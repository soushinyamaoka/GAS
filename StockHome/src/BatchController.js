/**
 * BatchController.gs
 * 日次バッチ / ユーザー別 Gmail 取込のエントリーポイント
 *
 * 仕様書 Section 18, 19 (BatchController) 準拠
 *
 * バッチ処理は installable trigger から呼ばれる。
 * 日次バッチ: runDailyBatch()
 *   1. counted_in_inventory の定期更新
 *   2. 全品目の在庫計算 → stock_snapshot 更新
 *   3. 通知判定 → ReadyGo Bot の Inbox に集約メッセージ投入
 *
 * ユーザー別 Gmail 取込: runMyGmailImport()
 *   各ユーザーの trigger が実行。GmailImportService に委譲。
 */

// ============================================================
// 日次バッチ（1日1回、朝に実行）
// ============================================================

/**
 * 日次バッチのメイン関数
 * installable trigger から呼ばれる
 *
 * 処理順序（Section 18.1）:
 *   1. inventory_effective_at が到来した purchase_log の counted_in_inventory を更新
 *   2. 有効な全消耗品の在庫を計算
 *   3. stock_snapshot を更新
 *   4. item_runtime_state を参照して通知対象を抽出
 *   5. スヌーズ確認
 *   6. ReadyGo Bot の Inbox に集約メッセージを投入
 *   7. notification_log を更新
 *
 * ステップ 4〜7 は NotificationService.processAllNotifications() に集約。
 */
function runDailyBatch() {
  Logger.log('=== 日次バッチ開始 ===');
  var startTime = new Date();

  try {
    // Step 1: counted_in_inventory の定期更新
    Logger.log('[Batch] Step 1: counted_in_inventory 更新');
    var updatedCount = PurchaseService.updateCountedInInventory();
    Logger.log('[Batch] → ' + updatedCount + ' 件の在庫有効フラグを更新');

    // Step 2-3: 全品目の在庫計算 & snapshot 保存
    Logger.log('[Batch] Step 2-3: 在庫計算 & snapshot 保存');
    var stocks = StockService.calculateAndSaveAllStocks();
    Logger.log('[Batch] → ' + stocks.length + ' 件の在庫 snapshot を更新');

    // Step 4-7: 通知判定 & ReadyGo Inbox 投入
    Logger.log('[Batch] Step 4-7: 通知判定 & ReadyGo Inbox 投入');
    var notifResult = NotificationService.processAllNotifications();
    Logger.log('[Batch] → 処理=' + notifResult.processed +
      ', アラート=' + notifResult.alerts +
      ', 通知=' + notifResult.notified +
      ', スキップ=' + notifResult.skipped);

    var elapsed = (new Date().getTime() - startTime.getTime()) / 1000;
    Logger.log('=== 日次バッチ完了 (' + elapsed + '秒) ===');

  } catch (e) {
    Logger.log('[Batch] エラー発生: ' + e.message);
    Logger.log(e.stack);
  }
}

// ============================================================
// ユーザー別 Gmail 取込バッチ
// ============================================================

/**
 * ユーザー別 Gmail 取込のメイン関数
 * 各ユーザーの installable trigger から呼ばれる
 *
 * 処理順序（Section 18.2）:
 *   1. 実行ユーザーの Gmail を検索
 *   2. 未処理メール抽出
 *   3. vendor 判定
 *   4. parser 実行
 *   5. import_order_candidates に保存
 *   6. User Properties に最終取込日時保存
 *
 * 実装本体は GmailImportService に委譲する。
 */
function runMyGmailImport() {
  Logger.log('=== Gmail 取込バッチ開始 ===');
  var startTime = new Date();

  try {
    // 現在の実行ユーザーを特定
    var email = '';
    try {
      email = Session.getActiveUser().getEmail();
    } catch (e) {
      Logger.log('[GmailBatch] メールアドレス取得失敗: ' + e.message);
    }
    Logger.log('[GmailBatch] 実行ユーザー: ' + (email || '不明'));

    // GmailImportService に委譲
    // Phase 3 で実装予定。ここでは存在チェックのみ。
    if (typeof GmailImportService !== 'undefined' && GmailImportService.runMyGmailImport) {
      var result = GmailImportService.runMyGmailImport();
      Logger.log('[GmailBatch] 取込結果: ' + JSON.stringify(result));
    } else {
      Logger.log('[GmailBatch] GmailImportService が未実装のためスキップ');
    }

    var elapsed = (new Date().getTime() - startTime.getTime()) / 1000;
    Logger.log('=== Gmail 取込バッチ完了 (' + elapsed + '秒) ===');

  } catch (e) {
    Logger.log('[GmailBatch] エラー発生: ' + e.message);
    Logger.log(e.stack);
  }
}

// ============================================================
// 在庫再計算（手動実行用）
// ============================================================

/**
 * 在庫の再計算のみ実行する（通知なし）
 * 管理画面やデバッグで使う
 */
function runStockRecalculation() {
  Logger.log('=== 在庫再計算開始 ===');

  try {
    // counted_in_inventory の更新
    PurchaseService.updateCountedInInventory();

    // 在庫計算 & snapshot 保存
    var stocks = StockService.calculateAndSaveAllStocks();
    Logger.log('[Recalc] ' + stocks.length + ' 件の在庫を再計算しました');

  } catch (e) {
    Logger.log('[Recalc] エラー: ' + e.message);
  }

  Logger.log('=== 在庫再計算完了 ===');
}

// ============================================================
// 日次バッチ trigger の作成・削除
// ============================================================

/**
 * 日次バッチ用の trigger を作成する
 * GAS エディタから手動実行する
 *
 * 毎晩 20:00〜21:00 に runDailyBatch を実行する。
 * ReadyGo Bot が 21:00 に LINE 通知を送る仕組みのため、その直前に
 * 在庫計算とアラート投入が完了している必要がある。
 */
function createDailyBatchTrigger() {
  // 既存の日次バッチ trigger を確認
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDailyBatch') {
      Logger.log('日次バッチ trigger は既に存在します。');
      return;
    }
  }

  ScriptApp.newTrigger('runDailyBatch')
    .timeBased()
    .atHour(20)
    .everyDays(1)
    .create();

  Logger.log('日次バッチ trigger を作成しました（毎晩 20:00〜21:00）');
}

/**
 * 日次バッチ用の trigger を削除する
 */
function deleteDailyBatchTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDailyBatch') {
      ScriptApp.deleteTrigger(triggers[i]);
      deleted++;
    }
  }
  Logger.log('日次バッチ trigger を ' + deleted + ' 件削除しました。');
}

/**
 * 配送バッファ日数を app_config に設定する（GAS エディタから手動実行用）
 * @param {number} days
 */
function setDeliveryBufferDays(days) {
  var n = parseInt(days, 10);
  if (isNaN(n) || n < 0) {
    throw new Error('days は 0 以上の整数で指定してください。');
  }
  setAppConfigValue('default_delivery_buffer_days', String(n));
  Logger.log('配送バッファ日数を ' + n + ' に更新しました。');
}

/**
 * 配送バッファを 0 にする（ワンショット用）
 */
function setDeliveryBufferDaysToZero() {
  setDeliveryBufferDays(0);
}
