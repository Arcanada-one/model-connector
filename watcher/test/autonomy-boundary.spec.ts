import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CascadeAdapter } from '../src/contracts/cascade.adapter.js';
import { DisabledCatalogWriterAdapter } from '../src/contracts/catalog-writer.adapter.js';

describe('autonomy boundary', () => {
  it('keeps dependency adapters fail-closed', async () => {
    const cascade = new CascadeAdapter();
    expect(cascade.contractVersion).toBeNull();
    expect(cascade.isAvailable()).toBe(false);
    await expect(cascade.proposeFailover({})).rejects.toThrow(/CONN-0223/);
    expect(new DisabledCatalogWriterAdapter().isAvailable()).toBe(false);
  });

  it('contains no executable broad authority', async () => {
    const root = join(import.meta.dirname, '..');
    const files = ['config.yaml.example', 'systemd/model-connector-watcher.service'];
    const content = (await Promise.all(files.map((file) => readFile(join(root, file), 'utf8')))).join('\n');
    expect(content).not.toMatch(/ADMIN_TOKEN|docker\.sock|ExecStart=.*(ssh|systemctl)|secret.*write/i);
    expect(content).toContain('127.0.0.1');
  });
});
