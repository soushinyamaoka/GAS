/**
 * TriggerService.gs
 * 家族ごとの Gmail 自動取込 trigger の作成・削除・確認
 *
 * 仕様書 Section 4.2, 12, 20 (TriggerService) 準拠
 *
 * 重要な考え方（Section 12.1）:
 *   - ソースコードは1つ
 *   - trigger はユーザーごと
 *   - 同じ runMyGmailImport を呼ぶが、実行ユーザーが異なる
 *   - 誰の trigger で動いたかにより、読む Gmail が変わる
 *
 * trigger の実行間隔は初期 6 時間（DEFAULTS.GMAIL_IMPORT_INTERVAL_HOURS）。
 * 必要以上に短くしない。
 */

var TriggerService = (function() {

  /** trigger が呼び出す関数名 */
  var TRIGGER_FUNCTION_NAME = 'runMyGmailImport';

  // ----------------------------------------------------------
  // trigger 作成
  // ----------------------------------------------------------

  /**
   * 現在ユーザーの Gmail 自動取込 trigger を作成する
   *
   * 仕様書 Section 12.2 フロー:
   *   1. 既存 trigger がないか確認
   *   2. 新規作成
   *   3. User Properties に有効化フラグを保存
   *
   * @return {Object} { created: boolean, message: string }
   */
  function createMyGmailImportTrigger() {
    // 既に存在するなら二重作成しない
    if (hasMyGmailImportTrigger()) {
      return {
        created: false,
        message: 'Gmail 自動取込 trigger は既に存在します。'
      };
    }

    var intervalHours = DEFAULTS.GMAIL_IMPORT_INTERVAL_HOURS;

    ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME)
      .timeBased()
      .everyHours(intervalHours)
      .create();

    // User Properties に有効化フラグを保存
    PropertiesService.getUserProperties().setProperty('gmail_import_enabled', 'true');

    var email = '';
    try {
      email = Session.getActiveUser().getEmail();
    } catch (e) { /* ignore */ }

    Logger.log('[TriggerService] Gmail 自動取込 trigger を作成しました: ' +
      email + ' (' + intervalHours + '時間ごと)');

    return {
      created: true,
      message: 'Gmail 自動取込を有効化しました（' + intervalHours + '時間ごとに実行されます）。'
    };
  }

  // ----------------------------------------------------------
  // trigger 削除
  // ----------------------------------------------------------

  /**
   * 現在ユーザーの Gmail 自動取込 trigger を削除する
   *
   * @return {Object} { deleted: boolean, message: string }
   */
  function deleteMyGmailImportTrigger() {
    var triggers = ScriptApp.getProjectTriggers();
    var deleted = 0;

    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === TRIGGER_FUNCTION_NAME) {
        // installable trigger の場合、自分が作成したものだけ削除できる
        // （GAS の仕様: getProjectTriggers は自分の trigger のみ返す）
        try {
          ScriptApp.deleteTrigger(triggers[i]);
          deleted++;
        } catch (e) {
          Logger.log('[TriggerService] trigger 削除失敗: ' + e.message);
        }
      }
    }

    // User Properties を更新
    PropertiesService.getUserProperties().setProperty('gmail_import_enabled', 'false');

    if (deleted > 0) {
      Logger.log('[TriggerService] Gmail 自動取込 trigger を ' + deleted + ' 件削除しました。');
      return {
        deleted: true,
        message: 'Gmail 自動取込を無効化しました。'
      };
    } else {
      return {
        deleted: false,
        message: 'Gmail 自動取込 trigger が見つかりませんでした。'
      };
    }
  }

  // ----------------------------------------------------------
  // trigger 確認
  // ----------------------------------------------------------

  /**
   * 現在ユーザーの Gmail 自動取込 trigger が存在するか
   * @return {boolean}
   */
  function hasMyGmailImportTrigger() {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === TRIGGER_FUNCTION_NAME) {
        return true;
      }
    }
    return false;
  }

  /**
   * 現在ユーザーの Gmail 自動取込ステータスを返す
   * 設定画面（HtmlGmailSettings）で表示する情報
   *
   * @return {Object}
   *   - enabled {boolean} 有効化フラグ
   *   - hasTrigger {boolean} trigger が存在するか
   *   - lastRunAt {string} 最終実行日時
   *   - amazonQuery {string} Amazon 用検索クエリ
   *   - matsukiyoQuery {string} マツキヨ用検索クエリ
   *   - intervalHours {number} 実行間隔
   *   - email {string} 実行ユーザーのメール
   */
  function getMyGmailImportStatus() {
    var email = '';
    try {
      email = Session.getActiveUser().getEmail();
    } catch (e) { /* ignore */ }

    return {
      enabled: isGmailImportEnabled(),
      hasTrigger: hasMyGmailImportTrigger(),
      lastRunAt: getGmailImportLastRunAt() || '未実行',
      amazonQuery: getAmazonSearchQuery(),
      matsukiyoQuery: getMatsukiyoSearchQuery(),
      intervalHours: DEFAULTS.GMAIL_IMPORT_INTERVAL_HOURS,
      email: email
    };
  }

  // ----------------------------------------------------------
  // 検索クエリ保存
  // ----------------------------------------------------------

  /**
   * Gmail 取込の検索クエリを保存する
   *
   * @param {Object} queryData
   *   - amazon_search_query {string}
   *   - matsukiyo_search_query {string}
   */
  function saveSearchQueries(queryData) {
    var userProps = PropertiesService.getUserProperties();

    if (queryData.amazon_search_query !== undefined) {
      userProps.setProperty('amazon_search_query', toStr(queryData.amazon_search_query));
    }
    if (queryData.matsukiyo_search_query !== undefined) {
      userProps.setProperty('matsukiyo_search_query', toStr(queryData.matsukiyo_search_query));
    }

    Logger.log('[TriggerService] 検索クエリを保存しました。');
  }

  // 公開API（仕様書 Section 20 準拠）
  return {
    createMyGmailImportTrigger: createMyGmailImportTrigger,
    deleteMyGmailImportTrigger: deleteMyGmailImportTrigger,
    hasMyGmailImportTrigger: hasMyGmailImportTrigger,
    getMyGmailImportStatus: getMyGmailImportStatus,
    saveSearchQueries: saveSearchQueries
  };

})();
