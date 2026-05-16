-- CONN-0102: STT multi-provider router audit row (Phase 1a — Groq sync)
-- PK uses app-side UUID v7 (uuidv7 lib) for time-sortable inserts.

-- CreateTable
CREATE TABLE "SttTranscription" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "language" TEXT,
    "audioBytes" INTEGER NOT NULL,
    "audioDurationSeconds" DOUBLE PRECISION,
    "mimeType" TEXT NOT NULL,
    "transcriptionPreview" TEXT NOT NULL,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorType" TEXT,
    "errorMessage" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SttTranscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SttTranscription_provider_createdAt_idx" ON "SttTranscription"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "SttTranscription_apiKeyId_createdAt_idx" ON "SttTranscription"("apiKeyId", "createdAt");

-- CreateIndex
CREATE INDEX "SttTranscription_status_idx" ON "SttTranscription"("status");

-- AddForeignKey
ALTER TABLE "SttTranscription" ADD CONSTRAINT "SttTranscription_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
