import { defineConfig } from 'vitest/config';

// CYBERCAB_BASE sets the web path, e.g. "/cybercab/" for GitHub Pages.
// The default "./" works from any folder.
export default defineConfig({
  base: process.env.CYBERCAB_BASE ?? './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  // Local only: never listen on the network (no firewall prompt).
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  // Test files run one at a time: each loads ~40 MB of data, too much at once on a small PC.
  test: { environment: 'node', testTimeout: 300_000, hookTimeout: 300_000, fileParallelism: false },
});
