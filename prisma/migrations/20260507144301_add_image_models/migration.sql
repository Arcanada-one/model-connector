-- CreateTable
CREATE TABLE "Request" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "model" TEXT,
    "promptHash" TEXT NOT NULL,
    "promptLength" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorType" TEXT,
    "errorMessage" TEXT,
    "apiKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "rateLimit" INTEGER NOT NULL DEFAULT 60,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorAccount" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ConnectorAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageGeneration" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "width" INTEGER NOT NULL DEFAULT 1024,
    "height" INTEGER NOT NULL DEFAULT 1024,
    "steps" INTEGER,
    "cfg" DOUBLE PRECISION,
    "seed" INTEGER,
    "aspectRatio" TEXT,
    "outputFormat" TEXT NOT NULL DEFAULT 'png',
    "status" TEXT NOT NULL,
    "resultUrl" TEXT,
    "r2Key" TEXT,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "errorType" TEXT,
    "errorMessage" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageJob" (
    "id" TEXT NOT NULL,
    "imageGenerationId" TEXT NOT NULL,
    "bullJobId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Request_connector_createdAt_idx" ON "Request"("connector", "createdAt");

-- CreateIndex
CREATE INDEX "Request_apiKeyId_createdAt_idx" ON "Request"("apiKeyId", "createdAt");

-- CreateIndex
CREATE INDEX "Request_status_idx" ON "Request"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectorAccount_connector_accountName_key" ON "ConnectorAccount"("connector", "accountName");

-- CreateIndex
CREATE INDEX "ImageGeneration_provider_createdAt_idx" ON "ImageGeneration"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "ImageGeneration_apiKeyId_createdAt_idx" ON "ImageGeneration"("apiKeyId", "createdAt");

-- CreateIndex
CREATE INDEX "ImageGeneration_status_idx" ON "ImageGeneration"("status");

-- CreateIndex
CREATE INDEX "ImageJob_imageGenerationId_idx" ON "ImageJob"("imageGenerationId");

-- CreateIndex
CREATE INDEX "ImageJob_bullJobId_idx" ON "ImageJob"("bullJobId");

-- CreateIndex
CREATE INDEX "ImageJob_status_createdAt_idx" ON "ImageJob"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageGeneration" ADD CONSTRAINT "ImageGeneration_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageJob" ADD CONSTRAINT "ImageJob_imageGenerationId_fkey" FOREIGN KEY ("imageGenerationId") REFERENCES "ImageGeneration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
