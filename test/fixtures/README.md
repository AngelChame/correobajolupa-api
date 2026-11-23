# Correos de prueba (M1 y M4)

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

## Laboratorio IMAP (`lab/`, M4)

21 mensajes **sintéticos** para los tres buzones del laboratorio (D-015), con su verdad en `lab/manifest.json`.
Se cargan en Dovecot con `npm run lab:seed` (ver `docker/imap/README.md`). Son la referencia de la búsqueda
retrospectiva (M5) y de las métricas (M8, D-023). Los casos de `emails/` no se tocan ni se copian aquí.

- Solo dominios `.example`, IP de `203.0.113.0/24`, nombres inventados y fechas fijas del 17 al 22 de noviembre
  de 2026 (`-0600`). `Message-ID` único `@lab.example`. CRLF, UTF-8, menos de 20 KiB cada uno.
- Dominio institucional: `universidad-ejemplo.example` (el mismo de `expected.json`).
- Nombre de archivo: `<id>-<descripcion>.eml`. En `lab/` solo van los `.eml` y `manifest.json` (la prueba lo exige).
- `test/lab-fixtures.test.ts` comprueba que cada mensaje dispara exactamente sus `expectedRules`, que el
  manifiesto cuadra con los archivos y que cada indicador coincide justo con sus candidatos y falsos candidatos.

### Campañas (11 mensajes de phishing)

| Campaña | Mensajes (buzón) | Rasgos | Reglas |
| --- | --- | --- | --- |
| A vence-correo | A1 (student), A2 (teacher), A3 (staff) | `soporte@universidad-ejernplo.example` (rn por m), Reply-To `buzon-respuestas.example`, enlace al dominio parecido con texto visible del institucional; la query cambia por mensaje | R1, R2, R3 |
| B factura | B1 (teacher), B2 (staff) | `facturacion@proveedor-pagos.example`, adjunto `factura-0042.pdf.exe` con los mismos bytes (empieza por `MZ`, no es ejecutable) | R7 |
| B (variante B3) | B3 (student) | mismo remitente, sin adjunto; enlace a `nube-compartida.example/descarga/987` | ninguna |
| C beca | C1 (student), C2 (staff) | enlace a `http://203.0.113.7/beca/solicitud` con texto `becas.universidad-ejemplo.example/solicitud` | R2, R5 |
| D nómina | D1 (teacher), D2 (staff), D3 (student) | `rh@nomina-avisos.example`, enlace a `xn--nmina-avisos-4fk.example` (`nomina-avisos` escrito con una "o" cirílica, U+043E) | R4 |

### Legítimos (10 mensajes, sin reglas)

| Grupo | Mensajes | Para qué |
| --- | --- | --- |
| aviso-institucional | LA1, LA2, LA3 | Remitente y enlace del dominio institucional: la lista de exclusión debe impedir falsos candidatos |
| boletin-cursos | LB1, LB2 | Boletín externo legítimo (`cursos-ejemplo.example`) |
| documento-compartido | LC1, LC2 | Colegas del dominio institucional que comparten archivos en `nube-compartida.example` (señuelo) |
| personal | LD1, LD2, LD3 | Texto plano sin enlaces ni adjuntos |

### Trampas de falsos candidatos (D-019: compartir un dominio no confirma una campaña)

1. **`nube-compartida.example`:** lo usa B3 (phishing) y también LC1 y LC2 (legítimos). Si el analista lo confirma,
   la búsqueda debe mostrar a LC1 y LC2 como candidatos con su razón, y el analista no debe aprobarlos.
2. **`universidad-ejemplo.example`:** aparece en el texto visible de A y C, pero no es indicador de ninguna campaña.
   Debe estar en la lista de exclusión; si alguien lo confirma, LA1 a LA3 y LC1 y LC2 no deben salir como candidatos.

### `manifest.json`

- `messages[]`: `id`, `file`, `mailbox`, `messageId`, `truth` (`phishing` o `legit`), `campaign` (`A`, `B`, `C`, `D`
  o `null`; B3 es de la campaña `B`), `expectedRules`, `decoyFor` (solo B3, LC1 y LC2: el dominio que comparten) y `note`.
- `indicators[]`: lo que un analista confirmaría por campaña (`domain`, `url` normalizada sin query, `sha256` o
  `sender`; el `value` sin desactivar), con `candidates` (mensajes de la campaña que deben salir) y
  `falseCandidates` (legítimos que saldrían). Las dos trampas son las únicas con falsos candidatos.
- `matching`: cómo coincide cada tipo. Un `domain` coincide con el dominio del remitente, del Reply-To o del host de
  un enlace, **nunca con el texto visible**. Si M5 decide otra cosa, se actualiza el manifiesto y su prueba.
