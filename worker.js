/* 计算线程：主线程只管界面，模拟全在这里跑 */
// 版本由主线程通过 worker.js?v=xx 传进来，保证和页面用的是同一份引擎
var V = (self.location.search.match(/v=([^&]+)/) || [])[1];
var q = V ? '?v=' + V : '';
importScripts('engine.js' + q, 'sim.js' + q, 'preflop.js' + q);

self.onmessage = function (e) {
  var msg = e.data;
  if (!msg || msg.type !== 'run') return;
  var id = msg.id;
  try {
    var res;
    // 摊牌单挑时未知组合仅 C(45,2)=990 种，直接精确枚举，零误差
    if (msg.board.length === 5 && msg.players === 2) {
      res = PokerSim.enumerateShowdownHeadsUp(msg.hero, msg.board);
    } else {
      res = PokerSim.simulate({
        hero: msg.hero,
        board: msg.board,
        players: msg.players,
        maxIterations: msg.maxIterations,
        timeLimitMs: msg.timeLimitMs,
        oppMaxPctl: msg.oppMaxPctl,
        onProgress: function (p) {
          self.postMessage({ type: 'progress', id: id, result: p });
        }
      });
    }
    self.postMessage({ type: 'done', id: id, result: res });
  } catch (err) {
    self.postMessage({ type: 'error', id: id, message: String((err && err.message) || err) });
  }
};
