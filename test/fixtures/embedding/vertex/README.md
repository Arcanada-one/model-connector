# Vertex AI embedding fixtures

All JSON files in this directory are handwritten synthetic fixtures for CONN-0285. They were derived from the Google Cloud Vertex AI text and multimodal embedding response schemas cited in the workflow research artifact. They are not captured responses, do not contain real embeddings, credentials, project IDs, locations, request IDs, or provider traffic, and must never be presented as live-provider evidence.

- `text-success.synthetic.json` exercises documented text embedding values and per-result token/truncation statistics.
- `multimodal-success.synthetic.json` exercises documented text, image, and segmented video vectors.
- `provider-error.synthetic.json` includes an intentionally fake bearer-shaped value to prove error redaction.
- `malformed-success.synthetic.json` is an intentionally invalid 2xx body with fake bearer material to prove malformed-success errors do not echo raw payloads.
