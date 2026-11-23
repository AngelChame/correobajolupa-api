import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { AuditAction, recordAudit } from '../audit.js';
import { requireRole } from '../auth/roles.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { ReportSource } from '../generated/prisma/enums.js';
import { PageQuery } from '../contract/schemas/common.js';
import { PasteBody, ReportStatus } from '../contract/schemas/reports.js';
import { sendError } from '../http/errors.js';
import { parseBody, parseQuery } from '../http/validate.js';
import type { ReportStorage } from '../storage/storage.js';
import { createReport, ReportQuotaExceededError } from './create.js';
import { DETAIL_SELECT, SUMMARY_SELECT, toDetailDto, toFindingDto, toSummaryDto } from './dto.js';
import { emlUpload } from './upload.js';

export type ReportsDeps = { db: Db; config: Config; storage: ReportStorage };

/** Consulta de GET /reports: la misma del contrato (paginación y filtro por estado). */
const ListReportsQuery = PageQuery.extend({ status: ReportStatus.optional() });
const ReportIdParam = z.uuid();

/**
 * Qué reportes puede ver o borrar quien pide: el reportante, solo los suyos; analista y
 * administrador, todos. Se aplica en la misma consulta, así un reporte ajeno se ve igual que
 * uno inexistente (404, no 403: no se revela que existe).
 */
function visibles(req: Request): { userId?: string } {
  const { id, role } = req.auth!.user;
  return role === 'reporter' ? { userId: id } : {};
}

/** reportId de la ruta si es un UUID; si no, responde 404 (un ID mal formado no existe). */
function reportIdDe(req: Request, res: Response): string | undefined {
  const id = req.params.reportId;
  if (typeof id === 'string' && ReportIdParam.safeParse(id).success) return id;
  sendError(req, res, 404, 'not_found', 'El reporte no existe.');
  return undefined;
}

/** Rutas de /reports (M1, paso 2). El análisis llega en el paso 3: aquí los reportes quedan en cola. */
export function createReportsRouter({ db, config, storage }: ReportsDeps) {
  const router = express.Router();
  // Cualquier rol con sesión; sin sesión, 401. Lo que cada rol puede ver se decide en cada ruta.
  const conSesion = requireRole(db, 'reporter', 'analyst', 'admin');
  const createDeps = { db, storage, reportsPerHour: config.REPORTS_PER_USER_PER_HOUR };

  /** Crea el reporte y responde 202 con ReportSummary, o 429 si la cuenta agotó su cuota. */
  async function crear(req: Request, res: Response, source: ReportSource, bytes: Uint8Array) {
    try {
      const report = await createReport(createDeps, { userId: req.auth!.user.id, source, bytes, requestId: String(req.id) }, req.log);
      res.status(202).json(toSummaryDto(report, 0));
    } catch (error) {
      if (error instanceof ReportQuotaExceededError) {
        sendError(req, res, 429, 'rate_limited', 'Alcanzaste el límite de reportes por hora. Intenta más tarde.');
        return;
      }
      throw error;
    }
  }

  // El csrfGuard global ya exigió sesión y X-CSRF-Token: el archivo no se lee sin ellos.
  router.post('/', conSesion, emlUpload(config.MAX_EML_BYTES), async (req, res) => {
    await crear(req, res, 'eml', req.file!.buffer);
  });

  // Texto pegado: se guarda como bytes UTF-8, igual que un .eml (el worker lo leerá igual).
  router.post('/paste', conSesion, async (req, res) => {
    const body = parseBody(PasteBody, req, res);
    if (!body) return;
    await crear(req, res, 'paste', Buffer.from(body.text, 'utf8'));
  });

  router.get('/', conSesion, async (req, res) => {
    const query = parseQuery(ListReportsQuery, req, res);
    if (!query) return;
    const where = { ...visibles(req), ...(query.status ? { status: query.status } : {}) };
    const [total, filas] = await Promise.all([
      db.report.count({ where }),
      db.report.findMany({
        where,
        // Más recientes primero; el id desempata, así la paginación no repite ni salta filas.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: { ...SUMMARY_SELECT, _count: { select: { findings: true } } },
      }),
    ]);
    res.json({
      items: filas.map((f) => toSummaryDto(f, f._count.findings)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    });
  });

  router.get('/:reportId', conSesion, async (req, res) => {
    const id = reportIdDe(req, res);
    if (!id) return;
    const fila = await db.report.findFirst({ where: { id, ...visibles(req) }, select: DETAIL_SELECT });
    if (!fila) {
      sendError(req, res, 404, 'not_found', 'El reporte no existe.');
      return;
    }
    res.json(toDetailDto(fila));
  });

  router.get('/:reportId/findings', conSesion, async (req, res) => {
    const id = reportIdDe(req, res);
    if (!id) return;
    const reporte = await db.report.findFirst({ where: { id, ...visibles(req) }, select: { id: true } });
    if (!reporte) {
      sendError(req, res, 404, 'not_found', 'El reporte no existe.');
      return;
    }
    const hallazgos = await db.finding.findMany({ where: { reportId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    res.json({ items: hallazgos.map(toFindingDto) });
  });

  // Reportante: el suyo. Analista y administrador: cualquiera. El csrfGuard ya exigió el token.
  router.delete('/:reportId', conSesion, async (req, res) => {
    const id = reportIdDe(req, res);
    if (!id) return;
    const actor = req.auth!.user;

    const borrado = await db.$transaction(async (tx) => {
      const fila = await tx.report.findFirst({ where: { id, ...visibles(req) }, select: { userId: true } });
      if (!fila) return false;
      // deleteMany y no delete: si otra petición lo borró justo antes, cuenta 0 y no lanza error.
      const { count } = await tx.report.deleteMany({ where: { id } });
      if (count === 0) return false;
      // Hallazgos y enlaces se van en cascada. Solo IDs en la auditoría.
      await recordAudit(tx, {
        action: AuditAction.reportDelete,
        result: 'success',
        requestId: String(req.id),
        actorId: actor.id,
        targetType: 'report',
        targetId: id,
        metadata: { ownerId: fila.userId },
      });
      return true;
    });
    if (!borrado) {
      sendError(req, res, 404, 'not_found', 'El reporte no existe.');
      return;
    }

    // Los archivos se borran después de la fila: si esto falla, la fila ya no existe y la
    // carpeta queda huérfana; la limpieza nocturna (paso 5) la recoge. Solo ID y código de error.
    try {
      await storage.deleteReport(id);
    } catch (error) {
      req.log.error({ reportId: id, errCode: (error as { code?: unknown }).code }, 'no se pudo borrar la carpeta de un reporte');
    }
    res.status(204).end();
  });

  return router;
}
