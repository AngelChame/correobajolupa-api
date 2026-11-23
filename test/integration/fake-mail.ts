import { MailUnavailableError, MoveUnconfirmedError, type FolderListing, type MailLocation, type MailProvider } from '../../src/mail/provider.js';

// Proveedor de correo en memoria para las pruebas de integración: simula INBOX y Cuarentena de un
// buzón del laboratorio (UID por carpeta, UIDVALIDITY, MOVE y APPEND), sin Dovecot.


export type Stored = { uid: number; raw: Buffer };
type Folder = { uidValidity: number; nextUid: number; messages: Stored[] };

export const messageIdOf = (raw: Buffer) => /^Message-ID:\s*(\S+)\s*$/im.exec(raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('utf8'))?.[1] ?? null;

export class FakeServer {
  folders: Record<MailLocation, Folder> = {
    inbox: { uidValidity: 1795424849, nextUid: 1, messages: [] },
    quarantine: { uidValidity: 1795424850, nextUid: 1, messages: [] },
  };
  delayMs = 0;
  failOpen = false;
  failList = false;
  failAppend = false;
  opened = 0;
  appended = 0;
  /** MOVE que sí cambiaron algo en el servidor. */
  moved = 0;
  /** Después de tantos MOVE la conexión "se corta": toda orden siguiente falla (P-14). */
  cutAfterMoves: number | null = null;
  /** MOVE falla sin mover nada (el servidor dijo NO). */
  failMove = false;
  /** MOVE mueve el mensaje pero no devuelve el UID nuevo (sin evidencia). */
  moveWithoutEvidence = false;
  /** Se llama justo después de mover (para simular fallos de la base en ese momento). */
  onMove: ((messageId: string | null) => Promise<void>) | null = null;

  add(raw: Buffer, location: MailLocation = 'inbox'): number {
    const f = this.folders[location];
    const uid = f.nextUid++;
    f.messages.push({ uid, raw });
    return uid;
  }
  find(messageId: string): { location: MailLocation; stored: Stored } {
    for (const location of ['inbox', 'quarantine'] as const) {
      const stored = this.folders[location].messages.find((m) => messageIdOf(m.raw) === messageId);
      if (stored) return { location, stored };
    }
    throw new Error('no está');
  }
  /** Como UID MOVE: sale de su carpeta y entra a la otra con un UID nuevo. */
  move(messageId: string, to: MailLocation): number {
    const { location, stored } = this.find(messageId);
    this.folders[location].messages = this.folders[location].messages.filter((m) => m !== stored);
    return this.add(stored.raw, to);
  }
  remove(messageId: string): void {
    const { location, stored } = this.find(messageId);
    this.folders[location].messages = this.folders[location].messages.filter((m) => m !== stored);
  }
  /** Nuevo UIDVALIDITY: el servidor renumera todos los UID de la carpeta. */
  resetUidValidity(location: MailLocation, uidValidity: number): void {
    const f = this.folders[location];
    f.uidValidity = uidValidity;
    f.nextUid = 1000;
    f.messages = f.messages.map((m) => ({ uid: f.nextUid++, raw: m.raw }));
  }
  /** La conexión ya se cortó (cutAfterMoves alcanzado). */
  cut(): boolean {
    return this.cutAfterMoves !== null && this.moved >= this.cutAfterMoves;
  }
  /** Abre el proveedor como lo haría openProvider (falla si failOpen). */
  async open(): Promise<MailProvider> {
    if (this.failOpen) throw new MailUnavailableError();
    this.opened++;
    return this.provider();
  }
  provider(): MailProvider {
    const server = this;
    const wait = () => new Promise((r) => setTimeout(r, server.delayMs));
    return {
      async listFolder(location): Promise<FolderListing> {
        if (server.failList) throw new MailUnavailableError();
        const f = server.folders[location];
        return { uidValidity: f.uidValidity, messages: f.messages.map((m) => ({ uid: m.uid, messageId: messageIdOf(m.raw), size: m.raw.length })) };
      },
      async fetchRaw(location, uid, maxBytes) {
        await wait();
        const m = server.folders[location].messages.find((x) => x.uid === uid);
        return m && m.raw.length <= maxBytes ? Buffer.from(m.raw) : null;
      },
      async append(location, raw, _internalDate) {
        if (server.failAppend) throw new MailUnavailableError();
        server.appended++;
        const uid = server.add(Buffer.from(raw), location);
        return { uid, uidValidity: server.folders[location].uidValidity };
      },
      async inspect(location, uid) {
        if (server.cut()) throw new MailUnavailableError();
        await wait();
        const f = server.folders[location];
        const m = f.messages.find((x) => x.uid === uid);
        return { uidValidity: f.uidValidity, found: Boolean(m), messageId: m ? messageIdOf(m.raw) : null };
      },
      async move(from, to, uid) {
        if (server.cut()) throw new MoveUnconfirmedError();
        await wait();
        if (server.failMove) throw new MoveUnconfirmedError();
        const stored = server.folders[from].messages.find((x) => x.uid === uid);
        // Como Dovecot: UID MOVE de un UID que no existe responde OK sin COPYUID.
        if (!stored) throw new MoveUnconfirmedError();
        server.folders[from].messages = server.folders[from].messages.filter((m) => m !== stored);
        const newUid = server.add(stored.raw, to);
        server.moved++;
        if (server.onMove) await server.onMove(messageIdOf(stored.raw));
        if (server.moveWithoutEvidence) throw new MoveUnconfirmedError();
        return { uid: newUid, uidValidity: server.folders[to].uidValidity };
      },
      async close() {},
    };
  }
}
