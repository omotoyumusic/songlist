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
  let writeChain = Promise.resolve();
  let loadGeneration = 0;
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
    return Array.from(String(value || '').trim(), (char) => {
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
    if (keys.includes(selected)) select.value = selected;
  }

  function keyInfo(key) {
    const match = String(key || '').trim().match(/^([A-G](?:#|b)?)(m?)$/i);
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
    return String(metadata.full_name || metadata.name || account.email?.split('@')[0] || 'ユーザー').trim();
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
    preview.innerHTML = '<span class="key-chip">' + escapeHtml(effective || '—') + '</span><span class="parallel-link">→</span><span class="parallel-chip">' + escapeHtml(relative || '—') + '</span>';
  }

  function updateTransposeOutput() {
    const value = Math.max(-24, Math.min(24, Number($('#transpose-value').value || 0)));
    $('#transpose-value').value = value;
    $('#transpose-output').textContent = signed(value);
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
    const query = $('#search-input').value.trim().toLocaleLowerCase('ja');
    const showHidden = personalView() && $('#show-hidden').checked;
    const list = songs.filter((song) => {
      if (!song.visible && !showHidden) return false;
      if (!query) return true;
      const searchable = [song.artist, song.artistKana, song.title, song.songKana, song.key, sungKey(song)];
      if (personalView()) searchable.push(song.notes);
      return searchable.some((value) => String(value || '').toLocaleLowerCase('ja').includes(query));
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
    const chordSearch = actionButton('chord-search', song.id, '', 'ChordwikiをGoogle検索', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M8 10.5h5M10.5 8v5"/></svg>');
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
      '<td><div class="key-cell">' + quickKey + '</div></td>' +
      searchCell +
      '<td><div class="cell-scroll date-scroll"><span class="date-cell ' + (song.lastSung ? 'date-recorded' : 'date-empty') + '">' + escapeHtml(formatDate(song.lastSung)) + '</span></div></td>' +
      notesCell + actionCell + '</tr>';
  }

  function render() {
    const list = filteredSongs();
    const canEdit = personalView();
    const countScope = canEdit ? songs : songs.filter((song) => song.visible);
    const artistCount = new Set(countScope.map((song) => song.artist)).size;
    $('#artist-count').textContent = artistCount.toLocaleString('ja-JP');
    $('#song-count').textContent = countScope.length.toLocaleString('ja-JP');
    const isFiltered = Boolean($('#search-input').value.trim());
    $('#result-count').textContent = isFiltered ? '検索結果 ' + list.length.toLocaleString('ja-JP') + ' 曲' : '全 ' + list.length.toLocaleString('ja-JP') + ' 曲';
    $('.sort-note').innerHTML = '<span class="sort-symbol">↕</span> ' + ({ artist: 'アーティスト五十音順', title: '曲名五十音順', recent: '最後に歌った日順' }[$('#sort-mode').value] || 'アーティスト五十音順');
    $('#empty-state').classList.toggle('hidden', list.length > 0);
    if (!list.length) {
      $('#song-list').innerHTML = '';
      return;
    }
    const actionHead = canEdit ? '<th scope="col">操作</th>' : '';
    const actionCol = canEdit ? '<col class="actions">' : '';
    const notesHead = canEdit ? '<th scope="col">備考</th>' : '';
    const notesCol = canEdit ? '<col class="notes">' : '';
    const listType = canEdit ? ' owner-list' : ' public-list';
    $('#song-list').innerHTML = '<table class="song-table' + listType + '"><colgroup><col class="artist"><col class="title"><col class="key"><col class="search"><col class="last">' + notesCol + actionCol + '</colgroup><thead><tr><th scope="col">アーティスト</th><th scope="col">曲名</th><th scope="col">（移調）原曲 → 歌うキー / 平行調</th><th class="search-heading" scope="col" title="Chordwikiで検索">検索</th><th scope="col">最後に歌った日</th>' + notesHead + actionHead + '</tr></thead><tbody>' + list.map(songRow).join('') + '</tbody></table>';
  }

  function updateAccessUi() {
    const canShowApp = Boolean(user || sharedListMode);
    $('#auth-gate').classList.toggle('hidden', canShowApp);
    $('#app-shell').classList.toggle('hidden', !canShowApp);
    document.querySelectorAll('.user-only').forEach((element) => element.classList.toggle('hidden', !personalView()));
    $('#auth-button').classList.toggle('hidden', !sharedListMode);
    $('#logout-button').classList.toggle('hidden', !personalView());
    $('#account-settings-button').classList.toggle('hidden', !personalView());
    $('#hidden-filter-wrap').classList.toggle('hidden', !personalView());
    $('.overview-share').classList.toggle('hidden', !personalView());
    updateListTitle();
    if (sharedListMode) setSyncState('閲覧用リスト', 'ok');
    else if (user) setSyncState('マイリストにログイン中', 'ok');
    render();
  }

  async function initializeAuth() {
    if (!config.supabaseUrl || !config.supabaseAnonKey) return;
    try {
      const module = await import('https://esm.sh/@supabase/supabase-js@2');
      supabase = module.createClient(config.supabaseUrl, config.supabaseAnonKey);
      const result = await supabase.auth.getSession();
      user = result.data.session ? result.data.session.user : null;
      supabase.auth.onAuthStateChange((_event, session) => {
        const nextUser = session ? session.user : null;
        if (sharedListMode) return;
        if ((user && user.id) === (nextUser && nextUser.id)) {
          if (nextUser) user = nextUser;
          return;
        }
        user = nextUser;
        updateAccessUi();
        void loadSongsForCurrentUser();
      });
      updateAccessUi();
    } catch (error) {
      console.error('Supabase initialization failed', error);
      setSyncState('認証に接続できません', 'warn');
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
    if (!shareId || !supabase) throw new Error('閲覧用URLが正しくありません。');
    setSyncState('閲覧用リストを読み込み中', 'warn');
    const { data: rows, error } = await supabase.rpc('get_public_song_list', { p_share_id: shareId });
    if (error) throw error;
    const data = Array.isArray(rows) ? rows[0] : rows;
    if (!data) throw new Error('この閲覧用リストは見つからないか、共有が停止されています。');
    sharedListRecord = data;
    songs = Array.isArray(data.songs) ? data.songs.map(normalizeSong) : [];
    setSyncState('閲覧用リスト', 'ok');
    updateAccessUi();
  }

  async function syncUserShare(list, createIfMissing, account = user) {
    if (!account || !supabase) throw new Error('ログインが必要です。');
    const { data: existing, error: lookupError } = await supabase.from('public_song_list_shares')
      .select('share_id').eq('user_id', account.id).maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing && !createIfMissing) return null;
    const shareId = existing?.share_id || crypto.randomUUID();
    const { data, error } = await supabase.from('public_song_list_shares').upsert({
      user_id: account.id,
      share_id: shareId,
      display_name: userDisplayName(account),
      songs: publicSongSnapshot(list)
    }, { onConflict: 'user_id' }).select('share_id').single();
    if (error) throw error;
    return data.share_id;
  }

  async function loadSongsForCurrentUser() {
    const generation = ++loadGeneration;
    const account = user;
    try {
      if (sharedListMode) {
        await loadSharedList();
      } else if (account && supabase) {
        setSyncState('個人リストを読み込み中', 'warn');
        let { data, error } = await supabase.from('song_lists').select('songs').eq('user_id', account.id).maybeSingle();
        if (error) throw error;
        if (generation !== loadGeneration) return;
        songs = Array.isArray(data?.songs) ? data.songs.map(normalizeSong) : [];
        setSyncState(data ? '自分のリストを読み込みました' : 'リストはまだ空です', 'ok');
        if (data && generation === loadGeneration && user?.id === account.id) {
          try { await syncUserShare(songs, false, account); }
          catch (shareError) { console.error('Existing viewer snapshot could not be refreshed', shareError); }
        }
      } else if (!sharedListMode) {
        songs = [];
        $('#auth-gate').classList.remove('hidden');
        $('#app-shell').classList.add('hidden');
        setSyncState('ログインしてください', '');
      }
    } catch (error) {
      console.error('Song list could not be loaded', error);
      if (generation !== loadGeneration) return;
      songs = [];
      const listName = sharedListMode ? '閲覧用リスト' : '個人リスト';
      setSyncState(listName + 'の読み込みに失敗しました', 'warn');
      announce(listName + 'を読み込めませんでした。時間をおいて再度お試しください。');
    }
    if (generation !== loadGeneration) return;
    $('#setup-notice').classList.toggle('hidden', Boolean(config.supabaseUrl && config.supabaseAnonKey));
    updateListTitle();
    render();
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

  async function persistSongs() {
    const snapshot = JSON.stringify(songs);
    const accountId = user && user.id;
    if (!accountId || !supabase) {
      announce('保存するにはログインしてください。');
      return Promise.reject(new Error('An authenticated account is required to save a song list.'));
    }
    writeChain = writeChain.catch(() => undefined).then(async () => {
      setSyncState('個人リストに保存しています', 'warn');
      const { error } = await supabase.from('song_lists').upsert({ user_id: accountId, songs: JSON.parse(snapshot) }, { onConflict: 'user_id' });
      if (error) throw error;
      try {
        await syncUserShare(JSON.parse(snapshot), false);
      } catch (shareError) {
        console.error('Shared view could not be updated', shareError);
        announce('リストは保存しましたが、閲覧用リンクの更新に失敗しました。');
      }
      setSyncState('自分のリストに保存しました', 'ok');
    }).catch((error) => {
      console.error('Song list could not be saved', error);
      setSyncState('Supabaseへの保存に失敗しました', 'warn');
      announce('保存に失敗しました。接続設定を確認して再度お試しください。');
      throw error;
    });
    return writeChain;
  }

  function openSongDialog(song, defaults = {}) {
    const editing = Boolean(song);
    $('#song-dialog-title').textContent = editing ? '曲を編集' : defaults.artist ? '同じアーティストに曲を追加' : '曲を追加';
    $('#song-id').value = editing ? song.id : '';
    $('#artist-reading').value = editing ? song.artistKana : defaults.artistKana || '';
    $('#song-reading').value = editing ? song.songKana : '';
    $('#artist-name').value = editing ? song.artist : defaults.artist || '';
    $('#song-title').value = editing ? song.title : '';
    fillKeySelect($('#song-key'), editing ? song.key : '');
    $('#transpose-value').value = editing ? song.transpose : 0;
    updateTransposeOutput();
    $('#last-sung').value = editing ? song.lastSung : '';
    $('#song-notes').value = editing ? song.notes : '';
    $('#song-visible').checked = editing ? song.visible : true;
    $('#form-error').classList.add('hidden');
    $('#song-dialog').showModal();
    if (defaults.artist && !editing) $('#song-reading').focus();
  }

  function showError(element, message) {
    element.textContent = message;
    element.classList.remove('hidden');
  }

  async function saveSong(event) {
    event.preventDefault();
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
    const song = normalizeSong({
      id: id || 'song-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      artistKana, artist, songKana: songKana || (previous && title === previous.title ? previous.songKana : ''), title,
      key: $('#song-key').value,
      transpose: $('#transpose-value').value,
      lastSung: $('#last-sung').value,
      notes: $('#song-notes').value.trim(),
      visible: $('#song-visible').checked,
      extra: previous ? previous.extra : {}
    });
    if (previous) songs = songs.map((item) => item.id === id ? song : item);
    else songs.push(song);
    render();
    $('#song-dialog').close();
    try {
      await persistSongs();
      announce(previous ? '曲の内容を更新しました。' : '曲を追加しました。');
    } catch (_) { /* The local backup is retained when remote saving fails. */ }
  }

  async function handleListAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const song = songs.find((item) => item.id === button.dataset.id);
    if (action === 'add-artist') {
      if (personalView() && song) openSongDialog(null, { artist: song.artist, artistKana: song.artistKana });
      return;
    }
    if (!song) return;
    if (action === 'edit') openSongDialog(song);
    if (action === 'chord-search') {
      const query = encodeURIComponent(song.artist + ' ' + song.title + ' Chordwiki');
      window.open('https://www.google.com/search?q=' + query, '_blank', 'noopener,noreferrer');
    }
    if (action === 'toggle-visible') {
      song.visible = !song.visible;
      render();
      try { await persistSongs(); announce(song.visible ? '一覧に表示しました。' : '一覧から非表示にしました。'); } catch (_) { /* Local backup remains available. */ }
    }
    if (action === 'delete') {
      if (!window.confirm('「' + song.artist + ' / ' + song.title + '」を削除しますか？')) return;
      songs = songs.filter((item) => item.id !== song.id);
      render();
      try { await persistSongs(); announce('曲を削除しました。'); } catch (_) { /* Local backup remains available. */ }
    }
    if (action === 'sung') {
      song.lastSung = localDate();
      render();
      try { await persistSongs(); announce('最後に歌った日を今日にしました。'); } catch (_) { /* Local backup remains available. */ }
    }
    if (action === 'transpose') {
      song.transpose = Math.max(-24, Math.min(24, Number(song.transpose || 0) + Number(button.dataset.delta)));
      render();
      try { await persistSongs(); } catch (_) { /* Local backup remains available. */ }
    }
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
      showError($('#auth-error'), 'Supabaseの接続設定がありません。READMEの初回設定を完了してください。');
      return;
    }
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!$('#auth-form').reportValidity()) return;
    const result = signUp
      ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: new URL(window.location.pathname, window.location.origin).toString() } })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) {
      showError($('#auth-error'), result.error.message);
      return;
    }
    if (signUp && !result.data.session) {
      $('#auth-message').textContent = '確認メールを送信しました。メール内のリンクを開いて登録を完了したあと、ここからログインしてください。届かない場合は迷惑メールとSupabaseのメール送信設定をご確認ください。';
      $('#auth-message').classList.remove('hidden');
      return;
    }
    user = result.data.user || (result.data.session && result.data.session.user);
    updateAccessUi();
    await loadSongsForCurrentUser();
    announce('ログインしました。自分専用のリストを表示しています。');
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
    try { await syncUserShare(songs, false); } catch (error) { console.error('Shared display name could not be updated', error); }
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
    const mode = new FormData($('#import-form')).get('import-mode');
    if (mode === 'replace') {
      if (!window.confirm('現在の' + songs.length + '曲を、CSVの' + pendingImport.length + '曲で置き換えますか？')) return;
      songs = pendingImport.map((song, index) => normalizeSong({ ...song, id: song.id || 'import-' + Date.now() + '-' + index }, index));
    } else {
      const merged = new Map(songs.map((song) => [(song.artist + '\u0000' + song.title).toLocaleLowerCase('ja'), song]));
      const claimedIds = new Set(songs.map((song) => song.id));
      pendingImport.forEach((incoming) => {
        const key = (incoming.artist + '\u0000' + incoming.title).toLocaleLowerCase('ja');
        const current = merged.get(key);
        let newId = current && current.id;
        if (!newId && incoming.id && !claimedIds.has(incoming.id)) newId = incoming.id;
        if (!newId) newId = 'import-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        claimedIds.add(newId);
        merged.set(key, normalizeSong({ ...current, ...incoming, id: newId }, merged.size));
      });
      songs = Array.from(merged.values());
    }
    $('#import-dialog').close();
    render();
    try { await persistSongs(); announce(pendingImport.length + '曲を取り込みました。'); }
    catch (_) { /* A local backup is retained. */ }
    $('#import-file').value = '';
  }

  async function handleShare() {
    if (!user) return announce('閲覧用リンクを作るにはログインしてください。');
    try {
      const shareId = await syncUserShare(songs, true);
      const url = new URL(window.location.href);
      url.search = '';
      url.searchParams.set('list', shareId);
      url.searchParams.set('sort', $('#sort-mode').value);
      try {
        await navigator.clipboard.writeText(url.toString());
        announce('あなたのソングリストの閲覧用URLをコピーしました。');
      } catch (_) {
        window.prompt('閲覧用URLをコピーしてください', url.toString());
      }
    } catch (error) {
      console.error('Personal share link could not be created', error);
      announce('閲覧用リンクを作成できませんでした。Supabaseの設定を確認してください。');
    }
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    user = null;
    songs = [];
    $('#show-hidden').checked = false;
    updateAccessUi();
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
    $('#search-input').addEventListener('input', render);
    $('#sort-mode').addEventListener('change', render);
    $('#show-hidden').addEventListener('change', render);
    document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $('#' + button.dataset.close).close()));
    document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus(); }
      if (event.key === 'Escape') document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    });
    applyUrlFilters();
    setAuthMode('signup');
    await initializeAuth();
    await loadSongsForCurrentUser();
  }

  start();
})();
