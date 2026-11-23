import { z } from 'zod';
import { PageQuery, UserRef, pageOf } from './common.js';
import { Indicator } from './indicators.js';
import { ReportSummary } from './reports.js';

/** M6 · Incidentes y comentarios. */

export const IncidentStatus = z
  .enum(['received', 'analyzing', 'contained', 'closed', 'false_positive'])
  .meta({
    id: 'IncidentStatus',
    description:
      'Transiciones: `received → analyzing → contained → closed`; desde cualquiera no cerrado → `false_positive`. `closed` y `false_positive` son finales. Una transición inválida responde 409 `conflict`.',
  });

export const Comment = z
  .object({
    id: z.uuid(),
    author: UserRef,
    body: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Comment', description: 'Los comentarios no se editan ni se borran.' });

export const IncidentSummary = z
  .object({
    id: z.uuid(),
    title: z.string(),
    status: IncidentStatus,
    reportsCount: z.number().int(),
    indicatorsCount: z.number().int(),
    createdBy: UserRef,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'IncidentSummary' });

export const IncidentDetail = IncidentSummary.extend({
  description: z.string().nullable(),
  reports: z.array(ReportSummary),
  indicators: z.array(Indicator),
  comments: z.array(Comment),
}).meta({ id: 'IncidentDetail' });

export const IncidentList = pageOf(IncidentSummary, 'IncidentList');

export const IncidentQuery = PageQuery.extend({ status: IncidentStatus.optional() });

export const CreateIncidentBody = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
  })
  .meta({ id: 'CreateIncidentBody' });

export const UpdateIncidentBody = z
  .object({
    title: z.string().min(1).max(120).optional(),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .meta({ description: 'Nueva descripción. `null` la borra; si se omite, no cambia.' }),
    status: IncidentStatus.optional(),
  })
  .meta({ id: 'UpdateIncidentBody' });

export const AddIncidentReportBody = z.object({ reportId: z.uuid() }).meta({ id: 'AddIncidentReportBody' });

export const AddIncidentIndicatorBody = z.object({ indicatorId: z.uuid() }).meta({ id: 'AddIncidentIndicatorBody' });

export const CreateCommentBody = z.object({ body: z.string().min(1).max(2000) }).meta({ id: 'CreateCommentBody' });
