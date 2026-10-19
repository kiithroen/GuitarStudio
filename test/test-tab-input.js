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
  assert.equal(ti.noteToken(doc, 1, { fret: 0, lh: 0, rh: null, art: '~', uncertain: false }), '~0E4@1');
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
  ti.setNoteAttrs(doc, pos(0, 0), 2, { art: '~' });
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
  assert.throws(function(){ ti.setNote(doc, p, 1, 13); });
  assert.throws(function(){ ti.setNote(doc, pos(5), 1, 0); });
  put(doc, p, [[1, 0]]);
  assert.throws(function(){ ti.setNoteAttrs(doc, p, 1, { rh: 'x' }); });
  assert.throws(function(){ ti.setNoteAttrs(doc, p, 1, { lh: 5 }); });
  assert.throws(function(){ ti.setNoteAttrs(doc, p, 1, { art: '>' }); });
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
  broken(function(d){ d.measures[0].cells[0].slots[0].notes[0].fret = 13; });
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
  assert.match(ti.parseImportText(['t', '4', '64', '[-] r r r r'].join('\t'), current).error, /^열이 5개여야 해/);
  assert.match(ti.parseImportText(['t', '5', '64', 'd', '[-] r r r r r'].join('\t'), current).error, /^칸 수는 2, 3, 4, 6, 8, 9 중 하나여야 해: 5$/);
  assert.match(ti.parseImportText(['t', '4', '0', 'd', '[-] r r r r'].join('\t'), current).error, /^BPM은 1 이상의 정수여야 해: 0$/);
  assert.match(ti.parseImportText(['t', '4', 'x', 'd', '[-] r r r r'].join('\t'), current).error, /^BPM은/);
  assert.equal(ti.parseImportText('   \n ', current).error, '불러올 악보가 비어 있어.');
  assert.match(ti.parseImportText('[-] r r r r r', current).error, /^첫 마디 칸 수\(5\)가 2, 3, 4, 6, 8, 9 중 하나가 아니야\.$/);
  const unknown = ti.parseImportText('[-] Q9 r r r', current);
  assert.ok(unknown.error.indexOf('(마디 1') > 0, unknown.error);
  const collide = ti.parseImportText('[-] E4+F4 r r r', current);
  assert.match(collide.error, /1번 줄에 겹쳐/);
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
  const parsed = ti.parseImportText('[-] !2A3@3:i?+E2 ~B3@2/r? r r', { title: 't' });
  assert.equal(parsed.error, undefined);
  const slots = parsed.doc.measures[0].cells[0].slots;
  assert.deepEqual(slots[0].notes[2], { fret: 2, lh: 2, rh: 'i', art: '!', uncertain: true });
  assert.deepEqual(slots[0].notes[5], { fret: 0, lh: null, rh: null, art: null, uncertain: false });
  const second = parsed.doc.measures[0].cells[1].slots;
  assert.deepEqual(second[0].notes[1], { fret: 0, lh: null, rh: null, art: '~', uncertain: false });
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

process.stdout.write('1..' + checks + '\n');
