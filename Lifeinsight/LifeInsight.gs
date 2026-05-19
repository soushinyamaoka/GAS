// ============================================================
// ライフ・インサイト（体調・気象相関分析システム）
// Google Apps Script
// ============================================================

// --- 定数 ---
const SHEET_NAME_RESPONSES = 'フォームの回答 1';
const SHEET_NAME_WEATHER_LOG = '気象ログ';
const SHEET_NAME_LOG = 'Log';

// GAS追記列（G〜N = 7〜14）※フォーム回答シート
const COL = {
  TIMESTAMP:       1,  // A
  MOOD:            2,  // B: 気分
  CONDITION:       3,  // C: 体調
  SLEEP:           4,  // D: 睡眠の質
  MEMO:            5,  // E: メモ
  CHECK_ITEMS:     6,  // F: チェック項目
  PRESSURE:        7,  // G: 瞬間気圧
  PRESSURE_TREND:  8,  // H: 気圧トレンド（3h）
  PRESSURE_24H:    9,  // I: 24h変動幅
  TEMPERATURE:    10,  // J: 気温
  TEMP_DIFF:      11,  // K: 寒暖差
  HUMIDITY:       12,  // L: 湿度
  MOON_AGE:       13,  // M: 月齢
  HOLIDAY_FLAG:   14,  // N: 休日フラグ
};

// 気象ログシートの列
const COL_WEATHER = {
  DATE:            1,  // A: 日付
  PRESSURE:        2,  // B: 瞬間気圧（正午）
  PRESSURE_TREND:  3,  // C: 気圧トレンド
  PRESSURE_24H:    4,  // D: 24h変動幅（確定）
  TEMPERATURE:     5,  // E: 気温（正午）
  TEMP_DIFF:       6,  // F: 寒暖差（確定）
  HUMIDITY:        7,  // G: 湿度（正午）
  MOON_AGE:        8,  // H: 月齢
  HOLIDAY_FLAG:    9,  // I: 休日フラグ
};

// ============================================================
// メイン: フォーム送信時トリガー
// ============================================================
function onFormSubmit(e) {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME_RESPONSES);
    if (!sheet) throw new Error('シート "' + SHEET_NAME_RESPONSES + '" が見つかりません');

    const row = e.range.getRow();
    const timestamp = sheet.getRange(row, COL.TIMESTAMP).getValue();
    const submitDate = new Date(timestamp);

    const { lat, lon } = getLocation();

    // 気象データ取得（前日0:00〜送信時刻をカバー）
    const weather = fetchWeatherData(lat, lon, submitDate);

    // 瞬間値の算出
    const instantValues = calculateInstantValues(weather, submitDate);

    // 暫定の寒暖差・24h変動幅
    const tempDiff = calculateTempDiff(weather, submitDate, false);
    const pressure24h = calculatePressure24hRange(weather, submitDate, false);

    // 月齢・休日
    const moonAge = calculateMoonAge(submitDate);
    const holiday = isHoliday(submitDate);

    // G〜N列に書き込み
    const values = [
      instantValues.pressure,
      instantValues.pressureTrend,
      pressure24h,
      instantValues.temperature,
      tempDiff,
      instantValues.humidity,
      moonAge,
      holiday,
    ];

    sheet.getRange(row, COL.PRESSURE, 1, values.length).setValues([values]);

  } catch (error) {
    logError('onFormSubmit', error.message);
  }
}

// ============================================================
// 日次更新: 毎日0:05に実行
// ============================================================
function updateDailySummary() {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME_RESPONSES);
    if (!sheet) throw new Error('シート "' + SHEET_NAME_RESPONSES + '" が見つかりません');

    const { lat, lon } = getLocation();

    // 「前日」を対象にする
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

    // 前日分の確定気象データを取得（前々日〜前日の2日間）
    const weatherConfirmed = fetchWeatherDataDaily(lat, lon, yesterday);

    // 確定値の算出
    const confirmedTempDiff = calculateTempDiff(weatherConfirmed, yesterday, true);
    const confirmedPressure24h = calculatePressure24hRange(weatherConfirmed, yesterday, true);

    // 前日の入力行を検索
    const rows = findRowsByDate(sheet, yesterday);

    if (rows.length > 0) {
      // フォーム入力があった日 → 24h変動幅(I列)と寒暖差(K列)を確定値で上書き
      rows.forEach(function(row) {
        sheet.getRange(row, COL.PRESSURE_24H).setValue(confirmedPressure24h);
        sheet.getRange(row, COL.TEMP_DIFF).setValue(confirmedTempDiff);
      });
    } else {
      // フォーム入力がなかった日 → 「気象ログ」シートに1行追記
      const weatherLogSheet = getOrCreateWeatherLogSheet(ss);

      const representativeHour = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 12, 0, 0);
      const weatherHourly = fetchWeatherData(lat, lon, representativeHour);
      const instantValues = calculateInstantValues(weatherHourly, representativeHour);
      const moonAge = calculateMoonAge(yesterday);
      const holiday = isHoliday(yesterday);

      weatherLogSheet.appendRow([
        yesterday,
        instantValues.pressure,
        instantValues.pressureTrend,
        confirmedPressure24h,
        instantValues.temperature,
        confirmedTempDiff,
        instantValues.humidity,
        moonAge,
        holiday,
      ]);
    }

    // 過去1ヶ月の欠損データを自動補完
    backfillMissingWeatherData();

  } catch (error) {
    logError('updateDailySummary', error.message);
  }
}

// ============================================================
// 欠損気象データの自動補完（過去10日以内）
// ============================================================
// AMeDAS APIの観測点別データ保持期間が約10日のため上限を10日とする。
function backfillMissingWeatherData() {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME_RESPONSES);
    if (!sheet) throw new Error('シート "' + SHEET_NAME_RESPONSES + '" が見つかりません');

    const { lat, lon } = getLocation();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tenDaysAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 10);

    // --- 1. フォーム回答シートで気象データが空の行を補完 ---
    const lastRow = sheet.getLastRow();
    const formDates = new Set();

    if (lastRow >= 2) {
      const data = sheet.getRange(2, 1, lastRow - 1, COL.HOLIDAY_FLAG).getValues();

      for (let i = 0; i < data.length; i++) {
        const timestamp = data[i][COL.TIMESTAMP - 1];
        if (!(timestamp instanceof Date)) continue;

        const rowDate = new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate());
        const dateStr = Utilities.formatDate(rowDate, 'Asia/Tokyo', 'yyyy-MM-dd');
        formDates.add(dateStr);

        // 対象期間外はスキップ
        if (rowDate < tenDaysAgo || rowDate >= today) continue;

        // 気象データが既に入っていればスキップ
        const pressure = data[i][COL.PRESSURE - 1];
        if (pressure !== '' && pressure !== null) continue;

        const row = i + 2;
        try {
          const weather = fetchWeatherData(lat, lon, timestamp);
          const instantValues = calculateInstantValues(weather, timestamp);
          const tempDiff = calculateTempDiff(weather, timestamp, false);
          const pressure24h = calculatePressure24hRange(weather, timestamp, false);
          const moonAge = calculateMoonAge(timestamp);
          const holiday = isHoliday(timestamp);

          const values = [
            instantValues.pressure,
            instantValues.pressureTrend,
            pressure24h,
            instantValues.temperature,
            tempDiff,
            instantValues.humidity,
            moonAge,
            holiday,
          ];
          sheet.getRange(row, COL.PRESSURE, 1, values.length).setValues([values]);
          console.log('補完完了（フォーム回答）: ' + dateStr);
        } catch (e) {
          logError('backfillMissingWeatherData', dateStr + '（フォーム行）: ' + e.message);
        }
      }
    }

    // --- 2. 気象ログシートの欠損日を補完 ---
    const weatherLogSheet = getOrCreateWeatherLogSheet(ss);

    // 既存の気象ログ日付を収集
    const logLastRow = weatherLogSheet.getLastRow();
    const existingLogDates = new Set();
    if (logLastRow >= 2) {
      const logDates = weatherLogSheet.getRange(2, COL_WEATHER.DATE, logLastRow - 1, 1).getValues();
      logDates.forEach(function(row) {
        if (row[0] instanceof Date) {
          existingLogDates.add(Utilities.formatDate(row[0], 'Asia/Tokyo', 'yyyy-MM-dd'));
        }
      });
    }

    // 1ヶ月前〜昨日の各日をチェック
    for (let d = new Date(tenDaysAgo); d < today; d.setDate(d.getDate() + 1)) {
      const dateStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');

      // フォーム回答がある日はスキップ（上で処理済み）
      if (formDates.has(dateStr)) continue;

      // 気象ログに既にあればスキップ
      if (existingLogDates.has(dateStr)) continue;

      try {
        const targetDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const weatherConfirmed = fetchWeatherDataDaily(lat, lon, targetDate);
        const confirmedTempDiff = calculateTempDiff(weatherConfirmed, targetDate, true);
        const confirmedPressure24h = calculatePressure24hRange(weatherConfirmed, targetDate, true);

        const representativeHour = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 12, 0, 0);
        const weatherHourly = fetchWeatherData(lat, lon, representativeHour);
        const instantValues = calculateInstantValues(weatherHourly, representativeHour);
        const moonAge = calculateMoonAge(targetDate);
        const holiday = isHoliday(targetDate);

        weatherLogSheet.appendRow([
          targetDate,
          instantValues.pressure,
          instantValues.pressureTrend,
          confirmedPressure24h,
          instantValues.temperature,
          confirmedTempDiff,
          instantValues.humidity,
          moonAge,
          holiday,
        ]);
        existingLogDates.add(dateStr);
        console.log('補完完了（気象ログ）: ' + dateStr);

        Utilities.sleep(500); // API負荷軽減
      } catch (e) {
        logError('backfillMissingWeatherData', dateStr + '（気象ログ）: ' + e.message);
      }
    }

    console.log('backfillMissingWeatherData 完了');
  } catch (error) {
    logError('backfillMissingWeatherData', error.message);
  }
}

// ============================================================
// 「気象ログ」シートの取得 or 作成
// ============================================================
function getOrCreateWeatherLogSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME_WEATHER_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME_WEATHER_LOG);
    sheet.appendRow([
      '日付',
      '瞬間気圧 (hPa)',
      '気圧トレンド (hPa)',
      '24h変動幅 (hPa)',
      '気温 (℃)',
      '寒暖差 (℃)',
      '湿度 (%)',
      '月齢',
      '休日フラグ',
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ============================================================
// 気象データ取得: 時系列（前日0:00〜送信日）
// ============================================================
function fetchWeatherData(lat, lon, targetDate) {
  const stationCode = getAmedasStationCode();
  const start = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() - 1, 0, 0, 0);
  const amedasData = fetchAmedasData(stationCode, start, targetDate);
  return adaptAmedasToHourly(amedasData);
}

// ============================================================
// 気象データ取得: 日次確定用（前々日〜前日の2日間）
// ============================================================
function fetchWeatherDataDaily(lat, lon, targetDate) {
  const stationCode = getAmedasStationCode();
  const dayBefore = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() - 1, 0, 0, 0);
  const endOfTarget = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59);
  const amedasData = fetchAmedasData(stationCode, dayBefore, endOfTarget);
  return adaptAmedasToHourly(amedasData);
}

// ============================================================
// AMeDAS観測点テーブル取得
// ============================================================
function fetchAmedasStationTable() {
  const url = 'https://www.jma.go.jp/bosai/amedas/const/amedastable.json';
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('AMeDAS観測点テーブル取得エラー: ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}

// ============================================================
// 最寄りAMeDAS観測点を選定（気温・湿度・気圧を観測している官署のみ）
// ============================================================
// elems は8桁の観測項目フラグ:
//   1=風向風速, 2=気温, 3=相対湿度, 4=降水量, 5=積雪深, 6=日照時間, 7=全天日射量, 8=気圧
// 気圧・湿度を観測しているのは「官署」のみで、これらは通常全項目を観測している。
// そのため elems が全桁 "1" の観測点を対象にする。
function findNearestAmedasStation(lat, lon) {
  const stations = fetchAmedasStationTable();
  let nearest = null;
  let minDist = Infinity;

  for (const code in stations) {
    const s = stations[code];
    if (!s.elems) continue;
    if (s.elems.indexOf('0') !== -1) continue; // 全項目観測（全桁"1"）のみ対象

    const sLat = s.lat[0] + s.lat[1] / 60;
    const sLon = s.lon[0] + s.lon[1] / 60;
    const dist = Math.sqrt(Math.pow(sLat - lat, 2) + Math.pow(sLon - lon, 2));

    if (dist < minDist) {
      minDist = dist;
      nearest = { code: code, name: s.kjName, lat: sLat, lon: sLon };
    }
  }

  if (!nearest) throw new Error('該当するAMeDAS観測点が見つかりません');
  return nearest;
}

// ============================================================
// 観測点コード取得（プロパティから取得 or 自動選定して保存）
// ============================================================
function getAmedasStationCode() {
  const props = PropertiesService.getScriptProperties();
  let code = props.getProperty('AMEDAS_STATION_CODE');
  if (!code) {
    const { lat, lon } = getLocation();
    const station = findNearestAmedasStation(lat, lon);
    code = station.code;
    props.setProperty('AMEDAS_STATION_CODE', code);
    console.log('AMeDAS観測点を自動設定: ' + station.name + ' (' + code + ')');
  }
  return code;
}

// ============================================================
// AMeDAS時系列データ取得（指定期間のバッチを統合）
// ============================================================
// AMeDAS APIは3時間ごとのバッチ配信（00, 03, 06, 09, 12, 15, 18, 21）。
// 1ファイルに3時間分の10分ごとデータが含まれる。
function fetchAmedasData(stationCode, startDate, endDate) {
  const result = {};

  // 開始時刻を3時間境界に正規化
  const startBatch = new Date(startDate);
  startBatch.setMinutes(0, 0, 0);
  startBatch.setHours(Math.floor(startBatch.getHours() / 3) * 3);

  const endBatch = new Date(endDate);
  endBatch.setMinutes(0, 0, 0);
  endBatch.setHours(Math.floor(endBatch.getHours() / 3) * 3);

  for (let d = new Date(startBatch); d <= endBatch; d.setHours(d.getHours() + 3)) {
    const dateStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMMdd');
    const hourStr = Utilities.formatDate(d, 'Asia/Tokyo', 'HH');
    const url = 'https://www.jma.go.jp/bosai/amedas/data/point/'
              + stationCode + '/' + dateStr + '_' + hourStr + '.json';

    try {
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() === 200) {
        const data = JSON.parse(response.getContentText());
        for (const k in data) result[k] = data[k];
      }
    } catch (e) {
      // バッチ単位の失敗は無視（保持期間外など）
    }
    Utilities.sleep(200);
  }

  return result;
}

// ============================================================
// AMeDASデータを内部共通形式（hourly配列）に変換
// ============================================================
// 内部形式: { hourly: { time: [...], surface_pressure: [...], temperature_2m: [...], relative_humidity_2m: [...] } }
// AMeDAS時刻キー（YYYYMMDDHHmmss）の00分のみを1時間刻みデータとして抽出。
function adaptAmedasToHourly(amedasData) {
  const times = [];
  const pressures = [];
  const temperatures = [];
  const humidities = [];

  const sortedKeys = Object.keys(amedasData).sort();

  for (const key of sortedKeys) {
    if (key.length < 14) continue;
    if (key.substring(10, 12) !== '00') continue; // 00分のみ採用

    const d = amedasData[key];
    if (!d) continue;

    const year = key.substring(0, 4);
    const month = key.substring(4, 6);
    const day = key.substring(6, 8);
    const hour = key.substring(8, 10);
    const minute = key.substring(10, 12);
    const timeStr = year + '-' + month + '-' + day + 'T' + hour + ':' + minute;

    times.push(timeStr);
    pressures.push(d.pressure ? d.pressure[0] : null);
    temperatures.push(d.temp ? d.temp[0] : null);
    humidities.push(d.humidity ? d.humidity[0] : null);
  }

  return {
    hourly: {
      time: times,
      surface_pressure: pressures,
      temperature_2m: temperatures,
      relative_humidity_2m: humidities,
    }
  };
}

// ============================================================
// 瞬間値の算出（送信時刻に最も近い時間帯のデータ）
// ============================================================
function calculateInstantValues(weather, targetDate) {
  const hourly = weather.hourly;
  const times = hourly.time;
  const targetTime = targetDate.getTime();

  if (!times || times.length === 0) {
    return { pressure: null, pressureTrend: null, temperature: null, humidity: null };
  }

  let closestIdx = 0;
  let minDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]).getTime();
    const diff = Math.abs(t - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closestIdx = i;
    }
  }

  // 気圧トレンド: 3時間前との差
  const trendIdx = Math.max(0, closestIdx - 3);
  const pCur = hourly.surface_pressure[closestIdx];
  const pTrend = hourly.surface_pressure[trendIdx];
  const pressureTrend = (pCur != null && pTrend != null) ? roundTo(pCur - pTrend, 1) : null;

  const t = hourly.temperature_2m[closestIdx];
  const h = hourly.relative_humidity_2m[closestIdx];

  return {
    pressure: pCur != null ? roundTo(pCur, 1) : null,
    pressureTrend: pressureTrend,
    temperature: t != null ? roundTo(t, 1) : null,
    humidity: h != null ? Math.round(h) : null,
  };
}

// ============================================================
// 24h変動幅の算出
// ============================================================
function calculatePressure24hRange(weather, targetDate, isConfirmed) {
  const hourly = weather.hourly;
  const times = hourly.time;
  const pressures = hourly.surface_pressure;

  if (isConfirmed) {
    const targetDateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
    const dayPressures = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i].startsWith(targetDateStr)) {
        if (pressures[i] != null) dayPressures.push(pressures[i]);
      }
    }
    if (dayPressures.length === 0) return null;
    return roundTo(Math.max(...dayPressures) - Math.min(...dayPressures), 1);
  } else {
    const targetTime = targetDate.getTime();
    const start24h = targetTime - 24 * 60 * 60 * 1000;
    const rangePressures = [];
    for (let i = 0; i < times.length; i++) {
      const t = new Date(times[i]).getTime();
      if (t >= start24h && t <= targetTime && pressures[i] != null) {
        rangePressures.push(pressures[i]);
      }
    }
    if (rangePressures.length === 0) return null;
    return roundTo(Math.max(...rangePressures) - Math.min(...rangePressures), 1);
  }
}

// ============================================================
// 寒暖差の算出（当日最高気温 - 前日最高気温）
// ============================================================
// isConfirmed=true: 当日全時間帯の最高気温で算出（確定値）
// isConfirmed=false: targetDate以前の時間帯のみで算出（暫定値）
function calculateTempDiff(weather, targetDate, isConfirmed) {
  const hourly = weather.hourly;
  const times = hourly.time;
  const temps = hourly.temperature_2m;

  const todayStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const yesterdayDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() - 1);
  const yesterdayStr = Utilities.formatDate(yesterdayDate, 'Asia/Tokyo', 'yyyy-MM-dd');

  let todayMax = -Infinity;
  let yesterdayMax = -Infinity;

  for (let i = 0; i < times.length; i++) {
    const timeStr = times[i];
    const temp = temps[i];
    if (temp == null) continue;

    if (timeStr.startsWith(todayStr)) {
      if (isConfirmed || new Date(timeStr).getTime() <= targetDate.getTime()) {
        todayMax = Math.max(todayMax, temp);
      }
    }
    if (timeStr.startsWith(yesterdayStr)) {
      yesterdayMax = Math.max(yesterdayMax, temp);
    }
  }

  if (todayMax === -Infinity || yesterdayMax === -Infinity) return null;
  return roundTo(todayMax - yesterdayMax, 1);
}

// ============================================================
// 月齢計算（簡易式）
// ============================================================
function calculateMoonAge(date) {
  const knownNewMoon = new Date(2000, 0, 6, 18, 14, 0);
  const synodicMonth = 29.53058867;

  const diffMs = date.getTime() - knownNewMoon.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const moonAge = diffDays % synodicMonth;

  return roundTo(moonAge < 0 ? moonAge + synodicMonth : moonAge, 1);
}

// ============================================================
// 休日判定（土日 + 祝日）
// ============================================================
function isHoliday(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return true;

  try {
    const calendarId = 'ja.japanese#holiday@group.v.calendar.google.com';
    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    const events = CalendarApp.getCalendarById(calendarId).getEvents(startOfDay, endOfDay);
    return events.length > 0;
  } catch (e) {
    logError('isHoliday', '祝日カレンダー取得エラー: ' + e.message);
    return day === 0 || day === 6;
  }
}

// ============================================================
// 指定日の行を検索
// ============================================================
function findRowsByDate(sheet, targetDate) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const targetDateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const timestamps = sheet.getRange(2, COL.TIMESTAMP, lastRow - 1, 1).getValues();
  const matchedRows = [];

  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i][0] instanceof Date) {
      const rowDateStr = Utilities.formatDate(timestamps[i][0], 'Asia/Tokyo', 'yyyy-MM-dd');
      if (rowDateStr === targetDateStr) {
        matchedRows.push(i + 2);
      }
    }
  }

  return matchedRows;
}

// ============================================================
// ユーティリティ
// ============================================================
function getSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID が PropertiesService に設定されていません');
  return SpreadsheetApp.openById(id);
}

function getLocation() {
  const props = PropertiesService.getScriptProperties();
  const lat = props.getProperty('LAT');
  const lon = props.getProperty('LON');
  if (!lat || !lon) throw new Error('LAT / LON が PropertiesService に設定されていません');
  return { lat: parseFloat(lat), lon: parseFloat(lon) };
}

function roundTo(value, decimals) {
  if (value == null) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ============================================================
// エラーログ記録
// ============================================================
function logError(funcName, message) {
  try {
    const ss = getSpreadsheet();
    let logSheet = ss.getSheetByName(SHEET_NAME_LOG);
    if (!logSheet) {
      logSheet = ss.insertSheet(SHEET_NAME_LOG);
      logSheet.appendRow(['タイムスタンプ', '関数名', 'エラー内容']);
      logSheet.setFrozenRows(1);
    }
    logSheet.appendRow([new Date(), funcName, message]);
  } catch (e) {
    console.error('ログ記録失敗: ' + e.message);
  }
}

// ============================================================
// デバッグ用: AMeDAS観測点テーブルの構造確認
// ============================================================
function debugAmedasTable() {
  const stations = fetchAmedasStationTable();
  const codes = Object.keys(stations);
  console.log('観測点総数: ' + codes.length);

  // 東京観測点（44132）のサンプル表示
  const tokyo = stations['44132'];
  console.log('東京 (44132): ' + JSON.stringify(tokyo));

  // elemsの長さ別カウント
  const lengthCount = {};
  for (const code in stations) {
    const elems = stations[code].elems;
    const len = elems ? elems.length : 'なし';
    lengthCount[len] = (lengthCount[len] || 0) + 1;
  }
  console.log('elems長さ別カウント: ' + JSON.stringify(lengthCount));

  // 主要観測点のelemsサンプル
  const samples = ['44132', '47662', '47772', '47636']; // 東京・大阪・名古屋・横浜
  samples.forEach(function(c) {
    if (stations[c]) {
      console.log(c + ' (' + stations[c].kjName + '): elems="' + stations[c].elems + '"');
    }
  });
}

// ============================================================
// 初期セットアップ用（1回だけ手動実行）
// ============================================================
function setupProperties() {
  const props = PropertiesService.getScriptProperties();
  // ★ 以下を自分の値に書き換えてから実行してください
  props.setProperty('SPREADSHEET_ID', 'ここにスプレッドシートIDを入力');
  props.setProperty('LAT', '35.6895');   // 例: 東京
  props.setProperty('LON', '139.6917');  // 例: 東京
  console.log('PropertiesService の設定が完了しました');
}
