import type { RequestHandler } from 'express';
import { sendError } from '../http/errors.js';
import { safeEqual } from './crypto.js';

export const CSRF_HEADER = 'x-csrf-token';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Únicas rutas que modifican datos sin sesión previa y, por tanto, sin token CSRF (D-044). */
const EXEMPT = new Set(['/api/v1/auth/register', '/api/v1/auth/login']);

/** Express enruta sin distinguir mayúsculas ni la barra final: se normaliza igual. */
const normalizar = (path: string) => path.toLowerCase().replace(/\/+$/, '');

/**
 * Protección CSRF global y segura por defecto: toda petición que modifica datos exige sesión
 * y la cabecera X-CSRF-Token igual al token de la sesión (patrón de token sincronizado).
 * Va después de loadSession y antes de las rutas, así una ruta nueva no puede olvidarla.
 * Sin sesión: 401. Token faltante o distinto: 403. La comparación es en tiempo constante.
 */
export const csrfGuard: RequestHandler = (req, res, next) => {
  if (!MUTATING.has(req.method) || EXEMPT.has(normalizar(req.path))) {
    next();
    return;
  }
  if (!req.auth) {
    sendError(req, res, 401, 'unauthenticated', 'Inicia sesión para continuar.');
    return;
  }
  const recibido = req.get(CSRF_HEADER);
  if (typeof recibido !== 'string' || !safeEqual(recibido, req.auth.csrfToken)) {
    sendError(req, res, 403, 'forbidden', 'Falta el token CSRF o no es válido. Recarga la página e intenta de nuevo.');
    return;
  }
  next();
};
