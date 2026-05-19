# ReadyGo Interactive — 仕様書

## 1. システム概要

| 項目 | 内容 |
|---|---|
| システム名 | ReadyGo Interactive |
| サブタイトル | 生活自動化AI秘書 |
| 実行環境 | Google Apps Script (GAS) |
| 主な役割 | 毎日の生活情報（天気・予定・服装・ゴミ出し）をLINEで自動通知する |

---

## 2. ファイル構成

| ファイル名 | 種別 | 説明 |
|---|---|---|
| `ReadyGo_Interactive.gs` | GASスクリプト | メインロジック全体 |
| `data/ReadyGo.xlsx` | Excelファイル | スプレッドシートのデータ定義（ローカル参照用、`.gitignore`対象） |

---

## 3. 外部連携

### 3.1 LINE Messaging API

| 項目 | 内容 |
|---|---|
| プッシュ通知エンドポイント | `https://api.line.me/v2/bot/message/push` |
| リプライエンドポイント | `https://api.line.me/v2/bot/message/reply` |
| 認証方式 | Bearer Token（`LINE_CHANNEL_ACCESS_TOKEN`） |
| 送信先 | `LINE_USER_IDS`（スクリプトプロパティで指定、カンマ区切りで複数対応） |

### 3.2 気象庁API（天気予報）

| 項目 | 内容 |
|---|---|
| エンドポイント | `https://www.jma.go.jp/bosai/forecast/data/forecast/{地域コード}.json` |
| 認証 | 不要 |
| 取得データ | 天気コード・予想最高気温・予想最低気温・降水確率（6時間ごと最大値） |
| 地域コード | `JMA_AREA_CODE`（スクリプトプロパティで指定、デフォルト: `130000` 東京） |

気象庁APIはレート制限なし・登録不要で利用可能。ただし非公式APIのため、仕様が予告なく変更される可能性がある。

### 3.3 Open-Meteo API（気圧・風・湿度・紫外線）

| 項目 | 内容 |
|---|---|
| エンドポイント | `https://api.open-meteo.com/v1/forecast` |
| 認証 | 不要 |
| 取得データ | `pressure_msl`, `wind_speed_10m`, `relative_humidity_2m`, `uv_index`（hourly） |
| 用途 | 気圧変動アラート＋服装AIアドバイスのファクト入力 |
| 緯度経度 | コード内固定（東京: 35.6895, 139.6917） |

呼び出し頻度は朝・夜の通知時のみ（1日2回）。Google共有IPによる429リスクを最小化するため、失敗時は当該機能（気圧アラート・服装AIへの一部入力）を欠落させる**フォールバック設計**（他の通知処理には影響しない）。

### 3.4 Gemini API（服装AIアドバイス生成）

| 項目 | 内容 |
|---|---|
| エンドポイント | `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` |
| 認証 | APIキー（クエリパラメータ `?key=...`） |
| 使用モデル | `gemini-2.5-flash`（無料枠 1500req/日） |
| APIキー保管 | スクリプトプロパティ `GEMINI_API_KEY` |
| 用途 | 夜の通知の服装アドバイス文を、複数のファクト（気温/天気/降水確率/風/湿度/紫外線/季節/予定）を元に動的生成 |

呼び出しは**夜の通知時のみ**（1日1回）。失敗時はClothingシートの気温帯ベースのアドバイスにフォールバックする。

### 3.4 Google Calendar

| 項目 | 内容 |
|---|---|
| 使用API | `CalendarApp`（GAS組み込み） |
| 対象 | デフォルトカレンダー |
| 取得内容 | 翌日/当日の全イベント（終日除きで最早の予定・弁当キーワード判定） |

### 3.6 Google Spreadsheet

| 項目 | 内容 |
|---|---|
| 指定方法 | `SPREADSHEET_ID`（スクリプトプロパティで指定） |
| 使用シート | `Config` / `Waste` / `Clothing` / `Log` / `Inbox` |

---

## 4. スプレッドシート仕様

### 4.1 Configシート

| A列（キー） | B列（値） | 説明 |
|---|---|---|
| 準備時間 | 数値（分） | 起床から出発までの準備時間（デフォルト: 45分） |
| 移動時間 | 数値（分） | 自宅から目的地までの移動時間（デフォルト: 15分） |
| 雨追加時間 | 数値（分） | 降水確率50%超の場合に加算する時間（デフォルト: 10分） |
| 弁当追加時間 | 数値（分） | 弁当作成が必要な場合に加算する時間（デフォルト: 20分） |
| 傘閾値 | 数値（%） | 傘を持ち物リストに追加する降水確率の閾値（デフォルト: 30%） |
| 気圧変動閾値 | 数値（hPa） | 気圧変動アラートを出す1日の変動幅閾値（デフォルト: 6hPa） |

### 4.2 Wasteシート（ゴミ出し）

| A列（曜日キー） | B列（ゴミの種類） |
|---|---|
| 英語曜日名またはN曜日形式 | ゴミの種類（例: ビン・缶・資源 など） |

- 1行目はヘッダー行
- A列の書式:
  - 単純曜日: `Monday` / `Tuesday` / `Wednesday` / `Thursday` / `Friday` / `Saturday` / `Sunday`
  - 第N曜日形式: `1st,3rd Saturday`（第1・第3土曜のように複数指定可能）
- マッチングは `matchesWasteDay()` が行い、単純曜日と第N曜日の両方に対応

### 4.3 Clothingシート（服装アドバイス）

| A列 | B列 | C列 |
|---|---|---|
| 下限気温（℃） | 上限気温（℃） | 服装アドバイス（テキスト） |

- 1行目はヘッダー行
- 最低気温がA〜B列の範囲に収まる行のアドバイスを返す
- 一致なしの場合: 「気温に応じた服装でお出かけください」

### 4.4 Logシート（ログ）

| A列 | B列 | C列 |
|---|---|---|
| 記録日時 | 種別 | メッセージ本文（最大500文字） |

種別一覧:

| 種別 | 内容 |
|---|---|
| `night` | 夜の通知メッセージ |
| `morning` | 朝の通知メッセージ |
| `webhook` | LINE Webhook受信（ユーザーID・メッセージ内容） |
| `error` | 外部APIエラー（気象庁API失敗など） |

### 4.5 Inboxシート（外部GASからのメッセージ受信）

| A列（posted_at） | B列（source） | C列（body） | D列（processed） |
|---|---|---|---|
| 投入日時（Datetime） | ソース名（任意のラベル） | 通知に追加する本文 | 処理済フラグ（Boolean） |

- 1行目はヘッダー行
- 外部GASがこのシートに行を追加することで、ReadyGoの**夜の通知メッセージ末尾**にお知らせ欄として追加される
- D列が `FALSE`（または空欄）の行が対象。投入日時昇順に追加される
- 夜の通知送信が成功すると、対象行のD列が `TRUE` に更新される（再送防止）
- B列のソース名はデバッグ・識別用（メッセージ本文には表示されない）

---

## 5. スクリプトプロパティ

GASの「スクリプトプロパティ」に以下を設定する。

| プロパティ名 | 必須 | 説明 |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 必須 | LINE Botのチャネルアクセストークン |
| `LINE_USER_IDS` | 必須 | 通知先LINEユーザーID（複数の場合はカンマ区切り。例: `Uxxxx,Uyyyy`） |
| `SPREADSHEET_ID` | 必須 | GoogleスプレッドシートのID |
| `JMA_AREA_CODE` | 任意 | 気象庁の地域コード（デフォルト: `130000` 東京） |
| `GEMINI_API_KEY` | 任意 | Gemini APIキー（夜の通知の服装AIアドバイス用。未設定時はClothingシートのアドバイスにフォールバック） |

---

## 6. 関数仕様

### 6.1 設定・キャッシュ系

#### `getConfig()`
- スクリプトプロパティから設定値を読み込みオブジェクトで返す
- 1回の実行内でキャッシュされ、2回目以降はキャッシュを返す（`_cfg`）

#### `getSpreadsheet()`
- `SpreadsheetApp.openById()` の結果をキャッシュして返す（`_ss`）
- 各シートアクセス関数から共通で呼ばれる

#### `getSheetConfig()`
- スプレッドシートの `Config` シートから運用設定を読み込みオブジェクトで返す

#### `weatherCodeToText(code)`
- 気象庁の天気コード（100〜450系）を日本語テキスト＋絵文字に変換する
- 未定義コードの場合: `不明(code)` を返す

### 6.2 LINE通信系

#### `pushMessage(text)`
- `LINE_USER_IDS` の全ユーザーにループでテキストメッセージをプッシュ送信する
- 1件の送信失敗が他のユーザーへの送信に影響しないよう、try/catchで個別にエラーハンドリングする

#### `replyMessage(replyToken, text)`
- LINE Reply APIを呼び出し、指定のリプライトークンにテキストメッセージを返信する

#### `doPost(e)`
- LINEのWebhookエンドポイント（GASのWebアプリとして公開）
- テキストメッセージ受信時に送信者の内部ユーザーID（`U`始まり）をLogシートに記録し、リプライで返す
- ユーザーID登録の確認用途で使用
- レスポンス: `{ status: 'ok' }`（JSON）

### 6.3 天気取得系

#### `fetchWeatherForDate(dateStr)`
- 気象庁APIから指定日の天気情報を取得する共通関数
- 引数: `dateStr`（`yyyy-MM-dd` 形式）
- API失敗時は `null` を返し、Logシートにエラーを記録する（`muteHttpExceptions: true`）
- 戻り値: `{ date, maxTemp, minTemp, precipProb, weatherCode }` または `null`
- 気温パース: `timeSeries[2].areas[0].temps` 配列から、`T00:xx` のエントリを最低気温、`T09:xx` のエントリを最高気温として取得

#### `getTomorrowWeather()`
- `fetchWeatherForDate()` を翌日の日付で呼び出すラッパー

#### `fetchOpenMeteoData(dateStr)`
- Open-Meteo APIから指定日の気圧・風速・湿度・紫外線データをまとめて取得する
- 引数: `dateStr`（`yyyy-MM-dd` 形式）
- 戻り値: `{ pressureRange, windMax, humidityMean, uvMax }` または `null`（API失敗時）
  - `pressureRange`: 1日の海面気圧の最大-最小（hPa）
  - `windMax`: 最大風速（m/s）
  - `humidityMean`: 平均湿度（%）
  - `uvMax`: 最大紫外線指数
- 緯度経度はコード内で東京固定（35.6895, 139.6917）
- 失敗時はLogに `error` を記録するのみ。当該機能を欠落させるだけで他の通知処理には影響しない

#### `seasonOf(month)`
- 月（1〜12）から季節（`春`/`夏`/`秋`/`冬`）を判定して返す
- 3〜5月=春、6〜8月=夏、9〜11月=秋、12〜2月=冬

#### `generateClothingAdvice(facts)`
- Gemini APIにファクトを送信し、自然な日本語の服装アドバイス文を生成する
- 引数 `facts`: `{ dayLabel, season, minTemp, maxTemp, weatherText, precipProb, windMax, humidityMean, uvMax, eventTitles }`
- 戻り値: 生成された文字列、または `null`（APIキー未設定・API失敗時）
- 失敗時はLogに `error` を記録するのみ。呼び出し側でClothingシートにフォールバックする

### 6.4 カレンダー系

#### `getTomorrowFirstEvent()`
- デフォルトカレンダーから翌日の終日以外の最早イベントを取得する
- 終日イベントのみの場合はタイトルのみ返す
- 予定なしの場合: `null`
- 戻り値: `{ title, startTime, allDay }`

#### `getTomorrowAllEventTitles()`
- 翌日の全イベントタイトルを配列で返す（弁当キーワード判定用）

### 6.5 ゴミ出し系

#### `getNthWeekdayOfMonth(date)`
- 指定日が月内で何番目の同曜日かを返す（1〜5）
- 例: 4/13（日）→ 第2日曜 → `2`

#### `matchesWasteDay(key, date)`
- Wasteシートのキー文字列が対象日にマッチするか判定する
- 単純曜日（`Monday`）と第N曜日形式（`1st,3rd Saturday`）の両方に対応

#### `getWasteForDate(date)`
- 指定日のゴミ種類をWasteシートから取得する共通関数

#### `getTomorrowWaste()`
- `getWasteForDate()` を翌日の日付で呼び出すラッパー

### 6.6 服装系

#### `getClothingAdvice(minTemp, maxTemp)`
- Clothingシートから最低気温に対応する服装アドバイスを返す

### 6.7 ログ系

#### `writeLog(type, message)`
- Logシートに日時・種別・メッセージを1行追記する
- メッセージは500文字に切り詰める

### 6.8 Inbox系（外部GASからのメッセージ受信）

#### `getPendingInboxMessages()`
- Inboxシートから未処理（D列=FALSE）のメッセージを取得する
- 戻り値: `{ rowIndices: [行番号...], bodies: [本文...] }`（投入日時昇順）
- シートが存在しない場合や取得失敗時は空の結果を返し、Logに `error` を記録（夜の通知本体は継続）

#### `markInboxAsProcessed(rowIndices)`
- 指定行のD列（processed）を `TRUE` に更新する
- 夜の通知送信成功後にまとめて呼び出される

### 6.9 メッセージ組み立て系

#### `buildNightMessage(inboxBodies)`
- 夜の通知メッセージを組み立てて文字列で返す
- 引数 `inboxBodies`: Inboxシートからの本文配列。空または未指定の場合「お知らせ」セクションは表示しない
- 天気API失敗時は「取得できませんでした」と表示し、天気以外の情報は正常に送信する
- 含まれる情報:
  1. 翌日の日付（曜日付き）
  2. 天気・最高/最低気温・降水確率
  3. 服装アドバイス（**Gemini AIで動的生成**: 気温/天気/降水確率/風/湿度/紫外線/季節/予定タイトルを元に。失敗時はClothingシートにフォールバック）
  4. 起床時刻（カレンダーの最早予定から逆算）
  5. 最初の予定名・開始時刻
  6. 持ち物リマインド（傘・ゴミ出し）
  7. ⚠️ 気圧アラート（翌日の気圧変動幅が `気圧変動閾値` 以上の場合のみ表示）
  8. 📨 お知らせ（外部GASからのInboxメッセージ。0件なら非表示）

#### `buildMorningMessage()`
- 朝の通知メッセージを組み立てて文字列で返す
- 天気API失敗時は「取得できませんでした」と表示し、天気以外の情報は正常に送信する
- 含まれる情報:
  1. 今日の天気・最高/最低気温（最低と最高が同じ、または最低が未取得の場合は最高気温のみ表示）
  2. 服装アドバイス
  3. 持ち物リマインド（傘・ゴミ出し）
  4. ⚠️ 気圧アラート（今日の気圧変動幅が `気圧変動閾値` 以上の場合のみ表示）

### 6.10 実行エントリポイント

#### `sendNightNotification()`
- `getPendingInboxMessages()` で未処理メッセージを取得し、`buildNightMessage()` に渡して送信する
- 送信成功後、`markInboxAsProcessed()` で処理済マークを更新する（再送防止）
- マーク更新が失敗してもログに記録するのみ（通知自体は成功扱い）
- **トリガー設定: 毎日21:00**

#### `sendMorningNotification()`
- `buildMorningMessage()` を実行して全ユーザーにLINE送信し、ログを記録する
- **トリガー設定: 毎日6:30（または動的設定）**

### 6.10 トリガー管理系

#### `setupTriggers()`
- 既存トリガーを全削除し、夜の通知（21:00）と朝の通知（6:30）のトリガーを新規作成する
- **初回セットアップ時に手動で1回実行する**

#### `setDynamicMorningTrigger(wakeHour, wakeMinute)`
- 既存の朝トリガーを削除し、指定した時刻で新しい朝トリガーを作成する
- GASの時間トリガーには±15分の誤差がある点に注意

---

## 7. 起床時刻の計算ロジック

```
起床時刻 = 最初の予定の開始時刻
         − 準備時間
         − 移動時間
         − 雨追加時間（降水確率 > 50% の場合のみ）
         − 弁当追加時間（予定タイトルに「弁当」が含まれる場合のみ）
```

---

## 8. 夜の通知メッセージ フォーマット例

```
🌙 おやすみ前の明日チェック
━━━━━━━━━━━━━━
📅 4/14（月）

🌡 天気: 🌧 曇り時々雨
   最高 23℃ / 最低 13℃
   降水確率: 70%

👔 服装: 朝晩の気温差が大きく雨予報なので、薄手の撥水コートに、室内で脱ぎ着しやすいカーディガンを合わせるのがおすすめ。☂️傘も忘れずに。

⏰ 起床時刻: 07:25（☔雨のため+10分）
   📌 最初の予定: 朝会（09:00〜）

🎒 持ち物リマインド
   ☂ 傘
   🗑 ゴミ出し: ビン・缶・資源

⚠️ 気圧アラート
   明日は気圧変動が大きい予報です（▼6.8hPa）
   体調にご注意ください

━━━━━━━━━━━━━━
📨 お知らせ
[外部GASから投入された本文1]

[外部GASから投入された本文2]

おやすみなさい 💤
```

「📨 お知らせ」セクションはInboxシートに未処理メッセージがある場合のみ表示される。

天気API失敗時:
```
🌡 天気: 取得できませんでした
```

---

## 9. 朝の通知メッセージ フォーマット例

```
☀️ おはようございます！
━━━━━━━━━━━━━━
🌡 ⛅ 曇り時々晴れ 24℃/13℃
👔 ジャケットやセーターがおすすめです

☂ 傘を忘れずに！
🗑 ゴミ出し: ビン・缶・資源

⚠️ 気圧アラート
   今日は気圧変動が大きい予報です（▼6.8hPa）
   体調にご注意ください

今日も良い一日を！ 💪
```

---

## 10. セットアップ手順

1. Google Apps Scriptプロジェクトを作成し、`ReadyGo_Interactive.gs` のコードを貼り付ける
2. GoogleスプレッドシートにConfigシート・Wasteシート・Clothingシート・Logシート・Inboxシートを作成する
3. スクリプトプロパティに必要な値を設定する:
   - `LINE_CHANNEL_ACCESS_TOKEN` — LINE Botのチャネルアクセストークン
   - `LINE_USER_IDS` — 通知先ユーザーID（カンマ区切りで複数可）
   - `SPREADSHEET_ID` — スプレッドシートのID
   - `JMA_AREA_CODE` — 気象庁地域コード（東京以外の場合）
   - `GEMINI_API_KEY` — Gemini APIキー（服装AIアドバイス用、aistudio.google.comで無料発行）
4. GASをWebアプリとして公開し、LINEのWebhook URLに登録する
5. `setupTriggers()` を手動で1回実行してトリガーを設定する
6. 新しいユーザーを追加する場合は、BotにメッセージをLINE送信させて内部ユーザーID（`U`始まり）を取得し、`LINE_USER_IDS` に追加する
7. 外部GASから夜の通知に追記したい場合は、`SPREADSHEET_ID` のスプレッドシートを共有設定で書き込み許可とし、`Inbox` シートに行を追加する（詳細は § 12）

---

## 12. 外部GASからのメッセージ追加（Inbox連携）

別のGASプロジェクトが生成したメッセージを、ReadyGoの夜の通知メッセージ末尾に「📨 お知らせ」として追加できる。

### 12.1 仕組み

- 外部GASは、ReadyGoのスプレッドシート（`SPREADSHEET_ID`）の `Inbox` シートに行を追加する
- ReadyGoは毎日21:00の夜の通知時に、`Inbox` シートのD列（processed）が `FALSE` の行を全件取得し、メッセージ末尾に追加する
- 送信成功後、対象行のD列を `TRUE` に更新（再送防止）

### 12.2 Inboxシート列構成

| 列 | 名前 | 型 | 説明 |
|---|---|---|---|
| A | posted_at | Datetime | 投入日時 |
| B | source | Text | 外部GAS側の識別ラベル（例: `家計簿Bot`）。表示には使われない |
| C | body | Text | 通知に追加する本文。改行可 |
| D | processed | Boolean | 送信済みなら `TRUE`、未処理は `FALSE`（または空欄） |

### 12.3 外部GAS側 サンプルコード

```javascript
// スクリプトプロパティ READYGO_SPREADSHEET_ID に ReadyGo のスプレッドシートIDを設定しておく
function postToReadyGoInbox(source, body) {
  const id = PropertiesService.getScriptProperties().getProperty('READYGO_SPREADSHEET_ID');
  const sheet = SpreadsheetApp.openById(id).getSheetByName('Inbox');
  sheet.appendRow([new Date(), source, body, false]);
}

// 使用例
function example() {
  postToReadyGoInbox('家計簿Bot', '今月の食費が予算の80%を超えました。');
}
```

### 12.4 注意事項

- **スプレッドシートの共有設定**: ReadyGoのスプレッドシートに、外部GASを実行するGoogleアカウントの編集権限を付与する必要がある
- **配信タイミング**: 投入したメッセージは「次の21:00の夜の通知」で配信される。即時配信ではない
- **再送はされない**: 1度配信されると `processed=TRUE` になり、再度配信されることはない
- **複数件OK**: 同じ夜に複数行があれば、投入日時昇順で連結されて送信される
- **長さ制限**: LINEのテキストメッセージ上限は5000文字。Inbox本文も合算で5000文字以内に収めること
- **失敗時の挙動**: ReadyGo側でInboxシート読み取りに失敗しても、夜の通知本体は通常通り送信される（お知らせ欄のみ欠落する）

---

## 11. 今後の拡張ポイント（現状未実装）

- `doPost()` のWebhookで受信したメッセージに応じた処理（設定変更・手動通知など）
- 夜の通知内で `setDynamicMorningTrigger()` を呼び出す動的起床トリガー設定
- TODO/買い物リストとの連携
