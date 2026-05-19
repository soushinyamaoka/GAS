/**
 * SheetRepository.gs
 * スプレッドシートへのアクセスを共通化するリポジトリ層
 * 全てのシート読み書きはこのモジュールを経由する
 */

var SheetRepository = (function() {

  /** スプレッドシートのキャッシュ（同一実行内で再利用） */
  var _ss = null;

  /**
   * 共通スプレッドシートを取得する
   * @return {Spreadsheet}
   */
  function getSpreadsheet() {
    if (!_ss) {
      var id = getSpreadsheetId();
      if (!id) {
        throw new Error('SPREADSHEET_ID が設定されていません。Script Properties を確認してください。');
      }
      _ss = SpreadsheetApp.openById(id);
    }
    return _ss;
  }

  /**
   * シート名からシートを取得する
   * @param {string} sheetName SHEET_NAMES の値
   * @return {Sheet}
   */
  function getSheet(sheetName) {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      throw new Error('シート "' + sheetName + '" が見つかりません。initializeAllSheets() を実行してください。');
    }
    return sheet;
  }

  /**
   * シートのヘッダー（1行目）を取得する
   * @param {string} sheetName
   * @return {string[]}
   */
  function getHeaders(sheetName) {
    var sheet = getSheet(sheetName);
    var lastCol = sheet.getLastColumn();
    if (lastCol === 0) return [];
    return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  }

  /**
   * シートの全データをオブジェクト配列で取得する
   * @param {string} sheetName
   * @return {Object[]}
   */
  function getAllRows(sheetName) {
    var sheet = getSheet(sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return []; // ヘッダーのみ or 空
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    return data.map(function(row) {
      return rowToObject(headers, row);
    });
  }

  /**
   * フィルタ条件に合致する行をオブジェクト配列で返す
   * @param {string} sheetName
   * @param {Function} filterFn (obj) => boolean
   * @return {Object[]}
   */
  function findRows(sheetName, filterFn) {
    return getAllRows(sheetName).filter(filterFn);
  }

  /**
   * 指定 ID カラムで1行を検索する
   * @param {string} sheetName
   * @param {string} idColumn ID列名
   * @param {string} idValue 検索する値
   * @return {Object|null}
   */
  function findRowById(sheetName, idColumn, idValue) {
    var rows = getAllRows(sheetName);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][idColumn]) === String(idValue)) {
        return rows[i];
      }
    }
    return null;
  }

  /**
   * シートに1行追加する
   * @param {string} sheetName
   * @param {Object} obj ヘッダーをキーとするオブジェクト
   */
  function appendRow(sheetName, obj) {
    var sheet = getSheet(sheetName);
    var headers = getHeaders(sheetName);
    var row = objectToRow(headers, obj);
    sheet.appendRow(row);
  }

  /**
   * 指定IDの行を更新する
   * @param {string} sheetName
   * @param {string} idColumn ID列名
   * @param {string} idValue 検索する値
   * @param {Object} updateObj 更新するフィールドのオブジェクト（部分更新可）
   * @return {boolean} 更新できた場合 true
   */
  function updateRowById(sheetName, idColumn, idValue, updateObj) {
    var sheet = getSheet(sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return false;

    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var idColIndex = headers.indexOf(idColumn);
    if (idColIndex === -1) return false;

    var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][idColIndex]) === String(idValue)) {
        // 更新対象行が見つかった
        var rowNum = i + 2; // シート上の行番号（ヘッダー分+1、0始まり分+1）
        for (var key in updateObj) {
          var colIndex = headers.indexOf(key);
          if (colIndex !== -1) {
            data[i][colIndex] = updateObj[key];
          }
        }
        sheet.getRange(rowNum, 1, 1, lastCol).setValues([data[i]]);
        return true;
      }
    }
    return false;
  }

  /**
   * 指定IDの行を更新する。存在しなければ追加する（upsert）
   * @param {string} sheetName
   * @param {string} idColumn ID列名
   * @param {string} idValue
   * @param {Object} obj 全フィールドのオブジェクト
   * @return {string} 'updated' or 'inserted'
   */
  function upsertRowById(sheetName, idColumn, idValue, obj) {
    var updated = updateRowById(sheetName, idColumn, idValue, obj);
    if (updated) return 'updated';
    appendRow(sheetName, obj);
    return 'inserted';
  }

  /**
   * 条件に合致する最初の行の特定カラムを更新する
   * 複数列を一度に更新できる簡易版
   * @param {string} sheetName
   * @param {string} matchColumn 検索に使う列名
   * @param {*} matchValue 検索値
   * @param {Object} updateObj 更新するフィールド
   * @return {boolean}
   */
  function updateFirstMatch(sheetName, matchColumn, matchValue, updateObj) {
    return updateRowById(sheetName, matchColumn, matchValue, updateObj);
  }

  /**
   * シートの行数を返す（ヘッダー除く）
   * @param {string} sheetName
   * @return {number}
   */
  function getRowCount(sheetName) {
    var sheet = getSheet(sheetName);
    return Math.max(0, sheet.getLastRow() - 1);
  }

  /**
   * 条件に合致する行数を返す
   * @param {string} sheetName
   * @param {Function} filterFn
   * @return {number}
   */
  function countRows(sheetName, filterFn) {
    return findRows(sheetName, filterFn).length;
  }

  /**
   * 内部キャッシュをクリアする（テスト用）
   */
  function clearCache() {
    _ss = null;
  }

  // 公開API
  return {
    getSpreadsheet: getSpreadsheet,
    getSheet: getSheet,
    getHeaders: getHeaders,
    getAllRows: getAllRows,
    findRows: findRows,
    findRowById: findRowById,
    appendRow: appendRow,
    updateRowById: updateRowById,
    upsertRowById: upsertRowById,
    updateFirstMatch: updateFirstMatch,
    getRowCount: getRowCount,
    countRows: countRows,
    clearCache: clearCache
  };

})();
