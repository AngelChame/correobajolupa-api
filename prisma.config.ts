import { defineConfig } from 'prisma/config';

// Configuración de la CLI de Prisma 7 (migrate, generate, validate).
// DATABASE_URL llega del entorno (Compose, CI o la terminal); aquí no se carga ningún .env.
// `prisma generate` y `prisma validate` no la necesitan; `migrate` sí.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
