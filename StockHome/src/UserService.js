/**
 * UserService.gs
 * 家族ユーザーの管理
 *
 * 仕様書 Section 7.1 / Section 20 (UserService) 準拠
 *
 * ユーザー識別の主キーは user_id。
 * email は補助情報であり必須ではない。
 * Session.getActiveUser().getEmail() で取得した email を users シートと
 * 突合して current_user を解決する。
 * 初回アクセスで該当ユーザーがいなければ仮登録を促す。
 */

var UserService = (function() {

  // ----------------------------------------------------------
  // 現在ユーザーの取得
  // ----------------------------------------------------------

  /**
   * 現在操作中のユーザーを取得する
   *
   * 解決順序:
   *   1. UserProperties の current_user_id
   *   2. Session.getActiveUser().getEmail() で users シートを検索
   *   3. 見つからなければ null
   *
   * @return {Object|null} ユーザーオブジェクト
   */
  function getCurrentUser() {
    // 1. UserProperties に保存済みならそれを使う
    var savedId = getCurrentUserIdFromProps();
    if (savedId) {
      var user = findUserById(savedId);
      if (user && toBool(user.is_active)) {
        return user;
      }
    }

    // 2. email で検索
    var email = '';
    try {
      email = Session.getActiveUser().getEmail();
    } catch (e) {
      Logger.log('[UserService] Session.getActiveUser() 失敗: ' + e.message);
    }

    if (email) {
      var users = getUsers();
      for (var i = 0; i < users.length; i++) {
        if (toStr(users[i].email) === email && toBool(users[i].is_active)) {
          // 見つかったら UserProperties にキャッシュ
          setCurrentUserIdToProps(users[i].user_id);
          return users[i];
        }
      }
    }

    return null;
  }

  // ----------------------------------------------------------
  // ユーザー一覧
  // ----------------------------------------------------------

  /**
   * 全ユーザーを取得する（有効ユーザーのみ）
   * @return {Object[]}
   */
  function getUsers() {
    return SheetRepository.findRows(SHEET_NAMES.USERS, function(row) {
      return toBool(row.is_active);
    });
  }

  /**
   * 全ユーザーを取得する（無効含む）
   * @return {Object[]}
   */
  function getAllUsers() {
    return SheetRepository.getAllRows(SHEET_NAMES.USERS);
  }

  // ----------------------------------------------------------
  // ユーザー検索
  // ----------------------------------------------------------

  /**
   * user_id でユーザーを検索する
   * @param {string} userId
   * @return {Object|null}
   */
  function findUserById(userId) {
    if (!userId) return null;
    return SheetRepository.findRowById(SHEET_NAMES.USERS, 'user_id', userId);
  }

  /**
   * email でユーザーを検索する
   * @param {string} email
   * @return {Object|null}
   */
  function findUserByEmail(email) {
    if (!email) return null;
    var rows = SheetRepository.findRows(SHEET_NAMES.USERS, function(row) {
      return toStr(row.email) === email;
    });
    return rows.length > 0 ? rows[0] : null;
  }

  // ----------------------------------------------------------
  // ユーザー登録・更新
  // ----------------------------------------------------------

  /**
   * ユーザーを作成または更新する
   *
   * userData に user_id がある場合は更新、なければ新規作成。
   *
   * @param {Object} userData
   *   - user_name {string} 必須
   *   - email {string} 任意
   *   - existing_bot_target_id {string} 任意
   *   - role {string} 任意（デフォルト: member）
   * @return {Object} 作成/更新されたユーザーオブジェクト
   */
  /**
   * Session の有効ユーザーから email を取得する
   * 失敗時は空文字を返す
   * @return {string}
   * @private
   */
  function getActiveSessionEmail_() {
    try {
      var email = Session.getActiveUser().getEmail();
      return email || '';
    } catch (e) {
      Logger.log('[UserService] Session.getActiveUser().getEmail() 失敗: ' + e.message);
      return '';
    }
  }

  /**
   * userData.user_id が未指定なら、既存ユーザーの検出を試みて補完する
   * 1. UserProperties キャッシュ（getCurrentUserIdFromProps）
   * 2. Session email と users.email の突合
   * いずれかでヒットすれば userData.user_id を上書きする（副作用）
   *
   * 既存ユーザーがフォームから「保存」を押した際の重複登録を防ぐため、
   * および email を Session から自動補完するための事前ステップ。
   *
   * @param {Object} userData
   * @param {string} sessionEmail Session.getActiveUser().getEmail()
   * @private
   */
  function autoResolveExistingUserId_(userData, sessionEmail) {
    if (userData.user_id) return;

    var savedId = getCurrentUserIdFromProps();
    if (savedId) {
      var savedUser = findUserById(savedId);
      if (savedUser && toBool(savedUser.is_active)) {
        userData.user_id = savedId;
        return;
      }
    }

    if (sessionEmail) {
      var users = getUsers();
      for (var i = 0; i < users.length; i++) {
        if (toStr(users[i].email) === sessionEmail) {
          userData.user_id = users[i].user_id;
          return;
        }
      }
    }
  }

  function createOrUpdateUser(userData) {
    // バリデーション
    var v = Validation.validateUser(userData);
    if (!v.valid) {
      throwUserError(v.errors.join('\n'));
    }

    // email は明示入力が無ければ Session から自動取得を試みる
    var sessionEmail = getActiveSessionEmail_();
    // user_id 未指定でも既存ユーザーを検出できれば更新パスに振り分ける
    autoResolveExistingUserId_(userData, sessionEmail);

    var now = nowIso();

    if (userData.user_id) {
      // --- 更新 ---
      var existing = findUserById(userData.user_id);
      if (!existing) {
        throwUserError('指定されたユーザーが見つかりません。');
      }

      // email の優先順: 明示入力 > Session > 既存値
      // 既存値が空でも Session から取得できれば空欄が埋まる
      var emailToSet = toStr(userData.email) || sessionEmail || toStr(existing.email);

      var updateObj = {
        user_name: toStr(userData.user_name),
        email: emailToSet,
        existing_bot_target_id: toStr(userData.existing_bot_target_id),
        role: toStr(userData.role) || existing.role,
        updated_at: now
      };

      SheetRepository.updateRowById(
        SHEET_NAMES.USERS, 'user_id', userData.user_id, updateObj
      );

      return findUserById(userData.user_id);

    } else {
      // --- 新規作成 ---
      // email の優先順: 明示入力 > Session
      var emailToSet = toStr(userData.email) || sessionEmail;

      var newUser = {
        user_id: generatePrefixedId('USR'),
        user_name: toStr(userData.user_name),
        email: emailToSet,
        existing_bot_target_id: toStr(userData.existing_bot_target_id),
        role: toStr(userData.role) || ENUMS.ROLE.MEMBER,
        is_active: true,
        created_at: now,
        updated_at: now
      };

      SheetRepository.appendRow(SHEET_NAMES.USERS, newUser);

      // 作成したユーザーを current_user_id に設定
      setCurrentUserIdToProps(newUser.user_id);

      return newUser;
    }
  }

  /**
   * ユーザー名から表示名を取得する（通知文面等で使う）
   * @param {string} userId
   * @return {string} ユーザー名。見つからなければ '不明'
   */
  function getUserName(userId) {
    var user = findUserById(userId);
    return user ? toStr(user.user_name) : '不明';
  }

  // 公開API（仕様書 Section 20 準拠）
  return {
    getCurrentUser: getCurrentUser,
    getUsers: getUsers,
    getAllUsers: getAllUsers,
    createOrUpdateUser: createOrUpdateUser,
    findUserById: findUserById,
    findUserByEmail: findUserByEmail,
    getUserName: getUserName
  };

})();
