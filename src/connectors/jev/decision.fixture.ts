import { DecisionRequest } from './decision.contract';
// Synthetic fixtures only: never imported from the frozen benchmark corpus.
export const request: DecisionRequest = {
  version: 'DecisionRequest/v1',
  mode: 'shadow',
  decisionType: 'task-routing',
  policyId: 'fixture-v1',
  model: 'jev-latest',
  state: 'Synthetic local task',
  questions: {
    tier: {
      type: 'choice',
      instructions: 'Choose tier',
      criteria: { small: 'Simple', large: 'Complex' },
    },
    complexity: {
      type: 'score',
      instructions: 'Estimate complexity',
      criteria: ['Low', 'Medium', 'High', 'Very high'],
    },
    risk: { type: 'noul', instructions: 'Is the task risky?' },
  },
};
export const nativeResponse = {
  model: 'jev-fixture-version',
  answers: {
    tier: { choice: 'small', confidence: 0.8, probabilities: { small: 0.8, large: 0.2 } },
    complexity: { score: 2.4 },
    risk: { noul: 0.6996 },
  },
};
