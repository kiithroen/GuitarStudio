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
  { midi:40, str:6 }, { midi:55, str:3, articulation:'tirando' }, { midi:60, str:2, articulation:'apoyando' }
] });
const chordEvents = context.getBeatGuideEvents(chord, { startTime:4, slotDuration:0.6 });
assert.equal(chordEvents.length, 3, 'full chord emits every component');
assert.deepEqual(Array.from(chordEvents, event => event.when), [4, 4, 4], 'chord components share an onset');
assert.deepEqual(Array.from(chordEvents, event => event.duration), [0.6, 0.6, 0.6], 'chord components share written duration');
assert.deepEqual(Array.from(chordEvents, event => event.str), [6, 3, 2], 'chord component strings are preserved');
assert.deepEqual(Array.from(chordEvents, event => event.gain), [1.0, 0.62, 1.16], 'explicit articulation gain follows each chord component');

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

calls.length = 0;
context.scheduleBeatGuide(restBeat, { startTime:5, slotDuration:0.9, capo:2 });
assert.deepEqual(calls.map(call => call[0]), ['note', 'stop', 'note'], 'rest cuts current sound and later note is scheduled afterward');
assert.equal(calls[0][1], 62, 'capo is applied once at scheduling');
assert.equal(calls[0][6], 2, 'physical string is preserved');
assert.equal(calls[0][7].exactDuration, true, 'exact duration option is passed through');

calls.length = 0;
context.scheduleSubdividedGuide(restBeat, { startTime:1, subStep:0.1, capo:0 });
assert.deepEqual(calls.map(call => call[0]), ['note', 'stop', 'note'], 'legacy subdivided scheduler delegates rest cutoff');
assert.ok(calls.filter(call => call[0] === 'note').every(call => call[7] && call[7].exactDuration), 'legacy wrapper uses exact note duration');
assert.equal(calls[2][3], 1.2, 'legacy wrapper uses the shared event onset');
assert.equal(context.getSubdividedGuideEvents(restBeat, { startTime:1, subStep:0.1 }).length, 2, 'legacy event accessor remains notes-only');
const legacySplit = { subNotes:restBeat.subNotes };
assert.equal(context.getSubdividedGuideEvents(legacySplit, { startTime:1, subStep:0.1 }).length, 2, 'legacy wrapper accepts the former minimal subNotes shape');

const parsedSplit = parser.parseScore('[C] -/0E2+0G3+1C4/0D3+0A3+1F4 - -', 4).measures[0].beats[0];
const parsedChordEvents = context.getBeatGuideEvents(parsedSplit, { startTime:10, slotDuration:0.6 });
assert.deepEqual(Array.from(parsedChordEvents, event => event.note.midi), [40, 55, 60, 50, 57, 65], 'parser chord components are all emitted');
assert.deepEqual(Array.from(parsedChordEvents, event => event.when), [10.2, 10.2, 10.2, 10.4, 10.4, 10.4], 'parsed chords stay simultaneous at each subdivided onset');
assert.deepEqual(Array.from(parsedChordEvents, event => Math.round(event.duration * 100) / 100), [0.2, 0.2, 0.2, 1.4, 1.4, 1.4], 'parsed chord components share each written tie-chain duration');

const explicitApo = parser.parseScore('!C4/D4 r r r', 4).measures[0].beats[0];
const explicitTir = parser.parseScore('~C4/D4 r r r', 4).measures[0].beats[0];
assert.deepEqual(Array.from(context.getBeatGuideEvents(explicitApo, { startTime:0, slotDuration:0.8 }), event => [event.articulation, event.gain]), [
  ['apoyando', 1.16], [null, 1.0]
], 'parsed explicit apoyando applies only to its written subdivision');
assert.deepEqual(Array.from(context.getBeatGuideEvents(explicitTir, { startTime:0, slotDuration:0.8 }), event => [event.articulation, event.gain]), [
  ['tirando', 0.62], [null, 1.0]
], 'parsed explicit tirando applies only to its written subdivision');

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

process.stdout.write('Result: guide events passed (parsed and synthetic subdivision timing, simultaneous chords, articulation gain, rests, cross-bar holds, resume, loop clipping, capo, and legacy wrapper)\n');
