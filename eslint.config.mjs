// eslint-config-next 16 ships flat config, so it is spread directly — routing it
// through FlatCompat/eslintrc crashes on a circular plugin reference.
import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescript from 'eslint-config-next/typescript'

const config = [
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: false,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^(_|ignore)',
        },
      ],
    },
  },
  {
    // ponytail: template components predate React 19's hook rules. Demoted, not
    // fixed, because Wave 2 replaces all four with per-site themed components —
    // delete this block then, and the rules go back to erroring everywhere.
    files: [
      'src/Header/Component.client.tsx',
      'src/components/Card/index.tsx',
      'src/providers/Theme/**/*.tsx',
    ],
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    ignores: ['.next/', 'src/payload-types.ts', 'src/payload-generated-schema.ts'],
  },
]

export default config
