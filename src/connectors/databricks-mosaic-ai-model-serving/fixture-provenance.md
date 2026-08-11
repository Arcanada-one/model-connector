# CONN-0296 synthetic fixture provenance

All fixtures in `synthetic-fixtures.ts` are handwritten, deterministic, and fictional. They were created on 2026-07-20 from public field meanings only. They are not recordings, captures, exports, SDK output, workspace responses, model output, credentials, tokens, customer data, or authenticated catalogue data.

First-party field sources:

- Endpoint list/get identity, `state`, active/pending configuration, and served-entity fields: [Databricks Serving Endpoints REST reference](https://docs.databricks.com/api/workspace/servingendpoints/get) and [list reference](https://docs.databricks.com/api/workspace/servingendpoints/list).
- Native invocation route, dataframe input, predictions, `client_request_id`, and `served-model-name` response header: [query reference](https://docs.databricks.com/api/workspace/servingendpoints/query).
- Conditional Public Preview OpenAPI document: [get OpenAPI reference](https://docs.databricks.com/api/workspace/servingendpoints/getopenapi) and [management guide](https://docs.databricks.com/aws/en/machine-learning/model-serving/manage-serving-endpoints).
- JSON error field meanings: the operation-specific error sections of the same generated REST reference.

Fiction markers include `synthetic`, zero-only workspace identifiers, and non-customer entity names. The fixtures deliberately exercise lifecycle and identity preservation without claiming that any represented workspace, endpoint, served entity, model, response, region, or deployment exists.
