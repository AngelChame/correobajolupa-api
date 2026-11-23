import { z } from 'zod';
import { Sha256 } from './common.js';

/** M2 · Adjuntos (D-018). El contenido nunca se descarga al navegador. */

export const ScanStatus = z
  .enum(['not_detected', 'detected', 'unsupported', 'error'])
  .meta({
    id: 'ScanStatus',
    description:
      'Resultado de ClamAV (D-018). `not_detected` no significa "seguro". `error`: ClamAV falló o no respondió; **nunca** se interpreta como limpio.',
  });

export const Attachment = z
  .object({
    id: z.uuid(),
    fileName: z.string().nullable().meta({ description: 'Nombre tal como venía en el correo. Texto hostil: el front lo escapa siempre.' }),
    declaredType: z.string().nullable().meta({ description: 'Content-Type declarado en el correo.' }),
    detectedType: z.string().nullable().meta({ description: 'Tipo detectado por los primeros bytes (provisional).' }),
    sizeBytes: z.number().int(),
    sha256: Sha256,
    scanStatus: ScanStatus,
    scanDetail: z.string().nullable().meta({ description: 'Firma detectada, o motivo de `unsupported` o `error`.' }),
    scannedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Attachment' });

export const AttachmentList = z.object({ items: z.array(Attachment) }).meta({ id: 'AttachmentList' });
