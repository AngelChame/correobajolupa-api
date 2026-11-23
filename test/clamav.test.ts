import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_BYTES, parseReply, scanBuffer, SCAN_DETAIL } from '../src/clamav/client.js';
import { startFakeClamd, type FakeClamd, type FakeReply } from './fake-clamd.js';

// Cliente de ClamAV contra un clamd falso (node:net). Ningún contenido real de malware.
let fake: FakeClamd | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function escanear(reply: FakeReply, content = Buffer.from('contenido sintético'), timeoutMs = 2000) {
  fake = await startFakeClamd(reply);
  return scanBuffer(content, { host: '127.0.0.1', port: fake.port, timeoutMs });
}

describe('scanBuffer', () => {
  it('stream: OK → not_detected; manda zINSTREAM y el trozo final de 0', async () => {
    expect(await escanear({ kind: 'text', text: 'stream: OK' })).toEqual({ status: 'not_detected', detail: null });
    expect(fake!.received).toHaveLength(1);
    expect(fake!.received[0]).toMatchObject({ command: 'zINSTREAM', lengths: [19 + 1, 0] }); // "é" ocupa 2 bytes
    expect(fake!.received[0]!.content.toString()).toBe('contenido sintético');
  });

  it('FOUND → detected con el nombre de la firma', async () => {
    expect(await escanear({ kind: 'text', text: 'stream: Firma-Sintetica-1 FOUND' })).toEqual({ status: 'detected', detail: 'Firma-Sintetica-1' });
  });

  it('ERROR → error', async () => {
    expect(await escanear({ kind: 'text', text: 'stream: algo salió mal ERROR' })).toEqual({ status: 'error', detail: SCAN_DETAIL.clamdError });
  });

  it('conexión cortada a la mitad → error, nunca not_detected', async () => {
    expect(await escanear({ kind: 'cut' })).toEqual({ status: 'error', detail: SCAN_DETAIL.connection });
  });

  it('silencio hasta el tiempo límite → error por tiempo', async () => {
    const inicio = Date.now();
    expect(await escanear({ kind: 'silent' }, Buffer.from('x'), 150)).toEqual({ status: 'error', detail: SCAN_DETAIL.timeout });
    expect(Date.now() - inicio).toBeLessThan(1500);
  });

  it('respuesta basura sin terminador → error', async () => {
    expect(await escanear({ kind: 'garbage' })).toEqual({ status: 'error', detail: SCAN_DETAIL.unexpected });
  });

  it('conexión rechazada (nadie escucha) → error', async () => {
    const libre = createServer();
    await new Promise<void>((r) => libre.listen(0, '127.0.0.1', r));
    const port = (libre.address() as AddressInfo).port;
    await new Promise<void>((r) => libre.close(() => r()));
    expect(await scanBuffer(Buffer.from('x'), { host: '127.0.0.1', port, timeoutMs: 2000 })).toEqual({ status: 'error', detail: SCAN_DETAIL.connection });
  });

  it('cuerpo grande: trozos de 64 KiB con su longitud big-endian y trozo final de 0', async () => {
    const grande = Buffer.alloc(CHUNK_BYTES * 2 + 123, 0x5a);
    expect(await escanear({ kind: 'text', text: 'stream: OK' }, grande)).toMatchObject({ status: 'not_detected' });
    const r = fake!.received[0]!;
    expect(r.lengths).toEqual([CHUNK_BYTES, CHUNK_BYTES, 123, 0]);
    expect(r.content.equals(grande)).toBe(true);
  });

  it('contenido vacío: solo el trozo final', async () => {
    await escanear({ kind: 'text', text: 'stream: OK' }, Buffer.alloc(0));
    expect(fake!.received[0]!.lengths).toEqual([0]);
  });
});

describe('parseReply', () => {
  it.each([
    ['stream: OK', 'not_detected'],
    ['stream: Win.Test.EICAR_HDB-1 FOUND', 'detected'],
    ['INSTREAM size limit exceeded. ERROR', 'error'],
    ['stream:  FOUND', 'error'],
    ['', 'error'],
    ['PONG', 'error'],
  ])('%j → %s', (texto, estado) => {
    expect(parseReply(texto).status).toBe(estado);
  });

  it('límite de tamaño de clamd tiene su propio motivo; la firma se recorta a 200 visibles', () => {
    expect(parseReply('INSTREAM size limit exceeded').detail).toBe(SCAN_DETAIL.sizeLimit);
    const larga = parseReply(`stream: ${'F'.repeat(300)}\u0007 FOUND`);
    expect(larga.detail).toHaveLength(200);
    expect(larga.detail).not.toMatch(/[^\x20-\x7e]/);
  });
});
