import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs allow the same build to work on localhost and GitHub Pages.
  base: './',
  build: {
    sourcemap: true,
  },
});
