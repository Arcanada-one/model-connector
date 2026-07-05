-- CreateTable
CREATE TABLE "model_catalog" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastChecked" TIMESTAMP(3) NOT NULL,
    "supportsStreaming" BOOLEAN NOT NULL DEFAULT false,
    "supportsJsonSchema" BOOLEAN NOT NULL DEFAULT false,
    "supportsTools" BOOLEAN NOT NULL DEFAULT false,
    "inputPerMTok" DOUBLE PRECISION,
    "outputPerMTok" DOUBLE PRECISION,
    "priceUnit" TEXT NOT NULL DEFAULT 'USD/1M tokens',
    "tier" TEXT NOT NULL,
    "free" BOOLEAN NOT NULL DEFAULT false,
    "priceMultiplier" DOUBLE PRECISION,
    "contextWindow" INTEGER,
    "maxOutputTokens" INTEGER,
    "endpoint" TEXT,
    "executableHere" BOOLEAN NOT NULL DEFAULT false,
    "routable" BOOLEAN NOT NULL DEFAULT false,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "absent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_access" (
    "provider" TEXT NOT NULL,
    "readEnabled" BOOLEAN NOT NULL DEFAULT true,
    "useEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_access_pkey" PRIMARY KEY ("provider")
);

-- CreateIndex
CREATE INDEX "model_catalog_modality_idx" ON "model_catalog"("modality");

-- CreateIndex
CREATE INDEX "model_catalog_status_idx" ON "model_catalog"("status");

-- CreateIndex
CREATE UNIQUE INDEX "model_catalog_connector_model_key" ON "model_catalog"("connector", "model");

