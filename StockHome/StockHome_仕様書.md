# 家庭用 消耗品在庫管理アプリ 実装仕様書（統合最終版）

## 1. 目的
家庭内の消耗品を管理し、購入履歴と消費設定から在庫切れ時期を予測し、在庫切れ前に通知する。  
家族複数人で利用できること。  
スマホから手動で消耗品追加・編集・削除・購入記録登録ができること。  
オンライン購入分は Gmail の注文関連メールから自動取得候補を作ること。  
LINE 通知は、新規アプリが通知情報を生成し、ReadyGo Bot（家族向け生活自動化Bot）の 21:00 夜次通知に追記して配信すること。

---

## 2. 今回の重要な決定事項
- 利用者は家族複数人を想定する
- 店舗購入やスーパー購入など履歴が残らない購入に対応するため、手動登録は必須機能とする
- オンライン購入の自動取得対象は以下の2つに限定する
  - Amazon
  - マツキヨオンライン
- オンライン購入履歴の自動取得は、各ECサイトの注文履歴画面スクレイピングではなく、各ユーザーの Gmail に届く注文確認メール・発送関連メールの解析で行う
- 家族それぞれの Gmail を対象にする
- Gmail 自動取込は、各ユーザーが初回だけ認可し、自分用の time-driven trigger を作る方式とする
- GAS プロジェクトは1つ、Webアプリも1つとする
- Webアプリは access user として実行する
- 家族全員に共通スプレッドシートの編集権限を付与する前提とする
- ソースコードは1つの GAS プロジェクトに集約し、ユーザーごとにソースは分けない
- トリガーはユーザーごとに持つ
- 消耗品削除は物理削除ではなく論理削除とする
- 自動取得したデータは直接 purchase_log に入れず、いったん import_order_candidates に保存する
- 候補確定後に purchase_log に反映する
- 通知は「残日数」と「残数量しきい値」の両方に対応する
- 推定在庫のズレを前提に、在庫補正機能を必須とする
- 通知にはスヌーズ機能を持たせる
- 品目ごとに通知 ON/OFF を設定できるようにする
- LINE Messaging API は新規アプリから直接呼ばない
- 通知は ReadyGo Bot 側スプレッドシートの `Inbox` シートに行を追加することで委譲する
- ReadyGo Bot は毎晩 21:00 の LINE 通知の末尾に「📨 お知らせ」として追記して配信する
- ReadyGo Bot は家族 LINE グループへのブロードキャストで運用するため、新規アプリ側では通知を「ユーザー別」に分けず1メッセージに集約する
- 二重送信防止は ReadyGo 側で `processed` フラグにより担保される（StockHome 側では行わない）
- ユーザー識別の主キーは email ではなく `user_id` とする
- email は補助情報とし、未取得でも利用可能にする（ただし `email` 未設定だとホーム画面アラートのユーザー別フィルタは効かず全件表示になる）
- 在庫補正とスヌーズは `stock_snapshot` に直接持たず、別の運用状態テーブルで管理する
- 購入金額の確認機能は将来的追加機能として設計に含める
- Gmail 読取条件と反映タイミングは明文化する
- 注文確認メールだけで在庫へ反映しない
- 発送通知メールを purchase_log 反映の起点にする
- 実在庫への加算は `inventory_effective_at` 基準にする
- 配達完了メールは MVP の必須条件にしない

### 2.1 移行: LINE Bot 連携方式の変更（2026年5月）
- 旧方式: 共有スプレッドシート上の `line_outbox` シートに pending レコードを積み、独自実装の LINE Bot がポーリングして送信
- 新方式: 既存の **ReadyGo Bot**（家族向け生活自動化Bot）の Inbox シートに行追加し、ReadyGo 21:00 夜次 LINE 通知の末尾に追記して配信
- 変更に伴い `line_outbox` シート / `OutboxService` / `dedupe_key` 等は廃止
- 通知はユーザー別配信ではなく1メッセージ集約のブロードキャストへ変更
- バッチ実行時刻は朝 7:00 から夜 20:00 へ移動（21:00 ReadyGo 配信の直前）
- 重複防止は ReadyGo 側の `processed` フラグに委譲し、StockHome 側では行わない（`NotificationService.hasRecentNotification` は将来再導入用に残置）

---

## 3. システム構成

### 3.1 構成要素
- フロントエンド
  - GAS HTML Service による Web アプリ
  - スマホブラウザ利用前提
- バックエンド
  - Google Apps Script
- データ保存
  - Google スプレッドシート
- メール取得
  - Apps Script の GmailApp
- 定期実行
  - Apps Script installable trigger
- 通知送信
  - ReadyGo Bot（家族向け生活自動化Bot）
- 通知連携
  - ReadyGo 側スプレッドシートの `Inbox` シートに行追加
- 設定保存
  - PropertiesService
- 同時実行対策
  - LockService

### 3.2 方針
- GAS プロジェクトは1つ
- Web アプリも1つ
- 共通スプレッドシートも1つ
- ただし Gmail 自動取込トリガーは家族ごとに別で持つ
- 各ユーザーの Gmail は、そのユーザーの権限でだけ読む
- 在庫ロジック、通知判定ロジック、ReadyGo Inbox 投入ロジックは全員共通
- LINE送信ロジックそのものは ReadyGo Bot に委譲する

---

## 4. 実行モデル

### 4.1 Web アプリ
- Web アプリは access user として実行する
- 各ユーザーがアクセスしたとき、そのユーザーの権限で Gmail 設定や trigger 作成が行えるようにする
- スプレッドシート更新は共通データに対して行う
- そのため、家族全員に共通スプレッドシートの編集権限が必要

### 4.2 Gmail 自動取込
- 各ユーザーが自分で「Gmail 自動取込を有効化」ボタンを押す
- その操作により、そのユーザー自身の installable trigger を作成する
- trigger は共通関数 `runMyGmailImport` を定期実行する
- 同じ関数名を使うが、実行ユーザーが異なるため、読む Gmail はユーザーごとに異なる
- ユーザーごとにソースを分けない

### 4.3 認可の考え方
- 初回だけ各ユーザーに Gmail 等の権限承認が必要
- 以後は通常不要
- ただし以下の場合は再承認や再作成が必要になりうる
  - 必要スコープが増えた場合
  - ユーザーが権限を取り消した場合
  - ユーザー自身の trigger が削除された場合

### 4.4 通知の実行モデル
- 新規アプリ側（StockHome）
  - 在庫計算
  - 通知判定（`notify_target_type=all` の品目のみ）
  - 通知文生成（全アラート品目を1メッセージに集約）
  - ReadyGo Bot 側スプレッドシートの `Inbox` シートに1行追加
  - `notification_log` への記録（投入成功時のみ）
- ReadyGo Bot 側
  - 21:00 の夜次 LINE 通知時に Inbox シートを読み取る
  - StockHome から投入された行の `body` を「📨 お知らせ」として通知末尾に追記
  - 配信後 Inbox 行の `processed` を `true` に更新

---

## 5. MVP 対象機能

### 5.1 消耗品マスタ管理
スマホから以下を追加・編集・論理削除できること。

- 品名
- カテゴリ
- 単位
- 標準購入数
- 1単位あたり消費日数
- 通知何日前
- 安全日数
- 在庫数しきい値通知数
- 購入先URL
- 通知先設定
- 通知有効/無効
- 有効/無効

### 5.2 購入履歴の手動登録
スマホから以下を登録できること。

- 品目
- 購入日
- 購入数
- 購入元
- 購入者
- 備考

### 5.3 オンライン購入履歴の自動取得候補作成
各ユーザーの Gmail から以下を対象に自動取込候補を作る。

- Amazon の注文関連メール
- Amazon の発送関連メール
- マツキヨオンラインの注文確認メール
- マツキヨオンラインの発送関連メール

### 5.4 自動取込候補の確認・確定
- 自動取込候補一覧を表示できること
- 候補を既存の消耗品に紐付けできること
- 候補を確定すると purchase_log に反映されること
- 候補を無視できること

### 5.5 在庫予測
購入履歴と消費設定から以下を算出する。

- 推定残数
- 推定残日数
- 在庫切れ予測日
- 日数ベース通知要否
- 数量ベース通知要否
- 最終通知要否

### 5.6 通知配信
通知対象になった場合、全品目を1メッセージに集約し ReadyGo Bot 側スプレッドシートの `Inbox` シートに1行追加する。
ReadyGo Bot が 21:00 の LINE 通知に追記して配信する。

### 5.7 通知スヌーズ
通知ごとに以下を設定できること。

- 3日後に再通知
- 7日後に再通知
- 今回は無視
- スヌーズ解除

### 5.8 在庫補正
推定在庫のズレを人が直せること。

- 実際の残数を手動入力して補正
- 補正理由をメモできる
- 補正日時と補正者を記録できる

### 5.9 通知 ON/OFF
品目ごとに通知送信可否を持てること。

- 通知する
- 通知しない

### 5.10 購入 URL ワンタップ導線
- 消耗品一覧
- 在庫予測一覧
- 通知文面

から購入先URLをすぐ開けること。

### 5.11 通知理由の見える化
通知履歴や在庫一覧から、通知理由を確認できること。

通知理由例:
- days_threshold
- qty_threshold
- both

---

## 6. 今回やらないこと
- Amazon / マツキヨのサイトスクレイピング
- Amazon / マツキヨの公式API連携
- レシート OCR
- クレカ履歴からの推定
- PWA 化
- ネイティブアプリ化
- 厳密在庫の完全自動化
- 複雑な権限制御
- 新規 LINE user_id 取得フロー
- 新規アプリからの LINE API 直接送信
- 配達完了メールを前提にした厳密在庫反映

---

## 7. スプレッドシート設計

### 7.1 users
家族ユーザー情報

列:
- user_id
- user_name
- email
- existing_bot_target_id
- role
- is_active
- created_at
- updated_at

補足:
- role は admin / member
- email は補助情報だが、ホーム画面アラートの notify_target_type フィルタを効かせるには Google アカウントメールを記入する必要がある
- 主キーは user_id
- existing_bot_target_id 列はスキーマ互換のため残置（ReadyGo はブロードキャスト配信のため個別 ID は不要。空のままで運用可）

---

### 7.2 items
消耗品マスタ

列:
- item_id
- item_name
- category
- unit
- default_purchase_qty
- days_per_unit
- lead_days
- safety_days
- low_stock_threshold_qty
- purchase_url
- notify_target_type
- notify_target_user_id
- notification_enabled
- is_active
- deleted_at
- deleted_by
- created_at
- updated_at

補足:
- notify_target_type は all / representative / specific_user
- notify_target_user_id は specific_user の場合のみ使用
- low_stock_threshold_qty は空欄許容
- notification_enabled が FALSE の場合は通知対象から外す
- 論理削除時は is_active = FALSE にする

---

### 7.3 purchase_log
購入履歴

列:
- purchase_id
- item_id
- purchased_at
- qty
- source
- source_type
- external_vendor
- external_order_id
- import_candidate_id
- purchased_by_user_id
- purchased_by_user_name
- note
- fulfillment_status
- shipped_at
- inventory_effective_at
- counted_in_inventory
- created_at
- updated_at

補足:
- source は manual / line / gmail
- source_type は manual / line_quick / gmail_auto
- external_vendor は amazon / matsukiyo / null
- fulfillment_status は ordered / shipped / received / cancelled を想定
- counted_in_inventory は boolean
- 在庫計算では counted_in_inventory = true の履歴のみ加味する

---

### 7.4 stock_snapshot
在庫計算結果

列:
- item_id
- calculated_at
- latest_purchase_date
- latest_purchase_qty
- estimated_remaining_qty
- estimated_days_left
- predicted_out_of_stock_date
- low_stock_threshold_qty
- days_alert_needed
- qty_alert_needed
- alert_needed
- updated_at

補足:
- 初期は各 item_id 1行の最新状態のみ保持でよい
- alert_needed は days_alert_needed または qty_alert_needed
- runtime状態はここに持たない

---

### 7.5 item_runtime_state
品目ごとの運用状態

列:
- item_id
- manual_override_qty
- manual_override_at
- manual_override_by_user_id
- manual_override_reason
- snooze_until
- last_notification_reason
- last_notification_at
- updated_at

補足:
- 在庫補正の現在有効値を持つ
- スヌーズ状態を持つ
- 派生表ではなく永続状態として扱う
- 在庫計算時は stock_snapshot と組み合わせて参照する

---

### 7.6 notification_log
通知履歴

列:
- notification_id
- item_id
- notification_type
- notification_reason
- target_user_id
- outbox_id
- message
- created_at

補足:
- 通知判定・通知生成の履歴を持つ
- ReadyGo Bot Inbox 投入が成功した場合のみレコードを作成する
- `target_user_id` は集約ブロードキャストのため固定値 `broadcast`
- `outbox_id` 列は旧 `line_outbox` 連携時代のスキーマ互換のために残置されているが、現フローでは常に空文字（将来的に削除可）

---

### 7.7 import_order_candidates
Gmail 自動取込候補

列:
- candidate_id
- vendor
- mail_message_id
- gmail_thread_id
- imported_by_user_id
- imported_by_email
- mail_date
- order_id
- mail_type
- mail_phase
- fulfillment_status
- candidate_group_key
- item_name_raw
- detected_qty
- detected_price
- candidate_status
- matched_item_id
- raw_subject
- raw_snippet
- parse_result
- created_at
- updated_at

補足:
- vendor は amazon / matsukiyo
- mail_type は order_confirm / shipment / other
- mail_phase は ordered / shipped / delivered_optional / other
- candidate_status は detected / ordered / shipped / confirmed / ignored / cancelled / error
- matched_item_id は既存消耗品に紐付いたら保存
- mail_message_id で重複排除する
- candidate_group_key は同一注文・同一商品行の突合用

---

### 7.8 stock_correction_log
在庫補正履歴

列:
- correction_id
- item_id
- corrected_at
- corrected_by_user_id
- corrected_by_user_name
- before_estimated_qty
- corrected_qty
- correction_reason
- note
- created_at

補足:
- 在庫補正の監査ログとして使う
- correction_reason 例:
  - still_have_more
  - counted_actual_stock
  - wrong_import
  - manual_adjustment

---

### 7.9 app_config
アプリ設定

列:
- config_key
- config_value

補足:
- 一般設定のみ
- 秘密情報は保存しない
- 以下を保持可能にする
  - default_delivery_buffer_days

---

## 8. PropertiesService 設計

### 8.1 Script Properties に保存
- SPREADSHEET_ID
- WEBAPP_BASE_URL
- READYGO_SPREADSHEET_ID

補足:
- `READYGO_SPREADSHEET_ID` は ReadyGo Bot 側スプレッドシートの ID。未設定だと ReadyGo 配信は行われずバッチは継続する。

### 8.2 User Properties に保存
- current_user_id
- gmail_import_enabled
- gmail_import_last_run_at
- amazon_search_query
- matsukiyo_search_query

補足:
- User Properties はユーザーごとの Gmail 取込設定保持に使う

---

## 9. UI 要件

### 9.1 共通方針
- スマホ前提
- 縦並び
- 入力しやすい大きめボタン
- 一覧は必要最小限
- 完了メッセージを分かりやすく表示
- 画面遷移は少なめ
- 下部ナビまたは上部タブで主要画面に移動可能にする

### 9.2 画面一覧
1. ホーム / ダッシュボード
2. 消耗品一覧
3. 消耗品登録 / 編集
4. 購入履歴登録
5. 在庫予測一覧
6. Gmail 自動取込候補一覧
7. Gmail 自動取込設定
8. 家族設定（簡易）
9. 通知履歴一覧
10. 在庫補正画面

---

### 9.3 ホーム
表示内容:
- 在庫切れが近い消耗品上位（current_user の notify_target_type に応じてフィルタ）
- 今日通知対象の件数
- 未確認の自動取込候補件数
- 主要ボタン
  - 消耗品追加
  - 購入記録追加
  - Gmail 自動取込設定
  - 候補確認
  - 在庫補正

アラート絞り込みロジック:
- `notify_target_type = all` の品目 → 全員に表示
- `notify_target_type = representative` の品目 → admin ロールのユーザーにのみ表示
- `notify_target_type = specific_user` の品目 → notify_target_user_id 一致ユーザーにのみ表示
- current_user が特定できない場合（users.email 未設定等）はフォールバックで全件表示

操作:
- アラート行タップ → 在庫予測一覧へ遷移し、対象品目位置にスクロール&ハイライト

---

### 9.4 消耗品一覧
表示項目:
- 品名
- カテゴリ
- 推定残日数
- 推定残数
- 在庫切れ予測日
- 在庫数しきい値通知数
- 通知ON/OFF
- 購入先URLリンク
- 編集ボタン
- 削除ボタン

挙動:
- 在庫切れが近い順
- 無効品目は通常非表示
- 「無効品目も表示」切り替えあり

---

### 9.5 消耗品登録 / 編集
入力項目:
- 品名
- カテゴリ
- 単位
- 標準購入数
- 1単位あたり消費日数
- 通知何日前
- 安全日数
- 在庫数しきい値通知数
- 購入先URL
- 通知先種別
- 通知先ユーザー
- 通知有効/無効
- 有効/無効

バリデーション:
- 品名必須
- 標準購入数は 1以上
- 消費日数は 1以上
- 通知何日前は 0以上整数
- 安全日数は 0以上整数
- 在庫数しきい値通知数は空欄可、入力時は 0以上数値
- URL は空許容、入力時はURL形式チェック

削除仕様:
- 削除ボタン押下時に確認ダイアログ
- 実際は論理削除
- is_active = FALSE
- deleted_at, deleted_by 更新

---

### 9.6 購入履歴登録
入力項目:
- 品目
- 購入日
- 購入数
- 購入元
- 購入者
- 備考

初期値:
- 購入日は今日
- 購入者はログイン中の家族ユーザー

バリデーション:
- 品目必須
- 購入日必須
- 購入数は 1以上

---

### 9.7 在庫予測一覧
表示項目:
- 品名
- 最新購入日
- 最新購入数
- 推定残数
- 推定残日数
- 在庫切れ予測日
- 数量しきい値
- 日数通知対象か
- 数量通知対象か
- 最終通知対象か
- 購入URL
- 補正ボタン
- スヌーズ状態

操作:
- 購入ページを開く
- 在庫補正
- スヌーズ設定 / 解除

---

### 9.8 Gmail 自動取込候補一覧
表示項目:
- vendor
- mail_date
- raw_subject
- item_name_raw
- detected_qty
- candidate_status
- mail_phase
- fulfillment_status
- imported_by_user_id
- matched_item_id

操作:
- 詳細を見る
- 消耗品に紐付ける
- 確定する
- 無視する

---

### 9.9 Gmail 自動取込設定
表示項目:
- 現在の Gmail 自動取込状態
- 最終取込日時
- 自分用 trigger の有無
- Amazon 用検索条件
- マツキヨ用検索条件
- 配送バッファ日数

操作:
- Gmail 自動取込を有効化
- Gmail 自動取込を無効化
- Gmail 取込を今すぐ実行
- 検索条件保存
- 配送バッファ日数保存

---

### 9.10 通知履歴一覧
表示項目:
- 生成日時
- 品目名
- 通知理由
- 通知文面（要約）

補足:
- ReadyGo Bot Inbox 投入が成功した場合のみレコードが残るため、表示されている = 投入成功
- 送信ステータス・エラーメッセージ等は表示しない（ReadyGo 側で管理）

操作:
- 3日後に再通知
- 7日後に再通知
- スヌーズ解除
- 今回は無視

---

### 9.11 在庫補正画面
入力項目:
- 品目
- 現在の推定残数
- 実際の残数
- 補正理由
- メモ

バリデーション:
- 品目必須
- 実際の残数は 0以上数値
- 補正理由は選択式必須

---

## 10. Gmail 自動取込仕様

### 10.1 基本方針
- 各ユーザーの Gmail を各ユーザー自身の権限で検索する
- 取込対象は Amazon とマツキヨオンラインのみ
- まずは候補生成までを確実に作る
- 直接 purchase_log に入れない
- 候補確認画面で確定してから反映する

### 10.2 読取対象メール
Amazon:
- 注文確認系メール
- 発送確認系メール

マツキヨオンライン:
- 注文確認メール
- 商品発送のお知らせ系メール

### 10.3 Gmail検索条件
- GmailApp.search() を使用
- ベンダーごとに検索クエリを持つ
- 初期クエリは User Properties に保存
- クエリは後から UI で変更可能にする
- 検索範囲は「前回取込日時以降 + バッファ数日」に限定する
- 既読/未読ではなく、処理状態はアプリ側で管理する

### 10.4 パーサー
- AmazonMailParser
- MatsukiyoMailParser

各 parser の責務:
- 件名から mail_type 判定
- 本文から order_id 抽出
- 本文から商品名抽出
- 本文から数量抽出
- 候補オブジェクト生成

### 10.5 重複排除
以下の順で重複判定する
1. mail_message_id 一致
2. vendor + order_id + item_name_raw 一致
3. vendor + imported_by_user_id + mail_date + raw_subject 一致

### 10.6 候補反映ルール
- 初期は detected として保存
- 注文確認メール受信時は ordered にする
- 発送通知メール受信時は shipped にする
- ユーザーが matched_item_id を設定し confirmed すると purchase_log へ反映
- ignored は無視扱い
- cancelled を扱えるようにする
- 将来、発送通知メールから自動 confirmed 化できるように設計する

---

## 11. 読取メール条件と反映タイミング

### 11.1 基本判断
- 注文確認メールだけで在庫へ反映しない
- 発送メールを purchase_log 反映の起点にする
- 実在庫への加算は `inventory_effective_at` 基準にする
- 配達完了メールを MVP の必須条件にしない

### 11.2 注文確認メール
- 注文確認メールを受信した時点では purchase_log に反映しない
- import_order_candidates に候補のみ作成する
- 候補状態は ordered とする
- 在庫には影響させない

### 11.3 発送通知メール
- 発送通知メールを受信した時点で候補状態を shipped に更新する
- この段階で purchase_log を作成してよい
- ただしまだ自宅在庫とはみなさない
- purchase_log に fulfillment_status, shipped_at を保存する
- 在庫へ加算する基準日は別に持つ

### 11.4 在庫へ加算するタイミング
- 在庫計算に使うのは `inventory_effective_at <= today` の purchase_log のみとする
- `inventory_effective_at` は次の優先順で決める
  1. メール本文や候補データから配送完了日または受取日が取得できる場合はその日
  2. 取得できない場合は `shipped_at + default_delivery_buffer_days`
- `default_delivery_buffer_days` の初期値は 2 日とする
- 将来、手動の「受取済み」操作や ReadyGo Bot 返信で受取確認できるよう拡張しやすくする

---

## 12. 家族ごとの trigger 仕様

### 12.1 重要な考え方
- ソースコードは1つ
- trigger はユーザーごと
- 同じ `runMyGmailImport` を使う
- 誰の trigger で動いたかにより、読む Gmail が変わる

### 12.2 初回セットアップフロー
各ユーザーについて:
1. Web アプリを開く
2. ユーザー情報を登録または紐付け
3. Gmail 権限を承認
4. 「Gmail 自動取込を有効化」ボタンを押す
5. 自分用 trigger 作成
6. 以後は自動実行

### 12.3 トリガー作成関数
- createMyGmailImportTrigger()
- deleteMyGmailImportTrigger()
- hasMyGmailImportTrigger()
- runMyGmailImport()

### 12.4 トリガーの実行頻度
- 初期は 6時間ごと
- 将来は変更可能
- 必要以上に短くしない

### 12.5 メンテナンス方針
- 初回以降は基本放置運用
- trigger 状態は設定画面から確認可能にする
- エラーが出た場合のみ再承認または再有効化を案内する

---

## 13. 在庫予測ロジック

### 13.1 初期ロジック
- 最新購入履歴を取得する
- ただし counted_in_inventory = true の履歴だけを在庫計算に使う
- 経過日数 = 今日 - 最新購入日
- 推定消費量 = 経過日数 / days_per_unit
- 推定残数 = 最新購入数量 - 推定消費量
- item_runtime_state.manual_override_qty が存在する場合は、その値を現在残数の基準として優先する
- 推定残日数 = max(0, 推定残数 * days_per_unit)
- 在庫切れ予測日 = 今日 + 推定残日数

### 13.2 counted_in_inventory の判定
- `inventory_effective_at <= today` の履歴のみ true 扱いにする
- ordered のみ、または shipped 直後でまだ到着見込み前の履歴は在庫に加えない

### 13.3 日数ベース通知判定
- days_alert_needed = estimated_days_left <= (lead_days + safety_days)

### 13.4 数量ベース通知判定
- low_stock_threshold_qty が設定されている場合
- qty_alert_needed = estimated_remaining_qty <= low_stock_threshold_qty

### 13.5 最終通知判定
- alert_needed = (days_alert_needed OR qty_alert_needed)
- ただし以下の場合は通知しない
  - notification_enabled = FALSE
  - item_runtime_state.snooze_until が未来日
  - is_active = FALSE

### 13.6 補足
- 購入履歴が無い場合は在庫不明
- 推定残数が負になったら0扱い
- 将来は複数購入履歴を使って改善できるよう関数分離すること

---

## 14. 在庫補正仕様

### 14.1 方針
- このアプリは推定在庫ベースであるため、手動補正を必須機能とする
- 補正は現在推定残数を実際の残数へ置き換える
- 補正状態は item_runtime_state に保存する
- 補正履歴は stock_correction_log に保存する

### 14.2 補正時の処理
- 現在の推定残数を取得
- item_runtime_state.manual_override_qty を更新
- item_runtime_state.manual_override_at を更新
- item_runtime_state.manual_override_by_user_id を更新
- item_runtime_state.manual_override_reason を更新
- stock_correction_log に履歴を追加
- 再計算時に manual_override_qty を加味する

### 14.3 補正理由例
- still_have_more
- counted_actual_stock
- wrong_import
- manual_adjustment

---

## 15. 通知仕様

### 15.1 通知対象（ReadyGo 配信）
- items.is_active = TRUE
- notification_enabled = TRUE
- alert_needed = TRUE
- item_runtime_state.snooze_until が過去または空
- **notify_target_type = all のみ**（ReadyGo は家族 LINE グループへのブロードキャストのため）

### 15.2 通知先設定（notify_target_type）
items.notify_target_type は以下の3値を取りうる。

- `all` — ホーム画面で全員に表示し、ReadyGo にも配信する
- `representative` — ホーム画面では admin ロールのユーザーにのみ表示。ReadyGo には配信しない
- `specific_user` — ホーム画面では指定ユーザー（notify_target_user_id）にのみ表示。ReadyGo には配信しない

representative / specific_user はホーム画面アラートでの「見える化」のみ機能し、LINE への通知は届かない点に注意。

### 15.3 通知理由
- days_threshold
- qty_threshold
- both

### 15.4 通知文面（集約フォーマット）
ReadyGo Inbox への投入メッセージは全アラート品目を1つに集約する。

```
📦 在庫アラート (3件)

・ティッシュ：残3日 / 約2個
・牛乳：残2日 / 約1.0L
・米：しきい値以下 (残0.5袋)

→ 在庫予測画面で確認
https://script.google.com/macros/s/.../exec?page=stocks
```

1品目あたり1行で、通知理由により表記を変える:
- days_threshold → `品目名：残N日`
- qty_threshold → `品目名：しきい値以下 (残N単位)`
- both → `品目名：残N日 / 残N単位`

### 15.5 通知生成・配信
- 全アラート対象品目を1メッセージにまとめて生成
- ReadyGo Bot 側スプレッドシートの `Inbox` シートに1行追加（A=posted_at, B='StockHome', C=本文, D=false）
- 投入成功時のみ品目数分の `notification_log` レコードを作成
- 投入失敗時（権限不足・シート未存在・スプレッドシートID未設定等）は Logger.log のみで `notification_log` 記録なし

### 15.6 ReadyGo Bot の配信責務
- StockHome から投入された Inbox 行は、ReadyGo の **次の 21:00 LINE 通知** の末尾に「📨 お知らせ」として追記される
- 配信完了で ReadyGo が Inbox 行の `processed` を `true` に更新
- 一度配信された行は再配信されない
- ReadyGo 側の配信失敗時はその夜の通知から在庫アラートが欠落するのみ（夜の通知本体は通常通り送信される）

### 15.7 重複送信防止
- 現バージョンでは StockHome 側での重複防止は行わない（連日同じ品目がアラートになっても毎日 Inbox 投入される）
- ReadyGo 側で `processed` フラグにより当日内の二重配信は防がれる
- 将来 dedup を再導入する場合は `NotificationService.hasRecentNotification` を呼び出す形に戻す（関数は残置済み）

---

## 16. 通知スヌーズ仕様

### 16.1 スヌーズ操作
- 3日後に再通知
- 7日後に再通知
- 今回は無視
- スヌーズ解除

### 16.2 スヌーズ保存
- item_runtime_state.snooze_until に日時保存

### 16.3 今回は無視
- 初期実装では 30日後まで通知抑止でもよい
- 将来 separate ignore 状態にしてもよい

---

## 17. ReadyGo Bot 連携仕様

### 17.1 連携方針
- StockHome は LINE Messaging API を直接呼ばない
- StockHome は ReadyGo Bot 側スプレッドシートの `Inbox` シートに1行追加するだけ
- ReadyGo Bot が 21:00 の夜次 LINE 通知に追記して配信する
- 通知は家族 LINE グループへのブロードキャスト前提（ユーザー別の配り分けは不可）

### 17.2 Inbox シートの仕様（ReadyGo 側）
ReadyGo Bot 側が定義する受け口で、StockHome は仕様に従って書き込むのみ。

| 列 | 名前 | StockHome が書き込む値 |
|----|------|---------------------|
| A | posted_at | 投入時刻（`new Date()`） |
| B | source | 固定値 `StockHome` |
| C | body | 集約メッセージ本文 |
| D | processed | `false` 固定（ReadyGo が配信後に `true` に更新） |

### 17.3 配信タイミングと前提
- 投入された行は **次の 21:00 LINE 通知** に含まれる（即時配信ではない）
  - 例: 20:30 投入 → 当日 21:00 通知
  - 例: 21:30 投入 → 翌日 21:00 通知
- StockHome の日次バッチは 20:00〜21:00 に実行するように設定する
- 1度配信された行は ReadyGo 側で `processed = true` になり再配信されない
- 同日複数行ある場合は ReadyGo 側で posted_at 昇順で連結配信される（StockHome は1日1行投入が基本）
- LINE のテキストメッセージ上限 5000 文字

### 17.4 失敗時の挙動
- StockHome 側で `READYGO_SPREADSHEET_ID` 未設定 / 権限不足 / シート不在 / 例外発生時は Logger.log のみ
- バッチ自体は継続させる
- `notification_log` は投入成功時のみ記録（失敗時は履歴に残さない）
- ReadyGo 側の配信失敗時は ReadyGo の `Log` シート（種別 error）で確認できる

### 17.5 必要な設定
- スクリプトプロパティ `READYGO_SPREADSHEET_ID` に ReadyGo 側スプレッドシート ID を設定
- StockHome の日次バッチを所有する Google アカウントに ReadyGo スプレッドシートの編集者権限を付与

---

## 18. バッチ処理

### 18.1 全体バッチ
1日1回、夜 20:00〜21:00 に実行（ReadyGo 21:00 配信の直前）

処理:
1. inventory_effective_at 到来分の `counted_in_inventory` 更新
2. 有効な消耗品の在庫計算
3. stock_snapshot 更新
4. item_runtime_state を参照して通知対象抽出（notify_target_type=all のみ）
5. スヌーズ確認
6. 全アラート品目を1メッセージに集約
7. ReadyGo Bot Inbox に1行追加
8. notification_log を更新（投入成功時のみ）

### 18.2 ユーザー別 Gmail 取込バッチ
各ユーザーの trigger が実行

処理:
1. そのユーザーの Gmail を検索
2. 未処理メール抽出
3. vendor 判定
4. parser 実行
5. import_order_candidates に保存
6. User Properties に最終取込日時保存

---

## 19. GAS コード構成

推奨ファイル構成:

- Main.gs
- Config.gs
- Utils.gs
- Validation.gs
- UserService.gs
- ItemService.gs
- PurchaseService.gs
- StockService.gs
- StockCorrectionService.gs
- ItemRuntimeStateService.gs
- NotificationService.gs
- SnoozeService.gs
- ReadyGoBotService.gs
- GmailImportService.gs
- AmazonMailParser.gs
- MatsukiyoMailParser.gs
- TriggerService.gs
- SheetRepository.gs
- SheetInitializer.gs
- BatchController.gs
- WebController.gs
- HtmlIndex.html
- HtmlItems.html
- HtmlItemForm.html
- HtmlPurchaseForm.html
- HtmlStocks.html
- HtmlImportCandidates.html
- HtmlGmailSettings.html
- HtmlNotifications.html
- HtmlStockCorrection.html
- appsscript.json

### 各役割
- Main.gs
  - doGet
  - 必要なら doPost
- Config.gs
  - Script Properties / User Properties 取得
- Utils.gs
  - ID生成
  - 日付処理
  - 共通ユーティリティ
- Validation.gs
  - 入力値検証
- UserService.gs
  - 家族ユーザー管理
- ItemService.gs
  - 消耗品 CRUD / 論理削除 / 通知設定
- PurchaseService.gs
  - 購入履歴登録 / 取得
- StockService.gs
  - 在庫計算 / snapshot 保存
- StockCorrectionService.gs
  - 在庫補正履歴保存
- ItemRuntimeStateService.gs
  - manual override / snooze / 通知状態管理
- NotificationService.gs
  - 通知対象判定 / 通知文生成（集約） / notification_log 記録
  - ReadyGoBotService 経由で Inbox 投入
- SnoozeService.gs
  - スヌーズ管理
- ReadyGoBotService.gs
  - ReadyGo Bot 側スプレッドシートの Inbox シート投入
- GmailImportService.gs
  - Gmail 検索 / 候補保存
- AmazonMailParser.gs
  - Amazon メール解析
- MatsukiyoMailParser.gs
  - マツキヨメール解析
- TriggerService.gs
  - create/delete/check runMyGmailImport trigger
- SheetRepository.gs
  - シートアクセス共通化
- SheetInitializer.gs
  - 初回セットアップ用のシート生成
- BatchController.gs
  - 日次バッチ
  - ユーザー別 Gmail import 実行入口
- WebController.gs
  - クライアント向け関数群

---

## 20. 必須関数仕様

### UserService
- getCurrentUser()
- getUsers()
- createOrUpdateUser(userData)
- findUserById(userId)

### ItemService
- getItems(includeInactive)
- getActiveItems()
- getItemById(itemId)
- createItem(itemData)
- updateItem(itemId, itemData)
- deleteItemLogical(itemId, deletedByUserId)
- updateItemNotificationEnabled(itemId, enabled)

### PurchaseService
- getPurchaseLogs(itemId)
- getLatestPurchaseByItem(itemId)
- createPurchaseLog(purchaseData)
- createPurchaseLogFromImportCandidate(candidateId, confirmedByUserId)

### StockService
- calculateStockForItem(itemId)
- calculateAllStocks()
- saveStockSnapshot(stockData)
- getStockSnapshotList()

### StockCorrectionService
- correctStock(itemId, correctedQty, reason, note, correctedByUserId)
- getStockCorrectionLogs(itemId)

### ItemRuntimeStateService
- getRuntimeState(itemId)
- saveManualOverride(itemId, overrideData)
- clearManualOverride(itemId)
- saveSnooze(itemId, untilDate)
- clearSnooze(itemId)

### NotificationService
- resolveNotificationReason(stockData)
- hasRecentNotification(itemId, notificationType, targetUserId, days) ※将来再導入用に残置
- createNotificationRecord(itemId, notificationData)
- processAllNotifications() — 集約メッセージを生成し ReadyGo Inbox に投入
- getNotificationLogs(limit)

### SnoozeService
- snooze3Days(itemId, snoozedByUserId)
- snooze7Days(itemId, snoozedByUserId)
- snoozeIgnore(itemId, snoozedByUserId)
- clearSnooze(itemId)
- isSnoozed(itemId)

### ReadyGoBotService
- appendToInbox(body) — ReadyGo 側 Inbox シートに1行追加（失敗時もログ出力のみで例外を投げない）

### GmailImportService
- runMyGmailImport()
- importAmazonMails()
- importMatsukiyoMails()
- saveImportCandidate(candidateData)
- getImportCandidates()
- confirmImportCandidate(candidateId, matchedItemId, confirmedByUserId)
- ignoreImportCandidate(candidateId, ignoredByUserId)

### TriggerService
- createMyGmailImportTrigger()
- deleteMyGmailImportTrigger()
- hasMyGmailImportTrigger()
- getMyGmailImportStatus()

### WebController
- getInitialData()
- saveItem(formData)
- savePurchase(formData)
- getStockList()
- getImportCandidatesForView()
- saveGmailSettings(formData)
- enableMyGmailImport()
- disableMyGmailImport()
- saveStockCorrection(formData)
- snoozeNotification(formData)
- clearNotificationSnooze(itemId)

---

## 21. doGet 仕様

以下の page パラメータで切り替える。

- ?page=home
- ?page=items
- ?page=itemForm
- ?page=purchaseForm
- ?page=stocks
- ?page=importCandidates
- ?page=gmailSettings
- ?page=notifications
- ?page=stockCorrection

初期版は1ページ SPA 風でもよい

---

## 22. バリデーション
サーバー側で必須:

- 必須未入力
- 数値不正
- URL不正
- 存在しない item_id
- 存在しない user_id
- 不正日付
- 購入数の負数
- 削除済み item への誤登録防止
- 在庫補正値の負数防止
- スヌーズ日付の不正防止

---

## 23. エラーハンドリング
- ユーザー向けは短く分かりやすいメッセージ
- Logger に詳細を残す
- import_order_candidates.parse_result に parse エラー概要を残す
- Gmail 取込失敗時は設定画面に「再承認または再有効化を確認してください」と表示する
- ReadyGo Inbox 投入失敗は Logger.log に残しバッチは継続する
- UI では入力値をなるべく保持する

---

## 24. 同時実行対策
- シート書き込み系は LockService を使う
- 特に以下でロックを検討
  - createPurchaseLog
  - confirmImportCandidate
  - saveStockSnapshot
  - correctStock
  - saveManualOverride
  - saveSnooze
  - runMyGmailImport

---

## 25. セキュリティ
- 秘密情報は Script Properties に保存
- スプレッドシートに秘密情報を置かない
- 画面出力は適切にエスケープ
- Gmail の raw 本文全文を長期保存しない
- 保存するのは必要最小限の subject/snippet に留める
- Web アプリの公開対象は家族利用に必要な範囲に限定する

---

## 26. GAS運用上の注意
- 家族利用・MVP 規模であれば GAS で実現可能
- ただし Gmail 取込は全件走査せず、前回取込日時以降 + バッファに限定する
- Trigger は短すぎる間隔にしない
- 初期は 6時間ごとの Gmail 取込で十分とする
- 画面はシンプルに保ち、重い SPA 化は避ける
- Apps Script のクォータと実行時間を前提に設計する
- 初回認可時に未確認アプリ警告が出る可能性があることを運用上許容する

---

## 27. 実装優先順位

### フェーズ1
- シート初期化
- 家族ユーザー登録
- 消耗品 CRUD
- 論理削除
- 手動購入履歴登録
- 在庫予測一覧
- 在庫数しきい値通知
- 通知 ON/OFF
- 購入 URL ワンタップ導線
- item_runtime_state 導入
- 在庫補正
- スヌーズ

### フェーズ2
- 日次在庫計算バッチ（毎晩 20:00〜21:00）
- 通知理由表示
- notification_log
- ReadyGo Bot Inbox 投入
- inventory_effective_at の反映

### フェーズ3
- Gmail 自動取込設定画面
- 家族ごとの trigger 作成 / 削除
- Amazon メール候補取込
- マツキヨメール候補取込
- 候補確認 / 確定 / 無視
- ordered / shipped / counted の状態管理

### フェーズ4
- 取込精度改善
- shipment メール利用の精度向上
- UI 改善
- 通知重複防止の再導入（必要に応じて）

---

## 28. 受け入れ条件
以下を満たせば MVP 完了とする。

1. 家族複数人が同じ Web アプリを使える
2. 家族全員に共通スプレッドシート編集権を付与した前提で運用できる
3. スマホから消耗品を追加・編集できる
4. スマホから消耗品を論理削除できる
5. スマホから購入履歴を手動登録できる
6. 購入履歴に購入者を残せる
7. 在庫切れ予測日を一覧で確認できる
8. 消耗品ごとに「在庫が何個以下になったら通知するか」を設定できる
9. 推定残数がしきい値以下になった場合、通知対象にできる
10. 通知 ON/OFF を切り替えられる
11. 購入先URLを一覧や通知からすぐ開ける
12. 通知理由を確認できる
13. 通知をスヌーズできる
14. 在庫補正ができる
15. 各ユーザーが初回承認後に自分用 Gmail 自動取込 trigger を作れる
16. 各ユーザーの Gmail から Amazon / マツキヨの注文関連メールを候補として取り込める
17. 自動取込候補を確認・確定・無視できる
18. 確定した候補が purchase_log に反映される
19. 注文確認メールだけでは在庫へ反映しない
20. 発送通知メールを purchase_log 反映の起点にできる
21. `inventory_effective_at` 基準で在庫に加算できる
22. 新規アプリが通知対象を判定し、全アラート品目を1メッセージに集約して ReadyGo Bot Inbox に投入できる
23. ReadyGo Bot が当日 21:00 の LINE 通知に投入内容を追記して家族 LINE グループへ配信できる前提の構造になっている
24. 投入失敗時はバッチを継続させ、Logger.log に記録する

---

## 29. 将来的追加する機能

> 注: 29.3 / 29.6 / 29.7 / 29.9 / 29.11 は実装済みのため、本セクションから除外し [30 章 実装履歴](#30-実装履歴) に移動済み。元の節番号は欠番のまま残してある。

### 29.1 使用ペースの自動学習
概要:
- 過去の購入間隔や補正履歴を使って days_per_unit を自動補正する
目的:
- 手入力の消費日数設定を減らす
- 推定精度を上げる

### 29.2 家族ごとの担当割り当て
概要:
- 消耗品ごとに「この人が買う担当」を設定する
目的:
- 通知先の最適化
- 重複購入の防止

### 29.4 購入先ごとの標準購入数設定
概要:
- Amazonでは3個セット、マツキヨでは1個、店舗では2個など、購入先別に標準購入数を持てるようにする
目的:
- 自動取込後の在庫計算精度を上げる
- 購入先ごとの実態に合わせる

### 29.5 LINE からの簡易購入登録
概要:
- ReadyGo Bot のメッセージに対して「買った」「まだある」「後で再通知」などを返せるようにする
目的:
- Webアプリを開かずに操作できるようにする
- 運用負荷を減らす

### 29.8 レシート OCR
概要:
- 店舗購入のレシート写真から購入履歴候補を作る
目的:
- 手動登録の負担軽減
- 店舗購入データの自動化拡張

### 29.10 PWA対応
概要:
- Webアプリをホーム画面追加しやすくし、ネイティブアプリに近い使い勝手にする
目的:
- 日常利用のしやすさ向上

---

## 30. 実装履歴

「将来的追加する機能」（29章）として記載されていた機能のうち、実装が完了したものをここにまとめる。元の節番号と差分の概要を記録する。

### 30.1 ReadyGo Bot 連携への移行（2026年5月実装）
- 旧 `line_outbox` + 独自 LINE Bot から、既存の **ReadyGo Bot**（家族向け生活自動化Bot）経由配信に切り替え
- 通知は ReadyGo 側スプレッドシートの `Inbox` シートに1行追加する形式
- ReadyGo が 21:00 の夜次 LINE 通知の末尾に「📨 お知らせ」として追記して配信
- 通知モデルがユーザー別配信から **集約ブロードキャスト** に変更
- 日次バッチは朝 7:00 → 夜 20:00 へ移動
- `line_outbox` / `OutboxService` / `dedupe_key` / 重複チェックは廃止（重複防止は ReadyGo の `processed` フラグに委譲）
- 詳細は 2.1 「移行: LINE Bot 連携方式の変更」および 17 章「ReadyGo Bot 連携仕様」参照

### 30.2 ホーム画面アラートのユーザー別フィルタ（2026年5月実装）
- ホーム画面の在庫アラートを current_user の `notify_target_type` に応じて出し分け
- all → 全員に表示 / representative → admin のみ / specific_user → 指定ユーザーのみ
- current_user 不明時（users.email 未設定）はフォールバックで全件表示
- 在庫予測一覧・消耗品一覧などその他の画面は無条件で全件表示

### 30.3 在庫不明フラグ（元 29.6、2026年5月実装）
- `items.is_inventory_unknown` 列追加（boolean）
- フラグ ON の品目は `StockService.calculateStockForItem` 内で `alert_needed` を強制 false にしてアラート対象から除外
- 線形消費モデルが当てにならない品目（来客時のみ使用、季節用品など）向け
- 消耗品編集画面にチェックボックスを追加
- 視認用に消耗品一覧/在庫予測一覧で「在庫不明」バッジを表示

### 30.4 最近買った直後の通知抑止（元 29.7、2026年5月実装）
- `DEFAULTS.RECENT_PURCHASE_SUPPRESS_DAYS = 3` を導入（グローバル設定）
- `latestPurchase.inventory_effective_at`（在庫反映済み日）が直近 3 日以内なら `alert_needed` を強制 false
- ホーム画面アラート・ReadyGo 通知の両方に効く
- 抑止対象は `counted_in_inventory=true` の購入のみ

### 30.5 過去購入金額確認（元 29.11、2026年5月実装）
- `purchase_log.price` 列追加（「1箱（1セット）の単価」）
- Gmail 取込: 候補の `detected_price` をそのまま保存
- 手動登録: 購入登録フォームに「1箱の単価」入力欄追加
- 新規画面 [HtmlPurchaseHistory.html](src/HtmlPurchaseHistory.html) を追加
- 消耗品一覧の各カードに「履歴」ボタンから遷移
- 価格統計（最新/平均/最安/最高）を表示
- 既存購入履歴行は price 空欄のまま、新規購入分から記録開始

### 30.6 代替品登録（元 29.3、2026年5月実装）
- `items.alternatives` 列追加（JSON 文字列で複数の代替購入候補を保存）
- 1品目につき最大10件まで。各候補は {name, url, note}
- 編集画面に動的行追加 UI（+ボタンで追加、×で削除）
- 消耗品一覧・在庫予測一覧で「代替: 名前（メモ）」リンクを表示
- 在庫計算への影響なし（純粋な情報項目）

### 30.7 消耗品メモ欄の強化（元 29.9、2026年5月実装）
- `items.item_memo` 列追加（自由記述、最大1000文字、改行可）
- 「こだわり」「買う時の注意」「家族向けの伝達事項」など自由に記入
- 編集画面に textarea（最小高さ80px、縦リサイズ可）
- 消耗品一覧でメモ全文を表示（黄色の付箋風ボックス、改行保持）
- 在庫予測一覧では非表示（情報過多回避）
- 在庫計算への影響なし

---

## 31. Claude への依頼
この仕様を前提に、以下を順に作成してください。

1. シート初期化コード
2. appsscript.json
3. GAS サーバー側コード一式
4. HTML Service の画面コード一式
5. TriggerService 実装
6. GmailImportService 実装
7. AmazonMailParser と MatsukiyoMailParser の雛形
8. item_runtime_state を使った在庫補正 / スヌーズ実装
9. ReadyGoBotService による Inbox 投入実装と NotificationService の集約配信実装
10. inventory_effective_at を含む purchase_log 反映ロジック
11. セットアップ手順
12. デプロイ手順
13. テスト手順

コード方針:
- できるだけシンプル
- 関数責務を分ける
- コメントは丁寧に入れる
- 後で拡張しやすくする
- 家庭内の個人開発として保守しやすい形にする
- まずは確実に動く MVP を優先する