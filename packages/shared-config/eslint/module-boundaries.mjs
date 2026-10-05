/**
 * Nx module-boundary constraints — the single source for docs/context/architecture.md#monorepo-nx--pnpm-node-22.
 *
 *   type:app      → libs only (apps never import apps)
 *   shared-types  ← shared-utils ← shared-contracts ← shared-api-client
 *   shared-ui     → types, utils, i18n
 *   scope:backend → types, utils, contracts (never ui / api-client / i18n)
 *   type:e2e      → libs only
 *   Server-only npm packages are banned in frontend code and the shared UI/i18n packages, browser/UI packages in backend code.
 *
 * Tags live in each project's project.json. Verified by src/module-boundaries.spec.ts.
 */
// Server code and credentials-bearing clients never reach a public SPA bundle (apps and the shared UI/i18n/API-client packages).
const SERVER_PACKAGES = ['@nestjs/*', '@prisma/*', 'prisma', 'bullmq', 'ioredis', 'pg', '@aws-sdk/*', 'nodemailer'];

export const depConstraints = [
  { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:lib'] },
  { sourceTag: 'type:lib', onlyDependOnLibsWithTags: ['type:lib'] },
  { sourceTag: 'type:e2e', onlyDependOnLibsWithTags: ['type:lib'] },

  { sourceTag: 'layer:types', onlyDependOnLibsWithTags: [] },
  { sourceTag: 'layer:utils', onlyDependOnLibsWithTags: ['layer:types'] },
  { sourceTag: 'layer:contracts', onlyDependOnLibsWithTags: ['layer:types', 'layer:utils'] },
  {
    sourceTag: 'layer:api-client',
    onlyDependOnLibsWithTags: ['layer:types', 'layer:utils', 'layer:contracts'],
    bannedExternalImports: SERVER_PACKAGES,
  },
  { sourceTag: 'layer:i18n', onlyDependOnLibsWithTags: ['layer:types'], bannedExternalImports: SERVER_PACKAGES },
  {
    sourceTag: 'layer:ui',
    onlyDependOnLibsWithTags: ['layer:types', 'layer:utils', 'layer:i18n'],
    bannedExternalImports: SERVER_PACKAGES,
  },
  { sourceTag: 'layer:config', onlyDependOnLibsWithTags: [] },

  {
    sourceTag: 'scope:backend',
    onlyDependOnLibsWithTags: ['layer:types', 'layer:utils', 'layer:contracts'],
    bannedExternalImports: ['react', 'react-dom', 'react-router', 'antd', '@ant-design/*'],
  },
  {
    sourceTag: 'scope:frontend',
    onlyDependOnLibsWithTags: [
      'layer:types',
      'layer:utils',
      'layer:contracts',
      'layer:api-client',
      'layer:i18n',
      'layer:ui',
    ],
    bannedExternalImports: SERVER_PACKAGES,
  },
];
