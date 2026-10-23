-- D-134: the name typed by the inviting manager, prefilled on the accept page.
ALTER TABLE "office_invitations" ADD COLUMN "full_name" TEXT;
