import { defineConfig } from 'prisma/config';

// Prisma CLI config. Run through the Nx targets (`pnpm nx run backend-api:prisma-migrate` …), which load the root .env.
// DATABASE_URL may be unset for `prisma generate`; migrate/seed fail with Prisma's own error when it is missing.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
