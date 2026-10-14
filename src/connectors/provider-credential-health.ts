import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  isManaged(connector: string): boolean;
  isReady(connector: string): boolean;
  isRequired(connector: string): boolean;
  peek(connector: string): ProviderCredentialHealth | null;
  status(connector: string): ProviderCredentialHealth | null;
  check(connector: string, force?: boolean): Promise<ProviderCredentialHealth | null>;
  checkCredential(
    connector: string,
    credential: string,
    force?: boolean,
  ): Promise<ProviderCredentialHealth | null>;
  checkAdvertised(connectors: string[], force?: boolean): Promise<ProviderCredentialHealth[]>;
}

export const PROVIDER_CREDENTIAL_MANIFEST = {
  deepseek: {
    required: true,
    source: 'DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_* (protected deployment environment)',
    probe: 'GET {DEEPSEEK_BASE_URL}/models with each configured credential binding',
  },
  openrouter: {
    required: false,
    source: 'Vault-managed deployment secret → OPENROUTER_API_KEY or OPENROUTER_API_KEY_*',
    probe: 'GET https://openrouter.ai/api/v1/models with each configured credential binding',
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
  groq: {
    required: false,
    source: 'GROQ_API_KEY (protected deployment environment)',
    probe: 'GET https://api.groq.com/openai/v1/models with the configured credential',
  },
  gemini: {
    required: false,
    source: 'Gemini CLI auth profile in the process HOME',
    probe: 'gemini auth status (local status command; no generation)',
  },
  'gemini-api': {
    required: false,
    source: 'GEMINI_API_KEY (protected deployment environment)',
    probe: 'GET {GEMINI_API_BASE_URL}/models with x-goog-api-key; no generation',
  },
} as const;

type ManifestConnector = keyof typeof PROVIDER_CREDENTIAL_MANIFEST;
type HttpManifestConnector = 'openrouter' | 'deepseek' | 'groq' | 'gemini-api';

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
  connector: HttpManifestConnector,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const sharedName = {
    openrouter: 'OPENROUTER_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    groq: 'GROQ_API_KEY',
    'gemini-api': 'GEMINI_API_KEY',
  }[connector];
  return env[sharedName]?.trim() || undefined;
}

async function probeHttpCredential(
  url: string,
  credential: string | undefined,
  fetchImpl: typeof fetch,
  headerName = 'Authorization',
  headerValue = (value: string) => `Bearer ${value}`,
): Promise<CredentialProbeState> {
  if (!credential) return 'missing';
  let response: Response | undefined;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { [headerName]: headerValue(credential) },
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
  kind: 'claude' | 'cursor' | 'gemini',
): CredentialProbeState {
  if (code < 0) return 'unavailable';
  if (code !== 0) return 'missing';
  if (kind === 'claude') {
    try {
      const parsed = JSON.parse(stdout) as { authMethod?: unknown; loggedIn?: unknown };
      if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn ? 'ready' : 'missing';
      return typeof parsed.authMethod === 'string' && parsed.authMethod !== 'none'
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
  private readonly cache = new Map<string, { result: ProviderCredentialHealth; at: number }>();
  private readonly inFlight = new Map<string, Promise<ProviderCredentialHealth>>();

  constructor(private readonly deps: CredentialHealthDeps = runtimeDeps) {}

  isManaged(connector: string): connector is ManifestConnector {
    return Object.hasOwn(PROVIDER_CREDENTIAL_MANIFEST, connector);
  }

  isReady(connector: string): boolean {
    if (!this.isManaged(connector)) return true;
    return this.peek(connector)?.state === 'ready';
  }

  peek(connector: string): ProviderCredentialHealth | null {
    if (!this.isManaged(connector)) return null;
    const key = this.cacheKey(connector, this.httpCredentials(connector));
    const cached = this.cache.get(key);
    if (!cached || this.deps.now().getTime() - cached.at >= CACHE_TTL_MS) return null;
    return cached.result;
  }

  status(connector: string): ProviderCredentialHealth | null {
    if (!this.isManaged(connector)) return null;
    const measured = this.peek(connector);
    if (measured) return measured;
    const hasCredential =
      connector === 'openrouter' ||
      connector === 'deepseek' ||
      connector === 'groq' ||
      connector === 'gemini-api'
        ? this.httpCredentials(connector).length > 0
        : false;
    return {
      connector,
      required: PROVIDER_CREDENTIAL_MANIFEST[connector].required,
      state: hasCredential ? 'unavailable' : 'missing',
      source: PROVIDER_CREDENTIAL_MANIFEST[connector].source,
      checkedAt: this.deps.now().toISOString(),
    };
  }

  isRequired(connector: string): boolean {
    return this.isManaged(connector) && PROVIDER_CREDENTIAL_MANIFEST[connector].required;
  }

  async check(connector: string, force = false): Promise<ProviderCredentialHealth | null> {
    if (!this.isManaged(connector)) return null;
    const credentials = this.httpCredentials(connector);
    const cacheKey = this.cacheKey(connector, credentials);
    return this.checkCached(connector, cacheKey, force, () => this.probe(connector, credentials));
  }

  async checkCredential(
    connector: string,
    credential: string,
    force = false,
  ): Promise<ProviderCredentialHealth | null> {
    if (connector !== 'deepseek' && connector !== 'openrouter') return null;
    const value = credential.trim();
    if (!value) {
      return this.checkCached(
        connector,
        `${connector}:missing-profile`,
        force,
        async () => 'missing',
      );
    }
    return this.checkCached(connector, this.cacheKey(connector, [value]), force, () =>
      this.probeHttp(connector, value),
    );
  }

  private cacheKey(connector: ManifestConnector, credentials: string[]): string {
    const fingerprint = createHash('sha256').update(credentials.join('\0')).digest('hex');
    return `${connector}:${fingerprint}`;
  }

  private async checkCached(
    connector: ManifestConnector,
    cacheKey: string,
    force: boolean,
    probe: () => Promise<CredentialProbeState>,
  ): Promise<ProviderCredentialHealth> {
    const now = this.deps.now();
    const cached = this.cache.get(cacheKey);
    if (!force && cached && now.getTime() - cached.at < CACHE_TTL_MS) return cached.result;
    const current = this.inFlight.get(cacheKey);
    if (current) return current;

    const pending = probe().then((state) => {
      const health: ProviderCredentialHealth = {
        connector,
        required: PROVIDER_CREDENTIAL_MANIFEST[connector].required,
        state,
        source: PROVIDER_CREDENTIAL_MANIFEST[connector].source,
        checkedAt: this.deps.now().toISOString(),
      };
      this.cache.set(cacheKey, { result: health, at: this.deps.now().getTime() });
      return health;
    });
    this.inFlight.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(cacheKey) === pending) this.inFlight.delete(cacheKey);
    }
  }

  async checkAdvertised(connectors: string[], force = false): Promise<ProviderCredentialHealth[]> {
    const names = [...new Set(connectors)].filter((name) => this.isManaged(name));
    return Promise.all(
      names.map((name) => this.check(name, force) as Promise<ProviderCredentialHealth>),
    );
  }

  private httpCredentials(connector: ManifestConnector): string[] {
    if (
      connector === 'deepseek' ||
      connector === 'openrouter' ||
      connector === 'groq' ||
      connector === 'gemini-api'
    ) {
      const shared = credentialFor(connector, this.deps.env);
      return shared ? [shared] : [];
    }
    return [];
  }

  private async probeHttp(
    connector: HttpManifestConnector,
    credential: string,
  ): Promise<CredentialProbeState> {
    if (connector === 'deepseek') {
      const url = `${(this.deps.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')}/models`;
      return probeHttpCredential(url, credential, this.deps.fetchImpl);
    }
    if (connector === 'openrouter') {
      return probeHttpCredential(
        'https://openrouter.ai/api/v1/models',
        credential,
        this.deps.fetchImpl,
      );
    }
    if (connector === 'groq') {
      return probeHttpCredential(
        'https://api.groq.com/openai/v1/models',
        credential,
        this.deps.fetchImpl,
      );
    }
    const base = (
      this.deps.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '');
    return probeHttpCredential(
      `${base}/models`,
      credential,
      this.deps.fetchImpl,
      'x-goog-api-key',
      (value) => value,
    );
  }

  private async probe(
    connector: ManifestConnector,
    credentials: string[],
  ): Promise<CredentialProbeState> {
    if (
      connector === 'deepseek' ||
      connector === 'openrouter' ||
      connector === 'groq' ||
      connector === 'gemini-api'
    ) {
      if (!credentials.length) return 'missing';
      return this.probeHttp(connector, credentials[0]);
    }
    const binary =
      connector === 'claude-code'
        ? this.deps.env.CLAUDE_BINARY_PATH || 'claude'
        : connector === 'cursor'
          ? this.deps.env.CURSOR_BINARY_PATH || 'cursor-agent'
          : 'gemini';
    const args = connector === 'cursor' ? ['status'] : ['auth', 'status'];
    const command = await this.deps.runCommand(binary, args);
    const kind =
      connector === 'claude-code' ? 'claude' : connector === 'cursor' ? 'cursor' : 'gemini';
    return commandState(command.code, command.stdout, kind);
  }
}

export const __INTERNALS__ = {
  commandState,
  credentialFor,
  probeHttpCredential,
  CACHE_TTL_MS,
};
