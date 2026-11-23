import { z } from 'zod';
import { PageQuery, UserRef, pageOf } from './common.js';

/** M7 · Consulta de la auditoría (solo lectura para analista y administrador). */

export const AuditResult = z.enum(['success', 'failure', 'denied']).meta({ id: 'AuditResult' });

export const AuditEvent = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    action: z.string().meta({ description: 'Por ejemplo `report.create`, `quarantine.execute`, `system.cleanup`.' }),
    result: AuditResult,
    actor: UserRef.nullable().meta({ description: 'Nulo en tareas del sistema.' }),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    requestId: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).meta({ description: 'Nunca asunto, cuerpo ni direcciones completas.' }),
  })
  .meta({ id: 'AuditEvent' });

export const AuditList = pageOf(AuditEvent, 'AuditList');

export const AuditQuery = PageQuery.extend({
  action: z.string().optional(),
  actorId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
