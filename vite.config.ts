import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));

// A server module reached from the browser bundle is a bug (it would ship DB
// or SSH code to the client): fail the build, as Next did.
function serverOnlyGuard(): Plugin {
  return {
    name: 'charon-server-only-guard',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'server-only') this.error(`server-only module imported by the browser bundle: ${importer}`);
      return null;
    },
  };
}

// The pages (web/<name>.html): the server fills each one per request
// (server/http/pages.ts).
export default defineConfig({
  root,
  // React Compiler: memoization written at build time (components and hooks
  // that follow the Rules of React; the others are left as written), so a
  // parent's render no longer re-renders every child by default (§14.38).
  plugins: [react({ babel: { plugins: ['babel-plugin-react-compiler'] } }), serverOnlyGuard()],
  resolve: { alias: { '@': root } },
  publicDir: 'public',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        hub: path.join(root, 'web/hub.html'),
        desk: path.join(root, 'web/desk.html'),
        view: path.join(root, 'web/view.html'),
        login: path.join(root, 'web/login.html'),
      },
      onwarn(warning, warn) {
        // `'use client'` markers left from Next: meaningless here.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
    },
  },
  server: { hmr: { port: 24678 } },
});
