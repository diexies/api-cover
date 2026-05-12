import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build to a dist that the .NET project embeds. Base path matches the APICover mount prefix
// so that asset URLs resolve under /apicover/ui/* without a server-side rewrite. Absolute
// path (not `./`) so that loading `/apicover/ui` without a trailing slash still resolves
// assets correctly — relative resolution against `/apicover/ui` would point at `/apicover/`.
export default defineConfig({
  plugins: [react()],
  base: '/apicover/ui/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          xyflow: ['@xyflow/react'],
          virtual: ['@tanstack/react-virtual'],
          layout: ['dagre'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/apicover/api': 'http://localhost:5050',
    },
  },
});
