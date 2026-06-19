// 平山牧場フォーマットの Excel 解析(excel-import.js)のゴールデンテスト。
// 代表的なシート配列(2次元配列)を入力に、農場割当・日付行検出・餌行/除外行の
// 判定・日消費量の集計が安定して動くことを固定する。
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHirayamaSheets } = require("../excel-import.js");

const FARMS = [{ id: "a", name: "赤坂" }, { id: "b", name: "本場" }];

// 日付行(3つ以上の日付)＋「エサ使用量」セクション＋餌行/除外行 を含む最小シート
const sampleSheet = () => [
  ["", "", "2026-06-01", "2026-06-02", "2026-06-03"], // 日付行(列2..4)
  ["搾乳エサ使用量", "", "", "", ""],                  // セクション見出し
  ["チモシー", "", 10, 12, 8],                         // 餌: 3日分=30kg
  ["合計", "", 10, 12, 8],                             // 除外(「合計」)
  ["アルファルファ", "", 5, "", 5],                    // 餌: 2日分=10kg(空欄は無視)
];

test("自動マッチ: シート名に農場名を含めば割り当てられ集計される", () => {
  const sheets = { "赤坂入力": sampleSheet() };
  const { results, foundAny, debug } = parseHirayamaSheets(sheets, null, FARMS);

  assert.equal(foundAny, true);
  assert.equal(debug.assignment.length, 1);
  assert.equal(debug.assignment[0].farmId, "a");

  const t = results.a["チモシー"];
  assert.equal(t.total, 30);
  assert.equal(t.days, 3);
  assert.equal(t.dailyKgAll, 10);
  assert.equal(t.from, "2026-06-01");
  assert.equal(t.to, "2026-06-03");

  const al = results.a["アルファルファ"];
  assert.equal(al.total, 10);
  assert.equal(al.days, 2); // 空欄の1日は集計から除外
  assert.equal(al.dailyKgAll, 5);
});

test("除外ルール: 「合計」等の行は餌として取り込まない", () => {
  const sheets = { "赤坂入力": sampleSheet() };
  const { results, debug } = parseHirayamaSheets(sheets, null, FARMS);
  assert.equal("合計" in results.a, false);
  const names = debug.perSheet[0].feeds.map(f => f.name);
  assert.deepEqual(names.sort(), ["アルファルファ", "チモシー"]);
  const excluded = debug.perSheet[0].excluded.map(e => e.name);
  assert.ok(excluded.includes("合計"));
});

test("手動マッピング: 任意のシート名を農場に割り当てられる", () => {
  const sheets = { "DataSheet": sampleSheet() };
  const { results, foundAny } = parseHirayamaSheets(sheets, { DataSheet: "b" }, FARMS);
  assert.equal(foundAny, true);
  assert.ok(results.b["チモシー"]);
});

test("農場名にマッチするシートが無ければ foundAny=false", () => {
  const sheets = { "無関係なシート": sampleSheet() };
  const { results, foundAny } = parseHirayamaSheets(sheets, null, FARMS);
  assert.equal(foundAny, false);
  assert.deepEqual(results, {});
});

test("日付行が見つからないシートはエラー情報を残す", () => {
  const sheets = { "赤坂": [["搾乳エサ使用量"], ["チモシー", "", 10]] }; // 日付行なし
  const { foundAny, debug } = parseHirayamaSheets(sheets, null, FARMS);
  assert.equal(foundAny, false);
  assert.match(debug.perSheet[0].error, /日付行/);
});
