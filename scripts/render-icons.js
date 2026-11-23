// Render every app icon from build/icon.svg (the master drawing):
//   build/icon.png                    Windows app / installer / tray icon
//   android/.../mipmap-*/ic_launcher*  phone launcher icons (square, round, adaptive)
//   android/.../drawable*/splash.png   phone start screens (icon on black)
// Needs Chromium through playwright-core, which is not a project dependency:
//   npm i --no-save playwright-core && node scripts/render-icons.js [path-to-chromium]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const root = path.join(__dirname, '..');
const RES = path.join(root, 'android/app/src/main/res');
const svg = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8');
// The artwork without its rounded dark square, for Android's adaptive icon.
const art = svg.replace(/<rect width="512" height="512"[^>]*\/>/, '');
const BG = '#1f2227'; // adaptive icon background (matches the drawing's dark square)

const page = (body, w, h, bg = 'transparent') => `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;background:${bg};display:grid;place-items:center;overflow:hidden">${body}</body></html>`;
const img = (src, size, extra = '') => `<img src="data:image/svg+xml;base64,${Buffer.from(src).toString('base64')}" style="width:${size}px;height:${size}px;${extra}">`;

(async () => {
  const browser = await chromium.launch(process.argv[2] ? { executablePath: process.argv[2] } : {});
  const p = await browser.newPage();
  async function render(file, html, w, h) {
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(html);
    await p.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  }
  await render(path.join(root, 'build/icon.png'), page(img(svg, 512), 512, 512), 512, 512);
  const dens = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, s] of Object.entries(dens)) {
    const dir = path.join(RES, `mipmap-${d}`);
    await render(path.join(dir, 'ic_launcher.png'), page(img(svg, s), s, s), s, s);
    const circle = `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${BG};display:grid;place-items:center">${img(art, Math.round(s * 0.78))}</div>`;
    await render(path.join(dir, 'ic_launcher_round.png'), page(circle, s, s), s, s);
    const f = Math.round(s * 108 / 48); // 108dp canvas; the artwork fills the 72dp safe zone
    await render(path.join(dir, 'ic_launcher_foreground.png'), page(img(art, Math.round(f * 72 / 108)), f, f), f, f);
  }
  fs.writeFileSync(path.join(RES, 'values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG.toUpperCase()}</color>\n</resources>\n`);
  for (const dir of fs.readdirSync(RES).filter((n) => n.startsWith('drawable'))) {
    const file = path.join(RES, dir, 'splash.png');
    if (!fs.existsSync(file)) continue;
    const b = fs.readFileSync(file);
    const w = b.readUInt32BE(16);
    const h = b.readUInt32BE(20);
    await render(file, page(img(svg, Math.round(Math.min(w, h) * 0.28)), w, h, '#000'), w, h);
  }
  await browser.close();
  console.log('icons written');
})();
