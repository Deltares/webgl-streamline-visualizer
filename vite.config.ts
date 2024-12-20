import { resolve } from 'path'
import type { BuildOptions } from 'vite'
import { defineConfig } from 'vitest/config'
import rollupPluginTypescript from '@rollup/plugin-typescript'

const PRODUCTION_BUILD_OPTIONS: BuildOptions = {
  lib: {
    entry: resolveRelativePath('src/index.ts'),
    // Only build ES module, this library is only relevant for use in the
    // browser.
    formats: ['es'],
    name: 'webgl-streamline-visualiser',
    fileName: 'webgl-streamline-visualiser'
  },
  rollupOptions: {
    // Do not bundle MapLibre; applications using this streamlines library as a
    // map layer should already have it anyway.
    external: ['maplibre-gl'],
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
