import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The dependency rule of a hexagonal architecture, enforced by the linter
 * instead of by good intentions:
 *
 *   domain      -> nothing (pure rules, no I/O, no libraries)
 *   application -> domain only (use cases talk to ports, never to adapters)
 *   adapters    -> domain + application (they implement the ports)
 *   ui/games    -> domain + application (they drive the use cases)
 *
 * Only src/composition (the composition root) may reach for adapters.
 */
const deny = (patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
});

export default tseslint.config(
  { ignores: ['dist', 'legacy', 'public', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Ports are declared as returning promises, so an adapter that happens
      // to answer synchronously still has to be `async`. That is the
      // interface doing its job, not a mistake.
      '@typescript-eslint/require-await': 'off',
      // A leading underscore marks a parameter kept only to satisfy a port.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: deny([
      {
        group: ['@app/*', '@adapters/*', '@ui/*', '@games/*', 'firebase*', 'three*'],
        message:
          'The domain is pure: it may not import application code, adapters, UI or third-party libraries.',
      },
    ]),
  },
  {
    files: ['src/application/**/*.ts'],
    rules: deny([
      {
        group: ['@adapters/*', '@ui/*', '@games/*', 'firebase*', 'three*'],
        message: 'Use cases depend on ports, never on the adapters that implement them.',
      },
    ]),
  },
  {
    files: ['src/ui/**/*.ts', 'src/games/**/*.ts'],
    ignores: ['src/games/*/adapters/**/*.ts', 'src/games/*/composition.ts'],
    rules: deny([
      {
        group: ['firebase*'],
        message: 'Reach Firebase through a port, not directly from the UI.',
      },
    ]),
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', 'eslint.config.js'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
);
