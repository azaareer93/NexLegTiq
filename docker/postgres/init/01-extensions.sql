-- Runs once when the pg-data volume is empty (docker-entrypoint-initdb.d), as the superuser.
-- Extensions the schema relies on: vector (pgvector, Phase 2 embeddings), pg_trgm (fuzzy names, D-059),
-- unaccent (FTS normalisation, D-059), citext (case-insensitive User.email, D-032).
-- Migrations (MVP-33) still run CREATE EXTENSION IF NOT EXISTS, so managed databases get them too.

-- template1 first: every database created later (nexlegtiq_test, Prisma's shadow database) inherits them.
\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;

\connect nexlegtiq
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;

-- Integration tests (backend-api-e2e) use their own database so they never touch dev data.
CREATE DATABASE nexlegtiq_test OWNER nexlegtiq;
