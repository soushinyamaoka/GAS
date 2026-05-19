/**
 * Main.gs
 * Web アプリのエントリーポイント
 *
 * 仕様書 Section 21 準拠
 * page パラメータで表示する HTML を切り替える。
 */

/**
 * doGet - Web アプリへの GET リクエストを処理する
 *
 * @param {Object} e イベントオブジェクト
 * @return {HtmlOutput}
 */
function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) ? e.parameter.page : 'home';
  var itemId = (e && e.parameter && e.parameter.itemId) ? e.parameter.itemId : '';

  var templateMap = {
    home:             'HtmlIndex',
    items:            'HtmlItems',
    itemForm:         'HtmlItemForm',
    purchaseForm:     'HtmlPurchaseForm',
    purchaseHistory:  'HtmlPurchaseHistory',
    stocks:           'HtmlStocks',
    importCandidates: 'HtmlImportCandidates',
    gmailSettings:    'HtmlGmailSettings',
    notifications:    'HtmlNotifications',
    stockCorrection:  'HtmlStockCorrection'
  };

  var templateName = templateMap[page] || 'HtmlIndex';

  var template = HtmlService.createTemplateFromFile(templateName);
  template.itemId = itemId;
  template.prefillName = (e && e.parameter && e.parameter.prefillName) ? e.parameter.prefillName : '';
  template.page = page;
  template.webAppUrl = ScriptApp.getService().getUrl();

  return template.evaluate()
    .setTitle('StockHome - 消耗品在庫管理')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * HTML テンプレート内で <?!= include('filename') ?> を使うためのヘルパー
 * 共通 CSS/JS を分離する場合に使用する
 *
 * @param {string} filename
 * @return {string} HTML 文字列
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
