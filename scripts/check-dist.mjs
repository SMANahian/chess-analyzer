// Checks a production build before it is tested or published (`npm run build` runs it on dist/):
// - index.html carries a Content-Security-Policy <meta> before anything loads, and that policy allows
//   each inline script by its hash (a stale hash would silently block the script);
// - THIRD-PARTY-LICENSES.md has a section with licence text (and NOTICE file, if any) for every package
//   whose code is in a bundle (read from the source maps, the service worker's included), and the
//   engine's GPL text ships;
// - the web manifest's maskable icon is a file of its own, not one of the regular icons.
// Usage: node scripts/check-dist.mjs [dist-dir]   (exit code 1 and a list of problems on failure)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LICENSES_FILE = 'THIRD-PARTY-LICENSES.md';

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sha256 = text => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

function checkCsp(dir, problems) {
  const html = readFileSync(join(dir, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const metas = [...html.matchAll(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi)];
  if (metas.length !== 1) {
    problems.push(`index.html: expected one Content-Security-Policy <meta>, found ${metas.length}`);
    return;
  }
  const meta = metas[0];
  const firstLoad = html.search(/<(script|link|style)\b/i);
  if (firstLoad >= 0 && firstLoad < meta.index) problems.push('index.html: the CSP <meta> comes after a <script>, <link> or <style>');
  const policy = /content="([^"]*)"/i.exec(meta[0])?.[1] ?? '';
  const directive = name => policy.split(';').map(d => d.trim().split(/\s+/)).find(d => d[0] === name)?.slice(1) ?? [];
  const scriptSrc = directive('script-src');
  if (scriptSrc.length === 0) problems.push('index.html: the CSP has no script-src');
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", '*']) {
    if (scriptSrc.includes(bad)) problems.push(`index.html: script-src allows ${bad}`);
  }
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc=/i.test(` ${m[1]}`)) continue;
    if (!scriptSrc.includes(sha256(m[2]))) problems.push(`index.html: the CSP does not allow the inline script starting "${m[2].trim().slice(0, 50)}…" (hash ${sha256(m[2])})`);
  }
}

/** The bodies of the `## name - version` sections, by package name. */
function licenceSections(markdown) {
  const sections = new Map();
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const name = /^(.+?) - /.exec(part)?.[1];
    if (name) sections.set(name, part.slice(part.indexOf('\n')).trim());
  }
  return sections;
}

function bundledPackages(dir) {
  const packages = new Map(); // name → bundle files using it
  for (const file of walk(dir).filter(f => f.endsWith('.js.map'))) {
    const { sources = [] } = JSON.parse(readFileSync(file, 'utf8'));
    for (const source of sources) {
      const i = source?.lastIndexOf('node_modules/') ?? -1;
      if (i < 0) continue;
      const [scope, name] = source.slice(i + 'node_modules/'.length).split('/');
      const pkg = scope.startsWith('@') ? `${scope}/${name}` : scope;
      packages.set(pkg, [...new Set([...(packages.get(pkg) ?? []), relative(dir, file).replace(/\.map$/, '')])]);
    }
  }
  return packages;
}

/** The NOTICE file text of an installed package (looked up from `root` upwards), if it has one. */
function packageNotice(name, root) {
  for (let base = resolve(root); ; base = dirname(base)) {
    const pkg = join(base, 'node_modules', name);
    if (existsSync(join(pkg, 'package.json'))) {
      const file = readdirSync(pkg).find(f => /^notice(\.(md|txt))?$/i.test(f));
      return file ? readFileSync(join(pkg, file), 'utf8').trim() : undefined;
    }
    if (dirname(base) === base) return undefined;
  }
}

function checkLicences(dir, root, problems) {
  const file = join(dir, LICENSES_FILE);
  if (!existsSync(file)) {
    problems.push(`${LICENSES_FILE} is missing`);
    return;
  }
  const sections = licenceSections(readFileSync(file, 'utf8'));
  const packages = bundledPackages(dir);
  if (packages.size === 0) problems.push('no source maps with node_modules sources: cannot tell which packages are bundled (build.sourcemap)');
  for (const [name, files] of packages) {
    const body = sections.get(name);
    if (body === undefined) problems.push(`${LICENSES_FILE}: no section for ${name} (bundled in ${files.join(', ')})`);
    else if (!/licen[sc]e|permission is hereby granted/i.test(body)) problems.push(`${LICENSES_FILE}: the section for ${name} has no licence text`);
    else {
      const notice = packageNotice(name, root);
      if (notice && !body.includes(notice)) problems.push(`${LICENSES_FILE}: the section for ${name} lacks the package's NOTICE file`);
    }
  }
  if (!existsSync(join(dir, 'engine', 'COPYING.txt'))) problems.push('engine/COPYING.txt (the engine\'s GPL text) is missing');
}

function checkManifest(dir, problems) {
  const file = join(dir, 'manifest.webmanifest');
  if (!existsSync(file)) {
    problems.push('manifest.webmanifest is missing');
    return;
  }
  const icons = JSON.parse(readFileSync(file, 'utf8')).icons ?? [];
  const purposes = icon => (icon.purpose ?? 'any').split(/\s+/);
  const maskable = icons.filter(i => purposes(i).includes('maskable'));
  const regular = new Set(icons.filter(i => purposes(i).includes('any')).map(i => i.src));
  if (maskable.length === 0) problems.push('manifest.webmanifest: no maskable icon');
  for (const icon of maskable) {
    if (regular.has(icon.src)) problems.push(`manifest.webmanifest: the maskable icon ${icon.src} is also a regular icon (maskable artwork needs its own safe-zone file)`);
    if (!existsSync(join(dir, icon.src))) problems.push(`manifest.webmanifest: the maskable icon ${icon.src} is not in the build`);
  }
}

/** Every problem found in the build at `dir` ([] when it is fine); packages are looked up from `root`. */
export function checkDist(dir, { root = process.cwd() } = {}) {
  if (!existsSync(join(dir, 'index.html'))) return [`${dir} has no index.html (build first)`];
  const problems = [];
  checkCsp(dir, problems);
  checkLicences(dir, root, problems);
  checkManifest(dir, problems);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'dist';
  const problems = checkDist(dir);
  if (problems.length > 0) {
    console.error(`check-dist: ${problems.length} problem(s) in ${dir}:\n${problems.map(p => `- ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`check-dist: ${dir} OK (CSP hashes, licence notices, manifest icons)`);
}
