#!/usr/bin/env node
// Renders public/icon.svg to the PNG app icons with Playwright's Chromium:
//   public/icon-192.png, public/icon-512.png          (purpose "any": the SVG as drawn, transparent corners)
//   public/icon-maskable-512.png                     (purpose "maskable": full-bleed background, artwork
//                                                     scaled into the 80 % safe zone so no mask clips it)
// Usage: node scripts/build-icons.mjs   (needs a Playwright Chromium: `npx playwright install chromium`)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const svg = readFileSync(join(publicDir, 'icon.svg'));
const svgUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`;

/** Same colour as the SVG's background square and the manifest's background_color. */
const BACKGROUND = '#161512';
/** The safe zone is a centred circle with a radius of 40 % of the size (204.8 px at 512). At 0.875
 *  the board's corners sit 198 px from the centre, and every square lands on whole pixels (no seams). */
const MASKABLE_SCALE = 0.875;

const ICONS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

function html(size, maskable) {
  const inner = maskable ? Math.round(size * MASKABLE_SCALE) : size;
  const background = maskable ? BACKGROUND : 'transparent';
  return `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${background}">
<img src="${svgUrl}" width="${inner}" height="${inner}" alt=""></body></html>`;
}

const browser = await chromium.launch();
try {
  for (const { file, size, maskable } of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(html(size, maskable));
    await page.locator('img').evaluate(img => img.decode());
    const png = await page.screenshot({ omitBackground: !maskable, type: 'png' });
    writeFileSync(join(publicDir, file), png);
    console.log(`icons: ${file} (${size}×${size}, ${png.length} bytes)`);
    await page.close();
  }
} finally {
  await browser.close();
}
