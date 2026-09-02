import { createConfig } from 'eslint-config-blazex';
import eslintPluginAstro from 'eslint-plugin-astro';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import eslintPluginTailwindcss from 'eslint-plugin-tailwindcss';

const tailwindcssConfig = eslintPluginTailwindcss.configs.recommended;
const tailwindcssRules = {
  ...tailwindcssConfig.rules,
  'tailwindcss/classnames-order': 'off',
  'tailwindcss/enforces-canonical-classname': 'off',
  'tailwindcss/enforces-negative-arbitrary-values': 'off',
  'tailwindcss/enforces-shorthand': 'off',
  'tailwindcss/no-custom-classname': [
    'warn',
    {
      whitelist: [
        'is-.*',
        'prose',
        'scrum-.*',
        'wheel-.*',
      ],
    },
  ],
  'tailwindcss/no-unnecessary-arbitrary-value': 'off',
};

const tailwindcssSettings = {
  tailwindcss: {
    cssConfigPath: './src/styles/global.css',
  },
};

export default [
  createConfig({
    preset: 'typescript',
    sonar: true,
    unicorn: true,
    perfectionist: true,
  }),
  {
    ...tailwindcssConfig,
    settings: tailwindcssSettings,
    rules: tailwindcssRules,
  },
  jsxA11y.flatConfigs.recommended,
  ...eslintPluginAstro.configs.recommended,
  {
    files: ['src/**/*.astro'],
    plugins: tailwindcssConfig.plugins,
    rules: tailwindcssRules,
    settings: tailwindcssSettings,
  },
  {
    files: ['src/pages/**/*.astro', 'src/pages/*.astro'],
    rules: {
      'jsx-a11y/label-has-associated-control': 'off',
      'unicorn/filename-case': 'off',
    },
  },
];
