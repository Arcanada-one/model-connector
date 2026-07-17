import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface StatsDailyRow {
  connector: string;
  model: string | null;
  day: Date;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

// Row-count cap for the daily-stats aggregate (threat T9 — MC
// aggregate-query DoS, datarim/plans/CTRL-0026-plan.md § Security Design).
// The 92-day window cap (src/stats/dto.ts) bounds the cardinality already,
// but this is a second, independent limit: 92 days x plausible
// connector x model cardinality (currently ~10 connectors, well under 100
// distinct models each across Request/ImageGeneration/SttTranscription)
// stays comfortably under 5000 in practice. The cap exists purely so a
// malformed or unexpectedly wide window can never turn into an unbounded
// aggregate scan/response.
export const STATS_MAX_RESULT_ROWS = 5000;

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async getDailyRequests(since: string, until: string): Promise<StatsDailyRow[]> {
    const sinceDate = new Date(`${since}T00:00:00.000Z`);
    const untilDate = new Date(`${until}T23:59:59.999Z`);

    // Parameterized Prisma tagged-template $queryRaw — since/untilDate/the
    // row cap are bound query parameters, never interpolated into the SQL
    // string. The unsafe raw-query variant and manual string concatenation
    // are both forbidden here (see stats.service.spec.ts's static assertion).
    const rows = await this.prisma.$queryRaw<StatsDailyRow[]>`
      SELECT connector, model, day,
             COUNT(*)::int AS requests,
             SUM("inputTokens")::int AS "inputTokens",
             SUM("outputTokens")::int AS "outputTokens",
             SUM("totalTokens")::int AS "totalTokens",
             SUM("costUsd")::float AS "costUsd"
      FROM (
        SELECT connector, model, date_trunc('day', "createdAt") AS day,
               "inputTokens", "outputTokens", "totalTokens", "costUsd"
        FROM "Request"
        WHERE "createdAt" >= ${sinceDate} AND "createdAt" <= ${untilDate}
        UNION ALL
        SELECT provider AS connector, model, date_trunc('day', "createdAt") AS day,
               0 AS "inputTokens", 0 AS "outputTokens", 0 AS "totalTokens", "costUsd"
        FROM "ImageGeneration"
        WHERE "createdAt" >= ${sinceDate} AND "createdAt" <= ${untilDate}
        UNION ALL
        SELECT provider AS connector, model, date_trunc('day', "createdAt") AS day,
               0 AS "inputTokens", 0 AS "outputTokens", 0 AS "totalTokens", "costUsd"
        FROM "SttTranscription"
        WHERE "createdAt" >= ${sinceDate} AND "createdAt" <= ${untilDate}
      ) unioned
      GROUP BY connector, model, day
      ORDER BY day ASC, connector ASC, model ASC
      LIMIT ${STATS_MAX_RESULT_ROWS}
    `;

    // Defense-in-depth: even if the SQL-level LIMIT were ever bypassed
    // (e.g. a mocked/stubbed Prisma layer in a future refactor), never hand
    // back more than the documented cap.
    return rows.length > STATS_MAX_RESULT_ROWS ? rows.slice(0, STATS_MAX_RESULT_ROWS) : rows;
  }
}
