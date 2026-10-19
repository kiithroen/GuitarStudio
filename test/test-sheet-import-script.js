const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const scorePrompt = require('../src/score-prompt.js');

const scriptSource = fs.readFileSync(path.join(__dirname, '../tools/sheet-import-script.js'), 'utf8');

let checks = 0;
function test(name, fn){ fn(); checks++; process.stdout.write('ok ' + checks + ' - ' + name + '\n'); }
function plain(value){ return JSON.parse(JSON.stringify(value)); }

const exampleCols = scorePrompt.EXAMPLE_TSV_ROW.split('\t');
assert.equal(exampleCols.length, 5);
// 예시 행에서 제목(과 필요하면 설명)만 바꾼 열 배열
function colsFor(title, description){
  const cols = exampleCols.slice();
  cols[0] = title;
  if (description !== undefined) cols[3] = description;
  return cols;
}
function rowFor(title, description){ return colsFor(title, description).join('\t'); }

const HEADER = ['곡 제목', '칸 수', 'BPM', '설명', '악보'];

// 가짜 시트: 2차원 배열을 들고 서식과 쓰기 순서를 기록한다.
function makeSheet(rows){
  const data = rows.map(function(r){ return r.slice(); });
  const formats = Object.create(null);
  const sheet = {
    data, formats, writes: [], formatCalls: [],
    getLastRow(){
      let last = 0;
      data.forEach(function(r, i){ if (r.some(function(v){ return v !== ''; })) last = i + 1; });
      return last;
    },
    getRange(row, col, numRows, numCols){
      const nr = numRows === undefined ? 1 : numRows;
      const nc = numCols === undefined ? 1 : numCols;
      return {
        getValue(){ return (data[row - 1] || [])[col - 1] === undefined ? '' : data[row - 1][col - 1]; },
        getValues(){
          const out = [];
          for (let i = 0; i < nr; i++){
            const line = [];
            for (let j = 0; j < nc; j++){
              const v = (data[row - 1 + i] || [])[col - 1 + j];
              line.push(v === undefined ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        setNumberFormat(fmt){
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) formats[(row + i) + ',' + (col + j)] = fmt;
          sheet.formatCalls.push({ row, col, nr, nc, fmt });
        },
        setValues(values){
          assert.equal(values.length, nr);
          const snapshot = [];
          for (let i = 0; i < nr; i++){
            assert.equal(values[i].length, nc);
            while (data.length < row + i) data.push(['', '', '', '', '']);
            const line = [];
            for (let j = 0; j < nc; j++){
              line.push(formats[(row + i) + ',' + (col + j)]);
              data[row - 1 + i][col - 1 + j] = values[i][j];
            }
            snapshot.push(line);
          }
          sheet.writes.push({ row, col, nr, nc, formatsAtWrite: snapshot });
        }
      };
    }
  };
  return sheet;
}

function makeFile(id, name, text, extra){
  return Object.assign({ id, name, text, trashed: false, updated: new Date(2026, 9, 1, 12, 0, 0) }, extra || {});
}
function iter(list){
  let i = 0;
  return { hasNext(){ return i < list.length; }, next(){ return list[i++]; } };
}

// 컨텍스트에 가짜 Apps Script 객체를 넣고 스크립트를 읽는다.
function makeWorld(options){
  const opts = options || {};
  const sheet = makeSheet(opts.sheetRows || [HEADER]);
  // name 이 null 이면 스크립트의 FOLDER_NAME 으로 본다
  const folders = opts.folders || [{ name: null, trashed: false, files: [] }];
  const props = Object.create(null);
  const alerts = [];
  const logs = [];
  const triggers = (opts.triggers || []).map(function(handler){ return { handler, getHandlerFunction(){ return handler; } }; });
  const deleted = [];
  const created = [];
  const lock = { tryLockArgs: [], released: 0, tryLock(ms){ this.tryLockArgs.push(ms); return opts.locked !== true; }, releaseLock(){ this.released++; } };
  const world = { sheet, folders, props, alerts, logs, triggers, deleted, created, lock };
  const ctx = {
    console: { log(message){ logs.push(String(message)); } },
    SpreadsheetApp: {
      getUi(){
        if (opts.uiThrows) throw new Error('no ui');
        return { alert(message){ alerts.push(String(message)); }, createMenu(){ throw new Error('unused'); } };
      },
      getActiveSpreadsheet(){
        return { getSheets(){ return [sheet]; }, getSheetByName(){ return null; } };
      }
    },
    DriveApp: {
      getFoldersByName(name){
        const found = folders.filter(function(f){ return (f.name === null ? ctx.FOLDER_NAME : f.name) === name; });
        return iter(found.map(function(f){
          return {
            isTrashed(){ return f.trashed; },
            getFiles(){
              return iter(f.files.map(function(file){
                return {
                  isTrashed(){ return file.trashed; },
                  getName(){ return file.name; },
                  getId(){ return file.id; },
                  getLastUpdated(){ return file.updated; },
                  getBlob(){ return { getDataAsString(enc){ assert.equal(enc, 'UTF-8'); return file.text; } }; }
                };
              }));
            }
          };
        }));
      }
    },
    PropertiesService: {
      getScriptProperties(){
        return {
          getProperty(key){ return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null; },
          setProperty(key, value){ props[key] = value; }
        };
      }
    },
    LockService: { getScriptLock(){ return lock; } },
    ScriptApp: {
      getProjectTriggers(){ return triggers.slice(); },
      deleteTrigger(trigger){ deleted.push(trigger.handler); const i = triggers.indexOf(trigger); if (i >= 0) triggers.splice(i, 1); },
      newTrigger(handler){
        const record = { handler, minutes: null };
        const builder = {
          timeBased(){ return builder; },
          everyMinutes(n){ record.minutes = n; return builder; },
          create(){ created.push(record); triggers.push({ handler, getHandlerFunction(){ return handler; } }); return record; }
        };
        return builder;
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(scriptSource, ctx, { filename: 'sheet-import-script.js' });
  world.ctx = ctx;
  return world;
}

function worldWithFiles(files, sheetRows, extra){
  return makeWorld(Object.assign({ sheetRows, folders: [{ name: null, trashed: false, files }] }, extra || {}));
}

test('parseScoreTsv reads BOM, CRLF and blank lines with original line numbers and trimmed columns', function(){
  const w = makeWorld();
  const padded = colsFor('A').map(function(c){ return ' ' + c + ' '; }).join('\t');
  const text = '\uFEFF' + [padded, '', '   ', rowFor('B')].join('\r\n');
  const out = plain(w.ctx.parseScoreTsv(text, 'x.tsv'));
  assert.equal(out.errors.length, 0);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].file, 'x.tsv');
  assert.equal(out.rows[0].line, 1);
  assert.equal(out.rows[1].line, 4);
  assert.deepEqual(out.rows[0].cols, colsFor('A'));
  assert.deepEqual(out.rows[1].cols, colsFor('B'));
});

test('parseScoreTsv reports wrong column count, empty title and empty score without keeping the row', function(){
  const w = makeWorld();
  const count = w.ctx.COLUMN_COUNT;
  const fourCols = colsFor('A').slice(0, count - 1).join('\t');
  const noTitle = colsFor('').join('\t');
  const noScore = colsFor('C').slice(0, 4).concat(['']).join('\t');
  const bothEmpty = colsFor('').slice(0, 4).concat(['']).join('\t');
  const text = [fourCols, noTitle, noScore, bothEmpty, rowFor('OK')].join('\n');
  const out = plain(w.ctx.parseScoreTsv(text, 'bad.tsv'));
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].cols[0], 'OK');
  assert.equal(out.rows[0].line, 5);
  assert.equal(out.errors.length, 4);
  assert.equal(out.errors[0].file, 'bad.tsv');
  assert.equal(out.errors[0].line, 1);
  assert.match(out.errors[0].message, new RegExp(String(count - 1)));
  assert.match(out.errors[0].message, new RegExp(String(count)));
  assert.equal(out.errors[1].line, 2);
  assert.match(out.errors[1].message, /제목/);
  assert.equal(out.errors[2].line, 3);
  assert.match(out.errors[2].message, /악보/);
  assert.equal(out.errors[3].line, 4);
  assert.match(out.errors[3].message, /제목/);
  assert.doesNotMatch(out.errors[3].message, /악보/);
});

test('toCellRow writes beats and BPM as numbers and keeps everything else text', function(){
  const w = makeWorld();
  assert.deepEqual(plain(w.ctx.toCellRow(['제목', '4', '80', '3/4', 'C4 - - -'])), ['제목', 4, 80, '3/4', 'C4 - - -']);
  assert.deepEqual(plain(w.ctx.toCellRow(['123', 'abc', '8x', '12', '34'])), ['123', 'abc', '8x', '12', '34']);
  const out = w.ctx.toCellRow(colsFor('T'));
  assert.equal(typeof out[0], 'string');
  assert.equal(typeof out[1], 'number');
  assert.equal(typeof out[2], 'number');
  assert.equal(typeof out[3], 'string');
  assert.equal(typeof out[4], 'string');
});

test('planImport drops header titles, updates by row, appends, counts unchanged and skips duplicate titles', function(){
  const w = makeWorld();
  const entry = function(file, title, changed, desc){
    return { file, fileKey: 'id-' + file, line: 1, cols: colsFor(title, desc), changed };
  };
  const entries = [
    entry('h.tsv', '곡 제목', true),
    entry('a.tsv', 'A', true, 'new'),
    entry('c.tsv', 'C', true),
    entry('d.tsv', 'D', false),
    entry('e1.tsv', 'E', true),
    entry('e2.tsv', 'E', true)
  ];
  const plan = plain(w.ctx.planImport(['X', 'A', 'D'], '곡 제목', entries));
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].row, 3);
  assert.deepEqual(plan.updates[0].values, plain(w.ctx.toCellRow(colsFor('A', 'new'))));
  assert.equal(plan.appends.length, 1);
  assert.equal(plan.appends[0][0], 'C');
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].title, 'E');
  assert.deepEqual(plan.duplicates[0].files, ['e1.tsv', 'e2.tsv']);
  assert.deepEqual(plan.duplicates[0].fileKeys, ['id-e1.tsv', 'id-e2.tsv']);
});

// 5, 6, 7 은 같은 세계를 이어서 쓴다.
const seq = worldWithFiles([
  makeFile('idA', 'A.tsv', rowFor('A', 'from file A') + '\n'),
  makeFile('idB', 'B.tsv', rowFor('B', 'from file B') + '\n')
], [HEADER, ['A', '4', '80', 'old desc', 'old score']]);
const expectedA = [colsFor('A')[0], Number(exampleCols[1]), Number(exampleCols[2]), 'from file A', exampleCols[4]];
const expectedB = ['B', Number(exampleCols[1]), Number(exampleCols[2]), 'from file B', exampleCols[4]];

test('first run overwrites the matching title, appends new ones, formats text columns before values and records stamps', function(){
  seq.ctx.importScoresFromMenu();
  assert.deepEqual(plain(seq.sheet.data[0]), HEADER);
  assert.deepEqual(plain(seq.sheet.data[1]), expectedA);
  assert.deepEqual(plain(seq.sheet.data[2]), expectedB);
  assert.equal(typeof seq.sheet.data[2][1], 'number');
  assert.equal(typeof seq.sheet.data[2][2], 'number');
  assert.equal(seq.sheet.writes.length, 2);
  const textColumns = plain(seq.ctx.TEXT_COLUMNS);
  seq.sheet.writes.forEach(function(write){
    write.formatsAtWrite.forEach(function(line){
      textColumns.forEach(function(c){ assert.equal(line[c], '@', 'column ' + c + ' has text format when the value is written'); });
    });
  });
  const stamp = String(seq.folders[0].files[0].updated.getTime());
  assert.equal(seq.props[seq.ctx.PROP_PREFIX + 'idA'], stamp);
  assert.equal(seq.props[seq.ctx.PROP_PREFIX + 'idB'], stamp);
  assert.equal(seq.alerts.length, 1);
  assert.match(seq.alerts[0], /추가 1곡 · 갱신 1곡 · 변경 없음 0곡/);
});

test('second run with unchanged files writes nothing and keeps hand edits', function(){
  seq.sheet.data[1][3] = 'hand edit';
  const before = plain(seq.sheet.data);
  const writes = seq.sheet.writes.length;
  seq.ctx.importScoresFromMenu();
  assert.equal(seq.sheet.writes.length, writes);
  assert.deepEqual(plain(seq.sheet.data), before);
  assert.equal(seq.sheet.data[1][3], 'hand edit');
  assert.match(seq.alerts[1], /추가 0곡 · 갱신 0곡 · 변경 없음 2곡/);
});

test('a file whose last-updated time changed overwrites its row again', function(){
  seq.folders[0].files[0].updated = new Date(2026, 9, 2, 12, 0, 0);
  const writes = seq.sheet.writes.length;
  seq.ctx.importScoresFromMenu();
  assert.equal(seq.sheet.writes.length, writes + 1);
  assert.deepEqual(plain(seq.sheet.data[1]), expectedA);
  assert.deepEqual(plain(seq.sheet.data[2]), expectedB);
  assert.match(seq.alerts[2], /추가 0곡 · 갱신 1곡 · 변경 없음 1곡/);
});

function badFileWorld(extra){
  const text = [rowFor('C', 'from bad file'), colsFor('Z').slice(0, 4).join('\t')].join('\n');
  return worldWithFiles([makeFile('idBad', 'bad.tsv', text)], [HEADER], extra);
}

test('a file with a broken line skips that line, is not recorded, and reports by file name', function(){
  const w = badFileWorld();
  let thrown = null;
  try { w.ctx.importScores(); } catch (e) { thrown = e; }
  assert.ok(thrown, 'importScores throws');
  assert.match(thrown.message, /bad\.tsv/);
  assert.match(thrown.message, /2행/);
  assert.equal(w.sheet.data.length, 2);
  assert.equal(w.sheet.data[1][0], 'C');
  assert.equal(Object.keys(w.props).length, 0);
  assert.equal(w.logs.at(-1), thrown.message);

  const menu = badFileWorld();
  menu.ctx.importScoresFromMenu();
  assert.equal(menu.alerts.length, 1);
  assert.match(menu.alerts[0], /bad\.tsv 2행/);
  assert.equal(Object.keys(menu.props).length, 0);

  const noUi = badFileWorld({ uiThrows: true });
  noUi.ctx.importScoresFromMenu();
  assert.equal(noUi.logs.length, 1);
  assert.equal(noUi.logs[0], thrown.message);
});

test('trashed files and non-tsv files are ignored', function(){
  const w = worldWithFiles([
    makeFile('t1', 'trashed.tsv', rowFor('Trashed') + '\n', { trashed: true }),
    makeFile('t2', 'notes.txt', rowFor('Notes') + '\n'),
    makeFile('t3', 'keep.tsv', rowFor('Keep') + '\n')
  ], [HEADER]);
  w.ctx.importScoresFromMenu();
  assert.deepEqual(plain(w.sheet.data.map(function(r){ return r[0]; })), [HEADER[0], 'Keep']);
  assert.deepEqual(Object.keys(w.props), [w.ctx.PROP_PREFIX + 't3']);
});

test('folder errors: none, several, and a trashed folder next to a normal one', function(){
  const none = makeWorld({ folders: [] });
  assert.throws(function(){ none.ctx.runImport_(); }, function(e){ return e.message === '드라이브에서 "' + none.ctx.FOLDER_NAME + '" 폴더를 찾지 못했습니다.'; });
  assert.equal(none.lock.released, 1);

  const name = none.ctx.FOLDER_NAME;
  const twoFolders = makeWorld({ folders: [{ name, trashed: false, files: [] }, { name, trashed: false, files: [] }] });
  assert.throws(function(){ twoFolders.ctx.runImport_(); }, function(e){ return e.message === '드라이브에 "' + name + '" 폴더가 여러 개 있습니다. 하나만 남기세요.'; });

  const menu = makeWorld({ folders: [] });
  assert.doesNotThrow(function(){ menu.ctx.importScoresFromMenu(); });
  assert.match(menu.alerts[0], /폴더를 찾지 못했습니다/);

  const mixed = makeWorld({
    sheetRows: [HEADER],
    folders: [
      { name, trashed: true, files: [makeFile('o', 'old.tsv', rowFor('Old') + '\n')] },
      { name, trashed: false, files: [makeFile('n', 'new.tsv', rowFor('New') + '\n')] }
    ]
  });
  mixed.ctx.importScoresFromMenu();
  assert.deepEqual(plain(mixed.sheet.data.map(function(r){ return r[0]; })), [HEADER[0], 'New']);
});

test('an empty sheet reports the missing header row', function(){
  const w = worldWithFiles([makeFile('a', 'a.tsv', rowFor('A') + '\n')], []);
  assert.throws(function(){ w.ctx.runImport_(); }, /머리글/);
  assert.equal(w.sheet.writes.length, 0);
  assert.equal(w.lock.released, 1);
});

test('setup removes only importScores triggers, creates a timer trigger and removeTriggers leaves others', function(){
  const w = worldWithFiles([makeFile('a', 'a.tsv', rowFor('A') + '\n')], [HEADER], { triggers: ['importScores', 'other', 'importScores'] });
  w.ctx.setup();
  assert.deepEqual(w.deleted, ['importScores', 'importScores']);
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].handler, 'importScores');
  assert.equal(w.created[0].minutes, w.ctx.TRIGGER_MINUTES);
  assert.deepEqual(w.triggers.map(function(t){ return t.handler; }).sort(), ['importScores', 'other']);
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0], new RegExp(String(w.ctx.TRIGGER_MINUTES) + '분마다'));
  assert.equal(w.sheet.data[1][0], 'A');

  w.ctx.removeTriggers();
  assert.deepEqual(w.triggers.map(function(t){ return t.handler; }), ['other']);
  assert.match(w.alerts[1], /껐습니다/);
});

test('a lock that cannot be taken returns busy without touching the sheet', function(){
  const w = worldWithFiles([makeFile('a', 'a.tsv', rowFor('A') + '\n')], [HEADER], { locked: true });
  const result = plain(w.ctx.runImport_());
  assert.equal(result.busy, true);
  assert.equal(w.sheet.writes.length, 0);
  assert.equal(w.sheet.formatCalls.length, 0);
  assert.equal(Object.keys(w.props).length, 0);
  assert.match(w.ctx.summarize(result), /진행 중/);
  w.ctx.importScoresFromMenu();
  assert.match(w.alerts[0], /진행 중/);
  assert.equal(w.sheet.data.length, 1);
});

process.stdout.write('1..' + checks + '\n');
