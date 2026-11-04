import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import viteGlslPlugin from 'vite-plugin-glsl'

function resolveRelativePath(relative: string): string {
  return resolve(import.meta.dirname, relative)
}

export default defineConfig({
  // public/ is for the examples; it should not end up in the package.
  publicDir: false,
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
    rolldownOptions: {
      // Do not bundle MapLibre; applications using this streamlines library as a
      // map layer should already have it anyway.
      external: ['maplibre-gl']
    }
  },
  resolve: {
    alias: {
      '@': resolveRelativePath('./src')
    }
  }
})
