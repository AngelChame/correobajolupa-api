import type { Request, RequestHandler } from 'express';
import { AuditAction, recordAudit } from '../audit.js';
import type { Db } from '../db/client.js';
import type { Role } from '../generated/prisma/enums.js';
import { sendError } from '../http/errors.js';

/**
 * Patrón de la ruta (por ejemplo `/api/v1/users/:userId`), no la URL real: así la auditoría no
 * guarda IDs ni parámetros que mande quien intenta entrar.
 */
function routePattern(req: Request): string {
  const ruta = req.route as { path?: unknown } | undefined;
  return `${req.baseUrl}${typeof ruta?.path === 'string' ? ruta.path : ''}`;
}

/**
 * Exige sesión y uno de los roles dados. Se usa por ruta: `requireRole('admin')` o, desde M1,
 * `requireRole('analyst', 'admin')`.
 * - Sin sesión: 401 unauthenticated.
 * - Rol insuficiente: 403 forbidden, y queda en la auditoría como `authz.denied` (result denied).
 *
 * Cada denegación escribe una fila de auditoría. Lo que impide que alguien llene la tabla
 * golpeando una ruta prohibida en bucle es el límite global de peticiones por IP (app.ts).
 */
export function requireRole(db: Db, ...roles: Role[]): RequestHandler {
  if (roles.length === 0) throw new Error('requireRole necesita al menos un rol');
  return async (req, res, next) => {
    const auth = req.auth;
    if (!auth) {
      sendError(req, res, 401, 'unauthenticated', 'Inicia sesión para continuar.');
      return;
    }
    if (!roles.includes(auth.user.role)) {
      await recordAudit(db, {
        action: AuditAction.authzDenied,
        result: 'denied',
        requestId: String(req.id),
        actorId: auth.user.id,
        metadata: { method: req.method, route: routePattern(req), role: auth.user.role, requiredRoles: roles },
      });
      sendError(req, res, 403, 'forbidden', 'Tu rol no permite esta acción.');
      return;
    }
    next();
  };
}
