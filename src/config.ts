import { z } from 'zod';

/** URL de PostgreSQL: debe ser válida y usar el esquema postgresql:// o postgres://. */
const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/ });

/** En un .env, `VAR=` llega como texto vacío: se trata igual que si no estuviera. */
const opcional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((valor) => (valor === '' ? undefined : valor), schema.optional());

/** Entero positivo con valor por defecto; vacío en el .env también toma el valor por defecto. */
const entero = (porDefecto: number) =>
  z.preprocess((valor) => (valor === '' ? undefined : valor), z.coerce.number().int().min(1).default(porDefecto));

/** Variables de entorno que la API necesita hoy. Se agregan conforme llegan los módulos. */
const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Obligatoria: sin base de datos la API no arranca. Lleva la contraseña, así que nunca se imprime.
    DATABASE_URL: DatabaseUrl,

    // Bandera Secure de la cookie de sesión. Solo se apaga en desarrollo local por HTTP;
    // en producción tiene que ser true (se comprueba abajo).
    COOKIE_SECURE: z.stringbool().default(true),

    // Primer administrador (D-010): se crea al arrancar si no hay ningún admin. Van en pareja.
    FIRST_ADMIN_EMAIL: opcional(z.email()),
    FIRST_ADMIN_PASSWORD: opcional(z.string().min(12).max(128)),

    // Código de invitación (D-010). Vacío: registro abierto. Con valor: obligatorio al registrarse.
    INVITE_CODE: opcional(z.string().max(64)),

    // Límites de peticiones (por defecto, los acordados en M0). Ventanas fijas en minutos.
    RATE_LIMIT_REGISTER_PER_IP: entero(10),
    RATE_LIMIT_REGISTER_WINDOW_MIN: entero(60),
    RATE_LIMIT_LOGIN_PER_IP: entero(30),
    RATE_LIMIT_LOGIN_FAILS_PER_EMAIL: entero(5),
    RATE_LIMIT_LOGIN_WINDOW_MIN: entero(15),
    // Límite global por IP en /api/v1 (salvo /health). Holgado: sin proxy todos comparten IP (D-048).
    RATE_LIMIT_GLOBAL_PER_MINUTE: entero(300),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'en producción la cookie de sesión debe ser Secure (COOKIE_SECURE=true)',
      });
    }
    if (Boolean(env.FIRST_ADMIN_EMAIL) !== Boolean(env.FIRST_ADMIN_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIRST_ADMIN_EMAIL'],
        message: 'FIRST_ADMIN_EMAIL y FIRST_ADMIN_PASSWORD van juntas: define las dos o ninguna',
      });
    }
  });

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Solo se nombran las variables, nunca sus valores (pueden ser secretos). Las reglas
    // propias (code "custom") agregan su explicación, que tampoco incluye valores.
    const campos = parsed.error.issues
      .map((issue) => {
        const nombre = issue.path.join('.');
        return issue.code === 'custom' ? `${nombre} (${issue.message})` : nombre;
      })
      .join(', ');
    throw new Error(`Variables de entorno inválidas: ${campos}`);
  }
  return parsed.data;
}
