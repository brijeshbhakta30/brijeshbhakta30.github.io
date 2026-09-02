/* eslint-disable unicorn/filename-case */
export default {
  '*.{astro,js,mjs,cjs,ts}': 'eslint --fix',
  '*.css': [
    'eslint --fix',
    'prettier --write',
  ],
  '*.{json,md,yaml,yml}': 'prettier --write',
};
