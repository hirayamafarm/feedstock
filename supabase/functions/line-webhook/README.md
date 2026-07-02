# line-webhook（Supabase Edge Function）

LINEのグループ/個人メッセージを受け取り、棚卸しの記録・入荷予定の登録・在庫問い合わせに答えるボット。

## 役割
- **グループ**メッセージ … 棚卸しとして解釈し、餌ごとに記録（農場判定・複数餌のまとめ送信・ズレ確認に対応）
- **1対1**メッセージ … 入荷予定の登録、または在庫の問い合わせ
- **送信取消(unsend)** … 直前に登録した入荷予定を取り消し

## 必要な Supabase Secrets
| 名前 | 用途 |
|---|---|
| `LINE_TOKEN` | LINE Messaging API チャネルアクセストークン |
| `LINE_CHANNEL_SECRET` | 署名検証用チャネルシークレット |
| `CLAUDE_API_KEY` | メッセージ解析に使うClaude APIキー |
| `SB_URL` | Supabase プロジェクトURL |
| `SB_SERVICE_KEY` | Supabase サービスロールキー |
| `ALLOW_GROUP_ID` | （任意）反応を許可するグループID |

## デプロイ
```bash
supabase functions deploy line-webhook --project-ref <PROJECT_REF>
```
または GitHub Actions の「Deploy line-webhook (Supabase)」を手動実行（`SUPABASE_ACCESS_TOKEN` と `SUPABASE_PROJECT_REF` のSecrets設定が必要）。

## 2026-07 の修正（無反応バグ対策）
- Claude解析の `max_tokens` を 4096 に引き上げ（長い棚卸しでJSONが途中で切れて解析に失敗するのを防止）。
- 返信(reply)が失効・失敗しても push で必ず届くようフォールバック（`say()`）。解析失敗や想定外でも必ず一言返す（無言をなくす）。
- 棚卸しの重複判定を「同じ月」→「同じ日付」に統一（別日の棚卸し記録を上書きせず残す。アプリ本体の挙動と一致）。

## 関連する Supabase テーブル
- `app_state`（id=main の data 列に在庫の全状態）
- `line_session`（source_idごとの農場モード・確認保留）
- `line_member`（user_idごとの担当農場）
- `line_order_map`（message_id→登録した発注、unsend取り消し用）
