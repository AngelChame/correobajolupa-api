import { loadConfig } from './config.js';
import { connectDb, disconnectDb } from './db/client.js';
import { createLogger } from './logger.js';
import { runWorker } from './queue/loop.js';
import { createDiskStorage } from './storage/disk.js';

// Proceso del worker de análisis (D-054): misma imagen que la API, otro comando
// (`node dist/worker.js`). Toma reportes de la cola en PostgreSQL y los analiza.

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, undefined, 'worker');
const db = connectDb(config.DATABASE_URL);
const storage = createDiskStorage(config.STORAGE_DIR);

// SIGTERM (docker stop): se deja de tomar trabajos, se termina el actual y se cierra la base.
const apagado = new AbortController();
let cerrando = false;
function cerrar(signal: string) {
  if (cerrando) return;
  cerrando = true;
  logger.info({ signal }, 'cerrando el worker');
  apagado.abort();
  // Si el análisis en curso no termina a tiempo, se sale igual: su arriendo vencerá y otro
  // intento lo retomará (P-22).
  setTimeout(() => process.exit(1), 25_000).unref();
}
process.on('SIGTERM', () => cerrar('SIGTERM'));
process.on('SIGINT', () => cerrar('SIGINT'));

logger.info({ pollMs: config.WORKER_POLL_MS, leaseSeconds: config.JOB_LEASE_SECONDS }, 'worker iniciado');
await runWorker(
  {
    db,
    storage,
    logger,
    institutionalDomains: config.INSTITUTIONAL_DOMAINS,
    leaseSeconds: config.JOB_LEASE_SECONDS,
    maxAttempts: config.JOB_MAX_ATTEMPTS,
  },
  { pollMs: config.WORKER_POLL_MS, signal: apagado.signal },
);
await disconnectDb();
logger.info('worker detenido');
process.exit(0);
