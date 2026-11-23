-- M5: borrar una cuenta que propuso indicadores ya no los borra en cascada (los confirmados
-- alimentan la búsqueda y, en M6, los incidentes). Hoy no hay ruta que borre cuentas: solo se
-- desactivan. Solo cambia la llave foránea.

-- DropForeignKey
ALTER TABLE "indicators" DROP CONSTRAINT "indicators_proposed_by_id_fkey";

-- AddForeignKey
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
