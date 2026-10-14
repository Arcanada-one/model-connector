import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { spendCursorSchema } from './envelope';
import { ProfileSpendEventsService } from './events.service';

const querySchema = z
  .object({
    after: spendCursorSchema.default('0'),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .refine((n) => n <= 500)
      .default(100),
  })
  .strict();

/** AuthModule's global AuthGuard establishes req.apiKey; no public exemption. */
@Controller('profile-spend')
export class ProfileSpendEventsController {
  constructor(private readonly events: ProfileSpendEventsService) {}
  @Get('events')
  read(@Req() request: { apiKey: { id: string } }, @Query() raw: unknown) {
    const query = querySchema.safeParse(raw);
    if (!query.success) throw new BadRequestException('Invalid spend cursor query');
    return this.events.read(request.apiKey.id, query.data.after, query.data.limit);
  }
}
