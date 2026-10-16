/* Pure merge rules and account-scoped durable drafts. No credentials are stored here. */
(function (root) {
  const fields = ['artist', 'artistKana', 'title', 'songKana', 'key', 'transpose', 'lastSung', 'notes', 'visible', 'extra'];
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const clean = (song) => song && Object.fromEntries(['id', ...fields].map((key) => [key, song[key]]));
  function mergeExtra(base, local, remote, preferLocal) {
    if (equal(local, base)) return remote;
    if (equal(remote, base) || equal(local, remote)) return local;
    const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
    if (object(base) && object(local) && object(remote)) {
      return Object.fromEntries([...new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(base)])].map((key) => [key, mergeExtra(base[key], local[key], remote[key], preferLocal)]).filter(([, value]) => value !== undefined));
    }
    const records = (value) => Array.isArray(value) && value.every((item) => object(item) && typeof item.id === 'string');
    if (records(base) && records(local) && records(remote)) {
      const maps = [base,local,remote].map((list) => new Map(list.map((item) => [item.id,item])));
      return [...new Set([...maps[2].keys(),...maps[1].keys(),...maps[0].keys()])].map((id) => mergeExtra(maps[0].get(id),maps[1].get(id),maps[2].get(id),preferLocal)).filter((value) => value !== undefined);
    }
    // Concurrent first-time practice additions have no base container yet.
    if (base === undefined && object(local) && object(remote)) return mergeExtra({},local,remote,preferLocal);
    if (base === undefined && records(local) && records(remote)) return mergeExtra([],local,remote,preferLocal);
    return preferLocal ? local : remote;
  }
  function mergeSongs(base, local, remote) {
    const maps = [base, local, remote].map((list) => new Map(list.map((song) => [song.id, clean(song)])));
    const result = new Map();
    const conflicts = [];
    for (const id of new Set([...maps[2].keys(), ...maps[1].keys(), ...maps[0].keys()])) {
      let [b, l, r] = maps.map((map) => map.get(id));
      // Treat the previous last-sung date as a real base record during migration.
      // This lets a deletion merge correctly with another device's first new record.
      if (root.SonglistPractice && [b,l,r].some((song) => song?.extra?.practice)) {
        [b,l,r] = [b,l,r].map((song) => song && { ...song, extra: { ...song.extra, practice: root.SonglistPractice.get(song) } });
      }
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
        else if (field === 'extra') {
          const localMerged = mergeExtra(b[field],l[field],r[field],true);
          const remoteMerged = mergeExtra(b[field],l[field],r[field],false);
          merged[field] = remoteMerged;
          if (!equal(localMerged,remoteMerged)) conflicts.push({ id, field, local:localMerged, remote:remoteMerged, label:l.title });
        } else {
          merged[field] = r[field];
          conflicts.push({ id, field, local: l[field], remote: r[field], label: l.title });
        }
      }
      if (Array.isArray(merged.extra?.practice?.history)) {
        const historyConflict = conflicts.some((c) => c.id === id && (c.field === 'extra' || c.field === '$song'));
        if (!historyConflict) {
          merged.lastSung = merged.extra.practice.history.map((r) => r.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1) || '';
          for (let i=conflicts.length-1;i>=0;i--) if (conflicts[i].id===id && conflicts[i].field==='lastSung') conflicts.splice(i,1);
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
    return [...map.values()].map((song) => {
      if (!Array.isArray(song.extra?.practice?.history)) return song;
      return { ...song, lastSung: song.extra.practice.history.map((r) => r.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1) || '' };
    });
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
