import { z } from 'zod';
import { UserRef } from './common.js';

/** M7 · Cuarentena y restauración en el laboratorio IMAP (D-008, D-013). */

export const QuarantineRequest = z
  .object({
    messageIds: z
      .array(z.uuid())
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Hay mensajes repetidos.' })
      .meta({ uniqueItems: true, description: 'Mensajes aprobados uno por uno (D-013), de 1 a 50, sin repetir.' }),
    confirm: z.literal(true),
  })
  .meta({ id: 'QuarantineRequest', description: 'La API solo actúa sobre los IDs enviados y con `confirm: true`.' });

export const QuarantineOutcome = z
  .enum(['quarantined', 'already_quarantined', 'uidvalidity_mismatch', 'not_found', 'error'])
  .meta({
    id: 'QuarantineOutcome',
    description:
      '`already_quarantined`: repetir no mueve nada (P-13). `uidvalidity_mismatch`: no actúa y el buzón queda para resincronizar (P-12). `error`: no se movió, por ejemplo por un corte de conexión (P-14).',
  });

export const QuarantineResponse = z
  .object({
    incidentId: z.uuid(),
    results: z.array(
      z.object({
        messageId: z.uuid(),
        outcome: QuarantineOutcome,
        actionId: z.uuid().nullable(),
        detail: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'QuarantineResponse', description: 'Un resultado por mensaje.' });

export const ImapLocation = z
  .object({ folder: z.string(), uid: z.number().int(), uidValidity: z.number().int() })
  .meta({ id: 'ImapLocation' });

export const ActionType = z.enum(['quarantine', 'restore']).meta({ id: 'ActionType' });

export const ActionStatus = z.enum(['done', 'failed']).meta({ id: 'ActionStatus' });

export const Action = z
  .object({
    id: z.uuid(),
    incidentId: z.uuid(),
    messageId: z.uuid(),
    type: ActionType,
    status: ActionStatus,
    originalLocation: ImapLocation,
    newLocation: ImapLocation.nullable(),
    actor: UserRef,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Action' });

export const ActionList = z.object({ items: z.array(Action) }).meta({ id: 'ActionList' });

export const RestoreRequest = z.object({ confirm: z.literal(true) }).meta({ id: 'RestoreRequest' });

export const RestoreOutcome = z
  .enum(['restored', 'already_restored', 'uidvalidity_mismatch', 'not_found', 'error'])
  .meta({ id: 'RestoreOutcome', description: '`already_restored`: repetir no mueve nada (P-13).' });

export const RestoreResponse = z
  .object({
    actionId: z.uuid(),
    outcome: RestoreOutcome,
    restoreActionId: z.uuid().nullable(),
    detail: z.string().nullable(),
  })
  .meta({ id: 'RestoreResponse' });
