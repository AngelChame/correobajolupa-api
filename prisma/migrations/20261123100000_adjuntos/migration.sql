-- M2: adjuntos. Solo agrega: no modifica tablas ni datos existentes.

-- CreateEnum
CREATE TYPE "scan_status" AS ENUM ('not_detected', 'detected', 'unsupported', 'error');

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "file_name" VARCHAR(255),
    "declared_type" VARCHAR(255),
    "detected_type" VARCHAR(64),
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "scan_status" "scan_status" NOT NULL,
    "scan_detail" VARCHAR(200),
    "scanned_at" TIMESTAMPTZ(3),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachments_report_id_position_key" ON "attachments"("report_id", "position");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Agregado a mano (Prisma no modela CHECK).

-- El SHA-256 siempre son 64 caracteres hexadecimales en minúsculas, y el tamaño no es negativo.
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_size_bytes_check" CHECK ("size_bytes" >= 0);
