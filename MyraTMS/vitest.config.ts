import { defineConfig } from 'vitest/config'
import path from 'path'
import fs from 'fs'

// Load .env.local into process.env so Engine 2 integration tests reach
// Neon + Upstash without requiring callers to pass --env-file.
const envPath = path.join(__dirname, '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    const [, k, raw] = m
    const v = raw.replace(/^['"]|['"]$/g, '')
    if (!process.env[k]) process.env[k] = v
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
