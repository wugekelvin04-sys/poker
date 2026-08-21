/* 让 LLM 对手和本 App 的算法真刀真枪打牌。
 *
 * 和 sim-session.mjs 的区别：对手不是规则机器人，而是外部（LLM）给的决策。
 * 所以整个牌局必须能「暂停 / 存盘 / 喂决策 / 继续」，于是拆成四个命令：
 *
 *   node tools/llm-table.mjs init  --hands 40 --seed 7 --state s.json
 *   node tools/llm-table.mjs step  --state s.json --pending p.txt
 *        把所有牌局推进到「必须由对手做决定」为止，把待决策点写出来
 *   node tools/llm-table.mjs apply --state s.json --decisions d.txt
 *        喂回决策，继续
 *   node tools/llm-table.mjs report --state s.json
 *
 * 所有手牌同时推进（lockstep）。同一轮里不同手牌之间互相独立，
 * 于是几十上百个决策点可以打成一个包一次问完——不这么做，
 * 300 手需要上千次模型调用，根本跑不动。
 *
 * 筹码规则按用户要求：带入 100BB，筹码跨手保留，输光才补回 100BB。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
for (const f of ['engine.js', 'sim.js', 'preflop.js', 'strategy.js'])
  vm.runInThisContext(fs.readFileSync(root + '/' + f, 'utf8'));
const E = globalThis.PokerEngine, S = globalThis.PokerSim,
      PF = globalThis.PokerPreflop, ST = globalThis.PokerStrategy;

const BB = 2, SB = 1, BUYIN = 200, N = 4, RAISE_CAP = 4;
const HERO = 0;                       // 座位 0 是算法
const RANK = '23456789TJQKA', SUIT = 'shdc';
const nm = (c) => c === null || c === undefined ? '??' : RANK[c >> 2] + SUIT[c & 3];
const STREETS = ['翻牌前', '翻牌', '转牌', '河牌'];

// ---------------- 命令行 ----------------
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

// ---------------- 工具 ----------------
function makeDeck(rng) {
  const d = [];
  for (let c = 0; c < 52; c++) d.push(c);
  for (let i = 51; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

const LABELS4 = ['btn', 'sb', 'bb', 'late'];   // 4 人桌：庄、小盲、大盲、枪口(=后位)
const posOf = (seat, btn) => LABELS4[(seat - btn + N) % N];
const POS_CN = { btn: '庄位', sb: '小盲', bb: '大盲', late: '后位', mid: '中位', early: '前位' };

// ---------------- 建局 ----------------
function newHand(st, id) {
  const rng = S.makeRng((st.seed * 1000003 + id * 7919) >>> 0);
  const deck = makeDeck(rng);
  const btn = ((id % 1000) % N + N) % N;
  const players = [];
  for (let i = 0; i < N; i++) {
    // 破产才补码，其余跨手保留
    if (st.stacks[i] < BB) { st.stacks[i] = BUYIN; st.rebuys[i]++; }
    players.push({
      seat: i, hero: i === HERO, cards: [deck[5 + 2 * i], deck[6 + 2 * i]],
      stack: st.stacks[i], put: 0, roundPut: 0, folded: false, allin: false
    });
  }
  const h = {
    id, btn, board: [deck[0], deck[1], deck[2], deck[3], deck[4]],
    players, street: 0, currentBet: BB, minRaise: BB, raises: 1,
    seat: (btn + 3) % N,           // 4 人桌翻牌前从大盲的下一位开始
    actedSet: [], done: false, log: [], startStacks: st.stacks.slice()
  };
  const post = (p, amt) => {
    const a = Math.min(amt, p.stack);
    p.stack -= a; p.put += a; p.roundPut += a;
    if (p.stack === 0) p.allin = true;
  };
  post(players[(btn + 1) % N], SB);
  post(players[(btn + 2) % N], BB);
  return h;
}

// ---------------- 英雄决策（走 strategy.js） ----------------
function heroAct(h, p, toCall) {
  const shown = h.street === 0 ? [] : h.board.slice(0, 2 + h.street);
  const board5 = [null, null, null, null, null];
  for (let i = 0; i < shown.length; i++) board5[i] = shown[i];
  const alive = h.players.filter(x => !x.folded).length;
  const potTotal = h.players.reduce((s, x) => s + x.put, 0);
  const roundSum = h.players.reduce((s, x) => s + x.roundPut, 0);

  const g = {
    hero: p.cards, board: board5, players: alive, tableSize: N,
    pos: posOf(p.seat, h.btn), oppLevel: OPP_LEVEL,
    pot: potTotal - roundSum, call: toCall,
    called: h.players.filter(x => x !== p && !x.folded && x.roundPut > 0).length,
    stack: p.stack
  };
  const opt = ST.simOptions(g);
  let eq;
  if (shown.length === 0) {
    eq = preflopEq(p.cards[0], p.cards[1], Math.max(1, Math.round(opt.players) - 1));
  } else {
    eq = S.simulate({
      hero: p.cards, board: shown, players: opt.players, seed: opt.seed,
      maxIterations: 4000, timeLimitMs: 0,
      oppMaxPctl: opt.oppMaxPctl, oppBoardTop: opt.oppBoardTop,
      oppStrong: opt.oppStrong, oppWideTop: opt.oppWideTop,
      oppFilterLen: opt.oppFilterLen
    }).equity;
  }
  const d = ST.decide(g, { equity: eq });
  const why = d.verdict;
  if (d.act === 'raise' || d.act === 'bet') return { act: 'raise', to: d.amount, why };
  if (d.act === 'call') return { act: 'call', why };
  if (d.act === 'check') return toCall > 0 ? { act: 'fold', why } : { act: 'check', why };
  if (d.act === 'marginal') return { act: 'call', why };            // 「临界」按跟注读
  if (d.act === 'need-input') return toCall > 0 ? { act: 'call', why } : { act: 'check', why };
  return { act: 'fold', why };
}

// 翻牌前胜率表（对随机牌），预算好省时间
let PREEQ = null;
function preflopEq(c1, c2, opp) {
  if (!PREEQ) PREEQ = JSON.parse(fs.readFileSync(root + '/tools/preflop-eq.json', 'utf8'));
  const r1 = c1 >> 2, r2 = c2 >> 2, s = (c1 & 3) === (c2 & 3);
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const key = RANK[hi] + RANK[lo] + (r1 === r2 ? '' : s ? 's' : 'o');
  const row = PREEQ[key];
  return row ? row[Math.min(Math.max(opp, 1), 7)] : 0.35;
}

let OPP_LEVEL = 'normal';

// ---------------- 推进一手牌 ----------------
/* 返回 null 表示这手牌已经推到底或已结束；
   返回一个对象表示卡在某个对手的决策点上，需要外部喂决策。 */
function advance(h, decisions) {
  const alive = () => h.players.filter(p => !p.folded);
  const canAct = () => h.players.filter(p => !p.folded && !p.allin);
  const post = (p, amt) => {
    const a = Math.min(amt, p.stack);
    p.stack -= a; p.put += a; p.roundPut += a;
    if (p.stack === 0) p.allin = true;
  };

  let guard = 0;
  while (!h.done && guard++ < 400) {
    /* 本街何时结束：还能行动的人里，每个都「自上次加注以来行动过」
       且投注额都追平了当前注。
       不能拿「本街开始时的人数」当基准——中间有人弃牌，人数就变了，
       行动会多绕一圈，出现「已经跟平的人又被要求过牌」这种非法序列。 */
    if (!h.actedSet) h.actedSet = [];
    const live = canAct();
    const roundOver = live.every(x => h.actedSet.indexOf(x.seat) >= 0
                                   && x.roundPut === h.currentBet);

    if (alive().length === 1 || live.length === 0 || roundOver) {
      if (alive().length === 1 || h.street === 3) { finish(h); return null; }
      h.street++;
      for (const p of h.players) p.roundPut = 0;
      h.currentBet = 0; h.minRaise = BB; h.raises = 0;
      h.actedSet = [];
      h.seat = (h.btn + 1) % N;
      if (canAct().length <= 1) { h.street = 3; finish(h); return null; }
      continue;
    }

    const p = h.players[h.seat];
    if (p.folded || p.allin) { h.seat = (h.seat + 1) % N; continue; }

    const toCall = h.currentBet - p.roundPut;
    let d;
    if (p.hero) {
      d = heroAct(h, p, toCall);
    } else {
      const key = 'H' + h.id + 'S' + p.seat + 'R' + h.street + 'A' + h.raises + '_' + h.actedSet.length;
      if (decisions && decisions[key]) d = decisions[key];
      else return { hand: h, player: p, toCall, key };
    }

    // 封顶后不许再加
    if (d.act === 'raise' && h.raises >= RAISE_CAP) d = toCall > 0 ? { act: 'call' } : { act: 'check' };

    const posCn = POS_CN[posOf(p.seat, h.btn)];
    if (d.act === 'fold') {
      if (toCall > 0) { p.folded = true; h.log.push(`${STREETS[h.street]} ${posCn} 弃牌`); }
      else { h.log.push(`${STREETS[h.street]} ${posCn} 过牌`); }
    } else if (d.act === 'check') {
      if (toCall > 0) { p.folded = true; h.log.push(`${STREETS[h.street]} ${posCn} 弃牌`); }
      else h.log.push(`${STREETS[h.street]} ${posCn} 过牌`);
    } else if (d.act === 'call') {
      post(p, toCall);
      h.log.push(`${STREETS[h.street]} ${posCn} ${toCall > 0 ? '跟注 ' + toCall : '过牌'}`);
    } else {
      let target = d.to !== undefined ? d.to : p.roundPut + toCall + (d.amount || 0);
      target = Math.max(target, h.currentBet + h.minRaise);
      target = Math.min(target, p.roundPut + p.stack);
      post(p, target - p.roundPut);
      if (p.roundPut > h.currentBet) {
        h.minRaise = p.roundPut - h.currentBet;
        h.currentBet = p.roundPut;
        h.actedSet = [];        // 加注了，其他人都得重新面对这笔钱
        h.raises++;
      }
      h.log.push(`${STREETS[h.street]} ${posCn} 加到 ${p.roundPut}`);
    }
    if (h.actedSet.indexOf(p.seat) < 0) h.actedSet.push(p.seat);
    if (alive().length === 1) { finish(h); return null; }
    h.seat = (h.seat + 1) % N;
  }
  if (!h.done) finish(h);
  return null;
}

function finish(h) {
  if (h.done) return;
  const live = h.players.filter(p => !p.folded);
  const pot = h.players.reduce((s, x) => s + x.put, 0);
  if (live.length === 1) {
    live[0].stack += pot;
    h.winner = [live[0].seat];
    h.showdown = false;
  } else {
    h.showdown = true;
    const levels = [...new Set(h.players.filter(p => p.put > 0).map(p => p.put))].sort((a, b) => a - b);
    let prev = 0;
    const winners = new Set();
    for (const lv of levels) {
      let sub = 0;
      for (const p of h.players) sub += Math.max(0, Math.min(p.put, lv) - prev);
      const elig = live.filter(p => p.put >= lv);
      if (elig.length && sub > 0) {
        let best = -1, ws = [];
        for (const p of elig) {
          const sc = E.evalHand(p.cards.concat(h.board));
          if (sc > best) { best = sc; ws = [p]; } else if (sc === best) ws.push(p);
        }
        for (const w of ws) { w.stack += sub / ws.length; winners.add(w.seat); }
      }
      prev = lv;
    }
    h.winner = [...winners];
  }
  h.pot = pot;
  h.done = true;
}

// ---------------- 决策点的文字描述 ----------------
function describePending(pt) {
  const h = pt.hand, p = pt.player;
  const shown = h.street === 0 ? [] : h.board.slice(0, 2 + h.street);
  const pot = h.players.reduce((s, x) => s + x.put, 0);
  const alive = h.players.filter(x => !x.folded);
  const others = alive.filter(x => x !== p)
    .map(x => `${POS_CN[posOf(x.seat, h.btn)]}(本轮投${x.roundPut}/共${x.put}/余${Math.round(x.stack)})`)
    .join(' ');
  const opts = [];
  opts.push(pt.toCall > 0 ? '弃牌' : '过牌');
  if (pt.toCall > 0) opts.push(`跟注${pt.toCall}`);
  const minTo = h.currentBet + h.minRaise;
  if (h.raises < RAISE_CAP && p.stack + p.roundPut > minTo)
    opts.push(`加到N(最少${minTo},最多${Math.round(p.stack + p.roundPut)})`);
  return `${pt.key} | ${STREETS[h.street]} | 我=${POS_CN[posOf(p.seat, h.btn)]}`
    + ` 手牌=${nm(p.cards[0])}${nm(p.cards[1])}`
    + ` 公共牌=${shown.length ? shown.map(nm).join('') : '无'}`
    + ` 底池=${pot} 需跟=${pt.toCall} 我筹码=${Math.round(p.stack)}`
    + ` | 其他人: ${others || '无'}`
    + ` | 本手历史: ${h.log.length ? h.log.join('; ') : '无'}`
    + ` | 可选: ${opts.join(' / ')}`;
}

// ---------------- 命令 ----------------
function load(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function save(f, o) { fs.writeFileSync(f, JSON.stringify(o)); }

if (cmd === 'init') {
  const hands = parseInt(arg('hands', '40'), 10);
  const seed = parseInt(arg('seed', '1'), 10);
  OPP_LEVEL = arg('level', 'normal');
  /* 多桌并行时给每桌一个手牌编号偏移，决策编号就不会跨桌撞车，
     五桌的待决策点可以合并成一个批次一次问完，轮数不变。
     apply 只认自己认识的编号，别桌的会被忽略。 */
  const idBase = parseInt(arg('idbase', '0'), 10);
  const st = {
    seed, total: hands, level: OPP_LEVEL, idBase,
    stacks: new Array(N).fill(BUYIN), rebuys: new Array(N).fill(0),
    hands: [], nextId: 0, finished: []
  };
  // 一次性把所有牌局建出来，锁步推进
  for (let i = 0; i < hands; i++) st.hands.push(newHand(st, idBase + i));
  // 建局时 stacks 会被 newHand 改（补码），这里同步回去
  save(arg('state', 'state.json'), st);
  console.log(`已开 ${hands} 手，座位0=算法(${OPP_LEVEL})，座位1/2/3=LLM 对手`);
}

if (cmd === 'step') {
  const f = arg('state', 'state.json');
  const st = load(f);
  OPP_LEVEL = st.level;
  const pend = [];
  for (const h of st.hands) {
    if (h.done) continue;
    const pt = advance(h, null);
    if (pt) pend.push(pt);
  }
  const bySeat = { 1: [], 2: [], 3: [] };
  for (const pt of pend) bySeat[pt.player.seat].push(describePending(pt));
  save(f, st);
  const out = arg('pending', 'pending.txt');
  let txt = '';
  for (const s of [1, 2, 3]) {
    if (!bySeat[s].length) continue;
    txt += `\n===== 座位 ${s} 需要决策 ${bySeat[s].length} 个 =====\n` + bySeat[s].join('\n') + '\n';
  }
  fs.writeFileSync(out, txt);
  const doneN = st.hands.filter(h => h.done).length;
  console.log(`待决策 ${pend.length} 个（座位1:${bySeat[1].length} 座位2:${bySeat[2].length} 座位3:${bySeat[3].length}）；已完成 ${doneN}/${st.total} 手`);
  if (!pend.length) console.log('ALL_DONE');
}

if (cmd === 'apply') {
  const f = arg('state', 'state.json');
  const st = load(f);
  OPP_LEVEL = st.level;
  const raw = fs.readFileSync(arg('decisions', 'decisions.txt'), 'utf8');
  const dec = {};
  let bad = 0;
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(H\d+S\d+R\d+A\d+_\d+)\s*[:：]?\s*(弃牌|过牌|跟注|加到)\s*(\d+)?/);
    if (!m) { if (line.trim()) bad++; continue; }
    const act = m[2] === '弃牌' ? 'fold' : m[2] === '过牌' ? 'check'
              : m[2] === '跟注' ? 'call' : 'raise';
    dec[m[1]] = act === 'raise' ? { act, to: parseInt(m[3] || '0', 10) } : { act };
  }
  let applied = 0;
  for (const h of st.hands) {
    if (h.done) continue;
    let guard = 0;
    while (guard++ < 50) {
      const pt = advance(h, dec);
      if (!pt) break;
      if (!dec[pt.key]) break;      // 还缺这个决策，等下一轮
      applied++;
    }
  }
  // 手牌全打完之后结算筹码
  for (const h of st.hands) if (h.done && !h.settled) {
    h.settled = true;
    for (let i = 0; i < N; i++) st.stacks[i] = h.players[i].stack;
  }
  save(f, st);
  console.log(`收到 ${Object.keys(dec).length} 条决策${bad ? `（${bad} 行无法解析）` : ''}，已完成 ${st.hands.filter(h => h.done).length}/${st.total} 手`);
}

if (cmd === 'report') {
  const st = load(arg('state', 'state.json'));
  const net = new Array(N).fill(0);
  let showdowns = 0, heroVpip = 0, heroWon = 0, potSum = 0, played = 0;
  for (const h of st.hands) {
    if (!h.done) continue;
    played++;
    for (let i = 0; i < N; i++) net[i] += h.players[i].stack - h.startStacks[i];
    if (h.showdown) showdowns++;
    if (h.players[HERO].put > BB) heroVpip++;
    if (h.winner && h.winner.includes(HERO)) heroWon++;
    potSum += h.pot;
  }
  const bb100 = (v) => (v / BB / played * 100);
  console.log(`\n手数            ${played}`);
  console.log(`座位0 算法      净 ${net[0] >= 0 ? '+' : ''}${net[0].toFixed(0)}  =  ${bb100(net[0]) >= 0 ? '+' : ''}${bb100(net[0]).toFixed(1)} BB/100`);
  for (let i = 1; i < N; i++)
    console.log(`座位${i} LLM       净 ${net[i] >= 0 ? '+' : ''}${net[i].toFixed(0)}  =  ${bb100(net[i]) >= 0 ? '+' : ''}${bb100(net[i]).toFixed(1)} BB/100`);
  console.log(`算法入池率      ${(100 * heroVpip / played).toFixed(1)}%`);
  console.log(`算法赢下彩池    ${(100 * heroWon / played).toFixed(1)}%`);
  console.log(`摊牌率          ${(100 * showdowns / played).toFixed(1)}%`);
  console.log(`平均彩池        ${(potSum / played).toFixed(1)}（${(potSum / played / BB).toFixed(1)}BB）`);
  console.log(`补码次数        ${st.rebuys.join(' / ')}`);
}

if (cmd === 'hands') {
  const st = load(arg('state', 'state.json'));
  const from = parseInt(arg('from', '0'), 10), to = parseInt(arg('to', '9999'), 10);
  for (const h of st.hands) {
    if (h.id < from || h.id > to || !h.done) continue;
    const net = h.players[HERO].stack - h.startStacks[HERO];
    console.log(`\n#${h.id} 庄=${POS_CN[posOf(h.btn, h.btn)]}座位${h.btn} 公共牌 ${h.board.map(nm).join(' ')}`);
    console.log(`  算法(${POS_CN[posOf(HERO, h.btn)]}) ${nm(h.players[HERO].cards[0])}${nm(h.players[HERO].cards[1])}  本手 ${net >= 0 ? '+' : ''}${net.toFixed(0)}`);
    for (let i = 1; i < N; i++)
      console.log(`  座位${i}(${POS_CN[posOf(i, h.btn)]}) ${nm(h.players[i].cards[0])}${nm(h.players[i].cards[1])}${h.players[i].folded ? ' 弃' : ''}`);
    console.log(`  ${h.log.join('; ')}`);
    console.log(`  彩池 ${h.pot} 赢家 座位${(h.winner || []).join(',')}${h.showdown ? ' (摊牌)' : ' (无摊牌)'}`);
  }
}
