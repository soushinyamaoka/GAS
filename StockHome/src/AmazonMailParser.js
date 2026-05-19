/**
 * AmazonMailParser.gs
 * Amazon のメールを解析して取込候補を生成する
 *
 * 仕様書 Section 10.4 準拠
 *
 * 各 parser の責務:
 *   - 件名から mail_type 判定
 *   - 本文から order_id 抽出
 *   - 本文から商品名抽出
 *   - 本文から数量抽出
 *   - 候補オブジェクト生成
 *
 * 設計方針:
 *   - 正規表現を配列で管理し、後から追加・調整しやすくする
 *   - 完全一致前提ではなく、複数パターンを順に試行する
 *   - 取れない情報があっても候補は生成する（手動で補完できる）
 *   - Amazon のメール形式変更に備えてパターンを分離しておく
 *
 * 対象メール送信元:
 *   - auto-confirm@amazon.co.jp  （注文確認）
 *   - shipment-tracking@amazon.co.jp （発送通知）
 *   - その他 Amazon ドメインも拾える構造にする
 */

var AmazonMailParser = (function() {

  // ============================================================
  // 件名パターン定義
  // 後から追加しやすいように配列で管理
  // ============================================================

  /** 注文確認メールの件名パターン */
  var ORDER_SUBJECT_PATTERNS = [
    /Amazon.*ご注文の確認/i,
    /ご注文の確認/i,
    /Amazon\.co\.jp.*ご注文/i,
    /Your Amazon.*order/i,
    /Order Confirmation/i
  ];

  /** 発送通知メールの件名パターン */
  var SHIPMENT_SUBJECT_PATTERNS = [
    /発送済み/i,
    /発送.*お知らせ/i,
    /商品を発送しました/i,
    /Amazon.*発送/i,
    /Shipped/i,
    /配送.*お知らせ/i,
    /出荷.*お知らせ/i
  ];

  // ============================================================
  // 本文パターン定義
  // ============================================================

  /** 注文番号の抽出パターン */
  var ORDER_ID_PATTERNS = [
    /注文番号[:\s#：]*([0-9\-]+)/,
    /Order\s*#?\s*([0-9\-]+)/i,
    /お客様の注文[（(]([0-9\-]+)[)）]/,
    /(\d{3}-\d{7}-\d{7})/     // Amazon の典型的な注文番号形式
  ];

  /** 商品名の抽出パターン（プレーンテキスト用） */
  var ITEM_NAME_PATTERNS = [
    // 「商品名: ○○○」形式
    /(?:商品名|品名)[:\s：]+(.+?)(?:\n|$)/,
    // 「数量: N」の直前行が商品名であることが多い
    /^(.{5,100})\n\s*数量[:\s：]/m,
    // 「1 点」の直前行
    /^(.{5,100})\n\s*\d+\s*点/m
  ];

  /** 数量の抽出パターン */
  var QTY_PATTERNS = [
    /数量[:\s：]*(\d+)/,
    /(\d+)\s*[点個個数]/,
    /Qty[:\s]*(\d+)/i
  ];

  /** 金額の抽出パターン */
  var PRICE_PATTERNS = [
    /[￥¥]\s*([0-9,]+)/,
    /(\d{1,3}(?:,\d{3})*)\s*円/,
    /価格[:\s：]*[￥¥]?\s*([0-9,]+)/
  ];

  // ============================================================
  // メイン: parse 関数
  // ============================================================

  /**
   * メールを解析して候補情報を返す
   *
   * GmailImportService から呼ばれる統一インタフェース。
   *
   * @param {string} subject メール件名
   * @param {string} body メール本文（プレーンテキスト）
   * @param {Date} mailDate メール日付
   * @return {Object|null} パース結果
   *   - mail_type {string} order_confirm / shipment / other
   *   - mail_phase {string} ordered / shipped / other
   *   - items {Object[]} 抽出した商品の配列
   *     - order_id {string}
   *     - item_name_raw {string}
   *     - detected_qty {number}
   *     - detected_price {string}
   *     - parse_note {string}
   */
  function parse(subject, body, mailDate) {
    // 1. mail_type 判定
    var mailType = detectMailType_(subject);
    if (mailType === ENUMS.MAIL_TYPE.OTHER) {
      // 対象外メール
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
    // 発送通知を先にチェック（注文確認の件名を含む場合があるため）
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
   * Amazon のメール（プレーンテキスト変換版）は商品ごとに
   *   [image: 商品名]
   *   <URL>
   *   商品名（切詰）
   *   <URL>
   *
   *   数量: N
   *
   *   ￥価格
   * というブロック形式になっている。`[image: ...]` を起点にブロック単位で抽出する。
   *
   * 注意:
   *   - 「合計 ￥」「セール商品のお買い物を続ける」より後はレコメンド/広告なので除外
   *   - `[image: 完了済み]` `[image: Amazon.co.jp]` 等の UI アイコンは数量を持たないので
   *     ブロック内に「数量:」が無い場合は商品ではないと判断してスキップ
   *
   * @param {string} body
   * @param {string} orderId
   * @return {Object[]}
   * @private
   */
  function extractItems_(body, orderId) {
    var items = [];

    // 方式1: [image: ...] ブロック抽出
    items = extractImageBlockItems_(body, orderId);
    if (items.length > 0) {
      return dedupeByName_(items);
    }

    // 方式2（フォールバック）: 行単位のヒューリスティクス
    // 「数量」「点」を含む行の直前行を商品名とみなす
    var lines = body.split('\n');
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i].trim();
      var prevLine = lines[i - 1].trim();

      if (/数量[:\s：]*\d+/.test(line) || /^\d+\s*[点個]/.test(line)) {
        if (prevLine.length >= 3 && prevLine.length <= 200) {
          var q = parseInt((line.match(/\d+/) || ['1'])[0], 10) || 1;
          items.push({
            order_id: orderId,
            item_name_raw: cleanItemName_(prevLine),
            detected_qty: q,
            detected_price: '',
            parse_note: 'ヒューリスティクス抽出'
          });
        }
      }
    }

    return dedupeByName_(items);
  }

  /**
   * `[image: 商品名]` ブロックから商品を抽出する
   * @param {string} body
   * @param {string} orderId
   * @return {Object[]}
   * @private
   */
  function extractImageBlockItems_(body, orderId) {
    // レコメンド/広告領域を切り捨てる
    var cutIdx = body.length;
    var mTotal = body.match(/合計\s*[￥¥]/);
    if (mTotal) cutIdx = Math.min(cutIdx, mTotal.index);
    var mSale = body.match(/セール商品のお買い物を続ける/);
    if (mSale) cutIdx = Math.min(cutIdx, mSale.index);
    var scan = body.substring(0, cutIdx);

    // [image: ...] の出現位置を全件収集
    var hits = [];
    var re = /\[image:\s*([^\]]+?)\]/g;
    var m;
    while ((m = re.exec(scan)) !== null) {
      hits.push({
        name: m[1].trim(),
        startIdx: m.index,
        endIdx: m.index + m[0].length
      });
    }
    if (hits.length === 0) return [];

    var items = [];
    for (var i = 0; i < hits.length; i++) {
      var segStart = hits[i].endIdx;
      var segEnd = (i + 1 < hits.length) ? hits[i + 1].startIdx : scan.length;
      var seg = scan.substring(segStart, segEnd);

      // 数量を含まないブロックは UI アイコン等とみなしスキップ
      var qm = seg.match(/数量[:\s：]+(\d+)/);
      if (!qm) continue;

      var pm = seg.match(/[￥¥]\s*([0-9,]+)/);

      items.push({
        order_id: orderId,
        item_name_raw: cleanItemName_(hits[i].name),
        detected_qty: parseInt(qm[1], 10) || 1,
        detected_price: pm ? pm[1] : '',
        parse_note: 'imageブロック抽出'
      });
    }
    return items;
  }

  /**
   * 商品名で重複除去
   * @param {Object[]} items
   * @return {Object[]}
   * @private
   */
  function dedupeByName_(items) {
    var seen = {};
    var unique = [];
    for (var i = 0; i < items.length; i++) {
      var key = items[i].item_name_raw;
      if (!seen[key]) {
        seen[key] = true;
        unique.push(items[i]);
      }
    }
    return unique;
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
      .replace(/^\s*[・\-\*]\s*/, '')  // 先頭の箇条書き記号
      .replace(/\s+/g, ' ')            // 連続空白を1つに
      .trim()
      .substring(0, 200);              // 長すぎる名前を切り詰め
  }

  // 公開API
  return {
    parse: parse
  };

})();
