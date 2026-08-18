/* 引擎正确性测试：node test/engine.test.mjs */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
vm.runInThisContext(fs.readFileSync(root + '/engine.js', 'utf8'));
const E = globalThis.PokerEngine;
const { evalHand, parseCards, describe: desc } = E;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
}
function section(name) { console.log('\n' + name); }
const ev = (s) => evalHand(parseCards(s));

// ---------- 1. 牌型等级排序 ----------
section('1. 牌型等级排序');
const ladder = [
  ['高牌',   'Ah Kd 9c 7s 4h'],
  ['一对',   '2h 2d 9c 7s 4h'],
  ['两对',   '2h 2d 3c 3s 4h'],
  ['三条',   '2h 2d 2c 7s 4h'],
  ['顺子',   '2h 3d 4c 5s 6h'],
  ['同花',   '2h 5h 7h 9h Jh'],
  ['葫芦',   '2h 2d 2c 7s 7h'],
  ['四条',   '2h 2d 2c 2s 7h'],
  ['同花顺', '2h 3h 4h 5h 6h'],
];
for (let i = 1; i < ladder.length; i++) {
  const [nameA, a] = ladder[i - 1], [nameB, b] = ladder[i];
  ok(ev(b) > ev(a), `${nameB} 应当大于 ${nameA}`);
}
ladder.forEach(([name, cards], i) => {
  ok(E.category(ev(cards)) === i, `${cards} 应被识别为等级 ${i}(${name})，实得 ${E.category(ev(cards))}`);
});

// ---------- 2. 边界情形 ----------
section('2. 边界情形');
// 轮子顺 A-2-3-4-5，顶张是 5，应输给 6 高顺
ok(ev('Ah 2d 3c 4s 5h') < ev('2h 3d 4c 5s 6h'), '轮子顺 A2345 应小于 6 高顺');
ok(desc(ev('Ah 2d 3c 4s 5h')) === '顺子 5 高', '轮子顺描述应为「顺子 5 高」，实得 ' + desc(ev('Ah 2d 3c 4s 5h')));
// 轮子同花顺
ok(E.category(ev('Ah 2h 3h 4h 5h')) === 8, 'A2345 同花应识别为同花顺');
ok(ev('Ah 2h 3h 4h 5h') < ev('2s 3s 4s 5s 6s'), '轮子同花顺应小于 6 高同花顺');
// 皇家同花顺
ok(desc(ev('Th Jh Qh Kh Ah')) === '皇家同花顺', '皇家同花顺识别');
// A 高同花 > K 高同花
ok(ev('Ah 5h 7h 9h Jh') > ev('Kh 5h 7h 9h Jh'), 'A 高同花应大于 K 高同花');
// 顺子不能绕回 K-A-2-3-4
ok(E.category(ev('Kh Ad 2c 3s 4h')) !== 4, 'K-A-2-3-4 不构成顺子');
// 7 张里选出最优 5 张：三条 + 一对 = 葫芦
ok(E.category(ev('2h 2d 2c 7s 7h Ah Kd')) === 6, '7 张应选出葫芦');
// 7 张里 6 张同花时取最高 5 张
ok(desc(ev('2h 3h 4h 6h 8h Th Ad')) === '同花 T 高', '6 张同花应取最高 5 张，实得 ' + desc(ev('2h 3h 4h 6h 8h Th Ad')));
// 四条 + 三条（7 张）应判四条，踢脚为三条那张
ok(E.category(ev('9h 9d 9c 9s 7h 7d 7c')) === 7, '四条 + 三条应判四条');
ok(desc(ev('9h 9d 9c 9s 7h 7d 7c')) === '四条 9', '四条描述');
// 两组三条 → 葫芦，取大三条 + 小三条当对子
ok(desc(ev('9h 9d 9c 7s 7h 7d 2c')) === '葫芦 9 带 7', '两组三条应组成 葫芦 9 带 7，实得 ' + desc(ev('9h 9d 9c 7s 7h 7d 2c')));
// 三对 → 取最大两对 + 最高踢脚
ok(desc(ev('9h 9d 7c 7s 5h 5d Ac')) === '两对 9 7', '三对应取最大两对，实得 ' + desc(ev('9h 9d 7c 7s 5h 5d Ac')));

// ---------- 3. 踢脚比较 ----------
section('3. 踢脚比较');
ok(ev('Ah Ad Kc 7s 4h') > ev('Ah Ad Qc 7s 4h'), '一对 A 带 K 应大于带 Q');
ok(ev('Ah Ad Kc 7s 4h') > ev('Ah Ad Kc 7s 3h'), '第 3 踢脚也应参与比较');
ok(ev('Ah Ad Kc 7s 4h') === ev('As Ac Kd 7h 4d'), '仅花色不同应完全平局');
ok(ev('Ah Ad Kc Ks 4h') > ev('Ah Ad Qc Qs 4h'), '两对 A/K 应大于两对 A/Q');
ok(ev('9h 9d 9c As Kh') > ev('9h 9d 9c As Qh'), '三条踢脚比较');
ok(ev('Ah Kd Qc Js 9h') > ev('Ah Kd Qc Js 8h'), '高牌第 5 张也参与比较');
// 公共牌一样时，两人靠踢脚分胜负
ok(ev('Ah 2d Qc Jh 9s 5c 3d') > ev('Kh 2s Qc Jh 9s 5c 3d'), '同公共牌下 A 高踢脚胜 K 高');

// ---------- 4. 张数少于 5 张 ----------
section('4. 少于 5 张（翻牌前显示用）');
ok(E.category(evalHand(parseCards('Ah Ad'))) === 1, '两张 AA 应识别为一对');
ok(E.category(evalHand(parseCards('Ah Kd'))) === 0, '两张 AK 应识别为高牌');
ok(ev('Ah Ad Kc') > ev('Kh Kd Ac'), '一对 A 大于一对 K（3 张）');

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
