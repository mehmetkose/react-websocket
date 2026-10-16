import { defineConfig } from 'tsup';

const shared = {
  format: ['esm', 'cjs'] as const,
  // tsup's dts step sets baseUrl, which TypeScript 6 flags as deprecated.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  target: 'es2022',
  external: ['react']
};

export default defineConfig([
  // `react-websocket/core` has no React dependency and no client directive.
  { ...shared, entry: { core: 'src/core.ts' } },
  // The hooks are client-only; mark them so Server Components frameworks bundle them correctly.
  { ...shared, entry: { index: 'src/index.ts' }, banner: { js: "'use client';" } }
]);
