import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_PATH, render } from '../src/contract/generate.js';
import { buildDocument } from '../src/contract/document.js';

type Operation = {
  operationId?: string;
  security?: unknown[];
  parameters?: { in: string; name: string }[];
};
const doc = buildDocument() as unknown as { paths: Record<string, Record<string, Operation>> };
const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ path, method, op })),
);

describe('contrato OpenAPI (D-033)', () => {
  it('el archivo commiteado coincide con el generado desde los esquemas Zod', () => {
    const commiteado = readFileSync(CONTRACT_PATH, 'utf8');
    expect(commiteado, 'Ejecuta `npm run contract:generate` y commitea contract/openapi.json').toBe(render());
  });

  it('cada operación tiene un operationId único', () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('las operaciones que modifican datos exigen X-CSRF-Token (salvo registro y entrada)', () => {
    const sinCsrf = new Set(['/auth/register', '/auth/login']);
    for (const { path, method, op } of operations) {
      if (!['post', 'patch', 'put', 'delete'].includes(method) || sinCsrf.has(path)) continue;
      const tiene = op.parameters?.some((p) => p.in === 'header' && p.name.toLowerCase() === 'x-csrf-token');
      expect(tiene, `${method.toUpperCase()} ${path} sin X-CSRF-Token`).toBe(true);
    }
  });

  it('solo salud, registro y entrada son públicos', () => {
    const publicas = operations.filter(({ op }) => Array.isArray(op.security) && op.security.length === 0).map(({ path }) => path);
    expect(publicas.sort()).toEqual(['/auth/login', '/auth/register', '/health']);
  });
});
