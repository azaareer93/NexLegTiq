// The workspace rules live in shared-config (MVP-29, D-094); every project's eslint.config.mjs spreads this.
export { baseConfig as default } from './packages/shared-config/eslint/base.mjs';
