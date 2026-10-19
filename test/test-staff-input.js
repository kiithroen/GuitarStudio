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
  assert.match(bad.error, /^이 길이는 지금 칸 수에서 못 적어\./);
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
  assert.match(result.error, /맞지 않아/);
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
  ti.setNote(top, pos(0), 1, 12);
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
  ti.setNoteAttrs(doc, pos(0), 1, { lh: 3, rh: 'p', art: '~', uncertain: true });
  assert.deepEqual(si.stringCandidates(doc, pos(0), 1), [
    { str: 1, fret: 0, current: true },
    { str: 2, fret: 5, current: false },
    { str: 3, fret: 9, current: false }
  ]);
  ti.setNote(doc, pos(0), 3, 0);
  assert.deepEqual(si.stringCandidates(doc, pos(0), 1).map(function(c){ return c.str; }), [1, 2]);
  assert.deepEqual(si.stringCandidates(doc, pos(0), 5), []);
  const refused = si.moveToString(doc, pos(0), 1, 4);
  assert.equal(refused.ok, false);
  assert.equal(si.moveToString(doc, pos(0), 1, 3).ok, false);
  assert.deepEqual(si.moveToString(doc, pos(0), 1, 2), { ok: true, str: 2 });
  assert.deepEqual(noteAt(doc, pos(0), 2), { fret: 5, lh: null, rh: 'p', art: '~', uncertain: true });
  assert.equal(noteAt(doc, pos(0), 1), null);
  const plain = fresh();
  put(plain, pos(0), 12, { midis: [64] });
  si.moveToString(plain, pos(0), 1, 2);
  assert.equal(tokens(plain)[0][0], 'E4@2');
});

test('writtenToMidi: guitar range E2-E5, written an octave above sounding', function(){
  const doc = fresh();
  const low = si.writtenToMidi(doc, pos(0), 'D', 3);
  assert.equal(low.midi, undefined);
  assert.equal(low.error, '기타 음역(E2~E5) 밖이야.');
  assert.deepEqual(si.writtenToMidi(doc, pos(0), 'E', 6), { midi: 76 });
  assert.deepEqual(si.writtenToMidi(doc, pos(0), 'E', 3), { midi: 40 });
  assert.equal(si.writtenToMidi(doc, pos(0), 'F', 6).error, '기타 음역(E2~E5) 밖이야.');
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

process.stdout.write('1..' + checks + '\n');
