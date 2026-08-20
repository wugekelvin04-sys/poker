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

  /* 翻牌后对手的范围该按「和这个牌面配合得怎样」筛，而不是起手牌排位。
     牌面 2-5-6 上 34 打成顺子却排在起手牌的后 5%，AK 只是 A 高却排前 5%——
     按起手牌筛出来的范围，废牌比随机范围还多，方向是反的。 */
  var PAIR_FLOOR = 1 << 20;      // 一对这一档的下限

  function boardStrength(c1, c2, board, bn) {
    var hand = [c1, c2];
    for (var i = 0; i < bn; i++) hand.push(board[i]);
    var sc = evalHand(hand, bn + 2);
    if (bn < 5 && sc < PAIR_FLOOR) {
      // 还有牌要发时，强听牌不能当废牌筛掉：四张同花或四张连牌，至少按一对看
      var suit = [0, 0, 0, 0], mask = (1 << (c1 >> 2)) | (1 << (c2 >> 2));
      suit[c1 & 3]++; suit[c2 & 3]++;
      for (var k = 0; k < bn; k++) { suit[board[k] & 3]++; mask |= 1 << (board[k] >> 2); }
      var draw = suit[0] === 4 || suit[1] === 4 || suit[2] === 4 || suit[3] === 4;
      if (!draw) {
        for (var h = 12; h >= 3; h--) {
          var run = 0xF << (h - 3);
          if ((mask & run) === run) { draw = true; break; }
        }
      }
      if (draw) sc = PAIR_FLOOR;
    }
    return sc;
  }

  /* 取「牌面契合度」前 topFrac 的分界分值，之后用它做拒绝采样 */
  function boardCutoff(deck, board, topFrac) {
    var bn = board.length, keys = [];
    for (var i = 0; i < deck.length; i++)
      for (var j = i + 1; j < deck.length; j++)
        keys.push(boardStrength(deck[i], deck[j], board, bn));
    keys.sort(function (a, b) { return b - a; });
    var idx = Math.floor(topFrac * keys.length) - 1;
    if (idx < 0) idx = 0;
    if (idx >= keys.length) idx = keys.length - 1;
    return keys[idx];
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
   * @param {number}  [o.oppMaxPctl=1] 只从「最强的前这么多比例」的起手牌里给对手发牌。
   *                  1 = 随机牌。对手敢投钱时他的范围本就强于随机，这个参数就是用来
   *                  修正那份乐观的。需要 preflop.js 提供起手牌强度排位。
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
    var maxPctl = o.oppMaxPctl === undefined ? 1 : o.oppMaxPctl;
    var PFL = global.PokerPreflop;
    var ranged = maxPctl < 1 && PFL && oppCount > 0;   // 拿不到排位表就退回随机牌
    // 翻牌后改按牌面契合度筛，比起手牌排位准得多
    var boardTop = o.oppBoardTop;
    /* 用来筛范围的牌面 = 最后一次有人行动时看到的牌面。
       本街有人下注就用当前牌面；没人下注，说明大家只是从上一条街跟过来的，
       还没对刚翻开的这张做过任何决定，那就用少一张的牌面。 */
    var fLen = o.oppFilterLen === undefined ? board.length : o.oppFilterLen;
    var fBoard = board.slice(0, fLen);
    var byBoard = boardTop !== undefined && boardTop < 1 && fBoard.length >= 3 && oppCount > 0;
    if (byBoard) ranged = false;
    /* 只有主动投钱的那一两个人范围才真的强；剩下的人是跟着看牌的。
       把窄范围无差别套到每个对手身上，人越多复合得越离谱——8 人桌等于
       假设 7 个人同时拿着前 36% 的牌，那件事的概率是 0.36^7 ≈ 0.08%。 */
    var strongN = o.oppStrong === undefined ? oppCount : Math.min(o.oppStrong, oppCount);
    var wideTop = o.oppWideTop !== undefined
      ? Math.min(1, o.oppWideTop)
      : Math.min(1, (byBoard ? boardTop : maxPctl) * 2.5);
    var cutoff = byBoard ? boardCutoff(deck, fBoard, boardTop) : 0;
    var wideByBoard = byBoard && strongN < oppCount && wideTop < 1;
    var cutoffWide = wideByBoard ? boardCutoff(deck, fBoard, wideTop) : 0;
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
        if (byBoard) {
          // 先洗公共牌
          for (var bk2 = 0; bk2 < need; bk2++) {
            var bj2 = bk2 + ((rng() * (deckLen - bk2)) | 0);
            var bt2 = deck[bj2]; deck[bj2] = deck[bk2]; deck[bk2] = bt2;
          }
          // 对手手牌必须在「当前牌面」上够强；判定只看已经翻出来的牌，
          // 因为他做决定时也只看得到这些
          var pos2 = need;
          for (var op2 = 0; op2 < oppCount; op2++) {
            var a1 = pos2, a2 = pos2 + 1;
            var strong2 = op2 < strongN;
            if (!strong2 && !wideByBoard) {
              // 这组不筛，随机发
              a1 = pos2 + ((rng() * (deckLen - pos2)) | 0);
              do { a2 = pos2 + ((rng() * (deckLen - pos2)) | 0); } while (a2 === a1);
            } else {
              var cut2 = strong2 ? cutoff : cutoffWide;
              for (var t2 = 0; t2 < 80; t2++) {
                a1 = pos2 + ((rng() * (deckLen - pos2)) | 0);
                a2 = pos2 + ((rng() * (deckLen - pos2)) | 0);
                if (a1 === a2) continue;
                if (boardStrength(deck[a1], deck[a2], fBoard, fLen) >= cut2) break;
              }
            }
            var q1 = deck[a1]; deck[a1] = deck[pos2]; deck[pos2] = q1;
            if (a2 === pos2) a2 = a1;
            var q2 = deck[a2]; deck[a2] = deck[pos2 + 1]; deck[pos2 + 1] = q2;
            pos2 += 2;
          }
        } else if (ranged) {
          // 先洗出公共牌
          for (var bk = 0; bk < need; bk++) {
            var bj = bk + ((rng() * (deckLen - bk)) | 0);
            var bt = deck[bj]; deck[bj] = deck[bk]; deck[bk] = bt;
          }
          // 再给每个对手抽两张，抽到不在范围内的就放回重抽
          var pos = need;
          for (var op = 0; op < oppCount; op++) {
            var i1 = pos, i2 = pos + 1;
            var mp2 = op < strongN ? maxPctl : wideTop;
            for (var tr = 0; tr < 60; tr++) {
              i1 = pos + ((rng() * (deckLen - pos)) | 0);
              i2 = pos + ((rng() * (deckLen - pos)) | 0);
              if (i1 === i2) continue;
              if (PFL.percentile(deck[i1], deck[i2]) <= mp2) break;
            }
            var s1 = deck[i1]; deck[i1] = deck[pos]; deck[pos] = s1;
            if (i2 === pos) i2 = i1;                      // 刚才那次交换把它挪走了
            var s2 = deck[i2]; deck[i2] = deck[pos + 1]; deck[pos + 1] = s2;
            pos += 2;
          }
        } else {
          // 部分 Fisher-Yates：只洗出需要的前 draw 张
          for (var k = 0; k < draw; k++) {
            var j = k + ((rng() * (deckLen - k)) | 0);
            var t = deck[j]; deck[j] = deck[k]; deck[k] = t;
          }
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
   * @param {number} [maxPctl=1] 只枚举落在最强前这么多比例的对手手牌。
   *        限定范围后仍是精确解，只是枚举的样本空间变小了。
   */
  function enumerateShowdownHeadsUp(hero, board, maxPctl, boardTop) {
    var deck = buildDeck(hero.concat(board));
    var h7 = hero.concat(board);
    var heroScore = evalHand(h7, 7);
    var o7 = board.concat([0, 0]);
    var win = 0, tie = 0, lose = 0, total = 0;
    var mp = maxPctl === undefined ? 1 : maxPctl;
    var PFL = global.PokerPreflop;
    var byBoard = boardTop !== undefined && boardTop < 1;
    var cut = byBoard ? boardCutoff(deck, board, boardTop) : 0;
    var ranged = !byBoard && mp < 1 && PFL;
    for (var i = 0; i < deck.length; i++) {
      for (var j = i + 1; j < deck.length; j++) {
        if (byBoard) { if (boardStrength(deck[i], deck[j], board, board.length) < cut) continue; }
        else if (ranged && PFL.percentile(deck[i], deck[j]) > mp) continue;
        o7[5] = deck[i]; o7[6] = deck[j];
        var s = evalHand(o7, 7);
        if (heroScore > s) win++; else if (heroScore < s) lose++; else tie++;
        total++;
      }
    }
    var catCounts = new Array(9).fill(0);
    catCounts[heroScore >>> 20] = 1;
    if (!total) return { n: 0, win: 0, tie: 0, lose: 0, winRate: 0, tieRate: 0,
      loseRate: 0, equity: 0.5, margin: 0, catCounts: catCounts, exact: true, elapsed: 0 };
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
    boardStrength: boardStrength,
    boardCutoff: boardCutoff,
    enumerateShowdownHeadsUp: enumerateShowdownHeadsUp
  };
})(typeof self !== 'undefined' ? self : this);
