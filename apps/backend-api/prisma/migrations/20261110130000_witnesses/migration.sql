-- Witnesses and their statements (MVP-143, D-163). Internal to the office: never on the client portal.

CREATE TABLE "witnesses" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "is_expert" BOOLEAN NOT NULL DEFAULT false,
    "expertise_area" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "witnesses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "witnesses_name_check" CHECK (length(btrim("full_name")) > 0)
);

CREATE TABLE "witness_statements" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "witness_id" UUID NOT NULL,
    "statement_date" DATE NOT NULL,
    "text" TEXT NOT NULL,
    "session_id" UUID,
    "recorded_by_id" UUID NOT NULL,
    "is_under_oath" BOOLEAN NOT NULL DEFAULT false,
    "search_vector_simple" tsvector,
    "search_vector_english" tsvector,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "witness_statements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "witness_statements_text_check" CHECK (length(btrim("text")) > 0)
);

CREATE UNIQUE INDEX "witnesses_id_office_id_key" ON "witnesses"("id", "office_id");
CREATE UNIQUE INDEX "witnesses_id_file_id_office_id_key" ON "witnesses"("id", "file_id", "office_id");
CREATE INDEX "witnesses_office_id_file_id_full_name_idx" ON "witnesses"("office_id", "file_id", "full_name");
CREATE INDEX "witness_statements_office_id_witness_id_statement_date_idx" ON "witness_statements"("office_id", "witness_id", "statement_date" DESC);
CREATE INDEX "witness_statements_session_id_idx" ON "witness_statements"("session_id");
CREATE INDEX "witness_statements_search_simple_idx" ON "witness_statements" USING gin ("search_vector_simple");
CREATE INDEX "witness_statements_search_english_idx" ON "witness_statements" USING gin ("search_vector_english");

ALTER TABLE "witnesses" ADD CONSTRAINT "witnesses_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "witnesses" ADD CONSTRAINT "witnesses_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "witness_statements" ADD CONSTRAINT "witness_statements_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "witness_statements" ADD CONSTRAINT "witness_statements_witness_id_file_id_office_id_fkey" FOREIGN KEY ("witness_id", "file_id", "office_id") REFERENCES "witnesses"("id", "file_id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "witness_statements" ADD CONSTRAINT "witness_statements_session_id_file_id_office_id_fkey" FOREIGN KEY ("session_id", "file_id", "office_id") REFERENCES "sessions"("id", "file_id", "office_id") ON DELETE NO ACTION ON UPDATE RESTRICT;
ALTER TABLE "witness_statements" ADD CONSTRAINT "witness_statements_recorded_by_id_office_id_fkey" FOREIGN KEY ("recorded_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Full-text search over testimony (D-059), like document_texts (D-119): a trigger, because unaccent() is only STABLE.
CREATE FUNCTION nlq_witness_statements_search() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  body text := unaccent(left(NEW.text, 500000));
BEGIN
  NEW.search_vector_simple := to_tsvector('simple'::regconfig, nlq_normalize_ar(body));
  NEW.search_vector_english := to_tsvector('english'::regconfig, body);
  RETURN NEW;
END
$$;
CREATE TRIGGER "witness_statements_search" BEFORE INSERT OR UPDATE OF "text", "search_vector_simple", "search_vector_english"
  ON "witness_statements" FOR EACH ROW EXECUTE FUNCTION nlq_witness_statements_search();

-- Testimony is case content: the read-only support role never reads it (as document_texts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_readonly') THEN
    REVOKE ALL ON "witness_statements" FROM nexlegtiq_readonly;
  END IF;
END
$$;
