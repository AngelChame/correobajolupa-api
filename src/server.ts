import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDb, disconnectDb } from './db/client.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
// Un solo cliente de base para todo el proceso; se conecta en la primera consulta.
const db = connectDb(config.DATABASE_URL);
const app = createApp({ logger, db, config });

const server = app.listen(config.PORT);
server.on('listening', () => logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API escuchando'));
server.on('error', (error) => {
  logger.fatal({ err: error }, 'la API no pudo arrancar');
  process.exit(1);
});

// Docker manda SIGTERM al detener el contenedor: primero se dejan de aceptar peticiones,
// se terminan las que están en curso y al final se cierra el pool de la base.
let cerrando = false;
function cerrar(signal: string) {
  if (cerrando) return;
  cerrando = true;
  logger.info({ signal }, 'cerrando la API');
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => {
    disconnectDb()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'error al cerrar la base de datos');
        process.exit(1);
      });
  });
}
process.on('SIGTERM', () => cerrar('SIGTERM'));
process.on('SIGINT', () => cerrar('SIGINT'));
