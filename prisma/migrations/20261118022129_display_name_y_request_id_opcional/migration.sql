-- D-047: los eventos sin petición HTTP (prefijo "system.") no tienen requestId.
ALTER TABLE "audit_events" ALTER COLUMN "request_id" DROP NOT NULL;

-- Nombre para mostrar (contrato v0: displayName). Se agrega en tres pasos para que la
-- migración no falle si ya hay cuentas: columna nula, relleno con la parte local del
-- correo y después NOT NULL.
ALTER TABLE "users" ADD COLUMN "display_name" VARCHAR(80);
UPDATE "users" SET "display_name" = left(split_part("email", '@', 1), 80) WHERE "display_name" IS NULL;
ALTER TABLE "users" ALTER COLUMN "display_name" SET NOT NULL;
