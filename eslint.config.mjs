export default [
  {
    files: [
      'lambdas/**/function/**/*.mjs',
      'lambdas/shared-layer/nodejs/**/*.mjs',
    ],
    ignores: [
      '**/node_modules/**',
      '**/*.test.mjs',
      '**/*.integration.test.mjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        AbortController: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        process: 'readonly',
        queueMicrotask: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
  {
    files: ['tests/fixtures/no-undef-regression.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...Object.fromEntries(['console', 'process', 'Buffer'].map((name) => [name, 'readonly'])) },
    },
    rules: { 'no-undef': 'error' },
  },
];
