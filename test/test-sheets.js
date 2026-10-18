'use strict';

const assert = require('node:assert/strict');
const Sheets = require('../src/sheets.js');
let checks = 0;
async function check(name, fn){ await fn(); checks++; process.stdout.write('ok ' + checks + ' - ' + name + '\n'); }

(async function(){
await check('extracts spreadsheet id and gid', function(){
  assert.deepEqual(Sheets.extractSheetIdAndGid('https://docs.google.com/spreadsheets/d/Abc-123_x/edit#gid=42'), { sheetId: 'Abc-123_x', gid: '42' });
  assert.equal(Sheets.extractSheetIdAndGid('invalid'), null);
});
await check('quotes tabs and preserves quotes, carriage returns, and newlines in TSV cells', function(){
  const song = { title: 'Title\tinside', description: 'say "yes"\r\nnext', format: 'alphatex', alphaTex: '\\title "A"\n:4 0.1' };
  const tsv = Sheets.toTsv(song);
  assert.equal(tsv, '"Title\tinside"\t"say ""yes""\r\nnext"\t"\\title ""A""\n:4 0.1"');
});
await check('parses three columns and accepts a valid alphaTex validator', function(){
  const rows = [['제목', '설명', 'alphaTex'], ['Piece', 'Short note', ':4 0.1 1.1 0.1 1.1']];
  const list = Sheets.parseRows(rows, function(text){ assert.match(text, /:4/); });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Piece');
  assert.equal(list[0].description, 'Short note');
  assert.equal(list[0].alphaTex, rows[1][2]);
  assert.equal(list[0].notationVersion, 3);
  assert.equal(list[0].fromSheet, true);
});
await check('rejects legacy five-column rows and leaves parsing atomic', function(){
  const rows = [['good', '', ':4 0.1'], ['legacy', '4', '64', 'badge', 'C4 - - -']];
  let committed = ['previous'];
  assert.throws(function(){ committed = Sheets.parseRows(rows, function(){}); }, /구형 5열/);
  assert.deepEqual(committed, ['previous']);
});
await check('rejects any invalid row with its row number', function(){
  assert.throws(function(){
    Sheets.parseRows([['One', '', ':4 0.1'], ['Broken', '', 'bad']], function(text){ if (text === 'bad') throw new Error('bad alphaTex'); });
  }, /시트 2행: bad alphaTex/);
});
await check('JSONP success and timeout both clean callback, script, and timer', async function(){
  const scripts = [];
  const timers = new Map();
  const windowStub = {};
  const documentStub = { head: { appendChild(script){ script.parentNode = this; scripts.push(script); }, removeChild(script){ script.parentNode = null; } }, createElement(){ return { parentNode: null }; } };
  let id = 0;
  const options = { document: documentStub, window: windowStub, setTimeout(fn, ms){ const timer = ++id; timers.set(timer, { fn, ms }); return timer; }, clearTimeout(timer){ timers.delete(timer); } };
  const pending = Sheets.loadSheetViaJsonp('sheetid', '1', options);
  const script = scripts[0]; const callbackName = /responseHandler:([^&]+)/.exec(script.src)[1]; const timer = [...timers.keys()][0];
  windowStub[callbackName]({ table: { rows: [{ c: [{ v: 'A' }, { v: 'B' }, { v: 'C' }] }] } });
  assert.deepEqual(await pending, [['A', 'B', 'C']]);
  assert.equal(windowStub[callbackName], undefined);
  assert.equal(script.parentNode, null);
  assert.equal(timers.has(timer), false);
  const timed = Sheets.loadSheetViaJsonp('sheetid', '1', options);
  const timedScript = scripts[1]; const timedCallback = /responseHandler:([^&]+)/.exec(timedScript.src)[1]; const timedTimer = [...timers.keys()][0];
  timers.get(timedTimer).fn();
  await assert.rejects(timed, /응답 시간 초과/);
  assert.equal(windowStub[timedCallback], undefined);
  assert.equal(timedScript.parentNode, null);
  assert.equal(timers.has(timedTimer), false);
});

process.stdout.write('1..' + checks + '\n');
})().catch(function(error){ console.error(error); process.exitCode = 1; });
