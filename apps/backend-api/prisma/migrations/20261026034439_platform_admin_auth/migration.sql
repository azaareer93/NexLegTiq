-- D-145: platform admin realm — TOTP enrolment on PlatformAdmin, sessions, recovery codes and the platform audit log.
-- AlterTable
ALTER TABLE "platform_admins" ADD COLUMN     "mfa_enrolled_at" TIMESTAMPTZ(3),
ADD COLUMN     "mfa_last_step" INTEGER,
ALTER COLUMN "mfa_secret" DROP NOT NULL;

-- CreateTable
CREATE TABLE "platform_sessions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "idle_until" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_recovery_codes" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "admin_id" UUID,
    "action" TEXT NOT NULL,
    "target_office_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "old_values" JSONB,
    "new_values" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_sessions_token_hash_key" ON "platform_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "platform_sessions_family_id_idx" ON "platform_sessions"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_recovery_codes_code_hash_key" ON "platform_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "platform_recovery_codes_admin_id_idx" ON "platform_recovery_codes"("admin_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_admin_id_created_at_idx" ON "platform_audit_logs"("admin_id", "created_at");

-- AddForeignKey
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_recovery_codes" ADD CONSTRAINT "platform_recovery_codes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- An enrolled admin has a secret; a step is only remembered once a code was accepted.
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_mfa_check"
  CHECK ("mfa_enrolled_at" IS NULL OR "mfa_secret" IS NOT NULL);
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_window_check"
  CHECK ("idle_until" <= "expires_at" AND "started_at" < "expires_at");

-- The platform audit log is append-only for the app (as audit_logs, D-079); sessions and recovery codes hold token hashes,
-- which the read-only support role never reads (db-roles.sql re-applies both).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "platform_audit_logs" FROM nexlegtiq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_readonly') THEN
    REVOKE ALL ON "platform_sessions", "platform_recovery_codes" FROM nexlegtiq_readonly;
  END IF;
END
$$;
