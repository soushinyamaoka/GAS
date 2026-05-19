/**
 * Utils.gs
 * 共通ユーティリティ関数
 * ID生成、日付処理、型変換などを提供する
 */

// ============================================================
// ID 生成
// ============================================================

/**
 * UUID v4 を生成する
 * @return {string} UUID文字列
 */
function generateId() {
  return Utilities.getUuid();
}

/**
 * プレフィックス付きIDを生成する
 * @param {string} prefix 例: 'ITEM', 'PUR', 'NOTIF'
 * @return {string} 例: 'ITEM_xxxxxxxx-xxxx-...'
 */
function generatePrefixedId(prefix) {
  return prefix + '_' + generateId();
}

// ============================================================
// 日付処理
// ============================================================

/**
 * 現在日時を ISO 文字列で返す
 * @return {string} ISO 8601 文字列
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 今日の日付（時刻なし）を返す
 * @return {Date} 時刻が 00:00:00 の Date
 */
function today() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Date オブジェクトを yyyy-MM-dd 形式に変換する
 * @param {Date|string} date
 * @return {string} yyyy-MM-dd
 */
function formatDate(date) {
  if (!date) return '';
  var d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  var yyyy = d.getFullYear();
  var mm = ('0' + (d.getMonth() + 1)).slice(-2);
  var dd = ('0' + d.getDate()).slice(-2);
  return yyyy + '/' + mm + '/' + dd;
}

/**
 * Date オブジェクトを yyyy-MM-dd HH:mm 形式に変換する
 * @param {Date|string} date
 * @return {string}
 */
function formatDateTime(date) {
  if (!date) return '';
  var d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  var hh = ('0' + d.getHours()).slice(-2);
  var mi = ('0' + d.getMinutes()).slice(-2);
  return formatDate(d) + ' ' + hh + ':' + mi;
}

/**
 * 文字列を Date に変換する（空やnullはnullを返す）
 * @param {string|Date|null} value
 * @return {Date|null}
 */
function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 指定日数後の日付を返す
 * @param {Date} baseDate 基準日
 * @param {number} days 加算する日数
 * @return {Date}
 */
function addDays(baseDate, days) {
  var d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * 2つの日付の差分日数を返す（date1 - date2）
 * @param {Date} date1
 * @param {Date} date2
 * @return {number} 日数（小数含む）
 */
function diffDays(date1, date2) {
  var ms = date1.getTime() - date2.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

// ============================================================
// 型変換・安全アクセス
// ============================================================

/**
 * 値を数値に変換する（変換不可なら defaultVal）
 * @param {*} value
 * @param {number} [defaultVal=0]
 * @return {number}
 */
function toNumber(value, defaultVal) {
  if (value === '' || value === null || value === undefined) {
    return (defaultVal !== undefined) ? defaultVal : 0;
  }
  var n = Number(value);
  return isNaN(n) ? ((defaultVal !== undefined) ? defaultVal : 0) : n;
}

/**
 * 値を整数に変換する
 * @param {*} value
 * @param {number} [defaultVal=0]
 * @return {number}
 */
function toInt(value, defaultVal) {
  var n = toNumber(value, defaultVal);
  return Math.floor(n);
}

/**
 * 値を boolean に変換する
 * @param {*} value
 * @return {boolean}
 */
function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return !!value;
}

/**
 * 値をトリムした文字列に変換する（null/undefinedは空文字）
 * @param {*} value
 * @return {string}
 */
function toStr(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// ============================================================
// ロック処理
// ============================================================

/**
 * スクリプトロックを取得して処理を実行する
 * @param {Function} fn 実行する関数
 * @return {*} fn の戻り値
 * @throws {Error} ロック取得失敗時
 */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(DEFAULTS.LOCK_TIMEOUT_MS);
  } catch (e) {
    throw new Error('他の処理が実行中です。しばらく待ってから再度お試しください。');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// オブジェクト操作
// ============================================================

/**
 * シートの1行（配列）をヘッダーをキーにしたオブジェクトに変換する
 * @param {string[]} headers ヘッダー配列
 * @param {Array} row データ行の配列
 * @return {Object}
 */
function rowToObject(headers, row) {
  var obj = {};
  for (var i = 0; i < headers.length; i++) {
    obj[headers[i]] = (i < row.length) ? row[i] : '';
  }
  return obj;
}

/**
 * オブジェクトをヘッダー順の配列に変換する
 * @param {string[]} headers ヘッダー配列
 * @param {Object} obj データオブジェクト
 * @return {Array}
 */
function objectToRow(headers, obj) {
  return headers.map(function(h) {
    var val = obj[h];
    return (val !== undefined && val !== null) ? val : '';
  });
}

// ============================================================
// エラーハンドリング
// ============================================================

/**
 * ユーザー向けエラーをスローする
 * 詳細は Logger に出力し、ユーザーには短いメッセージを返す
 * @param {string} userMessage ユーザーに見せるメッセージ
 * @param {Error|string} [detail] 詳細情報（Logger出力用）
 */
function throwUserError(userMessage, detail) {
  if (detail) {
    Logger.log('[ERROR] ' + userMessage + ' | detail: ' + detail);
  }
  throw new Error(userMessage);
}

/**
 * 処理結果を統一フォーマットで返す
 * WebController から HTML に返すレスポンス用
 * @param {boolean} success
 * @param {*} [data]
 * @param {string} [message]
 * @return {Object}
 */
function createResponse(success, data, message) {
  return {
    success: success,
    data: data || null,
    message: message || ''
  };
}

/**
 * 成功レスポンスを返す
 * @param {*} [data]
 * @param {string} [message]
 * @return {Object}
 */
function successResponse(data, message) {
  return createResponse(true, data, message || '');
}

/**
 * エラーレスポンスを返す
 * @param {string} message
 * @return {Object}
 */
function errorResponse(message) {
  return createResponse(false, null, message);
}
