CREATE TABLE "FirstDispatchObservation" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "observationKeySha256" TEXT NOT NULL,
    "measurement" JSONB NOT NULL,
    "connector" TEXT NOT NULL,
    "requestedModel" TEXT,
    "requestPayloadDigestSha256" TEXT NOT NULL,
    "requestPayloadBytes" INTEGER NOT NULL,
    "observationBoundary" TEXT NOT NULL,
    "connectorResponseId" TEXT,
    "observedModel" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "costUsd" DECIMAL(20,12),
    "latencyMs" INTEGER,
    "outcome" TEXT,
    "usageSource" TEXT,
    "persistence" TEXT NOT NULL,
    "evidenceStatus" TEXT NOT NULL,
    "authorization" TEXT NOT NULL,
    "failureStage" TEXT,
    "receipt" JSONB,
    "receiptDigestSha256" TEXT,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirstDispatchObservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FirstDispatchObservation_state_check" CHECK (
        (
            "state" = 'reserved'
            AND "connectorResponseId" IS NULL
            AND "observedModel" IS NULL
            AND "inputTokens" IS NULL
            AND "outputTokens" IS NULL
            AND "totalTokens" IS NULL
            AND "costUsd" IS NULL
            AND "latencyMs" IS NULL
            AND "outcome" IS NULL
            AND "usageSource" IS NULL
            AND "failureStage" IS NULL
            AND "receipt" IS NULL
            AND "receiptDigestSha256" IS NULL
            AND "evidenceStatus" = 'RESERVED_PRE_ADAPTER_OBSERVATION'
        ) OR (
            "state" = 'observed'
            AND "connectorResponseId" IS NOT NULL
            AND "observedModel" IS NOT NULL
            AND "inputTokens" IS NOT NULL
            AND "outputTokens" IS NOT NULL
            AND "totalTokens" IS NOT NULL
            AND "costUsd" IS NOT NULL
            AND "latencyMs" IS NOT NULL
            AND "outcome" IS NOT NULL
            AND "usageSource" IS NOT DISTINCT FROM 'CONNECTOR_RESPONSE_UNVERIFIED'
            AND "failureStage" IS NULL
            AND "receipt" IS NOT NULL
            AND "receiptDigestSha256" IS NOT NULL
            AND "evidenceStatus" = 'PERSISTED_PRE_ADAPTER_OBSERVATION'
        ) OR (
            "state" = 'indeterminate'
            AND "connectorResponseId" IS NULL
            AND "observedModel" IS NULL
            AND "inputTokens" IS NULL
            AND "outputTokens" IS NULL
            AND "totalTokens" IS NULL
            AND "costUsd" IS NULL
            AND "latencyMs" IS NULL
            AND "outcome" IS NULL
            AND "usageSource" IS NULL
            AND "failureStage" IS NOT NULL
            AND "failureStage" IN ('connector_or_response_processing', 'observation_finalize')
            AND "receipt" IS NULL
            AND "receiptDigestSha256" IS NULL
            AND "evidenceStatus" = 'INDETERMINATE_PROVIDER_OR_PERSISTENCE_OUTCOME'
        )
    ),
    CONSTRAINT "FirstDispatchObservation_persistence_check"
        CHECK ("persistence" = 'MODEL_CONNECTOR_POSTGRESQL'),
    CONSTRAINT "FirstDispatchObservation_authorization_check"
        CHECK ("authorization" = 'NOT_AUTHORIZED'),
    CONSTRAINT "FirstDispatchObservation_numeric_check" CHECK (
        "requestPayloadBytes" > 0
        AND ("inputTokens" IS NULL OR "inputTokens" >= 0)
        AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
        AND ("totalTokens" IS NULL OR "totalTokens" >= 0)
        AND ("costUsd" IS NULL OR "costUsd" >= 0)
        AND ("latencyMs" IS NULL OR "latencyMs" >= 0)
    ),
    CONSTRAINT "FirstDispatchObservation_outcome_check"
        CHECK ("outcome" IS NULL OR "outcome" IN ('success', 'error', 'timeout', 'rate_limited'))
);

CREATE UNIQUE INDEX "FirstDispatchObservation_observationKeySha256_key"
    ON "FirstDispatchObservation"("observationKeySha256");
CREATE UNIQUE INDEX "FirstDispatchObservation_receiptDigestSha256_key"
    ON "FirstDispatchObservation"("receiptDigestSha256");
CREATE INDEX "FirstDispatchObservation_apiKeyId_createdAt_idx"
    ON "FirstDispatchObservation"("apiKeyId", "createdAt");
CREATE INDEX "FirstDispatchObservation_state_createdAt_idx"
    ON "FirstDispatchObservation"("state", "createdAt");

ALTER TABLE "FirstDispatchObservation"
    ADD CONSTRAINT "FirstDispatchObservation_apiKeyId_fkey"
    FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_first_dispatch_observation_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'FirstDispatchObservation rows are append-only';
    END IF;

    IF OLD."state" <> 'reserved' OR NEW."state" NOT IN ('observed', 'indeterminate') THEN
        RAISE EXCEPTION 'FirstDispatchObservation permits only one transition from reserved';
    END IF;

    IF NEW."id" <> OLD."id"
        OR NEW."apiKeyId" <> OLD."apiKeyId"
        OR NEW."observationKeySha256" <> OLD."observationKeySha256"
        OR NEW."measurement" <> OLD."measurement"
        OR NEW."connector" <> OLD."connector"
        OR NEW."requestedModel" IS DISTINCT FROM OLD."requestedModel"
        OR NEW."requestPayloadDigestSha256" <> OLD."requestPayloadDigestSha256"
        OR NEW."requestPayloadBytes" <> OLD."requestPayloadBytes"
        OR NEW."observationBoundary" <> OLD."observationBoundary"
        OR NEW."persistence" <> OLD."persistence"
        OR NEW."authorization" <> OLD."authorization"
        OR NEW."createdAt" <> OLD."createdAt"
    THEN
        RAISE EXCEPTION 'FirstDispatchObservation reservation identity is immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "FirstDispatchObservation_immutability"
BEFORE UPDATE OR DELETE ON "FirstDispatchObservation"
FOR EACH ROW
EXECUTE FUNCTION "enforce_first_dispatch_observation_immutability"();
