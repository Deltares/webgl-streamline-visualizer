import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import rollupPluginTypescript from '@rollup/plugin-typescript'

function resolveRelativePath(relative: string): string {
  return resolve(__dirname, relative)
}

export default defineConfig({
  build: {
    lib: {
      entry: resolveRelativePath('src/main.ts'),
      name: 'webgl-streamline-visualiser',
      fileName: 'webgl-streamline-visualiser'
    },
    rollupOptions: {
      plugins: [
        rollupPluginTypescript({
          allowImportingTsExtensions: false,
          declaration: true,
          declarationDir: resolveRelativePath('dist'),
          rootDir: resolveRelativePath('src')
        })
      ]
    }
  },
  resolve: {
    alias: {
      '@': resolveRelativePath('./src')
    }
  },
  test: {
    browser: {
      enabled: true,
      provider: 'playwright',
      name: 'chromium',
      headless: true,
      api: 5174
    }
  }
})
