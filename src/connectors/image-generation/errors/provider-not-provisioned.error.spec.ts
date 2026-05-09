import { describe, it, expect } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ProviderNotProvisionedError } from './provider-not-provisioned.error';

describe('ProviderNotProvisionedError', () => {
  it('has HTTP status 503', () => {
    const err = new ProviderNotProvisionedError(
      'vertex',
      'arcanada/prod/env/model-connector-vertex',
    );
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('carries machine-readable code PROVIDER_NOT_PROVISIONED', () => {
    const err = new ProviderNotProvisionedError(
      'vertex',
      'arcanada/prod/env/model-connector-vertex',
    );
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('PROVIDER_NOT_PROVISIONED');
  });

  it('exposes provider and vaultPath in response body', () => {
    const err = new ProviderNotProvisionedError(
      'replicate',
      'arcanada/prod/env/model-connector-replicate',
    );
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.provider).toBe('replicate');
    expect(body.vaultPath).toBe('arcanada/prod/env/model-connector-replicate');
  });

  it('has a human-readable message mentioning provider and vault path', () => {
    const err = new ProviderNotProvisionedError(
      'openai-images',
      'arcanada/prod/env/model-connector-openai-images',
    );
    const body = err.getResponse() as Record<string, unknown>;
    expect(typeof body.message).toBe('string');
    expect(body.message as string).toContain('openai-images');
    expect(body.message as string).toContain('arcanada/prod/env/model-connector-openai-images');
  });

  it('is an instance of Error', () => {
    const err = new ProviderNotProvisionedError('vertex', 'path');
    expect(err).toBeInstanceOf(Error);
  });
});
