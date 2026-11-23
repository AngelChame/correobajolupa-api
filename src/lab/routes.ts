import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/roles.js';
import { MailUnavailableError } from '../mail/provider.js';
import type { Config } from '../config.js';
import { MessageQuery, SimulatedDeliveryBody } from '../contract/schemas/lab.js';
import type { Db } from '../db/client.js';
import { sendError } from '../http/errors.js';
import { parseBody, parseQuery } from '../http/validate.js';
import type { MailProvider } from '../mail/provider.js';
import type { ReportStorage } from '../storage/storage.js';
import { auditDeliveryRejection, ReportFileMissingError, ReportNotEmlError, ReportNotFoundError, simulateDelivery } from './delivery.js';
import { MailboxNotFoundError, SyncInProgressError, SyncTimeoutError, syncMailbox } from './sync.js';
import { MESSAGE_DETAIL_SELECT, MESSAGE_SUMMARY_SELECT, toMailboxDto, toMessageDetailDto, toMessageSummaryDto } from './dto.js';

export type LabDeps = {
  db: Db;
  config: Config;
  storage: ReportStorage;
  /** Abre el proveedor de correo de un buzón (IMAP del laboratorio; uno en memoria en las pruebas). */
  openProvider: (address: string) => Promise<MailProvider>;
};

const Uuid = z.uuid();
export const isUuid = (value: unknown): value is string => typeof value === 'string' && Uuid.safeParse(value).success;

/** Parámetro de la ruta si es un UUID; si no, 404 (un ID mal formado no existe). */
export function uuidParam(req: Request, res: Response, name: string, message: string): string | undefined {
  const id = req.params[name];
  if (isUuid(id)) return id;
  sendError(req, res, 404, 'not_found', message);
  return undefined;
}

/** Mensajes fijos: nunca llevan nada del servidor IMAP, direcciones ni contraseñas. */
export const LAB_UNAVAILABLE = 'El servidor IMAP del laboratorio no responde. Intenta más tarde.';
const SYNC_TIMEOUT = 'La sincronización tardó demasiado. Lo ya indexado se conservó; intenta de nuevo.';
const SYNC_BUSY = 'Ya hay una sincronización de ese buzón en curso. Intenta en un momento.';

/**
 * Traduce los errores del laboratorio a la respuesta de la API. Devuelve false si no es uno de
 * ellos (lo maneja el manejador general, 500).
 */
export function sendLabError(req: Request, res: Response, error: unknown): boolean {
  if (error instanceof MailboxNotFoundError) sendError(req, res, 404, 'not_found', 'El buzón no existe.');
  else if (error instanceof SyncInProgressError) sendError(req, res, 409, 'conflict', SYNC_BUSY);
  else if (error instanceof SyncTimeoutError) sendError(req, res, 503, 'service_unavailable', SYNC_TIMEOUT);
  else if (error instanceof MailUnavailableError) sendError(req, res, 503, 'service_unavailable', LAB_UNAVAILABLE);
  else return false;
  return true;
}

/**
 * Rutas del laboratorio IMAP (M4): solo analista o administrador; el reportante recibe 403 y
 * queda en la auditoría (requireRole). En los registros solo van IDs y conteos (P-18).
 */
export function createLabRouter({ db, config, storage, openProvider }: LabDeps) {
  const router = express.Router();
  const analista = requireRole(db, 'analyst', 'admin');

  router.get('/mailboxes', analista, async (_req, res) => {
    // Orden del enum: student, teacher, staff.
    const filas = await db.mailbox.findMany({ orderBy: { label: 'asc' }, include: { _count: { select: { messages: true } } } });
    res.json({ items: filas.map((f) => toMailboxDto(f, f._count.messages)) });
  });

  // Sincroniza al momento (máximo SYNC_BUDGET_MS, 45 s). El csrfGuard global ya exigió el token.
  router.post('/mailboxes/:mailboxId/sync', analista, async (req, res) => {
    const id = uuidParam(req, res, 'mailboxId', 'El buzón no existe.');
    if (!id) return;
    const deps = {
      db,
      logger: req.log,
      institutionalDomains: config.INSTITUTIONAL_DOMAINS,
      maxEmlBytes: config.MAX_EML_BYTES,
      maxMessages: config.SYNC_MAX_MESSAGES,
      budgetMs: config.SYNC_BUDGET_MS,
      openProvider,
    };
    try {
      const r = await syncMailbox(deps, id, { actorId: req.auth!.user.id, requestId: String(req.id) });
      res.json({ ...r, finishedAt: r.finishedAt.toISOString() });
    } catch (error) {
      if (!sendLabError(req, res, error)) throw error;
    }
  });

  // Entrega simulada (D-006): el .eml original del reporte entra a INBOX del buzón con APPEND.
  // Simulación local dentro del Dovecot del laboratorio: no envía correo a ningún sitio.
  // Siempre auditada, también los rechazos de aquí (P-16). La auditoría se escribe antes de
  // responder y nunca guarda lo que mandó el cliente: solo IDs ya validados como UUID.
  router.post('/mailboxes/:mailboxId/simulated-delivery', analista, async (req, res) => {
    const actor = req.auth!.user;
    const rejection = { actorId: actor.id, requestId: String(req.id) };
    if (!isUuid(req.params.mailboxId)) await auditDeliveryRejection(db, req.log, { ...rejection, reason: 'mailbox_not_found' });
    const id = uuidParam(req, res, 'mailboxId', 'El buzón no existe.');
    if (!id) return;
    if (!SimulatedDeliveryBody.safeParse(req.body).success) await auditDeliveryRejection(db, req.log, { ...rejection, mailboxId: id, reason: 'invalid_body' });
    const body = parseBody(SimulatedDeliveryBody, req, res);
    if (!body) return;
    try {
      const r = await simulateDelivery(
        { db, storage, logger: req.log, institutionalDomains: config.INSTITUTIONAL_DOMAINS, openProvider },
        {
          mailboxId: id,
          reportId: body.reportId,
          // Mismas reglas que GET /reports/{id} (hoy solo llegan analista y administrador: ven todos).
          ...(actor.role === 'reporter' ? { ownerId: actor.id } : {}),
          actorId: actor.id,
          requestId: String(req.id),
        },
      );
      const fila = await db.indexedMessage.findUniqueOrThrow({ where: { id: r.messageId }, select: MESSAGE_SUMMARY_SELECT });
      res.status(201).json({ message: toMessageSummaryDto(fila) });
    } catch (error) {
      if (error instanceof ReportNotFoundError) sendError(req, res, 404, 'not_found', 'El reporte no existe.');
      else if (error instanceof ReportFileMissingError) sendError(req, res, 404, 'not_found', 'El archivo del reporte ya no existe.');
      else if (error instanceof ReportNotEmlError)
        sendError(req, res, 400, 'validation_error', 'Solo se pueden entregar reportes subidos como .eml.', [
          { field: 'reportId', message: 'El reporte se pegó como texto, no se subió como .eml.' },
        ]);
      else if (!sendLabError(req, res, error)) throw error;
    }
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
