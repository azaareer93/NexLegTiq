-- D-135: keyed HMACs of national and tax ids, so parties and clients can be matched and searched by an exact identifier
-- while the ids themselves stay encrypted (D-056). Filled by the application; rows written before this migration get
-- them when the identifier is next saved.
ALTER TABLE "parties" ADD COLUMN "national_id_index" TEXT, ADD COLUMN "tax_id_index" TEXT;
ALTER TABLE "clients" ADD COLUMN "national_id_index" TEXT, ADD COLUMN "tax_id_index" TEXT;

CREATE INDEX "parties_office_id_national_id_index_idx" ON "parties"("office_id", "national_id_index");
CREATE INDEX "parties_office_id_tax_id_index_idx" ON "parties"("office_id", "tax_id_index");
CREATE INDEX "clients_office_id_national_id_index_idx" ON "clients"("office_id", "national_id_index");
CREATE INDEX "clients_office_id_tax_id_index_idx" ON "clients"("office_id", "tax_id_index");

-- Party search by name, Arabic-normalised (hamza/alef/ya/ta-marbuta forms, tashkeel; D-059), substring via trigrams.
CREATE INDEX "parties_name_normalized_trgm_idx" ON "parties"
  USING GIN (nlq_normalize_ar(coalesce("full_name", "company_name")) gin_trgm_ops);
