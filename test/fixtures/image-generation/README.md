# Image Generation Test Fixtures

Provider response fixtures for CONN-0052 image generation connector.

## Status (Phase 0)

All provider credentials are `PLACEHOLDER_CONN-0052` in Vault — live API calls not possible.
Fixtures will be captured in Phase 1 after real credentials are provisioned.

## Missing fixtures (TODO: Phase 1)

- `vertex-imagen4-fast-success.json` — Vertex AI Imagen 4 Fast happy-path response
- `vertex-imagen4-fast-error-quota.json` — quota exceeded error shape
- `replicate-flux-pro-success.json` — Replicate FLUX pro prediction response
- `replicate-flux-pro-polling-started.json` — initial `status: "starting"` response
- `replicate-flux-pro-error.json` — failed prediction shape
- `openai-gpt-image-1-success-url.json` — gpt-image-1 `response_format: "url"` shape
- `openai-gpt-image-1-success-b64.json` — gpt-image-1 `response_format: "b64_json"` shape
- `openai-gpt-image-1-error-moderation.json` — content policy violation shape

## Capture instructions (Phase 1)

After provisioning real creds in Vault (`arcanada/prod/env/model-connector-{vertex,replicate,openai-images}`):

```bash
# Vertex Imagen 4 Fast — single 1:1 image
curl -X POST \
  "https://us-central1-aiplatform.googleapis.com/v1/projects/arcanada-platform/locations/us-central1/publishers/google/models/imagen-4.0-fast-generate-001:predict" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"instances": [{"prompt": "a white cat sitting on a wooden table"}], "parameters": {"sampleCount": 1, "aspectRatio": "1:1"}}' \
  > vertex-imagen4-fast-success.json

# Replicate FLUX pro
curl -X POST \
  "https://api.replicate.com/v1/predictions" \
  -H "Authorization: Token $REPLICATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version": "black-forest-labs/flux-pro", "input": {"prompt": "a white cat sitting on a wooden table"}}' \
  > replicate-flux-pro-polling-started.json

# OpenAI gpt-image-1
curl -X POST \
  "https://api.openai.com/v1/images/generations" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-image-1", "prompt": "a white cat sitting on a wooden table", "n": 1, "size": "1024x1024", "response_format": "url"}' \
  > openai-gpt-image-1-success-url.json
```
