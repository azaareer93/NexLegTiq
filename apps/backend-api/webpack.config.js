const { join } = require('path');

const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const nodeExternals = require('webpack-node-externals');

// Two entrypoints from one codebase: `main` (HTTP API) and `worker` (BullMQ consumers, D-011).
module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  // npm packages stay external (required at runtime from node_modules); only @nexlegtiq/* source packages are
  // bundled (D-074). Nx's default only scans the root node_modules, but with pnpm the app's own deps live in
  // apps/backend-api/node_modules, so they would otherwise be bundled (breaking e.g. pino transports).
  externals: [
    nodeExternals({
      modulesDir: join(__dirname, 'node_modules'),
      additionalModuleDirs: [join(__dirname, '../../node_modules')],
      allowlist: [/^@nexlegtiq\//],
    }),
  ],
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'swc',
      main: './src/main.ts',
      additionalEntryPoints: [{ entryName: 'worker', entryPath: './src/worker.ts' }],
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      externalDependencies: 'none',
      mergeExternals: true,
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
