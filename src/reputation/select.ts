import type { AnalyzedLink } from '../analysis/types.js';

/** Tope conservador por reporte para una eventual fuente de reputación. */
export const MAX_REPUTATION_URLS = 5;

function visibleHost(text: string | null): string | null {
  const value = text?.trim();
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    return /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(url.hostname) ? url.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/** Ordena sin visitar ni modificar enlaces: primero texto visible que apunta a otro host. */
export function selectForReputation(links: readonly AnalyzedLink[]): string[] {
  const valid = links.filter((link) => link.scheme === 'http' || link.scheme === 'https');
  const prioritized = [...valid].sort((a, b) => {
    const mismatch = (link: AnalyzedLink) => {
      const visible = visibleHost(link.displayText);
      return visible !== null && link.domain !== null && visible !== link.domain.replace(/^www\./, '');
    };
    return Number(mismatch(b)) - Number(mismatch(a)) || a.position - b.position;
  });
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const link of prioritized) {
    if (seen.has(link.normalizedUrl)) continue;
    seen.add(link.normalizedUrl);
    selected.push(link.normalizedUrl);
    if (selected.length >= MAX_REPUTATION_URLS) break;
  }
  return selected;
}
