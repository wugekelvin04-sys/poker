/* 德州扑克牌力评估引擎
 * 纯脚本，无模块依赖：浏览器 <script>、Worker importScripts、Node vm 均可加载。
 *
 * 牌编码：0-51 的整数。rank = c >> 2（0=2, 1=3, ... 12=A），suit = c & 3（0=♠ 1=♥ 2=♦ 3=♣）
 * 评估结果：32 位整数分值 = 牌型等级 << 20 | 五张关键牌打包（每张 4 位，从高到低左对齐）
 *          同类型之间直接用 > 比较即可，无需元组比较。
 */
(function (global) {
  'use strict';

  var RANK_CHARS = '23456789TJQKA';
  var SUIT_CHARS = 'shdc';           // ♠ ♥ ♦ ♣
  var SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];

  var CAT_NAMES = [
    '高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'
  ];

  // ---------- 预计算查找表（13 位 rank 掩码 → 8192 项）----------
  var POPCNT = new Uint8Array(8192);
  var STRAIGHT_HIGH = new Int8Array(8192);   // 最高顺子的顶张 rank，无顺子为 -1
  var TOP5 = new Int32Array(8192);           // 最高 5 张打包（20 位，高位在前，不足补 0）

  var WHEEL = (1 << 12) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3); // A-2-3-4-5

  (function buildTables() {
    for (var m = 0; m < 8192; m++) {
      // popcount
      var v = m, pc = 0;
      while (v) { v &= v - 1; pc++; }
      POPCNT[m] = pc;

      // 顺子：从 A 高往下找连续 5 张
      var hi = -1;
      for (var h = 12; h >= 4; h--) {
        var run = 0x1F << (h - 4);
        if ((m & run) === run) { hi = h; break; }
      }
      // 轮子 A-2-3-4-5，顶张是 5（rank 3）
      if (hi < 0 && (m & WHEEL) === WHEEL) hi = 3;
      STRAIGHT_HIGH[m] = hi;

      // 最高 5 张打包
      var packed = 0, n = 0;
      for (var r = 12; r >= 0 && n < 5; r--) {
        if (m & (1 << r)) { packed = (packed << 4) | r; n++; }
      }
      TOP5[m] = packed << ((5 - n) * 4);
    }
  })();

  var _cnt = new Int8Array(13); // 复用，避免每次分配

  /**
   * 评估 2-7 张牌的牌力。
   * @param {ArrayLike<number>} cards 牌数组
   * @param {number} [n] 参与评估的张数，默认 cards.length
   * @returns {number} 分值，越大越强
   */
  function evalHand(cards, n) {
    if (n === undefined) n = cards.length;

    var rankMask = 0, s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    _cnt[0] = _cnt[1] = _cnt[2] = _cnt[3] = _cnt[4] = _cnt[5] = _cnt[6] = 0;
    _cnt[7] = _cnt[8] = _cnt[9] = _cnt[10] = _cnt[11] = _cnt[12] = 0;

    for (var i = 0; i < n; i++) {
      var c = cards[i], r = c >> 2, b = 1 << r;
      rankMask |= b;
      _cnt[r]++;
      switch (c & 3) {
        case 0: s0 |= b; break;
        case 1: s1 |= b; break;
        case 2: s2 |= b; break;
        default: s3 |= b;
      }
    }

    // 同花 / 同花顺
    var fm = 0;
    if (POPCNT[s0] >= 5) fm = s0;
    else if (POPCNT[s1] >= 5) fm = s1;
    else if (POPCNT[s2] >= 5) fm = s2;
    else if (POPCNT[s3] >= 5) fm = s3;
    if (fm) {
      var sfHigh = STRAIGHT_HIGH[fm];
      if (sfHigh >= 0) return (8 << 20) | (sfHigh << 16);
      return (5 << 20) | TOP5[fm];
    }

    // 按重复张数分组（从高 rank 往低扫，先取到的即最大）
    var quad = -1, trip = -1, trip2 = -1, p1 = -1, p2 = -1;
    for (var r2 = 12; r2 >= 0; r2--) {
      var c2 = _cnt[r2];
      if (c2 === 4) { if (quad < 0) quad = r2; }
      else if (c2 === 3) { if (trip < 0) trip = r2; else if (trip2 < 0) trip2 = r2; }
      else if (c2 === 2) { if (p1 < 0) p1 = r2; else if (p2 < 0) p2 = r2; }
    }

    // 四条
    if (quad >= 0) {
      var qk = TOP5[rankMask & ~(1 << quad)] >>> 16;
      return (7 << 20) | (quad << 16) | (qk << 12);
    }
    // 葫芦（两组三条时，较小的那组当对子用）
    if (trip >= 0 && (trip2 >= 0 || p1 >= 0)) {
      var pr = trip2 >= 0 ? (p1 > trip2 ? p1 : trip2) : p1;
      return (6 << 20) | (trip << 16) | (pr << 12);
    }
    // 顺子
    var sh = STRAIGHT_HIGH[rankMask];
    if (sh >= 0) return (4 << 20) | (sh << 16);
    // 三条
    if (trip >= 0) {
      var tk = TOP5[rankMask & ~(1 << trip)] >>> 12;   // 顶 2 张，8 位
      return (3 << 20) | (trip << 16) | (tk << 8);
    }
    // 两对
    if (p1 >= 0 && p2 >= 0) {
      var pk = TOP5[rankMask & ~(1 << p1) & ~(1 << p2)] >>> 16; // 顶 1 张，4 位
      return (2 << 20) | (p1 << 16) | (p2 << 12) | (pk << 8);
    }
    // 一对
    if (p1 >= 0) {
      var k3 = TOP5[rankMask & ~(1 << p1)] >>> 8;      // 顶 3 张，12 位
      return (1 << 20) | (p1 << 16) | (k3 << 4);
    }
    // 高牌
    return TOP5[rankMask];
  }

  function category(score) { return score >>> 20; }

  /** 牌型中文名，皇家同花顺单独识别 */
  function categoryName(score) {
    var cat = score >>> 20;
    if (cat === 8 && ((score >>> 16) & 0xF) === 12) return '皇家同花顺';
    return CAT_NAMES[cat];
  }

  /** 牌型全称，带关键牌，如「一对 A」「两对 K 9」「顺子 Q 高」 */
  function describe(score) {
    var cat = score >>> 20;
    var n1 = (score >>> 16) & 0xF, n2 = (score >>> 12) & 0xF;
    var R = RANK_CHARS;
    switch (cat) {
      case 8: return n1 === 12 ? '皇家同花顺' : '同花顺 ' + R[n1] + ' 高';
      case 7: return '四条 ' + R[n1];
      case 6: return '葫芦 ' + R[n1] + ' 带 ' + R[n2];
      case 5: return '同花 ' + R[n1] + ' 高';
      case 4: return '顺子 ' + R[n1] + ' 高';
      case 3: return '三条 ' + R[n1];
      case 2: return '两对 ' + R[n1] + ' ' + R[n2];
      case 1: return '一对 ' + R[n1];
      default: return '高牌 ' + R[n1];
    }
  }

  // ---------- 牌与字符串互转 ----------
  function cardToString(c) { return RANK_CHARS[c >> 2] + SUIT_CHARS[c & 3]; }
  function cardLabel(c) { return RANK_CHARS[c >> 2] + SUIT_SYMBOLS[c & 3]; }

  function cardFromString(s) {
    var r = RANK_CHARS.indexOf(s[0].toUpperCase());
    var u = SUIT_CHARS.indexOf(s[1].toLowerCase());
    if (r < 0 || u < 0) throw new Error('非法牌面: ' + s);
    return (r << 2) | u;
  }

  /** 解析 "As Kd Qh" 这类空格分隔的牌串 */
  function parseCards(str) {
    var out = [];
    var parts = String(str).trim().split(/[\s,]+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) out.push(cardFromString(parts[i]));
    return out;
  }

  global.PokerEngine = {
    RANK_CHARS: RANK_CHARS,
    SUIT_CHARS: SUIT_CHARS,
    SUIT_SYMBOLS: SUIT_SYMBOLS,
    CAT_NAMES: CAT_NAMES,
    evalHand: evalHand,
    category: category,
    categoryName: categoryName,
    describe: describe,
    cardToString: cardToString,
    cardLabel: cardLabel,
    cardFromString: cardFromString,
    parseCards: parseCards
  };
})(typeof self !== 'undefined' ? self : this);
