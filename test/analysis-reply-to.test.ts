import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/index.js';
import { applyRules } from '../src/analysis/rules.js';

// replyTo en el resultado del análisis (M4): campo aditivo para la búsqueda del laboratorio.
// No cambia reglas, hallazgos ni prioridades: las pruebas del analizador siguen idénticas.
const LAB = new URL('./fixtures/lab/', import.meta.url);
const EMAILS = new URL('./fixtures/emails/', import.meta.url);
const opciones = { institutionalDomains: ['universidad-ejemplo.example'] };

const CAMPOS_ANTES_DE_M4 = [
  'subject',
  'fromAddress',
  'status',
  'limitedReason',
  'hasHtml',
  'authentication',
  'links',
  'attachments',
  'attachmentsIgnored',
  'findings',
  'priority',
  'rulesVersion',
  'decodedText',
];

describe('analyze() devuelve replyTo', () => {
  it('trae la dirección de Reply-To cuando existe y [] cuando no', async () => {
    const a1 = await analyze(readFileSync(new URL('A1-vence-correo.eml', LAB)), 'eml', opciones);
    expect(a1.replyTo).toEqual(['ayuda@buzon-respuestas.example']);
    const ld1 = await analyze(readFileSync(new URL('LD1-personal.eml', LAB)), 'eml', opciones);
    expect(ld1.replyTo).toEqual([]);
  });

  it('un correo ilegible devuelve replyTo vacío', async () => {
    const r = await analyze(Buffer.from(''), 'eml', opciones);
    expect(r.replyTo).toEqual([]);
  });

  it('solo agrega replyTo: los demás campos son los de antes y los hallazgos salen de esas mismas direcciones', async () => {
    for (const archivo of ['R1-reply-to-distinto.eml', 'C1-combinado-reglas-1-2-5.eml', 'L02-aviso-institucional-legitimo.eml']) {
      const r = await analyze(readFileSync(new URL(archivo, EMAILS)), 'eml', opciones);
      expect(Object.keys(r).sort(), archivo).toEqual([...CAMPOS_ANTES_DE_M4, 'replyTo'].sort());
      const recalculados = applyRules({ fromAddress: r.fromAddress, replyTo: r.replyTo, links: r.links, attachments: r.attachments, ...opciones });
      expect(recalculados, archivo).toEqual(r.findings);
    }
  });
});
