import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendError } from './errors.js';

// Mensajes de Zod en español. Los de esta versión describen lo esperado (tipo, longitud,
// formato) y no repiten el valor recibido; test/auth-validation.test.ts lo comprueba.
z.config(z.locales.es());

/**
 * Valida el cuerpo con un esquema del contrato. Si no cumple, responde 400 validation_error
 * con `details: [{ field, message }]`: nunca se devuelve el valor recibido (podría ser una
 * contraseña). Devuelve undefined si ya respondió.
 */
export function parseBody<T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | undefined {
  const resultado = schema.safeParse(req.body);
  if (resultado.success) return resultado.data;
  const details = resultado.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'body',
    message: issue.message,
  }));
  sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', details);
  return undefined;
}
