-- M7: índice para GET /audit (filtro por acción y orden por fecha). Solo agrega un índice: no
-- cambia columnas ni datos de audit_events.
-- CreateIndex
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at");
