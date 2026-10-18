const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TabEngine = require('../src/tab-engine.js');

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}
function beats(score, voice = 0){ return score.tracks[0].staves[0].bars[0].voices[voice].beats; }

test('alphaTab parses single notes and preserves string/fret data', function(){
  const score = TabEngine.parseAlphaTex(':4 0.1 3.2 |');
  const notes = TabEngine.getBeatNotes(beats(score)[0]);
  assert.deepEqual(notes.map(note => [note.str, note.fret, note.midi]), [[1, 0, 64]]);
  assert.deepEqual(TabEngine.getBeatNotes(beats(score)[1]).map(note => [note.str, note.fret]), [[2, 3]]);
});

test('chords retain every note in one beat', function(){
  const score = TabEngine.parseAlphaTex(':4 (0.1 1.2 2.3) |');
  assert.equal(TabEngine.getBeatNotes(beats(score)[0]).length, 3);
});

test('separate alphaTab voices retain their independent beat arrays', function(){
  const score = TabEngine.parseAlphaTex('\\track "Voices" \\staff{tabs} \\voice :4 0.1 | \\voice :8 2.2 3.2 |');
  const voices = score.tracks[0].staves[0].bars[0].voices;
  assert.equal(voices.length, 2);
  assert.deepEqual(voices.map(voice => voice.beats.length), [1, 2]);
});

test('true rests remain distinct from tied notes', function(){
  const restScore = TabEngine.parseAlphaTex(':4 r |');
  const tieScore = TabEngine.parseAlphaTex(':4 0.1 0.1{-} |');
  assert.equal(beats(restScore)[0].isRest, true);
  assert.equal(beats(tieScore)[1].isRest, false);
  assert.equal(beats(tieScore)[1].notes[0].isTieDestination, true);
});

test('dotted notes and triplet beats retain alphaTab durations', function(){
  const dotted = TabEngine.parseAlphaTex(':4 0.1{d} |');
  const triplet = TabEngine.parseAlphaTex(':8 0.1{tu 3} 1.1{tu 3} 2.1{tu 3} |');
  assert.equal(beats(dotted)[0].displayDuration, 1440);
  assert.deepEqual(beats(triplet).map(beat => beat.displayDuration), [320, 320, 320]);
});

test('capo is reflected in the sounding MIDI value', function(){
  const score = TabEngine.parseAlphaTex('\\track "Capo" \\staff{tabs} \\capo 5 0.1 |');
  assert.equal(TabEngine.getBeatNotes(beats(score)[0])[0].midi, 69);
});

test('frets above twelve remain intact', function(){
  const score = TabEngine.parseAlphaTex(':4 15.1 |');
  assert.equal(TabEngine.getBeatNotes(beats(score)[0])[0].fret, 15);
});

test('alphaTab diagnostics reject invalid syntax', function(){
  assert.throws(() => TabEngine.parseAlphaTex('#@@@'));
});

test('alphaTab left and right hand finger enums map from model values', function(){
  const left = TabEngine.parseAlphaTex(':4 0.1{lf 1} 0.1{lf 2} 0.1{lf 3} 0.1{lf 4} 0.1{lf 5} |');
  const right = TabEngine.parseAlphaTex(':4 0.1{rf 1} 0.1{rf 2} 0.1{rf 3} 0.1{rf 4} 0.1{rf 5} |');
  const unset = TabEngine.parseAlphaTex(':4 0.1 |');
  assert.deepEqual(beats(left).map(beat => TabEngine.getBeatNotes(beat)[0].lh), ['T', 1, 2, 3, 4]);
  assert.deepEqual(beats(right).map(beat => TabEngine.getBeatNotes(beat)[0].rh), ['p', 'i', 'm', 'a', 'c']);
  assert.deepEqual(TabEngine.getBeatNotes(beats(unset)[0]).map(note => [note.lh, note.rh]), [[null, null]]);
});

test('semantic alphaTex errors include diagnostic text and source location', function(){
  assert.throws(() => TabEngine.parseAlphaTex(':4 0.1{lf 9} |'), error => {
    assert.match(error.message, /1:11/);
    assert.match(error.message, /Allowed range: 1-5, Actual Value: 9/);
    return true;
  });
});

test('GP export and import roundtrip through alphaTab', function(){
  const original = TabEngine.parseAlphaTex('\\title "Roundtrip" :4 0.1 (1.2 3.3) |');
  const bytes = TabEngine.exportGp(original);
  assert.ok(bytes instanceof Uint8Array);
  const restored = TabEngine.importBytes(bytes);
  assert.equal(restored.tracks.length, 1);
  assert.equal(restored.masterBars.length, original.masterBars.length);
  assert.equal(restored.tracks[0].staves[0].bars[0].voices[0].beats.length, 2);
});

test('MusicXML fixture imports through alphaTab ScoreLoader', function(){
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/alphatab/simple.musicxml'));
  const score = TabEngine.importBytes(fixture);
  assert.equal(score.tracks.length, 1);
  assert.equal(score.masterBars.length, 1);
});

process.stdout.write('1..' + checks + '\n');
