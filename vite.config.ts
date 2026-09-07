import { fileURLToPath } from 'node:url';
// `vitest/config` re-exports Vite's defineConfig with the `test` block typed,
// so the app config and the test config stay one file.
import { defineConfig } from 'vitest/config';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Relative base so the built site works from a project subpath (GitHub Pages).
  base: './',
  resolve: {
    alias: {
      '@domain': dir('./src/domain'),
      '@app': dir('./src/application'),
      '@adapters': dir('./src/adapters'),
      '@games': dir('./src/games'),
      '@ui': dir('./src/ui'),
      '@config': dir('./src/config'),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // three and firebase are each around half a megabyte and deliberately
    // split into their own long-lived chunks, so the default warning at
    // 500 kB only ever fires for the two we already decided about.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Firebase and three are large and change rarely. Splitting them out
        // keeps them cacheable across deploys and keeps the store shell — the
        // only thing needed to paint the shelf — small.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) {
            return 'firebase';
          }
          return undefined;
        },
      },
    },
  },
  server: { port: 5173, host: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
