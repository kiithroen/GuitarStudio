'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const storageSource = fs.readFileSync(path.join(__dirname, '../src/storage.js'), 'utf8');

function makeRequest(){ return {}; }

function makeDB(){
  const db = {
    closed: false,
    close(){ this.closed = true; if (this.onclose) this.onclose(); },
    transactionCalls: [],
    transaction(storeName, mode){
      const tx = { storeName, mode };
      const req = makeRequest();
      const store = {
        put(){ tx.request = req; return req; },
        delete(){ tx.request = req; return req; },
        getAll(){ tx.request = req; return req; }
      };
      tx.objectStore = function(){ return store; };
      this.transactionCalls.push(tx);
      return tx;
    }
  };
  return db;
}

function setup(){
  const opens = [];
  const context = {
    indexedDB: {
    open(name, version){
      const req = makeRequest();
      req.name = name;
      req.version = version;
      opens.push(req);
      return req;
    }
    },
    localStorage: { getItem(){ return null; }, setItem(){} },
    module: { exports: {} },
    setTimeout,
    clearTimeout
  };
  context.window = context;
  vm.runInNewContext(storageSource, context, { filename: 'src/storage.js' });
  return { storage: context.module.exports, opens };
}

function succeedOpen(req, db){ req.onsuccess({ target: { result: db } }); }
function failOpen(req, error){ req.onerror({ target: { error } }); }
function nextTurn(){ return new Promise(resolve => setImmediate(resolve)); }
async function settle(promise, outcome){
  const result = await Promise.race([
    promise.then(value => ({ type: 'resolve', value }), error => ({ type: 'reject', error })),
    new Promise(resolve => setTimeout(() => resolve({ type: 'timeout' }), 100))
  ]);
  assert.notStrictEqual(result.type, 'timeout', 'operation did not settle');
  assert.strictEqual(result.type, outcome);
  return result;
}

async function createPending(storage, opens, method, arg){
  const db = makeDB();
  const promise = storage[method](arg);
  succeedOpen(opens[0], db);
  await nextTurn();
  assert.strictEqual(db.transactionCalls.length, 1);
  return { db, tx: db.transactionCalls[0], promise };
}

async function main(){
  const beforeRequire = ['openDB', 'dbGetAllSongs', 'dbSaveSong', 'dbDeleteSong', 'ls'].map(key => Object.prototype.hasOwnProperty.call(global, key));
  delete require.cache[require.resolve('../src/storage.js')];
  require('../src/storage.js');
  for (const key of ['openDB', 'dbGetAllSongs', 'dbSaveSong', 'dbDeleteSong', 'ls']){
    assert.strictEqual(Object.prototype.hasOwnProperty.call(global, key), beforeRequire[['openDB', 'dbGetAllSongs', 'dbSaveSong', 'dbDeleteSong', 'ls'].indexOf(key)], 'CommonJS must not add ' + key + ' to Node globalThis');
  }
  delete require.cache[require.resolve('../src/storage.js')];
  for (const [method, arg] of [['dbSaveSong', { id: 'x' }], ['dbDeleteSong', 'x'], ['dbGetAllSongs', undefined]]){
    const { storage, opens } = setup();
    const { tx, promise } = await createPending(storage, opens, method, arg);
    tx.request.result = method === 'dbGetAllSongs' ? [{ id: 'x' }] : undefined;
    tx.request.onsuccess({ target: tx.request });
    tx.oncomplete({ target: tx });
    const done = await settle(promise, 'resolve');
    if (method === 'dbGetAllSongs') assert.deepStrictEqual(done.value, [{ id: 'x' }]);
  }

  for (const event of ['request-error', 'transaction-error', 'abort', 'success-then-abort', 'sync-transaction', 'sync-store']){
    const { storage, opens } = setup();
    const db = makeDB();
    if (event === 'sync-transaction') db.transaction = function(){ throw new Error('transaction threw'); };
    if (event === 'sync-store') db.transaction = function(){ return { objectStore(){ throw new Error('store threw'); } }; };
    const promise = storage.dbSaveSong({ id: 'x' });
    promise.catch(function(){});
    succeedOpen(opens[0], db);
    await nextTurn();
    const tx = db.transactionCalls[0];
    if (event === 'request-error') tx.request.onerror({ target: { error: new Error('request failed') } });
    else if (event === 'transaction-error') tx.onerror({ target: { error: new Error('transaction failed') } });
    else if (event === 'abort') tx.onabort({ target: { error: new Error('aborted') } });
    else if (event === 'success-then-abort'){
      tx.request.result = [];
      tx.request.onsuccess({ target: tx.request });
      tx.onabort({ target: { error: new Error('aborted after request') } });
    }
    await settle(promise, 'reject');
  }

  {
    const { storage, opens } = setup();
    const first = storage.openDB();
    failOpen(opens[0], new Error('open failed'));
    await settle(first, 'reject');
    const second = storage.openDB();
    assert.strictEqual(opens.length, 2);
    const db = makeDB();
    succeedOpen(opens[1], db);
    assert.strictEqual(await second, db);
  }
  {
    const { storage, opens } = setup();
    const a = storage.openDB();
    const b = storage.openDB();
    assert.strictEqual(opens.length, 1);
    const db = makeDB();
    succeedOpen(opens[0], db);
    assert.strictEqual(await a, db);
    assert.strictEqual(await b, db);
  }
  {
    const { storage, opens } = setup();
    const pending = storage.openDB();
    opens[0].onblocked({ target: opens[0] });
    await settle(pending, 'reject');
    const lateDB = makeDB();
    succeedOpen(opens[0], lateDB);
    assert.strictEqual(lateDB.closed, true);
    const retry = storage.openDB();
    const newDB = makeDB();
    succeedOpen(opens[1], newDB);
    assert.strictEqual(await retry, newDB);
  }
  {
    const { storage, opens } = setup();
    const first = storage.openDB();
    const db1 = makeDB();
    succeedOpen(opens[0], db1);
    await first;
    db1.onversionchange();
    assert.strictEqual(db1.closed, true);
    const second = storage.openDB();
    assert.strictEqual(opens.length, 2);
    const db2 = makeDB();
    succeedOpen(opens[1], db2);
    assert.strictEqual(await second, db2);
  }
  console.log('test-storage: 13 scenarios passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
