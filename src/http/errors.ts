import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { ErrorCode } from '../contract/schemas/common.js';

type Code = z.infer<typeof ErrorCode>;
type Detail = { field: string; message: string };

/** Responde con la forma única de error del contrato: `{code, message, details?, requestId}` (D-044). */
export function sendError(req: Request, res: Response, status: number, code: Code, message: string, details?: Detail[]): void {
  res.status(status).json({
    code,
    message,
    ...(details ? { details } : {}),
    requestId: String(req.id),
  });
}
