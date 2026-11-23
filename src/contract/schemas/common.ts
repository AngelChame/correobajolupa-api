import { z } from 'zod';

/**
 * Códigos de error estables. El front decide qué mostrar con `code`;
 * `message` es un texto en español pensado para personas.
 */
export const ErrorCode = z
  .enum([
    'validation_error',
    'unauthenticated',
    'invalid_credentials',
    'forbidden',
    'not_found',
    'email_taken',
    'conflict',
    'report_not_ready',
    'payload_too_large',
    'unsupported_media_type',
    'rate_limited',
    'internal_error',
    'service_unavailable',
  ])
  .meta({
    id: 'ErrorCode',
    description: '`service_unavailable` (503): el servidor IMAP del laboratorio o ClamAV no responden.',
  });

export const ErrorResponse = z
  .object({
    code: ErrorCode,
    message: z.string().meta({ description: 'Texto en español para mostrar a la persona.' }),
    details: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .optional()
      .meta({ description: 'Solo en `validation_error`: un elemento por campo inválido.' }),
    requestId: z.string().meta({ description: 'Identificador de la petición (también en la cabecera X-Request-Id).' }),
  })
  .meta({ id: 'ErrorResponse' });

export const Role = z.enum(['reporter', 'analyst', 'admin']).meta({ id: 'Role' });

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const PageMeta = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: 'PageMeta' });

export const csrfHeader = z.object({
  'x-csrf-token': z.string().meta({
    description: 'Token CSRF que entrega `GET /auth/me` y las respuestas de entrada. Obligatorio en peticiones que modifican datos.',
  }),
});

/** Referencia breve a una persona usuaria (quién propuso, decidió, comentó o actuó). */
export const UserRef = z.object({ id: z.uuid(), displayName: z.string() }).meta({ id: 'UserRef' });

/** Lista paginada con la forma de siempre: `{items, page, pageSize, total}`. */
export const pageOf = <T extends z.ZodType>(item: T, id: string) =>
  z
    .object({
      items: z.array(item),
      page: z.number().int(),
      pageSize: z.number().int(),
      total: z.number().int(),
    })
    .meta({ id });

/** SHA-256 en hexadecimal (minúsculas). */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/).meta({ description: 'SHA-256 en hexadecimal, 64 caracteres en minúsculas.' });
