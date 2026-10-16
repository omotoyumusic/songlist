/* Pure merge rules and account-scoped durable drafts. No credentials are stored here. */
(function (root) {
  const fields = ['artist', 'artistKana', 'title', 'songKana', 'key', 'transpose', 'lastSung', 'notes', 'visible', 'extra'];
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const clean = (song) => song && Object.fromEntries(['id', ...fields].map((key) => [key, song[key]]));
  function mergeSongs(base, local, remote) {
    const maps = [base, local, remote].map((list) => new Map(list.map((song) => [song.id, clean(song)])));
    const result = new Map();
    const conflicts = [];
    for (const id of new Set([...maps[2].keys(), ...maps[1].keys(), ...maps[0].keys()])) {
      const [b, l, r] = maps.map((map) => map.get(id));
      if (equal(l, b)) { if (r) result.set(id, r); continue; }
      if (equal(r, b) || equal(l, r)) { if (l) result.set(id, l); continue; }
      if (!b || !l || !r) {
        if (r) result.set(id, r);
        conflicts.push({ id, field: '$song', local: l, remote: r, label: (l || r || b).title });
        continue;
      }
      const merged = { id };
      for (const field of fields) {
        if (equal(l[field], b[field])) merged[field] = r[field];
        else if (equal(r[field], b[field]) || equal(l[field], r[field])) merged[field] = l[field];
        else {
          merged[field] = r[field];
          conflicts.push({ id, field, local: l[field], remote: r[field], label: l.title });
        }
      }
      result.set(id, merged);
    }
    return { songs: [...result.values()], conflicts };
  }
  function resolveMerge(merge, choices) {
    const map = new Map(merge.songs.map((song) => [song.id, { ...song }]));
    merge.conflicts.forEach((conflict, index) => {
      const value = choices[index] === 'local' ? conflict.local : conflict.remote;
      if (conflict.field === '$song') { if (value) map.set(conflict.id, { ...value }); else map.delete(conflict.id); }
      else map.get(conflict.id)[conflict.field] = value;
    });
    return [...map.values()];
  }
  function identity(value) { return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ja'); }
  function draftStore(storage) {
    const prefix = 'songlist-draft-v2:';
    return {
      write(userId, draftId, draft) {
        const key = prefix + userId + ':' + draftId;
        const value = JSON.stringify({ ...draft, draftId, updatedAt: new Date().toISOString() });
        storage.setItem(key, value);
        if (storage.getItem(key) !== value) throw new Error('Draft storage failed');
      },
      list(userId) {
        const drafts = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key.startsWith(prefix + userId + ':')) continue;
          try { const item = JSON.parse(storage.getItem(key)); if (Array.isArray(item.songs) && Array.isArray(item.baseSongs)) drafts.push(item); } catch (_) { /* Keep unreadable entries untouched. */ }
        }
        return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      },
      remove(userId, draftId, expectedStamp) {
        const key = prefix + userId + ':' + draftId;
        const stored = JSON.parse(storage.getItem(key) || 'null');
        if (!expectedStamp || stored?.stamp === expectedStamp) storage.removeItem(key);
      }
    };
  }
  root.SonglistCore = { mergeSongs, resolveMerge, identity, draftStore, equal, clean };
})(typeof window === 'undefined' ? globalThis : window);
