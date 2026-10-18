'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const parser = require('../src/parser.js');

const guideSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'guide.js'), 'utf8');
const audioSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio.js'), 'utf8');

function makeContext(capo){
  const oscillators = [];
  const context = {
    appState: { acousticFx: true, sympAmount: 1, synthEngine: 'ks' },
    STRINGS: [
      { str: 6, midi: 40 }, { str: 5, midi: 45 }, { str: 4, midi: 50 },
      { str: 3, midi: 55 }, { str: 2, midi: 59 }, { str: 1, midi: 64 }
    ],
    stringVoices: {},
    guitarBus: {},
    actx: {
      destination: {},
      createOscillator(){
        const oscillator = {
          frequency: { value: 0 },
          connect(){}, start(){},
          stop(time){ this.stopAt = time; }
        };
        oscillators.push(oscillator);
        return oscillator;
      },
      createGain(){
        return { gain: { setValueAtTime(){}, setTargetAtTime(){} }, connect(){} };
      }
    },
    curCapo(){ return capo; },
    soundingMidi(midi, offset){ return Number(midi) + Number(offset || 0); },
    getSongCapo(song){ return song.capo || 0; },
    resolveEffectiveBass(chord, beat, bIdx){ return context.appState.autoBass === false ? null : (beat.bass || null); },
    midiInfo(midi){ return { pos: { str: midi % 6 + 1 } }; },
    getMeasureCount(song){ return song.bars.length; },
    getFlatImageBar(index){ return context.imageBars[index]; },
    parseNoteToken(token){ return context.imageNote; },
    imageBars: [], imageNote: null,
    console
  };
  vm.createContext(context);
  vm.runInContext(guideSource + '\n' + audioSource + '\nthis.__audioHooks = { addSympatheticResonance, warmKsCache, replaceGetKsBuffer: function(fn){ getKsBuffer = fn; } };', context);
  return { context, oscillators };
}

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

function resonate(capo, midi){
  const { context, oscillators } = makeContext(capo);
  context.__audioHooks.addSympatheticResonance(midi, 1, 1, 2);
  return { oscillators, strings: context.STRINGS };
}

test('sympathetic open strings follow capo and leave standard tuning unchanged', function(){
  const open = resonate(0, 64);
  const capo4 = resonate(4, 68);
  const openFundamental = open.oscillators.find(o => Math.abs(o.frequency.value - 440 * Math.pow(2, (64 - 69) / 12)) < 0.01);
  const capoFundamental = capo4.oscillators.find(o => Math.abs(o.frequency.value - 440 * Math.pow(2, (68 - 69) / 12)) < 0.01);
  assert.ok(openFundamental);
  assert.ok(capoFundamental);
  const capoTau = 8 * Math.pow((440 * Math.pow(2, (68 - 69) / 12)) / 82.4, -0.33) / 6.91;
  const expectedStopAt = 1 + 0.15 + Math.min(6, capoTau * 7);
  assert.ok(Math.abs(capoFundamental.stopAt - expectedStopAt) < 1e-9);
  assert.deepEqual(open.strings.map(s => s.midi), [40, 45, 50, 55, 59, 64]);
  assert.deepEqual(capo4.strings.map(s => s.midi), [40, 45, 50, 55, 59, 64]);
});

test('a pitch matching only the uncapped open E string no longer excites it under capo', function(){
  const result = resonate(4, 64);
  assert.equal(result.oscillators.some(o => Math.abs(o.frequency.value - 440 * Math.pow(2, (64 - 69) / 12)) < 0.01), false);
});

test('warm cache applies song capo to subdivisions, chords, bass, image notes, strings, and articulation', function(){
  const { context } = makeContext(0);
  const calls = [];
  context.__audioHooks.replaceGetKsBuffer((midi, apo, str) => calls.push([midi, apo, str]));
  context.__audioHooks.warmKsCache({
    type: 'structured', capo: 2,
    measures: [{ chord: 'C', beats: [
      { midi: 60, str: 1, bass: { midi: 40, str: 6 }, isSubdivided: true,
        subNotes: [
          { midi: 62, str: 2, articulation: 'apoyando' },
          { midi: 64, str: 3, chordNotes: [
            { midi: 40, str: 6 }, { midi: 64, str: 4 }, { midi: 67, str: 3, articulation: 'apoyando' }
          ] }
        ] }
    ] }]
  });
  assert.deepEqual(calls, [
    [42, false, 6], [64, true, 2], [66, false, 4], [69, true, 3]
  ]);

  calls.length = 0;
  context.imageBars = [{ note: 'E4' }];
  context.imageNote = { midi: 64, pos: { str: 2 } };
  context.__audioHooks.warmKsCache({ type: 'image', capo: 3, bars: [{}] });
  assert.deepEqual(calls, [[67, false, 2]]);
});

test('warm cache follows explicit bass in parsed subNotes and keeps full chords when auto bass is off', function(){
  const parsed = parser.parseScore('[-] -/0E2+1C4 - - -', 4);
  const song = { type: 'structured', capo: 2, beats: parsed.beats, measures: parsed.measures };
  const { context } = makeContext(0);
  const calls = [];
  context.__audioHooks.replaceGetKsBuffer((midi, apo, str) => calls.push([midi, apo, str]));
  context.__audioHooks.warmKsCache(song);
  assert.deepEqual(calls, [[42, false, 6], [62, false, 2]]);

  calls.length = 0;
  context.appState.autoBass = false;
  context.__audioHooks.warmKsCache(song);
  assert.deepEqual(calls, [[62, false, 2]]);

  calls.length = 0;
  const chordSubNote = {
    midi: 67, str: 3, bass: { midi: 40, str: 6 },
    chordNotes: [
      { midi: 40, str: 6 },
      { midi: 64, str: 4 },
      { midi: 67, str: 3 }
    ]
  };
  context.__audioHooks.warmKsCache({ type: 'structured', capo: 1, measures: [{ chord: '-', beats: [
    { isSubdivided: true, subNotes: [chordSubNote] }
  ] }] });
  assert.deepEqual(calls, [[41, false, 6], [65, false, 4], [68, false, 3]]);
});

test('warm cache skips classic engine and keeps the 64-note limit', function(){
  const { context } = makeContext(0);
  const calls = [];
  context.__audioHooks.replaceGetKsBuffer((midi, apo, str) => calls.push([midi, apo, str]));
  const beat = n => ({ midi: 40 + n, str: (n % 6) + 1 });
  context.appState.synthEngine = 'classic';
  context.__audioHooks.warmKsCache({ type: 'structured', measures: [{ chord: '', beats: [beat(0)] }] });
  assert.equal(calls.length, 0);
  context.appState.synthEngine = 'ks';
  context.__audioHooks.warmKsCache({ type: 'structured', capo: 0, measures: [{ chord: '', beats: Array.from({ length: 70 }, (_, i) => beat(i)) }] });
  assert.equal(calls.length, 64);
});

process.stdout.write('1..' + checks + '\n');
