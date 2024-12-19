import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginPrettierRecommended from 'eslint-plugin-prettier/recommended'

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js']
        }
      }
    }
  },
  pluginPrettierRecommended
)
