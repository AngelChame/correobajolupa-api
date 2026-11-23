import express, { type Request, type Response } from 'express';
import { AuditAction, recordAudit } from '../audit.js';
import { requireRole } from '../auth/roles.js';
import { AddIncidentIndicatorBody, AddIncidentReportBody, CreateCommentBody, CreateIncidentBody, IncidentQuery, UpdateIncidentBody } from '../contract/schemas/incidents.js';
import type { Db } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { sendError } from '../http/errors.js';
import { parseBody, parseQuery } from '../http/validate.js';
import { isUuid, uuidParam } from '../lab/routes.js';
import { COMMENT_SELECT, INCIDENT_DETAIL_SELECT, INCIDENT_SUMMARY_SELECT, toCommentDto, toIncidentDetailDto, toIncidentSummaryDto } from './dto.js';
import { canTransition, FINAL_STATUSES, isFinal } from './status.js';

export type IncidentsDeps = { db: Db };
type Tx = Prisma.TransactionClient;

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

type RejectionReason =
  | 'invalid_body'
  | 'not_found'
  | 'final'
  | 'invalid_transition'
  | 'status_changed'
  | 'report_not_found'
  | 'indicator_not_found'
  | 'already_linked'
  | 'not_linked';

/** ID del reporte o del indicador de una asociación, solo si ya se validó como UUID. */
type LinkRef = { reportId: string } | { indicatorId: string } | Record<string, never>;

/**
 * Audita un rechazo (400, 404 o 409) como la entrega simulada y los indicadores: solo el motivo
 * y los IDs ya validados como UUID (un ID mal formado en la URL o en el cuerpo no se guarda).
 * Nunca el título, la descripción ni el comentario (P-18). Si la auditoría falla, se registra en
 * pino y la respuesta no cambia.
 */
async function auditRejection(
  db: Db,
  req: Request,
  action: IncidentAction,
  entry: { reason: RejectionReason; incidentId?: string | undefined; link?: LinkRef },
): Promise<void> {
  await recordAudit(db, {
    action,
    result: 'failure',
    requestId: String(req.id),
    actorId: req.auth!.user.id,
    targetType: 'incident',
    ...(entry.incidentId ? { targetId: entry.incidentId } : {}),
    metadata: { ...entry.link, reason: entry.reason },
  }).catch(() => req.log.error('no se pudo registrar la auditoría del incidente'));
}

/** Para deshacer una transacción con un motivo de rechazo (409 o 404). */
class Rechazo extends Error {
  constructor(readonly reason: 'final' | 'not_linked') {
    super(reason);
  }
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

  /**
   * Asociaciones con reportes e indicadores: lo mismo para los dos, cambia la tabla. Cualquier
   * estado de indicador se puede asociar (M7 decide cuáles usa). Analista y administrador ven
   * todos los reportes, así que aquí no hay "ajeno".
   */
  const ASOCIACIONES = {
    report: {
      param: 'reportId',
      body: AddIncidentReportBody,
      add: AuditAction.incidentReportAdd,
      remove: AuditAction.incidentReportRemove,
      notFoundReason: 'report_not_found',
      notFound: 'El reporte no existe.',
      taken: 'El reporte ya está asociado al incidente.',
      notLinked: 'El reporte no está asociado al incidente.',
      ref: (id: string): LinkRef => ({ reportId: id }),
      exists: async (id: string) => (await db.report.count({ where: { id } })) > 0,
      link: (tx: Tx, incidentId: string, id: string, addedById: string) => tx.incidentReport.create({ data: { incidentId, reportId: id, addedById } }),
      unlink: async (tx: Tx, incidentId: string, id: string) => (await tx.incidentReport.deleteMany({ where: { incidentId, reportId: id } })).count,
    },
    indicator: {
      param: 'indicatorId',
      body: AddIncidentIndicatorBody,
      add: AuditAction.incidentIndicatorAdd,
      remove: AuditAction.incidentIndicatorRemove,
      notFoundReason: 'indicator_not_found',
      notFound: 'El indicador no existe.',
      taken: 'El indicador ya está asociado al incidente.',
      notLinked: 'El indicador no está asociado al incidente.',
      ref: (id: string): LinkRef => ({ indicatorId: id }),
      exists: async (id: string) => (await db.indicator.count({ where: { id } })) > 0,
      link: (tx: Tx, incidentId: string, id: string, addedById: string) => tx.incidentIndicator.create({ data: { incidentId, indicatorId: id, addedById } }),
      unlink: async (tx: Tx, incidentId: string, id: string) => (await tx.incidentIndicator.deleteMany({ where: { incidentId, indicatorId: id } })).count,
    },
  } as const;

  /**
   * Dentro de la transacción: sube updatedAt solo si el incidente no es final. Si otra petición lo
   * cerró justo antes, deshace todo con 409.
   */
  async function tocarSiAbierto(tx: Tx, id: string): Promise<void> {
    const { count } = await tx.incident.updateMany({ where: { id, status: { notIn: FINAL_STATUSES } }, data: { updatedAt: new Date() } });
    if (count === 0) throw new Rechazo('final');
  }

  function asociar(tipo: keyof typeof ASOCIACIONES) {
    const cfg = ASOCIACIONES[tipo];
    return async (req: Request, res: Response) => {
      const paramId = isUuid(req.params.incidentId) ? req.params.incidentId : undefined;
      const parsed = cfg.body.safeParse(req.body);
      if (!parsed.success) await auditRejection(db, req, cfg.add, { reason: 'invalid_body', incidentId: paramId });
      const body = parseBody(cfg.body, req, res);
      if (!body) return;
      const targetId = (body as Record<string, string>)[cfg.param]!;
      const link = cfg.ref(targetId);
      if (!paramId) await auditRejection(db, req, cfg.add, { reason: 'not_found', link });
      const id = uuidParam(req, res, 'incidentId', INCIDENT_NOT_FOUND);
      if (!id) return;

      const incidente = await db.incident.findUnique({ where: { id }, select: { status: true } });
      if (!incidente) {
        await auditRejection(db, req, cfg.add, { reason: 'not_found', incidentId: id, link });
        sendError(req, res, 404, 'not_found', INCIDENT_NOT_FOUND);
        return;
      }
      if (!(await cfg.exists(targetId))) {
        await auditRejection(db, req, cfg.add, { reason: cfg.notFoundReason, incidentId: id, link });
        sendError(req, res, 404, 'not_found', cfg.notFound);
        return;
      }
      if (isFinal(incidente.status)) {
        await auditRejection(db, req, cfg.add, { reason: 'final', incidentId: id, link });
        sendError(req, res, 409, 'conflict', INCIDENT_FINAL);
        return;
      }

      const actor = req.auth!.user;
      try {
        await db.$transaction(async (tx) => {
          await tocarSiAbierto(tx, id);
          await cfg.link(tx, id, targetId, actor.id);
          await recordAudit(tx, {
            action: cfg.add,
            result: 'success',
            requestId: String(req.id),
            actorId: actor.id,
            targetType: 'incident',
            targetId: id,
            metadata: link,
          });
        });
      } catch (error) {
        const rechazo = clasificar(error);
        if (!rechazo) throw error;
        // P2003: el reporte o el indicador se borró entre la comprobación y la inserción.
        const [reason, status, message] =
          rechazo === 'final' ? (['final', 409, INCIDENT_FINAL] as const)
          : rechazo === 'duplicate' ? (['already_linked', 409, cfg.taken] as const)
          : ([cfg.notFoundReason, 404, cfg.notFound] as const);
        await auditRejection(db, req, cfg.add, { reason, incidentId: id, link });
        sendError(req, res, status, status === 409 ? 'conflict' : 'not_found', message);
        return;
      }
      res.json(await detalle(id));
    };
  }

  function quitar(tipo: keyof typeof ASOCIACIONES) {
    const cfg = ASOCIACIONES[tipo];
    return async (req: Request, res: Response) => {
      const rawTarget = req.params[cfg.param];
      const link = isUuid(rawTarget) ? cfg.ref(rawTarget) : {};
      if (!isUuid(req.params.incidentId)) await auditRejection(db, req, cfg.remove, { reason: 'not_found', link });
      const id = uuidParam(req, res, 'incidentId', INCIDENT_NOT_FOUND);
      if (!id) return;

      const incidente = await db.incident.findUnique({ where: { id }, select: { status: true } });
      if (!incidente) {
        await auditRejection(db, req, cfg.remove, { reason: 'not_found', incidentId: id, link });
        sendError(req, res, 404, 'not_found', INCIDENT_NOT_FOUND);
        return;
      }
      // Un ID mal formado no puede estar asociado: 404, sin guardar lo que mandó el cliente.
      if (!isUuid(rawTarget)) {
        await auditRejection(db, req, cfg.remove, { reason: 'not_linked', incidentId: id });
        sendError(req, res, 404, 'not_found', cfg.notLinked);
        return;
      }
      if (isFinal(incidente.status)) {
        await auditRejection(db, req, cfg.remove, { reason: 'final', incidentId: id, link });
        sendError(req, res, 409, 'conflict', INCIDENT_FINAL);
        return;
      }

      const actor = req.auth!.user;
      try {
        await db.$transaction(async (tx) => {
          if ((await cfg.unlink(tx, id, rawTarget)) === 0) throw new Rechazo('not_linked');
          await tocarSiAbierto(tx, id);
          await recordAudit(tx, {
            action: cfg.remove,
            result: 'success',
            requestId: String(req.id),
            actorId: actor.id,
            targetType: 'incident',
            targetId: id,
            metadata: link,
          });
        });
      } catch (error) {
        if (!(error instanceof Rechazo)) throw error;
        await auditRejection(db, req, cfg.remove, { reason: error.reason, incidentId: id, link });
        if (error.reason === 'final') sendError(req, res, 409, 'conflict', INCIDENT_FINAL);
        else sendError(req, res, 404, 'not_found', cfg.notLinked);
        return;
      }
      res.status(204).end();
    };
  }

  /**
   * Comentarios: solo se crean (no hay rutas para editarlos ni borrarlos). Suben updatedAt del
   * incidente. La auditoría guarda solo la longitud, nunca el texto (P-18).
   */
  router.post('/incidents/:incidentId/comments', analista, async (req, res) => {
    const action = AuditAction.incidentComment;
    const paramId = isUuid(req.params.incidentId) ? req.params.incidentId : undefined;
    if (!CreateCommentBody.safeParse(req.body).success) await auditRejection(db, req, action, { reason: 'invalid_body', incidentId: paramId });
    const body = parseBody(CreateCommentBody, req, res);
    if (!body) return;
    if (!paramId) await auditRejection(db, req, action, { reason: 'not_found' });
    const id = uuidParam(req, res, 'incidentId', INCIDENT_NOT_FOUND);
    if (!id) return;

    const incidente = await db.incident.findUnique({ where: { id }, select: { status: true } });
    if (!incidente) {
      await auditRejection(db, req, action, { reason: 'not_found', incidentId: id });
      sendError(req, res, 404, 'not_found', INCIDENT_NOT_FOUND);
      return;
    }
    if (isFinal(incidente.status)) {
      await auditRejection(db, req, action, { reason: 'final', incidentId: id });
      sendError(req, res, 409, 'conflict', INCIDENT_FINAL);
      return;
    }

    const actor = req.auth!.user;
    let comentario;
    try {
      comentario = await db.$transaction(async (tx) => {
        await tocarSiAbierto(tx, id);
        const creado = await tx.incidentComment.create({ data: { incidentId: id, authorId: actor.id, body: body.body }, select: COMMENT_SELECT });
        await recordAudit(tx, {
          action,
          result: 'success',
          requestId: String(req.id),
          actorId: actor.id,
          targetType: 'incident',
          targetId: id,
          metadata: { commentId: creado.id, length: body.body.length },
        });
        return creado;
      });
    } catch (error) {
      if (!(error instanceof Rechazo)) throw error;
      await auditRejection(db, req, action, { reason: 'final', incidentId: id });
      sendError(req, res, 409, 'conflict', INCIDENT_FINAL);
      return;
    }
    res.status(201).json(toCommentDto(comentario));
  });

  router.post('/incidents/:incidentId/reports', analista, asociar('report'));
  router.delete('/incidents/:incidentId/reports/:reportId', analista, quitar('report'));
  router.post('/incidents/:incidentId/indicators', analista, asociar('indicator'));
  router.delete('/incidents/:incidentId/indicators/:indicatorId', analista, quitar('indicator'));

  return router;
}

/** Traduce un error de la transacción de asociar a un rechazo conocido, o null si es otro. */
function clasificar(error: unknown): 'final' | 'duplicate' | 'missing' | null {
  if (error instanceof Rechazo) return 'final';
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return 'duplicate';
    if (error.code === 'P2003') return 'missing';
  }
  return null;
}
