# Catalogue cache pricing

The catalogue stores independent nullable USD-per-million-token tariffs for
cache reads, five-minute writes and one-hour writes. NULL means unpublished,
not free. Existing rows receive NULL without a price or ledger backfill.
Anthropic's curated global standard-tier prices were checked on 2026-10-07
against https://platform.claude.com/docs/en/about-claude/pricing.

The normalized input token total includes the uncached tail, cache reads and
both write durations. The meter subtracts these subsets before pricing the
tail. It never adds writes or reads to that total a second time. A provider's
positive invoice remains authoritative. Without an invoice, a consumed write
with an unknown tariff, missing TTL split or inconsistent write total is marked
`unpriced`; the ledger retains that reason instead of inventing a duration.
Legacy cache reads with no published read tariff keep the existing base-price
fallback. No write duration is inferred from a cache-control request.

The recorded native fixture `test/fixtures/connectors/anthropic-cache-invoice.json`
has 1,000 tail tokens, 6,000 read tokens, 2,000 five-minute write tokens,
1,000 one-hour write tokens and 100 output tokens. For Claude Fable 5.1:

```
(1000 * 10 + 6000 * 0.25 + 2000 * 12.5 + 1000 * 20 + 100 * 50) / 1e6
= 0.0615 USD
```

`src/billing/cache-invoice.integration.spec.ts` checks catalogue round-trip,
the native usage parser, the real billing service's PostgreSQL debit of
-0.0615 USD, the remaining synthetic balance and settlement idempotency.
The connector-service test separately checks the actual metering call site and
request persistence. Retry coverage retains the write duration counts from
discarded attempts. Cache-only price changes affect snapshot fingerprints;
omitted and NULL tariffs normalize to the same snapshot content.

Run the integration test only against an isolated, schema-synced fixture DB:

```
pnpm exec vitest run --config vitest.integration.config.ts src/billing/cache-invoice.integration.spec.ts
```

This source and fixture evidence does not establish a deployed tariff, live
Anthropic invoice, provider-key availability or runtime account restoration.
Before deploying, apply the additive migration through the normal deployment
path. Reverting the application revision leaves the nullable columns intact;
no historical debit or balance should be rewritten during rollback.
