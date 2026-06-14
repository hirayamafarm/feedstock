// まきば在庫 - 月末メンテナンスリマインド（1対1 LINE通知）
// 月末の1日前に、(1)棚卸し (2)使用量Excel取り込み のリマインドを送る。
// ただし、それぞれ直近5日以内に実行されていれば、そのリマインドは送らない。
//
// GitHub Secrets:
//   SUPABASE_URL, SUPABASE_ANON_KEY, LINE_TOKEN, LINE_USER_ID
//
// 毎日実行し、「今日が月末の1日前か」をスクリプト内で判定する。

const STATE_ID = "main";
const APP_URL = "https://feedstock.vercel.app";
const RECENT_DAYS = 5;   // 直近この日数以内に実行済みならリマインド不要

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const jstToday = () => jstNow().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// 今日が「月末の1日前」か判定
function isDayBeforeMonthEnd(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const tomorrow = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  const dayAfter = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 2);
  // 明後日が「1日」なら、今日は月末の1日前
  return dayAfter.getDate() === 1;
}

async function main() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, LINE_TOKEN, LINE_USER_ID } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !LINE_TOKEN || !LINE_USER_ID) {
    console.error("環境変数が不足しています。"); process.exit(1);
  }

  const now = jstNow();
  if (!isDayBeforeMonthEnd(now)) {
    console.log("今日は月末の1日前ではないので何もしません。"); return;
  }

  const today = jstToday();

  // state取得
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.${STATE_ID}&select=data`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) { console.error("Supabase取得失敗:", res.status); process.exit(1); }
  const rows = await res.json();
  if (!rows.length) { console.error("app_stateが見つかりません。"); process.exit(1); }
  const state = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;

  // 最新の棚卸し日
  let latestCount = "";
  for (const it of (state.items || [])) {
    for (const fid in (it.counts || {})) {
      for (const c of it.counts[fid]) { if (c.date > latestCount) latestCount = c.date; }
    }
  }
  // 最新のExcel取込日（feedDaily.to）
  let latestFeed = "";
  for (const it of (state.items || [])) {
    for (const fid in (it.feedDaily || {})) {
      const to = it.feedDaily[fid]?.to || "";
      if (to > latestFeed) latestFeed = to;
    }
  }

  const countRecent = latestCount && daysBetween(latestCount, today) <= RECENT_DAYS;
  const feedRecent = latestFeed && daysBetween(latestFeed, today) <= RECENT_DAYS;

  const msgs = [];
  if (!countRecent) {
    msgs.push(`📋 月末の棚卸しをお願いします。\n各餌の在庫を数えて、LINE（グループ）かアプリで記録してください。${latestCount ? `\n（前回の棚卸し: ${latestCount}）` : ""}`);
  }
  if (!feedRecent) {
    msgs.push(`📊 使用量Excelの取り込みをお願いします。\n日報の最新データをアプリに取り込んで、消費量を更新してください。${latestFeed ? `\n（前回の取込: ${latestFeed}まで）` : ""}`);
  }

  if (!msgs.length) {
    console.log("棚卸し・Excelとも直近5日以内に実行済み。リマインド不要。"); return;
  }

  const header = `🗓 まきば在庫 月末メンテナンス（${today}）\n`;
  const body = msgs.join("\n\n");
  const footer = `\n\n${APP_URL}`;
  const text = header + "\n" + body + footer;

  const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: "text", text }] }),
  });
  if (!lineRes.ok) { console.error("LINE送信失敗:", lineRes.status, await lineRes.text()); process.exit(1); }
  console.log("リマインド送信:\n" + text);
}

main().catch(e => { console.error(e); process.exit(1); });
