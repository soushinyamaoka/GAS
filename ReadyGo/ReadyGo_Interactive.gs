// ============================================================
// ReadyGo Interactive — 生活自動化AI秘書
// Google Apps Script (GAS)
// ============================================================

// --------------- 定数・設定読み込み ---------------

// 1回の実行内でキャッシュする（GASは実行ごとにリセットされる）
let _cfg = null;
let _ss = null;

function getConfig() {
  if (_cfg) return _cfg;
  const props = PropertiesService.getScriptProperties();
  const idsRaw = props.getProperty('LINE_USER_IDS') || '';
  const LINE_USER_IDS = idsRaw.split(',').map(id => id.trim()).filter(id => id.length > 0);
  _cfg = {
    LINE_TOKEN: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
    LINE_USER_IDS: LINE_USER_IDS,
    SPREADSHEET_ID: props.getProperty('SPREADSHEET_ID'),
    JMA_AREA_CODE: props.getProperty('JMA_AREA_CODE') || '130000',  // デフォルト: 東京
    GEMINI_API_KEY: props.getProperty('GEMINI_API_KEY'),
  };
  return _cfg;
}

function getSpreadsheet() {
  if (_ss) return _ss;
  _ss = SpreadsheetApp.openById(getConfig().SPREADSHEET_ID);
  return _ss;
}

// スプレッドシートからConfigシートの値を読み込む
function getSheetConfig() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName('Config');
  const data = sheet.getDataRange().getValues();
  const map = {};
  data.forEach(row => { map[row[0]] = row[1]; });
  return {
    prepTime: Number(map['準備時間'] || 45),
    travelTime: Number(map['移動時間'] || 15),
    rainExtraMin: Number(map['雨追加時間'] || 10),
    bentoExtraMin: Number(map['弁当追加時間'] || 20),
    rainThreshold: Number(map['傘閾値'] || 30),
    pressureThreshold: Number(map['気圧変動閾値'] || 6),
  };
}

// --------------- LINE Messaging API ---------------

function pushMessage(text) {
  const cfg = getConfig();
  const url = 'https://api.line.me/v2/bot/message/push';
  cfg.LINE_USER_IDS.forEach(userId => {
    try {
      const payload = {
        to: userId,
        messages: [{ type: 'text', text: text }],
      };
      UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + cfg.LINE_TOKEN },
        payload: JSON.stringify(payload),
      });
    } catch (e) {
      Logger.log('pushMessage failed for userId=' + userId + ': ' + e.message);
    }
  });
}

function replyMessage(replyToken, text) {
  const cfg = getConfig();
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }],
  };
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.LINE_TOKEN },
    payload: JSON.stringify(payload),
  });
}

// WebHook受信
function doPost(e) {
  const json = JSON.parse(e.postData.contents);
  const events = json.events || [];
  events.forEach(ev => {
    if (ev.type === 'message' && ev.message.type === 'text') {
      const userId = ev.source && ev.source.userId ? ev.source.userId : '不明';
      // 送信者の内部ユーザーIDをLogシートに記録（スクリプトプロパティへの登録確認用）
      writeLog('webhook', 'userId=' + userId + ' message=' + ev.message.text);
      replyMessage(ev.replyToken, 'あなたの内部IDは ' + userId + ' です');
    }
  });
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// --------------- 気象庁API（天気取得） ---------------

function weatherCodeToText(code) {
  const map = {
    '100': '☀️ 晴れ',            '101': '🌤 晴れ時々曇り',      '102': '🌦 晴れ一時雨',
    '103': '🌦 晴れ時々雨',      '104': '🌨 晴れ一時雪',        '105': '🌨 晴れ時々雪',
    '106': '🌦 晴れ一時雨か雪',  '107': '🌦 晴れ時々雨か雪',    '108': '⛈ 晴れ一時雨か雷雨',
    '110': '🌤 晴れ後曇り',      '111': '🌦 晴れ後雨',          '112': '🌦 晴れ後一時雨',
    '113': '🌦 晴れ後時々雨',    '114': '🌨 晴れ後雪',          '115': '🌨 晴れ後一時雪',
    '116': '🌨 晴れ後時々雪',    '117': '🌦 晴れ後雨か雪',      '119': '🌦 晴れ後曇り一時雨',
    '120': '🌦 晴れ朝夕一時雨',  '130': '🌤 朝曇り後晴れ',      '131': '🌤 晴れ明け方曇り',
    '140': '🌦 晴れ時々曇り一時雨', '160': '🌨 晴れ一時雪か雨', '170': '🌨 晴れ時々雪か雨',
    '181': '🌨 晴れ後雪か雨',
    '200': '☁️ 曇り',            '201': '⛅ 曇り時々晴れ',      '202': '🌧 曇り一時雨',
    '203': '🌧 曇り時々雨',      '204': '🌨 曇り一時雪',        '205': '🌨 曇り時々雪',
    '206': '🌧 曇り一時雨か雪',  '207': '🌧 曇り時々雨か雪',    '208': '⛈ 曇り一時雨か雷雨',
    '209': '🌫 霧',              '210': '⛅ 曇り後晴れ',         '211': '🌧 曇り後雨',
    '212': '🌧 曇り後一時雨',    '213': '🌧 曇り後時々雨',      '214': '🌨 曇り後雪',
    '215': '🌨 曇り後一時雪',    '216': '🌨 曇り後時々雪',      '217': '🌧 曇り後雨か雪',
    '218': '⛈ 曇り後雨か雷雨',  '220': '🌧 曇り朝夕一時雨',    '221': '🌧 曇り朝一時雨',
    '240': '🌧 曇り時々曇り一時雨', '250': '🌨 曇り時々雪一時雨', '260': '🌨 曇り一時雪か雨',
    '270': '🌨 曇り時々雪か雨',  '281': '🌨 曇り後雪か雨',
    '300': '🌧 雨',              '301': '🌦 雨時々晴れ',         '302': '🌧 雨時々雪',
    '303': '🌧 雨時々雪か雨',    '304': '🌧 雨か雪',            '306': '⛈ 大雨',
    '308': '⛈ 暴風雨',          '309': '🌧 雨一時雪',           '311': '🌦 雨後晴れ',
    '313': '🌧 雨後曇り',        '315': '🌨 雨後雪',            '320': '🌦 朝夕雨後晴れ',
    '328': '⛈ 雨一時強く降る',  '340': '🌨 雪か雨',            '350': '⛈ 雨で雷を伴う',
    '361': '🌨 雪か雨後晴れ',    '371': '🌨 雪か雨後曇り',
    '400': '🌨 雪',              '401': '🌨 雪時々晴れ',         '402': '🌨 雪時々止む',
    '403': '🌧 雪時々雨',        '405': '🌨 大雪',              '406': '🌨 風雪強い',
    '407': '🌨 暴風雪',          '409': '🌨 雪一時雨',           '411': '🌨 雪後晴れ',
    '413': '🌨 雪後曇り',        '414': '🌨 雪後雨',            '420': '🌨 朝夕雪後晴れ',
    '425': '🌨 雪一時強く降る',  '426': '🌨 雪後みぞれ',        '427': '🌨 雪一時みぞれ',
    '450': '⛈ 雪で雷を伴う',
  };
  return map[String(code)] || '不明(' + code + ')';
}

// 指定日の天気を気象庁APIから取得する
// dateStr: 'yyyy-MM-dd' 形式
function fetchWeatherForDate(dateStr) {
  const cfg = getConfig();
  const url = 'https://www.jma.go.jp/bosai/forecast/data/forecast/' + cfg.JMA_AREA_CODE + '.json';

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    writeLog('error', '気象庁API失敗 code=' + res.getResponseCode());
    return null;
  }

  try {
    const timeSeries = JSON.parse(res.getContentText())[0].timeSeries;

    // 天気コード（timeSeries[0]: 今日・明日・明後日の天気）
    const weatherSeries = timeSeries[0];
    const weatherArea = weatherSeries.areas[0];
    let weatherIdx = weatherSeries.timeDefines.findIndex(t => t.startsWith(dateStr));
    if (weatherIdx === -1) weatherIdx = 1; // 見つからない場合は明日(index 1)を使う
    const weatherCode = weatherArea.weatherCodes[weatherIdx];

    // 降水確率（timeSeries[1]: 6時間ごと）の対象日最大値
    const popSeries = timeSeries[1];
    const popArea = popSeries.areas[0];
    let maxPop = 0;
    popSeries.timeDefines.forEach((t, i) => {
      if (t.startsWith(dateStr)) {
        const pop = Number(popArea.pops[i]);
        if (!isNaN(pop) && pop > maxPop) maxPop = pop;
      }
    });

    // 気温（timeSeries[2]: temps単一配列。T00:xx=最低気温、T09:xx=最高気温）
    // ※ new Date().getHours()はUTC解釈になるため、時刻文字列から直接時間を取り出す
    const tempSeries = timeSeries[2];
    const tempArea = tempSeries.areas[0];
    let minTemp = null, maxTemp = null;
    tempSeries.timeDefines.forEach((t, i) => {
      if (!t.startsWith(dateStr)) return;
      const val = (tempArea.temps && tempArea.temps[i] !== '') ? Number(tempArea.temps[i]) : null;
      if (val === null || isNaN(val)) return;
      const hour = parseInt(t.substring(11, 13), 10); // 'yyyy-MM-ddTHH:mm:ss+09:00' のHH部分
      if (hour === 0)  minTemp = val;  // 0時 = 最低気温
      if (hour === 9)  maxTemp = val;  // 9時 = 最高気温
    });

    return { date: dateStr, maxTemp: maxTemp, minTemp: minTemp, precipProb: maxPop, weatherCode: weatherCode };
  } catch (e) {
    writeLog('error', '気象庁APIパース失敗: ' + e.message);
    return null;
  }
}

function getTomorrowWeather() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return fetchWeatherForDate(Utilities.formatDate(tomorrow, 'Asia/Tokyo', 'yyyy-MM-dd'));
}

// --------------- Open-Meteo（気圧・風・湿度・紫外線取得） ---------------

// 指定日のOpen-Meteoデータをまとめて取得する
// dateStr: 'yyyy-MM-dd' 形式
// 戻り値: { pressureRange, windMax, humidityMean, uvMax } または null（失敗時）
//   pressureRange: 気圧の最大値-最小値 (hPa)
//   windMax: 最大風速 (m/s)
//   humidityMean: 平均湿度 (%)
//   uvMax: 最大紫外線指数
// ※ 失敗時はnullを返すだけで他の通知処理には影響しない
function fetchOpenMeteoData(dateStr) {
  const lat = 35.6895;   // 東京
  const lon = 139.6917;  // 東京
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + lat
    + '&longitude=' + lon
    + '&hourly=pressure_msl,wind_speed_10m,relative_humidity_2m,uv_index'
    + '&timezone=Asia%2FTokyo'
    + '&start_date=' + dateStr
    + '&end_date=' + dateStr;

  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      writeLog('error', 'Open-Meteo失敗 code=' + res.getResponseCode());
      return null;
    }
    const json = JSON.parse(res.getContentText());
    const h = json.hourly || {};

    function numericValues(arr) {
      return (arr || []).filter(v => typeof v === 'number' && !isNaN(v));
    }
    function maxOf(arr) { return arr.length ? Math.max.apply(null, arr) : null; }
    function minOf(arr) { return arr.length ? Math.min.apply(null, arr) : null; }
    function meanOf(arr) {
      if (!arr.length) return null;
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    const pressures = numericValues(h.pressure_msl);
    const winds = numericValues(h.wind_speed_10m);
    const humidities = numericValues(h.relative_humidity_2m);
    const uvs = numericValues(h.uv_index);

    return {
      pressureRange: pressures.length >= 2 ? (maxOf(pressures) - minOf(pressures)) : null,
      windMax: maxOf(winds),
      humidityMean: meanOf(humidities),
      uvMax: maxOf(uvs),
    };
  } catch (e) {
    writeLog('error', 'Open-Meteo失敗: ' + e.message);
    return null;
  }
}

// --------------- Google Calendar ---------------

function getTomorrowFirstEvent() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const start = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0);
  const end = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59);

  const events = CalendarApp.getDefaultCalendar().getEvents(start, end);
  if (events.length === 0) return null;

  // 終日イベントを除いた最も早い予定を探す
  const timed = events.filter(ev => !ev.isAllDayEvent());
  if (timed.length === 0) {
    // 終日イベントのみ → タイトルだけ返す
    return { title: events[0].getTitle(), startTime: null, allDay: true };
  }
  timed.sort((a, b) => a.getStartTime() - b.getStartTime());
  return {
    title: timed[0].getTitle(),
    startTime: timed[0].getStartTime(),
    allDay: false,
  };
}

// 明日の全イベントタイトルを取得（弁当キーワード判定用）
function getTomorrowAllEventTitles() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const start = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0);
  const end = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59);
  return CalendarApp.getDefaultCalendar().getEvents(start, end).map(ev => ev.getTitle());
}

// --------------- スプレッドシート: Wasteシート ---------------

// その日が月内で何番目の同曜日かを返す（1〜5）
function getNthWeekdayOfMonth(date) {
  return Math.ceil(date.getDate() / 7);
}

// Wasteシートのキー文字列が対象日にマッチするか判定
// ・単純曜日: Monday / Tuesday / ... / Saturday / Sunday
// ・第N曜日形式: "1st Saturday" / "3rd Saturday" / "1st,3rd Saturday" など
function matchesWasteDay(key, date) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[date.getDay()];
  const nth = getNthWeekdayOfMonth(date);
  const ordinals = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };

  // 単純曜日マッチ（例: Monday, Saturday）
  if (key.trim() === dayName) return true;

  // 第N曜日マッチ: 曜日名が含まれる場合のみチェック
  // 例: "1st,3rd Saturday" は Saturday を含み、nth=1 なら '1st' を含むので true
  if (key.includes(dayName)) {
    const ordinal = ordinals[nth];
    if (ordinal && key.includes(ordinal)) return true;
  }

  return false;
}

// 指定日のゴミ種類をWasteシートから取得する共通関数
// Wasteシート: A列=曜日キー, B列=ゴミの種類（1行目はヘッダー）
function getWasteForDate(date) {
  const sheet = getSpreadsheet().getSheetByName('Waste');
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0]).trim();
    if (matchesWasteDay(key, date)) {
      return String(data[i][1]).trim();
    }
  }
  return null;
}

function getTomorrowWaste() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return getWasteForDate(tomorrow);
}

// --------------- Gemini API（服装アドバイスAI生成） ---------------

// 季節判定（月から）
function seasonOf(month) {
  if (month >= 3 && month <= 5) return '春';
  if (month >= 6 && month <= 8) return '夏';
  if (month >= 9 && month <= 11) return '秋';
  return '冬';
}

// ファクトをプロンプトに整形してGeminiに送り、服装アドバイス文を生成する
// 引数 facts: {
//   date: Date, dayLabel: '5/14（水）', season: '春',
//   minTemp, maxTemp, weatherText, precipProb,
//   windMax, humidityMean, uvMax,
//   eventTitles: [String]
// }
// 戻り値: 生成された文字列 / 失敗時 null
function generateClothingAdvice(facts) {
  const cfg = getConfig();
  if (!cfg.GEMINI_API_KEY) {
    writeLog('error', 'GEMINI_API_KEY未設定');
    return null;
  }

  const tempDiff = (facts.maxTemp !== null && facts.minTemp !== null)
    ? (facts.maxTemp - facts.minTemp).toFixed(1) : '不明';
  const wind = facts.windMax !== null ? facts.windMax.toFixed(1) + 'm/s' : '不明';
  const humidity = facts.humidityMean !== null ? Math.round(facts.humidityMean) + '%' : '不明';
  const uv = facts.uvMax !== null ? facts.uvMax.toFixed(1) : '不明';
  const events = (facts.eventTitles && facts.eventTitles.length > 0)
    ? facts.eventTitles.join('、') : 'なし';

  const prompt =
    'あなたは日本在住者向けの服装アドバイザーです。\n'
    + '以下の明日の気象・予定情報を元に、2〜3文の具体的な服装アドバイスを日本語で作成してください。\n'
    + '絵文字を1〜2個使い、要点を端的に。前置きや見出しは不要。本文のみ。\n\n'
    + '【日付】' + facts.dayLabel + ' ' + facts.season + '\n'
    + '【気温】最低' + (facts.minTemp !== null ? facts.minTemp : '不明') + '℃ / '
      + '最高' + (facts.maxTemp !== null ? facts.maxTemp : '不明') + '℃（差' + tempDiff + '℃）\n'
    + '【天気】' + (facts.weatherText || '不明') + '\n'
    + '【降水確率】' + (facts.precipProb !== null && facts.precipProb !== undefined ? facts.precipProb + '%' : '不明') + '\n'
    + '【風】最大' + wind + '\n'
    + '【湿度】平均' + humidity + '\n'
    + '【紫外線指数】' + uv + '\n'
    + '【予定】' + events;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + cfg.GEMINI_API_KEY;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
      // Gemini 2.5系はthinkingモデル。thinkingでトークンが消費され本文が切れるため無効化する
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      writeLog('error', 'Gemini失敗 code=' + res.getResponseCode() + ' body=' + res.getContentText().substring(0, 300));
      return null;
    }
    const json = JSON.parse(res.getContentText());
    const text = json && json.candidates && json.candidates[0]
      && json.candidates[0].content && json.candidates[0].content.parts
      && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
    if (!text) {
      writeLog('error', 'Gemini応答パース失敗: ' + res.getContentText().substring(0, 300));
      return null;
    }
    return text.trim();
  } catch (e) {
    writeLog('error', 'Gemini呼び出し失敗: ' + e.message);
    return null;
  }
}

// --------------- スプレッドシート: Clothingシート ---------------

function getClothingAdvice(minTemp, maxTemp) {
  const sheet = getSpreadsheet().getSheetByName('Clothing');
  const data = sheet.getDataRange().getValues();

  // Clothingシート想定: A列=下限気温, B列=上限気温, C列=服装アドバイス
  for (let i = 1; i < data.length; i++) {
    const lo = Number(data[i][0]);
    const hi = Number(data[i][1]);
    if (minTemp >= lo && minTemp <= hi) {
      return String(data[i][2]);
    }
  }
  return '気温に応じた服装でお出かけください';
}

// --------------- スプレッドシート: Inboxシート（外部GASからのメッセージ受信） ---------------

// Inboxシートから未処理メッセージを取得する
// Inboxシート: A列=投入日時, B列=ソース, C列=本文, D列=処理済 (1行目はヘッダー)
// 戻り値: { rowIndices: [行番号...], bodies: [本文...] } （投入日時昇順）
function getPendingInboxMessages() {
  try {
    const sheet = getSpreadsheet().getSheetByName('Inbox');
    if (!sheet) return { rowIndices: [], bodies: [] };
    const data = sheet.getDataRange().getValues();
    const items = [];
    for (let i = 1; i < data.length; i++) {
      const postedAt = data[i][0];
      const body = String(data[i][2] || '').trim();
      const processed = data[i][3] === true;
      if (!processed && body.length > 0) {
        items.push({ rowIndex: i + 1, postedAt: postedAt, body: body });
      }
    }
    items.sort((a, b) => {
      const ta = a.postedAt instanceof Date ? a.postedAt.getTime() : 0;
      const tb = b.postedAt instanceof Date ? b.postedAt.getTime() : 0;
      return ta - tb;
    });
    return {
      rowIndices: items.map(it => it.rowIndex),
      bodies: items.map(it => it.body),
    };
  } catch (e) {
    writeLog('error', 'Inbox取得失敗: ' + e.message);
    return { rowIndices: [], bodies: [] };
  }
}

// 指定行のD列にTRUEを書き込み、処理済としてマークする
function markInboxAsProcessed(rowIndices) {
  if (!rowIndices || rowIndices.length === 0) return;
  const sheet = getSpreadsheet().getSheetByName('Inbox');
  if (!sheet) return;
  rowIndices.forEach(rowIndex => {
    sheet.getRange(rowIndex, 4).setValue(true);
  });
}

// --------------- ログ記録 ---------------

function writeLog(type, message) {
  const sheet = getSpreadsheet().getSheetByName('Log');
  sheet.appendRow([
    new Date(),
    type,
    message.substring(0, 500), // 長すぎる場合は切り詰め
  ]);
}

// --------------- メインロジック ---------------

function buildNightMessage(inboxBodies) {
  // 1. 天気取得
  const weather = getTomorrowWeather();

  // 2. カレンダー取得
  const firstEvent = getTomorrowFirstEvent();
  const allTitles = getTomorrowAllEventTitles();

  // 3. ゴミ出し取得
  const waste = getTomorrowWaste();

  // 4. Open-Meteoから気圧・風・湿度・紫外線をまとめて取得
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = Utilities.formatDate(tomorrow, 'Asia/Tokyo', 'yyyy-MM-dd');
  const meteo = fetchOpenMeteoData(tomorrowStr);

  // 5. 服装アドバイス（Gemini AI生成 → 失敗時はClothingシートにフォールバック）
  let clothing = null;
  if (weather && weather.minTemp !== null) {
    const facts = {
      dayLabel: Utilities.formatDate(tomorrow, 'Asia/Tokyo', 'M/d（E）'),
      season: seasonOf(tomorrow.getMonth() + 1),
      minTemp: weather.minTemp,
      maxTemp: weather.maxTemp,
      weatherText: weatherCodeToText(weather.weatherCode),
      precipProb: weather.precipProb,
      windMax: meteo ? meteo.windMax : null,
      humidityMean: meteo ? meteo.humidityMean : null,
      uvMax: meteo ? meteo.uvMax : null,
      eventTitles: allTitles,
    };
    clothing = generateClothingAdvice(facts);
    if (!clothing) {
      clothing = getClothingAdvice(weather.minTemp, weather.maxTemp);
    }
  }

  // 6. 設定取得
  const sCfg = getSheetConfig();

  // 6. 起床時間の逆算
  let wakeUpText = '';
  if (firstEvent && firstEvent.startTime) {
    let wakeUp = new Date(firstEvent.startTime.getTime());
    wakeUp.setMinutes(wakeUp.getMinutes() - sCfg.prepTime - sCfg.travelTime);

    const rainOver50 = weather && weather.precipProb > 50;
    if (rainOver50) wakeUp.setMinutes(wakeUp.getMinutes() - sCfg.rainExtraMin);
    const hasBento = allTitles.some(t => t.includes('弁当'));
    if (hasBento) wakeUp.setMinutes(wakeUp.getMinutes() - sCfg.bentoExtraMin);

    wakeUpText = '⏰ 起床時刻: ' + Utilities.formatDate(wakeUp, 'Asia/Tokyo', 'HH:mm');
    if (rainOver50) wakeUpText += '（☔雨のため+' + sCfg.rainExtraMin + '分）';
    if (hasBento) wakeUpText += '（🍱弁当のため+' + sCfg.bentoExtraMin + '分）';
  } else {
    wakeUpText = '⏰ 明日は時間指定の予定がありません。ゆっくり休んでください！';
  }

  // 7. 持ち物
  const items = [];
  if (weather && weather.precipProb > sCfg.rainThreshold) items.push('☂ 傘');
  if (waste) items.push('🗑 ゴミ出し: ' + waste);

  // 8. メッセージ組み立て
  const dateLabel = Utilities.formatDate(tomorrow, 'Asia/Tokyo', 'M/d（E）');

  const lines = [
    '🌙 おやすみ前の明日チェック',
    '━━━━━━━━━━━━━━',
    '📅 ' + dateLabel,
    '',
  ];

  if (weather) {
    lines.push('🌡 天気: ' + weatherCodeToText(weather.weatherCode));
    lines.push('   最高 ' + weather.maxTemp + '℃ / 最低 ' + weather.minTemp + '℃');
    lines.push('   降水確率: ' + weather.precipProb + '%');
  } else {
    lines.push('🌡 天気: 取得できませんでした');
  }

  lines.push('');
  if (clothing) lines.push('👔 服装: ' + clothing);
  lines.push('');
  lines.push(wakeUpText);

  if (firstEvent) {
    lines.push('   📌 最初の予定: ' + firstEvent.title
      + (firstEvent.startTime
        ? '（' + Utilities.formatDate(firstEvent.startTime, 'Asia/Tokyo', 'HH:mm') + '〜）'
        : '（終日）'));
  }

  if (items.length > 0) {
    lines.push('');
    lines.push('🎒 持ち物リマインド');
    items.forEach(item => lines.push('   ' + item));
  }

  // 気圧アラート（翌日の気圧変動幅が閾値超なら表示。fetchOpenMeteoDataで取得済みの値を再利用）
  if (meteo && meteo.pressureRange !== null && meteo.pressureRange >= sCfg.pressureThreshold) {
    lines.push('');
    lines.push('⚠️ 気圧アラート');
    lines.push('   明日は気圧変動が大きい予報です（▼' + meteo.pressureRange.toFixed(1) + 'hPa）');
    lines.push('   体調にご注意ください');
  }

  // Inboxからの外部メッセージを末尾に追加
  if (inboxBodies && inboxBodies.length > 0) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━');
    lines.push('📨 お知らせ');
    inboxBodies.forEach((body, idx) => {
      if (idx > 0) lines.push('');
      lines.push(body);
    });
  }

  lines.push('');
  lines.push('おやすみなさい 💤');

  return lines.join('\n');
}

function buildMorningMessage() {
  // 朝は「今日」の情報を取得する
  const today = new Date();
  const dateStr = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy-MM-dd');
  const todayWeather = fetchWeatherForDate(dateStr);

  const clothing = (todayWeather && todayWeather.minTemp !== null) ? getClothingAdvice(todayWeather.minTemp, todayWeather.maxTemp) : null;
  const todayWaste = getWasteForDate(today);
  const sCfg = getSheetConfig();

  const items = [];
  if (todayWeather && todayWeather.precipProb > sCfg.rainThreshold) items.push('☂ 傘を忘れずに！');
  if (todayWaste) items.push('🗑 ゴミ出し: ' + todayWaste);

  const lines = [
    '☀️ おはようございます！',
    '━━━━━━━━━━━━━━',
  ];

  if (todayWeather) {
    var tempText;
    if (todayWeather.minTemp === null || todayWeather.minTemp === todayWeather.maxTemp) {
      tempText = ' 最高' + todayWeather.maxTemp + '℃';
    } else {
      tempText = ' ' + todayWeather.maxTemp + '℃/' + todayWeather.minTemp + '℃';
    }
    lines.push('🌡 ' + weatherCodeToText(todayWeather.weatherCode) + tempText);
  } else {
    lines.push('🌡 天気: 取得できませんでした');
  }

  if (clothing) lines.push('👔 ' + clothing);

  if (items.length > 0) {
    lines.push('');
    items.forEach(item => lines.push(item));
  }

  // 気圧アラート（今日の気圧変動幅が閾値超なら表示）
  const todayMeteo = fetchOpenMeteoData(dateStr);
  if (todayMeteo && todayMeteo.pressureRange !== null && todayMeteo.pressureRange >= sCfg.pressureThreshold) {
    lines.push('');
    lines.push('⚠️ 気圧アラート');
    lines.push('   今日は気圧変動が大きい予報です（▼' + todayMeteo.pressureRange.toFixed(1) + 'hPa）');
    lines.push('   体調にご注意ください');
  }

  lines.push('');
  lines.push('今日も良い一日を！ 💪');

  return lines.join('\n');
}

// --------------- 実行エントリポイント ---------------

// 夜の通知（トリガーで21:00に設定）
function sendNightNotification() {
  const inbox = getPendingInboxMessages();
  const msg = buildNightMessage(inbox.bodies);
  pushMessage(msg);
  writeLog('night', msg);
  if (inbox.rowIndices.length > 0) {
    try {
      markInboxAsProcessed(inbox.rowIndices);
    } catch (e) {
      writeLog('error', 'Inbox処理済マーク失敗: ' + e.message);
    }
  }
}

// 朝の通知（トリガーで起床時刻に設定 — 手動 or 動的トリガー）
function sendMorningNotification() {
  const msg = buildMorningMessage();
  pushMessage(msg);
  writeLog('morning', msg);
}

// --------------- トリガー設定（フェーズ3） ---------------

// 初回セットアップ用: 手動で1回実行する
function setupTriggers() {
  // 既存トリガーを削除
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 毎日21:00 — 夜の通知
  ScriptApp.newTrigger('sendNightNotification')
    .timeBased()
    .everyDays(1)
    .atHour(21)
    .nearMinute(0)
    .create();

  // 毎日6:30 — 朝の通知（デフォルト。動的に変えたい場合は夜の通知で再設定）
  ScriptApp.newTrigger('sendMorningNotification')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .nearMinute(30)
    .create();

  Logger.log('トリガーを設定しました');
}

// 夜の通知時に翌朝のトリガーを動的に設定する場合
function setDynamicMorningTrigger(wakeHour, wakeMinute) {
  // 既存の朝トリガーを削除
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendMorningNotification') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 新しいトリガー（GASの時間トリガーは±15分の誤差あり）
  ScriptApp.newTrigger('sendMorningNotification')
    .timeBased()
    .everyDays(1)
    .atHour(wakeHour)
    .nearMinute(wakeMinute)
    .create();
}
