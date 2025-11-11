import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import { playwright} from '@vitest/browser-playwright'

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
      provider: playwright(),
      instances: [ { browser: 'chromium' }],
      headless: true,
      api: 5174
    }
  }
})
