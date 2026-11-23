import { createApp } from '../src/app.js';
import { createDecoyHash } from '../src/auth/password.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { createLogger } from '../src/logger.js';
import type { ReportStorage } from '../src/storage/storage.js';

/** Configuración de prueba: valores válidos y sintéticos, con overrides por prueba. */
export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://prueba:prueba@127.0.0.1:5432/sin_uso_test',
    COOKIE_SECURE: 'false',
    ...overrides,
  });
}

/**
 * Base falsa para las pruebas unitarias: no hay sesiones y cualquier otra consulta falla,
 * así una prueba unitaria nunca depende de PostgreSQL por accidente.
 */
export function fakeDb(): Db {
  const sinBase = () => {
    throw new Error('Esta prueba unitaria intentó usar la base de datos.');
  };
  return new Proxy({} as Db, {
    get: (_target, modelo) => {
      if (modelo === 'session') return { findUnique: async () => null, deleteMany: sinBase, updateMany: sinBase };
      return new Proxy({}, { get: () => sinBase });
    },
  });
}

/** Almacenamiento falso para las pruebas unitarias: cualquier uso falla (igual que fakeDb). */
export function fakeStorage(): ReportStorage {
  const sinDisco = () => Promise.reject(new Error('Esta prueba unitaria intentó usar el almacenamiento.'));
  return { save: sinDisco, read: sinDisco, deleteReport: sinDisco, listReports: sinDisco };
}

/** Hash señuelo compartido por las pruebas (se calcula una vez por archivo). */
export const decoyHash = await createDecoyHash();

/** App con base falsa que guarda en `lineas` todo lo que se registra. */
export function appConRegistros(overrides: NodeJS.ProcessEnv = {}) {
  const lineas: string[] = [];
  const logger = createLogger('info', { write: (linea: string) => void lineas.push(linea) });
  const app = createApp({ logger, db: fakeDb(), config: testConfig(overrides), decoyHash, storage: fakeStorage() });
  return { app, lineas };
}
