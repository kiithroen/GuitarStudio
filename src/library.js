'use strict';

(function(root, factory){
  var api = factory(
    typeof module === 'object' && module.exports ? require('./storage.js') : root,
    typeof module === 'object' && module.exports ? require('./legacy-migration.js') : root.LegacyMigration,
    typeof module === 'object' && module.exports ? require('./tab-engine.js') : root.TabEngine
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuitarLibrary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(storage, migration, engine){
  function normalizeSong(record){
    if (!record || typeof record !== 'object') throw new TypeError('song record must be an object');
    if (typeof record.id !== 'string' || !record.id) throw new TypeError('song id is required');
    if (typeof record.title !== 'string' || !record.title.trim()) throw new TypeError('song title is required');
    if (record.format !== 'alphatex' && record.format !== 'binary') throw new TypeError('song format must be alphatex or binary');
    var normalized = Object.assign({}, record, {
      id: record.id, title: record.title.trim(), badge: String(record.badge || record.description || ''),
      notationVersion: 3, builtin: !!record.builtin, fromSheet: !!record.fromSheet
    });
    if (normalized.format === 'alphatex') {
      if (typeof normalized.alphaTex !== 'string' || !normalized.alphaTex.trim()) throw new TypeError('alphaTex is required');
      delete normalized.bytes;
    } else {
      if (!(normalized.bytes instanceof Uint8Array) && !(normalized.bytes instanceof ArrayBuffer)) throw new TypeError('binary bytes must be an ArrayBuffer or Uint8Array');
      normalized.bytes = normalized.bytes instanceof Uint8Array ? new Uint8Array(normalized.bytes) : normalized.bytes.slice(0);
      if (typeof normalized.fileName !== 'string' || !normalized.fileName) throw new TypeError('binary fileName is required');
      delete normalized.alphaTex;
    }
    return normalized;
  }
  async function builtinSongs(){
    var response = await fetch('./songs.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('songs.json request failed: ' + response.status);
    var records = await response.json();
    if (!Array.isArray(records)) throw new TypeError('songs.json must contain an array');
    return records.map(function(record){ var item = normalizeSong(record); item.builtin = true; return item; });
  }
  async function loadAll(){
    var warnings = [];
    var builtins = await builtinSongs();
    var stored = await storage.dbGetAllSongs();
    var songs = builtins.slice();
    for (var i = 0; i < stored.length; i++){
      var originalItem = stored[i];
      var item = originalItem;
      try {
        if (item && item.notationVersion !== 3) {
          item = migration.convertSong(item, engine);
          await storage.dbSaveSong(item);
          (item.warnings || []).forEach(function(message){ warnings.push({ id: item.id, message: message }); });
        }
        songs.push(normalizeSong(item));
      } catch (error){
        warnings.push({ id: originalItem && originalItem.id || null, message: error.message, record: originalItem });
      }
    }
    return { songs: songs, warnings: warnings };
  }
  async function save(song){
    var normalized = normalizeSong(song);
    if (normalized.builtin) throw new Error('내장곡은 직접 저장할 수 없어. 개인 복사본으로 저장해줘.');
    var builtins = await builtinSongs();
    if (builtins.some(function(item){ return item.id === normalized.id; })) throw new Error('내장곡 ID로는 저장할 수 없어. 개인 복사본에 새 ID를 지정해줘.');
    if (normalized.format === 'alphatex') engine.parseAlphaTex(normalized.alphaTex);
    else engine.importBytes(normalized.bytes);
    await storage.dbSaveSong(normalized);
    return normalized;
  }
  async function remove(id){
    var all = await builtinSongs();
    if (all.some(function(song){ return song.id === id; })) throw new Error('내장곡은 삭제할 수 없어.');
    await storage.dbDeleteSong(id);
  }
  return { loadAll: loadAll, save: save, remove: remove, normalizeSong: normalizeSong };
});
