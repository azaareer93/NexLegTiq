-- MVP-172, D-240: document search walks an office's newest texts first (search-query.ts, RECENT_WINDOW), in index order.
-- The new index starts with office_id, so it also serves everything the old one did.
DROP INDEX "document_texts_office_id_idx";

CREATE INDEX "document_texts_office_id_id_idx" ON "document_texts"("office_id", "id");
