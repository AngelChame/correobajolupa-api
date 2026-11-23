import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/roles.js';
import type { Config } from '../config.js';
import { MessageQuery } from '../contract/schemas/lab.js';
import type { Db } from '../db/client.js';
import { sendError } from '../http/errors.js';
import { parseQuery } from '../http/validate.js';
import type { MailProvider } from '../mail/provider.js';
import type { ReportStorage } from '../storage/storage.js';
import { MESSAGE_DETAIL_SELECT, MESSAGE_SUMMARY_SELECT, toMailboxDto, toMessageDetailDto, toMessageSummaryDto } from './dto.js';

export type LabDeps = {
  db: Db;
  config: Config;
  storage: ReportStorage;
  /** Abre el proveedor de correo de un buzón (IMAP del laboratorio; uno en memoria en las pruebas). */
  openProvider: (address: string) => Promise<MailProvider>;
};

const Uuid = z.uuid();

/** Parámetro de la ruta si es un UUID; si no, 404 (un ID mal formado no existe). */
export function uuidParam(req: Request, res: Response, name: string, message: string): string | undefined {
  const id = req.params[name];
  if (typeof id === 'string' && Uuid.safeParse(id).success) return id;
  sendError(req, res, 404, 'not_found', message);
  return undefined;
}

/**
 * Rutas del laboratorio IMAP (M4): solo analista o administrador; el reportante recibe 403 y
 * queda en la auditoría (requireRole). En los registros solo van IDs y conteos (P-18).
 */
export function createLabRouter({ db }: LabDeps) {
  const router = express.Router();
  const analista = requireRole(db, 'analyst', 'admin');

  router.get('/mailboxes', analista, async (_req, res) => {
    // Orden del enum: student, teacher, staff.
    const filas = await db.mailbox.findMany({ orderBy: { label: 'asc' }, include: { _count: { select: { messages: true } } } });
    res.json({ items: filas.map((f) => toMailboxDto(f, f._count.messages)) });
  });

  router.get('/messages', analista, async (req, res) => {
    const query = parseQuery(MessageQuery, req, res);
    if (!query) return;
    const where = { ...(query.mailboxId ? { mailboxId: query.mailboxId } : {}), ...(query.location ? { location: query.location } : {}) };
    const [total, filas] = await Promise.all([
      db.indexedMessage.count({ where }),
      db.indexedMessage.findMany({
        where,
        // Por fecha del mensaje, la más reciente primero; sin fecha al final; el id desempata.
        orderBy: [{ date: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: MESSAGE_SUMMARY_SELECT,
      }),
    ]);
    res.json({ items: filas.map(toMessageSummaryDto), page: query.page, pageSize: query.pageSize, total });
  });

  router.get('/messages/:messageId', analista, async (req, res) => {
    const id = uuidParam(req, res, 'messageId', 'El mensaje no existe.');
    if (!id) return;
    const fila = await db.indexedMessage.findUnique({ where: { id }, select: MESSAGE_DETAIL_SELECT });
    if (!fila) {
      sendError(req, res, 404, 'not_found', 'El mensaje no existe.');
      return;
    }
    res.json(toMessageDetailDto(fila));
  });

  return router;
}
