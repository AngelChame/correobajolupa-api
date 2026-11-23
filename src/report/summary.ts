import type { z } from 'zod';
import type { ScanStatus } from '../contract/schemas/attachments.js';
import type { ReportDocument } from '../contract/schemas/report-document.js';
import type { AuthResult, LimitedReason, Priority, ReportStatus } from '../contract/schemas/reports.js';
import { AUTH_RESULT_TEXT, HEADLINES, NOTE_TEXTS, SUMMARY_PHRASES } from './guide-texts.js';

/**
 * Resumen y notas del informe (M3, D-011): se eligen frases fijas de guide-texts.ts según el
 * estado, los hallazgos, la prioridad y el escaneo de los adjuntos. Solo se interpolan enteros.
 */

export type SummaryInput = {
  status: z.infer<typeof ReportStatus>;
  findingsCount: number;
  priority: z.infer<typeof Priority> | null;
  scanStatuses: readonly z.infer<typeof ScanStatus>[];
};

export type Summary = z.infer<typeof ReportDocument>['summary'];
export type Note = z.infer<typeof ReportDocument>['notes'][number];
export type Authentication = { spf: z.infer<typeof AuthResult>; dkim: z.infer<typeof AuthResult>; dmarc: z.infer<typeof AuthResult> };

function contar(estados: readonly string[], estado: string): number {
  return estados.filter((s) => s === estado).length;
}

/**
 * Encabezado y texto. Un adjunto `detected` manda sobre los hallazgos; `error` y `unsupported`
 * siempre se dicen y nunca se presentan como limpios (D-018).
 */
export function buildSummary({ status, findingsCount, priority, scanStatuses }: SummaryInput): Summary {
  if (status === 'failed') return { headline: HEADLINES.failed, text: SUMMARY_PHRASES.failed };

  const detectados = contar(scanStatuses, 'detected');
  const conError = contar(scanStatuses, 'error');
  const noSoportados = contar(scanStatuses, 'unsupported');

  let headline: string;
  if (detectados > 0) headline = detectados === 1 ? HEADLINES.detectedOne : HEADLINES.detectedMany;
  else if (findingsCount === 0 && status === 'limited') headline = HEADLINES.limitedNoFindings;
  // Sin hallazgos pero con adjuntos que no se escanearon: el encabezado no debe sonar a limpio.
  else if (findingsCount === 0) headline = conError + noSoportados > 0 ? HEADLINES.noFindingsUnscanned : HEADLINES.noFindings;
  else if (priority === 'high') headline = HEADLINES.high;
  else if (priority === 'low') headline = HEADLINES.low;
  else headline = HEADLINES.medium;

  const frases: string[] = [];
  if (findingsCount > 0) frases.push(SUMMARY_PHRASES.findings(findingsCount), SUMMARY_PHRASES.noRuleProves);
  else if (status !== 'limited') frases.push(SUMMARY_PHRASES.noFindings);
  if (status === 'limited') frases.push(SUMMARY_PHRASES.limited);
  if (detectados > 0) frases.push(SUMMARY_PHRASES.detected(detectados));
  if (conError > 0) frases.push(SUMMARY_PHRASES.scanError(conError));
  if (noSoportados > 0) frases.push(SUMMARY_PHRASES.unsupported(noSoportados));

  return { headline, text: frases.join(' ') };
}

export type NotesInput = {
  status: z.infer<typeof ReportStatus>;
  limitedReason: z.infer<typeof LimitedReason> | null;
  findingsCount: number;
  authentication: Authentication | null;
};

/** Notas en orden fijo: failed, limited, no_findings, auth_informative. */
export function buildNotes({ status, limitedReason, findingsCount, authentication }: NotesInput): Note[] {
  const notas: Note[] = [];
  if (status === 'failed') notas.push({ kind: 'failed', ...NOTE_TEXTS.failed });
  if (status === 'limited') {
    // Sin motivo guardado se usa el texto más prudente (parse_error).
    notas.push({ kind: 'limited', title: NOTE_TEXTS.limited.title, text: NOTE_TEXTS.limited.byReason[limitedReason ?? 'parse_error'] });
  }
  if (findingsCount === 0 && (status === 'completed' || status === 'limited')) notas.push({ kind: 'no_findings', ...NOTE_TEXTS.noFindings });
  if (authentication && [authentication.spf, authentication.dkim, authentication.dmarc].some((r) => r !== 'unknown')) {
    notas.push({
      kind: 'auth_informative',
      title: NOTE_TEXTS.authInformative.title,
      text: NOTE_TEXTS.authInformative.text(AUTH_RESULT_TEXT[authentication.spf], AUTH_RESULT_TEXT[authentication.dkim], AUTH_RESULT_TEXT[authentication.dmarc]),
    });
  }
  return notas;
}
