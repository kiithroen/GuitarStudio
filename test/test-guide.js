const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseScore } = require('../src/parser.js');

let autoBass = false;
const emitted = [];
const context = {
  soundingMidi: (midi, capo) => Number(midi) + Number(capo || 0),
  playGuitarNote: (...args) => emitted.push(args),
  resolveEffectiveBass: (chordName, beat, beatIndex) => {
    if (!autoBass) return null;
    if (beat && beat.bass && beat.bass.midi) return beat.bass;
    if (beatIndex === 0 && chordName === 'C') return { midi: 40, str: 6, en: 'E2' };
    return null;
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/guide.js'), 'utf8'), context);

const splitBeat = parseScore('[C] -/0E2+0G3+1C4/0D3+0A3+1F4 - -', 4).measures[0].beats[0];
splitBeat.subNotes[1].chordNotes[1].articulation = 'apoyando';
let events = context.getSubdividedGuideEvents(splitBeat, {
  chordName: 'C', beatIndex: 0, startTime: 10, subStep: 0.2, capo: 2, beatsPerBar: 4, preview: false
});
assert.equal(events.length, 6, 'rest followed by two full chords keeps all six notes');
assert.deepEqual(Array.from(events, event => event.note.midi), [40, 55, 60, 50, 57, 65], 'all parsed chord pitches remain in order');
assert.equal(events[0].when, 10.2, 'first chord starts at the second subdivision after the rest');
assert.equal(events[3].when, 10.4, 'second chord starts at the third subdivision');
assert.ok(Math.abs(events[0].duration - 1.32) < 0.000001, 'runtime rolled bass uses beat-length bass duration');
assert.ok(Math.abs(events[1].duration - 0.3) < 0.000001, 'runtime rolled chord melody uses subdivision duration');
assert.equal(events[1].when, 10.228, 'rolled chord offset remains inside the subdivision');
context.scheduleSubdividedGuide(splitBeat, { chordName: 'C', beatIndex: 0, startTime: 10, subStep: 0.2, capo: 2, beatsPerBar: 4, preview: false });
assert.equal(emitted.length, 6, 'schedule wrapper emits every shared event');
assert.equal(emitted[0][0], 42, 'schedule wrapper applies capo to emitted MIDI');
assert.equal(emitted[0][5], 6, 'schedule wrapper preserves physical string');
assert.equal(emitted[1][4], 'apoyando', 'schedule wrapper preserves articulation');
assert.equal(emitted[1][5], 3, 'schedule wrapper preserves each chord note string');

const pairBeat = parseScore('[C] -/0E2+1C4/D4 - -', 4).measures[0].beats[0];
autoBass = false;
events = context.getSubdividedGuideEvents(pairBeat, {
  chordName: 'C', beatIndex: 0, startTime: 3, subStep: 0.25, capo: 0, beatsPerBar: 4, preview: false
});
assert.deepEqual(Array.from(events, event => event.note.midi), [60, 62], 'auto bass off suppresses explicit bass while keeping both melodies');
autoBass = true;
events = context.getSubdividedGuideEvents(pairBeat, {
  chordName: 'C', beatIndex: 0, startTime: 3, subStep: 0.25, capo: 0, beatsPerBar: 4, preview: false
});
assert.deepEqual(Array.from(events, event => event.note.midi), [40, 60, 62], 'explicit bass sounds with its pair at the pair subdivision');
assert.equal(events[0].when, 3.25, 'explicit bass sounds only at its own pair subdivision');
assert.equal(events[2].when, 3.5, 'following melody remains at the later subdivision');

autoBass = false;
const melodyBeat = parseScore('[C] -/C4/D4 - - -', 4).measures[0].beats[0];
events = context.getSubdividedGuideEvents(melodyBeat, {
  chordName: 'C', beatIndex: 0, startTime: 2, subStep: 0.22, capo: 0, beatsPerBar: 4, preview: true
});
assert.equal(events.length, 2, 'preview without auto bass emits only melody notes');
assert.equal(events[0].duration, 0.75, 'preview melody duration is preserved');
autoBass = true;
events = context.getSubdividedGuideEvents(melodyBeat, {
  chordName: 'C', beatIndex: 0, startTime: 2, subStep: 0.22, capo: 0, beatsPerBar: 4, preview: true
});
assert.deepEqual(Array.from(events, event => event.note.midi), [40, 60, 62], 'auto bass is added once only when no subnote has explicit bass');
assert.equal(events[0].when, 2, 'automatic bass plays at beat start');
assert.equal(events[1].when, 2.22, 'first subnote after rest remains delayed in preview');
assert.equal(events[0].duration, 1.25, 'preview bass duration is preserved');
assert.equal(context.getSubdividedGuideEvents(null, {}).length, 0, 'invalid beat returns no events');

process.stdout.write('Result: guide events passed (chord topology, pair bass policy, capo, timing, preview and runtime durations)\n');
