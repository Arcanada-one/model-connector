/** Focused source controls only; not the maintained FULL or DIAG16 executor. */
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/diagnostic/df60-grounding.spec.ts'] } });
