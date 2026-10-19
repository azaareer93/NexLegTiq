-- DropIndex
DROP INDEX "documents_folder_id_idx";

-- Review of add_documents (D-119): the (office_id, file_id, folder_id) index already serves the folder foreign-key checks,
-- and nlq_uuid_v7() resolves its functions through a pinned search_path like the other nlq_ functions.
ALTER FUNCTION nlq_uuid_v7() SET search_path = pg_catalog, public;
