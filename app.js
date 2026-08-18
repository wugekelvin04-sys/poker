/* 界面逻辑。计算全部交给 worker.js，主线程只负责渲染。 */
(function () {
  'use strict';
  var E = window.PokerEngine;
  var RANKS = E.RANK_CHARS, SUITS = E.SUIT_SYMBOLS;
  var SUIT_NAMES = ['黑桃', '红桃', '方块', '梅花'];
  var $ = function (id) { return document.getElementById(id); };

  // 槽位顺序：手牌 2 张 + 公共牌 5 张。
  // group 决定连选范围：选完一张自动跳到同组的下一个空位，本组填满就收起抽屉，
  // 不会跨组（选完手牌不会窜到公共牌去）。
  var SLOTS = [
    { kind: 'hero', i: 0, group: 'hero' }, { kind: 'hero', i: 1, group: 'hero' },
    { kind: 'board', i: 0, group: 'flop' }, { kind: 'board', i: 1, group: 'flop' },
    { kind: 'board', i: 2, group: 'flop' },
    { kind: 'board', i: 3, group: 'turn' },
    { kind: 'board', i: 4, group: 'river' }
  ];
  var SLOT_LABELS = ['手牌 1', '手牌 2', '翻牌 1', '翻牌 2', '翻牌 3', '转牌', '河牌'];

  var APP_VERSION = 'v9';

  var state = {
    hero: [null, null],
    board: [null, null, null, null, null],
    players: 6,
    pot: '',
    call: '',
    bettors: 1,          // 我前面已经投了这个跟注额的人数
    hideHero: false,     // 桌上怕被瞄到时，把自己的两张牌盖起来；不影响任何计算
    showDist: false      // 成牌分布默认收起，一屏放得下
  };
  var active = -1;      // 当前正在选的槽位下标
  var lastResult = null;

  // ---------- 持久化 ----------
  function save() {
    try { localStorage.setItem('poker-cal', JSON.stringify(state)); } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem('poker-cal');
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        if (Array.isArray(s.hero) && s.hero.length === 2) state.hero = s.hero;
        if (Array.isArray(s.board) && s.board.length === 5) state.board = s.board;
        if (s.players >= 2 && s.players <= 10) state.players = s.players;
        state.pot = s.pot || ''; state.call = s.call || '';
        state.hideHero = !!s.hideHero;
        state.showDist = !!s.showDist;
        if (s.bettors >= 0 && s.bettors <= 9) state.bettors = s.bettors;
      }
    } catch (e) {}
  }

  function slotCard(k) { var s = SLOTS[k]; return state[s.kind][s.i]; }
  function setSlotCard(k, c) { var s = SLOTS[k]; state[s.kind][s.i] = c; }
  function usedCards() {
    var u = [];
    for (var k = 0; k < SLOTS.length; k++) { var c = slotCard(k); if (c !== null) u.push(c); }
    return u;
  }

  // ---------- 渲染卡槽 ----------
  function cardHTML(c) {
    return '<span class="r">' + RANKS[c >> 2] + '</span><span class="s">' + SUITS[c & 3] + '</span>';
  }
  function isRed(c) { var s = c & 3; return s === 1 || s === 2; }

  function renderSlots() {
    var box = $('cards');
    box.innerHTML = '';
    SLOTS.forEach(function (s, k) {
      var el = document.createElement('button');
      el.className = 'slot';
      var c = slotCard(k);
      var masked = state.hideHero && s.group === 'hero' && c !== null;
      if (masked) {
        el.classList.add('back');
      } else if (c !== null) {
        el.classList.add('filled');
        if (isRed(c)) el.classList.add('red');
        el.innerHTML = cardHTML(c);
      } else {
        el.textContent = '+';
      }
      if (k === active) el.classList.add('active');
      el.setAttribute('aria-label', masked ? '手牌已隐藏，点一下显示' : SLOT_LABELS[k]);
      // 盖着的时候点一下先翻开，翻开状态再点才是换牌
      el.addEventListener('click', function () {
        if (masked) { state.hideHero = false; save(); renderSlots(); runNow(); }
        else openPicker(k);
      });
      box.appendChild(el);
    });
    // 牌下面那行分区标签，和上面的牌共用同一套网格，严格对齐
    box.insertAdjacentHTML('beforeend',
      '<span class="lbl lbl-hero">我的手牌</span>' +
      '<span class="lbl lbl-flop">翻牌</span>' +
      '<span class="lbl lbl-turn">转牌</span>' +
      '<span class="lbl lbl-river">河牌</span>');

    // 起手牌记号，如 AKs / AKo / AA
    var note = '';
    if (state.hero[0] !== null && state.hero[1] !== null) {
      var a = state.hero[0], b = state.hero[1];
      var ra = a >> 2, rb = b >> 2;
      var hi = Math.max(ra, rb), lo = Math.min(ra, rb);
      note = RANKS[hi] + RANKS[lo] + (ra === rb ? '' : ((a & 3) === (b & 3) ? 's' : 'o'));
    }
    $('heroNotation').textContent = state.hideHero ? '' : note;
    $('toggleHero').textContent = state.hideHero ? '显示' : '隐藏';

    var n = state.board.filter(function (c) { return c !== null; }).length;
    $('streetName').textContent =
      n === 0 ? '翻牌前' : n === 3 ? '翻牌' : n === 4 ? '转牌' : n === 5 ? '河牌' : n + ' 张';
  }

  // ---------- 人数 ----------
  function renderPlayers() {
    var box = $('players');
    box.innerHTML = '';
    for (var p = 2; p <= 10; p++) {
      (function (p) {
        var b = document.createElement('button');
        b.textContent = p;
        if (p === state.players) b.className = 'on';
        b.addEventListener('click', function () {
          state.players = p; renderPlayers(); renderBettors(); save(); compute();
        });
        box.appendChild(b);
      })(p);
    }
  }

  /* 前面下注人数：最多到「我之外的人数」，超过没有意义 */
  function renderBettors() {
    var box = $('bettors');
    var maxN = state.players - 1;
    if (state.bettors > maxN) state.bettors = maxN;
    box.innerHTML = '';
    for (var n = 0; n <= maxN; n++) {
      (function (n) {
        var b = document.createElement('button');
        b.textContent = n;
        if (n === state.bettors) b.className = 'on';
        b.addEventListener('click', function () {
          state.bettors = n; renderBettors(); save(); renderOdds();
        });
        box.appendChild(b);
      })(n);
    }
  }

  // ---------- 选牌抽屉 ----------
  function renderDeck() {
    var deck = $('deck');
    deck.innerHTML = '';
    var used = usedCards();
    var cur = active >= 0 ? slotCard(active) : null;
    for (var s = 0; s < 4; s++) {
      var row = document.createElement('div');
      row.className = 'deck-row';
      for (var r = 12; r >= 0; r--) {
        var c = (r << 2) | s;
        var b = document.createElement('button');
        b.className = 'pick' + (isRed(c) ? ' red' : '');
        // 当前槽位自己的那张牌不算被占用，方便原地更换
        if (used.indexOf(c) >= 0 && c !== cur) b.className += ' used';
        b.innerHTML = cardHTML(c);
        b.setAttribute('aria-label', RANKS[r] + SUIT_NAMES[s]);
        b.dataset.card = c;
        row.appendChild(b);
      }
      deck.appendChild(row);
    }
  }

  function openPicker(k) {
    active = k;
    $('sheetTitle').textContent = '选择' + SLOT_LABELS[k];
    $('sheetRemove').hidden = slotCard(k) === null;
    $('sheet').hidden = false;
    $('sheetMask').hidden = false;
    renderDeck();
    renderSlots();
  }
  function closePicker() {
    active = -1;
    $('sheet').hidden = true;
    $('sheetMask').hidden = true;
    renderSlots();
  }

  function pickCard(c) {
    if (active < 0) return;
    // 同一张牌不能出现在两个位置。抽屉里已经置灰了，这里再兜一道，
    // 免得任何意外路径把重复牌塞进去导致计算直接报错。
    for (var k = 0; k < SLOTS.length; k++) {
      if (k !== active && slotCard(k) === c) return;
    }
    setSlotCard(active, c);
    // 自动跳到同一组里后面第一个空槽，连着选不用反复开关；本组选完就收起
    var group = SLOTS[active].group, next = -1;
    for (var k = active + 1; k < SLOTS.length && SLOTS[k].group === group; k++) {
      if (slotCard(k) === null) { next = k; break; }
    }
    save(); compute();
    if (next >= 0) openPicker(next); else closePicker();
  }

  // ---------- 计算 ----------
  var worker = null, runId = 0, debounce = null, fallbackTimer = null;

  function stopWorker() {
    if (worker) { worker.terminate(); worker = null; }
    clearTimeout(fallbackTimer); fallbackTimer = null;
  }

  function stopAll() { stopWorker(); clearTimeout(mainLoopTimer); mainLoopTimer = null; }

  /* 把两次模拟的原始计数合并。simulate 返回的是比率，乘回次数即可还原。 */
  function mergeResults(a, b) {
    var n = a.n + b.n;
    var win = a.win + b.win, tie = a.tie + b.tie, lose = a.lose + b.lose;
    // 平局权益 = 权益×次数 − 独赢次数
    var tieEq = (a.equity * a.n - a.win) + (b.equity * b.n - b.win);
    var cat = [];
    for (var i = 0; i < 9; i++) cat.push((a.catCounts[i] * a.n + b.catCounts[i] * b.n) / n);
    var eq = (win + tieEq) / n;
    return {
      n: n, win: win, tie: tie, lose: lose,
      winRate: win / n, tieRate: tie / n, loseRate: lose / n, equity: eq,
      margin: 1.96 * Math.sqrt(Math.max(eq * (1 - eq), 1e-9) / n),
      catCounts: cat, exact: false, elapsed: 0
    };
  }

  /* Worker 起不来或没回音时退回主线程。
     切成小片轮流跑，界面不会僵住，次数照样能跑满。 */
  var mainLoopTimer = null;

  function runOnMainThread(hero, board, id) {
    if (id !== runId) return;
    stopWorker();
    clearTimeout(mainLoopTimer);
    if (!window.PokerSim) { $('eqNote').textContent = '计算模块没能加载，刷新试试'; return; }

    if (board.length === 5 && state.players === 2) {
      try {
        var ex = PokerSim.enumerateShowdownHeadsUp(hero, board);
        lastResult = ex; renderResult(ex, true);
      } catch (err) { $('eqNote').textContent = '出错：' + String((err && err.message) || err); }
      return;
    }

    var acc = null, started = Date.now();
    var CHUNK = 10000, TARGET = 250000, BUDGET = 2500;

    function step() {
      if (id !== runId) return;
      try {
        var part = PokerSim.simulate({
          hero: hero, board: board, players: state.players,
          maxIterations: CHUNK, timeLimitMs: 0
        });
        acc = acc ? mergeResults(acc, part) : part;
      } catch (err) {
        $('eqNote').textContent = '出错：' + String((err && err.message) || err);
        return;
      }
      var done = acc.n >= TARGET || Date.now() - started > BUDGET;
      lastResult = acc;
      renderResult(acc, done);
      $('eqNote').textContent += ' · 主线程';
      if (!done) mainLoopTimer = setTimeout(step, 0);
    }
    mainLoopTimer = setTimeout(step, 0);
  }

  function compute() {
    clearTimeout(debounce);
    debounce = setTimeout(runNow, 80);
  }

  function runNow() {
    var hero = state.hero.filter(function (c) { return c !== null; });
    var board = state.board.filter(function (c) { return c !== null; });

    // 先作废上一次计算，否则清空手牌时旧结果会把界面覆盖回去
    runId++;
    stopAll();
    renderMadeHand(hero, board);

    if (hero.length < 2) {
      lastResult = null;
      $('eqValue').textContent = '—';
      $('eqNote').textContent = '先选好自己的两张手牌';
      setBar(0, 0, 0);
      $('legWin').textContent = $('legTie').textContent = $('legLose').textContent = '—';
      $('dist').innerHTML = '';
      $('improve').textContent = '';
      renderOdds();
      return;
    }
    // 牌桌上的人手牌加公共牌不能超过一副牌
    if (2 * state.players + 5 > 52) { $('eqNote').textContent = '人数过多'; return; }

    $('eqNote').textContent = '计算中…';
    var id = runId;

    try {
      worker = new Worker('worker.js?v=' + APP_VERSION);
    } catch (err) {
      // 某些浏览器或隐私设置下根本创建不了 Worker
      runOnMainThread(hero, board, id);
      return;
    }

    worker.onerror = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      runOnMainThread(hero, board, id);
    };
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.id !== runId) return;
      if (m.type === 'error') { $('eqNote').textContent = '出错：' + m.message; stopWorker(); return; }
      clearTimeout(fallbackTimer); fallbackTimer = null;
      lastResult = m.result;
      renderResult(m.result, m.type === 'done');
      if (m.type === 'done') stopWorker();
    };
    // worker 迟迟不回音也要出结果，绝不能停在「计算中…」
    fallbackTimer = setTimeout(function () {
      runOnMainThread(hero, board, id);
    }, 4000);

    worker.postMessage({
      type: 'run', id: id, hero: hero, board: board, players: state.players,
      maxIterations: 250000, timeLimitMs: 1600
    });
  }

  /* 不指定小数位时自动挑精度：0.02% 不该显示成 0.0%，那看起来像「不可能」。 */
  function pct(x, d) {
    if (d !== undefined) return (x * 100).toFixed(d) + '%';
    var v = x * 100;
    if (v === 0) return '0%';
    if (v >= 1) return v.toFixed(1) + '%';
    if (v >= 0.1) return v.toFixed(2) + '%';
    if (v >= 0.01) return v.toFixed(3) + '%';
    return '<0.01%';
  }

  /* 顶部那个大数字，同上但不带百分号 */
  function eqNum(x) {
    var v = x * 100;
    if (v === 0) return '0';
    if (v >= 1) return v.toFixed(1);
    if (v >= 0.1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(3);
    return '<0.01';
  }

  function marginStr(m) {
    var v = m * 100;
    return v >= 0.1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4);
  }

  function setBar(w, t, l) {
    $('barWin').style.width = (w * 100) + '%';
    $('barTie').style.width = (t * 100) + '%';
    $('barLose').style.width = (l * 100) + '%';
  }

  function renderResult(r, done) {
    $('eqValue').textContent = eqNum(r.equity);
    setBar(r.winRate, r.tieRate, r.loseRate);
    $('legWin').textContent = pct(r.winRate);
    $('legTie').textContent = pct(r.tieRate);
    $('legLose').textContent = pct(r.loseRate);

    // 胜率含平局分摊，和「独赢」不是一回事，容易被误会成算错了
    var ex = $('eqExplain');
    if (r.tieRate >= 0.005) {
      ex.hidden = false;
      ex.innerHTML = '胜率 = 独赢 <b>' + pct(r.winRate) + '</b> + 平分底池折算的 <b>'
        + pct(r.equity - r.winRate) + '</b>';
    } else {
      ex.hidden = true;
    }

    if (r.exact) {
      $('eqNote').textContent = '精确枚举 ' + r.n.toLocaleString() + ' 种可能，无误差';
    } else {
      var wan = (r.n / 10000).toFixed(r.n >= 100000 ? 0 : 1);
      if (r.win === 0 && r.tie === 0) {
        // 一次都没赢时报「±0」是骗人的，改成给出真实胜率的上界
        $('eqNote').textContent = '模拟 ' + wan + ' 万次一次没赢 · 真实胜率不超过 '
          + marginStr(r.margin) + '%' + (done ? '' : ' …');
      } else {
        $('eqNote').textContent = '模拟 ' + wan + ' 万次 · 误差 ±' + marginStr(r.margin) + '%'
          + (done ? '' : ' …');
      }
    }
    renderDist(r);
    renderOdds();
  }

  // ---------- 当前牌型与成牌分布 ----------
  function renderMadeHand(hero, board) {
    var el = $('made');
    el.classList.remove('hidden-hand');
    if (hero.length < 2) { el.textContent = '—'; $('madeHint').hidden = true; return; }
    var score = E.evalHand(hero.concat(board));
    el.dataset.cat = score >>> 20;
    if (state.hideHero) {
      // 牌型会直接暴露手牌，一并遮住
      el.textContent = '已隐藏（点手牌显示）';
      el.classList.add('hidden-hand');
      $('madeHint').hidden = true;
      return;
    }
    el.textContent = E.describe(score);

    // 牌型完全由公共牌凑成时，桌上每个人都有这副牌，你拼的只是踢脚。
    // 这种局面人一多胜率会塌得很快，值得单独提醒。
    var hint = $('madeHint');
    hint.hidden = true;
    if (board.length >= 3) {
      var bs = E.evalHand(board);
      if ((bs >>> 20) >= 1 && (bs >>> 20) === (score >>> 20)) {
        hint.hidden = false;
        hint.textContent = '公共牌本身就是' + E.describe(bs)
          + '，桌上每个人都有，你比的只是踢脚';
      }
    }
  }

  function renderDist(r) {
    var box = $('dist');
    var boardN = state.board.filter(function (c) { return c !== null; }).length;
    var curCat = parseInt($('made').dataset.cat || '0', 10);
    var markCur = !state.hideHero;   // 高亮当前牌型同样会泄漏手牌

    if (boardN >= 5) {
      // 河牌已发完，不存在“还能成什么牌”
      box.innerHTML = '';
      $('toggleDist').hidden = true;
      $('improve').textContent = '牌已发完，这就是最终牌型';
      return;
    }
    $('toggleDist').hidden = false;
    if (state.hideHero) {
      $('improve').textContent = '';
    } else {
      var improve = 0;
      for (var c = curCat + 1; c <= 8; c++) improve += r.catCounts[c];
      $('improve').innerHTML = '河牌发完后牌型变大的概率 <b>' + pct(improve) + '</b>';
    }

    $('toggleDist').textContent = state.showDist ? '收起' : '成牌分布';
    if (!state.showDist) { box.innerHTML = ''; return; }

    var max = Math.max.apply(null, r.catCounts);
    var html = '';
    for (var i = 8; i >= 0; i--) {
      var p = r.catCounts[i];
      if (p < 0.0005) continue;
      html += '<div class="dist-row' + (markCur && i === curCat ? ' cur' : '') + '">'
        + '<span class="nm">' + E.CAT_NAMES[i] + '</span>'
        + '<span class="tr"><span class="fl" style="width:' + (p / max * 100).toFixed(1) + '%"></span></span>'
        + '<span class="vl">' + pct(p, p < 0.01 ? 2 : 1) + '</span></div>';
    }
    box.innerHTML = html;
  }

  // ---------- 底池赔率 ----------
  function num(v) { var x = parseFloat(v); return isFinite(x) && x > 0 ? x : 0; }

  /* 筹码金额取整：大额不带小数，小额留一位 */
  function chips(x) {
    return x >= 20 ? String(Math.round(x)) : String(Math.round(x * 10) / 10);
  }

  function renderOdds() {
    var out = $('oddsOut');
    if (!lastResult) { out.textContent = '先选好自己的两张手牌'; return; }

    var potBefore = num(state.pot);        // 他们这轮下注之前池子里的钱
    var call = num(state.call);            // 我要跟的额度
    var bettors = state.bettors;           // 前面已经投了这个额度的人数
    var potNow = potBefore + call * bettors;   // 我行动时的实际底池

    var eq = lastResult.equity;
    var fair = 1 / state.players;          // 均分时每人应得的份额
    var ratio = eq / fair;

    // ---- 没人下注 ----
    if (call <= 0) {
      if (potNow <= 0) {
        // 第一轮，池子还是空的：没有底池就算不出赔率，只能定性判断
        var v0, c0, d0;
        if (ratio >= 1.6) {
          v0 = '值得进攻'; c0 = 'good';
          d0 = '胜率 <b>' + pct(eq) + '</b> 远高于 ' + state.players + ' 人桌的公平份额 <b>'
            + pct(fair) + '</b>，主动下注建池。';
        } else if (ratio >= 1.15) {
          v0 = '可以入池'; c0 = 'good';
          d0 = '胜率 <b>' + pct(eq) + '</b> 略高于公平份额 <b>' + pct(fair) + '</b>，值得看一手，别投太多。';
        } else if (ratio >= 0.85) {
          v0 = '边缘'; c0 = 'even';
          d0 = '胜率 <b>' + pct(eq) + '</b> 和公平份额 <b>' + pct(fair) + '</b> 差不多，看位置决定。';
        } else {
          v0 = '弃牌 ✕'; c0 = 'bad';
          d0 = '胜率 <b>' + pct(eq) + '</b> 明显不到公平份额 <b>' + pct(fair) + '</b>，这手不值得投钱。';
        }
        out.innerHTML = '<span class="verdict ' + c0 + '">' + v0 + '</span>' + d0
          + '<br>填上底池金额，就能给出该下多少筹码。';
        return;
      }
      var bet, verdict1, cls1, why1;
      if (ratio >= 2) {
        bet = potNow * 0.75;
        verdict1 = '下注 ' + chips(bet); cls1 = 'good';
        why1 = '牌力明显领先：胜率 <b>' + pct(eq) + '</b>，' + state.players
          + ' 人桌的公平份额只有 <b>' + pct(fair) + '</b>。下 ¾ 池要价值。';
      } else if (ratio >= 1.3) {
        bet = potNow * 0.5;
        verdict1 = '下注 ' + chips(bet); cls1 = 'good';
        why1 = '小幅领先：胜率 <b>' + pct(eq) + '</b> 高于公平份额 <b>' + pct(fair)
          + '</b>。下 ½ 池薄价值，别下太大。';
      } else {
        verdict1 = '过牌'; cls1 = 'even';
        why1 = '胜率 <b>' + pct(eq) + '</b> 没到 ' + state.players + ' 人桌的公平份额 <b>'
          + pct(fair) + '</b>，先别主动投钱。';
      }
      out.innerHTML = '<span class="verdict ' + cls1 + '">' + verdict1 + '</span>' + why1
        + '<br>当前底池 <b>' + chips(potNow) + '</b>。';
      return;
    }

    // ---- 有人下注 ----
    if (bettors <= 0) {
      out.innerHTML = '<span class="verdict even">还差一步</span>'
        + '既然要跟注，前面至少有一个人下了注。选一下<b>前面几人下注</b>，我才能算出底池。';
      return;
    }

    var required = call / (potNow + call);       // 跟注所需的最低胜率
    var ev = eq * (potNow + call) - call;        // 跟注的期望收益
    var edge = eq - required;
    var raiseTo = call + 0.7 * (potNow + call);  // 跟平后再按约 ⅔ 池加

    var verdict, cls;
    if (edge < -0.02) { verdict = '弃牌 ✕'; cls = 'bad'; }
    else if (edge < 0.02) { verdict = '临界，看位置和对手'; cls = 'even'; }
    else if (eq >= 1.6 * fair && edge >= 0.15) { verdict = '加注到 ' + chips(raiseTo); cls = 'good'; }
    else { verdict = '跟注 ' + chips(call); cls = 'good'; }

    var html = '<span class="verdict ' + cls + '">' + verdict + '</span>'
      + '底池 <b>' + chips(potNow) + '</b>'
      + (bettors > 0 && call > 0
          ? '（原 ' + chips(potBefore) + ' + ' + bettors + ' 人 × ' + chips(call) + '）'
          : '')
      + '，跟注需要 <b>' + pct(required) + '</b> 胜率，你有 <b>' + pct(eq) + '</b>'
      + '（' + (edge >= 0 ? '多 ' : '差 ') + pct(Math.abs(edge)) + '）<br>'
      + '跟注的期望收益 <b>' + (ev >= 0 ? '+' : '−') + chips(Math.abs(ev)) + '</b>';
    if (cls === 'good' && verdict.indexOf('加注') === 0) {
      html += '<br>优势够大，值得加注施压：跟平后按约 ⅔ 池加到 <b>' + chips(raiseTo) + '</b>。';
    }
    out.innerHTML = html;
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('deck').addEventListener('click', function (e) {
      var b = e.target.closest('.pick');
      if (b) pickCard(parseInt(b.dataset.card, 10));
    });
    $('toggleDist').addEventListener('click', function () {
      state.showDist = !state.showDist;
      save();
      if (lastResult) renderDist(lastResult);
      else $('toggleDist').textContent = state.showDist ? '收起' : '成牌分布';
    });
    $('toggleHero').addEventListener('click', function () {
      state.hideHero = !state.hideHero;
      save(); renderSlots(); runNow();
    });
    $('sheetClose').addEventListener('click', closePicker);
    $('sheetMask').addEventListener('click', closePicker);
    $('sheetRemove').addEventListener('click', function () {
      if (active >= 0) { setSlotCard(active, null); save(); compute(); closePicker(); }
    });

    document.querySelectorAll('[data-clear]').forEach(function (b) {
      b.addEventListener('click', function () {
        var what = b.dataset.clear;
        if (what === 'hero' || what === 'all') state.hero = [null, null];
        if (what === 'board' || what === 'all') state.board = [null, null, null, null, null];
        save(); renderSlots(); compute();
      });
    });

    ['pot', 'call'].forEach(function (k) {
      var el = $(k);
      el.value = state[k];
      el.addEventListener('input', function () {
        state[k] = el.value; save(); renderOdds();
      });
      // 点进来光标会落在数字中间，很难改。直接全选，打字即覆盖。
      el.addEventListener('focus', function () {
        setTimeout(function () { try { el.select(); } catch (e) {} }, 0);
      });
    });
    $('clearOdds').addEventListener('click', function () {
      state.pot = ''; state.call = ''; state.bettors = 1;
      $('pot').value = ''; $('call').value = '';
      renderBettors(); save(); renderOdds();
    });
    $('quickBets').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var pot = num(state.pot);
      var f = parseFloat(b.dataset.frac);
      if (f === 0) { state.call = '0'; $('call').value = '0'; save(); renderOdds(); return; }
      if (!pot) { $('pot').focus(); return; }
      // 底池填的是下注之前的数额，所以尺度直接乘即可，无需折算
      state.call = String(Math.round(pot * f * 10) / 10);
      if (state.bettors < 1) state.bettors = 1;
      $('call').value = state.call;
      renderBettors(); save(); renderOdds();
    });
  }

  // ---------- 启动 ----------
  try {
    load();
    renderSlots();
    renderPlayers();
    renderBettors();
    bind();
    compute();
    window.__APP_OK = true;   // 页面里的自愈脚本靠这个判断有没有起来
  } catch (err) {
    // 起不来通常是缓存里新旧版本对不上，交给自愈脚本清缓存重来
    if (window.console) console.error('初始化失败', err);
  }

  // ---------- 自动更新 ----------
  // 主屏 App 没有地址栏也没有刷新按钮，必须自己处理更新，
  // 否则用户永远停在旧版本上。
  $('verNum').textContent = APP_VERSION;

  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // 首次安装也会触发，那次不算更新，别刷
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // 每次回到前台都查一下有没有新版本
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) reg.update();
        });
        window.addEventListener('focus', function () { reg.update(); });
      }).catch(function () {});
    });
  }

  // 兜底：万一自动更新没生效，点一下清干净重来
  $('forceUpdate').addEventListener('click', function () {
    var btn = $('forceUpdate');
    btn.textContent = '正在更新…';
    var jobs = [];
    if ('serviceWorker' in navigator) {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) {
        return Promise.all(rs.map(function (r) { return r.unregister(); }));
      }));
    }
    if (window.caches) {
      jobs.push(caches.keys().then(function (ks) {
        return Promise.all(ks.map(function (k) { return caches.delete(k); }));
      }));
    }
    Promise.all(jobs)['catch'](function () {}).then(function () {
      location.replace(location.pathname + '?u=' + Date.now());
    });
  });
})();
