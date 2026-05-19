/**
 * ItemService.gs
 * 消耗品マスタの CRUD / 論理削除 / 通知設定
 *
 * 仕様書 Section 5.1, 7.2, 9.4, 9.5, 20 (ItemService) 準拠
 *
 * 判断事項:
 *   - lead_days, safety_days は空欄時 0 として扱う
 *   - notify_target_type のデフォルトは 'all'
 *   - notification_enabled のデフォルトは true
 */

var ItemService = (function() {

  // ----------------------------------------------------------
  // 代替品ヘルパー
  // ----------------------------------------------------------

  /**
   * フォーム/API からの alternatives 入力を正規化して JSON 文字列を返す
   * 受け取れる形式:
   *   - Array of {name, url, note}
   *   - JSON 文字列
   *   - 空欄 (undefined / null / '')
   * 名前が空の行は除外、最大10件まで
   *
   * @param {*} value
   * @return {string} JSON 文字列（保存用）
   * @private
   */
  function normalizeAlternativesForStorage_(value) {
    if (!value) return '';

    var arr = null;
    if (Array.isArray(value)) {
      arr = value;
    } else if (typeof value === 'string') {
      try {
        var parsed = JSON.parse(value);
        if (Array.isArray(parsed)) arr = parsed;
      } catch (e) {
        return ''; // 不正な JSON は空扱い
      }
    }
    if (!arr) return '';

    var cleaned = [];
    for (var i = 0; i < arr.length && cleaned.length < 10; i++) {
      var row = arr[i] || {};
      var name = toStr(row.name).substring(0, 200);
      if (!name) continue; // 名前なしは捨てる
      cleaned.push({
        name: name,
        url: toStr(row.url).substring(0, 500),
        note: toStr(row.note).substring(0, 200)
      });
    }
    return cleaned.length === 0 ? '' : JSON.stringify(cleaned);
  }

  /**
   * シートから読み出した alternatives（JSON 文字列）を配列に戻す
   * @param {string} value
   * @return {Object[]} [{name, url, note}, ...]
   */
  function parseAlternatives(value) {
    var s = toStr(value);
    if (!s) return [];
    try {
      var parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  // ----------------------------------------------------------
  // 取得
  // ----------------------------------------------------------

  /**
   * 消耗品一覧を取得する
   * @param {boolean} [includeInactive=false] 無効品目も含めるか
   * @return {Object[]}
   */
  function getItems(includeInactive) {
    if (includeInactive) {
      return SheetRepository.getAllRows(SHEET_NAMES.ITEMS);
    }
    return getActiveItems();
  }

  /**
   * 有効な消耗品のみ取得する
   * @return {Object[]}
   */
  function getActiveItems() {
    return SheetRepository.findRows(SHEET_NAMES.ITEMS, function(row) {
      return toBool(row.is_active);
    });
  }

  /**
   * item_id で1件取得する
   * @param {string} itemId
   * @return {Object|null}
   */
  function getItemById(itemId) {
    if (!itemId) return null;
    return SheetRepository.findRowById(SHEET_NAMES.ITEMS, 'item_id', itemId);
  }

  /**
   * 商品名の部分一致でアクティブな品目を検索する
   * @param {string} rawName メールから抽出した商品名
   * @return {Object[]} マッチした品目の配列
   */
  function findItemsByPartialMatch(rawName) {
    if (!rawName) return [];
    var normalized = rawName.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.length < 2) return [];

    return getActiveItems().filter(function(item) {
      var itemName = toStr(item.item_name).toLowerCase();
      if (!itemName) return false;
      return normalized.indexOf(itemName) !== -1 || itemName.indexOf(normalized) !== -1;
    });
  }

  // ----------------------------------------------------------
  // 作成
  // ----------------------------------------------------------

  /**
   * 消耗品を新規登録する
   *
   * @param {Object} itemData フォームデータ
   *   - item_name {string} 必須
   *   - category {string}
   *   - unit {string}
   *   - default_purchase_qty {number} 1以上
   *   - days_per_unit {number} 1以上
   *   - lead_days {number} 0以上
   *   - safety_days {number} 0以上
   *   - low_stock_threshold_qty {number|''} 空許容
   *   - purchase_url {string} 空許容
   *   - notify_target_type {string} all / representative / specific_user
   *   - notify_target_user_id {string}
   *   - notification_enabled {boolean}
   * @return {Object} 作成された消耗品
   */
  function createItem(itemData) {
    var v = Validation.validateItem(itemData);
    if (!v.valid) {
      throwUserError(v.errors.join('\n'));
    }

    // 有効な品目との重複チェック（大小・前後空白を無視）
    var normalized = toStr(itemData.item_name).toLowerCase();
    if (normalized) {
      var dup = getActiveItems().filter(function(it) {
        return toStr(it.item_name).toLowerCase() === normalized;
      });
      if (dup.length > 0) {
        throwUserError('同じ品名の消耗品が既に登録されています: ' + toStr(itemData.item_name));
      }
    }

    var now = nowIso();
    var newItem = {
      item_id: generatePrefixedId('ITEM'),
      item_name: toStr(itemData.item_name),
      category: toStr(itemData.category),
      unit: toStr(itemData.unit),
      default_purchase_qty: toInt(itemData.default_purchase_qty, 1),
      days_per_unit: toNumber(itemData.days_per_unit, 1),
      lead_days: toInt(itemData.alert_before_days, 0),
      safety_days: 0,
      low_stock_threshold_qty: itemData.low_stock_threshold_qty !== '' && itemData.low_stock_threshold_qty !== null && itemData.low_stock_threshold_qty !== undefined
        ? toNumber(itemData.low_stock_threshold_qty)
        : '',
      purchase_url: toStr(itemData.purchase_url),
      alternatives: normalizeAlternativesForStorage_(itemData.alternatives),
      item_memo: toStr(itemData.item_memo).substring(0, 1000),
      notify_target_type: toStr(itemData.notify_target_type) || ENUMS.NOTIFY_TARGET_TYPE.ALL,
      notify_target_user_id: toStr(itemData.notify_target_user_id),
      notification_enabled: itemData.notification_enabled !== undefined
        ? toBool(itemData.notification_enabled)
        : true,
      is_inventory_unknown: toBool(itemData.is_inventory_unknown),
      is_active: true,
      deleted_at: '',
      deleted_by: '',
      created_at: now,
      updated_at: now
    };

    SheetRepository.appendRow(SHEET_NAMES.ITEMS, newItem);

    // 対応する item_runtime_state も初期行を作成する
    ItemRuntimeStateService.ensureRuntimeState(newItem.item_id);

    return newItem;
  }

  // ----------------------------------------------------------
  // 更新
  // ----------------------------------------------------------

  /**
   * 消耗品を更新する
   *
   * @param {string} itemId
   * @param {Object} itemData 更新フィールド
   * @return {Object} 更新後の消耗品
   */
  function updateItem(itemId, itemData) {
    var existing = getItemById(itemId);
    if (!existing) {
      throwUserError('指定された品目が見つかりません。');
    }
    if (!toBool(existing.is_active)) {
      throwUserError('この品目は削除されています。');
    }

    var v = Validation.validateItem(itemData);
    if (!v.valid) {
      throwUserError(v.errors.join('\n'));
    }

    // 他の有効品目との名称重複チェック（自分自身は除外）
    var normalized = toStr(itemData.item_name).toLowerCase();
    if (normalized) {
      var dup = getActiveItems().filter(function(it) {
        return toStr(it.item_id) !== toStr(itemId) &&
          toStr(it.item_name).toLowerCase() === normalized;
      });
      if (dup.length > 0) {
        throwUserError('同じ品名の消耗品が既に登録されています: ' + toStr(itemData.item_name));
      }
    }

    var now = nowIso();
    var updateObj = {
      item_name: toStr(itemData.item_name),
      category: toStr(itemData.category),
      unit: toStr(itemData.unit),
      default_purchase_qty: toInt(itemData.default_purchase_qty, 1),
      days_per_unit: toNumber(itemData.days_per_unit, 1),
      lead_days: toInt(itemData.alert_before_days, 0),
      safety_days: 0,
      low_stock_threshold_qty: itemData.low_stock_threshold_qty !== '' && itemData.low_stock_threshold_qty !== null && itemData.low_stock_threshold_qty !== undefined
        ? toNumber(itemData.low_stock_threshold_qty)
        : '',
      purchase_url: toStr(itemData.purchase_url),
      alternatives: itemData.alternatives !== undefined
        ? normalizeAlternativesForStorage_(itemData.alternatives)
        : toStr(existing.alternatives),
      item_memo: itemData.item_memo !== undefined
        ? toStr(itemData.item_memo).substring(0, 1000)
        : toStr(existing.item_memo),
      notify_target_type: toStr(itemData.notify_target_type) || existing.notify_target_type,
      notify_target_user_id: toStr(itemData.notify_target_user_id),
      notification_enabled: itemData.notification_enabled !== undefined
        ? toBool(itemData.notification_enabled)
        : toBool(existing.notification_enabled),
      is_inventory_unknown: itemData.is_inventory_unknown !== undefined
        ? toBool(itemData.is_inventory_unknown)
        : toBool(existing.is_inventory_unknown),
      updated_at: now
    };

    SheetRepository.updateRowById(SHEET_NAMES.ITEMS, 'item_id', itemId, updateObj);

    // 在庫アラートに関わるフィールド（is_inventory_unknown, days_per_unit,
    // low_stock_threshold_qty, lead_days, safety_days 等）の変更を
    // ホーム画面アラートに即座に反映するため、stock_snapshot を再計算する
    StockService.refreshStockSnapshotForItem(itemId);

    return getItemById(itemId);
  }

  // ----------------------------------------------------------
  // 論理削除
  // ----------------------------------------------------------

  /**
   * 消耗品を論理削除する
   *
   * 仕様書: is_active = FALSE, deleted_at, deleted_by を更新
   *
   * @param {string} itemId
   * @param {string} deletedByUserId 削除実行者の user_id
   * @return {boolean} 成功したら true
   */
  function deleteItemLogical(itemId, deletedByUserId) {
    var existing = getItemById(itemId);
    if (!existing) {
      throwUserError('指定された品目が見つかりません。');
    }
    if (!toBool(existing.is_active)) {
      throwUserError('この品目は既に削除されています。');
    }

    var now = nowIso();
    SheetRepository.updateRowById(SHEET_NAMES.ITEMS, 'item_id', itemId, {
      is_active: false,
      deleted_at: now,
      deleted_by: deletedByUserId || '',
      updated_at: now
    });

    // 削除に伴う後片付け（エラーが出ても本体の削除は成立させたいので個別に try/catch）
    try {
      // 在庫補正値とスヌーズをクリア（再登録時に古い状態が残らないようにする）
      ItemRuntimeStateService.clearManualOverride(itemId);
      ItemRuntimeStateService.clearSnooze(itemId);
    } catch (e) {
      Logger.log('[ItemService] runtime_state クリア時の警告: ' + e.message);
    }

    return true;
  }

  // ----------------------------------------------------------
  // 通知 ON/OFF
  // ----------------------------------------------------------

  /**
   * 品目の通知有効/無効を切り替える
   * @param {string} itemId
   * @param {boolean} enabled
   * @return {boolean}
   */
  function updateItemNotificationEnabled(itemId, enabled) {
    var existing = getItemById(itemId);
    if (!existing) {
      throwUserError('指定された品目が見つかりません。');
    }

    SheetRepository.updateRowById(SHEET_NAMES.ITEMS, 'item_id', itemId, {
      notification_enabled: toBool(enabled),
      updated_at: nowIso()
    });

    return true;
  }

  // 公開API（仕様書 Section 20 準拠）
  return {
    getItems: getItems,
    getActiveItems: getActiveItems,
    getItemById: getItemById,
    findItemsByPartialMatch: findItemsByPartialMatch,
    createItem: createItem,
    updateItem: updateItem,
    deleteItemLogical: deleteItemLogical,
    updateItemNotificationEnabled: updateItemNotificationEnabled,
    parseAlternatives: parseAlternatives
  };

})();
