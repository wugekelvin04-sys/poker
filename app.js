/* 界面逻辑。计算全部交给 worker.js，主线程只负责渲染。 */
(function () {
  'use strict';
  /* 决策逻辑全在 strategy.js 里，这里只做转发。必须在最前面拿到引用：
     下面好几个常量（BIG_BLIND 等）在模块初始化时就要读它。 */
  var ST = window.PokerStrategy;

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

  var APP_VERSION = 'v59';

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
    $('heroToggleHint').textContent = state.hideHero ? '点牌型显示' : '点牌型可隐藏';

    var n = state.board.filter(function (c) { return c !== null; }).length;
    $('streetName').textContent =
      n === 0 ? '翻牌前' : n === 3 ? '翻牌' : n === 4 ? '转牌' : n === 5 ? '河牌' : n + ' 张';
  }

  // ---------- 人数 ----------
  /* 「还剩几人」每手都要改，用按钮；桌上总人数设一次就不动，用小输入框。
     按钮只渲染到总人数为止，不再摆一排点不动的灰按钮。 */
  /* 这两个动作每手都要按好几次，所以除了按钮，点标签也能触发 */
  function dropOne() {
    if (state.players <= 2) return;
    state.players--;
    if (state.called > state.players - 1) state.called = state.players - 1;
    renderPlayers(); renderBettors(); save(); compute();
  }

  function raiseOne() {
    if (state.players >= state.tableSize) return;
    state.players++;
    renderPlayers(); renderBettors(); save(); compute();
  }

  function dropCalled() {
    if (state.called <= 0) return;
    state.called--;
    renderCalled(); save(); refresh();
  }

  function addOne() {
    var maxN = Math.max(1, state.players - 1);
    if (calledCount() >= maxN) return;
    state.called = calledCount() + 1;
    renderCalled(); save(); refresh();
  }

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
    renderStepper('playersStep',
      { sign: '−', off: state.players <= 2,             run: dropOne },
      { sign: '+', off: state.players >= state.tableSize, run: raiseOne });
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
  /* 加减键单独成块放在 label 左边，只显示符号不显示数值——
     牌桌上是盲按，步长多少不重要，位置固定才重要。 */
  function renderStepper(boxId, minus, plus) {
    var box = $(boxId);
    box.innerHTML = '';
    [minus, plus].forEach(function (spec) {
      var b = document.createElement('button');
      b.className = 'add' + (spec.off ? ' off' : '');
      b.textContent = spec.sign;
      b.addEventListener('click', function () { if (!spec.off) spec.run(); });
      box.appendChild(b);
    });
  }

  function renderMoney(boxId, key, presets, steps) {
    var box = $(boxId);
    box.innerHTML = '';

    /* 步长跟当前档位走；「要跟」最低端还有一小段梯子 0→2→5。 */
    if (steps) {
      var st = stepFor(state[key], presets, steps);
      var cur = state[key];
      var ld = key === 'call' ? callLadder() : null;
      var top = ld ? ld[ld.length - 1] : 0;
      var up = null, down = null;
      if (ld && cur < top) {
        for (var li = 0; li < ld.length; li++) if (cur < ld[li]) { up = ld[li]; break; }
      }
      if (ld && cur <= top) {
        for (var lj = ld.length - 1; lj >= 0; lj--) if (cur > ld[lj]) { down = ld[lj]; break; }
      }
      if (up === null) up = cur + st;
      if (down === null) down = cur - st;
      // 减号沿梯子一路走回 0：翻牌前 5→2→0，翻牌后 5→0。
      // 「过牌到我」= 要跟 0，是最常见的状态，必须按得回去。
      var noDown = ld ? cur <= ld[0] : cur - st < 0;
      var apply = function (v) {
        state[key] = v;
        $(key).value = state[key] ? String(state[key]) : '';
        renderMoney(boxId, key, presets, steps);
        renderBettors(); save(); refresh();
      };
      renderStepper(key === 'pot' ? 'potStep' : 'callStep',
        { sign: '−', off: noDown || down < 0, run: function () { apply(down); } },
        { sign: '+', off: false,               run: function () { apply(up); } });
    }

    presets.forEach(function (v) {
      var b = document.createElement('button');
      b.textContent = v;
      if (v === state[key]) b.className = 'on';
      b.addEventListener('click', function () {
        state[key] = v;
        $(key).value = v === 0 ? '' : String(v);
        renderMoney(boxId, key, presets, steps);
        renderBettors(); save(); refresh();
      });
      box.appendChild(b);
    });
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
    renderStepper('calledStep',
      { sign: '−', off: state.called <= 0,       run: dropCalled },
      { sign: '+', off: calledCount() >= maxN,   run: addOne });
    box.style.gridTemplateColumns = 'repeat(' + (maxN + 1) + ',1fr)';
  }

  function renderBettors() {
    renderPos();
    renderCalled();
    /* 用不到的行置灰而不是隐藏——隐藏会让整个操作区上下移动，
       手指每次都得重新找位置。 */
    $('calledRow').classList.toggle('dim', !facingBet() || boardCount() === 0);
    renderOppLevel();
    renderMoney('potSeg', 'pot', POT_PRESETS, POT_STEPS);
    renderMoney('callSeg', 'call', callPresets(), callSteps());
    // 位置只在翻牌前用得上；下注人数只在有人下注时才需要
    var preflop = state.board.every(function (c) { return c === null; });
    // 位置常驻可改。它虽然只参与翻牌前的判断，但会随「新一局」自动顺延，
    // 设错了如果翻牌后不让改，下一局会跟着错下去，一路错到底。
    $('posRow').hidden = false;
    // 翻牌前没人加注时，开池与否只看起手牌和位置，底池金额用不上
    // 翻牌前完全不看底池，只看位置和起手牌范围；置灰保留占位
    $('potRow').classList.toggle('dim', preflop);
    // 翻牌前的加注是按大盲倍数，不是按池比例，快捷尺度用不上
    // 盲注位已经投过钱，只需补差额，而且那笔钱已经算在底池里了。
    // 不提醒的话很容易把整笔下注额填进「要跟」，把所需胜率抬到离谱。
    $('hintRow').textContent = preflop
      ? '翻牌前只看位置和起手牌，不用填金额'
      : '';   // 说明去掉，但元素留着占位，避免翻牌前后高度跳动
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
    var boardBefore = boardCount();
    setSlotCard(active, c);
    /* 新的一条街开始了：上一轮的下注该结账，「要跟」也要归零重新来。 */
    var nowCount = boardCount();
    if (nowCount > boardBefore && nowCount >= 3) {
      if (boardBefore < 3) {
        // 翻牌前的底池只有盲注那点，翻牌圈一般至少 20，直接顶上去
        if (state.pot < 20) state.pot = 20;
      } else {
        // 转牌河牌：把刚结束那一轮投进去的钱并进底池（含我自己跟的那笔）
        state.pot = Math.round(state.pot + (calledCount() + 1) * state.call);
      }
      state.call = 0;      // 新一街还没人下注
      state.called = 0;    // 已跟人数跟着重来
      $('pot').value = String(state.pot);
      $('call').value = '';
      renderMoney('potSeg', 'pot', POT_PRESETS, POT_STEPS);
      renderMoney('callSeg', 'call', callPresets(), callSteps());
    }
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
    if (!window.PokerSim) { setBusy(false); return; }

    if (board.length === 5 && Math.round(showdownPlayers()) === 2) {
      try {
        var ex = PokerSim.enumerateShowdownHeadsUp(hero, board, 1, activePctl());
        lastResult = ex; renderResult(ex, true);
      } catch (err) { setBusy(false); }
      return;
    }

    var acc = null, started = Date.now();
    var CHUNK = 10000, TARGET = 250000, BUDGET = 2500;

    function step() {
      if (id !== runId) return;
      try {
        var part = PokerSim.simulate({
          hero: hero, board: board, players: showdownPlayers(),
          maxIterations: CHUNK, timeLimitMs: 0, seed: (scenarioSeed() + (acc ? acc.n : 0)) >>> 0,
          oppMaxPctl: board.length >= 3 ? 1 : activePctl(),
          oppBoardTop: board.length >= 3 ? activePctl() : undefined,
          oppStrong: strongOppCount(),
          oppWideTop: wideTopPctl(),
          oppFilterLen: filterLen()
        });
        acc = acc ? mergeResults(acc, part) : part;
      } catch (err) { setBusy(false); return; }
      var done = acc.n >= TARGET || Date.now() - started > BUDGET;
      lastResult = acc;
      renderResult(acc, done);
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
      setBusy(false);
      setBar(0, 0, 0);
      $('legWin').textContent = $('legTie').textContent = $('legLose').textContent = '—';
      $('dist').innerHTML = '';
      $('improve').textContent = '';
      renderOdds();
      return;
    }
    // 牌桌上的人手牌加公共牌不能超过一副牌
    if (2 * state.players + 5 > 52) return;

    setBusy(true);
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
      if (m.type === 'error') { setBusy(false); stopWorker(); return; }
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
      maxIterations: 250000, timeLimitMs: 1600, seed: scenarioSeed(),
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


  /* 金额变了：只有当对手范围口径也跟着变时才值得重算胜率，
     否则光刷新建议就够，免得每点一下按钮都重跑一次模拟。 */
  var lastPctl = null;
  function refresh() {
    var p = activePctl();
    if (p !== lastPctl) { lastPctl = p; compute(); }
    else renderOdds();
  }

  /* 计算中就把数字调淡，不再用一行文字说明——那行技术细节没人看，
     还会因为长度变化导致切换人数时整页抖动 */
  function setBusy(on) { $('eqValue').style.opacity = on ? '0.4' : '1'; }

  function pct(x, d) { return ST.pct(x, d); }

  /* 顶部那个大数字，同上但不带百分号 */
  function eqNum(x) {
    var v = x * 100;
    if (v === 0) return '0';
    if (v >= 1) return v.toFixed(1);
    if (v >= 0.1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(3);
    return '<0.01';
  }


  function setBar(w, t, l) {
    $('barWin').style.width = (w * 100) + '%';
    $('barTie').style.width = (t * 100) + '%';
    $('barLose').style.width = (l * 100) + '%';
  }

  function renderResult(r, done) {
    /* 盖着牌的时候，胜率本身就是最扎眼的泄密——旁边的人扫一眼看到 92%
       就知道你有大牌了。连同胜负条、坚果标一起遮住。
       所有元素照常渲染，只是内容换成占位符，高度一格不动。 */
    if (state.hideHero) {
      $('eqValue').textContent = '••';
      setBar(0, 0, 0);
      $('legWin').textContent = $('legTie').textContent = $('legLose').textContent = '••';
      $('nutsFlag').textContent = '';
    } else {
      $('eqValue').textContent = eqNum(r.equity);
      setBar(r.winRate, r.tieRate, r.loseRate);
      $('legWin').textContent = pct(r.winRate);
      $('legTie').textContent = pct(r.tieRate);
      $('legLose').textContent = pct(r.loseRate);

      // 坚果牌只用一个小标签标出来，不再解释原理
      $('nutsFlag').textContent = (r.lose === 0 && r.n > 1000) ? '坚果·不可能输' : '';
    }

    setBusy(!done);

    renderDist(r);
    renderOdds();
  }

  // ---------- 当前牌型与成牌分布 ----------
  function renderMadeHand(hero, board) {
    var el = $('made');
    el.classList.remove('hidden-hand');
    if (hero.length < 2) { el.textContent = '—'; $('madeHint').textContent = ''; return; }
    var score = E.evalHand(hero.concat(board));
    el.dataset.cat = score >>> 20;
    if (state.hideHero) {
      // 牌型会直接暴露手牌，一并遮住
      el.textContent = '已隐藏';
      el.classList.add('hidden-hand');
      $('madeHint').textContent = '';
      return;
    }
    el.textContent = E.describe(score);

    // 牌型完全由公共牌凑成时，桌上每个人都有这副牌，你拼的只是踢脚。
    // 这种局面人一多胜率会塌得很快，值得单独提醒。
    var hint = $('madeHint');
    hint.textContent = '';
    if (board.length >= 3) {
      var bs = E.evalHand(board);
      if ((bs >>> 20) >= 1 && (bs >>> 20) === (score >>> 20)) {
        hint.textContent = '公共牌本身就是' + E.describe(bs)
          + '，桌上每个人都有，你比的只是踢脚';
      }
    }
  }

  /* 右栏固定列出全部九种牌型，永远九行，高度不会变 */
  function renderDist(r) {
    var box = $('dist');
    var boardN = boardCount();
    var curCat = parseInt($('made').dataset.cat || '0', 10);
    var markCur = !state.hideHero;

    if (state.hideHero) {
      $('improve').textContent = '';
    } else if (boardN >= 5) {
      $('improve').textContent = '牌已发完，这就是最终牌型';
    } else {
      var improve = 0;
      for (var c = curCat + 1; c <= 8; c++) improve += r.catCounts[c];
      $('improve').innerHTML = '牌型变大的概率 <b>' + pct(improve) + '</b>';
    }

    var max = Math.max.apply(null, r.catCounts) || 1;
    var hide = state.hideHero;   // 分布形状本身就能反推出手牌
    var html = '';
    for (var i = 8; i >= 0; i--) {
      var p = r.catCounts[i];
      var w = hide ? 0 : (max > 0 ? (p / max * 100) : 0);
      html += '<div class="dist-row' + (markCur && i === curCat ? ' cur' : '')
        + (!hide && p < 0.0005 ? ' zero' : '') + '">'
        + '<span class="nm">' + E.CAT_NAMES[i] + '</span>'
        + '<span class="tr"><span class="fl" style="width:' + w.toFixed(1) + '%"></span></span>'
        + '<span class="vl">' + (hide ? '••' : p < 0.0005 ? '—' : pct(p, p < 0.01 ? 2 : 1))
        + '</span></div>';
    }
    box.innerHTML = html;
  }

  // ---------- 底池赔率 ----------
  /* 位置。翻牌前盲注是在庄家之后行动的，所以不能用「后面还有几人」来推——
     那样庄位会数出小盲大盲两个人，被判成很紧的范围，而实际庄位开得最宽。 */
  /* 一个大盲多少筹码。桌子级别变了就改这一处。
     翻牌前「需跟注」等于它 = 没人加注；大于它 = 有人加注了。 */
  var BIG_BLIND = ST.BIG_BLIND;

  /* 对手水平 → 只从最强的前多少比例起手牌里给对手发牌。
     对手敢投钱说明范围强于随机，但娱乐局的人是真的什么牌都玩，
     模拟显示对松散对手收窄范围反而亏钱，所以默认按随机牌算。 */
  /* 两套系数，因为两个「前 X%」含义完全不同：
     pctl  —— 翻牌前按起手牌排位筛，前 30% 就是 88+/AJ+ 这类牌
     board —— 翻牌后按牌面契合度筛，前 30% 在河牌上意味着「最弱也有一对 Q」，
              直接套用会把对手范围收得离谱。实测这块合理区间在 55%~85%。 */
  var OPP_LEVELS = ST.OPP_LEVELS;
  function oppLevel() { return ST.oppLevel(state); }
  function oppPctl() { return oppLevel().pctl; }

  /* 有人往池子里投钱要我跟，说明他这条街还愿意加码 */
  /* 决策逻辑全在 strategy.js 里，这里只做转发：
     UI 代码照常调用这些名字，参数里那个 state 由转发层补上。
     以前 app 和模拟器各写一份、注释写着「镜像」，结果悄悄漂移了好几个版本，
     模拟器量出来的盈亏根本不是这个 App 的策略。现在只有一份。 */

  var STREET_TIGHTEN = ST.STREET_TIGHTEN;
  var OPEN_RANGE = ST.OPEN_RANGE;
  var DEFEND = ST.DEFEND;
  var TIER_EXP = ST.TIER_EXP;

  function facingBet()        { return ST.facingBet(state); }
  function boardCount()       { return ST.boardCount(state); }
  function betSizeFactor()    { return ST.betSizeFactor(state); }
  function strongOppCount()   { return ST.strongOppCount(state); }
  function calledCount()      { return ST.calledCount(state); }
  function playersBehind()    { return ST.playersBehind(state); }
  function callRateBehind(la) { return ST.callRateBehind(state, la); }
  function actionSplit()      { return ST.actionSplit(state); }
  function showdownPlayers()  { return ST.showdownPlayers(state); }
  function wideTopPctl()      { return ST.wideTopPctl(state); }
  function scenarioSeed()     { return ST.scenarioSeed(state); }
  function filterLen()        { return ST.filterLen(state); }
  function activePctl()       { return ST.activePctl(state); }
  function realizeFactor()    { return ST.realizeFactor(state); }
  function posted()           { return ST.posted(state); }
  function openRange()        { return ST.openRange(state); }
  function posName()          { return ST.posName(state); }
  function raiseTier(level)   { return ST.raiseTier(state, level); }
  function chips(x)           { return ST.chips(x); }
  function betSize(x)         { return ST.betSize(x); }
  function sized(x)           { return ST.sized(state, x); }
  function actText(verb, x)   { return ST.actText(state, verb, x); }

  /* 底池和跟注都用快捷金额，牌桌上没法数清物理筹码，估个量级就够用。
     底池指的是「中间现在一共多少」，已经含对手刚下的注——这样
     赔率直接就是 跟注/(底池+跟注)，不用再管谁跟了谁没跟。 */
  /* 底池档位，以及每档对应的加减步长。步长约等于「到下一档距离的 20%」，
     取整成好按的数：选 200 连按三下加号就是 260，选 500 一下加 100。 */
  var POT_PRESETS = [20, 100, 200, 300, 500];
  var POT_STEPS   = [10, 20,  20,  50,  100];

  /* 当前数值落在哪一档，就用那一档的步长 */
  function stepFor(val, presets, steps) {
    var st = steps[0];
    for (var i = 0; i < presets.length; i++) if (val >= presets[i]) st = steps[i];
    return st;
  }
  /* 要跟也是少放几档 + 可变步长。
     2 只在翻牌前有意义——那是一个大盲；翻牌后没人下 2 块，那一档就撤掉，
     省出来的位置给 200。步长按「跨一档要几步」定：
     5→10 一步，10→20 两步，20→50 三步，50→100 五步，100→200 五步，200 往上每步 50。 */
  var CALL_PRESETS_PRE  = [0, 2, 5, 10, 20, 50, 100, 200];
  var CALL_STEPS_PRE    = [5, 5, 5,  5, 10, 10,  20,  50];
  var CALL_PRESETS_POST = [0, 5, 10, 20, 50, 100, 200];
  var CALL_STEPS_POST   = [5, 5,  5, 10, 10,  20,  50];
  /* 最低端单独走一小段梯子，之后才进入按档位的步长。
     翻牌前 0→2→5（2 是一个大盲），翻牌后直接 0→5。 */
  var CALL_LADDER_PRE   = [0, 2, 5];
  var CALL_LADDER_POST  = [0, 5];

  function preflopNow() { return boardCount() === 0; }
  function callPresets() { return preflopNow() ? CALL_PRESETS_PRE : CALL_PRESETS_POST; }
  function callSteps()   { return preflopNow() ? CALL_STEPS_PRE   : CALL_STEPS_POST; }
  function callLadder()  { return preflopNow() ? CALL_LADDER_PRE  : CALL_LADDER_POST; }

  var POS = ST.POS;

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

  /* 盖着牌的时候，行动建议只留结论。中间那几行（你有多少胜率、期望多少）
     全是从手牌推出来的，旁边的人扫一眼就知道你强不强。
     在出口处统一裁剪，所有分支都覆盖得到，以后新加分支也不会漏。
     找不到结论标签的（「填入底池金额」这类提示）本来就不泄密，原样保留。 */
  function renderOdds() {
    renderOddsFull();
    if (!state.hideHero) return;
    var out = $('oddsOut');
    var v = out.querySelector('.verdict');
    if (v) out.innerHTML = v.outerHTML;
  }

  function renderOddsFull() {
    var out = $('oddsOut');
    if (!lastResult) { out.textContent = '先选好自己的两张手牌'; return; }
    out.innerHTML = ST.decide(state, lastResult).html;
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
    // 点「当前牌型」那块就能盖牌/翻牌——牌桌上一只手就能操作
    $('heroToggle').addEventListener('click', function () {
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
          renderMoney(k + 'Seg', k,
            k === 'pot' ? POT_PRESETS : callPresets(),
            k === 'pot' ? POT_STEPS : callSteps());
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

  /* 开发用回归钩子：直接喂状态和一个合成的模拟结果，拿回建议的 HTML。
     用来在重构决策逻辑前后逐条比对输出，确认行为完全一致。
     只在本机调试时挂出来，线上（GitHub Pages）碰不到。 */
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    window.__testDecide = function (patch, eq) {
      for (var k in patch) state[k] = patch[k];
      var cc = new Array(9);
      for (var i = 0; i < 9; i++) cc[i] = i === 1 ? 0.6 : 0.05;
      lastResult = { equity: eq, winRate: eq * 0.95, tieRate: eq * 0.05, loseRate: 1 - eq,
        n: 250000, lose: 1000, margin: 0.002, catCounts: cc, exact: false, elapsed: 1 };
      renderOddsFull();
      return $('oddsOut').innerHTML;
    };
  }

})();
