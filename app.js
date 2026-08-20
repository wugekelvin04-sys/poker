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

  var APP_VERSION = 'v39';

  var state = {
    hero: [null, null],
    board: [null, null, null, null, null],
    tableSize: 6,        // 桌上一共几人，一局一局不变
    seat: -1,            // 我在座位环里的下标，用于逐手轮转
    oppLevel: 'loose',   // 对手水平，决定按多强的范围给对手发牌
    players: 6,          // 这一手还剩几人没弃牌（含我）
    pot: 100,
    call: 0,
    stack: 200,          // 我手上还有多少筹码，建议不能超过它
    called: 0,           // 已投钱的人数（含下注者）；0 = 不确定，按下注尺度自己估
    pos: 'mid',          // 我的位置，决定开池范围
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
        if (s.tableSize >= 2 && s.tableSize <= 10) state.tableSize = s.tableSize;
        if (s.players >= 2 && s.players <= state.tableSize) state.players = s.players;
        if (typeof s.pot === 'number') state.pot = s.pot;
        if (typeof s.call === 'number') state.call = s.call;
        if (typeof s.stack === 'number') state.stack = s.stack;
        if (s.called >= 0 && s.called <= 9) state.called = s.called;
        state.hideHero = !!s.hideHero;
        state.showDist = !!s.showDist;
        if (POS.some(function (p) { return p.k === s.pos; })) state.pos = s.pos;
        if (typeof s.seat === 'number') state.seat = s.seat;
        if (OPP_LEVELS.some(function (l) { return l.k === s.oppLevel; })) state.oppLevel = s.oppLevel;
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
  /* 「还剩几人」每手都要改，用按钮；桌上总人数设一次就不动，用小输入框。
     按钮只渲染到总人数为止，不再摆一排点不动的灰按钮。 */
  function renderPlayers() {
    $('tableSize').value = String(state.tableSize);
    var box = $('players');
    box.innerHTML = '';
    for (var p = 2; p <= state.tableSize; p++) {
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
    box.style.gridTemplateColumns = 'repeat(' + (state.tableSize - 1) + ',1fr)';
  }

  function renderPos() {
    var box = $('pos');
    box.innerHTML = '';
    POS.forEach(function (p) {
      var b = document.createElement('button');
      b.textContent = p.n;
      if (p.k === state.pos) b.className = 'on';
      b.addEventListener('click', function () {
        // 手动选位置时，落到该档的第一个座位
        state.pos = p.k;
        state.seat = posCycle().indexOf(p.k);
        renderPos(); save(); renderOdds();
      });
      box.appendChild(b);
    });
  }

  function renderOppLevel() {
    var box = $('oppLevel');
    box.innerHTML = '';
    OPP_LEVELS.forEach(function (l) {
      var b = document.createElement('button');
      b.textContent = l.n;
      if (l.k === state.oppLevel) b.className = 'on';
      b.addEventListener('click', function () {
        state.oppLevel = l.k; renderOppLevel(); save(); compute();
      });
      box.appendChild(b);
    });
  }

  /* 快捷金额和输入框并存：点按钮直接填，也可以自己敲一个数 */
  function renderMoney(boxId, key, presets) {
    var box = $(boxId);
    box.innerHTML = '';
    presets.forEach(function (v) {
      var b = document.createElement('button');
      b.textContent = v;
      if (v === state[key]) b.className = 'on';
      b.addEventListener('click', function () {
        state[key] = v;
        $(key).value = v === 0 ? '' : String(v);
        renderMoney(boxId, key, presets);
        renderBettors(); save(); refresh();
      });
      box.appendChild(b);
    });
    // 底池这一行多一个累加键：每有一个人跟注就点一下，不用心算
    if (key === 'pot') {
      var add = document.createElement('button');
      add.className = 'add';
      add.textContent = state.call > 0 ? '+' + chips(state.call) : '+';
      if (state.call <= 0) add.className += ' off';
      add.addEventListener('click', function () {
        if (state.call <= 0) return;
        state.pot = Math.round(state.pot + state.call);
        $('pot').value = String(state.pot);
        renderMoney(boxId, key, presets);
        save(); refresh();
      });
      box.appendChild(add);
    }
  }

  /* 已经把这笔钱投进池子的人数（含下注的那个） */
  function renderCalled() {
    var box = $('called');
    var maxN = Math.max(1, state.players - 1);
    if (state.called > maxN) state.called = maxN;
    box.innerHTML = '';
    // 第一个是「?」——不确定就别填，按下注尺度自己估
    for (var n = 0; n <= maxN; n++) {
      (function (n) {
        var b = document.createElement('button');
        b.textContent = n === 0 ? '?' : n;
        if (n === state.called) b.className = 'on';
        b.addEventListener('click', function () {
          state.called = n; renderCalled(); save(); refresh();
        });
        box.appendChild(b);
      })(n);
    }
    box.style.gridTemplateColumns = 'repeat(' + (maxN + 1) + ',1fr)';
  }

  function renderBettors() {
    renderPos();
    renderCalled();
    $('calledRow').hidden = !facingBet() || boardCount() === 0;
    renderOppLevel();
    renderMoney('potSeg', 'pot', POT_PRESETS);
    renderMoney('callSeg', 'call', CALL_PRESETS);
    // 位置只在翻牌前用得上；下注人数只在有人下注时才需要
    var preflop = state.board.every(function (c) { return c === null; });
    // 位置常驻可改。它虽然只参与翻牌前的判断，但会随「新一局」自动顺延，
    // 设错了如果翻牌后不让改，下一局会跟着错下去，一路错到底。
    $('posRow').hidden = false;
    // 翻牌前没人加注时，开池与否只看起手牌和位置，底池金额用不上
    // 翻牌前完全不看底池，只看位置和起手牌范围
    $('potRow').hidden = preflop;
    $('hintRow').hidden = preflop;
    // 翻牌前的加注是按大盲倍数，不是按池比例，快捷尺度用不上
    // 盲注位已经投过钱，只需补差额，而且那笔钱已经算在底池里了。
    // 不提醒的话很容易把整笔下注额填进「要跟」，把所需胜率抬到离谱。
    $('hintRow').textContent = '底池 = 中间现在一共多少，已含他下的注；要跟填 0 = 没人下注';
  }

  // ---------- 选牌抽屉 ----------
  function renderDeck() {
    var deck = $('deck');
    deck.innerHTML = '';
    var used = usedCards();
    var cur = active >= 0 ? slotCard(active) : null;
    // 花色编码是 0♠ 1♥ 2♦ 3♣，但选牌面板按 黑桃 红桃 梅花 方片 排
    var SUIT_ORDER = [0, 1, 3, 2];
    for (var si = 0; si < 4; si++) {
      var s = SUIT_ORDER[si];
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
    // 从点的那张一路选到本组最后一张，中间那张即使已经有牌也照样停一下，
    // 方便顺手改；走完本组才收起抽屉。
    var group = SLOTS[active].group;
    var next = (active + 1 < SLOTS.length && SLOTS[active + 1].group === group)
      ? active + 1 : -1;
    save(); renderBettors(); compute();
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

    if (board.length === 5 && showdownPlayers() === 2) {
      try {
        var ex = PokerSim.enumerateShowdownHeadsUp(hero, board, 1, activePctl());
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
          hero: hero, board: board, players: showdownPlayers(),
          maxIterations: CHUNK, timeLimitMs: 0,
          oppMaxPctl: board.length >= 3 ? 1 : activePctl(),
          oppBoardTop: board.length >= 3 ? activePctl() : undefined,
          oppStrong: strongOppCount(),
          oppWideTop: wideTopPctl(),
          oppFilterLen: filterLen()
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
      type: 'run', id: id, hero: hero, board: board, players: showdownPlayers(),
      maxIterations: 250000, timeLimitMs: 1600,
      oppMaxPctl: board.length >= 3 ? 1 : activePctl(),
      oppBoardTop: board.length >= 3 ? activePctl() : undefined,
      oppStrong: strongOppCount(),
      oppWideTop: wideTopPctl(),
      oppFilterLen: filterLen()
    });
    lastPctl = activePctl();
  }

  /* 不指定小数位时自动挑精度：0.02% 不该显示成 0.0%，那看起来像「不可能」。 */
  /* 不是按随机牌算的时候要讲清楚，否则用户会以为胜率算低了 */
  function showdownNote() {
    var sp = showdownPlayers();
    return sp !== state.players
      ? ' · 按会跟到底的 ' + (sp - 1) + ' 名对手估算（其余还没说话，多半会弃）' : '';
  }

  function rangeNote() {
    var p = activePctl();
    if (p >= 1) return showdownNote();
    // 翻牌前按起手牌排位筛，翻牌后按「在这个牌面上有多强」筛
    return (boardCount() >= 3
      ? ' · 按对手在此牌面前 ' + Math.round(p * 100) + '% 的牌估算'
      : ' · 按对手前 ' + Math.round(p * 100) + '% 的起手牌估算') + showdownNote();
  }

  /* 金额变了：只有当对手范围口径也跟着变时才值得重算胜率，
     否则光刷新建议就够，免得每点一下按钮都重跑一次模拟。 */
  var lastPctl = null;
  function refresh() {
    var p = activePctl();
    if (p !== lastPctl) { lastPctl = p; compute(); }
    else renderOdds();
  }

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

    // 胜率含平局分摊，和「独赢」不是一回事，容易被误会成算错了。
    // 输 0% 更要挑明：那是坚果牌，只是常常要和人平分，胜率数字才显得不高。
    var ex = $('eqExplain');
    var nuts = r.lose === 0 && r.n > 1000;
    if (nuts) {
      ex.hidden = false;
      ex.innerHTML = '<b class="nuts">坚果牌 · 不可能输</b>'
        + (r.tieRate >= 0.005
            ? '，但 <b>' + pct(r.tieRate) + '</b> 的情况要和人平分底池，所以胜率不是 100%'
            : '');
    } else if (r.tieRate >= 0.005) {
      ex.hidden = false;
      ex.innerHTML = '胜率 = 独赢 <b>' + pct(r.winRate) + '</b> + 平分底池折算的 <b>'
        + pct(r.equity - r.winRate) + '</b>';
    } else {
      ex.hidden = true;
    }

    if (r.exact) {
      $('eqNote').textContent = '精确枚举 ' + r.n.toLocaleString() + ' 种可能，无误差' + rangeNote();
    } else {
      var wan = (r.n / 10000).toFixed(r.n >= 100000 ? 0 : 1);
      if (r.win === 0 && r.tie === 0) {
        // 一次都没赢时报「±0」是骗人的，改成给出真实胜率的上界
        $('eqNote').textContent = '模拟 ' + wan + ' 万次一次没赢 · 真实胜率不超过 '
          + marginStr(r.margin) + '%' + rangeNote() + (done ? '' : ' …');
      } else {
        $('eqNote').textContent = '模拟 ' + wan + ' 万次 · 误差 ±' + marginStr(r.margin) + '%'
          + rangeNote() + (done ? '' : ' …');
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
  /* 位置。翻牌前盲注是在庄家之后行动的，所以不能用「后面还有几人」来推——
     那样庄位会数出小盲大盲两个人，被判成很紧的范围，而实际庄位开得最宽。 */
  /* 一个大盲多少筹码。桌子级别变了就改这一处。
     翻牌前「需跟注」等于它 = 没人加注；大于它 = 有人加注了。 */
  var BIG_BLIND = 2;

  /* 对手水平 → 只从最强的前多少比例起手牌里给对手发牌。
     对手敢投钱说明范围强于随机，但娱乐局的人是真的什么牌都玩，
     模拟显示对松散对手收窄范围反而亏钱，所以默认按随机牌算。 */
  /* 两套系数，因为两个「前 X%」含义完全不同：
     pctl  —— 翻牌前按起手牌排位筛，前 30% 就是 88+/AJ+ 这类牌
     board —— 翻牌后按牌面契合度筛，前 30% 在河牌上意味着「最弱也有一对 Q」，
              直接套用会把对手范围收得离谱。实测这块合理区间在 55%~85%。 */
  var OPP_LEVELS = [
    { k: 'loose',  n: '娱乐局', pctl: 1,    board: 0.85 },
    { k: 'normal', n: '一般',   pctl: 0.55, board: 0.70 },
    { k: 'tight',  n: '老手',   pctl: 0.30, board: 0.55 }
  ];
  function oppLevel() {
    for (var i = 0; i < OPP_LEVELS.length; i++)
      if (OPP_LEVELS[i].k === state.oppLevel) return OPP_LEVELS[i];
    return OPP_LEVELS[0];
  }
  function oppPctl() { return oppLevel().pctl; }

  /* 有人往池子里投钱要我跟，说明他这条街还愿意加码 */
  function facingBet() {
    var preflop = state.board.every(function (c) { return c === null; });
    return preflop ? state.call > BIG_BLIND : state.call > 0;
  }

  /* 每多打一条街，还留在牌里的人范围就更强一层——他已经为前面每条街
     都付过钱了，跟这条街有没有下注无关。翻牌前没人加注是唯一的例外：
     那时谁都还没做选择，范围确实接近随机。 */
  // 翻牌后已经改按牌面契合度筛，本身就够狠了，逐街收窄的幅度要小得多
  var STREET_TIGHTEN = { 0: 1, 3: 1, 4: 0.92, 5: 0.85 };

  function boardCount() {
    return state.board.filter(function (c) { return c !== null; }).length;
  }

  /* 这一轮实际该用的对手范围 */
  /* 下注尺度本身就带信息：小注范围宽（探路、薄价值都可能），
     大注范围强。要跟/底池 正好就是这个尺度——底池已含他的注，
     所以半池下注约 0.33，满池约 0.5，1/4 池约 0.2。 */
  function betSizeFactor() {
    if (!facingBet() || !(state.pot > 0)) return 1;
    var ratio = state.call / state.pot;
    var f = 1.05 - 0.8 * ratio;             // 0.2→0.89  0.33→0.79  0.5→0.65
    return Math.max(0.65, Math.min(1, f));
  }

  /* 只有「这条街主动下注」的人才真的看着当前牌面做过决定，
     才配用当前牌面筛范围。没人下注时，所有人都只是从上一条街跟过来的，
     谁都不该按当前牌面算——包括那个我们本来当成强牌的。 */
  function strongOppCount() { return facingBet() ? 2 : 1; }

  /* 后面还没说话的人数是精确算得出来的，不用靠位置估：
     还剩几人 = 我 + 已经跟了的 + 还没说话的 */
  /* 不确定时按「只有下注那个人投了钱」算，其余的人交给下注尺度去估 */
  function calledCount() { return state.called > 0 ? state.called : 1; }

  function playersBehind() {
    return Math.max(0, state.players - 1 - calledCount());
  }

  /* 谁会跟到摊牌，得分两拨人算：

     排在我前面还没弃牌的人 —— 他们已经跟过这笔钱了，钱在底池里。
     但底池大小反过来约束了这个数：底池 100、要跟 50 就只装得下约两笔，
     不可能是七个人都跟了（那样底池至少 350）。

     排在我后面的人 —— 还没说话，多数会弃，按 40% 计。只有他们
     还会往池子里加钱。 */
  /* 后面那些人有多大概率跟：小注跟的人多，大注跑的人多。
     尺度就是 要跟/底池（底池已含他的注，半池约 0.33、满池约 0.5）。
     娱乐局的人跟得更凶，老手更容易放掉。 */
  function callRateBehind() {
    var ratio = state.pot > 0 ? state.call / state.pot : 0.33;
    var mult = state.oppLevel === 'loose' ? 1.3 : state.oppLevel === 'tight' ? 0.75 : 1;
    return Math.max(0.05, Math.min(0.75, (0.65 - ratio) * mult));
  }

  function actionSplit() {
    var opp = state.players - 1;
    var behind = playersBehind();
    // 已投钱的人由你直接告诉我，比从底池反推准——转牌河牌的底池里
    // 还含着前几条街的钱，反推会把它误判成「很多人跟过」
    var called = Math.max(0, Math.min(opp, calledCount()) - 1);   // 减掉下注者本人
    var willCall = Math.round(behind * callRateBehind());
    return { called: called, willCall: willCall, behind: behind };
  }

  function showdownPlayers() {
    var opp = state.players - 1;
    if (!facingBet() || opp <= 1) return state.players;
    var a = actionSplit();
    return Math.min(opp, Math.max(1, a.called + a.willCall + 1)) + 1;
  }

  /* 「跟着看牌」那组的范围。没人下注时大家处境一样，不额外放宽；
     有人下注时，没跟注的那些人范围明显更宽。 */
  function wideTopPctl() { return Math.min(1, activePctl() * 2.5); }

  /* 筛范围该用哪个牌面：本街有人下注就用当前的，
     否则用少一张的——大家还没对刚翻开的这张做过决定 */
  function filterLen() {
    var n = boardCount();
    return facingBet() ? n : Math.max(0, n - 1);
  }

  function activePctl() {
    var n = boardCount();
    // 翻牌前且没人加注：大家都还没投钱，按随机牌算
    if (n === 0 && !facingBet()) return 1;
    var base = n >= 3 ? oppLevel().board : oppLevel().pctl;
    var p = base * (STREET_TIGHTEN[n] || 1) * betSizeFactor();
    return Math.max(0.05, Math.min(1, p));
  }

  /* 底池和跟注都用快捷金额，牌桌上没法数清物理筹码，估个量级就够用。
     底池指的是「中间现在一共多少」，已经含对手刚下的注——这样
     赔率直接就是 跟注/(底池+跟注)，不用再管谁跟了谁没跟。 */
  var POT_PRESETS  = [10, 20, 50, 100, 200, 300];
  var CALL_PRESETS = [0, 2, 5, 10, 20, 30, 40, 50];

  var POS = [
    { k: 'early', n: '前位' }, { k: 'mid', n: '中位' }, { k: 'late', n: '后位' },
    { k: 'btn', n: '庄位' }, { k: 'sb', n: '小盲' }, { k: 'bb', n: '大盲' }
  ];

  /* 标准开池范围（RFI），对照常见图表。人多的桌前面几个位置要更紧。
     盲注是另一回事：已经投过钱、且翻牌后位置最差，单独处理。 */
  var OPEN_RANGE = {
    short: { early: 0.16, mid: 0.21, late: 0.28, btn: 0.45, sb: 0.42 },  // 6 人及以下
    full:  { early: 0.11, mid: 0.16, late: 0.24, btn: 0.42, sb: 0.40 }   // 7 人及以上
  };

  /* 翻牌前面对加注时的防守范围（前百分之几）。
     翻牌前不该用底池赔率判断——赔率是按对手拿随机牌算的，
     而敢加注的人范围明显强于随机，算出来会系统性偏乐观。
     标准做法是按位置查范围表：大盲价格最好所以防守最宽，
     小盲虽然也投过钱但翻牌后全程没位置，反而要紧。 */
  /* 加注到多少个大盲，决定这是开池、3-bet 还是 4-bet。
     标准开池 2.5~3BB，3-bet 9~12BB，4-bet 22BB 以上。
     范围差别巨大，用同一张防守表会松得离谱——所以按尺度整体缩放。 */
  function raiseTier(level) {
    var bb = level / BIG_BLIND;
    // 连续曲线，不是三个硬台阶——否则加到 4.4BB 和 4.6BB 会掉进完全
    // 不同的档，而同一档内加多少又完全不影响判断。
    // 以标准开池 2.5BB 为基准，加得越大防守越紧：
    //   3BB→0.87  4BB→0.70  6BB→0.52  10BB→0.35  25BB→0.18
    var mult = bb <= 2.5 ? 1 : Math.pow(2.5 / bb, 0.76);
    var name = bb <= 4.5 ? '开池加注' : bb <= 16 ? '3-bet 再加注' : '4-bet';
    return { mult: Math.max(0.05, Math.min(1, mult)), name: name };
  }

  var DEFEND = {
    early: { three: 0.03, call: 0.10 },
    mid:   { three: 0.04, call: 0.14 },
    late:  { three: 0.05, call: 0.20 },
    btn:   { three: 0.06, call: 0.25 },
    sb:    { three: 0.04, call: 0.18 },
    bb:    { three: 0.04, call: 0.40 }
  };

  /* 翻牌后有没有位置。庄位永远最后说话；后位要看庄家还在不在，算中性；
     盲注和前中位每条街都先说话，位置最差。
     同一手牌有位置能打出更多价值——这就是胜率兑现率(equity realization)：
     原始胜率一样，有位置兑现得多，没位置兑现得少。 */
  function realizeFactor() {
    if (state.pos === 'btn') return 1.07;
    if (state.pos === 'late') return 1.00;
    return 0.93;
  }
  function posLabel() {
    return state.pos === 'btn' ? '你有位置（最后说话）'
      : state.pos === 'late' ? '' : '你没位置（每条街先说话）';
  }

  /* 我在盲注位已经投进去的钱，面对加注时只需补差额 */
  function posted() {
    return state.pos === 'bb' ? BIG_BLIND : state.pos === 'sb' ? BIG_BLIND / 2 : 0;
  }

  function openRange() {
    var t = state.players >= 7 ? OPEN_RANGE.full : OPEN_RANGE.short;
    return t[state.pos] || t.mid;
  }

  /* 庄家每手顺时针挪一位，我的位置也跟着走一格。座位环必须按桌上总人数生成，
     环长 = 总人数，不能写死。顺序（沿轮转方向）：
       庄位 → 后位 → 中位… → 前位… → 大盲 → 小盲 → 回到庄位
     人多的桌中位和前位各占好几个座位，所以会在同一档连续待上几手，这是对的。 */
  function posCycle() {
    var n = state.tableSize;
    if (n <= 2) return ['btn', 'bb'];          // 单挑时庄位即小盲
    var arr = ['btn'];
    var mids = n - 3;                          // 既非庄位也非盲注的座位数
    if (mids >= 1) {
      arr.push('late');
      var rest = mids - 1;
      var m = Math.ceil(rest / 2);
      for (var i = 0; i < m; i++) arr.push('mid');
      for (var j = 0; j < rest - m; j++) arr.push('early');
    }
    arr.push('bb', 'sb');
    return arr;
  }

  /* 位置在环里可能重复（8 人桌有两个中位），所以要记座位下标，
     只按名字找会永远停在第一个同名座位上出不去。 */
  function seatIndex() {
    var cyc = posCycle();
    if (state.seat >= 0 && state.seat < cyc.length && cyc[state.seat] === state.pos) return state.seat;
    var i = cyc.indexOf(state.pos);
    return i < 0 ? 0 : i;
  }

  function advanceSeat() {
    var cyc = posCycle();
    var i = (seatIndex() + 1) % cyc.length;
    state.seat = i;
    state.pos = cyc[i];
  }

  function posName() {
    for (var i = 0; i < POS.length; i++) if (POS[i].k === state.pos) return POS[i].n;
    return '中位';
  }

  /* 筹码都是整数，任何金额一律取整，别报出 7.5 这种数 */
  function chips(x) { return String(Math.round(x)); }

  /* 任何建议都不能超过手上的筹码，超了就是全下 */
  function sized(x) {
    var st = state.stack;
    if (st > 0 && x >= st) return { text: '全下 ' + chips(st), allin: true };
    return { text: chips(x), allin: false };
  }
  /* 下注/加注类的判词，全下时不再说「加注到」 */
  function actText(verb, x) {
    var r = sized(x);
    return r.allin ? r.text : verb + ' ' + r.text;
  }


  function renderOdds() {
    var out = $('oddsOut');
    if (!lastResult) { out.textContent = '先选好自己的两张手牌'; return; }

    /* 底池要和胜率用同一套假设。既然按「会有 N 个对手跟到摊牌」算胜率，
       就得承认他们的钱也会进池：下注那个人的注已经含在底池里，
       其余每个跟注的人再各投一笔。
       只算对手数不算他们的钱，等于双重悲观——胜率被压低、赔率也被压低。 */
    // 只有排在我后面、还没说话的人会再往池子里加钱；
    // 前面那些人的钱早就在「底池」里了，再加一遍就是重复计算。
    var extraCallers = facingBet() ? actionSplit().willCall : 0;
    var potNow = state.pot + extraCallers * state.call;
    // 筹码不够跟的话，实际只投得进这么多，多出来的会退还给对手，
    // 赔率要按实际投进去的钱算
    var call = state.stack > 0 ? Math.min(state.call, state.stack) : state.call;

    var eq = lastResult.equity;
    var fair = 1 / state.players;          // 均分时每人应得的份额
    var ratio = eq / fair;
    // 翻牌后按位置折算能真正打出来的那部分胜率
    var rf = realizeFactor();
    var eqR = Math.max(0, Math.min(1, eq * rf));
    var posNote = posLabel()
      ? '<br><span class="caveat">' + posLabel() + '，同样的牌能打出的价值不同，已按 '
        + Math.round(rf * 100) + '% 折算</span>' : '';

    // ---- 翻牌前、没人下注：这是开池决策 ----
    // 不能拿「多人全下的均分份额」当标尺——真实牌局大多数时候大家都弃牌了，
    // 你赢的是盲注，而全下均分完全没有弃牌率这回事。
    // 正确做法是看这手牌在 169 手起手牌里的强度排位，再对照位置该开多宽。
    // 翻牌前你要跟的就是一个大盲 = 还没人加注；比大盲大就是有人加注了。
    // 翻牌前你要跟的就是一个大盲 = 还没人加注；比大盲大就是有人加注了
    var preflopUnraised = state.board.every(function (c) { return c === null; })
      && call <= BIG_BLIND;
    if (preflopUnraised && window.PokerPreflop) {
      var pctl = PokerPreflop.percentile(state.hero[0], state.hero[1]);

      // 大盲位没人加注，就是免费看翻牌，不存在开不开池的问题
      if (state.pos === 'bb') {
        out.innerHTML = '<span class="verdict even">过牌</span>'
          + '大盲没人加注 = 免费看翻牌，没理由再投钱。这手牌排<b>前 '
          + (pctl * 100).toFixed(0) + '%</b>。';
        return;
      }

      var open = openRange();
      // 起手牌排位是按单挑胜率排的，会严重低估同花连张在多人底池的价值：
      // T9s 单挑排前 35%，8 人桌的胜率却比排前 13% 的 KJo 还高。
      // 所以只要不是硬桌子，都额外看一眼多人胜率，够格就便宜跟一手；
      // 只有「老手」档禁掉——对好对手跛入是送钱。
      var early = state.pos === 'early' || state.pos === 'mid';
      var limpBar = early ? 1.25 : 1.10;
      var v0, c0, act, isRaise = false;
      if (pctl <= open) {
        v0 = '开池加注'; c0 = 'good'; act = '在范围内'; isRaise = true;
      } else if (state.oppLevel !== 'tight' && ratio >= limpBar) {
        v0 = actText('跟注', call > 0 ? call : BIG_BLIND); c0 = 'good';
        act = '不够开池，但 ' + state.players + ' 人桌胜率 <b>' + pct(eq)
          + '</b> 是均分的 <b>' + ratio.toFixed(2) + ' 倍</b>，便宜跟一手看翻牌';
      } else if (pctl <= open * 1.35) {
        v0 = '边缘'; c0 = 'even'; act = '略超范围，桌子松可以开';
      } else {
        v0 = '弃牌 ✕'; c0 = 'bad'; act = '超出范围较多';
      }
      if (isRaise) {
        // 翻牌前没人加注时，「需跟注」填的就是一个大盲，直接拿它算具体筹码，
        // 不用额外配置，也自动适配任何级别的桌子。
        // 标准开池尺度：2.5 倍大盲（小盲位 3 倍），场上每有一个跛入者再加一个大盲，
        // 而跛入进来的钱正好就是「原底池」。
        var to = (state.pos === 'sb' ? 3 : 2.5) * BIG_BLIND;
        v0 = actText('开池加注到', to);
        act += '，' + (state.pos === 'sb' ? '3' : '2.5') + ' 倍大盲';
      }
      out.innerHTML = '<span class="verdict ' + c0 + '">' + v0 + '</span>'
        + posName() + state.players + ' 人桌开<b>前 ' + (open * 100).toFixed(0) + '%</b>，'
        + '这手牌排<b>前 ' + (pctl * 100).toFixed(0) + '%</b> → ' + act
        + '<br><span class="caveat">排位按单挑胜率排，多人底池里同花连张的价值要更高</span>';
      return;
    }

    // ---- 翻牌前面对加注：查防守范围，不看底池赔率 ----
    if (state.board.every(function (c) { return c === null; }) && window.PokerPreflop) {
      // 面对加注要用「对加注范围的胜率」排位，不能用「对随机牌」那张。
      // 77 对随机牌 66% 排前 4.2%，对前 20% 范围只有 49% 排前 7.1%——
      // 用错表会把它排在 AKo 前面，面对 3-bet、4-bet 都建议跟注。
      var dp = PokerPreflop.vsRaise
        ? PokerPreflop.vsRaise(state.hero[0], state.hero[1])
        : PokerPreflop.percentile(state.hero[0], state.hero[1]);
      var d0 = DEFEND[state.pos] || DEFEND.mid;
      var level = call + posted();               // 他加到了多少
      var tier = raiseTier(level);
      var d = { three: d0.three * tier.mult, call: d0.call * tier.mult };
      var v1, c1, why;
      if (dp <= d.three) {
        // 有位置 3 倍就够；没位置要打大一点，否则翻牌后每条街都难打
        var ip = state.pos === 'btn' || state.pos === 'late';
        v1 = actText('再加注到', level * (ip ? 3 : 4)); c1 = 'good';
        why = '这手牌够强，值得反打施压' + (ip ? '（有位置，3 倍即可）' : '（没位置，打到 4 倍）') + '。';
      } else if (dp <= d.call) {
        v1 = actText('跟注', call); c1 = 'good';
        why = '在防守范围内，跟一手看翻牌。';
      } else {
        v1 = '弃牌 ✕'; c1 = 'bad';
        why = '超出' + posName() + '面对加注的防守范围。';
      }
      out.innerHTML = '<span class="verdict ' + c1 + '">' + v1 + '</span>'
        + posName() + '面对' + tier.name + '（' + (level / BIG_BLIND).toFixed(1) + 'BB）：<b>前 '
        + (d.call * 100).toFixed(1) + '%</b> 跟、<b>前 '
        + (d.three * 100).toFixed(1) + '%</b> 再加，这手牌排<b>前 '
        + (dp * 100).toFixed(0) + '%</b> → ' + why
        + '<br><span class="caveat">翻牌前按起手牌范围判断，不用底池赔率——'
        + '赔率是按对手随机牌算的，而敢加注的人范围强得多</span>';
      return;
    }

    // ---- 没人下注 ----
    if (call <= 0) {
      if (potNow <= 0) {
        out.innerHTML = '<span class="verdict even">缺少底池</span>'
          + '翻牌后没有底池就算不出该下多少，填一下原底池。';
        return;
      }
      var verdict1, cls1, why1;
      var ratioR = eqR / fair;
      if (ratioR >= 2) {
        verdict1 = actText('下注', potNow * 0.75); cls1 = 'good';
        why1 = '胜率 <b>' + pct(eq) + '</b> 远高于 ' + state.players + ' 人桌均分的 <b>'
          + pct(fair) + '</b>，下 ¾ 池要价值。';
      } else if (ratioR >= 1.3) {
        verdict1 = actText('下注', potNow * 0.5); cls1 = 'good';
        why1 = '胜率 <b>' + pct(eq) + '</b> 略高于均分的 <b>' + pct(fair) + '</b>，下 ½ 池薄价值。';
      } else {
        verdict1 = '过牌'; cls1 = 'even';
        why1 = '胜率 <b>' + pct(eq) + '</b> 没到 ' + state.players + ' 人桌均分的 <b>'
          + pct(fair) + '</b>，先别投钱。';
      }
      out.innerHTML = '<span class="verdict ' + cls1 + '">' + verdict1 + '</span>' + why1
        + '<br>当前底池 <b>' + chips(potNow) + '</b>。' + posNote;
      return;
    }

    // ---- 有人下注 ----
    // 底池是 0 却有人下注，说明底池没填。这时算出来必然是「需要 100% 胜率」，
    // 数学上没错但毫无用处，直接说清楚要填什么。
    if (potNow <= 0) {
      out.innerHTML = '<span class="verdict even">底池没填</span>'
        + '有人下注，底池就不会是 0。填一下中间现在一共多少'
        + '（含盲注和他下的注），否则赔率算不出来。';
      return;
    }

    var required = call / (potNow + call);       // 跟注所需的最低胜率
    var ev = eq * (potNow + call) - call;        // 跟注的期望收益
    var edge = eqR - required;
    var raiseTo = call + 0.7 * (potNow + call);  // 跟平后再按约 ⅔ 池加

    var verdict, cls;
    if (edge < -0.02) { verdict = '弃牌 ✕'; cls = 'bad'; }
    else if (edge < 0.02) { verdict = '临界，看位置和对手'; cls = 'even'; }
    else if (eqR >= 1.6 * fair && edge >= 0.15) { verdict = actText('加注到', raiseTo); cls = 'good'; }
    else { verdict = actText('跟注', call); cls = 'good'; }

    var html = '<span class="verdict ' + cls + '">' + verdict + '</span>'
      + '底池 <b>' + chips(potNow) + '</b>'
      + (extraCallers > 0 ? '（含 ' + extraCallers + ' 人跟注）' : '')
      + '，需 <b>' + pct(required) + '</b> 胜率，你有 <b>' + pct(eq) + '</b>'
      + (rf !== 1 ? '，按位置折算 <b>' + pct(eqR) + '</b>' : '')
      + '（' + (edge >= 0 ? '多 ' : '差 ') + pct(Math.abs(edge)) + '）<br>'
      + '跟注的期望收益 <b>' + (ev >= 0 ? '+' : '−') + chips(Math.abs(ev)) + '</b>';
    if (!state.board.every(function (c) { return c === null; })) html += posNote;
    if (state.board.every(function (c) { return c === null; })) {
      // 翻牌前对手敢下注，他的牌一定强于随机牌，而胜率是按随机牌算的
      // 口袋对子翻牌摸中暗三约 11.8%，纯胜率排位低估了这类牌
      var h0 = state.hero[0], h1 = state.hero[1];
      if (h0 !== null && h1 !== null && (h0 >> 2) === (h1 >> 2) && verdict.indexOf('弃牌') === 0) {
        html += '<br><span class="caveat">口袋对子有隐含赔率：翻牌 12% 中暗三，'
          + '手上筹码够跟注额 15 倍以上就值得摸一手</span>';
      }
      // 大盲已经投过钱，防守价格比别人好
      if (state.pos === 'bb' && call > 0) {
        html += '<br><span class="caveat">大盲已投过钱，防守可更宽，但翻牌后无位置</span>';
      }
      html += '<br><span class="caveat">对手敢下注，范围强于随机牌，实战胜率比这更低</span>';
    }
    out.innerHTML = html;
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('deck').addEventListener('click', function (e) {
      var b = e.target.closest('.pick');
      if (b) pickCard(parseInt(b.dataset.card, 10));
    });
    $('tableSize').addEventListener('input', function () {
      var v = parseInt($('tableSize').value, 10);
      if (!(v >= 2 && v <= 10)) return;
      state.tableSize = v;
      if (state.players > v) state.players = v;
      state.seat = posCycle().indexOf(state.pos);   // 换桌型要重新定位座位
      renderPlayers(); renderBettors(); save(); compute();
    });
    $('tableSize').addEventListener('blur', function () {
      $('tableSize').value = String(state.tableSize);   // 输了非法值就恢复
    });
    // 和其他金额框一样，点进来直接全选，打字即覆盖
    $('tableSize').addEventListener('focus', function () {
      setTimeout(function () { try { $('tableSize').select(); } catch (e) {} }, 0);
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
        var what = b.dataset.clear;   // all=牌全清  new=开新一局
        state.hero = [null, null];
        state.board = [null, null, null, null, null];
        if (what === 'new') {
          // 开新一局：底池清零、要跟回到一个大盲，这就是每手开始的样子。
          // 人数恢复成桌上总人数；庄家挪一位，我的位置也顺延一格。
          // 每手一开始底池不是 0，而是两个盲注（小盲 + 大盲 = 1.5 个大盲）。
          // 之前置成 0，一旦有人加注就会算出「需要 100% 胜率」，永远劝你弃牌。
          state.pot = BIG_BLIND * 1.5;
          state.call = BIG_BLIND;
          $('pot').value = String(state.pot); $('call').value = String(BIG_BLIND);
          state.players = state.tableSize;
          advanceSeat();
          state.hideHero = true;   // 新一局默认盖着，想看点一下牌背
          renderPlayers();
        }
        save(); renderSlots(); renderBettors(); compute();
      });
    });

    ['pot', 'call', 'stack'].forEach(function (k) {
      var el = $(k);
      el.value = state[k] ? String(state[k]) : '';
      el.addEventListener('input', function () {
        var v = parseFloat(el.value);
        state[k] = isFinite(v) && v > 0 ? Math.round(v) : 0;
        save();
        if (k !== 'stack') {
          renderMoney(k + 'Seg', k, k === 'pot' ? POT_PRESETS : CALL_PRESETS);
        }
        renderBettors(); refresh();
      });
      // 点进来光标会落在数字中间，很难改。直接全选，打字即覆盖。
      el.addEventListener('focus', function () {
        setTimeout(function () { try { el.select(); } catch (e) {} }, 0);
      });
    });
    $('clearOdds').addEventListener('click', function () {
      state.pot = 0; state.call = 0;
      $('pot').value = ''; $('call').value = '';
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
