import express from 'express';
import type { Db } from '../db/client.js';
import { PageQuery, Role } from '../contract/schemas/common.js';
import { requireRole } from '../auth/roles.js';
import { toUserDto } from '../auth/routes.js';
import { parseQuery } from '../http/validate.js';

/** Consulta de GET /users: la misma del contrato (paginación y filtro por rol). */
const ListUsersQuery = PageQuery.extend({ role: Role.optional() });

export type UsersDeps = { db: Db };

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
        select: { id: true, email: true, displayName: true, role: true, active: true, createdAt: true },
      }),
    ]);
    res.json({ items: usuarios.map(toUserDto), page: query.page, pageSize: query.pageSize, total });
  });

  return router;
}
