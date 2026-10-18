'use strict';

(function(root){
  var DB_NAME = 'guitar_studio_db';
  var DB_VER = 1;
  var dbInstance = null;
  var dbOpenPromise = null;

  function invalidateDB(db){
    if (dbInstance === db) dbInstance = null;
  }

  function openDB(){
    if (dbInstance) return Promise.resolve(dbInstance);
    if (dbOpenPromise) return dbOpenPromise;
    var openPromise = new Promise(function(resolve, reject){
      var req;
      var settled = false;
      try {
        req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function(e){
          var db = e.target.result;
          if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        };
        req.onblocked = function(){
          if (settled) return;
          settled = true;
          reject(new Error('IndexedDB open blocked'));
        };
        req.onerror = function(e){
          if (settled) return;
          settled = true;
          reject(e.target.error || new Error('IndexedDB open failed'));
        };
        req.onsuccess = function(e){
          var db = e.target.result;
          if (settled){ db.close(); return; }
          settled = true;
          db.onversionchange = function(){
            db.close();
            invalidateDB(db);
          };
          db.onclose = function(){ invalidateDB(db); };
          dbInstance = db;
          resolve(db);
        };
      } catch (error){
        settled = true;
        reject(error);
      }
    });
    dbOpenPromise = openPromise;
    openPromise.then(function(){
      if (dbOpenPromise === openPromise) dbOpenPromise = null;
    }, function(){
      if (dbOpenPromise === openPromise) dbOpenPromise = null;
    });
    return openPromise;
  }

  function runTransaction(storeName, mode, operation){
    return openDB().then(function(db){
      return new Promise(function(resolve, reject){
        var tx, request, result;
        var requestError = null;
        var settled = false;
        function fail(error){
          if (settled) return;
          settled = true;
          reject(error || requestError || new Error('IndexedDB transaction failed'));
        }
        try {
          tx = db.transaction(storeName, mode);
          tx.oncomplete = function(){
            if (settled) return;
            settled = true;
            resolve(result);
          };
          tx.onerror = function(e){ fail(e.target && e.target.error); };
          tx.onabort = function(e){ fail(e.target && e.target.error); };
          request = operation(tx.objectStore(storeName));
          if (request){
            request.onsuccess = function(){ result = request.result; };
            request.onerror = function(e){
              requestError = e.target && e.target.error;
              fail(requestError);
            };
          }
        } catch (error){ fail(error); }
      });
    });
  }

  function dbGetAllSongs(){
    return runTransaction('songs', 'readonly', function(store){ return store.getAll(); }).then(function(result){ return result || []; });
  }
  function dbSaveSong(song){
    return runTransaction('songs', 'readwrite', function(store){ return store.put(song); });
  }
  function dbDeleteSong(id){
    return runTransaction('songs', 'readwrite', function(store){ return store.delete(id); });
  }

  var ls = {
    get: function(k, d){ try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e){ return d; } },
    set: function(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e){} }
  };

  if (typeof window !== 'undefined'){
    root.openDB = openDB;
    root.dbGetAllSongs = dbGetAllSongs;
    root.dbSaveSong = dbSaveSong;
    root.dbDeleteSong = dbDeleteSong;
    root.ls = ls;
  }
  if (typeof module !== 'undefined' && module.exports){
    module.exports = { openDB: openDB, dbGetAllSongs: dbGetAllSongs, dbSaveSong: dbSaveSong, dbDeleteSong: dbDeleteSong, ls: ls };
  }
})(typeof window !== 'undefined' ? window : globalThis);
