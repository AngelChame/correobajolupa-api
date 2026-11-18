import type { Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config.js';
import { sendError } from './errors.js';

/** Respuesta 429 común a todos los límites, con la forma de error del contrato. */
export function rateLimitHandler(req: Request, res: Response): void {
  sendError(req, res, 429, 'rate_limited', 'Demasiados intentos. Espera unos minutos e intenta de nuevo.');
}

/**
 * Límite global por IP para todo /api/v1, salvo /health (el healthcheck de Docker no debe
 * gastarlo ni quedar bloqueado). Se monta antes de express.json para rechazar sin leer el cuerpo.
 * También evita que alguien llene la auditoría golpeando en bucle una ruta prohibida.
 *
 * El valor por defecto (300 por minuto) es holgado a propósito: sin proxy (nº 28) la API ve la
 * IP del puente de Docker para todo el mundo (D-048), así que este contador lo comparten todas
 * las personas. Revisarlo al activar 'trust proxy' con la nº 28.
 */
export function globalRateLimit(config: Config): RequestHandler {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: config.RATE_LIMIT_GLOBAL_PER_MINUTE,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
    handler: rateLimitHandler,
  });
}
