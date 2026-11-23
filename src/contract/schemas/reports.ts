import { z } from 'zod';

export const ReportStatus = z
  .enum(['queued', 'processing', 'completed', 'limited', 'failed'])
  .meta({
    id: 'ReportStatus',
    description:
      '`limited`: el correo no trajo encabezados completos o no se pudo leer del todo; nunca se interpreta como "sin señales" (D-004). `failed`: el análisis no terminó.',
  });

export const ReportSource = z.enum(['eml', 'paste']).meta({ id: 'ReportSource' });

export const Priority = z
  .enum(['low', 'medium', 'high'])
  .meta({ id: 'Priority', description: 'Prioridad provisional: los umbrales se calibran con el conjunto de evaluación.' });

export const RuleId = z
  .enum(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'])
  .meta({
    id: 'RuleId',
    description:
      'R1 Reply-To distinto; R2 texto del enlace distinto del destino; R3 dominio parecido a uno institucional; R4 dominio internacionalizado; R5 destino como IP; R6 esquema de URL no permitido; R7 doble extensión o tipo de adjunto inconsistente; R8 indicador confirmado.',
  });

export const LimitedReason = z.enum(['missing_headers', 'parse_error']).meta({ id: 'LimitedReason' });

export const ReportSummary = z
  .object({
    id: z.uuid(),
    status: ReportStatus,
    source: ReportSource,
    subject: z.string().nullable().meta({ description: 'Texto de correo: el front lo escapa siempre.' }),
    fromAddress: z.string().nullable(),
    priority: Priority.nullable().meta({ description: 'Nulo mientras no termine el análisis.' }),
    findingsCount: z.number().int(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().meta({ description: 'Los reportes se borran a los 7 días (D-012).' }),
  })
  .meta({ id: 'ReportSummary' });

export const ReportLink = z
  .object({
    displayText: z
      .string()
      .nullable()
      .meta({
        description:
          'Texto visible del enlace. Se entrega desactivado si parece enlace, dominio, IP o dirección (por ejemplo `hxxps://dominio[.]com`, D-017); el front lo escapa siempre.',
      }),
    defangedUrl: z.string().meta({ description: 'Siempre desactivada, por ejemplo `hxxp://dominio[.]com` (D-017). Nunca se visita.' }),
    domain: z.string().nullable().meta({ description: 'Dominio o IP del destino, desactivado (por ejemplo `dominio[.]com`, D-017).' }),
  })
  .meta({ id: 'ReportLink' });

export const AuthResult = z.enum(['pass', 'fail', 'none', 'unknown']);

export const ReportDetail = ReportSummary.extend({
  limitedReason: LimitedReason.nullable(),
  rulesVersion: z.string().nullable(),
  analyzedAt: z.iso.datetime().nullable(),
  links: z.array(ReportLink),
  hasHtml: z.boolean().meta({ description: 'Si el correo traía parte HTML que se puede pedir en `/reports/{reportId}/html`.' }),
  authentication: z
    .object({ spf: AuthResult, dkim: AuthResult, dmarc: AuthResult })
    .nullable()
    .meta({ description: 'Solo informativo; nunca suma puntaje (D-016). Puede estar alterado en un `.eml` subido.' }),
}).meta({ id: 'ReportDetail' });

export const PasteBody = z
  .object({
    text: z.string().min(1).max(200000).meta({ description: 'Mensaje original pegado (encabezados y cuerpo).' }),
  })
  .meta({ id: 'PasteBody' });

export const UploadBody = z.object({
  file: z.file().meta({ description: 'Archivo `.eml`.' }),
});

export const ReportList = z
  .object({
    items: z.array(ReportSummary),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: 'ReportList' });

export const EvidenceItem = z
  .object({
    label: z.string(),
    value: z.string().meta({ description: 'Los enlaces y dominios aparecen desactivados (D-017).' }),
  })
  .meta({ id: 'EvidenceItem' });

export const Finding = z
  .object({
    id: z.uuid(),
    ruleId: RuleId,
    ruleName: z.string(),
    summary: z.string().meta({ description: 'Explicación breve en español.' }),
    evidence: z.array(EvidenceItem),
    rulesVersion: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Finding', description: 'Ninguna regla prueba phishing por sí sola.' });

export const FindingList = z.object({ items: z.array(Finding) }).meta({ id: 'FindingList' });
