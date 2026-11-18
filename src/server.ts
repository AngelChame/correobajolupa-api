import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const app = createApp({ logger });

const server = app.listen(config.PORT);
server.on('listening', () => logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API escuchando'));
server.on('error', (error) => {
  logger.fatal({ err: error }, 'la API no pudo arrancar');
  process.exit(1);
});

// Docker manda SIGTERM al detener el contenedor: se cierran las conexiones con orden.
function cerrar(signal: string) {
  logger.info({ signal }, 'cerrando la API');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => cerrar('SIGTERM'));
process.on('SIGINT', () => cerrar('SIGINT'));
