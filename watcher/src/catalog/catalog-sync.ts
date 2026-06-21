import type { CatalogModel } from './provider-adapter.js';

interface CatalogWriter {
  readonly contractVersion: string | null;
  isAvailable(): boolean;
  submitValidatedDiff(input: unknown): Promise<unknown>;
}

export class CatalogSync {
  private readonly missingCounts = new Map<string, number>();

  constructor(
    private readonly writer: CatalogWriter,
    private readonly persistLkg: (provider: string, models: CatalogModel[]) => void | Promise<void>,
    private readonly config: {
      removalBlockRatio: number;
      removalBlockCount: number;
      missingBeforeDeprecate?: number;
    },
  ) {}

  async reconcile(provider: string, previous: CatalogModel[], current: CatalogModel[], writeEnabled: boolean) {
    const oldById = new Map(previous.map((model) => [model.id, model]));
    const newById = new Map(current.map((model) => [model.id, model]));
    const added = current.filter((model) => !oldById.has(model.id)).map((model) => model.id);
    const changed = current
      .filter((model) => oldById.has(model.id) && JSON.stringify(oldById.get(model.id)) !== JSON.stringify(model))
      .map((model) => model.id);
    const missing = previous.filter((model) => !newById.has(model.id)).map((model) => model.id);
    const missingBeforeDeprecate = this.config.missingBeforeDeprecate ?? 2;
    const eligibleMissing = missing.filter((id) => {
      const key = `${provider}:${id}`;
      const count = (this.missingCounts.get(key) ?? 0) + 1;
      this.missingCounts.set(key, count);
      return count >= missingBeforeDeprecate;
    });
    for (const id of current.map((model) => model.id)) this.missingCounts.delete(`${provider}:${id}`);
    const ratio = previous.length === 0 ? 0 : missing.length / previous.length;
    const blocked = ratio > this.config.removalBlockRatio || missing.length > this.config.removalBlockCount;
    await this.persistLkg(provider, current);
    const writeAttempted = writeEnabled && !blocked && this.writer.isAvailable();
    if (writeAttempted) {
      await this.writer.submitValidatedDiff({ provider, added, changed, missing: eligibleMissing, current });
    }
    return { added, changed, missing, eligibleMissing, blocked, writeAttempted };
  }
}
