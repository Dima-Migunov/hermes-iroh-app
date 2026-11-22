import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const aliases = {
  '@shared': resolve('src/shared'),
  '@renderer': resolve('src/renderer/src'),
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/release/**/*.test.mjs'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: aliases },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
