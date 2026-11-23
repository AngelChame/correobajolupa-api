import express from 'express';
import type { z } from 'zod';
import { requireRole } from '../auth/roles.js';
import { AuditEvent, AuditQuery } from '../contract/schemas/audit.js';
import type { Db } from '../db/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { sendError } from '../http/errors.js';
import { parseQuery } from '../http/validate.js';

export type AuditLogDeps = { db: Db };

const EVENT_SELECT = {
  id: true,
  createdAt: true,
  action: true,
  result: true,
  targetType: true,
  targetId: true,
  requestId: true,
  metadata: true,
  actor: { select: { id: true, displayName: true } },
} as const satisfies Prisma.AuditEventSelect;

type EventRow = Prisma.AuditEventGetPayload<{ select: typeof EVENT_SELECT }>;

/** metadata pasa tal cual solo si es un objeto de JSON; cualquier otra cosa (lista, texto, null) sale como {}. */
function metadataOf(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Forma AuditEvent del contrato. actor es null en los eventos del sistema (D-047). */
export function toAuditEventDto(row: EventRow): z.infer<typeof AuditEvent> {
  return AuditEvent.parse({
    id: row.id,
    at: row.createdAt.toISOString(),
    action: row.action,
    result: row.result,
    actor: row.actor,
    targetType: row.targetType,
    targetId: row.targetId,
    requestId: row.requestId,
    metadata: metadataOf(row.metadata),
  });
}

/**
 * GET /audit (M7): consulta de la auditoría, solo lectura para analista y administrador; el
 * reportante recibe 403 (y queda auditado por requireRole). La consulta en sí no se audita.
 * Filtros: action (igualdad exacta), actorId, from y to (inclusive). Orden: lo más reciente primero.
 */
export function createAuditLogRouter({ db }: AuditLogDeps) {
  const router = express.Router();
  const analista = requireRole(db, 'analyst', 'admin');

  router.get('/audit', analista, async (req, res) => {
    const query = parseQuery(AuditQuery, req, res);
    if (!query) return;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) {
      sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', [{ field: 'from', message: 'La fecha inicial no puede ser posterior a la final.' }]);
      return;
    }
    const where: Prisma.AuditEventWhereInput = {
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    const [total, filas] = await Promise.all([
      db.auditEvent.count({ where }),
      db.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: EVENT_SELECT,
      }),
    ]);
    res.json({ items: filas.map(toAuditEventDto), page: query.page, pageSize: query.pageSize, total });
  });

  return router;
}
