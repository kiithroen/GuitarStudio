const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const alphaTab = require('../vendor/alphatab/dist/alphaTab.min.js');
const converter = require('../src/score-to-alphatex.js');
const layoutApi = require('../src/staff-layout.js');
const parser = require('../src/parser.js');
const notation = require('../src/notation.js');
const rhythm = require('../src/rhythm.js');

const model = alphaTab.model;
const TICKS_PER_QUARTER = 960;

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

// 변환한 alphaTex를 alphaTab 가져오기로 읽는다. 진단이 하나라도 있으면(경고 포함) 실패한다.
function importTex(tex){
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  let score = null;
  let thrown = null;
  try { score = importer.readScore(); } catch (error) { thrown = error; }
  const diagnostics = [importer.lexerDiagnostics, importer.parserDiagnostics, importer.semanticDiagnostics]
    .flatMap(function(bag){ return bag && Array.isArray(bag.items) ? bag.items : []; })
    .map(function(item){ return item.code + ' ' + item.message; });
  return { score: score, thrown: thrown, diagnostics: diagnostics };
}

function convert(song){
  const result = converter.toAlphaTex(Object.assign({ title: 'T', beats: 4, bpm: 60, capo: 0 }, song));
  assert.equal(result.error, undefined, 'convert error: ' + result.error);
  const imported = importTex(result.tex);
  assert.deepEqual(imported.diagnostics, [], 'alphaTex diagnostics for:\n' + result.tex);
  assert.equal(imported.thrown, null, 'alphaTex read for:\n' + result.tex);
  return { tex: result.tex, score: imported.score, staff: imported.score.tracks[0].staves[0] };
}

function barBeats(staff, barIndex){ return staff.bars[barIndex].voices[0].beats; }
function allBeats(staff){ return staff.bars.flatMap(function(bar){ return bar.voices[0].beats; }); }
// alphaTab 줄 번호(높은 줄이 큼)를 우리 줄 번호(1번 줄이 높은 미)로.
function ourString(note){ return note.beat.voice.bar.staff.tuning.length - note.string + 1; }
function openMidi(str){ return parser.STRINGS[str - 1].midi; }

function noteOnEvents(score){
  const file = new alphaTab.midi.MidiFile();
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(file);
  new alphaTab.midi.MidiFileGenerator(score, new alphaTab.Settings(), handler).generate();
  return file.tracks.flatMap(function(track){ return track.events; })
    .filter(function(event){ return event.type === alphaTab.midi.MidiEventType.NoteOn; })
    .map(function(event){ return { tick: event.tick, key: event.noteKey }; });
}

function expectedBarTicks(beats){
  const grid = rhythm.getGridInfo(beats);
  return grid.numerator * (TICKS_PER_QUARTER * 4 / grid.denominator);
}

function assertBarLengths(staff, beats, label){
  const want = expectedBarTicks(beats);
  staff.bars.forEach(function(bar, index){
    const sum = bar.voices[0].beats.reduce(function(total, beat){ return total + beat.playbackDuration; }, 0);
    assert.equal(sum, want, label + ' bar ' + (index + 1) + ' tick sum');
    assert.equal(bar.masterBar.calculateDuration(), want, label + ' bar ' + (index + 1) + ' master bar length');
  });
}

const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '../songs.json'), 'utf8'));

test('built-in songs: alphaTex imports without diagnostics, bar count and bar lengths match', function(){
  let count = 0;
  songs.forEach(function(song){
    const capo = parser.getSongCapo({ title: song.title, badge: song.badge });
    const result = converter.toAlphaTex({ title: song.title, beats: song.beats, bpm: song.bpm, capo: capo, lines: song.lines });
    assert.equal(result.error, undefined, song.id + ': ' + result.error);
    const imported = importTex(result.tex);
    assert.deepEqual(imported.diagnostics, [], song.id + ' diagnostics');
    assert.equal(imported.thrown, null, song.id + ' read');
    const score = imported.score;
    const ourMeasures = parser.parseScore(song.lines.join('\n'), song.beats).measures.length;
    assert.equal(score.masterBars.length, ourMeasures, song.id + ' bar count');
    assert.equal(score.tracks.length, 1, song.id + ' track count');
    const staff = score.tracks[0].staves[0];
    assert.equal(staff.bars.length, ourMeasures, song.id + ' staff bar count');
    assertBarLengths(staff, song.beats, song.id);
    assert.equal(staff.capo, capo, song.id + ' capo');
    count++;
  });
  assert.equal(count, songs.length);
  assert.ok(count >= 20, 'checked the built-in songs');
  process.stdout.write('  built-in songs: ' + count + '\n');
});

test('built-in songs: every beat, string, fret and sounding pitch matches the staff layout', function(){
  songs.forEach(function(song){
    const capo = parser.getSongCapo({ title: song.title, badge: song.badge });
    const result = converter.toAlphaTex({ title: song.title, beats: song.beats, bpm: song.bpm, capo: capo, lines: song.lines });
    const staff = importTex(result.tex).score.tracks[0].staves[0];
    const layout = layoutApi.layoutScore(song.lines.join('\n'), song.beats, 0);
    layout.measures.forEach(function(measure, barIndex){
      const beats = barBeats(staff, barIndex);
      assert.equal(beats.length, measure.items.length, song.id + ' bar ' + (barIndex + 1) + ' beat count');
      measure.items.forEach(function(item, itemIndex){
        const beat = beats[itemIndex];
        assert.equal(beat.isRest, item.type === 'rest', song.id + ' bar ' + (barIndex + 1) + ' item ' + itemIndex + ' rest');
        if (item.type !== 'chord') return;
        assert.equal(beat.notes.length, item.notes.length, song.id + ' note count');
        item.notes.forEach(function(note, noteIndex){
          const got = beat.notes.find(function(candidate){ return ourString(candidate) === note.str; });
          assert.ok(got, song.id + ' string ' + note.str + ' present');
          assert.equal(got.fret, note.fret, song.id + ' fret');
          const offset = note.harmonic ? notation.NATURAL_HARMONICS[note.fret] : note.fret;
          assert.equal(got.realValue, openMidi(note.str) + offset + capo, song.id + ' sounding pitch of ' + note.name);
        });
      });
    });
  });
});

test('built-in songs: every emitted slur and slide origin finds its destination in the model', function(){
  let slurs = 0, slides = 0;
  songs.forEach(function(song){
    const layout = layoutApi.layoutScore(song.lines.join('\n'), song.beats, 0);
    let wantSlur = 0, wantSlide = 0;
    layout.measures.forEach(function(measure){
      measure.slurs.forEach(function(link){
        if (link.fromItem == null) return;
        if (link.kind === 'slide') wantSlide++; else wantSlur++;
      });
    });
    const staff = convert({ title: song.title, beats: song.beats, bpm: song.bpm, lines: song.lines }).staff;
    const notes = allBeats(staff).flatMap(function(beat){ return beat.notes; });
    const gotSlur = notes.filter(function(note){ return note.isHammerPullOrigin && note.hammerPullDestination; }).length;
    const gotSlide = notes.filter(function(note){ return note.slideOutType === model.SlideOutType.Legato && note.slideTarget; }).length;
    assert.equal(gotSlur, wantSlur, song.id + ' hammer/pull origins');
    assert.equal(gotSlide, wantSlide, song.id + ' slide origins');
    slurs += wantSlur;
    slides += wantSlide;
  });
  process.stdout.write('  slur origins: ' + slurs + ', slide origins: ' + slides + '\n');
});

test('header: title is escaped, tempo and time signature follow the grid', function(){
  const quoted = convert({ title: 'A "q" \\ b', lines: ['E4 r r r'] });
  assert.equal(quoted.score.title, 'A "q" \\ b');
  const cases = [
    { beats: 2, bpm: 80, tempo: 80, num: 2, den: 4 },
    { beats: 3, bpm: 90, tempo: 90, num: 3, den: 4 },
    { beats: 4, bpm: 64, tempo: 64, num: 4, den: 4 },
    // 8분음표 칸이면 알파텍스 템포(4분음표 기준)는 BPM의 절반
    { beats: 8, bpm: 120, tempo: 60, num: 4, den: 4 },
    { beats: 6, bpm: 120, tempo: 60, num: 6, den: 8 },
    { beats: 9, bpm: 100, tempo: 50, num: 9, den: 8 }
  ];
  cases.forEach(function(c){
    const rest = Array.from({ length: c.beats }, function(){ return 'r'; }).join(' ');
    const out = convert({ beats: c.beats, bpm: c.bpm, lines: [rest] });
    const grid = rhythm.getGridInfo(c.beats);
    const quarterSlots = grid.slotQuarterLength;
    assert.equal(out.score.tempo, c.bpm * quarterSlots, 'tempo for ' + c.beats + ' cells derives from slot length');
    assert.equal(out.score.tempo, c.tempo, 'tempo for ' + c.beats + ' cells');
    const bar = out.score.masterBars[0];
    assert.equal(bar.timeSignatureNumerator, c.num, 'numerator for ' + c.beats);
    assert.equal(bar.timeSignatureDenominator, c.den, 'denominator for ' + c.beats);
    assertBarLengths(out.staff, c.beats, 'rest bar ' + c.beats);
  });
});

test('capo: staff capo is set and sounding pitch is the written pitch plus capo', function(){
  const plain = convert({ lines: ['E4 B3 r r'] });
  assert.equal(plain.staff.capo, 0);
  assert.doesNotMatch(plain.tex, /\\capo/);
  const capoed = convert({ capo: 2, lines: ['E4@1 B3@2 r r'] });
  assert.equal(capoed.staff.capo, 2);
  const notes = barBeats(capoed.staff, 0).filter(function(beat){ return !beat.isRest; }).map(function(beat){ return beat.notes[0]; });
  assert.deepEqual(notes.map(function(note){ return note.fret; }), [parser.parseNoteToken('E4@1', 0).pos.fret, parser.parseNoteToken('B3@2', 0).pos.fret]);
  assert.deepEqual(notes.map(function(note){ return note.realValue; }), [parser.parseNoteToken('E4@1', 0).midi + 2, parser.parseNoteToken('B3@2', 0).midi + 2]);
  const bad = converter.toAlphaTex({ title: 'T', beats: 4, bpm: 60, capo: 13, lines: ['E4 r r r'] });
  assert.equal(bad.tex, undefined);
  assert.match(bad.error, /니다\.$/);
});

test('rests, dotted notes and tuplets keep the layout lengths', function(){
  // 점4분 + 8분, 4분 + 4분 쉼 (8분음표 칸 아님: 4칸 마디)
  const dotted = convert({ lines: ['E4 -/F4 r r'] });
  const beats = barBeats(dotted.staff, 0);
  assert.equal(beats[0].duration, model.Duration.Quarter);
  assert.equal(beats[0].dots, 1);
  assert.equal(beats[1].duration, model.Duration.Eighth);
  assert.equal(beats[1].dots, 0);
  assertBarLengths(dotted.staff, 4, 'dotted');

  const triplet = convert({ lines: ['E4/F4/G4 r r r'] });
  const tripletBeats = barBeats(triplet.staff, 0).slice(0, 3);
  tripletBeats.forEach(function(beat){
    assert.equal(beat.tupletNumerator, 3);
    assert.equal(beat.tupletDenominator, 2);
    assert.equal(beat.duration, model.Duration.Eighth);
  });
  assert.equal(barBeats(triplet.staff, 0)[3].tupletNumerator, -1);
  assertBarLengths(triplet.staff, 4, 'triplet');

  // 2/3 + 1/3 (셋잇단 4분 + 셋잇단 8분)
  const mixed = convert({ lines: ['E4/-/F4 r r r'] });
  assert.equal(barBeats(mixed.staff, 0)[0].duration, model.Duration.Quarter);
  assert.equal(barBeats(mixed.staff, 0)[0].tupletNumerator, 3);
  assertBarLengths(mixed.staff, 4, 'mixed triplet');

  // 마디가 통째로 쉼이면 온쉼표 하나 (3/4에서도 마디 길이와 맞는다)
  const whole = convert({ beats: 3, lines: ['r r r'] });
  assert.equal(barBeats(whole.staff, 0).length, 1);
  assert.ok(barBeats(whole.staff, 0)[0].isFullBarRest);
  assertBarLengths(whole.staff, 3, 'whole rest in 3/4');
});

test('tie: the later piece of a note split at the bar line is a tie destination', function(){
  const out = convert({ lines: ['G3@3 G3@3 G3@3 E4', '- r r r'] });
  const first = barBeats(out.staff, 0)[3];
  const second = barBeats(out.staff, 1)[0];
  assert.equal(first.notes[0].isTieDestination, false);
  assert.equal(second.notes[0].isTieDestination, true);
  assert.equal(second.notes[0].tieOrigin, first.notes[0]);
  assert.equal(second.notes[0].fret, first.notes[0].fret);
  assert.equal(second.notes[0].string, first.notes[0].string);
  // 화음 전체가 이어진다
  const chord = convert({ lines: ['G3@3 G3@3 G3@3 E2@6+E4@1', '- r r r'] });
  const chordNotes = barBeats(chord.staff, 1)[0].notes;
  assert.equal(chordNotes.length, 2);
  chordNotes.forEach(function(note){ assert.equal(note.isTieDestination, true); });
});

test('natural harmonic: nh with the touched fret', function(){
  const out = convert({ lines: ['hF#5@2 hE5@1 hB5@1 r'] });
  const notes = barBeats(out.staff, 0).slice(0, 3).map(function(beat){ return beat.notes[0]; });
  const want = [{ str: 2, fret: 7 }, { str: 1, fret: 12 }, { str: 1, fret: 7 }];
  assert.equal(parser.parseNoteToken('hF#5@2', 0).pos.fret, 7);
  notes.forEach(function(note, index){
    assert.equal(note.harmonicType, model.HarmonicType.Natural, 'harmonic type ' + index);
    assert.equal(ourString(note), want[index].str);
    assert.equal(note.fret, want[index].fret);
  });
  const sounding = ['hF#5@2', 'hE5@1', 'hB5@1'].map(function(token){ return parser.parseNoteToken(token, 0).midi; });
  assert.deepEqual(notes.map(function(note){ return note.realValue; }), sounding);
  // 일반 음은 하모닉스가 아니다
  const plain = convert({ lines: ['E4 r r r'] });
  assert.equal(barBeats(plain.staff, 0)[0].notes[0].harmonicType, model.HarmonicType.None);
});

test('slur: the origin note carries hammer-on / pull-off and the destination follows', function(){
  const hammer = convert({ lines: ['E4@1/sF4@1 r r r'] });
  const [origin, destination] = barBeats(hammer.staff, 0).slice(0, 2).map(function(beat){ return beat.notes[0]; });
  assert.equal(origin.isHammerPullOrigin, true);
  assert.equal(destination.isHammerPullOrigin, false);
  assert.equal(origin.hammerPullDestination, destination);
  assert.equal(destination.hammerPullOrigin, origin);
  assert.ok(destination.fret > origin.fret, 'hammer-on goes up');
  assert.equal(origin.slideOutType, model.SlideOutType.None);

  const pull = convert({ lines: ['F4@1/sE4@1 r r r'] });
  const pullNotes = barBeats(pull.staff, 0).slice(0, 2).map(function(beat){ return beat.notes[0]; });
  assert.equal(pullNotes[0].isHammerPullOrigin, true);
  assert.ok(pullNotes[1].fret < pullNotes[0].fret, 'pull-off goes down');
  assert.equal(pullNotes[1].isHammerPullOrigin, false);

  // 마디를 넘는 슬러: 출발 마디의 음이 출발 음이다
  const across = convert({ lines: ['G3@3 G3@3 G3@3 E4@1', 'sF4@1 r r r'] });
  const acrossOrigin = barBeats(across.staff, 0)[3].notes[0];
  assert.equal(acrossOrigin.isHammerPullOrigin, true);
  assert.equal(acrossOrigin.hammerPullDestination, barBeats(across.staff, 1)[0].notes[0]);
  assert.equal(barBeats(across.staff, 1)[0].notes[0].isHammerPullOrigin, false);

  // 붙임줄로 나뉜 출발 음은 마지막 토막이 출발 음이다
  const tied = convert({ lines: ['G3@3 G3@3 G3@3 E4@1', '- G3@3 G3@3 sF4@1'] });
  const tiedOrigin = barBeats(tied.staff, 1)[0].notes[0];
  assert.equal(tiedOrigin.isTieDestination, true);
  assert.equal(tiedOrigin.isHammerPullOrigin, true);
  assert.equal(barBeats(tied.staff, 0)[3].notes[0].isHammerPullOrigin, false);
  assert.equal(tiedOrigin.hammerPullDestination, barBeats(tied.staff, 1)[3].notes[0]);

  // 연속 슬러: 가운데 음은 도착이면서 출발
  const chain = convert({ lines: ['E4@1/sF4@1/sG4@1 r r r'] });
  const chainNotes = barBeats(chain.staff, 0).slice(0, 3).map(function(beat){ return beat.notes[0]; });
  assert.deepEqual(chainNotes.map(function(note){ return note.isHammerPullOrigin; }), [true, true, false]);
});

test('slide: the origin note carries a legato slide toward the destination', function(){
  const up = convert({ lines: ['E3@4/gF#3@4 r r r'] });
  const [upOrigin, upTarget] = barBeats(up.staff, 0).slice(0, 2).map(function(beat){ return beat.notes[0]; });
  assert.equal(upOrigin.slideOutType, model.SlideOutType.Legato);
  assert.equal(upOrigin.slideTarget, upTarget);
  assert.equal(upTarget.slideOrigin, upOrigin);
  assert.equal(upTarget.slideOutType, model.SlideOutType.None);
  assert.equal(upOrigin.isHammerPullOrigin, false);
  const upLink = parser.parseScore('E3@4/gF#3@4 r r r', 4).measures[0].beats[0].subNotes[1];
  assert.equal(upLink.slideType, 'up');
  assert.ok(upTarget.realValue > upOrigin.realValue);

  const down = convert({ lines: ['F#3@4/gE3@4 r r r'] });
  const [downOrigin, downTarget] = barBeats(down.staff, 0).slice(0, 2).map(function(beat){ return beat.notes[0]; });
  assert.equal(downOrigin.slideOutType, model.SlideOutType.Legato);
  assert.ok(downTarget.realValue < downOrigin.realValue);
  assert.equal(parser.parseScore('F#3@4/gE3@4 r r r', 4).measures[0].beats[0].subNotes[1].slideType, 'down');

  const across = convert({ lines: ['G3@3 G3@3 G3@3 E3@4', 'gF#3@4 r r r'] });
  assert.equal(barBeats(across.staff, 0)[3].notes[0].slideOutType, model.SlideOutType.Legato);
  assert.equal(barBeats(across.staff, 0)[3].notes[0].slideTarget, barBeats(across.staff, 1)[0].notes[0]);
});

test('roll: arpeggio brush plays the lowest string first, a plain chord has none', function(){
  const rolled = convert({ lines: ['~E2@6+B3@2+G4@1 r r r'] });
  const beat = barBeats(rolled.staff, 0)[0];
  // 알파텍스 ad(ArpeggioDown)가 낮은 소리부터 굴린다. 방향은 모델 값과 실제 MIDI 순서로 확인한다.
  assert.equal(beat.brushType, model.BrushType.ArpeggioDown);
  const ons = noteOnEvents(rolled.score).sort(function(a, b){ return a.tick - b.tick || a.key - b.key; });
  assert.equal(ons.length, 3);
  const midis = ['E2@6', 'B3@2', 'G4@1'].map(function(token){ return parser.parseNoteToken(token, 0).midi; });
  assert.deepEqual(ons.map(function(event){ return event.key; }), midis, 'lowest pitch first');
  assert.ok(ons[0].tick < ons[1].tick && ons[1].tick < ons[2].tick, 'staggered start ticks');

  const plain = convert({ lines: ['E2@6+B3@2+G4@1 r r r'] });
  assert.equal(barBeats(plain.staff, 0)[0].brushType, model.BrushType.None);
  const plainOns = noteOnEvents(plain.score);
  assert.equal(new Set(plainOns.map(function(event){ return event.tick; })).size, 1, 'plain chord starts together');

  // 롤 첫 토막에만: 마디를 넘어 이어진 뒤 토막에는 브러시가 없다
  const split = convert({ lines: ['G3@3 G3@3 G3@3 ~E2@6+B3@2', '- r r r'] });
  assert.equal(barBeats(split.staff, 0)[3].brushType, model.BrushType.ArpeggioDown);
  assert.equal(barBeats(split.staff, 1)[0].brushType, model.BrushType.None);
});

test('fingering: left 1-4 and right p i m a map to alphaTab fingers, unwritten stays unknown', function(){
  const left = { 1: model.Fingers.IndexFinger, 2: model.Fingers.MiddleFinger, 3: model.Fingers.AnnularFinger, 4: model.Fingers.LittleFinger };
  const right = { p: model.Fingers.Thumb, i: model.Fingers.IndexFinger, m: model.Fingers.MiddleFinger, a: model.Fingers.AnnularFinger };
  const out = convert({ lines: ['1G3@3:p 2G3@3:i 3G3@3:m 4G3@3:a', '0G3@3 G3@3:p 1G3@3 G3@3'] });
  const first = barBeats(out.staff, 0).map(function(beat){ return beat.notes[0]; });
  ['p', 'i', 'm', 'a'].forEach(function(finger, index){
    assert.equal(first[index].leftHandFinger, left[index + 1], 'left finger ' + (index + 1));
    assert.equal(first[index].rightHandFinger, right[finger], 'right finger ' + finger);
  });
  const second = barBeats(out.staff, 1).map(function(beat){ return beat.notes[0]; });
  assert.equal(second[0].leftHandFinger, model.Fingers.Unknown, 'open (0) is not a finger');
  assert.equal(second[0].rightHandFinger, model.Fingers.Unknown);
  assert.equal(second[1].leftHandFinger, model.Fingers.Unknown);
  assert.equal(second[1].rightHandFinger, model.Fingers.Thumb);
  assert.equal(second[2].leftHandFinger, left[1]);
  assert.equal(second[2].rightHandFinger, model.Fingers.Unknown);
  assert.equal(second[3].leftHandFinger, model.Fingers.Unknown);
  // 화음은 구성음마다 자기 운지를 갖는다
  const chord = convert({ lines: ['3C3@5:p+1C4@2:i r r r'] });
  const notes = barBeats(chord.staff, 0)[0].notes;
  const byString = {};
  notes.forEach(function(note){ byString[ourString(note)] = note; });
  assert.equal(byString[5].leftHandFinger, left[3]);
  assert.equal(byString[5].rightHandFinger, right.p);
  assert.equal(byString[2].leftHandFinger, left[1]);
  assert.equal(byString[2].rightHandFinger, right.i);
});

test('chord names: shown on the first beat of the bar, absent for [-], case-only differences stay distinct', function(){
  const out = convert({ lines: ['[Am] E4 r r r', '[-] E4 r r r', '[G7] r E4 r r', '[CM7] E4 r r r', '[Cm7] E4 r r r', '[CM7] E4 r r r'] });
  const staff = out.staff;
  function chordName(bar){
    const beat = barBeats(staff, bar)[0];
    return beat.chordId ? { id: beat.chordId, name: staff.chords.get(beat.chordId).name } : null;
  }
  assert.equal(chordName(0).name, 'Am');
  assert.equal(chordName(1), null);
  assert.equal(chordName(2).name, 'G7', 'chord goes on the first beat of the bar even when it is a rest');
  assert.equal(barBeats(staff, 2)[1].chordId, null);
  const pad = converter.CHORD_NAME_PAD;
  assert.equal(chordName(3).name, 'CM7');
  assert.equal(chordName(4).name, 'Cm7' + pad);
  assert.equal(chordName(5).name, 'CM7');
  assert.notEqual(chordName(3).id, chordName(4).id, 'CM7 and Cm7 are different chords');
  assert.equal(chordName(3).id, chordName(5).id);
});

function firstBeats(staff){ return staff.bars.map(function(bar){ return bar.voices[0].beats[0]; }); }

test('memo: the bar memo goes to the first beat of that bar as a text effect, escaped like the title', function(){
  const quotedMemo = '메모 "따옴표" \\ 역슬래시 · 둘째';
  const out = convert({ lines: ['[C] E4 r r r | ' + JSON.stringify(quotedMemo), '[G] E4 r r r', 'r r r r | "쉼 마디 메모"'] });
  const firsts = firstBeats(out.staff);
  assert.equal(firsts[0].text, quotedMemo);
  assert.equal(firsts[1].text, null, 'a bar without a memo has no text');
  assert.equal(firsts[2].text, '쉼 마디 메모', 'a whole-rest bar carries its memo too');
  // 같은 마디의 다른 박에는 글이 없다
  assert.equal(out.staff.bars[0].voices[0].beats[1].text, null);
  // 모든 내장곡의 마디 메모가 그 마디 첫 박의 글로 들어간다
  songs.forEach(function(song){
    const staff = convert({ title: song.title, beats: song.beats, bpm: song.bpm, lines: song.lines }).staff;
    const measures = parser.parseScore(song.lines.join('\n'), song.beats).measures;
    measures.forEach(function(measure, index){
      const want = measure.lyric ? measure.lyric : null;
      assert.equal(firstBeats(staff)[index].text, want, song.id + ' bar ' + (index + 1) + ' memo');
    });
  });
});

test('description: a non-empty description goes to the header notices, an empty one adds nothing', function(){
  const quoted = convert({ description: '설명 "q" \\ 끝', lines: ['E4 r r r'] });
  assert.equal(quoted.score.notices, '설명 "q" \\ 끝');
  assert.match(quoted.tex, /^\\title "T"\n\\notices "/);
  ['', '   ', undefined, null].forEach(function(description){
    const none = convert({ description: description, lines: ['E4 r r r'] });
    assert.doesNotMatch(none.tex, /\\notices/, JSON.stringify(description));
  });
});

test('apoyando and confirm marks are not written to alphaTex, and the result is only { tex }', function(){
  const out = converter.toAlphaTex({ title: 'T', beats: 4, bpm: 60, capo: 0, lines: ['!E4@1 B3@2+!G3@3 r !D4@2?', 'r r r r'] });
  assert.deepEqual(Object.keys(out), ['tex']);
  assert.doesNotMatch(out.tex, /apoyando|!|\?/);
  assert.equal(importTex(out.tex).diagnostics.length, 0);
  assert.deepEqual(Object.keys(converter.toAlphaTex({ title: 'T', beats: 4, bpm: 60, capo: 0, lines: ['E4 r r'] })), ['error']);
});

test('errors: layout errors come back as a message, never a thrown exception', function(){
  const bad = converter.toAlphaTex({ title: 'T', beats: 4, bpm: 60, capo: 0, lines: ['E4 r r'] });
  assert.equal(bad.tex, undefined);
  assert.equal(typeof bad.error, 'string');
  assert.ok(bad.error.length > 0);
  const unknown = converter.toAlphaTex({ title: 'T', beats: 4, bpm: 60, capo: 0, lines: ['X9 r r r'] });
  assert.equal(unknown.tex, undefined);
  assert.equal(typeof unknown.error, 'string');
  const noBeats = converter.toAlphaTex({ title: 'T', beats: 'x', bpm: 60, lines: ['E4 r r r'] });
  assert.match(noBeats.error, /니다\.$/);
  const noBpm = converter.toAlphaTex({ title: 'T', beats: 4, bpm: 0, lines: ['E4 r r r'] });
  assert.match(noBpm.error, /니다\.$/);
  const empty = converter.toAlphaTex(null);
  assert.equal(typeof empty.error, 'string');
});

process.stdout.write('1..' + checks + '\n');
