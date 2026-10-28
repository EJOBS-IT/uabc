// Renders extension/static/icons/{16,32,48,128}.png from inline SVG with Playwright.
// Run: npm run icons
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'static', 'icons');
mkdirSync(outDir, { recursive: true });

const gradient = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#0d9488"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs>`;
const cursor = (s) => `<path transform="${s}" d="M0 0 L0 46 L11 35 L19 52 L28 48 L20 31 L35 31 Z"
  fill="#fff" stroke="#0b2559" stroke-width="3.5" stroke-linejoin="round"/>`;
// Large sizes: browser window + cursor. Small sizes: bold cursor only, so it stays legible.
const detailed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${gradient}
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#g)"/>
  <rect x="20" y="26" width="88" height="66" rx="10" fill="none" stroke="#fff" stroke-width="7" opacity=".92"/>
  <path d="M20 43 H108" stroke="#fff" stroke-width="6" opacity=".92"/>
  <circle cx="31" cy="34.5" r="3" fill="#fff"/><circle cx="41" cy="34.5" r="3" fill="#fff"/>
  ${cursor('translate(58 52) scale(1.05)')}</svg>`;
const simple = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${gradient}
  <rect x="0" y="0" width="128" height="128" rx="30" fill="url(#g)"/>
  ${cursor('translate(36 22) scale(1.75)')}</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  const svg = size <= 32 ? simple : detailed;
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
  await page.screenshot({ path: join(outDir, `${size}.png`), omitBackground: true });
  console.log(`icons/${size}.png`);
}
await browser.close();
