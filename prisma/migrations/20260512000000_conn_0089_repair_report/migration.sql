-- CONN-0089: add repair_report JSONB column to Request for output-guard middleware

ALTER TABLE "Request" ADD COLUMN "repairReport" JSONB;

CREATE INDEX "Request_repairReport_pass_idx"
  ON "Request" ((("repairReport"->>'pass')))
  WHERE "repairReport" IS NOT NULL;
