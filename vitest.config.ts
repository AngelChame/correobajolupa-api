import { defineConfig } from 'vitest/config';

// Pruebas unitarias (`npm test`): no necesitan base de datos ni Docker.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**'],
  },
});
