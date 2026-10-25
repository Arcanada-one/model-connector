const phases = new Set([
  'import-env',
  'validate-config',
  'import-connectors',
  'import-billing',
  'import-output-guard',
  'import-interface',
  'import-intent',
  'fixture-construction',
  'billing-construction',
  'connector-construction',
  'fixture-register',
  'memory-execute',
  'money-assertions',
]);

export function phaseStart(name: string) {
  if (!phases.has(name)) throw new Error('unsupported_test_phase');
  const start = performance.now();
  const cpu = process.cpuUsage();
  return () => {
    try {
      const used = process.cpuUsage(cpu);
      console.info(
        'MC_TEST_PHASE',
        JSON.stringify({
          phase: name,
          wallMs: performance.now() - start,
          cpuUserUs: used.user,
          cpuSystemUs: used.system,
        }),
      );
    } catch {
      /* Missing diagnostics never override an operation result/error. */
    }
  };
}

export function observeSync<T>(name: string, operation: () => T): T {
  const end = phaseStart(name);
  try {
    return operation();
  } finally {
    end();
  }
}

export async function observeAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const end = phaseStart(name);
  try {
    return await operation();
  } finally {
    end();
  }
}
