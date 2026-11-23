import type { ScanStatus } from '../generated/prisma/enums.js';
import { scanBuffer, SCAN_DETAIL, type ScanResult } from './client.js';

/**
 * Escaneo de los adjuntos de un reporte con límites (M2, D-018). Los cuatro estados son honestos:
 *  - not_detected: ClamAV respondió OK (no significa "seguro").
 *  - detected: ClamAV encontró una firma (scanDetail = su nombre).
 *  - unsupported: no se mandó a escanear (vacío, demasiado grande o más allá del tope).
 *  - error: se intentó y falló, o se acabó el tiempo. NUNCA se trata como limpio.
 */

export type ScanSettings = {
  host: string;
  port: number;
  /** Tiempo máximo de un escaneo. */
  timeoutMs: number;
  /** Tiempo máximo de todos los escaneos del reporte juntos. */
  totalBudgetMs: number;
  /** Adjuntos más grandes que esto no se mandan (unsupported). */
  maxScanBytes: number;
  /** Solo se escanean los primeros N adjuntos; los demás quedan unsupported. */
  maxScanned: number;
};

export type AttachmentScan = { scanStatus: ScanStatus; scanDetail: string | null; scannedAt: Date | null };

export type ScanFn = typeof scanBuffer;

export const UNSUPPORTED_DETAIL = {
  empty: 'adjunto vacío',
  tooLarge: 'mayor que el límite de escaneo',
  overLimit: 'fuera de los primeros adjuntos que se escanean',
} as const;

/**
 * Escanea en orden, uno a la vez (ClamAV usa mucha memoria; no se le manda todo en paralelo).
 * Nunca lanza. Devuelve un resultado por adjunto, en el mismo orden.
 */
export async function scanAttachments(
  attachments: readonly { content: Buffer }[],
  settings: ScanSettings,
  scanFn: ScanFn = scanBuffer,
  now: () => number = Date.now,
): Promise<AttachmentScan[]> {
  const deadline = now() + settings.totalBudgetMs;
  const results: AttachmentScan[] = [];
  for (const [index, { content }] of attachments.entries()) {
    const unsupported = (detail: string) => results.push({ scanStatus: 'unsupported', scanDetail: detail, scannedAt: null });
    if (index >= settings.maxScanned) {
      unsupported(UNSUPPORTED_DETAIL.overLimit);
      continue;
    }
    if (content.length === 0) {
      unsupported(UNSUPPORTED_DETAIL.empty);
      continue;
    }
    if (content.length > settings.maxScanBytes) {
      unsupported(UNSUPPORTED_DETAIL.tooLarge);
      continue;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      results.push({ scanStatus: 'error', scanDetail: SCAN_DETAIL.timeout, scannedAt: null });
      continue;
    }
    let result: ScanResult;
    try {
      result = await scanFn(content, { host: settings.host, port: settings.port, timeoutMs: Math.min(settings.timeoutMs, remaining) });
    } catch {
      result = { status: 'error', detail: SCAN_DETAIL.connection };
    }
    // scannedAt solo cuando ClamAV dio un veredicto; un error no es un escaneo hecho.
    results.push({ scanStatus: result.status, scanDetail: result.detail, scannedAt: result.status === 'error' ? null : new Date() });
  }
  return results;
}
