/** CACHE-003b: recorded native usage -> persisted catalogue -> actual fixture ledger. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { AnthropicConnector } from '../connectors/anthropic/anthropic.connector';
import { CatalogRepository } from '../connectors/catalog.repository';
import { entryToRow, rowToEntry } from '../connectors/catalog-mapper';
import { BillingService } from './billing.service';
import { measureCostUsd } from './measured-cost';

class FixtureAnthropic extends AnthropicConnector {
  parseFixture(json: unknown) {
    return this.parseResponse(json, { prompt: 'fixture' });
  }
  metas() {
    return this.getStaticModelMetas();
  }
}
const prisma = new PrismaService();
const billing = new BillingService(prisma);
const repository = new CatalogRepository(prisma);
const keyId = 'ca003b00-0000-4000-8000-000000000001';
const model = 'claude-fable-5-1';
const connector = 'cache-invoice-fixture';

beforeAll(async () => {
  await prisma.apiKey.create({
    data: { id: keyId, name: 'cache-invoice-fixture', keyHash: 'synthetic-cache-invoice-fixture' },
  });
  // Synthetic fixture funding, never a provider purchase or live account mutation.
  await billing.credit({
    apiKeyId: keyId,
    amountUsd: '1',
    idempotencyKey: 'cache-invoice-fixture-funding',
  });
});
afterAll(async () => {
  await prisma.creditsLedger.deleteMany({ where: { apiKeyId: keyId } });
  await prisma.creditsBalance.deleteMany({ where: { apiKeyId: keyId } });
  await prisma.apiKey.deleteMany({ where: { id: keyId } });
  await prisma.modelCatalog.deleteMany({ where: { connector } });
  await prisma.$disconnect();
});

it('charges the recorded invoice formula exactly once and round-trips the three tariffs', async () => {
  const native = new FixtureAnthropic();
  const meta = native.metas().find((m) => m.id === model)!;
  await prisma.modelCatalog.create({
    data: {
      connector,
      model,
      modality: 'chat',
      status: 'online',
      lastChecked: new Date(),
      lastSeen: new Date(),
      observedAt: new Date(),
      tier: 'paid',
      inputPerMTok: meta.pricing!.inputPerMTok,
      outputPerMTok: meta.pricing!.outputPerMTok,
      cachedInputPerMTok: meta.pricing!.cachedInputPerMTok,
      cacheWrite5mPerMTok: meta.pricing!.cacheWrite5mPerMTok,
      cacheWrite1hPerMTok: meta.pricing!.cacheWrite1hPerMTok,
      priceUnit: meta.pricing!.unit,
    },
  });
  const pricing = await repository.findPricing(connector, model);
  expect(pricing).toMatchObject({
    cachedInputPerMTok: 0.25,
    cacheWrite5mPerMTok: 12.5,
    cacheWrite1hPerMTok: 20,
  });
  const row = (await repository.findAll()).find((r) => r.connector === connector)!;
  expect(rowToEntry(row).pricing).toEqual(meta.pricing);
  expect(entryToRow(rowToEntry(row))).toMatchObject(pricing!);
  const usage = native.parseFixture(
    JSON.parse(
      readFileSync(
        resolve(__dirname, '../../test/fixtures/connectors/anthropic-cache-invoice.json'),
        'utf8',
      ),
    ),
  );
  const measured = measureCostUsd({ ...usage, pricing });
  // Independently expanded invoice, USD: (1000*10 + 6000*.25 + 2000*12.5 + 1000*20 + 100*50)/1e6.
  expect(measured.costUsd).toBe(0.0615);
  const charge = {
    apiKeyId: keyId,
    amountUsd: measured.costUsd.toString(),
    idempotencyKey: 'cache-invoice-fixture-charge',
    reason: 'model-request',
  };
  expect(await billing.settle(charge)).toBe(true);
  expect(await billing.settle(charge)).toBe(false);
  const ledger = await prisma.creditsLedger.findMany({
    where: { apiKeyId: keyId, reason: 'model-request' },
  });
  expect(ledger).toHaveLength(1);
  expect(ledger[0].amountUsd.toString()).toBe('-0.0615');
  expect((await billing.balance(keyId)).toString()).toBe('0.9385');
});
