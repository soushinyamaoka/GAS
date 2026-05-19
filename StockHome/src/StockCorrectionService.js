/**
 * StockCorrectionService.gs
 * 在庫補正の実行と補正履歴の管理
 *
 * 仕様書 Section 5.8, 7.8, 9.11, 14, 20 (StockCorrectionService) 準拠
 *
 * 補正の流れ:
 *   1. 現在の推定残数を取得
 *   2. item_runtime_state に補正値を保存（ItemRuntimeStateService 経由）
 *   3. stock_correction_log に監査ログを追加
 *   4. 再計算時に manual_override_qty が使われる
 *
 * 補正理由（Section 14.3）:
 *   - still_have_more: まだ在庫がある
 *   - counted_actual_stock: 実数を数えた
 *   - wrong_import: 取り込みミスの修正
 *   - manual_adjustment: その他手動調整
 */

var StockCorrectionService = (function() {

  // ----------------------------------------------------------
  // 補正実行
  // ----------------------------------------------------------

  /**
   * 在庫補正を実行する
   *
   * @param {string} itemId 品目ID
   * @param {number} correctedQty 実際の残数（0以上）
   * @param {string} reason 補正理由（ENUMS.CORRECTION_REASON のいずれか）
   * @param {string} [note] メモ
   * @param {string} correctedByUserId 補��者の user_id
   * @return {Object} 作成された補正ログ
   */
  function correctStock(itemId, correctedQty, reason, note, correctedByUserId) {
    // バリデーション
    var v = Validation.validateStockCorrection({
      item_id: itemId,
      corrected_qty: correctedQty,
      correction_reason: reason
    });
    if (!v.valid) {
      throwUserError(v.errors.join('\n'));
    }

    // 品目の存在チェック
    var itemErr = Validation.requireActiveItem(itemId);
    if (itemErr) {
      throwUserError(itemErr);
    }

    return withLock(function() {
      // 現在の推定残数を取得（補正前の値として記録する）
      var beforeEstimatedQty = '';
      try {
        var currentStock = StockService.calculateStockForItem(itemId);
        if (currentStock.estimated_remaining_qty !== '') {
          beforeEstimatedQty = currentStock.estimated_remaining_qty;
        }
      } catch (e) {
        Logger.log('[StockCorrectionService] 補正前の推定残数取得失敗: ' + e.message);
      }

      var now = nowIso();
      var correctedQtyNum = toNumber(correctedQty);
      var userName = UserService.getUserName(correctedByUserId);

      // 1. item_runtime_state に補正値を保存
      ItemRuntimeStateService.saveManualOverride(itemId, {
        manual_override_qty: correctedQtyNum,
        manual_override_by_user_id: correctedByUserId,
        manual_override_reason: reason
      });

      // 2. stock_correction_log に監査ログを追加
      var correctionLog = {
        correction_id: generatePrefixedId('CORR'),
        item_id: itemId,
        corrected_at: now,
        corrected_by_user_id: correctedByUserId,
        corrected_by_user_name: userName,
        before_estimated_qty: beforeEstimatedQty,
        corrected_qty: correctedQtyNum,
        correction_reason: reason,
        note: toStr(note),
        created_at: now
      };

      SheetRepository.appendRow(SHEET_NAMES.STOCK_CORRECTION_LOG, correctionLog);

      Logger.log('[StockCorrectionService] 品目 ' + itemId +
        ' の在庫を補正: ' + beforeEstimatedQty + ' → ' + correctedQtyNum +
        ' (理由: ' + reason + ')');

      // 補正後の推定残数を即時 snapshot に反映（ホーム/在庫画面の古い値を防ぐ）
      StockService.refreshStockSnapshotForItem(itemId);

      return correctionLog;
    });
  }

  // ----------------------------------------------------------
  // 補正履歴取得
  // ----------------------------------------------------------

  /**
   * 指定品目の補正履歴を取得する（新しい順）
   * @param {string} itemId
   * @return {Object[]}
   */
  function getStockCorrectionLogs(itemId) {
    var rows = SheetRepository.findRows(SHEET_NAMES.STOCK_CORRECTION_LOG, function(row) {
      return String(row.item_id) === String(itemId);
    });

    // 補正日時の降順
    rows.sort(function(a, b) {
      var da = parseDate(a.corrected_at);
      var db = parseDate(b.corrected_at);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db.getTime() - da.getTime();
    });

    return rows;
  }

  /**
   * 全品目の補正履歴を取得する（新しい順）
   * @return {Object[]}
   */
  function getAllStockCorrectionLogs() {
    var rows = SheetRepository.getAllRows(SHEET_NAMES.STOCK_CORRECTION_LOG);

    rows.sort(function(a, b) {
      var da = parseDate(a.corrected_at);
      var db = parseDate(b.corrected_at);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db.getTime() - da.getTime();
    });

    return rows;
  }

  // 公開API（仕様書 Section 20 準拠）
  return {
    correctStock: correctStock,
    getStockCorrectionLogs: getStockCorrectionLogs,
    getAllStockCorrectionLogs: getAllStockCorrectionLogs
  };

})();
