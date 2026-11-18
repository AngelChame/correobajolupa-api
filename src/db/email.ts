/**
 * Forma única del email antes de guardarlo o buscarlo: sin espacios alrededor y en minúsculas.
 * La base lo exige con el CHECK users_email_lowercase_check (migración inicial), así que
 * `Ana@Ejemplo.invalid` y `ana@ejemplo.invalid` son la misma cuenta.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
