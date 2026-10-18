'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const parser = require('../src/parser.js');

const guideSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'guide.js'), 'utf8');
const audioSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio.js'), 'utf8');

function makeContext(capo, acousticFx){
  const oscillators = [];
  function param(initial){
    return { value:initial || 0, setValueAtTime(value, time){ this.value = value; this.last = ['set', value, time]; },
      linearRampToValueAtTime(value, time){ this.last = ['linear', value, time]; },
      exponentialRampToValueAtTime(value, time){ this.last = ['exponential', value, time]; },
      setTargetAtTime(value, time, constant){ this.last = ['target', value, time, constant]; },
      cancelScheduledValues(time){ this.cancelAt = time; } };
  }
  function source(){
    return { playbackRate:param(1), connect(){}, start(time){ this.startedAt = time; },
      stop(time){ this.stopAt = time; } };
  }
  const context = {
    appState: { acousticFx: acousticFx !== false, bodyAmount: 1, sympAmount: 1, synthEngine: 'ks' },
    GUITAR_MASTER_GAIN: 0.75,
    outGain: null,
    clickBus: null,
    guitarBus: {},
    dryGainNode: null,
    wetGainNode: null,
    reverbNode: null,
    bodyModes: [],
    STRINGS: [
      { str: 6, midi: 40 }, { str: 5, midi: 45 }, { str: 4, midi: 50 },
      { str: 3, midi: 55 }, { str: 2, midi: 59 }, { str: 1, midi: 64 }
    ],
    stringVoices: {},
    actx: {
      currentTime: 0,
      sampleRate: 48000,
      state: 'running',
      destination: {},
      createOscillator(){
        const oscillator = {
          frequency: param(0),
          connect(){}, start(){},
          stop(time){ this.stopAt = time; }
        };
        oscillators.push(oscillator);
        return oscillator;
      },
      createBufferSource: source,
      createBiquadFilter(){ return { frequency:param(0), Q:param(0), type:'', connect(){} }; },
      createGain(){
        return { gain:param(0), connect(){} };
      },
      createDynamicsCompressor(){ return { threshold:param(0), knee:param(0), ratio:param(0), attack:param(0), release:param(0), connect(){} }; },
      createConvolver(){ return { buffer:null, connect(){} }; },
      createBuffer(channels, length){
        const data = Array.from({ length:channels }, () => new Float32Array(length));
        return { getChannelData(index){ return data[index]; } };
      }
    },
    curCapo(){ return capo; },
    soundingMidi(midi, offset){ return Number(midi) + Number(offset || 0); },
    getSongCapo(song){ return song.capo || 0; },
    getExplicitBass: parser.getExplicitBass,
    midiInfo(midi){ return { pos: { str: midi % 6 + 1 } }; },
    getMeasureCount(song){ return song.bars.length; },
    getFlatImageBar(index){ return context.imageBars[index]; },
    parseNoteToken(token){ return context.imageNote; },
    imageBars: [], imageNote: null,
    console
  };
  vm.createContext(context);
  vm.runInContext(guideSource + '\n' + audioSource + '\nthis.__audioHooks = { addSympatheticResonance, warmKsCache, buildKsVoice, buildClassicVoice, dampSameStringVoices, trackGuideVoice, stopGuitarNotes, ensureAudioCtx, updateAudioFxRouting, getFxNodes: function(){ return { dryGainNode, wetGainNode }; }, replaceGetKsBuffer: function(fn){ getKsBuffer = fn; } };', context);
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
    [64, true, 2], [42, false, 6], [66, false, 4], [69, true, 3]
  ]);

  calls.length = 0;
  context.imageBars = [{ note: 'E4' }];
  context.imageNote = { midi: 64, pos: { str: 2 } };
  context.__audioHooks.warmKsCache({ type: 'image', capo: 3, bars: [{}] });
  assert.deepEqual(calls, [[67, false, 2]]);
});

test('warm cache follows explicit bass in parsed subNotes and keeps full chords', function(){
  const parsed = parser.parseScore('[-] -/0E2+1C4 - - -', 4);
  const song = { type: 'structured', capo: 2, beats: parsed.beats, measures: parsed.measures };
  const { context } = makeContext(0);
  const calls = [];
  context.__audioHooks.replaceGetKsBuffer((midi, apo, str) => calls.push([midi, apo, str]));
  context.__audioHooks.warmKsCache(song);
  assert.deepEqual(calls, [[42, false, 6], [62, false, 2]]);

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

test('exact KS duration ends at the requested time with a short release tail', function(){
  const { context } = makeContext(0);
  context.__audioHooks.replaceGetKsBuffer(() => ({ duration:4 }));
  const voice = context.__audioHooks.buildKsVoice(60, 2, 0.125, 1, false, false, true, 2, true);
  assert.equal(voice.stopAt, 2.14);
});

test('exact classic duration ends at the requested time and regular gate remains separate', function(){
  const { context } = makeContext(0);
  const exact = context.__audioHooks.buildClassicVoice(64, 1, 0.2, 1, false, false, false, false, true);
  const regular = context.__audioHooks.buildClassicVoice(64, 1, 0.2, 1, false, false, false, false, false);
  assert.ok(Math.abs(exact.stopAt - 1.215) < 1e-9);
  assert.ok(Math.abs(regular.stopAt - 1.23) < 1e-9);
});

test('concert hall wet gain initializes and toggles through the shared routing policy', function(){
  const enabled = makeContext(0, true);
  enabled.context.__audioHooks.ensureAudioCtx();
  const initial = enabled.context.__audioHooks.getFxNodes();
  assert.equal(initial.wetGainNode.gain.value, 0.35, 'enabled AudioContext starts at the concert hall wet level');
  assert.equal(initial.dryGainNode.gain.value, 0.88, 'enabled AudioContext keeps the existing dry level');

  enabled.context.appState.acousticFx = false;
  enabled.context.__audioHooks.updateAudioFxRouting();
  assert.deepEqual(initial.wetGainNode.gain.last, ['linear', 0, 0.04], 'live OFF ramps wet gain to zero over the existing 40ms');
  assert.deepEqual(initial.dryGainNode.gain.last, ['linear', 0.88, 0.04], 'live OFF leaves the dry target unchanged');

  enabled.context.appState.acousticFx = true;
  enabled.context.__audioHooks.updateAudioFxRouting();
  assert.deepEqual(initial.wetGainNode.gain.last, ['linear', 0.35, 0.04], 'live ON ramps wet gain to the shared constant');
  assert.deepEqual(initial.dryGainNode.gain.last, ['linear', 0.88, 0.04], 'live ON leaves the dry target unchanged');

  enabled.context.__audioHooks.replaceGetKsBuffer(() => ({ duration:4 }));
  enabled.context.playGuitarNote(64, 0.5, 1, 1, null, 1, { exactDuration:true });
  const direct = enabled.context.trackedGuideVoices[0];
  assert.ok(Math.abs(direct.end - 1.515) < 1e-9, 'wet gain changes leave direct KS note gate and 15ms release unchanged');

  const disabled = makeContext(0, false);
  disabled.context.__audioHooks.ensureAudioCtx();
  const offNodes = disabled.context.__audioHooks.getFxNodes();
  assert.equal(offNodes.wetGainNode.gain.value, 0, 'disabled AudioContext starts with wet muted');
  assert.equal(offNodes.dryGainNode.gain.value, 0.88, 'disabled AudioContext keeps dry gain');
});

test('stopGuitarNotes cuts direct and sympathetic voices at the requested time only', function(){
  const { context } = makeContext(0);
  const stopped = [];
  const gainFor = () => ({ gain:{ cancelScheduledValues(){}, setValueAtTime(){}, linearRampToValueAtTime(value, time){ stopped.push(['ramp', value, time]); } } });
  const sourceFor = () => ({ stop(time){ stopped.push(['stop', time]); } });
  context.stringVoices = {
    1:[{ start:2, end:5, damp:gainFor(), srcs:[sourceFor()] }],
    2:[{ start:4, end:6, symp:true, damp:gainFor(), srcs:[sourceFor()] }],
    3:[{ start:8, end:9, damp:gainFor(), srcs:[sourceFor()] }]
  };
  context.trackedGuideVoices = Object.values(context.stringVoices).flat();
  context.__audioHooks.stopGuitarNotes(4);
  assert.deepEqual(stopped.filter(x => x[0] === 'stop').map(x => x[1]), [4.015, 4, 8]);
  assert.deepEqual(stopped.filter(x => x[0] === 'ramp').map(x => x[2]), [4.01]);
  assert.equal(context.stringVoices[1].length, 1, 'future stop remains tracked until the audio clock passes its cutoff');
  assert.equal(context.stringVoices[2].length, 1, 'future-start voice remains tracked until its scheduled start');
  assert.equal(context.stringVoices[3].length, 1, 'future reservation remains tracked until its cutoff');
});

test('stopGuitarNotes still cuts a direct voice after same-string reattack removed it from the string list', function(){
  const { context } = makeContext(0);
  const stopped = [];
  const voice = { start:2, end:8,
    damp:{ gain:{ setValueAtTime(){}, setTargetAtTime(){} } },
    srcs:[{ stop(time){ stopped.push(time); } }] };
  context.stringVoices = { 1:[voice] };
  context.trackedGuideVoices = [voice];
  context.__audioHooks.dampSameStringVoices(1, 2.1);
  assert.equal(context.stringVoices[1].length, 0, 'normal reattack bookkeeping removes the previous voice from its string list');
  context.__audioHooks.stopGuitarNotes(2.15);
  assert.equal(stopped.length, 2, 'reattack release is replaced by stop cutoff');
  assert.ok(Math.abs(stopped[1] - 2.165) < 1e-9, 'previous direct voice is cut within 15ms of stop');
});

test('stopGuitarNotes cuts sympathetic voices after resonance refresh removes them from the string list', function(){
  const { context } = makeContext(0);
  context.__audioHooks.addSympatheticResonance(64, 1, 1, 2);
  const oldVoices = Object.values(context.stringVoices).flat().filter(voice => voice.symp);
  assert.ok(oldVoices.length > 0, 'first note creates sympathetic voices');
  context.__audioHooks.addSympatheticResonance(64, 1.2, 1, 2);
  assert.ok(oldVoices.some(voice => !Object.values(context.stringVoices).flat().includes(voice)), 'resonance refresh removes old voices from their string lists');
  context.__audioHooks.stopGuitarNotes(1.5);
  assert.ok(oldVoices.every(voice => voice.srcs[0].stopAt <= 1.515), 'refreshed sympathetic releases are cut within 15ms of stop');
});

test('scheduling a later subdivision does not prune a voice before the real audio clock reaches its end', function(){
  const { context } = makeContext(0);
  context.actx.currentTime = 1;
  const stopped = [];
  const active = { start:0.9, end:1.25, damp:{ gain:{ cancelScheduledValues(){}, setValueAtTime(){}, linearRampToValueAtTime(){} } },
    srcs:[{ stop(time){ stopped.push(time); } }] };
  context.trackedGuideVoices = [active];
  context.stringVoices = { 1:[active] };
  const later = { start:1.3, end:1.6, damp:{ gain:{} }, srcs:[] };
  context.__audioHooks.trackGuideVoice(later, 1.3);
  assert.ok(context.trackedGuideVoices.includes(active), 'still sounding voice survives a future event registration');
  context.__audioHooks.stopGuitarNotes(1.1);
  assert.ok(Math.abs(stopped[0] - 1.115) < 1e-9, 'intermediate stop still cuts the earlier voice within 15ms');
});

test('a future rest cutoff stays tracked so an earlier user stop can move it forward', function(){
  const { context } = makeContext(0);
  context.actx.currentTime = 1;
  const stopped = [];
  const voice = { start:1, end:2, damp:{ gain:{ cancelScheduledValues(){}, setValueAtTime(){}, linearRampToValueAtTime(){} } },
    srcs:[{ stop(time){ stopped.push(time); } }] };
  context.trackedGuideVoices = [voice];
  context.stringVoices = { 1:[voice] };
  context.__audioHooks.stopGuitarNotes(1.5);
  assert.equal(voice.end, 1.515, 'future rest establishes its cutoff without dropping the live registry entry');
  assert.ok(context.trackedGuideVoices.includes(voice));
  context.__audioHooks.stopGuitarNotes(1.2);
  assert.ok(Math.abs(voice.end - 1.215) < 1e-9, 'earlier stop moves the cutoff earlier');
  assert.ok(Math.abs(stopped[1] - 1.215) < 1e-9);
});

test('repeated stop requests never extend an already scheduled voice end', function(){
  const { context } = makeContext(0);
  context.actx.currentTime = 1;
  const stopped = [];
  const voice = { start:1, end:2, damp:{ gain:{ cancelScheduledValues(){}, setValueAtTime(){}, linearRampToValueAtTime(){} } },
    srcs:[{ stop(time){ stopped.push(time); } }] };
  context.trackedGuideVoices = [voice];
  context.stringVoices = { 1:[voice] };
  context.__audioHooks.stopGuitarNotes(1.5);
  context.__audioHooks.stopGuitarNotes(1.505);
  assert.equal(voice.end, 1.515, 'later request preserves the earlier cutoff');
  assert.deepEqual(stopped, [1.515], 'later request does not reschedule an extended stop');
});

process.stdout.write('1..' + checks + '\n');
