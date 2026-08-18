/* 生成 169 手起手牌的强度表：node tools/gen-preflop.mjs > preflop.js
 * 强度 = 对 1 名随机对手的胜率（这是起手牌排序的标准口径）。
 * 再按组合数加权算出「强于全部起手牌的前百分之几」。
 * AA 有 6 种组合、AKs 有 4 种、AKo 有 12 种，合计 1326 种。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
vm.runInThisContext(fs.readFileSync(root + '/engine.js', 'utf8'));
vm.runInThisContext(fs.readFileSync(root + '/sim.js', 'utf8'));
const E = globalThis.PokerEngine, S = globalThis.PokerSim;

const ITER = 500000;
const hands = [];

for (let hi = 12; hi >= 0; hi--) {
  for (let lo = hi; lo >= 0; lo--) {
    const kinds = hi === lo ? ['pair'] : ['s', 'o'];
    for (const kind of kinds) {
      let c1, c2, combos;
      if (kind === 'pair')   { c1 = (hi << 2) | 0; c2 = (hi << 2) | 1; combos = 6; }
      else if (kind === 's') { c1 = (hi << 2) | 0; c2 = (lo << 2) | 0; combos = 4; }
      else                   { c1 = (hi << 2) | 0; c2 = (lo << 2) | 1; combos = 12; }
      const r = S.simulate({ hero: [c1, c2], players: 2, maxIterations: ITER, timeLimitMs: 0 });
      // 索引：对子和不同花放 hi*13+lo，同花放 lo*13+hi
      const idx = (kind === 's') ? lo * 13 + hi : hi * 13 + lo;
      hands.push({ idx, hi, lo, kind, combos, eq: r.equity,
        name: E.RANK_CHARS[hi] + E.RANK_CHARS[lo] + (kind === 'pair' ? '' : kind) });
      process.stderr.write(`\r已算 ${hands.length}/169`);
    }
  }
}
process.stderr.write('\n');

hands.sort((a, b) => b.eq - a.eq);
const TOTAL = hands.reduce((s, h) => s + h.combos, 0);
if (TOTAL !== 1326) throw new Error('组合数不对: ' + TOTAL);

// 百分位 = 到这手牌为止的累计组合数占比，存千分数
const pct = new Array(169).fill(0);
let cum = 0;
for (const h of hands) { cum += h.combos; h.pctl = cum / TOTAL; pct[h.idx] = Math.round(h.pctl * 1000); }

const top = hands.slice(0, 12).map(h => `${h.name} ${(h.eq * 100).toFixed(1)}%`).join(', ');
const bottom = hands.slice(-5).map(h => `${h.name} ${(h.eq * 100).toFixed(1)}%`).join(', ');
process.stderr.write(`最强: ${top}\n最弱: ${bottom}\n`);
fs.writeFileSync(root + '/tools/preflop-detail.json', JSON.stringify(
  hands.map(h => ({ n: h.name, eq: +(h.eq * 100).toFixed(2), pctl: +(h.pctl * 100).toFixed(1) })), null, 1));

console.log(`/* 169 手起手牌的强度百分位（千分数，越小越强）。
 * 由 tools/gen-preflop.mjs 生成：各手牌对 1 名随机对手的胜率，
 * 每手 ${ITER.toLocaleString()} 次模拟，再按组合数加权累计。
 * 索引：对子与不同花为 hi*13+lo，同花为 lo*13+hi。 */
(function (global) {
  'use strict';
  var PCTL = [${pct.join(',')}];

  /* 返回这手牌处在全部起手牌的前百分之几（0-1） */
  function percentile(c1, c2) {
    var r1 = c1 >> 2, r2 = c2 >> 2;
    var hi = r1 > r2 ? r1 : r2, lo = r1 > r2 ? r2 : r1;
    var suited = (c1 & 3) === (c2 & 3);
    var idx = (hi !== lo && suited) ? lo * 13 + hi : hi * 13 + lo;
    return PCTL[idx] / 1000;
  }

  global.PokerPreflop = { percentile: percentile };
})(typeof self !== 'undefined' ? self : this);`);
