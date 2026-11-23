# Correos de prueba (M1)

26 casos con su resultado esperado en `expected.json`: 23 archivos `.eml` en `emails/` y 3 textos pegados en `paste/`.
Sirven para probar el lector de correos, las reglas 1 a 7 y el sanitizador del visor.

- **Sintéticos, salvo uno.** Los dominios usan TLD reservados (`.example`, `.invalid`) y las IP son del rango de
  documentación `203.0.113.0/24`. Los adjuntos son texto inventado, no archivos reales.
  **Excepción:** `L06` es un boletín legítimo real, anonimizado (destinatario, ID de suscriptor y parámetros de
  rastreo); conserva los dominios del remitente para servir como falso positivo de referencia.
- **Dominio institucional configurado en las pruebas:** `universidad-ejemplo.example` (lo usa la regla 3).
- **Prefijos:** `L` legítimo, `R` una regla, `C` combinado, `H` hostil (entradas que no deben romper nada),
  `T` texto pegado (`POST /reports/paste`, campo `text`).
- **`.eml` sin normalizar:** usan CRLF y `.gitattributes` los marca como `binary`; no se editan con herramientas que
  cambien los finales de línea.

## `expected.json`

Cada caso tiene `id`, `input` (`eml` o `paste`), `file`, `kind`, `expectedRules` (`R1`…`R7`), `status`
(`completed` o `limited`), `limitedReason` (`missing_headers`, `parse_error` o `null`), `tests` (casos P del
documento de requerimientos) y, si aplica, `evidence`, `decodedText`, `notes`, `forbiddenInSanitizedHtml` y
`mustKeepInSanitizedHtml`. Reglas y estados usan los mismos valores que el contrato (`RuleId`, `ReportStatus`,
`LimitedReason`).

- `evidence`: textos que deben aparecer en la evidencia de los hallazgos (solo casos con reglas).
- `decodedText`: textos que deben aparecer en el asunto o el cuerpo ya decodificados (charset,
  quoted-printable, partes que sí se pudieron leer). Prueba al lector, no a las reglas.

Las evidencias van en forma cruda. La API las devuelve desactivadas (`hxxp://dominio[.]com`, D-017), así que la
prueba compara contra el valor antes de desactivar o desactiva el esperado.

Es una referencia, no la verdad: si el analizador discrepa, se decide cuál tiene razón y se anota.

## Decisiones que estos casos dejan abiertas (por confirmar)

1. Regla 1: comparar **dominios** (no el buzón completo). `L02` depende de eso.
2. Qué enlaces del HTML cuentan: solo `<a href>`, o también `iframe`, `form`, `img`, etc. (`H01`).
3. Correo sin remitente ni cuerpo (`H03`): aceptar como análisis limitado o rechazar con 400.
4. Profundidad máxima de multipart (`H04`, 40 niveles).
5. Pesos y umbrales de prioridad (`C1` sirve para probarlos).
6. Regla 6 como lista de esquemas **permitidos** (`http`, `https`, `mailto`) en lugar de una lista de prohibidos
   (`R6b` incluye `vbscript:`).
7. Extraer URL del texto plano además del HTML (`T03`, y las URL de la parte de texto de `L01`).
