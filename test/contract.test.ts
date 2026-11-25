import { readFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { CONTRACT_PATH, render } from '../src/contract/generate.js';
import { buildDocument } from '../src/contract/document.js';
import { UpdateIncidentBody } from '../src/contract/schemas/incidents.js';
import { CreateExclusionBody, ProposeIndicatorBody } from '../src/contract/schemas/indicators.js';
import { RuleId } from '../src/contract/schemas/reports.js';

type Operation = {
  operationId?: string;
  security?: unknown[];
  parameters?: { in: string; name: string }[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
};
const doc = buildDocument() as unknown as { paths: Record<string, Record<string, Operation>> };
const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ path, method, op })),
);

describe('contrato OpenAPI (D-033)', () => {
  it('declara la versión 0.4.0 y las reglas nuevas R9 y R10', () => {
    const versionado = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as {
      info: { version: string };
      components: { schemas: { RuleId: { enum: string[] } } };
    };
    expect(versionado.info.version).toBe('0.4.0');
    expect(versionado.components.schemas.RuleId.enum).toEqual([...RuleId.options]);
    expect(RuleId.options).toContain('R9');
    expect(RuleId.options).toContain('R10');
  });

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

  it('el documento es OpenAPI 3.1 válido según el esquema oficial', async () => {
    const validator = new Validator();
    const resultado = await validator.validate(JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as Record<string, unknown>);
    expect(resultado.errors ?? [], 'errores del validador de OpenAPI 3.1').toEqual([]);
    expect(resultado.valid).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('cada esquema del documento es JSON Schema 2020-12 válido', () => {
    // El esquema oficial de OpenAPI 3.1 revisa la estructura, pero no el interior de cada Schema
    // Object (un `type: "objeto"` pasaría). Por eso se revisa cada uno contra el metaesquema 2020-12.
    const ajv = new Ajv2020({ strict: false });
    const contrato = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as { components?: { schemas?: Record<string, unknown> } };
    const esquemas: [string, unknown][] = Object.entries(contrato.components?.schemas ?? {}).map(([n, s]) => [`components.schemas.${n}`, s]);
    const recorrer = (nodo: unknown, ruta: string): void => {
      if (!nodo || typeof nodo !== 'object') return;
      for (const [clave, valor] of Object.entries(nodo)) {
        if (clave === 'schema' && valor && typeof valor === 'object') esquemas.push([`${ruta}.schema`, valor]);
        else recorrer(valor, `${ruta}.${clave}`);
      }
    };
    recorrer((contrato as { paths?: unknown }).paths, 'paths');
    expect(esquemas.length).toBeGreaterThan(20);
    for (const [ruta, esquema] of esquemas) {
      expect(ajv.validateSchema(esquema as object), `${ruta}: ${ajv.errorsText()}`).toBe(true);
    }
  });

  it('todo lo que modifica declara 403 y todo lo que recibe cuerpo declara 400 (salvo registro y entrada)', () => {
    const sinCsrf = new Set(['/auth/register', '/auth/login']);
    for (const { path, method, op } of operations) {
      if (sinCsrf.has(path)) continue;
      const nombre = `${method.toUpperCase()} ${path}`;
      if (['post', 'patch', 'put', 'delete'].includes(method)) expect(op.responses?.['403'], `${nombre} sin 403`).toBeDefined();
      if (op.requestBody) expect(op.responses?.['400'], `${nombre} recibe cuerpo y no declara 400`).toBeDefined();
    }
  });

  it('solo salud, registro y entrada son públicos', () => {
    const publicas = operations.filter(({ op }) => Array.isArray(op.security) && op.security.length === 0).map(({ path }) => path);
    expect(publicas.sort()).toEqual(['/auth/login', '/auth/register', '/health']);
  });
});

describe('ajustes del contrato 0.3.0 (D-055)', () => {
  type Propiedad = { maxLength?: number; minLength?: number; type?: unknown; anyOf?: Propiedad[]; description?: string };
  const contrato = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as {
    components: { schemas: Record<string, { properties: Record<string, Propiedad>; required?: string[] }> };
  };
  const propiedad = (esquema: string, campo: string): Propiedad => contrato.components.schemas[esquema]!.properties[campo]!;

  it('POST /indicators limita value a 2048 y note a 500 caracteres', () => {
    expect(propiedad('ProposeIndicatorBody', 'value')).toMatchObject({ minLength: 1, maxLength: 2048 });
    expect(propiedad('ProposeIndicatorBody', 'note')).toMatchObject({ maxLength: 500 });

    const base = { type: 'domain' as const, value: 'x'.repeat(2048) };
    expect(ProposeIndicatorBody.safeParse(base).success).toBe(true);
    expect(ProposeIndicatorBody.safeParse({ ...base, value: 'x'.repeat(2049) }).success).toBe(false);
    expect(ProposeIndicatorBody.safeParse({ ...base, value: '' }).success).toBe(false);
    expect(ProposeIndicatorBody.safeParse({ ...base, note: 'n'.repeat(500) }).success).toBe(true);
    expect(ProposeIndicatorBody.safeParse({ ...base, note: 'n'.repeat(501) }).success).toBe(false);
  });

  it('POST /exclusions limita domain a 253 y reason a 500 caracteres', () => {
    expect(propiedad('CreateExclusionBody', 'domain')).toMatchObject({ minLength: 1, maxLength: 253 });
    expect(propiedad('CreateExclusionBody', 'reason')).toMatchObject({ maxLength: 500 });

    const base = { domain: 'd'.repeat(253) };
    expect(CreateExclusionBody.safeParse(base).success).toBe(true);
    expect(CreateExclusionBody.safeParse({ domain: 'd'.repeat(254) }).success).toBe(false);
    expect(CreateExclusionBody.safeParse({ domain: '' }).success).toBe(false);
    expect(CreateExclusionBody.safeParse({ ...base, reason: 'r'.repeat(500) }).success).toBe(true);
    expect(CreateExclusionBody.safeParse({ ...base, reason: 'r'.repeat(501) }).success).toBe(false);
  });

  it('PATCH /incidents/{incidentId} acepta description null, opcional y con máximo 2000', () => {
    const description = propiedad('UpdateIncidentBody', 'description');
    expect(contrato.components.schemas['UpdateIncidentBody']!.required ?? []).not.toContain('description');
    expect(description.description).toContain('`null` la borra');
    expect(JSON.stringify(description)).toContain('"type":"null"');
    expect(JSON.stringify(description)).toContain('"maxLength":2000');

    expect(UpdateIncidentBody.safeParse({ description: null }).success).toBe(true);
    expect(UpdateIncidentBody.safeParse({}).success).toBe(true);
    expect(UpdateIncidentBody.safeParse({ description: 'a'.repeat(2000) }).success).toBe(true);
    expect(UpdateIncidentBody.safeParse({ description: 'a'.repeat(2001) }).success).toBe(false);
    expect(UpdateIncidentBody.safeParse({ description: 5 }).success).toBe(false);
  });
});
