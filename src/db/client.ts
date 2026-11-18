import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type Db = PrismaClient;

/**
 * Crea un cliente de Prisma 7 con el adaptador de `pg` (Prisma 7 ya no trae motor propio).
 * Prisma 7 usa los valores por defecto de `pg`, que no tienen tiempo límite de conexión:
 * se fija uno para que una base caída falle rápido en vez de colgar la petición.
 */
export function createDb(databaseUrl: string): Db {
  const adapter = new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  return new PrismaClient({ adapter });
}

let db: Db | undefined;

/** Un solo cliente (y un solo pool de conexiones) para toda la app. */
export function connectDb(databaseUrl: string): Db {
  db ??= createDb(databaseUrl);
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('La base de datos no está inicializada: llama a connectDb() al arrancar.');
  return db;
}

/** Cierra el pool. Se llama al apagar la API (SIGTERM) y al terminar las pruebas. */
export async function disconnectDb(): Promise<void> {
  if (!db) return;
  const actual = db;
  db = undefined;
  await actual.$disconnect();
}
