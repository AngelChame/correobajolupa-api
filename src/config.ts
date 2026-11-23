import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** URL de PostgreSQL: debe ser válida y usar el esquema postgresql:// o postgres://. */
const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/ });

/** En un .env, `VAR=` llega como texto vacío: se trata igual que si no estuviera. */
const opcional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((valor) => (valor === '' ? undefined : valor), schema.optional());

/** Entero positivo con valor por defecto; vacío en el .env también toma el valor por defecto. */
const entero = (porDefecto: number) =>
  z.preprocess((valor) => (valor === '' ? undefined : valor), z.coerce.number().int().min(1).default(porDefecto));

/** Entero dentro de [min, max] con valor por defecto; vacío en el .env toma el valor por defecto. */
const enteroEntre = (min: number, max: number, porDefecto: number) =>
  z.preprocess(
    (valor) => (valor === '' ? undefined : valor),
    z.coerce.number().int().min(min).max(max).default(porDefecto),
  );

/** Nombre de dominio en minúsculas, con al menos un punto y TLD alfabético (no una IP). */
const DOMINIO = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z][a-z0-9-]{0,62}$/;

/** Lista separada por comas; espacios y mayúsculas se ignoran y los vacíos se descartan. */
const listaDeDominios = z.preprocess(
  (valor) =>
    typeof valor === 'string'
      ? valor
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean)
      : valor,
  z.array(z.string().regex(DOMINIO)).default([]),
);

const MiB = 1024 * 1024;

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

    // Saltos de proxy de confianza para req.ip. 0 (por defecto) = sin proxy, 'trust proxy' apagado.
    // Solo un número: "true" se rechaza, porque confiaría en cualquier X-Forwarded-For (IP falsificable).
    TRUST_PROXY_HOPS: enteroEntre(0, 5, 0),

    // --- M1: reportes. Se leen y validan desde ya; los usan los pasos siguientes. ---
    // Carpeta del volumen de archivos de reportes (D-038). Ruta absoluta.
    STORAGE_DIR: z.preprocess(
      (valor) => (valor === '' ? undefined : valor),
      z.string().refine((ruta) => isAbsolute(ruta), 'debe ser una ruta absoluta').default('/data/reports'),
    ),
    // Tamaños máximos de entrada, en bytes (10 MiB por .eml y 1 MiB por texto pegado).
    MAX_EML_BYTES: enteroEntre(1, 50 * MiB, 10 * MiB),
    MAX_PASTE_BYTES: enteroEntre(1, 10 * MiB, 1 * MiB),
    // Reportes que una cuenta puede crear por hora (evita llenar la cola y el disco).
    REPORTS_PER_USER_PER_HOUR: entero(30),
    // Dominios institucionales para la regla 3, separados por comas.
    INSTITUTIONAL_DOMAINS: listaDeDominios,
    // Cola en PostgreSQL (D-054): cada cuánto busca trabajo el worker, cuánto dura su arriendo
    // de una fila y cuántos intentos se hacen antes de dejar el reporte como failed.
    WORKER_POLL_MS: enteroEntre(100, 60_000, 1000),
    JOB_LEASE_SECONDS: enteroEntre(5, 3600, 120),
    JOB_MAX_ATTEMPTS: enteroEntre(1, 10, 3),
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
