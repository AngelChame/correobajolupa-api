# CorreoBajoLupa — API

Backend, trabajador de análisis, infraestructura (Docker Compose, servidor IMAP de laboratorio) y contrato OpenAPI de **CorreoBajoLupa**: una plataforma web con API REST que analiza correos sospechosos con reglas explicables, relaciona mensajes de una misma campaña y entrega un informe con guía de mitigación. En un laboratorio IMAP controlado permite buscar mensajes relacionados y ponerlos en cuarentena de forma autorizada y reversible.

> **Estado:** en desarrollo (M0: cimientos). Ya hay contrato OpenAPI v0 y un servidor mínimo con `/api/v1/health`. Proyecto académico de Seguridad Informática (Universidad Politécnica de Chiapas).

## Datos y seguridad

- El proyecto trabaja con correos de phishing. En este repositorio solo hay datos **sintéticos o anonimizados**; nunca se suben correos reales, contraseñas, llaves ni archivos `.env`.
- Los enlaces de los correos nunca se visitan; en informes se muestran desactivados.

## Requisitos

- Node.js 24 (LTS) y npm. La versión está en `.nvmrc`.
- Docker y Docker Compose.

## Cómo levantarlo

```bash
cp .env.example .env          # cambia las contraseñas de ejemplo
docker compose up -d --build  # PostgreSQL y la API
curl http://127.0.0.1:3000/api/v1/health   # {"status":"ok"}
```

Sin Docker, para desarrollar: `npm ci`, `npm run dev`, `npm test`.

## Repositorio relacionado

El front vive en un repositorio aparte (`correobajolupa-web`, nombre por confirmar). El despliegue construye ambos juntos con Docker Compose.

## Licencia

Sin licencia: todos los derechos reservados.
