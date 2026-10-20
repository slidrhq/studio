// Converts and renders one variant in a headless browser, through the studio's render page
// (render.html), and keeps every view the page drew (`[data-snap]`). For a design:
//
//   node web/tools/snap.mjs --url <render page URL> --out <folder> [--channel msedge]
//
//   <folder>/<lang>-full.png    the slide at 1920×1080, for every language of the variant
//                               (he-full.png, en-full.png, ar-full.png, zh-CN-full.png…)
//   <folder>/<lang>-thumb.png   the gallery's thumbnail, 384 px wide
//   <folder>/result.json        the slides, findings, conversion notes, subject point
//
// For a template's sample in one language: `s01-full.png`, `s01-thumb.png`… for each slide,
// `sheet.png` with all of them small, and `result.json` with the findings slide by slide.
//
// The page's conversion engine compares its result with the HTML it converts, by pictures of the
// page: this script gives it real ones (`window.__slidrCapture`), as the app's capture window
// does, so a part that would not look the same stays `html` here exactly as in the app.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const url = option('--url');
const out = resolve(option('--out', '.'));
const channel = option('--channel', 'msedge');
// --blank: the engine gets blank pictures and accepts what it measured (as in a plain browser).
// --debug: every picture the engine asked for is kept as capture-<n>.png.
const blank = args.includes('--blank');
const debug = args.includes('--debug');
let captures = 0;
if (!url) {
  console.error('usage: snap.mjs --url <render page> --out <folder> [--channel msedge]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel, headless: true });
let failed = false;
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`console: ${message.text()}`);
  });
  if (!blank) {
    await page.exposeFunction('__slidrCapture', async (rect) => {
      const picture = await page.screenshot({
        clip: {
          x: rect.x,
          y: rect.y,
          width: Math.max(1, rect.width),
          height: Math.max(1, rect.height),
        },
        animations: 'disabled',
      });
      if (debug) writeFileSync(join(out, `capture-${(captures += 1)}.png`), picture);
      return picture.toString('base64');
    });
  }
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__snap?.done === true, null, { timeout: 200_000 });
  const snap = await page.evaluate(() => window.__snap);
  if (snap.error || !snap.result) {
    console.error(snap.error ?? 'The render page gave no result.');
    failed = true;
  } else {
    // Every view the page drew: a full-size slide and a thumbnail for each language it converted.
    const names = await page.$$eval('[data-snap]', (views) =>
      views.map((view) => view.getAttribute('data-snap')),
    );
    for (const name of names) {
      const view = page.locator(`[data-snap="${name}"]`);
      await view.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });
    }
    writeFileSync(join(out, 'result.json'), JSON.stringify(snap.result));
    const { langs, publishable } = snap.result;
    const counts = Object.entries(langs).map(
      ([lang, side]) => `${lang} ${side.error ? 'failed' : `${side.findings.length} findings`}`,
    );
    console.log(`rendered: publishable=${publishable}, ${counts.join(', ')}`);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
