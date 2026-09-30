-- Extensions the schema relies on (D-032 citext, D-059 pg_trgm/unaccent, pgvector for Phase 2 embeddings).
-- Idempotent: the dev image installs them via docker/postgres/init, and in staging/production the admin creates them
-- first (docs/runbooks/db-roles.sql) because pgvector may need a superuser; managed databases without that step get
-- the trusted ones here.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "Jurisdiction" AS ENUM ('PALESTINE', 'JORDAN', 'EGYPT', 'SAUDI_ARABIA', 'UAE', 'KUWAIT', 'QATAR', 'OMAN', 'BAHRAIN', 'LEBANON', 'IRAQ', 'MOROCCO', 'USA', 'UK', 'OTHER');

-- CreateEnum
CREATE TYPE "OfficeLanguage" AS ENUM ('AR', 'EN', 'BILINGUAL');

-- CreateEnum
CREATE TYPE "UiLanguage" AS ENUM ('AR', 'EN');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER', 'PARALEGAL', 'ADMIN', 'TRAINEE', 'EXTERNAL_COLLABORATOR');

-- CreateEnum
CREATE TYPE "BillingMethod" AS ENUM ('HOURLY', 'FIXED_FEE', 'RETAINER', 'CONTINGENCY');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "LegalDocumentType" AS ENUM ('TOS', 'PRIVACY', 'DPA');

-- CreateEnum
CREATE TYPE "PlanMarket" AS ENUM ('PALESTINE', 'GLOBAL');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CARD', 'NONE');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'VIEW', 'DOWNLOAD', 'SHARE', 'LOGIN', 'LOGOUT', 'EXPORT', 'PERMISSION_DENIED', 'SECURITY');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateTable
CREATE TABLE "offices" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "registration_number" TEXT,
    "tax_id" TEXT,
    "phone" TEXT,
    "email" CITEXT,
    "address" TEXT,
    "website" TEXT,
    "jurisdiction" "Jurisdiction" NOT NULL DEFAULT 'PALESTINE',
    "default_language" "OfficeLanguage" NOT NULL DEFAULT 'AR',
    "currency" CHAR(3) NOT NULL DEFAULT 'ILS',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Hebron',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "office_settings" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "court_reminder_days" INTEGER[] DEFAULT ARRAY[7, 3, 1]::INTEGER[],
    "task_reminder_days" INTEGER[] DEFAULT ARRAY[1]::INTEGER[],
    "default_billing_rate" DECIMAL(14,2),
    "default_billing_method" "BillingMethod" NOT NULL DEFAULT 'HOURLY',
    "tax_rate_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "enable_ai" BOOLEAN NOT NULL DEFAULT true,
    "enable_ocr" BOOLEAN NOT NULL DEFAULT true,
    "file_number_format" TEXT NOT NULL DEFAULT '{YEAR}-{TYPE}-{SEQ:5}',
    "session_idle_minutes" INTEGER NOT NULL DEFAULT 30,
    "audit_retention_days" INTEGER NOT NULL DEFAULT 365,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "office_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "phone" TEXT,
    "avatar_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "ui_language" "UiLanguage" NOT NULL DEFAULT 'AR',
    "timezone" TEXT,
    "mfa_secret" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "mfa_secret" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "office_invitations" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "message" TEXT,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "office_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by_id" UUID,
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "ip_address" INET NOT NULL,
    "success" BOOLEAN NOT NULL,
    "attempted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_acceptances" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "document_type" "LegalDocumentType" NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" INET,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "market" "PlanMarket" NOT NULL,
    "price_monthly" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "max_users" INTEGER,
    "ai_quota_monthly" INTEGER,
    "storage_quota_mb" INTEGER NOT NULL,
    "trial_days" INTEGER,
    "features" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "current_period_start" TIMESTAMPTZ(3) NOT NULL,
    "current_period_end" TIMESTAMPTZ(3),
    "trial_ends_at" TIMESTAMPTZ(3),
    "payment_method" "PaymentMethod" NOT NULL DEFAULT 'NONE',
    "cancelled_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "user_id" UUID,
    "platform_admin_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "action" "AuditAction" NOT NULL,
    "old_values" JSONB,
    "new_values" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "request_id" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title_key" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "link" TEXT,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "office_settings_office_id_key" ON "office_settings"("office_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_office_id_role_idx" ON "users"("office_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_office_id_key" ON "users"("id", "office_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "office_invitations_token_hash_key" ON "office_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "office_invitations_office_id_status_idx" ON "office_invitations"("office_id", "status");

-- CreateIndex
CREATE INDEX "office_invitations_office_id_email_idx" ON "office_invitations"("office_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_office_id_user_id_idx" ON "refresh_tokens"("office_id", "user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_office_id_user_id_idx" ON "password_reset_tokens"("office_id", "user_id");

-- CreateIndex
CREATE INDEX "login_attempts_email_attempted_at_idx" ON "login_attempts"("email", "attempted_at");

-- CreateIndex
CREATE INDEX "login_attempts_ip_address_attempted_at_idx" ON "login_attempts"("ip_address", "attempted_at");

-- CreateIndex
CREATE INDEX "legal_acceptances_office_id_user_id_idx" ON "legal_acceptances"("office_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_acceptances_user_id_document_type_version_key" ON "legal_acceptances"("user_id", "document_type", "version");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "plans_market_is_active_idx" ON "plans"("market", "is_active");

-- CreateIndex
CREATE INDEX "subscriptions_office_id_status_idx" ON "subscriptions"("office_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_office_id_occurred_at_idx" ON "audit_logs"("office_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_office_id_entity_type_entity_id_idx" ON "audit_logs"("office_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notifications_office_id_user_id_created_at_idx" ON "notifications"("office_id", "user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "office_settings" ADD CONSTRAINT "office_settings_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "office_invitations" ADD CONSTRAINT "office_invitations_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "office_invitations" ADD CONSTRAINT "office_invitations_invited_by_id_office_id_fkey" FOREIGN KEY ("invited_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_platform_admin_id_fkey" FOREIGN KEY ("platform_admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Raw SQL Prisma cannot express ──────────────────────────────────────────────────────────────────────────────

-- D-060 / D-053: audit retention only upward; idle timeout 15–120 minutes.
ALTER TABLE "office_settings" ADD CONSTRAINT "office_settings_audit_retention_days_check" CHECK ("audit_retention_days" >= 365);
ALTER TABLE "office_settings" ADD CONSTRAINT "office_settings_session_idle_minutes_check" CHECK ("session_idle_minutes" BETWEEN 15 AND 120);

-- D-079: at most one live (TRIALING/ACTIVE) subscription per office, and one pending invitation per office + email.
CREATE UNIQUE INDEX "subscriptions_one_live_per_office" ON "subscriptions" ("office_id") WHERE "status" IN ('TRIALING', 'ACTIVE');
CREATE UNIQUE INDEX "office_invitations_one_pending_per_email" ON "office_invitations" ("office_id", "email") WHERE "status" = 'PENDING';

-- D-079: audit_logs is append-only for the app role. Grant-based (the migrator can still purge after retention), and
-- revoked here so it never depends on re-running docs/runbooks/db-roles.sql. No-op where the role does not exist
-- (local, CI).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs" FROM nexlegtiq_app;
  END IF;
END
$$;

-- D-059: Arabic normalisation for search. Strips tashkeel (U+064B–U+065F, U+0670) and tatweel (U+0640), folds
-- alef variants (U+0623 U+0625 U+0622 U+0671 → U+0627), alef maqsura U+0649 and ya-hamza U+0626 → ya U+064A,
-- waw-hamza U+0624 → waw U+0648, ta marbuta U+0629 → ha U+0647, and lower-cases Latin. IMMUTABLE so it can back
-- generated tsvector columns and expression indexes. Callers add unaccent() for Latin diacritics themselves
-- (unaccent is only STABLE).
CREATE FUNCTION nlq_normalize_ar(input text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT lower(translate(
      regexp_replace(input, U&'[\064B-\065F\0670\0640]', '', 'g'),
      U&'\0623\0625\0622\0671\0649\0626\0624\0629',
      U&'\0627\0627\0627\0627\064A\064A\0648\0647'
    ))
  $$;
