import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,   // listen on 0.0.0.0 — accessible from any device on the network
    port: 5173,
  },
  build: {
    target: ['es2020', 'safari14'],
  },
})
