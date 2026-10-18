const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('../src/parser.js');
const score = require('../src/score.js');
const rhythm = require('../src/rhythm.js');

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
  assert.equal(parser.parseNoteToken('C4', 0).pos.lh, null);
  assert.equal(parser.parseNoteToken('C4', 0).pos.rh, null);
  assert.equal(parser.parseNoteToken('E4@2', 0).pos.lh, null);
  assert.equal(parser.parseNoteToken('E4@2', 0).pos.rh, null);
  assert.equal(parser.midiInfo(61).pos.lh, null);
  assert.equal(parser.midiInfo(61).pos.rh, null);
  assert.equal(parser.parseNoteToken('1C4', 0).customTok, '1C4');
  assert.equal(parser.parseNoteToken('0E4', 0).customTok, '0E4');
  assert.equal(parser.parseNoteToken('3솔', 0).pos.lh, 3);
  assert.equal(parser.parseNoteToken('3솔', 0).customTok, '3G4');
  assert.equal(parser.parseNoteToken('도4', 0).pos.lh, null);
  assert.equal(parser.parseNoteToken('C3', 0).midi, 48);
  const overridden = parser.parseNoteToken('1E4@2', 0);
  assert.equal(overridden.pos.str, 2);
  assert.equal(overridden.pos.fret, 5);
  assert.equal(overridden.customTok, '1E4@2');
});

test('duration postfix validates units and stays attached to each chord component', function(){
  for (const [token,slots,units] of [['E4*3',3,36],['E4*1',1,12],['E4*1.5',1.5,18],['E4*0.25',0.25,3],['E4*0.0833333333',0.0833333333,1]]){
    const note=parser.parseNoteToken(token,0);
    assert.equal(note.explicitDurationSlots,slots,token);
    assert.equal(note.customTok,token,token+' canonical token');
    assert.equal(Math.round(note.explicitDurationSlots*rhythm.UNITS_PER_SLOT),units,token+' normalized integer units');
  }
  for (const token of ['E4*0','E4*0.000000000001','E4*-1','E4*1e2','E4*Infinity','E4*NaN','E4*0.1','E4**3','E4*3*1','E4*','r*3','-*3','.*3','E4*3:p','E4:p*3!']){
    assert.equal(parser.parseNoteToken(token,0),null,token+' is rejected');
    assert.ok(parser.parseScore(token+' r r r',4).errors.length,token+' fails score validation');
  }
  const chord=parser.parseNoteToken('~0E2@6:p*3+!4B4@1:a*1',0);
  assert.deepEqual(chord.chordNotes.map(note=>[note.explicitDurationSlots,note.tok]),[
    [3,'~0E2@6:p*3'],[1,'!4B4@1:a*1']
  ]);
  assert.equal(chord.explicitDurationSlots,null,'chord representative does not leak final component duration');
  const scoreData=parse('[C] ~0E2@6:p*3+!4B4@1:a*1 B3@2:m*1 G3@3:i*1 r',4);
  assert.deepEqual(scoreData.errors,[]);
  assert.equal(scoreData.measures[0].beats[0].chordNotes[0].explicitDurationSlots,3);
  assert.equal(scoreData.measures[0].beats[0].chordNotes[1].explicitDurationSlots,1);
  const serialized=parser.serializeScoreMeasures(scoreData.measures);
  assert.match(serialized,/~0E2@6:p\*3\+!4B4@1:a\*1/);
  assert.deepEqual(parse(serialized,4).measures[0].beats.map(beat=>beat.tok),scoreData.measures[0].beats.map(beat=>beat.tok));
});

test('explicit right-hand suffixes stay attached to their written note only', function(){
  for (const finger of ['p','i','m','a']){
    const note=parser.parseNoteToken('C4:'+finger,0);
    assert.equal(note.pos.rh,finger);
    assert.equal(note.customTok,'C4:'+finger);
    assert.equal(parser.getExplicitRightHand('C4:'+finger),finger);
  }
  for (const token of ['1C4:i','!1C4@2:i','~E4:a','도4:m','D4(4):i']){
    assert.ok(parser.parseNoteToken(token,0),token);
    assert.equal(parser.getExplicitRightHand(token),token.slice(-1));
  }
  assert.equal(parser.parseNoteToken('C4:i').midi,60);
  const ordered=parser.parseNoteToken('E4:a+C3:p',0);
  assert.deepEqual(ordered.chordNotes.map(n=>[n.midi,n.rh]),[[48,'p'],[64,'a']]);
  assert.equal(ordered.bass.rh,'p');
  assert.equal(ordered.pos.rh,'a');
  assert.deepEqual(ordered.chordNotes.map(n=>n.tok),['C3:p','E4:a']);
  assert.equal(parser.getExplicitRightHand('E4:a+C3:p',0),'p');
  assert.equal(parser.getExplicitRightHand('E4:a+C3:p',1),'a');
  assert.equal(parser.getExplicitRightHand('E4:a+C3:p',2),null);
  assert.equal(parser.getExplicitRightHand('C4/D4:i'),null);
  assert.equal(parser.getExplicitRightHand('C4/D4'),null);
  assert.equal(parser.getExplicitRightHand('C4',1),null);
  const mixed=parser.parseScore('C3:p+E4:i C4 r -',4).measures[0].beats[0];
  assert.deepEqual(mixed.chordNotes.map(n=>n.rh),['p','i']);
  assert.equal(parser.parseScore('C4/D4:i r r r',4).measures[0].beats[0].subNotes[1].rh,'i');
  assert.equal(parser.parseScore('C4 D4:i r r',4).measures[0].beats[0].rh,null);
  assert.equal(parser.parseScore('C4:i - r r',4).measures[0].beats[1].rh,null);
  assert.equal(parser.parseScore('r:i C4 - -',4).errors.length>0,true);
  for (const invalid of ['C4:P','C4:x','C4:','C4:im','C4:i:m','C4:i@2','r:i','-:p','C4:i!','C4!:i','C3:p+E4:i!','C3:p+E4:i~','H4:i','C2@1:i']){
    assert.equal(parser.parseNoteToken(invalid,0),null,invalid);
    assert.ok(parser.parseScore(invalid+' - - -',4).errors.length,invalid+' validates as an error');
  }
  for (const invalid of ['>C4','C4>','^C4','C4^']) assert.equal(parser.parseNoteToken(invalid,0),null,invalid);
  const roundTrip=parser.parseScore('[C] E4:a+C3:p C4:i/D4:m 도4:p r | "hands"',4);
  const serialized=parser.serializeScoreMeasures(roundTrip.measures);
  assert.match(serialized,/E4:a\+C3:p C4:i\/D4:m 도4:p/);
  assert.deepEqual(parser.parseScore(serialized,4).measures[0].beats.map(b=>b.tok),roundTrip.measures[0].beats.map(b=>b.tok));
});

test('bass plus melody and multi-note chords preserve roles and ascending arpeggio order', function(){
  const pair = parser.parseNoteToken('0E2+4B4', 0);
  assert.equal(pair.bass.midi, 40);
  assert.equal(pair.bass.lh, 0);
  assert.equal(pair.bass.rh, null);
  assert.equal(pair.midi, 71);
  assert.equal(pair.pos.lh, 4);
  assert.equal(pair.pos.rh, null);
  assert.equal(pair.chordNotes.length, 2);
  assert.ok(pair.chordNotes.every(note => note.rh === null));
  const chord = parser.parseNoteToken('0E2+!0E4+!3G4+!4B4', 0);
  assert.deepEqual(chord.chordNotes.map(n => n.midi), [40, 64, 67, 71]);
  assert.equal(chord.chordNotes.every(note => note.rh === null), true);
  assert.equal(chord.chordNotes[3].midi, 71);
});

test('chord articulation belongs to its written component and canonical tokens retain it', function(){
  assert.equal(parser.parseNoteToken('C4!', 0).articulation, 'apoyando', 'legacy single-note postfix apoyando remains accepted');
  assert.equal(parser.parseNoteToken('C4~', 0).articulation, 'tirando', 'legacy single-note postfix tirando remains accepted');
  const cases = [
    ['!C3+E4', [[48, 'apoyando', true], [64, null, false]], '!C3+E4'],
    ['C3+!E4', [[48, null, false], [64, 'apoyando', true]], 'C3+!E4'],
    ['~C3+!E4', [[48, 'tirando', true], [64, 'apoyando', true]], '~C3+!E4'],
    ['!E4+C3', [[48, null, false], [64, 'apoyando', true]], 'C3+!E4'],
    ['~0E2@6:p+!4B4@1:a', [[40, 'tirando', true], [71, 'apoyando', true]], '~0E2@6:p+!4B4@1:a'],
    ['C3+~E3+!G3', [[48, null, false], [52, 'tirando', true], [55, 'apoyando', true]], 'C3+~E3+!G3']
  ];
  for (const [token, expected, canonical] of cases){
    const parsed = parser.parseNoteToken(token, 0);
    assert.ok(parsed, token);
    assert.deepEqual(parsed.chordNotes.map(note => [note.midi, note.articulation, note.explicitArticulation]), expected, token);
    assert.deepEqual(parsed.chordNotes.map(note => note.tok).join('+'), canonical, token + ' canonical token');
    assert.equal(parsed.articulation || null, expected[expected.length - 1][1], token + ' representative articulation');
    assert.equal(!!parsed.explicitArticulation, expected[expected.length - 1][2], token + ' representative explicit flag');
    assert.equal(parsed.customTok, canonical, token + ' normalized chord serialization');
  }

  const parsed = parser.parseNoteToken('~0E2@6:p+!4B4@1:a', 0);
  assert.deepEqual([parsed.bass.tok, parsed.bass.articulation, parsed.bass.explicitArticulation, parsed.bass.rh, parsed.bass.lh, parsed.bass.str],
    ['~0E2@6:p', 'tirando', true, 'p', 0, 6], 'bass retains its own articulation and complete token metadata');
  assert.deepEqual([parsed.pos.rh, parsed.pos.lh, parsed.pos.str, parsed.articulation], ['a', 4, 1, 'apoyando'], 'melody representative retains its own metadata');

  for (const token of ['~0E2@6:p+!4B4@1:a', 'E4+!C3', 'C3+~E3+!G3']){
    const score = parse('[C] ' + token + ' r r r', 4);
    assert.equal(score.errors.length, 0, token + ' parses as score');
    const serialized = parser.serializeScoreMeasures(score.measures);
    const restored = parse(serialized, 4);
    assert.equal(restored.errors.length, 0, token + ' round-trips');
    assert.deepEqual(restored.measures[0].beats[0].chordNotes.map(note => [note.midi, note.articulation]),
      score.measures[0].beats[0].chordNotes.map(note => [note.midi, note.articulation]), token + ' round-trip articulation');
  }
  assert.equal(parser.parseNoteToken('C3:p+E4:i!', 0), null, 'invalid RH postfix technique remains rejected');
});

test('explicit bass helper returns only the bass attached to the beat', function(){
  const beat={bass:{midi:40,str:6}};
  assert.equal(parser.getExplicitBass(beat),beat.bass);
  assert.equal(parser.getExplicitBass(null),null);
  assert.equal(parser.getExplicitBass({bass:{midi:0}}),null);
  assert.equal(parser.getExplicitBass({}),null);
  assert.equal(Object.prototype.hasOwnProperty.call(parser,'CHORD_BASS_TOKEN'),false);
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
  const tripletInfo = score.getBeatDurationInfo([triplet], 0, 4);
  assert.equal(tripletInfo.label, '3분할');
  assert.equal(tripletInfo.durName, '1/3칸 · 1/3칸 · 10/3칸');
});

test('explicit subdivisions report their exact duration and retain explicit technique', function(){
  const beat = parse('[C] !C4/D4/E4 - - -', 4).measures[0].beats[0];
  assert.equal(beat.subNotes[0].durationUnits, 4);
  assert.equal(beat.subNotes[0].articulation, 'apoyando');
  assert.equal(beat.subNotes[0].explicitArticulation, true);
  assert.equal(beat.subNotes[1].articulation, null);
  assert.equal(score.getBeatDurationInfo([beat], 0, 4).durName, '1/3칸 · 1/3칸 · 10/3칸');
});

test('measure separators are newline, CRLF, and double slash; single slash remains inside a bar', function(){
  assert.deepEqual(parser.splitScoreMeasures('C4 -\nD4 -'), ['C4 -', 'D4 -']);
  assert.deepEqual(parser.splitScoreMeasures('C4 -\r\nD4 -'), ['C4 -', 'D4 -']);
  assert.deepEqual(parser.splitScoreMeasures('C4 - / D4 -'), ['C4 - / D4 -']);
  assert.ok(parse('C4 - / D4 -', 4).errors.some(e => e.code === 'ISOLATED_SLASH'));
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

test('generic score parsing retains original beat tokens through serialization', function(){
  const raw = '[C] 4D4 -/!3G4 0E2+4B4 - | line a/b';
  const parsed = parse(raw, 4);
  const measure = parsed.measures[0];
  assert.deepEqual(measure.beats.slice(0, 3).map(b => b.tok), ['4D4', '-/!3G4', '0E2+4B4']);
  assert.equal(measure.lyric, 'line a/b');
  const roundTripText = parser.serializeScoreMeasures(parsed.measures, '\n');
  const roundTrip = parse(roundTripText, 4);
  assert.equal(roundTrip.errors.length, 0);
  assert.deepEqual(roundTrip.measures[0].beats.map(b => b.tok), measure.beats.map(b => b.tok));
  assert.equal(roundTrip.measures[0].lyric, 'line a/b');
  assert.equal(roundTrip.measures[0].beats[2].chordNotes.length, 2);
  assert.deepEqual(roundTrip.measures[0].beats[2].chordNotes.map(note => note.midi), [40, 71]);
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
  assert.equal(songs.length, 13);
  for (const song of songs){
    const structured = parser.buildStructuredSong(song);
    assert.equal(structured.id, song.id);
    assert.equal(structured.measures.length, song.lines.length, song.id);
    assert.equal(parse(song.lines.join('\n'),song.beats).errors.length,0,song.id);
    for (const measure of structured.measures){
      assert.equal(measure.beats.length, song.beats, song.id);
      assert.ok(measure.beats.every(beat => typeof beat.tok === 'string'), song.id);
    }
  }
});

process.stdout.write('1..' + checks + '\n');
