import { defangUrlValue } from '../analysis/links.js';
import type { AnalyzedLink, RawFinding } from '../analysis/types.js';
import type { Db } from '../db/client.js';
import { configExclusions, covers } from '../indicators/exclusions.js';
import { reserveLocalBudget } from './budget.js';
import { readCachedReputation, saveCachedReputation } from './cache.js';
import { interpretReputation, type ReputationState, type ReputationVerdict } from './interpret.js';
import { selectForReputation } from './select.js';
import { getVirusTotalReport } from './virustotal.js';

export type ReputationItem = {
  /** Desactivada antes de persistir: nunca una URL clicable en la respuesta. */
  displayUrl: string;
  state: ReputationState;
  malicious: number | null;
  total: number | null;
  /** Fecha del informe externo; nula si no se recibió o proviene de la caché local. */
  analyzedAt: string | null;
};

export type ReputationReview = {
  status: 'not_configured' | 'checked' | 'unavailable';
  items: ReputationItem[];
};

/** Un informe externo es evidencia, no prueba; la URL con parámetros no es coincidencia exacta. */
export function reputationFinding(review: ReputationReview, links: readonly AnalyzedLink[]): { finding: RawFinding | null; exactReported: boolean } {
  const item = review.items.find((entry) => entry.state === 'reported')
    ?? review.items.find((entry) => entry.state === 'suspicious');
  if (!item) return { finding: null, exactReported: false };
  const link = links.find((entry) => defangUrlValue(entry.normalizedUrl) === item.displayUrl);
  if (!link || item.malicious === null || item.total === null) return { finding: null, exactReported: false };
  const exact = !new URL(link.raw).search;
  return {
    finding: {
      ruleId: 'R10',
      ruleName: 'Enlace marcado en un informe de reputación',
      summary: 'Motores de VirusTotal marcaron la URL normalizada; el conteo y la coincidencia requieren revisión.',
      evidence: [
        { label: 'Enlace', value: link.normalizedUrl, kind: 'url' },
        { label: 'Fuente', value: 'VirusTotal (informe existente)', kind: 'text' },
        { label: 'Motores que la marcaron', value: `${item.malicious} de ${item.total}`, kind: 'text' },
        { label: 'Coincidencia', value: exact ? 'URL sin parámetros originales' : 'Solo URL normalizada (parámetros omitidos)', kind: 'text' },
        { label: 'Fecha del informe', value: item.analyzedAt ?? 'En caché local (menos de 24 horas)', kind: 'text' },
      ],
    },
    exactReported: item.state === 'reported' && exact,
  };
}

/**
 * Reutiliza la caché de todas las URL; hace como máximo UNA consulta nueva por reporte para
 * preservar los 16 segundos entre consultas, sin detener el worker esperando a la cuota.
 * Las restantes quedan no consultadas; ni cero detecciones ni falta de datos significan seguro.
 */
export async function reviewReputation(
  db: Db,
  links: readonly AnalyzedLink[],
  institutionalDomains: readonly string[],
  excludedDomains: readonly string[],
  apiKey: string | undefined,
  fetchFn: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<ReputationReview> {
  if (!apiKey) return { status: 'not_configured', items: [] };
  const excluded = [...configExclusions(institutionalDomains), ...excludedDomains];
  const candidates = links.filter((link) => link.domain && !excluded.some((domain) => covers(domain, link.domain!)));
  const urls = selectForReputation(candidates);
  const items: ReputationItem[] = [];
  let queried = false;
  let unavailable = false;

  for (const url of urls) {
    let verdict: ReputationVerdict | null = await readCachedReputation(db, url, now);
    let analyzedAt: string | null = null;
    if (!verdict && !queried) {
      const reservation = await reserveLocalBudget(db, now);
      if (reservation.state === 'reserved') {
        queried = true;
        const report = await getVirusTotalReport(url, apiKey, fetchFn);
        if (report.state === 'result') {
          verdict = interpretReputation({ status: 'result', malicious: report.malicious, total: report.total });
          analyzedAt = report.analyzedAt.toISOString();
        } else if (report.state === 'no_data') {
          verdict = interpretReputation({ status: 'no_data' });
        } else {
          verdict = interpretReputation({ status: 'error' });
          unavailable = true;
        }
        if (verdict.state !== 'error') await saveCachedReputation(db, url, verdict, now);
      } else if (reservation.state === 'daily_limit') {
        unavailable = true;
      }
    }
    verdict ??= interpretReputation({ status: 'not_checked' });
    items.push({
      displayUrl: defangUrlValue(url),
      state: verdict.state,
      malicious: verdict.malicious,
      total: verdict.total,
      analyzedAt,
    });
  }
  return { status: unavailable ? 'unavailable' : 'checked', items };
}
