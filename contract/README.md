# Contrato de la API

`openapi.json` es el contrato de la API (OpenAPI 3.1). **No se edita a mano**: se genera desde los
esquemas Zod de `src/contract/` con

```
npm run contract:generate
```

y `npm test` falla si el archivo commiteado no coincide con lo generado.

## Para quien consume la API (front)

- Las rutas son relativas a `/api/v1` (campo `servers`): el front y la API comparten origen.
- Autenticación por cookie `cbl_session` (HttpOnly): enviar siempre con credenciales.
- Las peticiones que modifican datos llevan la cabecera `X-CSRF-Token`; el valor viene en
  `GET /auth/me` y en las respuestas de registro y entrada.
- Tipos de TypeScript: `npx openapi-typescript contract/openapi.json -o src/api/schema.d.ts`.
- Todo texto de correo es contenido hostil: se escapa siempre. El HTML del correo solo se
  muestra con `GET /reports/{reportId}/html` dentro de un `<iframe sandbox>` sin permisos.
- Los cambios del contrato suben `info.version`; los que rompen algo se avisan.
