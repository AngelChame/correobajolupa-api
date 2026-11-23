import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { IndicatorType } from '../src/generated/prisma/enums.js';
import { defangIndicator, INVALID_VALUE, normalizeIndicator } from '../src/indicators/normalize.js';

// Normalización de indicadores (M5): valores del manifiesto del laboratorio y casos hostiles.
const manifest = JSON.parse(readFileSync(new URL('fixtures/lab/manifest.json', import.meta.url), 'utf8')) as {
  indicators: { type: IndicatorType; value: string }[];
};

/** "nоmina" con una o cirílica (U+043E): homógrafo de "nomina". */
const CIRILICA = 'nоmina-avisos.example';
const SHA = 'e1ebcaeb1816296896173ffd4d783a7c5b7c9c23d73e610c805d4f9afabdf7db';

describe('normalizeIndicator', () => {
  it('los valores del manifiesto ya están normalizados: se quedan igual', () => {
    for (const { type, value } of manifest.indicators) {
      const r = normalizeIndicator(type, value);
      expect(r, `${type} ${value}`).toMatchObject({ ok: true, value });
    }
  });

  const validos: [IndicatorType, string, string, string | null][] = [
    // tipo, entrada, valor guardado, host que se compara con la lista de exclusión
    ['domain', '  Universidad-Ejernplo.EXAMPLE. ', 'universidad-ejernplo.example', 'universidad-ejernplo.example'],
    ['domain', CIRILICA, 'xn--nmina-avisos-4fk.example', 'xn--nmina-avisos-4fk.example'],
    ['domain', '203.0.113.7', '203.0.113.7', '203.0.113.7'],
    ['domain', '2001:DB8::0:1', '[2001:db8::1]', '[2001:db8::1]'],
    ['domain', '[2001:db8::1]', '[2001:db8::1]', '[2001:db8::1]'],
    ['url', 'https://universidad-ejernplo.example/verificar?ref=a1#inicio', 'https://universidad-ejernplo.example/verificar', 'universidad-ejernplo.example'],
    ['url', 'HTTPS://Universidad-Ejernplo.Example/Verificar', 'https://universidad-ejernplo.example/Verificar', 'universidad-ejernplo.example'],
    ['url', `https://${CIRILICA}/recibo`, 'https://xn--nmina-avisos-4fk.example/recibo', 'xn--nmina-avisos-4fk.example'],
    ['url', 'https://x.example', 'https://x.example/', 'x.example'],
    ['url', 'http://[2001:db8::1]:8080/a', 'http://[2001:db8::1]:8080/a', '[2001:db8::1]'],
    ['sha256', ` ${SHA.toUpperCase()} `, SHA, null],
    ['sender', 'Soporte@Universidad-Ejernplo.Example', 'soporte@universidad-ejernplo.example', 'universidad-ejernplo.example'],
    ['sender', `rh@${CIRILICA}`, 'rh@xn--nmina-avisos-4fk.example', 'xn--nmina-avisos-4fk.example'],
  ];
  it.each(validos)('%s %j → %s', (type, entrada, value, host) => {
    expect(normalizeIndicator(type, entrada)).toEqual({ ok: true, value, host });
  });

  const invalidos: [IndicatorType, string][] = [
    ['domain', 'localhost'],
    ['domain', 'a..example'],
    ['domain', '-a.example'],
    ['domain', 'a_b.example'],
    ['domain', 'ex ample.example'],
    ['domain', 'http://x.example'],
    ['domain', 'x.example/ruta'],
    ['domain', 'usuario@x.example'],
    ['domain', '1.2.3'],
    ['domain', 'xn--zz.example'],
    ['domain', `${'a'.repeat(64)}.example`],
    ['domain', `${'a.'.repeat(127)}ab`],
    ['url', 'javascript:alert(1)'],
    ['url', 'JaVaScRiPt:alert(1)'],
    ['url', 'data:text/html,hola'],
    ['url', 'ftp://x.example/'],
    ['url', 'mailto:a@x.example'],
    ['url', 'x.example/a'],
    ['url', 'https://usuario:clave@x.example/'],
    ['url', 'https://usuario@x.example/'],
    ['url', `https://x.example/${'a'.repeat(2048)}`],
    ['sha256', 'zz'],
    ['sha256', SHA.slice(1)],
    ['sha256', `${SHA}0`],
    ['sender', 'Nombre <a@x.example>'],
    ['sender', '"a b"@x.example'],
    ['sender', 'a@b@x.example'],
    ['sender', '@x.example'],
    ['sender', 'a@203.0.113.7'],
    ['sender', `${'a'.repeat(65)}@x.example`],
    ['sender', 'sin-arroba.example'],
  ];
  it.each(invalidos)('%s %j → inválido, con mensaje fijo que no repite el valor', (type, entrada) => {
    const r = normalizeIndicator(type, entrada);
    expect(r).toEqual({ ok: false, message: INVALID_VALUE[type] });
  });
});

describe('defangIndicator (D-017)', () => {
  it.each([
    ['domain', 'universidad-ejernplo.example', 'universidad-ejernplo[.]example'],
    ['domain', '203.0.113.7', '203[.]0[.]113[.]7'],
    ['url', 'http://203.0.113.7/beca/solicitud', 'hxxp://203[.]0[.]113[.]7/beca/solicitud'],
    ['url', 'https://xn--nmina-avisos-4fk.example/recibo', 'hxxps://xn--nmina-avisos-4fk[.]example/recibo'],
    ['sender', 'rh@nomina-avisos.example', 'rh@nomina-avisos[.]example'],
    ['sha256', SHA, SHA],
  ] as [IndicatorType, string, string][])('%s %s → %s', (type, value, esperado) => {
    expect(defangIndicator(type, value)).toBe(esperado);
  });
});
