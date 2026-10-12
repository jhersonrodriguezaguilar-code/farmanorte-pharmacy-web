import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Rutas relativas: funcionan en GitHub Pages, Hostinger y localhost.
  base: './',
  build: {
    sourcemap: true,
  },
});
