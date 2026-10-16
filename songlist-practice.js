/* Private practice records live inside the existing per-song extra data. */
(function (root) {
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const date = new Date(value + 'T12:00:00Z');
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }
  const shift = (value) => Math.max(-24, Math.min(24, Math.round(Number(value) || 0)));
  function get(song) {
    const stored = song?.extra?.practice || {};
    const seen = new Set();
    const presets = (Array.isArray(stored.presets) ? stored.presets : []).filter((p) => p && p.id && !seen.has(String(p.id)) && seen.add(String(p.id))).map((p) => ({ id: String(p.id), name: String(p.name || 'キー設定').slice(0, 40), transpose: shift(p.transpose) }));
    if (!presets.length) presets.push({ id: 'default', name: '通常', transpose: shift(song?.transpose) });
    const activePresetId = presets.some((p) => p.id === stored.activePresetId) ? stored.activePresetId : presets[0].id;
    // Preserve adjustments made by older clients and direct +/- controls.
    presets.find((p) => p.id === activePresetId).transpose = shift(song?.transpose);
    const ids = new Set();
    let history = Array.isArray(stored.history) ? stored.history.filter((r) => r && r.id && validDate(r.date) && !ids.has(String(r.id)) && ids.add(String(r.id))).map((r) => ({ ...r, id: String(r.id), date: r.date })) : [];
    if (!Array.isArray(stored.history) && validDate(song?.lastSung)) history = [{ id: 'legacy:' + song.id, date: song.lastSung, legacy: true }];
    return { version: 1, presets, activePresetId, history };
  }
  function put(song, practice) {
    const active = practice.presets.find((p) => p.id === practice.activePresetId) || practice.presets[0];
    return { ...song, transpose: shift(active.transpose), lastSung: practice.history.map((r) => r.date).sort().at(-1) || (!Array.isArray(song.extra?.practice?.history) && song.lastSung && !validDate(song.lastSung) ? song.lastSung : ''), extra: { ...song.extra, practice: { ...practice, version: 1, activePresetId: active.id } } };
  }
  function addRecord(song, date, id, presetId) {
    if (!validDate(date)) throw new Error('Invalid date');
    const practice = get(song), preset = practice.presets.find((p) => p.id === presetId) || practice.presets.find((p) => p.id === practice.activePresetId);
    if (practice.history.some((r) => r.id === id)) return song;
    practice.history.push({ id, date, key: song.key, transpose: preset.transpose, presetName: preset.name });
    return put(song, practice);
  }
  function setPreset(song, id) {
    const practice = get(song);
    if (!practice.presets.some((p) => p.id === id)) return song;
    practice.activePresetId = id;
    return put(song, practice);
  }
  function transpose(song, value) {
    const practice = get(song);
    practice.presets.find((p) => p.id === practice.activePresetId).transpose = shift(value);
    return put(song, practice);
  }
  root.SonglistPractice = { validDate, shift, get, put, addRecord, setPreset, transpose };
})(typeof window === 'undefined' ? globalThis : window);
