/**
 * ItemRuntimeStateService.gs
 * 品目ごとの運用状態（在庫補正 / スヌーズ / 通知状態）を管理する
 *
 * 仕様書 Section 7.5, 14, 16, 20 (ItemRuntimeStateService) 準拠
 *
 * item_runtime_state は品目ごとに最大1行。
 * 在庫補正の「現在有効値」とスヌーズ状態を永続保持する。
 * 在庫計算時は stock_snapshot と組み合わせて参照する。
 */

var ItemRuntimeStateService = (function() {

  // ----------------------------------------------------------
  // 取得
  // ----------------------------------------------------------

  /**
   * 指定品目の runtime state を取得する
   * @param {string} itemId
   * @return {Object|null}
   */
  function getRuntimeState(itemId) {
    if (!itemId) return null;
    return SheetRepository.findRowById(
      SHEET_NAMES.ITEM_RUNTIME_STATE, 'item_id', itemId
    );
  }

  /**
   * 全品目の runtime state を取得する（バッチ用）
   * @return {Object} { item_id: runtimeStateObj, ... }
   */
  function getAllRuntimeStates() {
    var rows = SheetRepository.getAllRows(SHEET_NAMES.ITEM_RUNTIME_STATE);
    var map = {};
    for (var i = 0; i < rows.length; i++) {
      map[rows[i].item_id] = rows[i];
    }
    return map;
  }

  // ----------------------------------------------------------
  // 初期化
  // ----------------------------------------------------------

  /**
   * 指定品目の runtime state が存在しなければ初期行を作成する
   * ItemService.createItem から呼ばれる
   * @param {string} itemId
   */
  function ensureRuntimeState(itemId) {
    var existing = getRuntimeState(itemId);
    if (existing) return;

    var now = nowIso();
    SheetRepository.appendRow(SHEET_NAMES.ITEM_RUNTIME_STATE, {
      item_id: itemId,
      manual_override_qty: '',
      manual_override_at: '',
      manual_override_by_user_id: '',
      manual_override_reason: '',
      snooze_until: '',
      last_notification_reason: '',
      last_notification_at: '',
      updated_at: now
    });
  }

  // ----------------------------------------------------------
  // 在庫補正（manual override）
  // ----------------------------------------------------------

  /**
   * 在庫補正値を保存する
   *
   * @param {string} itemId
   * @param {Object} overrideData
   *   - manual_override_qty {number} 補正後の残数
   *   - manual_override_by_user_id {string}
   *   - manual_override_reason {string}
   * @return {boolean}
   */
  function saveManualOverride(itemId, overrideData) {
    return withLock(function() {
      ensureRuntimeState(itemId);

      var now = nowIso();
      SheetRepository.updateRowById(
        SHEET_NAMES.ITEM_RUNTIME_STATE, 'item_id', itemId,
        {
          manual_override_qty: toNumber(overrideData.manual_override_qty),
          manual_override_at: now,
          manual_override_by_user_id: toStr(overrideData.manual_override_by_user_id),
          manual_override_reason: toStr(overrideData.manual_override_reason),
          updated_at: now
        }
      );
      return true;
    });
  }

  /**
   * 在庫補正値をクリアする
   * 新しい購入登録時に呼ばれる
   * @param {string} itemId
   * @return {boolean}
   */
  function clearManualOverride(itemId) {
    var existing = getRuntimeState(itemId);
    if (!existing) return false;

    // override が設定されていない場合は何もしない
    if (existing.manual_override_qty === '' || existing.manual_override_qty === null) {
      return false;
    }

    SheetRepository.updateRowById(
      SHEET_NAMES.ITEM_RUNTIME_STATE, 'item_id', itemId,
      {
        manual_override_qty: '',
        manual_override_at: '',
        manual_override_by_user_id: '',
        manual_override_reason: '',
        updated_at: nowIso()
      }
    );
    return true;
  }

  // ----------------------------------------------------------
  // スヌーズ
  // ----------------------------------------------------------

  /**
   * スヌーズを設定する
   * @param {string} itemId
   * @param {string|Date} untilDate スヌーズ期限
   * @return {boolean}
   */
  function saveSnooze(itemId, untilDate) {
    return withLock(function() {
      ensureRuntimeState(itemId);

      var formatted = (untilDate instanceof Date) ? formatDateTime(untilDate) : toStr(untilDate);
      // Sheets が yyyy/MM/dd HH:mm を日付セルへ自動変換するのを防ぐため、
      // 先頭に ' を付けてテキスト強制で保存する（読み戻し時に ' は剥がれる）
      var until = formatted ? ("'" + formatted) : '';

      SheetRepository.updateRowById(
        SHEET_NAMES.ITEM_RUNTIME_STATE, 'item_id', itemId,
        {
          snooze_until: until,
          updated_at: nowIso()
        }
      );
      return true;
    });
  }

  /**
   * スヌーズをクリアする
   * @param {string} itemId
   * @return {boolean}
   */
  function clearSnooze(itemId) {
    var existing = getRuntimeState(itemId);
    if (!existing) return false;

    SheetRepository.updateRowById(
      SHEET_NAMES.ITEM_RUNTIME_STATE, 'item_id', itemId,
      {
        snooze_until: '',
        updated_at: nowIso()
      }
    );
    return true;
  }

  /**
   * 指定品目がスヌーズ中かどうか
   * @param {string} itemId
   * @return {boolean}
   */
  function isSnoozed(itemId) {
    var state = getRuntimeState(itemId);
    if (!state || !state.snooze_until) return false;

    var until = parseDate(state.snooze_until);
    if (!until) return false;

    return until > new Date();
  }

  // ----------------------------------------------------------
  // 通知状態更新
  // ----------------------------------------------------------

  /**
   * 最終通知状態を更新する
   * NotificationService から呼ばれる
   * @param {string} itemId
   * @param {string} reason 通知理由 (days_threshold / qty_threshold / both)
   */
  function updateLastNotification(itemId, reason) {
    ensureRuntimeState(itemId);

    SheetRepository.updateRowById(
      SHEET_NAMES.ITEM_RUNTIME_STATE, 'item_id', itemId,
      {
        last_notification_reason: reason,
        last_notification_at: nowIso(),
        updated_at: nowIso()
      }
    );
  }

  // ----------------------------------------------------------
  // ヘルパー
  // ----------------------------------------------------------

  /**
   * 在庫計算で使う「有効な補正値」を返す
   * 補正が設定されていなければ null
   * @param {string} itemId
   * @return {Object|null} { qty: number, at: Date } or null
   */
  function getEffectiveOverride(itemId) {
    var state = getRuntimeState(itemId);
    if (!state) return null;
    if (state.manual_override_qty === '' || state.manual_override_qty === null || state.manual_override_qty === undefined) {
      return null;
    }

    return {
      qty: toNumber(state.manual_override_qty),
      at: parseDate(state.manual_override_at)
    };
  }

  // 公開API���仕様書 Section 20 ��拠）
  return {
    getRuntimeState: getRuntimeState,
    getAllRuntimeStates: getAllRuntimeStates,
    ensureRuntimeState: ensureRuntimeState,
    saveManualOverride: saveManualOverride,
    clearManualOverride: clearManualOverride,
    saveSnooze: saveSnooze,
    clearSnooze: clearSnooze,
    isSnoozed: isSnoozed,
    updateLastNotification: updateLastNotification,
    getEffectiveOverride: getEffectiveOverride
  };

})();
