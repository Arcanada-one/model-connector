import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditRecord {
  timestamp?: string;
  audit_ref: string;
  component: string;
  level_attempted: string;
  fix_applied: boolean;
  outcome: string;
  [key: string]: unknown;
}

export class AuditLog {
  constructor(private readonly path: string) {}

  async append(record: AuditRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ ...record, timestamp: record.timestamp ?? new Date().toISOString() })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
