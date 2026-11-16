#!/usr/bin/env node
// `npm run dev`: the server bundle is rebuilt on every change (esbuild watch)
// and server.js restarts on it (node --watch); the UI is served by Vite with
// hot reload (server.js, NODE_ENV != production).
import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';
import { serverBuildOptions } from './build-server.mjs';

const ctx = await esbuild.context(serverBuildOptions);
await ctx.rebuild();
await ctx.watch();
const child = spawn(process.execPath, ['--watch-path=dist/server', 'server.js'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development' },
});
const stop = () => { child.kill('SIGTERM'); void ctx.dispose(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => { void ctx.dispose(); process.exit(code ?? 0); });
