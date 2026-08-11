export type MetaLlamaGuardClassificationTarget = 'prompt' | 'response';
export type MetaLlamaGuardVerdict = 'safe' | 'unsafe';

export type MetaLlamaGuardErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'runtime_timeout'
  | 'runtime_failure'
  | 'invalid_generation';

export interface MetaLlamaGuardTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface MetaLlamaGuardMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly MetaLlamaGuardTextContent[];
}

export interface MetaLlamaGuardGenerationRequest {
  readonly contractVersion: 'meta-llama-guard-generation/v1';
  readonly modelId: 'meta-llama/Llama-Guard-4-12B';
  readonly classificationTarget: MetaLlamaGuardClassificationTarget;
  readonly messages: readonly MetaLlamaGuardMessage[];
}

export type MetaLlamaGuardGenerate = (
  request: MetaLlamaGuardGenerationRequest,
) => Promise<unknown>;

export interface MetaLlamaGuardCategoryResult {
  readonly code: string;
  readonly label: string;
}

export interface MetaLlamaGuardClassificationResult {
  readonly modelId: 'meta-llama/Llama-Guard-4-12B';
  readonly target: MetaLlamaGuardClassificationTarget;
  readonly verdict: MetaLlamaGuardVerdict;
  readonly categories: readonly MetaLlamaGuardCategoryResult[];
}
