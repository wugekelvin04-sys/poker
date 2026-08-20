/* 决策逻辑：从「局面」算出「该怎么打」。
 *
 * 这一份被两个地方共用：
 *   app.js            —— 手机上实际使用的界面
 *   tools/sim-session.mjs —— 跑几十万手验证算法赚不赚钱的模拟器
 *
 * 之前两边各写了一份，注释里写着「镜像 app.js」，实际早就漂移了：
 * 模拟器还在用「对随机牌的胜率 + 底池赔率」判断翻牌前要不要跟，
 * 而 app 从 v51 起已经改成查防守范围表了。于是模拟器量出来的
 * 盈亏根本不是这个 App 的策略。合成一份，杜绝这类漂移。
 *
 * 这里只有纯函数，不碰 DOM、不读全局状态：所有函数都吃一个 g（局面），
 * 字段名和 app.js 里的 state 完全一致，app.js 可以直接把 state 传进来。
 *
 *   g = { hero:[c,c], board:[c×5，空位为 null], players, tableSize,
 *         pos, oppLevel, pot, call, called, stack }
 */
(function (global) {
  'use strict';

  var BIG_BLIND = 2;

  /* 每多打一条街，还留在牌里的人范围就更强一层——他已经为前面每条街
     都付过钱了，跟这条街有没有下注无关。翻牌前没人加注是唯一的例外：
     那时谁都还没做选择，范围确实接近随机。
     翻牌后已经改按牌面契合度筛，本身就够狠了，逐街收窄的幅度要小得多。 */
  /* 同样大小的注，越往后越有分量：河牌还敢开火的人，范围比翻牌窄得多。
     娱乐局这一档有牌桌实测口径（翻牌 ×1、转牌 ×0.8、河牌 ×0.6）；
     一般和老手没有同样的数据，沿用原来的保守值——实测把娱乐局那套
     套到基础更窄的档位上会过头（老手 + 2 倍池收到前 9.8%），成绩明显下滑。 */
  var STREET_TIGHTEN      = { 0: 1, 3: 1, 4: 0.92, 5: 0.85 };
  var STREET_TIGHTEN_LOOSE = { 0: 1, 3: 1, 4: 0.8,  5: 0.6 };

  var OPP_LEVELS = [
    { k: 'loose',  n: '娱乐局', pctl: 1,    board: 0.85 },
    { k: 'normal', n: '一般',   pctl: 0.55, board: 0.70 },
    { k: 'tight',  n: '老手',   pctl: 0.30, board: 0.55 }
  ];

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
  /* 大盲的再加注档从前 4% 放宽到前 9%。
     300 手对抗实测里，翻牌前「跟注」这个动作是 −295 BB/100、「加注」是 +553，
     而亏损几乎全部集中在大盲冷跟别人的加注（32 手冷跟里 20 手在大盲，净 −220）。
     那 20 手的结局是：14 手跟进去、翻牌没中、面对持续下注弃牌。
     等于按「会打后面几条街的人」的宽度进池，再按「不会打」的方式弃掉，两头占坏的。
     把跟注档最强的那批（AQo TT AJs AJo 99 ATs 88 ATo A9s 77 KQs）升级成反打，
     要么翻牌前直接拿下，要么带着主动权进翻牌——而主动下注正是这套算法唯一擅长的事。
     前 9% 装的是 AA-77 / AK-AT / KQ，是短桌大盲反打的标准范围，还偏紧一点。 */
  /* 防守范围要按对手档位整体缩放。原来三档共用同一张表——2.5 倍开池时
     raiseTier 的收紧系数对三档都等于 1，于是娱乐局和老手局的防守宽度
     一模一样，这显然不对：
       娱乐局的开池范围是前 70%（27o 都能跟 5 进来），对着这种范围
       J8s 在庄位当然该进；老手开池是前 20%，同一手牌就该弃。
     跟注档按对手范围的宽度放大／收窄；再加注档动得少——
     对娱乐局多打价值反打有用，但诈唬性反打没有弃牌率，不该跟着放宽。 */
  var DEFEND_LEVEL = {
    loose:  { three: 1.2, call: 1.8 },
    normal: { three: 1.0, call: 1.0 },
    tight:  { three: 1.0, call: 0.7 }
  };

  var DEFEND = {
    early: { three: 0.03, call: 0.10 },
    mid:   { three: 0.04, call: 0.14 },
    late:  { three: 0.05, call: 0.20 },
    btn:   { three: 0.06, call: 0.25 },
    sb:    { three: 0.04, call: 0.18 },
    bb:    { three: 0.09, call: 0.40 }
  };

  /* 加得越大，说明对手范围越强，我方防守就得越紧。
     但「大注 = 强牌」这个推断有多可靠，完全取决于对手是谁：
     娱乐局的人拿 A9o 也能加到 15BB，加注尺寸几乎不携带信息；
     老手加到 15BB 那基本就是 AA/KK。所以收紧的力度按档位走——
     指数越大收得越狠。注越大，档位造成的差别也越大，这是对的。 */
  var TIER_EXP = { loose: 0.40, normal: 0.70, tight: 0.90 };

  // ---------------- 局面的基本量 ----------------

  function boardCount(g) {
    return g.board.filter(function (c) { return c !== null; }).length;
  }

  function isPreflop(g) {
    return g.board.every(function (c) { return c === null; });
  }

  /* 翻牌前判断有没有人加注，必须看「他加到了多少」，不能看「我还欠多少」——
     这两个数只有在我没投过钱时才相等。
     我在大盲已经投了 2，别人最小加注到 4 时我只欠 2，用「欠的钱 > 大盲」
     判断就会得出「没人加注」，于是走进「大盲免费看翻牌」分支输出「过牌」。
     实测拿 AA 面对最小加注也建议过牌——而过牌根本不是合法选项，我欠着 2 块。
     任意两张牌最小加注就能白偷这个大盲。
     正确的量是 call + posted：
       大盲无人加注 0+2=2、小盲无人加注 1+1=2、其他位置无人加注 2+0=2，都不算加注；
       任何人加到 4，这个值就是 4，一律算加注。 */
  function facingBet(g) {
    return isPreflop(g) ? (g.call + posted(g)) > BIG_BLIND : g.call > 0;
  }

  function oppLevel(g) {
    for (var i = 0; i < OPP_LEVELS.length; i++)
      if (OPP_LEVELS[i].k === g.oppLevel) return OPP_LEVELS[i];
    return OPP_LEVELS[0];
  }

  /* 下注尺度本身就带信息：小注范围宽（探路、薄价值都可能），
     大注范围强。要跟/底池 正好就是这个尺度——底池已含他的注，
     所以半池下注约 0.33，满池约 0.5，1/4 池约 0.2。 */
  /* 下注尺度带的信息量，是按牌桌实测口径定的（娱乐局、单挑、翻牌）：
       ¼ 池 → 前 65%   ½ 池 → 前 40%   满池 → 前 25%   2 倍池 → 前 15%
     这四个点在对数坐标上几乎是一条直线（每翻一倍尺度，范围乘 0.61），
     所以拟合成幂律 0.291 ÷ 比例^0.703，再乘上各档的基础宽度。

     原来的公式是 1.05 − 0.8×比例、下限 0.65，半池就撞到下限了——
     半池、满池、2 倍池、4 倍池得到的对手范围一模一样，
     等于「超池注不携带任何信息」，对手可以用超池注价值最大化而不被察觉。 */
  function betSizeFactor(g) {
    if (!facingBet(g) || !(g.pot > 0)) return 1;
    var ratio = g.call / g.pot;
    if (g.oppLevel === 'loose')
      return Math.max(0.08, Math.min(1, 0.291 / Math.pow(Math.max(0.02, ratio), 0.703)));
    var f = 1.05 - 0.8 * ratio;             // 0.2→0.89  0.33→0.79  0.5→0.65
    return Math.max(0.65, Math.min(1, f));
  }

  /* 只有「这条街主动下注」的人才真的看着当前牌面做过决定，
     才配用当前牌面筛范围。没人下注时，所有人都只是从上一条街跟过来的。 */
  function strongOppCount(g) { return facingBet(g) ? 2 : 1; }

  /* 不确定时按「只有下注那个人投了钱」算，其余的人交给下注尺度去估 */
  function calledCount(g) { return g.called > 0 ? g.called : 1; }

  /* 后面还没说话的人数是精确算得出来的，不用靠位置估：
     还剩几人 = 我 + 已经跟了的 + 还没说话的 */
  function playersBehind(g) {
    return Math.max(0, g.players - 1 - calledCount(g));
  }

  /* 后面还没说话的人里，有多大比例会跟。注下得越大跟的人越少。
     levelAware !== false 时再按对手水平调整——松的桌子跟的人确实更多。

     翻牌前后必须用两把不同的尺子。
     翻牌后「要跟÷底池」是标准的下注尺度，半池 0.33、满池 0.5，够用。
     翻牌前底池就只有两个盲注（1.5BB），任何正常加注除以它都大于 1，
     这个公式会一律判成「超池大注，后面的人全跑」，跟注率被压到下限 5%——
     8 人桌有人开池到 2.5BB，算出来只有 2.3 个人会看到摊牌，
     于是 J8s 这种牌的胜率被抬到 42%（8 人桌的真实值约 16%）。
     翻牌前该看的是「他加到了几个大盲」：2.5BB 开池后面大约 20% 会跟，
     4BB 约 11%，10BB 的 3-bet 约 4%。 */
  function callRateBehind(g, levelAware) {
    var mult = levelAware === false ? 1
      : g.oppLevel === 'loose' ? 1.3 : g.oppLevel === 'tight' ? 0.75 : 1;
    if (isPreflop(g)) {
      /* 加到几个大盲，是翻牌前唯一有意义的尺度——底池此时就是两个盲注，
         拿它当分母，任何正常加注都会被算成「超池大注、后面全跑」。

         跟注率大致和加注倍数成反比。娱乐局的系数是按实战口径定的
         （8 人桌 1/2 盲注）：加到 5 全跟、加到 10 还剩 5 人、加到 20 剩 3~4 人。
         反推出来后面每个人的跟注概率约 2.4 ÷ 加注BB数。
         一般和老手没有同样的实测数据，按「同一个 2.5 倍开池分别剩 4 人 / 3 人」
         这个常见口径缩放。 */
      var A = { loose: 2.4, normal: 0.85, tight: 0.42 };
      var a = A[g.oppLevel] === undefined ? A.normal : A[g.oppLevel];
      var bb = Math.max(1, (g.call + posted(g)) / BIG_BLIND);
      return Math.max(0.02, Math.min(0.95, a / bb));
    }
    var base = 0.65 - (g.pot > 0 ? g.call / g.pot : 0.33);
    return Math.max(0.05, Math.min(0.75, base * mult));
  }

  function actionSplit(g) {
    var opp = g.players - 1;
    var behind = playersBehind(g);
    // 已投钱的人由用户直接告知，比从底池反推准——转牌河牌的底池里
    // 还含着前几条街的钱，反推会把它误判成「很多人跟过」
    var called = Math.max(0, Math.min(opp, calledCount(g)) - 1);   // 减掉下注者本人
    var willCall = Math.round(behind * callRateBehind(g));
    return { called: called, willCall: willCall, behind: behind };
  }

  /* 摊牌人数不取整。「后面还会跟几个」本来就是个期望值，硬凑成整数会造成
     整整一个人的跳变，而少一个对手值好几个胜率点——比范围收紧的影响还大，
     于是选「一般」反而比「娱乐局」算出更高的胜率。引擎支持小数人头。

     松桌子跟的人确实更多，这条真实效应保留。于是「对手水平」同时改人数和范围，
     两者方向相反（人多→胜率降，牌烂→胜率升），三档的胜率不保证单调——
     这不是 bug，是「对手更松」本来就既是坏消息也是好消息。 */
  function showdownPlayers(g) {
    var opp = g.players - 1;
    if (!facingBet(g) || opp <= 1) return g.players;
    var a = actionSplit(g);
    var willCall = playersBehind(g) * callRateBehind(g);   // 不取整
    return Math.min(opp, Math.max(1, a.called + willCall + 1)) + 1;
  }

  /* 筛范围该用哪个牌面：本街有人下注就用当前的，
     否则用少一张的——大家还没对刚翻开的这张做过决定 */
  function filterLen(g) {
    var n = boardCount(g);
    return facingBet(g) ? n : Math.max(0, n - 1);
  }

  /* 娱乐局、翻牌前、面对加注时，对手范围随加注大小衰减的实测曲线。
     按牌桌口径给的四个点（8 人桌 1/2 盲注）：
       加到 5 → 前 70%（27o 都能跟 5 进来）  加到 10 → 前 50%
       加到 20 → 前 30%                      加到 50 → 前 15%
     原来这里走的是 betSizeFactor（要跟 ÷ 底池），翻牌前底池只有两个盲注，
     算出来的比例永远撞下限，四个尺寸得到的范围一模一样都是 65%。
     横轴取对数插值：加注每翻一倍，范围收窄的幅度才是恒定的。
     只有娱乐局有这份实测数据，一般和老手仍按原路走。 */
  var PRE_LOOSE = [[2.5, 0.70], [5, 0.50], [10, 0.30], [25, 0.15]];

  function preflopLooseRange(bb) {
    var t = PRE_LOOSE;
    if (bb <= t[0][0]) return t[0][1];
    for (var i = 1; i < t.length; i++) {
      if (bb <= t[i][0]) {
        var f = Math.log(bb / t[i - 1][0]) / Math.log(t[i][0] / t[i - 1][0]);
        return t[i - 1][1] + f * (t[i][1] - t[i - 1][1]);
      }
    }
    // 超出最后一个点继续按同样的斜率往下走
    var last = t[t.length - 1], prev = t[t.length - 2];
    var k = Math.log(last[1] / prev[1]) / Math.log(last[0] / prev[0]);
    return Math.max(0.05, last[1] * Math.pow(bb / last[0], k));
  }

  /* 这一轮实际该用的对手范围 */
  function activePctl(g) {
    var n = boardCount(g);
    // 翻牌前且没人加注：大家都还没投钱，按随机牌算
    if (n === 0 && !facingBet(g)) return 1;
    if (n === 0 && g.oppLevel === 'loose')
      return preflopLooseRange((g.call + posted(g)) / BIG_BLIND);
    var base = n >= 3 ? oppLevel(g).board : oppLevel(g).pctl;
    var tight = g.oppLevel === 'loose' ? STREET_TIGHTEN_LOOSE : STREET_TIGHTEN;
    var p = base * (tight[n] || 1) * betSizeFactor(g);
    return Math.max(0.05, Math.min(1, p));
  }

  /* 「跟着看牌」那组的范围。没人下注时大家处境一样，不额外放宽；
     有人下注时，没跟注的那些人范围明显更宽。 */
  function wideTopPctl(g) { return Math.min(1, activePctl(g) * 2.5); }

  /* 固定随机种子：同一个局面每次都算出同一个数。
     不然切换「对手水平」时，两次各自 ±0.15% 的抽样抖动会叠在一起，
     偶尔盖过档位本身的差距，看上去就成了「收紧范围胜率反而更高」。 */
  function scenarioSeed(g) {
    var parts = [g.hero[0], g.hero[1]].concat(g.board)
      .concat([Math.round(showdownPlayers(g) * 100), strongOppCount(g), filterLen(g),
               Math.round(activePctl(g) * 1000), Math.round(wideTopPctl(g) * 1000)]);
    var h = 0x811c9dc5;
    for (var i = 0; i < parts.length; i++) {
      h ^= (parts[i] === null ? 53 : parts[i] | 0) + i * 131;
      h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /* 交给蒙特卡洛引擎的参数。app 和模拟器必须用同一套，
     否则「算出来的胜率」和「拿这个胜率做的决策」对不上。 */
  function simOptions(g) {
    var board = g.board.filter(function (c) { return c !== null; });
    return {
      players: showdownPlayers(g),
      seed: scenarioSeed(g),
      /* 牌面筛要至少三张牌才跑得起来。翻牌无人下注时筛选牌面退回两张
         （大家还没对翻牌做过决定），牌面筛失效——这时如果还把起手牌筛
         也关掉（oppMaxPctl=1），对手范围就退化成完全随机牌，胜率被系统性高估，
         于是拿底对也去下半池。两个筛至少要留一个。 */
      oppMaxPctl: (board.length >= 3 && filterLen(g) >= 3) ? 1 : activePctl(g),
      oppBoardTop: board.length >= 3 ? activePctl(g) : undefined,
      oppStrong: strongOppCount(g),
      oppWideTop: wideTopPctl(g),
      oppFilterLen: filterLen(g)
    };
  }

  // ---------------- 位置 ----------------

  /* 同一手牌有位置能打出更多价值——这就是胜率兑现率(equity realization)：
     原始胜率一样，有位置兑现得多，没位置兑现得少。 */
  function realizeFactor(g) {
    if (g.pos === 'btn') return 1.07;
    if (g.pos === 'late') return 1.00;
    return 0.93;
  }

  /* 我在盲注位已经投进去的钱，面对加注时只需补差额 */
  function posted(g) {
    return g.pos === 'bb' ? BIG_BLIND : g.pos === 'sb' ? BIG_BLIND / 2 : 0;
  }

  function openRange(g) {
    var t = g.players >= 7 ? OPEN_RANGE.full : OPEN_RANGE.short;
    return t[g.pos] || t.mid;
  }

  function posName(g) {
    for (var i = 0; i < POS.length; i++) if (POS[i].k === g.pos) return POS[i].n;
    return '中位';
  }

  /* 加注到多少个大盲，决定这是开池、3-bet 还是 4-bet。
     标准开池 2.5~3BB，3-bet 9~12BB，4-bet 22BB 以上。
     范围差别巨大，用同一张防守表会松得离谱——所以按尺度整体缩放。
     连续曲线，不是三个硬台阶——否则加到 4.4BB 和 4.6BB 会掉进完全
     不同的档，而同一档内加多少又完全不影响判断。 */
  function raiseTier(g, level) {
    var bb = level / BIG_BLIND;
    var exp = TIER_EXP[g.oppLevel] === undefined ? 0.70 : TIER_EXP[g.oppLevel];
    /* 曲线在 2.5BB 两侧都要延伸。原来是 bb<=2.5 一律取 1，
       意味着最小加注（2BB）和标准开池（2.5BB）买到的弃牌率完全一样——
       那对手当然只用最小加注，成本低 20% 效果相同。
       加得越小我该防守得越宽，这才是对的。上限 1.6 是防止
       输入一个极小的「要跟」把范围放到荒唐。 */
    var mult = Math.pow(2.5 / bb, exp);
    var name = bb <= 4.5 ? '开池加注' : bb <= 16 ? '3-bet 再加注' : '4-bet';
    return { mult: Math.max(0.05, Math.min(1.6, mult)), name: name };
  }

  // ---------------- 金额与文字 ----------------

  /* 筹码都是整数，任何金额一律取整，别报出 7.5 这种数 */
  function chips(x) { return String(Math.round(x)); }

  function pct(x, d) {
    if (d !== undefined) return (x * 100).toFixed(d) + '%';
    var v = x * 100;
    if (v === 0) return '0%';
    if (v >= 1) return v.toFixed(1) + '%';
    if (v >= 0.1) return v.toFixed(2) + '%';
    if (v >= 0.01) return v.toFixed(3) + '%';
    return '<0.01%';
  }

  /* 加注、下注的数额取整到好按的数上：牌桌上推的是实体筹码，
     「加注到 146」没人推得出来，实际也就推 150。
     50 以下取 5 的倍数，50 以上取 10 的倍数。
     跟注不能这么取——跟多少是对手定的，必须给准数。 */
  function betSize(x) {
    var v = x < 50 ? Math.round(x / 5) * 5 : Math.round(x / 10) * 10;
    return Math.max(5, v);
  }

  /* 任何建议都不能超过手上的筹码，超了就是全下 */
  function sized(g, x) {
    var st = g.stack;
    if (st > 0 && x >= st) return { text: '全下 ' + chips(st), allin: true, amount: st };
    return { text: chips(x), allin: false, amount: x };
  }

  /* 下注/加注类的判词，全下时不再说「加注到」 */
  function actText(g, verb, x) {
    var r = sized(g, x);
    return r.allin ? r.text : verb + ' ' + r.text;
  }

  // ---------------- 决策 ----------------

  /* g  局面
     r  蒙特卡洛结果（至少要有 equity）
     返回 { act, amount, allin, verdict, cls, html }
       act 取值：fold / call / raise / bet / check / marginal / need-input
       amount 是这个动作要投进去的筹码（raise/bet 是「加到多少」，call 是跟多少） */
  function decide(g, r) {
    var PF = global.PokerPreflop;

    /* 底池填的是「本轮下注之前」的数额——一整轮里它都不变，牌桌上好记。
       本轮投进去的钱由程序自己乘出来：
         实际底池 = 原始底池 + 已跟人数 × 要跟 + 后面预计跟的人 × 要跟
       后半段必须算，否则就成了「把后面的人当对手却不算他们的钱」的双重悲观。 */
    var split = facingBet(g) ? actionSplit(g) : { called: 0, willCall: 0 };
    var paidNow = facingBet(g) ? calledCount(g) : 0;
    var extraCallers = split.willCall;
    /* 筹码不够跟的话，实际只投得进这么多，多出来的会退还给对手。
       关键是底池也必须按这个封顶后的数算：以前分子封了顶、分母没封，
       对手随便报一个巨大的数字就能把「所需胜率」压到接近 0——
       我只剩 40、底池 100，他推 400，算出来只需 7.4% 胜率（真实 22.2%），
       于是拿 J4o 也全下。这不是模型偏保守，是纯粹的定价错误。 */
    var call = g.stack > 0 ? Math.min(g.call, g.stack) : g.call;
    var potNow = g.pot + (paidNow + extraCallers) * call;

    var eq = r.equity;
    var fair = 1 / g.players;              // 均分时每人应得的份额
    var ratio = eq / fair;
    var rf = realizeFactor(g);             // 翻牌后按位置折算能真正打出来的那部分
    var eqR = Math.max(0, Math.min(1, eq * rf));
    var posNote = '';

    var mk = function (act, amount, verdict, cls, html) {
      return { act: act, amount: amount, verdict: verdict, cls: cls, html: html };
    };

    // ---- 翻牌前、没人下注：这是开池决策 ----
    // 不能拿「多人全下的均分份额」当标尺——真实牌局大多数时候大家都弃牌了，
    // 你赢的是盲注，而全下均分完全没有弃牌率这回事。
    // 正确做法是看这手牌在 169 手起手牌里的强度排位，再对照位置该开多宽。
    var preflopUnraised = isPreflop(g) && (call + posted(g)) <= BIG_BLIND;
    if (preflopUnraised && PF) {
      var pctl = PF.percentile(g.hero[0], g.hero[1]);

      // 大盲位没人加注，就是免费看翻牌，不存在开不开池的问题
      if (g.pos === 'bb') {
        return mk('check', 0, '过牌', 'even',
          '<span class="verdict even">过牌</span>'
          + '大盲没人加注 = 免费看翻牌，没理由再投钱。这手牌排<b>前 '
          + (pctl * 100).toFixed(0) + '%</b>。');
      }

      var open = openRange(g);
      // 起手牌排位是按单挑胜率排的，会严重低估同花连张在多人底池的价值：
      // T9s 单挑排前 35%，8 人桌的胜率却比排前 13% 的 KJo 还高。
      // 所以只要不是硬桌子，都额外看一眼多人胜率，够格就便宜跟一手；
      // 只有「老手」档禁掉——对好对手跛入是送钱。
      var early = g.pos === 'early' || g.pos === 'mid';
      var limpBar = early ? 1.25 : 1.10;
      var v0, c0, act, a0, amt0, isRaise = false;
      if (pctl <= open) {
        v0 = '开池加注'; c0 = 'good'; act = '在范围内'; isRaise = true;
      } else if (g.oppLevel !== 'tight' && ratio >= limpBar) {
        amt0 = call > 0 ? call : BIG_BLIND;
        v0 = actText(g, '跟注', amt0); c0 = 'good'; a0 = 'call';
        act = '不够开池，但 ' + g.players + ' 人桌胜率 <b>' + pct(eq)
          + '</b> 是均分的 <b>' + ratio.toFixed(2) + ' 倍</b>，便宜跟一手看翻牌';
      } else if (pctl <= open * 1.35) {
        v0 = '边缘'; c0 = 'even'; act = '略超范围，桌子松可以开'; a0 = 'marginal'; amt0 = 0;
      } else {
        v0 = '弃牌 ✕'; c0 = 'bad'; act = '超出范围较多'; a0 = 'fold'; amt0 = 0;
      }
      if (isRaise) {
        // 标准开池尺度：2.5 倍大盲（小盲位 3 倍）
        var to = (g.pos === 'sb' ? 3 : 2.5) * BIG_BLIND;
        amt0 = betSize(to);
        v0 = actText(g, '开池加注到', amt0);
        act += '，' + (g.pos === 'sb' ? '3' : '2.5') + ' 倍大盲';
        a0 = 'raise';
      }
      return mk(a0, amt0, v0, c0,
        '<span class="verdict ' + c0 + '">' + v0 + '</span>'
        + posName(g) + g.players + ' 人桌开<b>前 ' + (open * 100).toFixed(0) + '%</b>，'
        + '这手牌<b>对随机牌前 ' + (pctl * 100).toFixed(0) + '%</b> → ' + act
        + '<br><span class="caveat">这张表按单挑胜率排，多人底池里同花连张的价值要更高</span>');
    }

    // ---- 翻牌前面对加注：查防守范围，不看底池赔率 ----
    if (isPreflop(g) && PF) {
      // 面对加注要用「对加注范围的胜率」排位，不能用「对随机牌」那张。
      // 77 对随机牌 66% 排前 4.2%，对前 20% 范围只有 49% 排前 7.1%——
      // 用错表会把它排在 AKo 前面，面对 3-bet、4-bet 都建议跟注。
      var dp = PF.vsRaise ? PF.vsRaise(g.hero[0], g.hero[1])
                          : PF.percentile(g.hero[0], g.hero[1]);
      var d0 = DEFEND[g.pos] || DEFEND.mid;
      var lv = DEFEND_LEVEL[g.oppLevel] || DEFEND_LEVEL.normal;
      var level = call + posted(g);               // 他加到了多少
      var tier = raiseTier(g, level);
      var d = { three: Math.min(1, d0.three * lv.three * tier.mult),
                call:  Math.min(1, d0.call  * lv.call  * tier.mult) };
      var v1, c1, why, a1, amt1;
      if (dp <= d.three) {
        // 有位置 3 倍就够；没位置要打大一点，否则翻牌后每条街都难打
        var ip = g.pos === 'btn' || g.pos === 'late';
        amt1 = betSize(level * (ip ? 3 : 4));
        v1 = actText(g, '再加注到', amt1); c1 = 'good'; a1 = 'raise';
        why = '够强，值得反打' + (ip ? '（有位置 3 倍）' : '（没位置 4 倍）') + '。';
      } else if (dp <= d.call) {
        amt1 = call;
        v1 = actText(g, '跟注', call); c1 = 'good'; a1 = 'call';
        why = '在防守范围内，跟一手。';
      } else {
        v1 = '弃牌 ✕'; c1 = 'bad'; a1 = 'fold'; amt1 = 0;
        why = '超出防守范围。';
      }
      return mk(a1, amt1, v1, c1,
        '<span class="verdict ' + c1 + '">' + v1 + '</span>'
        + posName(g) + '面对 ' + (level / BIG_BLIND).toFixed(1) + 'BB 加注：跟<b>前 '
        + (d.call * 100).toFixed(1) + '%</b>／再加<b>前 '
        + (d.three * 100).toFixed(1) + '%</b>，本手<b>对加注范围前 '
        + (dp * 100).toFixed(1) + '%</b> → ' + why
        + '<br><span class="caveat">翻牌前按范围判断，不看赔率</span>');
    }

    // ---- 没人下注 ----
    if (call <= 0) {
      if (potNow <= 0) {
        return mk('need-input', 0, '缺少底池', 'even',
          '<span class="verdict even">缺少底池</span>'
          + '翻牌后没有底池就算不出该下多少，填一下原底池。');
      }
      var verdict1, cls1, why1, a2, amt2;
      var ratioR = eqR / fair;
      /* 「均分份额」这把标尺在人少时会失效：单挑 fair=0.5，要下 ¾ 池得 eqR≥1.0，
         而无位置时 eqR = eq×0.93 ≤ 0.93，数学上永远达不到——拿着坚果也只会
         下半池。加注门槛同理要 86% 原始胜率。所以再开一条绝对胜率的通道，
         人多时不受影响（比例那条更容易先满足）。 */
      if (ratioR >= 2 || eqR >= 0.70) {
        amt2 = betSize(potNow * 0.75);
        verdict1 = actText(g, '下注', amt2); cls1 = 'good'; a2 = 'bet';
        why1 = '胜率 <b>' + pct(eq) + '</b> 远高于 ' + g.players + ' 人桌均分的 <b>'
          + pct(fair) + '</b>，下 ¾ 池要价值。';
      } else if (ratioR >= 1.3 || eqR >= 0.55) {
        amt2 = betSize(potNow * 0.5);
        verdict1 = actText(g, '下注', amt2); cls1 = 'good'; a2 = 'bet';
        why1 = '胜率 <b>' + pct(eq) + '</b> 略高于均分的 <b>' + pct(fair) + '</b>，下 ½ 池薄价值。';
      } else {
        verdict1 = '过牌'; cls1 = 'even'; a2 = 'check'; amt2 = 0;
        why1 = '胜率 <b>' + pct(eq) + '</b> 没到 ' + g.players + ' 人桌均分的 <b>'
          + pct(fair) + '</b>，先别投钱。';
      }
      return mk(a2, amt2, verdict1, cls1,
        '<span class="verdict ' + cls1 + '">' + verdict1 + '</span>' + why1
        + '<br>当前底池 <b>' + chips(potNow) + '</b>。' + posNote);
    }

    // ---- 有人下注 ----
    // 底池是 0 却有人下注，说明底池没填。这时算出来必然是「需要 100% 胜率」，
    // 数学上没错但毫无用处，直接说清楚要填什么。
    if (potNow <= 0) {
      return mk('need-input', 0, '底池没填', 'even',
        '<span class="verdict even">底池没填</span>'
        + '有人下注，底池就不会是 0。填一下中间现在一共多少'
        + '（含盲注和他下的注），否则赔率算不出来。');
    }

    var required = call / (potNow + call);       // 跟注所需的最低胜率
    var ev = eq * (potNow + call) - call;        // 跟注的期望收益
    var edge = eqR - required;
    var raiseTo = call + 0.7 * (potNow + call);  // 跟平后再按约 ⅔ 池加

    var verdict, cls, a3, amt3;
    if (edge < -0.02) { verdict = '弃牌 ✕'; cls = 'bad'; a3 = 'fold'; amt3 = 0; }
    else if (edge < 0.02) { verdict = '临界，看位置和对手'; cls = 'even'; a3 = 'marginal'; amt3 = call; }
    else if ((eqR >= 1.6 * fair || eqR >= 0.65) && edge >= 0.15) {
      amt3 = betSize(raiseTo);
      verdict = actText(g, '加注到', amt3); cls = 'good'; a3 = 'raise';
    } else {
      amt3 = call;
      verdict = actText(g, '跟注', call); cls = 'good'; a3 = 'call';
    }

    var html = '<span class="verdict ' + cls + '">' + verdict + '</span>'
      + '底池 <b>' + chips(potNow) + '</b>'
      + (call > 0
          ? '＝' + chips(g.pot) + '+' + (paidNow + extraCallers) + '×' + chips(call)
          : '')
      + ' · 需 <b>' + pct(required) + '</b><br>'
      + '你有 <b>' + pct(eq) + '</b>'
      + (rf !== 1 ? ' → 按位置 <b>' + pct(eqR) + '</b>' : '')
      + '（' + (edge >= 0 ? '多 ' : '差 ') + pct(Math.abs(edge)) + '）'
      + ' · 期望 <b>' + (ev >= 0 ? '+' : '−') + chips(Math.abs(ev)) + '</b>';
    if (!isPreflop(g)) html += posNote;
    if (isPreflop(g)) {
      // 翻牌前对手敢下注，他的牌一定强于随机牌，而胜率是按随机牌算的。
      // 口袋对子翻牌摸中暗三约 11.8%，纯胜率排位低估了这类牌
      var h0 = g.hero[0], h1 = g.hero[1];
      if (h0 !== null && h1 !== null && (h0 >> 2) === (h1 >> 2) && verdict.indexOf('弃牌') === 0) {
        html += '<br><span class="caveat">口袋对子：翻牌 12% 中暗三，筹码够 15 倍可摸</span>';
      }
      // 大盲已经投过钱，防守价格比别人好
      if (g.pos === 'bb' && call > 0) {
        html += '<br><span class="caveat">大盲防守可更宽，但翻牌后无位置</span>';
      }
    }
    return mk(a3, amt3, verdict, cls, html);
  }

  global.PokerStrategy = {
    BIG_BLIND: BIG_BLIND,
    STREET_TIGHTEN: STREET_TIGHTEN,
    OPP_LEVELS: OPP_LEVELS,
    POS: POS,
    OPEN_RANGE: OPEN_RANGE,
    DEFEND: DEFEND,
    DEFEND_LEVEL: DEFEND_LEVEL,
    TIER_EXP: TIER_EXP,

    boardCount: boardCount,
    isPreflop: isPreflop,
    facingBet: facingBet,
    oppLevel: oppLevel,
    betSizeFactor: betSizeFactor,
    strongOppCount: strongOppCount,
    calledCount: calledCount,
    playersBehind: playersBehind,
    callRateBehind: callRateBehind,
    actionSplit: actionSplit,
    showdownPlayers: showdownPlayers,
    filterLen: filterLen,
    preflopLooseRange: preflopLooseRange,
    activePctl: activePctl,
    wideTopPctl: wideTopPctl,
    scenarioSeed: scenarioSeed,
    simOptions: simOptions,

    realizeFactor: realizeFactor,
    posted: posted,
    openRange: openRange,
    posName: posName,
    raiseTier: raiseTier,

    chips: chips,
    pct: pct,
    betSize: betSize,
    sized: sized,
    actText: actText,

    decide: decide
  };
})(typeof self !== 'undefined' ? self : globalThis);
