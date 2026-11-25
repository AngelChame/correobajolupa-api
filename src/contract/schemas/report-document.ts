import { z } from 'zod';
import { ScanStatus } from './attachments.js';
import { Sha256 } from './common.js';
import { IndicatorType } from './indicators.js';
import { EvidenceItem, LimitedReason, Priority, ReputationReview, ReportStatus, RuleId } from './reports.js';

/** M3 · Informe con guía de mitigación: texto determinista de plantilla (D-011, D-014). */

export const GuideFinding = z
  .object({
    ruleId: RuleId,
    title: z.string(),
    whatItMeans: z.string(),
    whyRisky: z.string(),
    whatToDo: z.array(z.string()),
    forAnalyst: z.array(z.string()),
    evidence: z.array(EvidenceItem).meta({ description: 'Desactivada (D-017).' }),
  })
  .meta({ id: 'GuideFinding' });

export const ReportNoteKind = z
  .enum(['limited', 'no_findings', 'failed', 'auth_informative', 'feed_unavailable', 'reputation_unavailable'])
  .meta({
    id: 'ReportNoteKind',
    description: '`no_findings` dice que sin hallazgos no significa seguro. `failed` dice que el análisis no terminó (D-004).',
  });

export const ReportDocument = z
  .object({
    reportId: z.uuid(),
    generatedAt: z.iso.datetime(),
    rulesVersion: z.string().nullable(),
    guideVersion: z.string(),
    status: ReportStatus,
    limitedReason: LimitedReason.nullable(),
    priority: Priority.nullable(),
    summary: z.object({ headline: z.string(), text: z.string() }),
    findings: z.array(GuideFinding),
    reputation: ReputationReview,
    indicators: z
      .array(z.object({ type: IndicatorType, displayValue: z.string() }))
      .meta({ description: 'Desactivados (D-017).' }),
    attachments: z.array(
      z.object({
        fileName: z.string().nullable().meta({ description: 'Texto hostil: el front lo escapa siempre.' }),
        sha256: Sha256,
        scanStatus: ScanStatus,
      }),
    ),
    notes: z.array(z.object({ kind: ReportNoteKind, title: z.string(), text: z.string() })),
  })
  .meta({ id: 'ReportDocument', description: 'Texto de plantilla, determinista; nada se genera en ejecución (D-011).' });
