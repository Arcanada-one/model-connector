-- Issue #106: OpenRouter publishes pricing.prompt/completion = "-1" for
-- auto-routed models. normalizePerMTokPrice used to persist that sentinel as a
-- large negative USD-per-1M tariff. Clear every negative tariff to NULL
-- (unknown / unpriced). Do not invent a replacement price.
UPDATE "model_catalog"
SET
  "inputPerMTok" = CASE
    WHEN "inputPerMTok" IS NOT NULL AND "inputPerMTok" < 0 THEN NULL
    ELSE "inputPerMTok"
  END,
  "outputPerMTok" = CASE
    WHEN "outputPerMTok" IS NOT NULL AND "outputPerMTok" < 0 THEN NULL
    ELSE "outputPerMTok"
  END,
  "cachedInputPerMTok" = CASE
    WHEN "cachedInputPerMTok" IS NOT NULL AND "cachedInputPerMTok" < 0 THEN NULL
    ELSE "cachedInputPerMTok"
  END,
  "cacheWrite5mPerMTok" = CASE
    WHEN "cacheWrite5mPerMTok" IS NOT NULL AND "cacheWrite5mPerMTok" < 0 THEN NULL
    ELSE "cacheWrite5mPerMTok"
  END,
  "cacheWrite1hPerMTok" = CASE
    WHEN "cacheWrite1hPerMTok" IS NOT NULL AND "cacheWrite1hPerMTok" < 0 THEN NULL
    ELSE "cacheWrite1hPerMTok"
  END
WHERE
  ("inputPerMTok" IS NOT NULL AND "inputPerMTok" < 0)
  OR ("outputPerMTok" IS NOT NULL AND "outputPerMTok" < 0)
  OR ("cachedInputPerMTok" IS NOT NULL AND "cachedInputPerMTok" < 0)
  OR ("cacheWrite5mPerMTok" IS NOT NULL AND "cacheWrite5mPerMTok" < 0)
  OR ("cacheWrite1hPerMTok" IS NOT NULL AND "cacheWrite1hPerMTok" < 0);

-- A row that was marked paid only because of the sentinel no longer has
-- tariffs; mark it unknown rather than leave an inconsistent paid/NULL pair.
UPDATE "model_catalog"
SET "tier" = 'unknown', "free" = false
WHERE "tier" = 'paid'
  AND "inputPerMTok" IS NULL
  AND "outputPerMTok" IS NULL;
