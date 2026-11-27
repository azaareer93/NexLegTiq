-- Legal file types and sub-types become platform reference data per country (MVP-175, D-261). Every file keeps its
-- classification: the old enum values are seeded as types of every jurisdiction and the columns change type in place.

-- CreateTable
CREATE TABLE "legal_file_types" (
    "id" UUID NOT NULL,
    "jurisdiction" "Jurisdiction" NOT NULL,
    "code" TEXT NOT NULL,
    "number_code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "legal_file_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legal_file_types_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    CONSTRAINT "legal_file_types_number_code_check" CHECK ("number_code" ~ '^[A-Z0-9]{1,6}$')
);

-- CreateTable
CREATE TABLE "legal_file_sub_types" (
    "id" UUID NOT NULL,
    "jurisdiction" "Jurisdiction" NOT NULL,
    "type_code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "legal_file_sub_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legal_file_types_jurisdiction_code_key" ON "legal_file_types"("jurisdiction", "code");

-- CreateIndex
CREATE UNIQUE INDEX "legal_file_sub_types_id_jurisdiction_type_code_key" ON "legal_file_sub_types"("id", "jurisdiction", "type_code");

-- CreateIndex
CREATE UNIQUE INDEX "legal_file_sub_types_jurisdiction_type_code_name_ar_key" ON "legal_file_sub_types"("jurisdiction", "type_code", "name_ar");

-- CreateIndex
CREATE UNIQUE INDEX "legal_file_sub_types_jurisdiction_type_code_name_en_key" ON "legal_file_sub_types"("jurisdiction", "type_code", "name_en");

-- AddForeignKey
ALTER TABLE "legal_file_sub_types" ADD CONSTRAINT "legal_file_sub_types_jurisdiction_type_code_fkey" FOREIGN KEY ("jurisdiction", "type_code") REFERENCES "legal_file_types"("jurisdiction", "code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Seed: the 12 former FileType values for every jurisdiction, with the `{TYPE}` codes of D-031/D-034 and the names the
-- apps showed (enums.fileType). Platform staff rename, reorder, deactivate or add types per country afterwards.
INSERT INTO "legal_file_types" ("id", "jurisdiction", "code", "number_code", "name_ar", "name_en", "sort_order", "updated_at")
SELECT nlq_uuid_v7(), j."value", t."code", t."number_code", t."name_ar", t."name_en", t."sort_order", CURRENT_TIMESTAMP
FROM unnest(enum_range(NULL::"Jurisdiction")) AS j("value")
CROSS JOIN (VALUES
    ('LITIGATION', 'LIT', 'تقاضٍ', 'Litigation', 10),
    ('CRIMINAL', 'CRM', 'قضية جزائية', 'Criminal', 20),
    ('CONTRACT_DRAFTING', 'CON', 'صياغة العقود', 'Contract drafting', 30),
    ('LEGAL_ADVISORY', 'ADV', 'استشارة قانونية', 'Legal advisory', 40),
    ('COMPLIANCE', 'CMP', 'امتثال', 'Compliance', 50),
    ('CONFLICT_RESOLUTION', 'CRS', 'تسوية النزاعات', 'Dispute resolution', 60),
    ('BUSINESS_SUPPORT', 'BUS', 'دعم الأعمال', 'Business support', 70),
    ('NDA_REVIEW', 'NDA', 'مراجعة اتفاقية عدم الإفصاح', 'NDA review', 80),
    ('WILL_TRUST', 'WIL', 'وصايا وأوقاف', 'Wills and endowments', 90),
    ('COMPANY_FORMATION', 'INC', 'تأسيس الشركات', 'Company formation', 100),
    ('RENTAL_AGREEMENT', 'RNT', 'عقد إيجار', 'Rental agreement', 110),
    ('EMPLOYMENT_CONTRACT', 'EMP', 'عقد عمل', 'Employment contract', 120)
) AS t("code", "number_code", "name_ar", "name_en", "sort_order");

-- Files: the enum becomes the type code (in place, values unchanged), checked against the file's jurisdiction. The old
-- free-text "sub_type" column stays as the read-only legacy value (Prisma `legacySubType`).
ALTER TABLE "legal_files" ALTER COLUMN "file_type" TYPE TEXT USING "file_type"::text;
ALTER TABLE "legal_files" ADD COLUMN "sub_type_id" UUID;

-- AddForeignKey
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_jurisdiction_file_type_fkey" FOREIGN KEY ("jurisdiction", "file_type") REFERENCES "legal_file_types"("jurisdiction", "code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey (MATCH SIMPLE: no sub-type, no check; a sub-type must belong to the file's own type)
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_sub_type_id_jurisdiction_file_type_fkey" FOREIGN KEY ("sub_type_id", "jurisdiction", "file_type") REFERENCES "legal_file_sub_types"("id", "jurisdiction", "type_code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Free-text sub-types that equal a sub-type name of the file's type (Arabic or English, case and outer spaces ignored)
-- point at it; the rest stay as legacy text. The migration seeds no sub-types, so on an existing database this matches
-- nothing yet; it is here so a database that already holds sub-types converts the same way.
UPDATE "legal_files" f
SET "sub_type_id" = s."id", "sub_type" = NULL
FROM "legal_file_sub_types" s
WHERE f."sub_type" IS NOT NULL
  AND s."jurisdiction" = f."jurisdiction"
  AND s."type_code" = f."file_type"
  AND lower(btrim(f."sub_type")) IN (lower(btrim(s."name_ar")), lower(btrim(s."name_en")));

-- Task templates name a type code of the office's jurisdiction (checked by the API; no jurisdiction column to key on).
ALTER TABLE "task_templates" ALTER COLUMN "file_type" TYPE TEXT USING "file_type"::text;

-- DropEnum
DROP TYPE "FileType";

-- Search (D-165): a file is also found by its sub-type's names; the legacy text stays indexed.
CREATE OR REPLACE FUNCTION nlq_legal_files_search() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE v record;
BEGIN
  v := nlq_search_vectors(concat_ws(' ', NEW.file_number, NEW.title, NEW.sub_type,
    (SELECT concat_ws(' ', s.name_ar, s.name_en) FROM legal_file_sub_types s WHERE s.id = NEW.sub_type_id),
    NEW.court_case_number, NEW.description));
  NEW.search_vector_simple := v.simple;
  NEW.search_vector_english := v.english;
  RETURN NEW;
END
$$;
DROP TRIGGER "legal_files_search" ON "legal_files";
CREATE TRIGGER "legal_files_search" BEFORE INSERT OR UPDATE OF "file_number", "title", "sub_type", "sub_type_id", "court_case_number",
  "description", "search_vector_simple", "search_vector_english"
  ON "legal_files" FOR EACH ROW EXECUTE FUNCTION nlq_legal_files_search();
