import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { csrfGuard } from './auth/csrf.js';
import { createAuthLimiters } from './auth/rate-limit.js';
import { createAuthRouter } from './auth/routes.js';
import { loadSession } from './auth/session.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { sendError } from './http/errors.js';
import { globalRateLimit } from './http/global-limit.js';
import { noStore, securityHeaders } from './http/security.js';
import { createReportsRouter } from './reports/routes.js';
import type { ReportStorage } from './storage/storage.js';
import { createUsersRouter } from './users/routes.js';

/** Se acepta el X-Request-Id que llega solo si es corto y sin caracteres raros; si no, se genera uno. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Ruta sin query string: los parámetros nunca van a los registros (D-036). */
const sinQuery = (url: string) => url.split('?')[0] ?? url;

/** Ruta del healthcheck; no se registra en cada petición (ver autoLogging). */
const HEALTH_PATH = '/api/v1/health';

export type AppDeps = {
  logger: Logger;
  db: Db;
  config: Config;
  /** Hash señuelo de Argon2id, calculado una vez al arrancar (createDecoyHash). */
  decoyHash: string;
  /** Archivos de los reportes (D-038). */
  storage: ReportStorage;
};

export function createApp({ logger, db, config, decoyHash, storage }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  // 'trust proxy' depende de TRUST_PROXY_HOPS (0 por defecto = apagado, mientras no exista el
  // proxy inverso, nº 28). Apagado, req.ip es la dirección de quien abre la conexión TCP; en el
  // Compose es la del puente de Docker, así que el límite por IP lo comparten todas las personas.
  // Con el proxy delante: TRUST_PROXY_HOPS=1 (un salto) y revisar los límites. Siempre un
  // número de saltos, nunca 'true': confiaría en cualquier X-Forwarded-For y la IP se podría
  // falsificar (config.ts solo acepta enteros).
  if (config.TRUST_PROXY_HOPS > 0) {
    app.set('trust proxy', config.TRUST_PROXY_HOPS);
  }

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const recibido = req.headers['x-request-id'];
        const id = typeof recibido === 'string' && REQUEST_ID.test(recibido) ? recibido : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // El healthcheck de Docker pide /health cada 10 s: registrarlo solo llena los logs de ruido.
      // Se compara la ruta sin query string y solo con GET; cualquier otra petición se registra.
      autoLogging: {
        ignore: (req) => req.method === 'GET' && sinQuery(req.url ?? '') === HEALTH_PATH,
      },
      // Solo método, ruta e ID: sin cabeceras, cookies ni cuerpo.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: sinQuery(req.url) }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  // Cabeceras de seguridad y no-store en todas las respuestas, también en errores y 404.
  // Van antes de las rutas: una ruta puede sobrescribirlas a propósito (ver src/http/security.ts).
  app.use(securityHeaders(config));
  app.use(noStore);

  // Límite global por IP en /api/v1 (salvo /health), antes de leer el cuerpo.
  app.use('/api/v1', globalRateLimit(config));

  // Límite provisional; los de reportes y archivos se fijan con la nº 5.
  app.use(express.json({ limit: '100kb' }));

  // Sesión de la cookie cbl_session (D-034): si es válida queda en req.auth.
  app.use(loadSession(db, config.COOKIE_SECURE));
  // CSRF para toda petición que modifica datos, salvo registro y entrada (D-044).
  app.use(csrfGuard);

  const v1 = express.Router();
  v1.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  v1.use('/auth', createAuthRouter({ db, config, decoyHash, limiters: createAuthLimiters(config) }));
  v1.use('/users', createUsersRouter({ db }));
  v1.use('/reports', createReportsRouter({ db, config, storage }));
  app.use('/api/v1', v1);

  app.use((req, res) => {
    sendError(req, res, 404, 'not_found', 'La ruta no existe.');
  });

  const manejarError: ErrorRequestHandler = (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const tipo = (err as { type?: unknown }).type;
    if (tipo === 'entity.parse.failed') {
      sendError(req, res, 400, 'validation_error', 'El cuerpo de la petición no es JSON válido.');
      return;
    }
    if (tipo === 'entity.too.large') {
      sendError(req, res, 413, 'payload_too_large', 'La petición es demasiado grande.');
      return;
    }
    req.log.error({ err }, 'error no controlado');
    sendError(req, res, 500, 'internal_error', 'Ocurrió un error interno. Intenta de nuevo.');
  };
  app.use(manejarError);

  return app;
}
