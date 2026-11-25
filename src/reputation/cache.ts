import type { Db } from '../db/client.js';
import { normalizeIndicator } from '../indicators/normalize.js';
import { digest } from '../feeds/parse.js';
import { interpretReputation, type ReputationVerdict } from './interpret.js';

export const REPUTATION_CACHE_MS = 24 * 60 * 60 * 1000;

/** Clave local sin URL ni parámetros: la misma normalización usada por los indicadores. */
function keyOf(url: string): string | null {
  const value = normalizeIndicator('url', url);
  return value.ok ? digest(value.value) : null;
}

/** La consulta caducada no se presenta como una consulta reciente. */
export async function readCachedReputation(db: Pick<Db, 'reputationCache'>, url: string, now: Date): Promise<ReputationVerdict | null> {
  const urlHash = keyOf(url);
  if (!urlHash) return null;
  const row = await db.reputationCache.findUnique({ where: { urlHash } });
  if (!row || row.checkedAt > now || now.getTime() - row.checkedAt.getTime() >= REPUTATION_CACHE_MS) return null;
  if (row.state === 'no_data') return interpretReputation({ status: 'no_data' });
  if (row.malicious === null || row.total === null) return null;
  const verdict = interpretReputation({ status: 'result', malicious: row.malicious, total: row.total });
  return verdict.state === row.state ? verdict : null;
}

/** Solo se guardan estados interpretables; error y no consultada nunca se cachean como negativos. */
export async function saveCachedReputation(db: Pick<Db, 'reputationCache'>, url: string, verdict: ReputationVerdict, now: Date): Promise<boolean> {
  const urlHash = keyOf(url);
  if (!urlHash || !Number.isFinite(now.getTime()) || ['error', 'not_checked'].includes(verdict.state)) return false;
  const checked = verdict.state === 'no_data'
    ? interpretReputation({ status: 'no_data' })
    : interpretReputation({ status: 'result', malicious: verdict.malicious!, total: verdict.total! });
  if (checked.state !== verdict.state) return false;
  await db.reputationCache.upsert({
    where: { urlHash },
    create: { urlHash, state: checked.state, malicious: checked.malicious, total: checked.total, checkedAt: now },
    update: { state: checked.state, malicious: checked.malicious, total: checked.total, checkedAt: now },
  });
  // Las entradas vencidas no se acumulan indefinidamente.
  await db.reputationCache.deleteMany({ where: { checkedAt: { lt: new Date(now.getTime() - REPUTATION_CACHE_MS) } } });
  return true;
}
