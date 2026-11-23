import express, { type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { ReportSource } from '../generated/prisma/enums.js';
import { PasteBody } from '../contract/schemas/reports.js';
import { sendError } from '../http/errors.js';
import { parseBody } from '../http/validate.js';
import type { ReportStorage } from '../storage/storage.js';
import { createReport, ReportQuotaExceededError } from './create.js';
import { toSummaryDto } from './dto.js';
import { emlUpload } from './upload.js';

export type ReportsDeps = { db: Db; config: Config; storage: ReportStorage };

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

  return router;
}
