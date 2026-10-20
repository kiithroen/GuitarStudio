const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const layoutApi = require('../src/staff-layout.js');
const rhythm = require('../src/rhythm.js');
const parser = require('../src/parser.js');

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

function layout(text, beats, key){
  const result = layoutApi.layoutScore(text, beats == null ? 4 : beats, key == null ? 0 : key);
  assert.equal(result.error, undefined, 'layout error: ' + result.error + ' for ' + JSON.stringify(text));
  return result;
}

// 토막 하나를 "종류:음표값 칸.위치/길이" 로 줄여 쓴다. 점은 '.', 셋잇단은 't', 붙임줄은 앞 '<' 뒤 '>'.
function brief(item){
  const value = item.value.base + (item.value.dots ? '.' : '') + (item.value.triplet ? 't' : '');
  return (item.tieFromPrev ? '<' : '') + item.type[0] + ':' + value + ' ' + item.cell + '.' + item.unit + '/' + item.lengthUnits + (item.tieToNext ? '>' : '');
}
function briefs(result, measure){ return result.measures[measure || 0].items.map(brief); }
function firstNote(result, measure, item){ return result.measures[measure || 0].items[item || 0].notes[0]; }

test('staff position: written octave is one higher, step counts from E4, ledger lines', function(){
  const low = firstNote(layout('E2 r r r'), 0, 0);
  assert.equal(low.step, -7);
  assert.deepEqual(low.ledger, [-2, -4, -6]);
  assert.equal(low.octave, 3);
  const b3 = firstNote(layout('B3 r r r'), 0, 0);
  assert.equal(b3.step, 4);
  assert.deepEqual(b3.ledger, []);
  const e4 = firstNote(layout('E4 r r r'), 0, 0);
  assert.equal(e4.step, 7);
  const e5 = firstNote(layout('E5 r r r'), 0, 0);
  assert.equal(e5.step, 14);
  assert.deepEqual(e5.ledger, [10, 12, 14]);
  const sharp = firstNote(layout('F#3 r r r'), 0, 0);
  assert.equal(sharp.letter, 'F');
  assert.equal(sharp.alter, 1);
  assert.equal(sharp.octave, 4);
  assert.equal(sharp.step, 1);
  assert.equal(sharp.name, 'F#3');
  assert.equal(firstNote(layout('Bb3 r r r'), 0, 0).name, 'Bb3');
  assert.equal(firstNote(layout('Bb3 r r r'), 0, 0).alter, -1);
  const open = firstNote(layout('E2@6 r r r'), 0, 0);
  assert.equal(open.str, 6);
  assert.equal(open.fret, 0);
  const result = layout('G3+E2+B3 r r r');
  assert.deepEqual(result.measures[0].items[0].notes.map(function(note){ return note.name; }), ['E2', 'G3', 'B3'], 'chord notes are sorted low to high');
});

test('natural harmonics are placed at the hand position pitch and marked harmonic', function(){
  const HARMONICS = require('../src/notation.js').NATURAL_HARMONICS;
  let count = 0;
  Object.keys(HARMONICS).forEach(function(handFret){
    parser.STRINGS.forEach(function(string){
      const soundName = parser.noteNameForMidi(string.midi + HARMONICS[handFret], false);
      const handName = parser.noteNameForMidi(string.midi + Number(handFret), false);
      const harmonic = firstNote(layout('h' + soundName + '@' + string.str + ' r r r'), 0, 0);
      const plain = firstNote(layout(handName + '@' + string.str + ' r r r'), 0, 0);
      assert.equal(harmonic.harmonic, true, soundName + ' is marked harmonic');
      assert.equal(plain.harmonic, undefined, 'a plain note is not marked');
      assert.equal(harmonic.step, plain.step, 'step follows the hand position, not the sounding pitch');
      assert.deepEqual(harmonic.ledger, plain.ledger);
      assert.equal(harmonic.name, plain.name);
      assert.equal(harmonic.str, string.str);
      assert.equal(harmonic.fret, Number(handFret));
      count++;
    });
  });
  assert.equal(count, Object.keys(HARMONICS).length * parser.STRINGS.length);
  // 화음 안에서도 구성음마다 표시가 따로
  const top = parser.STRINGS[0].midi + HARMONICS[Object.keys(HARMONICS)[0]];
  const chord = layout(parser.noteNameForMidi(parser.STRINGS[5].midi, false) + '@6+h' + parser.noteNameForMidi(top, false) + '@1 r r r');
  assert.deepEqual(chord.measures[0].items[0].notes.map(function(note){ return !!note.harmonic; }), [false, true]);
});

test('layout shape: time signature, grid and the sum of the lengths', function(){
  const times = { 2: [2, 4], 3: [3, 4], 4: [4, 4], 6: [6, 8], 8: [4, 4], 9: [9, 8] };
  Object.keys(times).forEach(function(beats){
    const text = new Array(Number(beats)).fill('r').join(' ');
    const result = layout(text, Number(beats));
    assert.deepEqual([result.time.numerator, result.time.denominator], times[beats], beats + ' cells time');
    assert.equal(result.unitsPerCell, 12);
    assert.equal(result.cellQuarter, rhythm.getGridInfo(Number(beats)).slotQuarterLength);
    assert.equal(result.beats, Number(beats));
    assert.equal(result.key, 0);
    assert.equal(result.measures.length, 1);
    assert.equal(result.measures[0].items.length, 1, beats + ' cells whole-measure rest');
    assert.equal(result.measures[0].items[0].lengthUnits, Number(beats) * 12);
  });
});

test('lengths: whole, dotted half, tied pieces and the syncopation rule', function(){
  assert.deepEqual(briefs(layout('E4 - - -')), ['c:whole 0.0/48']);
  assert.deepEqual(briefs(layout('E4 - - G4')), ['c:half. 0.0/36', 'c:quarter 3.0/12']);
  // 8칸: 5칸 유지는 가장 긴 표준 음표(2칸 단위 4칸=2분)와 1칸(8분)으로, 3칸은 점4분으로 자른다.
  assert.deepEqual(briefs(layout('E4 - - - - G4 - -', 8)), ['c:half 0.0/48>', '<c:eighth 4.0/12', 'c:quarter. 5.0/36']);
  // 당김음: 8분-4분-8분, 뒤의 쉼 두 칸은 2분쉼.
  const sync = layout('E4/F4 -/G4 r r');
  assert.deepEqual(briefs(sync), ['c:eighth 0.0/6', 'c:quarter 0.6/12', 'c:eighth 1.6/6', 'r:half 2.0/24']);
  assert.equal(sync.measures[0].items[1].tieToNext, false, 'the syncopated quarter is one piece');
  assert.deepEqual(briefs(layout('r r r r')), ['r:whole 0.0/48']);
  assert.deepEqual(briefs(layout('E4 r r r')), ['c:quarter 0.0/12', 'r:half. 1.0/36']);
});

test('dotted values that are not a whole number of cells stay one piece', function(){
  // 4칸: 한 칸 반 길이는 점4분 하나, 붙임줄 없음.
  const quarter = layout('r r E4 -/D4');
  assert.deepEqual(briefs(quarter), ['r:half 0.0/24', 'c:quarter. 2.0/18', 'c:eighth 3.6/6']);
  assert.equal(quarter.measures[0].items[1].tieToNext, false);
  // 6칸(8분음표 칸): 3칸은 점4분, 1.5칸은 점8분 하나.
  const six = layout('E4 - - D4 -/F4 r', 6);
  assert.deepEqual(briefs(six), ['c:quarter. 0.0/36', 'c:eighth. 3.0/18', 'c:16th 4.6/6', 'r:eighth 5.0/12']);
  six.measures[0].items.forEach(function(item){ assert.ok(!item.tieToNext, 'no ties'); });
});

test('syncopation rule is not used when the rest of the note would be unplayable', function(){
  // 둘째 칸 위치 6에서 시작해 셋째 칸 위치 8에서 끝나는 음: 12짜리를 먼저 떼면 2가 남는다.
  const result = layout('r/E4 -/-/r r r', 4);
  assert.equal(result.error, undefined);
  const items = result.measures[0].items;
  const chordPieces = items.filter(function(item){ return item.type === 'chord'; });
  assert.deepEqual(chordPieces.map(function(item){ return item.lengthUnits; }), [6, 8]);
  assert.equal(items.reduce(function(sum, item){ return sum + item.lengthUnits; }, 0), 48);
});

test('triplets: three eighths, quarter plus eighth, eighth plus quarter', function(){
  const three = layout('E4/F4/G4 r r r');
  assert.deepEqual(briefs(three), ['c:eightht 0.0/4', 'c:eightht 0.4/4', 'c:eightht 0.8/4', 'r:half. 1.0/36']);
  assert.equal(three.measures[0].tuplets.length, 1);
  assert.deepEqual(three.measures[0].tuplets[0], { cell: 0, items: [0, 1, 2] });
  assert.equal(three.measures[0].beams.length, 1);
  assert.deepEqual(three.measures[0].beams[0], { items: [0, 1, 2], levels: [1, 1, 1] });
  const a = layout('E4/-/F4 r r r');
  assert.deepEqual(briefs(a), ['c:quartert 0.0/8', 'c:eightht 0.8/4', 'r:half. 1.0/36']);
  assert.deepEqual(a.measures[0].tuplets, [{ cell: 0, items: [0, 1] }]);
  assert.equal(a.measures[0].beams.length, 0);
  const b = layout('E4/F4/- r r r');
  assert.deepEqual(briefs(b), ['c:eightht 0.0/4', 'c:quartert 0.4/8', 'r:half. 1.0/36']);
  assert.deepEqual(b.measures[0].tuplets, [{ cell: 0, items: [0, 1] }]);
  // 8분음표 칸에서는 셋잇단이 16분음표 단위다.
  const eighthCells = layout('E4/F4/G4 r r r r r r r', 8);
  assert.deepEqual(briefs(eighthCells).slice(0, 3), ['c:16tht 0.0/4', 'c:16tht 0.4/4', 'c:16tht 0.8/4']);
});

test('dotted notes and sixteenths: dotted eighth plus sixteenth', function(){
  const result = layout('E4/-/-/F4 r r r');
  assert.deepEqual(briefs(result), ['c:eighth. 0.0/9', 'c:16th 0.9/3', 'r:half. 1.0/36']);
  assert.deepEqual(result.measures[0].beams, [{ items: [0, 1], levels: [1, 2] }]);
});

test('a note held across the barline is cut and tied, source stays at the first strike', function(){
  const result = layout('r r r E4\n- r r r');
  const first = result.measures[0].items;
  const second = result.measures[1].items;
  const last = first[first.length - 1];
  assert.equal(last.type, 'chord');
  assert.equal(last.tieToNext, true);
  assert.equal(last.tieFromPrev, false);
  assert.deepEqual(last.source, { measureIndex: 0, beatIndex: 3, subIndex: null });
  assert.equal(second[0].type, 'chord');
  assert.equal(second[0].tieFromPrev, true);
  assert.equal(second[0].tieToNext, false);
  assert.deepEqual(second[0].source, { measureIndex: 0, beatIndex: 3, subIndex: null });
  assert.equal(second[0].notes[0].accidental, null);
  assert.equal(second[1].type, 'rest');
  assert.equal(second[1].tieFromPrev, undefined, 'rests carry no ties');
});

test('beam groups: per cell for quarter cells, per three cells in 6/8, per two cells for 8 cells', function(){
  const quarter = layout('E4/F4 G4/A4 B3/C4 D4/E4', 4);
  assert.equal(quarter.measures[0].beams.length, 4);
  quarter.measures[0].beams.forEach(function(beam, index){
    assert.deepEqual(beam.items, [index * 2, index * 2 + 1]);
    assert.deepEqual(beam.levels, [1, 1]);
  });
  const six = layout('E4 F4 G4 A4 B3 C4', 6);
  assert.deepEqual(six.measures[0].beams.map(function(beam){ return beam.items; }), [[0, 1, 2], [3, 4, 5]]);
  const sixteenths = layout('E4/F4 G4/A4 B3/C4 D4/E4 E4/F4 G4/A4 B3/C4 D4/E4', 8);
  assert.deepEqual(sixteenths.measures[0].beams.map(function(beam){ return beam.items; }), [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]]);
  assert.deepEqual(sixteenths.measures[0].beams[0].levels, [2, 2, 2, 2]);
  // 쉼이 끼면 묶음이 끊긴다.
  const broken = layout('r E4 F4 r G4 A4', 6);
  assert.deepEqual(broken.measures[0].beams.map(function(beam){ return beam.items; }), [[1, 2], [4, 5]]);
  const groups = layout('r E4 F4 G4 A4 r', 6);
  assert.deepEqual(groups.measures[0].beams.map(function(beam){ return beam.items; }), [[1, 2], [3, 4]], 'a run is cut at the beat group edge');
  // 4분음표 이상은 묶지 않는다.
  assert.equal(layout('E4 F4 G4 A4').measures[0].beams.length, 0);
});

test('accidentals follow the key signature and the measure state', function(){
  const sharpKey = layout('F#3 F3 F#3 F#3\nF#3 r r r', 4, 1);
  const m0 = sharpKey.measures[0].items.map(function(item){ return item.notes[0].accidental; });
  assert.deepEqual(m0, [null, 'natural', 'sharp', null]);
  assert.equal(sharpKey.measures[1].items[0].notes[0].accidental, null, 'next measure starts from the key again');
  const flatNone = layout('Bb3 Bb3 B3 r', 4, 0);
  assert.deepEqual(flatNone.measures[0].items.slice(0, 3).map(function(item){ return item.notes[0].accidental; }), ['flat', null, 'natural']);
  // 다른 옥타브의 같은 글자는 따로 센다(조표는 모든 옥타브에 적용).
  const octaves = layout('F3 F2 F3 r', 4, 1);
  assert.deepEqual(octaves.measures[0].items.slice(0, 3).map(function(item){ return item.notes[0].accidental; }), ['natural', 'natural', null]);
  // 붙임줄로 이어진 뒤 토막에는 임시표를 다시 붙이지 않는다.
  const tied = layout('F#3 - - -\nr r r r', 4, 0);
  assert.equal(tied.measures[0].items[0].notes[0].accidental, 'sharp');
  const heldAcross = layout('r r r F#3\n- r r r', 4, 0);
  assert.equal(heldAcross.measures[0].items[1].notes[0].accidental, 'sharp');
  assert.equal(heldAcross.measures[1].items[0].notes[0].accidental, null);
  const tiedInside = layout('F#3 - - - - - - - -', 9, 0);
  const pieces = tiedInside.measures[0].items;
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].notes[0].accidental, 'sharp');
  pieces.slice(1).forEach(function(piece){ assert.equal(piece.notes[0].accidental, null); });
  // 내림 조표와 조표가 없는 경우의 환원.
  const flats = layout('Bb3 B3 Bb3 r', 4, -1);
  assert.deepEqual(flats.measures[0].items.slice(0, 3).map(function(item){ return item.notes[0].accidental; }), [null, 'natural', 'flat']);
});

test('stems: farthest note from the middle line decides, beam groups share one stem', function(){
  assert.equal(layout('E2 r r r').measures[0].items[0].stem, 'up');
  assert.equal(layout('E5 r r r').measures[0].items[0].stem, 'down');
  assert.equal(layout('B3 r r r').measures[0].items[0].stem, 'down', 'on the middle line goes down');
  assert.equal(layout('E4 - - -').measures[0].items[0].stem, null, 'whole note has no stem');
  const mixed = layout('B3/E5 r r r');
  assert.deepEqual(mixed.measures[0].beams[0].items, [0, 1]);
  assert.deepEqual(mixed.measures[0].items.slice(0, 2).map(function(item){ return item.stem; }), ['down', 'down']);
  const lowFar = layout('E2/E4 r r r');
  assert.deepEqual(lowFar.measures[0].items.slice(0, 2).map(function(item){ return item.stem; }), ['up', 'up']);
  const chord = layout('G3+D4 r r r');
  assert.equal(chord.measures[0].items[0].stem, 'down', 'equal distance goes down');
});

test('whole rest and check marks', function(){
  const rest = layout('r r r r');
  assert.equal(rest.measures[0].items.length, 1);
  assert.equal(rest.measures[0].items[0].type, 'rest');
  assert.equal(rest.measures[0].items[0].value.base, 'whole');
  assert.equal(rest.measures[0].items[0].cell, 0);
  assert.equal(rest.measures[0].items[0].unit, 0);
  assert.equal(rest.measures[0].items[0].lengthUnits, 48);
  assert.equal(rest.measures[0].items[0].uncertain, false);
  assert.equal(layout('E4? - - -').measures[0].items[0].uncertain, true);
  assert.equal(layout('E4 - - -').measures[0].items[0].uncertain, false);
  assert.equal(layout('r? r r r').measures[0].items[0].uncertain, true);
  assert.equal(layout('r r r r').measures[0].items[0].uncertain, false);
  const mixed = layout('E4+G4? r? r r');
  assert.equal(mixed.measures[0].items[0].uncertain, true);
  assert.deepEqual(mixed.measures[0].items[0].notes.map(function(note){ return note.uncertain; }), [false, true]);
  assert.equal(mixed.measures[0].items[1].type, 'rest');
  assert.equal(mixed.measures[0].items[1].uncertain, true);
});

// 슬러 곡선: 판정은 GuitarNotation.linkSlurs 하나이고, 배치는 그 결과를 마디별 slurs 에 싣는다.
function noteAt(result, measure, item, head){ return result.measures[measure].items[item].notes[head]; }

test('slur in one measure: one curve from the source head to the slurred head', function(){
  const result = layout('E4/sF4 - - -');
  const slurs = result.measures[0].slurs;
  assert.equal(slurs.length, 1);
  const slur = slurs[0];
  assert.deepEqual(Object.keys(slur).sort(), ['fromHead', 'fromItem', 'kind', 'toHead', 'toItem']);
  assert.equal(slur.kind, 'slur');
  assert.equal(noteAt(result, 0, slur.fromItem, slur.fromHead).name, 'E4');
  assert.equal(noteAt(result, 0, slur.toItem, slur.toHead).name, 'F4');
  assert.equal(slur.toItem, slur.fromItem + 1);
  assert.deepEqual(layout('E4 F4 - -').measures[0].slurs, [], 'no slur letter, no curve');
  const chain = layout('E4 sF4 sG4 - ').measures[0].slurs;
  assert.equal(chain.length, 2, 'a chain of slurs is one curve per slurred note');
  assert.equal(chain[1].fromItem, chain[0].toItem, 'the second curve starts where the first ends');
});

test('slur across the barline: the source measure leaves through the right edge, the target measure enters from the left', function(){
  const result = layout('r r r E4\nsF4 - - -');
  assert.deepEqual(result.measures[0].slurs.map(function(s){ return Object.keys(s).sort(); }), [['fromHead', 'fromItem', 'kind', 'toEdge']]);
  assert.deepEqual(result.measures[1].slurs.map(function(s){ return Object.keys(s).sort(); }), [['fromEdge', 'kind', 'toHead', 'toItem']]);
  const out = result.measures[0].slurs[0], into = result.measures[1].slurs[0];
  assert.equal(out.toEdge, true);
  assert.equal(into.fromEdge, true);
  assert.equal(noteAt(result, 0, out.fromItem, out.fromHead).name, 'E4');
  assert.equal(noteAt(result, 1, into.toItem, into.toHead).name, 'F4');
});

test('slur two measures apart: only the source measure and the target measure get a half each', function(){
  const far = layout('r r r E4\n- - - -\nsF4 - - -');
  assert.deepEqual(far.measures.map(function(m){ return m.slurs.length; }), [0, 1, 1], 'the source note is last cut in the held measure');
  assert.equal(far.measures[1].slurs[0].toEdge, true);
  assert.equal(far.measures[2].slurs[0].fromEdge, true);
  const wide = layout('r r r E4\n- - - -\n- - - -\nsF4 - - -');
  assert.deepEqual(wide.measures.map(function(m){ return m.slurs.length; }), [0, 0, 1, 1], 'no curve is drawn in the measures in between');
});

test('a slur after a rest is an invalid score, so the layout fails', function(){
  const result = layoutApi.layoutScore('E4 r sF4 -', 4, 0);
  assert.ok(result.error, 'no source after a rest');
  assert.ok(layoutApi.layoutScore('sF4 r r r', 4, 0).error, 'no source at the start of the song');
});

test('slur inside a chord: only the slurred component gets a curve, between the same-string heads', function(){
  const result = layout('E2@6+E4@1 E2@6+sF4@1 - r');
  const slurs = result.measures[0].slurs;
  assert.equal(slurs.length, 1);
  const slur = slurs[0];
  assert.equal(noteAt(result, 0, slur.fromItem, slur.fromHead).name, 'E4');
  assert.equal(noteAt(result, 0, slur.toItem, slur.toHead).name, 'F4');
  assert.equal(slur.fromHead, 1, 'the upper head of the two-note chord');
  assert.equal(slur.toHead, 1);
  // 화음 안에서 낮은 줄끼리 이어도 그 구성음 머리를 가리킨다
  const low = layout('E2@6+E4@1 sF2@6+E4@1 - r').measures[0].slurs;
  assert.equal(low.length, 1);
  assert.equal(low[0].fromHead, 0);
  assert.equal(low[0].toHead, 0);
});

test('slur judging uses the sounding pitch of a harmonic, not the hand position', function(){
  // 7프렛 하모닉스는 손 대는 자리가 B2, 울리는 음은 B3. 손 대는 자리 B2로 판정했다면 같은 높이 오류가 났을 것이다.
  const result = layout('hB3@6 sB2@6 - -');
  assert.equal(result.measures[0].slurs.length, 1);
  assert.equal(noteAt(result, 0, 0, 0).harmonic, true);
  assert.equal(noteAt(result, 0, 0, 0).name, 'B2', 'the harmonic head sits at the hand position');
});

test('a source note split by ties curves from its last piece, and a split target gets the curve at its first piece', function(){
  const source = layout('E4 - - - - sF4 - -', 8);
  const items = source.measures[0].items;
  assert.deepEqual(briefs(source), ['c:half 0.0/48>', '<c:eighth 4.0/12', 'c:quarter. 5.0/36']);
  const slur = source.measures[0].slurs[0];
  assert.equal(items.length, 3);
  assert.equal(slur.fromItem, 1, 'the source curve leaves the last tied piece');
  assert.equal(slur.toItem, 2);
  const target = layout('E4 sF4 - - - - - -', 8);
  const tItems = target.measures[0].items;
  assert.ok(tItems.length >= 3, 'the slurred note is cut into several pieces');
  const tslur = target.measures[0].slurs[0];
  assert.equal(tslur.fromItem, 0);
  assert.equal(tslur.toItem, 1, 'the curve ends at the first piece of the slurred note');
  assert.equal(tItems[tslur.toItem].tieFromPrev, false);
  // 마디를 넘는 붙임줄 음에서 나가는 슬러는 마지막 토막이 있는 마디에서 나간다
  const across = layout('E4 - - -\n- - - -\nsF4 - - -');
  assert.deepEqual(across.measures.map(function(m){ return m.slurs.length; }), [0, 1, 1]);
  assert.equal(across.measures[1].slurs[0].toEdge, true);
});

// 슬라이드(g): 슬러와 같은 linkSlurs 결과를 쓰고, 항목에 kind 'slide' 와 방향 dir 이 실린다.
test('slide: an entry carries kind slide and a direction, a slur entry carries kind slur and no direction', function(){
  const up = layout('E3@4 gF#3@4 - -').measures[0].slurs;
  assert.equal(up.length, 1);
  assert.equal(up[0].kind, 'slide');
  assert.equal(up[0].dir, 'up');
  assert.equal(up[0].toItem, up[0].fromItem + 1);
  const down = layout('F#3@4 gE3@4 - -').measures[0].slurs;
  assert.equal(down.length, 1);
  assert.equal(down[0].kind, 'slide');
  assert.equal(down[0].dir, 'down');
  const slur = layout('E3@4 sF#3@4 - -').measures[0].slurs;
  assert.equal(slur[0].kind, 'slur');
  assert.ok(!('dir' in slur[0]), 'a slur has no direction');
  const mixed = layout('E3@4 sF#3@4 gG3@4 -').measures[0].slurs;
  assert.deepEqual(mixed.map(function(entry){ return entry.kind; }), ['slur', 'slide'], 'the kind follows the target note');
});

test('slide: laid out without an error as a plain note, a chord component, and in split cells', function(){
  const plain = layout('E3@4 gF#3@4 - -');
  assert.equal(noteAt(plain, 0, 1, 0).name, 'F#3', 'the articulation letter is not read as part of the note name');
  const chord = layout('E3@4 A2@5+gG3@4 - -');
  const chordSlides = chord.measures[0].slurs;
  assert.equal(chordSlides.length, 1);
  assert.equal(chordSlides[0].kind, 'slide');
  assert.equal(noteAt(chord, 0, chordSlides[0].fromItem, chordSlides[0].fromHead).name, 'E3');
  assert.equal(noteAt(chord, 0, chordSlides[0].toItem, chordSlides[0].toHead).name, 'G3');
  const splitTo = layout('E3@4/gF#3@4 - - -').measures[0].slurs;
  assert.equal(splitTo.length, 1);
  assert.equal(splitTo[0].kind, 'slide');
  const splitFrom = layout('E3@4 F#3@4/gG3@4 - -').measures[0].slurs;
  assert.equal(splitFrom.length, 1);
  assert.equal(splitFrom[0].kind, 'slide');
  assert.equal(splitFrom[0].dir, 'up');
});

test('slide across the barline: both halves carry kind slide and the direction', function(){
  const up = layout('r r r E3@4\ngF#3@4 - - -');
  assert.deepEqual(up.measures[0].slurs.map(function(s){ return [s.kind, s.dir, !!s.toEdge]; }), [['slide', 'up', true]]);
  assert.deepEqual(up.measures[1].slurs.map(function(s){ return [s.kind, s.dir, !!s.fromEdge]; }), [['slide', 'up', true]]);
  const down = layout('r r r F#3@4\ngE3@4 - - -');
  assert.equal(down.measures[0].slurs[0].dir, 'down');
  assert.equal(down.measures[1].slurs[0].dir, 'down');
});

// 롤(~): 화음 item 의 roll 은 롤 사건의 첫 토막에만 true 다. 쉼 item 에는 roll 이 없다.
function rolls(result){
  return result.measures.map(function(measure){
    return measure.items.map(function(item){ return item.type === 'chord' ? item.roll : null; });
  });
}

test('roll: a rolled chord item carries roll true, a plain chord carries false, rests carry none', function(){
  const result = layout('~E2@6+B3@2+G4@1 E2@6+B3@2+G4@1 ~E2@6+B3@2 r');
  const items = result.measures[0].items;
  assert.deepEqual(items.map(function(item){ return item.type === 'chord' ? item.roll : null; }), [true, false, true, null]);
  assert.equal(items[3].type, 'rest');
  assert.ok(!('roll' in items[3]), 'a rest has no roll field');
  assert.equal(items[0].notes.length, 3, 'the roll mark is not read as part of a note name');
  assert.deepEqual(items[0].notes.map(function(note){ return note.name; }), ['E2', 'B3', 'G4']);
  rolls(layout('E2@6+B3@2+G4@1 - - -')).forEach(function(row){ row.forEach(function(value){ assert.equal(value, false); }); });
});

test('roll: only the first piece of a rolled chord that is tied across cells or the barline carries roll', function(){
  const held = layout('~E2@6+B3@2+G4@1 - - -');
  assert.deepEqual(rolls(held), [[true]], 'a whole-note chord is a single piece');
  const cells = layout('~E2@6+B3@2+G4@1 - - - - G4 - -', 8);
  const cellItems = cells.measures[0].items;
  const cellChords = cellItems.filter(function(item){ return item.type === 'chord' && item.notes.length === 3; });
  assert.ok(cellChords.length >= 2, 'the rolled chord is cut into several pieces');
  assert.deepEqual(cellChords.map(function(item){ return item.roll; }), cellChords.map(function(item, index){ return index === 0; }), 'only the first piece has roll');
  assert.equal(cellChords[1].tieFromPrev, true);
  const across = layout('r r r ~E2@6+B3@2+G4@1\n- - r r');
  assert.deepEqual(rolls(across)[0].filter(function(value){ return value !== null; }), [true], 'the struck piece has roll');
  const next = across.measures[1].items;
  assert.equal(next[0].tieFromPrev, true);
  assert.deepEqual(rolls(across)[1].filter(function(value){ return value !== null; }), [false], 'the piece after the barline has no roll');
  const split = layout('~E2@6+B3@2+G4@1 - - ~E2@6+B3@2+G4@1\n- - - -');
  assert.deepEqual(rolls(split), [[true, true], [false]], 'two struck chords roll, the piece held into the next measure does not');
});

test('roll: in a split cell only the rolled piece carries roll', function(){
  const result = layout('C3@5/~A3@3+D4@2+F#4@1 - - -');
  const chords = result.measures[0].items.filter(function(item){ return item.type === 'chord'; });
  const struck = chords.filter(function(item){ return !item.tieFromPrev; });
  assert.equal(struck.length, 2);
  assert.deepEqual(struck.map(function(item){ return item.roll; }), [false, true], 'the single note before it is not rolled, the chord piece is');
  chords.filter(function(item){ return item.tieFromPrev; }).forEach(function(item){ assert.equal(item.roll, false, 'the tied rest of the chord is not rolled'); });
  const both = layout('~E2@6+B3@2/~A3@3+D4@2 - - -');
  assert.deepEqual(both.measures[0].items.filter(function(item){ return !item.tieFromPrev && item.type === 'chord'; }).map(function(item){ return item.roll; }), [true, true]);
});

test('invalid scores return an error', function(){
  assert.ok(layoutApi.layoutScore('E4 - -', 4, 0).error, 'too few cells');
  assert.ok(layoutApi.layoutScore('- E4 r r', 4, 0).error, 'orphan hold');
  assert.ok(layoutApi.layoutScore('Z9 r r r', 4, 0).error, 'unknown note');
  assert.ok(layoutApi.layoutScore('E4 r r r', 4, 7).error, 'key out of range');
});

test('every built-in song lays out: lengths add up, strikes match, steps stay on the staff', function(){
  const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '../songs.json'), 'utf8'));
  let count = 0;
  songs.forEach(function(song){
    const text = song.lines.join('\n');
    const result = layoutApi.layoutScore(text, song.beats, 0);
    assert.equal(result.error, undefined, song.id + ': ' + result.error);
    const expected = rhythm.annotate(parser.parseScore(text, song.beats).measures, song.beats);
    let strikes = 0;
    result.measures.forEach(function(measure, index){
      const total = measure.items.reduce(function(sum, item){ return sum + item.lengthUnits; }, 0);
      assert.equal(total, song.beats * 12, song.id + ' measure ' + (index + 1) + ' length');
      measure.items.forEach(function(item){
        if (item.type !== 'chord') return;
        if (!item.tieFromPrev) strikes++;
        item.notes.forEach(function(note){
          assert.ok(note.step >= -7 && note.step <= 14, song.id + ' step ' + note.step);
        });
      });
    });
    assert.equal(strikes, expected.events.length, song.id + ' strikes');
    count++;
  });
  assert.ok(count >= 20, 'checked the built-in songs');
  process.stdout.write('  built-in songs: ' + count + '\n');
});

// 빈칸 _ : 마디 경계는 rhythm 의 실제 시간으로 자르고, 앞 빈칸 수만큼 칸을 밀어 TAB 칸 아래에 둔다(Docs/staff-notation.md).
test('skip cells: the pickup measure note sits under its TAB cell and later measures start at cell 0', function(){
  const result = layout('[-] _ _ _ E4\n[C] E4 F4 G4 A4');
  assert.deepEqual(briefs(result, 0), ['c:quarter 3.0/12']);
  assert.deepEqual(briefs(result, 1), ['c:quarter 0.0/12', 'c:quarter 1.0/12', 'c:quarter 2.0/12', 'c:quarter 3.0/12']);
  assert.equal(result.measures[0].items.some(function(item){ return item.cell < 3; }), false, 'nothing is drawn in the skip cells');
  // 앞 빈칸이 둘이면 두 칸 밀린다
  const two = layout('[-] _ _ E4 F4\n[C] E4 F4 G4 A4');
  assert.deepEqual(briefs(two, 0), ['c:quarter 2.0/12', 'c:quarter 3.0/12']);
});

test('skip cells: a short measure ending in skips, and a note after a middle pickup measure', function(){
  const trailing = layout('[G] B3 D4 _ _\n[C] E4 F4 G4 A4');
  assert.deepEqual(briefs(trailing, 0), ['c:quarter 0.0/12', 'c:quarter 1.0/12']);
  assert.equal(trailing.measures[1].items[0].cell, 0, 'the next measure starts at its own cell 0');
  assert.deepEqual(briefs(trailing, 1), ['c:quarter 0.0/12', 'c:quarter 1.0/12', 'c:quarter 2.0/12', 'c:quarter 3.0/12']);
  const middle = layout('E4 F4 G4 A4\n_ _ B3 D4\nE4 F4 G4 A4');
  assert.deepEqual(briefs(middle, 1), ['c:quarter 2.0/12', 'c:quarter 3.0/12']);
  assert.equal(middle.measures[2].items[0].cell, 0);
  assert.equal(middle.measures[2].items.length, 4);
  const single = layout('E4 _ _ _\nF4 G4 A4 B3');
  assert.deepEqual(briefs(single, 0), ['c:quarter 0.0/12']);
  assert.equal(single.measures[1].items[0].cell, 0);
});

test('skip cells: a measure with skips never gets a whole rest, a measure without them still does', function(){
  const front = layout('r r _ _\nE4 F4 G4 A4');
  assert.deepEqual(briefs(front, 0), ['r:half 0.0/24'], 'rests are split by length, not a whole rest');
  assert.equal(front.measures[0].items.some(function(item){ return item.value.base === 'whole'; }), false);
  const back = layout('E4 F4 G4 A4\n_ _ r r');
  assert.deepEqual(briefs(back, 1), ['r:half 2.0/24']);
  const three = layout('r r r _\nE4 F4 G4 A4');
  assert.deepEqual(briefs(three, 0), ['r:half. 0.0/36']);
  const plain = layout('r r r r\nE4 F4 G4 A4');
  assert.deepEqual(briefs(plain, 0), ['r:whole 0.0/48'], 'no skips: the whole rest is unchanged');
  const mixed = layout('_ _ E4 F4\nr r r r');
  assert.deepEqual(briefs(mixed, 1), ['r:whole 0.0/48']);
});

test('skip cells: beams follow the real cells, and ties cross the barline over trailing skips', function(){
  const result = layout('_ _ E4/F4 G4\nA4 - - -');
  assert.deepEqual(briefs(result, 0), ['c:eighth 2.0/6', 'c:eighth 2.6/6', 'c:quarter 3.0/12']);
  assert.deepEqual(result.measures[0].beams[0].items, [0, 1]);
  const sum = result.measures[0].items.reduce(function(total, item){ return total + item.lengthUnits; }, 0);
  assert.equal(sum, 2 * 12, 'the measure length is the playable cells');
  const tie = layout('E4 F4 G4 A4\nB3 D4 _ _\n- - E4 F4');
  assert.equal(tie.measures[2].items[0].tieFromPrev, true);
  assert.equal(tie.measures[1].items[1].tieToNext, true);
});

process.stdout.write('1..' + checks + '\n');
