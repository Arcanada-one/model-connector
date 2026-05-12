"""Arcanada Model Connector Python SDK.

Typed client for the Arcanada Model Connector `/execute` endpoint.
Mirrors server contract 1:1 — see `docs/sdk-python.md` for usage.
"""

from .client import AsyncClient, Client
from .errors import (
    ConnectorError,
    GuardExhaustedError,
    NetworkError,
    TimeoutError,
)
from .models import (
    ExecuteErrorEnvelope,
    ExecuteRequest,
    ExecuteResponse,
    ExecuteUsage,
    RepairReport,
)

__version__ = "0.1.0"

__all__ = [
    "AsyncClient",
    "Client",
    "ConnectorError",
    "ExecuteErrorEnvelope",
    "ExecuteRequest",
    "ExecuteResponse",
    "ExecuteUsage",
    "GuardExhaustedError",
    "NetworkError",
    "RepairReport",
    "TimeoutError",
    "__version__",
]
