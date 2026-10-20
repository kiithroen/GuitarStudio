const assert = require('node:assert/strict');
const notation = require('../src/notation.js');
const parser = require('../src/parser.js');
assert.equal(global.GuitarNotation, undefined, 'CommonJS loading does not write notation helpers to the Node global');

let checks = 0;
function test(name, fn){ fn(); checks++; process.stdout.write('ok '+checks+' - '+name+'\n'); }

test('only newline and context-free double slash split measures', function(){
  assert.deepEqual(notation.splitScoreMeasures('A4//B4\r\nC4 / D4'), ['A4','B4','C4 / D4']);
  assert.deepEqual(notation.splitScoreMeasures('[C/G] C4/D4 - | "url // x"'), ['[C/G] C4/D4 - | "url // x"']);
});
test('beat tokenizer preserves chord slash and tuplets and splits subdivisions on slash only', function(){
  assert.deepEqual(notation.tokenizeMeasureBeats('[C/G] C4/D4 E4'), ['[C/G]','C4/D4','E4']);
  assert.deepEqual(notation.splitBeatSubtokens('C4/D4'), ['C4','D4']);
  assert.deepEqual(notation.splitBeatSubtokens('C4'), ['C4']);
  assert.deepEqual(notation.splitBeatSubtokens('C4,D4'), ['C4,D4'], 'comma is not a split');
  assert.deepEqual(notation.splitBeatSubtokens('(C4 D4)'), ['(C4 D4)'], 'parentheses are not unwrapped or split on spaces');
  assert.deepEqual(notation.splitBeatSubtokens('D4(4)'), ['D4(4)']);
  assert.deepEqual(notation.tokenizeMeasureBeats('(C4 D4) E4'), ['(C4','D4)','E4'], 'parentheses do not group whitespace');
});
test('decoder protects JSON lyric delimiters and rejects unquoted memos', function(){
  const d=notation.decodeMeasureLine('[C] C4 | "https://x/y | \\\"a\\\""');
  assert.equal(d.lyric, 'https://x/y | "a"');
  assert.deepEqual(d.errors, []);
  assert.equal(notation.decodeMeasureLine('[C] C4 | "너 / 나"').lyric, '너 / 나');
  const unquoted=notation.decodeMeasureLine('[C] C4 | 너 / 나');
  assert.equal(unquoted.errors.length, 1);
  assert.equal(unquoted.errors[0].code, 'INVALID_LYRIC_QUOTE');
  assert.equal(unquoted.errors[0].message, '마디 메모는 큰따옴표 JSON 문자열로 적으세요. 예: | "메모"');
  assert.deepEqual(notation.decodeMeasureLine('[C] C4 |').errors, [], 'an empty memo has no error');
  assert.deepEqual(notation.decodeMeasureLine('[C] C4 |   ').errors, [], 'a blank memo has no error');
  assert.equal(notation.decodeMeasureLine('[C] C4 | "bad').errors[0].code, 'INVALID_LYRIC_QUOTE');
  assert.equal(notation.decodeMeasureLine('[C] C4 - - - | "https://example.com/a | x // y"').lyric,
    'https://example.com/a | x // y');
});
test('serializer quotes lyrics and round trips pipes and slash characters', function(){
  const input=[{chord:'-',notes:['C4','-'],lyric:'가사 // https://x/y | "ok"'}];
  const raw=notation.serializeScoreMeasures(input);
  assert.equal(notation.decodeMeasureLine(raw).lyric,input[0].lyric);
  assert.match(raw,/\[-\]/);
  assert.match(notation.serializeScoreMeasures([{chord:'C',autoChord:true,notes:['C4']}]),/^\[C\?\]/);
});
test('validation catches isolated slash, excess beats, unknown notes, empty parts, and bad strings', function(){
  const result=parser.validateScore('[C] C4 / D4 E4 F4 G4\n[C] C4+H4 - - -\n[C] C4// - - -\n[C] C4@1 - - -',4);
  const codes=result.errors.map(e=>e.code);
  for(const code of ['ISOLATED_SLASH','TOO_MANY_BEATS','UNKNOWN_NOTE','EMPTY_SUBDIVISION','INVALID_STRING_OVERRIDE']) assert.ok(codes.includes(code),code);
  assert.equal(result.errors[0].measure,1);
  assert.equal(result.errors[0].beat,null);
});

test('right-hand suffix validation preserves octave and string diagnostics', function(){
  const octave=parser.parseScore('C:i - - -',4);
  assert.ok(octave.errors.some(e=>e.code==='UNKNOWN_NOTE'),'an omitted octave is an error');
  assert.ok(!octave.warnings.some(e=>e.code==='AMBIGUOUS_OCTAVE'));
  const impossible=parser.parseScore('C2@1:i - - -',4);
  assert.ok(impossible.errors.some(e=>e.code==='INVALID_STRING_OVERRIDE'));
  for(const token of ['C4:P','C4:x','C4:im','C4:i:m','C4:i@2','r:i','-:p','C3:p+E4:i!','C3:p+E4:i~']){
    const result=parser.parseScore(token+' - - -',4);
    assert.ok(result.errors.length,token+' must remain invalid');
  }
});
test('removed duration postfix is rejected consistently by validation and parsing', function(){
  const valid='[C] E2@6+B4@1 B3@2:m G3@3:i r';
  assert.deepEqual(parser.parseScore(valid,4).errors,[]);
  assert.deepEqual(parser.validateScore(valid,4).errors,[]);
  const memo='[C] C4 - - - | "메모 *3"';
  assert.deepEqual(parser.validateScore(memo,4).errors,[],'asterisks in quoted measure notes remain ordinary text');
  assert.equal(parser.parseScore(memo,4).measures[0].lyric,'메모 *3');
  assert.deepEqual(parser.validateScore('C4*3 - - -',4).errors,parser.parseScore('C4*3 - - -',4).errors,
    'the note-token asterisk remains invalid rather than being stripped');
  for(const raw of ['E4*3 r r r','E4*1.5 r r r','E4*3*2 r r r','r*3 r r r','-*3 r r r','- C4 D4 E4']){
    const parsed=parser.parseScore(raw,4).errors.map(error=>[error.code,error.measure,error.beat]);
    const validated=parser.validateScore(raw,4).errors.map(error=>[error.code,error.measure,error.beat]);
    assert.deepEqual(validated,parsed,raw+' parser and validator agree');
    assert.ok(parsed.length,raw+' is rejected');
  }
  const saved=parser.buildStructuredSong({id:'note-roundtrip',lines:[valid],beats:4});
  const restored=parser.buildStructuredSong({id:'note-restored',lines:[parser.serializeScoreMeasures(saved.measures)],beats:4});
  assert.deepEqual(restored.measures[0].beats.map(beat=>beat.tok),saved.measures[0].beats.map(beat=>beat.tok));
  assert.ok(restored.measures[0].beats[0].chordNotes.every(note=>!Object.hasOwn(note,'explicitDurationSlots')));
  let annotated = null;
  global.GuitarRhythm = {annotate:measures=>{ annotated=measures; return {errors:[]}; }};
  try {
    notation.validateScore(valid,4,parser.parseNoteToken);
  } finally {
    delete global.GuitarRhythm;
  }
  assert.deepEqual([annotated[0].beats[0].str,annotated[0].beats[0].chordNotes.map(note=>note.str)], [1,[6,1]]);
  assert.ok(annotated[0].beats.every(beat=>!Object.hasOwn(beat,'explicitDurationSlots')));
  assert.ok(annotated[0].beats[0].chordNotes.every(note=>!Object.hasOwn(note,'explicitDurationSlots')));
});
test('parser and validator share slash subdivision splitting and reject parenthesis groups', function(){
  const result=parser.parseScore('[C] C4/D4 - - -',4);
  assert.equal(result.errors.length,0);
  assert.deepEqual(result.measures[0].beats[0].subNotes.map(n=>n.midi),[60,62]);
  const song=parser.buildStructuredSong({id:'tuple',lines:['[C] C4/D4 - - -'],beats:4});
  assert.equal(song.measures[0].beats[0].subNotes.length,2);
  for(const raw of ['[C] (C4 D4) - - -','[C] (C4/D4) - - -','[C] C4,D4 - - -']){
    assert.ok(parser.parseScore(raw,4).errors.length>=1,raw+' is rejected');
    assert.ok(parser.validateScore(raw,4).errors.length>=1,raw+' fails validation');
  }
});
test('parenthesis-wrapped single notes are rejected', function(){
  for(const token of ['(C4)','(E4@2)']){
    assert.ok(parser.validateScore('[-] '+token+' - - -',4).errors.some(e=>e.code==='UNKNOWN_NOTE'),token);
    assert.throws(()=>parser.buildStructuredSong({id:'group-'+token,lines:['[-] '+token+' - - -'],beats:4}),e=>e.name==='ScoreValidationError');
  }
});
test('string overrides preserve positions and explicit fingers without inferring fingers', function(){
  const single=parser.parseNoteToken('E4@2',0);
  assert.equal(single.pos.str,2);
  assert.equal(single.pos.fret,5);
  assert.equal(single.pos.lh,null);
  assert.equal(single.pos.rh,null);
  assert.equal(single.customTok,'E4@2');
  const explicit=parser.parseNoteToken('3E4@2',0);
  assert.equal(explicit.pos.lh,3);
  assert.equal(explicit.customTok,'3E4@2');
  const bassSide=parser.parseNoteToken('E4@2+G3@3',0);
  assert.ok(bassSide.chordNotes.some(note=>note.tok==='E4@2'));
  assert.ok(bassSide.chordNotes.some(note=>note.tok==='G3@3'));
  assert.ok(!bassSide.chordNotes.some(note=>/^\d[A-G]/.test(note.tok)));
  const bassString=parser.parseNoteToken('C3@5',0);
  assert.equal(bassString.pos.rh,null);
});
test('explicit left-hand lookup reads only source token fingering', function(){
  const getLH=parser.getExplicitLeftHand;
  assert.equal(getLH('C4'),null);
  assert.equal(getLH('E4@2'),null);
  assert.equal(getLH('도4'),null);
  assert.equal(getLH('솔3'),null);
  assert.equal(getLH('1C4'),1);
  assert.equal(getLH('0E4'),0);
  assert.equal(getLH('3솔'),null);
  assert.equal(getLH('D4(4)'),null);
  assert.equal(getLH('(4D4@2)'),null);
  assert.equal(getLH('4D4@2'),4);
  assert.equal(getLH('G3@3+C4@2',0),null);
  assert.equal(getLH('G3@3+C4@2',1),null);
  assert.equal(getLH('0G3@3+1C4@2',0),0);
  assert.equal(getLH('0G3@3+1C4@2',1),1);
  assert.equal(getLH('G3/C4'),null);
});
test('same-string collisions apply only inside a simultaneous chord', function(){
  assert.ok(parser.validateScore('[C] E4@1+F4@1 - - -',4).errors.some(e=>e.code==='STRING_COLLISION'));
  assert.ok(parser.validateScore('[C] !E4@1+F4@1 - - -',4).errors.some(e=>e.code==='STRING_COLLISION'));
  assert.ok(!parser.validateScore('[C] E4@1/F4@1 - - -',4).errors.some(e=>e.code==='STRING_COLLISION'));
  assert.ok(parser.validateScore('[C] C4+' + parser.noteNameForMidi(parser.STRINGS[0].midi + notation.MAX_FRET + 1, false) + ' - - -',4).errors.some(e=>e.code==='GUITAR_RANGE'));
});
test('empty score and empty canonical measures are distinct from empty beat subdivisions', function(){
  assert.ok(parser.validateScore('',4).errors.some(e=>e.code==='EMPTY_SCORE'));
  for(const raw of ['//C4 - - -','C4 - - -//','C4 - - -////D4 - - -']) assert.ok(parser.validateScore(raw,4).errors.some(e=>e.code==='EMPTY_MEASURE'),raw);
  for(const raw of ['[C] C4/ - - -','[C] /C4 - - -']) assert.ok(parser.validateScore(raw,4).errors.some(e=>e.code==='EMPTY_SUBDIVISION'),raw);
  assert.deepEqual(parser.splitScoreMeasures('C4 - / D4 -'),['C4 - / D4 -']);
  assert.ok(parser.validateScore('C4 - / D4 -',4).errors.some(e=>e.code==='ISOLATED_SLASH'));
  assert.equal(parser.validateScore('\n   \n',4).errors.filter(e=>e.code==='EMPTY_SCORE').length,1);
});
test('empty parenthesis group is rejected', function(){
  const score=parser.parseScore('[-] () - - -',4);
  assert.ok(score.errors.length>=1);
  assert.throws(()=>parser.buildStructuredSong({id:'empty-group',lines:['[-] () - - -'],beats:4}),e=>e.name==='ScoreValidationError');
});
test('beat counts are bounded finite integers with a safe four-beat preview fallback', function(){
  assert.equal(parser.parseScore('[-] C4 - - -','4').beats,4);
  assert.equal(parser.parseScore('[-] C4 - - -',undefined).beats,4);
  assert.equal(parser.parseScore('[-] C4 - - -',null).beats,4);
  assert.equal(parser.parseScore('[-] C4 - - -','').beats,4);
  for(const invalid of [1.5,-1,Infinity,13,Number.MAX_VALUE]){
    const preview=parser.parseScore('[-] C4 - - -',invalid);
    assert.equal(preview.beats,4);
    assert.ok(preview.errors.some(e=>e.code==='INVALID_BEATS'),String(invalid));
    assert.equal(preview.measures[0].beats.length,4);
    assert.throws(()=>parser.buildStructuredSong({id:'invalid-beats',lines:['[-] C4 - - -'],beats:invalid}),e=>e.name==='ScoreValidationError');
  }
});
test('accidentals resolve to canonical MIDI and invalid plus components are not dropped', function(){
  const midi=t=>parser.parseNoteToken(t,0).midi;
  assert.equal(midi('Bb4'),70); assert.equal(midi('Eb4'),63);
  for(const legacy of ['E♭4','F♮4','F♯4']) assert.equal(parser.parseNoteToken(legacy,0),null,legacy+' is rejected');
  assert.equal(midi('E#4'),65); assert.equal(midi('B#4'),72); assert.equal(midi('Cb4'),59); assert.equal(midi('Fb4'),64);
  assert.equal(parser.parseNoteToken('C4+H4',0),null);
  assert.equal(parser.parseNoteToken('C4++D4',0),null);
  assert.equal(parser.parseNoteToken('R',0),null);
});
test('score parsing returns diagnostics and structured save rejects invalid score', function(){
  const preview=parser.parseScore('[C] C4 H4 - -',4);
  assert.ok(preview.errors.some(e=>e.code==='UNKNOWN_NOTE'));
  assert.throws(()=>parser.buildStructuredSong({id:'bad',lines:['[C] C4 H4 - -'],beats:4}),e=>e.name==='ScoreValidationError'&&e.errors.length>0);
  assert.equal(parser.buildStructuredSong({id:'ok',lines:['[-] C4 - - - | "lyric"'],beats:4}).notationVersion,2);
  assert.ok(parser.validateScore('[C#maj13] C4 - - -',4).warnings.some(e=>e.code==='UNSUPPORTED_CHORD'));
});
test('sheet beat counts list is the single shared allowed list', function(){
  assert.deepEqual(notation.SHEET_BEAT_COUNTS, [2,3,4,6,8,9]);
});
// 슬러(해머링·풀링): 잇기 규칙은 GuitarNotation.linkSlurs 하나다.
const slurPiece = function(){ return { rest:false, hold:false, notes:Array.prototype.map.call(arguments, function(n){ return { str:n[0], midi:n[1], slur:!!n[2] }; }) }; };
const SLUR_REST = { rest:true, hold:false, notes:[] };
const SLUR_HOLD = { rest:false, hold:true, notes:[] };
const E4 = parser.parseNoteToken('E4', 0).midi;
const slurCodes = function(raw, beats){ return parser.validateScore(raw, beats || 4).errors.filter(function(e){ return e.code === 'INVALID_SLUR'; }); };

test('linkSlurs: higher on the same string is a hammer-on, lower is a pull-off, with the source pitch', function(){
  assert.deepEqual(notation.linkSlurs([slurPiece([1, E4]), slurPiece([1, E4 + 1, true])]),
    [[null], [{ ok:true, type:'hammer', fromMidi:E4, from:{ piece:0, note:0 } }]]);
  assert.deepEqual(notation.linkSlurs([slurPiece([1, E4 + 2]), slurPiece([1, E4, true])]),
    [[null], [{ ok:true, type:'pull', fromMidi:E4 + 2, from:{ piece:0, note:0 } }]]);
});
test('linkSlurs: a rest, the start of the song, or only other strings give no-source; the same pitch gives same-pitch', function(){
  assert.deepEqual(notation.linkSlurs([slurPiece([1, E4]), SLUR_REST, slurPiece([1, E4 + 1, true])]),
    [[null], [], [{ ok:false, reason:'no-source' }]]);
  assert.deepEqual(notation.linkSlurs([slurPiece([1, E4 + 1, true])]), [[{ ok:false, reason:'no-source' }]]);
  assert.deepEqual(notation.linkSlurs([slurPiece([2, E4 - 5]), slurPiece([1, E4 + 1, true])]),
    [[null], [{ ok:false, reason:'no-source' }]]);
  assert.deepEqual(notation.linkSlurs([slurPiece([1, E4]), slurPiece([1, E4, true])]),
    [[null], [{ ok:false, reason:'same-pitch' }]]);
});
test('linkSlurs: holds keep the source, three slurs in a row chain, a failed slur still counts as the last note played', function(){
  assert.deepEqual(notation.linkSlurs([slurPiece([1, E4]), SLUR_HOLD, slurPiece([1, E4 + 1, true])]),
    [[null], [], [{ ok:true, type:'hammer', fromMidi:E4, from:{ piece:0, note:0 } }]]);
  assert.deepEqual(notation.linkSlurs([slurPiece([1, E4]), slurPiece([1, E4 + 1, true]), slurPiece([1, E4 + 3, true]), slurPiece([1, E4, true])]),
    [[null], [{ ok:true, type:'hammer', fromMidi:E4, from:{ piece:0, note:0 } }], [{ ok:true, type:'hammer', fromMidi:E4 + 1, from:{ piece:1, note:0 } }], [{ ok:true, type:'pull', fromMidi:E4 + 3, from:{ piece:2, note:0 } }]]);
  assert.deepEqual(notation.linkSlurs([slurPiece([1, E4, true]), slurPiece([1, E4 + 1, true])]),
    [[{ ok:false, reason:'no-source' }], [{ ok:true, type:'hammer', fromMidi:E4, from:{ piece:0, note:0 } }]]);
});
test('linkSlurs: inside a chord only the slurred component is judged, against the previous piece, per string', function(){
  assert.deepEqual(notation.linkSlurs([slurPiece([6, 40], [1, E4]), slurPiece([6, 40], [1, E4 + 1, true])]),
    [[null, null], [null, { ok:true, type:'hammer', fromMidi:E4, from:{ piece:0, note:1 } }]]);
  assert.deepEqual(notation.linkSlurs([slurPiece([6, 40], [1, E4]), slurPiece([6, 41, true], [1, E4 - 1, true])]),
    [[null, null], [{ ok:true, type:'hammer', fromMidi:40, from:{ piece:0, note:0 } }, { ok:true, type:'pull', fromMidi:E4, from:{ piece:0, note:1 } }]]);
});
test('validateScore: slur needs a previous note on the same string, across measures too, and a different pitch', function(){
  assert.deepEqual(slurCodes('[-] E4/sF4 - - -'), [], 'hammer-on in a subdivision');
  assert.deepEqual(parser.validateScore('[-] E4/sF4 - - -', 4).errors, [], 'no error of any kind');
  assert.deepEqual(slurCodes('[-] F4 sE4 - -'), [], 'pull-off');
  assert.deepEqual(slurCodes('[-] E4 - - -\n[-] sF4 - - -'), [], 'across the measure line');
  assert.deepEqual(slurCodes('[-] E4 - - -\n[-] sF4 - - -\n[-] sG4 - - -'), [], 'three in a row');
  assert.deepEqual(slurCodes('[-] E2@6+E4@1 - E2@6+sF4@1 -'), [], 'a slurred chord component');
  const afterRest = slurCodes('[-] r sF4 - -');
  assert.equal(afterRest.length, 1);
  assert.deepEqual([afterRest[0].measure, afterRest[0].beat], [1, 2]);
  assert.equal(afterRest[0].message, '슬러 앞에 같은 줄에서 친 음이 없습니다(쉼 뒤나 곡 처음은 안 됩니다): sF4');
  assert.equal(slurCodes('[-] sF4 - - -').length, 1, 'start of the song');
  assert.equal(slurCodes('[-] E4 r sF4 -').length, 1, 'a rest between');
  assert.equal(slurCodes('[-] E4 - - r\n[-] sF4 - - -')[0].measure, 2, 'the rest in the previous measure');
  const same = slurCodes('[-] E4 sE4 - -');
  assert.equal(same.length, 1);
  assert.equal(same[0].message, '슬러는 다른 높이로 이어져야 합니다. 같은 음을 잇는 붙임줄은 -로 적으세요: sE4');
  assert.equal(slurCodes('[-] B3 sF4@1 - -').length, 1, 'the previous note is on another string');
  assert.deepEqual(slurCodes('[-] B3@2 sC4@2 - -'), [], '@string makes it the same string');
});
test('slur mark combines with nothing else and keeps the token readable', function(){
  ['!sE4', 's!E4', 'hsE4@1', 'shE4@1', 'ssE4', 'sE4s'].forEach(function(token){
    assert.equal(parser.parseNoteToken(token, 0), null, token + ' is rejected');
    assert.ok(parser.validateScore('[-] E4 ' + token + ' - -', 4).errors.length > 0, token + ' is an error');
  });
  const parsed = parser.parseNoteToken('s1F4@1:i?', 0);
  assert.equal(parsed.articulation, 'slur');
  assert.equal(parsed.explicitArticulation, true);
  assert.equal(parsed.customTok, 's1F4@1:i');
  assert.equal(parsed.uncertain, true);
  assert.equal(parsed.midi, E4 + 1);
  assert.equal(parser.parseNoteToken('sF4', 0).midi, parser.parseNoteToken('F4', 0).midi, 'the pitch is the same as a plain note');
  assert.deepEqual(parser.parseNoteToken('sF4', 0).pos, parser.parseNoteToken('F4', 0).pos, 'the default position is the same too');
});
test('parseScore: slurType (hammer or pull) lands on the note, the subdivision part, and chord components', function(){
  const single = parser.parseScore('[-] E4 sF4 - sE4', 4);
  assert.deepEqual(single.errors, []);
  const beats = single.measures[0].beats;
  assert.equal(beats[0].slurType, undefined);
  assert.deepEqual([beats[1].articulation, beats[1].explicitArticulation, beats[1].slurType], ['slur', true, 'hammer']);
  assert.equal(beats[3].slurType, 'pull');
  const split = parser.parseScore('[-] E4/sF4/sE4 - - -', 4).measures[0].beats[0];
  assert.deepEqual(split.subNotes.map(function(part){ return part.slurType; }), [undefined, 'hammer', 'pull']);
  const chord = parser.parseScore('[-] E2@6+E4@1 E2@6+sF4@1 sF2@6+F4@1 -', 4);
  assert.deepEqual(chord.errors, []);
  const top = chord.measures[0].beats[1];
  assert.equal(top.slurType, 'hammer', 'the highest component is the beat itself');
  assert.deepEqual(top.chordNotes.map(function(note){ return note.slurType; }), [undefined, 'hammer']);
  assert.equal(top.bass.slurType, undefined);
  const lowSlur = chord.measures[0].beats[2];
  assert.equal(lowSlur.bass.slurType, 'hammer', 'the lowest component is the bass');
  assert.deepEqual(lowSlur.chordNotes.map(function(note){ return note.slurType; }), ['hammer', undefined]);
  assert.equal(lowSlur.slurType, undefined);
  const broken = parser.parseScore('[-] r sF4 - -', 4);
  assert.ok(broken.errors.some(function(e){ return e.code === 'INVALID_SLUR'; }));
  assert.equal(broken.measures[0].beats[1].slurType, undefined, 'a slur that does not link gets no direction');
  const acrossMeasures = parser.parseScore('[-] E4 - - -\n[-] sF4 - - -', 4);
  assert.equal(acrossMeasures.measures[1].beats[0].slurType, 'hammer');
});

// 슬라이드(g): 잇기 규칙은 슬러와 같은 linkSlurs, 오류 코드와 파싱 결과가 다르다.
const slideCodes = function(raw, beats){ return parser.validateScore(raw, beats || 4).errors.filter(function(e){ return e.code === 'INVALID_SLIDE'; }); };

test('validateScore: slide follows the slur linking rule but reports INVALID_SLIDE', function(){
  assert.deepEqual(parser.validateScore('[-] E3@4/gF#3@4 - - -', 4).errors, [], 'a slide in a subdivision is valid');
  assert.deepEqual(slideCodes('[-] F4 gE4 - -'), [], 'a downward slide');
  assert.deepEqual(slideCodes('[-] E4 - - -\n[-] gF4 - - -'), [], 'across the measure line');
  assert.deepEqual(slideCodes('[-] E4 - gF4 -'), [], 'a hold between the source and the slide');
  assert.deepEqual(slideCodes('[-] E2@6+E4@1 - E2@6+gF4@1 -'), [], 'a slid chord component');
  const afterRest = slideCodes('[-] r gF4 - -');
  assert.equal(afterRest.length, 1);
  assert.deepEqual([afterRest[0].measure, afterRest[0].beat], [1, 2]);
  assert.equal(afterRest[0].message, '슬라이드 앞에 같은 줄에서 친 음이 없습니다(쉼 뒤나 곡 처음은 안 됩니다): gF4');
  assert.equal(slideCodes('[-] gF4 - - -').length, 1, 'start of the song');
  assert.equal(slideCodes('[-] E4 r gF4 -').length, 1, 'a rest between');
  assert.equal(slideCodes('[-] B3 gF4@1 - -').length, 1, 'the previous note is on another string');
  const same = slideCodes('[-] E4 gE4 - -');
  assert.equal(same.length, 1);
  assert.equal(same[0].message, '슬라이드는 다른 높이로 이어져야 합니다. 같은 음을 잇는 붙임줄은 -로 적으세요: gE4');
  assert.equal(slurCodes('[-] gF4 - - -').length, 0, 'a slide never reports INVALID_SLUR');
  assert.equal(slideCodes('[-] sF4 - - -').length, 0, 'a slur never reports INVALID_SLIDE');
  assert.equal(slurCodes('[-] sF4 - - -').length, 1, 'the slur error is unchanged');
});
test('slide mark combines with nothing else and keeps the token readable', function(){
  ['!gE4', 'g!E4', 'hgE4@1', 'ghE4@1', 'sgE4', 'gsE4', 'ggE4', 'gE4g'].forEach(function(token){
    assert.equal(parser.parseNoteToken(token, 0), null, token + ' is rejected');
    assert.ok(parser.validateScore('[-] E4 ' + token + ' - -', 4).errors.length > 0, token + ' is an error');
  });
  const parsed = parser.parseNoteToken('g1F4@1:i?', 0);
  assert.equal(parsed.articulation, 'slide');
  assert.equal(parsed.explicitArticulation, true);
  assert.equal(parsed.customTok, 'g1F4@1:i');
  assert.equal(parsed.uncertain, true);
  assert.equal(parsed.midi, E4 + 1);
  assert.deepEqual(parser.parseNoteToken('gF4', 0).pos, parser.parseNoteToken('F4', 0).pos, 'the default position is the same as a plain note');
});
test('parseScore: slideType (up or down) and slideFromMidi land on the note, the subdivision part, and chord components', function(){
  const single = parser.parseScore('[-] E4 gF4 - gE4', 4);
  assert.deepEqual(single.errors, []);
  const beats = single.measures[0].beats;
  assert.equal(beats[0].slideType, undefined);
  assert.deepEqual([beats[1].articulation, beats[1].explicitArticulation, beats[1].slideType, beats[1].slideFromMidi], ['slide', true, 'up', E4]);
  assert.equal(beats[1].slurType, undefined, 'a slide has no slurType');
  assert.deepEqual([beats[3].slideType, beats[3].slideFromMidi], ['down', E4 + 1]);
  const split = parser.parseScore('[-] E4/gF4/gE4 - - -', 4).measures[0].beats[0];
  assert.deepEqual(split.subNotes.map(function(part){ return part.slideType; }), [undefined, 'up', 'down']);
  const chord = parser.parseScore('[-] E2@6+E4@1 E2@6+gF4@1 gF2@6+F4@1 -', 4);
  assert.deepEqual(chord.errors, []);
  const top = chord.measures[0].beats[1];
  assert.deepEqual([top.slideType, top.slideFromMidi], ['up', E4], 'the highest component is the beat itself');
  assert.deepEqual(top.chordNotes.map(function(note){ return note.slideType; }), [undefined, 'up']);
  assert.equal(top.bass.slideType, undefined);
  const lowSlide = chord.measures[0].beats[2];
  assert.deepEqual([lowSlide.bass.slideType, lowSlide.bass.slideFromMidi], ['up', parser.STRINGS[5].midi], 'the lowest component is the bass');
  assert.deepEqual(lowSlide.chordNotes.map(function(note){ return note.slideType; }), ['up', undefined]);
  assert.equal(lowSlide.slideType, undefined);
  const broken = parser.parseScore('[-] r gF4 - -', 4);
  assert.ok(broken.errors.some(function(e){ return e.code === 'INVALID_SLIDE'; }));
  assert.equal(broken.measures[0].beats[1].slideType, undefined, 'a slide that does not link gets no direction');
  const acrossMeasures = parser.parseScore('[-] E4 - - -\n[-] gF4 - - -', 4);
  assert.equal(acrossMeasures.measures[1].beats[0].slideType, 'up');
});
process.stdout.write('1..'+checks+'\n');
