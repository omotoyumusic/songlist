const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = __dirname + '/';
const read = (file) => fs.readFileSync(root + file, 'utf8');
const window = {
  SONGLIST_CONFIG: {},
  location: { hash: '', search: '', pathname: '/songlist/', origin: 'https://example.test' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: { length: 0, getItem: () => null, setItem() {}, removeItem() {}, key: () => null },
};
const elements = {
  '#import-form': {},
  '#import-error': {textContent:'',classList:{remove() {}}},
  '#import-dialog': {closed:false,close() {this.closed=true;}},
  '#import-file': {value:'fixture.csv'}
};
class FormDataStub { get(name) { return name === 'import-mode' ? 'merge' : null; } }
const context = vm.createContext({ window, document: { querySelector: (selector) => elements[selector] || null }, FormData:FormDataStub, crypto: webcrypto, structuredClone, URLSearchParams, console, setTimeout, clearTimeout });
vm.runInContext(read('songlist-core.js'), context);
vm.runInContext(read('songlist-practice.js'), context);
const source = read('app.js').replace('  start();\n})();', `  window.debugApi = { csvToSongs, parseCsv, csvCell, sortSongs, normalizeSong, processImport, mergeImportedSongs: typeof mergeImportedSongs === 'function' ? mergeImportedSongs : null, prepareImport: (existing,incoming) => { songs=existing; pendingImport=incoming; canMutate=()=>true; commitSongs=(next)=>{songs=next;return true;}; persistSongs=async()=>true; announce=()=>{}; }, getSongs:()=>songs };\n})();`);
assert.notEqual(source, read('app.js'), 'Could not load app functions');
vm.runInContext(source, context);
const api = window.debugApi, practice = window.SonglistPractice, core = window.SonglistCore;
const plain = (value) => JSON.parse(JSON.stringify(value));
const csv = (rows) => rows.map((row) => row.map(api.csvCell).join(',')).join('\r\n');
const sample = {
  id:'existing-1', artist:'あいみょん', artistKana:'あいみょん', title:'曲A', songKana:'きょくえー',
  key:'A', transpose:1, lastSung:'2026-10-20', notes:'大切な備考', visible:false,
  extra:{ practice:{version:1,presets:[{id:'default',name:'通常',transpose:1}],activePresetId:'default',history:[{id:'h1',date:'2026-10-20',recordedAt:'2026-10-20T12:15:01.000Z'}]} }
};

const checks = [];
function check(name, fn) { try { fn(); checks.push([name, true]); } catch (error) { checks.push([name, false, error.message]); } }

check('CSV handles commas, quotes and multiline fields', () => {
  const rows = [['アーティスト名','曲名','備考'], ['歌手','曲A','歌詞,\n"サビ"']];
  assert.equal(api.csvToSongs(csv(rows))[0].notes, rows[1][2]);
});
check('CSV backup retains singing history and timestamps', () => {
  const headers = ['ID','アーティスト名の読み仮名','アーティスト名','曲名の読み仮名','曲名','原曲キー','自分が歌うキー（移調）','最後に歌った日','備考','一覧に表示','追加データ(JSON)'];
  const values = [sample.id,sample.artistKana,sample.artist,sample.songKana,sample.title,sample.key,sample.transpose,sample.lastSung,sample.notes,'false',JSON.stringify(sample.extra)];
  const loaded = api.csvToSongs(csv([headers,values]))[0];
  assert.deepEqual(plain(loaded.extra), sample.extra);
  assert.equal(loaded.visible,false);
});
check('Broken additional JSON is rejected instead of clearing history', () => {
  assert.throws(() => api.csvToSongs(csv([['アーティスト名','曲名','追加データ(JSON)'],[sample.artist,sample.title,'{broken']])), /追加データ/);
  assert.throws(() => api.csvToSongs(csv([['アーティスト名','曲名','追加データ(JSON)'],[sample.artist,sample.title,'[]']])), /追加データ/);
});
check('Malformed practice history is rejected instead of silently dropping records', () => {
  const headers = ['アーティスト名','曲名','追加データ(JSON)'];
  for (const extra of [{practice:{history:'broken'}},{practice:{history:[{id:'x',date:'invalid'}]}},{practice:{history:[{id:'x',date:'2026-10-20'},{id:'x',date:'2026-10-21'}]}}]) {
    assert.throws(() => api.csvToSongs(csv([headers,[sample.artist,sample.title,JSON.stringify(extra)]])), /追加データ/);
  }
});
check('Unterminated CSV quote is rejected', () => {
  assert.throws(() => api.csvToSongs('アーティスト名,曲名,備考\n歌手,曲A,"中断'), /CSV/);
});
check('Partial CSV updates preserve fields and singing history', () => {
  const imported = api.csvToSongs(csv([['アーティスト名','曲名','原曲キー'],[sample.artist,sample.title,'C']]));
  assert.ok(api.mergeImportedSongs, 'No safe partial import merge');
  const updated = api.mergeImportedSongs([sample],imported)[0];
  assert.equal(updated.id,sample.id); assert.equal(updated.key,'C');
  assert.equal(updated.transpose,1); assert.equal(updated.notes,sample.notes); assert.equal(updated.visible,false);
  assert.equal(updated.artistKana,sample.artistKana); assert.equal(updated.songKana,sample.songKana);
  assert.equal(updated.lastSung,sample.lastSung); assert.deepEqual(plain(updated.extra),sample.extra);
});
check('Date-only import cannot silently desynchronize existing history', () => {
  const imported = api.csvToSongs(csv([['アーティスト名','曲名','最後に歌った日'],[sample.artist,sample.title,'2026-10-21']]));
  assert.ok(api.mergeImportedSongs, 'No safe partial import merge');
  assert.throws(() => api.mergeImportedSongs([sample],imported), /歌唱履歴/);
  assert.equal(sample.lastSung,'2026-10-20');
});
check('Explicit full backup restores its history', () => {
  const replacement = {...sample.extra, practice:{...sample.extra.practice, history:[{id:'h2',date:'2026-10-22'}]}};
  const imported = api.csvToSongs(csv([['アーティスト名','曲名','最後に歌った日','追加データ(JSON)'],[sample.artist,sample.title,'2026-10-22',JSON.stringify(replacement)]]));
  assert.ok(api.mergeImportedSongs, 'No safe partial import merge');
  const updated = api.mergeImportedSongs([sample],imported)[0];
  assert.deepEqual(plain(updated.extra),replacement); assert.equal(updated.lastSung,'2026-10-22');
});
check('New songs imported with history derive their last sung date', () => {
  const imported=api.csvToSongs(csv([['アーティスト名','曲名','追加データ(JSON)'],[sample.artist,sample.title,JSON.stringify(sample.extra)]]));
  assert.equal(imported[0].lastSung,'2026-10-20');
  const added=api.mergeImportedSongs([],imported)[0];
  assert.equal(added.lastSung,'2026-10-20');assert.deepEqual(plain(added.extra),sample.extra);
});
check('A CSV with a date that contradicts its included history is rejected', () => {
  const data=csv([['アーティスト名','曲名','最後に歌った日','追加データ(JSON)'],[sample.artist,sample.title,'2026-10-21',JSON.stringify(sample.extra)]]);
  assert.throws(() => api.csvToSongs(data), /歌唱履歴/);
});
check('Explicit empty notes can be saved without clearing omitted history', () => {
  const imported=api.csvToSongs(csv([['アーティスト名','曲名','備考'],[sample.artist,sample.title,'']]));
  const updated=api.mergeImportedSongs([sample],imported)[0];
  assert.equal(updated.notes,''); assert.deepEqual(plain(updated.extra),sample.extra);
});
check('Adding a new partial CSV song does not reuse an existing id', () => {
  const imported=api.csvToSongs(csv([['ID','アーティスト名','曲名'],[sample.id,'別の歌手','別の曲']]));
  const merged=api.mergeImportedSongs([sample],imported);
  assert.equal(merged.length,2);assert.notEqual(merged[0].id,merged[1].id);
});
check('Ambiguous duplicate existing songs cannot be silently dropped during merge', () => {
  const duplicate={...sample,id:'existing-2'};
  const imported=api.csvToSongs(csv([['アーティスト名','曲名','備考'],[sample.artist,sample.title,'更新']]));
  assert.throws(() => api.mergeImportedSongs([sample,duplicate],imported), /重複/);
});
check('Unrelated existing duplicate songs survive an import', () => {
  const duplicate={...sample,id:'existing-2'};
  const imported=api.csvToSongs(csv([['アーティスト名','曲名'],['別の歌手','別の曲']]));
  const merged=api.mergeImportedSongs([sample,duplicate],imported);
  assert.equal(merged.length,3);assert.ok(merged.some(s=>s.id==='existing-1'));assert.ok(merged.some(s=>s.id==='existing-2'));
});
check('Duplicate CSV rows do not silently overwrite each other', () => {
  const imported=api.csvToSongs(csv([['アーティスト名','曲名','備考'],[sample.artist,sample.title,'1'],[sample.artist,sample.title,'2']]));
  assert.throws(() => api.mergeImportedSongs([sample],imported), /重複/);
});
check('History ordering uses recorded time and preserves unknown older times', () => {
  const a={date:'2026-10-20',recordedAt:'2026-10-20T10:00:01.000Z'},b={date:'2026-10-20',recordedAt:'2026-10-20T10:00:02.000Z'},unknown={date:'2026-10-20'};
  assert.ok(practice.compareRecordsNewestFirst(b,a)<0); assert.ok(practice.compareRecordsNewestFirst(a,unknown)<0);
  const added=practice.addRecord(sample,'2026-10-21','h2');
  assert.ok(practice.get(added).history.find((r)=>r.id==='h2').recordedAt);
  assert.equal(practice.get(sample).history.length,1);
});
check('Independent concurrent history additions are combined', () => {
  const local=practice.addRecord(sample,'2026-10-21','local-h'), remote=practice.addRecord(sample,'2026-10-22','remote-h');
  const merged=core.mergeSongs([sample],[local],[remote]);
  assert.equal(merged.conflicts.length,0);
  assert.deepEqual(plain(practice.get(merged.songs[0]).history.map(r=>r.id).sort()),['h1','local-h','remote-h']);
  assert.equal(merged.songs[0].lastSung,'2026-10-22');
});
check('Count sort uses saved history and breaks ties by reading', () => {
  const more=practice.addRecord(sample,'2026-10-21','second');
  const less={...sample,id:'other',artist:'別',artistKana:'あ',title:'別曲'};
  const sorted=api.sortSongs([less,more],'count');
  assert.equal(sorted[0].id,sample.id);
});

for (const [name, passed, error] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${error ? ': '+error : ''}`);
if (checks.some(([,passed]) => !passed)) process.exitCode=1;

(async () => {
  const imported=api.csvToSongs(csv([['アーティスト名','曲名','原曲キー'],[sample.artist,sample.title,'C']]));
  api.prepareImport([sample],imported);
  await api.processImport({preventDefault(){}});
  const saved=api.getSongs()[0];
  assert.equal(saved.key,'C');assert.equal(saved.notes,sample.notes);assert.deepEqual(plain(saved.extra),sample.extra);
  assert.equal(Object.hasOwn(saved,'_importFields'),false);assert.equal(elements['#import-dialog'].closed,true);
  console.log('PASS partial CSV import completes without losing private history');

  elements['#import-dialog'].closed=false;elements['#import-error'].textContent='';
  const mismatch=api.csvToSongs(csv([['アーティスト名','曲名','最後に歌った日'],[sample.artist,sample.title,'2026-10-21']]));
  api.prepareImport([sample],mismatch);
  await api.processImport({preventDefault(){}});
  assert.equal(api.getSongs()[0].lastSung,sample.lastSung);assert.match(elements['#import-error'].textContent,/歌唱履歴/);
  assert.equal(elements['#import-dialog'].closed,false);
  console.log('PASS conflicting date import shows an error without changing songs');
})().catch((error) => {console.error('FAIL import integration:',error.message);process.exitCode=1;});
