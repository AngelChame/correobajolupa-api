import type { Logger } from 'pino';
import { analyze, defangEmail, defangHost, defangUrlValue, type AnalysisResult, type RawEvidence } from '../analysis/index.js';
import { findUrlFinding, priorityOf } from '../analysis/rules.js';
import { scanAttachments, type AttachmentScan, type ScanFn, type ScanSettings } from '../clamav/scan.js';
import type { Db } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { ReportSource } from '../generated/prisma/enums.js';
import { lookupFeeds } from '../feeds/lookup.js';
import type { FeedName } from '../feeds/parse.js';
import type { ReportStorage } from '../storage/storage.js';

/**
 * Cola de análisis en PostgreSQL (D-054): la tabla reports es la cola. Un trabajo es una fila
 * `queued`, o `processing` cuyo arriendo (locked_until) venció porque su worker murió (P-22).
 */

export type Job = { id: string; source: ReportSource; storageKey: string; attempts: number };

export type QueueDeps = {
  db: Db;
  storage: ReportStorage;
  logger: Logger;
  institutionalDomains: readonly string[];
  leaseSeconds: number;
  maxAttempts: number;
  /** Tiempo máximo de un análisis. Por defecto, la mitad del arriendo (como mucho 30 s). */
  analysisTimeoutMs?: number;
  /** Solo para pruebas: reemplaza al analizador. */
  analyzeFn?: typeof analyze;
  /** ClamAV (M2): dónde está y sus límites. */
  scan: ScanSettings;
  /** Solo para pruebas: reemplaza al cliente de ClamAV. */
  scanFn?: ScanFn;
  enabledFeeds?: readonly FeedName[];
};

export type Outcome = 'idle' | 'done' | 'retry' | 'failed' | 'discarded';

/** Códigos cortos de error: nunca mensajes ni datos del correo (se guardan en last_error_code). */
type ErrorCode = 'analysis_timeout' | 'storage_error' | 'lease_expired' | 'unexpected_error';

class AnalysisTimeoutError extends Error {}

/**
 * Toma un trabajo de forma atómica. FOR UPDATE SKIP LOCKED hace que dos workers a la vez nunca
 * tomen la misma fila: el segundo se salta la que el primero tiene bloqueada y toma la siguiente.
 * attempts sube en cada toma; (id, attempts) identifica este intento hasta el final.
 */
export async function claimNext(db: Db, leaseSeconds: number): Promise<Job | null> {
  const filas = await db.$queryRaw<{ id: string; source: ReportSource; storage_key: string; attempts: number }[]>`
    UPDATE reports
    SET status = 'processing', attempts = attempts + 1,
        locked_until = now() + make_interval(secs => ${leaseSeconds}::int)
    WHERE id = (
      SELECT id FROM reports
      WHERE status = 'queued' OR (status = 'processing' AND locked_until < now())
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, source, storage_key, attempts`;
  const fila = filas[0];
  return fila ? { id: fila.id, source: fila.source, storageKey: fila.storage_key, attempts: fila.attempts } : null;
}

/** Evidencia desactivada para guardar (D-017): URL, dominios y el dominio de los correos. */
function defangEvidence(items: readonly RawEvidence[]): Prisma.InputJsonArray {
  return items.map(({ label, value, kind }) => ({
    label,
    value: kind === 'url' ? defangUrlValue(value) : kind === 'domain' ? defangHost(value) : kind === 'email' ? defangEmail(value) : value,
  }));
}

/** Condición "sigue siendo este intento": si otro worker la retomó o la borraron, no coincide. */
const esteIntento = (job: Job) => ({ id: job.id, status: 'processing' as const, attempts: job.attempts });

/**
 * Guarda TODO el análisis en una transacción, solo si el reporte sigue existiendo y sigue tomado
 * por este intento. El UPDATE condicional va primero: bloquea la fila, así un DELETE simultáneo
 * espera y no quedan hallazgos sueltos. Los hallazgos rechazan UPDATE (trigger): se borran los
 * previos y se insertan los nuevos.
 */
async function save(db: Db, job: Job, result: AnalysisResult, scans: readonly AttachmentScan[], priority: AnalysisResult['priority']): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.report.updateMany({
      where: esteIntento(job),
      data: {
        status: result.status,
        limitedReason: result.limitedReason,
        subject: result.subject,
        fromAddress: result.fromAddress,
        priority,
        rulesVersion: result.rulesVersion,
        hasHtml: result.hasHtml,
        authentication: result.authentication ?? Prisma.DbNull,
        feedUnavailable: result.feedUnavailable?.length ? result.feedUnavailable : Prisma.DbNull,
        analyzedAt: new Date(),
        lockedUntil: null,
        lastErrorCode: null,
      },
    });
    if (count === 0) return false;
    await tx.finding.deleteMany({ where: { reportId: job.id } });
    await tx.reportLink.deleteMany({ where: { reportId: job.id } });
    await tx.attachment.deleteMany({ where: { reportId: job.id } });
    // Solo metadatos: el contenido del adjunto nunca llega a la base.
    if (result.attachments.length > 0) {
      await tx.attachment.createMany({
        data: result.attachments.map((a, i) => ({
          reportId: job.id,
          position: a.position,
          fileName: a.fileName,
          declaredType: a.declaredType,
          detectedType: a.detectedType,
          sizeBytes: a.sizeBytes,
          sha256: a.sha256,
          scanStatus: scans[i]?.scanStatus ?? 'error',
          scanDetail: scans[i]?.scanDetail ?? null,
          scannedAt: scans[i]?.scannedAt ?? null,
        })),
      });
    }
    if (result.links.length > 0) {
      await tx.reportLink.createMany({
        data: result.links.map((l) => ({
          reportId: job.id,
          position: l.position,
          displayText: l.displayText,
          normalizedUrl: l.normalizedUrl,
          defangedUrl: l.defangedUrl,
          domain: l.domain,
        })),
      });
    }
    if (result.findings.length > 0) {
      await tx.finding.createMany({
        data: result.findings.map((f) => ({
          reportId: job.id,
          ruleId: f.ruleId,
          ruleName: f.ruleName,
          summary: f.summary,
          evidence: defangEvidence(f.evidence),
          rulesVersion: result.rulesVersion,
        })),
      });
    }
    return true;
  });
}

/** Libera el trabajo para reintentar, o lo deja en failed si ya agotó los intentos. */
async function release(db: Db, job: Job, code: ErrorCode, maxAttempts: number): Promise<'retry' | 'failed'> {
  const failed = job.attempts >= maxAttempts;
  await db.report.updateMany({
    where: esteIntento(job),
    data: { status: failed ? 'failed' : 'queued', lockedUntil: null, lastErrorCode: code },
  });
  return failed ? 'failed' : 'retry';
}

function conTiempoMaximo<T>(promesa: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AnalysisTimeoutError()), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(timer));
}

/**
 * Procesa como mucho un trabajo. Devuelve qué pasó; nunca lanza por un correo o un archivo.
 * Los registros llevan solo reportId, intento y códigos: nunca asunto, remitente ni contenido.
 */
export async function processNext(deps: QueueDeps): Promise<Outcome> {
  const { db, storage, logger, leaseSeconds, maxAttempts } = deps;
  const job = await claimNext(db, leaseSeconds);
  if (!job) return 'idle';
  const log = logger.child({ reportId: job.id, attempt: job.attempts });

  // Un arriendo que venció demasiadas veces (el worker muere con este correo): no se reintenta más.
  if (job.attempts > maxAttempts) {
    const outcome = await release(db, job, 'lease_expired', maxAttempts);
    log.warn({ outcome, errorCode: 'lease_expired' }, 'trabajo sin más intentos');
    return outcome;
  }

  let result: AnalysisResult;
  try {
    let bytes: Buffer;
    try {
      bytes = await storage.read(job.storageKey);
    } catch (error) {
      log.error({ errorCode: 'storage_error', errCode: (error as { code?: unknown }).code }, 'no se pudo leer el archivo del reporte');
      const outcome = await release(db, job, 'storage_error', maxAttempts);
      return outcome;
    }
    const timeoutMs = deps.analysisTimeoutMs ?? Math.min(30_000, (leaseSeconds * 1000) / 2);
    const analizar = deps.analyzeFn ?? analyze;
    result = await conTiempoMaximo(analizar(bytes, job.source, { institutionalDomains: deps.institutionalDomains }), timeoutMs);
  } catch (error) {
    const code: ErrorCode = error instanceof AnalysisTimeoutError ? 'analysis_timeout' : 'unexpected_error';
    // Sin el mensaje del error: podría citar contenido del correo.
    log.error({ errorCode: code, errName: (error as Error)?.name }, 'falló el análisis');
    return release(db, job, code, maxAttempts);
  }

  let exactFeedMatch = false;
  if (result.findings.some((f) => f.ruleId === 'R9') || (deps.enabledFeeds?.length ?? 0) > 0) {
    try {
      const feed = await lookupFeeds(db, result.links, deps.institutionalDomains, deps.enabledFeeds ?? []);
      const others = result.findings.filter((f) => f.ruleId !== 'R9');
      const url = findUrlFinding(result.links, deps.institutionalDomains, feed.excludedDomains);
      result.findings = [...others, ...(url ? [url] : []), ...(feed.finding ? [feed.finding] : [])];
      result.feedUnavailable = feed.unavailable;
      exactFeedMatch = feed.exact;
      result.priority = priorityOf(result.findings);
    } catch {
      // Un error del feed no impide terminar el reporte. Sin exclusiones disponibles no se
      // emite R9, para evitar falsas alarmas con dominios excluidos manualmente.
      result.findings = result.findings.filter((f) => f.ruleId !== 'R9');
      result.feedUnavailable = [...(deps.enabledFeeds ?? [])];
      result.priority = priorityOf(result.findings);
      log.warn({ errorCode: 'feed_lookup_unavailable' }, 'reputación no disponible');
    }
  }

  // ClamAV (M2). Nunca lanza: un fallo deja el adjunto en error y el reporte sigue (P-05).
  const scans = await scanAttachments(result.attachments, deps.scan, deps.scanFn);
  // Una firma de antivirus es la señal más fuerte que hay: el reporte sube a prioridad alta.
  const priority = scans.some((s) => s.scanStatus === 'detected') || exactFeedMatch ? 'high' : result.priority;

  const saved = await save(db, job, result, scans, priority);
  if (!saved) {
    log.info('reporte borrado o retomado por otro intento: se descarta el resultado');
    return 'discarded';
  }
  // Solo conteos y estados: nunca nombres de archivo, firmas, hashes ni contenido.
  const scanCounts: Record<string, number> = {};
  for (const s of scans) scanCounts[s.scanStatus] = (scanCounts[s.scanStatus] ?? 0) + 1;
  log.info(
    {
      status: result.status,
      findings: result.findings.length,
      links: result.links.length,
      attachments: result.attachments.length,
      attachmentsIgnored: result.attachmentsIgnored,
      scan: scanCounts,
    },
    'reporte analizado',
  );
  return 'done';
}
