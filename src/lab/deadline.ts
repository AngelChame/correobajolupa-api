/**
 * Presupuesto de tiempo de una petición al laboratorio (SYNC_BUDGET_MS). Una llamada al proveedor
 * de correo no puede pasar del presupuesto: si se cuelga, se abandona con DeadlineExceededError
 * (y quien llama cierra la conexión).
 */

export class DeadlineExceededError extends Error {
  constructor() {
    super('se agotó el tiempo de la operación en el laboratorio');
    this.name = 'DeadlineExceededError';
  }
}

export type Deadline = {
  /** Milisegundos que quedan (negativo si ya pasó). */
  remaining(): number;
  expired(): boolean;
  /** Espera la promesa como mucho lo que queda del presupuesto. */
  run<T>(promise: Promise<T>): Promise<T>;
};

export function createDeadline(budgetMs: number, now: () => number = Date.now): Deadline {
  const end = now() + budgetMs;
  const remaining = () => end - now();
  return {
    remaining,
    expired: () => remaining() <= 0,
    run<T>(promise: Promise<T>): Promise<T> {
      // Si pierde la carrera, su error no queda sin manejar.
      promise.catch(() => {});
      if (remaining() <= 0) return Promise.reject(new DeadlineExceededError());
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError()), remaining());
      });
      return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
    },
  };
}
