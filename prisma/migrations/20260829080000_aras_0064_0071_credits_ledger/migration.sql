-- CreateTable
CREATE TABLE "credits_balance" (
    "api_key_id" TEXT NOT NULL,
    "balance_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credits_balance_pkey" PRIMARY KEY ("api_key_id")
);

-- CreateTable
CREATE TABLE "credits_ledger" (
    "id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "amount_usd" DECIMAL(12,6) NOT NULL,
    "reason" TEXT NOT NULL,
    "entry_type" TEXT NOT NULL DEFAULT 'charge',
    "idempotency_key" TEXT NOT NULL,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credits_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credits_ledger_idempotency_key_key" ON "credits_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "credits_ledger_api_key_id_created_at_idx" ON "credits_ledger"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "credits_ledger_api_key_id_entry_type_idx" ON "credits_ledger"("api_key_id", "entry_type");

-- AddForeignKey
ALTER TABLE "credits_balance" ADD CONSTRAINT "credits_balance_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits_ledger" ADD CONSTRAINT "credits_ledger_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

