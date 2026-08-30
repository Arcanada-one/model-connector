-- CONN-0272 — the breakdown behind `Request.costUsd`.
--
-- `costUsd` is a single number, so two questions that decide where the money
-- goes cannot be answered from it: how much of a bill is prompt rather than
-- completion, and whether prompt caching is saving anything. Both inputs were
-- already present and discarded — `measureCostUsd()` computed the two halves
-- and returned only their sum, and the codex/claude-code connectors parsed the
-- providers' cache counts into a structured blob nothing meters.
--
-- All four columns are nullable with no default and no back-fill, and NULL is
-- deliberately NOT 0:
--   NULL = never reported (the provider is silent) or never computed (an
--          unpriced model, or a provider invoice that arrives as one number).
--   0    = measured, and it was zero — a cache that did not fire.
-- Back-filling zeros would make "caching is switched off" indistinguishable
-- from "we have no idea", which is precisely the ambiguity `costSource` was
-- added to remove. Existing rows predate the breakdown and say so.
--
-- Column names are camelCase to match every other column on this table.
--
-- AddColumn
ALTER TABLE "Request" ADD COLUMN "cachedInputTokens" INTEGER;
ALTER TABLE "Request" ADD COLUMN "reasoningOutputTokens" INTEGER;
ALTER TABLE "Request" ADD COLUMN "inputCostUsd" DECIMAL(10,6);
ALTER TABLE "Request" ADD COLUMN "outputCostUsd" DECIMAL(10,6);
