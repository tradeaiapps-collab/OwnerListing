// Renders every app icon and store graphic from the SVG sources in brand/.
// Usage: node brand/build-icons.mjs   (needs the `playwright` package and a Chromium)
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PW_ROOT ? process.env.PW_ROOT + "/" : import.meta.url)("playwright");
import { readFileSync, writeFileSync } from "node:fs";
const NAVY = "#14213d", GOLD = "#d4b37a";
// House mark with a keyhole cut-out, drawn in a 1024 box, centred on (512,512), about 470 wide.
const mark = (fill, hole) => `<path d="M512 262 L277 468 V738 H747 V468 Z" fill="${fill}" stroke="${fill}" stroke-width="40" stroke-linejoin="round"/>
<circle cx="512" cy="552" r="52" fill="${hole}"/><path d="M486 576 H538 L556 686 H468 Z" fill="${hole}" stroke="${hole}" stroke-width="6" stroke-linejoin="round"/>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const full = (size, radius = 0) => svg(1024, 1024, `<rect width="1024" height="1024" rx="${radius}" fill="${NAVY}"/>${mark(GOLD, NAVY)}`);
// Transparent-background variants need a real cut-out, so use a mask instead of painting the hole.
const cut = (fill, k = 0.85) => svg(1024, 1024, `<defs><mask id="m"><rect width="1024" height="1024" fill="#fff"/><circle cx="512" cy="552" r="52" fill="#000"/><path d="M486 576 H538 L556 686 H468 Z" fill="#000" stroke="#000" stroke-width="6" stroke-linejoin="round"/></mask></defs><g transform="translate(512 512) scale(${k}) translate(-512 -512)"><g mask="url(#m)"><path d="M512 262 L277 468 V738 H747 V468 Z" fill="${fill}" stroke="${fill}" stroke-width="40" stroke-linejoin="round"/></g></g>`);
const feature = svg(1024, 500, `<rect width="1024" height="500" fill="${NAVY}"/><rect x="0" y="480" width="1024" height="20" fill="${GOLD}"/>
<g transform="translate(-56 0) scale(.5)">${mark(GOLD, NAVY)}</g>
<text x="400" y="235" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="76" fill="#fff">OwnerListing</text>
<text x="402" y="300" font-family="Inter, DejaVu Sans, sans-serif" font-size="32" fill="${GOLD}">Sell your own home.</text>
<text x="402" y="344" font-family="Inter, DejaVu Sans, sans-serif" font-size="32" fill="#c8d0e0">You decide every offer.</text>`);
const jobs = [
  ["brand/icon.svg", full(1024), null], ["brand/mark-gold.svg", cut(GOLD, 1), null], ["brand/mark-mono.svg", cut("#000", 1), null], ["brand/feature-graphic.svg", feature, null],
  ["mobile/assets/icon.png", full(1024), 1024, true], ["mobile/assets/adaptive-icon.png", cut(GOLD), 1024],
  ["mobile/assets/adaptive-icon-mono.png", cut("#000"), 1024], ["mobile/assets/adaptive-icon-background.png", svg(1024, 1024, `<rect width="1024" height="1024" fill="${NAVY}"/>`), 1024, true],
  ["mobile/assets/splash-icon.png", cut(GOLD, 1), 1024], ["mobile/assets/favicon.png", full(1024, 224), 48],
  ["public/icons/icon-512.png", full(1024, 224), 512], ["public/icons/icon-192.png", full(1024, 224), 192],
  ["public/icons/icon-maskable-512.png", full(1024), 512, true], ["public/icons/apple-touch-icon.png", full(1024), 180, true],
  ["public/icons/favicon-32.png", full(1024, 224), 32], ["public/icons/icon.svg", full(1024, 224), null],
  ["store-assets/play-icon-512.png", full(1024), 512, true], ["store-assets/app-store-icon-1024.png", full(1024), 1024, true],
  ["store-assets/play-feature-graphic-1024x500.png", feature, "feature"],
];
const browser = await chromium.launch(); const page = await browser.newPage();
for (const [path, s, size, opaque] of jobs) {
  writeFileSync(path.endsWith(".svg") ? path : path.replace(/\.png$/, ".tmp.svg"), s);
  if (path.endsWith(".svg")) continue;
  const [w, h] = size === "feature" ? [1024, 500] : [size, size];
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0;background:transparent"><img style="width:${w}px;height:${h}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}"></body>`);
  await page.waitForTimeout(150);
  await page.screenshot({ path, omitBackground: !opaque && size !== "feature", clip: { x: 0, y: 0, width: w, height: h } });
}
await browser.close();
