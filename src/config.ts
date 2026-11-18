import { z } from 'zod';

/** URL de PostgreSQL: debe ser válida y usar el esquema postgresql:// o postgres://. */
const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/ });

/** Variables de entorno que la API necesita hoy. Se agregan conforme llegan los módulos. */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Obligatoria: sin base de datos la API no arranca. Lleva la contraseña, así que nunca se imprime.
  DATABASE_URL: DatabaseUrl,
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Solo se nombran las variables, nunca sus valores (pueden ser secretos).
    const campos = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Variables de entorno inválidas: ${campos}`);
  }
  return parsed.data;
}
