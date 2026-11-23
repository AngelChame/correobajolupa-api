import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AuditAction, recordAudit } from '../audit.js';
import type { Db } from '../db/client.js';
import type { Report } from '../generated/prisma/client.js';
import type { ReportSource } from '../generated/prisma/enums.js';
import type { ReportStorage } from '../storage/storage.js';

/** La cuenta ya creó REPORTS_PER_USER_PER_HOUR reportes en la última hora. */
export class ReportQuotaExceededError extends Error {
  constructor() {
    super('Cuota de reportes por hora alcanzada.');
    this.name = 'ReportQuotaExceededError';
  }
}

export type CreateReportDeps = { db: Db; storage: ReportStorage; reportsPerHour: number };

export type CreateReportInput = {
  userId: string;
  source: ReportSource;
  /** Bytes tal como llegaron (.eml o texto pegado en UTF-8). Nunca se registran. */
  bytes: Uint8Array;
  requestId: string;
};

type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

/**
 * Reportes de la cuenta en la última hora, contados en la base: la cuota sobrevive a reinicios
 * y la hora la pone PostgreSQL (la misma que fija created_at). Usa el índice (user_id, created_at).
 */
async function recentCount(db: Db | Tx, userId: string): Promise<number> {
  const [fila] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM reports
    WHERE user_id = ${userId}::uuid AND created_at > now() - interval '1 hour'`;
  return fila?.n ?? 0;
}

/**
 * Crea un reporte en cola: guarda los bytes, calcula SHA-256 y tamaño, inserta la fila y deja
 * la auditoría `report.create`. El análisis lo hará el worker (paso 3); aquí queda `queued`.
 *
 * Orden y garantías:
 *  1. Revisión rápida de la cuota antes de escribir en disco.
 *  2. Archivo en el almacenamiento con un reportId nuevo (carpeta propia, nombre aleatorio).
 *  3. Transacción con un candado por cuenta (pg_advisory_xact_lock): se vuelve a contar y se
 *     inserta. Así dos subidas simultáneas no pasan juntas la cuota.
 *  4. Si algo falla después de guardar el archivo, se borra la carpeta: no quedan huérfanos.
 */
export async function createReport(deps: CreateReportDeps, input: CreateReportInput, log: Logger): Promise<Report> {
  const { db, storage, reportsPerHour } = deps;
  if ((await recentCount(db, input.userId)) >= reportsPerHour) {
    throw new ReportQuotaExceededError();
  }

  const reportId = randomUUID();
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const storageKey = await storage.save(reportId, input.bytes);

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`report-quota:${input.userId}`}, 0))`;
      if ((await recentCount(tx, input.userId)) >= reportsPerHour) {
        throw new ReportQuotaExceededError();
      }
      const report = await tx.report.create({
        data: {
          id: reportId,
          userId: input.userId,
          source: input.source,
          storageKey,
          sizeBytes: input.bytes.byteLength,
          sha256,
        },
      });
      // Solo IDs y el tipo de entrada: nunca asunto, remitente ni contenido.
      await recordAudit(tx, {
        action: AuditAction.reportCreate,
        result: 'success',
        requestId: input.requestId,
        actorId: input.userId,
        targetType: 'report',
        targetId: reportId,
        metadata: { source: input.source },
      });
      return report;
    });
  } catch (error) {
    await storage.deleteReport(reportId).catch((cleanupError: unknown) => {
      // Solo el código del error del sistema y el ID: nada del correo ni rutas completas.
      log.error({ reportId, errCode: (cleanupError as { code?: unknown }).code }, 'no se pudo borrar la carpeta de un reporte fallido');
    });
    throw error;
  }
}
