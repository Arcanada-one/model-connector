-- Unknown tariffs remain NULL; no existing price or balance is rewritten.
ALTER TABLE "model_catalog"
  ADD COLUMN "cachedInputPerMTok" DOUBLE PRECISION,
  ADD COLUMN "cacheWrite5mPerMTok" DOUBLE PRECISION,
  ADD COLUMN "cacheWrite1hPerMTok" DOUBLE PRECISION;
