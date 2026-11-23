import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CandidateList, Indicator } from '../../src/contract/schemas/indicators.js';
import { dedupeKey } from '../../src/lab/index-message.js';
import { FakeServer } from './fake-mail.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Búsqueda retrospectiva (M5) guiada por test/fixtures/lab/manifest.json (D-023): los 21 mensajes
// sincronizados con el proveedor falso, cada indicador del manifiesto propuesto y confirmado, y el
// conjunto de candidatos comparado con el del manifiesto (candidatos + falsos candidatos).
type App = Parameters<typeof request>[0];
const LAB = new URL('../fixtures/lab/', import.meta.url);
type LabMessage = { id: string; file: string; mailbox: string; messageId: string; truth: string };
type LabIndicator = { campaign: string | null; type: string; value: string; candidates: string[]; falseCandidates: string[] };
const manifest = JSON.parse(readFileSync(new URL('manifest.json', LAB), 'utf8')) as {
  institutionalDomains: string[];
  mailboxes: string[];
  messages: LabMessage[];
  indicators: LabIndicator[];
};
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

let a: App;
let analista: Sesion;
/** id del mensaje indexado → id del manifiesto (A1, LC2…). */
const idDeManifiesto = new Map<string, string>();

const proponer = (body: Record<string, unknown>) =>
  request(a).post('/api/v1/indicators').set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf).send(body);
const confirmar = (id: string) => request(a).post(`/api/v1/indicators/${id}/confirm`).set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf);
const candidatos = (id: string, query = '?pageSize=100') => request(a).get(`/api/v1/indicators/${id}/candidates${query}`).set('Cookie', analista.cookie);

async function confirmado(type: string, value: string): Promise<string> {
  const res = await proponer({ type, value });
  expect(res.status, `${type} ${value}: ${JSON.stringify(res.body)}`).toBe(201);
  const id = Indicator.parse(res.body).id;
  await confirmar(id).expect(200);
  return id;
}

beforeAll(async () => {
  await limpiarBase();
  const mapa = new Map<string, FakeServer>();
  for (const address of manifest.mailboxes) {
    const s = new FakeServer();
    for (const m of manifest.messages.filter((x) => x.mailbox === address)) s.add(readFileSync(new URL(m.file, LAB)));
    mapa.set(address, s);
  }
  ({ app: a } = crearApp({ INSTITUTIONAL_DOMAINS: manifest.institutionalDomains.join(',') }, { openMailProvider: (address) => mapa.get(address)!.open() }));
  analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
  for (const mb of await db.mailbox.findMany()) {
    await request(a).post(`/api/v1/mailboxes/${mb.id}/sync`).set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf).expect(200);
  }
  for (const m of manifest.messages) {
    const fila = await db.indexedMessage.findFirstOrThrow({ where: { dedupeKey: dedupeKey(m.messageId)! } });
    idDeManifiesto.set(fila.id, m.id);
  }
  expect(idDeManifiesto.size).toBe(21);
});

afterAll(async () => {
  await db.$disconnect();
});

/** Resultado de cada indicador del manifiesto, para las métricas del final. */
const resultados: { indicador: LabIndicator; devueltos: string[] }[] = [];

describe('candidatos contra el manifiesto del laboratorio', () => {
  const confirmables = manifest.indicators.filter((i) => !manifest.institutionalDomains.includes(i.value));

  it.each(confirmables.map((i) => [`${i.type} ${i.value}`, i] as const))('%s', async (_nombre, ind) => {
    const id = await confirmado(ind.type, ind.value);
    const res = await candidatos(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lista = CandidateList.parse(res.body);
    const devueltos = lista.items.map((c) => idDeManifiesto.get(c.message.id)!);
    resultados.push({ indicador: ind, devueltos });

    // El conjunto devuelto es exactamente candidatos + falsos candidatos del manifiesto.
    expect(new Set(devueltos)).toEqual(new Set([...ind.candidates, ...ind.falseCandidates]));
    expect(lista.total).toBe(devueltos.length);
    for (const c of lista.items) {
      expect(c.reasons.length).toBeGreaterThan(0);
      for (const r of c.reasons) {
        expect(r).toMatchObject({ indicatorId: id, kind: ind.type });
        // Desactivado (D-017): nunca un enlace o dominio clicable.
        expect(r.matchedValue).not.toMatch(/https?:\/\/|\w\.\w/);
      }
      // Una razón por ubicación.
      expect(new Set(c.reasons.map((r) => r.location)).size).toBe(c.reasons.length);
    }
  });

  it('nube-compartida.example: salen B3 y también LC1 y LC2 (falsos candidatos honestos, D-019)', async () => {
    const r = resultados.find((x) => x.indicador.value === 'nube-compartida.example')!;
    expect(new Set(r.devueltos)).toEqual(new Set(['B3', 'LC1', 'LC2']));
    expect(r.indicador.falseCandidates).toEqual(['LC1', 'LC2']);
  });

  it('el dominio institucional no se puede proponer (409, P-11): LA1 a LA3, LC1 y LC2 nunca salen por él', async () => {
    const institucional = manifest.indicators.filter((i) => manifest.institutionalDomains.includes(i.value));
    expect(institucional).toHaveLength(1);
    const res = await proponer({ type: 'domain', value: institucional[0]!.value });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');
  });

  it('métricas sobre el conjunto del manifiesto (D-023): relacionados encontrados y candidatos incorrectos', () => {
    expect(resultados).toHaveLength(confirmables.length);
    let esperados = 0;
    let encontrados = 0;
    let devueltos = 0;
    let incorrectos = 0;
    for (const { indicador, devueltos: d } of resultados) {
      esperados += indicador.candidates.length;
      encontrados += indicador.candidates.filter((c) => d.includes(c)).length;
      devueltos += d.length;
      incorrectos += d.filter((c) => !indicador.candidates.includes(c)).length;
    }
    // Se imprime para el reporte; sin umbral duro (D-023).
    console.info(`M5 métricas: relacionados encontrados ${encontrados}/${esperados}; candidatos incorrectos ${incorrectos}/${devueltos}`);
    expect(encontrados).toBe(esperados);
    expect(incorrectos).toBe(2);
  });
});

describe('razones y orden', () => {
  it('campaña A por dominio parecido: razones link y from en cada mensaje, ordenadas', async () => {
    const ind = await db.indicator.findFirstOrThrow({ where: { type: 'domain', value: 'universidad-ejernplo.example' } });
    const lista = CandidateList.parse((await candidatos(ind.id).expect(200)).body);
    for (const c of lista.items) {
      expect(c.reasons.map((r) => [r.location, r.matchedValue])).toEqual([
        ['link', 'universidad-ejernplo[.]example'],
        ['from', 'universidad-ejernplo[.]example'],
      ]);
    }
  });

  it('Reply-To: el dominio buzon-respuestas.example coincide solo en reply_to', async () => {
    const ind = await db.indicator.findFirstOrThrow({ where: { type: 'domain', value: 'buzon-respuestas.example' } });
    const lista = CandidateList.parse((await candidatos(ind.id).expect(200)).body);
    expect(lista.items.flatMap((c) => c.reasons.map((r) => r.location))).toEqual(['reply_to', 'reply_to', 'reply_to']);
  });

  it('orden: más razones primero; luego fecha descendente; paginación estable', async () => {
    // B: proveedor-pagos.example solo en el remitente (una razón cada uno), ordenados por fecha.
    const ind = await db.indicator.findFirstOrThrow({ where: { type: 'domain', value: 'proveedor-pagos.example' } });
    const todos = CandidateList.parse((await candidatos(ind.id).expect(200)).body).items;
    const fechas = todos.map((c) => c.message.date);
    expect([...fechas].sort().reverse()).toEqual(fechas);
    const p1 = CandidateList.parse((await candidatos(ind.id, '?page=1&pageSize=2').expect(200)).body);
    const p2 = CandidateList.parse((await candidatos(ind.id, '?page=2&pageSize=2').expect(200)).body);
    expect(p1).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect([...p1.items, ...p2.items].map((c) => c.message.id)).toEqual(todos.map((c) => c.message.id));
  });

  it('un mensaje en Cuarentena también se busca', async () => {
    const ind = await db.indicator.findFirstOrThrow({ where: { type: 'sha256' } });
    const b1 = [...idDeManifiesto].find(([, m]) => m === 'B1')![0];
    await db.indexedMessage.update({ where: { id: b1 }, data: { location: 'quarantine' } });
    try {
      const lista = CandidateList.parse((await candidatos(ind.id).expect(200)).body);
      expect(lista.items.find((c) => c.message.id === b1)?.message).toMatchObject({ location: 'quarantine', quarantined: true });
    } finally {
      await db.indexedMessage.update({ where: { id: b1 }, data: { location: 'inbox' } });
    }
  });
});

describe('errores de /candidates', () => {
  it('409 si no está confirmado (propuesto o descartado); 404 inexistente o mal formado; 400 paginación; 403 reportante; 401 sin sesión', async () => {
    const propuesto = Indicator.parse((await proponer({ type: 'domain', value: 'sin-confirmar.example' }).expect(201)).body).id;
    const res = await candidatos(propuesto);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');
    await request(a).post(`/api/v1/indicators/${propuesto}/dismiss`).set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf).expect(200);
    expect((await candidatos(propuesto)).status).toBe(409);

    for (const malo of [UUID_INEXISTENTE, 'no-es-uuid']) {
      const r = await candidatos(malo);
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ code: 'not_found', message: 'El indicador no existe.' });
    }
    const ind = await db.indicator.findFirstOrThrow({ where: { status: 'confirmed' } });
    for (const q of ['?page=0', '?pageSize=101', '?page=abc']) expect((await candidatos(ind.id, q)).status, q).toBe(400);

    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    expect((await request(a).get(`/api/v1/indicators/${ind.id}/candidates`).set('Cookie', reportante.cookie)).status).toBe(403);
    expect((await request(a).get(`/api/v1/indicators/${ind.id}/candidates`)).status).toBe(401);
  });
});
