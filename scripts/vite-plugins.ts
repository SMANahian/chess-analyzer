// Build-only Vite plugins for the published app (GitHub Pages cannot send HTTP headers or ship anything
// but the files in dist/):
// - cspMeta: a Content-Security-Policy <meta> whose script hashes are computed from the final HTML, so
//   editing the inline script in index.html can never leave a stale hash behind.
// - licenseNotices: completes the licence file Vite writes (build.license) with what Vite does not see:
//   its own runtime helpers in the bundle, the service worker's Workbox code and the packages' NOTICE
//   files.
// scripts/check-dist.mjs verifies the result independently after every build.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

// ── Content-Security-Policy ───────────────────────────────────────────────

/** A CSP hash source for `text` (UTF-8), e.g. `'sha256-…'`. */
export function cspHash(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** HTML comments are not markup: a commented-out script neither runs nor needs a hash. */
const stripComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');

/** The text of every inline <script> (one without a src attribute), exactly as the browser hashes it. */
export function inlineScripts(html: string): string[] {
  return [...stripComments(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m => !/\ssrc\s*=/i.test(` ${m[1]}`))
    .map(m => m[2]!);
}

/** The text of every inline <style> element. */
export function inlineStyles(html: string): string[] {
  return [...stripComments(html).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(m => m[1]!);
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/** Decodes the character references an attribute value may contain (the browser hashes the decoded value). */
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (ref, body: string) => {
    if (body[0] === '#') return String.fromCodePoint(body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1)));
    const named = ENTITIES[body.toLowerCase()];
    if (named === undefined) throw new Error(`cspMeta: unsupported character reference ${ref} in a style attribute`);
    return named;
  });
}

/** The opening tags of the document (attributes included), outside comments and script/style bodies. */
function openingTags(html: string): string[] {
  const markup = stripComments(html).replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, '<$1$2>');
  return [...markup.matchAll(/<[a-z][^>]*>/gi)].map(m => m[0]);
}

/** The values of every style="…" attribute (the <noscript> message uses them). */
export function inlineStyleAttributes(html: string): string[] {
  return openingTags(html).flatMap(tag =>
    [...tag.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(m => decodeAttribute(m[1] ?? m[2] ?? '')),
  );
}

export interface CspOptions {
  /** Origins the app fetches from besides its own (the game APIs). */
  connectSrc: readonly string[];
}

/**
 * The policy for a page: only same-origin scripts plus the page's own inline scripts (by hash), workers
 * and the service worker from the same origin, fetches to the same origin and `connectSrc`, images from
 * the same origin and data: URIs (chessground's pieces), same-origin styles (Preact and chessground set
 * styles through the CSSOM, which style-src does not restrict) plus the page's own inline style
 * attributes by hash, no plugins, no <base>, no form submissions.
 */
export function contentSecurityPolicy(html: string, opts: CspOptions): string {
  const unique = (xs: string[]): string[] => [...new Set(xs)];
  const scripts = unique(inlineScripts(html).map(cspHash));
  const styles = unique(inlineStyles(html).map(cspHash));
  const styleAttrs = unique(inlineStyleAttributes(html).map(cspHash));
  const list = (...parts: string[]): string => parts.filter(Boolean).join(' ');
  return [
    `default-src 'self'`,
    `script-src ${list("'self'", ...scripts)}`,
    `worker-src 'self'`,
    `connect-src ${list("'self'", ...opts.connectSrc)}`,
    `img-src 'self' data:`,
    // 'unsafe-hashes' admits exactly the hashed style="…" values, nothing else.
    `style-src ${list("'self'", ...styles, ...(styleAttrs.length > 0 ? ["'unsafe-hashes'", ...styleAttrs] : []))}`,
    `font-src 'self'`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

/**
 * Adds the CSP <meta> to a page: right after <meta charset> when that opens the <head> (so the charset
 * stays in the first bytes), else as the first child of <head>, either way before anything that loads.
 * Throws on what the policy would break (inline event handlers, javascript: URLs) and on a page that
 * already has a policy.
 */
export function injectCsp(html: string, opts: CspOptions): string {
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/i.test(stripComments(html))) {
    throw new Error('cspMeta: the page already has a Content-Security-Policy <meta>');
  }
  for (const tag of openingTags(html)) {
    const handler = /\s(on[a-z]+)\s*=/i.exec(tag.replace(/"[^"]*"|'[^']*'/g, '""'));
    if (handler) throw new Error(`cspMeta: inline event handler ${handler[1]} in ${tag} would be blocked by the CSP`);
    if (/=\s*["']?\s*javascript:/i.test(tag)) throw new Error(`cspMeta: javascript: URL in ${tag} would be blocked by the CSP`);
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(html, opts)}" />`;
  const head = /<head\b[^>]*>(\s*<meta\s+charset\s*=[^>]*>)?/i.exec(html);
  if (!head) throw new Error('cspMeta: the page has no <head>');
  const at = head.index + head[0].length;
  const indent = /^[ \t]*\r?\n([ \t]*)/.exec(html.slice(at))?.[1] ?? '';
  return `${html.slice(0, at)}\n${indent}${meta}${html.slice(at)}`;
}

/** Build only: in dev, Vite injects <style> elements and its client script, which this policy would block. */
export function cspMeta(opts: CspOptions): Plugin {
  return {
    name: 'chess-analyzer:csp-meta',
    apply: 'build',
    enforce: 'post',
    // 'post' sees the final HTML: after Vite's asset tags and vite-plugin-pwa's manifest link.
    transformIndexHtml: { order: 'post', handler: html => injectCsp(html, opts) },
  };
}

// ── Licence notices ───────────────────────────────────────────────────────

export interface PackageNotice {
  name: string;
  version: string;
  license?: string;
  text?: string;
  /** The package's NOTICE file (Apache-2.0 §4(d): its attribution notices must ship too). */
  notice?: string;
  /** Why the package is listed although no bundled module comes from it. */
  note?: string;
}

const LICENSE_FILE = /^(licen[sc]e|copying)/i;
const NOTICE_FILE = /^notice(\.(md|txt))?$/i;

/** Finds `name` in node_modules, from `from` upwards. */
export function packageDir(name: string, from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The text of a package's NOTICE file, if it has one. */
export function readNoticeFile(dir: string): string | undefined {
  const file = readdirSync(dir).find(f => NOTICE_FILE.test(f));
  return file ? readFileSync(join(dir, file), 'utf8').trim() || undefined : undefined;
}

/** Name, version, licence identifier, licence text and NOTICE of an installed package. */
export function readPackageNotice(dir: string, note?: string): PackageNotice {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version?: string; license?: string };
  const file = readdirSync(dir).find(f => LICENSE_FILE.test(f));
  let text = file ? readFileSync(join(dir, file), 'utf8').trim() : undefined;
  // Vite's LICENSE.md appends the licences of the dependencies bundled into Vite itself (build-time
  // code, not shipped); only Vite's own licence applies to its helpers in the app.
  if (text && pkg.name === 'vite') text = text.split(/^# Licenses of bundled dependencies/m)[0]!.replace(/^# Vite core license\s*/m, '').trim();
  const notice = readNoticeFile(dir);
  return {
    name: pkg.name,
    version: pkg.version ?? '0.0.0',
    ...(pkg.license ? { license: pkg.license } : {}),
    ...(text ? { text } : {}),
    ...(notice ? { notice } : {}),
    ...(note ? { note } : {}),
  };
}

/** The node_modules packages a source map's sources come from. */
export function packagesInSourceMap(map: { sources?: (string | null)[] }): string[] {
  const names = new Set<string>();
  for (const source of map.sources ?? []) {
    if (!source) continue;
    const i = source.lastIndexOf('node_modules/');
    if (i < 0) continue;
    const [scope, name] = source.slice(i + 'node_modules/'.length).split('/');
    if (scope) names.add(scope.startsWith('@') && name ? `${scope}/${name}` : scope);
  }
  return [...names].sort();
}

const noticeBlock = (notice: string): string => `NOTICE file of the package:\n\n${notice}`;

/** One entry in the format Vite uses: `## name - version (licence)`, the licence text, then the NOTICE. */
export function noticeMarkdown(n: PackageNotice): string {
  const head = `## ${n.name} - ${n.version}${n.license ? ` (${n.license})` : ''}`;
  return [head, ...(n.note ? [`*${n.note}*`] : []), ...(n.text ? [n.text] : []), ...(n.notice ? [noticeBlock(n.notice)] : [])].join('\n\n');
}

/**
 * The shipped licence file: `preamble`, then Vite's list without its own title (it starts at the first
 * entry), each entry followed by the package's NOTICE (`noticeOf`; Vite only copies LICENSE files), then
 * the `extra` packages that Vite's list does not already contain.
 */
export function completeNotices(
  viteMarkdown: string,
  preamble: string,
  extra: readonly PackageNotice[],
  noticeOf: (name: string) => string | undefined = () => undefined,
): string {
  const listed = new Set<string>();
  const entries = viteMarkdown
    .split(/^## /m)
    .slice(1)
    .map(part => {
      const name = /^(.+?) - /.exec(part)?.[1];
      const notice = name === undefined ? undefined : noticeOf(name);
      if (name !== undefined) listed.add(name);
      return `## ${part.trim()}${notice ? `\n\n${noticeBlock(notice)}` : ''}`;
    });
  const added = extra.filter(n => !listed.has(n.name)).map(noticeMarkdown);
  return `${[preamble.trim(), ...entries, ...added].filter(Boolean).join('\n\n')}\n`;
}

export interface LicenseNoticesOptions {
  /** Must equal build.license.fileName. */
  fileName: string;
  /** Markdown put first: the app's own licence, where its source is, the files that carry their own. */
  preamble: string;
}

/**
 * After the build (and after vite-plugin-pwa has written the service worker), rewrites Vite's licence
 * file with the preamble, adds each package's NOTICE file (Dexie has one), and adds:
 * - Vite itself: its module-preload polyfill and preload helper are in the bundle, but Vite's list
 *   leaves out virtual modules;
 * - the Workbox packages in the service worker (read from its source map), and the AMD loader that
 *   workbox-build's bundler puts at the top of sw.js.
 * The file is not precached (workbox globPatterns has no .md), so changing it here is safe.
 */
export function licenseNotices(opts: LicenseNoticesOptions): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'chess-analyzer:license-notices',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      config = c;
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const outDir = resolve(config.root, config.build.outDir);
        const file = join(outDir, opts.fileName);
        if (!existsSync(file)) throw new Error(`licenseNotices: ${opts.fileName} was not written; set build.license.fileName to '${opts.fileName}'`);
        const find = (name: string, from = config.root): string => {
          const dir = packageDir(name, from);
          if (!dir) throw new Error(`licenseNotices: package ${name} not found`);
          return dir;
        };
        const extra: PackageNotice[] = [readPackageNotice(find('vite'), 'module preload polyfill and preload helper, bundled by the build')];
        const swMaps = readdirSync(outDir).filter(f => /^(sw|workbox-[\w-]+)\.js\.map$/.test(f));
        if (readdirSync(outDir).some(f => /^workbox-[\w-]+\.js$/.test(f)) && swMaps.length === 0) {
          throw new Error('licenseNotices: the service worker has no source map to list its packages from (build.sourcemap)');
        }
        const swPackages = [...new Set(swMaps.flatMap(f => packagesInSourceMap(JSON.parse(readFileSync(join(outDir, f), 'utf8')))))].sort();
        for (const name of swPackages) extra.push(readPackageNotice(find(name), 'service worker (sw.js, workbox-*.js)'));
        if (swMaps.length > 0) {
          const loader = '@trickfilm400/rollup-plugin-off-main-thread';
          extra.push(readPackageNotice(find(loader, find('workbox-build')), 'module loader at the top of sw.js'));
        }
        const noticeOf = (name: string): string | undefined => {
          const dir = packageDir(name, config.root);
          return dir ? readNoticeFile(dir) : undefined;
        };
        writeFileSync(file, completeNotices(readFileSync(file, 'utf8'), opts.preamble, extra, noticeOf));
      },
    },
  };
}
