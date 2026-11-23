import type { z } from 'zod';
import type { ReportSummary } from '../contract/schemas/reports.js';
import type { Report } from '../generated/prisma/client.js';

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
