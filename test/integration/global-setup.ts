import { execSync } from 'node:child_process';
import pg from 'pg';
import { testDatabaseUrl } from './test-db.js';

/** Deja la base de pruebas vacía y aplica todas las migraciones, como en un despliegue nuevo. */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
