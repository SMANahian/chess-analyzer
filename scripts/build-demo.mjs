#!/usr/bin/env node
// npm run build:demo [-- --workers N] — rebuilds public/demo/demo.json. The work is done by
// scripts/build-demo.ts, which imports the app's TypeScript modules; Vite's module runner loads it
// (TypeScript, import.meta.env and JSON imports, as in the app) without a separate build step.
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const entry = fileURLToPath(new URL('./build-demo.ts', import.meta.url));
const { module } = await runnerImport(entry, { configFile: false, logLevel: 'error' });
await module.main(process.argv.slice(2));
