const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const parser = require('../src/parser.js');
const rhythm = require('../src/rhythm.js');

const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '../songs.json'), 'utf8'));
const songById = new Map(songs.map(song => [song.id, song]));
const melodyPracticeIds = [
  'builtin-lv1-butterfly', 'builtin-lv1-twinkle',
  'builtin-lv2-london', 'builtin-lv2-jinglebells', 'builtin-lv2-odetojoy',
  'builtin-lv3-clementine', 'builtin-lv3-brahms',
  'builtin-lv4-amazinggrace', 'builtin-lv4-greensleeves'
];

// 원본 MIDI에서 변환한 곡: 운지·줄 번호가 없는 선율/저음 전사라서 아래 앱 운지 제안 검사 대상이 아니다.
const convertedIds = [
  'builtin-mary-lamb', 'builtin-sor-op60-01', 'builtin-carulli-op241-01', 'builtin-carulli-op241-05',
  'builtin-giuliani-op50-01', 'builtin-carcassi-op60-03', 'builtin-carcassi-op60-07',
  'builtin-sor-op35-22', 'builtin-tarrega-adelita', 'builtin-greensleeves-bass'
];

assert.ok(songs.length > 0, 'catalog is not empty');
assert.equal(new Set(songs.map(song => song.id)).size, songs.length, 'built-in ids are unique');
assert.equal(songById.has('builtin-lv3-arirang'), false, 'Arirang is absent from the built-in catalog');
assert.equal(songById.has('builtin-lv1-schoolbell'), false, 'School Bell is absent from the built-in catalog (copyright)');
for (const song of songs){
  assert.ok(Number.isInteger(song.level) && song.level >= 1, `${song.id} has an integer level of at least 1`);
  assert.ok(!song.title.startsWith('[Lv'), `${song.id} title has no level prefix`);
  assert.ok(!/^Lv\.\d/.test(song.badge), `${song.id} badge has no level prefix`);
}
const usedLevels = Array.from(new Set(songs.map(song => song.level))).sort((a, b) => a - b);
assert.deepEqual(usedLevels, usedLevels.map((level, index) => index + 1), 'used levels run from 1 without gaps');

for (const song of songs){
  assert.ok(Array.isArray(song.lines) && song.lines.length > 0, `${song.id} has score lines`);
  for (const line of song.lines){
    const scoreText = line.split('|', 1)[0].replace(/^\s*\[[^\]]*\]\s*/, '');
    for (const beat of parser.tokenizeMeasureBeats(scoreText)) for (const part of beat.split('/')){
      if (/^[rR-]$/.test(part)) continue;
      for (const noteToken of part.split('+')){
        assert.doesNotMatch(noteToken, /\*(?:\d|\.)/, `${song.id} does not use the removed per-note length suffix: ${noteToken}`);
      }
    }
  }
  const parsed = parser.parseScore(song.lines, song.beats);
  assert.deepEqual(parsed.errors, [], `${song.id} parses without score errors`);
  if (!convertedIds.includes(song.id)) assert.match(song.badge, /앱 (운지|연습용) 제안/, `${song.id} labels the app's fingering as a proposal`);
  assert.doesNotMatch(`${song.title} ${song.badge}`, /원곡 그대로|원곡 완곡|원곡 완결|정통 스코어|완벽 구현|전곡/, `${song.id} does not overstate source fidelity`);
  if (convertedIds.includes(song.id)) continue;
  for (const line of song.lines){
    const scoreText = line.split('|', 1)[0].replace(/^\s*\[[^\]]*\]\s*/, '');
    for (const beat of parser.tokenizeMeasureBeats(scoreText)) for (const part of beat.split('/')){
      if (/^[rR-]$/.test(part)) continue;
      for (const noteToken of part.split('+')){
        assert.match(noteToken, /^[!~]?[0-4].+@[1-6]:[pima]$/, `${song.id} attack states articulation, LH, string, and RH: ${noteToken}`);
        const parsed = parser.parseNoteToken(noteToken, 0);
        assert.ok(parsed && parsed.pos && parsed.pos.lh != null, `${song.id} explicit note metadata parses: ${noteToken}`);
        assert.equal(parsed.pos.str, Number(noteToken.match(/@([1-6])/)[1]), `${song.id} string override matches parser placement: ${noteToken}`);
      }
    }
  }
}

for (const id of convertedIds){
  const song = songById.get(id);
  assert.ok(song, `converted score ${id} exists`);
  assert.ok(Number.isInteger(song.level) && song.level >= 1 && song.level <= 5, `${id} level is between 1 and 5`);
  const checked = parser.validateScore(song.lines.join('\n'), song.beats);
  assert.deepEqual(checked.errors, [], `${id} has no score errors`);
  assert.deepEqual(checked.warnings, [], `${id} has no score warnings`);
  for (const line of song.lines) assert.ok(!line.split('|', 1)[0].includes('?'), `${id} has no confirmation mark: ${line}`);
}
const catalogLevels = songs.map(song => song.level);
for (let index = 1; index < catalogLevels.length; index++){
  assert.ok(catalogLevels[index] >= catalogLevels[index - 1], `songs.json keeps level order at ${songs[index].id}`);
}

for (const id of melodyPracticeIds){
  const song = songById.get(id);
  assert.ok(song, `single-note practice score ${id} exists`);
  let expectedRh = 'i';
  for (const line of song.lines){
    const scoreText = line.split('|', 1)[0].replace(/^\s*\[[^\]]*\]\s*/, '');
    for (const beat of parser.tokenizeMeasureBeats(scoreText)){
      for (const part of beat.split('/')){
        if (/^[rR-]$/.test(part)) continue;
        for (const noteToken of part.split('+')){
          assert.match(noteToken, /^[0-4].+@[1-6]:[im]$/, `${id} attack has explicit LH, string, and alternating RH data: ${noteToken}`);
          const parsed = parser.parseNoteToken(noteToken, 0);
          assert.ok(parsed && parsed.pos, `${id} note token parses: ${noteToken}`);
          assert.equal(parsed.pos.lh, Number(noteToken[0]), `${id} LH value is explicit: ${noteToken}`);
          assert.equal(parsed.pos.str, Number(noteToken.match(/@([1-6])/)[1]), `${id} string override matches parser placement: ${noteToken}`);
          assert.equal(parsed.pos.rh, expectedRh, `${id} attack alternates right-hand fingers at ${noteToken}`);
          expectedRh = expectedRh === 'i' ? 'm' : 'i';
        }
      }
    }
  }
}

for (const id of ['builtin-lv3-clementine', 'builtin-lv3-brahms', 'builtin-lv4-amazinggrace', 'builtin-lv4-greensleeves']){
  const firstMeasure = songById.get(id).lines[0].split('|', 1)[0].replace(/^\s*\[[^\]]*\]\s*/, '');
  const firstAttackIndex = parser.tokenizeMeasureBeats(firstMeasure).findIndex(beat => !/^[rR-]$/.test(beat));
  assert.ok(firstAttackIndex > 0, `${id} fills the fixed-grid pickup with leading rests`);
}

const clementine = songById.get('builtin-lv3-clementine');
assert.equal(clementine.lines.length, 9, 'Clementine is the documented pickup and eight-bar theme excerpt');
const london = songById.get('builtin-lv2-london');
assert.equal(london.beats, 2, 'London Bridge uses the source 2/4 grid');
assert.equal(london.bpm, 34, 'London Bridge practice tempo preserves the earlier bar duration');
const lightly = songById.get('builtin-lv1-butterfly');
assert.match(lightly.lines[7], /0E4@1:[im] - r r \| "미 2박 유지 후 2박 쉼"$/, 'Lightly Row m8 sustains E4 for two slots and rests for two');
assert.match(lightly.lines[15], /1C4@2:[im] - r r \| "도 2박 유지 후 2박 쉼"$/, 'Lightly Row m16 sustains C4 for two slots and rests for two');
const jingle = songById.get('builtin-lv2-jinglebells');
assert.match(jingle.lines[4], /1C4@2:[im] 1C4@2:[im] 1C4@2:[im] -\/1C4@2:[im]/, 'Jingle Bells m5 adds the source dot rhythm and reattack');
assert.match(jingle.lines[5], /1C4@2:[im] 0B3@2:[im] 0B3@2:[im]\/0B3@2:[im] 0B3@2:[im]/, 'Jingle Bells m6 has two written B3 reattacks');
assert.equal(jingle.lines[4].split('|',1)[0].replace(/^\s*\[[^\]]*\]\s*/,'').replace(/:[pima]/g,''), jingle.lines[12].split('|',1)[0].replace(/^\s*\[[^\]]*\]\s*/,'').replace(/:[pima]/g,''), 'Jingle Bells m13 repeats the corrected m5 rhythm');
assert.equal(jingle.lines[5].split('|',1)[0].replace(/^\s*\[[^\]]*\]\s*/,'').replace(/:[pima]/g,''), jingle.lines[13].split('|',1)[0].replace(/^\s*\[[^\]]*\]\s*/,'').replace(/:[pima]/g,''), 'Jingle Bells m14 repeats the corrected m6 rhythm');
assert.match(songById.get('builtin-lv2-odetojoy').lines[13], /1F4@1:[im]\/3D4@2:[im]/, 'Ode to Joy m14 ends with the verified F4 passing tone');

const lv5 = songById.get('builtin-lv5-romance');
const lv6 = songById.get('builtin-lv6-romance-full');
for (const song of [lv5, lv6]){
  assert.equal(song.beats, 3, `${song.id} expresses the same meter as three quarter-note slots`);
  assert.equal(song.bpm, 56, `${song.id} retains the same bar duration in three slots`);
  assert.equal(song.lines.length, 16, `${song.id} contains the documented minor sixteen-bar excerpt`);
}
assert.match(lv5.lines[14], /~2E3@4:p\+!0E4@1:a ~2B2@5:p\+!0E4@1:a ~3G2@6:p\+!0E4@1:a/, 'Lv.5 final three slots pair each bass with a melody note');
assert.match(lv5.lines[15], /- r \| "두 음 동시 탄현 · 2박 유지 후 쉼"$/, 'Lv.5 ending sustains the two-note sonority before its rest');
assert.match(lv6.lines[6], /~1E4@2:m\/~1C4@3:i/, 'Lv.6 Am inner voice uses the specified fifth-position strings');
assert.match(lv6.lines[8], /~1F#4@2:m\/~3D#4@3:i/, 'Lv.6 B7 inner voice has the specified bar and string placement');
assert.match(lv6.lines[9], /!4D#5@1:a/, 'Lv.6 D#5 uses string one fret eleven');
assert.match(lv6.lines[13], /~1D#3@4:p/, 'Lv.6 m14 uses the specified D-sharp bass');
assert.match(lv6.lines[14], /~2E3@4:p\+!0E4@1:a\/~0B3@2:m\/~0G3@3:i ~2B2@5:p\+!0E4@1:a\/~0B3@2:m\/~0G3@3:i ~3G2@6:p\+!0E4@1:a/, 'Lv.6 m15 changes bass to E3, B2, and G2 with the existing melody and inner subdivision');
assert.match(lv6.lines[15], /~0E2@6:p\+!0E4@1:a - r/, 'Lv.6 m16 has no arpeggio, then holds two slots and rests');
const parsedLv6 = parser.parseScore(lv6.lines, lv6.beats);
for (let measureIndex = 0; measureIndex < 15; measureIndex++){
  const measure = parsedLv6.measures[measureIndex];
  assert.equal(measure.beats.length, 3, `Lv.6 m${measureIndex + 1} has three beats`);
  for (const beat of measure.beats) assert.equal(beat.subNotes.length, 3, `Lv.6 m${measureIndex + 1} subdivides each beat into three equal attacks`);
}
const lv5Parsed = parser.parseScore(lv5.lines, lv5.beats);
const lv5Rhythm = rhythm.annotate(lv5Parsed.measures, lv5.beats);
const lv6Rhythm = rhythm.annotate(parsedLv6.measures, lv6.beats);
for (let measureIndex = 0; measureIndex < 14; measureIndex++){
  for (const [song, parsed] of [[lv5, lv5Parsed],[lv6, parsedLv6]]){
    const measure = parsed.measures[measureIndex];
    for (const beat of measure.beats){
      for (const part of beat.subNotes || [beat]){
        if (part.kind !== 'note') continue;
        assert.equal(part.durationUnits, part.slotUnits, `${song.id} m${measureIndex + 1} uses the ordinary part duration`);
        for (const note of part.chordNotes || []){
          assert.equal(note.durationUnits, undefined, `${song.id} m${measureIndex + 1} does not carry component-specific duration data`);
        }
      }
    }
  }
}
for (const beat of parsedLv6.measures[14].beats){
  for (const part of beat.subNotes || [beat]){
    if (part.kind !== 'note') continue;
    assert.equal(part.durationUnits, part.slotUnits, `Lv.6 m15 uses the ordinary subdivision duration`);
    for (const note of part.chordNotes || []) assert.equal(note.durationUnits, undefined, `Lv.6 m15 ${note.en} does not carry component-specific duration data`);
  }
}
assert.ok(lv5Rhythm.events.length && lv6Rhythm.events.length, 'Romance duration checks run through parser-to-rhythm annotation');
for (const [song, parsed] of [[lv5, lv5Parsed], [lv6, parsedLv6]]){
  for (let measureIndex = 0; measureIndex < parsed.measures.length; measureIndex++){
    const measure = parsed.measures[measureIndex];
    for (let beatIndex = 0; beatIndex < measure.beats.length; beatIndex++){
      const beat = measure.beats[beatIndex];
      const parts = beat.subNotes || [beat];
      for (let partIndex = 0; partIndex < parts.length; partIndex++){
        const part = parts[partIndex];
        if (part.kind === 'rest' || part.kind === 'hold') continue;
        for (const note of part.chordNotes || [part]){
          const expected = note.rh === 'a' ? 'apoyando' : 'tirando';
          assert.equal(note.articulation, expected, `${song.id} m${measureIndex + 1} beat ${beatIndex + 1} part ${partIndex + 1} ${note.en} RH ${note.rh} has explicit ${expected}`);
          assert.equal(note.explicitArticulation, true, `${song.id} m${measureIndex + 1} beat ${beatIndex + 1} part ${partIndex + 1} ${note.en} explicitly states its articulation`);
        }
      }
    }
  }
}
function melodyMidiForBar(song, parsed, barIndex){
  return parsed.measures[barIndex].beats.map(beat => {
    const part=beat.subNotes ? beat.subNotes[0] : beat;
    return part.midi;
  });
}
for (const [song, parsed] of [[lv5,lv5Parsed],[lv6,parsedLv6]]){
  assert.deepEqual(melodyMidiForBar(song,parsed,7), [69,71,72], `${song.id} m8 melody follows A4-B4-C5`);
  assert.deepEqual(melodyMidiForBar(song,parsed,9), [75,72,71], `${song.id} m10 melody follows D-sharp5-C5-B4`);
  const m15Bass=parsed.measures[14].beats.map(beat=>{
    const part=beat.subNotes ? beat.subNotes[0] : beat;
    return part.chordNotes.find(note=>note.str>=4).midi;
  });
  assert.deepEqual(m15Bass,[52,47,43],`${song.id} m15 bass descends E3-B2-G2`);
  const m9Bass=parsed.measures[8].beats[0].subNotes ? parsed.measures[8].beats[0].subNotes[0] : parsed.measures[8].beats[0];
  const lowB=m9Bass.chordNotes.find(note=>note.str===6);
  assert.deepEqual([lowB.midi,lowB.str,lowB.fret],[47,6,7],`${song.id} m9 B2 is on string six fret seven`);
}

const guideContext = { GuitarRhythm:rhythm };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/guide.js'), 'utf8'), guideContext);
for (const [song, maxMeasure, bassBeats] of [[lv5,14,1],[lv6,14,1]]){
  for (let i=0;i<maxMeasure;i++){
    const tokens=song.lines[i].split('|',1)[0].replace(/^\s*\[[^\]]*\]\s*/,'').trim().split(/\s+/);
    assert.equal(tokens.filter(token => token.includes('+')).length, bassBeats, `${song.id} m${i+1} strikes bass with the melody on its first beat only`);
  }
  assert.equal(song.lines[14].split('|',1)[0].replace(/^\s*\[[^\]]*\]\s*/,'').trim().split(/\s+/).filter(token => token.includes('+')).length, 3, `${song.id} m15 changes bass at each of its three beats`);
}
const fixtureSlotDuration = 0.6;
const firstMeasureEvents = parsedLv6.measures[0].beats.flatMap(beat => guideContext.getBeatGuideEvents(beat, { slotDuration:fixtureSlotDuration }));
assert.deepEqual(Array.from(firstMeasureEvents, event => event.gain), [0.62,1.16,0.62,0.62,1.16,0.62,0.62,1.16,0.62,0.62], 'Lv.6 m1 guide events contain one bass, three melodies, and six inner notes with independent articulation gains');
for (const beat of parsedLv6.measures[0].beats){
  const events = guideContext.getBeatGuideEvents(beat, { slotDuration:fixtureSlotDuration });
  for (const part of beat.subNotes || [beat]){
    if (part.kind !== 'note') continue;
    const expectedDuration = part.durationUnits / rhythm.UNITS_PER_SLOT * fixtureSlotDuration;
    for (const note of part.chordNotes || [part]){
      const event = events.find(candidate => candidate.note === note);
      assert.ok(event, `Lv.6 m1 ${note.en} guide event exists`);
      assert.ok(Math.abs(event.duration - expectedDuration) < 1e-9, `Lv.6 m1 ${note.en} guide duration follows its source part duration`);
    }
  }
}

const brahms = songById.get('builtin-lv3-brahms');
assert.match(brahms.lines[15], /1F4@1:[im]\/3G4@1:[im]\/1F4@1:[im]\/-/, 'Brahms four-part subdivision retains its final hold');
const parsedBrahms=parser.parseScore(brahms.lines,brahms.beats);
const brahmsRhythm=rhythm.annotate(parsedBrahms.measures,brahms.beats);
const g4Attack=brahmsRhythm.events.find(event=>event.measureIndex===1&&event.part.midi===67);
assert.equal(g4Attack.durationUnits,18,'Brahms dotted-quarter G4 sustains for one and a half slots');
const brahmsLast=brahmsRhythm.events.filter(event=>event.measureIndex===15);
const brahmsLastStart=15*brahms.beats*12;
assert.deepEqual(brahmsLast.slice(0,3).map(event=>[event.part.midi,event.startUnits-brahmsLastStart,event.durationUnits]),[[65,0,3],[67,3,3],[65,6,6]],'Brahms final four-part beat attacks F4/G4/F4 at quarter-slot offsets 0, 1/4, and 1/2, then holds F4');
const brahmsFinalHold=parsedBrahms.measures[15].beats[0].subNotes[3];
assert.equal(brahmsFinalHold.startUnits-brahmsLastStart,9,'Brahms final subdivision holds at the final quarter-slot offset');
assert.equal(brahmsFinalHold.durationUnits,3,'Brahms final F4 remains held through the last subdivision');

const greensleeves=songById.get('builtin-lv4-greensleeves');
const parsedGreensleeves=parser.parseScore(greensleeves.lines,greensleeves.beats);
const greenRhythm=rhythm.annotate(parsedGreensleeves.measures,greensleeves.beats);
const greenM3=greenRhythm.events.filter(event=>event.measureIndex===3);
assert.ok(greenM3.some(event=>event.part.midi===55),'Greensleeves body m3 uses G natural');
assert.equal(greenM3.some(event=>event.part.midi===56),false,'Greensleeves body m3 does not replace G natural with G-sharp');
const greenM7=greenRhythm.events.filter(event=>event.measureIndex===7);
assert.ok(greenM7.some(event=>event.part.midi===56&&event.startUnits-7*greensleeves.beats*12===36),'Greensleeves body m7 G-sharp lands at the written slot');
assert.ok(greenM7.some(event=>event.part.midi===54&&event.startUnits-7*greensleeves.beats*12===54),'Greensleeves body m7 F-sharp lands in the written subdivision');

const grace=songById.get('builtin-lv4-amazinggrace');
const parsedGrace=parser.parseScore(grace.lines,grace.beats);
const graceRhythm=rhythm.annotate(parsedGrace.measures,grace.beats);
const graceM1=graceRhythm.events.filter(event=>event.measureIndex===1&&event.startUnits>=60);
assert.deepEqual(graceM1.map(event=>[event.part.midi,event.startUnits,event.part.slotUnits]),[[59,60,4],[57,64,4],[55,68,4]],'Amazing Grace pickup subdivision starts at absolute units 60, 64, and 68');
const graceCarry=parsedGrace.measures[8].beats.slice(0,2);
assert.deepEqual(graceCarry.map(hold=>hold.tieFrom),[{measureIndex:7,beatIndex:0,subIndex:null},{measureIndex:7,beatIndex:0,subIndex:null}],'Amazing Grace first two slots in body m8 continue the prior D4');
assert.equal(rhythm.resolveHold(parsedGrace.measures,graceCarry[0]).midi,62,'Amazing Grace carry resolves to D4');
assert.deepEqual(parsedGrace.measures[16].beats.map(beat=>beat.kind),['hold','hold','rest'],'Amazing Grace final measure holds twice then rests');

const canon = songById.get('builtin-lv4-canon');
assert.equal(canon.title, '캐논 화성 연습 (C장조 · 17마디 앱 편곡)');
assert.equal(canon.badge, '4/4의 8분음표 칸 · 운지·주법은 앱 연습용 제안');
assert.match(canon.lines.at(-1), /^\[C\] 3C3@5:p\+2E3@4:i\+0G3@3:m\+1C4@2:a - - - - - - - \| "C코드 동시 탄현 · p\/i\/m\/a, 전체 4박 유지"$/);
for (const [index, line] of canon.lines.entries()){
  const memo = line.split('|')[1] || '';
  assert.doesNotMatch(memo, /엄지|파\(엄지\)/, `Canon m${index + 1} memo does not call the F2 bass a thumb fingering`);
}

process.stdout.write(`Result: built-in score contracts passed (${songs.length} scores, ${melodyPracticeIds.length} single-note practice scores)\n`);
