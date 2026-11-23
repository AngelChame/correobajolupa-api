import type { IncidentStatus } from '../generated/prisma/enums.js';

/**
 * Estados de un incidente (M6, RF-26 a RF-28). Camino normal `received → analyzing → contained →
 * closed`, un paso a la vez; desde cualquiera no final se puede marcar `false_positive`.
 * `closed` y `false_positive` son finales: el incidente queda de solo lectura.
 */
const SIGUIENTES: Record<IncidentStatus, readonly IncidentStatus[]> = {
  received: ['analyzing', 'false_positive'],
  analyzing: ['contained', 'false_positive'],
  contained: ['closed', 'false_positive'],
  closed: [],
  false_positive: [],
};

/** Estados finales: el incidente queda de solo lectura. */
export const FINAL_STATUSES: IncidentStatus[] = (Object.keys(SIGUIENTES) as IncidentStatus[]).filter((s) => SIGUIENTES[s].length === 0);

/** Si el incidente ya no admite cambios (título, descripción, estado, asociaciones ni comentarios). */
export function isFinal(status: IncidentStatus): boolean {
  return SIGUIENTES[status].length === 0;
}

/**
 * Si se puede pasar de `from` a `to`. Quedarse en el mismo estado no es una transición (la ruta
 * lo trata como "sin cambio"), así que aquí devuelve false; un salto que se salta un paso, también.
 */
export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return SIGUIENTES[from].includes(to);
}
