/**
 * WebController.gs
 * HTML Service のクライアントから google.script.run で呼ばれる関数群
 *
 * 仕様書 Section 20 (WebController) 準拠
 *
 * 全関数は try-catch で囲み、統一レスポンス形式で返す。
 * { success: boolean, data: any, message: string }
 */

// ============================================================
// 初期データ / ホーム
// ============================================================

/**
 * 値を google.script.run でシリアライズ可能な形に正規化する
 * Date → 文字列、undefined/null → ''、その他はそのまま
 */
function sanitizeRow_(row) {
  if (!row) return null;
  var out = {};
  for (var k in row) {
    var v = row[k];
    if (v instanceof Date) {
      out[k] = Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    } else if (v === undefined || v === null) {
      out[k] = '';
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      out[k] = v;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * 品目の notify_target_type 設定に応じて、current_user に対し
 * ホーム画面アラートを表示すべきかを判定する
 *
 * @param {Object} item items シートの行
 * @param {Object|null} currentUser UserService.getCurrentUser の戻り値
 * @return {boolean}
 */
function isAlertVisibleToCurrentUser_(item, currentUser) {
  // current_user 不明（email 未設定等）の場合は全件表示（フォールバック）
  if (!currentUser) return true;

  var targetType = toStr(item.notify_target_type) || ENUMS.NOTIFY_TARGET_TYPE.ALL;

  switch (targetType) {
    case ENUMS.NOTIFY_TARGET_TYPE.ALL:
      return true;
    case ENUMS.NOTIFY_TARGET_TYPE.REPRESENTATIVE:
      return toStr(currentUser.role) === ENUMS.ROLE.ADMIN;
    case ENUMS.NOTIFY_TARGET_TYPE.SPECIFIC_USER:
      return toStr(currentUser.user_id) === toStr(item.notify_target_user_id);
    default:
      return true;
  }
}

/**
 * ホーム画面の初期データを返す
 *
 * 在庫アラートは current_user の notify_target_type 設定に応じてフィルタする:
 *   - all          : 全ユーザーに表示
 *   - representative: admin ロールのみ表示
 *   - specific_user: notify_target_user_id 一致ユーザーのみ表示
 * current_user が特定できない場合（email 未設定など）はフォールバックで全件表示。
 */
function getInitialData() {
  try {
    var currentUser = UserService.getCurrentUser();
    var pendingCandidates = GmailImportService.getImportCandidates(false);
    var uid = currentUser ? currentUser.user_id : '';
    pendingCandidates = pendingCandidates.filter(function(c) {
      var owner = c.imported_by_user_id;
      return !owner || owner === uid;
    });

    // item_id → item の全項目マップ（notify_target_type 判定で使う）
    var itemMap = {};
    var items = ItemService.getActiveItems();
    for (var i = 0; i < items.length; i++) {
      itemMap[items[i].item_id] = items[i];
    }

    // まず全アラートを取得し、current_user 視点で表示すべきものだけに絞る
    var allAlerts = StockService.getAlertStocks(999);
    var visibleAlerts = allAlerts.filter(function(s) {
      var item = itemMap[s.item_id];
      if (!item) return false;
      return isAlertVisibleToCurrentUser_(item, currentUser);
    });
    var alertStocks = visibleAlerts.slice(0, 5);

    var enrichedStocks = alertStocks.map(function(s) {
      var clean = sanitizeRow_(s);
      var item = itemMap[s.item_id];
      clean.item_name = item ? item.item_name : '';
      return clean;
    });

    var safeUsers = UserService.getUsers().map(sanitizeRow_);

    return successResponse({
      currentUser: sanitizeRow_(currentUser),
      alertStocks: enrichedStocks,
      pendingCandidateCount: pendingCandidates.length,
      users: safeUsers
    });
  } catch (e) {
    Logger.log('[WebController] getInitialData error: ' + e.message);
    return errorResponse(e.message);
  }
}

// ============================================================
// ユーザー
// ============================================================

/** ユーザー一覧 */
function getUsers() {
  try {
    var users = UserService.getUsers().map(sanitizeRow_);
    return successResponse(users);
  } catch (e) { return errorResponse(e.message); }
}

/** ユーザー登録/更新 */
function saveUser(formData) {
  try {
    var user = UserService.createOrUpdateUser(formData);
    return successResponse(user, '保存しました。');
  } catch (e) { return errorResponse(e.message); }
}

// ============================================================
// 消耗品
// ============================================================

/**
 * 品目レコードに JSON 文字列の alternatives を parse して付与する
 * sanitizeRow_ 後に呼ぶ前提
 */
function withParsedAlternatives_(row) {
  if (!row) return row;
  row.alternatives = ItemService.parseAlternatives(row.alternatives);
  return row;
}

/** 消耗品一覧 */
function getItemList(includeInactive) {
  try {
    var items = ItemService.getItems(includeInactive).map(function(r) {
      return withParsedAlternatives_(sanitizeRow_(r));
    });
    return successResponse(items);
  } catch (e) { return errorResponse(e.message); }
}

/** 消耗品1件取得 */
function getItemById(itemId) {
  try {
    var item = ItemService.getItemById(itemId);
    if (!item) return errorResponse('品目が見つかりません。');
    return successResponse(withParsedAlternatives_(sanitizeRow_(item)));
  } catch (e) { return errorResponse(e.message); }
}

/** 消耗品登録/更新 */
function saveItem(formData) {
  try {
    var result;
    if (formData.item_id) {
      result = ItemService.updateItem(formData.item_id, formData);
    } else {
      result = ItemService.createItem(formData);
    }
    return successResponse(result, '保存しました。');
  } catch (e) { return errorResponse(e.message); }
}

/** 消耗品論理削除 */
function deleteItem(itemId) {
  try {
    var user = UserService.getCurrentUser();
    var uid = user ? user.user_id : '';
    ItemService.deleteItemLogical(itemId, uid);
    return successResponse(null, '削除しました。');
  } catch (e) { return errorResponse(e.message); }
}

/** 通知ON/OFF切替 */
function toggleItemNotification(itemId, enabled) {
  try {
    ItemService.updateItemNotificationEnabled(itemId, enabled);
    return successResponse(null, enabled ? '通知ONにしました。' : '通知OFFにしました。');
  } catch (e) { return errorResponse(e.message); }
}

// ============================================================
// 購入履歴
// ============================================================

/** 購入登録 */
function savePurchase(formData) {
  try {
    var user = UserService.getCurrentUser();
    if (user) {
      formData.purchased_by_user_id = formData.purchased_by_user_id || user.user_id;
      formData.purchased_by_user_name = formData.purchased_by_user_name || user.user_name;
    }
    var log = PurchaseService.createPurchaseLog(formData);
    return successResponse(log, '購入を登録しました。');
  } catch (e) { return errorResponse(e.message); }
}

/** 購入履歴画面用: 指定品目の購入履歴と価格統計を取得 */
function getPurchaseHistoryForItem(itemId) {
  try {
    var item = ItemService.getItemById(itemId);
    if (!item) return errorResponse('品目が見つかりません。');

    var logs = PurchaseService.getPurchaseLogs(itemId);
    var safeLogs = logs.map(function(log) {
      return sanitizeRow_({
        purchase_id: log.purchase_id,
        purchased_at: log.purchased_at,
        qty: log.qty,
        price: log.price,
        source: log.source,
        external_vendor: log.external_vendor,
        purchased_by_user_name: log.purchased_by_user_name,
        note: log.note,
        fulfillment_status: log.fulfillment_status,
        inventory_effective_at: log.inventory_effective_at,
        counted_in_inventory: log.counted_in_inventory,
        created_at: log.created_at
      });
    });

    var stats = PurchaseService.getPriceStatsByItem(itemId);

    return successResponse({
      item: sanitizeRow_({
        item_id: item.item_id,
        item_name: item.item_name,
        unit: item.unit,
        default_purchase_qty: item.default_purchase_qty
      }),
      logs: safeLogs,
      stats: stats
    });
  } catch (e) { return errorResponse(e.message); }
}

// ============================================================
// 在庫予測
// ============================================================

/** 在庫予測一覧 */
function getStockList() {
  try {
    // 最新の計算を実行してから返す
    var stocks = StockService.calculateAllStocks();

    var itemMap = {};
    var runtimeMap = ItemRuntimeStateService.getAllRuntimeStates();
    var items = ItemService.getActiveItems();
    for (var i = 0; i < items.length; i++) {
      itemMap[items[i].item_id] = items[i];
    }

    var result = stocks.map(function(s) {
      var item = itemMap[s.item_id] || {};
      var rs = runtimeMap[s.item_id] || {};
      // sanitizeRow_ で Date を文字列化（snooze_until 等が Date 化していた場合の保険）
      var clean = sanitizeRow_({
        item_id: s.item_id,
        item_name: item.item_name || '',
        category: item.category || '',
        unit: item.unit || '',
        purchase_url: item.purchase_url || '',
        notification_enabled: item.notification_enabled,
        is_inventory_unknown: item.is_inventory_unknown,
        latest_purchase_date: s.latest_purchase_date,
        latest_purchase_qty: s.latest_purchase_qty,
        estimated_remaining_qty: s.estimated_remaining_qty,
        estimated_days_left: s.estimated_days_left,
        predicted_out_of_stock_date: s.predicted_out_of_stock_date,
        low_stock_threshold_qty: s.low_stock_threshold_qty,
        days_alert_needed: s.days_alert_needed,
        qty_alert_needed: s.qty_alert_needed,
        alert_needed: s.alert_needed,
        has_purchase_history: s.has_purchase_history,
        snooze_until: rs.snooze_until || '',
        manual_override_qty: rs.manual_override_qty
      });
      // 代替品は JSON 文字列のまま渡らないよう配列化
      clean.alternatives = ItemService.parseAlternatives(item.alternatives);
      return clean;
    });

    // 在庫切れが近い順
    result.sort(function(a, b) {
      var da = (a.estimated_days_left !== '' && a.estimated_days_left !== null)
        ? Number(a.estimated_days_left) : 99999;
      var db = (b.estimated_days_left !== '' && b.estimated_days_left !== null)
        ? Number(b.estimated_days_left) : 99999;
      return da - db;
    });

    return successResponse(result);
  } catch (e) {
    Logger.log('[WebController] getStockList error: ' + e.message);
    return errorResponse(e.message);
  }
}

// ============================================================
// 在庫補正
// ============================================================

/** 在庫補正 */
function saveStockCorrection(formData) {
  try {
    var user = UserService.getCurrentUser();
    var uid = user ? user.user_id : '';
    var log = StockCorrectionService.correctStock(
      formData.item_id,
      formData.corrected_qty,
      formData.correction_reason,
      formData.note || '',
      uid
    );
    return successResponse(log, '在庫を補正しました。');
  } catch (e) { return errorResponse(e.message); }
}

/** 補正用: 品目の現在推定残数を取得 */
function getStockForCorrection(itemId) {
  try {
    var stock = StockService.calculateStockForItem(itemId);
    var item = ItemService.getItemById(itemId);
    return successResponse({
      item_id: itemId,
      item_name: item ? item.item_name : '',
      unit: item ? item.unit : '',
      estimated_remaining_qty: stock.estimated_remaining_qty
    });
  } catch (e) { return errorResponse(e.message); }
}

// ============================================================
// スヌーズ
// ============================================================

/** スヌーズ設定 */
function snoozeNotification(formData) {
  try {
    var user = UserService.getCurrentUser();
    var uid = user ? user.user_id : '';
    var action = formData.action || '';

    switch (action) {
      case '3days':
        SnoozeService.snooze3Days(formData.item_id, uid);
        return successResponse(null, '3日間スヌーズしました。');
      case '7days':
        SnoozeService.snooze7Days(formData.item_id, uid);
        return successResponse(null, '7日間スヌーズしました。');
      case 'ignore':
        SnoozeService.snoozeIgnore(formData.item_id, uid);
        return successResponse(null, '今回は無視しました。');
      default:
        return errorResponse('不正なアクションです。');
    }
  } catch (e) { return errorResponse(e.message); }
}

/** スヌーズ解除 */
function clearNotificationSnooze(itemId) {
  try {
    SnoozeService.clearSnooze(itemId);
    return successResponse(null, 'スヌーズを解除しました。');
  } catch (e) { return errorResponse(e.message); }
}

// ============================================================
// Gmail 取込候補
// ============================================================

/** 候補一覧（自分が取り込んだもの + imported_by_user_id が空の既存データのみ） */
function getImportCandidatesForView() {
  try {
    Logger.log('[getImportCandidatesForView] start');
    var candidates = GmailImportService.getImportCandidates(false);
    Logger.log('[getImportCandidatesForView] candidates=' + candidates.length);
    var user = UserService.getCurrentUser();
    var uid = user ? user.user_id : '';
    var filtered = candidates.filter(function(c) {
      var owner = c.imported_by_user_id;
      return !owner || owner === uid;
    });
    var items = ItemService.getActiveItems();
    Logger.log('[getImportCandidatesForView] filtered=' + filtered.length + ' items=' + items.length);

    // Date オブジェクトや undefined を含まない安全な形に正規化
    var safeCandidates = filtered.map(function(c) {
      var out = {};
      for (var k in c) {
        var v = c[k];
        if (v instanceof Date) {
          out[k] = Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
        } else if (v === undefined || v === null) {
          out[k] = '';
        } else {
          out[k] = String(v);
        }
      }
      return out;
    });
    var safeItems = items.map(function(it) {
      return { item_id: String(it.item_id || ''), item_name: String(it.item_name || ''), unit: String(it.unit || '') };
    });
    Logger.log('[getImportCandidatesForView] returning OK');
    return successResponse({ candidates: safeCandidates, items: safeItems });
  } catch (e) {
    Logger.log('[getImportCandidatesForView] ERROR ' + e.message + ' ' + e.stack);
    return errorResponse(e.message);
  }
}

/** 自動確定済み候補の一覧 */
function getAutoConfirmedCandidates() {
  try {
    var user = UserService.getCurrentUser();
    var uid = user ? user.user_id : '';
    var candidates = GmailImportService.getAutoConfirmedCandidates(50);
    candidates = candidates.filter(function(c) {
      var owner = c.imported_by_user_id;
      return !owner || owner === uid;
    }).slice(0, 20);
    var itemMap = {};
    var items = ItemService.getItems(true);
    for (var i = 0; i < items.length; i++) {
      itemMap[items[i].item_id] = {
        name: items[i].item_name,
        is_active: toBool(items[i].is_active)
      };
    }
    // purchase_log から import_candidate_id → log を引けるマップを構築
    var purchaseMap = {};
    var allLogs = PurchaseService.getAllPurchaseLogs();
    for (var p = 0; p < allLogs.length; p++) {
      var cid = toStr(allLogs[p].import_candidate_id);
      if (cid) purchaseMap[cid] = allLogs[p];
    }
    var safe = candidates.map(function(c) {
      var out = {};
      for (var k in c) {
        var v = c[k];
        if (v instanceof Date) {
          out[k] = Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
        } else if (v === undefined || v === null) {
          out[k] = '';
        } else {
          out[k] = String(v);
        }
      }
      var matched = itemMap[c.matched_item_id];
      out.matched_item_name = matched ? matched.name : '';
      out.matched_item_deleted = matched ? !matched.is_active : false;
      var pl = purchaseMap[toStr(c.candidate_id)];
      if (pl) {
        var effDate = parseDate(pl.inventory_effective_at);
        out.inventory_effective_at = effDate ? formatDate(effDate) : '';
        out.counted_in_inventory = toBool(pl.counted_in_inventory);
        out.purchase_qty = toInt(pl.qty, 0);
      } else {
        out.inventory_effective_at = '';
        out.counted_in_inventory = false;
        out.purchase_qty = 0;
      }
      return out;
    });
    return successResponse(safe);
  } catch (e) { return errorResponse(e.message); }
}

/** 候補確定 */
function confirmCandidate(candidateId, matchedItemId) {
  try {
    var user = UserService.getCurrentUser();
    var uid = user ? user.user_id : '';
    var result = GmailImportService.confirmImportCandidate(candidateId, matchedItemId, uid);
    return successResponse(result, '候補を確定し購入履歴に反映しました。');
  } catch (e) { return errorResponse(e.message); }
}

/** 候補無視 */
function ignoreCandidate(candidateId) {
  try {
    var user = UserService.getCurrentUser();
    var uid = user ? user.user_id : '';
    GmailImportService.ignoreImportCandidate(candidateId, uid);
    return successResponse(null, '候補を無視しました。');
  } catch (e) { return errorResponse(e.message); }
}

// ============================================================
// Gmail 設定
// ============================================================

/** Gmail 設定取得 */
function getGmailSettings() {
  try {
    var status = TriggerService.getMyGmailImportStatus();
    return successResponse(status);
  } catch (e) { return errorResponse(e.message); }
}

/** Gmail 設定保存 */
function saveGmailSettings(formData) {
  try {
    TriggerService.saveSearchQueries(formData);
    return successResponse(null, '検索条件を保存しました。');
  } catch (e) { return errorResponse(e.message); }
}

/** Gmail 自動取込 有効化 */
function enableMyGmailImport() {
  try {
    var result = TriggerService.createMyGmailImportTrigger();
    return successResponse(result, result.message);
  } catch (e) { return errorResponse(e.message); }
}

/** Gmail 自動取込 無効化 */
function disableMyGmailImport() {
  try {
    var result = TriggerService.deleteMyGmailImportTrigger();
    return successResponse(result, result.message);
  } catch (e) { return errorResponse(e.message); }
}

/** Gmail 今すぐ実行 */
function runGmailImportNow() {
  try {
    var result = GmailImportService.runMyGmailImport();
    return successResponse(result, 'Gmail 取込を実行しました。Amazon: ' + result.amazon + '件, マツキヨ: ' + result.matsukiyo + '件');
  } catch (e) { return errorResponse(e.message); }
}

// ============================================================
// 通知履歴
// ============================================================

/** 通知履歴一覧 */
function getNotificationList() {
  try {
    var logs = NotificationService.getNotificationLogs(50);

    var itemMap = {};
    var items = ItemService.getItems(true);
    for (var j = 0; j < items.length; j++) {
      itemMap[items[j].item_id] = items[j].item_name;
    }

    // notification_log は ReadyGo 投入成功時のみ記録されるため、
    // ここに載っている = 送信済 と扱う
    var result = logs.map(function(log) {
      return sanitizeRow_({
        notification_id: log.notification_id,
        item_id: log.item_id,
        item_name: itemMap[log.item_id] || '',
        notification_reason: log.notification_reason,
        message: log.message,
        created_at: log.created_at
      });
    });

    return successResponse(result);
  } catch (e) { return errorResponse(e.message); }
}

// ============================================================
// ユーティリティ（URL生成）
// ============================================================

/** ページ遷移用 URL を生成する */
function getPageUrl(page, params) {
  var base = getWebAppBaseUrl() || ScriptApp.getService().getUrl();
  var url = base + '?page=' + page;
  if (params) {
    for (var key in params) {
      url += '&' + key + '=' + encodeURIComponent(params[key]);
    }
  }
  return url;
}
