"""Typed exception hierarchy for the Arcanada Model Connector SDK."""

from __future__ import annotations

import re
from typing import Any

from .models import ExecuteErrorEnvelope

_BEARER_RE = re.compile(r"Bearer\s+[A-Za-z0-9._\-+/=]+")


def _redact_str(value: str) -> str:
    return _BEARER_RE.sub("Bearer [REDACTED]", value)


def redact_cause(cause: Any, depth: int = 0) -> Any:
    """Recursively scrub Bearer tokens + authorization headers from arbitrary data."""
    if depth > 10 or cause is None:
        return cause
    if isinstance(cause, str):
        return _redact_str(cause)
    if isinstance(cause, dict):
        out: dict[Any, Any] = {}
        for k, v in cause.items():
            if isinstance(k, str) and k.lower() == "authorization":
                out[k] = "[REDACTED]"
            else:
                out[k] = redact_cause(v, depth + 1)
        return out
    if isinstance(cause, list):
        return [redact_cause(v, depth + 1) for v in cause]
    return cause


class ConnectorError(Exception):
    """Base error for non-success responses from `/execute`."""

    def __init__(
        self,
        message: str,
        status: int,
        envelope: ExecuteErrorEnvelope | None = None,
        cause: Any = None,
    ) -> None:
        super().__init__(_redact_str(message))
        self.status = status
        self.envelope = envelope
        self.retry_after = envelope.retry_after if envelope else None
        self.cause = redact_cause(cause)


class GuardExhaustedError(ConnectorError):
    """Raised when the output-guard exhausts its retry budget."""


class TimeoutError(ConnectorError):
    """Raised when the request exceeds the configured timeout."""

    def __init__(self, timeout: float) -> None:
        super().__init__(f"Request timed out after {timeout}s", status=0)
        self.timeout = timeout


class NetworkError(ConnectorError):
    """Raised for transport failures (DNS, TLS, connection reset)."""
