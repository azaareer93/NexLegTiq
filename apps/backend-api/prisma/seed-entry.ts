// Entry of dist/seed.js (webpack.config.js): the reference-data seed run by the migrate image, which has no TypeScript
// runner (D-103). `require.main === module` in seed.ts is false inside a webpack bundle, hence this file.
// Plans only: courts are development and demo data, managed by the platform admin in production (D-266).
import { main } from './seed';

main({ courts: false }).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
