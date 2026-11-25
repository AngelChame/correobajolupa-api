-- Resultado por reporte: únicamente estados y URLs desactivadas.
ALTER TABLE "reports" ADD COLUMN "reputation" JSONB;
