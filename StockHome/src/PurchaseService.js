/**
 * PurchaseService.gs
 * 購入履歴の登録・取得
 *
 * 仕様書 Section 5.2, 7.3, 9.6, 11, 20 (PurchaseService) 準拠
 *
 * 判断事項:
 *   - 手動登録時の fulfillment_status は 'received'（手元に在庫がある前提）
 *   - 手動登録時の inventory_effective_at は purchased_at と同じ
 *   - 手動登録時の counted_in_inventory は即時 true
 *   - Gmail 取込候補からの反映時は fulfillment_status, shipped_at,
 *     inventory_effective_at を候補データから引き継ぐ
 *   - 在庫計算では counted_in_inventory = true かつ
 *     inventory_effective_at <= today のものだけ使う
 */

var PurchaseService = (function() {

  // ----------------------------------------------------------
  // 取得
  // ----------------------------------------------------------

  /**
   * 指定品目の購入履歴を取得する（新しい順）
   * @param {string} itemId
   * @return {Object[]}
   */
  function getPurchaseLogs(itemId) {
    var rows = SheetRepository.findRows(SHEET_NAMES.PURCHASE_LOG, function(row) {
      return String(row.item_id) === String(itemId);
    });
    // 購入日の降順でソート
    rows.sort(function(a, b) {
      var da = parseDate(a.purchased_at);
      var db = parseDate(b.purchased_at);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db.getTime() - da.getTime();
    });
    return rows;
  }

  /**
   * 指定品目の最新購入履歴を取得する
   * counted_in_inventory = true のもののみ対象
   * @param {string} itemId
   * @return {Object|null}
   */
  function getLatestPurchaseByItem(itemId) {
    var logs = getPurchaseLogs(itemId);
    for (var i = 0; i < logs.length; i++) {
      if (toBool(logs[i].counted_in_inventory)) {
        return logs[i];
      }
    }
    return null;
  }

  /**
   * 指定品目の「在庫有効な」購入履歴をすべて取得する
   * counted_in_inventory = true かつ inventory_effective_at <= today
   * @param {string} itemId
   * @return {Object[]}
   */
  function getEffectivePurchases(itemId) {
    var todayDate = today();
    return SheetRepository.findRows(SHEET_NAMES.PURCHASE_LOG, function(row) {
      if (String(row.item_id) !== String(itemId)) return false;
      if (!toBool(row.counted_in_inventory)) return false;
      var effectiveAt = parseDate(row.inventory_effective_at);
      if (!effectiveAt) return false;
      return effectiveAt <= todayDate;
    });
  }

  /**
   * 全購入履歴を取得する
   * @return {Object[]}
   */
  function getAllPurchaseLogs() {
    return SheetRepository.getAllRows(SHEET_NAMES.PURCHASE_LOG);
  }

  // ----------------------------------------------------------
  // 手動登録
  // ----------------------------------------------------------

  /**
   * 購入履歴を手動登録する
   *
   * @param {Object} purchaseData
   *   - item_id {string} 必須
   *   - purchased_at {string} 必須 (yyyy-MM-dd)
   *   - qty {number} 1以上
   *   - source {string} デフォルト 'manual'
   *   - purchased_by_user_id {string}
   *   - purchased_by_user_name {string}
   *   - note {string}
   * @return {Object} 作成された購入履歴
   */
  function createPurchaseLog(purchaseData) {
    // バリデーション
    var v = Validation.validatePurchase(purchaseData);
    if (!v.valid) {
      throwUserError(v.errors.join('\n'));
    }

    // 品目の存在・有効チェック
    var itemErr = Validation.requireActiveItem(purchaseData.item_id);
    if (itemErr) {
      throwUserError(itemErr);
    }

    return withLock(function() {
      var now = nowIso();
      var purchasedAt = toStr(purchaseData.purchased_at);

      // price は「1箱（=1セット）の単価」。空欄許可。
      var priceVal = (purchaseData.price !== '' && purchaseData.price !== null && purchaseData.price !== undefined)
        ? toNumber(purchaseData.price)
        : '';

      var newLog = {
        purchase_id: generatePrefixedId('PUR'),
        item_id: toStr(purchaseData.item_id),
        purchased_at: purchasedAt,
        qty: toInt(purchaseData.qty, 1),
        price: priceVal,
        source: toStr(purchaseData.source) || ENUMS.SOURCE.MANUAL,
        source_type: toStr(purchaseData.source_type) || ENUMS.SOURCE_TYPE.MANUAL,
        external_vendor: '',
        external_order_id: '',
        import_candidate_id: '',
        purchased_by_user_id: toStr(purchaseData.purchased_by_user_id),
        purchased_by_user_name: toStr(purchaseData.purchased_by_user_name),
        note: toStr(purchaseData.note),
        // 手動登録 = 手元にある前提
        fulfillment_status: ENUMS.FULFILLMENT_STATUS.RECEIVED,
        shipped_at: '',
        inventory_effective_at: purchasedAt,
        counted_in_inventory: true,
        created_at: now,
        updated_at: now
      };

      SheetRepository.appendRow(SHEET_NAMES.PURCHASE_LOG, newLog);

      // 購入登録後に在庫補正の override をクリアする
      // （新しい購入が入ったので手動補正値は古くなるため）
      try {
        ItemRuntimeStateService.clearManualOverride(purchaseData.item_id);
      } catch (e) {
        Logger.log('[PurchaseService] override クリア時の警告: ' + e.message);
      }

      // 在庫 snapshot を即時更新（ホーム/在庫画面の古いアラート表示を防ぐ）
      StockService.refreshStockSnapshotForItem(purchaseData.item_id);

      return newLog;
    });
  }

  // ----------------------------------------------------------
  // Gmail 取込候補からの反映
  // ----------------------------------------------------------

  /**
   * 自動取込候補から purchase_log を作成する
   *
   * 仕様書 Section 10.6, 11.3, 11.4:
   *   - 候補 confirmed 時に purchase_log へ反映
   *   - fulfillment_status, shipped_at を候補データから引き継ぐ
   *   - inventory_effective_at は候補データの配送完了日 or shipped_at + buffer
   *
   * @param {string} candidateId 候補ID
   * @param {string} matchedItemId 紐付けた消耗品ID
   * @param {string} confirmedByUserId 確定したユーザーID
   * @return {Object} 作成された購入履歴
   */
  function createPurchaseLogFromImportCandidate(candidateId, matchedItemId, confirmedByUserId, sourceType) {
    // 品目の存在チェック
    var itemErr = Validation.requireActiveItem(matchedItemId);
    if (itemErr) {
      throwUserError(itemErr);
    }

    return withLock(function() {
      // 候補データを取得
      var candidate = SheetRepository.findRowById(
        SHEET_NAMES.IMPORT_ORDER_CANDIDATES, 'candidate_id', candidateId
      );
      if (!candidate) {
        throwUserError('指定された取込候補が見つかりません。');
      }

      var now = nowIso();

      // purchase_log.qty は「個数」。candidate.detected_qty は「セット数」。
      // 1セット = default_purchase_qty 個 として個数に換算する。
      // 例: default_purchase_qty=5 のティッシュを 2セット購入 → qty = 2 × 5 = 10
      var item = ItemService.getItemById(matchedItemId) || {};
      var multiplier = Math.max(1, toInt(item.default_purchase_qty, 1));
      var qty = toInt(candidate.detected_qty, 1) * multiplier;

      // inventory_effective_at の決定（仕様書 Section 11.4）
      var inventoryEffectiveAt = resolveInventoryEffectiveAt_(candidate);

      // counted_in_inventory: inventory_effective_at <= today なら true
      var effectiveDate = parseDate(inventoryEffectiveAt);
      var todayDate = today();
      var countedInInventory = effectiveDate ? (effectiveDate <= todayDate) : false;

      // price は候補の detected_price（Amazon メール上の「1箱の単価」）をそのまま使う
      // 取得できなかった場合は空欄
      var detectedPriceVal = toStr(candidate.detected_price).replace(/,/g, '');
      var priceVal = (detectedPriceVal && !isNaN(Number(detectedPriceVal)))
        ? Number(detectedPriceVal)
        : '';

      var newLog = {
        purchase_id: generatePrefixedId('PUR'),
        item_id: matchedItemId,
        purchased_at: formatDate(parseDate(candidate.mail_date) || new Date()),
        qty: qty,
        price: priceVal,
        source: ENUMS.SOURCE.GMAIL,
        source_type: sourceType || ENUMS.SOURCE_TYPE.GMAIL_AUTO,
        external_vendor: toStr(candidate.vendor),
        external_order_id: toStr(candidate.order_id),
        import_candidate_id: candidateId,
        purchased_by_user_id: confirmedByUserId,
        purchased_by_user_name: UserService.getUserName(confirmedByUserId),
        note: '自動取込: ' + toStr(candidate.item_name_raw),
        fulfillment_status: toStr(candidate.fulfillment_status) || ENUMS.FULFILLMENT_STATUS.SHIPPED,
        shipped_at: formatDate(parseDate(candidate.mail_date) || new Date()),
        inventory_effective_at: inventoryEffectiveAt,
        counted_in_inventory: countedInInventory,
        created_at: now,
        updated_at: now
      };

      SheetRepository.appendRow(SHEET_NAMES.PURCHASE_LOG, newLog);

      // counted_in_inventory=true（即時反映）の場合は snapshot も更新する
      if (countedInInventory) {
        StockService.refreshStockSnapshotForItem(matchedItemId);
      }

      return newLog;
    });
  }

  /**
   * inventory_effective_at を決定する
   *
   * 仕様書 Section 11.4 の優先順:
   *   1. 配送完了日が取得できればその日
   *   2. shipped_at + default_delivery_buffer_days
   *   3. いずれもなければ注文日 + buffer
   *
   * @param {Object} candidate 候補データ
   * @return {string} yyyy-MM-dd
   * @private
   */
  function resolveInventoryEffectiveAt_(candidate) {
    var bufferDays = getDeliveryBufferDays();

    // 1. 発送日がある場合: shipped_at + buffer
    var shippedAt = parseDate(candidate.mail_date);
    if (candidate.mail_phase === ENUMS.MAIL_PHASE.SHIPPED && shippedAt) {
      return formatDate(addDays(shippedAt, bufferDays));
    }

    // 2. 注文日 + buffer（フォールバック）
    var mailDate = parseDate(candidate.mail_date);
    if (mailDate) {
      return formatDate(addDays(mailDate, bufferDays));
    }

    // 3. 最終フォールバック: 今日 + buffer
    return formatDate(addDays(today(), bufferDays));
  }

  // ----------------------------------------------------------
  // counted_in_inventory の定期更新
  // ----------------------------------------------------------

  /**
   * inventory_effective_at <= today の purchase_log で
   * まだ counted_in_inventory = false のものを true に更新する
   *
   * 日次バッチから呼ばれる想定
   * @return {number} 更新した件数
   */
  function updateCountedInInventory() {
    var todayDate = today();
    var allLogs = SheetRepository.getAllRows(SHEET_NAMES.PURCHASE_LOG);
    var count = 0;

    for (var i = 0; i < allLogs.length; i++) {
      var log = allLogs[i];
      if (toBool(log.counted_in_inventory)) continue;

      var effectiveAt = parseDate(log.inventory_effective_at);
      if (effectiveAt && effectiveAt <= todayDate) {
        SheetRepository.updateRowById(
          SHEET_NAMES.PURCHASE_LOG, 'purchase_id', log.purchase_id,
          {
            counted_in_inventory: true,
            updated_at: nowIso()
          }
        );
        count++;
      }
    }

    if (count > 0) {
      Logger.log('[PurchaseService] counted_in_inventory を ' + count + ' 件更新しました。');
    }

    return count;
  }

  // ----------------------------------------------------------
  // 価格集計
  // ----------------------------------------------------------

  /**
   * 指定品目の price 統計を計算する（履歴画面用）
   * price が空欄の行は集計対象から除外する
   *
   * @param {string} itemId
   * @return {Object} { count, min, max, avg, latest } いずれも数値、無効時は null
   */
  function getPriceStatsByItem(itemId) {
    var logs = getPurchaseLogs(itemId);
    var prices = [];
    var latest = null;

    for (var i = 0; i < logs.length; i++) {
      var p = logs[i].price;
      if (p === '' || p === null || p === undefined) continue;
      var n = Number(p);
      if (isNaN(n) || n < 0) continue;
      prices.push(n);
      if (latest === null) latest = n; // logs は新しい順なので先頭が最新
    }

    if (prices.length === 0) {
      return { count: 0, min: null, max: null, avg: null, latest: null };
    }

    var min = prices[0];
    var max = prices[0];
    var sum = 0;
    for (var j = 0; j < prices.length; j++) {
      if (prices[j] < min) min = prices[j];
      if (prices[j] > max) max = prices[j];
      sum += prices[j];
    }

    return {
      count: prices.length,
      min: min,
      max: max,
      avg: Math.round((sum / prices.length) * 10) / 10,
      latest: latest
    };
  }

  // 公開API（仕様書 Section 20 準拠）
  return {
    getPurchaseLogs: getPurchaseLogs,
    getLatestPurchaseByItem: getLatestPurchaseByItem,
    getEffectivePurchases: getEffectivePurchases,
    getAllPurchaseLogs: getAllPurchaseLogs,
    createPurchaseLog: createPurchaseLog,
    createPurchaseLogFromImportCandidate: createPurchaseLogFromImportCandidate,
    updateCountedInInventory: updateCountedInInventory,
    getPriceStatsByItem: getPriceStatsByItem
  };

})();
