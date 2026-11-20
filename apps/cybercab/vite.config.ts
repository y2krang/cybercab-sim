import { defineConfig } from 'vitest/config';

// CYBERCAB_BASE sets the web path, e.g. "/cybercab/" for GitHub Pages.
// The default "./" works from any folder.
export default defineConfig({
  base: process.env.CYBERCAB_BASE ?? './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  // Local only: never listen on the network (no firewall prompt).
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  test: { environment: 'node', testTimeout: 60_000 },
});
