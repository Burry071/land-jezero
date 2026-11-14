import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so the static build also works from any static host / subpath
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { target: 'esnext', sourcemap: false },
})
