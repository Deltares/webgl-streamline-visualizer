import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  test: {
    browser: {
      enabled: true,
      screenshotFailures: false,
      provider: 'playwright',
      name: 'chromium',
      headless: true,
      api: 5174
    }
  }
})
