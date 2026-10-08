// check-dist flags a build whose CSP hash is stale, whose licence file misses a bundled package (or its
// NOTICE file), or whose maskable icon is a regular icon; a complete build passes.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDist } from './check-dist.mjs';

const root = mkdtempSync(join(tmpdir(), 'ca-check-dist-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const THEME = 'document.documentElement.dataset.theme = "dark";';
const hash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

/** A minimal build; `change` edits its files (path → content) before they are written. */
function dist(name, change = {}) {
  const dir = join(root, name);
  const files = {
    'index.html': `<!doctype html><html><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' ${hash(THEME)}" />
<script>${THEME}</script><script type="module" src="./assets/index.js"></script></head><body></body></html>`,
    'assets/index.js.map': JSON.stringify({ sources: ['../../node_modules/preact/dist/preact.mjs', '../../src/main.tsx'] }),
    'workbox-1.js.map': JSON.stringify({ sources: ['node_modules/workbox-core/_version.js'] }),
    'THIRD-PARTY-LICENSES.md': '# Third-party licences\n\n## preact - 10.0.0 (MIT)\n\nPermission is hereby granted…\n\n## workbox-core - 7.4.1 (MIT)\n\nMIT License …\n',
    'engine/COPYING.txt': 'GNU GENERAL PUBLIC LICENSE',
    'manifest.webmanifest': JSON.stringify({
      icons: [
        { src: 'icon-512.png', sizes: '512x512' },
        { src: 'icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' },
      ],
    }),
    'icon-512.png': 'png',
    'icon-maskable-512.png': 'png',
    ...change,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe('check-dist', () => {
  it('passes a complete build', () => {
    expect(checkDist(dist('good'))).toEqual([]);
  });

  it('flags a missing or stale CSP, or one placed after a script', () => {
    expect(checkDist(dist('no-csp', { 'index.html': `<html><head><script>${THEME}</script></head></html>` }))).toEqual([
      'index.html: expected one Content-Security-Policy <meta>, found 0',
    ]);
    const stale = checkDist(dist('stale', { 'index.html': `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self' ${hash('old')}" /><script>${THEME}</script></head></html>` }));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/does not allow the inline script starting "document.documentElement/);
    expect(
      checkDist(dist('late', { 'index.html': `<html><head><script src="a.js"></script><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline'" /></head></html>` })),
    ).toEqual(['index.html: the CSP <meta> comes after a <script>, <link> or <style>', "index.html: script-src allows 'unsafe-inline'"]);
  });

  it('flags a bundled package without a licence section (the service worker included), and a missing engine licence', () => {
    expect(
      checkDist(dist('no-workbox', { 'THIRD-PARTY-LICENSES.md': '## preact - 10.0.0 (MIT)\n\nPermission is hereby granted…\n', 'engine/COPYING.txt': null })),
    ).toEqual([
      'THIRD-PARTY-LICENSES.md: no section for workbox-core (bundled in workbox-1.js)',
      "engine/COPYING.txt (the engine's GPL text) is missing",
    ]);
    expect(checkDist(dist('no-file', { 'THIRD-PARTY-LICENSES.md': null }))).toEqual(['THIRD-PARTY-LICENSES.md is missing']);
    expect(checkDist(dist('no-text', { 'THIRD-PARTY-LICENSES.md': '## preact - 10.0.0 (MIT)\n\n## workbox-core - 7.4.1 (MIT)\n\nMIT License\n' }))).toEqual([
      'THIRD-PARTY-LICENSES.md: the section for preact has no licence text',
    ]);
  });

  it("flags an Apache-2.0 package whose NOTICE file is not shipped (Dexie's, from this repository's node_modules)", () => {
    const withDexie = {
      'assets/index.js.map': JSON.stringify({ sources: ['../../node_modules/dexie/dist/dexie.mjs'] }),
      'workbox-1.js.map': null,
    };
    const apache = '## dexie - 4.4.6 (Apache-2.0)\n\nApache License, Version 2.0\n';
    expect(checkDist(dist('no-notice', { ...withDexie, 'THIRD-PARTY-LICENSES.md': apache }))).toEqual([
      "THIRD-PARTY-LICENSES.md: the section for dexie lacks the package's NOTICE file",
    ]);
    const notice = readFileSync(new URL('../node_modules/dexie/NOTICE', import.meta.url), 'utf8').trim();
    expect(checkDist(dist('notice', { ...withDexie, 'THIRD-PARTY-LICENSES.md': `${apache}\nNOTICE:\n\n${notice}\n` }))).toEqual([]);
  });

  it('flags a maskable icon that is a regular icon too, or not in the build', () => {
    const manifest = icons => ({ 'manifest.webmanifest': JSON.stringify({ icons }) });
    expect(checkDist(dist('maskable-regular', manifest([{ src: 'icon-512.png' }, { src: 'icon-512.png', purpose: 'maskable' }])))).toEqual([
      'manifest.webmanifest: the maskable icon icon-512.png is also a regular icon (maskable artwork needs its own safe-zone file)',
    ]);
    expect(checkDist(dist('maskable-missing', manifest([{ src: 'gone.png', purpose: 'maskable' }])))).toEqual([
      'manifest.webmanifest: the maskable icon gone.png is not in the build',
    ]);
    expect(checkDist(dist('no-maskable', manifest([{ src: 'icon-512.png' }])))).toEqual(['manifest.webmanifest: no maskable icon']);
  });
});
