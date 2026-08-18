import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(here, 'src/shared'),
      '@main': resolve(here, 'src/main'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Suite-wide defaults for the processes tests start but do not own — see the
    // file, which is one assignment and a long explanation of why it is there.
    setupFiles: [resolve(here, 'tests/support/setup.ts')],
  },
});
