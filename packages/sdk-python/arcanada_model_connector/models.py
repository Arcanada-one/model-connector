"""Pydantic v2 models mirroring server contract.

Source-of-truth on server side:
  src/connectors/dto/execute.dto.ts            — ExecuteRequest base shape
  src/connectors/interfaces/connector.interface.ts — ConnectorResponse
  src/connectors/output-guard/types.ts         — OutputGuardReport

Schema fidelity is 1:1 with the wire format; the server is the authoritative
validator, so the SDK keeps `extra='allow'` to forward-compatibly accept new
fields without raising.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

OutputFormat = Literal["json", "yaml", "toml", "python", "auto"]
ResponseFormatType = Literal["json_object", "text"]
OutputGuardPass = Literal["native", "guarded", "failed"]
ExecuteStatus = Literal["success", "error", "timeout", "rate_limited"]
ErrorAction = Literal["retry", "abort", "wait", "reauth"]
MEASUREMENT_IDENTIFIER_PATTERN = r"^[A-Za-z0-9._:/-]+$"


class ResponseFormat(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: ResponseFormatType


class FirstDispatchMeasurementV0(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: Literal["first-dispatch-measurement/v0"]
    corpus_id: str = Field(
        alias="corpusId",
        min_length=1,
        max_length=128,
        pattern=MEASUREMENT_IDENTIFIER_PATTERN,
    )
    case_id: str = Field(
        alias="caseId",
        min_length=1,
        max_length=128,
        pattern=MEASUREMENT_IDENTIFIER_PATTERN,
    )
    role_id: str = Field(
        alias="roleId",
        min_length=1,
        max_length=128,
        pattern=MEASUREMENT_IDENTIFIER_PATTERN,
    )
    task_class_id: str = Field(
        alias="taskClassId",
        min_length=1,
        max_length=128,
        pattern=MEASUREMENT_IDENTIFIER_PATTERN,
    )
    command_id: str = Field(
        alias="commandId",
        min_length=1,
        max_length=128,
        pattern=MEASUREMENT_IDENTIFIER_PATTERN,
    )
    replay_index: int = Field(alias="replayIndex", ge=1, le=65_535)
    variant: Literal["baseline", "compiled"]
    adapter_boundary: Literal["arcana-agent-system/driver/first-dispatch-v0"] = Field(
        alias="adapterBoundary"
    )


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    connector: str
    prompt: str
    model: str | None = None
    system_prompt: str | None = Field(default=None, alias="systemPrompt")
    tools: list[str] | None = None
    max_turns: int | None = Field(default=None, alias="maxTurns")
    max_budget_usd: float | None = Field(default=None, alias="maxBudgetUsd")
    effort: Literal["low", "medium", "high"] | None = None
    json_schema: dict[str, Any] | None = Field(default=None, alias="jsonSchema")
    response_format: ResponseFormat | None = Field(default=None, alias="responseFormat")
    timeout: int | None = None
    extra: dict[str, Any] | None = None
    output_format: OutputFormat | None = None
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")
    first_dispatch_measurement: FirstDispatchMeasurementV0 | None = Field(
        default=None, alias="firstDispatchMeasurement"
    )


class RepairReport(BaseModel):
    model_config = ConfigDict(extra="allow")

    strategies_applied: list[str]
    retries: int
    final_valid: bool
    pass_: OutputGuardPass = Field(alias="pass")
    error: str | None = None


class ExecuteUsage(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)
    input_tokens: int = Field(alias="inputTokens")
    output_tokens: int = Field(alias="outputTokens")
    total_tokens: int = Field(alias="totalTokens")
    cost_usd: float = Field(alias="costUsd")


class ExecuteErrorEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)
    type: str
    message: str
    retry_after: float | None = Field(default=None, alias="retryAfter")
    retryable: bool = False
    recommendation: ErrorAction = "abort"


class FirstDispatchObservationUsageV0(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    input_tokens: int = Field(alias="inputTokens")
    cached_input_tokens: None = Field(alias="cachedInputTokens")
    output_tokens: int = Field(alias="outputTokens")
    total_tokens: int = Field(alias="totalTokens")
    cost_usd: float = Field(alias="costUsd")
    source: Literal["CONNECTOR_RESPONSE_UNVERIFIED"]


class FirstDispatchObservationV0(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: Literal["first-dispatch-observation/v0"]
    observation_id: str = Field(alias="observationId")
    measurement: FirstDispatchMeasurementV0
    connector: str
    model: str
    connector_response_id: str = Field(alias="connectorResponseId")
    request_payload_digest_sha256: str = Field(alias="requestPayloadDigestSha256")
    request_payload_bytes: int = Field(alias="requestPayloadBytes")
    observation_boundary: Literal["model-connector/service/pre-adapter-v0"] = Field(
        alias="observationBoundary"
    )
    usage: FirstDispatchObservationUsageV0
    latency_ms: int = Field(alias="latencyMs")
    outcome: ExecuteStatus
    persistence: Literal["MODEL_CONNECTOR_POSTGRESQL"]
    evidence_status: Literal["PERSISTED_PRE_ADAPTER_OBSERVATION"] = Field(
        alias="evidenceStatus"
    )
    authorization: Literal["NOT_AUTHORIZED"]
    receipt_digest_sha256: str = Field(alias="receiptDigestSha256")


class ExecuteResponse(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    id: str
    connector: str
    model: str
    result: str
    structured: Any | None = None
    usage: ExecuteUsage
    latency_ms: int = Field(alias="latencyMs")
    queue_wait_ms: int | None = Field(default=None, alias="queueWaitMs")
    attempt: int | None = None
    max_attempts: int | None = Field(default=None, alias="maxAttempts")
    status: ExecuteStatus
    error: ExecuteErrorEnvelope | None = None
    repair_report: RepairReport | None = None
    first_dispatch_observation: FirstDispatchObservationV0 | None = Field(
        default=None, alias="firstDispatchObservation"
    )
