import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

/**
 * Servidor clamd falso para pruebas: lee "zINSTREAM\0" y los trozos con su longitud, guarda lo
 * recibido y responde según `reply`. No escanea nada: decide la respuesta la prueba.
 */
export type FakeReply =
  | { kind: 'text'; text: string } // responde el texto + "\0" cuando llega el trozo final
  | { kind: 'cut' } // cierra la conexión a la mitad, sin responder
  | { kind: 'silent' } // no responde nunca
  | { kind: 'garbage' }; // manda bytes sin "\0" hasta pasar el tope

export type Received = { command: string; lengths: number[]; content: Buffer };

export type FakeClamd = { port: number; received: Received[]; close: () => Promise<void> };

export async function startFakeClamd(reply: FakeReply | ((content: Buffer) => FakeReply)): Promise<FakeClamd> {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const lengths: number[] = [];
    const parts: Buffer[] = [];
    let answered = false;

    socket.on('data', (data: Buffer) => {
      if (answered) return;
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const nul = buffer.indexOf(0);
        if (nul === -1) return;
        command = buffer.subarray(0, nul).toString('latin1');
        buffer = buffer.subarray(nul + 1);
        const r = typeof reply === 'function' ? null : reply;
        if (r?.kind === 'cut') {
          answered = true;
          socket.destroy();
          return;
        }
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        lengths.push(length);
        parts.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
        if (length === 0) {
          answered = true;
          const content = Buffer.concat(parts);
          received.push({ command, lengths, content });
          const r = typeof reply === 'function' ? reply(content) : reply;
          if (r.kind === 'text') socket.end(`${r.text}\0`);
          else if (r.kind === 'cut') socket.destroy();
          else if (r.kind === 'garbage') socket.write(Buffer.alloc(4096, 0x41));
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
