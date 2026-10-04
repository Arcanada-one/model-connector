import { createPublicKey, KeyObject } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { BenchTrustedSocketAdapter } from './adapter';
import { requireBench } from './contract';
import { BenchReservationService, BenchServiceDependencies } from './service';
import { CampaignStore, CheckpointStore } from './store';

export type BenchCustodyCompositionOptions =
  | { enabled?: false }
  | { enabled: true; socketPath: string; dependencies: BenchServiceDependencies };
export interface BenchCustodyLifecycle {
  start(): Promise<boolean>;
  stop(): Promise<void>;
}

/** Source composition only. No AppModule registration, env/key loading, grant
 * issuer, provider fallback or automatic campaign provisioning. Explicit true
 * is a source lifecycle switch, never financial or runtime admission. */
export function composeBenchCustody(
  options: BenchCustodyCompositionOptions = {},
): BenchCustodyLifecycle | undefined {
  if (options.enabled !== true) {
    requireBench(
      options.enabled === false || options.enabled === undefined,
      'composition_flag_invalid',
    );
    return undefined; // Do not read dependencies or socketPath on the disabled path.
  }
  const { socketPath, dependencies: deps } = options;
  requireBench(
    typeof socketPath === 'string' && isAbsolute(socketPath) && Buffer.byteLength(socketPath) < 108,
    'composition_socket_invalid',
  );
  requireBench(
    !!deps && deps.campaign instanceof CampaignStore && deps.checkpoint instanceof CheckpointStore,
    'composition_stores_required',
  );
  requireBench(
    deps.issuerPublicKey instanceof KeyObject &&
      deps.issuerPublicKey.type === 'public' &&
      deps.issuerPublicKey.asymmetricKeyType === 'ed25519' &&
      deps.custodianPrivateKey instanceof KeyObject &&
      deps.custodianPrivateKey.type === 'private' &&
      deps.custodianPrivateKey.asymmetricKeyType === 'ed25519',
    'composition_keys_required',
  );
  requireBench(
    !deps.issuerPublicKey
      .export({ format: 'der', type: 'spki' })
      .equals(createPublicKey(deps.custodianPrivateKey).export({ format: 'der', type: 'spki' })),
    'composition_issuer_signer_separation',
  );
  requireBench(
    typeof deps.authArcanaJwks === 'string' &&
      deps.authArcanaJwks.trim().length > 0 &&
      typeof deps.now === 'function',
    'composition_auth_clock_required',
  );
  // Keep the supplied stores and Auth contract. Signed grants still bind the
  // account, caller, JWKS, original ledger, caps, hard bounds and actual wire.
  const service = new BenchReservationService({ ...deps });
  const adapter = new BenchTrustedSocketAdapter(service, socketPath);
  let running = false;
  let tail: Promise<void> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  return Object.freeze({
    start: () =>
      serialize(async () => {
        if (running) return true;
        running = await adapter.start(true);
        return running;
      }),
    stop: () =>
      serialize(async () => {
        running = false;
        await adapter.stop();
      }),
  });
}
