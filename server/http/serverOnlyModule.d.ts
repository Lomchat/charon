// `import 'server-only'` is a side-effect marker with no package behind it:
// the server bundle aliases it to ./serverOnly.ts, the browser build rejects
// it (vite.config.ts). TS 7 checks side-effect imports, so declare it.
declare module 'server-only';
