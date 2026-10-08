// The build-only plugins: the CSP meta tag (hashes from the final HTML) and the licence notices.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  completeNotices,
  contentSecurityPolicy,
  cspHash,
  injectCsp,
  inlineScripts,
  inlineStyleAttributes,
  noticeMarkdown,
  packageDir,
  packagesInSourceMap,
  readNoticeFile,
  readPackageNotice,
} from './vite-plugins';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const opts = { connectSrc: ['https://lichess.org', 'https://api.chess.com'] };
const directive = (policy: string, name: string): string[] =>
  policy.split('; ').map(d => d.split(' ')).find(d => d[0] === name)?.slice(1) ?? [];

describe('CSP meta', () => {
  it('hashes text like the browser (SHA-256 of the UTF-8 text, base64)', () => {
    // Reference values from `printf '%s' … | openssl dgst -sha256 -binary | base64`.
    expect(cspHash('alert(1)')).toBe("'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='");
    expect(cspHash('color: red')).toBe("'sha256-NerDAUWfwD31YdZHveMrq0GLjsNFMwxLpZl0dPUeCcw='");
  });

  it('finds inline scripts with their exact text, not external or commented-out ones', () => {
    const html = `<head><script>\n  a()\n</script><script type="module" crossorigin src="./x.js"></script>
      <!-- <script>old()</script> --><SCRIPT data-x="1">b()</SCRIPT ></head>`;
    expect(inlineScripts(html)).toEqual(['\n  a()\n', 'b()']);
  });

  it('allows the inline scripts of the page by hash, and nothing inline otherwise', () => {
    const policy = contentSecurityPolicy('<head><script>alert(1)</script></head><body><p>hi</p></body>', opts);
    expect(directive(policy, 'script-src')).toEqual(["'self'", cspHash('alert(1)')]);
    expect(directive(policy, 'style-src')).toEqual(["'self'"]);
    expect(directive(policy, 'connect-src')).toEqual(["'self'", 'https://lichess.org', 'https://api.chess.com']);
    expect(directive(policy, 'worker-src')).toEqual(["'self'"]);
    expect(directive(policy, 'img-src')).toEqual(["'self'", 'data:']);
    for (const d of ['object-src', 'base-uri', 'form-action']) expect(directive(policy, d)).toEqual(["'none'"]);
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('admits style="…" attributes (the <noscript> message) by hash only, decoding character references', () => {
    const html = `<body><noscript><div style="color: red"><h1 style='a&quot;b'>x</h1></div></noscript>
      <script>var s = '<p style="ignored">';</script></body>`;
    expect(inlineStyleAttributes(html)).toEqual(['color: red', 'a"b']);
    expect(directive(contentSecurityPolicy(html, opts), 'style-src')).toEqual([
      "'self'",
      "'unsafe-hashes'",
      "'sha256-NerDAUWfwD31YdZHveMrq0GLjsNFMwxLpZl0dPUeCcw='",
      "'sha256-OaASdy3Vw6zLxWkjCTQiiW1BrIguPNZpFLxYTHqslm8='",
    ]);
  });

  it('puts the meta right after <meta charset>, before anything that loads', () => {
    const html = '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n    <title>t</title>\n    <script>alert(1)</script>\n  </head>\n</html>';
    const out = injectCsp(html, opts);
    expect(out.split('\n').slice(3, 6)).toEqual([
      '    <meta charset="UTF-8" />',
      `    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(html, opts)}" />`,
      '    <title>t</title>',
    ]);
    // Without a charset meta, it is the first child of <head>.
    expect(injectCsp('<head><link rel="stylesheet" href="a.css"></head>', opts)).toMatch(/^<head>\n<meta http-equiv="Content-Security-Policy" [^>]*\/><link/);
  });

  it("covers the app's index.html: its theme script is allowed by hash", () => {
    const html = readFileSync(`${ROOT}index.html`, 'utf8');
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    const out = injectCsp(html, opts);
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(out)?.[1] ?? '';
    for (const s of scripts) expect(directive(policy, 'script-src')).toContain(cspHash(s));
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<script'));
  });

  it('refuses a page the policy would break, or one that already has a policy', () => {
    expect(() => injectCsp('<head></head><body><button onclick="go()">x</button></body>', opts)).toThrow(/inline event handler onclick/);
    expect(() => injectCsp('<head></head><body><a href="javascript:go()">x</a></body>', opts)).toThrow(/javascript: URL/);
    expect(() => injectCsp(injectCsp('<head></head>', opts), opts)).toThrow(/already has a Content-Security-Policy/);
    expect(() => injectCsp('<body></body>', opts)).toThrow(/no <head>/);
    // Words in attribute values are not handlers.
    expect(() => injectCsp('<head><meta name="description" content="Play online=free" /></head>', opts)).not.toThrow();
  });
});

describe('licence notices', () => {
  it('lists the node_modules packages of a source map (scoped, nested, relative paths)', () => {
    const map = {
      sources: [
        'node_modules/workbox-core/_version.js',
        '../../node_modules/@preact/signals-core/dist/signals-core.mjs',
        '../node_modules/a/node_modules/b/index.js',
        '../src/main.tsx',
        null,
        'node_modules/workbox-core/models/x.js',
      ],
    };
    expect(packagesInSourceMap(map)).toEqual(['@preact/signals-core', 'b', 'workbox-core']);
  });

  it("reads a package's licence (Vite: only its own, not the licences of its build-time dependencies)", () => {
    const workbox = readPackageNotice(packageDir('workbox-core', ROOT)!);
    expect(workbox).toMatchObject({ name: 'workbox-core', license: 'MIT' });
    expect(workbox.text).toMatch(/^Copyright 2018 Google LLC/);
    expect(workbox.text).toContain('Permission is hereby granted');
    const vite = readPackageNotice(packageDir('vite', ROOT)!, 'helpers');
    expect(vite).toMatchObject({ name: 'vite', license: 'MIT', note: 'helpers' });
    expect(vite.text).toContain('Copyright (c) 2019-present, VoidZero Inc. and Vite contributors');
    expect(vite.text).not.toContain('Licenses of bundled dependencies');
    expect(packageDir('no-such-package-here', ROOT)).toBeUndefined();
  });

  it("ships an Apache-2.0 package's NOTICE file with its licence (Dexie)", () => {
    const dir = packageDir('dexie', ROOT)!;
    expect(readNoticeFile(dir)).toContain('Copyright (c) 2014-2017 David Fahlander');
    const dexie = readPackageNotice(dir);
    expect(dexie.text).toContain('Apache License');
    expect(noticeMarkdown(dexie)).toMatch(/Apache License[\s\S]*NOTICE file of the package:\n\nDexie\.js\n\nCopyright \(c\) 2014-2017 David Fahlander/);
    // In Vite's list, the entry gets the NOTICE appended.
    const out = completeNotices('# Licenses\n\n## dexie - 4.4.6 (Apache-2.0)\n\nApache License\n\n## preact - 10.0.0 (MIT)\n\nMIT\n', '# T', [], name =>
      name === 'dexie' ? 'Dexie.js\n\nCopyright (c) David Fahlander' : undefined,
    );
    expect(out).toBe(
      '# T\n\n## dexie - 4.4.6 (Apache-2.0)\n\nApache License\n\nNOTICE file of the package:\n\nDexie.js\n\nCopyright (c) David Fahlander\n\n## preact - 10.0.0 (MIT)\n\nMIT\n',
    );
    expect(readNoticeFile(packageDir('preact', ROOT)!)).toBeUndefined();
  });

  it("completes Vite's file: preamble first, Vite's entries, then the extra packages it lacks", () => {
    const vite = '# Licenses\n\nThe app bundles dependencies which contain the following licenses:\n\n## preact - 10.0.0 (MIT)\n\nMIT text\n';
    const out = completeNotices(vite, '# Third-party licences\n\nIntro.', [
      { name: 'preact', version: '10.0.0', license: 'MIT', text: 'duplicate' },
      { name: 'workbox-core', version: '7.4.1', license: 'MIT', text: 'Copyright 2018 Google LLC', note: 'service worker' },
    ]);
    expect(out).toBe(
      '# Third-party licences\n\nIntro.\n\n## preact - 10.0.0 (MIT)\n\nMIT text\n\n## workbox-core - 7.4.1 (MIT)\n\n*service worker*\n\nCopyright 2018 Google LLC\n',
    );
    expect(noticeMarkdown({ name: 'x', version: '1.0.0' })).toBe('## x - 1.0.0');
  });
});
