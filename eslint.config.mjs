// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
      // spec §9: Prisma parameterizes queries; the *Unsafe variants accept
      // raw interpolated SQL and reopen the injection surface Prisma exists
      // to close.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/]",
          message:
            'Prisma\'s *RawUnsafe methods accept raw interpolated SQL and reintroduce injection risk. Use $queryRaw/$executeRaw with tagged-template parameterization instead.',
        },
      ],
    },
  },
);
