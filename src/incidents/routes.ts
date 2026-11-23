import express, { type Request } from 'express';
import { AuditAction, recordAudit } from '../audit.js';
import { requireRole } from '../auth/roles.js';
import { CreateIncidentBody, IncidentQuery } from '../contract/schemas/incidents.js';
import type { Db } from '../db/client.js';
import { sendError } from '../http/errors.js';
import { parseBody, parseQuery } from '../http/validate.js';
import { uuidParam } from '../lab/routes.js';
import { INCIDENT_DETAIL_SELECT, INCIDENT_SUMMARY_SELECT, toIncidentDetailDto, toIncidentSummaryDto } from './dto.js';

export type IncidentsDeps = { db: Db };

/** Mensajes fijos: nunca repiten el título, la descripción ni nada que mande el cliente. */
const INCIDENT_NOT_FOUND = 'El incidente no existe.';

type IncidentAction = (typeof AuditAction)[
  | 'incidentCreate'
  | 'incidentUpdate'
  | 'incidentReportAdd'
  | 'incidentReportRemove'
  | 'incidentIndicatorAdd'
  | 'incidentIndicatorRemove'
  | 'incidentComment'];

type RejectionReason = 'invalid_body' | 'not_found';

/**
 * Audita un rechazo (400, 404 o 409) como la entrega simulada y los indicadores: solo el motivo
 * y los IDs ya validados como UUID. Nunca el título, la descripción ni el comentario (P-18). Si la
 * auditoría falla, se registra en pino y la respuesta no cambia.
 */
async function auditRejection(
  db: Db,
  req: Request,
  action: IncidentAction,
  entry: { reason: RejectionReason; incidentId?: string },
): Promise<void> {
  await recordAudit(db, {
    action,
    result: 'failure',
    requestId: String(req.id),
    actorId: req.auth!.user.id,
    targetType: 'incident',
    ...(entry.incidentId ? { targetId: entry.incidentId } : {}),
    metadata: { reason: entry.reason },
  }).catch(() => req.log.error('no se pudo registrar la auditoría del incidente'));
}

/**
 * Rutas de M6: incidentes y comentarios, solo analista y administrador (el 403 de rol lo audita
 * requireRole). Título, descripción y comentarios son texto de usuario: se guardan tal cual y
 * nunca van a los registros ni a la auditoría (P-18); ahí solo van IDs, nombres de campos,
 * estados, longitudes y motivos.
 */
export function createIncidentsRouter({ db }: IncidentsDeps) {
  const router = express.Router();
  const analista = requireRole(db, 'analyst', 'admin');

  const detalle = async (id: string) => {
    const fila = await db.incident.findUnique({ where: { id }, select: INCIDENT_DETAIL_SELECT });
    return fila ? toIncidentDetailDto(fila) : null;
  };

  router.post('/incidents', analista, async (req, res) => {
    if (!CreateIncidentBody.safeParse(req.body).success) await auditRejection(db, req, AuditAction.incidentCreate, { reason: 'invalid_body' });
    const body = parseBody(CreateIncidentBody, req, res);
    if (!body) return;
    const actor = req.auth!.user;
    const fila = await db.$transaction(async (tx) => {
      const creado = await tx.incident.create({
        data: { title: body.title, description: body.description ?? null, createdById: actor.id },
        select: INCIDENT_DETAIL_SELECT,
      });
      await recordAudit(tx, {
        action: AuditAction.incidentCreate,
        result: 'success',
        requestId: String(req.id),
        actorId: actor.id,
        targetType: 'incident',
        targetId: creado.id,
      });
      return creado;
    });
    res.status(201).json(toIncidentDetailDto(fila));
  });

  // Solo lectura: no se audita, como GET /indicators.
  router.get('/incidents', analista, async (req, res) => {
    const query = parseQuery(IncidentQuery, req, res);
    if (!query) return;
    const where = query.status ? { status: query.status } : {};
    const [total, filas] = await Promise.all([
      db.incident.count({ where }),
      db.incident.findMany({
        where,
        // Los que cambiaron más recientemente primero; el id desempata para paginar sin repetir.
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: INCIDENT_SUMMARY_SELECT,
      }),
    ]);
    res.json({ items: filas.map(toIncidentSummaryDto), page: query.page, pageSize: query.pageSize, total });
  });

  router.get('/incidents/:incidentId', analista, async (req, res) => {
    const id = uuidParam(req, res, 'incidentId', INCIDENT_NOT_FOUND);
    if (!id) return;
    const dto = await detalle(id);
    if (!dto) {
      sendError(req, res, 404, 'not_found', INCIDENT_NOT_FOUND);
      return;
    }
    res.json(dto);
  });

  return router;
}
