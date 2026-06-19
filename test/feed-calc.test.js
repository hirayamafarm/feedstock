// 在庫計算の中核ロジック(feed-calc.js)のユニットテスト。
// これらは index.html と line-reminder.js が共有する「単一の真実」を検証する。
const test = require("node:test");
const assert = require("node:assert/strict");
const { countToKg, farmStats, stockModeOf, stockScopesOf, orderForFarm, daysBetween } = require("../feed-calc.js");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b} ではない`);

test("countToKg: 単位ごとのkg換算を合算する", () => {
  const item = { units: [{ id: "r", kg: 300 }, { id: "c", kg: 1200 }] };
  assert.equal(countToKg(item, { r: 2, c: 1 }), 1800);
  assert.equal(countToKg(item, { r: 1 }), 300);
});

test("countToKg: __kg があれば直接kg入力として扱う", () => {
  const item = { units: [{ id: "r", kg: 300 }] };
  assert.equal(countToKg(item, { __kg: 50, r: 99 }), 50);
  assert.equal(countToKg(item, { __kg: "0" }), 0);
});

test("countToKg: q が無い/単位が無いと 0", () => {
  assert.equal(countToKg({ units: [] }, null), 0);
  assert.equal(countToKg({}, { r: 5 }), 0);
});

test("farmStats: 棚卸し2回から日消費量を推定する(source=count)", () => {
  const item = {
    units: [{ id: "b", kg: 25 }],
    counts: { a: [{ date: "2026-04-15", qtys: { b: 8 } }, { date: "2026-05-15", qtys: { b: 3 } }] },
  };
  const fs = farmStats(item, "a");
  // 200kg → 75kg を30日で消費 = 125kg/30日
  assert.equal(fs.lastKg, 75);
  assert.equal(fs.lastDate, "2026-05-15");
  near(fs.dailyKg, 125 / 30);
  near(fs.usage, 125);
  assert.equal(fs.source, "count");
});

test("farmStats: Excel取込(feedDaily)を棚卸し推定より優先する(source=excel)", () => {
  const item = {
    units: [{ id: "b", kg: 25 }],
    feedDaily: { a: { dailyKg: 10 } },
    counts: { a: [{ date: "2026-04-15", qtys: { b: 8 } }, { date: "2026-05-15", qtys: { b: 3 } }] },
  };
  const fs = farmStats(item, "a");
  assert.equal(fs.dailyKg, 10);
  assert.equal(fs.usage, 300);
  assert.equal(fs.source, "excel");
});

test("farmStats: extraDaily(別給与)は常に加算する", () => {
  const item = { feedDaily: { a: { dailyKg: 10 } }, extraDaily: { a: 2 }, counts: {} };
  const fs = farmStats(item, "a");
  assert.equal(fs.dailyKg, 12);
  assert.equal(fs.usage, 360);
});

test("farmStats: 棚卸しもExcelも無く別給与だけなら source=extra", () => {
  const fs = farmStats({ extraDaily: { a: 5 } }, "a");
  assert.equal(fs.dailyKg, 5);
  assert.equal(fs.source, "extra");
  assert.equal(fs.lastKg, null);
});

test("farmStats: 在庫が増えていた場合(diff<=0)は消費0扱い", () => {
  const item = {
    units: [{ id: "b", kg: 25 }],
    counts: { a: [{ date: "2026-04-15", qtys: { b: 3 } }, { date: "2026-05-15", qtys: { b: 8 } }] },
  };
  const fs = farmStats(item, "a");
  assert.equal(fs.baseDaily, 0);
});

test("farmStats: データが何も無ければ全て null", () => {
  const fs = farmStats({}, "a");
  assert.equal(fs.lastKg, null);
  assert.equal(fs.dailyKg, null);
  assert.equal(fs.usage, null);
});

test("stockModeOf / stockScopesOf / orderForFarm の既定値", () => {
  assert.equal(stockModeOf({ stockMode: "shared" }), "shared");
  assert.equal(stockModeOf({}), "split");
  assert.equal(stockModeOf(null), "split");
  assert.deepEqual(stockScopesOf({ farms: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(stockScopesOf({}), []);
  assert.equal(orderForFarm({ forFarm: "a" }), "a");
  assert.equal(orderForFarm({}), "shared");
});

test("daysBetween: 経過日数。逆順は0に丸める", () => {
  assert.equal(daysBetween("2026-01-01", "2026-01-11"), 10);
  assert.equal(daysBetween("2026-01-11", "2026-01-01"), 0);
  assert.equal(daysBetween("2026-01-01", "2026-01-01"), 0);
});
