import { setTimeout as esperar } from 'node:timers/promises';
import type { Logger } from 'pino';
import { AuditAction, recordAudit } from '../audit.js';
import { SESSION_IDLE_TIMEOUT_MS } from '../auth/session.js';
import type { Db } from '../db/client.js';
import type { ReportStorage } from '../storage/storage.js';

/**
 * Limpieza programada del worker:
 *  1. Reportes vencidos (expiresAt, 7 días; D-012, RF-43): se borra la fila (hallazgos y enlaces
 *     en cascada) y después su carpeta.
 *  2. Sesiones vencidas por tiempo absoluto o por inactividad (D-034, D-048).
 *  3. Reconciliación del almacenamiento (D-038): carpetas sin fila con más de una hora se borran.
 *     El margen existe porque la subida guarda el archivo ANTES de crear la fila: sin él se
 *     borraría un reporte que se está creando en ese momento.
 */

/** Edad mínima de una carpeta sin fila para considerarla huérfana. */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
/** Reportes vencidos por tanda (la limpieza sigue mientras haya). */
const BATCH = 500;
/** Clave del candado de la limpieza (pg_try_advisory_xact_lock): un número fijo del proyecto. */
const CLEANUP_LOCK_KEY = 4_215_001;

export type CleanupDeps = { db: Db; storage: ReportStorage; logger: Logger; orphanMinAgeMs?: number };

export type CleanupCounts = {
  expiredReports: number;
  expiredSessions: number;
  orphanFolders: number;
  /** Carpetas que no se pudieron borrar (quedan para la siguiente vuelta). */
  folderErrors: number;
};

async function deleteFolder(storage: ReportStorage, logger: Logger, reportId: string): Promise<boolean> {
  try {
    await storage.deleteReport(reportId);
    return true;
  } catch (error) {
    logger.error({ reportId, errCode: (error as { code?: unknown }).code }, 'no se pudo borrar la carpeta de un reporte');
    return false;
  }
}

async function work({ db, storage, logger, orphanMinAgeMs = ORPHAN_MIN_AGE_MS }: CleanupDeps): Promise<CleanupCounts> {
  const counts: CleanupCounts = { expiredReports: 0, expiredSessions: 0, orphanFolders: 0, folderErrors: 0 };

  // 1. Reportes vencidos, por tandas. El DELETE vuelve a comprobar expires_at (no borra nada
  //    que no esté vencido) y RETURNING dice exactamente qué filas se fueron.
  for (;;) {
    const borrados = await db.$queryRaw<{ id: string }[]>`
      DELETE FROM reports WHERE id IN (
        SELECT id FROM reports WHERE expires_at < now() ORDER BY expires_at LIMIT ${BATCH}
      ) RETURNING id`;
    for (const { id } of borrados) {
      if (!(await deleteFolder(storage, logger, id))) counts.folderErrors++;
    }
    counts.expiredReports += borrados.length;
    if (borrados.length < BATCH) break;
  }

  // 2. Sesiones vencidas: mismo criterio que findValidSession (src/auth/session.ts).
  const ahora = new Date();
  const { count } = await db.session.deleteMany({
    where: { OR: [{ expiresAt: { lte: ahora } }, { lastActivityAt: { lte: new Date(ahora.getTime() - SESSION_IDLE_TIMEOUT_MS) } }] },
  });
  counts.expiredSessions = count;

  // 3. Carpetas sin fila (UUID válido y más de una hora).
  const limite = Date.now() - orphanMinAgeMs;
  const viejas = (await storage.listReports()).filter((c) => c.modifiedAt.getTime() < limite).map((c) => c.reportId);
  for (let i = 0; i < viejas.length; i += BATCH) {
    const tanda = viejas.slice(i, i + BATCH);
    const conFila = new Set((await db.report.findMany({ where: { id: { in: tanda } }, select: { id: true } })).map((r) => r.id));
    for (const id of tanda) {
      if (conFila.has(id)) continue;
      if (await deleteFolder(storage, logger, id)) counts.orphanFolders++;
      else counts.folderErrors++;
    }
  }
  return counts;
}

/**
 * Una vuelta de limpieza. Con varios workers, solo uno limpia a la vez: el candado es de
 * transacción (pg_try_advisory_xact_lock) porque Prisma usa un pool de conexiones y un candado de
 * sesión podría soltarse en otra conexión distinta de la que lo tomó. La transacción solo sostiene
 * el candado; los borrados van por fuera, así cada uno se confirma en el momento.
 * Devuelve null si otro worker ya estaba limpiando.
 */
export async function runCleanup(deps: CleanupDeps): Promise<CleanupCounts | null> {
  return deps.db.$transaction(
    async (tx) => {
      const [fila] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${CLEANUP_LOCK_KEY}) AS ok`;
      if (!fila?.ok) {
        deps.logger.info('otra limpieza está en curso: se omite esta vuelta');
        return null;
      }
      const counts = await work(deps);
      // Auditoría sin actor ni requestId (D-047): solo conteos.
      await recordAudit(deps.db, { action: AuditAction.cleanup, result: 'success', metadata: counts });
      deps.logger.info(counts, 'limpieza programada terminada');
      return counts;
    },
    { maxWait: 10_000, timeout: 30 * 60 * 1000 },
  );
}

/** Limpia al arrancar y después cada intervalMs, hasta que `signal` se aborte. Nunca lanza. */
export async function runCleanupSchedule(deps: CleanupDeps, { intervalMs, signal }: { intervalMs: number; signal: AbortSignal }): Promise<void> {
  while (!signal.aborted) {
    try {
      await runCleanup(deps);
    } catch (error) {
      deps.logger.error({ errorCode: 'cleanup_failed', errName: (error as Error)?.name }, 'falló la limpieza programada');
    }
    await esperar(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}
