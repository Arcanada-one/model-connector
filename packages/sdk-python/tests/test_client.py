from __future__ import annotations

import json

import httpx
import pytest

from arcanada_model_connector import (
    AsyncClient,
    Client,
    ConnectorError,
    ExecuteRequest,
    GuardExhaustedError,
    NetworkError,
    TimeoutError,
)
from arcanada_model_connector.errors import redact_cause

API_KEY = "arc_api_test_1234567890abcdef"
BASE_URL = "https://mc.test.local"


def _success_body() -> dict[str, object]:
    return {
        "id": "run_1",
        "connector": "openrouter",
        "model": "mistralai/mistral-small-3.2-24b-instruct",
        "result": "pong",
        "usage": {
            "inputTokens": 1,
            "outputTokens": 1,
            "totalTokens": 2,
            "costUsd": 0.0001,
        },
        "latencyMs": 412,
        "status": "success",
    }


def _transport(handler):  # type: ignore[no-untyped-def]
    return httpx.MockTransport(handler)


def _make_client(handler) -> Client:  # type: ignore[no-untyped-def]
    return Client(api_key=API_KEY, base_url=BASE_URL, transport=_transport(handler))


def _make_async_client(handler) -> AsyncClient:  # type: ignore[no-untyped-def]
    return AsyncClient(api_key=API_KEY, base_url=BASE_URL, transport=httpx.MockTransport(handler))


def test_success_201() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {API_KEY}"
        return httpx.Response(201, json=_success_body())

    with _make_client(handler) as client:
        got = client.execute(ExecuteRequest(connector="openrouter", prompt="ping"))
        assert got.id == "run_1"
        assert got.status == "success"


def test_repair_report_native_pass() -> None:
    body = _success_body()
    body["repair_report"] = {
        "strategies_applied": [],
        "retries": 0,
        "final_valid": True,
        "pass": "native",
    }

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=body)

    with _make_client(handler) as client:
        got = client.execute({"connector": "openrouter", "prompt": "p", "output_format": "json"})
        assert got.repair_report is not None
        assert got.repair_report.pass_ == "native"
        assert got.repair_report.retries == 0


def test_repair_report_guarded_pass() -> None:
    body = _success_body()
    body["repair_report"] = {
        "strategies_applied": ["strip_fences", "trailing_comma"],
        "retries": 1,
        "final_valid": True,
        "pass": "guarded",
    }

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=body)

    with _make_client(handler) as client:
        got = client.execute({"connector": "openrouter", "prompt": "p", "output_format": "json"})
        assert got.repair_report is not None
        assert got.repair_report.pass_ == "guarded"
        assert len(got.repair_report.strategies_applied) == 2


def test_guard_exhausted_raises() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            500,
            json={
                "error": {
                    "type": "guard_exhausted",
                    "message": "max retries exhausted",
                    "retryable": False,
                    "recommendation": "abort",
                }
            },
        )

    with _make_client(handler) as client:
        with pytest.raises(GuardExhaustedError):
            client.execute({"connector": "openrouter", "prompt": "p", "output_format": "json"})


def test_401_auth_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "error": {
                    "type": "auth_error",
                    "message": "invalid api key",
                    "retryable": False,
                    "recommendation": "reauth",
                }
            },
        )

    with _make_client(handler) as client:
        with pytest.raises(ConnectorError) as exc_info:
            client.execute({"connector": "openrouter", "prompt": "p"})
        assert exc_info.value.status == 401
        assert exc_info.value.envelope is not None
        assert exc_info.value.envelope.type == "auth_error"


def test_retry_after_header() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={"Retry-After": "10"},
            json={
                "error": {
                    "type": "rate_limited",
                    "message": "slow down",
                    "retryable": True,
                    "recommendation": "wait",
                }
            },
        )

    with _make_client(handler) as client:
        with pytest.raises(ConnectorError) as exc_info:
            client.execute({"connector": "openrouter", "prompt": "p"})
        assert exc_info.value.retry_after == 10.0


def test_timeout_maps_to_timeout_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("boom")

    with _make_client(handler) as client:
        with pytest.raises(TimeoutError):
            client.execute({"connector": "openrouter", "prompt": "p"})


def test_network_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failed")

    with _make_client(handler) as client:
        with pytest.raises(NetworkError):
            client.execute({"connector": "openrouter", "prompt": "p"})


def test_bearer_redacted_in_cause() -> None:
    leak_body = {
        "error": {
            "type": "validation_error",
            "message": "bad request",
            "retryable": False,
            "recommendation": "abort",
        },
        "echo": f"Bearer {API_KEY}",
        "authorization": f"Bearer {API_KEY}",
    }

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json=leak_body)

    with _make_client(handler) as client:
        with pytest.raises(ConnectorError) as exc_info:
            client.execute({"connector": "openrouter", "prompt": "p"})
        serialized = json.dumps(exc_info.value.cause)
        assert API_KEY not in serialized
        assert "[REDACTED]" in serialized


def test_redact_cause_walks_nested_structures() -> None:
    result = redact_cause(
        {
            "level1": {
                "headers": {"Authorization": f"Bearer {API_KEY}", "x-trace": "abc"},
                "body": f"note: Bearer {API_KEY} was sent",
            },
        }
    )
    assert isinstance(result, dict)
    headers = result["level1"]["headers"]
    assert headers["Authorization"] == "[REDACTED]"
    assert API_KEY not in result["level1"]["body"]
    assert "[REDACTED]" in result["level1"]["body"]


def test_client_requires_api_key() -> None:
    with pytest.raises(ValueError):
        Client(api_key="")


@pytest.mark.asyncio
async def test_async_success() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=_success_body())

    async with _make_async_client(handler) as client:
        got = await client.execute({"connector": "openrouter", "prompt": "ping"})
        assert got.status == "success"


@pytest.mark.asyncio
async def test_async_guard_exhausted() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            500,
            json={
                "error": {
                    "type": "guard_exhausted",
                    "message": "max retries exhausted",
                    "retryable": False,
                    "recommendation": "abort",
                }
            },
        )

    async with _make_async_client(handler) as client:
        with pytest.raises(GuardExhaustedError):
            await client.execute({"connector": "openrouter", "prompt": "p", "output_format": "json"})
