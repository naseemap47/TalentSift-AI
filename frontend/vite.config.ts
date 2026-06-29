import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import * as yaml from 'js-yaml'

// Read config.yaml from the root directory
const configPath = path.resolve(__dirname, '../config.yaml')
let frontendPort = 5173
let apiBaseUrl = 'http://localhost:8000'

try {
  if (fs.existsSync(configPath)) {
    const fileContents = fs.readFileSync(configPath, 'utf8')
    const config = yaml.load(fileContents) as any
    if (config && config.frontend) {
      if (config.frontend.port) {
        frontendPort = Number(config.frontend.port)
      }
      if (config.frontend.api_base_url) {
        apiBaseUrl = config.frontend.api_base_url
      }
    }
  }
} catch (e) {
  console.warn('Warning: Could not load config.yaml. Using defaults.', e)
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: frontendPort,
    host: true, // Allow exposing network interface if needed
  },
  define: {
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBaseUrl),
  }
})
