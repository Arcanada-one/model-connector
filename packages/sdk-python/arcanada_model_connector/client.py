"""Sync + async clients for the Arcanada Model Connector `/execute` endpoint."""

from __future__ import annotations

from typing import Any

import httpx

from .errors import (
    ConnectorError,
    GuardExhaustedError,
    NetworkError,
    TimeoutError,
)
from .models import ExecuteErrorEnvelope, ExecuteRequest, ExecuteResponse

DEFAULT_BASE_URL = "https://connector.arcanada.one"
DEFAULT_TIMEOUT = 120.0


def _build_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "arcanada-model-connector-python/0.1.0",
    }


def _serialize(request: ExecuteRequest | dict[str, Any]) -> dict[str, Any]:
    if isinstance(request, ExecuteRequest):
        return request.model_dump(by_alias=True, exclude_none=True)
    return {k: v for k, v in request.items() if v is not None}


def _raise_from_response(status: int, body: Any, retry_after: float | None) -> None:
    envelope = _extract_envelope(body, retry_after)
    message = envelope.message if envelope else f"HTTP {status}"
    if envelope is not None and envelope.type == "guard_exhausted":
        raise GuardExhaustedError(message, status, envelope, cause=body)
    raise ConnectorError(message, status, envelope, cause=body)


def _extract_envelope(body: Any, retry_after: float | None) -> ExecuteErrorEnvelope | None:
    if not isinstance(body, dict):
        return None
    candidate = body.get("error") if isinstance(body.get("error"), dict) else body
    if not isinstance(candidate, dict) or not isinstance(candidate.get("type"), str):
        return None
    payload = dict(candidate)
    if retry_after is not None and "retryAfter" not in payload and "retry_after" not in payload:
        payload["retryAfter"] = retry_after
    return ExecuteErrorEnvelope.model_validate(payload)


def _retry_after_seconds(response: httpx.Response) -> float | None:
    header = response.headers.get("retry-after")
    if header is None:
        return None
    try:
        return float(header)
    except ValueError:
        return None


def _decode(response: httpx.Response) -> Any:
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return {"raw": response.text}


class Client:
    """Synchronous client wrapping `httpx.Client`."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("Client requires a non-empty api_key")
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            transport=transport,
            headers=_build_headers(api_key),
        )
        self._timeout = timeout

    def execute(self, request: ExecuteRequest | dict[str, Any]) -> ExecuteResponse:
        body = _serialize(request)
        try:
            response = self._http.post("/execute", json=body)
        except httpx.TimeoutException as exc:
            raise TimeoutError(self._timeout) from exc
        except httpx.HTTPError as exc:
            raise NetworkError(str(exc), status=0) from exc
        return _parse(response)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()


class AsyncClient:
    """Async client wrapping `httpx.AsyncClient`."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("AsyncClient requires a non-empty api_key")
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            transport=transport,
            headers=_build_headers(api_key),
        )
        self._timeout = timeout

    async def execute(self, request: ExecuteRequest | dict[str, Any]) -> ExecuteResponse:
        body = _serialize(request)
        try:
            response = await self._http.post("/execute", json=body)
        except httpx.TimeoutException as exc:
            raise TimeoutError(self._timeout) from exc
        except httpx.HTTPError as exc:
            raise NetworkError(str(exc), status=0) from exc
        return _parse(response)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "AsyncClient":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.aclose()


def _parse(response: httpx.Response) -> ExecuteResponse:
    body = _decode(response)
    if response.status_code in (200, 201):
        if not isinstance(body, dict):
            raise ConnectorError("Empty success body", response.status_code, cause=body)
        return ExecuteResponse.model_validate(body)
    _raise_from_response(response.status_code, body, _retry_after_seconds(response))
    raise AssertionError("unreachable")
