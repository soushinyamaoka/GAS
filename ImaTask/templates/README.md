# スプレッドシート テンプレ

`Code.js` の `initializeSheetsIfNeeded()` で自動生成される内容と同じものを CSV で用意しています。
通常はウェブアプリに最初にアクセスするだけで自動投入されるので、このテンプレを手動で扱う必要はありません。

以下のような場合に使ってください:

- データを一度クリアして手動で再投入したい
- 構造を確認したい
- 自分用にカスタムしたい

## ファイル一覧

| ファイル | 対応シート | 内容 |
|---|---|---|
| `time_slots.csv` | `time_slots` | 時間帯定義 (4 件) |
| `tasks.csv` | `tasks` | 初期タスク (35 件) |
| `task_status.csv` | `task_status` | ヘッダーのみ (空) |
| `settings.csv` | `settings` | アプリ設定 (5 件) |

## 手動でスプレッドシートに反映する手順

### 方法 A: シートごとに直接インポート (推奨)

1. 対象スプレッドシートを開く
2. 下部のシートタブで `+` をクリック → シート名を `time_slots` に
3. メニュー: **ファイル → インポート → アップロード**
4. CSV をドラッグ
5. インポート設定:
   - インポート場所: **現在のシートを置換**
   - 区切り文字: **カンマ**
   - テキストを数値・日付・数式に変換: **オフ** (時刻を文字列で扱うため)
6. 同じ要領で `tasks` / `task_status` / `settings` を作成

### 方法 B: コピー＆ペースト

1. CSV をテキストエディタで開く
2. 全選択してコピー
3. シートの A1 に貼り付け
4. 自動で複数列に展開される

## 列の意味

### `time_slots`
| 列 | 意味 |
|---|---|
| `time_slot_id` | 時間帯の識別子 (英数) |
| `name` | 表示名 |
| `start_time` / `end_time` | `HH:mm` 文字列 (※日付型に変換しないこと) |
| `active` | TRUE で有効 |

### `tasks`
| 列 | 意味 |
|---|---|
| `task_id` | タスクの一意な ID (`t001` 形式) |
| `time_slot_id` | どの時間帯のタスクか (`time_slots.time_slot_id` と紐づく) |
| `assignee` | 担当者名 (画面のグループ単位) |
| `task_name` | タスク名 (画面表示用) |
| `sort_order` | 担当者ごとの表示順 |
| `active` | TRUE で表示 |
| `important` | TRUE で「重要」(脈打つアニメ) |
| `warning_minutes_before_end` | 終了何分前から黄色警告にするか |
| `days` | 対象曜日 (`all` または `mon,tue,...`) |
| `note` | 備考 (任意) |

### `task_status`
| 列 | 意味 |
|---|---|
| `date` | 日付 (`yyyy-mm-dd`) |
| `task_id` | 対象タスク |
| `status` | `done` または `pending` |
| `completed_at` | 完了時刻 |
| `completed_by` | 完了者 |

`task_status` はチェック操作で自動追記されるので、初期は空でOKです。

### `settings`
| key | 用途 |
|---|---|
| `app_title` | アプリタイトル (将来用) |
| `refresh_seconds` | 自動更新間隔 (秒) |
| `warning_default_minutes` | 警告表示するデフォルト分数 |
| `show_done_tasks` | TRUE で完了タスクも表示 / FALSE で非表示 |
| `tablet_mode` | タブレット表示モード (将来用) |

## 注意点

- **時刻列 (`start_time` / `end_time`)** は文字列で扱います。Google スプレッドシートが自動で日付型に変換しないよう、インポート時に「テキストを数値・日付・数式に変換」を **オフ** にしてください
- `active` / `important` / `show_done_tasks` などの真偽値は `TRUE` / `FALSE` (大文字推奨) で記載
- 担当者を増やす場合は `tasks.csv` の `assignee` 列に新しい名前を入れるだけで OK (画面側で自動的にカラムが増えます)
- 平日/休日の出し分けは MVP では未実装。`time_slot_id` を `noon_weekday` / `noon_holiday` のように分けて将来対応予定
