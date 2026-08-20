/* 生成「面对加注范围」的起手牌排位表：node tools/gen-defend.mjs
 *
 * 现有的排位按「对随机牌的胜率」排，用来判断开不开池没问题，
 * 但拿它判断「面对加注该不该跟」是错的：小对子对随机牌很强、
 * 对加注范围却很弱（77 从 66.2% 掉到 49.1%），而 AK 几乎不掉（-1.7）。
 * 结果 77 排在 AKo 前面，面对 3-bet、4-bet 都会被判该跟。
 *
 * 这里改用「对前 20% 强牌范围的胜率」重排，并把两张表都写回 preflop.js。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
vm.runInThisContext(fs.readFileSync(root + '/engine.js', 'utf8'));
vm.runInThisContext(fs.readFileSync(root + '/sim.js', 'utf8'));
vm.runInThisContext(fs.readFileSync(root + '/preflop.js', 'utf8'));
const E = globalThis.PokerEngine, S = globalThis.PokerSim;

// 把现有的排位表原样取出来，稍后一起写回去
const src = fs.readFileSync(root + '/preflop.js', 'utf8');
const oldArr = src.match(/var PCTL = \[([^\]]+)\]/)[1];

const ITER = 120000, VS = 0.20;
const hands = [];
let done = 0;

for (let hi = 12; hi >= 0; hi--) {
  for (let lo = hi; lo >= 0; lo--) {
    for (const kind of (hi === lo ? ['pair'] : ['s', 'o'])) {
      let c1, c2, combos;
      if (kind === 'pair')   { c1 = (hi << 2) | 0; c2 = (hi << 2) | 1; combos = 6; }
      else if (kind === 's') { c1 = (hi << 2) | 0; c2 = (lo << 2) | 0; combos = 4; }
      else                   { c1 = (hi << 2) | 0; c2 = (lo << 2) | 1; combos = 12; }
      const r = S.simulate({ hero: [c1, c2], players: 2, maxIterations: ITER,
                             timeLimitMs: 0, oppMaxPctl: VS });
      const idx = (kind === 's') ? lo * 13 + hi : hi * 13 + lo;
      hands.push({ idx, combos, eq: r.equity,
        name: E.RANK_CHARS[hi] + E.RANK_CHARS[lo] + (kind === 'pair' ? '' : kind) });
      process.stderr.write(`\r已算 ${++done}/169`);
    }
  }
}
process.stderr.write('\n');

hands.sort((a, b) => b.eq - a.eq);
const TOTAL = hands.reduce((s, h) => s + h.combos, 0);
if (TOTAL !== 1326) throw new Error('组合数不对: ' + TOTAL);

const vs = new Array(169).fill(0);
let cum = 0;
for (const h of hands) { cum += h.combos; vs[h.idx] = Math.round(cum / TOTAL * 1000); }

process.stderr.write('最强 12 手: ' + hands.slice(0, 12).map(h => h.name).join(' ') + '\n');
const p77 = hands.findIndex(h => h.name === '77');
process.stderr.write(`77 排到第 ${p77 + 1} 位，前 ${(vs[6 * 13 + 6] / 10).toFixed(1)}%\n`);

fs.writeFileSync(root + '/preflop.js', `/* 169 手起手牌的两张强度百分位表（千分数，越小越强）。
 * 由 tools/gen-preflop.mjs 和 tools/gen-defend.mjs 生成。
 * 索引：对子与不同花为 hi*13+lo，同花为 lo*13+hi。
 *
 * PCTL   对 1 名随机对手的胜率排序。用于「要不要开池」——那时对手范围本就宽。
 * VSRAISE 对「前 20% 强牌范围」的胜率排序。用于「面对加注要不要跟」。
 *   两者差别很大：77 对随机牌 66.2%，对加注范围只有 49.1%（掉 17 个点），
 *   而 AKo 只掉 1.7 个点。用 PCTL 判断防守会把 77 排在 AKo 前面，
 *   导致面对 3-bet、4-bet 都建议跟注。
 */
(function (global) {
  'use strict';
  var PCTL = [${oldArr}];
  var VSRAISE = [${vs.join(',')}];

  function keyOf(c1, c2) {
    var r1 = c1 >> 2, r2 = c2 >> 2;
    var hi = r1 > r2 ? r1 : r2, lo = r1 > r2 ? r2 : r1;
    var suited = (c1 & 3) === (c2 & 3);
    return (hi !== lo && suited) ? lo * 13 + hi : hi * 13 + lo;
  }

  /* 这手牌处在全部起手牌的前百分之几（0-1），按对随机牌的胜率排 */
  function percentile(c1, c2) { return PCTL[keyOf(c1, c2)] / 1000; }

  /* 同上，但按「对前 20% 加注范围的胜率」排——面对加注时该用这个 */
  function vsRaise(c1, c2) { return VSRAISE[keyOf(c1, c2)] / 1000; }

  global.PokerPreflop = { percentile: percentile, vsRaise: vsRaise };
})(typeof self !== 'undefined' ? self : this);
`);
console.error('preflop.js 已更新，含两张表');
