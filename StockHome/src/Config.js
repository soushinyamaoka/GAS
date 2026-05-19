/**
 * Config.gs
 * アプリ全体の設定値管理
 * Script Properties / User Properties / 定数を一元管理する
 */

// ============================================================
// シート名定義
// ============================================================
var SHEET_NAMES = {
  USERS: 'users',
  ITEMS: 'items',
  PURCHASE_LOG: 'purchase_log',
  STOCK_SNAPSHOT: 'stock_snapshot',
  ITEM_RUNTIME_STATE: 'item_runtime_state',
  NOTIFICATION_LOG: 'notification_log',
  IMPORT_ORDER_CANDIDATES: 'import_order_candidates',
  STOCK_CORRECTION_LOG: 'stock_correction_log',
  APP_CONFIG: 'app_config'
};

// ============================================================
// 各シートのヘッダー定義（列順は仕様書準拠）
// ============================================================
var SHEET_HEADERS = {
  users: [
    'user_id', 'user_name', 'email', 'existing_bot_target_id',
    'role', 'is_active', 'created_at', 'updated_at'
  ],
  items: [
    'item_id', 'item_name', 'category', 'unit',
    'default_purchase_qty', 'days_per_unit', 'lead_days', 'safety_days',
    'low_stock_threshold_qty', 'purchase_url', 'alternatives', 'item_memo',
    'notify_target_type', 'notify_target_user_id',
    'notification_enabled', 'is_inventory_unknown', 'is_active',
    'deleted_at', 'deleted_by',
    'created_at', 'updated_at'
  ],
  purchase_log: [
    'purchase_id', 'item_id', 'purchased_at', 'qty', 'price',
    'source', 'source_type', 'external_vendor', 'external_order_id',
    'import_candidate_id', 'purchased_by_user_id', 'purchased_by_user_name',
    'note', 'fulfillment_status', 'shipped_at',
    'inventory_effective_at', 'counted_in_inventory',
    'created_at', 'updated_at'
  ],
  stock_snapshot: [
    'item_id', 'calculated_at',
    'latest_purchase_date', 'latest_purchase_qty',
    'estimated_remaining_qty', 'estimated_days_left',
    'predicted_out_of_stock_date', 'low_stock_threshold_qty',
    'days_alert_needed', 'qty_alert_needed', 'alert_needed',
    'updated_at'
  ],
  item_runtime_state: [
    'item_id',
    'manual_override_qty', 'manual_override_at',
    'manual_override_by_user_id', 'manual_override_reason',
    'snooze_until',
    'last_notification_reason', 'last_notification_at',
    'updated_at'
  ],
  notification_log: [
    'notification_id', 'item_id', 'notification_type',
    'notification_reason', 'target_user_id', 'outbox_id',
    'message', 'created_at'
  ],
  import_order_candidates: [
    'candidate_id', 'vendor', 'mail_message_id', 'gmail_thread_id',
    'imported_by_user_id', 'imported_by_email', 'mail_date',
    'order_id', 'mail_type', 'mail_phase',
    'fulfillment_status', 'candidate_group_key',
    'item_name_raw', 'detected_qty', 'detected_price',
    'candidate_status', 'matched_item_id',
    'raw_subject', 'raw_snippet', 'parse_result',
    'created_at', 'updated_at'
  ],
  stock_correction_log: [
    'correction_id', 'item_id', 'corrected_at',
    'corrected_by_user_id', 'corrected_by_user_name',
    'before_estimated_qty', 'corrected_qty',
    'correction_reason', 'note', 'created_at'
  ],
  app_config: [
    'config_key', 'config_value'
  ]
};

// ============================================================
// 定数
// ============================================================
var DEFAULTS = {
  /** 配送バッファ日数の初期値 */
  DELIVERY_BUFFER_DAYS: 0,
  /** Gmail 取込トリガーの実行間隔（時間） */
  GMAIL_IMPORT_INTERVAL_HOURS: 6,
  /** スヌーズ「今回は無視」の場合の抑止日数 */
  SNOOZE_IGNORE_DAYS: 30,
  /** 通知重複チェック日数 */
  NOTIFICATION_DEDUPE_DAYS: 1,
  /** 直近の購入から何日以内ならアラートを抑止するか（最近買った直後の通知抑止） */
  RECENT_PURCHASE_SUPPRESS_DAYS: 3,
  /** ロック待ちタイムアウト（ミリ秒） */
  LOCK_TIMEOUT_MS: 10000
};

// ============================================================
// 列挙値
// ============================================================
var ENUMS = {
  ROLE: { ADMIN: 'admin', MEMBER: 'member' },
  SOURCE: { MANUAL: 'manual', LINE: 'line', GMAIL: 'gmail' },
  SOURCE_TYPE: { MANUAL: 'manual', LINE_QUICK: 'line_quick', GMAIL_AUTO: 'gmail_auto', GMAIL_AUTO_CONFIRMED: 'gmail_auto_confirmed' },
  EXTERNAL_VENDOR: { AMAZON: 'amazon', MATSUKIYO: 'matsukiyo' },
  FULFILLMENT_STATUS: {
    ORDERED: 'ordered', SHIPPED: 'shipped',
    RECEIVED: 'received', CANCELLED: 'cancelled'
  },
  CANDIDATE_STATUS: {
    DETECTED: 'detected', ORDERED: 'ordered', SHIPPED: 'shipped',
    CONFIRMED: 'confirmed', AUTO_CONFIRMED: 'auto_confirmed',
    IGNORED: 'ignored',
    CANCELLED: 'cancelled', ERROR: 'error'
  },
  MAIL_TYPE: { ORDER_CONFIRM: 'order_confirm', SHIPMENT: 'shipment', OTHER: 'other' },
  MAIL_PHASE: {
    ORDERED: 'ordered', SHIPPED: 'shipped',
    DELIVERED_OPTIONAL: 'delivered_optional', OTHER: 'other'
  },
  NOTIFY_TARGET_TYPE: { ALL: 'all', REPRESENTATIVE: 'representative', SPECIFIC_USER: 'specific_user' },
  NOTIFICATION_REASON: { DAYS: 'days_threshold', QTY: 'qty_threshold', BOTH: 'both' },
  CORRECTION_REASON: {
    STILL_HAVE_MORE: 'still_have_more',
    COUNTED_ACTUAL_STOCK: 'counted_actual_stock',
    WRONG_IMPORT: 'wrong_import',
    MANUAL_ADJUSTMENT: 'manual_adjustment'
  }
};

// ============================================================
// Script Properties アクセス
// ============================================================

/**
 * スプレッドシートIDを取得する
 * @return {string} スプレッドシートID
 */
function getSpreadsheetId() {
  return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
}

/**
 * WebアプリのベースURLを取得する
 * @return {string} URL
 */
function getWebAppBaseUrl() {
  return PropertiesService.getScriptProperties().getProperty('WEBAPP_BASE_URL');
}

/**
 * ReadyGo Bot のスプレッドシートIDを取得する
 * 在庫アラートを ReadyGo Bot の Inbox 経由で配信するために使用
 * @return {string|null} スプレッドシートID（未設定時は null）
 */
function getReadyGoSpreadsheetId() {
  return PropertiesService.getScriptProperties().getProperty('READYGO_SPREADSHEET_ID');
}

// ============================================================
// User Properties アクセス
// ============================================================

/**
 * 現在ユーザーの user_id を取得する
 * @return {string|null} user_id
 */
function getCurrentUserIdFromProps() {
  return PropertiesService.getUserProperties().getProperty('current_user_id');
}

/**
 * 現在ユーザーの user_id を保存する
 * @param {string} userId
 */
function setCurrentUserIdToProps(userId) {
  PropertiesService.getUserProperties().setProperty('current_user_id', userId);
}

/**
 * Gmail 取込の有効/無効フラグを取得する
 * @return {boolean}
 */
function isGmailImportEnabled() {
  return PropertiesService.getUserProperties().getProperty('gmail_import_enabled') === 'true';
}

/**
 * Gmail 取込の最終実行日時を取得する
 * @return {string|null} ISO日時文字列
 */
function getGmailImportLastRunAt() {
  return PropertiesService.getUserProperties().getProperty('gmail_import_last_run_at');
}

/**
 * Gmail 取込の最終実行日時を保存する
 * @param {Date} date
 */
function setGmailImportLastRunAt(date) {
  PropertiesService.getUserProperties().setProperty(
    'gmail_import_last_run_at', date.toISOString()
  );
}

/**
 * Amazon 用 Gmail 検索クエリを取得する
 * @return {string}
 */
function getAmazonSearchQuery() {
  var q = PropertiesService.getUserProperties().getProperty('amazon_search_query');
  // デフォルトクエリ: Amazon からの注文確認・発送通知
  return q || 'from:(auto-confirm@amazon.co.jp OR shipment-tracking@amazon.co.jp)';
}

/**
 * マツキヨ用 Gmail 検索クエリを取得する
 * @return {string}
 */
function getMatsukiyoSearchQuery() {
  var q = PropertiesService.getUserProperties().getProperty('matsukiyo_search_query');
  // デフォルトクエリ: マツキヨオンラインからの注文確認・発送通知
  return q || 'from:(*@matsukiyococokara.com OR *@matsukiyo.co.jp)';
}

// ============================================================
// app_config シートアクセス
// ============================================================

/**
 * app_config シートから設定値を取得する
 * @param {string} key 設定キー
 * @param {string} [defaultValue] デフォルト値
 * @return {string}
 */
function getAppConfigValue(key, defaultValue) {
  var sheet = SheetRepository.getSheet(SHEET_NAMES.APP_CONFIG);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      return data[i][1] !== '' ? String(data[i][1]) : (defaultValue || '');
    }
  }
  return defaultValue || '';
}

/**
 * 配送バッファ日数を取得する
 * @return {number}
 */
function getDeliveryBufferDays() {
  var val = getAppConfigValue('default_delivery_buffer_days', String(DEFAULTS.DELIVERY_BUFFER_DAYS));
  var n = parseInt(val, 10);
  return isNaN(n) ? DEFAULTS.DELIVERY_BUFFER_DAYS : n;
}

/**
 * app_config の値を更新する（既存なら上書き、なければ追加）
 * @param {string} key
 * @param {string} value
 */
function setAppConfigValue(key, value) {
  var sheet = SheetRepository.getSheet(SHEET_NAMES.APP_CONFIG);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(String(value));
      return;
    }
  }
  sheet.appendRow([key, String(value)]);
}
