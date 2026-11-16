// What `import 'server-only'` resolves to in the server bundle: nothing. The
// browser build turns the same import into a build error (vite.config.ts).
export {};
