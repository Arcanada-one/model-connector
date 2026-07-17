import { z } from 'zod';

// CTRL-0026 Phase 2 — GET /stats/requests/daily query DTO.
// since/until are ISO calendar-date strings (YYYY-MM-DD); until >= since;
// window (until - since) <= 92 days. Bounding the window is a security
// control (threat T9 — MC aggregate-query DoS) in addition to a usability
// one: it keeps the underlying $queryRaw aggregate cheap regardless of what
// the caller supplies.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WINDOW_DAYS = 92;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isValidCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Reject overflowed dates that Date() silently normalizes, e.g. 2026-02-30.
  return parsed.toISOString().slice(0, 10) === value;
}

export const statsDailyQuerySchema = z
  .object({
    since: z
      .string()
      .regex(ISO_DATE_RE, 'since must be an ISO date string (YYYY-MM-DD)')
      .refine(isValidCalendarDate, 'since is not a valid calendar date'),
    until: z
      .string()
      .regex(ISO_DATE_RE, 'until must be an ISO date string (YYYY-MM-DD)')
      .refine(isValidCalendarDate, 'until is not a valid calendar date'),
  })
  .refine((data) => Date.parse(data.until) >= Date.parse(data.since), {
    message: 'until must be greater than or equal to since',
    path: ['until'],
  })
  .refine(
    (data) => {
      const windowDays = (Date.parse(data.until) - Date.parse(data.since)) / MS_PER_DAY;
      return windowDays <= MAX_WINDOW_DAYS;
    },
    {
      message: `window (until - since) must not exceed ${MAX_WINDOW_DAYS} days`,
      path: ['until'],
    },
  );

export type StatsDailyQueryDto = z.infer<typeof statsDailyQuerySchema>;
