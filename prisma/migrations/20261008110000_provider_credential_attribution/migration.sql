-- Additive attribution only. Never invent credential identity for historical rows.
ALTER TABLE "Request"
  ADD COLUMN "upstreamCredentialRef" TEXT,
  ADD COLUMN "upstreamCredentialVersion" TEXT,
  ADD COLUMN "providerProfileId" TEXT,
  ADD COLUMN "providerProfileRevision" TEXT,
  ADD COLUMN "accountingBucket" TEXT;
CREATE INDEX "Request_upstreamCredentialRef_createdAt_idx" ON "Request"("upstreamCredentialRef", "createdAt");
CREATE INDEX "Request_accountingBucket_createdAt_idx" ON "Request"("accountingBucket", "createdAt");
