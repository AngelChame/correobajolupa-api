import type { RequestHandler } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import type { Config } from '../config.js';
import { normalizeEmail } from '../db/email.js';
import { rateLimitHandler } from '../http/global-limit.js';
import { sha256Hex } from './crypto.js';

export type AuthLimiters = {
  registerByIp: RequestHandler;
  loginByIp: RequestHandler;
  loginFailsByEmail: RequestHandler;
};

const MINUTO = 60 * 1000;

/**
 * Límites de peticiones de /auth (D-010, A-03). Cada createApp crea los suyos.
 *
 * Compromisos aceptados (M0):
 * - Los contadores viven en memoria: se reinician al reiniciar la API y no se comparten entre
 *   procesos. En M1 pueden pasar a Redis.
 * - 5 fallos por correo permiten que alguien bloquee 15 min el login de una cuenta concreta.
 * - La clave por IP usa req.ip. Sin proxy (nº 28) y con 'trust proxy' apagado, en el Compose
 *   req.ip es la del puente de Docker, así que todas las personas comparten el contador por IP.
 *   Al poner el proxy hay que activar 'trust proxy' con el número exacto de saltos.
 */
export function createAuthLimiters(config: Config): AuthLimiters {
  const comun: Partial<Options> = {
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
  };

  return {
    registerByIp: rateLimit({
      ...comun,
      windowMs: config.RATE_LIMIT_REGISTER_WINDOW_MIN * MINUTO,
      limit: config.RATE_LIMIT_REGISTER_PER_IP,
    }),
    loginByIp: rateLimit({
      ...comun,
      windowMs: config.RATE_LIMIT_LOGIN_WINDOW_MIN * MINUTO,
      limit: config.RATE_LIMIT_LOGIN_PER_IP,
    }),
    // Solo cuentan los fallos (respuestas >= 400): entrar bien no gasta intentos.
    // La clave es el SHA-256 del correo normalizado, así el correo no queda en memoria en claro.
    // Va después de la validación, que deja el cuerpo ya validado en res.locals.body.
    loginFailsByEmail: rateLimit({
      ...comun,
      windowMs: config.RATE_LIMIT_LOGIN_WINDOW_MIN * MINUTO,
      limit: config.RATE_LIMIT_LOGIN_FAILS_PER_EMAIL,
      skipSuccessfulRequests: true,
      keyGenerator: (_req, res) => `login:${sha256Hex(normalizeEmail(String(res.locals.body?.email ?? '')))}`,
    }),
  };
}
