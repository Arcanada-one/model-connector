/**
 * Handwritten deterministic CONN-0296 fixtures.
 *
 * These values are fictional and were not captured from a Databricks workspace.
 * Field meanings follow the dated first-party references recorded in
 * fixture-provenance.md and the workflow research artifacts.
 */

export const SYNTHETIC_WORKSPACE_ORIGINS = Object.freeze({
  aws: 'https://synthetic-workspace.cloud.databricks.com',
  azure: 'https://adb-0000000000000000.0.azuredatabricks.net',
  gcp: 'https://0000000000000000.0.gcp.databricks.com',
} as const);

export const SYNTHETIC_ENDPOINT_NAME = 'synthetic-endpoint_01';

export const SYNTHETIC_INVOCATION_REQUEST = Object.freeze({
  dataframe_records: Object.freeze([
    Object.freeze({ feature_a: 1, feature_b: 'synthetic-input' }),
  ]),
  client_request_id: 'synthetic-request-0001',
});

export const SYNTHETIC_INVOCATION_RESPONSE = Object.freeze({
  predictions: Object.freeze([Object.freeze({ score: 0.75, label: 'synthetic-label' })]),
});

export const SYNTHETIC_ENDPOINT = Object.freeze({
  id: 'synthetic-endpoint-id-0001',
  name: SYNTHETIC_ENDPOINT_NAME,
  state: Object.freeze({
    ready: 'READY',
    config_update: 'NOT_UPDATING',
  }),
  config: Object.freeze({
    config_version: 7,
    served_entities: Object.freeze([
      Object.freeze({
        name: 'synthetic-served-entity-v3',
        entity_name: 'synthetic_catalog.synthetic_schema.synthetic_model',
        entity_version: '3',
        state: Object.freeze({ deployment: 'DEPLOYMENT_READY' }),
      }),
    ]),
  }),
  pending_config: Object.freeze({
    config_version: 8,
    served_entities: Object.freeze([
      Object.freeze({
        name: 'synthetic-served-entity-v4',
        entity_name: 'synthetic_catalog.synthetic_schema.synthetic_model',
        entity_version: '4',
        state: Object.freeze({ deployment: 'DEPLOYMENT_CREATING' }),
      }),
    ]),
  }),
});

export const SYNTHETIC_ENDPOINT_UPDATE_FAILED = Object.freeze({
  id: 'synthetic-endpoint-id-0002',
  name: 'synthetic-update-failed',
  state: Object.freeze({
    ready: 'READY',
    config_update: 'UPDATE_FAILED',
  }),
  config: Object.freeze({ config_version: 11 }),
  pending_config: Object.freeze({ config_version: 12 }),
});

export const SYNTHETIC_ENDPOINT_LIST = Object.freeze({
  endpoints: Object.freeze([SYNTHETIC_ENDPOINT, SYNTHETIC_ENDPOINT_UPDATE_FAILED]),
});

export const SYNTHETIC_OPENAPI_SCHEMA = Object.freeze({
  openapi: '3.0.0',
  info: Object.freeze({ title: 'Synthetic endpoint schema', version: 'synthetic-v1' }),
  paths: Object.freeze({
    '/served-models/synthetic-served-entity-v3/invocations': Object.freeze({
      post: Object.freeze({ operationId: 'syntheticInvocation' }),
    }),
  }),
});

export const SYNTHETIC_PROVIDER_ERROR = Object.freeze({
  error_code: 'SYNTHETIC_UNAUTHENTICATED',
  message: 'synthetic-secret-marker Bearer synthetic-token must never escape',
});
