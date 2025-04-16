import { resolve } from 'path'
import { defineConfig } from 'vite'
import viteGlslPlugin from 'vite-plugin-glsl'
import rollupPluginTypescript from '@rollup/plugin-typescript'

function resolveRelativePath(relative: string): string {
  return resolve(__dirname, relative)
}

export default defineConfig({
  plugins: [
    viteGlslPlugin({
      include: ['**/*.frag.glsl', '**/*.vert.glsl'],
      minify: true
    })
  ],
  build: {
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
  },
  resolve: {
    alias: {
      '@': resolveRelativePath('./src')
    }
  }
})
