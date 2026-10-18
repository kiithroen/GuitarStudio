'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Migration = require('../src/legacy-migration.js');
const TabEngine = require('../src/tab-engine.js');
const Storage = require('../src/storage.js');
const Library = require('../src/library.js');
const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '../songs.json'), 'utf8'));
let checks = 0;
async function check(name, fn){ await fn(); checks++; process.stdout.write('ok ' + checks + ' - ' + name + '\n'); }

(async function(){
await check('all built-in alphaTex records parse and retain required metadata', function(){
  assert.equal(songs.length, 16);
  songs.forEach(function(song){
    const score = TabEngine.parseAlphaTex(song.alphaTex);
    assert.match(song.alphaTex, /\\ts \(\d+ \d+\)/);
    if (song.alphaTex.includes('\\tuning ')) assert.match(song.alphaTex, /\\tuning \([^)]*\)/);
    assert.equal(song.notationVersion, 3);
    assert.equal(song.builtin, true);
    assert.equal(score.tracks[0].staves[0].bars.length, song.id === 'example-capo5-two-bars' || song.id === 'example-independent-voices' ? 2 : song.legacyOriginal.measures.length);
    assert.equal(score.tempo, song.id === 'example-capo5-two-bars' || song.id === 'example-independent-voices' ? 64 : (song.legacyOriginal.beats === 6 || song.legacyOriginal.beats === 8 || song.legacyOriginal.beats === 9 ? song.legacyOriginal.bpm / 2 : song.legacyOriginal.bpm));
    if (song.legacyOriginal){
      assert.equal(song.id, song.legacyOriginal.id);
      assert.equal(song.title, song.legacyOriginal.title);
      assert.equal(song.badge, song.legacyOriginal.badge);
      assert.equal(score.tracks[0].staves[0].capo, song.legacyOriginal.capo || 0);
      const gridIsEighth = [6, 8, 9].includes(song.legacyOriginal.beats);
      score.tracks[0].staves[0].bars.forEach(function(bar){
        assert.equal(bar.voices[0].beats.reduce((sum, beat) => sum + beat.playbackDuration, 0), song.legacyOriginal.beats * (gridIsEighth ? 480 : 960));
      });
    }
  });
});

await check('migration maps pitches and explicit left-hand fingers, preserving the source snapshot', function(){
  const original = {
    id: 'legacy-finger', title: 'Finger', badge: 'Original badge', type: 'structured', notationVersion: 2,
    bpm: 64, beats: 4, capo: 0, measures: [{ beats: [
      { tok: '1E4', midi: 64, str: 1, fret: 0 }, { tok: '4F4', midi: 65, str: 1, fret: 1 },
      { tok: '-', midi: null }, { tok: '-', midi: null }
    ] }]
  };
  const result = Migration.convertSong(original, TabEngine);
  const score = TabEngine.parseAlphaTex(result.alphaTex);
  const notes = score.tracks[0].staves[0].bars[0].voices[0].beats.flatMap(function(beat){ return beat.notes; });
  assert.equal(result.legacyOriginal.measures[0].beats[0].tok, '1E4');
  assert.match(result.alphaTex, /0\.1\{lf 2\}/);
  assert.match(result.alphaTex, /1\.1\{lf 5\}/);
  assert.equal(notes[0].leftHandFinger, 1);
  assert.equal(notes[1].leftHandFinger, 4);
  assert.equal(notes[0].string, 6);
  assert.equal(notes[1].string, 6);
  assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats.reduce((sum, beat) => sum + beat.playbackDuration, 0), 3840);
});

await check('starting blank is a rest and later dashes tie the prior note', function(){
  const result = Migration.convertSong({
    id: 'legacy-rest', title: 'Rest', type: 'structured', bpm: 60, beats: 4,
    measures: [{ beats: [
      { tok: '-', midi: null }, { tok: '2G3', midi: 55, str: 3, fret: 0 },
      { tok: '-', midi: null }, { tok: '-', midi: null }
    ] }]
  }, TabEngine);
  const beats = TabEngine.parseAlphaTex(result.alphaTex).tracks[0].staves[0].bars[0].voices[0].beats;
  assert.equal(beats[0].isRest, true);
  assert.equal(beats[2].notes[0].isTieDestination, true);
  assert.equal(beats[3].notes[0].isTieDestination, true);
  assert.equal(result.warnings.some(message => message.includes('시작 빈 칸')), true);
});

await check('compound and eight-slot tempos convert to quarter-note BPM', function(){
  for (const meter of [6, 8, 9]){
    const measure = { beats: Array.from({ length: meter }, function(){ return { tok: 'E4', midi: 64, str: 1, fret: 0 }; }) };
    const result = Migration.convertSong({ id: 'meter-' + meter, title: 'Meter', type: 'structured', bpm: 80, beats: meter, measures: [measure] }, TabEngine);
    const score = TabEngine.parseAlphaTex(result.alphaTex);
    assert.equal(score.tempo, 40);
    const duration = score.tracks[0].staves[0].bars[0].voices[0].beats.reduce((sum, beat) => sum + beat.playbackDuration, 0);
    assert.equal(duration, meter * 480);
  }
});

await check('new example records preserve capo, independent voices, note durations, and the cross-bar tie', function(){
  const capoSong = songs.find(song => song.id === 'example-capo5-two-bars');
  const capoScore = TabEngine.parseAlphaTex(capoSong.alphaTex);
  assert.equal(capoScore.tracks[0].staves[0].capo, 5);
  assert.equal(capoScore.tracks[0].staves[0].bars.length, 2);
  assert.deepEqual(capoScore.tracks[0].staves[0].bars.map(bar => bar.voices[0].beats.map(beat => beat.playbackDuration)), [[960, 960, 960], [960, 960, 960]]);
  const voiceScore = TabEngine.parseAlphaTex(songs.find(song => song.id === 'example-independent-voices').alphaTex);
  const bars = voiceScore.tracks[0].staves[0].bars;
  assert.equal(bars.length, 2);
  assert.equal(bars[0].voices.length, 2);
  assert.equal(bars[1].voices.length, 2);
  assert.deepEqual(bars[0].voices[0].beats.map(beat => beat.playbackDuration), [960, 960, 960, 960]);
  assert.deepEqual(bars[1].voices[0].beats.map(beat => beat.playbackDuration), [1920, 960, 960]);
  assert.deepEqual(bars[0].voices[1].beats.map(beat => beat.playbackDuration), [2880, 960]);
  assert.deepEqual(bars[1].voices[1].beats.map(beat => beat.playbackDuration), [960, 2880]);
  const tiedNote = bars[1].voices[1].beats[0].notes[0];
  assert.equal(tiedNote.isTieDestination, true);
  assert.equal(tiedNote.string, 3);
  assert.equal(tiedNote.fret, 2);
});

await check('8 eighth-note slots use a 4/4 meter and duration ratios do not leak across events', function(){
  const oldMeasure = { beats: [
    { tok: 'E4/E4', subNotes: [{ tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 }], midi: 64, str: 1, fret: 0 },
    { tok: 'E4/F4/G4', subNotes: [{ tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'F4', midi: 65, str: 1, fret: 1 }, { tok: 'G4', midi: 67, str: 1, fret: 3 }], midi: 64, str: 1, fret: 0 },
    { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 },
    { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 },
    { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 }
  ] };
  const result = Migration.convertSong({ id: 'eight-grid', title: 'Eight grid', type: 'structured', beats: 8, bpm: 64, measures: [oldMeasure] }, TabEngine);
  const score = TabEngine.parseAlphaTex(result.alphaTex);
  const beats = score.tracks[0].staves[0].bars[0].voices[0].beats;
  assert.match(result.alphaTex, /\\ts \(4 4\)/);
  assert.equal(score.tempo, 32);
  assert.deepEqual(beats.map(beat => beat.playbackDuration), [240, 240, 160, 160, 160, 480, 480, 480, 480, 480, 480]);
  assert.equal(beats.reduce((sum, beat) => sum + beat.playbackDuration, 0), 3840);
});

await check('two and four subdivisions preserve the slot duration between regular beats', function(){
  const repeated = function(token, midi, fret){ return { tok: token, midi: midi, str: 1, fret: fret }; };
  const result = Migration.convertSong({ id: 'two-four', title: 'Two four', type: 'structured', bpm: 64, beats: 4,
    measures: [{ beats: [
      repeated('E4', 64, 0),
      { tok: 'E4/F4/G4/A4', midi: 64, str: 1, fret: 0, subNotes: [repeated('E4', 64, 0), repeated('F4', 65, 1), repeated('G4', 67, 3), repeated('A4', 69, 5)] },
      repeated('E4', 64, 0),
      { tok: 'E4/F4', midi: 64, str: 1, fret: 0, subNotes: [repeated('E4', 64, 0), repeated('F4', 65, 1)] }
    ] }] }, TabEngine);
  const beats = TabEngine.parseAlphaTex(result.alphaTex).tracks[0].staves[0].bars[0].voices[0].beats;
  assert.deepEqual(beats.map(beat => beat.playbackDuration), [960, 240, 240, 240, 240, 960, 480, 480]);
  assert.equal(beats.reduce((sum, beat) => sum + beat.playbackDuration, 0), 3840);
});

await check('title capo takes precedence over record capo and validates sounding MIDI', function(){
  const record = { id: 'capo-5', title: 'Piece Capo 5', badge: '', type: 'structured', capo: 2, bpm: 60, beats: 4,
    measures: [{ beats: [
      { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'F4', midi: 65, str: 1, fret: 1 },
      { tok: 'G4', midi: 67, str: 1, fret: 3 }, { tok: 'E4', midi: 64, str: 1, fret: 0 }
    ] }] };
  const result = Migration.convertSong(record, TabEngine);
  const score = TabEngine.parseAlphaTex(result.alphaTex);
  const notes = score.tracks[0].staves[0].bars[0].voices[0].beats.flatMap(beat => beat.notes);
  assert.equal(score.tracks[0].staves[0].capo, 5);
  [64, 65, 67, 64].forEach((midi, index) => assert.equal(notes[index].realValue, midi + 5));
});

await check('poison child tokens and inferred metadata do not create fingerings', function(){
  const result = Migration.convertSong({ id: 'poison', title: 'Poison', type: 'structured', bpm: 60, beats: 4,
    measures: [{ beats: [
      { tok: 'E4+G3', midi: 67, str: 3, fret: 0, lh: 4, rh: 2, chordNotes: [
        { tok: '2E4', midi: 64, en: 'E4', str: 1, fret: 0, lh: 2, rh: 1 },
        { tok: '3G3', midi: 55, en: 'G3', str: 3, fret: 0, lh: 3, rh: 2 }
      ] },
      { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 }
    ] }] }, TabEngine);
  assert.doesNotMatch(result.alphaTex, /\{lf /);
});

await check('personal migration keeps builtin false and returns notice once after storage succeeds', async function(){
  const oldGet = Storage.dbGetAllSongs;
  const oldSave = Storage.dbSaveSong;
  const oldFetch = global.fetch;
  const original = { id: 'personal-old', title: 'Personal', type: 'structured', notationVersion: 2, bpm: 60, beats: 4,
    measures: [{ beats: [
      { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 },
      { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 }
    ] }] };
  try {
    Storage.dbGetAllSongs = async function(){ return [original]; };
    Storage.dbSaveSong = async function(record){ assert.equal(record.builtin, false); };
    global.fetch = async function(){ return { ok: true, json: async function(){ return songs; } }; };
    const result = await Library.loadAll();
    assert.equal(result.songs.find(song => song.id === original.id).builtin, false);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /앞 음 유지 또는 시작 쉼/);
  } finally {
    Storage.dbGetAllSongs = oldGet; Storage.dbSaveSong = oldSave; global.fetch = oldFetch;
  }
});

await check('failed migration write reports the untouched source record and invalid save is rejected', async function(){
  const oldGet = Storage.dbGetAllSongs;
  const oldSave = Storage.dbSaveSong;
  const oldFetch = global.fetch;
  const original = { id: 'write-fail', title: 'Write fail', type: 'structured', bpm: 60, beats: 4,
    measures: [{ beats: [
      { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 },
      { tok: 'E4', midi: 64, str: 1, fret: 0 }, { tok: 'E4', midi: 64, str: 1, fret: 0 }
    ] }] };
  let saves = 0;
  try {
    Storage.dbGetAllSongs = async function(){ return [original]; };
    Storage.dbSaveSong = async function(){ saves++; throw new Error('database write failed'); };
    global.fetch = async function(){ return { ok: true, json: async function(){ return songs; } }; };
    const result = await Library.loadAll();
    assert.equal(result.songs.some(song => song.id === original.id), false);
    assert.equal(result.warnings[0].record, original);
    assert.equal(result.warnings[0].message, 'database write failed');
    const priorSaves = saves;
    await assert.rejects(Library.save({ id: 'invalid-song', title: 'Invalid', format: 'alphatex', alphaTex: 'not alphaTex' }));
    assert.equal(saves, priorSaves);
  } finally {
    Storage.dbGetAllSongs = oldGet; Storage.dbSaveSong = oldSave; global.fetch = oldFetch;
  }
});

process.stdout.write('1..' + checks + '\n');
})().catch(function(error){ console.error(error); process.exitCode = 1; });
