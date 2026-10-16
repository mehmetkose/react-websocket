import { defineConfig, type Options } from 'tsup';
import type { Plugin } from 'esbuild';

const shared = {
  format: ['esm', 'cjs'],
  // tsup's dts step sets baseUrl, which TypeScript 6 flags as deprecated.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  target: 'es2022',
  external: ['react']
} satisfies Options;

// The hooks entry imports the client from the built `core` entry instead of bundling a second
// copy, so an app using both entries ships the client once and `instanceof MessageError` holds.
const coreAsExternal: Plugin = {
  name: 'core-as-external',
  setup(build) {
    const target = build.initialOptions.format === 'cjs' ? './core.cjs' : './core.js';
    build.onResolve({ filter: /^\.\/core$/ }, () => ({ path: target, external: true }));
  }
};

export default defineConfig([
  // `react-websocket/core` has no React dependency and no client directive.
  { ...shared, entry: { core: 'src/core.ts' } },
  // The hooks are client-only; mark them so Server Components frameworks bundle them correctly.
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    banner: { js: "'use client';" },
    esbuildPlugins: [coreAsExternal]
  }
]);
