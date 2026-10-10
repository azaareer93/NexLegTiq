// Entry of dist/seed.js (webpack.config.js): the reference-data seed run by the migrate image, which has no TypeScript
// runner (D-103). `require.main === module` in seed.ts is false inside a webpack bundle, hence this file.
import { main } from './seed';

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
