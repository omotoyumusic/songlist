(() => {
  const $ = (selector) => document.querySelector(selector);
  const config = window.SONGLIST_CONFIG || {};
  const hiragana = Array.from('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽゔ');
  const keys = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B', 'Cm', 'C#m', 'Dbm', 'Dm', 'D#m', 'Ebm', 'Em', 'Fm', 'F#m', 'Gbm', 'Gm', 'G#m', 'Abm', 'Am', 'A#m', 'Bbm', 'Bm'];
  const pitchByName = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
  const sharpNotes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const flatNotes = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  const storageKey = 'songlist-owner-draft-v1';
  let songs = [];
  let user = null;
  let supabase = null;
  let isOwner = false;
  let pendingImport = [];
  let toastTimer = 0;
  let writeChain = Promise.resolve();

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
    return number > 0 ? '+' + number : String(number);
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

  function sortSongs(list) {
    const mode = $('#sort-mode').value;
    return list.sort((left, right) => {
      if (mode === 'recent') return (right.lastSung || '').localeCompare(left.lastSung || '') || collator.compare(left.artist, right.artist) || collator.compare(left.title, right.title);
      if (mode === 'title') return collator.compare(left.songKana || left.title, right.songKana || right.title) || collator.compare(left.title, right.title) || collator.compare(left.artistKana || left.artist, right.artistKana || right.artist);
      return collator.compare(left.artistKana || left.artist, right.artistKana || right.artist) || collator.compare(left.artist, right.artist) || collator.compare(left.songKana || left.title, right.songKana || right.title) || collator.compare(left.title, right.title);
    });
  }

  function filteredSongs() {
    const query = $('#search-input').value.trim().toLocaleLowerCase('ja');
    const showHidden = isOwner && $('#show-hidden').checked;
    const list = songs.filter((song) => {
      if (!song.visible && !showHidden) return false;
      if (!query) return true;
      const searchable = [song.artist, song.artistKana, song.title, song.songKana, song.key, sungKey(song)];
      if (user) searchable.push(song.notes);
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
    const adminActions = isOwner
      ? actionButton('toggle-visible', song.id, '', song.visible ? '一覧から非表示にする' : '一覧に表示する', visibilityIcon) + actionButton('sung', song.id, '', '今日歌った', '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 15l2 2 5-5"/></svg>', 'recorded') + actionButton('edit', song.id, '', '編集', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-.8L19.5 7.7a2.12 2.12 0 0 0-3-3L5 16.2 4 20Z"/></svg>') + actionButton('delete', song.id, '', '削除', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg>')
      : '';
    const searchCell = '<td class="search-cell"><div class="row-actions search-actions">' + chordSearch + '</div></td>';
    const actionCell = isOwner ? '<td><div class="row-actions">' + adminActions + '</div></td>' : '';
    const sungKeyLabel = (key || '—') + ' (' + signed(song.transpose) + ')';
    const quickKey = isOwner
      ? '<span class="base-key">' + escapeHtml(original) + '</span><span class="key-arrow">→</span><button class="key-nudge" type="button" data-action="transpose" data-delta="-1" data-id="' + escapeHtml(song.id) + '" aria-label="半音下げる">−</button><span class="key-chip" title="自分が歌うキー（原曲からの移調）">' + escapeHtml(sungKeyLabel) + '</span><button class="key-nudge" type="button" data-action="transpose" data-delta="1" data-id="' + escapeHtml(song.id) + '" aria-label="半音上げる">＋</button><span class="parallel-link">/</span><span class="parallel-chip" title="平行調">' + escapeHtml(relative || '—') + '</span>'
      : '<span class="base-key">' + escapeHtml(original) + '</span><span class="key-arrow">→</span><span class="key-chip" title="自分が歌うキー（原曲からの移調）">' + escapeHtml(sungKeyLabel) + '</span><span class="parallel-link">/</span><span class="parallel-chip" title="平行調">' + escapeHtml(relative || '—') + '</span>';
    const hiddenMark = song.visible ? '' : '<span class="hidden-pill">非表示</span>';
    const notesCell = user ? '<td><div class="note-cell" title="' + escapeHtml(song.notes || '') + '"><span>' + escapeHtml(song.notes || '—') + '</span></div></td>' : '';
    return '<tr class="' + (song.visible ? '' : 'is-hidden-song') + '">' +
      '<td><div class="artist-cell"><div class="cell-scroll"><span class="artist-name" title="' + escapeHtml(song.artist) + '">' + escapeHtml(song.artist) + hiddenMark + '</span></div><div class="cell-scroll reading-scroll" title="アーティスト名の読み仮名"><span class="artist-reading">' + escapeHtml(song.artistKana) + '</span></div></div></td>' +
      '<td><div class="song-cell"><div class="cell-scroll"><span class="song-name" title="' + escapeHtml(song.title) + '">' + escapeHtml(song.title) + '</span></div><div class="cell-scroll reading-scroll" title="曲名の読み仮名"><span class="song-reading">' + escapeHtml(song.songKana) + '</span></div></div></td>' +
      '<td><div class="key-cell">' + quickKey + '</div></td>' +
      searchCell +
      '<td><div class="cell-scroll date-scroll"><span class="date-cell ' + (song.lastSung ? 'date-recorded' : 'date-empty') + '">' + escapeHtml(formatDate(song.lastSung)) + '</span></div></td>' +
      notesCell + actionCell + '</tr>';
  }

  function render() {
    const list = filteredSongs();
    const countScope = isOwner ? songs : songs.filter((song) => song.visible);
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
    const actionHead = isOwner ? '<th scope="col">操作</th>' : '';
    const actionCol = isOwner ? '<col class="actions">' : '';
    const notesHead = user ? '<th scope="col">備考</th>' : '';
    const notesCol = user ? '<col class="notes">' : '';
    const listType = isOwner ? ' owner-list' : user ? ' authenticated-list' : ' public-list';
    $('#song-list').innerHTML = '<table class="song-table' + listType + '"><colgroup><col class="artist"><col class="title"><col class="key"><col class="search"><col class="last">' + notesCol + actionCol + '</colgroup><thead><tr><th scope="col">アーティスト</th><th scope="col">曲名</th><th scope="col">原曲 → 歌うキー（移調） / 平行調</th><th class="search-heading" scope="col" title="Chordwikiで検索">検索</th><th scope="col">最後に歌った日</th>' + notesHead + actionHead + '</tr></thead><tbody>' + list.map(songRow).join('') + '</tbody></table>';
  }

  function updateAccessUi() {
    isOwner = Boolean(user && config.adminUserId && user.id === config.adminUserId);
    document.querySelectorAll('.admin-only').forEach((element) => element.classList.toggle('hidden', !isOwner));
    $('#auth-button').classList.toggle('hidden', Boolean(user));
    $('#logout-button').classList.toggle('hidden', !user);
    $('#hidden-filter-wrap').classList.toggle('hidden', !isOwner);
    if (user && !isOwner) announce('ログイン中ですが、このアカウントには編集権限がありません。');
    if (user && isOwner) setSyncState('オーナーとしてログイン中', 'ok');
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
        user = session ? session.user : null;
        updateAccessUi();
      });
      updateAccessUi();
    } catch (error) {
      console.error('Supabase initialization failed', error);
      setSyncState('認証に接続できません', 'warn');
    }
  }

  async function loadSongs() {
    const stored = localStorage.getItem(storageKey);
    const dataUrl = config.songsDataUrl || './data/songs.json';
    try {
      const response = await fetch(dataUrl + (dataUrl.includes('?') ? '&' : '?') + 'v=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) throw new Error('一覧データを取得できませんでした');
      songs = await response.json();
      if (stored && !config.songsDataUrl) {
        try {
          const draft = JSON.parse(stored);
          if (Array.isArray(draft) && draft.length) songs = draft;
        } catch (_) { localStorage.removeItem(storageKey); }
      }
      setSyncState('公開リストを読み込みました', 'ok');
    } catch (error) {
      console.error('Song data could not be loaded', error);
      try {
      songs = stored ? JSON.parse(stored) : (Array.isArray(window.SONGLIST_INITIAL_SONGS) ? window.SONGLIST_INITIAL_SONGS : []);
      } catch (_) { songs = []; }
      setSyncState(songs.length ? '保存済みのリストを表示中' : '一覧データを読み込めません', 'warn');
      if (!songs.length) announce('曲リストを読み込めませんでした。GitHub PagesなどのWebサーバーから開いてください。');
    }
    songs = songs.map(normalizeSong);
    if (config.adminUserId && config.supabaseUrl && config.supabaseAnonKey && config.githubSyncReady) $('#setup-notice').classList.add('hidden');
    else $('#setup-notice').classList.remove('hidden');
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
    writeChain = writeChain.catch(() => undefined).then(async () => {
      if (isOwner && supabase && config.adminUserId) {
        setSyncState('GitHubに保存しています', 'warn');
        const { error } = await supabase.functions.invoke(config.syncFunctionName || 'songlist-github-sync', { body: { songs: JSON.parse(snapshot) } });
        if (error) throw error;
        localStorage.removeItem(storageKey);
        setSyncState('GitHubに保存しました', 'ok');
      } else {
        localStorage.setItem(storageKey, snapshot);
        setSyncState('このブラウザーに保存しました', 'warn');
      }
    }).catch((error) => {
      console.error('Song list could not be saved', error);
      localStorage.setItem(storageKey, snapshot);
      setSyncState('保存に失敗・端末に一時保存', 'warn');
      announce('GitHubへの保存に失敗しました。接続設定を確認してください。');
      throw error;
    });
    return writeChain;
  }

  function openSongDialog(song) {
    const editing = Boolean(song);
    $('#song-dialog-title').textContent = editing ? '曲を編集' : '曲を追加';
    $('#song-id').value = editing ? song.id : '';
    $('#artist-reading').value = editing ? song.artistKana : '';
    $('#song-reading').value = editing ? song.songKana : '';
    $('#artist-name').value = editing ? song.artist : '';
    $('#song-title').value = editing ? song.title : '';
    fillKeySelect($('#song-key'), editing ? song.key : '');
    $('#transpose-value').value = editing ? song.transpose : 0;
    updateTransposeOutput();
    $('#last-sung').value = editing ? song.lastSung : '';
    $('#song-notes').value = editing ? song.notes : '';
    $('#song-visible').checked = editing ? song.visible : true;
    $('#form-error').classList.add('hidden');
    $('#song-dialog').showModal();
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
    const song = songs.find((item) => item.id === button.dataset.id);
    if (!song) return;
    if (button.dataset.action === 'edit') openSongDialog(song);
    if (button.dataset.action === 'chord-search') {
      const query = encodeURIComponent(song.artist + ' ' + song.title + ' Chordwiki');
      window.open('https://www.google.com/search?q=' + query, '_blank', 'noopener,noreferrer');
    }
    if (button.dataset.action === 'toggle-visible') {
      song.visible = !song.visible;
      render();
      try { await persistSongs(); announce(song.visible ? '一覧に表示しました。' : '一覧から非表示にしました。'); } catch (_) { /* Local backup remains available. */ }
    }
    if (button.dataset.action === 'delete') {
      if (!window.confirm('「' + song.artist + ' / ' + song.title + '」を削除しますか？')) return;
      songs = songs.filter((item) => item.id !== song.id);
      render();
      try { await persistSongs(); announce('曲を削除しました。'); } catch (_) { /* Local backup remains available. */ }
    }
    if (button.dataset.action === 'sung') {
      song.lastSung = localDate();
      render();
      try { await persistSongs(); announce('最後に歌った日を今日にしました。'); } catch (_) { /* Local backup remains available. */ }
    }
    if (button.dataset.action === 'transpose') {
      song.transpose = Math.max(-24, Math.min(24, Number(song.transpose || 0) + Number(button.dataset.delta)));
      render();
      try { await persistSongs(); } catch (_) { /* Local backup remains available. */ }
    }
  }

  async function authSubmit(event, signUp) {
    event.preventDefault();
    $('#auth-error').classList.add('hidden');
    $('#auth-message').classList.add('hidden');
    if (!supabase) {
      showError($('#auth-error'), 'Supabaseの接続設定がありません。READMEの初回設定を完了してください。');
      return;
    }
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const result = signUp
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) {
      showError($('#auth-error'), result.error.message);
      return;
    }
    if (signUp && !result.data.session) {
      $('#auth-message').textContent = '確認メールを送信しました。メールのリンクを開いて登録を完了してください。';
      $('#auth-message').classList.remove('hidden');
      return;
    }
    user = result.data.user || (result.data.session && result.data.session.user);
    updateAccessUi();
    $('#auth-dialog').close();
    announce(isOwner ? 'オーナーとしてログインしました。' : 'ログインしました。編集にはオーナー権限が必要です。');
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
    const url = new URL(window.location.href);
    const query = $('#search-input').value.trim();
    const sort = $('#sort-mode').value;
    if (query) url.searchParams.set('q', query); else url.searchParams.delete('q');
    url.searchParams.delete('genre');
    if (sort !== 'artist') url.searchParams.set('sort', sort); else url.searchParams.delete('sort');
    url.searchParams.delete('showHidden');
    try {
      await navigator.clipboard.writeText(url.toString());
      announce('共有URLをコピーしました。');
    } catch (_) {
      window.prompt('共有URLをコピーしてください', url.toString());
    }
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    user = null;
    isOwner = false;
    $('#show-hidden').checked = false;
    updateAccessUi();
    setSyncState('公開リストを表示中', 'ok');
  }

  function applyUrlFilters() {
    const params = new URLSearchParams(window.location.search);
    $('#search-input').value = params.get('q') || '';
    params.delete('genre');
  }

  async function start() {
    $('#footer-year').textContent = String(new Date().getFullYear());
    fillKeySelect($('#song-key'), '');
    const params = new URLSearchParams(window.location.search);
    if (params.get('sort') === 'title' || params.get('sort') === 'recent') $('#sort-mode').value = params.get('sort');
    $('#add-button').addEventListener('click', () => openSongDialog(null));
    $('#song-form').addEventListener('submit', saveSong);
    $('#song-list').addEventListener('click', handleListAction);
    $('#transpose-down').addEventListener('click', () => { $('#transpose-value').value = Number($('#transpose-value').value || 0) - 1; updateTransposeOutput(); });
    $('#transpose-up').addEventListener('click', () => { $('#transpose-value').value = Number($('#transpose-value').value || 0) + 1; updateTransposeOutput(); });
    $('#song-key').addEventListener('change', updatePreview);
    $('#artist-name').addEventListener('input', () => { const reading = inferReadingFromName($('#artist-name').value); if (reading && !$('#artist-reading').value) $('#artist-reading').value = reading; });
    $('#song-title').addEventListener('input', () => { const reading = inferReadingFromName($('#song-title').value); if (reading && !$('#song-reading').value) $('#song-reading').value = reading; });
    $('#auth-button').addEventListener('click', () => $('#auth-dialog').showModal());
    $('#logout-button').addEventListener('click', signOut);
    $('#auth-form').addEventListener('submit', (event) => authSubmit(event, false));
    $('#signup-button').addEventListener('click', () => {
      if ($('#auth-form').reportValidity()) authSubmit(new Event('submit', { cancelable: true, bubbles: true }), true);
    });
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
    await loadSongs();
    applyUrlFilters();
    render();
    await initializeAuth();
  }

  start();
})();
