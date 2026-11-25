# Decisiones — Parte 5 (análisis de URL)

## D-069 — Análisis de URL por capas, sin visitar enlaces

- Estado: aprobada por Ángel el 25 nov 2026.
- Propuesta: 24 nov 2026.
- Contexto: el profesor observó que el analizador evaluaba los enlaces «muy por arriba»: una URL maliciosa aparecía solo como enlace, sin señales ni veredicto. Se pide un motor de reglas más potente, sin convertir el proyecto en un escáner que abra sitios.

### Decisión

1. Analizar cada URL **sin visitarla nunca**. El análisis es estático: se evalúa la forma del enlace y se comparan hashes contra listas e informes existentes.
2. Ejecutar tres capas en este orden, cada una válida por sí sola:
   1. **Heurísticas locales (R9)**: señales de la forma de la URL, con evidencia por señal. Funcionan sin internet, claves ni cuotas; cubren enlaces nuevos aún no reportados.
   2. **Feeds descargados (R10)**: comparación por hash contra OpenPhish y URLhaus. El worker descarga las listas desde direcciones fijas; el análisis solo lee la tabla.
   3. **VirusTotal**: capa opcional, solo informes ya existentes, sin enviar URLs nuevas a escaneo. Se activa únicamente con `VIRUSTOTAL_API_KEY` en el `.env` del servidor.
3. Ampliar el contrato a **0.4.0** con `RuleId` = R9 y R10, y mantener R8 reservado para indicadores confirmados por un analista.
4. Usar tres niveles de veredicto, siempre con fuente y fecha como evidencia:
   - **Reportada como maliciosa**: coincide con un feed, o al menos 3 motores de VirusTotal la marcan. Redacción obligatoria: «marcada por X de Y motores», nunca «es maliciosa» por decisión propia del sistema.
   - **Sospechosa**: señales heurísticas, coincidencia solo por dominio o 1–2 motores.
   - **Sin señales**: ninguna capa marca el enlace; se aclara que **no significa seguro**.
5. Registrar una fuente caída, vacía o sin datos como **«no disponible»**, nunca como «sin señales». El reporte termina `completed` y añade la nota correspondiente. Las capas locales siguen funcionando si VirusTotal falla o se agota su cuota.
6. Representar el veredicto y el estado de la fuente **por enlace**, aunque el contrato anterior solo contemplara hallazgos y prioridad a nivel de reporte. La evidencia guarda fuente, fecha y tipo de coincidencia.
7. Reutilizar la normalización de M5: URL sin query ni fragmento. No escribir otra. Solo una coincidencia exacta comprobada eleva la prioridad a alta; compartir dominio o coincidir después de quitar parámetros queda como señal media.
8. Seguridad y privacidad:
   - Sin SSRF: las direcciones de los feeds salen solo de configuración, nunca del correo.
   - Evidencia desactivada (`hxxp`, `[.]`) y sin URLs crudas en respuestas ni registros (D-017, P-18).
   - A VirusTotal solo se envía la URL normalizada; nunca asunto, cuerpo, direcciones ni nombres de adjuntos. Se añade el aviso de privacidad en el modo real.
   - Claves solo en el `.env` del servidor; `.env.example` con campos vacíos.
   - Muestras sintéticas (`.example`, `203.0.113.x`); ninguna URL maliciosa real en fixtures ni pruebas. Los valores que parezcan secretos usan el prefijo `MARCADOR_`.
9. Uso permitido: API pública de VirusTotal y feeds comunitarios bajo uso académico **no comercial**. OpenPhish restringe redistribución; URLhaus exige Auth-Key gratuita y uso razonable. Queda registrado en el README.
10. Fuera de alcance: análisis dinámico del sitio o ejecución en sandbox. Es una limitación que se presenta al profesor: un enlace recién creado, sin rasgos raros, no será detectado por una fuente que no lo ejecute.

### Verificación acordada

- Los 26 fixtures de M1 y los 21 mensajes del laboratorio conservan su resultado; `L06` y los mensajes legítimos no disparan R9.
- Feeds y VirusTotal se prueban en CI con respuestas simuladas, sin llamadas reales.
- Con fuente fallida, vacía, 429 o timeout, el reporte sigue `completed`.
- La caché de 24 horas evita consultar dos veces la misma URL.
- Contrato, tipos del front, gitleaks y auditoría de producción en verde.

### Aprobación

Aprobado por: Ángel — 25 nov 2026.
