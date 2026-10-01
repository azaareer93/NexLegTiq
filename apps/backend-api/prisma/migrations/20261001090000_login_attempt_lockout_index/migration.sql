-- Lockout reads failures for one email + IP pair, newest first (D-053, MVP-40).
-- DropIndex
DROP INDEX "login_attempts_email_attempted_at_idx";

-- CreateIndex
CREATE INDEX "login_attempts_email_ip_address_attempted_at_idx" ON "login_attempts"("email", "ip_address", "attempted_at");
