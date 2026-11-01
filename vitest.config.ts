import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { resolve } from 'node:path'
import viteGlslPlugin from 'vite-plugin-glsl'

export default defineConfig({
  plugins: [
    viteGlslPlugin({
      include: ['**/*.frag.glsl', '**/*.vert.glsl']
    })
  ],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src')
    }
  },
  test: {
    browser: {
      enabled: true,
      screenshotFailures: false,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      headless: true,
    }
  }
})
