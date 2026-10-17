import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: ['dist', 'coverage', 'docs/.vitepress/cache', 'docs/.vitepress/dist'],
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
