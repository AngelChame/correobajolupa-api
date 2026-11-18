/**
 * URL de la base de pruebas. Las pruebas de integración BORRAN todo lo que hay en ella,
 * así que solo se aceptan bases cuyo nombre termine en `_test` (protege la base real).
 */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Define DATABASE_URL con una base de pruebas (ver README, "Pruebas de integración").');
  }
  const nombre = new URL(url).pathname.slice(1);
  if (!nombre.endsWith('_test')) {
    throw new Error('DATABASE_URL debe apuntar a una base cuyo nombre termine en "_test": estas pruebas la vacían.');
  }
  return url;
}
