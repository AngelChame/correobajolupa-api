import type { z } from 'zod';
import { Comment, IncidentDetail, IncidentSummary } from '../contract/schemas/incidents.js';
import type { Prisma } from '../generated/prisma/client.js';
import { INDICATOR_SELECT, toIndicatorDto } from '../indicators/routes.js';
import { SUMMARY_SELECT, toSummaryDto } from '../reports/dto.js';

const USER_REF = { select: { id: true, displayName: true } } as const;

/** Columnas del resumen. Los conteos salen de la base (_count), sin cargar las asociaciones. */
export const INCIDENT_SUMMARY_SELECT = {
  id: true,
  title: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  createdBy: USER_REF,
  _count: { select: { reports: true, indicators: true } },
} as const;

export const COMMENT_SELECT = { id: true, body: true, createdAt: true, author: USER_REF } as const;

/**
 * Detalle: reportes e indicadores en el orden en que se asociaron, comentarios del más antiguo al
 * más reciente. El id desempata cuando dos filas tienen la misma hora.
 */
export const INCIDENT_DETAIL_SELECT = {
  ...INCIDENT_SUMMARY_SELECT,
  description: true,
  reports: {
    orderBy: [{ addedAt: 'asc' }, { reportId: 'asc' }],
    select: { report: { select: { ...SUMMARY_SELECT, _count: { select: { findings: true } } } } },
  },
  indicators: {
    orderBy: [{ addedAt: 'asc' }, { indicatorId: 'asc' }],
    select: { indicator: { select: INDICATOR_SELECT } },
  },
  comments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: COMMENT_SELECT },
} as const satisfies Prisma.IncidentSelect;

type SummaryRow = Prisma.IncidentGetPayload<{ select: typeof INCIDENT_SUMMARY_SELECT }>;
type DetailRow = Prisma.IncidentGetPayload<{ select: typeof INCIDENT_DETAIL_SELECT }>;
type CommentRow = Prisma.IncidentCommentGetPayload<{ select: typeof COMMENT_SELECT }>;

/** Forma IncidentSummary. title es texto de usuario: el front lo escapa siempre. */
export function toIncidentSummaryDto(row: SummaryRow): z.infer<typeof IncidentSummary> {
  return IncidentSummary.parse({
    id: row.id,
    title: row.title,
    status: row.status,
    reportsCount: row._count.reports,
    indicatorsCount: row._count.indicators,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Forma Comment. body es texto de usuario: el front lo escapa siempre. */
export function toCommentDto(row: CommentRow): z.infer<typeof Comment> {
  return Comment.parse({ id: row.id, author: row.author, body: row.body, createdAt: row.createdAt.toISOString() });
}

/** Forma IncidentDetail: reportes como en GET /reports e indicadores solo desactivados (D-017). */
export function toIncidentDetailDto(row: DetailRow): z.infer<typeof IncidentDetail> {
  return IncidentDetail.parse({
    ...toIncidentSummaryDto(row),
    description: row.description,
    reports: row.reports.map(({ report }) => toSummaryDto(report, report._count.findings)),
    indicators: row.indicators.map(({ indicator }) => toIndicatorDto(indicator)),
    comments: row.comments.map(toCommentDto),
  });
}
