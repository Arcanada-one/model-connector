import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

let writeQueue = Promise.resolve();

export class StateStore<T extends object = Record<string, unknown>> {
  constructor(private readonly path: string) {}

  async read(): Promise<T | null> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error('state target must not be a symlink');
      return JSON.parse(await readFile(this.path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error('malformed watcher state', { cause: error });
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    const operation = writeQueue.then(() => this.atomicWrite(value));
    writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async atomicWrite(value: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error('state target must not be a symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temp = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${crypto.randomUUID()}`);
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
      const dir = await open(dirname(this.path), constants.O_RDONLY);
      await dir.sync();
      await dir.close();
      await access(this.path, constants.R_OK);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temp, { force: true });
      throw error;
    }
  }
}
