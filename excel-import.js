// まきば在庫 - 平山牧場フォーマットの Excel 解析（純粋ロジック）
// React コンポーネント(index.html の ExcelImport)から状態更新と切り離して呼べるように
// 抽出したもの。シート配列を受け取り、農場ごとの餌使用量と解析デバッグ情報を返す。
//
// 公開形式(UMD):
//   - ブラウザ : <script src="./excel-import.js"> で window.ExcelImportCore に生える
//   - Node     : const ExcelImportCore = require("./excel-import.js")
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ExcelImportCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // sheets: { シート名: 行配列(配列の配列) }
  // sheetFarmOverride: { シート名: farmId | "skip" } 手動マッピング（null=自動）
  // farms: [{ id, name }]（旧 FARMS グローバルを引数化）
  // 返り値: { results, foundAny, debug:{ sheets, assignment, perSheet } }
  function parseHirayamaSheets(sheets, sheetFarmOverride, farms) {
    // 農場対応: farmsの名前を見てシートを自動マッチ。手動マッピングがあれば優先。
    const farmMap = farms.map(f => ({ keywords: [f.name], farmId: f.id, farmName: f.name }));
    const results = {};
    let foundAny = false;
    const debugSheets = Object.keys(sheets);
    const debug = []; // 各シートの解析結果(画面表示用)

    // どのシートをどの農場に割り当てるか決める
    const assignment = []; // {sheetName, farmId, farmName}
    if (sheetFarmOverride) {
      for (const [sheetName, farmId] of Object.entries(sheetFarmOverride)) {
        if (farmId === "skip") continue;
        const farm = farms.find(f => f.id === farmId); if (!farm) continue;
        assignment.push({ sheetName, farmId, farmName: farm.name });
      }
    } else {
      // 自動: 各農場名を含むシートを探す
      for (const { keywords, farmId, farmName } of farmMap) {
        const sheetName = debugSheets.find(nm => {
          const norm = String(nm).replace(/\s/g, "").trim();
          return keywords.some(k => norm.includes(k));
        });
        if (sheetName) assignment.push({ sheetName, farmId, farmName });
      }
    }

    for (const { sheetName, farmId, farmName } of assignment) {
      const sheetDebug = { sheetName, farmId, farmName, totalRows: 0, dateRow: null, dateCount: 0, dateFromTo: null, sections: [], feeds: [], excluded: [] };
      debug.push(sheetDebug);
      const rows = sheets[sheetName]; if (!rows) { sheetDebug.error = "シートが読み込めません"; continue; }
      sheetDebug.totalRows = rows.length;

      const isDateLike = (v) => {
        if (v == null) return null;
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        const s = String(v).trim();
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) { const d = new Date(s); if (!isNaN(d)) return d.toISOString().slice(0, 10); }
        if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) { const d = new Date(s); if (!isNaN(d)) return d.toISOString().slice(0, 10); }
        return null;
      };
      let dateRow = -1, dateStartCol = 2;
      for (let r = 0; r < Math.min(rows.length, 30); r++) {
        const row = rows[r] || []; let dc = 0, firstC = -1;
        for (let c = 0; c < Math.min(row.length, 60); c++) {
          if (isDateLike(row[c])) { dc++; if (firstC < 0) firstC = c; }
        }
        if (dc >= 3) { dateRow = r; dateStartCol = firstC; break; }
      }
      if (dateRow < 0) { sheetDebug.error = "日付行が見つかりませんでした（最初の30行で日付らしき値が3つ以上並ぶ行が必要）"; continue; }
      const dates = []; const dateCols = [];
      for (let c = dateStartCol; c < rows[dateRow].length; c++) {
        const d = isDateLike(rows[dateRow][c]);
        if (d) { dateCols.push(c); dates.push(d); }
      }
      sheetDebug.dateRow = dateRow + 1; // 人間向けに1始まり
      sheetDebug.dateCount = dates.length;
      sheetDebug.dateFromTo = dates.length > 0 ? `${dates[0]}〜${dates[dates.length - 1]}` : null;

      // 餌セクション開始行
      const sectionStarts = [];
      for (let r = 0; r < rows.length; r++) {
        const v = rows[r]?.[0]; if (!v) continue;
        const s = String(v);
        if (s.includes("エサ使用量") && !s.includes("残餌")) sectionStarts.push({ row: r, label: s.trim() });
      }
      if (sectionStarts.length === 0) { sheetDebug.error = "「エサ使用量」を含むセクション見出しが見つかりませんでした"; continue; }
      const ranges = sectionStarts.map((s, i) => ({ startRow: s.row + 1, endRow: (sectionStarts[i + 1]?.row || rows.length), label: s.label }));
      sheetDebug.sections = ranges.map(r => ({ label: r.label, startRow: r.startRow + 1, endRow: r.endRow }));

      const isNotFeed = (s) => {
        if (s.includes("使用量")) return "「使用量」を含む";
        if (s.includes("合計")) return "「合計」を含む";
        if (s.includes("平均")) return "「平均」を含む";
        if (s.includes("乾物")) return "「乾物」を含む";
        if (s.includes("残餌")) return "「残餌」を含む";
        if (s.includes("ロボ配合平均")) return "ロボ配合平均";
        if (s.includes("TMR") || s.includes("ＴＭR") || s.includes("ＴＭＲ")) return "TMR";
        if (s.includes("割合")) return "「割合」を含む";
        if (s.includes("率")) return "「率」を含む";
        if (s.includes("頭数")) return "「頭数」を含む";
        if (s.includes("群")) return "「群」を含む";
        if (s === "水" || s === "塩ブロック") return "除外名";
        if (s.includes("ロール")) return "「ロール」を含む";
        if (s.includes("ブロック")) return "「ブロック」を含む";
        return null;
      };

      const feedDaily = {};
      for (const r of ranges) {
        for (let row = r.startRow; row < r.endRow; row++) {
          const name = rows[row]?.[0]; if (!name) continue;
          const ns = String(name).trim(); if (!ns) continue;
          const reason = isNotFeed(ns);
          if (reason) { sheetDebug.excluded.push({ row: row + 1, name: ns, reason }); continue; }
          let rowTotal = 0, rowDays = 0;
          for (let i = 0; i < dateCols.length; i++) {
            const c = dateCols[i]; const v = rows[row][c];
            const num = typeof v === "number" ? v : parseFloat(v);
            if (!isNaN(num) && num > 0) {
              if (!feedDaily[ns]) feedDaily[ns] = {};
              feedDaily[ns][dates[i]] = (feedDaily[ns][dates[i]] || 0) + num;
              rowTotal += num; rowDays++;
            }
          }
          // 検出された餌行（複数同名が出る場合は1つにまとめる）
          const exist = sheetDebug.feeds.find(f => f.name === ns);
          if (exist) { exist.rows.push(row + 1); exist.total += rowTotal; exist.days += rowDays; }
          else sheetDebug.feeds.push({ name: ns, rows: [row + 1], total: rowTotal, days: rowDays });
        }
      }

      const farmRes = {};
      for (const [name, daily] of Object.entries(feedDaily)) {
        const ds = Object.keys(daily).filter(d => daily[d] > 0).sort();
        if (ds.length === 0) continue;
        const total = ds.reduce((s, d) => s + daily[d], 0);
        const from = ds[0], to = ds[ds.length - 1];
        const dailyKgAll = total / ds.length;
        const cut = new Date(new Date(to) - 14 * 86400000).toISOString().slice(0, 10);
        const recentDs = ds.filter(d => d >= cut);
        const recentTotal = recentDs.reduce((s, d) => s + daily[d], 0);
        const dailyKgRecent = recentDs.length > 0 ? recentTotal / recentDs.length : dailyKgAll;
        farmRes[name] = { dailyKgAll, dailyKgRecent, total, recentTotal, recentDays: recentDs.length, from, to, days: ds.length, rows: ds.length, recentFrom: recentDs[0] || from };
      }
      if (Object.keys(farmRes).length > 0) { results[farmId] = farmRes; foundAny = true; }
    }

    return { results, foundAny, debug: { sheets: debugSheets, assignment, perSheet: debug } };
  }

  return { parseHirayamaSheets };
});
