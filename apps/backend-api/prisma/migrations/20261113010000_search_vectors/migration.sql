-- MVP-80, D-165: Arabic-aware full-text search on files, clients, parties and tasks (D-059).
-- Same shape as document_texts and witness_statements: a `simple` vector over the Arabic-normalised, unaccented text and an
-- `english` vector for stemming, filled by triggers (unaccent is STABLE, so generated columns cannot call it).

ALTER TABLE "legal_files" ADD COLUMN "search_vector_simple" tsvector, ADD COLUMN "search_vector_english" tsvector;
ALTER TABLE "clients" ADD COLUMN "search_vector_simple" tsvector, ADD COLUMN "search_vector_english" tsvector;
ALTER TABLE "parties" ADD COLUMN "search_vector_simple" tsvector, ADD COLUMN "search_vector_english" tsvector;
ALTER TABLE "tasks" ADD COLUMN "search_vector_simple" tsvector, ADD COLUMN "search_vector_english" tsvector;

-- One helper so every table indexes text the same way; the description is capped like document text.
CREATE FUNCTION nlq_search_vectors(body text, OUT simple tsvector, OUT english tsvector)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  plain text := unaccent(left(coalesce(body, ''), 500000));
BEGIN
  simple := to_tsvector('simple'::regconfig, nlq_normalize_ar(plain));
  english := to_tsvector('english'::regconfig, plain);
END
$$;

CREATE FUNCTION nlq_legal_files_search() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE v record;
BEGIN
  v := nlq_search_vectors(concat_ws(' ', NEW.file_number, NEW.title, NEW.sub_type, NEW.court_case_number, NEW.description));
  NEW.search_vector_simple := v.simple;
  NEW.search_vector_english := v.english;
  RETURN NEW;
END
$$;
CREATE TRIGGER "legal_files_search" BEFORE INSERT OR UPDATE OF "file_number", "title", "sub_type", "court_case_number", "description",
  "search_vector_simple", "search_vector_english"
  ON "legal_files" FOR EACH ROW EXECUTE FUNCTION nlq_legal_files_search();

CREATE FUNCTION nlq_clients_search() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE v record;
BEGIN
  v := nlq_search_vectors(concat_ws(' ', NEW.display_name, NEW.full_name, NEW.company_name));
  NEW.search_vector_simple := v.simple;
  NEW.search_vector_english := v.english;
  RETURN NEW;
END
$$;
CREATE TRIGGER "clients_search" BEFORE INSERT OR UPDATE OF "display_name", "full_name", "company_name",
  "search_vector_simple", "search_vector_english"
  ON "clients" FOR EACH ROW EXECUTE FUNCTION nlq_clients_search();

CREATE FUNCTION nlq_parties_search() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE v record;
BEGIN
  v := nlq_search_vectors(concat_ws(' ', NEW.full_name, NEW.company_name));
  NEW.search_vector_simple := v.simple;
  NEW.search_vector_english := v.english;
  RETURN NEW;
END
$$;
CREATE TRIGGER "parties_search" BEFORE INSERT OR UPDATE OF "full_name", "company_name",
  "search_vector_simple", "search_vector_english"
  ON "parties" FOR EACH ROW EXECUTE FUNCTION nlq_parties_search();

CREATE FUNCTION nlq_tasks_search() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE v record;
BEGIN
  v := nlq_search_vectors(concat_ws(' ', NEW.title, NEW.description));
  NEW.search_vector_simple := v.simple;
  NEW.search_vector_english := v.english;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tasks_search" BEFORE INSERT OR UPDATE OF "title", "description",
  "search_vector_simple", "search_vector_english"
  ON "tasks" FOR EACH ROW EXECUTE FUNCTION nlq_tasks_search();

-- Backfill: naming a vector column in SET fires the trigger, which recomputes it from the row.
UPDATE "legal_files" SET "search_vector_simple" = NULL;
UPDATE "clients" SET "search_vector_simple" = NULL;
UPDATE "parties" SET "search_vector_simple" = NULL;
UPDATE "tasks" SET "search_vector_simple" = NULL;

CREATE INDEX "legal_files_search_simple_idx" ON "legal_files" USING GIN ("search_vector_simple");
CREATE INDEX "legal_files_search_english_idx" ON "legal_files" USING GIN ("search_vector_english");
CREATE INDEX "clients_search_simple_idx" ON "clients" USING GIN ("search_vector_simple");
CREATE INDEX "clients_search_english_idx" ON "clients" USING GIN ("search_vector_english");
CREATE INDEX "parties_search_simple_idx" ON "parties" USING GIN ("search_vector_simple");
CREATE INDEX "parties_search_english_idx" ON "parties" USING GIN ("search_vector_english");
CREATE INDEX "tasks_search_simple_idx" ON "tasks" USING GIN ("search_vector_simple");
CREATE INDEX "tasks_search_english_idx" ON "tasks" USING GIN ("search_vector_english");

-- Fuzzy fallback (typos, partial words) on the Arabic-normalised name or title; parties already have theirs (D-135).
CREATE INDEX "legal_files_title_norm_trgm_idx" ON "legal_files" USING GIN (nlq_normalize_ar("title") gin_trgm_ops);
CREATE INDEX "clients_display_name_norm_trgm_idx" ON "clients" USING GIN (nlq_normalize_ar("display_name") gin_trgm_ops);
CREATE INDEX "tasks_title_norm_trgm_idx" ON "tasks" USING GIN (nlq_normalize_ar("title") gin_trgm_ops);
