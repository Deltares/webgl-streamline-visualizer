import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { resolve } from 'node:path'

export default defineConfig({
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
