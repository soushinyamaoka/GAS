/**
 * SnoozeService.gs
 * 通知スヌーズの管理
 *
 * 仕様書 Section 5.7, 16, 20 (SnoozeService) 準拠
 *
 * スヌーズ操作:
 *   - 3日後に再通知
 *   - 7日後に再通知
 *   - 今回は無視（SNOOZE_IGNORE_DAYS 日間抑止）
 *   - スヌーズ解除
 *
 * スヌーズ状態は item_runtime_state.snooze_until に日時保存。
 * 実際の永続化は ItemRuntimeStateService に委譲する。
 * このサービスはスヌーズのビジネスロジック（日数計算・操作種別）を担当。
 */

var SnoozeService = (function() {

  // ----------------------------------------------------------
  // スヌーズ設定
  // ----------------------------------------------------------

  /**
   * 品目にスヌーズを設定する
   *
   * @param {string} itemId
   * @param {string|Date} untilDate スヌーズ解除日時
   * @param {string} [snoozedByUserId] 操作者（ログ用）
   * @return {boolean}
   */
  function snoozeItem(itemId, untilDate, snoozedByUserId) {
    // 品目チェック
    var itemErr = Validation.requireActiveItem(itemId);
    if (itemErr) {
      throwUserError(itemErr);
    }

    // 日付チェック
    var d = parseDate(untilDate);
    if (!d || d <= new Date()) {
      throwUserError('スヌーズ期限は未来の日付を指定してください。');
    }

    ItemRuntimeStateService.saveSnooze(itemId, d);

    Logger.log('[SnoozeService] スヌーズ設定: item=' + itemId +
      ', until=' + formatDateTime(d) +
      ', by=' + (snoozedByUserId || 'unknown'));

    return true;
  }

  /**
   * 3日後にスヌーズする
   * @param {string} itemId
   * @param {string} [snoozedByUserId]
   * @return {boolean}
   */
  function snooze3Days(itemId, snoozedByUserId) {
    var until = addDays(new Date(), 3);
    return snoozeItem(itemId, until, snoozedByUserId);
  }

  /**
   * 7日後にスヌーズする
   * @param {string} itemId
   * @param {string} [snoozedByUserId]
   * @return {boolean}
   */
  function snooze7Days(itemId, snoozedByUserId) {
    var until = addDays(new Date(), 7);
    return snoozeItem(itemId, until, snoozedByUserId);
  }

  /**
   * 「今回は無視」: SNOOZE_IGNORE_DAYS 日間通知を抑止する（Section 16.3）
   * @param {string} itemId
   * @param {string} [snoozedByUserId]
   * @return {boolean}
   */
  function snoozeIgnore(itemId, snoozedByUserId) {
    var until = addDays(new Date(), DEFAULTS.SNOOZE_IGNORE_DAYS);
    return snoozeItem(itemId, until, snoozedByUserId);
  }

  // ----------------------------------------------------------
  // スヌーズ解除
  // ----------------------------------------------------------

  /**
   * スヌーズを解除する
   * @param {string} itemId
   * @return {boolean}
   */
  function clearSnooze(itemId) {
    var itemErr = Validation.requireActiveItem(itemId);
    if (itemErr) {
      throwUserError(itemErr);
    }

    ItemRuntimeStateService.clearSnooze(itemId);

    Logger.log('[SnoozeService] スヌーズ解除: item=' + itemId);
    return true;
  }

  // ----------------------------------------------------------
  // スヌーズ状態確認
  // ----------------------------------------------------------

  /**
   * 指定品目がスヌーズ中かどうか
   * @param {string} itemId
   * @return {boolean}
   */
  function isSnoozed(itemId) {
    return ItemRuntimeStateService.isSnoozed(itemId);
  }

  /**
   * スヌーズ解除予定日を取得する
   * @param {string} itemId
   * @return {string} 日時文字列。スヌーズ中でなければ空文字
   */
  function getSnoozeUntil(itemId) {
    var state = ItemRuntimeStateService.getRuntimeState(itemId);
    if (!state || !state.snooze_until) return '';
    var until = parseDate(state.snooze_until);
    if (!until || until <= new Date()) return '';
    return formatDateTime(until);
  }

  // 公開API（仕様書 Section 20 準拠）
  return {
    snoozeItem: snoozeItem,
    snooze3Days: snooze3Days,
    snooze7Days: snooze7Days,
    snoozeIgnore: snoozeIgnore,
    clearSnooze: clearSnooze,
    isSnoozed: isSnoozed,
    getSnoozeUntil: getSnoozeUntil
  };

})();
