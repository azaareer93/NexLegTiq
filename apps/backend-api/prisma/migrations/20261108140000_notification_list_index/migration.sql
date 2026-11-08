-- The list pages by id (UUID v7 = creation order, D-149): the per-user index follows it.
DROP INDEX "notifications_office_id_user_id_created_at_idx";
CREATE INDEX "notifications_office_id_user_id_id_idx" ON "notifications"("office_id", "user_id", "id" DESC);
