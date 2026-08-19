import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative so the same build works from any host and any sub-path --
  // GitHub Pages serves from /<repo>/, a plain static host from the root.
  base: './',
  plugins: [react()],
})
