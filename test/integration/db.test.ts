import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { normalizeEmail } from '../../src/db/email.js';
import { testDatabaseUrl } from './test-db.js';

const db = createDb(testDatabaseUrl());
const UNA_HORA = 60 * 60 * 1000;

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE attachments, report_links, findings, reports, audit_events, sessions, users');
});

function crearUsuario(email = 'ana@ejemplo.invalid') {
  return db.user.create({ data: { email: normalizeEmail(email), displayName: 'Persona de prueba', passwordHash: 'hash-sintetico' } });
}

function crearSesion(userId: string, tokenHash: string) {
  return db.session.create({
    data: { userId, tokenHash, csrfToken: 'csrf-sintetico', expiresAt: new Date(Date.now() + UNA_HORA) },
  });
}

type Migracion = { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null };

describe('migración inicial', () => {
  it('se aplica completa en una base vacía', async () => {
    const migraciones = await db.$queryRaw<Migracion[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
    expect(migraciones.length).toBeGreaterThan(0);
    for (const m of migraciones) {
      expect(m.finished_at, m.migration_name).not.toBeNull();
      expect(m.rolled_back_at, m.migration_name).toBeNull();
    }

    const tablas = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tablas.map((t) => t.table_name)).toEqual([
      '_prisma_migrations',
      'attachments',
      'audit_events',
      'findings',
      'indexed_message_attachments',
      'indexed_message_links',
      'indexed_messages',
      'mailboxes',
      'report_links',
      'reports',
      'sessions',
      'users',
    ]);
  });

  it('crea un usuario con los valores por defecto', async () => {
    const usuario = await crearUsuario();
    expect(usuario.role).toBe('reporter');
    expect(usuario.active).toBe(true);
  });
});

describe('users.email', () => {
  it('es único sin importar mayúsculas', async () => {
    await crearUsuario('Ana@Ejemplo.invalid');
    await expect(crearUsuario('ANA@EJEMPLO.INVALID')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('la base rechaza un email con mayúsculas aunque se salten la normalización', async () => {
    await expect(
      db.$executeRaw`INSERT INTO users (id, email, display_name, password_hash, updated_at)
                     VALUES (gen_random_uuid(), 'Ana@Ejemplo.invalid', 'Ana', 'x', now())`,
    ).rejects.toThrow(/users_email_lowercase_check/);
  });
});

describe('borrado de un usuario', () => {
  it('borra sus sesiones y deja su auditoría con actorId nulo', async () => {
    const usuario = await crearUsuario();
    await crearSesion(usuario.id, 'hash-1');
    await crearSesion(usuario.id, 'hash-2');
    const evento = await db.auditEvent.create({
      data: { requestId: 'req-1', actorId: usuario.id, action: 'auth.login', result: 'success' },
    });

    await db.user.delete({ where: { id: usuario.id } });

    expect(await db.session.count({ where: { userId: usuario.id } })).toBe(0);
    const conservado = await db.auditEvent.findUniqueOrThrow({ where: { id: evento.id } });
    expect(conservado.actorId).toBeNull();
    expect(conservado.action).toBe('auth.login');
  });
});

describe('audit_events.requestId (D-047)', () => {
  it('es opcional para los eventos del sistema', async () => {
    const evento = await db.auditEvent.create({ data: { action: 'system.bootstrap_admin', result: 'success' } });
    expect(evento.requestId).toBeNull();
    expect(evento.actorId).toBeNull();
  });
});

describe('sessions.tokenHash', () => {
  it('es único', async () => {
    const ana = await crearUsuario('ana@ejemplo.invalid');
    const luis = await crearUsuario('luis@ejemplo.invalid');
    await crearSesion(ana.id, 'hash-repetido');
    await expect(crearSesion(luis.id, 'hash-repetido')).rejects.toMatchObject({ code: 'P2002' });
  });
});
