const assert = require('node:assert/strict');
const notation = require('../src/notation.js');
const parser = require('../src/parser.js');
assert.equal(global.GuitarNotation, undefined, 'CommonJS loading does not write notation helpers to the Node global');

let checks = 0;
function test(name, fn){ fn(); checks++; process.stdout.write('ok '+checks+' - '+name+'\n'); }

test('only newline and context-free double slash split measures', function(){
  assert.deepEqual(notation.splitScoreMeasures('A4//B4\r\nC4 / D4'), ['A4','B4','C4 / D4']);
  assert.deepEqual(notation.splitScoreMeasures('[C/G] (C4//D4) - | "url // x"'), ['[C/G] (C4//D4) - | "url // x"']);
});
test('beat tokenizer preserves chord slash, tuplets, and fingering suffix', function(){
  assert.deepEqual(notation.tokenizeMeasureBeats('[C/G] (C4/D4) D4(4)'), ['[C/G]','(C4/D4)','D4(4)']);
  assert.deepEqual(notation.splitBeatSubtokens('(C4 D4)'), ['C4','D4']);
  assert.deepEqual(notation.splitBeatSubtokens('D4(4)'), ['D4(4)']);
});
test('decoder protects JSON lyric delimiters and keeps unquoted single slash', function(){
  const d=notation.decodeMeasureLine('[C] C4 | "https://x/y | \\\"a\\\""');
  assert.equal(d.lyric, 'https://x/y | "a"');
  assert.deepEqual(d.errors, []);
  assert.equal(notation.decodeMeasureLine('[C] C4 | 너 / 나').lyric, '너 / 나');
  assert.equal(notation.decodeMeasureLine('[C] C4 | "bad').errors[0].code, 'INVALID_LYRIC_QUOTE');
  assert.equal(notation.decodeMeasureLine('[C] C4 - - - | https://example.com/a | x // y').lyric,
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
  assert.ok(octave.warnings.some(e=>e.code==='AMBIGUOUS_OCTAVE'));
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
test('parser and validator share grouped subdivision splitting', function(){
  const result=parser.parseScore('[C] (C4 D4) - - -',4);
  assert.equal(result.errors.length,0);
  assert.deepEqual(result.measures[0].beats[0].subNotes.map(n=>n.midi),[60,62]);
  const song=parser.buildStructuredSong({id:'tuple',lines:['[C] (C4 D4) - - -'],beats:4});
  assert.equal(song.measures[0].beats[0].subNotes.length,2);
});
test('single-note groups parse their inner token and survive save serialization', function(){
  for(const [token,midi] of [['(C4)',60],['(E4@2)',64]]){
    const song=parser.buildStructuredSong({id:'group-'+token,lines:['[-] '+token+' - - -'],beats:4});
    assert.equal(song.measures[0].beats[0].midi,midi);
    assert.equal(song.measures[0].beats[0].tok,token);
    const serialized=parser.serializeScoreMeasures(song.measures);
    const restored=parser.buildStructuredSong({id:'restored',lines:[serialized],beats:4});
    assert.equal(restored.measures[0].beats[0].midi,midi);
    assert.equal(restored.measures[0].beats[0].tok,token);
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
  assert.equal(getLH('3솔'),3);
  assert.equal(getLH('D4(4)'),4);
  assert.equal(getLH('(4D4@2)'),4);
  assert.equal(getLH('G3@3+C4@2',0),null);
  assert.equal(getLH('G3@3+C4@2',1),null);
  assert.equal(getLH('0G3@3+1C4@2',0),0);
  assert.equal(getLH('0G3@3+1C4@2',1),1);
  assert.equal(getLH('G3/C4'),null);
});
test('same-string collisions apply only inside a simultaneous chord', function(){
  assert.ok(parser.validateScore('[C] E4@1+F4@1 - - -',4).errors.some(e=>e.code==='STRING_COLLISION'));
  assert.ok(parser.validateScore('[C] E4@1!+F4@1 - - -',4).errors.some(e=>e.code==='STRING_COLLISION'));
  assert.ok(!parser.validateScore('[C] E4@1/F4@1 - - -',4).errors.some(e=>e.code==='STRING_COLLISION'));
  assert.ok(parser.validateScore('[C] C4+F5 - - -',4).errors.some(e=>e.code==='GUITAR_RANGE'));
});
test('empty score and empty canonical measures are distinct from empty beat subdivisions', function(){
  assert.ok(parser.validateScore('',4).errors.some(e=>e.code==='EMPTY_SCORE'));
  for(const raw of ['//C4 - - -','C4 - - -//','C4 - - -////D4 - - -']) assert.ok(parser.validateScore(raw,4).errors.some(e=>e.code==='EMPTY_MEASURE'),raw);
  for(const raw of ['[C] C4/ - - -','[C] /C4 - - -']) assert.ok(parser.validateScore(raw,4).errors.some(e=>e.code==='EMPTY_SUBDIVISION'),raw);
  assert.deepEqual(parser.splitScoreMeasures('C4 - / D4 -'),['C4 - / D4 -']);
  assert.ok(parser.validateScore('C4 - / D4 -',4).errors.some(e=>e.code==='ISOLATED_SLASH'));
  assert.equal(parser.validateScore('\n   \n',4).errors.filter(e=>e.code==='EMPTY_SCORE').length,1);
});
test('empty grouped beat is rejected as an empty subdivision', function(){
  const score=parser.parseScore('[-] () - - -',4);
  assert.ok(score.errors.some(e=>e.code==='EMPTY_SUBDIVISION'));
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
  assert.equal(midi('Bb4'),70); assert.equal(midi('E♭4'),63); assert.equal(midi('F♮4'),65);
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
  assert.ok(parser.validateScore('[H#maj] C4 - - -',4).warnings.some(e=>e.code==='UNSUPPORTED_CHORD'));
});
process.stdout.write('1..'+checks+'\n');
