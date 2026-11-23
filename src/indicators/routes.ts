import express, { type Request, type Response } from 'express';
import type { z } from 'zod';
import { AuditAction, recordAudit } from '../audit.js';
import { requireRole } from '../auth/roles.js';
import type { Config } from '../config.js';
import { CreateExclusionBody, Exclusion, Indicator, IndicatorQuery, ProposeIndicatorBody } from '../contract/schemas/indicators.js';
import type { Db } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { IndicatorType } from '../generated/prisma/enums.js';
import { sendError } from '../http/errors.js';
import { parseBody, parseQuery } from '../http/validate.js';
import { isUuid, uuidParam } from '../lab/routes.js';
import { configExclusions, isExcluded } from './exclusions.js';
import { defangIndicator, INVALID_VALUE, normalizeHost, normalizeIndicator } from './normalize.js';

export type IndicatorsDeps = { db: Db; config: Config };

/** Mensajes fijos: nunca repiten el valor recibido. */
const EXCLUSION_TAKEN = 'Ese dominio ya está excluido.';
const INDICATOR_NOT_FOUND = 'El indicador no existe.';
const INDICATOR_EXCLUDED = 'El dominio está en la lista de exclusión: no puede ser indicador.';
const INDICATOR_TAKEN = 'Ese indicador ya existe.';
const INDICATOR_DECIDED = 'El indicador ya fue decidido.';

function toExclusionDto(row: { id: string | null; domain: string; reason: string | null; createdAt: Date | null }, source: 'config' | 'manual'): z.infer<typeof Exclusion> {
  return Exclusion.parse({
    id: row.id,
    // Desactivado (D-017): el dominio nunca sale clicable.
    domain: defangIndicator('domain', row.domain),
    source,
    reason: row.reason,
    createdAt: row.createdAt?.toISOString() ?? null,
  });
}

const INDICATOR_SELECT = {
  id: true,
  type: true,
  value: true,
  status: true,
  reportId: true,
  createdAt: true,
  decidedAt: true,
  proposedBy: { select: { id: true, displayName: true } },
  decidedBy: { select: { id: true, displayName: true } },
} as const;

type IndicatorRow = Prisma.IndicatorGetPayload<{ select: typeof INDICATOR_SELECT }>;

/** Forma del contrato: el valor sale solo desactivado (displayValue, D-017); nunca crudo ni la nota. */
function toIndicatorDto(row: IndicatorRow): z.infer<typeof Indicator> {
  return Indicator.parse({
    id: row.id,
    type: row.type,
    displayValue: defangIndicator(row.type, row.value),
    status: row.status,
    reportId: row.reportId,
    proposedBy: row.proposedBy,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  });
}

type IndicatorAction = (typeof AuditAction)['indicatorPropose' | 'indicatorConfirm' | 'indicatorDismiss'];
type RejectionReason = 'report_not_found' | 'not_found' | 'excluded' | 'duplicate' | 'already_decided';

/**
 * Audita un indicador rechazado (404 o 409), como la entrega simulada (D-006). Solo IDs ya
 * validados, el tipo y el motivo: nunca el valor propuesto, la nota ni nada del cliente. Si la
 * auditoría falla, se registra en pino y la respuesta no cambia.
 */
async function auditRejection(
  db: Db,
  req: Request,
  action: IndicatorAction,
  entry: { reason: RejectionReason; indicatorId?: string; type?: IndicatorType; reportId?: string },
): Promise<void> {
  const metadata = { ...(entry.type ? { type: entry.type } : {}), ...(entry.reportId ? { reportId: entry.reportId } : {}), reason: entry.reason };
  await recordAudit(db, {
    action,
    result: 'failure',
    requestId: String(req.id),
    actorId: req.auth!.user.id,
    targetType: 'indicator',
    ...(entry.indicatorId ? { targetId: entry.indicatorId } : {}),
    metadata,
  }).catch(() => req.log.error('no se pudo registrar la auditoría del indicador'));
}

/** Host de un indicador ya guardado (para volver a comprobar la exclusión al confirmar). */
function storedHost(type: IndicatorType, value: string): string | null {
  const r = normalizeIndicator(type, value);
  return r.ok ? r.host : null;
}

/**
 * Rutas de M5: indicadores y lista de exclusión (D-019). En los registros y la auditoría solo van
 * IDs, tipo y motivo: nunca el valor de un indicador, la nota ni el dominio excluido (P-18).
 */
export function createIndicatorsRouter({ db, config }: IndicatorsDeps) {
  const router = express.Router();
  const analista = requireRole(db, 'analyst', 'admin');
  // Proponer y listar: cualquier rol con sesión; lo que puede cada uno se decide en la ruta.
  const conSesion = requireRole(db, 'reporter', 'analyst', 'admin');

  router.post('/indicators', conSesion, async (req, res) => {
    const body = parseBody(ProposeIndicatorBody, req, res);
    if (!body) return;
    const actor = req.auth!.user;
    const esReportante = actor.role === 'reporter';
    if (esReportante && !body.reportId) {
      sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', [{ field: 'reportId', message: 'El reportante solo propone desde un reporte suyo.' }]);
      return;
    }
    const normalizado = normalizeIndicator(body.type, body.value);
    if (!normalizado.ok) {
      sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', [{ field: 'value', message: normalizado.message }]);
      return;
    }
    const base = { type: body.type, ...(body.reportId ? { reportId: body.reportId } : {}) };

    if (body.reportId) {
      // Mismas reglas que GET /reports/{id}: el reportante, solo los suyos (ajeno = inexistente).
      const report = await db.report.findFirst({ where: { id: body.reportId, ...(esReportante ? { userId: actor.id } : {}) }, select: { id: true } });
      if (!report) {
        await auditRejection(db, req, AuditAction.indicatorPropose, { ...base, reason: 'report_not_found' });
        sendError(req, res, 404, 'not_found', 'El reporte no existe.');
        return;
      }
    }
    if (normalizado.host && (await isExcluded(db, config.INSTITUTIONAL_DOMAINS, normalizado.host))) {
      await auditRejection(db, req, AuditAction.indicatorPropose, { ...base, reason: 'excluded' });
      sendError(req, res, 409, 'conflict', INDICATOR_EXCLUDED);
      return;
    }

    let fila: IndicatorRow;
    try {
      fila = await db.$transaction(async (tx) => {
        const creado = await tx.indicator.create({
          data: { type: body.type, value: normalizado.value, reportId: body.reportId ?? null, proposedById: actor.id, note: body.note ?? null },
          select: INDICATOR_SELECT,
        });
        await recordAudit(tx, {
          action: AuditAction.indicatorPropose,
          result: 'success',
          requestId: String(req.id),
          actorId: actor.id,
          targetType: 'indicator',
          targetId: creado.id,
          metadata: base,
        });
        return creado;
      });
    } catch (error) {
      // Ya hay uno igual propuesto o confirmado (índice único parcial).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await auditRejection(db, req, AuditAction.indicatorPropose, { ...base, reason: 'duplicate' });
        sendError(req, res, 409, 'conflict', INDICATOR_TAKEN);
        return;
      }
      throw error;
    }
    res.status(201).json(toIndicatorDto(fila));
  });

  router.get('/indicators', conSesion, async (req, res) => {
    const query = parseQuery(IndicatorQuery, req, res);
    if (!query) return;
    const actor = req.auth!.user;
    const where = {
      ...(actor.role === 'reporter' ? { proposedById: actor.id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const [total, filas] = await Promise.all([
      db.indicator.count({ where }),
      db.indicator.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: INDICATOR_SELECT,
      }),
    ]);
    res.json({ items: filas.map(toIndicatorDto), page: query.page, pageSize: query.pageSize, total });
  });

  /** Confirmar o descartar: solo un indicador propuesto; al confirmar se vuelve a mirar la exclusión. */
  function decidir(status: 'confirmed' | 'dismissed', action: IndicatorAction) {
    return async (req: Request, res: Response) => {
      // ID mal formado: 404 auditado, sin guardar lo que mandó el cliente.
      if (!isUuid(req.params.indicatorId)) await auditRejection(db, req, action, { reason: 'not_found' });
      const id = uuidParam(req, res, 'indicatorId', INDICATOR_NOT_FOUND);
      if (!id) return;
      const actor = req.auth!.user;

      const actual = await db.indicator.findUnique({ where: { id }, select: { type: true, value: true, status: true } });
      if (!actual) {
        await auditRejection(db, req, action, { reason: 'not_found', indicatorId: id });
        sendError(req, res, 404, 'not_found', INDICATOR_NOT_FOUND);
        return;
      }
      if (actual.status !== 'proposed') {
        await auditRejection(db, req, action, { reason: 'already_decided', indicatorId: id, type: actual.type });
        sendError(req, res, 409, 'conflict', INDICATOR_DECIDED);
        return;
      }
      // Pudo excluirse después de proponerse (P-11).
      const host = storedHost(actual.type, actual.value);
      if (status === 'confirmed' && host && (await isExcluded(db, config.INSTITUTIONAL_DOMAINS, host))) {
        await auditRejection(db, req, action, { reason: 'excluded', indicatorId: id, type: actual.type });
        sendError(req, res, 409, 'conflict', INDICATOR_EXCLUDED);
        return;
      }

      const fila = await db.$transaction(async (tx) => {
        // Condicional: si otra petición lo decidió justo antes, no cuenta.
        const { count } = await tx.indicator.updateMany({ where: { id, status: 'proposed' }, data: { status, decidedById: actor.id, decidedAt: new Date() } });
        if (count === 0) return null;
        await recordAudit(tx, {
          action,
          result: 'success',
          requestId: String(req.id),
          actorId: actor.id,
          targetType: 'indicator',
          targetId: id,
          metadata: { type: actual.type },
        });
        return tx.indicator.findUniqueOrThrow({ where: { id }, select: INDICATOR_SELECT });
      });
      if (!fila) {
        await auditRejection(db, req, action, { reason: 'already_decided', indicatorId: id, type: actual.type });
        sendError(req, res, 409, 'conflict', INDICATOR_DECIDED);
        return;
      }
      res.json(toIndicatorDto(fila));
    };
  }

  router.post('/indicators/:indicatorId/confirm', analista, decidir('confirmed', AuditAction.indicatorConfirm));
  router.post('/indicators/:indicatorId/dismiss', analista, decidir('dismissed', AuditAction.indicatorDismiss));

  // Los institucionales de la configuración van primero, como solo lectura (id null).
  router.get('/exclusions', analista, async (_req, res) => {
    const filas = await db.exclusion.findMany({ orderBy: [{ domain: 'asc' }] });
    res.json({
      items: [
        ...configExclusions(config.INSTITUTIONAL_DOMAINS).map((domain) => toExclusionDto({ id: null, domain, reason: null, createdAt: null }, 'config')),
        ...filas.map((f) => toExclusionDto(f, 'manual')),
      ],
    });
  });

  router.post('/exclusions', analista, async (req, res) => {
    const body = parseBody(CreateExclusionBody, req, res);
    if (!body) return;
    const domain = normalizeHost(body.domain);
    if (!domain) {
      sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', [{ field: 'domain', message: INVALID_VALUE.domain }]);
      return;
    }
    // Ya cubierto (el mismo dominio o uno padre, en la tabla o en la configuración): 409.
    if (await isExcluded(db, config.INSTITUTIONAL_DOMAINS, domain)) {
      sendError(req, res, 409, 'conflict', EXCLUSION_TAKEN);
      return;
    }
    const actor = req.auth!.user;
    let fila;
    try {
      fila = await db.$transaction(async (tx) => {
        const creada = await tx.exclusion.create({ data: { domain, reason: body.reason ?? null, createdById: actor.id } });
        await recordAudit(tx, {
          action: AuditAction.exclusionCreate,
          result: 'success',
          requestId: String(req.id),
          actorId: actor.id,
          targetType: 'exclusion',
          targetId: creada.id,
        });
        return creada;
      });
    } catch (error) {
      // Otra petición lo excluyó al mismo tiempo.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        sendError(req, res, 409, 'conflict', EXCLUSION_TAKEN);
        return;
      }
      throw error;
    }
    res.status(201).json(toExclusionDto(fila, 'manual'));
  });

  router.delete('/exclusions/:exclusionId', analista, async (req, res) => {
    const id = uuidParam(req, res, 'exclusionId', 'La exclusión no existe.');
    if (!id) return;
    const actor = req.auth!.user;
    const borrada = await db.$transaction(async (tx) => {
      const { count } = await tx.exclusion.deleteMany({ where: { id } });
      if (count === 0) return false;
      await recordAudit(tx, {
        action: AuditAction.exclusionDelete,
        result: 'success',
        requestId: String(req.id),
        actorId: actor.id,
        targetType: 'exclusion',
        targetId: id,
      });
      return true;
    });
    if (!borrada) {
      sendError(req, res, 404, 'not_found', 'La exclusión no existe.');
      return;
    }
    res.status(204).end();
  });

  return router;
}
