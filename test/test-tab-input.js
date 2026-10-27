const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const notation = require('../src/notation.js');
const parser = require('../src/parser.js');
const ti = require('../src/tab-input.js');

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

function pos(m, c, s){ return { m: m, c: c || 0, s: s || 0 }; }
// 첫 마디 첫 칸에 음들을 넣는다. 항목은 [줄, 프렛].
function put(doc, p, items){ items.forEach(function(item){ ti.setNote(doc, p, item[0], item[1]); }); }
function tokens(doc){ return ti.docToMeasureObjects(doc).map(function(m){ return m.notes; }); }
function fresh(options){ return ti.createDoc(options); }

test('note token: string number always written, optional fingering, articulation and check mark', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0), 3, 2);
  assert.equal(ti.docToMeasureObjects(doc)[0].notes[0], 'A3@3');
  assert.deepEqual(ti.setNoteAttrs(doc, pos(0), 3, { lh: 2, rh: 'i', art: '!', uncertain: true }), { ok: true });
  assert.equal(ti.docToMeasureObjects(doc)[0].notes[0], '!2A3@3:i?');
  assert.equal(ti.noteToken(doc, 3, doc.measures[0].cells[0].slots[0].notes[2]), '!2A3@3:i?');
  assert.equal(ti.noteToken(doc, 1, { fret: 0, lh: 0, rh: null, art: '!', uncertain: false }), '!0E4@1');
});

test('chord notes are joined from the lowest pitch, thicker string first on equal pitch', function(){
  const doc = fresh();
  put(doc, pos(0), [[6, 0], [1, 0], [3, 0]]);
  assert.equal(tokens(doc)[0][0], 'E2@6+G3@3+E4@1');
  const same = fresh();
  put(same, pos(0), [[2, 0], [3, 4]]);
  assert.equal(tokens(same)[0][0], 'B3@3+B3@2');
});

test('empty slots become - while sound continues and r at the start or after a rest, across measures', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), 1, 0);
  ti.setRest(doc, pos(0, 2), true);
  assert.deepEqual(tokens(doc)[0], ['E4@1', '-', 'r', 'r']);
  const start = fresh();
  ti.setNote(start, pos(0, 1), 1, 0);
  assert.deepEqual(tokens(start)[0], ['r', 'E4@1', '-', '-']);
  const across = fresh();
  ti.setNote(across, pos(0, 3), 1, 0);
  ti.insertEmptyMeasure(across, 1);
  assert.deepEqual(tokens(across)[1], ['-', '-', '-', '-']);
  const after = fresh();
  ti.insertEmptyMeasure(after, 1);
  assert.deepEqual(tokens(after)[1], ['r', 'r', 'r', 'r']);
});

test('slotTokens: tokens per measure, cell and slot; the cell lines still come from the reduced tokens', function(){
  const text = '[-] C4 - E4/r G4 | ""\n[-] - - r A4/B4 | ""';
  const read = ti.scoreToDoc({ beats: 4, raw: text });
  assert.equal(read.error, undefined);
  assert.deepEqual(ti.slotTokens(read.doc), [
    [['C4@2'], ['-'], ['E4@1', 'r'], ['G4@1']],
    [['-'], ['-'], ['r'], ['A4@1', 'B4@1']]
  ]);
  assert.deepEqual(ti.docToScoreLines(read.doc), ['[-] C4@2 - E4@1/r G4@1 | ""', '[-] - - r A4@1/B4@1 | ""']);
  const empty = ti.slotTokens(fresh());
  assert.deepEqual(empty, [[['r'], ['r'], ['r'], ['r']]]);
  const across = fresh();
  ti.setNote(across, pos(0, 3), 1, 0);
  ti.insertEmptyMeasure(across, 1);
  assert.deepEqual(ti.slotTokens(across)[1], [['-'], ['-'], ['-'], ['-']], 'sounding continues across the measure');
});

test('divided cells are shortened only when the sound stays the same', function(){
  function cellWith(division, fill, before){
    const doc = fresh();
    let target = 0;
    if (before){ ti.setNote(doc, pos(0, 0), 1, 0); target = 1; }
    ti.setDivision(doc, 0, target, division);
    fill(doc, target);
    return tokens(doc)[0][target];
  }
  const X = [1, 0], Y = [1, 1];
  assert.equal(cellWith(2, function(d, c){ put(d, pos(0, c, 0), [X]); }, false), 'E4@1');
  assert.equal(cellWith(4, function(d, c){ put(d, pos(0, c, 0), [X]); put(d, pos(0, c, 2), [Y]); }, false), 'E4@1/F4@1');
  assert.equal(cellWith(2, function(d, c){ ti.setRest(d, pos(0, c, 0), true); ti.setRest(d, pos(0, c, 1), true); }, false), 'r');
  assert.equal(cellWith(2, function(d, c){ ti.setRest(d, pos(0, c, 0), true); ti.setRestUncertain(d, pos(0, c, 0), true); ti.setRest(d, pos(0, c, 1), true); }, false), 'r?');
  assert.equal(cellWith(4, function(d, c){ put(d, pos(0, c, 0), [X]); put(d, pos(0, c, 3), [Y]); }, false), 'E4@1/-/-/F4@1');
  assert.equal(cellWith(3, function(d, c){ put(d, pos(0, c, 0), [X]); }, false), 'E4@1');
  assert.equal(cellWith(2, function(d, c){ put(d, pos(0, c, 1), [X]); }, false), 'r/E4@1');
  assert.equal(cellWith(2, function(d, c){ put(d, pos(0, c, 1), [X]); }, true), '-/E4@1');
});

test('accidentals setting picks sharp or flat spelling', function(){
  const sharp = fresh({ accidentals: 'sharp' });
  ti.setNote(sharp, pos(0), 3, 3);
  assert.equal(tokens(sharp)[0][0], 'A#3@3');
  const flat = fresh({ accidentals: 'flat' });
  ti.setNote(flat, pos(0), 3, 3);
  assert.equal(tokens(flat)[0][0], 'Bb3@3');
});

test('chord field and memo reach the measure line; quoted memo with // stays one measure', function(){
  const doc = fresh();
  assert.ok(ti.docToScoreLines(doc)[0].startsWith('[-] '));
  ti.setMeasureChord(doc, 0, '?');
  assert.ok(ti.docToScoreLines(doc)[0].startsWith('[?] '));
  ti.setMeasureChord(doc, 0, ' Am ');
  assert.ok(ti.docToScoreLines(doc)[0].startsWith('[Am] '));
  const memo = 'a "q" // b';
  ti.setMeasureMemo(doc, 0, memo);
  const line = ti.docToScoreLines(doc)[0];
  assert.ok(line.indexOf(JSON.stringify(memo)) > 0);
  assert.equal(parser.validateScore(line, 4).errors.length, 0);
  assert.equal(notation.splitScoreMeasures(ti.docScoreText(doc)).length, 1);
  assert.equal(notation.decodeMeasureLine(line).lyric, memo);
});

test('validateDoc: a document using every feature has no errors or warnings; a bad chord is INVALID_CHORD', function(){
  const doc = fresh({ accidentals: 'flat' });
  ti.setMeasureChord(doc, 0, 'Am');
  ti.setMeasureMemo(doc, 0, 'memo');
  put(doc, pos(0, 0), [[5, 0], [3, 2], [2, 1]]);
  ti.setNoteAttrs(doc, pos(0, 0), 5, { lh: 0, rh: 'p' });
  ti.setNoteAttrs(doc, pos(0, 0), 3, { lh: 2, rh: 'i', uncertain: true });
  ti.setNoteAttrs(doc, pos(0, 0), 2, { art: '!' });
  ti.setDivision(doc, 0, 1, 2);
  put(doc, pos(0, 1, 0), [[1, 0]]);
  put(doc, pos(0, 1, 1), [[1, 3]]);
  ti.setNoteAttrs(doc, pos(0, 1, 0), 1, { art: '!' });
  ti.setDivision(doc, 0, 2, 4);
  put(doc, pos(0, 2, 0), [[2, 3]]);
  put(doc, pos(0, 2, 2), [[2, 1]]);
  ti.setRest(doc, pos(0, 2, 3), true);
  ti.setRestUncertain(doc, pos(0, 2, 3), true);
  ti.insertEmptyMeasure(doc, 1);
  ti.setDivision(doc, 1, 0, 3);
  put(doc, pos(1, 0, 0), [[3, 3]]);
  put(doc, pos(1, 0, 1), [[3, 0]]);
  ti.setRest(doc, pos(1, 0, 2), true);
  ti.setRest(doc, pos(1, 1), true);
  const result = ti.validateDoc(doc);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  ti.setMeasureChord(doc, 0, 'xyz');
  const bad = ti.validateDoc(doc);
  const invalid = bad.errors.find(function(e){ return e.code === 'INVALID_CHORD'; });
  assert.ok(invalid);
  assert.equal(invalid.measure, 1);
});

test('setDivision keeps slots whose start position still lines up and counts lost non-empty ones', function(){
  function make(division, fills){
    const doc = fresh();
    ti.setDivision(doc, 0, 0, division);
    fills.forEach(function(fret, i){ if (fret != null) ti.setNote(doc, pos(0, 0, i), 1, fret); });
    return doc;
  }
  function frets(doc){
    return doc.measures[0].cells[0].slots.map(function(slot){ return slot.notes[0] ? slot.notes[0].fret : null; });
  }
  let doc = make(2, [1, 2]);
  assert.deepEqual(ti.setDivision(doc, 0, 0, 4), { ok: true, lost: 0 });
  assert.deepEqual(frets(doc), [1, null, 2, null]);
  doc = make(2, [1, 2]);
  assert.deepEqual(ti.setDivision(doc, 0, 0, 3), { ok: true, lost: 1 });
  assert.deepEqual(frets(doc), [1, null, null]);
  doc = make(4, [1, 2, 3, 4]);
  assert.deepEqual(ti.setDivision(doc, 0, 0, 2), { ok: true, lost: 2 });
  assert.deepEqual(frets(doc), [1, 3]);
  doc = make(4, [1, null, 3, null]);
  assert.deepEqual(ti.setDivision(doc, 0, 0, 2), { ok: true, lost: 0 }, 'empty slots do not count');
  assert.throws(function(){ ti.setDivision(doc, 0, 0, 5); });
});

test('setBeats cuts trailing cells counting lost content and appends empty cells', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0, 3), 1, 0);
  ti.setNote(doc, pos(0, 0), 1, 0);
  assert.deepEqual(ti.setBeats(doc, 3), { ok: true, lost: 1 });
  assert.equal(doc.beats, 3);
  assert.equal(doc.measures[0].cells.length, 3);
  assert.deepEqual(ti.setBeats(doc, 4), { ok: true, lost: 0 });
  assert.equal(doc.measures[0].cells.length, 4);
  assert.equal(ti.getSlot(doc, pos(0, 3)).notes.every(function(n){ return n === null; }), true);
  assert.throws(function(){ ti.setBeats(doc, 5); });
});

test('measure operations: insert, duplicate, delete, clear, copy, paste, positions', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0), 1, 0);
  ti.setMeasureChord(doc, 0, 'Am');
  assert.deepEqual(ti.insertEmptyMeasure(doc, 1), { ok: true });
  ti.insertEmptyMeasure(doc, 0);
  assert.equal(doc.measures.length, 3);
  assert.equal(doc.measures[1].chord, 'Am');
  assert.deepEqual(ti.duplicateRange(doc, 1, 1), { ok: true, inserted: 1 });
  assert.equal(doc.measures.length, 4);
  assert.deepEqual(doc.measures[1], doc.measures[2]);
  assert.notEqual(doc.measures[1], doc.measures[2]);
  assert.deepEqual(ti.deleteRange(doc, 0, 0), { ok: true, removed: 1 });
  assert.deepEqual(ti.deleteRange(doc, 0, doc.measures.length - 1), { ok: false });
  assert.equal(doc.measures.length, 3);
  assert.deepEqual(ti.clearRange(doc, 0, 0), { ok: true });
  assert.equal(doc.measures[0].chord, '');
  assert.equal(ti.getSlot(doc, pos(0)).notes[0], null);
  const copied = ti.copyRange(doc, 1, 2);
  assert.equal(copied.length, 2);
  copied[0].chord = 'changed';
  assert.equal(doc.measures[1].chord, 'Am');
  const result = ti.pasteAfter(doc, -1, ti.copyRange(doc, 1, 1));
  assert.deepEqual(result, { ok: true, inserted: 1, lost: 0 });
  assert.equal(doc.measures[0].chord, 'Am');
  assert.equal(doc.measures.length, 4);
  // 칸 수가 다른 마디를 붙이면 맞춰진다
  const wide = fresh({ beats: 6 });
  ti.setNote(wide, pos(0, 5), 1, 0);
  ti.setNote(wide, pos(0, 1), 1, 0);
  const target = fresh({ beats: 4 });
  const cut = ti.pasteAfter(target, 0, wide.measures);
  assert.deepEqual(cut, { ok: true, inserted: 1, lost: 1 });
  assert.equal(target.measures[1].cells.length, 4);
  const narrow = fresh({ beats: 2 });
  const fill = ti.pasteAfter(target, 1, narrow.measures);
  assert.equal(fill.lost, 0);
  assert.equal(target.measures[2].cells.length, 4);
  // 위치
  assert.deepEqual(ti.firstPos(), { m: 0, c: 0, s: 0 });
  assert.deepEqual(ti.clampPos(doc, { m: 99, c: 99, s: 99 }), { m: doc.measures.length - 1, c: 3, s: 0 });
  assert.deepEqual(ti.clampPos(doc, { m: -3, c: -1, s: -1 }), { m: 0, c: 0, s: 0 });
  const divided = fresh();
  ti.setDivision(divided, 0, 0, 2);
  ti.insertEmptyMeasure(divided, 1);
  assert.deepEqual(ti.nextPos(divided, pos(0, 0, 0)), pos(0, 0, 1));
  assert.deepEqual(ti.nextPos(divided, pos(0, 0, 1)), pos(0, 1, 0));
  assert.deepEqual(ti.nextPos(divided, pos(0, 3, 0)), pos(1, 0, 0));
  assert.deepEqual(ti.prevPos(divided, pos(1, 0, 0)), pos(0, 3, 0));
  assert.deepEqual(ti.prevPos(divided, pos(0, 1, 0)), pos(0, 0, 1));
  assert.equal(ti.nextPos(divided, pos(1, 3, 0)), null);
  assert.equal(ti.prevPos(divided, pos(0, 0, 0)), null);
  assert.equal(ti.isValidPos(divided, pos(0, 0, 2)), false);
  assert.equal(ti.getSlot(divided, pos(9)), null);
});

test('note edits: set replaces and clears rest, toggle, remove, attrs, rest and clear', function(){
  const doc = fresh();
  const p = pos(0);
  ti.setRest(doc, p, true);
  ti.setRestUncertain(doc, p, true);
  assert.equal(ti.getSlot(doc, p).restUncertain, true);
  ti.setNote(doc, p, 2, 3);
  assert.equal(ti.getSlot(doc, p).rest, false);
  assert.equal(ti.getSlot(doc, p).restUncertain, false);
  ti.setNoteAttrs(doc, p, 2, { lh: 3 });
  ti.setNote(doc, p, 2, 5);
  assert.equal(ti.getSlot(doc, p).notes[1].lh, null, 'replacing a note drops its fingering');
  assert.deepEqual(ti.toggleNote(doc, p, 2, 5), { ok: true, action: 'removed' });
  assert.deepEqual(ti.toggleNote(doc, p, 2, 5), { ok: true, action: 'set' });
  assert.deepEqual(ti.toggleNote(doc, p, 2, 6), { ok: true, action: 'set' });
  assert.equal(ti.getSlot(doc, p).notes[1].fret, 6);
  assert.deepEqual(ti.removeNote(doc, p, 2), { ok: true });
  assert.deepEqual(ti.removeNote(doc, p, 2), { ok: false });
  assert.deepEqual(ti.setNoteAttrs(doc, p, 2, { lh: 1 }), { ok: false });
  assert.deepEqual(ti.setRestUncertain(doc, p, true), { ok: false });
  put(doc, p, [[1, 0], [2, 0]]);
  assert.deepEqual(ti.setRest(doc, p, true), { ok: true, removedNotes: 2 });
  assert.equal(ti.getSlot(doc, p).notes.every(function(n){ return n === null; }), true);
  assert.deepEqual(ti.setRest(doc, p, false), { ok: true, removedNotes: 0 });
  assert.equal(ti.getSlot(doc, p).rest, false);
  ti.setNote(doc, p, 1, 0);
  assert.deepEqual(ti.clearSlot(doc, p), { ok: true });
  assert.equal(ti.hasContent(doc), false);
  assert.throws(function(){ ti.setNote(doc, p, 7, 0); });
  assert.throws(function(){ ti.setNote(doc, p, 1, ti.MAX_FRET + 1); });
  assert.throws(function(){ ti.setNote(doc, pos(5), 1, 0); });
  put(doc, p, [[1, 0]]);
  assert.throws(function(){ ti.setNoteAttrs(doc, p, 1, { rh: 'x' }); });
  assert.throws(function(){ ti.setNoteAttrs(doc, p, 1, { lh: 5 }); });
  assert.throws(function(){ ti.setNoteAttrs(doc, p, 1, { art: '>' }); });
  assert.throws(function(){ ti.setNoteAttrs(doc, p, 1, { art: '~' }); }, /주법/, 'the removed tirando value ~ is refused');
  assert.equal(ti.getSlot(doc, p).notes[0].art, null, 'a refused attribute leaves the note unchanged');
  assert.equal(ti.hasContent(doc), true);
  const memoOnly = fresh();
  ti.setMeasureMemo(memoOnly, 0, 'x');
  assert.equal(ti.hasContent(memoOnly), true);
  const twoMeasures = fresh();
  ti.insertEmptyMeasure(twoMeasures, 1);
  assert.equal(ti.hasContent(twoMeasures), true);
});

test('history: record, undo, redo order; limit drops oldest; record clears redo', function(){
  const history = ti.createHistory(3);
  assert.equal(history.canUndo(), false);
  assert.equal(history.undo({ n: 0 }), null);
  assert.equal(history.redo({ n: 0 }), null);
  history.record({ n: 1 });
  history.record({ n: 2 });
  assert.equal(history.canUndo(), true);
  assert.deepEqual(history.undo({ n: 3 }), { n: 2 });
  assert.deepEqual(history.undo({ n: 2 }), { n: 1 });
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), true);
  assert.deepEqual(history.redo({ n: 1 }), { n: 2 });
  assert.deepEqual(history.redo({ n: 2 }), { n: 3 });
  assert.equal(history.canRedo(), false);
  history.record({ n: 4 });
  history.undo({ n: 5 });
  assert.equal(history.canRedo(), true);
  history.record({ n: 6 });
  assert.equal(history.canRedo(), false, 'record clears redo');
  history.clear();
  assert.equal(history.canUndo(), false);
  for (let i = 1; i <= 5; i++) history.record({ n: i });
  const seen = [];
  let current = { n: 6 };
  for (let step = history.undo(current); step; step = history.undo(current)){ seen.push(step.n); current = step; }
  assert.deepEqual(seen, [5, 4, 3], 'limit 3 keeps only the newest three');
  const stored = { n: 1, list: [1] };
  history.record(stored);
  stored.list.push(2);
  assert.deepEqual(history.undo({}).list, [1], 'recorded documents are snapshots');
});

test('normalizeDoc accepts a valid document as a copy and rejects broken shapes', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0), 1, 0);
  const normalized = ti.normalizeDoc(doc);
  assert.ok(normalized.doc);
  assert.deepEqual(normalized.doc, doc);
  assert.notEqual(normalized.doc, doc);
  assert.notEqual(normalized.doc.measures[0], doc.measures[0]);
  function broken(mutate){
    const copy = ti.cloneDoc(doc);
    mutate(copy);
    const result = ti.normalizeDoc(copy);
    assert.equal(typeof result.error, 'string');
    assert.equal(result.doc, undefined);
  }
  broken(function(d){ d.beats = 5; });
  broken(function(d){ d.measures[0].cells[0].slots[0].notes[0].fret = ti.MAX_FRET + 1; });
  broken(function(d){ d.measures[0].cells[0].slots[0].notes.pop(); });
  broken(function(d){ d.measures[0].cells[0].slots[0].rest = true; });
  broken(function(d){ d.version = 2; });
  broken(function(d){ d.bpm = 10; });
  broken(function(d){ d.accidentals = 'natural'; });
  broken(function(d){ d.measures = []; });
  broken(function(d){ d.measures[0].cells.pop(); });
  broken(function(d){ d.measures[0].cells[0].slots = []; });
  broken(function(d){ d.measures[0].cells[0].slots[0].notes[0].lh = 5; });
  broken(function(d){ d.measures[0].cells[0].slots[0].notes[0].rh = 'x'; });
  broken(function(d){ d.measures[0].cells[0].slots[0].notes[0].art = '>'; });
  broken(function(d){ d.measures[0].cells[0].slots[0].notes[0].uncertain = 1; });
  broken(function(d){ d.title = 3; });
  broken(function(d){ d.measures[0].chord = null; });
  assert.equal(typeof ti.normalizeDoc(null).error, 'string');
});

test('normalizeDoc reads a stored art "~" (the removed tirando mark) as no mark instead of rejecting the document', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0), 1, 0);
  ti.setNote(doc, pos(0), 2, 1);
  const stored = ti.cloneDoc(doc);
  stored.measures[0].cells[0].slots[0].notes[0].art = '~';
  stored.measures[0].cells[0].slots[0].notes[1].art = '!';
  const before = JSON.stringify(stored);
  const result = ti.normalizeDoc(stored);
  assert.equal(result.error, undefined);
  const notes = result.doc.measures[0].cells[0].slots[0].notes;
  assert.equal(notes[0].art, null, '~ becomes null');
  assert.equal(notes[1].art, '!', '! stays');
  assert.equal(JSON.stringify(stored), before, 'the stored object is not mutated');
  assert.equal(ti.docToMeasureObjects(result.doc)[0].notes[0], '!C4@2+E4@1', 'the migrated note is written without a tirando mark and the apoyando note keeps its !');
  assert.deepEqual(ti.validateDoc(result.doc).errors, []);
});

test('parseImportText refuses a ~ on a single note or inside a chord with the roll message', function(){
  for (const text of ['[-] ~E4 r r r', '[-] E4 ~B3@2 r r', '[-] E2+~B3 r r r']){
    const parsed = ti.parseImportText(text, { title: 't' });
    assert.equal(parsed.doc, undefined, text + ' is not imported');
    assert.ok(String(parsed.error).indexOf('롤 ~는 +로 묶은 화음(두 음 이상)의 맨 앞에만 붙입니다: ') >= 0, text + ' shows the message: ' + parsed.error);
  }
});

test('roll: createSlot starts without a roll', function(){
  assert.equal(ti.createSlot().roll, false);
  const doc = fresh();
  assert.equal(doc.measures[0].cells[0].slots[0].roll, false);
});

test('roll: a ~ chord round-trips text to document to text, whole cells and split parts', function(){
  const text = [
    '[-] ~E2@6+B3@2+G4@1 ~E2@6:p+hE5@1 ~E2@6+B3@2? E2@6+B3@2 | ""',
    '[-] C3@5/~A3@3+D4@2+F#4@1 ~C3@5+E4@1/E4@1 r r | ""'
  ].join('\n');
  const result = ti.scoreToDoc({ beats: 4, raw: text });
  assert.equal(result.error, undefined);
  const cells =result.doc.measures[0].cells;
  assert.deepEqual(cells.map(cell => cell.slots[0].roll), [true, true, true, false]);
  const split = result.doc.measures[1].cells[0].slots;
  assert.deepEqual(split.map(slot => slot.roll), [false, true], 'only the split part with ~ is rolled');
  assert.equal(ti.docScoreText(result.doc), text, 'exported text equals the imported text');
  assert.deepEqual(ti.scoreToDoc({ beats: 4, raw: ti.docScoreText(result.doc) }).doc.measures, result.doc.measures);
  assert.deepEqual(ti.validateDoc(result.doc).errors, []);
});

test('roll: ~ is written only while the part has two or more notes, and the flag survives', function(){
  const doc = fresh();
  put(doc, pos(0), [[6, 0], [2, 0], [1, 0]]);
  doc.measures[0].cells[0].slots[0].roll = true;
  assert.equal(tokens(doc)[0][0], '~E2@6+B3@2+E4@1');
  ti.removeNote(doc, pos(0), 1);
  assert.equal(tokens(doc)[0][0], '~E2@6+B3@2', 'two notes keep the ~');
  ti.removeNote(doc, pos(0), 2);
  assert.equal(tokens(doc)[0][0], 'E2@6', 'one note drops the ~');
  assert.equal(doc.measures[0].cells[0].slots[0].roll, true, 'the flag is kept');
  ti.setNote(doc, pos(0), 1, 0);
  assert.equal(tokens(doc)[0][0], '~E2@6+E4@1', 'adding a note back revives the roll');
  assert.deepEqual(ti.scoreToDoc({ beats: 4, raw: ti.docScoreText(doc) }).error, undefined);
});

test('roll: slotRollShown follows the rule that the export uses', function(){
  const doc = fresh();
  const slot = doc.measures[0].cells[0].slots[0];
  assert.equal(ti.slotRollShown(null), false);
  assert.equal(ti.slotRollShown(slot), false, 'an empty slot');
  put(doc, pos(0), [[6, 0], [2, 0]]);
  assert.equal(ti.slotRollShown(slot), false, 'two notes without the flag');
  slot.roll = true;
  assert.equal(ti.slotRollShown(slot), true);
  assert.equal(tokens(doc)[0][0].charAt(0), '~', 'the export writes ~ exactly when slotRollShown is true');
  ti.removeNote(doc, pos(0), 2);
  assert.equal(ti.slotRollShown(slot), false, 'one note');
  assert.equal(tokens(doc)[0][0].charAt(0) === '~', false);
  ti.setNote(doc, pos(0), 2, 0);
  slot.rest = true;
  assert.equal(ti.slotRollShown(slot), false, 'a rest never shows a roll');
});

test('roll: setRoll turns the roll on and off for a chord and refuses one note or a rest', function(){
  const doc = fresh();
  put(doc, pos(0), [[6, 0], [2, 0], [1, 0]]);
  const slot = doc.measures[0].cells[0].slots[0];
  assert.deepEqual(ti.setRoll(doc, pos(0), true), { ok: true });
  assert.equal(slot.roll, true);
  assert.equal(ti.slotRollShown(slot), true);
  assert.equal(tokens(doc)[0][0].charAt(0), '~');
  assert.deepEqual(ti.setRoll(doc, pos(0), false), { ok: true });
  assert.equal(slot.roll, false);
  assert.equal(tokens(doc)[0][0].charAt(0) === '~', false);

  // 한 음
  put(doc, pos(0, 1), [[3, 0]]);
  const before = JSON.stringify(doc);
  const single = ti.setRoll(doc, pos(0, 1), true);
  assert.equal(single.ok, false);
  assert.equal(single.error, ti.ROLL_ERROR);
  assert.equal(JSON.stringify(doc), before, 'the document is untouched when the roll is refused');
  // 빈 조각, 쉼
  assert.equal(ti.setRoll(doc, pos(0, 2), true).ok, false);
  ti.setRest(doc, pos(0, 3), true);
  const restBefore = JSON.stringify(doc);
  const rest = ti.setRoll(doc, pos(0, 3), true);
  assert.deepEqual([rest.ok, rest.error], [false, ti.ROLL_ERROR]);
  assert.equal(JSON.stringify(doc), restBefore);
  // 끄기는 조건 없이 된다
  assert.deepEqual(ti.setRoll(doc, pos(0, 1), false), { ok: true });
  assert.throws(() => ti.setRoll(doc, pos(9), true), /올바르지 않은 위치/);
});

test('roll: setRoll round-trips through the exported text', function(){
  const doc = fresh();
  put(doc, pos(0), [[6, 0], [2, 0], [1, 0]]);
  ti.setRoll(doc, pos(0), true);
  const text = ti.docScoreText(doc);
  const back = ti.scoreToDoc({ beats: 4, raw: text });
  assert.equal(back.error, undefined);
  assert.equal(back.doc.measures[0].cells[0].slots[0].roll, true);
  assert.equal(ti.docScoreText(back.doc), text);
});

test('roll: setRest(true) and clearSlot turn the roll off, setRest(false) leaves it', function(){
  const doc = fresh();
  put(doc, pos(0), [[6, 0], [1, 0]]);
  doc.measures[0].cells[0].slots[0].roll = true;
  ti.setRest(doc, pos(0), true);
  assert.equal(doc.measures[0].cells[0].slots[0].roll, false);
  assert.equal(tokens(doc)[0][0], 'r');
  put(doc, pos(0, 1), [[6, 0], [1, 0]]);
  doc.measures[0].cells[1].slots[0].roll = true;
  ti.clearSlot(doc, pos(0, 1));
  assert.equal(doc.measures[0].cells[1].slots[0].roll, false);
  put(doc, pos(0, 2), [[6, 0], [1, 0]]);
  doc.measures[0].cells[2].slots[0].roll = true;
  ti.setRest(doc, pos(0, 2), false);
  assert.equal(doc.measures[0].cells[2].slots[0].roll, true, 'turning a rest off is not a clear');
});

test('roll: normalizeDoc reads old documents without roll as false and refuses a non-boolean roll', function(){
  const doc = fresh();
  put(doc, pos(0), [[6, 0], [1, 0]]);
  const old = JSON.parse(JSON.stringify(doc));
  old.measures.forEach(m => m.cells.forEach(c => c.slots.forEach(slot => { delete slot.roll; })));
  const before = JSON.stringify(old);
  const result = ti.normalizeDoc(old);
  assert.equal(result.error, undefined);
  assert.ok(result.doc.measures.every(m => m.cells.every(c => c.slots.every(slot => slot.roll === false))), 'missing roll becomes false');
  assert.equal(JSON.stringify(old), before, 'the stored object is not mutated');

  const rolled = JSON.parse(JSON.stringify(doc));
  rolled.measures[0].cells[0].slots[0].roll = true;
  assert.equal(ti.normalizeDoc(rolled).doc.measures[0].cells[0].slots[0].roll, true, 'true is kept');
  const restRoll = JSON.parse(JSON.stringify(fresh()));
  restRoll.measures[0].cells[0].slots[0].rest = true;
  restRoll.measures[0].cells[0].slots[0].roll = true;
  assert.equal(ti.normalizeDoc(restRoll).error, undefined, 'a rolled rest slot is not an error');

  for (const bad of ['yes', 1, null]){
    const broken = JSON.parse(JSON.stringify(doc));
    broken.measures[0].cells[0].slots[0].roll = bad;
    const refused = ti.normalizeDoc(broken);
    assert.ok(String(refused.error).indexOf('롤 표시는 true/false여야 합니다.') >= 0, JSON.stringify(bad) + ' is refused: ' + refused.error);
  }
});

test('parseImportText: TSV row fields, plain score, and the error cases', function(){
  const row = ['제목', '3', '90', '설명 Capo 2', '[Am] E4@1 - - | "m"'].join('\t');
  const parsed = ti.parseImportText(row, { title: 'x', bpm: 70, description: 'y' });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.doc.title, '제목');
  assert.equal(parsed.doc.beats, 3);
  assert.equal(parsed.doc.bpm, 90);
  assert.equal(parsed.doc.description, '설명 Capo 2');
  assert.equal(parsed.doc.measures[0].chord, 'Am');
  assert.equal(parsed.doc.measures[0].memo, 'm');
  assert.equal(ti.parseImportText(['t', '4', '500', 'd', '[-] r r r r'].join('\t'), {}).doc.bpm, 240);
  assert.equal(ti.parseImportText(['t', '4', '5', 'd', '[-] r r r r'].join('\t'), {}).doc.bpm, 30);
  const current = { title: '지금', bpm: 77, description: '설명' };
  const plain = ti.parseImportText('[-] E4 - -\n[-] r r r', current);
  assert.equal(plain.doc.beats, 3);
  assert.equal(plain.doc.title, '지금');
  assert.equal(plain.doc.bpm, 77);
  assert.equal(plain.doc.description, '설명');
  assert.equal(plain.doc.measures.length, 2);
  assert.match(ti.parseImportText(['t', '4', '64', '[-] r r r r'].join('\t'), current).error, /^열이 5개 또는 6개여야 합니다/);
  // 6번째 열(원본 alphaTex)은 받되 버린다
  const withTex = ti.parseImportText(['t', '4', '64', 'd', '[-] E4 r r r', '\\title "x" \\tempo 64 0.1.4 |'].join('\t'), current);
  assert.equal(withTex.error, undefined);
  assert.deepEqual([withTex.doc.title, withTex.doc.beats, withTex.doc.bpm, withTex.doc.description], ['t', 4, 64, 'd']);
  assert.deepEqual(withTex.doc, ti.parseImportText(['t', '4', '64', 'd', '[-] E4 r r r'].join('\t'), current).doc, 'the sixth column leaves no trace');
  assert.match(ti.parseImportText(['t', '4', '64', 'd', '[-] r r r r', 'x', 'y'].join('\t'), current).error, /^열이 5개 또는 6개여야 합니다.*지금 7개\./);
  assert.match(ti.parseImportText(['t', '5', '64', 'd', '[-] r r r r r'].join('\t'), current).error, /^칸 수는 2, 3, 4, 6, 8, 9 중 하나여야 합니다: 5$/);
  assert.match(ti.parseImportText(['t', '4', '0', 'd', '[-] r r r r'].join('\t'), current).error, /^BPM은 1 이상의 정수여야 합니다: 0$/);
  assert.match(ti.parseImportText(['t', '4', 'x', 'd', '[-] r r r r'].join('\t'), current).error, /^BPM은/);
  assert.equal(ti.parseImportText('   \n ', current).error, '불러올 악보가 비어 있습니다.');
  assert.match(ti.parseImportText('[-] r r r r r', current).error, /^첫 마디 칸 수\(5\)가 2, 3, 4, 6, 8, 9 중 하나가 아닙니다\.$/);
  const unknown = ti.parseImportText('[-] Q9 r r r', current);
  assert.ok(unknown.error.indexOf('(마디 1') > 0, unknown.error);
  const collide = ti.parseImportText('[-] E4+F4 r r r', current);
  assert.match(collide.error, /1번 줄에 겹칩니다/);
  assert.match(collide.error, /^마디 1, 칸 1:/);
});

test('import detects the accidental spelling from the source tokens', function(){
  function accidentals(text){ return ti.parseImportText(text, {}).doc.accidentals; }
  assert.equal(accidentals('[-] Bb3 r r r'), 'flat');
  assert.equal(accidentals('[-] A#3 r r r'), 'sharp');
  assert.equal(accidentals('[-] Bb3 A#3 r r'), 'sharp');
  assert.equal(accidentals('[-] E4 r r r'), 'sharp');
  assert.equal(accidentals('[-] 2Bb3@3:i+E2 r r r'), 'flat');
});

test('import keeps string, fret, fingering, articulation and check marks', function(){
  const parsed = ti.parseImportText('[-] !2A3@3:i?+E2 B3@2/r? r r', { title: 't' });
  assert.equal(parsed.error, undefined);
  const slots = parsed.doc.measures[0].cells[0].slots;
  assert.deepEqual(slots[0].notes[2], { fret: 2, lh: 2, rh: 'i', art: '!', uncertain: true });
  assert.deepEqual(slots[0].notes[5], { fret: 0, lh: null, rh: null, art: null, uncertain: false });
  const second = parsed.doc.measures[0].cells[1].slots;
  assert.deepEqual(second[0].notes[1], { fret: 0, lh: null, rh: null, art: null, uncertain: false });
  assert.equal(second[1].rest, true);
  assert.equal(second[1].restUncertain, true);
  assert.equal(parsed.doc.measures[0].chord, '');
  assert.equal(ti.parseImportText('E4 r r r', {}).doc.measures[0].chord, '?');
  assert.equal(ti.parseImportText('[?] E4 r r r', {}).doc.measures[0].chord, '?');
  assert.equal(ti.parseImportText('[] E4 r r r', {}).doc.measures[0].chord, '?');
});

// ---- 내장곡 왕복

// 한 악보(줄 목록)에서 시작 시각별 사건 목록을 만든다. 소리가 같은지 비교하려는 테스트 안 함수다.
function soundEvents(lines, beats){
  const events = [];
  let previous = null;
  lines.forEach(function(line, m){
    const tokens = notation.tokenizeMeasureBeats(notation.decodeMeasureLine(line).notation);
    tokens.forEach(function(token, c){
      const parts = notation.splitBeatSubtokens(token);
      parts.forEach(function(part, i){
        const time = (m * beats + c + i / parts.length).toFixed(6);
        const text = part.trim();
        if (text === '-') return;
        if (notation.isRestToken(text)){
          if (text === 'r' && previous && previous.rest) return;
          previous = { rest: true, uncertain: text !== 'r' };
          events.push({ time: time, rest: true, uncertain: text !== 'r' });
          return;
        }
        const notes = text.split('+').map(function(token){
          const parsed = parser.parseNoteToken(token.trim(), 0);
          return {
            midi: parsed.midi, str: parsed.pos.str, fret: parsed.pos.fret,
            lh: parsed.pos.lh, rh: parsed.pos.rh,
            art: parsed.explicitArticulation ? parsed.articulation : null,
            uncertain: !!parsed.uncertain
          };
        });
        notes.sort(function(a, b){ return a.midi - b.midi || b.str - a.str; });
        previous = { rest: false };
        events.push({ time: time, notes: notes });
      });
    });
  });
  return events;
}

function measureMeta(lines){
  return lines.map(function(line){
    const decoded = notation.decodeMeasureLine(line);
    let chord = decoded.chordRaw;
    if (chord == null || chord === '' || chord === '?') chord = '?';
    return { chord: chord, memo: decoded.lyric };
  });
}

test('round trip over every built-in song: imports, exports clean, and sounds the same', function(){
  const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '../songs.json'), 'utf8'));
  assert.ok(songs.length > 0);
  songs.forEach(function(song){
    const lines = notation.splitScoreMeasures(song.lines);
    const imported = ti.scoreToDoc({ title: song.title, beats: song.beats, bpm: song.bpm, description: song.badge || '', raw: song.lines });
    assert.equal(imported.error, undefined, song.id + ': ' + imported.error);
    assert.equal(ti.normalizeDoc(imported.doc).error, undefined, song.id + ' normalizes');
    const exported = ti.docToScoreLines(imported.doc);
    const check = parser.validateScore(exported.join('\n'), song.beats);
    assert.deepEqual(check.errors, [], song.id + ' export errors');
    assert.deepEqual(check.warnings, [], song.id + ' export warnings');
    assert.equal(exported.length, lines.length, song.id + ' measure count');
    assert.deepEqual(soundEvents(exported, song.beats), soundEvents(lines, song.beats), song.id + ' sounds the same');
    assert.deepEqual(measureMeta(exported), measureMeta(lines), song.id + ' chords and memos');
  });
  process.stdout.write('  round trip songs: ' + songs.length + '\n');
});

test('handoff fields and capo from the description', function(){
  const doc = fresh({ title: '  곡  ', description: ' Capo 3 ', bpm: 80, beats: 3 });
  ti.setNote(doc, pos(0), 1, 0);
  const handoff = ti.buildHandoff(doc, 12345);
  assert.equal(handoff.title, '곡');
  assert.equal(handoff.beats, 3);
  assert.equal(handoff.bpm, 80);
  assert.equal(handoff.badge, 'Capo 3');
  assert.equal(handoff.savedAt, 12345);
  assert.deepEqual(handoff.lines, ti.docToScoreLines(doc));
  assert.equal(ti.docCapo(doc), 3);
  assert.equal(ti.docCapo(fresh()), 0);
  assert.equal(ti.buildHandoff(fresh({ title: '   ' }), 1).title, '새 악보');
  assert.equal(ti.createDoc().title, ti.DEFAULT_TITLE);
  assert.equal(ti.createDoc().bpm, ti.DEFAULT_BPM);
});

test('handoff unchanged: the signature taken right after loading marks an untouched export and nothing else', function(){
  const loaded = ti.scoreToDoc({ title: '곡', beats: 4, bpm: 70, description: '설명', raw: '[C] C4 D4 E4 F4\n[G] G4 A4 _ _' });
  assert.equal(loaded.error, undefined);
  const doc = loaded.doc;
  doc.sourceId = 'sheet-1';
  const baseline = ti.handoffSignature(doc);
  assert.equal(typeof baseline, 'string');
  assert.equal(ti.buildHandoff(doc, 1).unchanged, undefined, 'without a baseline nothing is marked');
  assert.equal(ti.buildHandoff(doc, 1, null).unchanged, undefined);
  assert.equal(ti.buildHandoff(doc, 1, baseline).unchanged, true, 'the same export is unchanged');
  assert.equal(ti.buildHandoff(doc, 2, baseline).unchanged, true, 'the time of saving is not compared');
  const retitled = JSON.parse(JSON.stringify(doc));
  retitled.title = '다른 제목';
  assert.equal(ti.buildHandoff(retitled, 1, baseline).unchanged, true, 'the title is not compared (the copy title comes from the original)');
  const edits = {
    note: d => ti.setNote(d, pos(0, 0, 0), 1, 3),
    capo: d => { d.description = '설명 Capo 2'; },
    bpm: d => { d.bpm = 71; },
    beats: d => { d.beats = 3; },
    key: d => { d.key = 2; },
    source: d => { d.sourceId = 'sheet-2'; }
  };
  Object.keys(edits).forEach(function(name){
    const changed = JSON.parse(JSON.stringify(doc));
    try { edits[name](changed); } catch (error) { /* beats 변경은 마디 모양이 안 맞아 던질 수 있다: 서명이 달라지는지만 본다 */ }
    assert.notEqual(ti.handoffSignature(changed), baseline, name + ' changes the signature');
    assert.equal(ti.buildHandoff(changed, 1, baseline).unchanged, undefined, name + ' is not marked unchanged');
  });
});

test('key signature: accidental spelling follows the key, normalizeDoc fills and validates it', function(){
  function tokenAt33(options){
    const doc = fresh(options);
    ti.setNote(doc, pos(0), 3, 3);
    return ti.docToMeasureObjects(doc)[0].notes[0];
  }
  assert.equal(tokenAt33({ key: 1 }), 'A#3@3');
  assert.equal(tokenAt33({ key: -1 }), 'Bb3@3');
  assert.equal(tokenAt33({ key: 0, accidentals: 'flat' }), 'Bb3@3');
  assert.equal(tokenAt33({ key: 0, accidentals: 'sharp' }), 'A#3@3');
  assert.equal(tokenAt33({ key: 2, accidentals: 'flat' }), 'A#3@3');
  assert.equal(tokenAt33({ key: -2, accidentals: 'sharp' }), 'Bb3@3');
  assert.equal(fresh().key, 0);
  const doc = fresh();
  assert.deepEqual(ti.setKey(doc, -5), { ok: true });
  assert.equal(doc.key, -5);
  ti.setKey(doc, 5);
  assert.equal(doc.key, 5);
  [6, -6, 1.5, '1', null].forEach(function(bad){
    assert.throws(function(){ ti.setKey(doc, bad); }, /조표는 -5~5의 정수여야 합니다/);
  });
  assert.equal(doc.key, 5);
  const legacy = JSON.parse(JSON.stringify(fresh()));
  delete legacy.key;
  const normalized = ti.normalizeDoc(legacy);
  assert.equal(normalized.error, undefined);
  assert.equal(normalized.doc.key, 0);
  const keyed = fresh({ key: -3 });
  assert.equal(ti.normalizeDoc(keyed).doc.key, -3);
  [6, -6, 1.5].forEach(function(bad){
    const raw = JSON.parse(JSON.stringify(fresh()));
    raw.key = bad;
    assert.match(ti.normalizeDoc(raw).error, /조표는 -5~5의 정수여야 합니다/);
  });
  assert.equal(ti.scoreToDoc({ beats: 4, raw: 'E4 - - -' }).doc.key, 0);
  assert.equal(ti.parseImportText('E4 - - -').doc.key, 0);
  assert.equal(ti.buildHandoff(keyed, 1).key, -3, 'the handoff carries the key signature');
  assert.equal(ti.buildHandoff(fresh(), 1).key, 0);
});

test('sourceId: default null, stored strings kept, legacy documents read as null, other types rejected, handoff carries it', function(){
  assert.equal(fresh().sourceId, null);
  assert.equal(ti.createDoc().sourceId, null);
  assert.equal(fresh({ sourceId: 'builtin-x' }).sourceId, 'builtin-x');
  assert.equal(ti.normalizeDoc(JSON.parse(JSON.stringify(fresh({ sourceId: 'builtin-x' })))).doc.sourceId, 'builtin-x');
  const legacy = JSON.parse(JSON.stringify(fresh()));
  delete legacy.sourceId;
  const normalized = ti.normalizeDoc(legacy);
  assert.equal(normalized.error, undefined);
  assert.equal(normalized.doc.sourceId, null);
  const explicitNull = JSON.parse(JSON.stringify(fresh()));
  explicitNull.sourceId = null;
  assert.equal(ti.normalizeDoc(explicitNull).doc.sourceId, null);
  [7, true, {}, []].forEach(function(bad){
    const raw = JSON.parse(JSON.stringify(fresh()));
    raw.sourceId = bad;
    assert.match(ti.normalizeDoc(raw).error, /원래 곡 id/);
  });
  assert.equal(ti.scoreToDoc({ beats: 4, raw: 'E4 - - -' }).doc.sourceId, null);
  assert.equal(ti.parseImportText('E4 - - -').doc.sourceId, null);
  assert.equal(ti.buildHandoff(fresh({ sourceId: 'builtin-x' }), 1).sourceId, 'builtin-x');
  assert.equal(ti.buildHandoff(fresh(), 1).sourceId, null);
});

test('replaceMeasuresFromText: keeps metadata, swaps only the measures, never touches the original, reports errors', function(){
  const base = fresh({ title: '제목', beats: 4, bpm: 80, description: '설명 Capo 2', sourceId: 'builtin-x' });
  base.key = 2;
  base.accidentals = 'flat';
  const before = JSON.stringify(base);
  const replaced = ti.replaceMeasuresFromText(base, '[C] E4 - - - | "a"\n[-] G4@1 - - - | ""');
  assert.equal(replaced.error, undefined);
  assert.equal(JSON.stringify(base), before, 'the original document is not modified');
  assert.notEqual(replaced.doc, base);
  ['title', 'beats', 'bpm', 'description', 'key', 'sourceId'].forEach(function(field){
    assert.equal(replaced.doc[field], base[field], field);
  });
  assert.equal(replaced.doc.measures.length, 2);
  assert.equal(replaced.doc.measures[0].chord, 'C');
  assert.equal(replaced.doc.measures[0].memo, 'a');
  assert.equal(replaced.doc.measures[1].cells[0].slots[0].notes[0].fret, 3);
  assert.equal(replaced.doc.accidentals, 'flat', 'key 1 or more keeps the original accidentals');
  replaced.doc.measures[0].memo = 'changed';
  assert.equal(JSON.stringify(base), before, 'the result does not share objects with the original');

  const bad = ti.replaceMeasuresFromText(base, '[-] E4 - - - | ""\n[-] Q9 - - - | ""');
  assert.equal(bad.doc, undefined);
  assert.match(bad.error, /\(마디 2/);
  assert.equal(JSON.stringify(base), before);

  const short = ti.replaceMeasuresFromText(base, '[-] E4 - - | ""');
  assert.ok(short.error, 'a line with the wrong number of beats is an error');
  assert.equal(short.doc, undefined);
  assert.equal(short.error, ti.scoreToDoc({ title: base.title, beats: 4, bpm: 80, description: base.description, raw: '[-] E4 - - | ""' }).error, 'the scoreToDoc message is passed through');

  const noKey = fresh({ beats: 4 });
  assert.equal(noKey.key, 0);
  assert.equal(ti.replaceMeasuresFromText(noKey, '[-] Bb3 - - - | ""').doc.accidentals, 'flat');
  assert.equal(ti.replaceMeasuresFromText(noKey, '[-] Bb3 - - - | ""\n[-] F#3 - - - | ""').doc.accidentals, 'sharp');
  const flatBase = fresh({ beats: 4, accidentals: 'flat' });
  assert.equal(ti.replaceMeasuresFromText(flatBase, '[-] E4 - - - | ""').doc.accidentals, 'sharp', 'with key 0 the accidentals follow the typed text');
});

test('natural harmonics: imported into the model as art h with the hand fret, exported with the sounding pitch', function(){
  const HARMONICS = notation.NATURAL_HARMONICS;
  const STRINGS = parser.STRINGS;
  const frets = Object.keys(HARMONICS).map(Number);
  // 표의 모든 항목을 줄마다 한 칸씩 (2·3·4칸 마디 제약을 피하려 8칸 마디에 나눠 담는다)
  const tokens = [];
  frets.forEach(function(handFret){
    STRINGS.forEach(function(string){
      tokens.push('h' + parser.noteNameForMidi(string.midi + HARMONICS[handFret], false) + '@' + string.str);
    });
  });
  const lines = [];
  for (let i = 0; i < tokens.length; i += 4){
    const row = tokens.slice(i, i + 4);
    while (row.length < 4) row.push('r');
    lines.push('[-] ' + row.join(' ') + ' | ""');
  }
  const text = lines.join('\n');
  const result = ti.scoreToDoc({ beats: 4, raw: text });
  assert.equal(result.error, undefined);
  const doc = result.doc;
  const found = [];
  doc.measures.forEach(function(measure){
    measure.cells.forEach(function(cell){
      cell.slots.forEach(function(slot){
        slot.notes.forEach(function(note, index){ if (note) found.push({ str: index + 1, note: note }); });
      });
    });
  });
  assert.equal(found.length, tokens.length);
  found.forEach(function(item){
    assert.equal(item.note.art, 'h');
    assert.ok(frets.indexOf(item.note.fret) >= 0, 'fret is the hand fret');
  });
  assert.deepEqual(ti.validateDoc(doc).errors, []);
  assert.equal(ti.docScoreText(doc), text, 'exported text equals the imported text');
  // 문서 -> 악보 줄 -> 문서 왕복도 같다
  const again = ti.scoreToDoc({ beats: 4, raw: ti.docScoreText(doc) });
  assert.deepEqual(again.doc.measures, doc.measures);
  // 울리는 음 / 이름
  const one = fresh();
  ti.setNote(one, pos(0), 2, frets[0]);
  ti.setNoteAttrs(one, pos(0), 2, { art: 'h' });
  const note = one.measures[0].cells[0].slots[0].notes[1];
  assert.equal(ti.noteMidiOf(2, note), STRINGS[1].midi + HARMONICS[frets[0]]);
  assert.equal(ti.noteMidiOf(2, { fret: frets[0], lh: null, rh: null, art: null, uncertain: false }), STRINGS[1].midi + frets[0]);
  assert.equal(ti.noteLabelOf(one, 2, note), parser.noteNameForMidi(STRINGS[1].midi + HARMONICS[frets[0]], false));
  assert.equal(ti.noteToken(one, 2, note), 'h' + ti.noteLabelOf(one, 2, note) + '@2');
  // 모양 검사: 표에 없는 프렛은 오류, 표의 프렛은 통과
  const missingFret = (function(){ let f = 0; while (frets.indexOf(f) >= 0) f++; return f; })();
  const badDoc = ti.cloneDoc(one);
  badDoc.measures[0].cells[0].slots[0].notes[1].fret = missingFret;
  const badResult = ti.normalizeDoc(badDoc);
  assert.equal(badResult.doc, undefined);
  assert.ok(badResult.error.indexOf('하모닉스 프렛은 ' + notation.naturalHarmonicFretsText()) >= 0, badResult.error);
  assert.ok(ti.normalizeDoc(one).doc, 'a valid harmonic document is accepted');
  const wrongArt = ti.cloneDoc(one);
  wrongArt.measures[0].cells[0].slots[0].notes[1].art = '>';
  assert.match(ti.normalizeDoc(wrongArt).error, /주법은 없음, !, h, s 또는 g여야 합니다\./);
  assert.throws(function(){ ti.setNoteAttrs(one, pos(0), 2, { art: '>' }); }, /주법은 null, !, h, s 또는 g여야 합니다: /);
  const plain = fresh();
  ti.setNote(plain, pos(0), 2, missingFret);
  assert.throws(function(){ ti.setNoteAttrs(plain, pos(0), 2, { art: 'h' }); }, /하모닉스 프렛은 /);
});

test('slur: art s round-trips with the same tokens, and slurLinks judges direction with the shared rule', function(){
  const text = [
    '[-] E4@1 sF4@1 - s1E4@1:i? | ""',
    '[-] E4@1/sF4@1 - - E2@6+E4@1 | ""',
    '[-] E2@6+E4@1 E2@6+sF4@1 - r | ""'
  ].join('\n');
  const result = ti.scoreToDoc({ beats: 4, raw: text });
  assert.equal(result.error, undefined);
  const doc = result.doc;
  assert.equal(doc.measures[0].cells[1].slots[0].notes[0].art, 's');
  assert.equal(doc.measures[0].cells[3].slots[0].notes[0].art, 's');
  assert.equal(doc.measures[0].cells[3].slots[0].notes[0].lh, 1);
  assert.equal(doc.measures[0].cells[3].slots[0].notes[0].uncertain, true);
  assert.equal(ti.docScoreText(doc), text, 'exported text equals the imported text');
  assert.deepEqual(ti.scoreToDoc({ beats: 4, raw: ti.docScoreText(doc) }).doc.measures, doc.measures);
  assert.equal(ti.noteToken(doc, 1, doc.measures[0].cells[1].slots[0].notes[0]), 'sF4@1');
  // 방향: 같은 줄 위는 해머링, 아래는 풀링, 분할 안, 화음 안, 쉼 뒤는 판정 실패
  const links = ti.slurLinks(doc);
  assert.equal(links[0][0][0][0], null, 'a plain note has no link');
  assert.equal(links[0][1][0][0].type, 'hammer');
  assert.equal(links[0][3][0][0].type, 'pull', 'the hold in between keeps the source');
  assert.equal(links[1][0][1][0].type, 'hammer', 'inside a subdivision');
  assert.equal(links[2][1][0][0].type, 'hammer', 'a slurred chord component');
  assert.equal(links[2][1][0][5], null, 'the plain chord component has no link');
  assert.deepEqual(ti.validateDoc(doc).errors, []);
  // 쉼 뒤 슬러는 판정 실패(방향 없음)이고 검사 오류다. 불러오기도 같은 검사로 막는다.
  const broken = fresh();
  ti.setNote(broken, pos(0), 1, 0);
  ti.setRest(broken, pos(0, 1), true);
  ti.setNote(broken, pos(0, 2), 1, 1);
  ti.setNoteAttrs(broken, pos(0, 2), 1, { art: 's' });
  assert.deepEqual(ti.slurLinks(broken)[0][2][0][0], { ok: false, reason: 'no-source' }, 'a rest before it breaks the slur');
  const brokenErrors = ti.validateDoc(broken).errors;
  assert.deepEqual(brokenErrors.map(function(e){ return [e.code, e.measure]; }), [['INVALID_SLUR', 1]]);
  assert.ok(ti.scoreToDoc({ beats: 4, raw: ti.docScoreText(broken) }).error.indexOf('슬러 앞에 같은 줄에서 친 음이 없습니다') >= 0);
  // 속성 바꾸기
  const one = fresh();
  ti.setNote(one, pos(0), 1, 0);
  ti.setNote(one, pos(0, 1), 1, 1);
  assert.deepEqual(ti.setNoteAttrs(one, pos(0, 1), 1, { art: 's' }), { ok: true });
  assert.equal(ti.docToMeasureObjects(one)[0].notes[1], 'sF4@1');
  assert.deepEqual(ti.validateDoc(one).errors, []);
  assert.equal(ti.slurLinks(one)[0][1][0][0].type, 'hammer');
});

test('slide: art g round-trips with the same tokens, and slurLinks judges direction with the shared rule', function(){
  const text = [
    '[-] E4@1 gF4@1 - g1E4@1:i? | ""',
    '[-] E4@1/gF4@1 - - E2@6+E4@1 | ""',
    '[-] E2@6+E4@1 E2@6+gF4@1 - r | ""'
  ].join('\n');
  const result = ti.scoreToDoc({ beats: 4, raw: text });
  assert.equal(result.error, undefined);
  const doc = result.doc;
  assert.equal(doc.measures[0].cells[1].slots[0].notes[0].art, 'g');
  assert.equal(doc.measures[0].cells[3].slots[0].notes[0].art, 'g');
  assert.equal(doc.measures[0].cells[3].slots[0].notes[0].lh, 1);
  assert.equal(doc.measures[0].cells[3].slots[0].notes[0].uncertain, true);
  assert.equal(ti.docScoreText(doc), text, 'exported text equals the imported text');
  assert.deepEqual(ti.scoreToDoc({ beats: 4, raw: ti.docScoreText(doc) }).doc.measures, doc.measures);
  assert.equal(ti.noteToken(doc, 1, doc.measures[0].cells[1].slots[0].notes[0]), 'gF4@1');
  const links = ti.slurLinks(doc);
  assert.equal(links[0][0][0][0], null, 'a plain note has no link');
  assert.equal(links[0][1][0][0].type, 'hammer', 'higher than the source is judged as up (hammer)');
  assert.equal(links[0][3][0][0].type, 'pull', 'lower than the source is judged as down (pull); the hold keeps the source');
  assert.equal(links[1][0][1][0].type, 'hammer', 'inside a subdivision');
  assert.equal(links[2][1][0][0].type, 'hammer', 'a slid chord component');
  assert.equal(links[2][1][0][5], null, 'the plain chord component has no link');
  assert.deepEqual(ti.validateDoc(doc).errors, []);
  // 쉼 뒤 슬라이드는 판정 실패이고 검사 오류(INVALID_SLIDE)다. 불러오기도 같은 검사로 막는다.
  const broken = fresh();
  ti.setNote(broken, pos(0), 1, 0);
  ti.setRest(broken, pos(0, 1), true);
  ti.setNote(broken, pos(0, 2), 1, 1);
  ti.setNoteAttrs(broken, pos(0, 2), 1, { art: 'g' });
  assert.deepEqual(ti.slurLinks(broken)[0][2][0][0], { ok: false, reason: 'no-source' }, 'a rest before it breaks the slide');
  assert.deepEqual(ti.validateDoc(broken).errors.map(function(e){ return [e.code, e.measure]; }), [['INVALID_SLIDE', 1]]);
  assert.ok(ti.scoreToDoc({ beats: 4, raw: ti.docScoreText(broken) }).error.indexOf('슬라이드 앞에 같은 줄에서 친 음이 없습니다') >= 0);
  // 속성 바꾸기
  const one = fresh();
  ti.setNote(one, pos(0), 1, 0);
  ti.setNote(one, pos(0, 1), 1, 1);
  assert.deepEqual(ti.setNoteAttrs(one, pos(0, 1), 1, { art: 'g' }), { ok: true });
  assert.equal(ti.docToMeasureObjects(one)[0].notes[1], 'gF4@1');
  assert.deepEqual(ti.validateDoc(one).errors, []);
  assert.equal(ti.slurLinks(one)[0][1][0][0].type, 'hammer');
  // 주법은 한 음에 하나다: 겹쳐 적은 토큰은 받지 않는다
  assert.ok(ti.scoreToDoc({ beats: 4, raw: '[-] E4@1 sgF4@1 - - | ""' }).error, 'sg is not a token');
});

test('slurLinks: ok results carry the document position of the source note', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), 3, 2);
  ti.setNote(doc, pos(0, 0), 2, 1);
  ti.setNote(doc, pos(0, 1), 3, 4);
  ti.setNoteAttrs(doc, pos(0, 1), 3, { art: 's' });
  ti.insertEmptyMeasure(doc, 1);
  ti.setNote(doc, pos(1, 0), 3, 2);
  ti.setNoteAttrs(doc, pos(1, 0), 3, { art: 's' });
  const links = ti.slurLinks(doc);
  assert.deepEqual(links[0][1][0][2].fromPos, { m: 0, c: 0, s: 0, str: 3 }, 'the source is the earlier note on the same string, not the other chord note');
  assert.equal(links[0][1][0][2].from.piece, 0, 'from keeps the piece number in time order');
  assert.deepEqual(links[1][0][0][2].fromPos, { m: 0, c: 1, s: 0, str: 3 }, 'the source may sit in the previous measure');
  assert.equal(links[1][0][0][2].from.piece, 1, 'the piece number counts every slot in time order, the empty ones too');
  assert.equal(links[0][0][0][2], null, 'a plain note has no link');
  const failing = fresh();
  ti.setNote(failing, pos(0, 0), 1, 0);
  ti.setNote(failing, pos(0, 1), 2, 0);
  ti.setNoteAttrs(failing, pos(0, 1), 2, { art: 's' });
  assert.equal('fromPos' in ti.slurLinks(failing)[0][1][0][1], false, 'a failed link has no source position');
});

test('slurCheck: judges a slur on a copy and never changes the document', function(){
  const doc = fresh();
  const hf = Number(Object.keys(notation.NATURAL_HARMONICS)[0]);
  ti.setNote(doc, pos(0, 0), 2, 3);   // 2번 줄 기준 음
  ti.setNote(doc, pos(0, 1), 2, 5);   // 위로: 해머링
  ti.setNote(doc, pos(0, 2), 2, 1);   // 아래로: 풀링
  ti.setNote(doc, pos(0, 3), 2, 1);   // 앞과 같은 높이
  ti.setNote(doc, pos(0, 3), 3, 0);   // 이 줄은 앞에 친 음이 없다
  ti.insertEmptyMeasure(doc, 1);
  ti.setNote(doc, pos(1, 0), 2, 0);   // 앞 마디의 마지막 2번 줄 음에서
  ti.setNote(doc, pos(1, 1), 4, 0);
  ti.setRest(doc, pos(1, 2), true);
  ti.setNote(doc, pos(1, 3), 4, 2);   // 쉼 뒤
  const before = JSON.stringify(doc);
  const midiOf = (str, fret) => parser.STRINGS[str - 1].midi + fret;

  const hammer = ti.slurCheck(doc, pos(0, 1), 2);
  assert.equal(hammer.ok, true);
  assert.equal(hammer.type, 'hammer');
  assert.equal(hammer.fromMidi, midiOf(2, 3));
  assert.deepEqual(hammer.fromPos, { m: 0, c: 0, s: 0, str: 2 });
  const pull = ti.slurCheck(doc, pos(0, 2), 2);
  assert.equal(pull.ok, true);
  assert.equal(pull.type, 'pull');
  assert.equal(pull.fromMidi, midiOf(2, 5));
  assert.deepEqual(pull.fromPos, { m: 0, c: 1, s: 0, str: 2 });
  assert.equal(ti.slurCheck(doc, pos(1, 0), 2).type, 'pull', 'the source may be in the previous measure');
  assert.deepEqual(ti.slurCheck(doc, pos(1, 0), 2).fromPos, { m: 0, c: 3, s: 0, str: 2 });

  assert.deepEqual(ti.slurCheck(doc, pos(0, 3), 2), { ok: false, reason: 'same-pitch', error: '앞의 같은 줄 음과 높이가 같아 슬러로 이을 수 없습니다.' });
  assert.deepEqual(ti.slurCheck(doc, pos(0, 3), 3), { ok: false, reason: 'no-source', error: '앞에 같은 줄 음이 없어 슬러로 이을 수 없습니다.' });
  assert.deepEqual(ti.slurCheck(doc, pos(0, 0), 2), { ok: false, reason: 'no-source', error: '앞에 같은 줄 음이 없어 슬러로 이을 수 없습니다.' }, 'the very first note has no source');
  assert.equal(ti.slurCheck(doc, pos(1, 3), 4).reason, 'no-source', 'a rest cuts the source off');
  const noNote = '슬러로 바꿀 음이 없습니다.';
  assert.deepEqual(ti.slurCheck(doc, pos(0, 1), 5), { ok: false, reason: 'no-note', error: noNote }, 'no note on that string');
  assert.deepEqual(ti.slurCheck(doc, pos(1, 2), 4), { ok: false, reason: 'no-note', error: noNote }, 'a rest slot');
  assert.deepEqual(ti.slurCheck(doc, pos(9, 0), 2), { ok: false, reason: 'no-note', error: noNote }, 'a position outside the document');
  assert.equal(ti.slurCheck(doc, pos(0, 1), 7).reason, 'no-note', 'a string outside 1-6');
  assert.equal(ti.slurCheck(doc, pos(0, 1), 0).reason, 'no-note');
  assert.equal(ti.slurCheck(doc, pos(0, 1), null).reason, 'no-note');
  assert.equal(JSON.stringify(doc), before, 'checking changes nothing in the document');

  // 이미 주법이 든 음도 사본에서 슬러로 바꿔 그 프렛의 보통 음으로 판정한다.
  const apo = ti.cloneDoc(doc);
  ti.setNoteAttrs(apo, pos(0, 1), 2, { art: '!' });
  assert.equal(ti.slurCheck(apo, pos(0, 1), 2).type, 'hammer', 'an apoyando note is judged as a slur');
  assert.equal(apo.measures[0].cells[1].slots[0].notes[1].art, '!', 'and keeps its apoyando mark');
  const harm = fresh();
  ti.setNote(harm, pos(0, 0), 2, 0);
  ti.setNote(harm, pos(0, 1), 2, hf);
  ti.setNoteAttrs(harm, pos(0, 1), 2, { art: 'h' });
  const harmCheck = ti.slurCheck(harm, pos(0, 1), 2);
  assert.equal(harmCheck.ok, true, 'a harmonic note is judged as the plain note of its hand fret');
  assert.equal(harmCheck.type, 'hammer');
  assert.equal(harmCheck.fromMidi, midiOf(2, 0));
  assert.equal(harm.measures[0].cells[1].slots[0].notes[1].art, 'h', 'the harmonic mark stays');

  // 이미 슬러인 음은 그대로 판정된다.
  const slurred = ti.cloneDoc(doc);
  ti.setNoteAttrs(slurred, pos(0, 1), 2, { art: 's' });
  assert.equal(ti.slurCheck(slurred, pos(0, 1), 2).type, 'hammer');
});

test('slideCheck: same judgment as slurCheck with slide texts, and the document is never changed', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), 2, 3);   // 2번 줄 기준 음
  ti.setNote(doc, pos(0, 1), 2, 5);   // 위로
  ti.setNote(doc, pos(0, 2), 2, 1);   // 아래로
  ti.setNote(doc, pos(0, 3), 2, 1);   // 앞과 같은 높이
  ti.setNote(doc, pos(0, 3), 3, 0);   // 이 줄은 앞에 친 음이 없다
  const before = JSON.stringify(doc);
  const midiOf = (str, fret) => parser.STRINGS[str - 1].midi + fret;

  const hammer = ti.slideCheck(doc, pos(0, 1), 2);
  assert.equal(hammer.ok, true);
  assert.equal(hammer.type, 'hammer', 'an upward slide reads as the upward link');
  assert.equal(hammer.fromMidi, midiOf(2, 3));
  assert.deepEqual(hammer.fromPos, { m: 0, c: 0, s: 0, str: 2 });
  assert.equal(ti.slideCheck(doc, pos(0, 2), 2).type, 'pull', 'a downward slide reads as the downward link');
  assert.deepEqual(ti.slideCheck(doc, pos(0, 1), 2), ti.linkCheck(doc, pos(0, 1), 2, 'g'));
  assert.deepEqual(ti.slideCheck(doc, pos(0, 1), 2), ti.slurCheck(doc, pos(0, 1), 2), 'a passing check is the same result for both marks');

  assert.deepEqual(ti.slideCheck(doc, pos(0, 3), 2), { ok: false, reason: 'same-pitch', error: '앞의 같은 줄 음과 높이가 같아 슬라이드로 이을 수 없습니다.' });
  assert.deepEqual(ti.slideCheck(doc, pos(0, 3), 3), { ok: false, reason: 'no-source', error: '앞에 같은 줄 음이 없어 슬라이드로 이을 수 없습니다.' });
  assert.deepEqual(ti.slideCheck(doc, pos(0, 1), 5), { ok: false, reason: 'no-note', error: '슬라이드로 바꿀 음이 없습니다.' });
  assert.equal(ti.slideCheck(doc, pos(9, 0), 2).reason, 'no-note', 'a position outside the document');
  assert.equal(JSON.stringify(doc), before, 'checking changes nothing in the document');

  // 슬러 문구는 그대로다.
  assert.deepEqual(ti.slurCheck(doc, pos(0, 3), 2), { ok: false, reason: 'same-pitch', error: '앞의 같은 줄 음과 높이가 같아 슬러로 이을 수 없습니다.' });
  assert.deepEqual(ti.slurCheck(doc, pos(0, 3), 3), { ok: false, reason: 'no-source', error: '앞에 같은 줄 음이 없어 슬러로 이을 수 없습니다.' });
  assert.deepEqual(ti.slurCheck(doc, pos(0, 1), 5), { ok: false, reason: 'no-note', error: '슬러로 바꿀 음이 없습니다.' });
  assert.deepEqual(ti.linkCheck(doc, pos(0, 3), 2, 's'), ti.slurCheck(doc, pos(0, 3), 2));
  assert.deepEqual(Object.keys(ti.LINK_ERRORS).sort(), ['g', 's']);

  // 이미 슬러인 음도 사본에서 슬라이드로 바꿔 판정하고, 문서의 슬러 표시는 그대로 둔다.
  const slurred = ti.cloneDoc(doc);
  ti.setNoteAttrs(slurred, pos(0, 1), 2, { art: 's' });
  assert.equal(ti.slideCheck(slurred, pos(0, 1), 2).type, 'hammer');
  assert.equal(slurred.measures[0].cells[1].slots[0].notes[1].art, 's');
});

// 빈칸 _ : 칸 자리는 있고 시간은 0인 칸. 문서 모델은 cell.skip 이다(Docs/tab-input.md 빈칸).
test('skip cell: _ is read as a skip cell and written back as _, and the round trip keeps the text', function(){
  const text = '[-] _ _ _ E4@1\n[C] E4@1 F4@1 G4@1 A4@1\n[G] B3@2 D4@2 _ _';
  const result = ti.scoreToDoc({ beats: 4, raw: text });
  assert.equal(result.error, undefined);
  const doc = result.doc;
  assert.deepEqual(doc.measures[0].cells.map(c => c.skip), [true, true, true, false]);
  assert.deepEqual(doc.measures[1].cells.map(c => c.skip), [false, false, false, false]);
  assert.deepEqual(doc.measures[2].cells.map(c => c.skip), [false, false, true, true]);
  assert.equal(doc.measures[0].cells[0].slots.length, 1, 'a skip cell is one undivided cell');
  assert.deepEqual(tokens(doc)[0], ['_', '_', '_', 'E4@1']);
  assert.deepEqual(tokens(doc)[2], ['B3@2', 'D4@2', '_', '_']);
  const exported = text.split('\n').map(line => line + ' | ""').join('\n');
  assert.equal(ti.docScoreText(doc), exported);
  assert.deepEqual(ti.validateDoc(doc).errors, [], 'the exported text passes the score check');
  const again = ti.parseImportText(ti.docScoreText(doc), { beats: 4 });
  assert.equal(again.error, undefined);
  assert.equal(ti.docScoreText(again.doc), exported);
  // 불러오기: 분할 안의 _ 와 가운데·양쪽의 _ 는 거절한다
  assert.match(ti.scoreToDoc({ beats: 4, raw: 'E4/_ F4 G4 A4' }).error, /빈칸/);
  assert.match(ti.scoreToDoc({ beats: 4, raw: 'E4 _ F4 G4' }).error, /빈칸/);
  assert.match(ti.scoreToDoc({ beats: 4, raw: '_ E4 _ _' }).error, /빈칸/);
  assert.match(ti.scoreToDoc({ beats: 4, raw: '_ _ _ _' }).error, /빈칸/);
  // 텍스트 모드의 반영도 같은 길이다
  const replaced = ti.replaceMeasuresFromText(ti.createDoc(), '_ _ E4@1 F4@1');
  assert.deepEqual(replaced.doc.measures[0].cells.map(c => c.skip), [true, true, false, false]);
});

test('setSkip: turning it on clears every slot of the cell, off leaves an empty cell, and the history restores it', function(){
  const doc = fresh();
  ti.setDivision(doc, 0, 1, 3);
  ti.setNote(doc, pos(0, 1, 0), 1, 0);
  ti.setRest(doc, pos(0, 1, 2), true);
  const history = ti.createHistory(10);
  history.record(ti.cloneDoc(doc));
  const on = ti.setSkip(doc, pos(0, 1, 2), true);
  assert.deepEqual(on, { ok: true, removed: 2 });
  assert.equal(doc.measures[0].cells[1].skip, true);
  assert.equal(doc.measures[0].cells[1].slots.length, 1, 'the divided cell becomes one slot');
  assert.equal(ti.getSlot(doc, pos(0, 1, 0)).notes.every(n => n === null) && !ti.getSlot(doc, pos(0, 1, 0)).rest, true, 'the content is gone');
  assert.equal(ti.isSkipCell(doc, pos(0, 1)), true);
  const off = ti.setSkip(doc, pos(0, 1), false);
  assert.deepEqual(off, { ok: true });
  assert.equal(doc.measures[0].cells[1].skip, false);
  assert.equal(doc.measures[0].cells[1].slots.length, 1);
  assert.equal(ti.isSkipCell(doc, pos(0, 1)), false);
  assert.throws(() => ti.setSkip(doc, pos(9, 0), true), /올바르지 않은 위치/);
  // 되돌리기 기록으로 켜기 전 문서(3분할과 음·쉼)로 돌아간다
  const before = history.undo(doc);
  assert.equal(before.measures[0].cells[1].slots.length, 3);
  assert.equal(before.measures[0].cells[1].slots[0].notes[0].fret, 0);
  assert.equal(before.measures[0].cells[1].slots[2].rest, true);
  assert.equal(before.measures[0].cells[1].skip, false);
});

test('a skip cell turns off first when a note, fret, rest, clear or division is put into it', function(){
  const make = () => { const d = fresh(); ti.setSkip(d, pos(0, 1), true); return d; };
  let doc = make();
  ti.setNote(doc, pos(0, 1), 2, 3);
  assert.equal(doc.measures[0].cells[1].skip, false, 'setNote');
  assert.equal(ti.getSlot(doc, pos(0, 1)).notes[1].fret, 3);
  doc = make();
  assert.equal(ti.toggleNote(doc, pos(0, 1), 3, 2).action, 'set');
  assert.equal(doc.measures[0].cells[1].skip, false, 'toggleNote');
  doc = make();
  ti.setRest(doc, pos(0, 1), true);
  assert.equal(doc.measures[0].cells[1].skip, false, 'setRest on');
  assert.equal(ti.getSlot(doc, pos(0, 1)).rest, true);
  doc = make();
  ti.setRest(doc, pos(0, 1), false);
  assert.equal(doc.measures[0].cells[1].skip, true, 'removing a rest from a skip cell changes nothing');
  doc = make();
  ti.clearSlot(doc, pos(0, 1));
  assert.equal(doc.measures[0].cells[1].skip, false, 'clearSlot (the empty-cell button)');
  doc = make();
  ti.setDivision(doc, 0, 1, 1);
  assert.equal(doc.measures[0].cells[1].skip, true, 'dividing by 1 keeps the skip');
  ti.setDivision(doc, 0, 1, 2);
  assert.equal(doc.measures[0].cells[1].skip, false, 'a divided cell is never a skip cell');
  assert.equal(doc.measures[0].cells[1].slots.length, 2);
});

test('slotTokens over skip cells: a skip cell is _ and does not change what the next empty slot becomes', function(){
  // 소리가 이어지는 중: 음 - 빈칸 빈칸 | 빈 조각 -> 빈 조각은 -(빈칸 앞 칸 기준)
  const holding = fresh();
  ti.setNote(holding, pos(0, 0), 1, 0);
  ti.setSkip(holding, pos(0, 2), true);
  ti.setSkip(holding, pos(0, 3), true);
  ti.insertEmptyMeasure(holding, 1);
  assert.deepEqual(tokens(holding), [['E4@1', '-', '_', '_'], ['-', '-', '-', '-']]);
  // 쉼 뒤: 빈칸을 건너도 쉼이 이어진다(r)
  const resting = fresh();
  ti.setRest(resting, pos(0, 0), true);
  ti.setSkip(resting, pos(0, 3), true);
  ti.insertEmptyMeasure(resting, 1);
  assert.deepEqual(tokens(resting), [['r', 'r', 'r', '_'], ['r', 'r', 'r', 'r']]);
  // 곡 처음의 앞 빈칸: 아직 소리가 없으니 빈 조각은 r
  const start = fresh();
  ti.setSkip(start, pos(0, 0), true);
  ti.setSkip(start, pos(0, 1), true);
  ti.setNote(start, pos(0, 3), 1, 0);
  assert.deepEqual(tokens(start)[0], ['_', '_', 'r', 'E4@1']);
  assert.deepEqual(ti.validateDoc(start).errors, []);
  // 앞 빈칸 뒤의 빈 조각은 빈칸 앞(앞 마디 끝)의 소리가 이어진다
  const across = fresh();
  ti.setNote(across, pos(0, 3), 1, 0);
  ti.insertEmptyMeasure(across, 1);
  ti.setSkip(across, pos(1, 0), true);
  ti.setSkip(across, pos(1, 1), true);
  assert.deepEqual(tokens(across)[1], ['_', '_', '-', '-']);
  assert.deepEqual(ti.validateDoc(across).errors, []);
});

test('skip cells are transparent to slur links, and a slur reaches over a skip cell to the earlier note', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), 2, 3);
  ti.setSkip(doc, pos(0, 2), true);
  ti.setSkip(doc, pos(0, 3), true);
  ti.insertEmptyMeasure(doc, 1);
  ti.setNote(doc, pos(1, 0), 2, 5);
  ti.setNoteAttrs(doc, pos(1, 0), 2, { art: 's' });
  const links = ti.slurLinks(doc);
  assert.deepEqual(links[0][2][0], [null, null, null, null, null, null], 'a skip cell has no links');
  const link = links[1][0][0][1];
  assert.equal(link.ok, true);
  assert.deepEqual(link.fromPos, { m: 0, c: 0, s: 0, str: 2 });
  assert.equal(ti.slurCheck(doc, pos(1, 0), 2).ok, true);
  assert.deepEqual(ti.validateDoc(doc).errors, []);
});

test('documents saved before the skip field read it as false; wrong skip values are refused', function(){
  const doc = fresh();
  doc.measures.push(JSON.parse(JSON.stringify(doc.measures[0])));
  const old = JSON.parse(JSON.stringify(doc));
  old.measures.forEach(m => m.cells.forEach(cell => { delete cell.skip; }));
  assert.equal(old.measures[0].cells[0].skip, undefined);
  const result = ti.normalizeDoc(old);
  assert.equal(result.error, undefined);
  assert.ok(result.doc.measures.every(m => m.cells.every(cell => cell.skip === false)));
  assert.equal(ti.docScoreText(result.doc), ti.docScoreText(doc), 'an old document exports the same text');
  // 새로 만든 칸은 skip: false 를 가진다
  assert.equal(ti.createCell(2).skip, false);
  assert.equal(ti.createMeasure(4).cells[0].skip, false);
  const bad = JSON.parse(JSON.stringify(doc));
  bad.measures[0].cells[0].skip = 'yes';
  assert.match(ti.normalizeDoc(bad).error, /빈칸 표시는 true\/false/);
  const divided = JSON.parse(JSON.stringify(doc));
  divided.measures[0].cells[0].skip = true;
  divided.measures[0].cells[0].slots.push(ti.createSlot());
  assert.match(ti.normalizeDoc(divided).error, /빈칸 칸은 나누지 않은 칸/);
  const good = JSON.parse(JSON.stringify(doc));
  good.measures[0].cells[1].skip = true;
  assert.equal(ti.normalizeDoc(good).doc.measures[0].cells[1].skip, true);
});

test('a document with only a skip cell counts as having content; copy and paste keep skip cells', function(){
  const doc = fresh();
  assert.equal(ti.hasContent(doc), false);
  ti.setSkip(doc, pos(0, 0), true);
  assert.equal(ti.hasContent(doc), true);
  const copy = ti.copyRange(doc, 0, 0);
  ti.pasteAfter(doc, 0, copy);
  assert.deepEqual(doc.measures[1].cells.map(c => c.skip), [true, false, false, false]);
  assert.equal(ti.setBeats(doc, 3).lost, 0);
  ti.setBeats(doc, 6);
  assert.ok(doc.measures.every(m => m.cells.length === 6));
  assert.equal(doc.measures[0].cells[0].skip, true);
  assert.equal(doc.measures[0].cells[5].skip, false, 'padded cells are plain empty cells');
});

test('getCellChord and setCellChord read and write mid-measure chords in [Am, 3:G7] format', function(){
  const doc = fresh();
  assert.equal(ti.getCellChord(doc, 0, 0), '');
  assert.equal(ti.getCellChord(doc, 0, 2), '');
  ti.setCellChord(doc, 0, 0, 'Am');
  assert.equal(doc.measures[0].chord, 'Am');
  assert.equal(ti.getCellChord(doc, 0, 0), 'Am');
  ti.setCellChord(doc, 0, 2, 'G7');
  assert.equal(doc.measures[0].chord, 'Am, 3:G7');
  assert.equal(ti.getCellChord(doc, 0, 0), 'Am');
  assert.equal(ti.getCellChord(doc, 0, 1), '');
  assert.equal(ti.getCellChord(doc, 0, 2), 'G7');
  assert.equal(ti.docToScoreLines(doc)[0], '[Am, 3:G7] r r r r | ""');
  assert.deepEqual(ti.validateDoc(doc).errors, []);
  // 1칸 코드를 비우면 3:G7 만 남는다
  ti.setCellChord(doc, 0, 0, '');
  assert.equal(doc.measures[0].chord, '3:G7');
  assert.equal(ti.getCellChord(doc, 0, 0), '');
  assert.equal(ti.getCellChord(doc, 0, 2), 'G7');
  // 3칸 코드도 비우면 빈 문자열이 된다
  ti.setCellChord(doc, 0, 2, '-');
  assert.equal(doc.measures[0].chord, '');
  assert.equal(ti.docToScoreLines(doc)[0], '[-] r r r r | ""');
});

process.stdout.write('1..' + checks + '\n');
