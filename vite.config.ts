import { defineConfig, type Plugin } from 'vite-plus';
import type { PackUserConfig } from 'vite-plus/pack';

const shared = {
  dts: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
  // `.js`/`.cjs` (and `.d.ts`/`.d.cts`), matching the `exports` map in package.json.
  fixedExtension: false,
  // Both configs write to dist/; `npm run build` empties it first.
  clean: false,
  deps: { neverBundle: ['react'] }
} satisfies PackUserConfig;

// The hooks entry imports the client from the built `core` entry instead of bundling a second
// copy, so an app using both entries ships the client once and `instanceof MessageError` holds.
function coreAsExternal(target: string): Plugin {
  return {
    name: 'core-as-external',
    resolveId(source) {
      if (source === './core') return { id: target, external: true };
    }
  };
}

export default defineConfig({
  pack: [
    // `react-websocket/core` has no React dependency and no client directive.
    { ...shared, entry: { core: 'src/core.ts' }, format: ['esm', 'cjs'] },
    // A development tool with no imports, built on its own so it shares no chunks with `core`.
    { ...shared, entry: { chaos: 'src/chaos.ts' }, format: ['esm', 'cjs'] },
    // The hooks are client-only; mark them so Server Components frameworks bundle them correctly.
    {
      ...shared,
      entry: { index: 'src/index.ts' },
      banner: { js: "'use client';" },
      format: {
        esm: { plugins: [coreAsExternal('./core.js')] },
        cjs: { plugins: [coreAsExternal('./core.cjs')] }
      }
    }
  ],
  fmt: {
    singleQuote: true,
    trailingComma: 'none',
    tabWidth: 2,
    arrowParens: 'avoid',
    printWidth: 100,
    // Keep package.json in its hand-written order, as Prettier did.
    sortPackageJson: false,
    ignorePatterns: [
      'dist',
      'coverage',
      'package-lock.json',
      'doc_build',
      // Prose is hand-wrapped; tables and examples are formatted by hand.
      '*.md',
      '*.mdx'
    ]
  },
  lint: {
    ignorePatterns: [
      'dist',
      'coverage',
      'doc_build',
      // Type-aware linting needs the examples' own dependencies, which `npm ci` here doesn't
      // install. They have their own `typecheck` and `build` scripts.
      'examples/nextjs',
      'examples/hono',
      'examples/astro',
      'examples/remix'
    ],
    plugins: ['eslint', 'typescript', 'react'],
    options: { typeAware: true, typeCheck: true },
    // The rules ESLint ran here before (eslint, typescript-eslint and react-hooks recommended)
    // that Oxlint doesn't enable by default.
    rules: {
      'no-case-declarations': 'error',
      'no-empty': 'error',
      'no-fallthrough': 'error',
      'no-prototype-builtins': 'error',
      'no-regex-spaces': 'error',
      'no-unexpected-multiline': 'error',
      'no-useless-assignment': 'error',
      'preserve-caught-error': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'no-array-constructor': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'typescript/ban-ts-comment': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-namespace': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/no-unnecessary-type-constraint': 'error',
      'typescript/no-unsafe-function-type': 'error',
      'react/rules-of-hooks': 'error',
      'react/exhaustive-deps': 'warn',
      'react/static-components': 'error',
      'react/use-memo': 'error',
      'react/preserve-manual-memoization': 'error',
      'react/immutability': 'error',
      'react/globals': 'error',
      'react/refs': 'error',
      'react/set-state-in-effect': 'error',
      'react/set-state-in-render': 'error',
      'react/error-boundaries': 'error',
      'react/purity': 'error',
      'react/incompatible-library': 'warn',
      'react/unsupported-syntax': 'warn',
      // Type-aware rules ESLint didn't run. The client's methods are closures, so passing
      // `client.subscribe` around unbound is safe, and tests leave `act()` promises un-awaited.
      'typescript/unbound-method': 'off',
      'typescript/no-floating-promises': 'off'
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: { statements: 90, branches: 82, functions: 90, lines: 92 }
    }
  }
});
