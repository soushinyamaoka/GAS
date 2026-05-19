/**
 * SheetInitializer.gs
 * スプレッドシートの初期化処理
 * 全シートの作成、ヘッダー設定、app_config 初期値の投入を行う
 *
 * 使い方:
 *   1. GAS エディタで initializeAllSheets() を実行
 *   2. 既存シートがある場合はスキップする（破壊しない）
 *   3. Script Properties に SPREADSHEET_ID を事前に設定しておくこと
 *      または setupScriptProperties() を先に実行すること
 */

/**
 * Script Properties の初期設定
 * GAS エディタから手動実行する
 */
function setupScriptProperties() {
  var props = PropertiesService.getScriptProperties();

  // TODO: 実際のスプレッドシートIDに置き換える
  if (!props.getProperty('SPREADSHEET_ID')) {
    props.setProperty('SPREADSHEET_ID', 'YOUR_SPREADSHEET_ID_HERE');
    Logger.log('SPREADSHEET_ID を設定してください。Script Properties を開いて値を変更してください。');
  }

  // WEBAPP_BASE_URL はデプロイ後に設定する
  if (!props.getProperty('WEBAPP_BASE_URL')) {
    props.setProperty('WEBAPP_BASE_URL', '');
    Logger.log('WEBAPP_BASE_URL はデプロイ後に設定してください。');
  }

  Logger.log('Script Properties の初期設定が完了しました。');
}

/**
 * 全シートを初期化する
 * 既存シートがある場合はスキップ（安全動作）
 */
function initializeAllSheets() {
  var ss = SpreadsheetApp.openById(getSpreadsheetId());

  // 各シートを作成
  var sheetNames = Object.keys(SHEET_HEADERS);
  for (var i = 0; i < sheetNames.length; i++) {
    var name = sheetNames[i];
    ensureSheet_(ss, name, SHEET_HEADERS[name]);
  }

  // app_config に初期値を投入
  initializeAppConfig_(ss);

  // デフォルトの Sheet1 が残っていたら削除を試みる
  cleanupDefaultSheet_(ss);

  Logger.log('全シートの初期化が完了しました。');
}

/**
 * シートが存在しなければ作成し、ヘッダーを設定する
 * @param {Spreadsheet} ss
 * @param {string} sheetName
 * @param {string[]} headers
 * @private
 */
function ensureSheet_(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);

  if (sheet) {
    Logger.log('シート "' + sheetName + '" は既に存在します。スキップします。');
    // ヘッダーが空なら設定する（安全策）
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      formatHeaderRow_(sheet, headers.length);
    }
    return;
  }

  // シート作成
  sheet = ss.insertSheet(sheetName);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  formatHeaderRow_(sheet, headers.length);

  // シート固有の書式設定
  applySheetFormat_(sheet, sheetName, headers);

  Logger.log('シート "' + sheetName + '" を作成しました。');
}

/**
 * ヘッダー行の書式を設定する
 * @param {Sheet} sheet
 * @param {number} colCount
 * @private
 */
function formatHeaderRow_(sheet, colCount) {
  var headerRange = sheet.getRange(1, 1, 1, colCount);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#4a86c8');
  headerRange.setFontColor('#ffffff');
  headerRange.setWrap(true);

  // ヘッダー行を固定
  sheet.setFrozenRows(1);
}

/**
 * シート固有の書式・列幅を設定する
 * @param {Sheet} sheet
 * @param {string} sheetName
 * @param {string[]} headers
 * @private
 */
function applySheetFormat_(sheet, sheetName, headers) {
  // ID列は狭くしすぎない程度に調整
  // 主要シートの列幅を設定
  switch (sheetName) {
    case 'items':
      setColumnWidths_(sheet, headers, {
        'item_id': 120,
        'item_name': 200,
        'category': 120,
        'unit': 60,
        'purchase_url': 250
      });
      break;

    case 'purchase_log':
      setColumnWidths_(sheet, headers, {
        'purchase_id': 120,
        'item_id': 120,
        'note': 200
      });
      break;

    case 'import_order_candidates':
      setColumnWidths_(sheet, headers, {
        'candidate_id': 120,
        'item_name_raw': 250,
        'raw_subject': 300,
        'raw_snippet': 300
      });
      break;
  }
}

/**
 * 列幅を設定するヘルパー
 * @param {Sheet} sheet
 * @param {string[]} headers
 * @param {Object} widthMap { columnName: pixelWidth }
 * @private
 */
function setColumnWidths_(sheet, headers, widthMap) {
  for (var colName in widthMap) {
    var idx = headers.indexOf(colName);
    if (idx !== -1) {
      sheet.setColumnWidth(idx + 1, widthMap[colName]);
    }
  }
}

/**
 * app_config シートに初期値を投入する
 * 既に値がある場合は上書きしない
 * @param {Spreadsheet} ss
 * @private
 */
function initializeAppConfig_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAMES.APP_CONFIG);
  if (!sheet) return;

  var existingData = sheet.getDataRange().getValues();
  var existingKeys = {};
  for (var i = 1; i < existingData.length; i++) {
    existingKeys[existingData[i][0]] = true;
  }

  // 初期設定値
  var defaults = [
    ['default_delivery_buffer_days', String(DEFAULTS.DELIVERY_BUFFER_DAYS)]
  ];

  for (var j = 0; j < defaults.length; j++) {
    if (!existingKeys[defaults[j][0]]) {
      sheet.appendRow(defaults[j]);
      Logger.log('app_config に "' + defaults[j][0] + '" を追加しました。');
    }
  }
}

/**
 * デフォルトの「シート1」「Sheet1」を削除する
 * 他にシートが存在する場合のみ
 * @param {Spreadsheet} ss
 * @private
 */
function cleanupDefaultSheet_(ss) {
  var defaultNames = ['Sheet1', 'シート1'];
  var sheets = ss.getSheets();

  // シートが2つ以上あるときだけ削除を試みる
  if (sheets.length <= 1) return;

  for (var i = 0; i < defaultNames.length; i++) {
    var defaultSheet = ss.getSheetByName(defaultNames[i]);
    if (defaultSheet) {
      try {
        ss.deleteSheet(defaultSheet);
        Logger.log('デフォルトシート "' + defaultNames[i] + '" を削除しました。');
      } catch (e) {
        Logger.log('デフォルトシートの削除に失敗しました: ' + e.message);
      }
    }
  }
}

/**
 * 開発・テスト用: 全シートをリセットする（データを全削除してヘッダーだけ残す）
 * 本番では絶対に使わないこと
 */
function resetAllSheets_DANGEROUS() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    '警告',
    '全シートのデータを削除します。この操作は取り消せません。続行しますか？',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    Logger.log('リセットがキャンセルされました。');
    return;
  }

  var ss = SpreadsheetApp.openById(getSpreadsheetId());
  var sheetNames = Object.keys(SHEET_HEADERS);

  for (var i = 0; i < sheetNames.length; i++) {
    var name = sheetNames[i];
    var sheet = ss.getSheetByName(name);
    if (sheet && sheet.getLastRow() > 1) {
      sheet.deleteRows(2, sheet.getLastRow() - 1);
      Logger.log('シート "' + name + '" のデータをクリアしました。');
    }
  }

  // app_config の初期値を再投入
  initializeAppConfig_(ss);

  Logger.log('全シートのリセットが完了しました。');
}
