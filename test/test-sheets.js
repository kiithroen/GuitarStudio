const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const parserSource = fs.readFileSync(path.join(__dirname, '../src/parser.js'), 'utf8');
const notationSource = fs.readFileSync(path.join(__dirname, '../src/notation.js'), 'utf8');
const sheetsSource = fs.readFileSync(path.join(__dirname, '../src/sheets.js'), 'utf8');

let checks = 0;
async function test(name, fn){ await fn(); checks++; process.stdout.write('ok ' + checks + ' - ' + name + '\n'); }
function makeHarness(){
  const elements = Object.create(null);
  const timers = new Map();
  const scripts = [];
  const lsData = Object.create(null);
  let timerId = 0;
  function element(id){
    if (!elements[id]) elements[id] = { id, value: '', textContent: '', hidden: true, listeners: [], addEventListener(type, fn){ this.listeners.push({ type, fn }); } };
    return elements[id];
  }
  const document = {
    head: { appendChild(script){ script.parentNode = this; scripts.push(script); }, removeChild(script){ script.parentNode = null; } },
    createElement(tag){ return { tagName: tag.toUpperCase(), parentNode: null, src: '', onerror: null }; },
    querySelector(selector){ return element(selector.slice(1)); }
  };
  const context = {
    console, document, window: null,
    fetch: async () => ({ ok: false }),
    setTimeout(fn, delay){ const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id){ timers.delete(id); },
    Date, Math, Promise, encodeURIComponent,
    navigator: { clipboard: { writeText: async () => {} } },
    alert(){}, prompt(){}, confirm(){ return true; },
    ls: { get(key, fallback){ return Object.prototype.hasOwnProperty.call(lsData, key) ? lsData[key] : fallback; }, set(key, value){ lsData[key] = value; } },
    appState: { lastSongId: 'builtin-last' }, BUILTIN_SONGS: [],
    rebuildSongSelect(id){ context.rebuilt.push(id); }, rebuilt: [],
    curSong: null
  };
  context.$ = function(selector){ return document.querySelector(selector); };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(notationSource, context, { filename: 'notation.js' });
  vm.runInContext(parserSource, context, { filename: 'parser.js' });
  vm.runInContext(sheetsSource, context, { filename: 'sheets.js' });
  return { context, elements, timers, scripts, lsData };
}
function callbackName(script){ return /responseHandler:([^&]+)/.exec(script.src)[1]; }
function respond(script, value){ script.parentNode; script.parentNode && script.parentNode.removeChild(script); }

async function run(){
const h = makeHarness();
await test('extracts spreadsheet id and gid from URL and raw id', function(){
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.extractSheetIdAndGid('https://docs.google.com/spreadsheets/d/Abc-123_x/edit#gid=42'))), { sheetId: 'Abc-123_x', gid: '42' });
  assert.equal(h.context.extractSheetIdAndGid('a'.repeat(20)).gid, '0');
  assert.equal(h.context.extractSheetIdAndGid('invalid'), null);
});
await test('JSONP success cleans script, callback, and timeout', async function(){
  const pending = h.context.loadSheetViaJsonp('sheetId', '7');
  const script = h.scripts.at(-1); const cb = callbackName(script); const timer = [...h.timers.keys()][0];
  assert.match(script.src, /\/gviz\/tq\?tqx=responseHandler:/);
  h.context[cb]({ table: { rows: [{ c: [{ v: 'Song' }, null, { f: '64' }] }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [['Song', '', '64']]);
  assert.equal(h.context[cb], undefined); assert.equal(script.parentNode, null); assert.equal(h.timers.has(timer), false);
});
await test('JSONP error and timeout clean all pending resources', async function(){
  const failed = h.context.loadSheetViaJsonp('sheetId', '0');
  const badScript = h.scripts.at(-1); const badCb = callbackName(badScript); const badTimer = [...h.timers.keys()][0];
  h.context[badCb]({ status: 'error' });
  await assert.rejects(failed, /시트 데이터를 읽지 못했어요/);
  assert.equal(h.context[badCb], undefined); assert.equal(badScript.parentNode, null); assert.equal(h.timers.has(badTimer), false);
  const timed = h.context.loadSheetViaJsonp('sheetId', '0');
  const timedScript = h.scripts.at(-1); const timedCb = callbackName(timedScript); const timedTimer = [...h.timers.keys()][0];
  h.timers.get(timedTimer).fn();
  await assert.rejects(timed, /응답 시간 초과/);
  assert.equal(h.context[timedCb], undefined); assert.equal(timedScript.parentNode, null); assert.equal(h.timers.has(timedTimer), false);
});
await test('sync parses every sheet row without applying or changing legacy visibility and title keys', async function(){
  const ls = h.context.ls;
  ls.set('gs.hiddenSheetSongs', ['Hidden']);
  ls.set('gs.sheetTitleOverrides', { 'sheet-song-3': 'Override title' });
  const promise = h.context.syncGoogleSheetSongs('https://docs.google.com/spreadsheets/d/sheet1234567890123456/edit?gid=5', false);
  const cb = callbackName(h.scripts.at(-1));
  h.context[cb]({ table: { rows: [
    { c: [{ v: '곡 제목' }] },
    { c: [{ v: 'Visible' }, { v: '4' }, { v: '90' }, { v: 'badge' }, { v: '[C] C4 - - - | one / lyric' }] },
    { c: [{ v: 'Hidden' }, { v: '4' }, { v: '80' }, { v: 'badge' }, { v: '[G] G3 - - - | lyric/slash' }] },
    { c: [{ v: 'Override me' }, { v: '[G] 2E3/0G3 - - - | lyric / slash' }] },
    { c: [{ v: 'Right hand' }, { v: '[C] C4:i 1C4@2:i+E4:a - -' }] }
  ] } });
  assert.equal(await promise, true);
  assert.equal(h.context.sheetSongs.length, 4);
  assert.equal(h.context.sheetSongs[0].id, 'sheet-song-1');
  assert.equal(h.context.sheetSongs[0].measures.length, 1);
  assert.equal(h.context.sheetSongs[0].measures[0].lyric, 'one / lyric');
  assert.equal(h.context.sheetSongs[1].title, 'Hidden');
  assert.equal(h.context.sheetSongs[1].measures[0].lyric, 'lyric/slash');
  assert.equal(h.context.sheetSongs[1].measures.length, 1);
  assert.equal(h.context.sheetSongs[2].title, 'Override me');
  assert.equal(h.context.sheetSongs[3].measures[0].beats[0].tok, 'C4:i');
  assert.equal(h.context.sheetSongs[3].measures[0].beats[1].tok, '1C4@2:i+E4:a');
  assert.deepEqual(JSON.parse(JSON.stringify(ls.get('gs.hiddenSheetSongs', null))), ['Hidden']);
  assert.deepEqual(JSON.parse(JSON.stringify(ls.get('gs.sheetTitleOverrides', null))), { 'sheet-song-3': 'Override title' });
  assert.equal(h.context.rebuilt.at(-1), 'sheet-song-1');

  ls.set('gs.hiddenSheetSongs', ['Hidden']);
  const silent = h.context.syncGoogleSheetSongs('https://docs.google.com/spreadsheets/d/sheet1234567890123456/edit', true);
  const silentCb = callbackName(h.scripts.at(-1));
  h.context[silentCb]({ table: { rows: [
    { c: [{ v: 'Visible' }, { v: '4' }, { v: '90' }, { v: 'badge' }, { v: '[C] C4 - - -' }] },
    { c: [{ v: 'Hidden' }, { v: '4' }, { v: '80' }, { v: 'badge' }, { v: '[G] G3 - - -' }] }
  ] } });
  assert.equal(await silent, true);
  assert.equal(h.context.sheetSongs.length, 2);
  assert.equal(h.context.sheetSongs[0].title, 'Visible');
  assert.equal(h.context.sheetSongs[1].title, 'Hidden');
  assert.deepEqual(JSON.parse(JSON.stringify(ls.get('gs.hiddenSheetSongs', null))), ['Hidden']);
  assert.equal(h.context.rebuilt.at(-1), 'builtin-last');
});
await test('invalid sheet row preserves previous songs and settings', async function(){
  const ls = h.context.ls;
  const previous = h.context.sheetSongs.slice();
  const previousUrl = ls.get('gs.sheetUrl', '');
  ls.set('gs.hiddenSheetSongs', ['Keep hidden']);
  const promise = h.context.syncGoogleSheetSongs('https://docs.google.com/spreadsheets/d/sheet1234567890123456/edit', false);
  const cb = callbackName(h.scripts.at(-1));
  h.context[cb]({ table: { rows: [
    { c: [{ v: 'Bad row' }, { v: '4' }, { v: '80' }, { v: 'badge' }, { v: '[C] C4 H4 - -' }] }
  ] } });
  assert.equal(await promise, false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.sheetSongs)), JSON.parse(JSON.stringify(previous)));
  assert.equal(ls.get('gs.sheetUrl', ''), previousUrl);
  assert.deepEqual(JSON.parse(JSON.stringify(ls.get('gs.hiddenSheetSongs', []))), ['Keep hidden']);
  assert.match(h.elements.sheetSyncStatus.textContent, /1행/);
  assert.equal(h.context.rebuilt.at(-1), 'builtin-last');
});
await test('silent sync failure explains itself on the main screen and success clears it', async function(){
  const url = 'https://docs.google.com/spreadsheets/d/sheet1234567890123456/edit';
  const badRows = { table: { rows: [
    { c: [{ v: 'Bad row' }, { v: '4' }, { v: '80' }, { v: 'badge' }, { v: '[C] C4 H4 - -' }] }
  ] } };
  const goodRows = { table: { rows: [
    { c: [{ v: 'Good row' }, { v: '4' }, { v: '80' }, { v: 'badge' }, { v: '[C] C4 - - -' }] }
  ] } };
  async function syncSilent(rows){
    const pending = h.context.syncGoogleSheetSongs(url, true);
    h.context[callbackName(h.scripts.at(-1))](rows);
    return pending;
  }
  assert.equal(await syncSilent(badRows), false);
  assert.equal(h.elements.sheetLoadStatus.hidden, false);
  assert.match(h.elements.sheetLoadStatus.textContent, /구글 시트를 불러오지 못했어/);
  assert.match(h.elements.sheetLoadStatus.textContent, /1행/);
  assert.match(h.elements.sheetSyncStatus.textContent, /불러오기 실패/);

  assert.equal(await syncSilent(goodRows), true);
  assert.equal(h.elements.sheetLoadStatus.hidden, true);
  assert.equal(h.elements.sheetLoadStatus.textContent, '');

  assert.equal(await syncSilent(badRows), false);
  assert.equal(h.elements.sheetLoadStatus.hidden, false);
  h.context.allSongs = [];
  h.context.initSheetSync();
  const clear = h.elements.clearSheetSyncBtn.listeners.find(function(l){ return l.type === 'click'; });
  clear.fn();
  assert.equal(h.elements.sheetLoadStatus.hidden, true);
  assert.equal(h.elements.sheetLoadStatus.textContent, '');
});
await test('removed apoyando aliases and malformed right-hand suffixes block sheet imports', async function(){
  const previous = JSON.parse(JSON.stringify(h.context.sheetSongs));
  for (const token of ['C4>', 'C4^', 'C4:i!']){
    const pending = h.context.syncGoogleSheetSongs('https://docs.google.com/spreadsheets/d/sheet1234567890123456/edit', false);
    const cb = callbackName(h.scripts.at(-1));
    h.context[cb]({ table: { rows: [
      { c: [{ v: 'Invalid token' }, { v: '4' }, { v: '80' }, { v: 'badge' }, { v: '[C] ' + token + ' - - -' }] }
    ] } });
    assert.equal(await pending, false, token + ' is rejected');
    assert.deepEqual(JSON.parse(JSON.stringify(h.context.sheetSongs)), previous, token + ' leaves existing sheet songs intact');
  }
});
await test('initSheetSync registers handlers once and keeps manual/silent behaviors distinct', function(){
  h.context.initSheetSync(); h.context.initSheetSync();
  assert.equal(h.elements.openSheetSyncBtn.listeners.length, 1);
  assert.equal(h.elements.syncSheetNowBtn.listeners.length, 1);
  assert.equal(h.elements.copySheetTemplateBtn.listeners.length, 1);
});
process.stdout.write('1..' + checks + '\n');
}
run().catch(function(error){ console.error(error); process.exitCode = 1; });
