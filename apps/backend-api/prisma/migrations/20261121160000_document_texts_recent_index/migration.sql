-- MVP-172, D-240: document search walks an office's newest texts first (search-query.ts, RECENT_WINDOW), in index order.
-- The new index starts with office_id, so it also serves everything the old one did.
-- Plain CREATE INDEX (Prisma runs a migration in a transaction): writes to document_texts wait while it builds — seconds
-- at launch size (D-165, D-235). The new index first, so office lookups always have one.
CREATE INDEX "document_texts_office_id_id_idx" ON "document_texts"("office_id", "id");

DROP INDEX "document_texts_office_id_idx";
