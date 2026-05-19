/**
 * NotificationService.gs
 * 通知判定 / 通知文面生成 / 通知ログ記録
 *
 * 仕様書 Section 15, 17, 20 (NotificationService) 準拠
 *
 * このサービスは LINE API を直接呼ばない。
 * ReadyGo Bot の Inbox に集約メッセージを投入し、notification_log に履歴を残すまでが責務。
 *
 * 通知対象条件:
 *   - items.is_active = TRUE
 *   - notification_enabled = TRUE
 *   - alert_needed = TRUE
 *   - item_runtime_state.snooze_until が過去または空
 *   - notify_target_type = 'all'（ReadyGo はブロードキャストのみ）
 *
 * 重複防止:
 *   - 現在は実施しない（毎日のバッチで同じ品目が出続けても再通知する）
 *   - 将来再導入する場合は hasRecentNotification と notification_log を流用する想定
 */

var NotificationService = (function() {

  /** 集約メッセージの送信先識別子（notification_log.target_user_id 用） */
  var BROADCAST_TARGET = 'broadcast';

  // ----------------------------------------------------------
  // 通知対象判定
  // ----------------------------------------------------------

  /**
   * 指定品目が ReadyGo 通知対象かどうか判定する
   *
   * @param {string} itemId
   * @param {Object} stockData StockService.calculateStockForItem の戻り値
   * @param {Object|null} runtimeState ItemRuntimeStateService.getRuntimeState の戻り値
   * @return {Object|null} 通知対象なら { item, reason }、対象外なら null
   * @private
   */
  function evaluateAlertTarget_(itemId, stockData, runtimeState) {
    if (!stockData || !stockData.has_purchase_history) return null;
    if (!toBool(stockData.alert_needed)) return null;

    var item = ItemService.getItemById(itemId);
    if (!item) return null;
    if (!toBool(item.is_active)) return null;
    if (!toBool(item.notification_enabled)) return null;

    // notify_target_type が all 以外は ReadyGo に流さない
    var targetType = toStr(item.notify_target_type) || ENUMS.NOTIFY_TARGET_TYPE.ALL;
    if (targetType !== ENUMS.NOTIFY_TARGET_TYPE.ALL) return null;

    // スヌーズ中なら通知しない
    if (runtimeState && runtimeState.snooze_until) {
      var until = parseDate(runtimeState.snooze_until);
      if (until && until > new Date()) {
        return null;
      }
    }

    var reason = resolveNotificationReason(stockData);
    return { item: item, reason: reason };
  }

  // ----------------------------------------------------------
  // 通知理由
  // ----------------------------------------------------------

  /**
   * 在庫計算結果から通知理由を解決する
   *
   * @param {Object} stockData
   * @return {string} ENUMS.NOTIFICATION_REASON のいずれか
   */
  function resolveNotificationReason(stockData) {
    var days = toBool(stockData.days_alert_needed);
    var qty = toBool(stockData.qty_alert_needed);

    if (days && qty) return ENUMS.NOTIFICATION_REASON.BOTH;
    if (days) return ENUMS.NOTIFICATION_REASON.DAYS;
    if (qty) return ENUMS.NOTIFICATION_REASON.QTY;
    return ENUMS.NOTIFICATION_REASON.DAYS; // フォールバック
  }

  // ----------------------------------------------------------
  // 重複チェック（将来再導入時用に残置。現フローでは呼ばない）
  // ----------------------------------------------------------

  /**
   * 指定期間内に同じ通知が送られていないか確認する
   *
   * @param {string} itemId
   * @param {string} notificationType 通知理由
   * @param {string} targetUserId 通知先ユーザー
   * @param {number} days チェック日数
   * @return {boolean} 直近に通知済みなら true
   */
  function hasRecentNotification(itemId, notificationType, targetUserId, days) {
    var cutoff = addDays(new Date(), -days);

    var recent = SheetRepository.findRows(SHEET_NAMES.NOTIFICATION_LOG, function(row) {
      if (String(row.item_id) !== String(itemId)) return false;
      if (String(row.notification_reason) !== String(notificationType)) return false;
      if (String(row.target_user_id) !== String(targetUserId)) return false;
      var createdAt = parseDate(row.created_at);
      return createdAt && createdAt >= cutoff;
    });

    return recent.length > 0;
  }

  // ----------------------------------------------------------
  // 通知文面生成
  // ----------------------------------------------------------

  /**
   * 単一品目の1行要約を生成する
   *
   * @param {Object} item 品目データ
   * @param {Object} stockData 在庫計算結果
   * @param {string} reason 通知理由
   * @return {string} 例: 「ティッシュ：残3日 / 約2個」
   * @private
   */
  function buildItemSummaryLine_(item, stockData, reason) {
    var name = toStr(item.item_name);
    var daysLeft = Math.round(toNumber(stockData.estimated_days_left));
    var remainQty = Math.round(toNumber(stockData.estimated_remaining_qty) * 10) / 10;
    var unit = toStr(item.unit);
    var remainStr = remainQty + (unit || '');

    switch (reason) {
      case ENUMS.NOTIFICATION_REASON.DAYS:
        return name + '：残' + daysLeft + '日';
      case ENUMS.NOTIFICATION_REASON.QTY:
        return name + '：しきい値以下 (残' + remainStr + ')';
      case ENUMS.NOTIFICATION_REASON.BOTH:
        return name + '：残' + daysLeft + '日 / 残' + remainStr;
      default:
        return name;
    }
  }

  /**
   * ReadyGo Inbox に投入する集約メッセージを生成する
   *
   * フォーマット:
   *   📦 在庫アラート (3件)
   *
   *   ・ティッシュ：残3日 / 約2個
   *   ・牛乳：残2日 / 約1.0L
   *
   *   → 在庫予測画面で確認
   *   https://script.google.com/.../exec?page=stocks
   *
   * @param {Object[]} alertTargets [{ item, stockData, reason }]
   * @return {string}
   * @private
   */
  function buildBroadcastMessage_(alertTargets) {
    var lines = [];
    lines.push('📦 在庫アラート (' + alertTargets.length + '件)');
    lines.push('');
    for (var i = 0; i < alertTargets.length; i++) {
      lines.push('・' + buildItemSummaryLine_(alertTargets[i].item, alertTargets[i].stockData, alertTargets[i].reason));
    }
    var url = getWebAppBaseUrl();
    if (url) {
      lines.push('');
      lines.push('→ 在庫予測画面で確認');
      lines.push(url + '?page=stocks');
    }
    return lines.join('\n');
  }

  // ----------------------------------------------------------
  // 通知レコード生成
  // ----------------------------------------------------------

  /**
   * notification_log にレコードを作成する
   *
   * @param {string} itemId
   * @param {Object} notificationData
   *   - notification_type {string}
   *   - notification_reason {string}
   *   - target_user_id {string}
   *   - outbox_id {string}
   *   - message {string}
   * @return {Object} 作成された通知ログ
   */
  function createNotificationRecord(itemId, notificationData) {
    var now = nowIso();
    var record = {
      notification_id: generatePrefixedId('NOTIF'),
      item_id: itemId,
      notification_type: toStr(notificationData.notification_type) || 'stock_alert',
      notification_reason: toStr(notificationData.notification_reason),
      target_user_id: toStr(notificationData.target_user_id),
      outbox_id: toStr(notificationData.outbox_id),
      message: toStr(notificationData.message),
      created_at: now
    };

    SheetRepository.appendRow(SHEET_NAMES.NOTIFICATION_LOG, record);
    return record;
  }

  // ----------------------------------------------------------
  // 一括通知処理（BatchController から呼ばれる）
  // ----------------------------------------------------------

  /**
   * 全品目について通知判定を行い、対象品目を ReadyGo Inbox に集約投入する
   *
   * 仕様:
   *   - notify_target_type = 'all' の品目のみ対象
   *   - 全アラート品目を1つのメッセージにまとめて1行 Inbox 投入
   *   - notification_log には品目ごとに記録（target_user_id = 'broadcast'）
   *   - 重複チェックは行わない（毎日のバッチで同じ品目が出続けても再通知する）
   *
   * @return {Object} { processed: number, alerts: number, notified: number, skipped: number }
   */
  function processAllNotifications() {
    var stocks = StockService.calculateAllStocks();
    var runtimeStates = ItemRuntimeStateService.getAllRuntimeStates();

    var alertTargets = [];
    var processed = 0;
    var skipped = 0;

    for (var i = 0; i < stocks.length; i++) {
      var stockData = stocks[i];
      var itemId = stockData.item_id;
      var runtimeState = runtimeStates[itemId] || null;

      processed++;

      var target = evaluateAlertTarget_(itemId, stockData, runtimeState);
      if (!target) {
        skipped++;
        continue;
      }

      alertTargets.push({
        item: target.item,
        stockData: stockData,
        reason: target.reason
      });
    }

    var notified = 0;

    if (alertTargets.length === 0) {
      Logger.log('[NotificationService] アラート対象なし。ReadyGo 投入はスキップ。');
    } else {
      var message = buildBroadcastMessage_(alertTargets);
      var success = ReadyGoBotService.appendToInbox(message);

      if (!success) {
        Logger.log('[NotificationService] ReadyGo 投入失敗のため notification_log は記録しません');
      } else {
        // 投入成功時のみ、品目ごとの履歴を残す
        for (var k = 0; k < alertTargets.length; k++) {
          var at = alertTargets[k];
          try {
            createNotificationRecord(at.item.item_id, {
              notification_type: 'stock_alert',
              notification_reason: at.reason,
              target_user_id: BROADCAST_TARGET,
              outbox_id: '',
              message: buildItemSummaryLine_(at.item, at.stockData, at.reason)
            });
            ItemRuntimeStateService.updateLastNotification(at.item.item_id, at.reason);
            notified++;
          } catch (e) {
            Logger.log('[NotificationService] notification_log 記録失敗: item=' + at.item.item_id + ' | ' + e.message);
          }
        }
      }
    }

    Logger.log('[NotificationService] 処理完了: processed=' + processed +
      ', alerts=' + alertTargets.length + ', notified=' + notified + ', skipped=' + skipped);

    return {
      processed: processed,
      alerts: alertTargets.length,
      notified: notified,
      skipped: skipped
    };
  }

  // ----------------------------------------------------------
  // 通知履歴取得
  // ----------------------------------------------------------

  /**
   * 通知履歴一覧を取得する（新しい順）
   * @param {number} [limit] 取得件数上限
   * @return {Object[]}
   */
  function getNotificationLogs(limit) {
    var rows = SheetRepository.getAllRows(SHEET_NAMES.NOTIFICATION_LOG);

    // 作成日時の降順
    rows.sort(function(a, b) {
      var da = parseDate(a.created_at);
      var db = parseDate(b.created_at);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db.getTime() - da.getTime();
    });

    if (limit && limit > 0) {
      return rows.slice(0, limit);
    }
    return rows;
  }

  // 公開API
  return {
    resolveNotificationReason: resolveNotificationReason,
    hasRecentNotification: hasRecentNotification,
    createNotificationRecord: createNotificationRecord,
    processAllNotifications: processAllNotifications,
    getNotificationLogs: getNotificationLogs
  };

})();
