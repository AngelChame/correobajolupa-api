import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dedupeKey, headerDate } from '../src/lab/index-message.js';

// Clave de deduplicación (RF-07) y fecha del encabezado de los mensajes del laboratorio.
const LAB = new URL('./fixtures/lab/', import.meta.url);

describe('dedupeKey', () => {
  it('usa el Message-ID sin espacios y en minúsculas', () => {
    expect(dedupeKey('<A1.Vence-Correo@LAB.example>')).toBe('<a1.vence-correo@lab.example>');
    expect(dedupeKey('  <a1.vence-correo@lab.example >\r\n')).toBe('<a1.vence-correo@lab.example>');
    expect(dedupeKey('<x@lab.example>', Buffer.from('otro contenido'))).toBe('<x@lab.example>');
  });

  it('sin Message-ID usa sha256: del crudo; sin crudo devuelve null', () => {
    const raw = Buffer.from('From: a@lab.example\r\n\r\nsin message-id\r\n');
    const esperado = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    expect(dedupeKey(null, raw)).toBe(esperado);
    expect(dedupeKey('   ', raw)).toBe(esperado);
    expect(dedupeKey(undefined)).toBeNull();
  });

  it('el mismo mensaje da la misma clave y uno distinto, otra', () => {
    const a = Buffer.from('From: a@lab.example\r\n\r\nuno\r\n');
    expect(dedupeKey(null, a)).toBe(dedupeKey(null, Buffer.from(a)));
    expect(dedupeKey(null, a)).not.toBe(dedupeKey(null, Buffer.from('From: a@lab.example\r\n\r\ndos\r\n')));
  });

  it('un Message-ID enorme se guarda por su hash (cabe en la columna)', () => {
    const clave = dedupeKey(`<${'x'.repeat(2000)}@lab.example>`)!;
    expect(clave).toMatch(/^message-id-sha256:[0-9a-f]{64}$/);
  });
});

describe('headerDate', () => {
  it('lee el Date de un mensaje del laboratorio', () => {
    expect(headerDate(readFileSync(new URL('A1-vence-correo.eml', LAB)))?.toISOString()).toBe('2026-11-17T14:12:00.000Z');
  });

  it('une líneas plegadas y no mira el cuerpo', () => {
    expect(headerDate(Buffer.from('Subject: x\r\nDate: Tue, 17 Nov 2026\r\n 08:12:00 -0600\r\n\r\ncuerpo'))?.toISOString()).toBe('2026-11-17T14:12:00.000Z');
    expect(headerDate(Buffer.from('Subject: x\r\n\r\nDate: Tue, 17 Nov 2026 08:12:00 -0600\r\n'))).toBeNull();
  });

  it('null si falta o no se entiende', () => {
    expect(headerDate(Buffer.from('Subject: x\r\n\r\n'))).toBeNull();
    expect(headerDate(Buffer.from('Date: mañana temprano\r\n\r\n'))).toBeNull();
  });
});
