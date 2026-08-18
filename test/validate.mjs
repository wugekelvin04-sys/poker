/* 数值验证：node test/validate.mjs
 * 1) 全量 5 张牌牌型分布对照教科书数字（独立于本实现的真值）
 * 2) 不同分值个数须为 7462（校验踢脚打包无碰撞、无虚假区分）
 * 3) 精确枚举 vs 蒙特卡洛，校验采样无偏
 * 4) 公认起手牌胜率对照
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
vm.runInThisContext(fs.readFileSync(root + '/engine.js', 'utf8'));
vm.runInThisContext(fs.readFileSync(root + '/sim.js', 'utf8'));
const E = globalThis.PokerEngine, S = globalThis.PokerSim;
const { evalHand, parseCards } = E;

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail++; };
const pct = (x) => (x * 100).toFixed(2) + '%';

// ---------- 1. 全量 5 张牌的牌型分布 ----------
console.log('\n1. 枚举全部 C(52,5)=2,598,960 手，对照公认牌型频数');
const EXPECTED = [
  ['高牌',   1302540], ['一对',   1098240], ['两对',    123552],
  ['三条',     54912], ['顺子',     10200], ['同花',      5108],
  ['葫芦',      3744], ['四条',       624], ['同花顺',      40],
];
{
  const counts = new Array(9).fill(0);
  const distinct = new Set();
  const h = new Int32Array(5);
  let total = 0;
  for (let a = 0; a < 48; a++) { h[0] = a;
    for (let b = a + 1; b < 49; b++) { h[1] = b;
      for (let c = b + 1; c < 50; c++) { h[2] = c;
        for (let d = c + 1; d < 51; d++) { h[3] = d;
          for (let e = d + 1; e < 52; e++) { h[4] = e;
            const sc = evalHand(h, 5);
            counts[sc >>> 20]++; distinct.add(sc); total++;
          }}}}}
  ok(total === 2598960, `枚举总数 ${total.toLocaleString()} = 2,598,960`);
  EXPECTED.forEach(([name, exp], i) =>
    ok(counts[i] === exp, `${name.padEnd(4, '　')} ${String(counts[i]).padStart(9)} 应为 ${exp.toLocaleString()}`));
  ok(distinct.size === 7462, `不同分值个数 ${distinct.size} 应为 7462（德州扑克 5 张牌的等价类数量）`);
}

// ---------- 2. 精确枚举 vs 蒙特卡洛（河牌单挑）----------
console.log('\n2. 河牌单挑：精确枚举 vs 蒙特卡洛 30 万次');
{
  const hero = parseCards('Ah Kh'), board = parseCards('Qh Jc 2s 7d 3h');
  const ex = S.enumerateShowdownHeadsUp(hero, board);
  const mc = S.simulate({ hero, board, players: 2, maxIterations: 300000, timeLimitMs: 0 });
  const diff = Math.abs(ex.equity - mc.equity);
  console.log(`    精确 ${pct(ex.equity)}（枚举 ${ex.n} 种）  蒙特卡洛 ${pct(mc.equity)}  偏差 ${pct(diff)}`);
  ok(diff < 0.005, `偏差 ${pct(diff)} 应小于 0.5%`);
}

// ---------- 3. 精确枚举 vs 蒙特卡洛（翻牌单挑，1,070,190 种组合）----------
console.log('\n3. 翻牌单挑：精确枚举 vs 蒙特卡洛 30 万次');
{
  const hero = parseCards('Ah Kh'), board = parseCards('Qh Jc 2s');
  const deck = S.buildDeck(hero.concat(board));
  const h7 = new Int32Array(7), o7 = new Int32Array(7);
  h7[0] = hero[0]; h7[1] = hero[1]; h7[2] = board[0]; h7[3] = board[1]; h7[4] = board[2];
  o7[2] = board[0]; o7[3] = board[1]; o7[4] = board[2];
  let win = 0, tie = 0, lose = 0, total = 0;
  for (let i = 0; i < deck.length; i++) {
    h7[5] = deck[i]; o7[5] = deck[i];
    for (let j = i + 1; j < deck.length; j++) {
      h7[6] = deck[j]; o7[6] = deck[j];
      const hs = evalHand(h7, 7);
      // 对手两张牌取自剩余 45 张
      for (let x = 0; x < deck.length; x++) {
        if (x === i || x === j) continue;
        o7[0] = deck[x];
        for (let y = x + 1; y < deck.length; y++) {
          if (y === i || y === j) continue;
          o7[1] = deck[y];
          const os = evalHand(o7, 7);
          if (hs > os) win++; else if (hs < os) lose++; else tie++;
          total++;
        }
      }
    }
  }
  const exEq = (win + tie / 2) / total;
  const mc = S.simulate({ hero, board, players: 2, maxIterations: 300000, timeLimitMs: 0 });
  const diff = Math.abs(exEq - mc.equity);
  console.log(`    精确 ${pct(exEq)}（枚举 ${total.toLocaleString()} 种）  蒙特卡洛 ${pct(mc.equity)}  偏差 ${pct(diff)}`);
  ok(total === 1070190, `枚举组合数 ${total.toLocaleString()} 应为 1,070,190`);
  ok(diff < 0.005, `偏差 ${pct(diff)} 应小于 0.5%`);
}

// ---------- 4. 公认起手牌胜率 ----------
console.log('\n4. 对照公认翻牌前胜率（各 50 万次模拟，容差 ±1%）');
const BENCH = [
  ['AA  对 1 名随机对手', 'Ah Ad', 2, 0.852],
  ['AKs 对 1 名随机对手', 'Ah Kh', 2, 0.670],
  ['72o 对 1 名随机对手', '7h 2d', 2, 0.346],
  ['AA  对 8 名随机对手', 'Ah Ad', 9, 0.346],
  ['AA  对 9 名随机对手', 'Ah Ad', 10, 0.311],
  ['KK  对 1 名随机对手', 'Kh Kd', 2, 0.823],
];
for (const [name, cards, players, expect] of BENCH) {
  const r = S.simulate({ hero: parseCards(cards), players, maxIterations: 500000, timeLimitMs: 0 });
  const diff = Math.abs(r.equity - expect);
  console.log(`    ${name}: ${pct(r.equity)}  公认 ${pct(expect)}  偏差 ${pct(diff)}`);
  ok(diff < 0.01, `${name} 偏差应小于 1%`);
}

// ---------- 5. 一致性 ----------
console.log('\n5. 一致性检查');
{
  const r = S.simulate({ hero: parseCards('Ah Ad'), players: 6, maxIterations: 100000, timeLimitMs: 0 });
  ok(Math.abs(r.winRate + r.tieRate + r.loseRate - 1) < 1e-9, '胜/平/负三者相加为 1');
  ok(Math.abs(r.catCounts.reduce((a, b) => a + b, 0) - 1) < 1e-9, '牌型分布相加为 1');
  let prev = 1;
  const eqs = [];
  for (let p = 2; p <= 9; p++) {
    const x = S.simulate({ hero: parseCards('Ah Ad'), players: p, maxIterations: 60000, timeLimitMs: 0 });
    eqs.push(pct(x.equity));
    if (x.equity > prev) fail++;
    prev = x.equity;
  }
  console.log(`    AA 随人数递增: ${eqs.join(' → ')}`);
  ok(true, '胜率随人数单调下降');
}

console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过');
process.exit(fail ? 1 : 0);
