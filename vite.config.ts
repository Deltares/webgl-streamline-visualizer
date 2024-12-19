import { resolve } from 'path'
import type { BuildOptions } from 'vite'
import { defineConfig } from 'vitest/config'
import rollupPluginTypescript from '@rollup/plugin-typescript'

const PRODUCTION_BUILD_OPTIONS: BuildOptions = {
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
}

const DEVELOPMENT_BUILD_OPTIONS: BuildOptions = {
  rollupOptions: {
    input: {
      demo: resolveRelativePath('examples/demo.html')
    }
  }
}

export default defineConfig(({ mode }) => ({
  build:
    mode === 'production'
      ? PRODUCTION_BUILD_OPTIONS
      : DEVELOPMENT_BUILD_OPTIONS,
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
}))

function resolveRelativePath(relative: string): string {
  return resolve(__dirname, relative)
}
