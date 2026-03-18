import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Produce relative-path assets so the VS Code WebView URI rewriting works
  base: './',
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Single JS + CSS chunk for simplicity
        manualChunks: undefined,
      },
    },
  },
});
