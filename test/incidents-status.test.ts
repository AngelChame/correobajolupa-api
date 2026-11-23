import { describe, expect, it } from 'vitest';
import { IncidentStatus } from '../src/contract/schemas/incidents.js';
import { canTransition, isFinal } from '../src/incidents/status.js';

// Matriz completa 5 x 5 de transiciones de un incidente (M6). Las únicas válidas:
const VALIDAS = new Set([
  'received>analyzing',
  'analyzing>contained',
  'contained>closed',
  'received>false_positive',
  'analyzing>false_positive',
  'contained>false_positive',
]);

const todos = IncidentStatus.options;
const matriz = todos.flatMap((from) => todos.map((to) => [from, to, VALIDAS.has(`${from}>${to}`)] as const));

describe('transiciones de estado de un incidente', () => {
  it('la matriz tiene las 25 combinaciones', () => {
    expect(matriz).toHaveLength(25);
  });

  it.each(matriz)('%s → %s: %s', (from, to, esperado) => {
    expect(canTransition(from, to)).toBe(esperado);
  });

  it('saltarse un paso es inválido', () => {
    expect(canTransition('received', 'contained')).toBe(false);
    expect(canTransition('received', 'closed')).toBe(false);
    expect(canTransition('analyzing', 'closed')).toBe(false);
  });

  it('closed y false_positive son finales; los demás no', () => {
    expect(todos.filter(isFinal)).toEqual(['closed', 'false_positive']);
  });
});
