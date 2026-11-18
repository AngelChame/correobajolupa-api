import { defineConfig } from 'vitest/config';

// Pruebas de integración (`npm run test:int`): corren contra un PostgreSQL real.
// El globalSetup vacía la base de pruebas y aplica las migraciones antes de empezar.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    // Comparten una sola base: un archivo a la vez para que no se pisen.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
