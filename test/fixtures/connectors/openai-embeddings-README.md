# OpenAI embeddings synthetic fixture provenance

All `openai-*.synthetic.json` fixtures used by CONN-0283 are hand-authored synthetic data. They mirror field names and shapes documented in the public OpenAI API reference frozen on 2026-07-15.

They are not live captures, contain no API key, request ID, customer input, personal data, production model catalogue, pricing, region, or lifecycle claim, and require no network access to replay. Small vectors and token counts are deliberately artificial and assert schema mapping only.

Official shape sources:

- https://developers.openai.com/api/reference/resources/embeddings/methods/create
- https://developers.openai.com/api/reference/overview#authentication
- https://developers.openai.com/api/docs/guides/error-codes#api-errors
