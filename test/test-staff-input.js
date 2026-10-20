const assert = require('node:assert/strict');
const ti = require('../src/tab-input.js');
const si = require('../src/staff-input.js');

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

function pos(m, c, s){ return { m: m, c: c || 0, s: s || 0 }; }
function fresh(options){ return ti.createDoc(options); }
function lines(doc){ return ti.docToScoreLines(doc); }
function tokens(doc){ return ti.docToMeasureObjects(doc).map(function(m){ return m.notes; }); }
function units(beats, value, dotted, triplet){
  const result = si.durationUnits(beats, value, dotted, triplet);
  return result.error ? 'error' : result.units;
}
// 음 하나(또는 화음)나 쉼을 넣고 성공을 확인한 뒤 결과를 돌려준다.
function put(doc, at, D, content){
  const result = si.placeEvent(doc, at, D, content);
  assert.equal(result.ok, true, 'placeEvent failed: ' + result.error);
  return result;
}
function noteAt(doc, at, str){ return ti.getSlot(doc, at).notes[str - 1]; }
function snapshot(doc){ return JSON.parse(JSON.stringify(doc)); }

test('durationUnits and unit positions: values, dots, triplets, lengths the grid cannot write', function(){
  assert.equal(units(4, 'quarter'), 12);
  assert.equal(units(4, 'eighth'), 6);
  assert.equal(units(4, '16th'), 3);
  assert.equal(units(4, '32nd'), 'error');
  assert.equal(units(4, 'quarter', true), 18);
  assert.equal(units(4, 'half'), 24);
  assert.equal(units(4, 'whole'), 48);
  assert.equal(units(4, 'eighth', false, true), 4);
  assert.equal(units(4, 'quarter', false, true), 8);
  assert.equal(units(4, 'eighth', true), 9);
  assert.equal(units(6, 'quarter'), 24);
  assert.equal(units(6, 'eighth'), 12);
  assert.equal(units(6, '16th'), 6);
  assert.equal(units(6, '32nd'), 3);
  assert.equal(units(6, 'quarter', true), 36);
  const bad = si.durationUnits(4, '32nd', false, false);
  assert.match(bad.error, /^이 길이는 지금 칸 수에서 적을 수 없습니다\./);
  assert.match(bad.error, /8칸/);
  assert.equal(si.durationUnits(4, 'quarter').error, undefined);
  const doc = fresh({ beats: 6 });
  ti.setDivision(doc, 0, 1, 3);
  assert.equal(si.totalUnits(doc), 72);
  assert.equal(si.posToUnits(doc, pos(0, 1, 2)), 12 + 8);
  assert.deepEqual(si.unitsToPos(doc, 20), pos(0, 1, 2));
  assert.equal(si.unitsToPos(doc, 14), null);
  assert.equal(si.unitsToPos(doc, 72), null);
  assert.equal(si.eventEnd(doc, pos(0)), null);
  ti.setNote(doc, pos(0), 1, 0);
  assert.equal(si.eventEnd(doc, pos(0)), 72);
  ti.setNote(doc, pos(0, 1, 1), 1, 0);
  assert.equal(si.eventEnd(doc, pos(0)), 16);
});

test('4/4 sequence: eighths, quarter, half; the cursor lands on the appended measure', function(){
  const doc = fresh();
  let cursor = pos(0);
  const steps = [[6, 64], [6, 65], [12, 67], [24, 69]];
  steps.forEach(function(step){
    const result = put(doc, cursor, step[0], { midis: [step[1]] });
    cursor = result.next;
  });
  assert.equal(lines(doc)[0], '[-] E4@1/F4@1 G4@1 A4@1 - | ""');
  assert.equal(doc.measures.length, 2);
  assert.deepEqual(cursor, pos(1, 0, 0));
  // 앞에서 덮어쓰면 그 구간의 조각과 나눈 칸이 비워진다.
  const again = put(doc, pos(0, 0, 0), 24, { midis: [64] });
  assert.equal(lines(doc)[0], '[-] E4@1 - A4@1 - | ""');
  assert.deepEqual(again.next, pos(0, 2, 0));
});

test('dotted quarter then eighth splits the second cell in two', function(){
  const doc = fresh();
  let r = put(doc, pos(0), 18, { midis: [64] });
  assert.deepEqual(r.next, pos(0, 1, 1));
  r = put(doc, r.next, 6, { midis: [65] });
  assert.deepEqual(r.next, pos(0, 2, 0));
  assert.equal(tokens(doc)[0][0], 'E4@1');
  assert.equal(tokens(doc)[0][1], '-/F4@1');
  assert.equal(ti.getSlot(doc, pos(0, 1, 0)).notes.every(function(n){ return n === null; }), true);
});

test('three eighth triplets divide one cell in three', function(){
  const doc = fresh();
  let cursor = pos(0);
  [64, 65, 67].forEach(function(midi){
    cursor = put(doc, cursor, 4, { midis: [midi] }).next;
  });
  assert.equal(tokens(doc)[0][0], 'E4@1/F4@1/G4@1');
  assert.equal(doc.measures[0].cells[0].slots.length, 3);
  assert.deepEqual(cursor, pos(0, 1, 0));
});

test('a long note crosses the barline: held cell in the next measure, cursor after it', function(){
  const doc = fresh();
  let cursor = pos(0);
  [64, 65, 67].forEach(function(midi){ cursor = put(doc, cursor, 12, { midis: [midi] }).next; });
  assert.deepEqual(cursor, pos(0, 3, 0));
  const r = put(doc, cursor, 24, { midis: [69] });
  assert.equal(r.appended, 1);
  assert.equal(tokens(doc)[0][3], 'A4@1');
  assert.equal(tokens(doc)[1][0], '-');
  assert.deepEqual(r.next, pos(1, 1, 0));
  // 앞 마디의 음을 덮는 긴 음은 사이의 음을 지운다.
  const back = put(doc, pos(0, 1, 0), 36, { midis: [71] });
  assert.deepEqual(tokens(doc)[0].slice(0, 3), ['E4@1', 'B4@1', '-']);
  assert.deepEqual(back.next, pos(1, 0, 0));
});

test('rest events write r and the cursor moves on', function(){
  const doc = fresh();
  const first = put(doc, pos(0), 12, { midis: [64] });
  const rest = put(doc, first.next, 12, { rest: true });
  assert.deepEqual(tokens(doc)[0], ['E4@1', 'r', 'r', 'r']);
  assert.deepEqual(rest.next, pos(0, 2, 0));
  const only = fresh();
  put(only, pos(0), 12, { rest: true });
  assert.equal(tokens(only)[0][0], 'r');
});

test('a length that would drop notes behind the new boundary is refused and the document stays', function(){
  const doc = fresh();
  ti.setDivision(doc, 0, 0, 3);
  ti.setNote(doc, pos(0, 0, 1), 1, 0);
  ti.setNote(doc, pos(0, 0, 2), 1, 3);
  const before = snapshot(doc);
  const result = si.placeEvent(doc, pos(0, 0, 0), 6, { midis: [64] });
  assert.equal(result.ok, false);
  assert.match(result.error, /맞지 않습니다/);
  assert.deepEqual(doc, before);
  // 뒤 조각이 비어 있으면 같은 길이가 들어간다.
  const loose = fresh();
  ti.setDivision(loose, 0, 0, 3);
  ti.setNote(loose, pos(0, 0, 1), 1, 0);
  const ok = si.placeEvent(loose, pos(0, 0, 0), 6, { midis: [64] });
  assert.equal(ok.ok, true);
  assert.equal(loose.measures[0].cells[0].slots.length, 2);
});

test('shortening a note turns the freed room into a rest', function(){
  const doc = fresh();
  put(doc, pos(0), 24, { midis: [64] });
  assert.deepEqual(tokens(doc)[0], ['E4@1', '-', 'r', 'r']);
  put(doc, pos(0), 12, { midis: [64] });
  assert.deepEqual(tokens(doc)[0], ['E4@1', 'r', 'r', 'r']);
  assert.equal(ti.getSlot(doc, pos(0, 1, 0)).rest, true);
});

test('chords: addToChord picks the default string, then another free string, then refuses', function(){
  const low = fresh();
  put(low, pos(0), 12, { midis: [40] });
  const added = si.addToChord(low, pos(0), 59);
  assert.equal(added.ok, true);
  assert.equal(added.str, 2);
  assert.equal(tokens(low)[0][0], 'E2@6+B3@2');
  const high = fresh();
  put(high, pos(0), 12, { midis: [64] });
  const second = si.addToChord(high, pos(0), 65);
  assert.deepEqual(second, { ok: true, str: 2 });
  assert.equal(noteAt(high, pos(0), 2).fret, 6);
  const full = fresh();
  [1, 2, 3, 4, 5, 6].forEach(function(str){ ti.setNote(full, pos(0), str, 0); });
  const before = snapshot(full);
  const refused = si.addToChord(full, pos(0), 64);
  assert.equal(refused.ok, false);
  assert.deepEqual(full, before);
  assert.equal(si.addToChord(fresh(), pos(0), 64).ok, false);
  const resting = fresh();
  ti.setRest(resting, pos(0), true);
  assert.equal(si.addToChord(resting, pos(0), 64).ok, false);
  // 한 번에 여러 음을 넣어도 낮은 음부터 줄을 정한다.
  const chord = fresh();
  const r = put(chord, pos(0), 12, { midis: [64, 40, 59] });
  assert.deepEqual(r.placed, [{ str: 6, midi: 40 }, { str: 2, midi: 59 }, { str: 1, midi: 64 }]);
});

test('key signature and measure-long accidentals decide the written note', function(){
  const doc = fresh({ key: 1 });
  const start = pos(0, 0, 0);
  const written = si.writtenToMidi(doc, start, 'F', 5);
  assert.deepEqual(written, { midi: 66 });
  put(doc, start, 12, { midis: [66] });
  assert.equal(tokens(doc)[0][0], 'F#4@1');
  assert.equal(si.alterFor(doc, pos(0, 1, 0), 'F', 4), 1);
  assert.deepEqual(si.transposeNote(doc, start, 1, -1), { ok: true, str: 1 });
  assert.equal(tokens(doc)[0][0], 'F4@1');
  // 같은 마디 뒤에서는 제자리 F가 이어진다.
  assert.equal(si.alterFor(doc, pos(0, 1, 0), 'F', 4), 0);
  assert.deepEqual(si.writtenToMidi(doc, pos(0, 1, 0), 'F', 5), { midi: 65 });
  // 다른 옥타브에는 이어지지 않고 조표를 따른다.
  assert.equal(si.alterFor(doc, pos(0, 1, 0), 'F', 3), 1);
  // 다음 마디에서는 조표로 돌아간다.
  ti.insertEmptyMeasure(doc, 1);
  assert.deepEqual(si.writtenToMidi(doc, pos(1, 0, 0), 'F', 5), { midi: 66 });
  // 같은 조각 안의 앞선 줄이나 뒤 조각은 보지 않는다.
  assert.equal(si.alterFor(doc, start, 'F', 4), 1);
  assert.equal(si.alterFor(doc, start, 'C', 4), 0);
  const flats = fresh({ key: -1 });
  assert.deepEqual(si.writtenToMidi(flats, pos(0), 'B', 4), { midi: 58 });
  const none = fresh();
  assert.deepEqual(si.writtenToMidi(none, pos(0), 'F', 5), { midi: 65 });
});

test('nearestMidi: closest octave in range to the reference, ties go up', function(){
  const doc = fresh();
  assert.deepEqual(si.nearestMidi(doc, pos(0), 'E', 59), { midi: 64 });
  assert.deepEqual(si.nearestMidi(doc, pos(0), 'G', 40), { midi: 43 });
  assert.deepEqual(si.nearestMidi(doc, pos(0), 'B', 53), { midi: 59 });
  const sharp = fresh({ key: 1 });
  assert.deepEqual(si.nearestMidi(sharp, pos(0), 'F', 66), { midi: 66 });
  // referenceMidi: 방금 넣은 음, 아니면 앞 조각의 마지막 음, 아니면 B3.
  const ref = fresh();
  assert.equal(si.referenceMidi(ref, pos(0), null), 59);
  put(ref, pos(0, 0, 0), 12, { midis: [64, 40] });
  put(ref, pos(0, 1, 0), 12, { midis: [55] });
  assert.equal(si.referenceMidi(ref, pos(0, 2, 0), null), 55);
  assert.equal(si.referenceMidi(ref, pos(0, 2, 0), { pos: pos(0, 0, 0) }), 64);
  assert.equal(si.referenceMidi(ref, pos(0, 1, 0), null), 64);
});

test('transposeNote: same string by fret, another string when the fret runs out, range limits', function(){
  const up = fresh();
  put(up, pos(0), 12, { midis: [64] });
  assert.deepEqual(si.transposeNote(up, pos(0), 1, 1), { ok: true, str: 1 });
  assert.equal(noteAt(up, pos(0), 1).fret, 1);
  assert.equal(tokens(up)[0][0], 'F4@1');
  const low = fresh();
  put(low, pos(0), 12, { midis: [40] });
  const beforeLow = snapshot(low);
  const tooLow = si.transposeNote(low, pos(0), 6, -1);
  assert.equal(tooLow.ok, false);
  assert.match(tooLow.error, /음역/);
  assert.deepEqual(low, beforeLow);
  const top = fresh();
  ti.setNote(top, pos(0), 1, ti.MAX_FRET);
  const beforeTop = snapshot(top);
  assert.equal(si.transposeNote(top, pos(0), 1, 1).ok, false);
  assert.deepEqual(top, beforeTop);
  const octave = fresh();
  put(octave, pos(0), 12, { midis: [64] });
  assert.deepEqual(si.transposeNote(octave, pos(0), 1, 12), { ok: true, str: 1 });
  assert.equal(tokens(octave)[0][0], 'E5@1');
  // 같은 줄에 프렛이 없으면 다른 줄로 옮기고 오른손·주법·확인 표시는 가져간다.
  const move = fresh();
  put(move, pos(0), 12, { midis: [59] });
  ti.setNoteAttrs(move, pos(0), 2, { lh: 2, rh: 'i', art: '!', uncertain: true });
  const moved = si.transposeNote(move, pos(0), 2, -1);
  assert.deepEqual(moved, { ok: true, str: 3 });
  assert.deepEqual(noteAt(move, pos(0), 3), { fret: 3, lh: null, rh: 'i', art: '!', uncertain: true });
  assert.equal(noteAt(move, pos(0), 2), null);
  // 같은 줄에 남으면 왼손 운지만 지운다.
  const keepRh = fresh();
  put(keepRh, pos(0), 12, { midis: [64] });
  ti.setNoteAttrs(keepRh, pos(0), 1, { lh: 1, rh: 'm' });
  si.transposeNote(keepRh, pos(0), 1, 2);
  assert.deepEqual(noteAt(keepRh, pos(0), 1), { fret: 2, lh: null, rh: 'm', art: null, uncertain: false });
  // 빈 줄이 없으면 막는다.
  const full = fresh();
  [1, 2, 3, 4, 5, 6].forEach(function(str){ ti.setNote(full, pos(0), str, 0); });
  ti.setNote(full, pos(0), 2, 0);
  const beforeFull = snapshot(full);
  assert.equal(si.transposeNote(full, pos(0), 2, -1).ok, false);
  assert.deepEqual(full, beforeFull);
});

test('keep: changing only the length leaves strings and fingerings alone', function(){
  const doc = fresh();
  put(doc, pos(0), 12, { midis: [64, 55] });
  ti.setNoteAttrs(doc, pos(0), 1, { lh: 1, rh: 'm', art: '!' });
  const noteBefore = snapshot(noteAt(doc, pos(0), 1));
  const lowBefore = snapshot(noteAt(doc, pos(0), 3));
  const longer = put(doc, pos(0), 24, { keep: true });
  assert.deepEqual(longer.next, pos(0, 2, 0));
  assert.deepEqual(noteAt(doc, pos(0), 1), noteBefore);
  assert.deepEqual(noteAt(doc, pos(0), 3), lowBefore);
  assert.deepEqual(longer.placed, [{ str: 3, midi: 55 }, { str: 1, midi: 64 }]);
  assert.equal(ti.getSlot(doc, pos(0, 1, 0)).notes.every(function(n){ return n === null; }), true);
  const shorter = put(doc, pos(0), 12, { keep: true });
  assert.deepEqual(shorter.next, pos(0, 1, 0));
  assert.deepEqual(noteAt(doc, pos(0), 1), noteBefore);
  assert.equal(ti.getSlot(doc, pos(0, 1, 0)).rest, true);
  const empty = fresh();
  assert.equal(si.placeEvent(empty, pos(0), 12, { keep: true }).ok, false);
});

test('stringCandidates and moveToString keep the right hand and drop the left', function(){
  const doc = fresh();
  put(doc, pos(0), 12, { midis: [64] });
  ti.setNoteAttrs(doc, pos(0), 1, { lh: 3, rh: 'p', art: '!', uncertain: true });
  // 후보: 0~MAX_FRET 프렛으로 칠 수 있는 줄(비어 있는 줄만)
  const parser = require('../src/parser.js');
  const playable = parser.STRINGS.map(function(st, i){ return { str: i + 1, fret: 64 - st.midi }; })
    .filter(function(c){ return c.fret >= 0 && c.fret <= ti.MAX_FRET; });
  assert.deepEqual(si.stringCandidates(doc, pos(0), 1), playable.map(function(c){ return { str: c.str, fret: c.fret, current: c.str === 1 }; }));
  const unplayable = parser.STRINGS.map(function(st, i){ return i + 1; }).filter(function(str){ return !playable.some(function(c){ return c.str === str; }); });
  ti.setNote(doc, pos(0), 3, 0);
  assert.deepEqual(si.stringCandidates(doc, pos(0), 1).map(function(c){ return c.str; }), playable.map(function(c){ return c.str; }).filter(function(str){ return str !== 3; }));
  assert.deepEqual(si.stringCandidates(doc, pos(0), 5), []);
  assert.ok(unplayable.length > 0, 'E4 has a string it cannot be played on');
  const refused = si.moveToString(doc, pos(0), 1, unplayable[0]);
  assert.equal(refused.ok, false);
  assert.equal(si.moveToString(doc, pos(0), 1, 3).ok, false);
  assert.deepEqual(si.moveToString(doc, pos(0), 1, 2), { ok: true, str: 2 });
  assert.deepEqual(noteAt(doc, pos(0), 2), { fret: 5, lh: null, rh: 'p', art: '!', uncertain: true });
  assert.equal(noteAt(doc, pos(0), 1), null);
  const plain = fresh();
  put(plain, pos(0), 12, { midis: [64] });
  si.moveToString(plain, pos(0), 1, 2);
  assert.equal(tokens(plain)[0][0], 'E4@2');
});

test('writtenToMidi: guitar range from the lowest open string to the top string at MAX_FRET, written an octave above sounding', function(){
  const doc = fresh();
  const parser = require('../src/parser.js');
  const lowest = parser.STRINGS[parser.STRINGS.length - 1].midi;
  const highest = parser.STRINGS[0].midi + ti.MAX_FRET;
  const rangeError = '기타 음역(' + parser.noteNameForMidi(lowest, false) + '~' + parser.noteNameForMidi(highest, false) + ') 밖입니다.';
  // 기보음 이름: 소리보다 한 옥타브 위. 경계 음은 변화표가 없는 음만 쓰므로 가장 가까운 자연음을 찾는다.
  function written(midi){ const name = parser.noteNameForMidi(midi + 12, false); return [name.charAt(0), Number(name.slice(1))]; }
  let below = lowest - 1;
  while (parser.noteNameForMidi(below, false).indexOf('#') >= 0) below--;
  let above = highest + 1;
  while (parser.noteNameForMidi(above, false).indexOf('#') >= 0) above++;
  const low = si.writtenToMidi(doc, pos(0), written(below)[0], written(below)[1]);
  assert.equal(low.midi, undefined);
  assert.equal(low.error, rangeError);
  assert.deepEqual(si.writtenToMidi(doc, pos(0), written(highest)[0], written(highest)[1]), { midi: highest });
  assert.deepEqual(si.writtenToMidi(doc, pos(0), written(lowest)[0], written(lowest)[1]), { midi: lowest });
  assert.equal(si.writtenToMidi(doc, pos(0), written(above)[0], written(above)[1]).error, rangeError);
  assert.equal(si.writtenToMidi(doc, pos(0), 'H', 4).error !== undefined, true);
});

test('noteToRest turns the slot into a rest', function(){
  const doc = fresh();
  put(doc, pos(0), 12, { midis: [64, 40] });
  assert.deepEqual(si.noteToRest(doc, pos(0)), { ok: true });
  assert.equal(ti.getSlot(doc, pos(0)).rest, true);
  assert.equal(tokens(doc)[0][0], 'r');
  assert.equal(si.noteToRest(doc, pos(9)).ok, false);
});

test('the end of every event is filled with a rest, also at the end of the score and for keep', function(){
  const doc = fresh();
  const first = put(doc, pos(0), 12, { midis: [64] });
  assert.equal(lines(doc)[0], '[-] E4@1 r r r | ""');
  put(doc, first.next, 12, { midis: [65] });
  assert.equal(lines(doc)[0], '[-] E4@1 F4@1 r r | ""');
  // 마지막 칸에 음을 넣으면 붙은 마디의 첫 칸은 쉼이라 앞 음을 끌지 않는다.
  const last = fresh();
  const tail = put(last, pos(0, 3, 0), 12, { midis: [64] });
  assert.equal(tail.appended, 1);
  assert.deepEqual(tail.next, pos(1, 0, 0));
  assert.deepEqual(tokens(last)[0], ['r', 'r', 'r', 'E4@1']);
  assert.deepEqual(tokens(last)[1], ['r', 'r', 'r', 'r']);
  assert.equal(ti.getSlot(last, pos(1, 0, 0)).rest, true);
  // 다음 음을 그 자리에 넣으면 쉼을 덮어쓴다.
  put(last, tail.next, 12, { midis: [65] });
  assert.deepEqual(tokens(last)[1], ['F4@1', 'r', 'r', 'r']);
  assert.equal(last.measures.length, 2);
  // {keep:true}도 같다.
  const kept = fresh();
  put(kept, pos(0, 3, 0), 12, { midis: [64] });
  ti.deleteRange(kept, 1, 1);
  const keep = put(kept, pos(0, 3, 0), 12, { keep: true });
  assert.equal(keep.appended, 1);
  assert.deepEqual(tokens(kept)[1], ['r', 'r', 'r', 'r']);
  assert.deepEqual(keep.next, pos(1, 0, 0));
  // 쉼 사건도 뒤를 채운다.
  const rest = fresh();
  put(rest, pos(0), 12, { rest: true });
  assert.deepEqual(tokens(rest)[0], ['r', 'r', 'r', 'r']);
});

test('nextEventPos and prevEventPos skip held slots and stop at the ends', function(){
  const read = ti.scoreToDoc({ beats: 4, raw: '[-] C4 - E4/r G4 | ""\n[-] - - r A4/B4 | ""' });
  assert.equal(read.error, undefined);
  const doc = read.doc;
  assert.deepEqual(si.nextEventPos(doc, pos(0, 0, 0)), pos(0, 2, 0));
  assert.deepEqual(si.nextEventPos(doc, pos(0, 2, 0)), pos(0, 2, 1));
  assert.deepEqual(si.nextEventPos(doc, pos(0, 2, 1)), pos(0, 3, 0));
  assert.deepEqual(si.nextEventPos(doc, pos(0, 3, 0)), pos(1, 2, 0));
  assert.deepEqual(si.nextEventPos(doc, pos(1, 2, 0)), pos(1, 3, 0));
  assert.deepEqual(si.nextEventPos(doc, pos(1, 3, 0)), pos(1, 3, 1));
  assert.equal(si.nextEventPos(doc, pos(1, 3, 1)), null);
  assert.deepEqual(si.prevEventPos(doc, pos(1, 2, 0)), pos(0, 3, 0));
  assert.deepEqual(si.prevEventPos(doc, pos(0, 2, 0)), pos(0, 0, 0));
  assert.equal(si.prevEventPos(doc, pos(0, 0, 0)), null);
  assert.equal(si.nextEventPos(doc, pos(9, 0, 0)), null);
  assert.equal(si.prevEventPos(doc, pos(0, 9, 0)), null);
  assert.deepEqual(si.nextEventPos(ti.createDoc(), pos(0, 0, 0)), pos(0, 1, 0), 'an empty score has no held slots');
});

test('toggleChordNote adds a new pitch, removes the same pitch, turns the last note into a rest, refuses an empty slot', function(){
  const doc = fresh();
  const first = put(doc, pos(0), 12, { midis: [60] });
  assert.deepEqual(first.next, pos(0, 1, 0));
  const c4 = ti.getSlot(doc, pos(0)).notes.findIndex(Boolean) + 1;
  const added = si.toggleChordNote(doc, pos(0), 64);
  assert.equal(added.ok, true);
  assert.equal(added.added, true);
  assert.equal(ti.getSlot(doc, pos(0)).notes.filter(Boolean).length, 2);
  const removedE = si.toggleChordNote(doc, pos(0), 64);
  assert.equal(removedE.ok, true);
  assert.equal(removedE.removed, true);
  assert.equal(removedE.str, c4, 'the remaining note is C4');
  assert.equal(ti.getSlot(doc, pos(0)).notes.filter(Boolean).length, 1);
  const removedC = si.toggleChordNote(doc, pos(0), 60);
  assert.equal(removedC.ok, true);
  assert.equal(removedC.removed, true);
  assert.equal(removedC.str, null);
  const slot = ti.getSlot(doc, pos(0));
  assert.equal(slot.rest, true);
  assert.equal(slot.notes.filter(Boolean).length, 0);
  const refused = si.toggleChordNote(doc, pos(0), 64);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, '화음에 더할 음이 없습니다. 먼저 음을 넣으세요.');
  const before = snapshot(doc);
  assert.equal(si.toggleChordNote(doc, pos(9), 64).error, '올바르지 않은 위치입니다.');
  assert.deepEqual(doc, before);
  const high = fresh();
  put(high, pos(0), 12, { midis: [60] });
  assert.equal(si.toggleChordNote(high, pos(0), 90).ok, false, 'out of range is refused');
  const empty = fresh();
  assert.equal(si.toggleChordNote(empty, pos(0), 64).ok, false, 'an empty slot has no chord to join');
  // 남은 음이 둘일 때 가장 높은 음의 줄을 돌려준다.
  const three = fresh();
  put(three, pos(0), 12, { midis: [60, 64, 67] });
  const afterG = si.toggleChordNote(three, pos(0), 60);
  assert.equal(afterG.removed, true);
  const g4 = ti.getSlot(three, pos(0)).notes.findIndex(function(n, i){ return n && ti.noteMidi(i + 1, n.fret) === 67; }) + 1;
  assert.equal(afterG.str, g4, 'the highest remaining note is G4');
});

test('harmonic notes (art h) cannot be transposed or moved to another string, and their sounding pitch is used elsewhere', function(){
  const HARMONICS = require('../src/notation.js').NATURAL_HARMONICS;
  const parser = require('../src/parser.js');
  const fret = Number(Object.keys(HARMONICS)[0]);
  const string = parser.STRINGS[1];
  const soundMidi = string.midi + HARMONICS[fret];
  const text = '[-] h' + parser.noteNameForMidi(soundMidi, false) + '@' + string.str + ' r r r | ""';
  const loaded = ti.scoreToDoc({ beats: 4, raw: text });
  assert.equal(loaded.error, undefined);
  const doc = loaded.doc;
  const at = pos(0);
  assert.equal(noteAt(doc, at, string.str).art, 'h');
  const message = '하모닉스 음은 오선 입력으로 옮길 수 없습니다. 타브 입력에서 다시 넣으세요.';
  const before = snapshot(doc);
  const up = si.transposeNote(doc, at, string.str, 1);
  assert.equal(up.ok, false);
  assert.equal(up.error, message);
  assert.deepEqual(snapshot(doc), before, 'transposeNote leaves the document unchanged');
  const down = si.transposeNote(doc, at, string.str, -12);
  assert.equal(down.error, message);
  const other = string.str === 1 ? 2 : 1;
  const moved = si.moveToString(doc, at, string.str, other);
  assert.equal(moved.ok, false);
  assert.equal(moved.error, message);
  assert.deepEqual(snapshot(doc), before, 'moveToString leaves the document unchanged');
  assert.equal(si.moveToString(doc, at, string.str, string.str).error, message, 'even the same string is refused');
  // 울리는 음을 쓰는 곳: 같은 음 토글은 하모닉스 음을 지운다
  const toggled = si.toggleChordNote(doc, at, soundMidi);
  assert.equal(toggled.ok, true);
  assert.equal(toggled.removed, true);
  assert.equal(noteAt(doc, at, string.str), null);
});

test('accidental history reads a harmonic as the hand position the staff draws, not the sounding note', function(){
  const HARMONICS = require('../src/notation.js').NATURAL_HARMONICS;
  const parser = require('../src/parser.js');
  function inRange(midi){ return midi >= si.MIN_MIDI && midi <= si.MAX_MIDI; }
  let found = null;
  parser.STRINGS.forEach(function(string){
    Object.keys(HARMONICS).map(Number).forEach(function(fret){
      const handMidi = string.midi + fret;
      if (found || parser.noteNameForMidi(handMidi, false).indexOf('#') < 0) return;
      // 같은 글자의 제자리 음(손 대는 옥타브 위, 울리는 옥타브)이 모두 음역 안인 경우만 쓴다.
      const natural = handMidi - 1;
      const soundNatural = Math.floor((string.midi + HARMONICS[fret]) / 12) * 12 + natural % 12;
      if (inRange(handMidi) && inRange(natural + 12) && inRange(soundNatural)) found = { string: string, fret: fret, handMidi: handMidi };
    });
  });
  assert.ok(found, 'a harmonic fret whose hand position is a sharp note exists');
  const soundMidi = found.string.midi + HARMONICS[found.fret];
  const handName = parser.noteNameForMidi(found.handMidi, false);
  const letter = handName.charAt(0);
  const handOctave = Math.floor(found.handMidi / 12) - 1;
  const naturalPitchClass = (found.handMidi - 1) % 12;
  const text = '[-] h' + parser.noteNameForMidi(soundMidi, false) + '@' + found.string.str + ' r r r | ""';
  const loaded = ti.scoreToDoc({ beats: 4, raw: text });
  assert.equal(loaded.error, undefined);
  const doc = loaded.doc;
  assert.equal(noteAt(doc, pos(0), found.string.str).art, 'h');
  const after = pos(0, 1, 0);
  // 화면의 올림표가 이어진다: 손 대는 자리와 같은 글자·옥타브는 올림 음.
  assert.equal(si.alterFor(doc, after, letter, handOctave), 1);
  assert.deepEqual(si.writtenToMidi(doc, after, letter, handOctave + 1), { midi: found.handMidi });
  // 울리는 음의 옥타브에는 표시된 올림표가 없으니 조표(없음)를 따른다.
  const soundOctave = Math.floor(soundMidi / 12) - 1;
  if (soundOctave !== handOctave){
    assert.equal(si.alterFor(doc, after, letter, soundOctave), 0);
    assert.deepEqual(si.writtenToMidi(doc, after, letter, soundOctave + 1), { midi: (soundOctave + 1) * 12 + naturalPitchClass });
  }
  const upOctave = handOctave + 1;
  assert.deepEqual(si.writtenToMidi(doc, after, letter, upOctave + 1), { midi: (upOctave + 1) * 12 + naturalPitchClass });
});

// 하모닉스 켜기: 값은 NATURAL_HARMONICS·STRINGS에서 셈한다. 기대는 테스트 안에서 따로 브루트포스로 구한다.
function harmonicSetup(){
  const notation = require('../src/notation.js');
  const parser = require('../src/parser.js');
  const frets = Object.keys(notation.NATURAL_HARMONICS).map(Number).sort(function(a, b){ return b - a; });
  // 손 대는 자리 (str, fret)에서 같은 음을 하모닉스 프렛으로 칠 수 있는 다른 줄들을 우선순위대로(프렛이 큰 쪽, 같으면 낮은 줄 번호) 늘어놓는다.
  function candidatesOf(str, fret, occupied){
    const midi = parser.STRINGS[str - 1].midi + fret;
    const list = [];
    for (let s = 1; s <= 6; s++){
      if (s === str || (occupied && occupied.indexOf(s) >= 0)) continue;
      const f = midi - parser.STRINGS[s - 1].midi;
      if (frets.indexOf(f) >= 0) list.push({ str: s, fret: f });
    }
    list.sort(function(a, b){ return frets.indexOf(a.fret) - frets.indexOf(b.fret) || a.str - b.str; });
    return list;
  }
  const all = [];
  for (let s = 1; s <= 6; s++){
    for (let f = 0; f <= ti.MAX_FRET; f++) all.push({ str: s, fret: f, isHarmonic: frets.indexOf(f) >= 0 });
  }
  return { notation: notation, parser: parser, frets: frets, candidatesOf: candidatesOf, all: all };
}

test('harmonicTarget and makeHarmonic: a harmonic fret stays on its string', function(){
  const h = harmonicSetup();
  const item = h.all.find(function(x){ return x.isHarmonic; });
  const doc = fresh();
  ti.setNote(doc, pos(0), item.str, item.fret);
  const target = si.harmonicTarget(doc, pos(0), item.str);
  assert.deepEqual(target, { ok: true, str: item.str, fret: item.fret, same: true });
  assert.deepEqual(si.makeHarmonic(doc, pos(0), item.str), { ok: true, str: item.str });
  assert.equal(noteAt(doc, pos(0), item.str).art, 'h');
  assert.equal(noteAt(doc, pos(0), item.str).fret, item.fret);
  // 이미 하모닉스이면 바꾸지 않는다
  const before = snapshot(doc);
  assert.deepEqual(si.harmonicTarget(doc, pos(0), item.str), { ok: true, str: item.str, fret: item.fret, same: true });
  assert.deepEqual(si.makeHarmonic(doc, pos(0), item.str), { ok: true, str: item.str });
  assert.deepEqual(snapshot(doc), before);
  // 음이 없으면 막는다
  const empty = fresh();
  assert.equal(si.harmonicTarget(empty, pos(0), 1).error, '하모닉스로 바꿀 음이 없습니다.');
  assert.equal(si.makeHarmonic(empty, pos(0), 1).error, '하모닉스로 바꿀 음이 없습니다.');
});

test('harmonicTarget moves a plain note to the free string where its hand position is a harmonic fret', function(){
  const h = harmonicSetup();
  const item = h.all.find(function(x){ return !x.isHarmonic && h.candidatesOf(x.str, x.fret).length > 0; });
  assert.ok(item, 'a plain position with a harmonic alternative exists');
  const expected = h.candidatesOf(item.str, item.fret)[0];
  const doc = fresh();
  ti.setNote(doc, pos(0), item.str, item.fret);
  ti.setNoteAttrs(doc, pos(0), item.str, { lh: 2, rh: 'i', art: '!', uncertain: true });
  const handMidi = ti.noteMidiOf(item.str, noteAt(doc, pos(0), item.str));
  assert.deepEqual(si.harmonicTarget(doc, pos(0), item.str), { ok: true, str: expected.str, fret: expected.fret, same: false });
  assert.deepEqual(si.makeHarmonic(doc, pos(0), item.str), { ok: true, str: expected.str });
  assert.equal(noteAt(doc, pos(0), item.str), null, 'the old string is emptied');
  const moved = noteAt(doc, pos(0), expected.str);
  assert.equal(moved.art, 'h', 'apoyando became a harmonic');
  assert.equal(moved.fret, expected.fret);
  assert.equal(moved.lh, null, 'the left hand finger is cleared');
  assert.equal(moved.rh, 'i', 'the right hand finger stays');
  assert.equal(moved.uncertain, true, 'the check mark stays');
  assert.equal(h.parser.STRINGS[expected.str - 1].midi + moved.fret, handMidi, 'the hand position pitch is kept');
});

test('harmonicTarget priority: larger harmonic fret first, then the lower string number', function(){
  const h = harmonicSetup();
  let multi = 0;
  h.all.forEach(function(item){
    if (item.isHarmonic) return;
    const list = h.candidatesOf(item.str, item.fret);
    if (list.length < 2) return;
    multi++;
    const doc = fresh();
    ti.setNote(doc, pos(0), item.str, item.fret);
    const target = si.harmonicTarget(doc, pos(0), item.str);
    const bestFret = Math.max.apply(null, list.map(function(x){ return x.fret; }));
    assert.equal(target.fret, bestFret, 'the largest harmonic fret wins at ' + item.str + '/' + item.fret);
    assert.equal(target.str, list.filter(function(x){ return x.fret === bestFret; })[0].str);
    assert.equal(target.str, list[0].str);
  });
  assert.ok(multi > 0, 'at least one position has two harmonic alternatives');
});

test('harmonicTarget fails with the guide text when no free string makes the hand position a harmonic fret', function(){
  const h = harmonicSetup();
  const item = h.all.find(function(x){ return !x.isHarmonic && h.candidatesOf(x.str, x.fret).length === 0; });
  assert.ok(item, 'a position with no harmonic alternative exists');
  const doc = fresh();
  ti.setNote(doc, pos(0), item.str, item.fret);
  const before = snapshot(doc);
  const message = '이 자리는 빈 줄 어디에서도 ' + h.notation.naturalHarmonicFretsText() + '프렛이 아니라 하모닉스로 칠 수 없습니다.';
  const target = si.harmonicTarget(doc, pos(0), item.str);
  assert.equal(target.ok, false);
  assert.equal(target.error, message);
  const made = si.makeHarmonic(doc, pos(0), item.str);
  assert.equal(made.ok, false);
  assert.equal(made.error, message);
  assert.deepEqual(snapshot(doc), before, 'a refusal leaves the document unchanged');
});

test('harmonicTarget skips candidate strings that hold other notes', function(){
  const h = harmonicSetup();
  const item = h.all.find(function(x){ return !x.isHarmonic && h.candidatesOf(x.str, x.fret).length >= 2; });
  assert.ok(item, 'a position with two alternatives exists');
  const list = h.candidatesOf(item.str, item.fret);
  const doc = fresh();
  ti.setNote(doc, pos(0), item.str, item.fret);
  // 우선 후보 줄을 다른 음(0프렛)으로 채운다. 그 줄의 0프렛은 하모닉스 프렛이 아니라서 후보와 같은 음일 수 없다.
  ti.setNote(doc, pos(0), list[0].str, 0);
  const occupied = [list[0].str];
  const expected = h.candidatesOf(item.str, item.fret, occupied)[0];
  assert.equal(expected.str, list[1].str);
  assert.deepEqual(si.harmonicTarget(doc, pos(0), item.str), { ok: true, str: expected.str, fret: expected.fret, same: false });
  assert.deepEqual(si.makeHarmonic(doc, pos(0), item.str), { ok: true, str: expected.str });
  assert.equal(noteAt(doc, pos(0), list[0].str).fret, 0, 'the other note is untouched');
  assert.equal(noteAt(doc, pos(0), list[0].str).art, null);
  // 후보를 모두 채우면 막는다
  const full = fresh();
  ti.setNote(full, pos(0), item.str, item.fret);
  list.forEach(function(x){ ti.setNote(full, pos(0), x.str, 0); });
  assert.equal(si.harmonicTarget(full, pos(0), item.str).ok, false, 'all alternatives occupied is refused');
});

test('random operations keep the document valid and failures leave it untouched', function(){
  let seed = 20261019;
  function random(){
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  function pick(list){ return list[Math.floor(random() * list.length)]; }
  const values = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];
  let succeeded = 0;
  let failed = 0;
  let ops = 0;
  const tally = {};
  function count(name, ok){ const key = name + (ok ? ' ok' : ' fail'); tally[key] = (tally[key] || 0) + 1; }
  [4, 6, 9].forEach(function(beats){
    const doc = fresh({ beats: beats, key: pick([0, 1, -1, 2]) });
    let cursor = pos(0);
    let last = null;
    for (let i = 0; i < 100; i++){
      ops++;
      const before = snapshot(doc);
      const kind = random();
      let result;
      let timed = null;
      if (kind < 0.5 || kind >= 0.9){
        const length = si.durationUnits(beats, pick(values), random() < 0.3, random() < 0.3);
        if (length.error){
          failed++;
          count('duration', false);
          continue;
        }
        timed = length.units;
        let content;
        if (kind >= 0.9) content = { keep: true };
        else if (random() < 0.15) content = { rest: true };
        else {
          const midis = [40 + Math.floor(random() * 37)];
          if (random() < 0.25) midis.push(40 + Math.floor(random() * 37));
          content = { midis: midis };
        }
        result = si.placeEvent(doc, cursor, length.units, content);
        count('place', result.ok); if (!result.ok) count('E:' + result.error.slice(0, 12), false);
        if (result.ok){
          assert.equal(ti.isValidPos(doc, result.next), true, 'cursor valid after place');
          last = content.rest ? null : { pos: cursor };
          cursor = result.next;
        }
      } else if (kind < 0.65){
        const target = last && ti.isValidPos(doc, last.pos) ? last.pos : cursor;
        result = si.addToChord(doc, target, 40 + Math.floor(random() * 37));
        count('chord', result.ok);
      } else if (kind < 0.8){
        const target = last && ti.isValidPos(doc, last.pos) ? last.pos : cursor;
        const slot = ti.getSlot(doc, target);
        const strs = [];
        slot.notes.forEach(function(note, index){ if (note) strs.push(index + 1); });
        if (!strs.length){
          result = { ok: false };
          count('transpose-none', false);
        } else {
          result = si.transposeNote(doc, target, pick(strs), pick([1, -1, 12, -12]));
          count('transpose', result.ok);
        }
      } else {
        const moved = random() < 0.5 ? ti.nextPos(doc, cursor) : ti.prevPos(doc, cursor);
        if (moved) cursor = moved;
        result = { ok: true, moved: true };
        count('move', true);
      }
      if (result.ok){
        succeeded++;
        const check = ti.validateDoc(doc);
        assert.equal(check.errors.length, 0, 'errors after op ' + ops + ': ' + JSON.stringify(check.errors));
        assert.equal(check.warnings.length, 0, 'warnings after op ' + ops + ': ' + JSON.stringify(check.warnings));
        assert.equal(ti.isValidPos(doc, cursor), true, 'cursor valid');
        if (timed !== null){
          assert.equal(doc.measures.every(function(m){ return m.cells.length === beats; }), true);
        }
      } else {
        failed++;
        assert.deepEqual(doc, before, 'failed op ' + ops + ' changed the document');
      }
    }
  });
  assert.equal(ops, 300);
  assert.ok(succeeded > 50 && failed >= 0);
  process.stdout.write('# random ops: ' + succeeded + ' succeeded, ' + failed + ' failed ' + JSON.stringify(tally) + '\n');
});

test('slur notes (art s) can be transposed and moved to another string; the check reports a slur that no longer links', function(){
  const doc = fresh();
  put(doc, pos(0, 0), 12, { midis: [64] });
  put(doc, pos(0, 1), 12, { midis: [65] });
  ti.setNoteAttrs(doc, pos(0, 1), 1, { art: 's' });
  assert.deepEqual(ti.validateDoc(doc).errors, []);
  assert.deepEqual(si.transposeNote(doc, pos(0, 1), 1, 2), { ok: true, str: 1 });
  assert.equal(noteAt(doc, pos(0, 1), 1).art, 's', 'transposing keeps the slur');
  assert.deepEqual(ti.validateDoc(doc).errors, [], 'still a hammer-on from the open string');
  assert.deepEqual(si.moveToString(doc, pos(0, 1), 1, 2), { ok: true, str: 2 });
  assert.equal(noteAt(doc, pos(0, 1), 2).art, 's', 'moving to another string keeps the slur');
  assert.deepEqual(ti.validateDoc(doc).errors.map(function(e){ return e.code; }), ['INVALID_SLUR'], 'the slur no longer links on another string');
});

// 슬러 켜기: 줄·프렛은 STRINGS와 MAX_FRET에서 찾고 기대는 테스트 안에서 따로 셈한다.
const SLUR_STAFF_MESSAGE = '앞 음과 같은 줄에서 이을 수 있는 자리가 없어 슬러로 만들 수 없습니다.';
function slurSetup(){
  const parser = require('../src/parser.js');
  // k.midiOn / fretOn / stringsFor: 줄·프렛·음높이 변환은 STRINGS에서 셈한다.
  function midiOn(str, fret){ return parser.STRINGS[str - 1].midi + fret; }
  function fretOn(str, midi){
    const fret = midi - parser.STRINGS[str - 1].midi;
    return fret >= 0 && fret <= ti.MAX_FRET ? fret : null;
  }
  // 한 음 M을 칠 수 있는 줄들
  function stringsFor(midi){
    const list = [];
    for (let s = 1; s <= 6; s++) if (fretOn(s, midi) !== null) list.push(s);
    return list;
  }
  const lo = midiOn(6, 0);
  const hi = midiOn(1, ti.MAX_FRET);
  return { parser: parser, midiOn: midiOn, fretOn: fretOn, stringsFor: stringsFor, lo: lo, hi: hi };
}

test('slurTarget keeps the current string when it already links to the note just before', function(){
  const k = slurSetup();
  let found = null;
  for (let m = k.lo + 2; m <= k.hi && !found; m++){
    const strs = k.stringsFor(m).filter(function(s){ return k.fretOn(s, m - 1) !== null; });
    if (strs.length) found = { midi: m, str: strs[0] };
  }
  assert.ok(found);
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), found.str, k.fretOn(found.str, found.midi - 1));
  ti.setNote(doc, pos(0, 1), found.str, k.fretOn(found.str, found.midi));
  const before = snapshot(doc);
  assert.deepEqual(si.slurTarget(doc, pos(0, 1), found.str), { ok: true, str: found.str, same: true });
  assert.deepEqual(snapshot(doc), before, 'slurTarget never edits the document');
  assert.deepEqual(si.makeSlur(doc, pos(0, 1), found.str), { ok: true, str: found.str });
  assert.equal(noteAt(doc, pos(0, 1), found.str).art, 's');
  assert.equal(noteAt(doc, pos(0, 1), found.str).fret, k.fretOn(found.str, found.midi), 'the fret is kept');
  assert.deepEqual(ti.validateDoc(doc).errors, []);
  // 이미 슬러이면 그대로 둔다
  const again = snapshot(doc);
  assert.deepEqual(si.slurTarget(doc, pos(0, 1), found.str), { ok: true, str: found.str, same: true });
  assert.deepEqual(si.makeSlur(doc, pos(0, 1), found.str), { ok: true, str: found.str });
  assert.deepEqual(snapshot(doc), again);
  // 슬러로 표시된 음은 앞이 이어지지 않아도 그대로 같다고 답한다(끄는 것은 화면 몫)
  const lone = fresh();
  ti.setNote(lone, pos(0, 0), 1, 0);
  ti.setNoteAttrs(lone, pos(0, 0), 1, { art: 's' });
  assert.deepEqual(si.slurTarget(lone, pos(0, 0), 1), { ok: true, str: 1, same: true });
});

test('slurTarget moves the note to the string of the note just before it and clears the left hand finger', function(){
  const k = slurSetup();
  // 지금 줄 a에는 앞 음이 없고, 다른 줄 b에 한 반음 아래 앞 음을 둘 수 있는 음 M을 찾는다(a에 M, b에 M-1).
  let found = null;
  for (let m = k.lo + 2; m <= k.hi && !found; m++){
    const strs = k.stringsFor(m);
    for (let i = 0; i < strs.length && !found; i++){
      for (let j = 0; j < strs.length && !found; j++){
        if (i !== j && k.fretOn(strs[j], m - 1) !== null) found = { midi: m, a: strs[i], b: strs[j] };
      }
    }
  }
  assert.ok(found, 'a pitch playable on two strings exists');
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), found.b, k.fretOn(found.b, found.midi - 1));
  ti.setNote(doc, pos(0, 1), found.a, k.fretOn(found.a, found.midi));
  ti.setNoteAttrs(doc, pos(0, 1), found.a, { lh: 3, rh: 'm', art: '!', uncertain: true });
  const before = snapshot(doc);
  assert.deepEqual(si.slurTarget(doc, pos(0, 1), found.a), { ok: true, str: found.b, same: false });
  assert.deepEqual(snapshot(doc), before, 'slurTarget never edits the document');
  assert.deepEqual(si.makeSlur(doc, pos(0, 1), found.a), { ok: true, str: found.b });
  assert.equal(noteAt(doc, pos(0, 1), found.a), null, 'the old string is emptied');
  const moved = noteAt(doc, pos(0, 1), found.b);
  assert.equal(moved.fret, k.fretOn(found.b, found.midi), 'the fret is the pitch minus the open string of the new string');
  assert.equal(moved.art, 's');
  assert.equal(moved.lh, null, 'the left hand finger is cleared');
  assert.equal(moved.rh, 'm', 'the right hand finger stays');
  assert.equal(moved.uncertain, true, 'the check mark stays');
  assert.equal(ti.slurLinks(doc)[0][1][0][found.b - 1].type, 'hammer');
  assert.deepEqual(ti.validateDoc(doc).errors, []);
});

test('slurTarget prefers the string whose source note is latest, even when the current string also links to an earlier note', function(){
  const k = slurSetup();
  let found = null;
  for (let m = k.lo + 2; m <= k.hi && !found; m++){
    const strs = k.stringsFor(m).filter(function(s){ return k.fretOn(s, m - 1) !== null; });
    if (strs.length >= 2) found = { midi: m, a: strs[strs.length - 1], b: strs[0] };
  }
  assert.ok(found, 'a pitch with two strings that can hold the previous pitch exists');
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), found.a, k.fretOn(found.a, found.midi - 1)); // 지금 줄의 먼 출발 음
  ti.setNote(doc, pos(0, 1), found.b, k.fretOn(found.b, found.midi - 1)); // 더 가까운 출발 음
  ti.setNote(doc, pos(0, 2), found.a, k.fretOn(found.a, found.midi));
  // 지금 줄도 판정을 통과한다
  const own = ti.slurCheck(doc, pos(0, 2), found.a);
  assert.equal(own.ok, true, 'the current string alone would pass');
  assert.deepEqual(own.fromPos, { m: 0, c: 0, s: 0, str: found.a });
  assert.deepEqual(si.slurTarget(doc, pos(0, 2), found.a), { ok: true, str: found.b, same: false });
  assert.deepEqual(si.makeSlur(doc, pos(0, 2), found.a), { ok: true, str: found.b });
  assert.equal(noteAt(doc, pos(0, 2), found.a), null);
  assert.equal(noteAt(doc, pos(0, 2), found.b).art, 's');
  assert.equal(ti.slurCheck(doc, pos(0, 2), found.b).fromPos.c, 1);
});

test('slurTarget ties: the current string first, then the smaller pitch gap, then the lower string number', function(){
  const k = slurSetup();
  // 같은 앞 조각(화음)에 두 줄의 음이 있어 출발 음 순서가 같다.
  let tie = null;
  for (let m = k.lo + 6; m <= k.hi && !tie; m++){
    const strs = k.stringsFor(m);
    if (strs.length < 2) continue;
    for (let i = 0; i < strs.length && !tie; i++){
      for (let j = 0; j < strs.length && !tie; j++){
        if (i !== j && k.fretOn(strs[i], m - 1) !== null && k.fretOn(strs[j], m - 1) !== null) tie = { midi: m, cur: strs[i], other: strs[j] };
      }
    }
  }
  assert.ok(tie, 'a pitch with two strings that can hold the previous pitch exists');
  const chord = fresh();
  ti.setNote(chord, pos(0, 0), tie.cur, k.fretOn(tie.cur, tie.midi - 1));
  ti.setNote(chord, pos(0, 0), tie.other, k.fretOn(tie.other, tie.midi - 1));
  ti.setNote(chord, pos(0, 1), tie.cur, k.fretOn(tie.cur, tie.midi));
  assert.deepEqual(si.slurTarget(chord, pos(0, 1), tie.cur), { ok: true, str: tie.cur, same: true }, 'the same source order keeps the current string');

  // 지금 줄에는 앞 음이 없고 다른 두 줄의 음이 같은 앞 조각에 있을 때: 음높이 차가 작은 줄. 번호가 낮은 줄이 차가 크도록 짠다.
  let gap = null;
  for (let m = k.lo + 6; m <= k.hi && !gap; m++){
    const strs = k.stringsFor(m);
    for (let c = 0; c < strs.length && !gap; c++){
      for (let x = 0; x < strs.length && !gap; x++){
        for (let y = 0; y < strs.length && !gap; y++){
          if (c === x || c === y || x === y) continue;
          if (strs[y] < strs[x] && k.fretOn(strs[x], m - 1) !== null && k.fretOn(strs[y], m - 5) !== null) gap = { midi: m, cur: strs[c], near: strs[x], far: strs[y] };
        }
      }
    }
  }
  assert.ok(gap, 'a pitch with three playable strings exists');
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), gap.far, k.fretOn(gap.far, gap.midi - 5));
  ti.setNote(doc, pos(0, 0), gap.near, k.fretOn(gap.near, gap.midi - 1));
  ti.setNote(doc, pos(0, 1), gap.cur, k.fretOn(gap.cur, gap.midi));
  assert.ok(gap.far < gap.near, 'the lower string number has the larger gap');
  assert.deepEqual(si.slurTarget(doc, pos(0, 1), gap.cur), { ok: true, str: gap.near, same: false }, 'the smaller pitch gap wins over the lower string number');

  // 음높이 차도 같으면 낮은 줄 번호: 두 줄 모두 한 반음 아래 음
  let low = null;
  for (let m = k.lo + 6; m <= k.hi && !low; m++){
    const strs = k.stringsFor(m).filter(function(s){ return k.fretOn(s, m - 1) !== null; });
    for (let c = 0; c < k.stringsFor(m).length && !low; c++){
      const cur = k.stringsFor(m)[c];
      const others = strs.filter(function(s){ return s !== cur; });
      if (others.length >= 2) low = { midi: m, cur: cur, first: others[0], second: others[1] };
    }
  }
  assert.ok(low, 'a pitch with two other strings that can hold the previous pitch exists');
  const same = fresh();
  ti.setNote(same, pos(0, 0), low.first, k.fretOn(low.first, low.midi - 1));
  ti.setNote(same, pos(0, 0), low.second, k.fretOn(low.second, low.midi - 1));
  ti.setNote(same, pos(0, 1), low.cur, k.fretOn(low.cur, low.midi));
  assert.ok(low.first < low.second);
  assert.deepEqual(si.slurTarget(same, pos(0, 1), low.cur), { ok: true, str: low.first, same: false }, 'equal gaps pick the lower string number');
});

test('slurTarget fails with the guide text when no string can link, and leaves the document alone', function(){
  const k = slurSetup();
  const message = SLUR_STAFF_MESSAGE;
  // 앞 음이 전혀 없다
  const first = fresh();
  ti.setNote(first, pos(0, 0), 3, 2);
  let before = snapshot(first);
  assert.deepEqual(si.slurTarget(first, pos(0, 0), 3), { ok: false, error: message });
  assert.deepEqual(si.makeSlur(first, pos(0, 0), 3), { ok: false, error: message });
  assert.deepEqual(snapshot(first), before);
  // 쉼이 출발 음을 끊는다
  const rested = fresh();
  ti.setNote(rested, pos(0, 0), 3, 0);
  ti.setRest(rested, pos(0, 1), true);
  ti.setNote(rested, pos(0, 2), 3, 2);
  before = snapshot(rested);
  assert.equal(si.slurTarget(rested, pos(0, 2), 3).error, message);
  assert.deepEqual(snapshot(rested), before);
  // 앞 음과 높이가 같다
  const equal = fresh();
  ti.setNote(equal, pos(0, 0), 3, 2);
  ti.setNote(equal, pos(0, 1), 3, 2);
  assert.equal(si.makeSlur(equal, pos(0, 1), 3).error, message, 'the same pitch on the same string cannot be a slur; other strings have no source');
  // 음이 없다
  const empty = fresh();
  assert.deepEqual(si.slurTarget(empty, pos(0), 1), { ok: false, error: '슬러로 바꿀 음이 없습니다.' });
  assert.deepEqual(si.makeSlur(empty, pos(0), 1), { ok: false, error: '슬러로 바꿀 음이 없습니다.' });
  assert.equal(si.slurTarget(empty, pos(7), 1).ok, false);
  assert.equal(si.slurTarget(first, pos(0, 0), 9).ok, false);
});

test('slurTarget never moves a harmonic note: only its own string is judged, and the mark becomes a slur', function(){
  const k = slurSetup();
  const notation = require('../src/notation.js');
  const hf = Number(Object.keys(notation.NATURAL_HARMONICS)[0]);
  // 손 대는 자리 (a, hf)의 음을 다른 줄 b에서도 칠 수 있고, b에 한 반음 아래 앞 음을 둘 수 있다.
  let found = null;
  for (let a = 1; a <= 6 && !found; a++){
    const m = k.midiOn(a, hf);
    for (let b = 1; b <= 6 && !found; b++){
      if (b !== a && k.fretOn(b, m) !== null && k.fretOn(b, m - 1) !== null) found = { a: a, b: b, midi: m };
    }
  }
  assert.ok(found, 'a hand position playable on a second string exists');
  const noOwnSource = fresh();
  ti.setNote(noOwnSource, pos(0, 0), found.b, k.fretOn(found.b, found.midi - 1));
  ti.setNote(noOwnSource, pos(0, 1), found.a, hf);
  ti.setNoteAttrs(noOwnSource, pos(0, 1), found.a, { art: 'h' });
  const before = snapshot(noOwnSource);
  assert.deepEqual(si.slurTarget(noOwnSource, pos(0, 1), found.a), { ok: false, error: '앞에 같은 줄 음이 없어 슬러로 이을 수 없습니다.' });
  assert.deepEqual(si.makeSlur(noOwnSource, pos(0, 1), found.a), { ok: false, error: '앞에 같은 줄 음이 없어 슬러로 이을 수 없습니다.' });
  assert.deepEqual(snapshot(noOwnSource), before, 'a harmonic is not moved to another string');
  const ownSource = fresh();
  ti.setNote(ownSource, pos(0, 0), found.a, hf === 0 ? 1 : 0);
  ti.setNote(ownSource, pos(0, 1), found.a, hf);
  ti.setNoteAttrs(ownSource, pos(0, 1), found.a, { art: 'h' });
  assert.deepEqual(si.slurTarget(ownSource, pos(0, 1), found.a), { ok: true, str: found.a, same: true });
  assert.deepEqual(si.makeSlur(ownSource, pos(0, 1), found.a), { ok: true, str: found.a });
  const note = noteAt(ownSource, pos(0, 1), found.a);
  assert.equal(note.art, 's', 'the harmonic mark was replaced by the slur');
  assert.equal(note.fret, hf, 'the fret is kept');
});

// 슬라이드 켜기: 슬러와 같은 줄 고르기(linkTarget·makeLink)를 art 'g'로 부른다. 문구만 다르다.
const SLIDE_STAFF_MESSAGE = '앞 음과 같은 줄에서 이을 수 있는 자리가 없어 슬라이드로 만들 수 없습니다.';

test('slideTarget keeps the current string when it already links, and makeSlide writes the g mark without touching the fret', function(){
  const k = slurSetup();
  let found = null;
  for (let m = k.lo + 2; m <= k.hi && !found; m++){
    const strs = k.stringsFor(m).filter(function(s){ return k.fretOn(s, m - 1) !== null; });
    if (strs.length) found = { midi: m, str: strs[0] };
  }
  assert.ok(found);
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), found.str, k.fretOn(found.str, found.midi - 1));
  ti.setNote(doc, pos(0, 1), found.str, k.fretOn(found.str, found.midi));
  const before = snapshot(doc);
  assert.deepEqual(si.slideTarget(doc, pos(0, 1), found.str), { ok: true, str: found.str, same: true });
  assert.deepEqual(si.linkTarget(doc, pos(0, 1), found.str, 'g'), { ok: true, str: found.str, same: true });
  assert.deepEqual(snapshot(doc), before, 'slideTarget never edits the document');
  assert.deepEqual(si.makeSlide(doc, pos(0, 1), found.str), { ok: true, str: found.str });
  assert.equal(noteAt(doc, pos(0, 1), found.str).art, 'g', 'the note carries the slide mark, not the slur mark');
  assert.equal(noteAt(doc, pos(0, 1), found.str).fret, k.fretOn(found.str, found.midi), 'the fret is kept');
  assert.deepEqual(ti.validateDoc(doc).errors, []);
  assert.equal(ti.slurLinks(doc)[0][1][0][found.str - 1].type, 'hammer', 'a higher slide note reads as the upward link');
  // 이미 슬라이드이면 그대로 둔다
  const again = snapshot(doc);
  assert.deepEqual(si.makeSlide(doc, pos(0, 1), found.str), { ok: true, str: found.str });
  assert.deepEqual(snapshot(doc), again);
  // 슬러를 슬라이드로 바꾸고, 슬라이드를 슬러로 바꿀 수 있다
  assert.deepEqual(si.makeSlur(doc, pos(0, 1), found.str), { ok: true, str: found.str });
  assert.equal(noteAt(doc, pos(0, 1), found.str).art, 's');
  assert.deepEqual(si.makeLink(doc, pos(0, 1), found.str, 'g'), { ok: true, str: found.str });
  assert.equal(noteAt(doc, pos(0, 1), found.str).art, 'g');
});

test('slideTarget moves the note to the string of the note just before it, like the slur does', function(){
  const k = slurSetup();
  let found = null;
  for (let m = k.lo + 2; m <= k.hi && !found; m++){
    const strs = k.stringsFor(m);
    for (let i = 0; i < strs.length && !found; i++){
      for (let j = 0; j < strs.length && !found; j++){
        if (i !== j && k.fretOn(strs[j], m - 1) !== null) found = { midi: m, a: strs[i], b: strs[j] };
      }
    }
  }
  assert.ok(found, 'a pitch playable on two strings exists');
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), found.b, k.fretOn(found.b, found.midi - 1));
  ti.setNote(doc, pos(0, 1), found.a, k.fretOn(found.a, found.midi));
  ti.setNoteAttrs(doc, pos(0, 1), found.a, { lh: 3, rh: 'm', art: '!', uncertain: true });
  const before = snapshot(doc);
  assert.deepEqual(si.slideTarget(doc, pos(0, 1), found.a), { ok: true, str: found.b, same: false });
  assert.deepEqual(si.slurTarget(doc, pos(0, 1), found.a), { ok: true, str: found.b, same: false }, 'the slur picks the same string');
  assert.deepEqual(snapshot(doc), before, 'slideTarget never edits the document');
  assert.deepEqual(si.makeSlide(doc, pos(0, 1), found.a), { ok: true, str: found.b });
  assert.equal(noteAt(doc, pos(0, 1), found.a), null, 'the old string is emptied');
  const moved = noteAt(doc, pos(0, 1), found.b);
  assert.equal(moved.fret, k.fretOn(found.b, found.midi), 'the fret is the pitch minus the open string of the new string');
  assert.equal(moved.art, 'g');
  assert.equal(moved.lh, null, 'the left hand finger is cleared');
  assert.equal(moved.rh, 'm', 'the right hand finger stays');
  assert.equal(moved.uncertain, true, 'the check mark stays');
  assert.deepEqual(ti.validateDoc(doc).errors, []);
});

test('slideTarget fails with the slide guide text when no string can link, and leaves the document alone', function(){
  const first = fresh();
  ti.setNote(first, pos(0, 0), 3, 2);
  let before = snapshot(first);
  assert.deepEqual(si.slideTarget(first, pos(0, 0), 3), { ok: false, error: SLIDE_STAFF_MESSAGE });
  assert.deepEqual(si.makeSlide(first, pos(0, 0), 3), { ok: false, error: SLIDE_STAFF_MESSAGE });
  assert.deepEqual(snapshot(first), before);
  assert.deepEqual(si.slurTarget(first, pos(0, 0), 3), { ok: false, error: SLUR_STAFF_MESSAGE }, 'the slur text is unchanged');
  const equal = fresh();
  ti.setNote(equal, pos(0, 0), 3, 2);
  ti.setNote(equal, pos(0, 1), 3, 2);
  before = snapshot(equal);
  assert.equal(si.makeSlide(equal, pos(0, 1), 3).error, SLIDE_STAFF_MESSAGE);
  assert.deepEqual(snapshot(equal), before);
  const empty = fresh();
  assert.deepEqual(si.slideTarget(empty, pos(0), 1), { ok: false, error: '슬라이드로 바꿀 음이 없습니다.' });
  assert.deepEqual(si.makeSlide(empty, pos(0), 1), { ok: false, error: '슬라이드로 바꿀 음이 없습니다.' });
  assert.deepEqual(si.linkTarget(empty, pos(0), 1, 's'), { ok: false, error: '슬러로 바꿀 음이 없습니다.' });
  assert.equal(si.slideTarget(empty, pos(7), 1).ok, false);
});

test('slideTarget on a harmonic note judges only its own string and the mark becomes a slide', function(){
  const notation = require('../src/notation.js');
  const hf = Number(Object.keys(notation.NATURAL_HARMONICS)[0]);
  const own = fresh();
  ti.setNote(own, pos(0, 0), 3, hf === 0 ? 1 : 0);
  ti.setNote(own, pos(0, 1), 3, hf);
  ti.setNoteAttrs(own, pos(0, 1), 3, { art: 'h' });
  assert.deepEqual(si.slideTarget(own, pos(0, 1), 3), { ok: true, str: 3, same: true });
  assert.deepEqual(si.makeSlide(own, pos(0, 1), 3), { ok: true, str: 3 });
  assert.equal(noteAt(own, pos(0, 1), 3).art, 'g', 'the harmonic mark was replaced by the slide');
  const lone = fresh();
  ti.setNote(lone, pos(0, 0), 3, hf);
  ti.setNoteAttrs(lone, pos(0, 0), 3, { art: 'h' });
  assert.deepEqual(si.slideTarget(lone, pos(0, 0), 3), { ok: false, error: '앞에 같은 줄 음이 없어 슬라이드로 이을 수 없습니다.' });
});

// 빈칸 _ : 오선 모드는 빈칸 칸에 사건을 넣지 않는다(Docs/staff-input.md 빈칸).
const SKIP_ERROR = '빈칸을 건너서는 음을 넣을 수 없습니다.';

test('placeEvent refuses an event that touches a skip cell and leaves the document unchanged', function(){
  const doc = fresh();
  ti.setSkip(doc, pos(0, 2), true);
  ti.setSkip(doc, pos(0, 3), true);
  const before = snapshot(doc);
  // 2분음표가 칸 1에서 시작해 빈칸 칸 2 로 들어간다
  const across = si.placeEvent(doc, pos(0, 1), 24, { midis: [64] });
  assert.deepEqual(across, { ok: false, error: SKIP_ERROR });
  assert.deepEqual(snapshot(doc), before);
  // 커서가 빈칸 칸 위
  assert.deepEqual(si.placeEvent(doc, pos(0, 2), 12, { midis: [64] }), { ok: false, error: SKIP_ERROR });
  assert.deepEqual(si.placeEvent(doc, pos(0, 3), 12, { rest: true }), { ok: false, error: SKIP_ERROR });
  assert.deepEqual(snapshot(doc), before);
  // 빈칸 칸을 지나 곡 끝을 넘는 긴 음도 같다
  assert.deepEqual(si.placeEvent(doc, pos(0, 0), 96, { midis: [64] }), { ok: false, error: SKIP_ERROR });
  assert.deepEqual(snapshot(doc), before);
});

test('placeEvent before a skip cell fills the rest where the sound really ends and keeps the skip cells', function(){
  const doc = fresh();
  ti.setSkip(doc, pos(0, 2), true);
  ti.setSkip(doc, pos(0, 3), true);
  const result = put(doc, pos(0, 1), 12, { midis: [64] });
  assert.deepEqual(result.next, pos(1, 0), 'the event ends at the first sounding cell after the skip cells');
  assert.equal(doc.measures.length, 2, 'a measure is added for the rest');
  assert.deepEqual(doc.measures[0].cells.map(c => c.skip), [false, false, true, true]);
  assert.equal(ti.getSlot(doc, pos(1, 0)).rest, true);
  assert.equal(noteAt(doc, pos(0, 1), 1) !== null, true);
  assert.deepEqual(tokens(doc)[0], ['r', 'E4@1', '_', '_']);
  // 뒤 빈칸이 아니라 다음 마디가 이미 있으면 거기에 쉼
  const longer = fresh();
  ti.setSkip(longer, pos(0, 3), true);
  ti.insertEmptyMeasure(longer, 1);
  const second = put(longer, pos(0, 2), 12, { midis: [64] });
  assert.deepEqual(second.next, pos(1, 0));
  assert.equal(longer.measures.length, 2);
  assert.equal(ti.getSlot(longer, pos(1, 0)).rest, true);
  assert.equal(longer.measures[0].cells[3].skip, true);
});

test('event moves skip skip cells in both directions, and Delete on a skip cell is refused', function(){
  const doc = fresh();
  ti.setNote(doc, pos(0, 0), 1, 0);
  ti.setRest(doc, pos(0, 1), true);
  ti.setSkip(doc, pos(0, 2), true);
  ti.setSkip(doc, pos(0, 3), true);
  ti.insertEmptyMeasure(doc, 1);
  ti.setSkip(doc, pos(1, 0), true);
  ti.setNote(doc, pos(1, 1), 1, 1);
  assert.deepEqual(si.nextEventPos(doc, pos(0, 1)), pos(1, 1), 'from the rest, over trailing skips and leading skips');
  assert.deepEqual(si.prevEventPos(doc, pos(1, 1)), pos(0, 1), 'and back');
  assert.deepEqual(si.nextEventPos(doc, pos(0, 0)), pos(0, 1));
  const stops = [];
  for (let p = pos(0, 0); p; p = si.nextEventPos(doc, p)) {
    assert.equal(ti.isSkipCell(doc, p), false, 'the cursor never lands on a skip cell');
    stops.push(p.m + ':' + p.c);
  }
  assert.equal(stops.includes('0:2') || stops.includes('0:3') || stops.includes('1:0'), false);
  const before = snapshot(doc);
  const refused = si.noteToRest(doc, pos(0, 2));
  assert.equal(refused.ok, false);
  assert.match(refused.error, /빈칸/);
  assert.deepEqual(snapshot(doc), before);
});

process.stdout.write('1..' + checks + '\n');
