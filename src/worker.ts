import { loadConfig } from './config.js';
import { connectDb, disconnectDb } from './db/client.js';
import { createLogger } from './logger.js';
import { runFeedSchedule } from './feeds/refresh.js';
import { runCleanupSchedule } from './queue/cleanup.js';
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

logger.info(
  { pollMs: config.WORKER_POLL_MS, leaseSeconds: config.JOB_LEASE_SECONDS, cleanupIntervalMin: config.CLEANUP_INTERVAL_MIN },
  'worker iniciado',
);
// La cola y la limpieza programada corren a la vez; las dos terminan con SIGTERM.
await Promise.all([
  runWorker(
    {
      db,
      storage,
      logger,
      institutionalDomains: config.INSTITUTIONAL_DOMAINS,
      leaseSeconds: config.JOB_LEASE_SECONDS,
      maxAttempts: config.JOB_MAX_ATTEMPTS,
      enabledFeeds: [
        ...(config.OPENPHISH_FEED_ENABLED ? ['OpenPhish' as const] : []),
        ...(config.URLHAUS_AUTH_KEY ? ['URLhaus' as const] : []),
      ],
      scan: {
        host: config.CLAMAV_HOST,
        port: config.CLAMAV_PORT,
        timeoutMs: config.CLAMAV_TIMEOUT_MS,
        totalBudgetMs: config.CLAMAV_TOTAL_BUDGET_MS,
        maxScanBytes: config.CLAMAV_MAX_SCAN_BYTES,
        maxScanned: config.MAX_ATTACHMENTS_SCANNED,
      },
    },
    { pollMs: config.WORKER_POLL_MS, signal: apagado.signal },
  ),
  runCleanupSchedule({ db, storage, logger }, { intervalMs: config.CLEANUP_INTERVAL_MIN * 60_000, signal: apagado.signal }),
  runFeedSchedule(db, logger, {
    openPhishEnabled: config.OPENPHISH_FEED_ENABLED,
    urlhausAuthKey: config.URLHAUS_AUTH_KEY,
    intervalMs: config.FEED_REFRESH_HOURS * 60 * 60 * 1000,
    signal: apagado.signal,
  }),
]);
await disconnectDb();
logger.info('worker detenido');
process.exit(0);
