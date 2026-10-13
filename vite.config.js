import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Rutas relativas: funcionan en GitHub Pages, Hostinger y localhost. La
  // ruta /courier/ es un build Flutter independiente; Vite la copia desde
  // public/courier y no debe reemplazarla por la portada de farmacia.
  base: './',
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          documents: ['html-to-image', 'jspdf'],
        },
      },
    },
  },
});
