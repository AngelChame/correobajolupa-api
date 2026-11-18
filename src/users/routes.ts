import express from 'express';
import { z } from 'zod';
import { AuditAction, recordAudit } from '../audit.js';
import { requireRole } from '../auth/roles.js';
import { toUserDto } from '../auth/routes.js';
import { UpdateUserBody } from '../contract/schemas/auth.js';
import { PageQuery, Role } from '../contract/schemas/common.js';
import type { Db } from '../db/client.js';
import type { Role as RoleType } from '../generated/prisma/enums.js';
import { sendError } from '../http/errors.js';
import { parseBody, parseQuery } from '../http/validate.js';

/** Consulta de GET /users: la misma del contrato (paginación y filtro por rol). */
const ListUsersQuery = PageQuery.extend({ role: Role.optional() });
const UserId = z.uuid();

/** Campos públicos de un usuario (forma User del contrato); nunca el hash. */
const PUBLIC_USER = { id: true, email: true, displayName: true, role: true, active: true, createdAt: true } as const;

export type UsersDeps = { db: Db };

type Fila = { id: string; role: RoleType; active: boolean };

type Resultado =
  | { tipo: 'not_found' }
  | { tipo: 'forbidden' }
  | { tipo: 'conflict'; mensaje: string }
  | { tipo: 'ok'; user: Parameters<typeof toUserDto>[0] };

/** Rutas de /users: solo administrador (paso 4 de M0). */
export function createUsersRouter({ db }: UsersDeps) {
  const router = express.Router();
  const soloAdmin = requireRole(db, 'admin');

  router.get('/', soloAdmin, async (req, res) => {
    const query = parseQuery(ListUsersQuery, req, res);
    if (!query) return;
    const where = query.role ? { role: query.role } : {};
    const [total, usuarios] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        // createdAt y luego id: orden total, así la paginación no repite ni salta filas.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: PUBLIC_USER,
      }),
    ]);
    res.json({ items: usuarios.map(toUserDto), page: query.page, pageSize: query.pageSize, total });
  });

  // El csrfGuard global ya exigió X-CSRF-Token antes de llegar aquí.
  router.patch('/:userId', soloAdmin, async (req, res) => {
    const userId = req.params.userId;
    // Un ID que no es UUID se trata como inexistente (404): no hace falta otro código.
    if (typeof userId !== 'string' || !UserId.safeParse(userId).success) {
      sendError(req, res, 404, 'not_found', 'El usuario no existe.');
      return;
    }
    const body = parseBody(UpdateUserBody, req, res);
    if (!body) return;
    if (body.role === undefined && body.active === undefined) {
      sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', [
        { field: 'body', message: 'Indica al menos uno de estos campos: role o active.' },
      ]);
      return;
    }

    const actor = req.auth!.user;
    const requestId = String(req.id);

    const resultado = await db.$transaction(async (tx): Promise<Resultado> => {
      // 1) Candado del conjunto de administradores activos, siempre en el mismo orden (por id),
      //    antes de tocar al usuario objetivo. Si dos administradores se degradan a la vez, el
      //    segundo espera aquí y, al seguir, vuelve a leer el conjunto ya actualizado. Tomar los
      //    candados siempre en este orden evita interbloqueos entre peticiones simultáneas.
      const admins = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM users WHERE role = 'admin' AND active ORDER BY id FOR UPDATE`;

      // requireRole revisó el rol antes del candado; otro administrador pudo degradar o desactivar
      // a quien actúa justo en ese instante. Se vuelve a comprobar con el conjunto ya bloqueado.
      if (!admins.some((a) => a.id === actor.id)) return { tipo: 'forbidden' };

      // 2) Candado del usuario objetivo.
      const [objetivo] = await tx.$queryRaw<Fila[]>`
        SELECT id, role::text AS role, active FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (!objetivo) return { tipo: 'not_found' };

      const rolNuevo = body.role ?? objetivo.role;
      const activoNuevo = body.active ?? objetivo.active;
      const cambiaRol = rolNuevo !== objetivo.role;
      const cambiaActivo = activoNuevo !== objetivo.active;

      // Un PATCH que no cambia nada real no audita ni cierra sesiones.
      if (!cambiaRol && !cambiaActivo) {
        return { tipo: 'ok', user: await tx.user.findUniqueOrThrow({ where: { id: userId }, select: PUBLIC_USER }) };
      }

      const dejaDeSerAdminActivo = objetivo.role === 'admin' && objetivo.active && (rolNuevo !== 'admin' || !activoNuevo);
      if (dejaDeSerAdminActivo && objetivo.id === actor.id) {
        return { tipo: 'conflict', mensaje: 'No puedes quitarte el rol de administrador ni desactivar tu propia cuenta.' };
      }
      if (dejaDeSerAdminActivo && admins.every((a) => a.id === objetivo.id)) {
        return { tipo: 'conflict', mensaje: 'Debe quedar al menos un administrador activo.' };
      }

      const user = await tx.user.update({
        where: { id: userId },
        data: { ...(cambiaRol ? { role: rolNuevo } : {}), ...(cambiaActivo ? { active: activoNuevo } : {}) },
        select: PUBLIC_USER,
      });

      // D-034: al cambiar el rol o desactivar se cierran todas sus sesiones. Reactivar no hace falta.
      if (cambiaRol || (cambiaActivo && !activoNuevo)) {
        await tx.session.deleteMany({ where: { userId } });
      }

      const comun = { result: 'success' as const, requestId, actorId: actor.id, targetType: 'user', targetId: userId };
      if (cambiaRol) {
        await recordAudit(tx, { ...comun, action: AuditAction.roleChange, metadata: { roleFrom: objetivo.role, roleTo: rolNuevo } });
      }
      if (cambiaActivo) {
        await recordAudit(tx, { ...comun, action: activoNuevo ? AuditAction.activate : AuditAction.deactivate });
      }
      return { tipo: 'ok', user };
    });

    if (resultado.tipo === 'forbidden') {
      sendError(req, res, 403, 'forbidden', 'Tu rol no permite esta acción.');
      return;
    }
    if (resultado.tipo === 'not_found') {
      sendError(req, res, 404, 'not_found', 'El usuario no existe.');
      return;
    }
    if (resultado.tipo === 'conflict') {
      // Sin details: el contrato los reserva para validation_error.
      sendError(req, res, 409, 'conflict', resultado.mensaje);
      return;
    }
    res.json(toUserDto(resultado.user));
  });

  return router;
}
