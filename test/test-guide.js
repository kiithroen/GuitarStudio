const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rhythm = require('../src/rhythm.js');
const parser = require('../src/parser.js');

const calls = [];
const context = {
  GuitarRhythm: rhythm,
  soundingMidi: (midi, capo) => Number(midi) + Number(capo || 0),
  playGuitarNote: (...args) => calls.push(['note', ...args]),
  stopGuitarNotes: when => calls.push(['stop', when])
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/guide.js'), 'utf8'), context);

function part(tok, midi, str, fields){
  return Object.assign({ tok, midi, str, kind:midi == null ? (tok === '-' ? 'hold' : 'rest') : 'note',
    slotUnits:12, durationUnits:12, tieFrom:null }, fields || {});
}

const chord = part('0E2+0G3+1C4', 60, 2, { chordNotes:[
  { midi:40, str:6 }, { midi:55, str:3 }, { midi:60, str:2, articulation:'apoyando' }
] });
const chordEvents = context.getBeatGuideEvents(chord, { startTime:4, slotDuration:0.6 });
assert.equal(chordEvents.length, 3, 'full chord emits every component');
assert.deepEqual(Array.from(chordEvents, event => event.when), [4, 4, 4], 'chord components share an onset');
assert.deepEqual(Array.from(chordEvents, event => event.duration), [0.6, 0.6, 0.6], 'chord components share written duration');
assert.deepEqual(Array.from(chordEvents, event => event.str), [6, 3, 2], 'chord component strings are preserved');
assert.deepEqual(Array.from(chordEvents, event => event.gain), [1.0, 1.0, 1.16], 'explicit articulation gain follows each chord component');

const syntheticChordFallback = part('C3+E4', 64, 1, { articulation:'apoyando', chordNotes:[
  { midi:48, str:5 }, { midi:64, str:1 }
] });
assert.deepEqual(Array.from(context.getBeatGuideEvents(syntheticChordFallback, { startTime:1, slotDuration:0.5 }), event => [event.articulation, event.gain]),
  [[null, 1.0], [null, 1.0]], 'chord components do not inherit articulation from their note source');

for (const count of [2, 3, 4]){
  const notes = Array.from({ length:count }, (_, index) => part('C4', 60 + index, index + 1, {
    slotUnits:12 / count, durationUnits:12 / count
  }));
  const beat = { isSubdivided:true, subNotes:notes };
  const events = context.getBeatGuideEvents(beat, { startTime:2, slotDuration:0.8 });
  assert.deepEqual(Array.from(events, event => event.when), notes.map((_, index) => 2 + index * 0.8 / count), count + ' equal subdivisions use exact onsets');
  assert.deepEqual(Array.from(events, event => event.duration), notes.map(() => 0.8 / count), count + ' equal subdivisions use exact durations');
}

const restBeat = { isSubdivided:true, subNotes:[
  part('C4', 60, 2, { slotUnits:4, durationUnits:4 }),
  part('r', null, null, { slotUnits:4, durationUnits:4 }),
  part('D4', 62, 1, { slotUnits:4, durationUnits:4 })
] };
const restEvents = context.getBeatGuideEvents(restBeat, { startTime:5, slotDuration:0.9, maxDurationSlots:0.8333333333333333 });
assert.deepEqual(Array.from(restEvents, event => event.kind), ['note', 'rest', 'note'], 'rest event remains between surrounding notes');
assert.deepEqual(Array.from(restEvents, event => event.when), [5, 5.3, 5.6], 'note and rest events remain chronological');
assert.ok(Math.abs(restEvents[0].duration - 0.3) < 1e-9 && Math.abs(restEvents[1].duration - 0.3) < 1e-9
  && Math.abs(restEvents[2].duration - 0.15) < 1e-9, 'loop edge clips a later subdivision using its onset offset');

const source = part('C4', 60, 2, { durationUnits:36 });
const measures = [{ beats:[source] }, { beats:[part('-', null, null, {
  kind:'hold', durationUnits:24, tieFrom:{ measureIndex:0, beatIndex:0, subIndex:null }
})] }];
const held = measures[1].beats[0];
assert.equal(context.getBeatGuideEvents(held, { startTime:8, slotDuration:0.5, measures }).length, 0, 'ordinary internal hold never retriggers');
const resumed = context.getBeatGuideEvents(held, { startTime:8, slotDuration:0.5, measures, resumeHold:true, maxDurationSlots:1.5 });
assert.equal(resumed.length, 1, 'resume plays the source note once');
assert.equal(resumed[0].note, source, 'resume uses the actual tie source');
assert.equal(resumed[0].when, 8, 'resume starts at the hold position');
assert.equal(resumed[0].duration, 0.75, 'resume duration clips at loop boundary');
const resumedWithoutClip = context.getBeatGuideEvents(held, { startTime:8, slotDuration:0.5, measures, resumeHold:true });
assert.equal(resumedWithoutClip[0].duration,1,'synthetic fallback uses the current hold part remaining length');

calls.length = 0;
context.scheduleBeatGuide(restBeat, { startTime:5, slotDuration:0.9, capo:2, maxDurationSlots:0.8333333333333333 });
assert.deepEqual(calls.map(call => call[0]), ['note', 'stop', 'note'], 'rest cuts current sound and later note is scheduled afterward');
assert.equal(calls[0][1], 62, 'capo is applied once at scheduling');
assert.equal(calls[0][6], 2, 'physical string is preserved');
assert.equal(calls[0][7].naturalDecay, true, 'guide enables natural decay');
assert.equal(calls[0][7].exactDuration, undefined, 'guide does not turn the nominal score length into note-off');
assert.ok(Math.abs(calls[0][7].hardStopAt - 5.75) < 1e-9, 'loop boundary is passed as the absolute per-voice hard stop');
assert.ok(Math.abs(calls[2][7].hardStopAt - 5.75) < 1e-9, 'all scheduled notes share the same loop boundary');

calls.length = 0;
context.scheduleSubdividedGuide(restBeat, { startTime:1, subStep:0.1, capo:0 });
assert.deepEqual(calls.map(call => call[0]), ['note', 'stop', 'note'], 'legacy subdivided scheduler delegates rest cutoff');
assert.ok(calls.filter(call => call[0] === 'note').every(call => call[7] && call[7].naturalDecay && !call[7].exactDuration), 'subdivided guide uses natural decay while retaining nominal event durations');
assert.equal(calls[2][3], 1.2, 'legacy wrapper uses the shared event onset');
assert.equal(context.getSubdividedGuideEvents(restBeat, { startTime:1, subStep:0.1 }).length, 2, 'legacy event accessor remains notes-only');
const legacySplit = { subNotes:restBeat.subNotes };
assert.equal(context.getSubdividedGuideEvents(legacySplit, { startTime:1, subStep:0.1 }).length, 2, 'legacy wrapper accepts the former minimal subNotes shape');

const parsedSplit = parser.parseScore('[C] -/0E2+0G3+1C4/0D3+0A3+1F4 - -', 4).measures[0].beats[0];
const parsedChordEvents = context.getBeatGuideEvents(parsedSplit, { startTime:10, slotDuration:0.6 });
assert.deepEqual(Array.from(parsedChordEvents, event => event.note.midi), [40, 55, 60, 50, 57, 65], 'parser chord components are all emitted');
assert.deepEqual(Array.from(parsedChordEvents, event => event.when), [10.2, 10.2, 10.2, 10.4, 10.4, 10.4], 'parsed chords stay simultaneous at each subdivided onset');
assert.deepEqual(Array.from(parsedChordEvents, event => Math.round(event.duration * 100) / 100), [0.2, 0.2, 0.2, 1.4, 1.4, 1.4], 'parsed chord components share each written tie-chain duration');

const parsedMixedChord = parser.parseScore('[C] 0E2@6:p+!4B4@1:a r r r', 4).measures[0].beats[0];
const parsedMixedChordEvents = context.getBeatGuideEvents(parsedMixedChord, { startTime:7, slotDuration:0.4 });
assert.deepEqual(Array.from(parsedMixedChordEvents, event => [event.note.midi, event.articulation, event.gain, event.when, event.duration, event.str]), [
  [40, null, 1.0, 7, 0.4, 6], [71, 'apoyando', 1.16, 7, 0.4, 1]
], 'parsed mixed chord uses component articulations and keeps simultaneous timing and strings');

const durationScore = parser.parseScore('[C] 0E2@6:p+!4B4@1:a - - r', 4);
const durationBeat = durationScore.measures[0].beats[0];
const durationEvents = context.getBeatGuideEvents(durationBeat, { startTime:0, slotDuration:0.5 });
assert.deepEqual(Array.from(durationEvents, event => [event.note.midi,event.duration,event.articulation]), [
  [40,1.5,null], [71,1.5,'apoyando']
], 'annotated chord components use their shared note-or-hold part duration');
const resumedBeat = durationScore.measures[0].beats[1];
const resumedMiddle = context.getBeatGuideEvents(resumedBeat, {
  startTime:0.5, slotDuration:0.5, measures:durationScore.measures, resumeHold:true
});
assert.deepEqual(Array.from(resumedMiddle, event => [event.note.midi,event.when,event.duration]), [
  [40,0.5,1.0], [71,0.5,1.0]
], 'middle resume restores the entire held chord with one common remaining length');
const clippedResume = context.getBeatGuideEvents(resumedBeat, {
  startTime:0.5, slotDuration:0.5, measures:durationScore.measures, resumeHold:true, maxDurationSlots:0.5
});
assert.ok(clippedResume.every(event => event.duration === 0.25),'resume duration respects loop clipping');
const restResume = context.getBeatGuideEvents(durationScore.measures[0].beats[3], {
  startTime:1.5, slotDuration:0.5, measures:durationScore.measures, resumeHold:true
});
assert.deepEqual(Array.from(restResume, event => event.kind),['rest'],'a rest start does not duplicate previously sounding notes');

const parsedMelodyArtChord = parser.parseScore('[C] C3+!E4 r r r', 4).measures[0].beats[0];
assert.deepEqual(Array.from(context.getBeatGuideEvents(parsedMelodyArtChord, { startTime:2, slotDuration:0.5 }), event => [event.articulation, event.gain]), [
  [null, 1.0], ['apoyando', 1.16]
], 'melody articulation is not used as a fallback for an unmarked bass component');

const explicitApo = parser.parseScore('!C4/D4 r r r', 4).measures[0].beats[0];
const unmarkedSplit = parser.parseScore('C4/D4 r r r', 4).measures[0].beats[0];
assert.deepEqual(Array.from(context.getBeatGuideEvents(explicitApo, { startTime:0, slotDuration:0.8 }), event => [event.articulation, event.gain]), [
  ['apoyando', 1.16], [null, 1.0]
], 'parsed explicit apoyando applies only to its written subdivision');
assert.deepEqual(Array.from(context.getBeatGuideEvents(unmarkedSplit, { startTime:0, slotDuration:0.8 }), event => [event.articulation, event.gain]), [
  [null, 1.0], [null, 1.0]
], 'unmarked notes (tirando) all use the plain gain');

const plainForHand = parser.parseScore('E4 - - -',4).measures[0].beats[0];
const markedForHand = parser.parseScore('E4:a - - -',4).measures[0].beats[0];
const plainEvent = context.getBeatGuideEvents(plainForHand,{startTime:3,slotDuration:0.7})[0];
const markedEvent = context.getBeatGuideEvents(markedForHand,{startTime:3,slotDuration:0.7})[0];
assert.deepEqual([markedEvent.when,markedEvent.duration,markedEvent.note.midi,markedEvent.str,markedEvent.gain,markedEvent.articulation],
  [plainEvent.when,plainEvent.duration,plainEvent.note.midi,plainEvent.str,plainEvent.gain,plainEvent.articulation],
  'right-hand metadata does not change guide timing, pitch, string, gain, or articulation');

const parsedRestMeasures = parser.parseScore('[C] C4 r D4 E4 // - - - -', 4).measures;
const parsedRestEvents = context.getBeatGuideEvents(parsedRestMeasures[0].beats[0], {
  startTime:2, slotDuration:0.5, measures:parsedRestMeasures, capo:3
});
assert.equal(parsedRestEvents[0].duration, 0.5, 'parsed note uses its written slot duration');
calls.length = 0;
parsedRestMeasures[0].beats.forEach((beat, index) => context.scheduleBeatGuide(beat, {
  startTime:2 + index * 0.5, slotDuration:0.5, measures:parsedRestMeasures, capo:3
}));
assert.deepEqual(calls.map(call => call[0]), ['note', 'stop', 'note', 'note'], 'parsed rest cuts prior sound before later notes are scheduled');
assert.deepEqual(calls.filter(call => call[0] === 'note').map(call => call[1]), [63, 65, 67], 'parsed notes receive capo exactly once');

const parsedCrossBar = parser.parseScore('[C] C4 - - - // - - - -', 4).measures;
const crossBarHold = parsedCrossBar[1].beats[0];
assert.equal(rhythm.resolveHold(parsedCrossBar, crossBarHold), parsedCrossBar[0].beats[0], 'cross-bar hold resolves to the original parser note');
assert.equal(context.getBeatGuideEvents(crossBarHold, { startTime:4, slotDuration:0.5, measures:parsedCrossBar }).length, 0, 'parsed internal cross-bar hold does not retrigger');
const crossBarResume = context.getBeatGuideEvents(crossBarHold, {
  startTime:4, slotDuration:0.5, measures:parsedCrossBar, resumeHold:true
});
assert.equal(crossBarResume.length, 1, 'parsed start-inside-hold resumes once');
assert.equal(crossBarResume[0].note, parsedCrossBar[0].beats[0], 'parsed resume keeps the source note');
assert.equal(crossBarResume[0].duration, 2, 'parsed resume uses only the remaining cross-bar hold duration');

{
  const HARMONICS = require('../src/notation.js').NATURAL_HARMONICS;
  const handFret = Number(Object.keys(HARMONICS)[0]);
  const string = parser.STRINGS[0];
  const soundMidi = string.midi + HARMONICS[handFret];
  const soundName = parser.noteNameForMidi(soundMidi, false);
  const bassName = parser.noteNameForMidi(parser.STRINGS[5].midi, false);
  const harmonicScore = parser.parseScore('[-] h' + soundName + '@1 ' + bassName + '@6+h' + soundName + '@1 h' + soundName + '@1/r r', 4);
  assert.deepEqual(harmonicScore.errors, []);
  const harmonicMeasures = harmonicScore.measures;
  const single = context.getBeatGuideEvents(harmonicMeasures[0].beats[0], { startTime:0, slotDuration:0.5, measures:harmonicMeasures });
  assert.deepEqual(Array.from(single, event => [event.note.midi, event.str, event.articulation, event.gain]), [[soundMidi, 1, 'harmonic', 1.0]],
    'a harmonic plays the sounding pitch on its string, with unchanged gain');
  const withChord = context.getBeatGuideEvents(harmonicMeasures[0].beats[1], { startTime:0, slotDuration:0.5, measures:harmonicMeasures });
  assert.deepEqual(Array.from(withChord, event => event.note.midi), [parser.STRINGS[5].midi, soundMidi], 'a harmonic chord component keeps the sounding pitch');
  const split = context.getBeatGuideEvents(harmonicMeasures[0].beats[2], { startTime:0, slotDuration:0.5, measures:harmonicMeasures });
  assert.deepEqual(Array.from(split.filter(event => event.kind === 'note'), event => event.note.midi), [soundMidi], 'a harmonic in a subdivision plays the sounding pitch');
  calls.length = 0;
  context.scheduleBeatGuide(harmonicMeasures[0].beats[0], { startTime:1, slotDuration:0.5, measures:harmonicMeasures, capo:2 });
  assert.deepEqual(calls.filter(call => call[0] === 'note').map(call => [call[1], call[5], call[6]]), [[soundMidi + 2, 'harmonic', 1]],
    'scheduling hands the capo-shifted sounding pitch and the string to playGuitarNote');
}

{
  // 슬러(해머링·풀링) 음은 오른손으로 다시 치지 않아 gain만 작고, 음높이·줄·길이는 보통 음과 같다
  assert.ok(context.SLUR_GAIN > 0 && context.SLUR_GAIN < 1, 'the slur gain is a quieter positive value');
  const slurScore = parser.parseScore('[-] E4 sF4 - E4@1/sF4@1 | ""\n[-] E2@6+E4@1 E2@6+sF4@1 - -', 4);
  assert.deepEqual(slurScore.errors, []);
  const slurMeasures = slurScore.measures;
  const eventsFor = (m, b) => Array.from(context.getBeatGuideEvents(slurMeasures[m].beats[b], { startTime:0, slotDuration:0.5, measures:slurMeasures }).filter(event => event.kind === 'note'));
  const plainNote = eventsFor(0, 0)[0];
  const slurNote = eventsFor(0, 1)[0];
  assert.equal(slurNote.articulation, 'slur');
  assert.equal(slurNote.gain, context.SLUR_GAIN);
  assert.ok(slurNote.gain < plainNote.gain, 'a slurred note is quieter than a plain note');
  assert.equal(slurNote.note.midi, parser.parseNoteToken('F4', 0).midi, 'the pitch is unchanged');
  assert.equal(slurNote.str, 1);
  assert.equal(slurNote.duration, 1, 'the written duration includes the hold');
  const slurSplit = eventsFor(0, 3);
  assert.deepEqual(slurSplit.map(event => event.gain), [1.0, context.SLUR_GAIN], 'a slur in a subdivision is quieter, its plain neighbor is not');
  const slurChord = eventsFor(1, 1);
  assert.deepEqual(slurChord.map(event => [event.note.midi, event.gain]), [[parser.STRINGS[5].midi, 1.0], [parser.parseNoteToken('F4', 0).midi, context.SLUR_GAIN]],
    'in a chord only the slurred component is quieter');
}

process.stdout.write('Result: guide events passed (parsed and synthetic subdivision timing, simultaneous chords, articulation gain, rests, cross-bar holds, resume, loop clipping, capo, and legacy wrapper)\n');
