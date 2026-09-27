// Build the web assets for the Android app into www/:
// the shared renderer (src/renderer) + the Capacitor platform layer (src/mobile).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const www = path.join(root, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(root, 'src', 'renderer'), www, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'mobile', 'platform.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  outfile: path.join(www, 'platform.js'),
});

const indexFile = path.join(www, 'index.html');
const html = fs.readFileSync(indexFile, 'utf8');
const tag = '<script src="app.js"></script>';
if (!html.includes(tag)) throw new Error('app.js script tag not found in index.html');
fs.writeFileSync(indexFile, html.replace(tag, `<script src="platform.js"></script>\n  ${tag}`));
console.log('www/ built');
