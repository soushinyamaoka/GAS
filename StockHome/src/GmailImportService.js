/**
 * GmailImportService.gs
 * Gmail 検索・候補保存・候補確定・候補無視
 *
 * 仕様書 Section 5.3, 5.4, 7.7, 10, 11, 18.2, 20 (GmailImportService) 準拠
 *
 * 処理概要:
 *   1. GmailApp.search() で前回取込日時以降 + バッファのメールを検索
 *   2. vendor ごとの parser でメールを解析
 *   3. 重複排除（mail_message_id / vendor+order_id+item_name_raw）
 *   4. import_order_candidates に候補を保存
 *   5. 候補確認画面で確定 → PurchaseService 経由で purchase_log へ反映
 *
 * Gmail 検索は全件走査しない（Section 26）。
 * 前回取込日時以降 + バッファ数日に限定する。
 */

var GmailImportService = (function() {

  /** 検索時の日付バッファ（前回取込からさかのぼる日数） */
  var SEARCH_BUFFER_DAYS = 3;

  /** 1回の検索で取得するスレッド上限 */
  var MAX_THREADS = 30;

  // ============================================================
  // メイン: ユーザー別 Gmail 取込
  // ============================================================

  /**
   * 現在実行ユーザーの Gmail を取込む
   * BatchController.runMyGmailImport() から呼ばれる
   *
   * @return {Object} { amazon: number, matsukiyo: number, errors: number }
   */
  function runMyGmailImport() {
    var result = { amazon: 0, matsukiyo: 0, errors: 0 };

    // 実行ユーザー情報
    var email = '';
    try {
      email = Session.getActiveUser().getEmail();
    } catch (e) { /* ignore */ }

    var userId = getCurrentUserIdFromProps() || '';

    Logger.log('[GmailImport] 取込開始: user=' + email);

    // Amazon 取込
    try {
      result.amazon = importVendorMails_(
        ENUMS.EXTERNAL_VENDOR.AMAZON,
        getAmazonSearchQuery(),
        AmazonMailParser,
        userId,
        email
      );
    } catch (e) {
      Logger.log('[GmailImport] Amazon 取込エラー: ' + e.message);
      result.errors++;
    }

    // マツキヨ取込
    try {
      result.matsukiyo = importVendorMails_(
        ENUMS.EXTERNAL_VENDOR.MATSUKIYO,
        getMatsukiyoSearchQuery(),
        MatsukiyoMailParser,
        userId,
        email
      );
    } catch (e) {
      Logger.log('[GmailImport] マツキヨ取込エラー: ' + e.message);
      result.errors++;
    }

    // 最終取込日時を保存
    setGmailImportLastRunAt(new Date());

    Logger.log('[GmailImport] 取込完了: ' + JSON.stringify(result));
    return result;
  }

  // ============================================================
  // vendor 別取込の共通ロジック
  // ============================================================

  /**
   * 指定 vendor のメールを検索・解析・候補保存する
   *
   * @param {string} vendor ENUMS.EXTERNAL_VENDOR の値
   * @param {string} baseQuery Gmail 検索クエリ
   * @param {Object} parser AmazonMailParser / MatsukiyoMailParser
   * @param {string} userId
   * @param {string} email
   * @return {number} 保存した候補数
   * @private
   */
  function importVendorMails_(vendor, baseQuery, parser, userId, email) {
    // 日付フィルタ付きクエリを構築
    var query = buildDateFilteredQuery_(baseQuery);
    Logger.log('[GmailImport] 検索クエリ (' + vendor + '): ' + query);

    // Gmail 検索
    var threads;
    try {
      threads = GmailApp.search(query, 0, MAX_THREADS);
    } catch (e) {
      Logger.log('[GmailImport] GmailApp.search() 失敗: ' + e.message);
      throw new Error(vendor + ' のメール検索に失敗しました。Gmail 権限を確認してください。');
    }

    Logger.log('[GmailImport] ' + vendor + ': ' + threads.length + ' スレッド取得');

    var savedCount = 0;

    for (var t = 0; t < threads.length; t++) {
      var messages = threads[t].getMessages();

      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];

        try {
          var candidates = processMessage_(msg, vendor, parser, userId, email);
          savedCount += candidates;
        } catch (e) {
          Logger.log('[GmailImport] メッセージ処理エラー: ' + e.message +
            ' (subject: ' + msg.getSubject() + ')');
        }
      }
    }

    return savedCount;
  }

  /**
   * 前回取込日時以降 + バッファを含む検索クエリを構築する
   *
   * @param {string} baseQuery ベースクエリ
   * @return {string} 日付フィルタ付きクエリ
   * @private
   */
  function buildDateFilteredQuery_(baseQuery) {
    var lastRun = getGmailImportLastRunAt();
    var afterDate;

    if (lastRun) {
      // 前回取込日時から SEARCH_BUFFER_DAYS 日さかのぼる
      afterDate = addDays(new Date(lastRun), -SEARCH_BUFFER_DAYS);
    } else {
      // 初回: 30日前から
      afterDate = addDays(new Date(), -30);
    }

    var afterStr = formatDate(afterDate);
    return baseQuery + ' after:' + afterStr;
  }

  // ============================================================
  // メッセージ単位の処理
  // ============================================================

  /**
   * 1通のメッセージを解析し、候補を保存する
   *
   * @param {GmailMessage} msg
   * @param {string} vendor
   * @param {Object} parser
   * @param {string} userId
   * @param {string} email
   * @return {number} 保存した候補数
   * @private
   */
  function processMessage_(msg, vendor, parser, userId, email) {
    var messageId = msg.getId();
    var threadId = msg.getThread().getId();

    // 重複排除 1: mail_message_id
    if (isDuplicateByMessageId_(messageId)) {
      return 0;
    }

    var subject = msg.getSubject() || '';
    var body = msg.getPlainBody() || '';
    var mailDate = msg.getDate();

    // parser でメール解析
    var parseResult;
    try {
      parseResult = parser.parse(subject, body, mailDate);
    } catch (e) {
      Logger.log('[GmailImport] パース失敗: ' + e.message);
      // エラーでも候補を1件作成（手動で確認できるように）
      saveErrorCandidate_(vendor, messageId, threadId, userId, email, mailDate, subject, e.message);
      return 1;
    }

    if (!parseResult || !parseResult.items || parseResult.items.length === 0) {
      // パース結果なし = 対象外メール
      return 0;
    }

    var savedCount = 0;

    for (var i = 0; i < parseResult.items.length; i++) {
      var parsedItem = parseResult.items[i];

      // 重複排除 2: vendor + order_id + item_name_raw
      if (isDuplicateByOrderItem_(vendor, parsedItem.order_id, parsedItem.item_name_raw)) {
        Logger.log('[GmailImport] 重複スキップ (order+item): ' +
          parsedItem.order_id + ' / ' + parsedItem.item_name_raw);
        continue;
      }

      // 重複排除 3: vendor + imported_by_user_id + mail_date + raw_subject
      if (isDuplicateByUserDateSubject_(vendor, userId, formatDate(mailDate), subject)) {
        // 同一ユーザー・同日・同件名は既に取込済みとみなす
        // ただし items が複数行ある場合があるので、order_id レベルで通過したものは保存する
        // → この判定は order_id が空のときのフォールバック
        if (!parsedItem.order_id) {
          Logger.log('[GmailImport] 重複スキップ (user+date+subject)');
          continue;
        }
      }

      // 候補を保存
      var candidateData = buildCandidateData_(
        vendor, messageId, threadId, userId, email,
        mailDate, subject, msg.getBody(),
        parseResult, parsedItem
      );

      saveImportCandidate(candidateData);
      savedCount++;

      // 自動確定を試みる
      tryAutoConfirm_(candidateData.candidate_id, candidateData.item_name_raw, userId);
    }

    return savedCount;
  }

  // ============================================================
  // 候補データ構築
  // ============================================================

  /**
   * import_order_candidates の1行分のデータを構築する
   * @private
   */
  function buildCandidateData_(vendor, messageId, threadId, userId, email,
                                mailDate, subject, htmlBody, parseResult, parsedItem) {
    var mailType = parseResult.mail_type || ENUMS.MAIL_TYPE.OTHER;
    var mailPhase = parseResult.mail_phase || ENUMS.MAIL_PHASE.OTHER;

    // candidate_status の決定（Section 10.6）
    var candidateStatus;
    switch (mailPhase) {
      case ENUMS.MAIL_PHASE.ORDERED:
        candidateStatus = ENUMS.CANDIDATE_STATUS.ORDERED;
        break;
      case ENUMS.MAIL_PHASE.SHIPPED:
        candidateStatus = ENUMS.CANDIDATE_STATUS.SHIPPED;
        break;
      default:
        candidateStatus = ENUMS.CANDIDATE_STATUS.DETECTED;
    }

    // fulfillment_status の決定
    var fulfillmentStatus;
    switch (mailPhase) {
      case ENUMS.MAIL_PHASE.ORDERED:
        fulfillmentStatus = ENUMS.FULFILLMENT_STATUS.ORDERED;
        break;
      case ENUMS.MAIL_PHASE.SHIPPED:
        fulfillmentStatus = ENUMS.FULFILLMENT_STATUS.SHIPPED;
        break;
      default:
        fulfillmentStatus = ENUMS.FULFILLMENT_STATUS.ORDERED;
    }

    // candidate_group_key: 同一注文・同一商品の突合用
    var groupKey = vendor + '|' + (parsedItem.order_id || messageId) + '|' + (parsedItem.item_name_raw || '');

    // snippet は本文先頭200文字まで（セキュリティ: 長期保存しない）
    var snippet = (htmlBody || '').replace(/<[^>]+>/g, '').substring(0, 200);

    return {
      candidate_id: generatePrefixedId('CAND'),
      vendor: vendor,
      mail_message_id: messageId,
      gmail_thread_id: threadId,
      imported_by_user_id: userId,
      imported_by_email: email,
      mail_date: formatDate(mailDate),
      order_id: toStr(parsedItem.order_id),
      mail_type: mailType,
      mail_phase: mailPhase,
      fulfillment_status: fulfillmentStatus,
      candidate_group_key: groupKey,
      item_name_raw: toStr(parsedItem.item_name_raw),
      detected_qty: parsedItem.detected_qty !== undefined ? parsedItem.detected_qty : 1,
      detected_price: parsedItem.detected_price || '',
      candidate_status: candidateStatus,
      matched_item_id: '',
      raw_subject: subject.substring(0, 300),
      raw_snippet: snippet,
      parse_result: toStr(parsedItem.parse_note || ''),
      created_at: nowIso(),
      updated_at: nowIso()
    };
  }

  /**
   * パースエラー時のエラー候補を保存する
   * @private
   */
  function saveErrorCandidate_(vendor, messageId, threadId, userId, email, mailDate, subject, errorMsg) {
    var data = {
      candidate_id: generatePrefixedId('CAND'),
      vendor: vendor,
      mail_message_id: messageId,
      gmail_thread_id: threadId,
      imported_by_user_id: userId,
      imported_by_email: email,
      mail_date: formatDate(mailDate),
      order_id: '',
      mail_type: ENUMS.MAIL_TYPE.OTHER,
      mail_phase: ENUMS.MAIL_PHASE.OTHER,
      fulfillment_status: '',
      candidate_group_key: '',
      item_name_raw: '',
      detected_qty: '',
      detected_price: '',
      candidate_status: ENUMS.CANDIDATE_STATUS.ERROR,
      matched_item_id: '',
      raw_subject: subject.substring(0, 300),
      raw_snippet: '',
      parse_result: 'PARSE_ERROR: ' + errorMsg,
      created_at: nowIso(),
      updated_at: nowIso()
    };

    SheetRepository.appendRow(SHEET_NAMES.IMPORT_ORDER_CANDIDATES, data);
  }

  // ============================================================
  // 重複排除（Section 10.5）
  // ============================================================

  /**
   * mail_message_id による重複チェック
   * @param {string} messageId
   * @return {boolean}
   * @private
   */
  function isDuplicateByMessageId_(messageId) {
    if (!messageId) return false;
    var found = SheetRepository.findRows(SHEET_NAMES.IMPORT_ORDER_CANDIDATES, function(row) {
      return toStr(row.mail_message_id) === messageId;
    });
    return found.length > 0;
  }

  /**
   * vendor + order_id + item_name_raw による重複チェック
   * @param {string} vendor
   * @param {string} orderId
   * @param {string} itemNameRaw
   * @return {boolean}
   * @private
   */
  function isDuplicateByOrderItem_(vendor, orderId, itemNameRaw) {
    if (!orderId || !itemNameRaw) return false;
    var found = SheetRepository.findRows(SHEET_NAMES.IMPORT_ORDER_CANDIDATES, function(row) {
      return toStr(row.vendor) === vendor &&
        toStr(row.order_id) === orderId &&
        toStr(row.item_name_raw) === itemNameRaw;
    });
    return found.length > 0;
  }

  /**
   * vendor + imported_by_user_id + mail_date + raw_subject による重複チェック
   * order_id が取れないメールのフォールバック
   * @param {string} vendor
   * @param {string} userId
   * @param {string} mailDateStr yyyy-MM-dd
   * @param {string} subject
   * @return {boolean}
   * @private
   */
  function isDuplicateByUserDateSubject_(vendor, userId, mailDateStr, subject) {
    if (!subject) return false;
    var subjectTrimmed = subject.substring(0, 300);
    var found = SheetRepository.findRows(SHEET_NAMES.IMPORT_ORDER_CANDIDATES, function(row) {
      // mail_date は Date オブジェクトで格納されている場合があるため正規化
      var rowMailDateStr = row.mail_date
        ? formatDate(parseDate(row.mail_date))
        : '';
      return toStr(row.vendor) === vendor &&
        toStr(row.imported_by_user_id) === userId &&
        rowMailDateStr === mailDateStr &&
        toStr(row.raw_subject) === subjectTrimmed;
    });
    return found.length > 0;
  }

  // ============================================================
  // 候補の保存
  // ============================================================

  /**
   * 取込候補を保存する
   * @param {Object} candidateData
   */
  function saveImportCandidate(candidateData) {
    withLock(function() {
      SheetRepository.appendRow(SHEET_NAMES.IMPORT_ORDER_CANDIDATES, candidateData);
    });
  }

  // ============================================================
  // 候補の取得
  // ============================================================

  /**
   * 取込候補一覧を取得する（新しい順）
   * @param {boolean} [includeResolved=false] confirmed/ignored 含めるか
   * @return {Object[]}
   */
  function getImportCandidates(includeResolved) {
    var rows;

    if (includeResolved) {
      rows = SheetRepository.getAllRows(SHEET_NAMES.IMPORT_ORDER_CANDIDATES);
    } else {
      // 未解決のもの: detected / ordered / shipped のみ
      var activeStatuses = [
        ENUMS.CANDIDATE_STATUS.DETECTED,
        ENUMS.CANDIDATE_STATUS.ORDERED,
        ENUMS.CANDIDATE_STATUS.SHIPPED
      ];
      rows = SheetRepository.findRows(SHEET_NAMES.IMPORT_ORDER_CANDIDATES, function(row) {
        return activeStatuses.indexOf(toStr(row.candidate_status)) !== -1;
      });
    }

    // mail_date の降順
    rows.sort(function(a, b) {
      var da = parseDate(a.mail_date);
      var db = parseDate(b.mail_date);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db.getTime() - da.getTime();
    });

    return rows;
  }

  // ============================================================
  // 自動確定（部分一致）
  // ============================================================

  /**
   * 候補の商品名でマスタを部分一致検索し、1件のみヒットなら自動確定する
   * @param {string} candidateId
   * @param {string} itemNameRaw
   * @param {string} userId
   * @private
   */
  function tryAutoConfirm_(candidateId, itemNameRaw, userId) {
    try {
      var matches = ItemService.findItemsByPartialMatch(itemNameRaw);

      if (matches.length === 1) {
        var matchedItem = matches[0];
        autoConfirmCandidate_(candidateId, matchedItem.item_id, userId, matchedItem.default_purchase_qty);
        Logger.log('[GmailImport] 自動確定: candidate=' + candidateId +
          ', item=' + matchedItem.item_id + ' (' + matchedItem.item_name +
          '), qty=' + matchedItem.default_purchase_qty);
      } else if (matches.length > 1) {
        var matchNames = matches.map(function(m) { return m.item_name; }).join(', ');
        SheetRepository.updateRowById(
          SHEET_NAMES.IMPORT_ORDER_CANDIDATES, 'candidate_id', candidateId,
          { parse_result: '自動確定スキップ: 複数一致 (' + matchNames + ')', updated_at: nowIso() }
        );
        Logger.log('[GmailImport] 自動確定スキップ（複数一致）: candidate=' + candidateId +
          ', matches=' + matchNames);
      }
    } catch (e) {
      Logger.log('[GmailImport] 自動確定エラー: ' + e.message);
    }
  }

  /**
   * 自動確定: candidate を auto_confirmed にし purchase_log に反映する
   * @param {string} candidateId
   * @param {string} matchedItemId
   * @param {string} userId
   * @private
   */
  function autoConfirmCandidate_(candidateId, matchedItemId, userId, defaultPurchaseQty) {
    // candidate.detected_qty はパーサーが拾ったセット数として扱う（上書きしない）。
    // purchase_log の qty は createPurchaseLogFromImportCandidate 側で
    // detected_qty × default_purchase_qty に換算される。
    PurchaseService.createPurchaseLogFromImportCandidate(
      candidateId, matchedItemId, userId, ENUMS.SOURCE_TYPE.GMAIL_AUTO_CONFIRMED
    );

    SheetRepository.updateRowById(
      SHEET_NAMES.IMPORT_ORDER_CANDIDATES, 'candidate_id', candidateId,
      {
        candidate_status: ENUMS.CANDIDATE_STATUS.AUTO_CONFIRMED,
        matched_item_id: matchedItemId,
        parse_result: '自動確定（部分一致1件）',
        updated_at: nowIso()
      }
    );
  }

  // ============================================================
  // 候補の確定（confirmed → purchase_log 反映）
  // ============================================================

  /**
   * 取込候補を確定し、purchase_log に反映する
   *
   * Section 10.6:
   *   ユーザーが matched_item_id を設定し confirmed すると purchase_log へ反映
   *
   * @param {string} candidateId
   * @param {string} matchedItemId 紐付ける消耗品ID
   * @param {string} confirmedByUserId 確定したユーザーID
   * @return {Object} { candidate: Object, purchaseLog: Object }
   */
  function confirmImportCandidate(candidateId, matchedItemId, confirmedByUserId) {
    if (!candidateId) throwUserError('候補IDが指定されていません。');
    if (!matchedItemId) throwUserError('紐付ける品目を選択してください。');

    return withLock(function() {
      var candidate = SheetRepository.findRowById(
        SHEET_NAMES.IMPORT_ORDER_CANDIDATES, 'candidate_id', candidateId
      );
      if (!candidate) {
        throwUserError('指定された取込候補が見つかりません。');
      }

      var status = toStr(candidate.candidate_status);
      if (status === ENUMS.CANDIDATE_STATUS.CONFIRMED) {
        throwUserError('この候補は既に確定済みです。');
      }
      if (status === ENUMS.CANDIDATE_STATUS.IGNORED) {
        throwUserError('この候補は無視済みです。再度取り込む場合はステータスを戻してください。');
      }

      // 候補のステータスを confirmed に更新
      SheetRepository.updateRowById(
        SHEET_NAMES.IMPORT_ORDER_CANDIDATES, 'candidate_id', candidateId,
        {
          candidate_status: ENUMS.CANDIDATE_STATUS.CONFIRMED,
          matched_item_id: matchedItemId,
          updated_at: nowIso()
        }
      );

      // purchase_log に反映（PurchaseService に委譲）
      var purchaseLog = PurchaseService.createPurchaseLogFromImportCandidate(
        candidateId, matchedItemId, confirmedByUserId
      );

      Logger.log('[GmailImport] 候補確定: candidate=' + candidateId +
        ', item=' + matchedItemId + ', purchase=' + purchaseLog.purchase_id);

      return {
        candidate: SheetRepository.findRowById(
          SHEET_NAMES.IMPORT_ORDER_CANDIDATES, 'candidate_id', candidateId
        ),
        purchaseLog: purchaseLog
      };
    });
  }

  // ============================================================
  // 候補の無視
  // ============================================================

  /**
   * 取込候補を無視する
   *
   * @param {string} candidateId
   * @param {string} [ignoredByUserId]
   * @return {boolean}
   */
  function ignoreImportCandidate(candidateId, ignoredByUserId) {
    if (!candidateId) throwUserError('候補IDが指定されていません。');

    var candidate = SheetRepository.findRowById(
      SHEET_NAMES.IMPORT_ORDER_CANDIDATES, 'candidate_id', candidateId
    );
    if (!candidate) {
      throwUserError('指定された取込候補が見つかりません。');
    }

    SheetRepository.updateRowById(
      SHEET_NAMES.IMPORT_ORDER_CANDIDATES, 'candidate_id', candidateId,
      {
        candidate_status: ENUMS.CANDIDATE_STATUS.IGNORED,
        updated_at: nowIso()
      }
    );

    Logger.log('[GmailImport] 候補無視: candidate=' + candidateId +
      ', by=' + (ignoredByUserId || 'unknown'));
    return true;
  }

  // ============================================================
  // 既存候補のステータス更新（発送メール受信時）
  // ============================================================

  /**
   * 同一注文の既存候補を shipped に更新する
   * 発送通知メール取込時に、対応する ordered 候補があれば更新する
   *
   * @param {string} vendor
   * @param {string} orderId
   * @return {number} 更新した件数
   */
  function upgradeOrderedToShipped(vendor, orderId) {
    if (!orderId) return 0;

    var targets = SheetRepository.findRows(SHEET_NAMES.IMPORT_ORDER_CANDIDATES, function(row) {
      return toStr(row.vendor) === vendor &&
        toStr(row.order_id) === orderId &&
        toStr(row.candidate_status) === ENUMS.CANDIDATE_STATUS.ORDERED;
    });

    var count = 0;
    for (var i = 0; i < targets.length; i++) {
      SheetRepository.updateRowById(
        SHEET_NAMES.IMPORT_ORDER_CANDIDATES, 'candidate_id', targets[i].candidate_id,
        {
          candidate_status: ENUMS.CANDIDATE_STATUS.SHIPPED,
          fulfillment_status: ENUMS.FULFILLMENT_STATUS.SHIPPED,
          mail_phase: ENUMS.MAIL_PHASE.SHIPPED,
          updated_at: nowIso()
        }
      );
      count++;
    }

    if (count > 0) {
      Logger.log('[GmailImport] ordered → shipped 更新: vendor=' + vendor +
        ', order=' + orderId + ', count=' + count);
    }

    return count;
  }

  // ============================================================
  // 個別 vendor 取込（UI の「今すぐ実行」用）
  // ============================================================

  /**
   * Amazon メール取込のみ実行する
   * @return {number} 候補数
   */
  function importAmazonMails() {
    var userId = getCurrentUserIdFromProps() || '';
    var email = '';
    try { email = Session.getActiveUser().getEmail(); } catch (e) { /* ignore */ }

    return importVendorMails_(
      ENUMS.EXTERNAL_VENDOR.AMAZON,
      getAmazonSearchQuery(),
      AmazonMailParser,
      userId,
      email
    );
  }

  /**
   * マツキヨメール取込のみ実行する
   * @return {number} 候補数
   */
  function importMatsukiyoMails() {
    var userId = getCurrentUserIdFromProps() || '';
    var email = '';
    try { email = Session.getActiveUser().getEmail(); } catch (e) { /* ignore */ }

    return importVendorMails_(
      ENUMS.EXTERNAL_VENDOR.MATSUKIYO,
      getMatsukiyoSearchQuery(),
      MatsukiyoMailParser,
      userId,
      email
    );
  }

  /**
   * 自動確定済みの候補一覧を取得する（直近のログ確認用）
   * @param {number} [limit=20]
   * @return {Object[]}
   */
  function getAutoConfirmedCandidates(limit) {
    var max = limit || 20;
    var rows = SheetRepository.findRows(SHEET_NAMES.IMPORT_ORDER_CANDIDATES, function(row) {
      return toStr(row.candidate_status) === ENUMS.CANDIDATE_STATUS.AUTO_CONFIRMED;
    });

    rows.sort(function(a, b) {
      var da = parseDate(a.updated_at);
      var db = parseDate(b.updated_at);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db.getTime() - da.getTime();
    });

    return rows.slice(0, max);
  }

  // 公開API（仕様書 Section 20 準拠）
  return {
    runMyGmailImport: runMyGmailImport,
    importAmazonMails: importAmazonMails,
    importMatsukiyoMails: importMatsukiyoMails,
    saveImportCandidate: saveImportCandidate,
    getImportCandidates: getImportCandidates,
    getAutoConfirmedCandidates: getAutoConfirmedCandidates,
    confirmImportCandidate: confirmImportCandidate,
    ignoreImportCandidate: ignoreImportCandidate,
    upgradeOrderedToShipped: upgradeOrderedToShipped
  };

})();
