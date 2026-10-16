(() => {
  const $ = (selector) => document.querySelector(selector);
  const config = window.SONGLIST_CONFIG || {};
  const hiragana = Array.from('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽゔ');
  const keys = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B', 'Cm', 'C#m', 'Dbm', 'Dm', 'D#m', 'Ebm', 'Em', 'Fm', 'F#m', 'Gbm', 'Gm', 'G#m', 'Abm', 'Am', 'A#m', 'Bbm', 'Bm'];
  const pitchByName = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
  const sharpNotes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const flatNotes = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  let songs = [];
  let user = null;
  let supabase = null;
  let pendingImport = [];
  let toastTimer = 0;
  const Core = window.SonglistCore;
  const Practice = window.SonglistPractice;
  let editorPractice = null;
  let historyEditing = null;
  let historyLimit = 100;
  let drafts;
  try { drafts = Core.draftStore(window.localStorage); }
  catch (_) { drafts = Core.draftStore({ get length() { throw new Error('Storage unavailable'); }, setItem() { throw new Error('Storage unavailable'); } }); }
  const draftId = crypto.randomUUID();
  let revision = 0;
  let baseSongs = [];
  let loadState = 'idle';
  let dirty = false;
  let saving = false;
  let saveTask = null;
  let stamp = 0;
  let storageError = false;
  let pendingDrafts = [];
  let restoreSource = null;
  let conflictState = null;
  let shareRecord = null;
  let pageLimit = 100;
  let recoveryMode = new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery';
  let authBusy = false;
  let mailCooldown = 0;
  let loadGeneration = 0;
  let activeListLoad = null;
  const mobileLayout = window.matchMedia('(max-width: 700px)');
  const openMobileSongs = new Set();
  let renderedListScope = '';
  let sharedListMode = false;
  let sharedListRecord = null;
  let authMode = 'signup';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function getKanaInitial(value) {
    if (!value) return '';
    const char = normalizeReading(value).charAt(0);
    if (hiragana.includes(char)) return char;
    return '';
  }

  function normalizeReading(value) {
    return Array.from(String(value || '').normalize('NFKC').trim(), (char) => {
      const code = char.charCodeAt(0);
      return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : char;
    }).join('');
  }

  function inferReadingFromName(value) {
    const text = String(value || '').trim();
    return /^[\u3041-\u3096\u3099\u309a\u30a1-\u30f6ー・\s　]+$/u.test(text) ? normalizeReading(text) : '';
  }

  function fillKeySelect(select, selected) {
    select.innerHTML = '<option value="">未設定</option>' + keys.map((key) => '<option value="' + key + '">' + key + '</option>').join('');
    const normalized = normalizeKey(selected);
    if (keys.includes(normalized)) select.value = normalized;
    else if (selected) {
      const option = document.createElement('option');
      option.value = selected;
      option.textContent = selected + '（登録済み）';
      select.append(option);
      select.value = selected;
    }
  }

  function normalizeKey(value) {
    return String(value || '').normalize('NFKC').trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  }

  function keyInfo(key) {
    const match = normalizeKey(key).match(/^([A-G](?:#|b)?)(m?)$/i);
    if (!match) return null;
    const tonic = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    if (!(tonic in pitchByName)) return null;
    const minor = match[2].toLowerCase() === 'm';
    const flatPreferred = ['F', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm'].includes(tonic + (minor ? 'm' : ''));
    return { pitch: pitchByName[tonic], minor, flat: tonic.includes('b') || flatPreferred };
  }

  function keyName(pitch, minor, flat) {
    const table = flat ? flatNotes : sharpNotes;
    return table[((pitch % 12) + 12) % 12] + (minor ? 'm' : '');
  }

  function sungKey(song) {
    const parsed = keyInfo(song.key);
    if (!parsed) return '';
    return keyName(parsed.pitch + Number(song.transpose || 0), parsed.minor, parsed.flat);
  }

  function parallelKey(key) {
    const parsed = keyInfo(key);
    if (!parsed) return '';
    return keyName(parsed.pitch + (parsed.minor ? 3 : -3), !parsed.minor, parsed.flat);
  }

  function signed(value) {
    const number = Number(value || 0);
    return number === 0 ? '±0' : number > 0 ? '+' + number : String(number);
  }

  function localDate() {
    const date = new Date();
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function formatDate(value) {
    if (!value) return '未記録';
    const match = String(value).match(/^(\d{4})-(\d\d)-(\d\d)$/);
    return match ? match[1] + '.' + match[2] + '.' + match[3] : value;
  }

  function announce(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function userDisplayName(account = user) {
    if (!account) return '';
    const metadata = account.user_metadata || {};
    return String(metadata.full_name || metadata.name || 'ユーザー').trim();
  }

  function personalView() {
    return Boolean(user && !sharedListMode);
  }

  function updateListTitle() {
    const name = sharedListMode ? sharedListRecord?.display_name : userDisplayName();
    $('#list-title').textContent = name ? name + 'のソングリスト' : 'マイソングリスト';
  }

  function setSyncState(label, state) {
    $('#sync-label').textContent = label;
    $('#sync-status').classList.remove('ok', 'warn');
    if (state) $('#sync-status').classList.add(state);
  }

  function updatePreview() {
    const tempSong = { key: $('#song-key').value, transpose: Number($('#transpose-value').value || 0) };
    const effective = sungKey(tempSong);
    const relative = parallelKey(effective);
    const preview = $('#key-preview');
    preview.innerHTML = '<span class="key-chip">' + escapeHtml(effective || '—') + '</span><span class="parallel-link">/</span><span class="parallel-chip">' + escapeHtml(relative || '—') + '</span>';
  }

  function updateTransposeOutput() {
    const value = Math.max(-24, Math.min(24, Number($('#transpose-value').value || 0)));
    $('#transpose-value').value = value;
    $('#transpose-output').textContent = signed(value);
    if (editorPractice) {
      editorPractice.presets.find((p) => p.id === editorPractice.activePresetId).transpose = value;
      refreshPresetChoices();
      const input = [...document.querySelectorAll('#preset-rows input[data-preset-field="transpose"]')].find((el) => el.dataset.presetId === editorPractice.activePresetId);
      if (input && input !== document.activeElement) input.value = value;
    }
    updatePreview();
  }

  function sortSongs(list, mode = $('#sort-mode').value) {
    return list.sort((left, right) => {
      if (mode === 'recent') return (right.lastSung || '').localeCompare(left.lastSung || '') || collator.compare(left.artist, right.artist) || collator.compare(left.title, right.title);
      const storedOrderField = mode === 'title' ? 'titleSortIndex' : 'artistSortIndex';
      const storedOrder = sharedListMode && Number.isInteger(left[storedOrderField]) && Number.isInteger(right[storedOrderField])
        ? left[storedOrderField] - right[storedOrderField]
        : null;
      if (storedOrder !== null) return storedOrder;
      if (mode === 'title') return collator.compare(left.songKana || left.title, right.songKana || right.title) || collator.compare(left.title, right.title) || collator.compare(left.artistKana || left.artist, right.artistKana || right.artist);
      return collator.compare(left.artistKana || left.artist, right.artistKana || right.artist) || collator.compare(left.artist, right.artist) || collator.compare(left.songKana || left.title, right.songKana || right.title) || collator.compare(left.title, right.title);
    });
  }

  function filteredSongs() {
    const terms = normalizeReading($('#search-input').value).toLocaleLowerCase('ja').split(/\s+/u).filter(Boolean);
    const showHidden = personalView() && $('#show-hidden').checked;
    const artistFilter = $('#artist-filter').value;
    const list = songs.filter((song) => {
      if (artistFilter && song.artist !== artistFilter) return false;
      if (personalView()) {
        const practiceFilter = $('#practice-filter').value;
        if (practiceFilter === 'never' && song.lastSung) return false;
        if (practiceFilter === 'recent' && (!song.lastSung || song.lastSung < dateBefore(30))) return false;
        if (practiceFilter === 'older' && song.lastSung && song.lastSung >= dateBefore(90)) return false;
      }
      if (!song.visible && !showHidden) return false;
      if (!terms.length) return true;
      const searchable = [song.artist, song.artistKana, song.title, song.songKana, song.key, sungKey(song)];
      if (personalView()) searchable.push(song.notes);
      const fields = searchable.map((value) => normalizeReading(value).toLocaleLowerCase('ja'));
      return terms.every((term) => fields.some((value) => value.includes(term)));
    });
    return sortSongs(list);
  }

  function actionButton(action, id, label, title, icon, extra) {
    return '<button class="row-action ' + (extra || '') + '" type="button" data-action="' + action + '" data-id="' + escapeHtml(id) + '" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">' + (icon || escapeHtml(label)) + '</button>';
  }

  function songRow(song) {
    const key = sungKey(song);
    const relative = parallelKey(key);
    const original = song.key || '—';
    const chordSearch = '<button class="search-menu-button" type="button" data-action="search-menu" data-id="' + escapeHtml(song.id) + '" title="Chordwiki・YouTube・コード譜検索" aria-label="' + escapeHtml(song.title) + 'を検索">検索 ▾</button>';
    const visibilityIcon = song.visible
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.1 3.7M6.2 6.2C3.4 8 2 12 2 12s3.5 6 10 6c1.3 0 2.5-.3 3.5-.7"/></svg>';
    const adminActions = personalView()
      ? actionButton('toggle-visible', song.id, '', song.visible ? '一覧から非表示にする' : '一覧に表示する', visibilityIcon) + actionButton('sung', song.id, '', '今日歌った', '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 15l2 2 5-5"/></svg>', 'recorded') + actionButton('edit', song.id, '', '編集', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-.8L19.5 7.7a2.12 2.12 0 0 0-3-3L5 16.2 4 20Z"/></svg>') + actionButton('delete', song.id, '', '削除', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg>')
      : '';
    const searchCell = '<td class="search-cell"><div class="row-actions search-actions">' + chordSearch + '</div></td>';
    const actionCell = personalView() ? '<td><div class="row-actions">' + adminActions + '</div></td>' : '';
    const transposeLabel = '(' + signed(song.transpose) + ')';
    const quickKey = personalView()
      ? '<span class="transpose-label key-chip">' + escapeHtml(transposeLabel) + '</span><span class="base-key">' + escapeHtml(original) + '</span><span class="key-arrow">→</span><button class="key-nudge" type="button" data-action="transpose" data-delta="-1" data-id="' + escapeHtml(song.id) + '" aria-label="半音下げる">−</button><span class="key-chip" title="自分が歌うキー">' + escapeHtml(key || '—') + '</span><button class="key-nudge" type="button" data-action="transpose" data-delta="1" data-id="' + escapeHtml(song.id) + '" aria-label="半音上げる">＋</button><span class="parallel-link">/</span><span class="parallel-chip" title="平行調">' + escapeHtml(relative || '—') + '</span>'
      : '<span class="transpose-label key-chip">' + escapeHtml(transposeLabel) + '</span><span class="base-key">' + escapeHtml(original) + '</span><span class="key-arrow">→</span><span class="key-chip" title="自分が歌うキー">' + escapeHtml(key || '—') + '</span><span class="parallel-link">/</span><span class="parallel-chip" title="平行調">' + escapeHtml(relative || '—') + '</span>';
    const hiddenMark = song.visible ? '' : '<span class="hidden-pill">非表示</span>';
    const notesCell = personalView() ? '<td><div class="note-cell" title="' + escapeHtml(song.notes || '') + '"><span>' + escapeHtml(song.notes || '—') + '</span></div></td>' : '';
    const artistReading = personalView() ? '<div class="cell-scroll reading-scroll" title="アーティスト名の読み仮名"><span class="artist-reading">' + escapeHtml(song.artistKana) + '</span></div>' : '';
    const songReading = personalView() ? '<div class="cell-scroll reading-scroll" title="曲名の読み仮名"><span class="song-reading">' + escapeHtml(song.songKana) + '</span></div>' : '';
    const artistAddButton = personalView() ? '<button class="artist-add-button" type="button" data-action="add-artist" data-id="' + escapeHtml(song.id) + '" title="このアーティストの曲を追加" aria-label="' + escapeHtml(song.artist) + 'の曲を追加"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>' : '';
    return '<tr class="' + (song.visible ? '' : 'is-hidden-song') + '">' +
      '<td><div class="artist-cell"><div class="artist-main"><div class="artist-info"><div class="cell-scroll"><span class="artist-name" title="' + escapeHtml(song.artist) + '">' + escapeHtml(song.artist) + hiddenMark + '</span></div>' + artistReading + '</div>' + artistAddButton + '</div></div></td>' +
      '<td><div class="song-cell"><div class="cell-scroll"><span class="song-name" title="' + escapeHtml(song.title) + '">' + escapeHtml(song.title) + '</span></div>' + songReading + '</div></td>' +
      '<td><div class="key-stack"><div class="key-cell">' + quickKey + '</div>' + (personalView() ? presetSwitcher(song) : '') + '</div></td>' +
      searchCell +
      '<td><div class="cell-scroll date-scroll"><span class="date-cell ' + (song.lastSung ? 'date-recorded' : 'date-empty') + '">' + escapeHtml(formatDate(song.lastSung)) + '</span>' + (personalView() ? '<button class="history-link" type="button" data-action="history" data-id="' + escapeHtml(song.id) + '">履歴 ' + Practice.get(song).history.length + '回</button>' : '') + '</div></td>' +
      notesCell + actionCell + '</tr>';
  }

  function render() {
    updateArtistOptions();
    const scope = sharedListMode ? 'share:' + new URLSearchParams(window.location.search).get('list') : 'user:' + (user?.id || '');
    if (renderedListScope !== scope) openMobileSongs.clear();
    else document.querySelectorAll('.song-card').forEach((card) => {
      if (card.open) openMobileSongs.add(card.dataset.songId);
      else openMobileSongs.delete(card.dataset.songId);
    });
    renderedListScope = scope;
    const focused = document.activeElement?.dataset;
    const focusKey = focused?.action ? {action:focused.action,id:focused.id,delta:focused.delta} : null;
    if ($('#history-dialog').open) renderHistory();
    const list = filteredSongs();
    updateKanaIndex(list);
    const canEdit = personalView();
    const countScope = canEdit ? songs : songs.filter((song) => song.visible);
    const artistCount = new Set(countScope.map((song) => song.artist)).size;
    $('#artist-count').textContent = artistCount.toLocaleString('ja-JP');
    $('#song-count').textContent = countScope.length.toLocaleString('ja-JP');
    const isFiltered = Boolean($('#search-input').value.trim() || $('#artist-filter').value || (personalView() && $('#practice-filter').value));
    $('#search-clear').classList.toggle('hidden', !isFiltered);
    $('#result-count').textContent = isFiltered ? '検索結果 ' + list.length.toLocaleString('ja-JP') + ' 曲' : '全 ' + list.length.toLocaleString('ja-JP') + ' 曲';
    $('.sort-note').innerHTML = '<span class="sort-symbol">↕</span> ' + ({ artist: 'アーティスト五十音順', title: '曲名五十音順', recent: '最後に歌った日順' }[$('#sort-mode').value] || 'アーティスト五十音順');
    $('#empty-state').classList.toggle('hidden', list.length > 0 || loadState !== 'ready');
    const emptyLibrary = canEdit && loadState === 'ready' && songs.length === 0;
    $('#empty-title').textContent = emptyLibrary ? '最初の1曲を登録しましょう' : '曲が見つかりませんでした';
    $('#empty-description').textContent = emptyLibrary ? '「曲を追加」から登録するか、CSVでまとめて取り込めます。' : isFiltered ? '読み仮名でも検索できます。キーワードを短くするか、検索をクリアしてください。' : '表示できる曲がありません。';
    $('#empty-add').classList.toggle('hidden', !emptyLibrary);
    $('#empty-clear').classList.toggle('hidden', !isFiltered || emptyLibrary);
    if (!list.length) {
      $('#song-list').innerHTML = '';
      $('#mobile-song-list').innerHTML = '';
      $('#load-more').classList.add('hidden');
      updateDataUi();
      return;
    }
    const actionHead = canEdit ? '<th scope="col">操作</th>' : '';
    const actionCol = canEdit ? '<col class="actions">' : '';
    const notesHead = canEdit ? '<th scope="col">備考</th>' : '';
    const notesCol = canEdit ? '<col class="notes">' : '';
    const listType = canEdit ? ' owner-list' : ' public-list';
    const shown = list.slice(0, pageLimit);
    $('#load-more').classList.toggle('hidden', list.length <= shown.length);
    $('#load-more').textContent = 'さらに表示（残り ' + (list.length - shown.length) + ' 曲）';
    if (mobileLayout.matches) {
      if ($('#song-list').hasChildNodes()) $('#song-list').replaceChildren();
      $('#mobile-song-list').innerHTML = shown.map(songCard).join('');
      $('#mobile-song-list').querySelectorAll('.song-card').forEach((card) => { card.open = openMobileSongs.has(card.dataset.songId); });
    } else {
      if ($('#mobile-song-list').hasChildNodes()) $('#mobile-song-list').replaceChildren();
      $('#song-list').innerHTML = '<table class="song-table' + listType + '"><colgroup><col class="artist"><col class="title"><col class="key"><col class="search"><col class="last">' + notesCol + actionCol + '</colgroup><thead><tr><th scope="col">アーティスト</th><th scope="col">曲名</th><th scope="col">（移調）原曲 → 歌うキー / 平行調</th><th class="search-heading" scope="col" title="Chordwiki・YouTube・コード譜検索">検索</th><th scope="col">最後に歌った日</th>' + notesHead + actionHead + '</tr></thead><tbody>' + shown.map(songRow).join('') + '</tbody></table>';
    }
    updateDataUi();
    if (focusKey) [...document.querySelectorAll('[data-action]')].find((el) => el.dataset.action === focusKey.action && el.dataset.id === focusKey.id && el.dataset.delta === focusKey.delta && el.offsetParent)?.focus({preventScroll:true});
  }

  function updateAccessUi() {
    const canShowApp = Boolean(user || sharedListMode);
    if (!user) document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    $('#auth-gate').classList.toggle('hidden', canShowApp || recoveryMode);
    $('#recovery-gate').classList.toggle('hidden', !recoveryMode);
    $('#app-shell').classList.toggle('hidden', !canShowApp || recoveryMode);
    document.querySelectorAll('.user-only').forEach((element) => element.classList.toggle('hidden', !personalView()));
    $('#auth-button').classList.toggle('hidden', !sharedListMode);
    $('#logout-button').classList.toggle('hidden', !personalView());
    $('#account-settings-button').classList.toggle('hidden', !personalView());
    $('#hidden-filter-wrap').classList.toggle('hidden', !personalView());
    $('.overview-share').classList.toggle('hidden', !personalView());
    updateListTitle();
    if (!user && !sharedListMode) setSyncState('ログインしてください', '');
    render();
  }

  async function initializeAuth() {
    if (!config.supabaseUrl || !config.supabaseAnonKey) return;
    let bootstrapping = true;
    let startupSession;
    try {
      const module = await import('https://esm.sh/@supabase/supabase-js@2.118.0');
      supabase = module.createClient(config.supabaseUrl, config.supabaseAnonKey);
      supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'INITIAL_SESSION') return; // getSession below is the single startup path.
        if (bootstrapping) startupSession = session;
        if (event === 'PASSWORD_RECOVERY') {
          recoveryMode = true;
          user = session?.user || null;
          updateAccessUi();
          return;
        }
        if (bootstrapping || sharedListMode) return;
        const nextUser = session?.user || null;
        if (user?.id === nextUser?.id) { if (nextUser) user = nextUser; return; }
        ++loadGeneration; activeListLoad = null; openMobileSongs.clear();
        user = nextUser;
        songs = []; baseSongs = []; dirty = false; pendingDrafts = []; conflictState = null;
        shareRecord = null; loadState = 'idle'; revision = 0;
        const accountId = nextUser?.id;
        setTimeout(() => {
          if (user?.id !== accountId) return;
          updateAccessUi();
          if (user) void loadSongsForCurrentUser();
        }, 0);
      });
      const result = await supabase.auth.getSession();
      bootstrapping = false;
      if (result.error) throw result.error;
      user = (startupSession === undefined ? result.data.session : startupSession)?.user || null;
      updateAccessUi();
    } catch (error) {
      bootstrapping = false;
      console.error('Auth initialization failed', error);
      showError($('#auth-error'), '接続できません。通信状態を確認してページを再読み込みしてください。');
      setSyncState('接続できません', 'warn');
    }
  }

  function publicSongSnapshot(list) {
    const visibleSongs = list.filter((song) => song.visible);
    const artistOrder = new Map(sortSongs(visibleSongs.slice(), 'artist').map((song, index) => [song.id, index]));
    const titleOrder = new Map(sortSongs(visibleSongs.slice(), 'title').map((song, index) => [song.id, index]));
    return visibleSongs.map((song) => ({
      id: song.id,
      artist: song.artist,
      artistKana: song.artistKana,
      title: song.title,
      songKana: song.songKana,
      artistSortIndex: artistOrder.get(song.id),
      titleSortIndex: titleOrder.get(song.id),
      key: song.key,
      transpose: song.transpose,
      lastSung: song.lastSung,
      visible: true
    }));
  }

  async function loadSharedList() {
    const shareId = new URLSearchParams(window.location.search).get('list');
    if (!shareId || !config.supabaseUrl || !config.supabaseAnonKey) throw new Error('閲覧用URLが正しくありません。');
    // This RPC already exposes only the enabled share's public projection.
    // Read it anonymously without loading the auth SDK or inspecting a saved session.
    const headers = { apikey:config.supabaseAnonKey, 'Content-Type':'application/json' };
    if (config.supabaseAnonKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + config.supabaseAnonKey;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(),20000);
    let response;
    try {
      response = await fetch(config.supabaseUrl.replace(/\/+$/u,'') + '/rest/v1/rpc/get_public_song_list', {
        method:'POST', headers, body:JSON.stringify({p_share_id:shareId}),
        credentials:'omit', cache:'no-store', signal:controller.signal
      });
      if (!response.ok) throw new Error('Shared list request failed: ' + response.status);
      const rows = await response.json();
      const data = Array.isArray(rows) ? rows[0] : rows;
      if (!data || !Array.isArray(data.songs)) throw new Error('この閲覧用リストは見つからないか、共有が停止されています。');
      return data;
    } finally { window.clearTimeout(timeout); }
  }

  function loadSongsForCurrentUser() {
    const accountId = user?.id;
    if (!sharedListMode && !accountId) {
      ++loadGeneration; activeListLoad = null;
      loadState = 'idle'; render(); return Promise.resolve();
    }
    const scope = sharedListMode ? 'share:' + new URLSearchParams(window.location.search).get('list') : 'user:' + accountId;
    if (activeListLoad?.scope === scope) return activeListLoad.promise;
    if (dirty || saving) { announce('未保存の変更を保存または書き出してから再読み込みしてください。'); return Promise.resolve(); }
    const request = { scope, generation:++loadGeneration, promise:null };
    activeListLoad = request;
    request.promise = performListLoad(request,accountId);
    return request.promise;
  }

  async function performListLoad(request,accountId) {
    const isCurrent = () => request.generation === loadGeneration && (sharedListMode || user?.id === accountId);
    loadState = 'loading';
    setSyncState(sharedListMode ? '閲覧用リストを読み込み中' : '読み込み中', 'warn'); render();
    try {
      if (sharedListMode) {
        const data = await loadSharedList();
        if (!isCurrent()) return;
        sharedListRecord = data;
        songs = data.songs.map(normalizeSong);
      } else {
        const { data, error } = await supabase.rpc('get_my_song_list');
        if (error) throw error;
        if (!isCurrent()) return;
        if (!data || !Array.isArray(data.songs) || !Number.isSafeInteger(data.revision)) throw new Error('Invalid server response');
        songs = data.songs.map(normalizeSong);
        baseSongs = structuredClone(songs); revision = data.revision; shareRecord = data.share;
        try { pendingDrafts = drafts.list(accountId).filter((d) => d.draftId !== draftId); }
        catch (_) { storageError = true; }
      }
      if (!isCurrent()) return;
      loadState = 'ready';
      setSyncState(sharedListMode ? '閲覧用リスト' : '保存済み', 'ok');
    } catch (error) {
      if (!isCurrent()) return;
      console.error('List load failed', error);
      loadState = 'error';
      setSyncState('読み込みに失敗', 'warn');
    } finally {
      if (activeListLoad === request) activeListLoad = null;
    }
    if (isCurrent()) { updateListTitle(); render(); }
  }

  function normalizeSong(song, index) {
    const title = song.title || song.song || '';
    return {
      id: String(song.id || 'song-' + (index + 1)),
      artistKana: normalizeReading(song.artistKana) || getKanaInitial(song.artist || ''),
      artist: String(song.artist || ''),
      songKana: normalizeReading(song.songKana) || getKanaInitial(title),
      title: String(title),
      artistSortIndex: Number.isInteger(song.artistSortIndex) ? song.artistSortIndex : null,
      titleSortIndex: Number.isInteger(song.titleSortIndex) ? song.titleSortIndex : null,
      key: String(song.key || ''),
      transpose: Math.max(-24, Math.min(24, Number(song.transpose || 0) || 0)),
      lastSung: String(song.lastSung || ''),
      notes: String(song.notes || ''),
      visible: song.visible !== false,
      extra: song.extra && typeof song.extra === 'object' ? song.extra : {}
    };
  }

  function persistSongs() {
    if (!personalView() || loadState !== 'ready' || pendingDrafts.length || conflictState) return Promise.resolve(false);
    if (saveTask) return saveTask;
    if (!dirty) return Promise.resolve(true);
    const accountId = user.id;
    saveTask = (async () => {
      saving = true; updateDataUi();
      try {
        while (dirty && user?.id === accountId && !conflictState) {
          const savedStamp = stamp;
          const snapshot = structuredClone(songs);
          const { data, error } = await supabase.rpc('save_my_song_list', { p_songs: orderedSongs(snapshot), p_expected_revision: revision });
          if (error) throw error;
          if (user?.id !== accountId) return false;
          if (!data || !Number.isSafeInteger(data.revision)) throw new Error('Invalid save response');
          if (!data.ok) {
            const remote = data.songs.map(normalizeSong);
            const merge = Core.mergeSongs(baseSongs, songs, remote);
            if (merge.conflicts.length) {
              conflictState = { merge, remote, revision: data.revision };
              showConflicts(); return false;
            }
            baseSongs = remote; revision = data.revision; songs = merge.songs.map(normalizeSong);
            dirty = !sameSongs(songs, baseSongs); stamp++;
            if (dirty) storeDraft(songs); else finishDraft(accountId);
            render();
            continue;
          }
          revision = data.revision; baseSongs = snapshot;
          if (stamp === savedStamp) { dirty = false; finishDraft(accountId); }
          else storeDraft(songs);
        }
        return !dirty;
      } catch (error) {
        console.error('List save failed', error);
        announce('保存できませんでした。変更はこの端末に保持しています。「再送」で保存できます。');
        return false;
      } finally {
        saving = false; saveTask = null;
        if (user?.id === accountId) {
          setSyncState(dirty ? '未保存の変更あり' : '保存済み', dirty ? 'warn' : 'ok');
          updateDataUi();
        } else if (dirty) { setTimeout(() => void persistSongs(), 0); }
      }
    })();
    return saveTask;
  }

  function openSongDialog(song, defaults = {}) {
    if (!canMutate()) return;
    const editing = Boolean(song);
    $('#duplicate-hint').classList.add('hidden');
    $('#artist-picker').value = '';
    fillArtistPicker();
    $('#song-dialog-title').textContent = editing ? '曲を編集' : defaults.artist ? '同じアーティストに曲を追加' : '曲を追加';
    const artistContext = $('#artist-context');
    artistContext.classList.toggle('hidden', editing || !defaults.artist);
    artistContext.textContent = defaults.artist ? '「' + defaults.artist + '」のアーティスト名・読み仮名を引き継ぎました。新しい曲の情報を入力してください。' : '';
    $('#song-id').value = editing ? song.id : '';
    $('#artist-reading').value = editing ? song.artistKana : defaults.artistKana || '';
    $('#song-reading').value = editing ? song.songKana : '';
    $('#artist-name').value = editing ? song.artist : defaults.artist || '';
    $('#song-title').value = editing ? song.title : '';
    editorPractice = Practice.get(editing ? song : { id:'new', transpose:0, extra:{} });
    $('#preset-editor').open = false;
    renderPresetEditor();
    fillKeySelect($('#song-key'), editing ? song.key : '');
    $('#transpose-value').value = editing ? song.transpose : 0;
    updateTransposeOutput();
    $('#last-sung').value = formatDate(editing ? song.lastSung : '');
    $('#song-notes').value = editing ? song.notes : '';
    $('#song-visible').checked = editing ? song.visible : true;
    $('#form-error').classList.add('hidden');
    $('#song-dialog').showModal();
    if (defaults.artist && !editing) $('#song-title').focus();
    else $('#artist-name').focus();
  }

  function showError(element, message) {
    element.textContent = message;
    element.classList.remove('hidden');
  }

  async function saveSong(event) {
    event.preventDefault();
    if (!canMutate()) return;
    const id = $('#song-id').value;
    const artist = $('#artist-name').value.trim();
    const title = $('#song-title').value.trim();
    const artistKana = normalizeReading($('#artist-reading').value);
    const songKana = normalizeReading($('#song-reading').value);
    const previous = id ? songs.find((song) => song.id === id) : null;
    if (!artist || !title || (!artistKana && (!previous || artist !== previous.artist)) || (!songKana && (!previous || title !== previous.title))) {
      showError($('#form-error'), 'アーティスト名・曲名と、それぞれの読み仮名を入力してください。');
      return;
    }
    if (!validateEditorPresets()) return;
    const practice = { ...editorPractice, history: previous ? Practice.get(previous).history : [] };
    practice.presets.find((p) => p.id === practice.activePresetId).transpose = Number($('#transpose-value').value);
    const song = normalizeSong({
      id: id || crypto.randomUUID(),
      artistKana, artist, songKana: songKana || (previous && title === previous.title ? previous.songKana : ''), title,
      key: $('#song-key').value,
      transpose: $('#transpose-value').value,
      lastSung: previous?.lastSung || '',
      notes: $('#song-notes').value.trim(),
      visible: $('#song-visible').checked,
      extra: { ...(previous?.extra || {}), practice }
    });
    const duplicate = songs.find((item) => item.id !== id && songIdentity(item) === songIdentity(song));
    if (duplicate) {
      $('#duplicate-hint').classList.remove('hidden');
      $('#duplicate-edit').dataset.id = duplicate.id;
      showError($('#form-error'), '同じアーティスト・曲名が登録済みです。既存の曲を編集してください。別バージョンは曲名に区別を付けて登録できます。');
      return;
    }
    const next = previous ? songs.map((item) => item.id === id ? song : item) : [...songs, song];
    if (!commitSongs(next)) return;
    render();
    $('#song-dialog').close();
    try {
      if (await persistSongs()) announce(previous ? '曲の内容を更新しました。' : '曲を追加しました。');
    } catch (_) { /* The local backup is retained when remote saving fails. */ }
  }

  async function handleListAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const song = songs.find((item) => item.id === button.dataset.id);
    if (!song) return;
    if (action === 'search-menu') return openSearchMenu(song);
    if (action === 'history') return openHistory(song.id);
    if (action === 'chord-search') {
      window.open('https://www.google.com/search?q=' + encodeURIComponent(song.artist + ' ' + song.title + ' Chordwiki'), '_blank', 'noopener,noreferrer');
      return;
    }
    if (!canMutate()) return;
    if (action === 'add-artist') return openSongDialog(null, { artist: song.artist, artistKana: song.artistKana });
    if (action === 'edit') return openSongDialog(song);
    if (action === 'key-settings') { openSongDialog(song); $('#preset-editor').open = true; $('#preset-choice').focus(); return; }
    if (action === 'sung') return recordToday(song);
    let next = songs;
    if (action === 'delete') {
      if (!window.confirm('「' + song.artist + ' / ' + song.title + '」を削除しますか？')) return;
      next = songs.filter((item) => item.id !== song.id);
    } else {
      const updated = { ...song };
      if (action === 'toggle-visible') updated.visible = !song.visible;
      else if (action === 'transpose') Object.assign(updated, Practice.transpose(song, song.transpose + Number(button.dataset.delta)));
      else return;
      next = songs.map((item) => item.id === song.id ? updated : item);
    }
    if (commitSongs(next)) await persistSongs();
  }

  function setAuthMode(mode) {
    authMode = mode;
    const isSignup = mode === 'signup';
    $('#auth-heading').innerHTML = isSignup ? '自分だけの<br><span>ソングリストを。</span>' : 'おかえりなさい。<br><span>ログインしましょう。</span>';
    $('#auth-intro').textContent = isSignup
      ? 'アカウントを作成して、歌いたい曲やキーを自分専用のリストに保存しましょう。'
      : 'ログインすると、あなた専用のソングリストを開けます。';
    $('#auth-password').autocomplete = isSignup ? 'new-password' : 'current-password';
    $('#auth-submit-button').textContent = isSignup ? '無料で新規登録' : 'ログイン';
    $('#auth-switch-prompt').textContent = isSignup ? 'すでにアカウントをお持ちですか？' : '初めてご利用ですか？';
    $('#auth-mode-toggle').textContent = isSignup ? 'ログイン' : '新規登録';
    $('#auth-error').classList.add('hidden');
    $('#auth-message').classList.add('hidden');
  }

  async function authSubmit(event, signUp) {
    event.preventDefault();
    signUp = signUp === undefined ? authMode === 'signup' : signUp;
    $('#auth-error').classList.add('hidden');
    $('#auth-message').classList.add('hidden');
    if (!supabase) {
      showError($('#auth-error'), '現在接続できません。通信状態を確認して再度お試しください。');
      return;
    }
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!$('#auth-form').reportValidity()) return;
    if (authBusy) return;
    authBusy = true; $('#auth-submit-button').disabled = true;
    try {
    const result = signUp
      ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: new URL(window.location.pathname, window.location.origin).toString() } })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) {
      showError($('#auth-error'), authErrorMessage(result.error));
      return;
    }
    if (signUp && !result.data.session) {
      $('#auth-message').textContent = '確認メールを送信しました。メール内のリンクで登録を完了してください。届かない場合は迷惑メールを確認し、下の「確認メールを再送」をお試しください。';
      $('#auth-message').classList.remove('hidden');
      return;
    }
    const signedInUser = result.data.user || result.data.session?.user;
    const alreadyLoading = user?.id === signedInUser?.id && (loadState === 'loading' || loadState === 'ready');
    user = signedInUser;
    updateAccessUi();
    if (!alreadyLoading) await loadSongsForCurrentUser();
    announce('ログインしました。自分専用のリストを表示しています。');
    } catch (error) { showError($('#auth-error'), '通信に失敗しました。時間をおいて再度お試しください。'); }
    finally { authBusy = false; $('#auth-submit-button').disabled = false; }
  }

  function openProfileDialog() {
    $('#profile-display-name').value = userDisplayName();
    $('#profile-error').classList.add('hidden');
    $('#profile-dialog').showModal();
    $('#profile-display-name').focus();
  }

  async function saveProfile(event) {
    event.preventDefault();
    const name = $('#profile-display-name').value.trim();
    if (!name || !user || !supabase) return;
    const result = await supabase.auth.updateUser({ data: { full_name: name } });
    if (result.error) {
      showError($('#profile-error'), '表示名を保存できませんでした。時間をおいて再度お試しください。');
      return;
    }
    user = result.data.user;
    updateListTitle();
    $('#profile-dialog').close();
    if (shareRecord) {
      const { data, error } = await supabase.rpc('manage_my_song_share', { p_action: 'rename', p_display_name: name });
      if (error) return announce('自分の表示名は保存しました。共有名は「共有設定」で更新してください。');
      shareRecord = data;
    }
    announce('表示名を更新しました。');
  }

  async function changePassword(event) {
    event.preventDefault();
    $('#password-error').classList.add('hidden');
    $('#password-message').classList.add('hidden');
    const password = $('#new-password').value;
    if (password !== $('#confirm-password').value) {
      showError($('#password-error'), '確認用パスワードが一致しません。');
      return;
    }
    const result = await supabase.auth.updateUser({ password });
    if (result.error) {
      showError($('#password-error'), 'パスワードを変更できませんでした。時間をおいて再度お試しください。');
      return;
    }
    $('#password-form').reset();
    $('#password-message').textContent = 'パスワードを変更しました。';
    $('#password-message').classList.remove('hidden');
  }

  async function deleteAccount() {
    if (!user || !supabase) return;
    if (saving) return announce('保存が完了してからアカウントを削除してください。');
    const confirmation = 'アカウントと曲リストを削除します。元に戻せません。続けますか？';
    if (!window.confirm(confirmation)) return;
    $('#delete-account-error').classList.add('hidden');
    $('#delete-account-button').disabled = true;
    $('#delete-account-button').textContent = '削除しています…';
    const { error } = await supabase.functions.invoke('delete-songlist-account', { method: 'POST' });
    $('#delete-account-button').disabled = false;
    $('#delete-account-button').textContent = 'アカウントを削除';
    if (error) {
      showError($('#delete-account-error'), 'アカウントを削除できませんでした。管理者にお問い合わせください。');
      return;
    }
    for (const draft of drafts.list(user.id)) drafts.remove(user.id, draft.draftId);
    dirty = false; pendingDrafts = [];
    try { await supabase.auth.signOut({ scope: 'local' }); } catch (_) { /* The account was already removed. */ }
    user = null;
    songs = [];
    $('#account-settings-dialog').close();
    updateAccessUi();
    announce('アカウントを削除しました。');
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value);
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    const headers = ['ID', 'アーティスト名の読み仮名', 'アーティスト名', '曲名の読み仮名', '曲名', '原曲キー', '自分が歌うキー（移調）', '最後に歌った日', '備考', '一覧に表示', '追加データ(JSON)'];
    const rows = [headers, ...songs.map((song) => [song.id, song.artistKana, song.artist, song.songKana, song.title, song.key, song.transpose, song.lastSung, song.notes, song.visible ? 'true' : 'false', JSON.stringify(song.extra || {})])];
    const content = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'songlist-' + localDate() + '.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    announce('CSVを書き出しました。');
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else value += char;
      } else if (char === '"') quoted = true;
      else if (char === ',') { row.push(value); value = ''; }
      else if (char === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
      else value += char;
    }
    if (value || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
    return rows;
  }

  function columnIndex(header, candidates) {
    return header.findIndex((name) => candidates.includes(String(name || '').trim()));
  }

  function cleanImportedCell(value) {
    const text = String(value || '').trim();
    return ['#N/A', '#REF!', '#VALUE!', '#DIV/0!'].includes(text) ? '' : text;
  }

  function csvToSongs(text) {
    const rows = parseCsv(text.replace(/^\uFEFF/, ''));
    const headerIndex = rows.findIndex((row) => row.includes('アーティスト名') && row.includes('曲名'));
    if (headerIndex < 0) throw new Error('アーティスト名と曲名の列が見つかりません。CSVの形式を確認してください。');
    const header = rows[headerIndex].map((item) => item.trim());
    const original = header.includes('キー') && header.includes('最後に歌った') && header.includes('VE500');
    const columns = {
      id: columnIndex(header, ['ID', 'id']),
      artistKana: columnIndex(header, ['アーティスト名の読み仮名', 'アーティストの読み仮名', 'アーティストの頭文字', 'artistKana', 'artistReading']),
      artist: columnIndex(header, ['アーティスト名', 'artist']),
      songKana: columnIndex(header, ['曲名の読み仮名', '曲名の頭文字', 'songKana', 'songReading']),
      title: columnIndex(header, ['曲名', 'title', 'song']),
      key: columnIndex(header, ['原曲キー', 'key']),
      transpose: columnIndex(header, ['自分が歌うキー（移調）', '自分が歌うキー', 'transpose']),
      lastSung: columnIndex(header, ['最後に歌った日', '最後に歌った', 'lastSung']),
      notes: columnIndex(header, ['備考', '転調など', 'notes']),
      visible: columnIndex(header, ['一覧に表示', 'visible']),
      extra: columnIndex(header, ['追加データ(JSON)', 'extra'])
    };
    const valueAt = (row, key, fallback) => columns[key] >= 0 ? cleanImportedCell(row[columns[key]]) : fallback;
    const imported = [];
    for (const row of rows.slice(headerIndex + 1)) {
      const artist = original ? cleanImportedCell(row[1]) : valueAt(row, 'artist', '');
      const title = original ? cleanImportedCell(row[2]) : valueAt(row, 'title', '');
      if (!artist || !title) continue;
      const rawTranspose = original ? cleanImportedCell(row[5]) : valueAt(row, 'transpose', '0');
      const match = rawTranspose.match(/[-+]?\d+/);
      const rawDate = original ? cleanImportedCell(row[4]) : valueAt(row, 'lastSung', '');
      const normalizedDate = /^\d{8}$/.test(rawDate) ? rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8) : rawDate;
      let extra = {};
      const rawExtra = original ? null : valueAt(row, 'extra', '');
      if (rawExtra) { try { extra = JSON.parse(rawExtra); } catch (_) { extra = {}; } }
      if (original) {
        extra = {
          ve500: cleanImportedCell(row[3]),
          sourceTransposeText: rawTranspose,
          spotlight: cleanImportedCell(row[6]), sourceVisibilityMark: cleanImportedCell(row[7]),
          chordwikiTitle: cleanImportedCell(row[8]), chordSearchText: cleanImportedCell(row[9]),
          parallelKeyHint: cleanImportedCell(row[11]), recordingType: cleanImportedCell(row[17]),
          g: cleanImportedCell(row[13]), sourceNumber: cleanImportedCell(row[14]),
          tempo: cleanImportedCell(row[18]), content: cleanImportedCell(row[19]), voice: cleanImportedCell(row[20]), season: cleanImportedCell(row[21])
        };
      }
      imported.push(normalizeSong({
        id: original ? '' : valueAt(row, 'id', ''),
        artistKana: original ? cleanImportedCell(row[0]) : valueAt(row, 'artistKana', getKanaInitial(artist)),
        artist, songKana: original ? getKanaInitial(title) : valueAt(row, 'songKana', getKanaInitial(title)), title,
        key: original ? cleanImportedCell(row[10]) : valueAt(row, 'key', ''),
        transpose: match ? Number(match[0]) : 0,
        lastSung: normalizedDate, notes: original ? cleanImportedCell(row[12]) : valueAt(row, 'notes', ''),
        visible: original ? true : valueAt(row, 'visible', 'true').toLowerCase() !== 'false', extra
      }, imported.length));
    }
    if (!imported.length) throw new Error('取り込める曲データがありません。');
    return imported;
  }

  async function processImport(event) {
    event.preventDefault();
    if (!canMutate()) return;
    const beforeImport = songs;
    const mode = new FormData($('#import-form')).get('import-mode');
    if (mode === 'replace') {
      if (!window.confirm('現在の' + songs.length + '曲を、CSVの' + pendingImport.length + '曲で置き換えますか？')) return;
      songs = pendingImport.map((song, index) => normalizeSong({ ...song, id: song.id || 'import-' + Date.now() + '-' + index }, index));
    } else {
      const merged = new Map(songs.map((song) => [songIdentity(song), song]));
      const claimedIds = new Set(songs.map((song) => song.id));
      pendingImport.forEach((incoming) => {
        const key = songIdentity(incoming);
        const current = merged.get(key);
        let newId = current && current.id;
        if (!newId && incoming.id && !claimedIds.has(incoming.id)) newId = incoming.id;
        if (!newId) newId = crypto.randomUUID();
        claimedIds.add(newId);
        merged.set(key, normalizeSong({ ...current, ...incoming, id: newId }, merged.size));
      });
      songs = Array.from(merged.values());
    }
    const importedSongs = songs; songs = beforeImport;
    if (new Set(importedSongs.map((s) => s.id)).size !== importedSongs.length) return showError($('#import-error'), 'CSV内のIDが重複しています。IDを一意にするか、追加・更新を選んでください。');
    if (!commitSongs(importedSongs)) return;
    $('#import-dialog').close();
    try { if (await persistSongs()) announce(pendingImport.length + '曲を取り込みました。'); }
    catch (_) { /* A local backup is retained. */ }
    $('#import-file').value = '';
  }

  async function handleShare() {
    if (!personalView() || loadState !== 'ready') return;
    $('#share-name').value = shareRecord?.display_name || userDisplayName();
    updateShareDialog();
    $('#share-error').classList.add('hidden');
    $('#share-dialog').showModal();
  }

  async function signOut() {
    if (saving) return announce('保存が終わってからログアウトしてください。');
    if (dirty && !window.confirm('未保存の変更はこの端末に残し、ログアウトしますか？同じアカウントでログインすると復元できます。')) return;
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      user = null; songs = []; baseSongs = []; dirty = false; pendingDrafts = []; conflictState = null;
      loadState = 'idle'; shareRecord = null; revision = 0;
      $('#show-hidden').checked = false;
      updateAccessUi();
    } catch (_) { announce('ログアウトできませんでした。再度お試しください。'); }
  }

  function applyUrlFilters() {
    const params = new URLSearchParams(window.location.search);
    $('#search-input').value = params.get('q') || '';
    params.delete('genre');
  }

  async function start() {
    $('#footer-year').textContent = String(new Date().getFullYear());
    fillKeySelect($('#song-key'), '');
    $('#supabase-setup-hint').classList.toggle('hidden', Boolean(config.supabaseUrl && config.supabaseAnonKey));
    const params = new URLSearchParams(window.location.search);
    sharedListMode = Boolean(params.get('list'));
    if (sharedListMode) updateAccessUi();
    if (params.get('sort') === 'title' || params.get('sort') === 'recent') $('#sort-mode').value = params.get('sort');
    $('#add-button').addEventListener('click', () => openSongDialog(null));
    setupUpgradeEvents();
    setupPracticeEvents();
    setupKanaIndex();
    $('#empty-add').addEventListener('click', () => { if (personalView()) openSongDialog(null); });
    const clearSearch = () => { $('#search-input').value = ''; $('#artist-filter').value = ''; $('#practice-filter').value = ''; pageLimit = 100; render(); $('#search-input').focus(); };
    $('#search-clear').addEventListener('click', clearSearch);
    $('#empty-clear').addEventListener('click', clearSearch);
    $('#search-input').addEventListener('keydown', (event) => { if (event.key === 'Escape') clearSearch(); });
    $('#song-form').addEventListener('submit', saveSong);
    $('#song-list').addEventListener('click', handleListAction);
    $('#transpose-down').addEventListener('click', () => { $('#transpose-value').value = Number($('#transpose-value').value || 0) - 1; updateTransposeOutput(); });
    $('#transpose-up').addEventListener('click', () => { $('#transpose-value').value = Number($('#transpose-value').value || 0) + 1; updateTransposeOutput(); });
    $('#song-key').addEventListener('change', updatePreview);
    $('#artist-name').addEventListener('input', () => { const reading = inferReadingFromName($('#artist-name').value); if (reading && !$('#artist-reading').value) $('#artist-reading').value = reading; });
    $('#song-title').addEventListener('input', () => { const reading = inferReadingFromName($('#song-title').value); if (reading && !$('#song-reading').value) $('#song-reading').value = reading; });
    $('#auth-button').addEventListener('click', () => { window.location.href = window.location.pathname; });
    $('#logout-button').addEventListener('click', signOut);
    $('#account-settings-button').addEventListener('click', () => {
      $('#password-form').reset();
      $('#password-error').classList.add('hidden');
      $('#password-message').classList.add('hidden');
      $('#delete-account-error').classList.add('hidden');
      $('#account-settings-dialog').showModal();
    });
    $('#edit-display-name-button').addEventListener('click', openProfileDialog);
    $('#profile-form').addEventListener('submit', saveProfile);
    $('#password-form').addEventListener('submit', changePassword);
    $('#delete-account-button').addEventListener('click', deleteAccount);
    $('#auth-form').addEventListener('submit', (event) => authSubmit(event));
    $('#auth-mode-toggle').addEventListener('click', () => setAuthMode(authMode === 'signup' ? 'login' : 'signup'));
    $('#export-button').addEventListener('click', exportCsv);
    $('#import-button').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', async (event) => {
      if (!canMutate()) return;
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        pendingImport = csvToSongs(await file.text());
        $('#import-summary').textContent = '「' + file.name + '」から ' + pendingImport.length + ' 曲を読み取ります。';
        $('#import-error').classList.add('hidden');
        $('#import-dialog').showModal();
      } catch (error) { announce(error.message || 'CSVを読み取れませんでした。'); event.target.value = ''; }
    });
    $('#import-form').addEventListener('submit', processImport);
    $('#share-button').addEventListener('click', handleShare);
    $('#search-input').addEventListener('input', () => { pageLimit = 100; render(); });
    $('#sort-mode').addEventListener('change', () => { pageLimit = 100; render(); });
    $('#show-hidden').addEventListener('change', render);
    document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $('#' + button.dataset.close).close()));
    document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus(); }
      if (event.key === 'Escape') document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    });
    applyUrlFilters();
    setAuthMode('signup');
    if (!sharedListMode || recoveryMode) await initializeAuth();
    await loadSongsForCurrentUser();
  }

  function sameSongs(a, b) {
    const normalize = (list) => list.map(Core.clean).sort((x, y) => x.id.localeCompare(y.id));
    return Core.equal(normalize(a), normalize(b));
  }
  function songIdentity(song) { return Core.identity(song.artist) + '\u0000' + Core.identity(song.title); }
  function orderedSongs(list) {
    const snapshot = publicSongSnapshot(list.map((song) => ({ ...song, visible: true })));
    const indexes = new Map(snapshot.map((song) => [song.id, song]));
    return list.map((song) => ({ ...song, artistSortIndex: indexes.get(song.id).artistSortIndex, titleSortIndex: indexes.get(song.id).titleSortIndex }));
  }
  function canMutate(notify = true) {
    const allowed = personalView() && loadState === 'ready' && !pendingDrafts.length && !conflictState;
    if (!allowed && notify) announce('読み込み・下書きの復元・変更の確認を完了してから編集してください。');
    return allowed;
  }
  function storeDraft(next) {
    drafts.write(user.id, draftId, { revision, baseSongs, songs: next, stamp });
    storageError = false;
  }
  function commitSongs(next) {
    if (!canMutate()) return false;
    stamp++;
    try { storeDraft(next); }
    catch (_) {
      storageError = true; updateDataUi();
      announce('この端末に変更を保持できないため、編集を止めました。保存済みデータをCSVに書き出し、ブラウザーの空き容量や保存設定を確認してください。');
      return false;
    }
    songs = next; dirty = true; render();
    return true;
  }
  function finishDraft(accountId) {
    try {
      drafts.remove(accountId, draftId);
      if (restoreSource) drafts.remove(accountId, restoreSource.draftId, restoreSource.stamp);
      restoreSource = null;
      pendingDrafts = drafts.list(accountId).filter((item) => item.draftId !== draftId);
    } catch (_) { storageError = true; }
  }
  function updateDataUi() {
    const personal = personalView();
    const panel = $('#data-status');
    let message = '';
    if (loadState === 'loading') message = 'リストを読み込んでいます。完了するまで編集できません。';
    else if (loadState === 'error') message = sharedListMode ? 'リストを読み込めません。通信状態を確認してください。リンクが停止・変更された場合も表示されません。' : '読み込みに失敗しました。既存データを守るため、編集を停止しています。';
    else if (conflictState) message = '別の端末と同じ項目を変更しました。残す内容を選んでください。未保存の変更は端末に保持しています。';
    else if (pendingDrafts.length) message = 'この端末に未保存の下書きがあります。復元するか、CSVで内容を確認できます。';
    else if (storageError) message = '端末への下書き保存を確認できません。ブラウザーの空き容量・保存設定を確認してください。';
    else if (dirty) message = saving ? '保存しています。変更はこの端末にも保持しています。' : '未保存の変更があります。この端末に保持中です。通信が戻ったら「再送」を押してください。';
    panel.classList.toggle('hidden', !message || (!personal && loadState !== 'error' && loadState !== 'loading'));
    $('#data-status-message').textContent = message;
    $('#reload-list').classList.toggle('hidden', loadState !== 'error');
    $('#retry-save').classList.toggle('hidden', !personal || !dirty || saving || Boolean(conflictState) || pendingDrafts.length > 0);
    $('#review-conflicts').classList.toggle('hidden', !conflictState);
    $('#draft-actions').classList.toggle('hidden', !personal || !pendingDrafts.length);
    const picker = $('#draft-select');
    const previous = picker.value;
    picker.innerHTML = pendingDrafts.map((draft) => '<option value="' + escapeHtml(draft.draftId) + '">' + escapeHtml(new Date(draft.updatedAt).toLocaleString('ja-JP')) + '・' + draft.songs.length + '曲</option>').join('');
    if (pendingDrafts.some((d) => d.draftId === previous)) picker.value = previous;
    document.querySelectorAll('#add-button,#empty-add,#import-button,#artist-manage-button,#save-song-button,[data-action]:not([data-action="chord-search"]):not([data-action="search-menu"])').forEach((el) => { el.disabled = !canMutate(false); });
    $('#export-button').disabled = loadState !== 'ready';
    $('#history-open-button').disabled = loadState !== 'ready';
    $('#history-save').disabled = !canMutate(false) || songs.length === 0;
    document.querySelectorAll('#history-records button').forEach((button) => { button.disabled = !canMutate(false); });
    $('#share-button').disabled = loadState !== 'ready' || dirty || saving || pendingDrafts.length > 0;
    $('#sharing-status').textContent = shareRecord?.enabled ? '共有中' : '共有停止中';
    if (personal && loadState === 'ready') setSyncState(conflictState ? '変更の確認が必要' : saving ? '保存中' : dirty ? '未保存の変更あり' : '保存済み', dirty || conflictState ? 'warn' : 'ok');
  }
  function selectedDraft() { return pendingDrafts.find((d) => d.draftId === $('#draft-select').value); }
  function downloadSongs(list, suffix = '') {
    const headers = ['ID','アーティスト名の読み仮名','アーティスト名','曲名の読み仮名','曲名','原曲キー','自分が歌うキー（移調）','最後に歌った日','備考','一覧に表示','追加データ(JSON)'];
    const rows = [headers, ...list.map((s) => [s.id,s.artistKana,s.artist,s.songKana,s.title,s.key,s.transpose,s.lastSung,s.notes,s.visible ? 'true' : 'false',JSON.stringify(s.extra || {})])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'songlist-' + localDate() + suffix + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function restoreDraft() {
    const draft = selectedDraft(); if (!draft || loadState !== 'ready') return;
    const merge = Core.mergeSongs(draft.baseSongs.map(normalizeSong), draft.songs.map(normalizeSong), baseSongs);
    restoreSource = draft; pendingDrafts = [];
    if (merge.conflicts.length) {
      conflictState = { merge, remote: baseSongs, revision }; showConflicts(); updateDataUi(); return;
    }
    stamp++;
    try { storeDraft(merge.songs); } catch (_) { pendingDrafts = [draft]; storageError = true; updateDataUi(); return; }
    songs = merge.songs.map(normalizeSong); dirty = !sameSongs(songs, baseSongs);
    if (!dirty) finishDraft(user.id);
    render(); if (dirty) await persistSongs();
  }
  const fieldNames = { artist:'アーティスト名', artistKana:'アーティストの読み', title:'曲名', songKana:'曲名の読み', key:'原曲キー', transpose:'移調', lastSung:'最後に歌った日', notes:'備考', visible:'閲覧用への表示', extra:'歌唱履歴・キー設定など', $song:'曲の追加・削除' };
  function conflictValue(value) {
    if (value === undefined) return '削除';
    if (typeof value === 'boolean') return value ? '表示' : '非表示';
    if (value?.practice) return '歌唱記録 ' + (value.practice.history?.length || 0) + '件／キー設定：' + (value.practice.presets || []).map((p) => p.name + ' (' + signed(p.transpose) + ')').join('、');
    if (value && typeof value === 'object') return value.title ? value.artist + ' / ' + value.title : JSON.stringify(value);
    return String(value || '未設定');
  }
  function showConflicts() {
    if (!conflictState) return;
    $('#conflict-items').innerHTML = conflictState.merge.conflicts.map((c, i) => '<fieldset class="conflict-item"><legend>' + escapeHtml(c.label + '：' + fieldNames[c.field]) + '</legend><label><input type="radio" name="conflict-' + i + '" value="remote" checked><span>他の端末：' + escapeHtml(conflictValue(c.remote)) + '</span></label><label><input type="radio" name="conflict-' + i + '" value="local"><span>この端末：' + escapeHtml(conflictValue(c.local)) + '</span></label></fieldset>').join('');
    if (!$('#conflict-dialog').open) $('#conflict-dialog').showModal();
  }
  async function resolveConflicts(event) {
    event.preventDefault(); if (!conflictState) return;
    const current = conflictState;
    const choices = current.merge.conflicts.map((_, i) => document.querySelector('input[name="conflict-' + i + '"]:checked').value);
    const next = Core.resolveMerge(current.merge, choices).map(normalizeSong);
    const oldBase = baseSongs, oldRevision = revision;
    baseSongs = current.remote; revision = current.revision; stamp++;
    try { storeDraft(next); } catch (_) { baseSongs = oldBase; revision = oldRevision; storageError = true; updateDataUi(); return; }
    songs = next; dirty = !sameSongs(songs, baseSongs); conflictState = null;
    $('#conflict-dialog').close();
    if (!dirty) finishDraft(user.id);
    render(); if (dirty) await persistSongs();
  }
  function updateArtistOptions() {
    const readings = new Map();
    for (const song of songs) {
      if ((personalView() || song.visible) && !readings.has(song.artist)) readings.set(song.artist,song.artistKana || song.artist);
    }
    const artists = [...readings.keys()].sort((a,b) => collator.compare(readings.get(a),readings.get(b)));
    const select = $('#artist-filter'), selected = select.value;
    const markup = '<option value="">全アーティスト</option>' + artists.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>').join('');
    if (select.innerHTML !== markup) { select.innerHTML = markup; if (artists.includes(selected)) select.value = selected; }
  }
  function fillArtistPicker() {
    const artists = [...new Map(songs.map((s) => [s.artist, s])).values()].sort((a,b) => collator.compare(a.artistKana || a.artist,b.artistKana || b.artist));
    $('#artist-options').innerHTML = artists.map((s) => '<option value="' + escapeHtml(s.artist) + '">' + escapeHtml(s.artistKana) + '</option>').join('');
  }
  function chooseArtist() {
    const song = songs.find((s) => Core.identity(s.artist) === Core.identity($('#artist-picker').value));
    if (!song) return;
    $('#artist-name').value = song.artist; $('#artist-reading').value = song.artistKana;
    $('#artist-context').textContent = '「' + song.artist + '」の名前・読み仮名を入力しました。';
    $('#artist-context').classList.remove('hidden');
  }
  function openArtistManager() {
    if (!canMutate()) return;
    const names = [...new Set(songs.map((song) => song.artist))].sort(collator.compare);
    $('#artist-source').innerHTML = names.map((name) => '<option>' + escapeHtml(name) + '</option>').join('');
    populateArtistManager(); $('#artist-manage-dialog').showModal();
  }
  function populateArtistManager() {
    const matching = songs.filter((s) => s.artist === $('#artist-source').value);
    $('#artist-new-name').value = matching[0]?.artist || '';
    $('#artist-new-reading').value = matching[0]?.artistKana || '';
    $('#artist-bulk-count').textContent = matching.length + '曲をまとめて更新します。';
    $('#artist-bulk-error').classList.add('hidden');
  }
  async function saveArtistManager(event) {
    event.preventDefault(); if (!canMutate()) return;
    const source = $('#artist-source').value, artist = $('#artist-new-name').value.trim(), kana = normalizeReading($('#artist-new-reading').value);
    if (!artist || !kana) return;
    const next = songs.map((s) => s.artist === source ? { ...s, artist, artistKana: kana } : s);
    const identities = next.map(songIdentity);
    if (new Set(identities).size < identities.length && next.some((s,i) => s.artist === artist && identities.indexOf(identities[i]) !== i)) return showError($('#artist-bulk-error'), '更新すると同じアーティスト・曲名が重複します。先に該当曲を整理してください。');
    if (!window.confirm('「' + source + '」の' + songs.filter((s) => s.artist === source).length + '曲を更新しますか？')) return;
    if (commitSongs(next)) { $('#artist-manage-dialog').close(); await persistSongs(); }
  }
  function songCard(song) {
    const key = sungKey(song), relative = parallelKey(key);
    const personal = personalView();
    const button = (action, label, delta = '') => '<button type="button" class="button button-outline" data-action="' + action + '" data-id="' + escapeHtml(song.id) + '"' + (delta ? ' data-delta="' + delta + '"' : '') + '>' + label + '</button>';
    const fullKey = '<span class="key-chip">(' + signed(song.transpose) + ')</span> <span>' + escapeHtml(song.key || '未設定') + '</span> → <span class="key-chip">' + escapeHtml(key || '—') + '</span> / <span class="parallel-chip">' + escapeHtml(relative || '—') + '</span>';
    return '<details class="song-card' + (!song.visible ? ' is-hidden-song' : '') + '" data-song-id="' + escapeHtml(song.id) + '" data-kana-group="' + kanaGroup(song) + '"><summary><span class="card-title">' + escapeHtml(song.title) + '</span><span class="card-artist">' + escapeHtml(song.artist) + (!song.visible ? '・非表示' : '') + '</span><span class="card-key">' + fullKey + '</span><span class="card-chevron" aria-hidden="true">⌄</span></summary><div class="card-details">' +
      (personal ? presetSwitcher(song) + '<p class="card-reading">読み：' + escapeHtml(song.artistKana + ' / ' + song.songKana) + '</p><div class="card-transpose">' + button('transpose','− 半音下げる','-1') + button('transpose','＋ 半音上げる','1') + '</div>' : '') +
      '<p>最後に歌った日：' + escapeHtml(formatDate(song.lastSung)) + (personal ? ' ／ 記録 ' + Practice.get(song).history.length + '回' : '') + '</p>' +
      (personal ? '<p class="card-notes">備考：' + escapeHtml(song.notes || '未入力') + '</p>' : '') +
      '<div class="card-search-actions">' + searchLinks(song) + '</div><div class="card-actions">' + (personal ? button('sung','今日歌った') + button('history','歌唱履歴') + button('edit','編集') + button('add-artist','同じ歌手の曲を追加') + button('toggle-visible',song.visible ? '閲覧用から非表示' : '閲覧用に表示') + button('delete','削除') : '') + '</div></div></details>';
  }
  function updateShareDialog() {
    $('#share-state').textContent = shareRecord?.enabled ? '共有中' : '共有停止中';
    $('#share-description').textContent = '「表示する」が有効な ' + songs.filter((s) => s.visible).length + ' 曲と表示名を共有します。備考・非表示曲は共有しません。リンクを知る人はログインせずに閲覧・検索できます。';
    $('#share-enable').textContent = shareRecord?.enabled ? '表示名を保存してURLをコピー' : '共有を開始してURLをコピー';
    $('#share-stop').disabled = !shareRecord?.enabled;
    $('#share-rotate').disabled = !shareRecord;
    $('#share-url').value = shareRecord ? viewerUrl(shareRecord.share_id) : '';
  }
  function viewerUrl(id) {
    const url = new URL(window.location.pathname, window.location.origin);
    url.searchParams.set('list', id); url.searchParams.set('sort', $('#sort-mode').value); return url.toString();
  }
  async function manageShare(action) {
    if (!personalView() || loadState !== 'ready' || dirty || saving) return;
    const name = $('#share-name').value.trim();
    if (action !== 'stop' && !name) return showError($('#share-error'), '共有する表示名を入力してください。');
    if (action === 'rotate' && !window.confirm('閲覧用URLを作り直します。以前のURLは使えなくなります。続けますか？')) return;
    $('#share-error').classList.add('hidden');
    $('#share-dialog').querySelectorAll('button[data-share-action]').forEach((el) => { el.disabled = true; });
    try {
      const { data, error } = await supabase.rpc('manage_my_song_share', { p_action: action, p_display_name: name || null });
      if (error) throw error;
      shareRecord = data; updateShareDialog(); updateDataUi();
      if (action === 'enable' || action === 'rotate') {
        try { await navigator.clipboard.writeText(viewerUrl(data.share_id)); announce('閲覧用URLをコピーしました。'); }
        catch (_) { $('#share-url').focus(); $('#share-url').select(); announce('URL欄を選択しました。コピーしてお使いください。'); }
      } else announce('閲覧用リンクを停止しました。');
    } catch (_) { showError($('#share-error'), '共有設定を保存できませんでした。現在の状態を変えずに、時間をおいて再度お試しください。'); }
    finally { $('#share-enable').disabled = false; updateShareDialog(); }
  }
  function authErrorMessage(error) {
    const text = String(error?.message || '').toLowerCase();
    if (text.includes('invalid login')) return 'メールアドレスまたはパスワードが正しくありません。';
    if (text.includes('email not confirmed')) return 'メールの確認が完了していません。「確認メールを再送」をお試しください。';
    if (text.includes('rate') || error?.status === 429) return '送信が集中しています。しばらく待ってから再度お試しください。';
    if (text.includes('already registered')) return '登録済みの可能性があります。ログインまたはパスワードの再設定をお試しください。';
    return '手続きを完了できませんでした。入力内容を確認し、時間をおいて再度お試しください。';
  }
  async function sendAccountMail(kind) {
    const email = $('#auth-email').value.trim();
    if (!$('#auth-email').reportValidity() || !email || !supabase || authBusy) return;
    if (Date.now() < mailCooldown) return showError($('#auth-error'), '再送信まで1分ほどお待ちください。');
    authBusy = true; $('#auth-error').classList.add('hidden');
    $('#password-reset-button').disabled = true; $('#resend-confirmation-button').disabled = true;
    try {
      const redirect = new URL(window.location.pathname, window.location.origin).toString();
      const { error } = kind === 'reset' ? await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirect }) : await supabase.auth.resend({ type:'signup',email,options:{emailRedirectTo:redirect} });
      if (error) throw error;
      mailCooldown = Date.now() + 60000;
      $('#auth-message').textContent = kind === 'reset' ? '該当するアカウントがある場合、パスワード再設定メールが届きます。メールのリンクを開いて新しいパスワードを設定してください。' : '確認メールの再送を受け付けました。受信箱と迷惑メールをご確認ください。';
      $('#auth-message').classList.remove('hidden');
    } catch (error) { showError($('#auth-error'), authErrorMessage(error)); }
    finally { authBusy = false; $('#password-reset-button').disabled = false; $('#resend-confirmation-button').disabled = false; }
  }
  async function saveRecoveryPassword(event) {
    event.preventDefault();
    if (!user || !supabase) return showError($('#recovery-error'), 'リンクの期限が切れている可能性があります。ログイン画面から再設定メールを送り直してください。');
    const password = $('#recovery-password').value;
    if (password !== $('#recovery-confirm').value) return showError($('#recovery-error'), '確認用パスワードが一致しません。');
    $('#recovery-submit').disabled = true;
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      $('#recovery-form').reset(); recoveryMode = false;
      history.replaceState(null, '', window.location.pathname);
      updateAccessUi(); await loadSongsForCurrentUser(); announce('パスワードを再設定しました。');
    } catch (error) { showError($('#recovery-error'), authErrorMessage(error)); }
    finally { $('#recovery-submit').disabled = false; }
  }
  function setupUpgradeEvents() {
    $('#reload-list').addEventListener('click', loadSongsForCurrentUser);
    $('#retry-save').addEventListener('click', persistSongs);
    $('#review-conflicts').addEventListener('click', showConflicts);
    $('#restore-draft').addEventListener('click', restoreDraft);
    $('#download-draft').addEventListener('click', () => { const d = selectedDraft(); if (d) downloadSongs(d.songs,'-未保存'); });
    $('#discard-draft').addEventListener('click', () => {
      const d = selectedDraft();
      if (!d || !window.confirm('選択した端末内の下書きを削除し、サーバーの保存済みデータを使いますか？必要なら先に下書きCSVを書き出してください。')) return;
      try { drafts.remove(user.id,d.draftId,d.stamp); pendingDrafts = drafts.list(user.id).filter((d) => d.draftId !== draftId); }
      catch (_) { storageError = true; }
      render();
    });
    $('#conflict-form').addEventListener('submit', resolveConflicts);
    $('#mobile-song-list').addEventListener('click', handleListAction);
    $('#artist-filter').addEventListener('change', () => { pageLimit = 100; render(); });
    $('#load-more').addEventListener('click', () => { pageLimit += 100; render(); });
    $('#artist-picker').addEventListener('input', chooseArtist);
    $('#duplicate-edit').addEventListener('click', () => openSongDialog(songs.find((s) => s.id === $('#duplicate-edit').dataset.id)));
    $('#artist-manage-button').addEventListener('click', openArtistManager);
    $('#artist-source').addEventListener('change', populateArtistManager);
    $('#artist-bulk-form').addEventListener('submit', saveArtistManager);
    $('#share-enable').addEventListener('click', () => manageShare('enable'));
    $('#share-stop').addEventListener('click', () => manageShare('stop'));
    $('#share-rotate').addEventListener('click', () => manageShare('rotate'));
    $('#password-reset-button').addEventListener('click', () => sendAccountMail('reset'));
    $('#resend-confirmation-button').addEventListener('click', () => sendAccountMail('signup'));
    $('#recovery-form').addEventListener('submit', saveRecoveryPassword);
    $('#recovery-back').addEventListener('click', () => { recoveryMode = false; history.replaceState(null,'',window.location.pathname); updateAccessUi(); });
    window.addEventListener('beforeunload', (event) => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('online', () => { if (dirty && !conflictState) void persistSongs(); });
  }

  function dateBefore(days) {
    const date = new Date(); date.setDate(date.getDate() - days);
    return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
  }
  function searchDestinations(song) {
    const query = song.artist + ' ' + song.title;
    return [
      { label:'Chordwiki', href:'https://www.google.com/search?q=' + encodeURIComponent(query + ' Chordwiki') },
      { label:'YouTube', href:'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) },
      { label:'コード譜', href:'https://www.google.com/search?q=' + encodeURIComponent(query + ' コード譜') }
    ];
  }
  function searchLinks(song) {
    return searchDestinations(song).map((item) => '<a class="button button-outline" href="' + escapeHtml(item.href) + '" target="_blank" rel="noopener noreferrer" aria-label="' + escapeHtml(song.artist + ' ' + song.title + 'を' + item.label + 'で検索（新しいタブ）') + '">' + item.label + ' ↗</a>').join('');
  }
  function openSearchMenu(song) {
    $('#search-song-name').textContent = song.artist + ' / ' + song.title;
    $('#search-destinations').innerHTML = searchLinks(song);
    $('#search-dialog').showModal();
  }
  function presetSwitcher(song) {
    const practice = Practice.get(song);
    return '<div class="preset-switcher"><select data-action="select-preset" data-id="' + escapeHtml(song.id) + '" aria-label="' + escapeHtml(song.title) + 'のキー設定">' + practice.presets.map((p) => '<option value="' + escapeHtml(p.id) + '"' + (p.id === practice.activePresetId ? ' selected' : '') + '>' + escapeHtml(p.name + ' (' + signed(p.transpose) + ')') + '</option>').join('') + '</select><button type="button" data-action="key-settings" data-id="' + escapeHtml(song.id) + '" title="キー設定を追加・編集" aria-label="' + escapeHtml(song.title) + 'のキー設定を編集">設定</button></div>';
  }
  function refreshPresetChoices() {
    if (!editorPractice) return;
    $('#preset-choice').innerHTML = editorPractice.presets.map((p) => '<option value="' + escapeHtml(p.id) + '"' + (p.id === editorPractice.activePresetId ? ' selected' : '') + '>' + escapeHtml(p.name + ' (' + signed(p.transpose) + ')') + '</option>').join('');
  }
  function renderPresetEditor() {
    refreshPresetChoices();
    $('#preset-rows').innerHTML = editorPractice.presets.map((p) => '<div class="preset-editor-row"><label><span class="sr-only">キー設定名</span><input data-preset-id="' + escapeHtml(p.id) + '" data-preset-field="name" value="' + escapeHtml(p.name) + '" required maxlength="40" placeholder="通常・低め・弾き語り用"></label><label><span class="sr-only">原曲からの移調</span><input type="number" min="-24" max="24" step="1" required data-preset-id="' + escapeHtml(p.id) + '" data-preset-field="transpose" value="' + p.transpose + '"></label><button type="button" class="button button-outline" data-remove-preset="' + escapeHtml(p.id) + '"' + (editorPractice.presets.length === 1 ? ' disabled' : '') + '>削除</button></div>').join('');
  }
  function validateEditorPresets() {
    const presets = editorPractice?.presets || [];
    if (!presets.length || presets.some((p) => !p.name.trim() || p.name.length > 40 || !Number.isInteger(Number(p.transpose)) || Number(p.transpose) < -24 || Number(p.transpose) > 24)) {
      showError($('#form-error'),'キー設定名と、−24〜＋24の整数で移調を入力してください。'); return false;
    }
    if (new Set(presets.map((p) => Core.identity(p.name))).size !== presets.length) {
      showError($('#form-error'),'キー設定名が重複しています。区別できる名前を付けてください。'); return false;
    }
    return true;
  }
  async function switchListPreset(event) {
    const select = event.target.closest('select[data-action="select-preset"]');
    if (!select || !canMutate()) return;
    const song = songs.find((s) => s.id === select.dataset.id); if (!song) return;
    const next = Practice.setPreset(song,select.value);
    if (commitSongs(songs.map((s) => s.id === song.id ? next : s))) await persistSongs();
  }
  async function recordToday(song) {
    const today = localDate(), previous = Practice.get(song).history;
    if (previous.some((r) => r.date === today) && !window.confirm('今日の記録があります。もう1回歌った記録を追加しますか？')) return;
    const updated = Practice.addRecord(song,today,crypto.randomUUID());
    if (!commitSongs(songs.map((s) => s.id === song.id ? updated : s))) return;
    if (await persistSongs()) announce('今日の歌唱を記録しました（記録 ' + Practice.get(updated).history.length + '回）。');
  }
  function historyOptions(selected='') {
    return sortSongs(songs.slice(),'artist').map((song) => '<option value="' + escapeHtml(song.id) + '"' + (song.id === selected ? ' selected' : '') + '>' + escapeHtml(song.artist + ' / ' + song.title) + '</option>').join('');
  }
  function openHistory(songId='') {
    if (!personalView() || loadState !== 'ready') return;
    $('#history-song-filter').innerHTML = '<option value="">すべての曲</option>' + historyOptions(songId);
    $('#history-month').value = '';
    $('#history-add-song').innerHTML = historyOptions(songId || songs[0]?.id);
    historyLimit = 100; resetHistoryForm(); renderHistory();
    if (!$('#history-dialog').open) $('#history-dialog').showModal();
  }
  function fillHistoryPreset(record=null) {
    const song = songs.find((s) => s.id === $('#history-add-song').value);
    if (!song) { $('#history-add-preset').innerHTML = ''; return; }
    const practice = Practice.get(song);
    $('#history-add-preset').innerHTML = (record ? '<option value="$keep" selected>記録済みのキーを保持</option>' : '') + practice.presets.map((p) => '<option value="' + escapeHtml(p.id) + '"' + (!record && p.id === practice.activePresetId ? ' selected' : '') + '>' + escapeHtml(p.name + ' (' + signed(p.transpose) + ') / ' + (sungKey({key:song.key,transpose:p.transpose}) || 'キー未設定')) + '</option>').join('');
  }
  function resetHistoryForm() {
    historyEditing = null;
    $('#history-add-song').disabled = false;
    $('#history-add-date').value = localDate(); $('#history-add-date').max = localDate();
    $('#history-save').textContent = '1回として記録';
    $('#history-edit-cancel').classList.add('hidden');
    $('#history-error').classList.add('hidden');
    fillHistoryPreset();
  }
  function renderHistory() {
    const songId = $('#history-song-filter').value, month = $('#history-month').value;
    const records = songs.flatMap((song) => Practice.get(song).history.map((record) => ({song,record}))).filter(({song,record}) => (!songId || song.id === songId) && (!month || record.date.startsWith(month))).sort((a,b) => b.record.date.localeCompare(a.record.date) || collator.compare(a.song.artist,b.song.artist) || collator.compare(a.song.title,b.song.title) || a.record.id.localeCompare(b.record.id));
    $('#history-summary').textContent = records.length + '回の記録・' + new Set(records.map((r) => r.record.date)).size + '日・' + new Set(records.map((r) => r.song.id)).size + '曲';
    $('#history-legacy-note').classList.toggle('hidden', !records.some(({record}) => record.legacy));
    $('#history-records').innerHTML = records.length ? records.slice(0,historyLimit).map(({song,record}) => {
      const key = record.legacy || record.transpose == null ? '歌唱キーは未記録' : (record.presetName ? record.presetName + ' ' : '') + '(' + signed(record.transpose) + ') ' + (sungKey({key:record.key,transpose:record.transpose}) || 'キー未設定');
      return '<li class="history-record"><div><time datetime="' + escapeHtml(record.date) + '">' + escapeHtml(formatDate(record.date)) + '</time><strong>' + escapeHtml(song.title) + '</strong><span>' + escapeHtml(song.artist) + '</span><small>' + escapeHtml(key) + (record.legacy ? '・以前の最終歌唱日' : '') + '</small></div><div class="history-record-actions"><button class="button button-outline" type="button" data-history-action="edit" data-song-id="' + escapeHtml(song.id) + '" data-record-id="' + escapeHtml(record.id) + '">修正</button><button class="button button-outline" type="button" data-history-action="delete" data-song-id="' + escapeHtml(song.id) + '" data-record-id="' + escapeHtml(record.id) + '">削除</button></div></li>';
    }).join('') : '<li class="history-empty">該当する歌唱記録がありません。</li>';
    $('#history-more').classList.toggle('hidden',records.length <= historyLimit);
    $('#history-more').textContent = 'さらに表示（残り ' + Math.max(0,records.length-historyLimit) + '件）';
    document.querySelectorAll('#history-records button').forEach((b) => { b.disabled = !canMutate(false); });
    $('#history-save').disabled = !canMutate(false) || songs.length === 0;
  }
  async function saveHistoryRecord(event) {
    event.preventDefault(); if (!canMutate()) return;
    const song = songs.find((s) => s.id === $('#history-add-song').value), date = $('#history-add-date').value;
    if (!song) return showError($('#history-error'),'曲を選んでください。');
    if (!Practice.validDate(date) || date > localDate()) return showError($('#history-error'),'今日までの有効な日付を入力してください。');
    let updated;
    if (historyEditing) {
      const practice = Practice.get(song), old = practice.history.find((r) => r.id === historyEditing.recordId);
      if (!old || song.id !== historyEditing.songId) return showError($('#history-error'),'この記録は変更されています。一覧から開き直してください。');
      const presetId = $('#history-add-preset').value;
      const preset = practice.presets.find((p) => p.id === presetId);
      if (presetId !== '$keep' && !preset) return showError($('#history-error'),'キー設定が変更されています。記録を開き直してください。');
      const replacement = presetId === '$keep' ? { ...old,date } : { id:old.id,date,key:song.key,transpose:preset.transpose,presetName:preset.name };
      practice.history = practice.history.map((r) => r.id === old.id ? replacement : r);
      updated = Practice.put(song,practice);
    } else updated = Practice.addRecord(song,date,crypto.randomUUID(),$('#history-add-preset').value);
    if (!commitSongs(songs.map((s) => s.id === song.id ? updated : s))) return;
    resetHistoryForm(); renderHistory();
    if (await persistSongs()) announce('歌唱履歴を保存しました。');
  }
  async function historyRecordAction(event) {
    const button = event.target.closest('[data-history-action]'); if (!button || !canMutate()) return;
    const song = songs.find((s) => s.id === button.dataset.songId); if (!song) return;
    const practice = Practice.get(song), record = practice.history.find((r) => r.id === button.dataset.recordId); if (!record) return;
    if (button.dataset.historyAction === 'edit') {
      historyEditing = { songId:song.id,recordId:record.id };
      $('#history-add-song').value = song.id; $('#history-add-song').disabled = true;
      $('#history-add-date').value = record.date; fillHistoryPreset(record);
      $('#history-save').textContent = '記録を更新'; $('#history-edit-cancel').classList.remove('hidden');
      $('#history-add-date').focus(); return;
    }
    if (!window.confirm(formatDate(record.date) + '「' + song.title + '」の記録を削除しますか？')) return;
    practice.history = practice.history.filter((r) => r.id !== record.id);
    const updated = Practice.put(song,practice);
    if (commitSongs(songs.map((s) => s.id === song.id ? updated : s))) {
      if (historyEditing?.recordId === record.id) resetHistoryForm();
      renderHistory(); await persistSongs();
    }
  }
  function setupPracticeEvents() {
    $('#history-open-button').addEventListener('click',() => openHistory());
    $('#history-song-filter').addEventListener('change',() => { historyLimit=100; renderHistory(); });
    $('#history-month').addEventListener('change',() => { historyLimit=100; renderHistory(); });
    $('#history-clear-month').addEventListener('click',() => { $('#history-month').value=''; historyLimit=100; renderHistory(); });
    $('#history-more').addEventListener('click',() => { historyLimit+=100; renderHistory(); });
    $('#history-form').addEventListener('submit',saveHistoryRecord);
    $('#history-add-song').addEventListener('change',() => fillHistoryPreset());
    $('#history-edit-cancel').addEventListener('click',resetHistoryForm);
    $('#history-records').addEventListener('click',historyRecordAction);
    $('#practice-filter').addEventListener('change',() => { pageLimit=100; render(); });
    $('#song-list').addEventListener('change',switchListPreset);
    $('#mobile-song-list').addEventListener('change',switchListPreset);
    $('#preset-rows').addEventListener('invalid',() => { $('#preset-editor').open = true; },true);
    $('#preset-choice').addEventListener('change',() => {
      editorPractice.activePresetId = $('#preset-choice').value;
      $('#transpose-value').value = editorPractice.presets.find((p) => p.id === editorPractice.activePresetId).transpose;
      updateTransposeOutput();
    });
    $('#preset-rows').addEventListener('input',(event) => {
      const input=event.target.closest('[data-preset-field]'); if (!input) return;
      const preset=editorPractice.presets.find((p) => p.id===input.dataset.presetId);
      if (input.dataset.presetField==='name') preset.name=input.value;
      else preset.transpose=input.value === '' ? NaN : Number(input.value);
      refreshPresetChoices();
      if (preset.id===editorPractice.activePresetId && input.dataset.presetField==='transpose' && Number.isFinite(preset.transpose)) {
        $('#transpose-value').value=preset.transpose; $('#transpose-output').textContent=signed(preset.transpose); updatePreview();
      }
    });
    $('#preset-rows').addEventListener('click',(event) => {
      const button=event.target.closest('[data-remove-preset]'); if (!button || editorPractice.presets.length<=1) return;
      editorPractice.presets=editorPractice.presets.filter((p) => p.id!==button.dataset.removePreset);
      if (!editorPractice.presets.some((p) => p.id===editorPractice.activePresetId)) editorPractice.activePresetId=editorPractice.presets[0].id;
      $('#transpose-value').value=editorPractice.presets.find((p) => p.id===editorPractice.activePresetId).transpose;
      renderPresetEditor(); updateTransposeOutput();
    });
    $('#preset-add').addEventListener('click',() => {
      if (editorPractice.presets.length>=20) return announce('キー設定は1曲につき20件まで保存できます。');
      let number=2; while(editorPractice.presets.some((p) => p.name==='設定'+number)) number++;
      const preset={id:crypto.randomUUID(),name:'設定'+number,transpose:Number($('#transpose-value').value)};
      editorPractice.presets.push(preset); editorPractice.activePresetId=preset.id;
      renderPresetEditor(); updateTransposeOutput();
      [...$('#preset-rows').querySelectorAll('input[data-preset-field="name"]')].at(-1).focus();
    });
  }

  const kanaSections = [
    ['あ','あいうえおぁぃぅぇぉ'],['か','かきくけこゕゖ'],['さ','さしすせそ'],
    ['た','たちつてとっ'],['な','なにぬねの'],['は','はひふへほ'],
    ['ま','まみむめも'],['や','やゆよゃゅょ'],['ら','らりるれろ'],['わ','わをんゎゐゑ'],['他','']
  ];
  const kanaNavigation = { targets:new Map(), enabled:false, dragging:false, pointerId:null, pointGroup:'', jumpedGroup:'', suppressedUntil:0, frame:0, feedbackTimer:0 };
  function kanaGroup(song) {
    const titleOrder = $('#sort-mode').value === 'title';
    const reading = titleOrder ? song.songKana || song.title : song.artistKana || song.artist;
    const first = normalizeReading(reading).normalize('NFD').replace(/[\u3099\u309a]/gu,'').replace(/^[\s\p{P}\p{S}ー]+/u,'').charAt(0);
    return kanaSections.find(([,characters]) => characters.includes(first) && first)?.[0] || '他';
  }
  function kanaLabel(group) { return group === '他' ? '英数字・その他' : group + '行'; }
  function setKanaCurrent(group) {
    $('#kana-index').querySelectorAll('button').forEach((button) => {
      if (button.dataset.kana === group) button.setAttribute('aria-current','location');
      else button.removeAttribute('aria-current');
    });
  }
  function updateKanaIndex(list) {
    const nav = $('#kana-index');
    if (!nav) return;
    kanaNavigation.targets = new Map();
    if (mobileLayout.matches && $('#sort-mode').value !== 'recent') list.forEach((song,index) => {
      const group = kanaGroup(song);
      if (!kanaNavigation.targets.has(group)) kanaNavigation.targets.set(group,{id:song.id,index,song});
    });
    kanaNavigation.enabled = loadState === 'ready' && list.length > 0 && $('#sort-mode').value !== 'recent' && !recoveryMode && Boolean(user || sharedListMode) && mobileLayout.matches;
    const titleOrder = $('#sort-mode').value === 'title';
    nav.setAttribute('aria-label',(titleOrder ? '曲名' : 'アーティスト名') + 'の五十音インデックス');
    nav.querySelectorAll('button').forEach((button) => {
      const available = kanaNavigation.targets.has(button.dataset.kana);
      button.setAttribute('aria-disabled',String(!available));
      button.setAttribute('aria-label',kanaLabel(button.dataset.kana) + (available ? 'へ移動' : '：該当する曲なし'));
      button.tabIndex = available ? 0 : -1;
    });
    $('#mobile-song-list').classList.toggle('has-kana-index',kanaNavigation.enabled);
    $('#kana-index-help').classList.toggle('hidden',!kanaNavigation.enabled);
    if (!kanaNavigation.enabled) {
      finishKanaGesture(false);
      nav.classList.add('hidden');
      $('#kana-index-feedback').classList.add('hidden');
    }
    scheduleKanaLayout();
  }
  function scheduleKanaLayout() {
    if (kanaNavigation.frame) return;
    kanaNavigation.frame = window.requestAnimationFrame(() => { kanaNavigation.frame=0; positionKanaIndex(); });
  }
  function positionKanaIndex() {
    const nav = $('#kana-index');
    if (!kanaNavigation.enabled) return nav.classList.add('hidden');
    if (kanaNavigation.dragging) return; // Keep the rail under the finger during jumps.
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
    const controls = $('.library-controls').getBoundingClientRect();
    const list = $('#mobile-song-list').getBoundingClientRect();
    const top = Math.max(viewportTop + 12,controls.bottom + 8,list.top);
    const bottom = Math.min(viewportBottom - 16,list.bottom);
    const visible = bottom - top >= 220 && !document.querySelector('dialog[open]');
    nav.classList.toggle('hidden',!visible);
    if (!visible) return;
    const height = Math.min(330,bottom-top);
    nav.style.top = (top + (bottom-top-height)/2) + 'px';
    nav.style.height = height + 'px';
    // Only measure a logarithmic number of cards, including when many are expanded.
    const cards = $('#mobile-song-list').children;
    let low=0,high=cards.length-1;
    const edge = Math.max(viewportTop,controls.bottom) + 12;
    while (low<high) {
      const middle=Math.floor((low+high)/2);
      if (cards[middle].getBoundingClientRect().bottom<=edge) low=middle+1;
      else high=middle;
    }
    setKanaCurrent(cards[low]?.dataset.kanaGroup);
  }
  function showKanaFeedback(group) {
    window.clearTimeout(kanaNavigation.feedbackTimer);
    $('#kana-index-letter').textContent = group;
    $('#kana-index-caption').textContent = kanaNavigation.targets.has(group) ? kanaLabel(group) : '該当する曲なし';
    $('#kana-index-feedback').classList.remove('hidden');
    if (!kanaNavigation.dragging) kanaNavigation.feedbackTimer = window.setTimeout(() => $('#kana-index-feedback').classList.add('hidden'),650);
  }
  function jumpKana(group,spoken=false) {
    const target = kanaNavigation.targets.get(group);
    showKanaFeedback(group);
    if (!target) return;
    if (target.index >= pageLimit) {
      pageLimit = Math.ceil((target.index+1)/100)*100;
      render();
    }
    const card = [...$('#mobile-song-list').children].find((item) => item.dataset.songId === target.id);
    if (!card) return;
    const stickyHeight = $('.library-controls').offsetHeight;
    window.scrollTo({top:Math.max(0,window.scrollY+card.getBoundingClientRect().top-stickyHeight-8),behavior:'auto'});
    kanaNavigation.jumpedGroup = group;
    setKanaCurrent(group);
    if (spoken) $('#kana-index-status').textContent = kanaLabel(group) + '、' + target.song.artist + '、' + target.song.title + 'へ移動しました。';
    scheduleKanaLayout();
  }
  function moveKanaPointer(event) {
    const buttons = [...$('#kana-index').querySelectorAll('button')];
    const button = buttons.find((item) => event.clientY < item.getBoundingClientRect().bottom) || buttons.at(-1);
    const group = button.dataset.kana;
    if (group === kanaNavigation.pointGroup) return;
    kanaNavigation.pointGroup = group;
    jumpKana(group);
  }
  function finishKanaGesture(spoken=true) {
    if (!kanaNavigation.dragging) return;
    const nav = $('#kana-index');
    const pointerId = kanaNavigation.pointerId;
    kanaNavigation.dragging=false; kanaNavigation.pointerId=null;
    nav.classList.remove('is-dragging');
    if (pointerId != null && nav.hasPointerCapture(pointerId)) nav.releasePointerCapture(pointerId);
    kanaNavigation.suppressedUntil=Date.now()+450;
    const target=kanaNavigation.targets.get(kanaNavigation.jumpedGroup);
    if (spoken && target) $('#kana-index-status').textContent=kanaLabel(kanaNavigation.jumpedGroup)+'、'+target.song.artist+'、'+target.song.title+'へ移動しました。';
    kanaNavigation.feedbackTimer=window.setTimeout(() => $('#kana-index-feedback').classList.add('hidden'),450);
    scheduleKanaLayout();
  }
  function setupKanaIndex() {
    const nav=$('#kana-index');
    nav.innerHTML=kanaSections.map(([group]) => '<button type="button" data-kana="'+group+'" aria-controls="mobile-song-list">'+group+'</button>').join('');
    nav.addEventListener('pointerdown',(event) => {
      if (!kanaNavigation.enabled || !event.isPrimary || event.button!==0) return;
      event.preventDefault();
      kanaNavigation.dragging=true; kanaNavigation.pointerId=event.pointerId;
      kanaNavigation.pointGroup=''; kanaNavigation.jumpedGroup='';
      nav.setPointerCapture(event.pointerId); nav.classList.add('is-dragging');
      moveKanaPointer(event);
    });
    nav.addEventListener('pointermove',(event) => {
      if (!kanaNavigation.dragging || event.pointerId!==kanaNavigation.pointerId) return;
      event.preventDefault(); moveKanaPointer(event);
    });
    nav.addEventListener('pointerup',(event) => { if (event.pointerId===kanaNavigation.pointerId) finishKanaGesture(); });
    nav.addEventListener('pointercancel',() => finishKanaGesture(false));
    nav.addEventListener('lostpointercapture',() => finishKanaGesture(false));
    nav.addEventListener('click',(event) => {
      const button=event.target.closest('button[data-kana]');
      if (!button || !kanaNavigation.enabled || (event.detail!==0 && Date.now()<kanaNavigation.suppressedUntil) || button.getAttribute('aria-disabled')==='true') return;
      jumpKana(button.dataset.kana,true);
    });
    nav.addEventListener('keydown',(event) => {
      if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
      const buttons=[...nav.querySelectorAll('button[aria-disabled="false"]')];
      if (!buttons.length) return;
      event.preventDefault();
      const current=buttons.indexOf(document.activeElement);
      const next=event.key==='Home' ? 0 : event.key==='End' ? buttons.length-1 : Math.max(0,Math.min(buttons.length-1,current+(event.key==='ArrowDown' ? 1 : -1)));
      buttons[next].focus({preventScroll:true}); jumpKana(buttons[next].dataset.kana,true);
    });
    window.addEventListener('scroll',scheduleKanaLayout,{passive:true});
    window.addEventListener('resize',scheduleKanaLayout,{passive:true});
    mobileLayout.addEventListener('change',() => render());
    window.visualViewport?.addEventListener('resize',scheduleKanaLayout,{passive:true});
    window.visualViewport?.addEventListener('scroll',scheduleKanaLayout,{passive:true});
    $('#mobile-song-list').addEventListener('toggle',scheduleKanaLayout,true);
    // Native modal dialogs temporarily cover the list and its index.
    new MutationObserver(scheduleKanaLayout).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
  }

  start();
})();
