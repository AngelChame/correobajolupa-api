import express, { type Request } from 'express';
import type { z } from 'zod';
import { AuditAction, recordAudit } from '../audit.js';
import { requireRole } from '../auth/roles.js';
import type { Config } from '../config.js';
import { Action, QuarantineRequest, QuarantineResponse, RestoreRequest, RestoreResponse } from '../contract/schemas/response.js';
import type { Db } from '../db/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { sendError } from '../http/errors.js';
import { parseBody } from '../http/validate.js';
import { isUuid, LAB_UNAVAILABLE, uuidParam } from '../lab/routes.js';
import { MailUnavailableError, type MailProvider } from '../mail/provider.js';
import { ActionNotFoundError, IncidentNotFoundError, IncidentStateError, quarantineMessages, restoreAction, type QuarantineDeps } from './service.js';

export type QuarantineRouteDeps = {
  db: Db;
  config: Config;
  openProvider: (address: string) => Promise<MailProvider>;
};

/** Mensajes fijos: nunca repiten nada que mande el cliente ni nada del servidor IMAP. */
const INCIDENT_NOT_FOUND = 'El incidente no existe.';
const ACTION_NOT_FOUND = 'La acción no existe o no es una cuarentena hecha.';
const WRONG_STATUS = 'Solo se puede poner en cuarentena con el incidente en análisis (analyzing) o contenido (contained).';

type RejectionReason = 'invalid_body' | 'not_found' | 'invalid_status' | 'mail_unavailable';

/**
 * Audita un rechazo de cuarentena o restauración (400, 404, 409 o 503) como la entrega simulada:
 * solo el motivo y el ID ya validado como UUID. Nunca lo que mandó el cliente (P-18). El 403 de
 * rol lo audita requireRole.
 */
async function auditRejection(
  db: Db,
  req: Request,
  action: (typeof AuditAction)['quarantineExecute' | 'quarantineRestore'],
  entry: { reason: RejectionReason; targetType: 'incident' | 'action'; targetId?: string | undefined },
): Promise<void> {
  await recordAudit(db, {
    action,
    result: 'failure',
    requestId: String(req.id),
    actorId: req.auth!.user.id,
    targetType: entry.targetType,
    ...(entry.targetId ? { targetId: entry.targetId } : {}),
    metadata: { reason: entry.reason },
  }).catch(() => req.log.error('no se pudo registrar la auditoría de la cuarentena'));
}

const ACTION_SELECT = {
  id: true,
  incidentId: true,
  messageId: true,
  type: true,
  status: true,
  originalLocation: true,
  originalUid: true,
  originalUidValidity: true,
  newLocation: true,
  newUid: true,
  newUidValidity: true,
  createdAt: true,
  actor: { select: { id: true, displayName: true } },
} as const satisfies Prisma.QuarantineActionSelect;

type ActionRow = Prisma.QuarantineActionGetPayload<{ select: typeof ACTION_SELECT }>;

/**
 * Forma Action del contrato. folder es la carpeta neutral (inbox o quarantine, D-007), como
 * MessageSummary.location: el nombre real de la carpeta en Dovecot no sale de la API.
 */
export function toActionDto(row: ActionRow): z.infer<typeof Action> {
  return Action.parse({
    id: row.id,
    incidentId: row.incidentId,
    messageId: row.messageId,
    type: row.type,
    status: row.status,
    originalLocation: { folder: row.originalLocation, uid: Number(row.originalUid), uidValidity: Number(row.originalUidValidity) },
    newLocation:
      row.newLocation !== null && row.newUid !== null && row.newUidValidity !== null
        ? { folder: row.newLocation, uid: Number(row.newUid), uidValidity: Number(row.newUidValidity) }
        : null,
    actor: row.actor,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Rutas de M7 (D-008, D-013): cuarentena aprobada mensaje por mensaje, acciones de un incidente y
 * restauración. Solo analista y administrador. Nada se mueve sin una persona y `confirm: true`.
 * Registros y auditoría solo con IDs y resultados (P-18).
 */
export function createQuarantineRouter({ db, config, openProvider }: QuarantineRouteDeps) {
  const router = express.Router();
  const analista = requireRole(db, 'analyst', 'admin');
  const deps = (req: Request): QuarantineDeps => ({ db, logger: req.log, maxEmlBytes: config.MAX_EML_BYTES, budgetMs: config.SYNC_BUDGET_MS, openProvider });

  router.post('/incidents/:incidentId/quarantine', analista, async (req, res) => {
    const action = AuditAction.quarantineExecute;
    const paramId = isUuid(req.params.incidentId) ? req.params.incidentId : undefined;
    if (!QuarantineRequest.safeParse(req.body).success) await auditRejection(db, req, action, { reason: 'invalid_body', targetType: 'incident', targetId: paramId });
    const body = parseBody(QuarantineRequest, req, res);
    if (!body) return;
    if (!paramId) await auditRejection(db, req, action, { reason: 'not_found', targetType: 'incident' });
    const id = uuidParam(req, res, 'incidentId', INCIDENT_NOT_FOUND);
    if (!id) return;

    try {
      const results = await quarantineMessages(deps(req), id, body.messageIds, { actorId: req.auth!.user.id, requestId: String(req.id) });
      res.json(QuarantineResponse.parse({ incidentId: id, results }));
    } catch (error) {
      if (error instanceof IncidentNotFoundError) {
        await auditRejection(db, req, action, { reason: 'not_found', targetType: 'incident', targetId: id });
        sendError(req, res, 404, 'not_found', INCIDENT_NOT_FOUND);
      } else if (error instanceof IncidentStateError) {
        await auditRejection(db, req, action, { reason: 'invalid_status', targetType: 'incident', targetId: id });
        sendError(req, res, 409, 'conflict', WRONG_STATUS);
      } else if (error instanceof MailUnavailableError) {
        // Cada mensaje ya quedó auditado con su resultado; aquí solo la respuesta.
        sendError(req, res, 503, 'service_unavailable', LAB_UNAVAILABLE);
      } else throw error;
    }
  });

  // Solo lectura: no se audita, como GET /incidents.
  router.get('/incidents/:incidentId/actions', analista, async (req, res) => {
    const id = uuidParam(req, res, 'incidentId', INCIDENT_NOT_FOUND);
    if (!id) return;
    if ((await db.incident.count({ where: { id } })) === 0) {
      sendError(req, res, 404, 'not_found', INCIDENT_NOT_FOUND);
      return;
    }
    const filas = await db.quarantineAction.findMany({
      where: { incidentId: id },
      // La más reciente primero; el id desempata.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: ACTION_SELECT,
    });
    res.json({ items: filas.map(toActionDto) });
  });

  // Se permite en cualquier estado del incidente (también cerrado o falso positivo).
  router.post('/actions/:actionId/restore', analista, async (req, res) => {
    const action = AuditAction.quarantineRestore;
    const paramId = isUuid(req.params.actionId) ? req.params.actionId : undefined;
    if (!RestoreRequest.safeParse(req.body).success) await auditRejection(db, req, action, { reason: 'invalid_body', targetType: 'action', targetId: paramId });
    const body = parseBody(RestoreRequest, req, res);
    if (!body) return;
    if (!paramId) await auditRejection(db, req, action, { reason: 'not_found', targetType: 'action' });
    const id = uuidParam(req, res, 'actionId', ACTION_NOT_FOUND);
    if (!id) return;

    try {
      const r = await restoreAction(deps(req), id, { actorId: req.auth!.user.id, requestId: String(req.id) });
      res.json(RestoreResponse.parse(r));
    } catch (error) {
      if (error instanceof ActionNotFoundError) {
        await auditRejection(db, req, action, { reason: 'not_found', targetType: 'action', targetId: id });
        sendError(req, res, 404, 'not_found', ACTION_NOT_FOUND);
      } else if (error instanceof MailUnavailableError) {
        await auditRejection(db, req, action, { reason: 'mail_unavailable', targetType: 'action', targetId: id });
        sendError(req, res, 503, 'service_unavailable', LAB_UNAVAILABLE);
      } else throw error;
    }
  });

  return router;
}
