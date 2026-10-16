-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('PLEADING', 'EVIDENCE', 'CONTRACT_DRAFT', 'FINAL_CONTRACT', 'WILL', 'NDA', 'COURT_ORDER', 'JUDGMENT', 'CLIENT_INSTRUCTION', 'INVOICE', 'LEGAL_NOTICE', 'DEMAND_LETTER', 'POWER_OF_ATTORNEY', 'CORRESPONDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'SCANNING', 'PROCESSING', 'READY', 'FAILED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('NOT_NEEDED', 'PENDING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "DocumentLanguage" AS ENUM ('AR', 'EN', 'MIXED');

-- CreateEnum
CREATE TYPE "FolderSystemKey" AS ENUM ('PLEADINGS', 'EVIDENCE', 'COURT_ORDERS', 'CONTRACTS', 'CORRESPONDENCE', 'CLIENT_UPLOADS');

-- CreateTable
CREATE TABLE "document_folders" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT,
    "system_key" "FolderSystemKey",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "folder_id" UUID,
    "session_id" UUID,
    "name" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "document_type" "DocumentType" NOT NULL DEFAULT 'OTHER',
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "ocr_status" "OcrStatus" NOT NULL DEFAULT 'PENDING',
    "language" "DocumentLanguage",
    "is_confidential" BOOLEAN NOT NULL DEFAULT false,
    "shared_with_client" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by_id" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "change_note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_texts" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "search_vector_simple" tsvector,
    "search_vector_english" tsvector,
    "page_count" INTEGER,
    "ocr_engine" TEXT,
    "ocr_confidence" DECIMAL(5,2),
    "extracted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_texts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_folders_office_id_file_id_idx" ON "document_folders"("office_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_folders_id_file_id_office_id_key" ON "document_folders"("id", "file_id", "office_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_folders_file_id_system_key_key" ON "document_folders"("file_id", "system_key");

-- CreateIndex
CREATE UNIQUE INDEX "documents_storage_key_key" ON "documents"("storage_key");

-- CreateIndex
CREATE INDEX "documents_office_id_file_id_folder_id_idx" ON "documents"("office_id", "file_id", "folder_id");

-- CreateIndex
CREATE INDEX "documents_session_id_idx" ON "documents"("session_id");

-- CreateIndex
CREATE INDEX "documents_folder_id_idx" ON "documents"("folder_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_id_office_id_key" ON "documents"("id", "office_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_storage_key_key" ON "document_versions"("storage_key");

-- CreateIndex
CREATE INDEX "document_versions_office_id_size_bytes_idx" ON "document_versions"("office_id", "size_bytes");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_number_key" ON "document_versions"("document_id", "version_number");

-- CreateIndex
CREATE INDEX "document_texts_office_id_idx" ON "document_texts"("office_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_texts_document_id_version_number_key" ON "document_texts"("document_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_id_file_id_office_id_key" ON "sessions"("id", "file_id", "office_id");

-- AddForeignKey
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_parent_id_file_id_office_id_fkey" FOREIGN KEY ("parent_id", "file_id", "office_id") REFERENCES "document_folders"("id", "file_id", "office_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_file_id_office_id_fkey" FOREIGN KEY ("folder_id", "file_id", "office_id") REFERENCES "document_folders"("id", "file_id", "office_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_session_id_file_id_office_id_fkey" FOREIGN KEY ("session_id", "file_id", "office_id") REFERENCES "sessions"("id", "file_id", "office_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_id_office_id_fkey" FOREIGN KEY ("uploaded_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_office_id_fkey" FOREIGN KEY ("document_id", "office_id") REFERENCES "documents"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_id_office_id_fkey" FOREIGN KEY ("created_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_document_id_office_id_fkey" FOREIGN KEY ("document_id", "office_id") REFERENCES "documents"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_document_id_version_number_fkey" FOREIGN KEY ("document_id", "version_number") REFERENCES "document_versions"("document_id", "version_number") ON DELETE CASCADE ON UPDATE RESTRICT;


-- ─── Raw SQL Prisma cannot express ──────────────────────────────────────────────────────────────────────────────

-- Folders (D-119): a system folder has a key and no name and sits at the root; any other folder has a non-blank name of
-- at most 100 characters. A folder is never its own parent (deeper cycles and the depth limit are checked by the API
-- under a lock on the file's folders).
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_name_or_system_check" CHECK (
  ("system_key" IS NULL) <> ("name" IS NULL)
);
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_system_at_root_check" CHECK ("system_key" IS NULL OR "parent_id" IS NULL);
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_name_check" CHECK (
  "name" IS NULL OR (length(btrim("name")) > 0 AND length("name") <= 100)
);
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_not_own_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
-- Sibling folders have different names, compared case-insensitively and Arabic-normalised (أدلة = ادلة). A root folder's
-- parent is the file itself for this purpose.
CREATE UNIQUE INDEX "document_folders_sibling_name_key" ON "document_folders" (
  "file_id", COALESCE("parent_id", "file_id"), nlq_normalize_ar(btrim("name"))
) WHERE "name" IS NOT NULL;

-- Documents and versions: storage keys always start with the row's office (D-035, D-085), checksums are lower-case hex.
ALTER TABLE "documents" ADD CONSTRAINT "documents_size_check" CHECK ("size_bytes" >= 0);
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_check" CHECK ("current_version" >= 1);
ALTER TABLE "documents" ADD CONSTRAINT "documents_checksum_check" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "documents" ADD CONSTRAINT "documents_storage_key_office_check" CHECK (
  starts_with("storage_key", "office_id"::text || '/')
);
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_number_check" CHECK ("version_number" >= 1);
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_size_check" CHECK ("size_bytes" >= 0);
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_checksum_check" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_storage_key_office_check" CHECK (
  starts_with("storage_key", "office_id"::text || '/')
);
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_page_count_check" CHECK ("page_count" IS NULL OR "page_count" >= 0);
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_ocr_confidence_check" CHECK (
  "ocr_confidence" IS NULL OR "ocr_confidence" BETWEEN 0 AND 100
);

-- Full-text search over extracted text (D-059): `simple` over Arabic-normalised, unaccented text, and `english` with
-- stemming. A trigger, not generated columns, because unaccent() is only STABLE. Only the first 500,000 characters are
-- indexed: a tsvector is capped at 1 MB (D-119).
CREATE FUNCTION nlq_document_texts_search() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  body text := unaccent(left(NEW.text, 500000));
BEGIN
  NEW.search_vector_simple := to_tsvector('simple'::regconfig, nlq_normalize_ar(body));
  NEW.search_vector_english := to_tsvector('english'::regconfig, body);
  RETURN NEW;
END
$$;
CREATE TRIGGER "document_texts_search" BEFORE INSERT OR UPDATE OF "text", "search_vector_simple", "search_vector_english"
  ON "document_texts" FOR EACH ROW EXECUTE FUNCTION nlq_document_texts_search();
CREATE INDEX "document_texts_search_simple_idx" ON "document_texts" USING gin ("search_vector_simple");
CREATE INDEX "document_texts_search_english_idx" ON "document_texts" USING gin ("search_vector_english");

-- Versions are append-only for the app (DELETE stays so a purged document takes them with it); extracted text is document
-- content, which the read-only support role never reads. Repeated in docs/runbooks/db-roles.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    REVOKE UPDATE, TRUNCATE ON "document_versions" FROM nexlegtiq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_readonly') THEN
    REVOKE ALL ON "document_texts" FROM nexlegtiq_readonly;
  END IF;
END
$$;

-- UUID v7 (D-015) for rows the database creates itself: PostgreSQL 17 has no uuidv7(). A random v4 whose first 48 bits
-- become the Unix time in milliseconds and whose version nibble becomes 7.
CREATE FUNCTION nlq_uuid_v7() RETURNS uuid LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
        PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
        FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- Every file gets the default folders (one root folder per FolderSystemKey) in the transaction that opens it, whatever
-- creates it (API, import, seed) (D-119); files opened before this migration get them below.
CREATE FUNCTION nlq_legal_files_default_folders() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO document_folders (id, office_id, file_id, system_key, updated_at)
  SELECT nlq_uuid_v7(), NEW.office_id, NEW.id, key, CURRENT_TIMESTAMP
  FROM unnest(enum_range(NULL::"FolderSystemKey")) AS key;
  RETURN NULL;
END
$$;
CREATE TRIGGER "legal_files_default_folders" AFTER INSERT ON "legal_files"
  FOR EACH ROW EXECUTE FUNCTION nlq_legal_files_default_folders();

INSERT INTO "document_folders" ("id", "office_id", "file_id", "system_key", "updated_at")
SELECT nlq_uuid_v7(), f."office_id", f."id", k.key, CURRENT_TIMESTAMP
FROM "legal_files" f
CROSS JOIN unnest(enum_range(NULL::"FolderSystemKey")) AS k(key);
