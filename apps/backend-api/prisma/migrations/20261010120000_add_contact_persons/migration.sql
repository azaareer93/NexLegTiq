-- CreateTable
CREATE TABLE "contact_persons" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "position" TEXT,
    "email" CITEXT,
    "phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contact_persons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_persons_office_id_client_id_idx" ON "contact_persons"("office_id", "client_id");

-- CreateIndex
CREATE INDEX "clients_display_name_trgm_idx" ON "clients" USING GIN ("display_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "clients_full_name_trgm_idx" ON "clients" USING GIN ("full_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "clients_company_name_trgm_idx" ON "clients" USING GIN ("company_name" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "contact_persons" ADD CONSTRAINT "contact_persons_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_persons" ADD CONSTRAINT "contact_persons_client_id_office_id_fkey" FOREIGN KEY ("client_id", "office_id") REFERENCES "clients"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- A client has at most one primary contact; the service keeps exactly one while it has any (MVP-53, D-108).
CREATE UNIQUE INDEX "contact_persons_one_primary_per_client" ON "contact_persons" ("client_id") WHERE "is_primary";

-- Contact names are required text (the API trims them).
ALTER TABLE "contact_persons" ADD CONSTRAINT "contact_persons_full_name_check" CHECK (btrim("full_name") <> '');

