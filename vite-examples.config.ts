import { resolve } from 'path'
import { defineConfig } from 'vite'
import viteGlslPlugin from 'vite-plugin-glsl'

function resolveRelativePath(relative: string): string {
  return resolve(__dirname, relative)
}

export default defineConfig({
  base: '/webgl-streamline-visualizer/', // Base path for GitHub Pages
  plugins: [
    viteGlslPlugin({
      include: ['**/*.frag.glsl', '**/*.vert.glsl'],
      minify: true
    })
  ],
  build: {
    rollupOptions: {
      input: {
        index: resolveRelativePath('index.html'),
        vortex: resolveRelativePath('examples/vortex.html'),
        vortex_sprite: resolveRelativePath('examples/vortex_sprites.html'),
        maplibre: resolveRelativePath('examples/maplibre.html')
      }
    }
  },
  resolve: {
    alias: {
      '@': resolveRelativePath('./src')
    }
  }
})
