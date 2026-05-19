/**
 * MatsukiyoMailParser.gs
 * マツキヨオンラインのメールを解析して取込候補を生成する
 *
 * 仕様書 Section 10.2, 10.4 準拠
 *
 * 対象:
 *   - 注文確認メール
 *   - 商品発送のお知らせ系メール
 *
 * 設計方針:
 *   - AmazonMailParser と同じインタフェース（parse 関数）
 *   - 正規表現を配列で管理し、後から追加・調整しやすくする
 *   - マツキヨのメール形式はシンプルな傾向なので Amazon より取りやすい想定
 *   - 取れない情報があっても候補は生成する
 *
 * 対象メール送信元:
 *   - *@matsukiyococokara.com （マツキヨココカラオンライン、現行）
 *   - *@matsukiyo.co.jp （旧ドメイン）
 */

var MatsukiyoMailParser = (function() {

  // ============================================================
  // 件名パターン定義
  // ============================================================

  /** 注文確認メールの件名パターン */
  var ORDER_SUBJECT_PATTERNS = [
    /ご注文.*確認/i,
    /ご注文.*ありがとう/i,
    /ご注文.*受付/i,
    /マツモトキヨシ.*注文/i,
    /matsukiyo.*注文/i,
    /ご注文内容/i
  ];

  /** 発送通知メールの件名パターン */
  var SHIPMENT_SUBJECT_PATTERNS = [
    /発送.*お知らせ/i,
    /商品.*発送/i,
    /出荷.*お知らせ/i,
    /配送.*お知らせ/i,
    /お届け.*お知らせ/i,
    /マツモトキヨシ.*発送/i,
    /マツキヨココカラ.*発送/i
  ];

  // ============================================================
  // 本文パターン定義
  // ============================================================

  /** 注文番号の抽出パターン */
  var ORDER_ID_PATTERNS = [
    /注文番号[:\s#：]*([A-Za-z0-9\-]+)/,
    /受注番号[:\s#：]*([A-Za-z0-9\-]+)/,
    /オーダー番号[:\s#：]*([A-Za-z0-9\-]+)/,
    /ご注文番号[:\s#：]*([A-Za-z0-9\-]+)/
  ];

  /** 商品名の抽出パターン */
  var ITEM_NAME_PATTERNS = [
    // 「商品名：○○○」形式
    /(?:商品名|品名)[:\s：]+(.+?)(?:\n|$)/,
    // 「商品[:\s]○○○」形式
    /商品[:\s：]+(.+?)(?:\n|$)/,
    // テーブル行風: 「○○○  数量 N」
    /^(.{3,100})\s{2,}(?:数量|個数)[:\s：]*\d+/m
  ];

  /** 数量の抽出パターン */
  var QTY_PATTERNS = [
    /数量[:\s：]*(\d+)/,
    /個数[:\s：]*(\d+)/,
    /(\d+)\s*[点個個数]/,
    /×\s*(\d+)/
  ];

  /** 金額の抽出パターン */
  var PRICE_PATTERNS = [
    /[￥¥]\s*([0-9,]+)/,
    /(\d{1,3}(?:,\d{3})*)\s*円/,
    /税込[:\s：]*[￥¥]?\s*([0-9,]+)/,
    /小計[:\s：]*[￥¥]?\s*([0-9,]+)/
  ];

  // ============================================================
  // メイン: parse 関数
  // ============================================================

  /**
   * メールを解析して候補情報を返す
   *
   * GmailImportService から呼ばれる統一インタフェース。
   * AmazonMailParser.parse と同じ戻り値構造。
   *
   * @param {string} subject メール件名
   * @param {string} body メール本文（プレーンテキスト）
   * @param {Date} mailDate メール日付
   * @return {Object|null} パース結果
   *   - mail_type {string}
   *   - mail_phase {string}
   *   - items {Object[]}
   */
  function parse(subject, body, mailDate) {
    // 1. mail_type 判定
    var mailType = detectMailType_(subject);
    if (mailType === ENUMS.MAIL_TYPE.OTHER) {
      return null;
    }

    // 2. mail_phase 判定
    var mailPhase;
    if (mailType === ENUMS.MAIL_TYPE.ORDER_CONFIRM) {
      mailPhase = ENUMS.MAIL_PHASE.ORDERED;
    } else if (mailType === ENUMS.MAIL_TYPE.SHIPMENT) {
      mailPhase = ENUMS.MAIL_PHASE.SHIPPED;
    } else {
      mailPhase = ENUMS.MAIL_PHASE.OTHER;
    }

    // 3. 注文番号を抽出
    var orderId = extractFirst_(body, ORDER_ID_PATTERNS) || '';

    // 4. 商品情報を抽出
    var items = extractItems_(body, orderId);

    // 商品が1つも取れなかった場合、件名をフォールバックにする
    if (items.length === 0) {
      items.push({
        order_id: orderId,
        item_name_raw: subject,
        detected_qty: 1,
        detected_price: extractFirst_(body, PRICE_PATTERNS) || '',
        parse_note: '商品名を本文から抽出できず件名を使用'
      });
    }

    return {
      mail_type: mailType,
      mail_phase: mailPhase,
      items: items
    };
  }

  // ============================================================
  // 内部ヘルパー
  // ============================================================

  /**
   * 件名から mail_type を判定する
   * @param {string} subject
   * @return {string}
   * @private
   */
  function detectMailType_(subject) {
    for (var i = 0; i < SHIPMENT_SUBJECT_PATTERNS.length; i++) {
      if (SHIPMENT_SUBJECT_PATTERNS[i].test(subject)) {
        return ENUMS.MAIL_TYPE.SHIPMENT;
      }
    }
    for (var j = 0; j < ORDER_SUBJECT_PATTERNS.length; j++) {
      if (ORDER_SUBJECT_PATTERNS[j].test(subject)) {
        return ENUMS.MAIL_TYPE.ORDER_CONFIRM;
      }
    }
    return ENUMS.MAIL_TYPE.OTHER;
  }

  /**
   * パターン配列から最初にマッチしたグループ1を返す
   * @param {string} text
   * @param {RegExp[]} patterns
   * @return {string|null}
   * @private
   */
  function extractFirst_(text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m && m[1]) {
        return m[1].trim();
      }
    }
    return null;
  }

  /**
   * 本文から商品情報を抽出する
   *
   * マツキヨのメールは Amazon ほど複雑でないことが多い。
   * 複数商品を含む場合にも対応する。
   *
   * @param {string} body
   * @param {string} orderId
   * @return {Object[]}
   * @private
   */
  function extractItems_(body, orderId) {
    var items = [];

    // 方式1: 「商品名：X」「数量：N個」のペア抽出
    // マツキヨのメールは商品ごとに商品名行と数量行が交互に並ぶ。
    items = extractPairedItems_(body, orderId);
    if (items.length > 0) {
      return items;
    }

    // 方式2: 区切り線ベースのヒューリスティクス
    // マツキヨのメールは「---」「===」「■」で商品ブロックを区切ることがある
    var blocks = body.split(/[-=]{3,}|■/);
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b].trim();
      if (block.length < 5 || block.length > 500) continue;

      // ブロック内に「数量」「個」があれば商品ブロックとみなす
      if (/数量|個数|[×x]\s*\d/.test(block)) {
        var blockName = extractItemNameFromBlock_(block);
        if (blockName) {
          var blockQty = parseInt(extractFirst_(block, QTY_PATTERNS) || '1', 10) || 1;
          var blockPrice = extractFirst_(block, PRICE_PATTERNS) || '';
          items.push({
            order_id: orderId,
            item_name_raw: cleanItemName_(blockName),
            detected_qty: blockQty,
            detected_price: blockPrice,
            parse_note: 'ブロック抽出'
          });
        }
      }
    }

    // 重複除去
    var seen = {};
    var unique = [];
    for (var j = 0; j < items.length; j++) {
      var key = items[j].item_name_raw;
      if (!seen[key]) {
        seen[key] = true;
        unique.push(items[j]);
      }
    }

    return unique;
  }

  /**
   * 「商品名：X」行と「数量：N」行のペアを走査して商品配列を作る
   *
   * マツキヨのメールは商品ごとに
   *   商品名：XXX
   *   数量：N個
   * が繰り返される形式が多い。行単位で歩くことで
   * 複数商品それぞれの数量を正しく対応付ける。
   *
   * @param {string} body
   * @param {string} orderId
   * @return {Object[]}
   * @private
   */
  function extractPairedItems_(body, orderId) {
    var lines = body.split(/\r?\n/);
    var items = [];
    var pendingName = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var nameMatch = line.match(/^\s*(?:商品名|品名)[:\s：]+(.+?)\s*$/);
      if (nameMatch && nameMatch[1]) {
        // 直前に数量未検出の商品名が残っていれば数量1で確定する
        if (pendingName) {
          items.push({
            order_id: orderId,
            item_name_raw: cleanItemName_(pendingName),
            detected_qty: 1,
            detected_price: '',
            parse_note: 'ペア抽出(数量未検出)'
          });
        }
        pendingName = nameMatch[1].trim();
        continue;
      }
      var qtyMatch = line.match(/^\s*(?:数量|個数)[:\s：]+(\d+)/);
      if (qtyMatch && pendingName) {
        items.push({
          order_id: orderId,
          item_name_raw: cleanItemName_(pendingName),
          detected_qty: parseInt(qtyMatch[1], 10) || 1,
          detected_price: '',
          parse_note: 'ペア抽出'
        });
        pendingName = null;
      }
    }

    // 最後まで残った商品名は数量1で確定する
    if (pendingName) {
      items.push({
        order_id: orderId,
        item_name_raw: cleanItemName_(pendingName),
        detected_qty: 1,
        detected_price: '',
        parse_note: 'ペア抽出(数量未検出)'
      });
    }

    return items;
  }

  /**
   * テキストブロックから商品名を推定する
   * @param {string} block
   * @return {string|null}
   * @private
   */
  function extractItemNameFromBlock_(block) {
    // 最初の非空白行で、ラベルっぽくないものを商品名とする
    var lines = block.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.length < 3) continue;
      // ラベル行（「注文番号」「小計」「合計」など）はスキップ
      if (/^(注文|受注|小計|合計|送料|税|お届け|配送|支払|数量|個数|金額|価格)/.test(line)) continue;
      // 数値だけの行はスキップ
      if (/^[0-9,￥¥\s]+$/.test(line)) continue;
      return line;
    }
    return null;
  }

  /**
   * パターン配列でマッチした全結果（グループ1）を返す
   * @param {string} text
   * @param {RegExp[]} patterns
   * @return {string[]}
   * @private
   */
  function extractAllMatches_(text, patterns) {
    var results = [];
    for (var i = 0; i < patterns.length; i++) {
      // グローバルフラグを追加して全マッチ
      var globalPattern = new RegExp(patterns[i].source, 'gm');
      var m;
      while ((m = globalPattern.exec(text)) !== null) {
        if (m[1]) {
          results.push(m[1].trim());
        }
      }
      if (results.length > 0) break; // 最初にマッチしたパターンで十分
    }
    return results;
  }

  /**
   * 商品名のクリーンアップ
   * @param {string} name
   * @return {string}
   * @private
   */
  function cleanItemName_(name) {
    if (!name) return '';
    return name
      .replace(/^\s*[・\-\*]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
  }

  // 公開API
  return {
    parse: parse
  };

})();
