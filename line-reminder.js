// まきば在庫 - 発注忘れリマインド（1対1 LINE通知）
// GitHub Actions から毎朝実行される。
// 「在庫10日未満 かつ 今日より未来の入荷予定なし」の餌を見つけて、LINEで通知する。
// 該当なしの日は何も送信しない。
//
// 必要な環境変数（GitHub Secrets で設定）:
//   SUPABASE_URL        例: https://yqhhcgvopbevvttjlmee.supabase.co
//   SUPABASE_ANON_KEY        Supabase anon キー
//   LINE_TOKEN          LINE Messaging API チャネルアクセストークン
//   LINE_USER_ID        通知先のユーザーID（1対1。Uで始まる文字列）
//
// 設定（必要なら変更）:
const WARN_DAYS = 10;            // 在庫がこの日数未満なら警告対象
const STATE_ID = "main";        // app_state テーブルの行ID（アプリと同じ）
const APP_URL = "https://feedstock.vercel.app";

// ── 計算ロジックはアプリ本体(index.html)と共有 ──────
// countToKg / farmStats / stockModeOf / orderForFarm / daysBetween は feed-calc.js に集約。
// 以前はここに同じ実装をコピーしており、片方だけ直すと通知と画面表示が食い違う危険があった。
const { countToKg, farmStats, stockModeOf, orderForFarm, daysBetween } = require("./feed-calc.js");

// ── ユーティリティ ────────────────────────────────
const todayStr = () => {
  // 日本時間(JST)の今日の日付 YYYY-MM-DD
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
};
const fmt = (n) => (n == null || isNaN(n)) ? "—" : Math.round(n).toLocaleString("ja-JP");

// 農場ごとの在庫日数と入荷予定の有無を計算
function analyzeByFarm(item, today) {
  const orders = item.orders || [];
  const out = {};
  for (const fid of (item.farms || [])) {
    const fs = farmStats(item, fid);
    if (fs.lastKg == null || fs.dailyKg == null || fs.dailyKg <= 0) { out[fid] = null; continue; }
    // 棚卸し日以降〜今日に到来した発注（入荷済問わず）を加算
    let receivedSince = 0;
    if (fs.lastDate) {
      for (const o of orders) {
        if (o.etaDate <= fs.lastDate || o.etaDate > today) continue;
        const ff = orderForFarm(o);
        if (ff === fid) receivedSince += o.kg;
        else if (ff === "shared") {
          let tot = 0, mine = 0;
          for (const f of item.farms) { const u = farmStats(item, f).usage || 0; tot += u; if (f === fid) mine = u; }
          const share = tot > 0 ? mine / tot : 1 / item.farms.length;
          receivedSince += o.kg * share;
        }
      }
    }
    // 棚卸し日〜今日の消費見込み
    const days = fs.lastDate ? daysBetween(fs.lastDate, today) : 0;
    const consumed = fs.dailyKg * days;
    const stock = Math.max(0, fs.lastKg + receivedSince - consumed);
    const daysLeft = stock / fs.dailyKg;
    // 今日より未来の入荷予定があるか（この農場 or 共通指定）
    const hasFuture = orders.some(o => o.etaDate > today && !o.received &&
      (orderForFarm(o) === fid || orderForFarm(o) === "shared"));
    out[fid] = { stock, daysLeft, hasFuture, dailyKg: fs.dailyKg };
  }
  return out;
}

// 共通在庫モードの餌は全農場を合算して1つの在庫として判定
function analyzeShared(item, today) {
  const orders = item.orders || [];
  let totalStock = 0, totalDaily = 0, anchorDate = null, ok = false;
  for (const fid of (item.farms || [])) {
    const fs = farmStats(item, fid);
    if (fs.lastKg == null || fs.dailyKg == null) continue;
    ok = true;
    if (!anchorDate || (fs.lastDate && fs.lastDate < anchorDate)) anchorDate = fs.lastDate;
  }
  if (!ok) return null;
  // 合算は簡略化: 各農場の現在庫・日消費を合算
  for (const fid of (item.farms || [])) {
    const fs = farmStats(item, fid);
    if (fs.lastKg == null || fs.dailyKg == null) continue;
    const days = fs.lastDate ? daysBetween(fs.lastDate, today) : 0;
    let recv = 0;
    for (const o of orders) {
      if (o.etaDate <= fs.lastDate || o.etaDate > today) continue;
      // 共通モードは農場指定問わず全量を合算プールへ（1回だけ数えるため最初の農場ループでのみ加算）
    }
    totalStock += Math.max(0, fs.lastKg - fs.dailyKg * days);
    totalDaily += fs.dailyKg;
  }
  // 共通モードの入荷は全量加算（農場按分しない）
  for (const o of orders) {
    if (!anchorDate) break;
    if (o.etaDate <= anchorDate || o.etaDate > today) continue;
    totalStock += o.kg;
  }
  if (totalDaily <= 0) return null;
  const daysLeft = totalStock / totalDaily;
  const hasFuture = orders.some(o => o.etaDate > today && !o.received);
  return { stock: totalStock, daysLeft, hasFuture };
}

// ── メイン ────────────────────────────────────────
async function main() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, LINE_TOKEN, LINE_USER_ID } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !LINE_TOKEN || !LINE_USER_ID) {
    console.error("環境変数が不足しています。");
    process.exit(1);
  }
  const today = todayStr();

  // Supabaseから app_state を取得（id=main の data 列）
  const url = `${SUPABASE_URL}/rest/v1/app_state?id=eq.${STATE_ID}&select=data`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) { console.error("Supabase取得失敗:", res.status, await res.text()); process.exit(1); }
  const rows = await res.json();
  if (!rows.length) { console.error("app_stateが見つかりません。"); process.exit(1); }
  const state = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;

  const farms = state.farms || [];
  const farmName = (id) => farms.find(f => f.id === id)?.name || id;

  // 警告対象を集める: { farmId: [ {name, daysLeft, endDate} ] }
  const byFarm = {};   // 農場別の警告
  const sharedWarn = []; // 共通在庫の警告

  for (const item of (state.items || [])) {
    if (item.excludeFromPlan) continue; // 発注プラン除外フラグ
    if (stockModeOf(item) === "shared") {
      const a = analyzeShared(item, today);
      if (a && a.daysLeft < WARN_DAYS && !a.hasFuture) {
        const endDate = new Date(Date.now() + 9 * 3600 * 1000 + a.daysLeft * 86400000).toISOString().slice(5, 10).replace("-", "/");
        sharedWarn.push({ name: item.name, daysLeft: a.daysLeft, endDate });
      }
    } else {
      const res2 = analyzeByFarm(item, today);
      for (const fid of (item.farms || [])) {
        const a = res2[fid];
        if (a && a.daysLeft < WARN_DAYS && !a.hasFuture) {
          if (!byFarm[fid]) byFarm[fid] = [];
          const endDate = new Date(Date.now() + 9 * 3600 * 1000 + a.daysLeft * 86400000).toISOString().slice(5, 10).replace("-", "/");
          byFarm[fid].push({ name: item.name, daysLeft: a.daysLeft, endDate });
        }
      }
    }
  }

  const hasAny = Object.keys(byFarm).length > 0 || sharedWarn.length > 0;
  if (!hasAny) {
    console.log("該当なし。通知しません。");
    return;
  }

  // メッセージ組み立て
  const md = today.slice(5).replace("-", "/");
  let msg = `🚨 まきば在庫 発注リマインド（${md} 朝）\n\n発注予定がなく、在庫が少なくなっています：\n`;
  for (const fid of farms.map(f => f.id)) {
    const list = byFarm[fid];
    if (!list || !list.length) continue;
    list.sort((a, b) => a.daysLeft - b.daysLeft);
    msg += `\n▼ ${farmName(fid)}\n`;
    for (const w of list) {
      msg += `・${w.name}: 残り${Math.floor(w.daysLeft)}日分（${w.endDate}頃まで）\n`;
    }
  }
  if (sharedWarn.length) {
    sharedWarn.sort((a, b) => a.daysLeft - b.daysLeft);
    msg += `\n▼ 共通在庫\n`;
    for (const w of sharedWarn) {
      msg += `・${w.name}: 残り${Math.floor(w.daysLeft)}日分（${w.endDate}頃まで）\n`;
    }
  }
  msg += `\nアプリで発注予定を登録してください。\n${APP_URL}`;

  // LINE送信
  const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: "text", text: msg }] }),
  });
  if (!lineRes.ok) { console.error("LINE送信失敗:", lineRes.status, await lineRes.text()); process.exit(1); }
  console.log("通知しました:\n" + msg);
}

// テストから require したときは main() を実行せず、純粋ロジックだけ公開する。
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { analyzeByFarm, analyzeShared, todayStr, fmt };
