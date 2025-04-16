import { resolve } from 'path'
import { defineConfig, type BuildOptions } from 'vite'
import viteGlslPlugin from 'vite-plugin-glsl'

function resolveRelativePath(relative: string): string {
  return resolve(__dirname, relative)
}

const EXAMPLES_BUILD_OPTIONS: BuildOptions = {
  rollupOptions: {
    input: {
      index: resolveRelativePath('index.html'),
      vortex: resolveRelativePath('examples/vortex.html'),
      vortex_sprite: resolveRelativePath('examples/vortex_sprites.html'),
      maplibre: resolveRelativePath('examples/maplibre.html')
    }
  }
}

export default defineConfig({
  base: '/webgl-streamline-visualizer/', // Base path for GitHub Pages
  plugins: [
    viteGlslPlugin({
      include: ['**/*.frag.glsl', '**/*.vert.glsl'],
      minify: true
    })
  ],
  build: EXAMPLES_BUILD_OPTIONS,
  resolve: {
    alias: {
      '@': resolveRelativePath('./src')
    }
  }
})
