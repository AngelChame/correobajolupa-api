import { createHash } from 'node:crypto';
import { normalizeIndicator } from '../indicators/normalize.js';

export type FeedName = 'OpenPhish' | 'URLhaus';
export type FeedHash = { urlHash: string; hostHash: string; hasQuery: boolean };

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Ambos feeds usan listas de URLs, una por línea. No conservamos el texto recibido:
 * solo hashes de la normalización de M5. Nunca se solicita el destino de una línea.
 */
export function parseFeed(text: string, source: FeedName): FeedHash[] {
  const hashes = new Map<string, FeedHash>();
  let lines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (++lines > 200_000) throw new Error('feed_too_many_entries');
    // URLhaus puede incluir FTP; el analizador solo conoce HTTP(S).
    if (source === 'URLhaus' && /^ftp:\/\//i.test(line)) continue;
    const url = normalizeIndicator('url', line);
    if (!url.ok || !url.host) throw new Error('feed_invalid_format');
    const urlHash = digest(url.value);
    const hasQuery = new URL(line).search !== '';
    hashes.set(urlHash, { urlHash, hostHash: digest(url.host), hasQuery: hasQuery || hashes.get(urlHash)?.hasQuery === true });
  }
  if (hashes.size === 0) throw new Error('feed_empty');
  return [...hashes.values()];
}
