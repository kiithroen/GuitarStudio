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

process.stdout.write('1..' + checks + '\n');
