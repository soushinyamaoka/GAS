/**
 * StockService.gs
 * 在庫計算 / stock_snapshot の保存・取得
 *
 * 仕様書 Section 5.5, 7.4, 13, 20 (StockService) 準拠
 *
 * 在庫計算ロジック（Section 13.1）:
 *   1. counted_in_inventory = true の購入履歴だけを使う
 *   2. item_runtime_state.manual_override_qty がある場合は
 *      その値を「現在残数の基準」として優先する
 *   3. override がない場合:
 *      - 最新購入日からの経過日数を計算
 *      - 推定消費量 = 経過日数 / days_per_unit
 *      - 推定残数 = 最新購入数量 - 推定消費量
 *   4. override がある場合:
 *      - 補正日時からの経過日数を計算
 *      - 推定消費量 = 経過日数 / days_per_unit
 *      - 推定残数 = override_qty - 推定消費量
 *   5. 推定残数が負なら 0
 *   6. 推定残日数 = max(0, 推定残数 * days_per_unit)
 *   7. 在庫切れ予測日 = 今日 + 推定残日数
 */

var StockService = (function() {

  // ----------------------------------------------------------
  // 在庫計算（1品目）
  // ----------------------------------------------------------

  /**
   * 指定品目の在庫を計算する
   *
   * @param {string} itemId
   * @return {Object} 在庫計算結果
   *   - item_id
   *   - calculated_at
   *   - latest_purchase_date
   *   - latest_purchase_qty
   *   - estimated_remaining_qty
   *   - estimated_days_left
   *   - predicted_out_of_stock_date
   *   - low_stock_threshold_qty
   *   - days_alert_needed
   *   - qty_alert_needed
   *   - alert_needed
   *   - has_purchase_history {boolean} 計算に使える購入履歴があるか
   */
  function calculateStockForItem(itemId) {
    var item = ItemService.getItemById(itemId);
    if (!item) {
      throwUserError('品目が見つかりません: ' + itemId);
    }

    var daysPerUnit = toNumber(item.days_per_unit, 1);
    var leadDays = toNumber(item.lead_days, 0);
    var safetyDays = toNumber(item.safety_days, 0);
    var lowStockThresholdQty = item.low_stock_threshold_qty !== ''
      ? toNumber(item.low_stock_threshold_qty, null)
      : null;

    var todayDate = today();
    var nowStr = nowIso();

    // デフォルト結果（購入履歴なし）
    var result = {
      item_id: itemId,
      calculated_at: nowStr,
      latest_purchase_date: '',
      latest_purchase_qty: '',
      estimated_remaining_qty: '',
      estimated_days_left: '',
      predicted_out_of_stock_date: '',
      low_stock_threshold_qty: lowStockThresholdQty !== null ? lowStockThresholdQty : '',
      days_alert_needed: false,
      qty_alert_needed: false,
      alert_needed: false,
      has_purchase_history: false
    };

    // 在庫補正の有効値を確認
    var override = ItemRuntimeStateService.getEffectiveOverride(itemId);

    // 最新の有効な購入履歴を取得
    var latestPurchase = PurchaseService.getLatestPurchaseByItem(itemId);

    if (!latestPurchase && !override) {
      // 購入履歴もなく、補正もなければ在庫不明
      return result;
    }

    result.has_purchase_history = true;

    // --- 推定残数の計算 ---
    var estimatedRemainingQty;
    var latestPurchaseDate;
    var latestPurchaseQty;

    if (override && override.at) {
      // 補正値がある場合: 補正日時からの消費を計算（Section 14.2）
      var daysSinceOverride = Math.max(0, diffDays(todayDate, override.at));
      var consumedSinceOverride = daysSinceOverride / daysPerUnit;
      estimatedRemainingQty = override.qty - consumedSinceOverride;

      // latest_purchase 情報は参考値として保持
      if (latestPurchase) {
        latestPurchaseDate = toStr(latestPurchase.purchased_at);
        latestPurchaseQty = toNumber(latestPurchase.qty);
      } else {
        latestPurchaseDate = '';
        latestPurchaseQty = '';
      }

    } else if (latestPurchase) {
      // 通常計算: 最新購入日からの消費（Section 13.1）
      latestPurchaseDate = toStr(latestPurchase.purchased_at);
      latestPurchaseQty = toNumber(latestPurchase.qty);

      var purchaseDate = parseDate(latestPurchaseDate);
      if (!purchaseDate) {
        return result;
      }

      var daysSincePurchase = Math.max(0, diffDays(todayDate, purchaseDate));
      var consumed = daysSincePurchase / daysPerUnit;
      estimatedRemainingQty = latestPurchaseQty - consumed;

    } else {
      return result;
    }

    // 推定残数が負なら 0（Section 13.6）
    estimatedRemainingQty = Math.max(0, estimatedRemainingQty);
    // 小数第2位で丸める
    estimatedRemainingQty = Math.round(estimatedRemainingQty * 100) / 100;

    // 推定残日数 = max(0, 推定残数 * days_per_unit)（Section 13.1）
    var estimatedDaysLeft = Math.max(0, estimatedRemainingQty * daysPerUnit);
    estimatedDaysLeft = Math.round(estimatedDaysLeft * 10) / 10;

    // 在庫切れ予測日
    var predictedOutOfStockDate = formatDate(addDays(todayDate, estimatedDaysLeft));

    // --- 通知判定 ---

    // 日数ベース通知判定（Section 13.3）
    var daysAlertNeeded = estimatedDaysLeft <= (leadDays + safetyDays);

    // 数量ベース通知判定（Section 13.4）
    var qtyAlertNeeded = false;
    if (lowStockThresholdQty !== null) {
      qtyAlertNeeded = estimatedRemainingQty <= lowStockThresholdQty;
    }

    // 最終通知判定（Section 13.5）
    var alertNeeded = daysAlertNeeded || qtyAlertNeeded;

    // 在庫不明フラグが立っている品目はアラート対象から除外
    // 自動推定が当てにならない品目（来客時のみ使用、季節用品など）向け
    if (toBool(item.is_inventory_unknown)) {
      daysAlertNeeded = false;
      qtyAlertNeeded = false;
      alertNeeded = false;
    }

    // 最近購入後の通知抑止: 直近の購入から RECENT_PURCHASE_SUPPRESS_DAYS 日以内は
    // アラートを抑止する（買った直後に「もう買え」と言われないように）
    // 在庫反映済み日（inventory_effective_at）基準
    if (alertNeeded && latestPurchase) {
      var effectiveAt = parseDate(latestPurchase.inventory_effective_at);
      if (effectiveAt) {
        var daysSinceEffective = diffDays(todayDate, effectiveAt);
        if (daysSinceEffective >= 0 && daysSinceEffective < DEFAULTS.RECENT_PURCHASE_SUPPRESS_DAYS) {
          daysAlertNeeded = false;
          qtyAlertNeeded = false;
          alertNeeded = false;
        }
      }
    }

    result.latest_purchase_date = latestPurchaseDate || '';
    result.latest_purchase_qty = latestPurchaseQty !== undefined ? latestPurchaseQty : '';
    result.estimated_remaining_qty = estimatedRemainingQty;
    result.estimated_days_left = estimatedDaysLeft;
    result.predicted_out_of_stock_date = predictedOutOfStockDate;
    result.days_alert_needed = daysAlertNeeded;
    result.qty_alert_needed = qtyAlertNeeded;
    result.alert_needed = alertNeeded;

    return result;
  }

  // ----------------------------------------------------------
  // 全品目一括計算
  // ----------------------------------------------------------

  /**
   * 有効な全品目の在庫を計算する
   * @return {Object[]} 在庫計算結果の配列
   */
  function calculateAllStocks() {
    var activeItems = ItemService.getActiveItems();
    var results = [];

    for (var i = 0; i < activeItems.length; i++) {
      try {
        var stock = calculateStockForItem(activeItems[i].item_id);
        results.push(stock);
      } catch (e) {
        Logger.log('[StockService] 品目 ' + activeItems[i].item_id + ' の在庫計算失敗: ' + e.message);
      }
    }

    return results;
  }

  // ----------------------------------------------------------
  // stock_snapshot 保存
  // ----------------------------------------------------------

  /**
   * 指定品目の在庫を再計算し、stock_snapshot に即時反映する
   * 書き込み系処理（購入登録、在庫補正、候補確定）の直後に呼ぶことで
   * ホーム画面や在庫一覧の古いアラート表示を防ぐ
   * @param {string} itemId
   * @return {Object|null} 更新後の stock データ
   */
  function refreshStockSnapshotForItem(itemId) {
    try {
      var stock = calculateStockForItem(itemId);
      saveStockSnapshot(stock);
      return stock;
    } catch (e) {
      Logger.log('[StockService] snapshot 即時更新失敗: ' + itemId + ' | ' + e.message);
      return null;
    }
  }

  /**
   * 在庫計算結果を stock_snapshot に保存する（upsert）
   * item_id ごとに1行の最新状態を保持する
   *
   * @param {Object} stockData calculateStockForItem の戻り値
   */
  function saveStockSnapshot(stockData) {
    withLock(function() {
      var snapshotRow = {
        item_id: stockData.item_id,
        calculated_at: stockData.calculated_at,
        latest_purchase_date: stockData.latest_purchase_date,
        latest_purchase_qty: stockData.latest_purchase_qty,
        estimated_remaining_qty: stockData.estimated_remaining_qty,
        estimated_days_left: stockData.estimated_days_left,
        predicted_out_of_stock_date: stockData.predicted_out_of_stock_date,
        low_stock_threshold_qty: stockData.low_stock_threshold_qty,
        days_alert_needed: stockData.days_alert_needed,
        qty_alert_needed: stockData.qty_alert_needed,
        alert_needed: stockData.alert_needed,
        updated_at: nowIso()
      };

      SheetRepository.upsertRowById(
        SHEET_NAMES.STOCK_SNAPSHOT, 'item_id', stockData.item_id, snapshotRow
      );
    });
  }

  /**
   * 全品目の在庫を計算し、snapshot に一括保存する
   * @return {Object[]} 保存した在庫計算結果
   */
  function calculateAndSaveAllStocks() {
    var stocks = calculateAllStocks();

    for (var i = 0; i < stocks.length; i++) {
      try {
        saveStockSnapshot(stocks[i]);
      } catch (e) {
        Logger.log('[StockService] snapshot 保存失敗: ' + stocks[i].item_id + ' | ' + e.message);
      }
    }

    Logger.log('[StockService] ' + stocks.length + ' 件の在庫 snapshot を更新しました。');
    return stocks;
  }

  // ----------------------------------------------------------
  // stock_snapshot 取得
  // ----------------------------------------------------------

  /**
   * stock_snapshot の一覧を取得する
   * 在庫切れが近い順にソート
   * @return {Object[]}
   */
  function getStockSnapshotList() {
    var rows = SheetRepository.getAllRows(SHEET_NAMES.STOCK_SNAPSHOT);

    // estimated_days_left の昇順でソート（在庫切れが近い順）
    rows.sort(function(a, b) {
      var da = toNumber(a.estimated_days_left, 99999);
      var db = toNumber(b.estimated_days_left, 99999);
      return da - db;
    });

    return rows;
  }

  /**
   * 指定品目の stock_snapshot を取得する
   * @param {string} itemId
   * @return {Object|null}
   */
  function getStockSnapshot(itemId) {
    return SheetRepository.findRowById(SHEET_NAMES.STOCK_SNAPSHOT, 'item_id', itemId);
  }

  /**
   * 在庫切れが近い品目の上位を取得する（ホーム画面用）
   * @param {number} [limit=5] 取得件数
   * @return {Object[]}
   */
  function getAlertStocks(limit) {
    var max = limit || 5;
    var snapshots = getStockSnapshotList();

    // 有効な品目のみ対象（削除済みを除外）
    var activeMap = {};
    var activeItems = ItemService.getActiveItems();
    for (var a = 0; a < activeItems.length; a++) {
      activeMap[activeItems[a].item_id] = true;
    }

    var alertItems = [];
    for (var i = 0; i < snapshots.length && alertItems.length < max; i++) {
      var s = snapshots[i];
      if (!activeMap[s.item_id]) continue;
      if (s.estimated_remaining_qty === '' || s.estimated_remaining_qty === null) continue;
      if (!toBool(s.alert_needed)) continue;
      alertItems.push(s);
    }

    return alertItems;
  }

  // 公開API（仕様書 Section 20 準拠）
  return {
    calculateStockForItem: calculateStockForItem,
    calculateAllStocks: calculateAllStocks,
    saveStockSnapshot: saveStockSnapshot,
    refreshStockSnapshotForItem: refreshStockSnapshotForItem,
    calculateAndSaveAllStocks: calculateAndSaveAllStocks,
    getStockSnapshotList: getStockSnapshotList,
    getStockSnapshot: getStockSnapshot,
    getAlertStocks: getAlertStocks
  };

})();
