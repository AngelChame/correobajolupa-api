import type { RequestHandler } from 'express';
import multer from 'multer';
import { sendError } from '../http/errors.js';

const EML_NAME = /\.eml$/i;

/**
 * Se acepta un archivo si su nombre termina en .eml o si declara el tipo message/rfc822.
 * Con application/octet-stream (lo que mandan muchos navegadores) solo pasa si el nombre es .eml.
 * Ni el nombre ni el tipo se creen: el contenido se trata siempre como hostil, y el nombre nunca
 * se usa como ruta ni se guarda (D-038).
 */
export function isAcceptedEml(fileName: string, mimeType: string): boolean {
  return EML_NAME.test(fileName) || mimeType.toLowerCase() === 'message/rfc822';
}

class UnsupportedMediaTypeError extends Error {}

/**
 * Lee el campo `file` de un multipart/form-data en memoria (como mucho maxBytes) y deja el
 * archivo en req.file. Cualquier error responde con la forma del contrato, nunca con el texto
 * o el HTML por defecto de multer o Express:
 *  - archivo demasiado grande → 413 payload_too_large;
 *  - no es .eml → 415 unsupported_media_type;
 *  - sin archivo, más de un archivo, campos de más o formulario mal formado → 400 validation_error.
 */
export function emlUpload(maxBytes: number): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    // fields: 0 y parts: 1 → solo se admite exactamente un archivo y ningún campo de texto.
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1, headerPairs: 100 },
    fileFilter: (_req, file, cb) => {
      if (isAcceptedEml(file.originalname, file.mimetype)) cb(null, true);
      else cb(new UnsupportedMediaTypeError());
    },
  }).single('file');

  const invalido = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], message: string) =>
    sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', [{ field: 'file', message }]);

  return (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (err instanceof UnsupportedMediaTypeError) {
        sendError(req, res, 415, 'unsupported_media_type', 'El archivo debe ser un correo .eml.');
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          sendError(req, res, 413, 'payload_too_large', 'El archivo supera el tamaño máximo permitido.');
          return;
        }
        invalido(req, res, 'Envía un solo archivo en el campo file, sin otros campos.');
        return;
      }
      if (err) {
        // Errores de busboy (multipart mal formado o cortado). Sin el mensaje original.
        invalido(req, res, 'No se pudo leer el formulario enviado.');
        return;
      }
      if (!req.file) {
        invalido(req, res, 'Falta el archivo .eml en el campo file (multipart/form-data).');
        return;
      }
      next();
    });
  };
}
