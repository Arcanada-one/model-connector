export const VERTEX_GENERATIVE_CONFIG = Symbol('VERTEX_GENERATIVE_CONFIG');
export const VERTEX_GENERATIVE_TOKEN_PROVIDER = Symbol('VERTEX_GENERATIVE_TOKEN_PROVIDER');

export interface VertexGenerativeConfig {
  project: string;
  location: string;
  models: string[];
}

export type VertexBearerTokenProvider = () => Promise<string>;
