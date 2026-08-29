-- ARAS-0058 — record WHERE a request's cost came from.
--
-- Nullable with no default and no back-fill: every existing row was written by
-- the pre-meter code and genuinely does not know its provenance. Stamping them
-- with a guess would manufacture evidence about $0.000000 charges that are the
-- very thing under investigation. NULL reads as "predates the meter".
--
-- AddColumn
ALTER TABLE "Request" ADD COLUMN "costSource" TEXT;
