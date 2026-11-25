import type { AnalyzedLink, RawFinding } from '../analysis/types.js';
import type { Db } from '../db/client.js';
import { configExclusions, covers, domainSuffixes } from '../indicators/exclusions.js';
import { normalizeIndicator } from '../indicators/normalize.js';
import { digest, type FeedName } from './parse.js';

export type LookupResult = {
  finding: RawFinding | null;
  exact: boolean;
  unavailable: FeedName[];
  excludedDomains: string[];
};

/** Consulta solo hashes indexados de la base; no solicita ninguno de los destinos del correo. */
export async function lookupFeeds(
  db: Db,
  links: readonly AnalyzedLink[],
  institutionalDomains: readonly string[],
  enabled: readonly FeedName[],
): Promise<LookupResult> {
  const suffixes = [...new Set(links.flatMap((l) => l.domain ? domainSuffixes(l.domain) : []))];
  const manual = suffixes.length
    ? await db.exclusion.findMany({ where: { domain: { in: suffixes } }, select: { domain: true } })
    : [];
  const excludedDomains = manual.map((row) => row.domain);
  const excluded = [...configExclusions(institutionalDomains), ...excludedDomains];
  const candidates = links.flatMap((link) => {
    if (!link.domain || excluded.some((d) => covers(d, link.domain!))) return [];
    const normalized = normalizeIndicator('url', link.normalizedUrl);
    return normalized.ok && normalized.host
      ? [{ link, urlHash: digest(normalized.value), hostHash: digest(normalized.host) }]
      : [];
  });
  if (enabled.length === 0) return { finding: null, exact: false, unavailable: [], excludedDomains };
  const sources = await db.feedSource.findMany({ where: { source: { in: [...enabled] } } });
  const bySource = new Map(sources.map((s) => [s.source, s]));
  const unavailable = enabled.filter((s) => {
    const state = bySource.get(s);
    return !state?.lastGoodAt || (state.lastErrorAt !== null && state.lastErrorAt >= state.lastGoodAt);
  });
  const available = enabled.filter((s) => bySource.get(s)?.lastGoodAt);
  if (candidates.length === 0 || available.length === 0) return { finding: null, exact: false, unavailable, excludedDomains };

  const exact = await db.feedEntry.findFirst({
    where: { source: { in: available }, urlHash: { in: candidates.map((c) => c.urlHash) } },
  });
  const match = exact ?? await db.feedEntry.findFirst({
    where: { source: { in: available }, hostHash: { in: candidates.map((c) => c.hostHash) } },
  });
  if (!match) return { finding: null, exact: false, unavailable, excludedDomains };
  const candidate = candidates.find((c) => exact ? c.urlHash === match.urlHash : c.hostHash === match.hostHash)!;
  // La normalización M5 elimina la query: solo llamamos "exacta" a la coincidencia cuando
  // ninguno de los dos lados tenía parámetros que pudieran diferenciar los destinos.
  const fullExact = Boolean(exact) && !match.hasQuery && new URL(candidate.link.raw).search === '';
  const source = match.source as FeedName;
  const date = bySource.get(source)!.lastGoodAt!.toISOString();
  return {
    finding: {
      ruleId: 'R10',
      ruleName: 'Enlace reportado por una lista de reputación',
      summary: fullExact
        ? 'La URL aparece en una lista de reputación; confirma la fuente y la fecha antes de actuar.'
        : 'Un enlace comparte dominio o URL sin parámetros con una lista, pero no hay coincidencia exacta comprobada.',
      evidence: [
        { label: 'Enlace', value: candidate.link.normalizedUrl, kind: 'url' },
        { label: 'Fuente', value: source, kind: 'text' },
        { label: 'Fecha de la lista', value: date, kind: 'text' },
        { label: 'Coincidencia', value: fullExact ? 'URL exacta' : exact ? 'URL sin parámetros (no exacta)' : 'Solo dominio', kind: 'text' },
      ],
    },
    exact: fullExact,
    unavailable,
    excludedDomains,
  };
}
