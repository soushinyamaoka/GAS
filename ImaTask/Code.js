/**
 * 日常タスク常時表示アプリ - サーバー側コード
 * Google Apps Script で動作する Web アプリ本体
 *
 * 役割:
 *   - Web アプリ画面の配信 (doGet)
 *   - スプレッドシートの初期化
 *   - 画面表示用データの取得
 *   - タスク完了状態の保存
 */

// ================================================================
// 定数定義
// ================================================================

// シート名の定義
const SHEET_TIME_SLOTS  = 'time_slots';
const SHEET_TASKS       = 'tasks';
const SHEET_TASK_STATUS = 'task_status';
const SHEET_SETTINGS    = 'settings';

// タイムゾーン (日本時間固定)
const TZ_JST = 'Asia/Tokyo';

// 特定のスプレッドシートIDを使う場合は、GAS エディタで
//   [プロジェクトの設定] → [スクリプト プロパティ] に
//   キー: SPREADSHEET_ID 値: 対象スプレッドシートのID
// を登録してください。
// 未設定の場合は ActiveSpreadsheet を使用 (コンテナバインド前提)。
const SPREADSHEET_ID_PROP_KEY = 'SPREADSHEET_ID';

// ================================================================
// Web アプリのエントリーポイント
// ================================================================

/**
 * Web アプリ表示用のエントリポイント
 * 初回アクセス時にシートが存在しなければ自動作成する
 */
function doGet() {
  // 必要なシートを初期化 (存在すれば何もしない)
  initializeSheetsIfNeeded();

  // Index.html をベースにテンプレートを評価して返す
  const template = HtmlService.createTemplateFromFile('Index');
  return template.evaluate()
    .setTitle('日常タスクボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * HTML テンプレート内から他のファイルを取り込むためのヘルパー
 * Index.html から <?!= include('Style') ?> のように呼び出して使う
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ================================================================
// スプレッドシート取得ヘルパー
// ================================================================

/**
 * 操作対象のスプレッドシートを返す
 * スクリプトプロパティ SPREADSHEET_ID が設定されていればそれを使い、
 * なければ ActiveSpreadsheet を使う (コンテナバインド前提)
 */
function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROP_KEY);
  if (id) {
    return SpreadsheetApp.openById(id);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

// ================================================================
// 初期化処理
// ================================================================

/**
 * 必要なシートが存在しなければ作成し、ヘッダーと初期データを投入する
 * Web アプリ初回アクセス時、または手動実行で呼び出す
 */
function initializeSheetsIfNeeded() {
  const ss = getSpreadsheet_();

  // 各シートを順番に初期化する
  initTimeSlotsSheet_(ss);
  initTasksSheet_(ss);
  initTaskStatusSheet_(ss);
  initSettingsSheet_(ss);
}

/**
 * time_slots シートを初期化する
 */
function initTimeSlotsSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_TIME_SLOTS);
  if (sheet) return; // 既存ならスキップ

  // シートを新規作成
  sheet = ss.insertSheet(SHEET_TIME_SLOTS);

  // ヘッダー行
  const headers = ['time_slot_id', 'name', 'start_time', 'end_time', 'active'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');

  // 初期データ (時刻は文字列 "HH:mm" として保存)
  const rows = [
    ['morning',            '朝',          '05:00', '10:00', true],
    ['noon_holiday',       '昼・休日',     '10:00', '16:00', true],
    ['night_before_sleep', '夜・寝かしつけ前', '16:00', '20:30', true],
    ['night_after_sleep',  '夜・寝かしつけ後', '20:30', '24:00', true],
  ];
  // 時刻列が日付型に自動変換されないよう、テキスト書式に設定
  sheet.getRange(2, 3, rows.length, 2).setNumberFormat('@');
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

  // 列幅をある程度整える
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 160);
  sheet.setFrozenRows(1);
}

/**
 * tasks シートを初期化する
 * 仕様書 18章の初期タスクを投入する
 */
function initTasksSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_TASKS);
  if (sheet) return;

  sheet = ss.insertSheet(SHEET_TASKS);

  // ヘッダー行
  const headers = [
    'task_id', 'time_slot_id', 'assignee', 'task_name',
    'sort_order', 'active', 'important', 'warning_minutes_before_end',
    'days', 'note'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');

  // 初期タスク一覧 (仕様書 18 章をベースに作成)
  // 各タスクは [time_slot_id, assignee, task_name, important] の順で並べた後、
  // 後段で task_id, sort_order, その他デフォルト値を付与する
  const seed = [
    // ----- 朝 -----
    ['morning', '父', 'ごみ捨て',       false],
    ['morning', '父', 'ランニング',     false],
    ['morning', '父', '朝食の片付け',   false],
    ['morning', '父', '食洗器の片付け', false],
    ['morning', '母', '子の身支度',     true],
    ['morning', '母', '着替え',         true],
    ['morning', '母', '朝食を作る',     true],
    ['morning', '母', '子と遊ぶ',       false],
    ['morning', '母', '歯磨き',         true],
    ['morning', '母', '保湿ケア',       true],

    // ----- 昼・休日 -----
    ['noon_holiday', '父', '休憩',       false],
    ['noon_holiday', '母', '子の身支度', true],
    ['noon_holiday', '母', '昼食を作る', true],
    ['noon_holiday', '母', '子と遊ぶ',   false],
    ['noon_holiday', '母', '歯磨き',     true],
    ['noon_holiday', '母', 'お昼寝',     false],
    ['noon_holiday', '母', '買い物',     false],

    // ----- 夜・寝かしつけ前 -----
    ['night_before_sleep', '父', '翌日の服の用意',   false],
    ['night_before_sleep', '父', '翌日の持ち物準備', false],
    ['night_before_sleep', '父', '洗濯',             false],
    ['night_before_sleep', '父', '休憩',             false],
    ['night_before_sleep', '父', '夕食の片付け',     false],
    ['night_before_sleep', '母', '夕食を作る',       true],
    ['night_before_sleep', '母', '歯磨き',           true],
    ['night_before_sleep', '母', 'お風呂',           true],
    ['night_before_sleep', '母', 'スキンケア',       true],
    ['night_before_sleep', '母', '保湿ケア',         true],
    ['night_before_sleep', '母', '寝かしつけ',       true],

    // ----- 夜・寝かしつけ後 -----
    ['night_after_sleep', '父', '休憩',             false],
    ['night_after_sleep', '母', '翌日の献立を考える', false],
    ['night_after_sleep', '母', '夕食の仕込み',     false],
    ['night_after_sleep', '母', '宅配サービス対応', false],
    ['night_after_sleep', '母', '消耗品の在庫確認', false],
    ['night_after_sleep', '母', '提出物の確認',     false],
    ['night_after_sleep', '母', '連絡事項の記入',   false],
  ];

  // 時間帯×担当者ごとに sort_order を採番しながら、行データを構築する
  const sortCounters = {}; // key: time_slot_id|assignee, value: 連番
  const rows = seed.map((s, idx) => {
    const [slotId, assignee, name, important] = s;
    const key = slotId + '|' + assignee;
    sortCounters[key] = (sortCounters[key] || 0) + 1;
    const taskId = 't' + String(idx + 1).padStart(3, '0');
    return [
      taskId,            // task_id
      slotId,            // time_slot_id
      assignee,          // assignee
      name,              // task_name
      sortCounters[key], // sort_order
      true,              // active
      important,         // important
      10,                // warning_minutes_before_end (10分前から警告)
      'all',             // days
      ''                 // note
    ];
  });

  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

  // 列幅・固定行
  sheet.setColumnWidth(1, 80);
  sheet.setColumnWidth(2, 180);
  sheet.setColumnWidth(4, 220);
  sheet.setFrozenRows(1);
}

/**
 * task_status シートを初期化する (ヘッダーのみ)
 */
function initTaskStatusSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_TASK_STATUS);
  if (sheet) return;

  sheet = ss.insertSheet(SHEET_TASK_STATUS);
  const headers = ['date', 'task_id', 'status', 'completed_at', 'completed_by'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');

  // 日付列・完了時刻列の書式を整える
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('D:D').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.setFrozenRows(1);
}

/**
 * settings シートを初期化する
 */
function initSettingsSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_SETTINGS);
  if (sheet) return;

  sheet = ss.insertSheet(SHEET_SETTINGS);
  const headers = ['key', 'value'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');

  // 仕様書 8.4 の初期値
  const rows = [
    ['app_title',               '日常タスクボード'],
    ['refresh_seconds',         30],
    ['warning_default_minutes', 10],
    ['show_done_tasks',         true],
    ['tablet_mode',             true],
  ];
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.setColumnWidth(1, 220);
  sheet.setFrozenRows(1);
}

// ================================================================
// データ取得
// ================================================================

/**
 * 画面表示に必要な情報をまとめて返す
 * クライアント側 google.script.run から呼び出される
 */
function getAppData() {
  // 安全のため、毎回シートの存在確認を行う (軽量、シートがあれば即 return)
  initializeSheetsIfNeeded();

  const ss = getSpreadsheet_();
  const today = getTodayString();
  const now   = new Date();

  return {
    settings:    readSettings_(ss),
    timeSlots:   readTimeSlots_(ss),
    tasks:       readTasks_(ss),
    taskStatus:  readTaskStatusForDate_(ss, today),
    today:       today,
    serverTime:  Utilities.formatDate(now, TZ_JST, "yyyy-MM-dd'T'HH:mm:ssXXX"),
  };
}

/**
 * settings シートを読み込んで key-value のオブジェクトとして返す
 */
function readSettings_(ss) {
  const sheet = ss.getSheetByName(SHEET_SETTINGS);
  const data  = sheet.getDataRange().getValues();
  const obj = {};
  // 1 行目はヘッダーなので 2 行目以降を処理
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0] || '').trim();
    if (!key) continue;
    obj[key] = data[i][1];
  }
  return obj;
}

/**
 * time_slots シートを読み込んで配列で返す
 */
function readTimeSlots_(ss) {
  const sheet = ss.getSheetByName(SHEET_TIME_SLOTS);
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0];
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = rowToObject_(headers, data[i]);
    if (!row.time_slot_id) continue;
    // 時刻が日付型で入っているケースに備えて文字列化
    row.start_time = toTimeString_(row.start_time);
    row.end_time   = toTimeString_(row.end_time);
    row.active     = toBool_(row.active);
    rows.push(row);
  }
  return rows;
}

/**
 * tasks シートを読み込んで配列で返す
 */
function readTasks_(ss) {
  const sheet = ss.getSheetByName(SHEET_TASKS);
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0];
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = rowToObject_(headers, data[i]);
    if (!row.task_id) continue;
    row.active     = toBool_(row.active);
    row.important  = toBool_(row.important);
    row.sort_order = Number(row.sort_order) || 0;
    row.warning_minutes_before_end = Number(row.warning_minutes_before_end) || 0;
    rows.push(row);
  }
  return rows;
}

/**
 * 指定日付の task_status を読み込んで返す
 * @param {Spreadsheet} ss
 * @param {string} dateStr yyyy-MM-dd
 */
function readTaskStatusForDate_(ss, dateStr) {
  const sheet = ss.getSheetByName(SHEET_TASK_STATUS);
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0];
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = rowToObject_(headers, data[i]);
    // 日付列が Date 型のことが多いので yyyy-MM-dd に整形して比較
    const rowDate = formatDateString_(row.date);
    if (rowDate !== dateStr) continue;
    row.date = rowDate;
    if (row.completed_at instanceof Date) {
      row.completed_at = Utilities.formatDate(row.completed_at, TZ_JST, 'yyyy-MM-dd HH:mm:ss');
    }
    rows.push(row);
  }
  return rows;
}

// ================================================================
// 完了状態の更新
// ================================================================

/**
 * タスクの完了状態を保存する
 * 同一日付・同一タスクIDの行があれば更新、なければ新規追加
 *
 * @param {string} taskId      対象のタスクID
 * @param {string} status      'done' または 'pending'
 * @param {string} completedBy 完了操作を行った人 (省略可)
 * @return {Object} 更新後のステータス行情報
 */
function updateTaskStatus(taskId, status, completedBy) {
  if (!taskId)  throw new Error('taskId が指定されていません');
  if (status !== 'done' && status !== 'pending') {
    throw new Error('status は done か pending を指定してください');
  }

  const ss    = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEET_TASK_STATUS);
  const today = getTodayString();
  const now   = new Date();

  // 既存行を線形検索 (家庭利用かつ件数が少ないので十分)
  const data = sheet.getDataRange().getValues();
  let foundRow = -1; // シート上の行番号 (1-origin)
  for (let i = 1; i < data.length; i++) {
    const rowDate = formatDateString_(data[i][0]);
    const rowTaskId = String(data[i][1] || '');
    if (rowDate === today && rowTaskId === taskId) {
      foundRow = i + 1;
      break;
    }
  }

  // 完了時刻 (done のときだけ記録)
  const completedAt = (status === 'done') ? now : '';
  const by = completedBy || '';

  if (foundRow > 0) {
    // 既存行を更新
    sheet.getRange(foundRow, 1, 1, 5).setValues([[
      today, taskId, status, completedAt, by
    ]]);
  } else {
    // 末尾に追加
    sheet.appendRow([today, taskId, status, completedAt, by]);
  }

  return {
    date: today,
    task_id: taskId,
    status: status,
    completed_at: completedAt instanceof Date
      ? Utilities.formatDate(completedAt, TZ_JST, 'yyyy-MM-dd HH:mm:ss')
      : '',
    completed_by: by,
  };
}

/**
 * 複数タスクの完了状態を一括で保存する
 * 一括完了ボタンから呼ばれる想定。シート読み込み 1 回 + 書き込み 1〜2 回で済むので
 * 件数が多くてもサーバー負荷は最小限になる
 *
 * @param {string[]} taskIds      対象タスクIDの配列
 * @param {string}   status       'done' または 'pending'
 * @param {string}   completedBy  完了操作を行った人 (省略可)
 * @return {Object} 更新サマリ {today, status, count, results: []}
 */
function updateTasksStatusBulk(taskIds, status, completedBy) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    throw new Error('taskIds が指定されていません');
  }
  if (status !== 'done' && status !== 'pending') {
    throw new Error('status は done か pending を指定してください');
  }

  const ss    = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEET_TASK_STATUS);
  const today = getTodayString();
  const now   = new Date();
  const completedAt = (status === 'done') ? now : '';
  const by = completedBy || '';

  // 既存データを 1 度だけ読み込み、taskId -> 行番号(1-origin) のマップを作る
  const data = sheet.getDataRange().getValues();
  const rowOfTask = {};
  for (let i = 1; i < data.length; i++) {
    const rowDate   = formatDateString_(data[i][0]);
    const rowTaskId = String(data[i][1] || '');
    if (rowDate !== today) continue;
    rowOfTask[rowTaskId] = i + 1;
  }

  // 既存行を更新するもの / 新規追加するものを分類
  const updates = []; // {rowNo, values}
  const appends = []; // values
  taskIds.forEach(function (taskId) {
    if (!taskId) return;
    const values = [today, taskId, status, completedAt, by];
    if (rowOfTask[taskId]) {
      updates.push({ rowNo: rowOfTask[taskId], values: values });
    } else {
      appends.push(values);
    }
  });

  // 既存行は 1 件ずつ更新 (列範囲が連続なので setValues で OK)
  updates.forEach(function (u) {
    sheet.getRange(u.rowNo, 1, 1, 5).setValues([u.values]);
  });

  // 新規行はまとめて末尾追加 (1回の書き込み)
  if (appends.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, appends.length, 5).setValues(appends);
  }

  return {
    today: today,
    status: status,
    count: updates.length + appends.length,
  };
}

// ================================================================
// ユーティリティ
// ================================================================

/**
 * 日本時間で今日の日付を yyyy-MM-dd 形式で返す
 */
function getTodayString() {
  return Utilities.formatDate(new Date(), TZ_JST, 'yyyy-MM-dd');
}

/**
 * シートの 1 行分の配列をヘッダーに従ってオブジェクトに変換する
 */
function rowToObject_(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    const key = String(headers[i] || '').trim();
    if (!key) continue;
    obj[key] = row[i];
  }
  return obj;
}

/**
 * セル値を "HH:mm" の文字列に揃える
 * Date 型・文字列・数値 (シリアル値) のいずれでも受け付ける
 */
function toTimeString_(val) {
  if (val == null || val === '') return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, TZ_JST, 'HH:mm');
  }
  // 文字列の場合: "HH:mm" や "H:mm" を 2桁0埋めして返す
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2}):(\d{1,2})/);
  if (m) {
    const hh = ('0' + m[1]).slice(-2);
    const mm = ('0' + m[2]).slice(-2);
    return hh + ':' + mm;
  }
  return s;
}

/**
 * セル値を yyyy-MM-dd の文字列に揃える
 */
function formatDateString_(val) {
  if (val == null || val === '') return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, TZ_JST, 'yyyy-MM-dd');
  }
  return String(val).trim();
}

/**
 * セル値を真偽値に変換する
 * TRUE/FALSE, true/false, 1/0, "TRUE"/"FALSE" を許容
 */
function toBool_(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number')  return val !== 0;
  const s = String(val || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}
