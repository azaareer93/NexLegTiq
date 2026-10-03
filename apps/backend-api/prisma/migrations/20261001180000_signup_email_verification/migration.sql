-- Office signup (MVP-39, D-083): account type, email verification state and verification tokens.

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('SOLO', 'FIRM', 'CORPORATE');

-- AlterTable
ALTER TABLE "offices" ADD COLUMN     "account_type" "AccountType" NOT NULL DEFAULT 'SOLO';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_office_id_user_id_idx" ON "email_verification_tokens"("office_id", "user_id");

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Accounts that exist before this migration were created by seeds or invitations (accepting an invitation proves the
-- address), so they count as verified rather than losing access after 7 days.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;

-- Token tables are hidden from the read-only support role (docs/runbooks/db-roles.sql).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_readonly') THEN
    REVOKE ALL ON "email_verification_tokens" FROM nexlegtiq_readonly;
  END IF;
END
$$;
