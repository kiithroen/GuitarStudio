const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('../src/parser.js');
const score = require('../src/score.js');

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

const parse = parser.parseScore;
assert.equal(global.GuitarParser, undefined, 'CommonJS loading does not write to the Node global');

test('single notes retain English, Korean, octave, fingering, and string override', function(){
  const english = parser.parseNoteToken('E4', 0);
  assert.equal(english.midi, 64);
  assert.equal(english.en, 'E4');
  assert.equal(parser.parseNoteToken('3솔', 0).midi, 67);
  assert.equal(parser.parseNoteToken('4D4', 0).pos.lh, 4);
  assert.equal(parser.parseNoteToken('C3', 0).midi, 48);
  const overridden = parser.parseNoteToken('1E4@2', 0);
  assert.equal(overridden.pos.str, 2);
  assert.equal(overridden.pos.fret, 5);
  assert.equal(overridden.customTok, '1E4@2');
});

test('bass plus melody and multi-note chords preserve roles and ascending arpeggio order', function(){
  const pair = parser.parseNoteToken('0E2+4B4', 0);
  assert.equal(pair.bass.midi, 40);
  assert.equal(pair.midi, 71);
  assert.equal(pair.chordNotes.length, 2);
  const chord = parser.parseNoteToken('0E2+!0E4+!3G4+!4B4', 0);
  assert.deepEqual(chord.chordNotes.map(n => n.midi), [40, 64, 67, 71]);
  assert.equal(chord.chordNotes[0].rh, 'p');
  assert.equal(chord.chordNotes[3].midi, 71);
});

test('two, three, and four subdivisions preserve tokens and duration fractions', function(){
  for (const [token, count] of [['C4/D4', 2], ['C4/D4/E4', 3], ['C4/D4/E4/F4', 4]]){
    const measure = parse('[C] ' + token + ' - - -', 4).measures[0];
    const beat = measure.beats[0];
    assert.equal(beat.tok, token);
    assert.equal(beat.subNotes.length, count);
    assert.equal(beat.subNotes.reduce((sum, n) => sum + n.durFrac, 0), 1);
  }
  const triplet = parse('[C] C4/D4/E4 - - -', 4).measures[0].beats[0];
  assert.equal(score.getBeatDurationInfo([triplet], 0, 4).durName, '셋잇단음표');
});

test('held-note dotted rhythm C4 -/D4 has a 1.5 beat duration', function(){
  const beats = parse('[C] C4 -/D4 - -', 4).measures[0].beats;
  const duration = score.getBeatDurationInfo(beats, 0, 4);
  assert.equal(duration.label, '점4분');
  assert.match(duration.durName, /1\.5박/);
  assert.equal(beats[1].subNotes[0].tok, '-');
});

test('measure separators are newline, CRLF, spaced slash, and double slash only', function(){
  assert.deepEqual(parser.splitScoreMeasures('C4 -\nD4 -'), ['C4 -', 'D4 -']);
  assert.deepEqual(parser.splitScoreMeasures('C4 -\r\nD4 -'), ['C4 -', 'D4 -']);
  assert.deepEqual(parser.splitScoreMeasures('C4 - / D4 -'), ['C4 -', 'D4 -']);
  assert.deepEqual(parser.splitScoreMeasures('C4 -//D4 -'), ['C4 -', 'D4 -']);
  assert.deepEqual(parser.splitScoreMeasures('a/b E3/G3'), ['a/b E3/G3']);
  const grouped = parse('[C] C4,D4 (E4 F4) - -', 4).measures[0];
  assert.deepEqual(grouped.beats.slice(0, 2).map(beat => beat.subNotes.length), [2, 2]);
  assert.deepEqual(grouped.beats.slice(0, 2).map(beat => beat.subNotes.map(note => note.midi)), [[60, 62], [64, 65]]);
  const scoreData = parse('[C] 2E3/0G3 - - - | lyric a/b', 4);
  assert.equal(scoreData.measures.length, 1);
  assert.equal(scoreData.measures[0].beats[0].subNotes.length, 2);
  assert.equal(scoreData.measures[0].lyric, 'lyric a/b');
});

test('explicit, inferred, and absent chords retain their modes', function(){
  const explicit = parse('[G7] C4 D4 E4 G4', 4).measures[0];
  assert.equal(explicit.chord, 'G7');
  assert.equal(explicit.autoChord, false);
  const automatic = parse('[자동] C4 E4 G4 C5', 4).measures[0];
  assert.ok(automatic.chord);
  assert.equal(automatic.autoChord, true);
  const none = parse('[N.C.] C4 E4 G4 C5', 4).measures[0];
  assert.equal(none.chord, '');
  assert.equal(none.autoChord, false);
  assert.equal(none.needsInfer, false);
});

test('editor projection matches the common parser and retains original beat tokens', function(){
  const raw = '[C] 4D4 -/!3G4 0E2+4B4 - | line a/b';
  const bars = parser.parseTextToVeBars(raw, 4);
  const measure = parse(raw, 4).measures[0];
  assert.deepEqual(bars[0].notes, measure.beats.map(b => b.tok));
  assert.equal(bars[0].notes[0], '4D4');
  assert.equal(bars[0].notes[1], '-/!3G4');
  assert.equal(bars[0].notes[2], '0E2+4B4');
  assert.equal(bars[0].lyric, 'line a/b');
  assert.equal(parser.parseTextToVeBars('', 4)[0].notes[0], 'C4');
  const preserved = parser.parseTextToVeBars('[C] 1E4@2 !C4 ~D4 R . -', 6)[0].notes;
  assert.deepEqual(preserved, ['1E4@2', '!C4', '~D4', 'R', '.', '-']);
  const paren = parser.parseTextToVeBars('[C] (C4 D4) C4,D4 - -', 4)[0].notes;
  assert.deepEqual(paren.slice(0, 2), ['(C4 D4)', 'C4,D4']);
  const roundTrip = parse('[C] ' + paren.join(' '), 4).measures[0];
  assert.deepEqual(roundTrip.beats.slice(0, 2).map(beat => beat.subNotes.map(note => note.midi)), [[60, 62], [60, 62]]);
});

test('capo offsets clamp to twelve and title/badge metadata takes precedence', function(){
  assert.equal(parser.getSongCapo({ title: 'song Capo 4', capo: 2 }), 4);
  assert.equal(parser.getSongCapo({ title: 'song', badge: '카포: 7' }), 7);
  assert.equal(parser.getSongCapo({ title: 'Capo 20', capo: 2 }), 12);
  assert.equal(parser.getSongCapo({ title: 'song', capo: -3 }), 0);
  assert.equal(parser.getSongCapo({ title: 'song', capo: 3 }), 3);
  for (let capo = 0; capo <= 12; capo++) assert.equal(parser.soundingMidi(60, capo), 60 + capo);
  assert.equal(parser.soundingMidi(60, -4), 60);
  assert.equal(parser.soundingMidi(60, 100), 72);
});

test('all songs.json entries parse into the expected number of beats per measure', function(){
  const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'songs.json'), 'utf8'));
  assert.equal(songs.length, 14);
  for (const song of songs){
    const structured = parser.buildStructuredSong(song);
    assert.equal(structured.id, song.id);
    assert.equal(structured.measures.length, song.lines.length, song.id);
    for (const measure of structured.measures){
      assert.equal(measure.beats.length, song.beats, song.id);
      assert.ok(measure.beats.every(beat => typeof beat.tok === 'string'), song.id);
    }
  }
});

process.stdout.write('1..' + checks + '\n');
