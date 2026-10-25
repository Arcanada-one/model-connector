import { availableParallelism } from 'node:os';

const pools = new Set(['threads', 'forks', 'vmThreads', 'vmForks', 'typescript']);
const positiveInteger = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

// Observe resolved values only. An unset worker limit is not an observed count.
export function profileObservation(ctx, cpuCount, overridePresent) {
  const root = ctx?.config ?? {};
  const projects = Array.isArray(ctx?.projects) ? ctx.projects : [];
  return {
    cpu: positiveInteger(cpuCount),
    overridePresent: overridePresent === true,
    projects: (projects.length ? projects : [{ config: root }]).map(({ config }) => ({
      pool: pools.has(config?.pool ?? root.pool) ? (config?.pool ?? root.pool) : null,
      maxWorkers: positiveInteger(config?.maxWorkers ?? root.maxWorkers),
      isolate:
        typeof (config?.isolate ?? root.isolate) === 'boolean'
          ? (config?.isolate ?? root.isolate)
          : null,
    })),
  };
}

export default class ProfileReporter {
  onInit(ctx) {
    // Observation failures must not change the suite's business verdict.
    try {
      console.info(
        'MC_TEST_PROFILE',
        JSON.stringify(
          profileObservation(
            ctx,
            availableParallelism(),
            Object.hasOwn(process.env, 'VITEST_MAX_WORKERS'),
          ),
        ),
      );
    } catch {
      /* No observation is NOT_MEASURED, never a test pass. */
    }
  }
}
