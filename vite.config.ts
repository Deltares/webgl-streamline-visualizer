import { resolve } from 'path'
import { defineConfig, type BuildOptions } from 'vite'

import rollupPluginTypescript from '@rollup/plugin-typescript'
import viteGlslPlugin from 'vite-plugin-glsl'

const PRODUCTION_BUILD_OPTIONS: BuildOptions = {
  lib: {
    entry: resolveRelativePath('src/index.ts'),
    // Only build ES module, this library is only relevant for use in the
    // browser.
    formats: ['es'],
    name: 'webgl-streamline-visualizer',
    fileName: 'webgl-streamline-visualizer'
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
      vortex: resolveRelativePath('examples/vortex.html'),
      maplibre: resolveRelativePath('examples/maplibre.html'),
      maplibre_basic: resolveRelativePath('examples/maplibre_basic.html')
    }
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [
    viteGlslPlugin({
      include: ['**/*.frag.glsl', '**/*.vert.glsl'],
      compress: true
    })
  ],
  build:
    mode === 'production'
      ? PRODUCTION_BUILD_OPTIONS
      : DEVELOPMENT_BUILD_OPTIONS,
  resolve: {
    alias: {
      '@': resolveRelativePath('./src')
    }
  }
}))

function resolveRelativePath(relative: string): string {
  return resolve(__dirname, relative)
}
