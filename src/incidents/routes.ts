import express, { type Request } from 'express';
import { AuditAction, recordAudit } from '../audit.js';
import { requireRole } from '../auth/roles.js';
import { CreateIncidentBody, IncidentQuery, UpdateIncidentBody } from '../contract/schemas/incidents.js';
import type { Db } from '../db/client.js';
import { sendError } from '../http/errors.js';
import { parseBody, parseQuery } from '../http/validate.js';
import { isUuid, uuidParam } from '../lab/routes.js';
import { INCIDENT_DETAIL_SELECT, INCIDENT_SUMMARY_SELECT, toIncidentDetailDto, toIncidentSummaryDto } from './dto.js';
import { canTransition, isFinal } from './status.js';

export type IncidentsDeps = { db: Db };

/** Mensajes fijos: nunca repiten el título, la descripción ni nada que mande el cliente. */
const INCIDENT_NOT_FOUND = 'El incidente no existe.';
const INCIDENT_FINAL = 'El incidente ya está cerrado o marcado como falso positivo: es de solo lectura.';
const INVALID_TRANSITION = 'Ese cambio de estado no está permitido desde el estado actual.';
const STATUS_CHANGED = 'Otra persona cambió el incidente al mismo tiempo. Vuelve a cargarlo e intenta de nuevo.';

type IncidentAction = (typeof AuditAction)[
  | 'incidentCreate'
  | 'incidentUpdate'
  | 'incidentReportAdd'
  | 'incidentReportRemove'
  | 'incidentIndicatorAdd'
  | 'incidentIndicatorRemove'
  | 'incidentComment'];

type RejectionReason = 'invalid_body' | 'not_found' | 'final' | 'invalid_transition' | 'status_changed';

/**
 * Audita un rechazo (400, 404 o 409) como la entrega simulada y los indicadores: solo el motivo
 * y los IDs ya validados como UUID (un ID mal formado en la URL no se guarda). Nunca el título, la descripción ni el comentario (P-18). Si la
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

  /**
   * Título, descripción y estado. Orden: 400 (cuerpo), 404 (no existe), 409 (final, transición
   * inválida o carrera). Lo que no cambia de verdad se ignora: un PATCH sin cambios reales
   * responde 200 sin tocar updatedAt (ni auditar). Cambiar el estado no mueve mensajes ni
   * deshace nada: eso es de M7.
   */
  router.patch('/incidents/:incidentId', analista, async (req, res) => {
    const action = AuditAction.incidentUpdate;
    const paramId = isUuid(req.params.incidentId) ? req.params.incidentId : undefined;
    if (!UpdateIncidentBody.safeParse(req.body).success) await auditRejection(db, req, action, { reason: 'invalid_body', ...(paramId ? { incidentId: paramId } : {}) });
    const body = parseBody(UpdateIncidentBody, req, res);
    if (!body) return;
    if (!paramId) await auditRejection(db, req, action, { reason: 'not_found' });
    const id = uuidParam(req, res, 'incidentId', INCIDENT_NOT_FOUND);
    if (!id) return;

    const actual = await db.incident.findUnique({ where: { id }, select: { title: true, description: true, status: true } });
    if (!actual) {
      await auditRejection(db, req, action, { reason: 'not_found', incidentId: id });
      sendError(req, res, 404, 'not_found', INCIDENT_NOT_FOUND);
      return;
    }

    const cambios: { title?: string; description?: string | null; status?: typeof actual.status } = {};
    if (body.title !== undefined && body.title !== actual.title) cambios.title = body.title;
    if (body.description !== undefined && body.description !== actual.description) cambios.description = body.description;
    if (body.status !== undefined && body.status !== actual.status) cambios.status = body.status;
    const campos = Object.keys(cambios);
    if (campos.length === 0) {
      res.json(await detalle(id));
      return;
    }
    if (isFinal(actual.status)) {
      await auditRejection(db, req, action, { reason: 'final', incidentId: id });
      sendError(req, res, 409, 'conflict', INCIDENT_FINAL);
      return;
    }
    if (cambios.status && !canTransition(actual.status, cambios.status)) {
      await auditRejection(db, req, action, { reason: 'invalid_transition', incidentId: id });
      sendError(req, res, 409, 'conflict', INVALID_TRANSITION);
      return;
    }

    const actor = req.auth!.user;
    const hecho = await db.$transaction(async (tx) => {
      // Condicional: si otra petición cambió el estado justo antes (o lo cerró), no cuenta.
      const { count } = await tx.incident.updateMany({ where: { id, status: actual.status }, data: { ...cambios, updatedAt: new Date() } });
      if (count === 0) return false;
      await recordAudit(tx, {
        action,
        result: 'success',
        requestId: String(req.id),
        actorId: actor.id,
        targetType: 'incident',
        targetId: id,
        // Solo los nombres de los campos y los estados; nunca los textos.
        metadata: { fields: campos, ...(cambios.status ? { fromStatus: actual.status, toStatus: cambios.status } : {}) },
      });
      return true;
    });
    if (!hecho) {
      await auditRejection(db, req, action, { reason: 'status_changed', incidentId: id });
      sendError(req, res, 409, 'conflict', STATUS_CHANGED);
      return;
    }
    res.json(await detalle(id));
  });

  return router;
}
