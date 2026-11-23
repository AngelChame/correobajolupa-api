import type { z } from 'zod';
import { Finding, ReportDetail, type ReportSummary } from '../contract/schemas/reports.js';
import type { Finding as FindingRow, Report } from '../generated/prisma/client.js';
import { defangHost } from '../analysis/links.js';
import { defangLooseText } from '../viewer/text.js';

type SummaryDto = z.infer<typeof ReportSummary>;

/** Columnas de un reporte que se devuelven en ReportSummary (nunca storageKey, sha256 ni la cola). */
export const SUMMARY_SELECT = {
  id: true,
  status: true,
  source: true,
  subject: true,
  fromAddress: true,
  priority: true,
  createdAt: true,
  expiresAt: true,
} as const;

type SummaryRow = Pick<Report, keyof typeof SUMMARY_SELECT>;

/** Forma ReportSummary del contrato. subject y fromAddress son texto del correo: el front los escapa. */
export function toSummaryDto(row: SummaryRow, findingsCount: number): SummaryDto {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    subject: row.subject,
    fromAddress: row.fromAddress,
    priority: row.priority,
    findingsCount,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

type DetailDto = z.infer<typeof ReportDetail>;
type FindingDto = z.infer<typeof Finding>;

/** Columnas extra del detalle (ReportDetail). */
export const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  limitedReason: true,
  rulesVersion: true,
  analyzedAt: true,
  hasHtml: true,
  authentication: true,
  links: { select: { displayText: true, defangedUrl: true, domain: true }, orderBy: { position: 'asc' } },
  _count: { select: { findings: true } },
} as const;

type DetailRow = SummaryRow &
  Pick<Report, 'limitedReason' | 'rulesVersion' | 'analyzedAt' | 'hasHtml' | 'authentication'> & {
    links: { displayText: string | null; defangedUrl: string; domain: string | null }[];
    _count: { findings: number };
  };

/**
 * Forma ReportDetail. authentication y evidence son JSON que escribe el analizador: se validan
 * con el esquema del contrato y, si no cumplen, falla con 500 en vez de mandar datos mal formados.
 */
export function toDetailDto(row: DetailRow): DetailDto {
  return {
    ...toSummaryDto(row, row._count.findings),
    limitedReason: row.limitedReason,
    rulesVersion: row.rulesVersion,
    analyzedAt: row.analyzedAt?.toISOString() ?? null,
    // La base guarda texto y dominio crudos (sirven para correlacionar); salen desactivados (D-017, D-055).
    links: row.links.map((l) => ({
      displayText: l.displayText === null ? null : defangLooseText(l.displayText),
      defangedUrl: l.defangedUrl,
      domain: l.domain === null ? null : defangHost(l.domain),
    })),
    hasHtml: row.hasHtml,
    authentication: ReportDetail.shape.authentication.parse(row.authentication ?? null),
  };
}

/** Forma Finding del contrato. */
export function toFindingDto(row: FindingRow): FindingDto {
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    summary: row.summary,
    evidence: Finding.shape.evidence.parse(row.evidence),
    rulesVersion: row.rulesVersion,
    createdAt: row.createdAt.toISOString(),
  };
}
