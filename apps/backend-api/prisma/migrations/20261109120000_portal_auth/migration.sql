-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "client_user_id" UUID;

-- CreateTable
CREATE TABLE "client_users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "email_verified_at" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portal_accesses" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "contact_person_id" UUID,
    "granted_by_id" UUID NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_portal_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_invitations" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "contact_person_id" UUID,
    "email" CITEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_sessions" (
    "id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_password_reset_tokens" (
    "id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_users_email_key" ON "client_users"("email");

-- CreateIndex
CREATE INDEX "client_portal_accesses_office_id_client_id_idx" ON "client_portal_accesses"("office_id", "client_id");

-- CreateIndex
CREATE INDEX "client_portal_accesses_client_user_id_idx" ON "client_portal_accesses"("client_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_invitations_token_hash_key" ON "client_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "client_invitations_office_id_client_id_status_idx" ON "client_invitations"("office_id", "client_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "client_sessions_token_hash_key" ON "client_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "client_sessions_family_id_idx" ON "client_sessions"("family_id");

-- CreateIndex
CREATE INDEX "client_sessions_client_user_id_idx" ON "client_sessions"("client_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_password_reset_tokens_token_hash_key" ON "client_password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "client_password_reset_tokens_client_user_id_created_at_idx" ON "client_password_reset_tokens"("client_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "contact_persons_id_office_id_key" ON "contact_persons"("id", "office_id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_portal_accesses" ADD CONSTRAINT "client_portal_accesses_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_accesses" ADD CONSTRAINT "client_portal_accesses_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_portal_accesses" ADD CONSTRAINT "client_portal_accesses_client_id_office_id_fkey" FOREIGN KEY ("client_id", "office_id") REFERENCES "clients"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_portal_accesses" ADD CONSTRAINT "client_portal_accesses_contact_person_id_office_id_fkey" FOREIGN KEY ("contact_person_id", "office_id") REFERENCES "contact_persons"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_portal_accesses" ADD CONSTRAINT "client_portal_accesses_granted_by_id_office_id_fkey" FOREIGN KEY ("granted_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_client_id_office_id_fkey" FOREIGN KEY ("client_id", "office_id") REFERENCES "clients"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_contact_person_id_office_id_fkey" FOREIGN KEY ("contact_person_id", "office_id") REFERENCES "contact_persons"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_invited_by_id_office_id_fkey" FOREIGN KEY ("invited_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_password_reset_tokens" ADD CONSTRAINT "client_password_reset_tokens_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One live grant per office and portal account; one PENDING invitation per office and address (D-157).
CREATE UNIQUE INDEX "client_portal_accesses_live_key" ON "client_portal_accesses"("office_id", "client_user_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "client_invitations_pending_key" ON "client_invitations"("office_id", "email") WHERE "status" = 'PENDING';

ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_window_check" CHECK ("started_at" < "expires_at");

-- Credentials and token hashes are off-limits to the read-only support role (db-roles.sql re-applies this).
DO $$
DECLARE
  readable text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_readonly') THEN
    REVOKE ALL ON "client_sessions", "client_password_reset_tokens", "client_invitations" FROM nexlegtiq_readonly;
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO readable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'client_users' AND column_name <> 'password_hash';
    REVOKE ALL ON "client_users" FROM nexlegtiq_readonly;
    EXECUTE format('GRANT SELECT (%s) ON "client_users" TO nexlegtiq_readonly', readable);
  END IF;
END
$$;
