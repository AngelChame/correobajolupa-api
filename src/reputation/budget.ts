import type { Db } from '../db/client.js';

export const MIN_QUERY_GAP_MS = 16_000;
export const MAX_DAILY_QUERIES = 500;

type BudgetRow = { dayUtc: string; used: number; nextAllowedAt: Date };
export type BudgetDecision =
  | { state: 'reserved'; next: BudgetRow }
  | { state: 'wait' | 'daily_limit'; nextAllowedAt: Date };

/** Política pura para un presupuesto local; no envía ni programa ninguna consulta. */
export function decideBudget(now: Date, row: BudgetRow): BudgetDecision {
  const dayUtc = now.toISOString().slice(0, 10);
  const used = row.dayUtc === dayUtc ? row.used : 0;
  if (used >= MAX_DAILY_QUERIES) {
    const tomorrow = Date.parse(`${dayUtc}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
    return { state: 'daily_limit', nextAllowedAt: new Date(Math.max(tomorrow, row.nextAllowedAt.getTime())) };
  }
  if (now < row.nextAllowedAt) return { state: 'wait', nextAllowedAt: row.nextAllowedAt };
  return { state: 'reserved', next: { dayUtc, used: used + 1, nextAllowedAt: new Date(now.getTime() + MIN_QUERY_GAP_MS) } };
}

/**
 * Reserva atómica compartida por workers. La fila se bloquea hasta confirmar la transacción.
 * Una reserva no utilizada cuenta igualmente: es más prudente que exceder la cuota.
 */
export async function reserveLocalBudget(db: Db, now: Date): Promise<BudgetDecision> {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_budget_time');
  return db.$transaction(async (tx) => {
    const dayUtc = now.toISOString().slice(0, 10);
    await tx.$executeRaw`
      INSERT INTO reputation_quota (id, day_utc, used, next_allowed_at)
      VALUES (1, ${dayUtc}, 0, ${new Date(0)})
      ON CONFLICT (id) DO NOTHING`;
    const [row] = await tx.$queryRaw<BudgetRow[]>`
      SELECT day_utc AS "dayUtc", used, next_allowed_at AS "nextAllowedAt"
      FROM reputation_quota WHERE id = 1 FOR UPDATE`;
    if (!row) throw new Error('missing_budget_row');
    const decision = decideBudget(now, row);
    if (decision.state === 'reserved') {
      await tx.reputationQuota.update({
        where: { id: 1 },
        data: { dayUtc: decision.next.dayUtc, used: decision.next.used, nextAllowedAt: decision.next.nextAllowedAt },
      });
    }
    return decision;
  });
}
