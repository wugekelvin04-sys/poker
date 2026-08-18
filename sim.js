/* 蒙特卡洛胜率模拟。依赖 engine.js，同样是纯脚本。 */
(function (global) {
  'use strict';

  var E = global.PokerEngine;
  var evalHand = E.evalHand;

  // ---------- 随机数：sfc32，比 Math.random 更快且质量足够 ----------
  function sfc32(a, b, c, d) {
    return function () {
      a |= 0; b |= 0; c |= 0; d |= 0;
      var t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    if (seed === undefined) seed = (Date.now() ^ (Math.random() * 0x100000000)) >>> 0;
    var s = seed >>> 0;
    var rng = sfc32(0x9e3779b9, 0x243f6a88, 0xb7e15162, s);
    for (var i = 0; i < 16; i++) rng(); // 预热
    return rng;
  }

  function buildDeck(used) {
    var seen = new Uint8Array(52), deck = [];
    for (var i = 0; i < used.length; i++) {
      if (seen[used[i]]) throw new Error('牌重复: ' + E.cardToString(used[i]));
      seen[used[i]] = 1;
    }
    for (var c = 0; c < 52; c++) if (!seen[c]) deck.push(c);
    return deck;
  }

  /**
   * 蒙特卡洛模拟。
   * @param {object} o
   * @param {number[]} o.hero     我的两张手牌
   * @param {number[]} [o.board]  公共牌 0/3/4/5 张
   * @param {number}  o.players   总人数（含我）
   * @param {number}  [o.maxIterations=200000]
   * @param {number}  [o.timeLimitMs=2000]  软时间上限，保证界面不卡死
   * @param {number}  [o.batchSize=4000]
   * @param {function} [o.onProgress] 每批回调，收到累计统计
   * @param {number}  [o.seed]
   */
  function simulate(o) {
    var hero = o.hero, board = o.board || [], players = o.players;
    var maxIter = o.maxIterations || 200000;
    var timeLimit = o.timeLimitMs === undefined ? 2000 : o.timeLimitMs;
    var batchSize = o.batchSize || 4000;
    var rng = o.rng || makeRng(o.seed);
    var now = (typeof performance !== 'undefined' && performance.now)
      ? function () { return performance.now(); } : function () { return Date.now(); };

    if (hero.length !== 2) throw new Error('需要正好两张手牌');
    if (board.length > 5) throw new Error('公共牌不能超过 5 张');
    if (players < 2 || players > 10) throw new Error('人数需在 2-10 之间');

    var deck = buildDeck(hero.concat(board));
    var oppCount = players - 1;
    var need = 5 - board.length;
    var draw = need + oppCount * 2;
    if (draw > deck.length) throw new Error('剩余牌不够发给这么多人');

    var deckLen = deck.length;
    var comm = new Int32Array(5);
    var h7 = new Int32Array(7), o7 = new Int32Array(7);
    for (var i = 0; i < board.length; i++) comm[i] = board[i];
    h7[0] = hero[0]; h7[1] = hero[1];

    var win = 0, lose = 0, tieEquity = 0, tieCount = 0, n = 0;
    var catCounts = new Float64Array(9);
    var start = now();

    while (n < maxIter) {
      var target = Math.min(n + batchSize, maxIter);
      for (; n < target; n++) {
        // 部分 Fisher-Yates：只洗出需要的前 draw 张
        for (var k = 0; k < draw; k++) {
          var j = k + ((rng() * (deckLen - k)) | 0);
          var t = deck[j]; deck[j] = deck[k]; deck[k] = t;
        }
        for (var b = 0; b < need; b++) comm[board.length + b] = deck[b];
        h7[2] = comm[0]; h7[3] = comm[1]; h7[4] = comm[2]; h7[5] = comm[3]; h7[6] = comm[4];
        o7[2] = comm[0]; o7[3] = comm[1]; o7[4] = comm[2]; o7[5] = comm[3]; o7[6] = comm[4];

        var heroScore = evalHand(h7, 7);
        catCounts[heroScore >>> 20]++;

        var best = -1, ties = 0;
        for (var p = 0; p < oppCount; p++) {
          o7[0] = deck[need + p * 2];
          o7[1] = deck[need + p * 2 + 1];
          var s = evalHand(o7, 7);
          if (s > best) { best = s; ties = 1; }
          else if (s === best) ties++;
        }

        if (heroScore > best) win++;
        else if (heroScore < best) lose++;
        else { tieCount++; tieEquity += 1 / (ties + 1); }
      }

      if (o.onProgress) o.onProgress(pack());
      if (timeLimit && now() - start > timeLimit) break;
    }

    function pack() {
      var eq = (win + tieEquity) / n;
      return {
        n: n, win: win, tie: tieCount, lose: lose,
        winRate: win / n, tieRate: tieCount / n, loseRate: lose / n,
        equity: eq,
        // 95% 置信区间半宽。正态近似在 0 次或全中时会退化成 0，
        // 这时改用「三倍法则」给出上界 3/n，否则会谎称零误差。
        margin: Math.max(1.96 * Math.sqrt(Math.max(eq * (1 - eq), 0) / n), 3 / n),
        catCounts: Array.prototype.slice.call(catCounts).map(function (v) { return v / n; }),
        exact: false,
        elapsed: now() - start
      };
    }
    return pack();
  }

  /**
   * 精确枚举：仅用于单挑（2 人）且公共牌已发满 5 张的摊牌场景。
   * 未知组合只有 C(45,2)=990 种，瞬间算完且零误差。
   */
  function enumerateShowdownHeadsUp(hero, board) {
    var deck = buildDeck(hero.concat(board));
    var h7 = hero.concat(board);
    var heroScore = evalHand(h7, 7);
    var o7 = board.concat([0, 0]);
    var win = 0, tie = 0, lose = 0, total = 0;
    for (var i = 0; i < deck.length; i++) {
      for (var j = i + 1; j < deck.length; j++) {
        o7[5] = deck[i]; o7[6] = deck[j];
        var s = evalHand(o7, 7);
        if (heroScore > s) win++; else if (heroScore < s) lose++; else tie++;
        total++;
      }
    }
    var catCounts = new Array(9).fill(0);
    catCounts[heroScore >>> 20] = 1;
    return {
      n: total, win: win, tie: tie, lose: lose,
      winRate: win / total, tieRate: tie / total, loseRate: lose / total,
      equity: (win + tie / 2) / total,
      margin: 0, catCounts: catCounts, exact: true, elapsed: 0
    };
  }

  global.PokerSim = {
    makeRng: makeRng,
    buildDeck: buildDeck,
    simulate: simulate,
    enumerateShowdownHeadsUp: enumerateShowdownHeadsUp
  };
})(typeof self !== 'undefined' ? self : this);
