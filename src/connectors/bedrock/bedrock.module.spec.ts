import { describe, expect, it, vi } from 'vitest';
import { BedrockConnector } from './bedrock.connector';
import {
  BedrockModule,
  createUnconfiguredBedrockSigner,
  resolveBedrockSigner,
} from './bedrock.module';

describe('BedrockModule', () => {
  it('uses the fail-closed signer when the optional token is absent', async () => {
    const signer = resolveBedrockSigner({
      get: () => {
        throw new Error('provider missing');
      },
    } as never);
    await expect(
      signer({ method: 'POST', url: 'https://example.test', headers: {}, body: '{}' }),
    ).rejects.toThrow('Bedrock SigV4 signer is not configured');
  });

  it('registers the connector without credential discovery', () => {
    const connector = new BedrockConnector(
      { BEDROCK_REGION: 'us-east-1', BEDROCK_MODELS: ['model-a'] },
      createUnconfiguredBedrockSigner(),
      vi.fn(),
    );
    const register = vi.fn();
    new BedrockModule(connector, { register } as never).onModuleInit();
    expect(register).toHaveBeenCalledWith(connector);
  });

  it('fails closed when no signer is configured', async () => {
    const signer = createUnconfiguredBedrockSigner();
    await expect(
      signer({
        method: 'POST',
        url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    ).rejects.toThrow('Bedrock SigV4 signer is not configured');
  });

  it('normalizes the unconfigured signer as an auth error on execution', async () => {
    const connector = new BedrockConnector(
      { BEDROCK_REGION: 'us-east-1', BEDROCK_MODELS: ['model-a'] },
      createUnconfiguredBedrockSigner(),
      vi.fn(),
    );
    const response = await connector.execute({ model: 'model-a', prompt: 'hello' });
    expect(response.error?.type).toBe('auth_error');
  });
});
