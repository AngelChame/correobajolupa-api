import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requireRole } from '../src/auth/roles.js';
import type { AuthContext } from '../src/auth/session.js';
import { ErrorResponse } from '../src/contract/schemas/common.js';
import type { Db } from '../src/db/client.js';

type Rol = AuthContext['user']['role'];

/** App mínima con una sesión simulada; registra lo que se audita en `auditados`. */
function app(rol: Rol | null) {
  const auditados: unknown[] = [];
  const db = { auditEvent: { create: async (args: unknown) => void auditados.push(args) } } as unknown as Db;
  const a = express();
  a.use((req, _res, next) => {
    req.id = 'req-prueba';
    if (rol) req.auth = { sessionId: 's', csrfToken: 'c', user: { id: 'u-1', role: rol } as AuthContext['user'] };
    next();
  });
  const router = express.Router();
  router.get('/:userId', requireRole(db, 'admin'), (_req, res) => {
    res.json({ ok: true });
  });
  a.use('/api/v1/users', router);
  return { app: a, auditados };
}

describe('requireRole', () => {
  it('sin sesión responde 401 y no audita', async () => {
    const { app: a, auditados } = app(null);
    const res = await request(a).get('/api/v1/users/123');
    expect(res.status).toBe(401);
    expect(ErrorResponse.parse(res.body).code).toBe('unauthenticated');
    expect(auditados).toHaveLength(0);
  });

  it.each(['reporter', 'analyst'] as const)('con rol %s responde 403 y audita authz.denied con el patrón de ruta', async (rol) => {
    const { app: a, auditados } = app(rol);
    const res = await request(a).get('/api/v1/users/MARCADOR_ID?x=MARCADOR_QUERY');
    expect(res.status).toBe(403);
    expect(ErrorResponse.parse(res.body).code).toBe('forbidden');
    expect(auditados).toEqual([
      {
        data: expect.objectContaining({
          action: 'authz.denied',
          result: 'denied',
          actorId: 'u-1',
          requestId: 'req-prueba',
          metadata: { method: 'GET', route: '/api/v1/users/:userId', role: rol, requiredRoles: ['admin'] },
        }),
      },
    ]);
    expect(JSON.stringify(auditados)).not.toMatch(/MARCADOR_ID|MARCADOR_QUERY/);
  });

  it('con el rol requerido deja pasar', async () => {
    const { app: a } = app('admin');
    expect((await request(a).get('/api/v1/users/123')).status).toBe(200);
  });
});
