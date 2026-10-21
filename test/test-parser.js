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

test('single notes retain English, octave, fingering, and string override', function(){
  const english = parser.parseNoteToken('E4', 0);
  assert.equal(english.midi, 64);
  assert.equal(english.en, 'E4');
  assert.equal(parser.parseNoteToken('3G4', 0).midi, 67);
  assert.equal(parser.parseNoteToken('4D4', 0).pos.lh, 4);
  assert.equal(parser.parseNoteToken('C4', 0).pos.lh, null);
  assert.equal(parser.parseNoteToken('C4', 0).pos.rh, null);
  assert.equal(parser.parseNoteToken('E4@2', 0).pos.lh, null);
  assert.equal(parser.parseNoteToken('E4@2', 0).pos.rh, null);
  assert.equal(parser.midiInfo(61).pos.lh, null);
  assert.equal(parser.midiInfo(61).pos.rh, null);
  assert.equal(parser.parseNoteToken('1C4', 0).customTok, '1C4');
  assert.equal(parser.parseNoteToken('0E4', 0).customTok, '0E4');
  assert.equal(parser.parseNoteToken('3G4', 0).pos.lh, 3);
  assert.equal(parser.parseNoteToken('3G4', 0).customTok, '3G4');
  assert.equal(parser.parseNoteToken('도4', 0), null, 'Korean solfege names are rejected');
  assert.equal(parser.parseNoteToken('C3', 0).midi, 48);
  const overridden = parser.parseNoteToken('1E4@2', 0);
  assert.equal(overridden.pos.str, 2);
  assert.equal(overridden.pos.fret, 5);
  assert.equal(overridden.customTok, '1E4@2');
});

test('duration postfix syntax is rejected instead of normalized or converted', function(){
  for (const token of ['E4*3','E4*1','E4*1.5','E4*0.25','E4*0.0833333333','E4*0','E4*0.000000000001','E4*-1','E4*1e2','E4*Infinity','E4*NaN','E4*0.1','E4**3','E4*3*1','E4*','r*3','-*3','.*3','E4*3:p','E4:p*3!','~0E2@6:p*3+!4B4@1:a*1']){
    assert.equal(parser.parseNoteToken(token,0),null,token+' is rejected');
    assert.ok(parser.parseScore(token+' r r r',4).errors.length,token+' fails score validation');
  }
  const scoreData=parse('[C] 0E2@6:p+!4B4@1:a B3@2:m G3@3:i r',4);
  assert.deepEqual(scoreData.errors,[]);
  assert.equal(Object.hasOwn(scoreData.measures[0].beats[0].chordNotes[0],'explicitDurationSlots'),false);
  assert.equal(Object.hasOwn(scoreData.measures[0].beats[0].chordNotes[1],'explicitDurationSlots'),false);
  const serialized=parser.serializeScoreMeasures(scoreData.measures);
  assert.match(serialized,/0E2@6:p\+!4B4@1:a/);
  assert.doesNotMatch(serialized,/\*/);
  assert.deepEqual(parse(serialized,4).measures[0].beats.map(beat=>beat.tok),scoreData.measures[0].beats.map(beat=>beat.tok));
  const memo=parse('[C] C4 - - - | "메모 *3"',4);
  assert.deepEqual(memo.errors,[],'asterisks in quoted measure notes are not note syntax');
  assert.equal(memo.measures[0].lyric,'메모 *3');
  const memoRoundTrip=parse(parser.serializeScoreMeasures(memo.measures),4);
  assert.equal(memoRoundTrip.measures[0].lyric,'메모 *3','quoted note text preserves asterisks through serialization');
  assert.ok(parse('C4*3 - - -',4).errors.length,'an asterisk in the note token remains invalid');
});

test('explicit right-hand suffixes stay attached to their written note only', function(){
  for (const finger of ['p','i','m','a']){
    const note=parser.parseNoteToken('C4:'+finger,0);
    assert.equal(note.pos.rh,finger);
    assert.equal(note.customTok,'C4:'+finger);
    assert.equal(parser.getExplicitRightHand('C4:'+finger),finger);
  }
  for (const token of ['1C4:i','!1C4@2:i','E4:a']){
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
  for (const invalid of ['C4:P','C4:x','C4:','C4:im','C4:i:m','C4:i@2','r:i','-:p','C4:i!','C4!:i','C3:p+E4:i!','C3:p+E4:i~','H4:i','C2@1:i','도4:m','D4(4):i']){
    assert.equal(parser.parseNoteToken(invalid,0),null,invalid);
    assert.ok(parser.parseScore(invalid+' - - -',4).errors.length,invalid+' validates as an error');
  }
  for (const invalid of ['>C4','C4>','^C4','C4^']) assert.equal(parser.parseNoteToken(invalid,0),null,invalid);
  const roundTrip=parser.parseScore('[C] E4:a+C3:p C4:i/D4:m G4:p r | "hands"',4);
  const serialized=parser.serializeScoreMeasures(roundTrip.measures);
  assert.match(serialized,/E4:a\+C3:p C4:i\/D4:m G4:p/);
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
  assert.equal(parser.parseNoteToken('C4!', 0), null, 'postfix apoyando is rejected');
  assert.equal(parser.parseNoteToken('C4~', 0), null, 'a trailing ~ is rejected');
  assert.equal(parser.parseNoteToken('~C4', 0), null, 'the removed tirando mark ~ is rejected');
  const cases = [
    ['!C3+E4', [[48, 'apoyando', true], [64, null, false]], '!C3+E4'],
    ['C3+!E4', [[48, null, false], [64, 'apoyando', true]], 'C3+!E4'],
    ['!E4+C3', [[48, null, false], [64, 'apoyando', true]], 'C3+!E4'],
    ['0E2@6:p+!4B4@1:a', [[40, null, false], [71, 'apoyando', true]], '0E2@6:p+!4B4@1:a'],
    ['C3+E3+!G3', [[48, null, false], [52, null, false], [55, 'apoyando', true]], 'C3+E3+!G3']
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

  const parsed = parser.parseNoteToken('0E2@6:p+!4B4@1:a', 0);
  assert.deepEqual([parsed.bass.tok, parsed.bass.articulation, parsed.bass.explicitArticulation, parsed.bass.rh, parsed.bass.lh, parsed.bass.str],
    ['0E2@6:p', null, false, 'p', 0, 6], 'bass retains its own articulation and complete token metadata');
  assert.deepEqual([parsed.pos.rh, parsed.pos.lh, parsed.pos.str, parsed.articulation], ['a', 4, 1, 'apoyando'], 'melody representative retains its own metadata');

  for (const token of ['0E2@6:p+!4B4@1:a', 'E4+!C3', 'C3+E3+!G3']){
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
  const grouped = parse('[C] C4/D4 E4/F4 - -', 4).measures[0];
  assert.deepEqual(grouped.beats.slice(0, 2).map(beat => beat.subNotes.length), [2, 2]);
  assert.deepEqual(grouped.beats.slice(0, 2).map(beat => beat.subNotes.map(note => note.midi)), [[60, 62], [64, 65]]);
  const scoreData = parse('[C] 2E3/0G3 - - - | "lyric a/b"', 4);
  assert.equal(scoreData.measures.length, 1);
  assert.equal(scoreData.measures[0].beats[0].subNotes.length, 2);
  assert.equal(scoreData.measures[0].lyric, 'lyric a/b');
});

test('explicit, inferred, and absent chords retain their modes', function(){
  const explicit = parse('[G7] C4 D4 E4 G4', 4).measures[0];
  assert.equal(explicit.chord, 'G7');
  assert.equal(explicit.autoChord, false);
  const automatic = parse('[?] C4 E4 G4 C5', 4).measures[0];
  assert.ok(automatic.chord);
  assert.equal(automatic.autoChord, true);
  const none = parse('[-] C4 E4 G4 C5', 4).measures[0];
  assert.equal(none.chord, '');
  assert.equal(none.autoChord, false);
  assert.equal(none.needsInfer, false);
});

test('generic score parsing retains original beat tokens through serialization', function(){
  const raw = '[C] 4D4 -/!3G4 0E2+4B4 - | "line a/b"';
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

test('setSongCapoText rewrites, appends, or removes the capo mark in the title and badge', function(){
  const cases = [
    ['로망스', '3/4 · 아포얀도', 3, '로망스', '3/4 · 아포얀도 · Capo 3'],
    ['곡', '', 2, '곡', 'Capo 2'],
    ['곡', '카포: 2 · 메모', 5, '곡', '카포: 5 · 메모'],
    ['곡', 'capo fret 2', 7, '곡', 'capo fret 7'],
    ['Song (Capo 2)', 'x · Capo 2', 4, 'Song (Capo 4)', 'x · Capo 4'],
    ['곡', 'a · Capo 2 · b', 0, '곡', 'a · b'],
    ['곡', 'Capo 2', 0, '곡', ''],
    ['Song (Capo 2)', 'x', 0, 'Song', 'x'],
    ['곡', 'a · Capo 2', 0, '곡', 'a'],
    ['곡', 'Capo 2 · a', 0, '곡', 'a'],
    ['곡', '메모', 0, '곡', '메모']
  ];
  cases.forEach(function(row){
    const input = { title: row[0], badge: row[1] };
    const result = parser.setSongCapoText(input, row[2]);
    assert.deepEqual(result, { title: row[3], badge: row[4] }, JSON.stringify(row));
    assert.deepEqual(input, { title: row[0], badge: row[1] }, 'the given song object is not changed');
    assert.equal(parser.getSongCapo(result), row[2], 'the result reads back as the capo ' + JSON.stringify(row));
  });
  assert.deepEqual(parser.setSongCapoText({}, 2), { title: '', badge: 'Capo 2' }, 'missing title and badge count as empty text');
  [13, -1, 2.5].forEach(function(capo){
    assert.throws(function(){ parser.setSongCapoText({ title: 'a', badge: '' }, capo); }, new Error('카포는 0~12의 정수여야 합니다: ' + capo));
  });
});

test('all songs.json entries parse into the expected number of beats per measure', function(){
  const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'songs.json'), 'utf8'));
  assert.equal(new Set(songs.map(song => song.id)).size, songs.length);
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

test('uncertain mark ? parses like the unmarked token and flags the beat', function(){
  const text = '[-] E4? 1C4@2:i? C3@5+E4@1? r? | ""';
  const parsed = parse(text, 4);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parser.validateScore(text, 4).errors, []);
  const beats = parsed.measures[0].beats;
  assert.deepEqual(beats.map(beat => beat.tok), ['E4?', '1C4@2:i?', 'C3@5+E4@1?', 'r?']);
  const plain = parse('[-] E4 r r r', 4).measures[0].beats[0];
  assert.equal(beats[0].midi, plain.midi);
  assert.equal(beats[0].kind, 'note');
  assert.equal(beats[0].uncertain, true);
  assert.equal(parser.getExplicitRightHand(beats[1].tok, 0), 'i');
  assert.equal(parser.getExplicitLeftHand(beats[1].tok, 0), 1);
  assert.equal(beats[1].uncertain, true);
  assert.equal(beats[2].chordNotes.length, 2);
  assert.equal(beats[2].uncertain, true);
  assert.equal(beats[3].kind, 'rest');
  assert.equal(beats[3].uncertain, true);
});

test('uncertain mark ? works on a lone rest, split parts, and chord components', function(){
  const text = '[-] ? E4?/F4 C3@5?+E4@1 r | ""';
  const parsed = parse(text, 4);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parser.validateScore(text, 4).errors, []);
  const beats = parsed.measures[0].beats;
  assert.equal(beats[0].kind, 'rest');
  assert.equal(beats[0].uncertain, true);
  assert.equal(beats[1].uncertain, true);
  assert.equal(beats[1].subNotes[0].uncertain, true);
  assert.equal(beats[1].subNotes[1].uncertain, false);
  assert.equal(beats[2].uncertain, true);
  assert.equal(beats[3].uncertain, false);
});

test('beats without a ? mark report uncertain false', function(){
  const beats = parse('[-] E4 r r r', 4).measures[0].beats;
  assert.ok(beats.every(beat => beat.uncertain === false));
  assert.equal(score.countUncertainBeats(parse('[-] E4 r r r', 4).measures), 0);
  assert.equal(score.countUncertainBeats(parse('[-] E4? r? E4/F4? r', 4).measures), 3);
});

test('double, hold, and dot uncertain marks stay errors', function(){
  for (const token of ['E4??', '-?', '.?']){
    const result = parse('[-] ' + token + ' r r r', 4);
    assert.ok(result.errors.length >= 1, token + ' is rejected');
  }
});

test('uncertain marks survive score serialization', function(){
  const measures = parse('[-] E4? 1C4@2:i? C3@5+E4@1? r? | ""', 4).measures;
  const text = parser.serializeScoreMeasures(measures.map(m => ({chord:m.chord || '-', autoChord:!!m.autoChord, notes:m.beats.map(b => b.tok), lyric:m.lyric || ''})), '\n');
  assert.ok(text.includes('E4?'));
  assert.ok(text.includes('r?'));
});

test('removed legacy notations are rejected and modern equivalents pass', function(){
  const rejected = [
    ['[-] E r r r', 'UNKNOWN_NOTE'],
    ['[-] e4 r r r', 'UNKNOWN_NOTE'],
    ['[-] F\u266F4 r r r', 'UNKNOWN_NOTE'],
    ['[-] E4! r r r', 'UNKNOWN_NOTE'],
    ['[-] E4~ r r r', 'UNKNOWN_NOTE'],
    ['[-] ~E4 r r r', 'INVALID_ROLL'],
    ['[-] 도4 r r r', 'UNKNOWN_NOTE'],
    ['[-] 0솔 r r r', 'UNKNOWN_NOTE'],
    ['[-] E4,F4 r r r', 'UNKNOWN_NOTE'],
    ['[-] R r r r', 'UNKNOWN_NOTE'],
    ['[-] E4 r r r | 메모', 'INVALID_LYRIC_QUOTE'],
    ['[없음] E4 r r r', 'INVALID_CHORD'],
    ['[N.C.] E4 r r r', 'INVALID_CHORD'],
    ['[자동] E4 r r r', 'INVALID_CHORD'],
    ['[(자동)] E4 r r r', 'INVALID_CHORD'],
    ['[C(추정)] E4 r r r', 'INVALID_CHORD'],
    ['[am] E4 r r r', 'INVALID_CHORD']
  ];
  for (const [text, code] of rejected){
    const result = parser.validateScore(text, 4);
    assert.ok(result.errors.some(e => e.code === code), text + ' reports ' + code);
    assert.equal(parse(text, 4).errors.some(e => e.code === code), true, text + ' parseScore reports ' + code);
  }
  for (const text of ['[-] D4(4) r r r', '[-] (E4 F4) r r r']){
    assert.ok(parser.validateScore(text, 4).errors.length >= 1, text + ' is rejected');
  }
  assert.equal(parser.validateScore('[am] E4 r r r', 4).warnings.some(w => w.code === 'UNSUPPORTED_CHORD'), false, 'an invalid chord header gets no unsupported-chord warning');
  const accepted = [
    '[-] !E4 4D4 E4/F4 r | "메모"',
    '[C/G] E4 r r r',
    '[F#m7b5] E4 r r r',
    '[E7(9)] E4 r r r',
    '[?] E4 r r r',
    '[C?] E4 r r r',
    'E4 r r r',
    '[-] E4 r? ? r',
    '[-] E4 r r r |'
  ];
  for (const text of accepted){
    assert.deepEqual(parser.validateScore(text, 4).errors, [], text + ' has no errors');
    assert.deepEqual(parse(text, 4).errors, [], text + ' parses without errors');
  }
  for (const text of rejected.map(item => item[0]).concat(accepted)){
    const result = parser.validateScore(text, 4);
    assert.equal(result.warnings.concat(result.errors).some(e => e.code === 'AMBIGUOUS_OCTAVE'), false, text + ' never reports AMBIGUOUS_OCTAVE');
  }
  assert.equal(parser.parseScore('[C?] E4 r r r', 4).measures[0].autoChord, true);
  assert.equal(parser.parseScore('[-] E4 r r r', 4).measures[0].chord, '');
  assert.equal(parser.lookupChord('am'), null);
  assert.notEqual(parser.lookupChord('Am'), null);
});

test('every chord dictionary entry is a valid header with six strings, and its lowest note is the root or the slash bass', function(){
  for (const key of Object.keys(parser.CHORD_DB)){
    const entry = parser.CHORD_DB[key];
    const result = parser.validateScore('[' + key + '] C4 - - -', 4);
    assert.equal(result.errors.length, 0, key + ' header has no errors');
    assert.equal(result.warnings.some(w => w.code === 'UNSUPPORTED_CHORD'), false, key + ' is not reported as UNSUPPORTED_CHORD');
    assert.equal(entry.frets.length, 6, key + ' has six frets');
    assert.equal(entry.fingers.length, 6, key + ' has six fingers');
    for (let i = 0; i < 6; i++){
      const fret = entry.frets[i];
      const finger = entry.fingers[i];
      assert.ok(Number.isInteger(fret) && fret >= -1 && fret <= 12, key + ' fret ' + i + ' is an integer in -1..12');
      assert.ok(Number.isInteger(finger) && finger >= 0 && finger <= 4, key + ' finger ' + i + ' is an integer in 0..4');
      if (fret <= 0) assert.equal(finger, 0, key + ' string ' + i + ' has no finger when open or muted');
    }
    assert.ok(typeof entry.name === 'string' && entry.name.trim() !== '', key + ' has a name');
    assert.ok(typeof entry.desc === 'string' && entry.desc.trim() !== '', key + ' has a desc');
    const bassName = key.includes('/') ? key.split('/')[1] : key.match(/^[A-G][#b]?/)[0];
    const expected = parser.parseNoteToken(bassName + '3', 0).midi % 12;
    const lowest = entry.frets.findIndex(f => f >= 0);
    assert.ok(lowest >= 0, key + ' has a sounding string');
    const actual = parser.STRINGS[5 - lowest].midi + entry.frets[lowest];
    assert.equal(actual % 12, expected, key + ' lowest note is the root or slash bass');
  }
});

test('roll ~ is accepted only at the front of a chord of two or more notes', function(){
  const message = token => '롤 ~는 +로 묶은 화음(두 음 이상)의 맨 앞에만 붙입니다: ' + token;
  for (const token of ['~E4', 'E2+~B3', '!E4+~B3', '~r', '~-', '~~E2+B3']){
    const result = parser.validateScore('[-] ' + token + ' r r r', 4);
    const rolls = result.errors.filter(e => e.code === 'INVALID_ROLL');
    assert.equal(rolls.length, 1, token + ' reports one INVALID_ROLL');
    assert.ok(rolls[0].message === message(token) && rolls[0].measure === 1 && rolls[0].beat === 1, token + ' reports the roll message at measure 1 beat 1');
    assert.equal(parser.parseNoteToken(token, 0), null, token + ' is not a note');
    assert.ok(parse('[-] ' + token + ' r r r', 4).errors.some(e => e.code === 'INVALID_ROLL'), token + ' parseScore reports INVALID_ROLL');
  }
  const inSplit = parser.validateScore('[-] C3@5/~A3@3 r r r', 4).errors;
  assert.ok(inSplit.some(e => e.code === 'INVALID_ROLL' && e.message === message('~A3@3')), 'a single note after a split slash reports the part as the token');
  const plain = parser.validateScore('[-] E4! r r r', 4).errors.filter(e => e.code === 'UNKNOWN_NOTE');
  assert.ok(plain.length >= 1, 'other bad tokens stay UNKNOWN_NOTE');
  assert.deepEqual(parser.validateScore('[-] E4 !E4 E2+B3 r', 4).errors, [], 'unmarked notes and apoyando stay valid');
});

test('roll ~ parses with fingering, articulation and the check mark, and marks the beat or split part rolled', function(){
  for (const token of ['~E2@6+B3@2+G4@1', '~0E2@6:p+!4B4@1:a', '~E2@6:p+hE5@1', '~E2+B3?', '~E2@6+sB3@2']){
    const plain = token.slice(1);
    assert.deepEqual(parser.validateScore('[-] ' + token + ' r r r', 4).errors.filter(e => e.code === 'INVALID_ROLL'), [], token + ' has no roll error');
    const rolled = parser.parseNoteToken(token, 0);
    const bare = parser.parseNoteToken(plain, 0);
    assert.ok(rolled && bare, token + ' parses');
    assert.equal(rolled.rolled, true, token + ' is rolled');
    assert.equal(bare.rolled, undefined, plain + ' is not rolled');
    assert.ok(rolled.customTok.charAt(0) === '~' && rolled.customTok.slice(1) === bare.customTok, token + ' customTok is ~ plus the plain customTok');
    assert.deepEqual(rolled.chordNotes, bare.chordNotes, token + ' keeps its components unchanged');
    assert.equal(rolled.midi, bare.midi);
  }
  const fingered = parse('[-] ~0E2@6:p+!4B4@1:a r r r', 4);
  assert.deepEqual(fingered.errors, []);
  const fingeredNotes = fingered.measures[0].beats[0].chordNotes;
  assert.equal(fingeredNotes[0].rh, 'p');
  assert.equal(fingeredNotes[0].lh, 0);
  assert.equal(fingeredNotes[1].rh, 'a');
  assert.equal(fingeredNotes[1].articulation, 'apoyando');
  const harmonic = parse('[-] ~E2@6:p+hE5@1 r r r', 4).measures[0].beats[0];
  assert.equal(harmonic.rolled, true);
  assert.equal(harmonic.chordNotes[1].articulation, 'harmonic');
  const uncertain = parse('[-] ~E2+B3? r r r', 4).measures[0].beats[0];
  assert.equal(uncertain.rolled, true);
  assert.equal(uncertain.uncertain, true);
  assert.ok(uncertain.tok.charAt(0) === '~', 'the beat token keeps the ~');

  const whole = parse('[-] ~E2@6+B3@2+G4@1 E2@6+B3@2 C3@5/~A3@3+D4@2+F#4@1 r', 4);
  assert.deepEqual(whole.errors, []);
  const beats = whole.measures[0].beats;
  assert.equal(beats[0].rolled, true, 'a whole-cell rolled chord');
  assert.equal(beats[1].rolled, false, 'a plain chord is not rolled');
  assert.equal(beats[3].rolled, false, 'a rest is not rolled');
  assert.equal(beats[2].rolled, undefined, 'the split group itself carries no rolled flag');
  assert.deepEqual(beats[2].subNotes.map(p => p.rolled), [false, true], 'only the rolled split part is rolled');
  assert.equal(beats[0].tok, '~E2@6+B3@2+G4@1');
});

test('a roll does not disturb slur judgement of its components', function(){
  const ok = parse('[-] E4@1 ~E2@6+sF4@1 r r', 4);
  assert.deepEqual(ok.errors, [], 'the slur is judged against the previous note on the same string');
  const bad = parse('[-] r ~E2@6+sF4@1 r r', 4);
  assert.ok(bad.errors.some(e => e.code === 'INVALID_SLUR'), 'a slur without a source inside a roll is still an error');
});

test('noteNameForMidi gives octave names in sharp or flat spelling', function(){
  assert.equal(parser.noteNameForMidi(60, false), 'C4');
  assert.equal(parser.noteNameForMidi(40, false), 'E2');
  assert.equal(parser.noteNameForMidi(76, false), 'E5');
  assert.equal(parser.noteNameForMidi(70, false), 'A#4');
  assert.equal(parser.noteNameForMidi(70, true), 'Bb4');
  assert.equal(parser.noteNameForMidi(61, false), 'C#4');
  assert.equal(parser.noteNameForMidi(61, true), 'Db4');
  assert.equal(parser.midiInfo(70).en, 'A#4');
});

test('guitar range runs to GuitarNotation.MAX_FRET on the first string, and default positions of lower notes do not move', function(){
  const MAX_FRET = require('../src/notation.js').MAX_FRET;
  const STRINGS = parser.STRINGS;
  const top = STRINGS[0].midi + MAX_FRET;
  const topName = parser.noteNameForMidi(top, false);
  const overName = parser.noteNameForMidi(top + 1, false);
  const codes = function(raw){ return parser.validateScore('[C] ' + raw + ' - - -', 4).errors.map(function(e){ return e.code; }); };
  // (a) 최고음은 오류 없이 읽히고 기본 위치는 1번 줄 MAX_FRET 프렛
  assert.deepEqual(codes(topName), []);
  const topInfo = parser.parseNoteToken(topName, 0);
  assert.equal(topInfo.midi, top);
  assert.equal(topInfo.pos.str, 1);
  assert.equal(topInfo.pos.fret, MAX_FRET);
  // (c) @줄은 그 줄에서 MAX_FRET까지만
  const secondFret13 = parser.noteNameForMidi(STRINGS[1].midi + 13, false);
  const secondOver = parser.noteNameForMidi(STRINGS[1].midi + MAX_FRET + 1, false);
  assert.deepEqual(codes(secondFret13 + '@2'), []);
  assert.equal(parser.parseNoteToken(secondFret13 + '@2', 0).pos.fret, 13);
  assert.ok(codes(secondOver + '@2').indexOf('INVALID_STRING_OVERRIDE') >= 0);
  // (d) 범위를 넓혀도 이미 있던 음(MIDI 40~76)의 기본 위치는 그대로: 사전에 있으면 그것, 없으면 1번 줄부터 보아 0~12프렛인 첫 줄
  for (let m = 40; m <= 76; m++){
    let expected = parser.FIRST_POS[m] ? { str: parser.FIRST_POS[m].str, fret: parser.FIRST_POS[m].fret } : null;
    for (let i = 0; !expected && i < STRINGS.length; i++){
      const f = m - STRINGS[i].midi;
      if (f >= 0 && f <= 12) expected = { str: STRINGS[i].str, fret: f };
    }
    const pos = parser.midiInfo(m).pos;
    assert.deepEqual({ str: pos.str, fret: pos.fret }, expected, 'midi ' + m);
  }
  // (b) 최고음 + 1반음은 범위 밖
  assert.ok(codes(overName).indexOf('GUITAR_RANGE') >= 0);
});

test('natural harmonics: h + sounding pitch + @string, hand fret from the table, no range limit', function(){
  const HARMONICS = require('../src/notation.js').NATURAL_HARMONICS;
  const STRINGS = parser.STRINGS;
  const MAX_FRET = require('../src/notation.js').MAX_FRET;
  const codes = function(text){ return parser.validateScore('[-] ' + text + ' r r r', 4).errors.map(function(e){ return e.code; }); };
  Object.keys(HARMONICS).forEach(function(handFret){
    STRINGS.forEach(function(string){
      const midi = string.midi + HARMONICS[handFret];
      const token = 'h' + parser.noteNameForMidi(midi, false) + '@' + string.str;
      assert.deepEqual(codes(token), [], token + ' is valid');
      const parsed = parser.parseNoteToken(token, 0);
      assert.equal(parsed.midi, midi, token + ' sounds the written pitch');
      assert.equal(parsed.pos.str, string.str);
      assert.equal(parsed.pos.fret, Number(handFret), token + ' reports the hand fret');
      assert.equal(parsed.articulation, 'harmonic');
      assert.equal(parsed.explicitArticulation, true);
      assert.equal(parsed.harmonic, true);
      assert.equal(parsed.customTok, token);
    });
  });
  // 가장 높은 음(1번 줄, 손 대는 프렛이 가장 낮은 하모닉스)은 일반 음역(MAX_FRET) 밖이어도 받는다
  const topOffset = Math.max.apply(null, Object.keys(HARMONICS).map(function(key){ return HARMONICS[key]; }));
  const topMidi = STRINGS[0].midi + topOffset;
  assert.ok(topOffset > MAX_FRET && topMidi > STRINGS[0].midi + MAX_FRET, 'the highest harmonic is above the normal range');
  const topToken = 'h' + parser.noteNameForMidi(topMidi, false) + '@1';
  assert.deepEqual(codes(topToken), []);
  assert.equal(parser.midiInfo(topMidi).pos, null, 'the same pitch has no normal fingering');
  assert.equal(parser.parseNoteToken(topToken, 0).pos.fret, Math.min.apply(null, Object.keys(HARMONICS).map(Number)));
  // 운지와 확인 표시 (표의 첫 항목, 1번 줄)
  const firstFret = Number(Object.keys(HARMONICS)[0]);
  const firstMidi = STRINGS[0].midi + HARMONICS[firstFret];
  const firstName = parser.noteNameForMidi(firstMidi, false);
  const fingered = parser.parseNoteToken('h' + firstName + '@1:i?', 0);
  assert.equal(fingered.pos.rh, 'i');
  assert.equal(fingered.uncertain, true);
  assert.equal(parser.parseNoteToken('h2' + firstName + '@1', 0).pos.lh, 2);
  assert.equal(parser.parseNoteToken('h2' + firstName + '@1:i', 0).customTok, 'h2' + firstName + '@1:i');
  // 오류: @줄 없음, 표에 없는 오프셋, 주법 조합
  const tableOffsets = Object.keys(HARMONICS).map(function(key){ return HARMONICS[key]; });
  let missingOffset = 1;
  while (tableOffsets.indexOf(missingOffset) >= 0) missingOffset++;
  const offTableToken = 'h' + parser.noteNameForMidi(STRINGS[0].midi + missingOffset, false) + '@1';
  assert.ok(codes('h' + firstName).indexOf('INVALID_HARMONIC') >= 0, 'no @string');
  assert.ok(codes(offTableToken).indexOf('INVALID_HARMONIC') >= 0, 'offset not in the table');
  assert.equal(codes('h' + firstName + '@1').indexOf('INVALID_HARMONIC'), -1, 'control: valid harmonic');
  ['!h' + firstName + '@1', 'h!' + firstName + '@1'].forEach(function(token){
    assert.equal(parser.parseNoteToken(token, 0), null, token + ' is rejected');
    assert.ok(codes(token).length > 0, token + ' is an error');
  });
  const detail = parser.validateScore('[-] h' + firstName + ' r r r', 4).errors;
  const harmonicErrors = detail.filter(function(e){ return e.code === 'INVALID_HARMONIC'; });
  assert.equal(harmonicErrors.length, 1);
  assert.ok(harmonicErrors[0].message.indexOf(require('../src/notation.js').naturalHarmonicFretsText() + '프렛') >= 0 && harmonicErrors[0].message.indexOf('h' + firstName) >= 0);
  assert.equal(detail.filter(function(e){ return e.code === 'INVALID_STRING_OVERRIDE'; }).length, 0);
  // 화음: 구성음마다 따로 붙고 chordNotes에 실린다
  const bassToken = parser.noteNameForMidi(STRINGS[5].midi, false) + '@6';
  const chordText = bassToken + '+h' + firstName + '@1';
  const chordScore = parser.parseScore('[-] ' + chordText + ' r r r', 4);
  assert.deepEqual(chordScore.errors, []);
  const chord = chordScore.measures[0].beats[0];
  assert.deepEqual(chord.chordNotes.map(function(note){ return [note.tok, note.midi, note.str, note.fret, note.articulation, note.explicitArticulation]; }),
    [[bassToken, STRINGS[5].midi, 6, 0, null, false], ['h' + firstName + '@1', firstMidi, 1, firstFret, 'harmonic', true]]);
  assert.equal(chord.tok, chordText);
});

test('skip cells parse into note-less cell objects that are not rests', function(){
  const pickup = parse('[-] _ _ _ E3@4/G3@3', 4);
  assert.deepEqual(pickup.errors, []);
  const cells = pickup.measures[0].beats;
  assert.equal(cells.length, 4, 'a skip cell keeps its place in the measure');
  for (const cell of cells.slice(0, 3)){
    assert.deepEqual([cell.tok, cell.kind, cell.isSubdivided, cell.midi, cell.str, cell.chordNotes, cell.uncertain], ['_', 'skip', false, null, null, null, false]);
    assert.equal(cell.ko, '빈칸');
  }
  assert.equal(cells[3].isSubdivided, true, 'the cell after the skip cells is a normal subdivision');
  const shortMeasure = parse('[G] B3 D4 _ _', 4);
  assert.deepEqual(shortMeasure.errors, []);
  assert.deepEqual(shortMeasure.measures[0].beats.map(cell => cell.kind), ['note', 'note', 'skip', 'skip']);
  const shortEnd = parse('[Am] A2+E3 - - _', 4);
  assert.deepEqual(shortEnd.errors, []);
  assert.deepEqual(shortEnd.measures[0].beats.map(cell => cell.kind), ['note', 'hold', 'hold', 'skip']);
  assert.equal(parser.serializeScoreMeasures(pickup.measures, '\n').split(' | ')[0], '[-] _ _ _ E3@4/G3@3', 'a skip cell serializes as _');
  assert.equal(require('../src/notation.js').isRestToken('_'), false);
});
test('mid-measure chord changes parse multiple chords and attach chords to matching beats', function(){
  // parseBracketChordSpec direct verification
  const spec1 = parser.parseBracketChordSpec('Am, 2:G/B, 3:C, 4:D7', 4);
  assert.equal(spec1.chord, 'Am');
  assert.equal(spec1.autoChord, false);
  assert.equal(spec1.needsInfer, false);
  assert.deepEqual(spec1.chords, [
    { beat: 1, chord: 'Am', autoChord: false },
    { beat: 2, chord: 'G/B', autoChord: false },
    { beat: 3, chord: 'C', autoChord: false },
    { beat: 4, chord: 'D7', autoChord: false }
  ]);

  const spec2 = parser.parseBracketChordSpec('1:Am, 2:G/B', 4);
  assert.equal(spec2.chord, 'Am');
  assert.equal(spec2.autoChord, false);
  assert.deepEqual(spec2.chords, [
    { beat: 1, chord: 'Am', autoChord: false },
    { beat: 2, chord: 'G/B', autoChord: false }
  ]);

  const specEmpty = parser.parseBracketChordSpec('-', 4);
  assert.deepEqual(specEmpty, { chord: '', autoChord: false, needsInfer: false, chords: [] });

  const specNull = parser.parseBracketChordSpec('', 4);
  assert.deepEqual(specNull, { chord: '', autoChord: true, needsInfer: true, chords: [{ beat: 1, chord: '', autoChord: true }] });

  // parseScore integration
  const scoreData = parse('[Am, 2:G/B, 3:C, 4:D7] C4 D4 E4 F4', 4);
  assert.equal(scoreData.errors.length, 0);
  const m = scoreData.measures[0];
  assert.equal(m.chord, 'Am');
  assert.deepEqual(m.chords, [
    { beat: 1, chord: 'Am', autoChord: false },
    { beat: 2, chord: 'G/B', autoChord: false },
    { beat: 3, chord: 'C', autoChord: false },
    { beat: 4, chord: 'D7', autoChord: false }
  ]);
  assert.equal(m.beats[0].chord, 'Am');
  assert.equal(m.beats[0].autoChord, false);
  assert.equal(m.beats[1].chord, 'G/B');
  assert.equal(m.beats[1].autoChord, false);
  assert.equal(m.beats[2].chord, 'C');
  assert.equal(m.beats[2].autoChord, false);
  assert.equal(m.beats[3].chord, 'D7');
  assert.equal(m.beats[3].autoChord, false);

  // Sparse chord beats
  const sparse = parse('[C, 3:G7] C4 D4 E4 F4', 4);
  assert.equal(sparse.errors.length, 0);
  assert.equal(sparse.measures[0].chord, 'C');
  assert.equal(sparse.measures[0].beats[0].chord, 'C');
  assert.equal(sparse.measures[0].beats[0].autoChord, false);
  assert.equal(sparse.measures[0].beats[1].chord, undefined);
  assert.equal(sparse.measures[0].beats[2].chord, 'G7');
  assert.equal(sparse.measures[0].beats[2].autoChord, false);
  assert.equal(sparse.measures[0].beats[3].chord, undefined);

  // Auto-chord ? flag
  const withAuto = parse('[Am?, 2:G/B?] C4 D4 E4 F4', 4);
  assert.equal(withAuto.errors.length, 0);
  assert.equal(withAuto.measures[0].autoChord, true);
  assert.equal(withAuto.measures[0].chords[0].autoChord, true);
  assert.equal(withAuto.measures[0].chords[1].autoChord, true);
  assert.equal(withAuto.measures[0].beats[0].autoChord, true);
  assert.equal(withAuto.measures[0].beats[1].autoChord, true);
});

test('serializeScoreMeasures formats mid-measure chord changes and supports lossless round-trip', function(){
  const raw = '[Am, 2:G/B, 3:C, 4:D7] C4 D4 E4 F4 | "memo"';
  const scoreData = parse(raw, 4);
  assert.equal(scoreData.errors.length, 0);
  const serialized = parser.serializeScoreMeasures(scoreData.measures);
  assert.equal(serialized, '[Am, 2:G/B, 3:C, 4:D7] C4 D4 E4 F4 | "memo"');

  const roundTrip = parse(serialized, 4);
  assert.equal(roundTrip.errors.length, 0);
  assert.deepEqual(roundTrip.measures[0].chords, scoreData.measures[0].chords);
  assert.equal(roundTrip.measures[0].lyric, 'memo');
  assert.equal(roundTrip.measures[0].beats[0].chord, 'Am');
  assert.equal(roundTrip.measures[0].beats[1].chord, 'G/B');

  // Single chord serialized as [Am]
  const single = parse('[Am] C4 D4 E4 F4', 4);
  assert.match(parser.serializeScoreMeasures(single.measures), /^\[Am\] /);

  // Empty chord serialized as [-]
  const none = parse('[-] C4 D4 E4 F4', 4);
  assert.match(parser.serializeScoreMeasures(none.measures), /^\[-\] /);
});

test('validateScore reports INVALID_CHORD_BEAT and DUPLICATE_CHORD_BEAT for mid-measure chords', function(){
  // Non-integer beat
  const nonInt = parser.validateScore('[1.5:Am] C4 D4 E4 F4', 4);
  assert.ok(nonInt.errors.some(e => e.code === 'INVALID_CHORD_BEAT'));

  // Out of range: beat 0 (< 1)
  const zeroBeat = parser.validateScore('[0:Am, 2:G] C4 D4 E4 F4', 4);
  assert.ok(zeroBeat.errors.some(e => e.code === 'INVALID_CHORD_BEAT'));

  // Out of range: beat > bpb
  const overBeat = parser.validateScore('[Am, 5:G] C4 D4 E4 F4', 4);
  assert.ok(overBeat.errors.some(e => e.code === 'INVALID_CHORD_BEAT'));

  // Missing beat specification on subsequent chord
  const missingBeat = parser.validateScore('[Am, G/B] C4 D4 E4 F4', 4);
  assert.ok(missingBeat.errors.some(e => e.code === 'INVALID_CHORD_BEAT'));

  // Duplicate beat: explicit 1: with default 1:
  const dup1 = parser.validateScore('[Am, 1:C] C4 D4 E4 F4', 4);
  assert.ok(dup1.errors.some(e => e.code === 'DUPLICATE_CHORD_BEAT'));

  // Duplicate beat: same beat repeated
  const dup2 = parser.validateScore('[Am, 2:G, 2:C] C4 D4 E4 F4', 4);
  assert.ok(dup2.errors.some(e => e.code === 'DUPLICATE_CHORD_BEAT'));

  // Invalid chord syntax in multi-chord spec
  const invalidChord = parser.validateScore('[Am, 2:한글코드] C4 D4 E4 F4', 4);
  assert.ok(invalidChord.errors.some(e => e.code === 'INVALID_CHORD'));

  // Unsupported chord warning in multi-chord spec
  const unsupported = parser.validateScore('[Am, 2:Cmaj7] C4 D4 E4 F4', 4);
  assert.ok(unsupported.warnings.some(w => w.code === 'UNSUPPORTED_CHORD'));
});

test('empty bracket [] triggers chord inference while explicit dash [-] marks absent chord', function(){
  const emptySpec = parser.parseBracketChordSpec('', 4);
  assert.equal(emptySpec.autoChord, true);
  assert.equal(emptySpec.needsInfer, true);

  const dashSpec = parser.parseBracketChordSpec('-', 4);
  assert.equal(dashSpec.autoChord, false);
  assert.equal(dashSpec.needsInfer, false);

  const parsedEmpty = parser.parseScore('[] C4 E4 G4 C5', 4);
  assert.equal(parsedEmpty.measures[0].chord, 'C');
  assert.equal(parsedEmpty.measures[0].autoChord, true);
  assert.equal(parsedEmpty.measures[0].chords[0].chord, 'C');
  assert.equal(parsedEmpty.measures[0].beats[0].chord, 'C');
});

test('inferred chord in [?] synchronizes to measure.chord and measure.chords[0].chord and serializes with question mark', function(){
  const parsed = parser.parseScore('[?] C4 E4 G4 C5', 4);
  assert.equal(parsed.measures[0].chord, 'C');
  assert.equal(parsed.measures[0].autoChord, true);
  assert.equal(parsed.measures[0].chords[0].chord, 'C');
  assert.equal(parsed.measures[0].chords[0].autoChord, true);
  assert.equal(parsed.measures[0].beats[0].chord, 'C');
  assert.equal(parser.serializeScoreMeasures(parsed.measures), '[C?] C4 E4 G4 C5 | ""');
});

test('multi-chord starting with dash [-, 3:C] parses and round-trips via serializeScoreMeasures', function(){
  const parsed = parser.parseScore('[-, 3:C] C4 D4 E4 F4', 4);
  assert.equal(parsed.measures[0].chords[0].chord, '');
  assert.equal(parsed.measures[0].chords[0].beat, 1);
  assert.equal(parsed.measures[0].chords[1].chord, 'C');
  assert.equal(parsed.measures[0].chords[1].beat, 3);
  assert.equal(parser.serializeScoreMeasures(parsed.measures), '[-, 3:C] C4 D4 E4 F4 | ""');
});
process.stdout.write('1..' + checks + '\n');
