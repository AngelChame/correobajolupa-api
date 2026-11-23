import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Lista de redacción central (D-036). Nunca deben llegar a los registros contraseñas,
 * tokens, cookies ni contenido de correos. Se amplía conforme aparecen rutas nuevas.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'body',
  '*.body',
  // Texto de correos (M1): asunto, remitente, texto pegado y nombre del archivo subido.
  'subject',
  '*.subject',
  'fromAddress',
  '*.fromAddress',
  'text',
  '*.text',
  'originalname',
  '*.originalname',
];

/** `service` distingue los procesos en los registros: 'api' o 'worker'. */
export function createLogger(level: string, destination?: DestinationStream, service = 'api'): Logger {
  const options = {
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[redactado]' },
  };
  return destination ? pino(options, destination) : pino(options);
}
