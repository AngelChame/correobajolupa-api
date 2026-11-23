import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDecoyHash, hashPassword } from '../../src/auth/password.js';
import { Session } from '../../src/contract/schemas/auth.js';
import { createDb } from '../../src/db/client.js';
import type { Role } from '../../src/generated/prisma/enums.js';
import { createLogger } from '../../src/logger.js';
import { createDiskStorage } from '../../src/storage/disk.js';
import type { MailProvider } from '../../src/mail/provider.js';
import type { ReportStorage } from '../../src/storage/storage.js';
import { testConfig } from '../helpers.js';
import { testDatabaseUrl } from './test-db.js';

/** Utilidades compartidas por las pruebas de integración de rutas. */

export const db = createDb(testDatabaseUrl());
export const decoyHash = await createDecoyHash();
export const CLAVE = 'una-clave-de-prueba-larga';
const claveHash = await hashPassword(CLAVE);

export async function limpiarBase(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE quarantine_actions, incident_comments, incident_indicators, incident_reports, incidents, indicators, exclusions, attachments, report_links, findings, reports, audit_events, sessions, users');
  // Laboratorio (M4): los buzones los crea la migración; solo se vacían sus mensajes y su estado.
  await db.$executeRawUnsafe('TRUNCATE indexed_message_attachments, indexed_message_links, indexed_messages');
  await db.$executeRawUnsafe(`UPDATE mailboxes SET last_sync_at = NULL, last_sync_status = 'never', sync_started_at = NULL`);
}

/** Carpeta temporal de este proceso de pruebas; se borra completa al salir. */
const RAIZ_ALMACENAMIENTO = mkdtempSync(join(tmpdir(), 'cbl-reports-'));
process.on('exit', () => rmSync(RAIZ_ALMACENAMIENTO, { recursive: true, force: true }));

/** App de prueba con base real y almacenamiento en una subcarpeta temporal propia (storageDir). */
export function crearApp(overrides: NodeJS.ProcessEnv = {}, opciones: { storage?: ReportStorage; openMailProvider?: (address: string) => Promise<MailProvider> } = {}) {
  const lineas: string[] = [];
  const logger = createLogger('info', { write: (linea: string) => void lineas.push(linea) });
  const storageDir = mkdtempSync(join(RAIZ_ALMACENAMIENTO, 'app-'));
  const config = testConfig({ DATABASE_URL: testDatabaseUrl(), STORAGE_DIR: storageDir, ...overrides });
  const storage = opciones.storage ?? createDiskStorage(storageDir);
  const lab = opciones.openMailProvider ? { openMailProvider: opciones.openMailProvider } : {};
  return { app: createApp({ logger, db, config, decoyHash, storage, ...lab }), lineas, logger, config, storageDir, storage };
}

/** Archivos que hay en la carpeta del almacenamiento, como rutas relativas "reportId/nombre". */
export function archivosEn(storageDir: string): string[] {
  return readdirSync(storageDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(storageDir.length + 1).replaceAll(sep, '/'));
}

export type Sesion = { userId: string; cookie: string; csrf: string; token: string };

/** Crea una cuenta con el rol dado directamente en la base e inicia sesión por la API. */
export async function entrarComo(app: Parameters<typeof request>[0], role: Role, email: string): Promise<Sesion> {
  const user = await db.user.create({ data: { email, displayName: `Persona ${role}`, passwordHash: claveHash, role } });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: CLAVE });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const sesion = Session.parse(res.body);
  const token = tokenDe(res)!;
  return { userId: user.id, cookie: `cbl_session=${token}`, csrf: sesion.csrfToken, token };
}

/** Token de la cookie cbl_session de una respuesta (o undefined). */
export function tokenDe(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('cbl_session=') && !c.startsWith('cbl_session=;'));
  return cookie?.split(';')[0]?.slice('cbl_session='.length);
}
