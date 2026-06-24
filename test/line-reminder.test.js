// 発注リマインドの警告ロジック(line-reminder.js)のユニットテスト。
// 「在庫日数」と「将来の入荷予定の有無」が正しく出るかを検証する。
// require.main ガードにより main() は実行されない(環境変数不要)。
const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeByFarm, analyzeShared } = require("../line-reminder.js");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b} ではない`);
const TODAY = "2026-06-11";

test("analyzeByFarm: 棚卸し後の消費だけで在庫が尽きる", () => {
  const item = {
    farms: ["a"],
    units: [{ id: "b", kg: 25 }],
    feedDaily: { a: { dailyKg: 10 } },
    counts: { a: [{ date: "2026-06-01", qtys: { b: 4 } }] }, // 100kg
    orders: [],
  };
  const out = analyzeByFarm(item, TODAY);
  // 100kg - 10kg/日 * 10日 = 0
  assert.equal(out.a.stock, 0);
  assert.equal(out.a.daysLeft, 0);
  assert.equal(out.a.hasFuture, false);
  assert.equal(out.a.dailyKg, 10);
});

test("analyzeByFarm: 棚卸し後〜今日に到来した入荷を在庫へ加算", () => {
  const item = {
    farms: ["a"],
    units: [{ id: "b", kg: 25 }],
    feedDaily: { a: { dailyKg: 10 } },
    counts: { a: [{ date: "2026-06-01", qtys: { b: 4 } }] },
    orders: [{ id: 1, kg: 300, etaDate: "2026-06-05", forFarm: "a", received: true }],
  };
  const out = analyzeByFarm(item, TODAY);
  // 100 + 300 - 100 = 300、残り30日
  assert.equal(out.a.stock, 300);
  assert.equal(out.a.daysLeft, 30);
});

test("analyzeByFarm: 今日より未来の未入荷予定は hasFuture=true（在庫には未加算）", () => {
  const item = {
    farms: ["a"],
    units: [{ id: "b", kg: 25 }],
    feedDaily: { a: { dailyKg: 10 } },
    counts: { a: [{ date: "2026-06-01", qtys: { b: 4 } }] },
    orders: [{ id: 1, kg: 300, etaDate: "2026-06-20", forFarm: "a", received: false }],
  };
  const out = analyzeByFarm(item, TODAY);
  assert.equal(out.a.stock, 0); // 未来分は未加算
  assert.equal(out.a.hasFuture, true);
});

test("analyzeByFarm: 消費量が出せない餌は null", () => {
  const item = { farms: ["a"], units: [{ id: "b", kg: 25 }], counts: { a: [{ date: "2026-06-01", qtys: { b: 4 } }] }, orders: [] };
  const out = analyzeByFarm(item, TODAY); // 棚卸し1回のみ → dailyKg 出せない
  assert.equal(out.a, null);
});

test("analyzeShared: 全農場を合算して1タンクとして在庫日数を出す", () => {
  const item = {
    stockMode: "shared",
    farms: ["a", "b"],
    units: [{ id: "b", kg: 25 }],
    feedDaily: { a: { dailyKg: 10 }, b: { dailyKg: 5 } },
    counts: {
      a: [{ date: "2026-06-01", qtys: { b: 4 } }], // 100kg
      b: [{ date: "2026-06-01", qtys: { b: 4 } }], // 100kg
    },
    orders: [],
  };
  const a = analyzeShared(item, TODAY);
  // a: 100-100=0, b: 100-50=50 → 合計50 / (10+5)/日
  assert.equal(a.stock, 50);
  near(a.daysLeft, 50 / 15);
  assert.equal(a.hasFuture, false);
});

test("analyzeShared: 共通モードの入荷は農場按分せず全量を加算", () => {
  const item = {
    stockMode: "shared",
    farms: ["a", "b"],
    units: [{ id: "b", kg: 25 }],
    feedDaily: { a: { dailyKg: 10 }, b: { dailyKg: 5 } },
    counts: {
      a: [{ date: "2026-06-01", qtys: { b: 4 } }],
      b: [{ date: "2026-06-01", qtys: { b: 4 } }],
    },
    orders: [
      { id: 1, kg: 300, etaDate: "2026-06-05", received: true },  // 到来済 → 加算
      { id: 2, kg: 999, etaDate: "2026-06-20", received: false }, // 未来 → hasFuture
    ],
  };
  const a = analyzeShared(item, TODAY);
  assert.equal(a.stock, 350); // 50 + 300
  assert.equal(a.hasFuture, true);
});
