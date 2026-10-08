-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('INDIVIDUAL', 'CORPORATION', 'GOVERNMENT', 'NGO', 'PARTNERSHIP');

-- CreateEnum
CREATE TYPE "FileType" AS ENUM ('LITIGATION', 'CRIMINAL', 'CONTRACT_DRAFTING', 'LEGAL_ADVISORY', 'COMPLIANCE', 'CONFLICT_RESOLUTION', 'BUSINESS_SUPPORT', 'NDA_REVIEW', 'WILL_TRUST', 'COMPANY_FORMATION', 'RENTAL_AGREEMENT', 'EMPLOYMENT_CONTRACT');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('OPEN', 'SUSPENDED', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "FileTeamRole" AS ENUM ('RESPONSIBLE_LAWYER', 'PARALEGAL', 'MEMBER');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('PLAINTIFF', 'DEFENDANT', 'APPELLANT', 'RESPONDENT', 'THIRD_PARTY', 'GUARANTOR', 'SIGNATORY', 'INTERESTED_PARTY', 'PROSECUTION');

-- CreateEnum
CREATE TYPE "TimelineEventType" AS ENUM ('FILE_OPENED', 'FILE_CLOSED', 'FILE_REOPENED', 'FILE_REASSIGNED', 'SESSION_CREATED', 'SESSION_UPDATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_SHARED', 'TASK_COMPLETED', 'PARTY_ADDED', 'WITNESS_STATEMENT_ADDED', 'SUMMARY_GENERATED', 'INVOICE_SENT', 'INVOICE_PAID');

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "client_type" "ClientType" NOT NULL,
    "display_name" TEXT NOT NULL,
    "full_name" TEXT,
    "company_name" TEXT,
    "national_id" TEXT,
    "tax_id" TEXT,
    "phone" TEXT,
    "email" CITEXT,
    "address" TEXT,
    "industry" TEXT,
    "primary_lawyer_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_files" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "file_type" "FileType" NOT NULL,
    "sub_type" TEXT,
    "status" "FileStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "opening_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "closing_date" DATE,
    "responsible_lawyer_id" UUID NOT NULL,
    "responsible_paralegal_id" UUID,
    "court_case_number" TEXT,
    "jurisdiction" "Jurisdiction" NOT NULL,
    "billing_method" "BillingMethod" NOT NULL DEFAULT 'HOURLY',
    "hourly_rate" DECIMAL(14,2),
    "fixed_fee" DECIMAL(14,2),
    "retainer_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "is_confidential" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "legal_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_clients" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_team_members" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "FileTeamRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "file_team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_number_sequences" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "type_code" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "file_number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parties" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "is_individual" BOOLEAN NOT NULL,
    "full_name" TEXT,
    "company_name" TEXT,
    "national_id" TEXT,
    "tax_id" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" CITEXT,
    "legal_representative" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_parties" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "party_type" "PartyType" NOT NULL,
    "role_label" TEXT,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "file_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflicts_of_interest" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id_a" UUID NOT NULL,
    "file_id_b" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolution_notes" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conflicts_of_interest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_timeline_events" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "event_type" "TimelineEventType" NOT NULL,
    "source_type" TEXT,
    "source_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "case_timeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_notes" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID,
    "client_id" UUID,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "is_confidential" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "file_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_templates" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "file_type" "FileType",
    "default_title" TEXT NOT NULL,
    "default_description" TEXT,
    "due_days_after_open" INTEGER,
    "default_assignee_role" "FileTeamRole",
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clients_office_id_display_name_idx" ON "clients"("office_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "clients_id_office_id_key" ON "clients"("id", "office_id");

-- CreateIndex
CREATE INDEX "legal_files_office_id_responsible_lawyer_id_idx" ON "legal_files"("office_id", "responsible_lawyer_id");

-- CreateIndex
CREATE INDEX "legal_files_office_id_responsible_paralegal_id_idx" ON "legal_files"("office_id", "responsible_paralegal_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_files_office_id_file_number_key" ON "legal_files"("office_id", "file_number");

-- CreateIndex
CREATE UNIQUE INDEX "legal_files_id_office_id_key" ON "legal_files"("id", "office_id");

-- CreateIndex
CREATE INDEX "file_clients_office_id_client_id_idx" ON "file_clients"("office_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_clients_file_id_client_id_key" ON "file_clients"("file_id", "client_id");

-- CreateIndex
CREATE INDEX "file_team_members_office_id_user_id_idx" ON "file_team_members"("office_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_team_members_file_id_user_id_key" ON "file_team_members"("file_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_number_sequences_office_id_year_type_code_key" ON "file_number_sequences"("office_id", "year", "type_code");

-- CreateIndex
CREATE INDEX "parties_office_id_full_name_idx" ON "parties"("office_id", "full_name");

-- CreateIndex
CREATE INDEX "parties_office_id_company_name_idx" ON "parties"("office_id", "company_name");

-- CreateIndex
CREATE UNIQUE INDEX "parties_id_office_id_key" ON "parties"("id", "office_id");

-- CreateIndex
CREATE INDEX "file_parties_office_id_party_id_idx" ON "file_parties"("office_id", "party_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_parties_file_id_party_id_party_type_key" ON "file_parties"("file_id", "party_id", "party_type");

-- CreateIndex
CREATE INDEX "conflicts_of_interest_office_id_resolved_idx" ON "conflicts_of_interest"("office_id", "resolved");

-- CreateIndex
CREATE INDEX "conflicts_of_interest_office_id_file_id_a_idx" ON "conflicts_of_interest"("office_id", "file_id_a");

-- CreateIndex
CREATE INDEX "conflicts_of_interest_office_id_file_id_b_idx" ON "conflicts_of_interest"("office_id", "file_id_b");

-- CreateIndex
CREATE INDEX "case_timeline_events_office_id_file_id_occurred_at_idx" ON "case_timeline_events"("office_id", "file_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "file_notes_office_id_file_id_created_at_idx" ON "file_notes"("office_id", "file_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "file_notes_office_id_client_id_created_at_idx" ON "file_notes"("office_id", "client_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "task_templates_office_id_file_type_idx" ON "task_templates"("office_id", "file_type");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_primary_lawyer_id_office_id_fkey" FOREIGN KEY ("primary_lawyer_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_responsible_lawyer_id_office_id_fkey" FOREIGN KEY ("responsible_lawyer_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_responsible_paralegal_id_office_id_fkey" FOREIGN KEY ("responsible_paralegal_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_clients" ADD CONSTRAINT "file_clients_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_clients" ADD CONSTRAINT "file_clients_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_clients" ADD CONSTRAINT "file_clients_client_id_office_id_fkey" FOREIGN KEY ("client_id", "office_id") REFERENCES "clients"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_team_members" ADD CONSTRAINT "file_team_members_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_team_members" ADD CONSTRAINT "file_team_members_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_team_members" ADD CONSTRAINT "file_team_members_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_number_sequences" ADD CONSTRAINT "file_number_sequences_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_parties" ADD CONSTRAINT "file_parties_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_parties" ADD CONSTRAINT "file_parties_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_parties" ADD CONSTRAINT "file_parties_party_id_office_id_fkey" FOREIGN KEY ("party_id", "office_id") REFERENCES "parties"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts_of_interest" ADD CONSTRAINT "conflicts_of_interest_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts_of_interest" ADD CONSTRAINT "conflicts_of_interest_file_id_a_office_id_fkey" FOREIGN KEY ("file_id_a", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts_of_interest" ADD CONSTRAINT "conflicts_of_interest_file_id_b_office_id_fkey" FOREIGN KEY ("file_id_b", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts_of_interest" ADD CONSTRAINT "conflicts_of_interest_party_id_office_id_fkey" FOREIGN KEY ("party_id", "office_id") REFERENCES "parties"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts_of_interest" ADD CONSTRAINT "conflicts_of_interest_resolved_by_id_office_id_fkey" FOREIGN KEY ("resolved_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_timeline_events" ADD CONSTRAINT "case_timeline_events_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_timeline_events" ADD CONSTRAINT "case_timeline_events_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_timeline_events" ADD CONSTRAINT "case_timeline_events_actor_id_office_id_fkey" FOREIGN KEY ("actor_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_notes" ADD CONSTRAINT "file_notes_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_notes" ADD CONSTRAINT "file_notes_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_notes" ADD CONSTRAINT "file_notes_client_id_office_id_fkey" FOREIGN KEY ("client_id", "office_id") REFERENCES "clients"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_notes" ADD CONSTRAINT "file_notes_author_id_office_id_fkey" FOREIGN KEY ("author_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Raw SQL Prisma cannot express ──────────────────────────────────────────────────────────────────────────────

-- Row rules the services also check; the database is the last line.
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_closing_after_opening_check" CHECK ("closing_date" IS NULL OR "closing_date" >= "opening_date");
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_amounts_not_negative_check" CHECK (COALESCE("hourly_rate", 0) >= 0 AND COALESCE("fixed_fee", 0) >= 0);
ALTER TABLE "file_number_sequences" ADD CONSTRAINT "file_number_sequences_last_value_check" CHECK ("last_value" >= 0);
ALTER TABLE "parties" ADD CONSTRAINT "parties_name_check" CHECK (CASE WHEN "is_individual" THEN "full_name" IS NOT NULL ELSE "company_name" IS NOT NULL END);
ALTER TABLE "conflicts_of_interest" ADD CONSTRAINT "conflicts_of_interest_two_files_check" CHECK ("file_id_a" <> "file_id_b");
ALTER TABLE "file_notes" ADD CONSTRAINT "file_notes_subject_check" CHECK ("file_id" IS NOT NULL OR "client_id" IS NOT NULL);

-- One primary client per file (D-033).
CREATE UNIQUE INDEX "file_clients_one_primary_per_file" ON "file_clients" ("file_id") WHERE "is_primary";

-- Case list (MVP-57): newest activity first, without visiting the table for the list columns.
CREATE INDEX "legal_files_list_idx" ON "legal_files" ("office_id", "updated_at" DESC)
  INCLUDE ("file_number", "title", "file_type", "status", "priority", "responsible_lawyer_id")
  WHERE "deleted_at" IS NULL;
-- "My open files" (dashboard, assigned scope): open, not deleted, per responsible lawyer.
CREATE INDEX "legal_files_open_by_lawyer_idx" ON "legal_files" ("office_id", "responsible_lawyer_id", "opening_date" DESC)
  WHERE "status" = 'OPEN' AND "deleted_at" IS NULL;
