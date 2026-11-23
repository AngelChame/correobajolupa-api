import { describe, expect, it } from 'vitest';
import { SCAN_DETAIL, type ScanResult } from '../src/clamav/client.js';
import { scanAttachments, UNSUPPORTED_DETAIL, type ScanFn, type ScanSettings } from '../src/clamav/scan.js';

// Escaneo de los adjuntos de un reporte: límites y presupuesto, con un escáner falso.
const AJUSTES: ScanSettings = { host: 'clamav', port: 3310, timeoutMs: 1000, totalBudgetMs: 5000, maxScanBytes: 10, maxScanned: 3 };
const adj = (texto: string) => ({ content: Buffer.from(texto) });

describe('scanAttachments', () => {
  it('vacío, demasiado grande y más allá del tope quedan unsupported sin llamar a ClamAV', async () => {
    const llamadas: number[] = [];
    const scanFn: ScanFn = async (content) => {
      llamadas.push(content.length);
      return { status: 'not_detected', detail: null };
    };
    const r = await scanAttachments([adj('ok'), adj(''), adj('x'.repeat(11)), adj('cuarto')], AJUSTES, scanFn);
    expect(r.map((x) => [x.scanStatus, x.scanDetail])).toEqual([
      ['not_detected', null],
      ['unsupported', UNSUPPORTED_DETAIL.empty],
      ['unsupported', UNSUPPORTED_DETAIL.tooLarge],
      ['unsupported', UNSUPPORTED_DETAIL.overLimit],
    ]);
    expect(llamadas).toEqual([2]);
    expect(r[0]!.scannedAt).toBeInstanceOf(Date);
    expect(r[1]!.scannedAt).toBeNull();
  });

  it('detected conserva la firma; un error no lleva scannedAt; una excepción es error', async () => {
    const respuestas: (ScanResult | Error)[] = [
      { status: 'detected', detail: 'Firma-Sintetica' },
      { status: 'error', detail: SCAN_DETAIL.clamdError },
      new Error('falla inesperada'),
    ];
    const scanFn: ScanFn = async () => {
      const r = respuestas.shift()!;
      if (r instanceof Error) throw r;
      return r;
    };
    const r = await scanAttachments([adj('a'), adj('b'), adj('c')], AJUSTES, scanFn);
    expect(r[0]).toMatchObject({ scanStatus: 'detected', scanDetail: 'Firma-Sintetica' });
    expect(r[1]).toEqual({ scanStatus: 'error', scanDetail: SCAN_DETAIL.clamdError, scannedAt: null });
    expect(r[2]).toEqual({ scanStatus: 'error', scanDetail: SCAN_DETAIL.connection, scannedAt: null });
  });

  it('el presupuesto total recorta el tiempo de cada escaneo y lo que no alcanza queda error', async () => {
    let reloj = 0;
    const tiempos: number[] = [];
    const scanFn: ScanFn = async (_c, { timeoutMs }) => {
      tiempos.push(timeoutMs);
      reloj += 3000; // cada escaneo "tarda" 3 s
      return { status: 'not_detected', detail: null };
    };
    const ajustes = { ...AJUSTES, timeoutMs: 4000, totalBudgetMs: 5000 };
    const r = await scanAttachments([adj('a'), adj('b'), adj('c')], ajustes, scanFn, () => reloj);
    expect(tiempos).toEqual([4000, 2000]);
    expect(r.map((x) => x.scanStatus)).toEqual(['not_detected', 'not_detected', 'error']);
    expect(r[2]!.scanDetail).toBe(SCAN_DETAIL.timeout);
  });
});
