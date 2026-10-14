/** Focused source controls only; not the maintained FULL or DIAG16 executor. */
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: [
      'test/diagnostic/df60-grounding.spec.ts',
      'test/diagnostic/df60-raw-cli.spec.ts',
      'test/diagnostic/df60-output-custody.spec.ts',
      'test/diagnostic/df60-accounting-port.spec.ts',
    ],
  },
});
