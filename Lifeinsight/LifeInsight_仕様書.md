# ライフ・インサイト 仕様書

## 概要

体調（気分・体調・睡眠の質）の自己記録と気象データを自動で紐付け、体調と気象の相関を分析するためのデータ収集システム。

Googleフォームで日々の体調を入力すると、その時点の気象データ（気圧・気温・湿度など）を気象庁AMeDAS APIから自動取得し、スプレッドシートに記録する。

---

## システム構成

```
[Googleフォーム] → [スプレッドシート] ← [GAS (LifeInsight.gs)]
                                              ↓
                                        [気象庁 AMeDAS API]
                                        [Google Calendar API]
```

---

## データ構造

### フォーム回答シート（`フォームの回答 1`）

| 列 | セル | 項目 | 入力元 | 説明 |
|----|------|------|--------|------|
| A | TIMESTAMP | タイムスタンプ | フォーム自動 | 送信日時 |
| B | MOOD | 気分 | ユーザー入力 | 1（最悪）〜 5（最高） |
| C | CONDITION | 体調 | ユーザー入力 | 1（最悪）〜 5（最高） |
| D | SLEEP | 睡眠の質 | ユーザー入力 | 1（悪い）, 2（普通）, 3（良い） |
| E | MEMO | メモ | ユーザー入力 | 自由記述（任意） |
| F | CHECK_ITEMS | チェック項目 | ユーザー入力 | 薬, カフェイン, 酒（複数選択） |
| G | PRESSURE | 瞬間気圧 (hPa) | GAS自動 | 送信時刻に最も近い時間帯の気圧 |
| H | PRESSURE_TREND | 気圧トレンド (hPa) | GAS自動 | 3時間前との気圧差 |
| I | PRESSURE_24H | 24h変動幅 (hPa) | GAS自動 | 当日の気圧最大値 - 最小値 |
| J | TEMPERATURE | 気温 (℃) | GAS自動 | 送信時刻に最も近い時間帯の気温 |
| K | TEMP_DIFF | 寒暖差 (℃) | GAS自動 | 当日最高気温 - 前日最高気温 |
| L | HUMIDITY | 湿度 (%) | GAS自動 | 送信時刻に最も近い時間帯の湿度 |
| M | MOON_AGE | 月齢 | GAS自動 | 簡易式による月齢（0〜29.5） |
| N | HOLIDAY_FLAG | 休日フラグ | GAS自動 | TRUE（土日祝） / FALSE（平日） |

### 気象ログシート（`気象ログ`）

フォーム入力がなかった日の気象データを記録する。自動作成。

| 列 | 項目 | 説明 |
|----|------|------|
| A | 日付 | 対象日 |
| B | 瞬間気圧 (hPa) | 正午時点の気圧 |
| C | 気圧トレンド (hPa) | 正午から3時間前との差 |
| D | 24h変動幅 (hPa) | 当日の気圧最大値 - 最小値（確定値） |
| E | 気温 (℃) | 正午時点の気温 |
| F | 寒暖差 (℃) | 当日最高気温 - 前日最高気温（確定値） |
| G | 湿度 (%) | 正午時点の湿度 |
| H | 月齢 | 簡易式による月齢 |
| I | 休日フラグ | TRUE / FALSE |

### エラーログシート（`Log`）

| 列 | 項目 |
|----|------|
| A | タイムスタンプ |
| B | 関数名 |
| C | エラー内容 |

---

## 機能一覧

### 1. フォーム送信時トリガー（`onFormSubmit`）

| 項目 | 内容 |
|------|------|
| トリガー | スプレッドシートのフォーム送信時 |
| 処理内容 | 送信時刻に対応する気象データを取得し、G〜N列に書き込む |

**処理フロー:**

1. フォーム送信行のタイムスタンプを取得
2. Open-Meteo APIから前日0:00〜送信日の時系列気象データを取得
3. 送信時刻に最も近い時間帯の瞬間値（気圧・気温・湿度）を算出
4. 気圧トレンド（3時間前との差）を算出
5. 暫定の24h変動幅・寒暖差を算出
6. 月齢・休日フラグを算出
7. G〜N列に書き込み

### 2. 日次更新（`updateDailySummary`）

| 項目 | 内容 |
|------|------|
| トリガー | 時間主導型 / 日付ベース / 午前0時〜1時 |
| 処理内容 | 前日の確定気象データで上書き + 欠損データの自動補完 |

**処理フロー:**

1. 前日の確定気象データ（前々日〜前日の2日間）をOpen-Meteo APIから取得
2. 確定値（24h変動幅・寒暖差）を算出
3. フォーム回答シートに前日の入力行があるか検索
   - **ある場合**: I列（24h変動幅）とK列（寒暖差）を確定値で上書き
   - **ない場合**: 気象ログシートに正午時点の気象データを1行追記
4. `backfillMissingWeatherData` を呼び出して過去の欠損を補完

### 3. 欠損気象データの自動補完（`backfillMissingWeatherData`）

| 項目 | 内容 |
|------|------|
| 呼び出し元 | `updateDailySummary` の末尾 |
| 対象期間 | 実行日の10日前〜前日（AMeDAS APIのデータ保持期間に合わせる） |

**処理フロー:**

1. フォーム回答シートで気象データ（G列: 瞬間気圧）が空の行を検索
   - 対象期間内かつ空の行 → 気象データを取得して補完
   - 既にデータがある行 → スキップ
2. フォーム入力がなかった日で気象ログにもない日を検索
   - 該当日の正午時点データを取得して気象ログに追記
   - 気象ログに既にある日 → スキップ（上書きしない）
3. API連続呼び出しの負荷軽減のため、日付ごとに500msのウェイトを挿入

---

## 気象データの算出ロジック

### 瞬間値（`calculateInstantValues`）

- 時系列データの中から、対象時刻に最も近い時間帯のインデックスを特定
- そのインデックスの気圧・気温・湿度を返す
- 気圧トレンドは、3時間前のインデックスとの気圧差

### 24h変動幅（`calculatePressure24hRange`）

- **確定値**（isConfirmed=true）: 対象日の全時間帯の気圧から最大値 - 最小値
- **暫定値**（isConfirmed=false）: 対象時刻から過去24時間の気圧から最大値 - 最小値

### 寒暖差（`calculateTempDiff`）

- 当日最高気温 - 前日最高気温（時系列データから算出）
- **確定値**（isConfirmed=true）: 当日全時間帯の最高気温で算出
- **暫定値**（isConfirmed=false）: 当日のうち送信時刻以前の最高気温で算出

### 月齢（`calculateMoonAge`）

- 基準新月: 2000年1月6日 18:14 (UTC)
- 朔望月周期: 29.53058867日
- 対象日との日数差を朔望月で剰余算出

### 休日判定（`isHoliday`）

- 土曜・日曜 → TRUE
- 平日 → Googleカレンダーの日本の祝日カレンダー（`ja.japanese#holiday@group.v.calendar.google.com`）でイベントの有無を判定

---

## 外部API

### 気象庁 AMeDAS API（非公式公開API）

| 項目 | 内容 |
|------|------|
| 観測点テーブル | `https://www.jma.go.jp/bosai/amedas/const/amedastable.json` |
| 時系列データ | `https://www.jma.go.jp/bosai/amedas/data/point/{観測点コード}/{YYYYMMDD}_{HH}.json` |
| 認証 | 不要 |
| 配信粒度 | 10分ごと（1ファイルに3時間分） |
| データ保持期間 | 約10日 |

**取得項目:**

| AMeDASキー | 内部マッピング | 説明 |
|---|---|---|
| `temp[0]` | `temperature_2m` | 気温（℃） |
| `humidity[0]` | `relative_humidity_2m` | 相対湿度（%） |
| `pressure[0]` | `surface_pressure` | 現地気圧（hPa） |

**観測点選定ロジック:**

`amedastable.json` の `elems` フィールド（14桁文字列）の以下のフラグを確認：
- 3桁目: 気温
- 4桁目: 相対湿度
- 10桁目: 現地気圧

3つすべてが `1` の観測点から、緯度経度の距離（ユークリッド距離）が最小のものを選定する。

**呼び出しパターン:**

| 関数 | 期間 | 用途 |
|------|------|------|
| `fetchWeatherData` | 前日0:00〜対象時刻 | フォーム送信時・補完時の瞬間値取得 |
| `fetchWeatherDataDaily` | 前日0:00〜対象日23:59 | 日次確定値の算出 |
| `fetchAmedasData` | 任意期間 | 上記の内部実装。3時間バッチを統合して返す |
| `adaptAmedasToHourly` | - | AMeDASのキー形式を内部共通形式（hourly配列）に変換 |

各バッチ呼び出しの間に200msのウェイトを挿入してAPI負荷を軽減。

---

## スクリプトプロパティ

| キー名 | 説明 | 設定方法 |
|--------|------|----------|
| `SPREADSHEET_ID` | GoogleスプレッドシートのID | `setupProperties` で設定 |
| `LAT` | 緯度 | `setupProperties` で設定 |
| `LON` | 経度 | `setupProperties` で設定 |
| `AMEDAS_STATION_CODE` | AMeDAS観測点コード | 未設定時は `LAT`/`LON` から自動選定して保存 |

---

## トリガー構成

| 関数 | イベント | タイミング |
|------|----------|-----------|
| `onFormSubmit` | スプレッドシートのフォーム送信時 | フォーム送信の都度 |
| `updateDailySummary` | 時間主導型 / 日付ベース | 毎日 午前0時〜1時 |

---

## 関数一覧

| 関数名 | 種別 | 説明 |
|--------|------|------|
| `onFormSubmit(e)` | トリガー | フォーム送信時に気象データを取得・記録 |
| `updateDailySummary()` | トリガー | 前日の確定値で上書き + 欠損補完 |
| `backfillMissingWeatherData()` | 自動補完 | 過去10日の欠損気象データを自動取得 |
| `getOrCreateWeatherLogSheet(ss)` | シート管理 | 気象ログシートの取得または新規作成 |
| `fetchWeatherData(lat, lon, targetDate)` | API | 時系列気象データの取得（前日〜対象時刻） |
| `fetchWeatherDataDaily(lat, lon, targetDate)` | API | 日次確定用気象データの取得（前日〜対象日23:59） |
| `fetchAmedasStationTable()` | API | AMeDAS観測点テーブルの取得 |
| `findNearestAmedasStation(lat, lon)` | 観測点 | 気温・湿度・気圧を観測している最寄り観測点の選定 |
| `getAmedasStationCode()` | 観測点 | 観測点コードの取得（プロパティ or 自動選定） |
| `fetchAmedasData(stationCode, startDate, endDate)` | API | AMeDAS時系列データを期間指定で取得 |
| `adaptAmedasToHourly(amedasData)` | 変換 | AMeDASデータを内部共通形式（hourly配列）に変換 |
| `calculateInstantValues(weather, targetDate)` | 算出 | 瞬間値（気圧・気温・湿度・トレンド）の算出 |
| `calculatePressure24hRange(weather, targetDate, isConfirmed)` | 算出 | 24h気圧変動幅の算出 |
| `calculateTempDiff(weather, targetDate, isConfirmed)` | 算出 | 寒暖差の算出 |
| `calculateMoonAge(date)` | 算出 | 月齢の算出（簡易式） |
| `isHoliday(date)` | 判定 | 休日判定（土日 + 祝日） |
| `findRowsByDate(sheet, targetDate)` | 検索 | 指定日のフォーム回答行を検索 |
| `getSpreadsheet()` | ユーティリティ | スプレッドシート取得 |
| `getLocation()` | ユーティリティ | 緯度・経度取得 |
| `roundTo(value, decimals)` | ユーティリティ | 小数点丸め |
| `logError(funcName, message)` | ログ | エラーログ記録 |
| `setupProperties()` | セットアップ | スクリプトプロパティの初期設定（手動1回実行） |
