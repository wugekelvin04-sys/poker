/* 统一改版本号：node tools/set-version.mjs v7
 * index.html 的资源查询串、sw.js 的缓存名、app.js 的显示版本必须完全一致，
 * 否则会出现「新 HTML + 旧 JS」这种缓存错配。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const v = process.argv[2];
if (!/^v\d+$/.test(v || '')) { console.error('用法: node tools/set-version.mjs v7'); process.exit(1); }

const ASSETS = ['style.css', 'engine.js', 'sim.js', 'app.js', 'manifest.webmanifest'];

let html = fs.readFileSync(root + '/index.html', 'utf8');
for (const a of ASSETS) {
  html = html.replace(new RegExp(a.replace('.', '\\.') + '(\\?v=v\\d+)?', 'g'), a + '?v=' + v);
}
fs.writeFileSync(root + '/index.html', html);

let sw = fs.readFileSync(root + '/sw.js', 'utf8');
sw = sw.replace(/const VERSION = 'v\d+';/, `const VERSION = '${v}';`);
fs.writeFileSync(root + '/sw.js', sw);

let app = fs.readFileSync(root + '/app.js', 'utf8');
app = app.replace(/var APP_VERSION = 'v\d+';/, `var APP_VERSION = '${v}';`);
fs.writeFileSync(root + '/app.js', app);

console.log('版本已统一为', v);
