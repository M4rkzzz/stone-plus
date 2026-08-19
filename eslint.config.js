import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist-web/**',
      'release/**',
      '.artifacts/**',
      'temp/**',
      '_wm_*.cjs',
      '_wm_*.json',
      '_native_responses_*.cjs',
      '_native_responses_*.json',
      '_codex_app_*.cjs',
      '_codex_app_*.json',
      '_reasoning_*.cjs',
      '_reasoning_*.json'
    ]
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs['recommended-latest'],
  {
    files: ['src/renderer/src/App.tsx', 'src/renderer/src/views/**/*.tsx'],
    plugins: {
      'react-refresh': reactRefresh
    },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }]
    }
  }
)
