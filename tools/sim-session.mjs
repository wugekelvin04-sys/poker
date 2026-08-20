/* 让「行动建议」的算法真的去打牌，看长期是赚是赔。
 *
 *   node tools/sim-session.mjs [手数] [对手类型]
 *
 * 8 人桌，盲注 1/2，每人带入 200（100BB），筹码低于一个大盲就补满 200。
 * 英雄用 app.js 里那套决策规则；对手用几种规则型玩家，可切换。
 *
 * 结果用 BB/100 衡量（每 100 手赢多少个大盲），这是扑克界的标准口径。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
vm.runInThisContext(fs.readFileSync(root + '/engine.js', 'utf8'));
vm.runInThisContext(fs.readFileSync(root + '/sim.js', 'utf8'));
vm.runInThisContext(fs.readFileSync(root + '/preflop.js', 'utf8'));
const E = globalThis.PokerEngine, S = globalThis.PokerSim, PF = globalThis.PokerPreflop;

const HANDS = parseInt(process.argv[2] || '100000', 10);
const OPP_KIND = process.argv[3] || 'amateur';
const HERO_KIND = process.argv[4] || 'algo';   // algo = 本 App 的算法；其余按规则型玩家打
/* 实验开关：
   range  面对下注时，只从前 30% 的强牌里给对手发牌（现版本是随机牌）
   edgy   「临界」判为弃牌（现版本判为跟注） */
const OPTS = (process.argv[5] || '').split(',').filter(Boolean);
const RANGE_OPT = OPTS.find(o => o.startsWith('range'));
const RANGE_PCT = RANGE_OPT ? (parseFloat(RANGE_OPT.split('=')[1]) || 0.30) : 0;
const USE_RANGE = !!RANGE_OPT;
const FOLD_MARGINAL = OPTS.includes('edgy');
/* bluff=P  该过牌时以 P 的频率半诈唬下注（只在单挑、且手上有点底子时）
   catch=Q  该弃牌但只差一点时，以 Q 的频率抓偷鸡跟一手（只在单挑） */
const numOpt = (k, dflt) => {
  const o = OPTS.find(x => x.startsWith(k));
  return o ? (parseFloat(o.split('=')[1]) || dflt) : 0;
};
const FREE_BLIND = OPTS.includes('freeblind');   // 留一个对手（大盲）不受范围限制
const BLUFF = numOpt('bluff', 0.25);
const CATCH = numOpt('catch', 0.30);
const N = 8, BB = 2, SB = 1, BUYIN = 200;

// ---------------- 随机数 ----------------
const rng = S.makeRng(20260819);
const rnd = () => rng();

// ---------------- 位置 ----------------
/* 与 app.js 的 posCycle 同一套分桶：非盲注非庄位的座位按行动顺序是
   前位…中位…后位(CO)，庄位单列，盲注单列。 */
function seatLabels(n) {
  if (n <= 2) return ['btn', 'bb'];
  const mids = n - 3;
  const bucket = [];
  if (mids >= 1) {
    const rest = mids - 1;
    const m = Math.ceil(rest / 2), e = rest - m;
    for (let i = 0; i < e; i++) bucket.push('early');
    for (let i = 0; i < m; i++) bucket.push('mid');
    bucket.push('late');
  }
  // 下标 0 = 庄位，1 = 小盲，2 = 大盲，3.. = 行动顺序上的其余座位
  return ['btn', 'sb', 'bb', ...bucket];
}
const LABELS = seatLabels(N);
const posOf = (seat, btn) => LABELS[(seat - btn + N) % N];

// ---------------- 英雄的决策规则（镜像 app.js） ----------------
const OPEN_RANGE = {
  short: { early: 0.16, mid: 0.21, late: 0.28, btn: 0.45, sb: 0.42 },
  full:  { early: 0.11, mid: 0.16, late: 0.24, btn: 0.42, sb: 0.40 }
};
const openRange = (pos, n) => (n >= 7 ? OPEN_RANGE.full : OPEN_RANGE.short)[pos] || 0.21;

/* o = { preflop, pos, pctl, potNow, call, playersLeft, equity } */
function heroPolicy(o) {
  const eq = o.equity, fair = 1 / o.playersLeft, ratio = eq / fair;
  const heads = o.playersLeft === 2;   // 只剩一个对手。多人底池里诈唬基本是送钱

  if (o.preflop && o.call <= 0) {
    if (o.pos === 'bb') return { act: 'check' };
    const open = openRange(o.pos, N);
    if (o.pctl <= open) return { act: 'raise', to: (o.pos === 'sb' ? 3 : 2.5) * BB };
    return { act: 'fold' };                       // 含「边缘」，app 的默认读法是弃
  }
  if (o.call <= 0) {
    if (ratio >= 2)   return { act: 'bet', amount: o.potNow * 0.75 };
    if (ratio >= 1.3) return { act: 'bet', amount: o.potNow * 0.5 };
    // 半诈唬：单挑、手上还有点底子（能听牌或有摊牌价值）时才偷
    if (BLUFF && heads && !o.preflop && eq >= 0.20 && rnd() < BLUFF)
      return { act: 'bet', amount: o.potNow * 0.5 };
    return { act: 'check' };
  }
  const required = o.call / (o.potNow + o.call);
  const edge = eq - required;
  if (edge < -0.02) {
    // 抓偷鸡：只差一点、又是单挑，对手有可能在偷，按一定频率跟一手
    if (CATCH && heads && !o.preflop && edge >= -0.10 && rnd() < CATCH) return { act: 'call' };
    return { act: 'fold' };
  }
  if (edge < 0.02)  return FOLD_MARGINAL ? { act: 'fold' } : { act: 'call' };
  if (eq >= 1.6 * fair && edge >= 0.15)
    return { act: 'raise', to: o.call + 0.7 * (o.potNow + o.call) };
  return { act: 'call' };
}

// ---------------- 对手 ----------------
/* 三种规则型玩家。都不做诈唬，靠牌力和赔率决策。 */
const OPPS = {
  // 松被动：入池宽、很少加注、拿到一对就跟到底
  amateur:  { openPct: 0.40, callPct: 0.30, threePct: 0.03, callMaxPotFrac: 0.9, betCat: 2, betSize: 0.6 },
  // 跟注站：几乎什么都跟，从不主动施压
  station:  { openPct: 0.55, callPct: 0.60, threePct: 0.00, callMaxPotFrac: 2.0, betCat: 6, betSize: 0.5 },
  // 紧凶：范围紧、有牌就打，但从不诈唬
  tag:      { openPct: 0.18, callPct: 0.12, threePct: 0.04, callMaxPotFrac: 0.5, betCat: 1, betSize: 0.7 },
  // 高手：范围紧、该弃就弃，而且会偷鸡——只有这种对手才测得出诈唬和抓偷鸡的价值
  pro:      { openPct: 0.20, callPct: 0.13, threePct: 0.045, callMaxPotFrac: 0.5, betCat: 1, betSize: 0.7,
              bluff: 0.30, foldToBluffCatch: true }
};

function oppPolicy(cfg, o) {
  if (o.preflop) {
    if (o.call <= 0) {
      if (o.pos === 'bb') return { act: 'check' };
      return o.pctl <= cfg.openPct ? { act: 'raise', to: 2.5 * BB } : { act: 'fold' };
    }
    if (o.pctl <= cfg.threePct) return { act: 'raise', to: o.call * 3 };
    if (o.pctl <= cfg.callPct && o.call <= o.stack) return { act: 'call' };
    return { act: 'fold' };
  }
  // 翻牌后按成牌等级：0 高牌 1 一对 2 两对 3 三条 …
  const cat = o.madeCat;
  if (o.call <= 0) {
    if (cat >= cfg.betCat) return { act: 'bet', amount: o.potNow * cfg.betSize };
    // 会偷鸡的对手：单挑时按一定频率无牌也下注
    if (cfg.bluff && o.heads && rnd() < cfg.bluff) return { act: 'bet', amount: o.potNow * cfg.betSize };
    return { act: 'check' };
  }
  if (cat >= cfg.betCat + 2) return { act: 'raise', to: o.call + o.potNow * 0.7 };
  if (cat >= 1 && o.call <= o.potNow * cfg.callMaxPotFrac) return { act: 'call' };
  if (cat >= cfg.betCat) return { act: 'call' };
  return { act: 'fold' };
}

// ---------------- 翻牌前胜率查表 ----------------
const EQ_CACHE = root + '/tools/preflop-eq.json';
let PREEQ;
if (fs.existsSync(EQ_CACHE)) {
  PREEQ = JSON.parse(fs.readFileSync(EQ_CACHE, 'utf8'));
} else {
  process.stderr.write('首次运行：生成翻牌前胜率表（169 手 × 1-7 名对手）…\n');
  PREEQ = {};
  let done = 0;
  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = hi; lo >= 0; lo--) {
      for (const kind of (hi === lo ? ['p'] : ['s', 'o'])) {
        const c1 = (hi << 2) | 0;
        const c2 = kind === 'p' ? (hi << 2) | 1 : (lo << 2) | (kind === 's' ? 0 : 1);
        const key = kind === 's' ? lo * 13 + hi : hi * 13 + lo;
        PREEQ[key] = [];
        for (let opp = 1; opp <= 7; opp++) {
          const r = S.simulate({ hero: [c1, c2], players: opp + 1, maxIterations: 30000, timeLimitMs: 0 });
          PREEQ[key][opp] = +r.equity.toFixed(4);
        }
        process.stderr.write(`\r  ${++done}/169`);
      }
    }
  }
  process.stderr.write('\n');
  fs.writeFileSync(EQ_CACHE, JSON.stringify(PREEQ));
}

function preflopKey(c1, c2) {
  const r1 = c1 >> 2, r2 = c2 >> 2;
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const suited = (c1 & 3) === (c2 & 3);
  return (hi !== lo && suited) ? lo * 13 + hi : hi * 13 + lo;
}
const preflopEq = (c1, c2, opp) => PREEQ[preflopKey(c1, c2)][Math.min(Math.max(opp, 1), 7)];

// 翻牌后胜率：蒙特卡洛，局数不多所以能承受
function postflopEq(hole, board, opp) {
  const r = S.simulate({ hero: hole, board, players: opp + 1, maxIterations: 900, timeLimitMs: 0 });
  return r.equity;
}

/* 只从「前 maxPctl 的起手牌」里给对手发牌，再算胜率。
   对手敢投钱说明他的范围强于随机牌，这才是该用的口径。 */
function eqVsRange(hole, board, oppCount, maxPctl, iters) {
  const used = new Uint8Array(52);
  for (const c of hole) used[c] = 1;
  for (const c of board) used[c] = 1;
  const free = [];
  for (let c = 0; c < 52; c++) if (!used[c]) free.push(c);

  const need = 5 - board.length;
  const h7 = new Int32Array(7), o7 = new Int32Array(7);
  h7[0] = hole[0]; h7[1] = hole[1];
  let win = 0, tieEq = 0, n = 0;

  for (let it = 0; it < iters; it++) {
    const taken = new Uint8Array(52);
    const draw = [];
    const pick = () => {
      for (let g = 0; g < 200; g++) {
        const c = free[(rnd() * free.length) | 0];
        if (!taken[c]) { taken[c] = 1; return c; }
      }
      return -1;
    };
    // 补齐公共牌
    let bad = false;
    const comm = board.slice();
    for (let i = 0; i < need; i++) { const c = pick(); if (c < 0) { bad = true; break; } comm.push(c); }
    if (bad) continue;
    // 每个对手在范围内随机取两张
    const opps = [];
    for (let k = 0; k < oppCount && !bad; k++) {
      const free = FREE_BLIND && k === 0;      // 盲注被迫投钱，范围本就宽
      let ok = false;
      for (let g = 0; g < (free ? 1 : 60); g++) {
        const a = pick(); if (a < 0) { bad = true; break; }
        const b = pick(); if (b < 0) { bad = true; break; }
        if (free || PF.percentile(a, b) <= maxPctl) { opps.push([a, b]); ok = true; break; }
        taken[a] = 0; taken[b] = 0;      // 不在范围内就放回去重抽
      }
      if (!ok) bad = true;
    }
    if (bad) continue;

    for (let i = 0; i < 5; i++) { h7[2 + i] = comm[i]; o7[2 + i] = comm[i]; }
    const hs = E.evalHand(h7, 7);
    let best = -1, ties = 0;
    for (const o of opps) {
      o7[0] = o[0]; o7[1] = o[1];
      const sc = E.evalHand(o7, 7);
      if (sc > best) { best = sc; ties = 1; } else if (sc === best) ties++;
    }
    if (hs > best) win++; else if (hs === best) tieEq += 1 / (ties + 1);
    n++;
  }
  return n ? (win + tieEq) / n : 0.5;
}

// ---------------- 发牌 ----------------
const DECK = [];
for (let c = 0; c < 52; c++) DECK.push(c);
function shuffleTop(k) {
  for (let i = 0; i < k; i++) {
    const j = i + ((rnd() * (52 - i)) | 0);
    const t = DECK[j]; DECK[j] = DECK[i]; DECK[i] = t;
  }
}

// ---------------- 一手牌 ----------------
const players = [];
for (let i = 0; i < N; i++) players.push({ stack: BUYIN, profit: 0, hero: i === 0 });
const HERO = players[0];
const MIRROR = OPP_KIND === 'mirror';   // 全桌同一套算法，用来验证引擎公平性
// mixed：更接近真实牌桌——两个跟注站、三个松被动、两个紧凶
const MIXED_SEATS = [null, 'station', 'station', 'amateur', 'amateur', 'amateur', 'tag', 'tag'];
const MIXED = OPP_KIND === 'mixed';
const cfg = (MIRROR || MIXED) ? OPPS.amateur : OPPS[OPP_KIND];
if (!cfg) {
  console.error('未知对手类型:', OPP_KIND, '可选:', Object.keys(OPPS).join('/') + '/mirror/mixed');
  process.exit(1);
}
const seatCfg = (i) => MIXED ? OPPS[MIXED_SEATS[i]] : cfg;

let heroVpip = 0, heroSawFlop = 0, heroWon = 0, showdowns = 0, potSum = 0, potMax = 0;

function playHand(btn) {
  // 每手都坐回 100BB：赢了的把盈利收进口袋，输光的补码。
  // 不这么做的话赢家筹码会无限滚雪球，最后量出来的是滚雪球效应而不是策略好坏，
  // 而且真实牌局也不会出现一个人带着几十倍于别人的筹码坐在桌上。
  for (const p of players) { p.profit += p.stack - BUYIN; p.stack = BUYIN; }

  shuffleTop(4 + 2 * N);
  const board = [DECK[0], DECK[1], DECK[2], DECK[3], DECK[4]];
  for (let i = 0; i < N; i++) {
    const p = players[i];
    p.cards = [DECK[5 + 2 * i], DECK[6 + 2 * i]];
    p.folded = false; p.allin = false; p.put = 0; p.roundPut = 0;
  }

  const sbSeat = (btn + 1) % N, bbSeat = (btn + 2) % N;
  const post = (p, amt) => { const a = Math.min(amt, p.stack); p.stack -= a; p.put += a; p.roundPut += a; if (p.stack === 0) p.allin = true; return a; };
  post(players[sbSeat], SB);
  post(players[bbSeat], BB);

  let currentBet = BB, minRaise = BB, raisesThisStreet = 1;   // 大盲算一次下注
  let street = 0;                 // 0 翻牌前 1 翻牌 2 转牌 3 河牌
  let heroPlayed = false;

  const alive = () => players.filter(p => !p.folded);
  const canAct = () => players.filter(p => !p.folded && !p.allin);

  while (true) {
    // ---- 一轮下注 ----
    const RAISE_CAP = 4;   // 每条街最多四次下注/加注，否则规则型机器人会无限互加到全下
    let seat = street === 0 ? (bbSeat + 1) % N : (btn + 1) % N;
    let acted = 0, needed = canAct().length;
    if (needed >= 2 || (needed === 1 && currentBet > 0)) {
      let guard = 0;
      while (guard++ < 200) {
        const p = players[seat];
        if (!p.folded && !p.allin) {
          const toCall = currentBet - p.roundPut;
          const potNow = players.reduce((s, x) => s + x.put, 0);
          const oppLeft = alive().length - 1;
          let d;
          const useAlgo = MIRROR || (p.hero ? HERO_KIND === 'algo' : false);
          if (useAlgo) {
            const nOpp = Math.max(oppLeft, 1);
            const bd = board.slice(0, 2 + street);
            // 面对下注时按收窄的范围算；无人下注时对手范围本就宽，仍按随机牌
            const eq = (USE_RANGE && toCall > 0)
              ? eqVsRange(p.cards, street === 0 ? [] : bd, nOpp, RANGE_PCT, 700)
              : (street === 0
                  ? preflopEq(p.cards[0], p.cards[1], nOpp)
                  : postflopEq(p.cards, bd, nOpp));
            d = heroPolicy({
              preflop: street === 0, pos: posOf(seat, btn),
              pctl: PF.percentile(p.cards[0], p.cards[1]),
              potNow, call: toCall, playersLeft: oppLeft + 1, equity: eq
            });
            if (p.hero && street === 0 && d.act !== 'fold' && d.act !== 'check') heroPlayed = true;
          } else {
            const rule = p.hero ? OPPS[HERO_KIND] : seatCfg(seat);
            d = oppPolicy(rule, {
              heads: oppLeft === 1,
              preflop: street === 0, pos: posOf(seat, btn),
              pctl: PF.percentile(p.cards[0], p.cards[1]),
              potNow, call: toCall, stack: p.stack,
              madeCat: street === 0 ? 0 : (E.evalHand(p.cards.concat(board.slice(0, 2 + street))) >>> 20)
            });
            if (p.hero && street === 0 && d.act !== 'fold' && d.act !== 'check') heroPlayed = true;
          }

          // 已到封顶就不许再加，只能跟或弃
          if ((d.act === 'raise' || d.act === 'bet') && raisesThisStreet >= RAISE_CAP) {
            d = toCall > 0 ? { act: 'call' } : { act: 'check' };
          }

          if (d.act === 'fold' && toCall > 0) p.folded = true;
          else if (d.act === 'fold' || d.act === 'check') {
            if (toCall > 0) p.folded = true;       // 要钱还想过牌，按弃牌处理
          } else if (d.act === 'call') {
            post(p, toCall);
          } else {
            // 下注 / 加注
            let target = d.to !== undefined ? d.to : p.roundPut + toCall + d.amount;
            target = Math.max(target, currentBet + minRaise);
            const add = Math.min(target - p.roundPut, p.stack);
            post(p, add);
            if (p.roundPut > currentBet) {
              minRaise = p.roundPut - currentBet; currentBet = p.roundPut;
              acted = 0; raisesThisStreet++;
            }
          }
        }
        acted++;
        if (alive().length === 1) break;
        if (acted >= N) {
          // 所有人都行动过且下注额一致
          const pend = canAct().filter(x => x.roundPut < currentBet);
          if (pend.length === 0) break;
        }
        seat = (seat + 1) % N;
      }
    }

    if (alive().length === 1) break;
    if (street === 3) break;
    street++;
    for (const p of players) p.roundPut = 0;
    currentBet = 0; minRaise = BB; raisesThisStreet = 0;
    if (canAct().length <= 1) {
      // 大家都全下了，直接发完剩余公共牌
      street = 3;
      break;
    }
  }

  const finalPot = players.reduce((s, x) => s + x.put, 0);
  potSum += finalPot; if (finalPot > potMax) potMax = finalPot;
  if (heroPlayed) heroVpip++;
  if (!HERO.folded && street >= 1) heroSawFlop++;

  // ---- 分池 ----
  const live = alive();
  const before = HERO.stack;
  if (live.length === 1) {
    live[0].stack += players.reduce((s, x) => s + x.put, 0);
  } else {
    showdowns++;
    const levels = [...new Set(players.filter(p => p.put > 0).map(p => p.put))].sort((a, b) => a - b);
    let prev = 0;
    for (const lv of levels) {
      let pot = 0;
      for (const p of players) pot += Math.max(0, Math.min(p.put, lv) - prev);
      const elig = live.filter(p => p.put >= lv);
      if (elig.length && pot > 0) {
        let best = -1, winners = [];
        for (const p of elig) {
          const sc = E.evalHand(p.cards.concat(board));
          if (sc > best) { best = sc; winners = [p]; }
          else if (sc === best) winners.push(p);
        }
        const share = pot / winners.length;
        for (const w of winners) w.stack += share;
      }
      prev = lv;
    }
  }
  if (HERO.stack > before) heroWon++;
}

// ---------------- 跑 ----------------
const t0 = Date.now();
const totalChips = () => players.reduce((s, p) => s + p.stack, 0);

for (let h = 0; h < HANDS; h++) {
  playHand(h % N);
  // 筹码必须守恒：场上总筹码 = 总带入
  const diff = totalChips() - N * BUYIN;
  if (Math.abs(diff) > 1e-6) {
    console.error(`第 ${h + 1} 手筹码不守恒，差 ${diff.toFixed(2)}`);
    console.error(players.map((p, i) => `  座位${i}${p.hero ? '(英雄)' : ''} 筹码 ${p.stack.toFixed(1)} 本手投入 ${p.put} ${p.folded ? '弃牌' : ''}`).join('\n'));
    process.exit(1);
  }
  if ((h + 1) % 10000 === 0) {
    const net = HERO.profit + HERO.stack - BUYIN;
    process.stderr.write(`\r  ${h + 1} 手  净额 ${net.toFixed(0)}  ${(net / BB / (h + 1) * 100).toFixed(2)} BB/100`);
  }
}
process.stderr.write('\n');

const net = HERO.profit + HERO.stack - BUYIN;
const bb100 = net / BB / HANDS * 100;
console.log('');
console.log(`英雄策略      ${HERO_KIND === 'algo' ? '本 App 的算法' : HERO_KIND + '（规则型）'}${OPTS.length ? ' + ' + OPTS.join('+') : ''}`);
console.log(`对手类型      ${MIXED ? '混合桌（2 跟注站 + 3 松被动 + 2 紧凶）' : OPP_KIND + ' × 7'}`);
console.log(`手数          ${HANDS.toLocaleString()}`);
console.log(`每手带入      ${BUYIN}（${BUYIN / BB}BB），每手结束把盈亏收走再坐回 ${BUYIN}`);
console.log(`净盈亏        ${net >= 0 ? '+' : ''}${net.toFixed(1)} 元`);
console.log(`折合          ${bb100 >= 0 ? '+' : ''}${bb100.toFixed(2)} BB/100`);
console.log(`入池率 VPIP   ${(heroVpip / HANDS * 100).toFixed(1)}%`);
console.log(`看到翻牌      ${(heroSawFlop / HANDS * 100).toFixed(1)}%`);
console.log(`赢下彩池      ${(heroWon / HANDS * 100).toFixed(1)}%`);
console.log(`平均彩池      ${(potSum / HANDS).toFixed(1)}（${(potSum / HANDS / BB).toFixed(1)}BB）  最大 ${potMax.toFixed(0)}`);
if (MIRROR) {
  const nets = players.map(p => (p.profit + p.stack - BUYIN) / BB / HANDS * 100);
  console.log(`各座位 BB/100 ${nets.map(x => x.toFixed(1)).join(' ')}`);
  console.log(`八人合计      ${nets.reduce((a, b) => a + b, 0).toFixed(2)} BB/100（应当接近 0）`);
}
console.log(`耗时          ${((Date.now() - t0) / 1000).toFixed(0)}s`);
