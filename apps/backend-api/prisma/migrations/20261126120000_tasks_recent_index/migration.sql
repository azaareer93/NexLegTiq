-- MVP-172, D-240: task search walks an office's newest tasks first (search-query.ts, RECENT_WINDOW), in index order.
CREATE INDEX "tasks_office_id_id_idx" ON "tasks"("office_id", "id");
