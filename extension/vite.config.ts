import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './public/manifest.json' with { type: 'json' };

export default defineConfig({
  plugins: [crx({ manifest })],
  server: {
    port: 5173,
    host: '127.0.0.1',
    hmr: { port: 5174 },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      input: {
        sidepanel: 'src/sidepanel/index.html',
      },
    },
  },
});
