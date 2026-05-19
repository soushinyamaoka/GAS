/**
 * Validation.gs
 * サーバーサイドの入力値検証
 * 仕様書 Section 22 に基づくバリデーション関数群
 */

var Validation = (function() {

  /**
   * バリデーション結果オブジェクト
   * @param {boolean} valid
   * @param {string[]} errors
   */
  function result(valid, errors) {
    return { valid: valid, errors: errors || [] };
  }

  /**
   * 必須チェック
   * @param {*} value
   * @param {string} fieldName
   * @return {string|null} エラーメッセージ or null
   */
  function requireField(value, fieldName) {
    if (value === null || value === undefined || String(value).trim() === '') {
      return fieldName + 'は必須です。';
    }
    return null;
  }

  /**
   * 正の整数チェック（min以上）
   * @param {*} value
   * @param {string} fieldName
   * @param {number} min 最小値
   * @return {string|null}
   */
  function requirePositiveInt(value, fieldName, min) {
    var n = Number(value);
    if (isNaN(n) || !Number.isInteger(n) || n < min) {
      return fieldName + 'は' + min + '以上の整数を入力してください。';
    }
    return null;
  }

  /**
   * 正の数値チェック（小数可）
   * @param {*} value
   * @param {string} fieldName
   * @return {string|null}
   */
  function requirePositiveNumber(value, fieldName) {
    var n = Number(value);
    if (isNaN(n) || n <= 0) {
      return fieldName + 'は0より大きい数値を入力してください。';
    }
    return null;
  }

  /**
   * 0以上の整数チェック（空欄許容）
   * @param {*} value
   * @param {string} fieldName
   * @return {string|null}
   */
  function optionalNonNegativeInt(value, fieldName) {
    if (value === '' || value === null || value === undefined) return null;
    var n = Number(value);
    if (isNaN(n) || !Number.isInteger(n) || n < 0) {
      return fieldName + 'は0以上の整数を入力してください。';
    }
    return null;
  }

  /**
   * 0以上の数値チェック（空欄許容）
   * @param {*} value
   * @param {string} fieldName
   * @return {string|null}
   */
  function optionalNonNegativeNumber(value, fieldName) {
    if (value === '' || value === null || value === undefined) return null;
    var n = Number(value);
    if (isNaN(n) || n < 0) {
      return fieldName + 'は0以上の数値を入力してください。';
    }
    return null;
  }

  /**
   * URL形式チェック（空欄許容）
   * @param {*} value
   * @param {string} fieldName
   * @return {string|null}
   */
  function optionalUrl(value, fieldName) {
    if (!value || String(value).trim() === '') return null;
    var s = String(value).trim();
    if (!/^https?:\/\/.+/.test(s)) {
      return fieldName + 'は有効なURLを入力してください。';
    }
    return null;
  }

  /**
   * 日付チェック
   * @param {*} value
   * @param {string} fieldName
   * @return {string|null}
   */
  function requireDate(value, fieldName) {
    if (!value) return fieldName + 'は必須です。';
    var d = new Date(value);
    if (isNaN(d.getTime())) {
      return fieldName + 'は有効な日付を入力してください。';
    }
    return null;
  }

  /**
   * スヌーズ日付チェック（未来日であること）
   * @param {*} value
   * @param {string} fieldName
   * @return {string|null}
   */
  function requireFutureDate(value, fieldName) {
    var err = requireDate(value, fieldName);
    if (err) return err;
    var d = new Date(value);
    if (d <= new Date()) {
      return fieldName + 'は未来の日付を指定してください。';
    }
    return null;
  }

  // ----------------------------------------------------------
  // 画面ごとのバリデーション
  // ----------------------------------------------------------

  /**
   * 消耗品登録・編集のバリデーション
   * @param {Object} data フォームデータ
   * @return {Object} { valid: boolean, errors: string[] }
   */
  function validateItem(data) {
    var errors = [];

    var e;
    e = requireField(data.item_name, '品名'); if (e) errors.push(e);
    e = requirePositiveInt(data.default_purchase_qty, '標準購入数', 1); if (e) errors.push(e);
    e = requirePositiveNumber(data.days_per_unit, '消費ペース'); if (e) errors.push(e);
    e = optionalNonNegativeInt(data.alert_before_days, '在庫切れ何日前に通知'); if (e) errors.push(e);
    e = optionalNonNegativeNumber(data.low_stock_threshold_qty, '在庫数しきい値通知数'); if (e) errors.push(e);
    e = optionalUrl(data.purchase_url, '購入先URL'); if (e) errors.push(e);

    return result(errors.length === 0, errors);
  }

  /**
   * 購入履歴登録のバリデーション
   * @param {Object} data フォームデータ
   * @return {Object} { valid: boolean, errors: string[] }
   */
  function validatePurchase(data) {
    var errors = [];

    var e;
    e = requireField(data.item_id, '品目'); if (e) errors.push(e);
    e = requireDate(data.purchased_at, '購入日'); if (e) errors.push(e);
    if (!e && data.purchased_at) {
      // 未来日付は受け付けない（今日を含む過去のみ有効）
      var purchasedDate = new Date(data.purchased_at);
      purchasedDate.setHours(0, 0, 0, 0);
      var todayDate = today();
      if (purchasedDate.getTime() > todayDate.getTime()) {
        errors.push('購入日に未来の日付は指定できません。');
      }
    }
    e = requirePositiveInt(data.qty, '購入数', 1); if (e) errors.push(e);
    e = optionalNonNegativeNumber(data.price, '金額'); if (e) errors.push(e);

    return result(errors.length === 0, errors);
  }

  /**
   * 在庫補正のバリデーション
   * @param {Object} data フォームデータ
   * @return {Object} { valid: boolean, errors: string[] }
   */
  function validateStockCorrection(data) {
    var errors = [];

    var e;
    e = requireField(data.item_id, '品目'); if (e) errors.push(e);
    e = optionalNonNegativeNumber(data.corrected_qty, '実際の残数');
    // corrected_qty は必須 & 0以上
    if (data.corrected_qty === '' || data.corrected_qty === null || data.corrected_qty === undefined) {
      errors.push('実際の残数は必須です。');
    } else if (e) {
      errors.push(e);
    }
    e = requireField(data.correction_reason, '補正理由'); if (e) errors.push(e);

    return result(errors.length === 0, errors);
  }

  /**
   * スヌーズ設定のバリデーション
   * @param {Object} data フォームデータ
   * @return {Object} { valid: boolean, errors: string[] }
   */
  function validateSnooze(data) {
    var errors = [];

    var e;
    e = requireField(data.item_id, '品目'); if (e) errors.push(e);
    e = requireFutureDate(data.snooze_until, 'スヌーズ期限'); if (e) errors.push(e);

    return result(errors.length === 0, errors);
  }

  /**
   * ユーザー登録のバリデーション
   * @param {Object} data
   * @return {Object} { valid: boolean, errors: string[] }
   */
  function validateUser(data) {
    var errors = [];

    var e;
    e = requireField(data.user_name, 'ユーザー名'); if (e) errors.push(e);

    return result(errors.length === 0, errors);
  }

  // ----------------------------------------------------------
  // 存在チェック系（SheetRepository 依存のため、呼び出し側で使う）
  // ----------------------------------------------------------

  /**
   * item_id が存在し、有効であることを確認する
   * @param {string} itemId
   * @return {string|null} エラーメッセージ or null
   */
  function requireActiveItem(itemId) {
    if (!itemId) return '品目IDが指定されていません。';
    var item = SheetRepository.findRowById(SHEET_NAMES.ITEMS, 'item_id', itemId);
    if (!item) return '指定された品目が見つかりません。';
    if (toBool(item.is_active) === false) {
      return 'この品目は削除されています。';
    }
    return null;
  }

  /**
   * user_id が存在することを確認する
   * @param {string} userId
   * @return {string|null}
   */
  function requireExistingUser(userId) {
    if (!userId) return 'ユーザーIDが指定されていません。';
    var user = SheetRepository.findRowById(SHEET_NAMES.USERS, 'user_id', userId);
    if (!user) return '指定されたユーザーが見つかりません。';
    return null;
  }

  // 公開API
  return {
    validateItem: validateItem,
    validatePurchase: validatePurchase,
    validateStockCorrection: validateStockCorrection,
    validateSnooze: validateSnooze,
    validateUser: validateUser,
    requireActiveItem: requireActiveItem,
    requireExistingUser: requireExistingUser,
    requireField: requireField,
    requireDate: requireDate,
    requireFutureDate: requireFutureDate
  };

})();
