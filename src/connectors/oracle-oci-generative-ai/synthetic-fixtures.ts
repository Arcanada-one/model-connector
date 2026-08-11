export const SYNTHETIC_COMPARTMENT_ID =
  'ocid1.compartment.oc1..syntheticconn0295compartment' as const;

export const SYNTHETIC_WORK_REQUEST_ID =
  'ocid1.workrequest.oc1.us-ashburn-1.syntheticconn0295request' as const;

export const SYNTHETIC_ON_DEMAND_BODY = Object.freeze({
  compartmentId: SYNTHETIC_COMPARTMENT_ID,
  servingMode: Object.freeze({
    servingType: 'ON_DEMAND',
    modelId: 'synthetic.oracle-model',
  }),
  chatRequest: Object.freeze({
    apiFormat: 'GENERIC',
    messages: Object.freeze([
      Object.freeze({ role: 'USER', content: 'synthetic prompt' }),
    ]),
  }),
});

export const SYNTHETIC_DEDICATED_BODY = Object.freeze({
  compartmentId: SYNTHETIC_COMPARTMENT_ID,
  servingMode: Object.freeze({
    servingType: 'DEDICATED',
    endpointId: 'ocid1.generativeaiendpoint.oc1.iad.syntheticconn0295endpoint',
  }),
  input: 'synthetic input',
});

export const SYNTHETIC_JSON_RESPONSE = Object.freeze({
  id: 'synthetic-response',
  modelId: 'synthetic.oracle-model',
  values: Object.freeze([0.125, -0.25]),
});

export const SYNTHETIC_ENDPOINT_COLLECTION = Object.freeze({
  items: Object.freeze(
    ['ACTIVE', 'CREATING', 'UPDATING', 'DELETING', 'DELETED', 'FAILED'].map(
      (lifecycleState, index) =>
        Object.freeze({
          id: `ocid1.generativeaiendpoint.oc1.iad.synthetic${index}`,
          lifecycleState,
        }),
    ),
  ),
});

export const SYNTHETIC_WORK_REQUEST = Object.freeze({
  id: SYNTHETIC_WORK_REQUEST_ID,
  statuses: Object.freeze([
    'ACCEPTED',
    'IN_PROGRESS',
    'WAITING',
    'FAILED',
    'SUCCEEDED',
    'CANCELING',
    'CANCELED',
  ]),
});
