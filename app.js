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

  var state = {
    hero: [null, null],
    board: [null, null, null, null, null],
    players: 6,
    pot: '',
    call: '',
    hideHero: false      // 桌上怕被瞄到时，把自己的两张牌盖起来；不影响任何计算
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
    var hero = $('heroSlots'), board = $('boardSlots');
    hero.innerHTML = ''; board.innerHTML = '';
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
      (s.kind === 'hero' ? hero : board).appendChild(el);
    });

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
          state.players = p; renderPlayers(); save(); compute();
        });
        box.appendChild(b);
      })(p);
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
      worker = new Worker('worker.js');
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

  function pct(x, d) { return (x * 100).toFixed(d === undefined ? 1 : d) + '%'; }

  function setBar(w, t, l) {
    $('barWin').style.width = (w * 100) + '%';
    $('barTie').style.width = (t * 100) + '%';
    $('barLose').style.width = (l * 100) + '%';
  }

  function renderResult(r, done) {
    $('eqValue').textContent = (r.equity * 100).toFixed(1);
    setBar(r.winRate, r.tieRate, r.loseRate);
    $('legWin').textContent = pct(r.winRate);
    $('legTie').textContent = pct(r.tieRate, r.tieRate < 0.01 ? 2 : 1);
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
      $('eqNote').textContent = '模拟 ' + wan + ' 万次 · 误差 ±' + (r.margin * 100).toFixed(2) + '%'
        + (done ? '' : ' …');
    }
    renderDist(r);
    renderOdds();
  }

  // ---------- 当前牌型与成牌分布 ----------
  function renderMadeHand(hero, board) {
    var el = $('made');
    el.classList.remove('hidden-hand');
    if (hero.length < 2) { el.textContent = '—'; return; }
    var score = E.evalHand(hero.concat(board));
    el.dataset.cat = score >>> 20;
    if (state.hideHero) {
      // 牌型会直接暴露手牌，一并遮住
      el.textContent = '已隐藏（点手牌显示）';
      el.classList.add('hidden-hand');
    } else {
      el.textContent = E.describe(score);
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
      $('improve').textContent = '牌已发完，这就是最终牌型';
      return;
    }
    if (state.hideHero) {
      $('improve').textContent = '';
    } else {
      var improve = 0;
      for (var c = curCat + 1; c <= 8; c++) improve += r.catCounts[c];
      $('improve').innerHTML = '河牌发完后牌型变大的概率 <b>' + pct(improve) + '</b>';
    }

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

  function renderOdds() {
    var out = $('oddsOut');
    var pot = num(state.pot), call = num(state.call);
    if (!call) { out.textContent = '填入底池和需跟注的金额'; return; }
    var required = call / (pot + call);
    if (!lastResult) {
      out.innerHTML = '需要至少 <b>' + pct(required) + '</b> 的胜率才值得跟注';
      return;
    }
    var eq = lastResult.equity;
    var ev = eq * (pot + call) - call;
    var edge = eq - required;
    var cls = edge > 0.02 ? 'good' : edge < -0.02 ? 'bad' : 'even';
    var verdict = edge > 0.02 ? '跟注 ✓' : edge < -0.02 ? '弃牌 ✕' : '临界，看位置和后续行动';
    out.innerHTML =
      '<span class="verdict ' + cls + '">' + verdict + '</span>'
      + '需要胜率 <b>' + pct(required) + '</b>，你有 <b>' + pct(eq) + '</b>'
      + '（' + (edge >= 0 ? '多 ' : '差 ') + pct(Math.abs(edge)) + '）<br>'
      + '跟注的期望收益 <b>' + (ev >= 0 ? '+' : '') + ev.toFixed(1) + '</b>';
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('deck').addEventListener('click', function (e) {
      var b = e.target.closest('.pick');
      if (b) pickCard(parseInt(b.dataset.card, 10));
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
        if (b.dataset.clear === 'hero') state.hero = [null, null];
        else state.board = [null, null, null, null, null];
        save(); renderSlots(); compute();
      });
    });

    ['pot', 'call'].forEach(function (k) {
      $(k).value = state[k];
      $(k).addEventListener('input', function () {
        state[k] = $(k).value; save(); renderOdds();
      });
    });
    $('quickBets').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var pot = num(state.pot);
      if (!pot) { $('pot').focus(); return; }
      // 底池字段填的是对手下注之后的总额 P' = P + f·P。
      // 所以我要跟的金额 = f·P = P' · f/(1+f)。不改底池，重复点击不会累加。
      var f = parseFloat(b.dataset.frac);
      state.call = String(Math.round(pot * f / (1 + f) * 10) / 10);
      $('call').value = state.call;
      save(); renderOdds();
    });
  }

  // ---------- 启动 ----------
  load();
  renderSlots();
  renderPlayers();
  bind();
  compute();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
