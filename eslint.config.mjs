// eslint-config-next 16 ships flat config, so it is spread directly — routing it
// through FlatCompat/eslintrc crashes on a circular plugin reference.
import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescript from 'eslint-config-next/typescript'

/**
 * Tailwind utilities that hardcode a physical direction. Written as an esquery
 * attribute regex — no plugin and no new dependency, which a Tailwind-aware linter
 * would both cost.
 *
 * `\b` is what keeps `whitespace-pre-line`, `rounded-lg`, `border-lime-500` and
 * `copyright-2026` out of it: each has a word character where the utility would need
 * a `-` or a boundary.
 */
const PHYSICAL_UTILITY =
  '\\b(p[lr]-|m[lr]-|left-|right-|text-left|text-right|float-left|float-right|border-[lr]\\b|rounded-[tb]?[lr]\\b)'

const RTL_MESSAGE =
  'Physical-direction utility breaks RTL silently. Use the logical one: ps/pe, ms/me, start/end, text-start/text-end, border-s/border-e, rounded-s/rounded-e. A genuine exception (a popover’s own side, a directional icon) takes an eslint-disable with the reason.'

const FORMAT_MESSAGE =
  'Persian pages need Shamsi dates and Persian-Indic digits. Use formatDate/formatNumber/toLocaleDigits from src/lib/format.ts, which take the active locale — a bare Intl call renders Gregorian Latin on a fa page.'

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
    /**
     * PLAN §3.5, enforced rather than remembered. Literals and template chunks, not
     * just `className="…"`, so `cn(...)` arguments and `cva` variants are covered.
     * Comments are not literals, so prose about what was "left" as-is is safe.
     *
     * PLAN §3.6 rides the same mechanism: `src/lib/format.ts` is the only module
     * allowed to construct an `Intl` formatter or call `toLocale*String`.
     */
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/lib/format.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { message: RTL_MESSAGE, selector: `Literal[value=/${PHYSICAL_UTILITY}/]` },
        { message: RTL_MESSAGE, selector: `TemplateElement[value.raw=/${PHYSICAL_UTILITY}/]` },
        {
          message: FORMAT_MESSAGE,
          selector: 'NewExpression[callee.object.name="Intl"]',
        },
        {
          message: FORMAT_MESSAGE,
          selector: 'CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/]',
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
