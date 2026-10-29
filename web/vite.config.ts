import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The demo build is served from GitHub Pages under the repository name, so asset URLs need
// that prefix. A dev or self-hosted build is served from the root instead, which is what
// VITE_BASE=/ gives you.
const base = process.env.VITE_BASE ?? '/livereel-media-pipeline/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    // Published straight into docs/ so GitHub Pages can serve it from the main branch with
    // no extra workflow.
    outDir: '../docs',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    css: false,
  },
});
