/* 生成 PWA 图标：SVG → headless Chrome 截图 → PNG
 * 用法：node tools/make-icons.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** @param {number} scale 内容缩放，maskable 图标需留出安全边距 */
function svg(scale = 1) {
  const card = (rot, dx, suit, color) => `
    <g transform="rotate(${rot} 256 256) translate(${dx} 0)">
      <rect x="178" y="146" width="156" height="220" rx="19" fill="#f7f8fa"
            stroke="#c9d0da" stroke-width="2"/>
      <text x="196" y="196" font-family="Helvetica Neue,Helvetica,Arial" font-size="52"
            font-weight="700" fill="${color}">A</text>
      <text x="256" y="300" font-family="Helvetica Neue,Helvetica,Arial" font-size="112"
            text-anchor="middle" fill="${color}">${suit}</text>
    </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="34%" r="72%">
      <stop offset="0%" stop-color="#1d2534"/><stop offset="100%" stop-color="#0b0e13"/>
    </radialGradient>
    <filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)" filter="url(#sh)">
    ${card(-15, -46, '♥', '#d22a35')}
    ${card(11, 40, '♠', '#141a22')}
  </g>
</svg>`;
}

function render(svgText, size, out) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'));
  const html = path.join(tmp, 'i.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>
${svgText}`);
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--window-size=${size},${size}`,
    `--screenshot=${out}`,
    'file://' + html
  ], { stdio: 'pipe' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  ${path.basename(out)}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
}

fs.mkdirSync(root + '/icons', { recursive: true });
console.log('生成图标：');
for (const size of [180, 192, 512]) render(svg(1), size, `${root}/icons/icon-${size}.png`);
render(svg(0.68), 512, `${root}/icons/icon-maskable-512.png`);  // maskable 留安全区
fs.writeFileSync(root + '/icons/icon.svg', svg(1));
console.log('完成');
