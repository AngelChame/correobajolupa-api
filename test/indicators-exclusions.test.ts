import { describe, expect, it } from 'vitest';
import { configExclusions, covers, domainSuffixes } from '../src/indicators/exclusions.js';

// Lista de exclusión (P-11): un dominio excluido cubre el dominio y sus subdominios, con frontera de etiqueta.
describe('covers', () => {
  it.each([
    ['universidad-ejemplo.example', 'universidad-ejemplo.example', true],
    ['universidad-ejemplo.example', 'portal.universidad-ejemplo.example', true],
    ['universidad-ejemplo.example', 'a.b.universidad-ejemplo.example', true],
    ['universidad-ejemplo.example', 'xuniversidad-ejemplo.example', false],
    ['universidad-ejemplo.example', 'universidad-ejemplo.example.otro.example', false],
    ['universidad-ejemplo.example', 'universidad-ejernplo.example', false],
    ['portal.universidad-ejemplo.example', 'universidad-ejemplo.example', false],
    ['203.0.113.7', '203.0.113.7', true],
    ['113.7', '203.0.113.7', false],
    ['[2001:db8::1]', '[2001:db8::1]', true],
  ])('%s cubre %s → %s', (excluido, host, esperado) => {
    expect(covers(excluido, host)).toBe(esperado);
  });
});

describe('domainSuffixes', () => {
  it('de más largo a más corto, con al menos dos etiquetas; una IP solo ella misma', () => {
    expect(domainSuffixes('a.b.universidad-ejemplo.example')).toEqual(['a.b.universidad-ejemplo.example', 'b.universidad-ejemplo.example', 'universidad-ejemplo.example']);
    expect(domainSuffixes('universidad-ejemplo.example')).toEqual(['universidad-ejemplo.example']);
    expect(domainSuffixes('203.0.113.7')).toEqual(['203.0.113.7']);
    expect(domainSuffixes('[2001:db8::1]')).toEqual(['[2001:db8::1]']);
  });
});

describe('configExclusions', () => {
  it('normaliza los dominios de la configuración y quita repetidos', () => {
    expect(configExclusions(['universidad-ejemplo.example', 'Universidad-Ejemplo.Example.'])).toEqual(['universidad-ejemplo.example']);
  });
});
