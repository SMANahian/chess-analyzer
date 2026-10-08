/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };
import { cspMeta, licenseNotices, noticeMarkdown } from './scripts/vite-plugins.ts';

/** Shipped next to index.html. Not a dot-file: actions/upload-pages-artifact leaves hidden files out. */
const LICENSES_FILE = 'THIRD-PARTY-LICENSES.md';
const SOURCE_URL = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');

const LICENSES_PREAMBLE = `# Third-party licences

This is the built web app of Chess Analyzer (<${pkg.homepage}>). Its own source code is released
under the MIT licence (below). The app bundles components licensed under the GNU GPL v3 (Stockfish,
chessops, chessground), so **the app as distributed is subject to the GPL-3.0**. The complete
corresponding source is <${SOURCE_URL}> (this build also ships source maps).

Files that carry their own licence:

- \`engine/\`: Stockfish 19 lite NNUE (WebAssembly build by stockfish.js), GPL-3.0. Licence text:
  \`engine/COPYING.txt\`. Source: https://github.com/official-stockfish/Stockfish,
  https://github.com/nmrugg/stockfish.js
- The chess pieces in the stylesheet: cburnett piece set from chessground, GPL-2.0-or-later.
- \`data/openings.json\`: opening names from https://github.com/lichess-org/chess-openings, CC0-1.0.

Every package with code in the app's JavaScript and its service worker follows, with its version and
licence text.

${noticeMarkdown({ name: pkg.name, version: pkg.version, license: pkg.license, text: readFileSync(new URL('LICENSE', import.meta.url), 'utf8').trim() })}`;

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites and any sub-path.
  base: './',
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'engine/*', 'data/*'],
      manifest: {
        name: 'Chess Analyzer — fix your opening mistakes',
        short_name: 'Chess Analyzer',
        description: 'Find the opening mistakes you keep repeating and drill them until they stick.',
        theme_color: '#161512',
        background_color: '#161512',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,wasm,json,woff2}'],
        // The engine binary is ~1.8 MB; precache it so analysis works offline.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
    // GitHub Pages cannot send a CSP header; the meta tag covers the page (workers and the service
    // worker get no policy from it). The app only talks to the two game APIs.
    cspMeta({ connectSrc: ['https://lichess.org', 'https://api.chess.com'] }),
    licenseNotices({ fileName: LICENSES_FILE, preamble: LICENSES_PREAMBLE }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    // The licences of the bundled packages (MIT and Apache-2.0 require shipping them; the minifier strips
    // their banners). licenseNotices completes the file.
    license: { fileName: LICENSES_FILE },
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'scripts/**/*.test.mjs'],
    testTimeout: 20_000,
  },
});
