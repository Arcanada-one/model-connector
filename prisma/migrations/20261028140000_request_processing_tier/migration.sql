-- #6664 — processing-tier attribution on the request log row that already
-- carries the served model. NULL = predates this column (never invent standard).
ALTER TABLE "Request"
  ADD COLUMN "tierRequested" TEXT,
  ADD COLUMN "tierActual" TEXT;
