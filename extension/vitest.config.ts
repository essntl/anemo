import { defineConfig } from 'vitest/config'
import { alias } from './vite.config.ts'

export default defineConfig({
  resolve: { alias },
  define: { __DEV__: 'false', __E2E__: 'false' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
})
