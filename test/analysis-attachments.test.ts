import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { detectType, extensionsOf, MAX_ATTACHMENTS, sanitizeFileName } from '../src/analysis/attachments.js';
import { analyze } from '../src/analysis/index.js';
import { correoConAdjuntos } from './correo-adjuntos.js';

// Adjuntos (M2): extracción sin ejecutar ni descomprimir. Contenidos sintéticos armados aquí:
// ningún binario real en el repositorio.
const INST = { institutionalDomains: ['universidad-ejemplo.example'] };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const bytes = (...valores: number[]) => Buffer.from(valores);

describe('tipo por los primeros bytes', () => {
  it.each([
    ['PE (MZ)', bytes(0x4d, 0x5a, 0x90, 0x00), 'application/x-msdownload'],
    ['ELF', bytes(0x7f, 0x45, 0x4c, 0x46, 0x02), 'application/x-elf'],
    ['Mach-O', bytes(0xcf, 0xfa, 0xed, 0xfe, 0x07), 'application/x-mach-binary'],
    ['PDF', Buffer.from('%PDF-1.7\n'), 'application/pdf'],
    ['ZIP', Buffer.from('PK\x03\x04resto', 'latin1'), 'application/zip'],
    ['OLE2', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00), 'application/x-ole-storage'],
    ['RAR', Buffer.from('Rar!\x1a\x07\x00', 'latin1'), 'application/vnd.rar'],
    ['7z', bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00), 'application/x-7z-compressed'],
    ['gzip', bytes(0x1f, 0x8b, 0x08), 'application/gzip'],
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00), 'image/png'],
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['GIF', Buffer.from('GIF89a...'), 'image/gif'],
    ['RTF', Buffer.from('{\\rtf1\\ansi texto}'), 'application/rtf'],
    ['texto UTF-8', Buffer.from('Hola, aquí va el texto.\r\nOtra línea\t.'), 'text/plain'],
  ])('%s', (_n, contenido, tipo) => {
    expect(detectType(contenido)).toBe(tipo);
  });

  it('vacío o binario sin firma conocida: null', () => {
    expect(detectType(Buffer.alloc(0))).toBeNull();
    expect(detectType(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull();
    expect(detectType(bytes(0xc3, 0x28, 0x41))).toBeNull(); // UTF-8 inválido
  });

  it('un carácter de varios bytes partido al final de la muestra sigue siendo texto', () => {
    const texto = Buffer.concat([Buffer.alloc(4095, 0x61), Buffer.from('é')]); // la "é" queda partida en el byte 4096
    expect(detectType(texto)).toBe('text/plain');
  });
});

describe('nombre saneado', () => {
  it('escapa controles y caracteres de dirección de texto de forma visible', () => {
    expect(sanitizeFileName('factura‮fdp.exe')).toBe('factura[U+202E]fdp.exe');
    expect(sanitizeFileName('a\u0000b\u001fc\u0085d⁦e')).toBe('a[U+0000]b[U+001F]c[U+0085]d[U+2066]e');
  });

  it('desactiva URL (D-017) y deja igual un nombre normal o con ../', () => {
    expect(sanitizeFileName('https://banco.example/x.pdf')).toBe('hxxps://banco[.]example/x.pdf');
    expect(sanitizeFileName('estado de cuenta (1).pdf')).toBe('estado de cuenta (1).pdf');
    // Se guarda como texto: nunca se usa como ruta, así que ../ no hace daño.
    expect(sanitizeFileName('../../etc/passwd')).toBe('../../etc/passwd');
  });

  it('recorta a 255 caracteres sin partir un emoji, y vacío queda null', () => {
    const largo = sanitizeFileName(`${'😀'.repeat(300)}.pdf`)!;
    expect(Array.from(largo)).toHaveLength(255);
    expect(largo).toBe('😀'.repeat(255));
    expect(sanitizeFileName('   ')).toBeNull();
    expect(sanitizeFileName('')).toBeNull();
    expect(sanitizeFileName(undefined)).toBeNull();
  });
});

describe('extensiones para R7', () => {
  it.each([
    ['factura-0042.pdf.exe', 'exe', 'pdf'],
    ['FACTURA.PDF.EXE. ', 'exe', 'pdf'],
    ['estado-de-cuenta.pdf', 'pdf', null],
    ['sin-extension', null, null],
    ['raro.pdf.ex e', null, null],
    [undefined, null, null],
  ])('%s', (nombre, extension, previousExtension) => {
    expect(extensionsOf(nombre)).toEqual({ extension, previousExtension });
  });
});

describe('analyze(): adjuntos', () => {
  it('extrae metadatos y SHA-256 del contenido decodificado, sin descomprimir un ZIP', async () => {
    const zip = Buffer.from('PK\x03\x04 contenido sintético que parece un zip', 'latin1');
    const pdf = Buffer.from('%PDF-1.4\n% sintético\n');
    const r = await analyze(
      correoConAdjuntos([
        { name: 'paquete.zip', type: 'application/zip', content: zip },
        { name: 'informe.pdf', type: 'application/pdf', content: pdf },
      ]),
      'eml',
      INST,
    );
    expect(r.attachmentsIgnored).toBe(0);
    expect(r.attachments.map(({ content: _c, ...a }) => a)).toEqual([
      {
        position: 0,
        fileName: 'paquete.zip',
        declaredType: 'application/zip',
        detectedType: 'application/zip',
        sizeBytes: zip.length,
        sha256: sha(zip),
        extension: 'zip',
        previousExtension: null,
        hasBidiControls: false,
      },
      {
        position: 1,
        fileName: 'informe.pdf',
        declaredType: 'application/pdf',
        detectedType: 'application/pdf',
        sizeBytes: pdf.length,
        sha256: sha(pdf),
        extension: 'pdf',
        previousExtension: null,
        hasBidiControls: false,
      },
    ]);
    // El contenido queda en memoria tal cual (para ClamAV): un solo adjunto por ZIP, sin entradas internas.
    expect(r.attachments[0]!.content.equals(zip)).toBe(true);
  });

  it('un nombre con U+202E se guarda escapado y se marca para R7', async () => {
    const r = await analyze(correoConAdjuntos([{ name: 'factura‮fdp.exe', type: 'application/octet-stream', content: bytes(0x4d, 0x5a) }]), 'eml', INST);
    expect(r.attachments[0]).toMatchObject({ fileName: 'factura[U+202E]fdp.exe', hasBidiControls: true, extension: 'exe' });
  });

  it(`registra como mucho ${MAX_ATTACHMENTS} adjuntos y cuenta los ignorados`, async () => {
    const partes = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) => ({ name: `n${i}.txt`, type: 'text/plain', content: Buffer.from(`texto ${i}`) }));
    const r = await analyze(correoConAdjuntos(partes), 'eml', INST);
    expect(r.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(r.attachmentsIgnored).toBe(3);
    expect(r.attachments.at(-1)!.position).toBe(MAX_ATTACHMENTS - 1);
  });

  it('un correo sin adjuntos y el texto pegado dan lista vacía', async () => {
    expect((await analyze(Buffer.from('From: a@b.example\r\nDate: Mon, 23 Nov 2026 10:00:00 -0600\r\n\r\nHola'), 'eml', INST)).attachments).toEqual([]);
    expect((await analyze(Buffer.from('Estimado usuario: hola'), 'paste', INST)).attachments).toEqual([]);
  });
});
