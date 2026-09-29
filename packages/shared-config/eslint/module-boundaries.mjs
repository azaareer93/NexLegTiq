/**
 * Nx module-boundary constraints — the single source for docs/context/architecture.md#monorepo-nx--pnpm-node-22.
 *
 *   type:app      → libs only (apps never import apps)
 *   shared-types  ← shared-utils ← shared-contracts ← shared-api-client
 *   shared-ui     → types, utils, i18n
 *   scope:backend → types, utils, contracts (never ui / api-client / i18n)
 *
 * Tags live in each project's project.json. Verified by src/module-boundaries.spec.ts.
 */
export const depConstraints = [
  { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:lib'] },
  { sourceTag: 'type:lib', onlyDependOnLibsWithTags: ['type:lib'] },

  { sourceTag: 'layer:types', onlyDependOnLibsWithTags: [] },
  { sourceTag: 'layer:utils', onlyDependOnLibsWithTags: ['layer:types'] },
  { sourceTag: 'layer:contracts', onlyDependOnLibsWithTags: ['layer:types', 'layer:utils'] },
  {
    sourceTag: 'layer:api-client',
    onlyDependOnLibsWithTags: ['layer:types', 'layer:utils', 'layer:contracts'],
  },
  { sourceTag: 'layer:i18n', onlyDependOnLibsWithTags: ['layer:types'] },
  { sourceTag: 'layer:ui', onlyDependOnLibsWithTags: ['layer:types', 'layer:utils', 'layer:i18n'] },
  { sourceTag: 'layer:config', onlyDependOnLibsWithTags: [] },

  {
    sourceTag: 'scope:backend',
    onlyDependOnLibsWithTags: ['layer:types', 'layer:utils', 'layer:contracts'],
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
  },
];
