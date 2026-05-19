/**
 * ReadyGoBotService.gs
 * ReadyGo Bot 連携サービス
 *
 * ReadyGo Bot（家族向け生活自動化Bot）の Inbox シートに通知を投入する。
 * 投入された行は ReadyGo 側の 21:00 夜次通知の末尾に「お知らせ」として配信される。
 *
 * 連携仕様:
 *   - スプレッドシートID: スクリプトプロパティ READYGO_SPREADSHEET_ID
 *   - シート名: Inbox
 *   - 列構成: A=posted_at(Date), B=source(string), C=body(string), D=processed(false)
 *   - 配信タイミング: 投入後、次の 21:00 通知に含まれる（即時配信ではない）
 *   - 再送なし: 1度配信されると ReadyGo 側で processed=TRUE になり再配信されない
 *
 * 失敗時の挙動:
 *   - スプレッドシートID 未設定や権限不足、シート不在等のエラーは Logger.log のみ
 *     呼び出し元のバッチ処理は継続させる（夜の通知側で欠落するだけで良い設計）
 */

var ReadyGoBotService = (function() {

  /** ReadyGo 側で固定の Inbox シート名 */
  var INBOX_SHEET_NAME = 'Inbox';

  /** 投入時の source 名（ReadyGo 側のログ識別用） */
  var SOURCE_NAME = 'StockHome';

  /**
   * ReadyGo の Inbox に通知本文を1行追加する
   *
   * @param {string} body 通知本文（改行可、5000文字以内推奨）
   * @return {boolean} 成功時 true、失敗時 false
   */
  function appendToInbox(body) {
    var text = toStr(body);
    if (!text) {
      Logger.log('[ReadyGoBotService] body が空のため投入をスキップ');
      return false;
    }

    var spreadsheetId = getReadyGoSpreadsheetId();
    if (!spreadsheetId) {
      Logger.log('[ReadyGoBotService] スクリプトプロパティ READYGO_SPREADSHEET_ID が未設定のためスキップ');
      return false;
    }

    try {
      var ss = SpreadsheetApp.openById(spreadsheetId);
      var sheet = ss.getSheetByName(INBOX_SHEET_NAME);
      if (!sheet) {
        Logger.log('[ReadyGoBotService] Inbox シートが見つかりません: spreadsheetId=' + spreadsheetId);
        return false;
      }

      sheet.appendRow([new Date(), SOURCE_NAME, text, false]);

      Logger.log('[ReadyGoBotService] Inbox に投入しました (' + text.length + '文字)');
      return true;
    } catch (e) {
      Logger.log('[ReadyGoBotService] Inbox 投入失敗: ' + e.message);
      return false;
    }
  }

  // 公開API
  return {
    appendToInbox: appendToInbox
  };

})();
