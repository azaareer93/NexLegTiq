-- D-080 review: a rotated refresh token may only point at a token of the same office (composite FK, like the
-- (user_id, office_id) FKs of D-079). NO ACTION so a family can be deleted in one statement.

-- DropForeignKey
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_replaced_by_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_id_office_id_key" ON "refresh_tokens"("id", "office_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_office_id_key" ON "refresh_tokens"("replaced_by_id", "office_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_office_id_fkey" FOREIGN KEY ("replaced_by_id", "office_id") REFERENCES "refresh_tokens"("id", "office_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

