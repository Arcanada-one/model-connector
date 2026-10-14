import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;

export type CredentialProbeState = 'ready' | 'missing' | 'rejected' | 'unavailable';

export interface ProviderCredentialHealth {
  connector: string;
  required: boolean;
  state: CredentialProbeState;
  source: string;
  checkedAt: string;
}

export interface ProviderCredentialHealthLike {
  isReady(connector: string): boolean;
  isRequired(connector: string): boolean;
  check(connector: string, force?: boolean): Promise<ProviderCredentialHealth | null>;
  checkAdvertised(connectors: string[], force?: boolean): Promise<ProviderCredentialHealth[]>;
}

export const PROVIDER_CREDENTIAL_MANIFEST = {
  deepseek: {
    required: true,
    source: 'DEEPSEEK_API_KEY (protected deployment environment)',
    probe: 'GET https://api.deepseek.com/models with the configured credential',
  },
  openrouter: {
    required: false,
    source: 'Vault-managed deployment secret → OPENROUTER_API_KEY',
    probe: 'GET https://openrouter.ai/api/v1/models with the selected configured credential',
  },
  'claude-code': {
    required: false,
    source: 'Docker auth volume claude-auth mounted at ~/.claude',
    probe: 'claude auth status (local status command; no generation)',
  },
  cursor: {
    required: false,
    source:
      'Docker auth volumes cursor-auth (~/.cursor) and cursor-config (~/.config/cursor), or CURSOR_API_KEY',
    probe: 'cursor-agent status (local status command; no generation)',
  },
} as const;

type ManifestConnector = keyof typeof PROVIDER_CREDENTIAL_MANIFEST;

export interface CredentialHealthDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  runCommand: (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  now: () => Date;
}

const runtimeDeps: CredentialHealthDeps = {
  env: process.env,
  fetchImpl: fetch,
  async runCommand(binary, args) {
    try {
      const result = await execFile(binary, args, {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 16 * 1024,
        windowsHide: true,
        env: process.env,
      });
      return { code: 0, stdout: result.stdout };
    } catch (error) {
      const e = error as { code?: number; stdout?: string };
      return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '' };
    }
  },
  now: () => new Date(),
};

function credentialFor(
  connector: 'openrouter' | 'deepseek',
  env: NodeJS.ProcessEnv,
): string | undefined {
  const sharedName = connector === 'openrouter' ? 'OPENROUTER_API_KEY' : 'DEEPSEEK_API_KEY';
  return env[sharedName]?.trim() || undefined;
}

async function probeHttpCredential(
  url: string,
  credential: string | undefined,
  fetchImpl: typeof fetch,
): Promise<CredentialProbeState> {
  if (!credential) return 'missing';
  let response: Response | undefined;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok
      ? 'ready'
      : response.status === 401 || response.status === 403
        ? 'rejected'
        : 'unavailable';
  } catch {
    return 'unavailable';
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

function commandState(
  code: number,
  stdout: string,
  kind: 'claude' | 'cursor',
): CredentialProbeState {
  if (code < 0) return 'unavailable';
  if (code !== 0) return 'missing';
  if (kind === 'claude') {
    try {
      const parsed = JSON.parse(stdout) as { authMethod?: unknown; loggedIn?: unknown };
      return parsed.loggedIn === true ||
        (typeof parsed.authMethod === 'string' && parsed.authMethod !== 'none')
        ? 'ready'
        : 'missing';
    } catch {
      return 'unavailable';
    }
  }
  if (/not\s+authenticated|not\s+logged\s+in|unauthenticated/i.test(stdout)) return 'missing';
  if (/authenticated|logged\s+in/i.test(stdout)) return 'ready';
  return 'unavailable';
}

export class ProviderCredentialHealthService implements ProviderCredentialHealthLike {
  private readonly cache = new Map<
    ManifestConnector,
    { result: ProviderCredentialHealth; at: number }
  >();

  constructor(private readonly deps: CredentialHealthDeps = runtimeDeps) {}

  isManaged(connector: string): connector is ManifestConnector {
    return Object.hasOwn(PROVIDER_CREDENTIAL_MANIFEST, connector);
  }

  isReady(connector: string): boolean {
    if (!this.isManaged(connector)) return true;
    return this.cache.get(connector)?.result.state === 'ready';
  }

  isRequired(connector: string): boolean {
    return this.isManaged(connector) && PROVIDER_CREDENTIAL_MANIFEST[connector].required;
  }

  async check(connector: string, force = false): Promise<ProviderCredentialHealth | null> {
    if (!this.isManaged(connector)) return null;
    const now = this.deps.now();
    const cached = this.cache.get(connector);
    if (!force && cached && now.getTime() - cached.at < CACHE_TTL_MS) return cached.result;

    const result = await this.probe(connector);
    const health: ProviderCredentialHealth = {
      connector,
      required: PROVIDER_CREDENTIAL_MANIFEST[connector].required,
      state: result,
      source: PROVIDER_CREDENTIAL_MANIFEST[connector].source,
      checkedAt: now.toISOString(),
    };
    this.cache.set(connector, { result: health, at: now.getTime() });
    return health;
  }

  async checkAdvertised(connectors: string[], force = false): Promise<ProviderCredentialHealth[]> {
    const names = [...new Set(connectors)].filter((name) => this.isManaged(name));
    return Promise.all(
      names.map((name) => this.check(name, force) as Promise<ProviderCredentialHealth>),
    );
  }

  private async probe(connector: ManifestConnector): Promise<CredentialProbeState> {
    if (connector === 'deepseek' || connector === 'openrouter') {
      const credential = credentialFor(connector, this.deps.env);
      const url =
        connector === 'deepseek'
          ? 'https://api.deepseek.com/models'
          : 'https://openrouter.ai/api/v1/models';
      return probeHttpCredential(url, credential, this.deps.fetchImpl);
    }
    const binary =
      connector === 'claude-code'
        ? this.deps.env.CLAUDE_BINARY_PATH || 'claude'
        : this.deps.env.CURSOR_BINARY_PATH || 'cursor-agent';
    const args = connector === 'claude-code' ? ['auth', 'status'] : ['status'];
    const command = await this.deps.runCommand(binary, args);
    return commandState(
      command.code,
      command.stdout,
      connector === 'claude-code' ? 'claude' : 'cursor',
    );
  }
}

export const __INTERNALS__ = { commandState, credentialFor, probeHttpCredential, CACHE_TTL_MS };
