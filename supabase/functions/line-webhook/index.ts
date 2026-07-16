// Supabase Edge Function: line-webhook（第2弾フル機能）
// LINEグループ/個人で棚卸しを送ると記録する。
//   - 農場判定: メッセージ内農場名 → セッション → 送信者登録 → 聞き返し
//   - まとめ送信対応（複数餌を一度に）
//   - ズレ確認（予想の半分以下/2倍以上）。excludeFromPlanの餌は確認なし
//   - 「本場の棚卸し」等でセッション（農場モード）を設定
//   - 「はい」で保留中の確認を確定
//
// Supabase Secrets:
//   LINE_TOKEN, LINE_CHANNEL_SECRET, CLAUDE_API_KEY, SB_URL, SB_SERVICE_KEY, ALLOW_GROUP_ID(任意)
//
// デプロイ:
//   supabase functions deploy line-webhook --project-ref <PROJECT_REF>
//   （または .github/workflows/deploy-line-webhook.yml を手動実行）
//
// 2026-07 修正:
//   - Claudeの max_tokens を 4096 に引き上げ（長い棚卸しでJSONが途中で切れて解析失敗するのを防止）
//   - 返信(reply)が失効/失敗しても push で必ず届くようにフォールバック（無言をやめる）
//   - 解析失敗・想定外も必ず一言返す
//   - 棚卸しの重複判定を「同じ月」→「同じ日付」に統一（別日の記録を上書きせず残す）
//   - DMでも棚卸し可能に（入荷予定/問い合わせに該当しない＝日付なしの数量報告は棚卸しとして処理）

import { createHmac } from "node:crypto";

const STATE_ID = "main";
const SESSION_TTL_MIN = 120;          // 農場モードの有効時間（分）
const DISCREPANCY_LOW = 0.5;          // 予想の半分以下で確認
const DISCREPANCY_HIGH = 2.0;         // 予想の2倍以上で確認
const CLAUDE_MAX_TOKENS = 4096;       // 長文の棚卸しでも切れないように十分大きく

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const jstToday = () => jstNow().toISOString().slice(0, 10);
const ym = (d) => d.slice(0, 7);
const fmt = (n) => (n == null || isNaN(n)) ? "—" : Math.round(n).toLocaleString("ja-JP");
const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
// 予想在庫との差異を1行で表す
const diffLine = (kg, pred) => {
  if (pred == null) return "";
  const d = Math.round(kg - pred); const sign = d >= 0 ? "+" : "";
  const pct = pred > 0 ? `・${sign}${Math.round(d / pred * 100)}%` : "";
  return `\n  └ 予想${fmt(pred)}kg／実測${fmt(kg)}kg／差${sign}${fmt(d)}kg${pct}`;
};

function countToKg(item, q) {
  if (!q) return 0;
  if (q.__kg != null) return Number(q.__kg) || 0;
  let kg = 0; for (const u of (item.units || [])) { const n = q?.[u.id]; if (n) kg += n * u.kg; } return kg;
}
function farmStats(item, fid) {
  const counts = [...(item.counts?.[fid] || [])].sort((a, b) => a.date.localeCompare(b.date));
  const last = counts[counts.length - 1] || null, prev = counts[counts.length - 2] || null;
  const lastKg = last ? countToKg(item, last.qtys) : null;
  const fd = item.feedDaily?.[fid]; let baseDaily = null;
  if (fd && fd.dailyKg > 0) baseDaily = fd.dailyKg;
  else if (last && prev) { const days = Math.max(1, daysBetween(prev.date, last.date)); const diff = countToKg(item, prev.qtys) - lastKg; baseDaily = diff > 0 ? diff / days : 0; }
  const extra = (item.extraDaily?.[fid]) || 0;
  const dailyKg = baseDaily != null ? baseDaily + extra : (extra > 0 ? extra : null);
  return { lastKg, dailyKg, lastDate: last?.date || null };
}
function orderForFarm(o) { return o.forFarm || "shared"; }

// 表記ゆれ(別名)を学習する。安全のため、他の餌と衝突する表記は学習しない。
// 学習できたら追加した別名文字列を、しなければ null を返す。
function learnAlias(item, raw, allItems) {
  if (!item || !raw) return null;
  const r = String(raw).trim();
  if (r.length < 2) return null;                                          // 短すぎる表記は危険
  if (r === item.name) return null;                                       // 正式名そのもの
  if ((item.lineAliases || []).some(a => a === r)) return null;           // 既に登録済み
  for (const it of (allItems || [])) {
    if (it.name === r) return null;                                       // 他の餌の正式名と同じ
    if (it.id !== item.id && (it.lineAliases || []).includes(r)) return null; // 他の餌の別名と衝突
  }
  item.lineAliases = item.lineAliases || [];
  item.lineAliases.push(r);
  return r;
}

function predictKg(item, fid, date) {
  // 直前の棚卸し（日付が前のもの）を基準に予測。※同月でも別日の記録は基準に使える
  const counts = [...(item.counts?.[fid] || [])].sort((a, b) => a.date.localeCompare(b.date)).filter(c => c.date < date);
  if (!counts.length) return null;
  const last = counts[counts.length - 1];
  const fs = farmStats(item, fid); const dailyKg = fs.dailyKg || 0;
  const days = daysBetween(last.date, date);
  let arrival = 0;
  for (const o of (item.orders || [])) {
    if (o.etaDate > last.date && o.etaDate <= date) {
      let share = 1;
      if ((item.farms || []).length > 1) { let total = 0, mine = 0; for (const ff of item.farms) { const u = farmStats(item, ff).dailyKg ? farmStats(item, ff).dailyKg * 30 : 0; total += u; if (ff === fid) mine = u; } share = total > 0 ? mine / total : 1 / item.farms.length; }
      arrival += o.kg * share;
    }
  }
  return Math.max(0, countToKg(item, last.qtys) - dailyKg * days + arrival);
}

async function verifySignature(body, signature, secret) {
  const h = createHmac("sha256", secret); h.update(body); return h.digest("base64") === signature;
}

// 返信（reply）。成否を返す。失敗はログに残す。
async function replyLine(token, replyToken, text) {
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
    });
    if (r.ok) return true;
    console.error("LINE reply失敗:", r.status, await r.text());
  } catch (e) { console.error("LINE reply例外:", e?.message || e); }
  return false;
}
// push（宛先ID指定）。replyが失効した場合のフォールバック用。
async function pushLine(token, to, text) {
  if (!to) return false;
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
    if (r.ok) return true;
    console.error("LINE push失敗:", r.status, await r.text());
  } catch (e) { console.error("LINE push例外:", e?.message || e); }
  return false;
}
// まず reply、ダメなら push。どちらかで必ず届ける（無言をなくす）。
async function say(token, replyToken, srcId, text) {
  const ok = await replyLine(token, replyToken, text);
  if (!ok) await pushLine(token, srcId, text);
}

async function sbGet(url, key, path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  return r.ok ? await r.json() : null;
}
async function sbUpsert(url, key, table, row) {
  return fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
}

// Claudeの返答テキストからJSONを取り出す。失敗時は分かりやすい例外を投げる。
function extractJson(data) {
  const txt = (data.content || []).map(c => c.type === "text" ? c.text : "").join("").trim().replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(txt);
  } catch (e) {
    console.error("Claude応答のJSON解析に失敗:", txt.slice(0, 500));
    throw new Error("解析結果を読み取れませんでした（メッセージが長すぎるか書式が不規則な可能性）");
  }
}

async function parseWithClaude(apiKey, text, farms, items) {
  // 別名＋単位リストを含む餌情報を作る
  const itemLines = items.map(i => {
    const al = (i.lineAliases || []).filter(Boolean);
    const us = (i.units || []).map(u => `${u.label}=${u.kg}kg`).join("、") || "kg直接";
    const aliasStr = al.length ? `／別名: ${al.join("、")}` : "";
    return `${i.name}（単位: ${us}${aliasStr}）`;
  }).join("\n");
  const sys = `あなたは牧場の棚卸しLINEを解析するアシスタント。メッセージを解析しJSONのみで返す。
農場候補: ${farms.map(f => `${f.name}(${f.id})`).join(", ")}
餌リスト（単位と別名）:
${itemLines}

返すJSON:
{
 "intent": "stocktake" | "set_farm" | "confirm" | "other",
 "farm_id": "a"|"b"|null,
 "items": [ {"item":"正式な餌名","raw":"メッセージに実際に書かれていた餌名（正規化前の元の表記）","units":[{"unit":"単位名","n":数値}],"uncertain":true|false} ],
 "confirm_yes": true|false
}
判定ルール:
- 餌名と数量を含む → intent="stocktake"。各餌の数量を「単位ごと」に分解してunitsに入れる。
  例:「重曹 137個 パレット16」→ {"item":"重曹","units":[{"unit":"個","n":137},{"unit":"パレット","n":16}]}
  例:「スーダン 1コンテナと39個」→ {"item":"スーダン","units":[{"unit":"コンテナ","n":1},{"unit":"個","n":39}]}
  例:「アルファ 30」→ 単位の指定がなければ既定で「個」とみなす → {"item":"アルファ","units":[{"unit":"個","n":30}]}
  例:「綿実 500」→ その餌に「個」単位がなければkg直接 → {"item":"綿実","units":[{"unit":"kg","n":500}]}
- 「NコはMパレット」「N個はMパレット」の書き方は「1パレット=N個 のものが Mパレット分」の意味。個数に換算して N×M 個 とする。同じ餌で複数行あればそれぞれ換算して合計する。
  例:「ビタミン: 50コは3パレット / 35コは2パレット / 30コは3パレット / 25コは2パレット」→ 50*3+35*2+30*3+25*2=360 → {"item":"ビタミン","units":[{"unit":"個","n":360}]}
- 「~31コ」「約31個」などの概数は数値だけ拾って 31 とする。
- 「1コンテナ116個」「1コンテナと116個」は {"unit":"コンテナ","n":1} と {"unit":"個","n":116} の2つに分ける。
- 単位名は必ずその餌が持つ単位ラベルか「kg」を使う。
- 餌名は正式名に正規化（別名・誤字も。例「いてそだ」「SODA」→「重曹」、「サイレージ」→「ベトナムｃｓ」、「シボウサン」「シボゥサソ」→「脂肪酸カルシウム」、「ミズかバイダ」「ミズかバィダ」→「ミズカバインダー」、「お茶から」「お茶おから」→「おちゃおから」、「ネオナ」「ネオナ-」→「ネオナーリンレッド」）。
- 餌名が餌リストのどれか確信できない、数量や単位の解釈に自信がない場合は、その項目に "uncertain": true を付ける（勝手に確定させず後で確認する）。明確なものは付けない（省略でよい）。
- "raw" には、メッセージに書かれていた餌名の表記を「正規化する前のそのままの文字列」で入れる（例: 実際に「ミズかバイダ」と書かれていたら item="ミズカバインダー"、raw="ミズかバイダ"）。表記ゆれの学習に使う。
- 「塩」「しお」だけで搾乳塩かDRY塩か不明 → item名「塩(要確認)」。
- 「本場の棚卸し」等の農場宣言だけ → intent="set_farm"、farm_id。
- 「はい」「OK」等の肯定 → intent="confirm"、confirm_yes=true。
- 雑談 → intent="other"。
JSONのみ返す。`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: CLAUDE_MAX_TOKENS, system: sys, messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) throw new Error("Claude " + res.status + " " + await res.text());
  return extractJson(await res.json());
}

// 入荷予定（1対1）の解析。日付・餌・農場・数量(省略可)を抽出。
async function parseOrderWithClaude(apiKey, text, farms, items, todayStr) {
  const itemLines = items.map(i => {
    const al = (i.lineAliases || []).filter(Boolean);
    const us = (i.units || []).map(u => `${u.label}=${u.kg}kg`).join("、") || "kg直接";
    const preset = (i.orderPresets || [])[0];
    const presetStr = preset ? `／既定入荷=${preset.label}(${preset.kg}kg)` : "";
    const aliasStr = al.length ? `／別名: ${al.join("、")}` : "";
    return `${i.name}（単位: ${us}${presetStr}${aliasStr}）`;
  }).join("\n");
  const sys = `あなたは牧場の「入荷予定」LINEを解析するアシスタント。メッセージを解析しJSONのみで返す。
今日は ${todayStr}。
農場候補: ${farms.map(f => `${f.name}(${f.id})`).join(", ")}
餌リスト:
${itemLines}

メッセージには「日付・餌・農場」の組が複数入ることがある。餌名が一度だけ書かれ、その後は日付＋農場だけ並ぶこともある（その場合は同じ餌が続く）。
返すJSON:
{
 "intent": "order" | "query" | "other",
 "orders": [ {"item":"正式な餌名","farm_id":"a"|"b"|null,"date":"YYYY-MM-DD","received":true|false,"units":[{"unit":"単位名","n":数値}]|null} ],
 "query_items": [ "正式な餌名" ]
}
ルール:
- 入荷予定の登録（日付＋餌＋農場）→ intent="order"、ordersに全件。received=false。
- 【入荷済み】「入荷済み」「入荷した」「届いた」「入れた」「入荷」など“もう届いた納品”を表す語がある → intent="order"、received=true。日付が書いてなければ date は今日(${todayStr})。例「サイレージ 本場11 入荷済み」→ order 1件、item=ベトナムｃｓ, farm_id=a, received=true, date=今日, units=[{"unit":"個","n":11}]。
- 在庫の問い合わせ（「サイレージの予定」「重曹どれくらいある?」「ベトナムcs 残り」「在庫」「あと何日」等、数量報告でなく状況を尋ねている）→ intent="query"、query_itemsに対象の餌名（複数可）。
- 日付は今日(${todayStr})基準で「一番近い未来」に解釈。「6/20」→次に来る6月20日。年跨ぎは最も近い未来。
- 【最重要】「1,200kg/日」「800kg/日」「330kg/日」のように「/日」「kg/日」「／日」が付いた数量は“1日あたりの使用量”であって入荷（納品）量では絶対にない。入荷量として使ってはいけない。その行の入荷量は書かれていないものとして units=null（既定の発注パターンを使う）にし、日付だけ（8/4、8/25 等）を入荷日として order にする。
  例「綿実 本場 1,200kg/日 8/4、8/25」→ order 2件: {"item":"綿実","farm_id":"a","date":"…-08-04","units":null},{"item":"綿実","farm_id":"a","date":"…-08-25","units":null}（1200は使わない）。
  例「ソイパス 赤坂 450kg/日 8/20」→ order 1件 {"item":"ソイパス","farm_id":"b","date":"…-08-20","units":null}。
- 「納品なし」「未定」「納期未定」など入荷日が無い/納品しないものは order に含めない（skipする）。
- 上記の /日 が付かない、はっきりした入荷量（例「本場 1コンテナ」「500kg」）だけを units に入れる。単位の指定がない数字は、その餌に「個」単位があれば「個」、無ければ「kg」とみなす。数量そのものが無ければ units=null（既定の発注パターンを使う）。
- 餌名は正式名に正規化（別名・誤字も。「サイレージ」→「ベトナムｃｓ」等）。
- 農場が共通在庫の餌で農場指定がなければ farm_id=null でよい。
- 「6/16 サイレージ 本場 6/20 サイレージ 赤坂」→ order 2件。
- 「サイレージの予定」「サイレージ どう?」→ query、query_items=["ベトナムｃｓ"]。
- 【重要】日付も「入荷」系の語も無く、餌名＋数量だけの報告（棚卸しの可能性が高い。例「本場 チモシー 26個」「スーダン 24コ」「本場の棚卸し」「はい」）は入荷予定ではないので intent="other" にする（別処理で棚卸しとして扱う）。※「入荷」系の語があれば上の【入荷済み】を優先しorderにする。
- どちらでもない雑談 → intent="other"。
JSONのみ返す。`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: CLAUDE_MAX_TOKENS, system: sys, messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) throw new Error("Claude " + res.status + " " + await res.text());
  return extractJson(await res.json());
}

Deno.serve(async (req) => {
  const TOKEN = Deno.env.get("LINE_TOKEN");
  const SECRET = Deno.env.get("LINE_CHANNEL_SECRET");
  const CLAUDE = Deno.env.get("CLAUDE_API_KEY");
  const SB_URL = Deno.env.get("SB_URL");
  const SB_KEY = Deno.env.get("SB_SERVICE_KEY");
  const ALLOW_GROUP = Deno.env.get("ALLOW_GROUP_ID") || "";

  const raw = await req.text();
  const sig = req.headers.get("x-line-signature") || "";
  if (SECRET && !(await verifySignature(raw, sig, SECRET))) return new Response("bad sig", { status: 401 });

  let payload; try { payload = JSON.parse(raw); } catch { return new Response("ok"); }

  for (const ev of (payload.events || [])) {
    // ── 送信取消（unsend）への対応 ──
    if (ev.type === "unsend") {
      const mid = ev.unsend?.messageId;
      if (mid) {
        const maps = await sbGet(SB_URL, SB_KEY, `line_order_map?message_id=eq.${encodeURIComponent(mid)}&select=*`);
        const map = maps && maps[0];
        if (map && Array.isArray(map.orders) && map.orders.length) {
          const rows = await sbGet(SB_URL, SB_KEY, `app_state?id=eq.${STATE_ID}&select=data`);
          if (rows && rows.length) {
            const state = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
            for (const o of map.orders) {
              const item = (state.items || []).find(i => i.id === o.item_id);
              if (item && item.orders) item.orders = item.orders.filter(x => x.id !== o.order_id);
            }
            await fetch(`${SB_URL}/rest/v1/app_state?id=eq.${STATE_ID}`, {
              method: "PATCH", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
              body: JSON.stringify({ data: state, updated_at: new Date().toISOString() }),
            });
            // マップも削除
            await fetch(`${SB_URL}/rest/v1/line_order_map?message_id=eq.${encodeURIComponent(mid)}`, {
              method: "DELETE", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
            });
            // 取り消し通知（送信元へpush。1対1なのでpush可）
            const sid = map.source_id;
            if (sid) await pushLine(TOKEN, sid, `🗑️ 送信取消に伴い、入荷予定（${map.orders.length}件）を取り消しました。`);
          }
        }
      }
      continue;
    }

    if (ev.type !== "message" || ev.message?.type !== "text") continue;
    const srcId = ev.source?.groupId || ev.source?.roomId || ev.source?.userId || "";
    const userId = ev.source?.userId || "";
    const isGroup = !!(ev.source?.groupId || ev.source?.roomId); // グループ/ルーム = 棚卸し、1対1 = 入荷予定
    if (ALLOW_GROUP && srcId !== ALLOW_GROUP && isGroup) continue;
    const text = ev.message.text.trim();
    const replyToken = ev.replyToken;
    const messageId = ev.message.id;

    try {
      const rows = await sbGet(SB_URL, SB_KEY, `app_state?id=eq.${STATE_ID}&select=data`);
      if (!rows || !rows.length) { await say(TOKEN, replyToken, srcId, "⚠️ 在庫データが見つかりません。"); continue; }
      const state = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
      const farms = state.farms || [];
      const itemNames = (state.items || []).map(i => i.name);
      const findFarm = (id) => farms.find(f => f.id === id);
      const findItem = (nm) => (state.items || []).find(i => i.name === nm)
        || (state.items || []).find(i => (i.lineAliases || []).includes(nm));

      const sessRows = await sbGet(SB_URL, SB_KEY, `line_session?source_id=eq.${encodeURIComponent(srcId)}&select=*`);
      let session = (sessRows && sessRows[0]) || null;
      const memRows = userId ? await sbGet(SB_URL, SB_KEY, `line_member?user_id=eq.${encodeURIComponent(userId)}&select=*`) : null;
      const member = (memRows && memRows[0]) || null;

      let sessionFarm = null;
      if (session?.farm_id && session?.farm_set_at) {
        const ageMin = (Date.now() - new Date(session.farm_set_at).getTime()) / 60000;
        if (ageMin <= SESSION_TTL_MIN) sessionFarm = session.farm_id;
      }

      // ── 1対1（グループ以外）= 入荷予定の転記 / 在庫問い合わせ ──
      if (!isGroup) {
        const today = jstToday();
        const po = await parseOrderWithClaude(CLAUDE, text, farms, state.items || [], today);
        // DMでも棚卸しできるように: 入荷予定 or 在庫問い合わせ ならここで処理して終了。
        // それ以外(other=日付なしの数量報告など)は「棚卸しかも」→ 下の棚卸し処理へフォールスルー。

        // ── 在庫問い合わせ ──
        if (po && po.intent === "query" && Array.isArray(po.query_items) && po.query_items.length) {
          const dow = ["日","月","火","水","木","金","土"];
          // 農場ごとの現在庫・残り日数を計算
          const calcFarm = (item, fid) => {
            const fs = farmStats(item, fid);
            if (fs.lastKg == null || !fs.dailyKg || fs.dailyKg <= 0) return null;
            const days = fs.lastDate ? daysBetween(fs.lastDate, today) : 0;
            // 棚卸し日〜今日に到来した入荷を加算
            let recv = 0;
            for (const o of (item.orders || [])) {
              if (!fs.lastDate || o.etaDate <= fs.lastDate || o.etaDate > today) continue;
              const ff = o.forFarm || "shared";
              if (ff === fid) recv += o.kg;
              else if (ff === "shared") {
                let tot = 0, mine = 0;
                for (const f of item.farms) { const u = (farmStats(item, f).dailyKg || 0) * 30; tot += u; if (f === fid) mine = u; }
                recv += o.kg * (tot > 0 ? mine / tot : 1 / item.farms.length);
              }
            }
            const stock = Math.max(0, fs.lastKg - fs.dailyKg * days + recv);
            const daysLeft = stock / fs.dailyKg;
            const endDate = new Date(Date.now() + 9 * 3600 * 1000 + daysLeft * 86400000);
            return { stock, daysLeft, endStr: `${endDate.getMonth() + 1}/${endDate.getDate()}` };
          };
          let out = [];
          for (const nm of po.query_items) {
            const item = findItem(nm);
            if (!item) { out.push(`「${nm}」が見つかりません。`); continue; }
            let blk = `📊 ${item.name} の在庫状況\n`;
            const sMode = item.stockMode === "shared" ? "shared" : "split";
            for (const fid of (item.farms || [])) {
              const fName = findFarm(fid)?.name || fid;
              const c = calcFarm(item, fid);
              blk += `\n▼ ${fName}\n`;
              if (!c) { blk += `現在庫: データ不足（棚卸し未登録）\n`; }
              else { blk += `現在庫: 約${fmt(c.stock)}kg（残り${Math.floor(c.daysLeft)}日 / ${c.endStr}頃まで）\n`; }
              // 入荷予定（この農場 or 共通、今日以降、未入荷）
              const ups = (item.orders || []).filter(o => o.etaDate >= today && !o.received && ((o.forFarm || "shared") === fid || (o.forFarm || "shared") === "shared"));
              if (ups.length) {
                ups.sort((a, b) => a.etaDate.localeCompare(b.etaDate));
                blk += `入荷予定: ` + ups.map(o => `${o.etaDate.slice(5).replace("-", "/")} ${fmt(o.kg)}kg`).join("、") + `\n`;
              } else { blk += `入荷予定: なし\n`; }
            }
            out.push(blk.trim());
          }
          await say(TOKEN, replyToken, srcId, out.join("\n\n"));
          continue;
        }

        // ── 入荷予定の登録（該当すれば処理して終了。該当しなければ下の棚卸し処理へフォールスルー）──
        if (po && po.intent === "order" && Array.isArray(po.orders) && po.orders.length) {
        const created = [], errs = [], mapOrders = [];
        let nextOrderId = state.nextOrderId || Date.now();
        const dow = ["日","月","火","水","木","金","土"];

        for (const od of po.orders) {
          const item = findItem(od.item);
          if (!item) { errs.push(`「${od.item}」が見つかりません`); continue; }
          let odate = od.date;
          if ((!odate || !/^\d{4}-\d{2}-\d{2}$/.test(odate)) && od.received) odate = today; // 入荷済みで日付なし → 今日
          if (!odate || !/^\d{4}-\d{2}-\d{2}$/.test(odate)) { errs.push(`${item.name}の日付を読み取れません`); continue; }
          // 農場決定（共通在庫は shared、それ以外で指定なければエラー）
          const sMode = item.stockMode === "shared" ? "shared" : "split";
          let forFarm = od.farm_id || null;
          if (sMode === "shared") forFarm = "shared";
          else if (!forFarm) { errs.push(`${item.name}は農場（本場/赤坂）の指定が必要です`); continue; }
          // 数量決定: units指定 → kg換算合計、なければ既定プリセット
          let kg = 0, label = "";
          if (Array.isArray(od.units) && od.units.length) {
            for (const uu of od.units) {
              const n = Number(uu.n); if (!n) continue;
              const udef = (item.units || []).find(u => u.label === uu.unit || u.label.includes(uu.unit)) || (item.units || []).find(u => uu.unit && uu.unit.includes(u.label));
              if (udef) { kg += n * udef.kg; label += `${n}${udef.label} `; }
              else { kg += n; label += `${n}kg `; }
            }
          } else {
            const preset = (item.orderPresets || [])[0];
            if (preset) { kg = preset.kg; label = preset.label; }
            else { errs.push(`${item.name}は数量の指定も既定の発注パターンもありません`); continue; }
          }
          if (kg <= 0) { errs.push(`${item.name}の数量が不正です`); continue; }

          const oid = nextOrderId++;
          const recv = !!od.received;
          item.orders = item.orders || [];
          item.orders.push({ id: oid, kg, etaDate: odate, forFarm, received: recv });
          mapOrders.push({ item_id: item.id, order_id: oid });
          const fName = forFarm === "shared" ? "共通" : (findFarm(forFarm)?.name || forFarm);
          const d = new Date(odate + "T00:00:00+09:00");
          created.push(`・${odate}(${dow[d.getDay()]}) ${item.name} ${fName} ${label.trim()}（${fmt(kg)}kg）${recv ? "【入荷済み】" : ""}`);
        }
        state.nextOrderId = nextOrderId;

        if (created.length) {
          await fetch(`${SB_URL}/rest/v1/app_state?id=eq.${STATE_ID}`, {
            method: "PATCH", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ data: state, updated_at: new Date().toISOString() }),
          });
          // メッセージID→発注の対応を記録（unsend取り消し用）
          if (messageId && mapOrders.length) {
            await sbUpsert(SB_URL, SB_KEY, "line_order_map", { message_id: messageId, source_id: srcId, orders: mapOrders, created_at: new Date().toISOString() });
          }
        }
        let msg = "";
        if (created.length) msg += `📦 入荷予定を登録しました（${created.length}件）\n` + created.join("\n");
        if (errs.length) msg += (msg ? "\n\n" : "") + `❌ ${errs.join(" / ")}`;
        if (!msg) msg = "入荷予定を読み取れませんでした。「6/16 サイレージ 本場」のように送ってください。";
        msg += `\n\n※修正は送信取消で取り消して送り直し、または、アプリで編集できます。`;
        await say(TOKEN, replyToken, srcId, msg.trim());
        continue;
        } // end 入荷予定の登録
        // ここに来た＝DMだが入荷予定でも問い合わせでもない → 下の棚卸し処理へ
      }

      // ── 棚卸し処理（グループは常に／DMは入荷予定・問い合わせ以外のとき） ──
      const p = await parseWithClaude(CLAUDE, text, farms, state.items || []);
      if (p.intent === "other") continue;

      // 確認の「はい」
      if (p.intent === "confirm" && p.confirm_yes && session?.pending) {
        const pend = session.pending;
        if (Array.isArray(pend) && pend.length) {
          const learned = [];
          for (const x of pend) {
            const item = (state.items || []).find(i => i.id === x.item_id); if (!item) continue;
            item.counts = item.counts || {}; item.counts[x.farm_id] = item.counts[x.farm_id] || [];
            const date = jstToday();
            // 同じ日付だけ上書き（別日の記録は残す）
            const ex = item.counts[x.farm_id].find(c => c.date === date);
            // x.qtys は既存＋新規を合算済み。今日の記録があれば置換、なければ追加。
            if (ex) { ex.qtys = x.qtys; } else item.counts[x.farm_id].push({ date, qtys: x.qtys });
            // 「はい」で確定した＝表記が正しかった → 表記ゆれを学習
            const a = learnAlias(item, x.raw, state.items || []);
            if (a) learned.push(`${a}→${item.name}`);
          }
          await fetch(`${SB_URL}/rest/v1/app_state?id=eq.${STATE_ID}`, {
            method: "PATCH", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ data: state, updated_at: new Date().toISOString() }),
          });
          await sbUpsert(SB_URL, SB_KEY, "line_session", { source_id: srcId, pending: null, updated_at: new Date().toISOString() });
          let cmsg = "✅ 確認分を記録しました：\n" + pend.map(x => `・${x.farmName} ${x.name}: ${x.unitLabel}` + diffLine(x.kg, x.predKg)).join("\n");
          if (learned.length) cmsg += `\n\n📝 表記ゆれを記憶しました（次回から自動認識）\n` + learned.map(l => `・${l}`).join("\n");
          await say(TOKEN, replyToken, srcId, cmsg);
        } else {
          await say(TOKEN, replyToken, srcId, "確認待ちの項目がありませんでした。");
        }
        continue;
      }

      // 農場モード設定
      if (p.intent === "set_farm" && p.farm_id) {
        const f = findFarm(p.farm_id);
        await sbUpsert(SB_URL, SB_KEY, "line_session", { source_id: srcId, farm_id: p.farm_id, farm_set_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        await say(TOKEN, replyToken, srcId, `📋 ${f?.name || p.farm_id}の棚卸しモードにしました。餌名と個数を送ってください（例：チモシー 26）。`);
        continue;
      }

      // 棚卸し報告
      if (p.intent === "stocktake" && Array.isArray(p.items) && p.items.length) {
        let farmId = p.farm_id || sessionFarm || member?.farm_id || null;
        if (!farmId) {
          await say(TOKEN, replyToken, srcId, `❓ どちらの農場ですか？\n「本場」または「赤坂」を先に送るか、「本場 チモシー 26」のように農場名を付けて送ってください。`);
          continue;
        }
        if (p.farm_id) await sbUpsert(SB_URL, SB_KEY, "line_session", { source_id: srcId, farm_id: p.farm_id, farm_set_at: new Date().toISOString(), updated_at: new Date().toISOString() });

        const farm = findFarm(farmId);
        const date = jstToday();
        const recorded = [], pending = [], errors = [], learned = [];

        // ヘルパ: 餌の単位ラベル→unit定義
        const findUnit = (item, unitName) => {
          if (!unitName || unitName === "kg") return null; // kg直接
          return (item.units || []).find(u => u.label === unitName || u.label.includes(unitName))
            || (item.units || []).find(u => unitName.includes(u.label));
        };
        // qtysからkg合計
        const qtysToKg = (item, qtys) => {
          let kg = 0;
          for (const k in qtys) {
            if (k === "__kg") { kg += Number(qtys[k]) || 0; continue; }
            const u = (item.units || []).find(uu => uu.id === k);
            if (u) kg += (Number(qtys[k]) || 0) * u.kg;
          }
          return kg;
        };
        // qtys表示ラベル
        const qtysLabel = (item, qtys) => {
          const parts = [];
          for (const k in qtys) {
            if (k === "__kg") { parts.push(`${fmt(qtys[k])}kg`); continue; }
            const u = (item.units || []).find(uu => uu.id === k);
            if (u) parts.push(`${fmt(qtys[k])}${u.label}`);
          }
          return parts.join(" + ");
        };

        for (const row of p.items) {
          // 「塩(要確認)」の農場依存解決
          if (row.item && (row.item.includes("塩(要確認)") || row.item.includes("塩（要確認）"))) {
            if (farmId === "b") { row.item = "搾乳塩"; }
            else { errors.push("「塩」は本場ではDRY塩か搾乳塩か不明です。「DRY塩 26」「搾乳塩 24」のように送ってください"); continue; }
          }
          const item = findItem(row.item);
          if (!item) { errors.push(`「${row.item}」が見つかりません`); continue; }

          // units配列を qtys に変換。同一単位の重複を検出。
          const unitsArr = Array.isArray(row.units) ? row.units : (row.qty != null ? [{ unit: "個", n: row.qty }] : []);
          if (!unitsArr.length) { errors.push(`${item.name}の数量を読み取れません`); continue; }
          const qtys = {}; let dupUnit = false; const seen = {};
          let bad = false;
          for (const uu of unitsArr) {
            const n = Number(uu.n);
            if (!n || n < 0) { bad = true; break; }
            const udef = findUnit(item, uu.unit);
            const key = udef ? udef.id : "__kg";
            if (seen[key]) dupUnit = true;             // 同一送信内で同じ単位が重複
            seen[key] = true;
            qtys[key] = (qtys[key] || 0) + n;          // 同一単位なら足す（重複時は確認フラグも立てる）
          }
          if (bad) { errors.push(`${item.name}の数量が不正`); continue; }

          const kg = qtysToKg(item, qtys);
          const label = qtysLabel(item, qtys);

          // 既に今日この農場で記録があるか（別送信での追加 → 足す＋確認）※同じ日付のみ
          item.counts = item.counts || {}; item.counts[farmId] = item.counts[farmId] || [];
          const existing = item.counts[farmId].find(c => c.date === date);
          const existingKg = existing ? qtysToKg(item, existing.qtys) : 0;

          // 確認が必要なケース:
          //  (0) 解析があいまい（uncertain）
          //  (1) 同一送信内で同じ単位が重複
          //  (2) 今日すでに記録あり（別送信の追加）
          //  (3) ズレ大（excludeFromPlan以外）
          let needConfirm = false, reason = "", predKg = null;
          const predShow = item.excludeFromPlan ? null : predictKg(item, farmId, date); // 予想在庫（差異表示用）
          if (row.uncertain) { needConfirm = true; reason = "読み取りに自信がありません（餌名/数量を確認）"; }
          if (dupUnit) { needConfirm = true; reason = "同じ単位が複数回ありました"; }
          if (existing) { needConfirm = true; reason = `今日すでに記録あり（${qtysLabel(item, existing.qtys)}＝${fmt(existingKg)}kg）。追加で合算します`; }
          if (predShow != null && predShow > 0) {
            const checkKg = existing ? existingKg + kg : kg;
            if (checkKg <= predShow * DISCREPANCY_LOW || checkKg >= predShow * DISCREPANCY_HIGH) {
              needConfirm = true; predKg = predShow; if (!reason) reason = "予想と差が大きい";
            }
          }

          if (needConfirm) {
            // 既存があれば合算後のqtysを作る
            const mergedQtys = existing ? { ...existing.qtys } : {};
            for (const k in qtys) mergedQtys[k] = (mergedQtys[k] || 0) + qtys[k];
            pending.push({
              farm_id: farmId, item_id: item.id, qtys: mergedQtys, kg: qtysToKg(item, mergedQtys),
              name: item.name, farmName: farm?.name, unitLabel: qtysLabel(item, mergedQtys), predKg: predShow, reason,
              raw: row.raw || null,
            });
          } else {
            item.counts[farmId].push({ date, qtys });
            recorded.push({ name: item.name, unitLabel: label, kg, pred: predShow });
            // 表記ゆれを学習（明確に記録できたものだけ）
            const a = learnAlias(item, row.raw, state.items || []);
            if (a) learned.push(`${a}→${item.name}`);
          }
        }

        if (recorded.length) {
          await fetch(`${SB_URL}/rest/v1/app_state?id=eq.${STATE_ID}`, {
            method: "PATCH", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ data: state, updated_at: new Date().toISOString() }),
          });
        }
        if (pending.length) {
          await sbUpsert(SB_URL, SB_KEY, "line_session", { source_id: srcId, pending, updated_at: new Date().toISOString() });
        }

        let msg = `【${farm?.name}の棚卸し】\n`;
        if (recorded.length) { msg += `✅ 記録（${recorded.length}件）\n` + recorded.map(r => `・${r.name}: ${r.unitLabel}` + diffLine(r.kg, r.pred)).join("\n") + "\n"; }
        if (pending.length) {
          msg += `\n⚠️ 確認が必要な項目\n` + pending.map(x => {
            let line = `・${x.name}: ${x.unitLabel}`;
            if (x.reason) line += `\n  └ ${x.reason}`;
            line += diffLine(x.kg, x.predKg);
            return line;
          }).join("\n");
          msg += `\n\nこの内容で記録するなら「はい」と送ってください。`;
        }
        if (errors.length) { msg += `\n\n❌ ${errors.join(" / ")}`; }
        if (learned.length) { msg += `\n\n📝 表記ゆれを記憶しました（次回から自動認識）\n` + learned.map(l => `・${l}`).join("\n"); }
        await say(TOKEN, replyToken, srcId, msg.trim());
        continue;
      }

      // ここまで該当なし（棚卸しとして解釈できなかった等）→ 無言にしない
      await say(TOKEN, replyToken, srcId, "棚卸しとして読み取れませんでした。お手数ですが、1行に1つの餌と数量を書いて送り直してください（例：チモシー 26個 / スーダン 1コンテナ 24個）。");
    } catch (e) {
      console.error("処理エラー:", e?.message || e);
      await say(TOKEN, replyToken, srcId, "⚠️ うまく処理できませんでした。少し時間をおいて、1行に1つの餌・数量を明記して送り直してください。（例：チモシー 26個）\n" + (e?.message ? `詳細: ${e.message}` : ""));
    }
  }
  return new Response("ok");
});
