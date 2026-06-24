// まきば在庫 - 共通在庫計算ロジック（単一の真実）
// index.html（ブラウザ）と line-reminder.js（Node）の両方がここを参照する。
// 以前は両ファイルに同じ計算がコピーされており、片方だけ直すと表示と通知が
// 食い違う危険があった。それを防ぐために1ファイルへ集約している。
//
// 公開形式(UMD):
//   - ブラウザ : <script src="./feed-calc.js"> で window.FeedCalc に生える
//   - Node     : const FeedCalc = require("./feed-calc.js")
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FeedCalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 2日付間の経過日数（負値は0に丸める）
  const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));

  // 棚卸し数量(qtys)を kg に換算。q.__kg があれば直接kg入力として扱う。
  function countToKg(item, q) {
    if (!q) return 0;
    if (q.__kg != null) return Number(q.__kg) || 0; // 手入力(kg直接)
    let kg = 0;
    for (const u of (item.units || [])) { const n = q?.[u.id]; if (n) kg += n * u.kg; }
    return kg;
  }

  // 農場ごとの最新在庫・1日消費量などを算出。
  // baseDaily は Excel取込(feedDaily) > 棚卸し2回からの推定 の優先順位。
  // extraDaily（別給与）は常に加算する。
  function farmStats(item, fid) {
    const counts = [...(item.counts?.[fid] || [])].sort((a, b) => a.date.localeCompare(b.date));
    const last = counts[counts.length - 1] || null, prev = counts[counts.length - 2] || null;
    const lastKg = last ? countToKg(item, last.qtys) : null;
    const fd = item.feedDaily?.[fid];
    let baseDaily = null, source = null;
    if (fd && fd.dailyKg > 0) { baseDaily = fd.dailyKg; source = "excel"; }
    else if (last && prev) {
      // 同日棚卸し(diff日数=0)でも0除算しないよう最低1日とする
      const days = Math.max(1, Math.round((new Date(last.date) - new Date(prev.date)) / 86400000));
      const diff = countToKg(item, prev.qtys) - lastKg;
      baseDaily = diff > 0 ? diff / days : 0; source = "count";
    }
    const extra = (item.extraDaily?.[fid]) || 0; // 別給与（1日あたりkg・Excel/棚卸しに含まれない分）
    let dailyKg = baseDaily != null ? baseDaily + extra : (extra > 0 ? extra : null);
    if (baseDaily == null && extra > 0) source = "extra";
    const usage = dailyKg != null ? dailyKg * 30 : null;
    return { last, lastKg, usage, dailyKg, baseDaily, extra, source, lastDate: last?.date || null };
  }

  // 餌の在庫モード(shared:全農場共通 / split:農場別)。古いデータはsplit扱い。
  function stockModeOf(item) { return item?.stockMode === "shared" ? "shared" : "split"; }
  // stockModeに応じた在庫スコープのリスト（常に農場別。共通モードは表示時に合計するだけ）
  function stockScopesOf(item) { return item.farms || []; }
  // 発注の対象農場（古いordersはshared互換）
  function orderForFarm(o) { return o.forFarm || "shared"; }

  return { daysBetween, countToKg, farmStats, stockModeOf, stockScopesOf, orderForFarm };
});
