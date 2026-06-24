// 月末メンテナンスリマインドの日付判定(line-maintenance.js)のユニットテスト。
// 「今日が月末の1日前か」がリマインド送信の発火条件なので、月の長さ・うるう年・
// 年またぎの境界を重点的に検証する。
const test = require("node:test");
const assert = require("node:assert/strict");
const { isDayBeforeMonthEnd, daysBetween } = require("../line-maintenance.js");

// new Date(y, m-1, d): ローカル時刻で日付を作る（関数も getFullYear/Month/Date を使う）
const d = (y, m, day) => new Date(y, m - 1, day);

test("isDayBeforeMonthEnd: 31日月", () => {
  assert.equal(isDayBeforeMonthEnd(d(2026, 1, 30)), true);  // 1/30 は 1/31 の前日
  assert.equal(isDayBeforeMonthEnd(d(2026, 1, 31)), false); // 月末当日
  assert.equal(isDayBeforeMonthEnd(d(2026, 1, 29)), false);
});

test("isDayBeforeMonthEnd: 30日月", () => {
  assert.equal(isDayBeforeMonthEnd(d(2026, 4, 29)), true);  // 4/29 は 4/30 の前日
  assert.equal(isDayBeforeMonthEnd(d(2026, 4, 30)), false);
});

test("isDayBeforeMonthEnd: 平年2月", () => {
  assert.equal(isDayBeforeMonthEnd(d(2026, 2, 27)), true);  // 平年は 2/28 が月末
  assert.equal(isDayBeforeMonthEnd(d(2026, 2, 28)), false);
});

test("isDayBeforeMonthEnd: うるう年2月", () => {
  assert.equal(isDayBeforeMonthEnd(d(2024, 2, 28)), true);  // うるう年は 2/29 が月末
  assert.equal(isDayBeforeMonthEnd(d(2024, 2, 27)), false);
  assert.equal(isDayBeforeMonthEnd(d(2024, 2, 29)), false);
});

test("isDayBeforeMonthEnd: 年またぎ(12/30)", () => {
  assert.equal(isDayBeforeMonthEnd(d(2026, 12, 30)), true);
  assert.equal(isDayBeforeMonthEnd(d(2026, 12, 31)), false);
});

test("isDayBeforeMonthEnd: 月の途中は常に false", () => {
  assert.equal(isDayBeforeMonthEnd(d(2026, 6, 15)), false);
  assert.equal(isDayBeforeMonthEnd(d(2026, 6, 1)), false);
});

test("daysBetween: 経過日数", () => {
  assert.equal(daysBetween("2026-06-01", "2026-06-06"), 5);
  assert.equal(daysBetween("2026-06-06", "2026-06-06"), 0);
});
