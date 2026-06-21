# OpenModel Connector

Reference documentation for the `openmodel` connector (CONN-0223).

## Overview

The OpenModel connector provides access to the OpenModel API using an OpenAI-compatible interface.
The primary use case is accessing free-tier models (e.g., `deepseek-v4-flash`) at zero cost.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `OPENMODEL_ENABLED` | `false` | Enable the OpenModel connector. |
| `OPENMODEL_API_KEY` | — | API key. Required when `OPENMODEL_ENABLED=true`. |
| `OPENMODEL_BASE_URL` | `https://api.openmodel.ai/v1` | API base URL. |
| `OPENMODEL_FREE_MODELS` | `deepseek-v4-flash` | Comma-separated list of free models. |
| `OPENMODEL_TIMEOUT_MS` | `30000` | Request timeout in milliseconds. |
| `OPENMODEL_MAX_CONCURRENCY` | `2` | Maximum concurrent requests. |

## Free Tier

The OpenModel connector reports `costUsd: 0` for all responses because its primary use case
is the free tier. The free model list is configurable via `OPENMODEL_FREE_MODELS`.

## Models

| Model | Free |
|---|---|
| `deepseek-v4-flash` | Yes |
| `deepseek-r2` | No |
| `qwen3-235b` | No |

## Usage

```http
POST /execute
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "connector": "openmodel",
  "model": "deepseek-v4-flash",
  "prompt": "Hello world"
}
```
