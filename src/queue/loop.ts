import { setTimeout as esperar } from 'node:timers/promises';
import { processNext, type QueueDeps } from './process.js';

/**
 * Bucle del worker: procesa trabajos mientras haya y, si no hay, espera pollMs. Termina cuando
 * `signal` se aborta (SIGTERM): acaba el trabajo en curso y no toma otro.
 * Un error de la base no tumba el proceso: se registra (sin datos del correo) y se espera antes
 * de volver a intentar; el arriendo del trabajo vence solo y otro intento lo retoma.
 */
export async function runWorker(deps: QueueDeps, { pollMs, signal }: { pollMs: number; signal: AbortSignal }): Promise<void> {
  while (!signal.aborted) {
    let outcome;
    try {
      outcome = await processNext(deps);
    } catch (error) {
      deps.logger.error({ errorCode: 'unexpected_error', errName: (error as Error)?.name }, 'error en el ciclo del worker');
      outcome = 'idle';
    }
    if (outcome === 'idle') {
      await esperar(pollMs, undefined, { signal }).catch(() => undefined);
    }
  }
}
