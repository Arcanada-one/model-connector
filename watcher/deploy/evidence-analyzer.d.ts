export interface AuditRecord {
  timestamp: string;
  provider: string;
  model: string;
  [key: string]: unknown;
}

export function filterToWindow(
  records: AuditRecord[],
  startTs: number | null,
  endTs: number | null
): AuditRecord[];
