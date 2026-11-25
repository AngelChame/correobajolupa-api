import { normalizeIndicator } from '../indicators/normalize.js';

const REPORT_ENDPOINT = 'https://www.virustotal.com/api/v3/urls/';
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 4_000;

export type VirusTotalResult =
  | { state: 'result'; malicious: number; total: number; analyzedAt: Date }
  | { state: 'no_data' | 'rate_limited' | 'error' };

/** La URL se envía como identificador base64url sin padding; no se envía a un escaneo nuevo. */
export function urlReportId(normalizedUrl: string): string | null {
  const normalized = normalizeIndicator('url', normalizedUrl);
  if (!normalized.ok || normalized.value !== normalizedUrl || /[?#]/.test(normalizedUrl)) return null;
  return Buffer.from(normalizedUrl, 'utf8').toString('base64url');
}

async function readBounded(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty_report');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('oversized_report');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseReport(payload: unknown): VirusTotalResult {
  const attributes = record(record(record(payload)?.data)?.attributes);
  if (!attributes) return { state: 'error' };
  const stats = record(attributes?.last_analysis_stats);
  const timestamp = attributes?.last_analysis_date;
  if (!stats || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0) return { state: 'no_data' };
  const counts = ['harmless', 'malicious', 'suspicious', 'undetected'] as const;
  if (counts.some((name) => !Number.isSafeInteger(stats[name]) || (stats[name] as number) < 0)) return { state: 'error' };
  const total = counts.reduce((sum, name) => sum + (stats[name] as number), 0);
  const malicious = stats.malicious as number;
  const analyzedAt = new Date(timestamp * 1000);
  if (!Number.isSafeInteger(total) || !Number.isFinite(analyzedAt.getTime())) return { state: 'error' };
  return total === 0 ? { state: 'no_data' } : { state: 'result', malicious, total, analyzedAt };
}

/**
 * Únicamente lee informes existentes desde un host fijo. No hay POST, redirecciones, reintentos,
 * ni solicitudes al destino del correo. Nunca registrar la clave, el identificador o la respuesta.
 */
export async function getVirusTotalReport(
  normalizedUrl: string,
  apiKey: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<VirusTotalResult> {
  const id = urlReportId(normalizedUrl);
  if (!apiKey || !id) return { state: 'error' };
  try {
    const response = await fetchFn(`${REPORT_ENDPOINT}${id}`, {
      method: 'GET',
      headers: { 'x-apikey': apiKey, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return { state: 'no_data' };
    if (response.status === 429) return { state: 'rate_limited' };
    if (!response.ok) return { state: 'error' };
    return parseReport(await readBounded(response));
  } catch {
    return { state: 'error' };
  }
}
