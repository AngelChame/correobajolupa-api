import { z } from 'zod';
import { PageQuery, UserRef, pageOf } from './common.js';
import { MessageSummary } from './lab.js';

/** M5 · Indicadores, candidatos y lista de exclusión (D-019). */

export const IndicatorType = z.enum(['domain', 'url', 'sha256', 'sender']).meta({ id: 'IndicatorType' });

export const IndicatorStatus = z.enum(['proposed', 'confirmed', 'dismissed']).meta({ id: 'IndicatorStatus' });

export const Indicator = z
  .object({
    id: z.uuid(),
    type: IndicatorType,
    displayValue: z.string().meta({ description: 'Valor normalizado y desactivado (D-017), por ejemplo `dominio[.]com`.' }),
    status: IndicatorStatus,
    reportId: z.uuid().nullable(),
    proposedBy: UserRef,
    decidedBy: UserRef.nullable(),
    createdAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Indicator' });

export const IndicatorList = pageOf(Indicator, 'IndicatorList');

export const ProposeIndicatorBody = z
  .object({
    type: IndicatorType,
    value: z.string().min(1).max(2048).meta({
      description:
        'Se normaliza al proponer: dominio en minúsculas y punycode; URL sin query ni fragmento; SHA-256 en minúsculas; remitente en minúsculas.',
    }),
    reportId: z.uuid().optional().meta({ description: 'Obligatorio para el reportante: solo propone desde un reporte suyo.' }),
    note: z.string().max(500).optional(),
  })
  .meta({ id: 'ProposeIndicatorBody' });

export const IndicatorQuery = PageQuery.extend({ status: IndicatorStatus.optional(), type: IndicatorType.optional() });

export const MatchLocation = z.enum(['link', 'from', 'reply_to', 'attachment']).meta({ id: 'MatchLocation' });

export const CandidateReason = z
  .object({
    indicatorId: z.uuid(),
    kind: IndicatorType,
    location: MatchLocation,
    matchedValue: z.string().meta({ description: 'Valor que coincidió, desactivado (D-017).' }),
  })
  .meta({ id: 'CandidateReason' });

export const Candidate = z
  .object({
    message: MessageSummary,
    reasons: z.array(CandidateReason),
  })
  .meta({
    id: 'Candidate',
    description:
      'Mensaje candidato con la razón de cada coincidencia, sin puntuación (D-019). Compartir un dominio no confirma una campaña: decide una persona. Orden: número de razones y luego fecha.',
  });

export const CandidateList = pageOf(Candidate, 'CandidateList');

export const ExclusionSource = z.enum(['config', 'manual']).meta({ id: 'ExclusionSource' });

export const Exclusion = z
  .object({
    id: z.uuid().nullable().meta({ description: 'Nulo si viene de la configuración (dominios institucionales, solo lectura).' }),
    domain: z.string().meta({ description: 'Desactivado (D-017).' }),
    source: ExclusionSource,
    reason: z.string().nullable(),
    createdAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Exclusion' });

export const ExclusionList = z.object({ items: z.array(Exclusion) }).meta({ id: 'ExclusionList' });

export const CreateExclusionBody = z
  .object({
    domain: z.string().min(1).max(253),
    reason: z.string().max(500).optional(),
  })
  .meta({ id: 'CreateExclusionBody' });
