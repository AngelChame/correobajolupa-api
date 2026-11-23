import { readdirSync, readFileSync, statSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { analyze, type AnalysisResult } from '../src/analysis/index.js';

// Conjunto sintético del laboratorio IMAP (M4): los 21 .eml de test/fixtures/lab y su manifiesto,
// que es la verdad de referencia de M5 y M8 (D-023). Sin Docker ni base de datos.

const MAILBOXES = ['student@lab.example', 'teacher@lab.example', 'staff@lab.example'] as const;

const Message = z.strictObject({
  id: z.string().regex(/^[A-Z]{1,2}\d$/),
  file: z.string().regex(/^[A-Z]{1,2}\d-[a-z0-9-]+\.eml$/),
  mailbox: z.enum(MAILBOXES),
  messageId: z.string().regex(/^<[a-z0-9.-]+@lab\.example>$/),
  truth: z.enum(['phishing', 'legit']),
  campaign: z.enum(['A', 'B', 'C', 'D']).nullable(),
  expectedRules: z.array(z.enum(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'])),
  decoyFor: z.string().optional(),
  note: z.string().min(1),
});
const Indicator = z.strictObject({
  campaign: z.enum(['A', 'B', 'C', 'D']).nullable(),
  type: z.enum(['domain', 'url', 'sha256', 'sender']),
  value: z.string().min(1),
  candidates: z.array(z.string()),
  falseCandidates: z.array(z.string()),
  note: z.string().min(1),
});
const Manifest = z.strictObject({
  version: z.literal(1),
  description: z.string(),
  institutionalDomains: z.array(z.string()).min(1),
  mailboxes: z.array(z.enum(MAILBOXES)),
  matching: z.string(),
  messages: z.array(Message),
  indicators: z.array(Indicator),
});

const LAB = new URL('./fixtures/lab/', import.meta.url);
const manifest = Manifest.parse(JSON.parse(readFileSync(new URL('manifest.json', LAB), 'utf8')));
const raw = (file: string) => readFileSync(new URL(file, LAB));
const byId = new Map(manifest.messages.map((m) => [m.id, m]));

const results = new Map<string, AnalysisResult>();
beforeAll(async () => {
  for (const m of manifest.messages) {
    results.set(m.id, await analyze(raw(m.file), 'eml', { institutionalDomains: manifest.institutionalDomains }));
  }
});

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
const header = (text: string, name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'mi').exec(text)?.[1]?.trim() ?? null;
const addressIn = (value: string | null) => (value ? (/<([^>]+)>/.exec(value)?.[1] ?? value).toLowerCase() : null);

/** Regla de coincidencia del manifiesto (campo matching): la que M5 debe respetar. */
function matches(id: string, type: z.infer<typeof Indicator>['type'], value: string): boolean {
  const r = results.get(id)!;
  const text = raw(byId.get(id)!.file).toString('utf8');
  const from = r.fromAddress?.toLowerCase() ?? null;
  const replyTo = addressIn(header(text, 'Reply-To'));
  switch (type) {
    case 'sender':
      return from === value;
    case 'sha256':
      return r.attachments.some((a) => a.sha256 === value);
    case 'url':
      return r.links.some((l) => l.normalizedUrl === value);
    case 'domain':
      return [from && domainOf(from), replyTo && domainOf(replyTo), ...r.links.map((l) => l.domain)].includes(value);
  }
}

describe('manifiesto del laboratorio', () => {
  it('lista exactamente los .eml del directorio, sin repetir id, archivo ni Message-ID', () => {
    const files = readdirSync(LAB).filter((f) => f.endsWith('.eml')).sort();
    expect(manifest.messages.map((m) => m.file).sort()).toEqual(files);
    expect(readdirSync(LAB).filter((f) => !f.endsWith('.eml'))).toEqual(['manifest.json']);
    for (const campo of ['id', 'file', 'messageId'] as const) {
      expect(new Set(manifest.messages.map((m) => m[campo])).size, campo).toBe(manifest.messages.length);
    }
    for (const m of manifest.messages) {
      expect(m.file.startsWith(`${m.id}-`), m.id).toBe(true);
      expect(header(raw(m.file).toString('utf8'), 'Message-ID'), m.id).toBe(m.messageId);
    }
  });

  it('21 mensajes: 7 por buzón, cada uno dirigido a su buzón', () => {
    expect(manifest.messages).toHaveLength(21);
    expect(manifest.mailboxes).toEqual([...MAILBOXES]);
    for (const mailbox of MAILBOXES) {
      expect(manifest.messages.filter((m) => m.mailbox === mailbox), mailbox).toHaveLength(7);
    }
    for (const m of manifest.messages) {
      expect(addressIn(header(raw(m.file).toString('utf8'), 'To')), m.id).toBe(m.mailbox);
    }
  });

  it('campañas: A en 3 buzones, B en 3 (B3 incluido), C en 2 y D en 3; los legítimos sin campaña', () => {
    const buzones = (c: string) => new Set(manifest.messages.filter((m) => m.campaign === c).map((m) => m.mailbox)).size;
    expect({ A: buzones('A'), B: buzones('B'), C: buzones('C'), D: buzones('D') }).toEqual({ A: 3, B: 3, C: 2, D: 3 });
    for (const m of manifest.messages) {
      expect(m.truth === 'phishing', m.id).toBe(m.campaign !== null);
    }
    expect(manifest.messages.filter((m) => m.truth === 'phishing')).toHaveLength(11);
  });

  it('fechas fijas entre el 17 y el 22 de noviembre de 2026, zona -0600', () => {
    for (const m of manifest.messages) {
      const date = header(raw(m.file).toString('utf8'), 'Date')!;
      expect(date, m.id).toMatch(/ -0600$/);
      const t = Date.parse(date);
      expect(t, m.id).toBeGreaterThanOrEqual(Date.parse('2026-11-17T00:00:00-06:00'));
      expect(t, m.id).toBeLessThan(Date.parse('2026-11-23T00:00:00-06:00'));
    }
  });
});

describe('mensajes del laboratorio contra el analizador', () => {
  it.each(manifest.messages.map((m) => [m.id, m] as const))('%s dispara exactamente sus reglas esperadas', (_id, m) => {
    const r = results.get(m.id)!;
    expect(r.status).toBe('completed');
    expect(r.findings.map((f) => f.ruleId)).toEqual(m.expectedRules);
  });

  it('B1 y B2 traen el mismo adjunto (mismo SHA-256); B3 no trae adjunto', () => {
    const [b1, b2, b3] = ['B1', 'B2', 'B3'].map((id) => results.get(id)!);
    expect(b1!.attachments).toHaveLength(1);
    expect(b1!.attachments[0]!.sha256).toBe(b2!.attachments[0]!.sha256);
    expect(b1!.attachments[0]!.fileName).toBe('factura-0042.pdf.exe');
    expect(b3!.attachments).toHaveLength(0);
  });

  it('los señuelos B3, LC1 y LC2 comparten el dominio nube-compartida.example', () => {
    const decoys = manifest.messages.filter((m) => m.decoyFor === 'nube-compartida.example').map((m) => m.id);
    expect(decoys.sort()).toEqual(['B3', 'LC1', 'LC2']);
    for (const id of decoys) expect(matches(id, 'domain', 'nube-compartida.example'), id).toBe(true);
  });

  it('cada indicador coincide exactamente con sus candidatos y falsos candidatos', () => {
    for (const ind of manifest.indicators) {
      const etiqueta = `${ind.type} ${ind.value}`;
      const esperados = [...ind.candidates, ...ind.falseCandidates].sort();
      const reales = manifest.messages.filter((m) => matches(m.id, ind.type, ind.value)).map((m) => m.id).sort();
      expect(reales, etiqueta).toEqual(esperados);
      // Los candidatos son de la campaña; los falsos candidatos, legítimos.
      for (const id of ind.candidates) expect(byId.get(id)?.campaign, `${etiqueta}: ${id}`).toBe(ind.campaign);
      for (const id of ind.falseCandidates) expect(byId.get(id)?.truth, `${etiqueta}: ${id}`).toBe('legit');
    }
    // Las cuatro campañas tienen indicadores y hay dos trampas con falsos candidatos.
    expect(new Set(manifest.indicators.map((i) => i.campaign))).toEqual(new Set(['A', 'B', 'C', 'D', null]));
    expect(manifest.indicators.filter((i) => i.falseCandidates.length > 0)).toHaveLength(2);
  });
});

describe('higiene de los archivos del laboratorio', () => {
  const files = manifest.messages.map((m) => m.file);

  it('ninguno pasa de 20 KiB y todos usan CRLF', () => {
    for (const f of files) {
      expect(statSync(new URL(f, LAB)).size, f).toBeLessThanOrEqual(20 * 1024);
      expect(raw(f).toString('utf8').replace(/\r\n/g, ''), f).not.toMatch(/[\r\n]/);
    }
  });

  it('UTF-8 válido y sin caracteres ocultos ni que imiten letras (controles, formato, cirílico...)', () => {
    // El dominio internacionalizado de D va en punycode: ningún archivo lleva la letra que imita.
    for (const f of [...files, 'manifest.json']) {
      const bytes = raw(f);
      const text = bytes.toString('utf8');
      expect(Buffer.from(text, 'utf8').equals(bytes), f).toBe(true);
      // Solo ASCII imprimible, CRLF y letras o signos latinos (U+00A1 a U+00FF: á, ñ, ¿...).
      expect(text, f).toMatch(/^[\r\n\x20-\x7e\u00a1-\u00ff]*$/);
    }
  });

  it('todo dominio termina en .example y toda IP es de 203.0.113.0/24', () => {
    for (const f of files) {
      const text = raw(f).toString('utf8');
      const hosts = [...text.matchAll(/(?:@|:\/\/)([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
      expect(hosts.length, f).toBeGreaterThan(0);
      for (const host of hosts) {
        expect(host.endsWith('.example') || host.startsWith('203.0.113.'), `${f}: ${host}`).toBe(true);
      }
      for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
        expect(ip.startsWith('203.0.113.'), `${f}: ${ip}`).toBe(true);
      }
      expect(text, f).not.toMatch(/\b[a-z0-9-]+\.(?:com|net|org|edu|gob|mx|io)\b/i);
    }
  });

  it('no hay cadenas con forma de secreto', () => {
    const SECRETOS = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
      /\bxox[abprs]-[A-Za-z0-9-]+/,
      /\bsk-[A-Za-z0-9]{20,}/,
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
      /(?:password|passwd|contraseña|token|secret)\s*[:=]\s*\S+/i,
    ];
    for (const f of [...files, 'manifest.json']) {
      const text = raw(f).toString('utf8');
      for (const patron of SECRETOS) expect(text, `${f}: ${patron}`).not.toMatch(patron);
    }
  });
});
