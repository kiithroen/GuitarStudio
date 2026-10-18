const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function createStaticServer() {
  const server = http.createServer((req, res) => {
    const rawPath = req.url.split('?')[0];
    const safePath = rawPath === '/' ? '/index.html' : rawPath;
    const filePath = path.join(root, safePath);

    if (!filePath.startsWith(root)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      res.end(data);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

function findBrowserBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);

  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

async function waitForCdpEndpoint(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(item => item.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch (_) {
      // Chrome boot wait
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for Chrome CDP endpoint');
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.consoleErrors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          this.consoleErrors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          this.consoleErrors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
        }
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error('Evaluation error: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function waitForCondition(client, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const val = await client.evaluate(expression);
      if (val) return val;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for condition: ' + expression);
}

async function testConcertHallRouting(client){
  const routing = await client.evaluate(`(async function(){
    var saved = { acousticFx:appState.acousticFx, bodyAmount:appState.bodyAmount,
      sympAmount:appState.sympAmount, synthEngine:appState.synthEngine };
    var button = document.getElementById('toggleFxBtn'), off, on, voiceScheduled = false;
    try {
      if (!appState.acousticFx){ button.click(); await new Promise(function(resolve){ setTimeout(resolve, 60); }); }
      button.click();
      await new Promise(function(resolve){ setTimeout(resolve, 60); });
      off = { state:appState.acousticFx, wet:wetGainNode.gain.value, dry:dryGainNode.gain.value,
        running:actx.state === 'running', bus:!!guitarBus && !!outGain };
      appState.sympAmount = 0;
      playGuitarNote(64, 0.125, actx.currentTime + 0.02, 1, null, 1, { exactDuration:true });
      voiceScheduled = trackedGuideVoices.some(function(voice){ return voice.start >= actx.currentTime; });
      button.click();
      await new Promise(function(resolve){ setTimeout(resolve, 60); });
      on = { state:appState.acousticFx, wet:wetGainNode.gain.value, dry:dryGainNode.gain.value,
        running:actx.state === 'running', bus:!!guitarBus && !!outGain };
      return { initial:saved.acousticFx, off:off, on:on, voiceScheduled:voiceScheduled };
    } finally {
      appState.acousticFx=saved.acousticFx; appState.bodyAmount=saved.bodyAmount;
      appState.sympAmount=saved.sympAmount; appState.synthEngine=saved.synthEngine;
      updateAudioFxRouting(); syncConsoleUI(); saveAppState(); stopGuitarNotes(actx.currentTime);
    }
  })()`);
  assert.equal(routing.off.state, false, 'the actual FX toggle changes app state to OFF');
  assert.ok(Math.abs(routing.off.wet) < 0.001, 'the live AudioContext wet gain reaches zero when OFF');
  assert.ok(Math.abs(routing.off.dry - 0.88) < 0.001, 'OFF preserves the dry route');
  assert.equal(routing.off.running, true, 'AudioContext remains running when FX is OFF');
  assert.equal(routing.off.bus, true, 'guitar bus and output graph remain connected when FX is OFF');
  assert.equal(routing.voiceScheduled, true, 'direct note scheduling remains active through the FX toggle');
  assert.equal(routing.on.state, true, 'the actual FX toggle changes app state to ON');
  assert.ok(Math.abs(routing.on.wet - 0.35) < 0.001, 'the live AudioContext wet gain reaches the hall level when ON');
  assert.ok(Math.abs(routing.on.dry - 0.88) < 0.001, 'ON preserves the dry route');
  assert.equal(routing.on.running, true, 'AudioContext remains running when FX is ON');
  assert.equal(routing.on.bus, true, 'guitar bus and output graph remain connected when FX is ON');
  process.stdout.write('Browser checkpoint: concert hall routing ON/OFF passed\n');
}

async function testConcertHallOfflineRender(client){
  const render = await client.evaluate(`(async function(){
    var saved = { actx:window.actx, outGain:window.outGain, clickBus:window.clickBus, guitarBus:window.guitarBus,
      dryGainNode:window.dryGainNode, wetGainNode:window.wetGainNode, reverbNode:window.reverbNode,
      bodyModes:window.bodyModes, trackedGuideVoices:window.trackedGuideVoices, stringVoices:window.stringVoices,
      acousticFx:appState.acousticFx, bodyAmount:appState.bodyAmount, sympAmount:appState.sympAmount, synthEngine:appState.synthEngine };
    async function renderAt(engine, midi, duration, wet, dry, hardStopAt){
      appState.acousticFx = wet > 0; appState.bodyAmount = 0; appState.sympAmount = 0; appState.synthEngine = engine;
      var rate = 48000, ctx = new OfflineAudioContext(2, rate * 3.2, rate), sourceStops = [];
      ctx.resume = function(){ return Promise.resolve(); };
      var originalCreateBufferSource = ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource = function(){ var source = originalCreateBufferSource(); var stop = source.stop.bind(source);
        source.stop = function(time){ sourceStops.push(time); return stop(time); }; return source; };
      var originalCreateOscillator = ctx.createOscillator.bind(ctx);
      ctx.createOscillator = function(){ var source = originalCreateOscillator(); var stop = source.stop.bind(source);
        source.stop = function(time){ sourceStops.push(time); return stop(time); }; return source; };
      window.actx = ctx; window.outGain = null; window.clickBus = null; window.guitarBus = null;
      window.dryGainNode = null; window.wetGainNode = null; window.reverbNode = null; window.bodyModes = [];
      window.trackedGuideVoices = []; window.stringVoices = {};
      ensureAudioCtx(); dryGainNode.gain.value = dry; wetGainNode.gain.value = wet;
      playGuitarNote(midi, duration, 0.1, 1, null, 1, { exactDuration:true, hardStopAt:hardStopAt });
      var buffer = await ctx.startRendering(), left = buffer.getChannelData(0), right = buffer.getChannelData(1);
      function rms(start, end){ var sum = 0, count = 0;
        for(var i=Math.floor(start*rate); i<Math.floor(end*rate); i++){ var x=(left[i]+right[i])*0.5; sum+=x*x; count++; }
        return Math.sqrt(sum/count); }
      var peak=0; for(var i=0;i<left.length;i++) peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));
      return { tailRms:rms(1.01,1.8), lateRms:rms(0.516,1.0), earlyRms:rms(0.11,0.45), peak:peak, sourceStops:sourceStops };
    }
    async function renderChord(engine, chord, wet, amount){
      amount = amount == null ? 1 : amount;
      appState.acousticFx=wet; appState.bodyAmount=amount; appState.sympAmount=amount; appState.synthEngine=engine;
      var rate=48000, ctx=new OfflineAudioContext(2,rate*2.5,rate); ctx.resume=function(){ return Promise.resolve(); };
      window.actx=ctx; window.outGain=null; window.clickBus=null; window.guitarBus=null;
      window.dryGainNode=null; window.wetGainNode=null; window.reverbNode=null; window.bodyModes=[];
      window.trackedGuideVoices=[]; window.stringVoices={}; ensureAudioCtx(); dryGainNode.gain.value=0.88; wetGainNode.gain.value=wet?CONCERT_HALL_WET_GAIN:0;
      chord.forEach(function(midi,index){ playGuitarNote(midi,0.5,0.1,1,null,6-index,{exactDuration:true}); });
      var buffer=await ctx.startRendering(), peak=0, sum=0, count=0;
      for(var i=0;i<buffer.length;i++){
        var left=buffer.getChannelData(0)[i], right=buffer.getChannelData(1)[i];
        peak=Math.max(peak,Math.abs(left),Math.abs(right));
        if(i>=Math.floor(0.1*rate)&&i<Math.floor(1.2*rate)){var mono=(left+right)*0.5;sum+=mono*mono;count++;}
      }
      return {engine:engine,chord:chord.join('-'),fx:wet,bodyAmount:amount,sympAmount:amount,peak:peak,activeRms:Math.sqrt(sum/count)};
    }
    var result, matrix=[];
    try {
      for(var engine of ['ks','classic']) for(var duration of [0.125,0.5,1.5]) for(var wetMode of [false,true]){
        var item=await renderAt(engine,64,duration,wetMode?CONCERT_HALL_WET_GAIN:0,wetMode?0:0.88);
        matrix.push({engine:engine,duration:duration,fx:wetMode,peak:item.peak,earlyRms:item.earlyRms,tailRms:item.tailRms,sourceCount:item.sourceStops.length,
          maxSourceStop:item.sourceStops.length?Math.max.apply(null,item.sourceStops):null,sourceStops:item.sourceStops});
      }
      var dry = await renderAt('ks',64,0.5,0,0.88);
      var hall = await renderAt('ks',64,0.5,CONCERT_HALL_WET_GAIN,0);
      var forced = await renderAt('ks',64,1.5,0,0.88,0.5);
      var forcedClassic = await renderAt('classic',64,1.5,0,0.88,0.5);
      result = { matrix:matrix, dry:dry, hall:hall, forced:forced, gain:CONCERT_HALL_WET_GAIN,
        forcedClassic:forcedClassic,
        tailRatio:hall.tailRms/(await renderAt('ks',64,0.5,0.18,0)).tailRms,
        chords:[] };
      for(var engine of ['ks','classic']) for(var chordWet of [false,true]){
        result.chords.push(await renderChord(engine,[40,47,52,55,59,64],chordWet));
        result.chords.push(await renderChord(engine,[41,48,53,57,60,65],chordWet));
      }
      for(var engine of ['ks','classic']){
        result.chords.push(await renderChord(engine,[40,47,52,55,59,64],true,2));
        result.chords.push(await renderChord(engine,[41,48,53,57,60,65],true,2));
      }
    } finally {
      window.actx=saved.actx; window.outGain=saved.outGain; window.clickBus=saved.clickBus;
      window.guitarBus=saved.guitarBus; window.dryGainNode=saved.dryGainNode; window.wetGainNode=saved.wetGainNode;
      window.reverbNode=saved.reverbNode; window.bodyModes=saved.bodyModes;
      window.trackedGuideVoices=saved.trackedGuideVoices; window.stringVoices=saved.stringVoices;
      appState.acousticFx=saved.acousticFx; appState.bodyAmount=saved.bodyAmount;
      appState.sympAmount=saved.sympAmount; appState.synthEngine=saved.synthEngine;
    }
    result.restored = window.actx===saved.actx && window.outGain===saved.outGain && window.guitarBus===saved.guitarBus &&
      window.wetGainNode===saved.wetGainNode && appState.acousticFx===saved.acousticFx &&
      appState.bodyAmount===saved.bodyAmount && appState.sympAmount===saved.sympAmount && appState.synthEngine===saved.synthEngine;
    return result;
  })()`);
  assert.equal(render.gain, 0.35, 'offline render uses the production wet gain');
  assert.equal(render.restored, true, 'offline measurement restores the live AudioContext graph and app settings');
  assert.ok(render.dry.tailRms < 1e-8, 'dry KS render is silent after the natural release bound');
  assert.ok(render.hall.tailRms > 0, 'hall KS render has a real post-note-off convolver tail');
  assert.ok(render.matrix.every(function(item){ return item.earlyRms > 0; }), 'KS and classic actual audio graphs render audible nonzero samples');
  assert.ok(Math.abs(render.tailRatio / (0.35 / 0.18) - 1) < 0.05, 'isolated wet tail RMS follows the wet-gain ratio within 5%');
  assert.ok(render.matrix.every(function(item){ return item.peak < 1 && item.maxSourceStop <= 0.1 + item.duration + 0.4 + 1e-6; }), 'KS/classic, hall/dry, and .125/.5/1.5s renders stay below full scale and natural release bound');
  assert.ok(render.forced.sourceStops.length === 1 && Math.abs(render.forced.sourceStops[0] - 0.515) < 1e-6, 'hard loop boundary stops KS direct source within 15ms');
  assert.ok(render.forced.lateRms < 1e-8, 'hard loop boundary render is silent after its 15ms cutoff');
  assert.ok(render.forcedClassic.sourceStops.length === 3 && render.forcedClassic.sourceStops.every(function(stop){return Math.abs(stop - 0.515) < 1e-6;}), 'hard loop boundary stops all three classic oscillators within 15ms');
  assert.ok(render.forcedClassic.lateRms < 1e-8, 'hard loop boundary render is silent for classic output after its 15ms cutoff');
  assert.ok(render.chords.every(function(chord){ return chord.peak < 1 && chord.activeRms > 0; }), 'valid six-string Em/F chords render for KS/classic with dry/hall routing and body/sympathetic amount 1 or 2, without clipping');
  const artifact = path.join(root, 'test-artifacts', 'audio-release-check-' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(artifact), { recursive:true });
  fs.writeFileSync(artifact, JSON.stringify({ sampleRateHz:48000, peakDefinition:'max absolute sample across stereo channels',
    rmsDefinition:'RMS of stereo channel average; natural tail window 1.01-1.8s after a note starting at 0.1s with 0.5s duration',
    gain:render.gain, wetTailRatio:render.tailRatio, chords:render.chords, matrix:render.matrix,
    dryTailRms:render.dry.tailRms, hallTailRms:render.hall.tailRms, forcedCutoffStopAt:render.forced.sourceStops[0],
    forcedClassicStops:render.forcedClassic.sourceStops, forcedClassicLateRms:render.forcedClassic.lateRms,
    forcedPostCutoffRms:render.forced.lateRms }, null, 2) + '\n');
  process.stdout.write('Artifact: ' + artifact + '\n');
  process.stdout.write('Browser checkpoint: OfflineAudioContext natural releases, KS/classic hard cutoff, 12 KS/classic duration/FX cases, isolated hall tail, and 12 valid six-string Em/F chord renders passed (wet tail ratio ' + render.tailRatio.toFixed(4) + ', max chord peak ' + Math.max.apply(null,render.chords.map(function(chord){return chord.peak;})).toFixed(4) + ')\n');
}

async function testPracticeSessionLifecycle(client) {
  const result = await client.evaluate(`(async function(){
    var original = {
      setTimeout: window.setTimeout,
      actx: window.actx,
      scheduleMetronomeClick: window.scheduleMetronomeClick,
      playGuitarNote: window.playGuitarNote,
      scheduleMetronomeClick: window.scheduleMetronomeClick,
      highlightFretboard: window.highlightFretboard,
      ensureAudioCtx: window.ensureAudioCtx,
      warmKsCache: window.warmKsCache,
      state: { guideSound: appState.guideSound, loopEnable: appState.loopEnable, loopStart: appState.loopStart, loopEnd: appState.loopEnd, bpm: appState.bpm },
      isPlaying: window.isPlaying,
      playSession: window.playSession,
      song: window.curSong,
      measure: window.curMeasureIdx,
      beat: window.curBeatIdx
    };
    var assertions = [];
    function check(ok, message){ if (!ok) throw new Error(message); assertions.push(message); }
    try {
      var timers = [];
      var clicks = [];
      var highlights = 0;
      var notes = [];
      window.setTimeout = function(fn, delay){ timers.push({ fn: fn, delay: delay }); return timers.length; };
      window.scheduleMetronomeClick = function(time){ clicks.push(time); };
      window.highlightFretboard = function(){ highlights++; };
      window.playGuitarNote = function(midi, duration, time){ notes.push({ midi: midi, duration: duration, time: time }); };
      window.actx = { currentTime: 0, outputLatency: 0.02, baseLatency: 0.01 };
      appState.guideSound = false;
      appState.loopEnable = false;
      appState.loopStart = 1;
      appState.loopEnd = 1;
      window.curSong = { type: 'structured', measures: [{ beats: [{ isSubdivided: true, subNotes: [{}, { midi: 64, tok: 'E4' }] }, {}, {}, {}] }], title: 'lifecycle-test' };

      var staleSession = { inCountIn: false, nextBeatTime: 1, spb: 1, bpb: 4, bIdx: 0, mIdx: 0, loopCompleted: 0, endScheduled: false };
      window.playSession = staleSession;
      window.isPlaying = true;
      window.actx.currentTime = 0.95;
      schedulerTick();
      check(timers.length === 2, 'beat UI and guide-off subnote UI callbacks captured');
      var currentMeasureBefore = window.curMeasureIdx;
      var currentBeatBefore = window.curBeatIdx;
      window.playSession = { sentinel: true };
      timers[0].fn();
      timers[1].fn();
      check(window.curMeasureIdx === currentMeasureBefore && window.curBeatIdx === currentBeatBefore, 'stale beat UI callback ignored after session replacement');
      check(highlights === 0, 'stale subnote UI callback ignored after session replacement');
      window.isPlaying = false;

      [30, 60, 240].forEach(function(bpm){
        timers = [];
        clicks = [];
        notes = [];
        appState.guideSound = true;
        window.curSong.measures[0].beats = [{}, {}, {}, { isSubdivided: true, subNotes: [{ midi: 65, tok: 'F4' }, { midi: 67, tok: 'G4' }] }];
        appState.bpm = bpm;
        var spb = 60 / bpm;
        var session = { inCountIn: false, nextBeatTime: 1, spb: spb, bpb: 4, bIdx: 0, mIdx: 0, loopCompleted: 0, endScheduled: false };
        window.playSession = session;
        window.isPlaying = true;
        for (var beatIdx = 0; beatIdx < 4; beatIdx++){
          window.actx.currentTime = session.nextBeatTime - 0.01;
          schedulerTick();
        }
        check(session.endScheduled === true, 'tempo ' + bpm + ': final beat marks session ending');
        check(clicks.length === 4, 'tempo ' + bpm + ': exactly four in-range beats scheduled');
        check(notes.length === 2 && Math.abs(notes[1].time - (session.nextBeatTime - spb / 2)) < 0.000001, 'tempo ' + bpm + ': final beat subdivision is scheduled before session stop');
        var endTimers = timers.filter(function(timer){ return Math.abs(timer.delay - Math.max(0, (session.nextBeatTime + 0.03 - window.actx.currentTime) * 1000)) < 0.01; });
        check(endTimers.length === 1, 'tempo ' + bpm + ': one latency-aligned stop is scheduled');
        var clicksBefore = clicks.length;
        window.actx.currentTime = session.nextBeatTime + spb * 2;
        schedulerTick();
        check(clicks.length === clicksBefore, 'tempo ' + bpm + ': no out-of-range beat after final beat');
        var uiTimers = timers.filter(function(timer){ return timer !== endTimers[0]; });
        var replacement = { sentinel: true };
        window.playSession = replacement;
        window.curMeasureIdx = 42;
        window.curBeatIdx = 43;
        uiTimers.forEach(function(timer){ timer.fn(); });
        endTimers[0].fn();
        check(window.isPlaying === true && window.playSession === replacement, 'tempo ' + bpm + ': stale UI and stop callbacks ignored');
        window.isPlaying = false;
      });

      window.playSession = null;
      window.curSong = original.song;
      window.ensureAudioCtx = function(){};
      window.warmKsCache = function(){};
      window.actx = { currentTime: 0 };
      startPractice();
      var firstSession = window.playSession;
      check(window.isPlaying === true && firstSession && firstSession.inCountIn === true, 'practice starts synchronously with a count-in session');
      check(!Object.prototype.hasOwnProperty.call(firstSession, 'hits') && !Object.prototype.hasOwnProperty.call(firstSession, 'lastOnsetObj'), 'practice session has no scoring or onset state');
      check(document.getElementById('playBtn').textContent === '연습 정지', 'main play button immediately exposes stop action');
      startPractice();
      check(window.playSession === firstSession, 'duplicate start while playing is ignored');
      stopPractice();
      check(window.isPlaying === false && window.playSession == null, 'main play button session stops synchronously');

      document.getElementById('compactPlayBtn').click();
      check(window.isPlaying === true && window.playSession, 'compact play button starts immediately');
      document.getElementById('compactPlayBtn').click();
      check(window.isPlaying === false && window.playSession == null, 'compact play button stops immediately');

      startPractice();
      var previousSong = window.curSong.id;
      var nextSong = window.allSongs.find(function(song){ return song.id !== previousSong; });
      changeSongById(nextSong.id);
      check(window.isPlaying === false && window.playSession == null && window.curSong.id === nextSong.id, 'song change stops active practice');

      var spaceStart = new KeyboardEvent('keydown', { key: ' ', code:'Space', bubbles: true, cancelable: true });
      window.dispatchEvent(spaceStart);
      check(window.isPlaying === true && window.playSession, 'Space keyboard shortcut starts practice');
      var spaceStop = new KeyboardEvent('keydown', { key: ' ', code:'Space', bubbles: true, cancelable: true });
      window.dispatchEvent(spaceStop);
      check(window.isPlaying === false && window.playSession == null, 'Space keyboard shortcut stops practice');
      return assertions;
    } finally {
      window.setTimeout = original.setTimeout;
      window.actx = original.actx;
      window.scheduleMetronomeClick = original.scheduleMetronomeClick;
      window.playGuitarNote = original.playGuitarNote;
      window.highlightFretboard = original.highlightFretboard;
      window.ensureAudioCtx = original.ensureAudioCtx;
      window.warmKsCache = original.warmKsCache;
      Object.keys(original.state).forEach(function(key){ appState[key] = original.state[key]; });
      window.isPlaying = original.isPlaying;
      window.playSession = original.playSession;
      window.curSong = original.song;
      window.curMeasureIdx = original.measure;
      window.curBeatIdx = original.beat;
      syncCompactPlayButtons();
    }
  })()`);
  assert.ok(Array.isArray(result) && result.length >= 20, 'practice session lifecycle regressions pass');
  process.stdout.write('Checks: practice lifecycle ' + result.length + '\n');
}

async function testCaptureRemovalAndAudioOffset(client) {
  const result = await client.evaluate(`(function(){
    var original = { song:curSong, compact:appState.isCompactPractice, guide:appState.guideSound,
      offset:appState.audioOffsetMs, playing:window.isPlaying, session:window.playSession };
    var audit = window.__gsCaptureAudit;
    function check(ok, message){ if (!ok) throw new Error(message); }
    try {
      var removedIds = ['tunerModal','tunerBtn','micScoreBtn','liveNote','liveErr','micFill','histBody','clearHistBtn','runCalibBtn'];
      check(removedIds.every(function(id){ return document.getElementById(id) === null; }), 'capture, tuner, calibration, and scoring history DOM is removed');
      check(typeof navigator.mediaDevices.getUserMedia === 'function' && typeof navigator.mediaDevices.enumerateDevices === 'function', 'capture audit stubs are installed before app startup');

      document.getElementById('audioOffsetOpenBtn').click();
      check(!document.getElementById('audioOffsetModal').hidden, 'manual output offset modal opens without requesting microphone access');
      document.getElementById('btPresetWired').click();
      check(appState.audioOffsetMs === 0 && document.getElementById('audioOffsetBadge').textContent === '0ms', 'wired preset keeps a zero output offset');
      document.getElementById('btPresetNormal').click();
      check(appState.audioOffsetMs === 180 && document.getElementById('audioOffsetBadge').textContent === '+180ms', 'normal Bluetooth preset applies 180ms');
      document.getElementById('btPresetHeavy').click();
      check(appState.audioOffsetMs === 240 && document.getElementById('audioOffsetBadge').textContent === '+240ms', 'heavy Bluetooth preset applies 240ms');
      var range = document.getElementById('audioOffsetRange');
      check(range.min === '0' && range.max === '400' && range.step === '5', 'manual output offset slider spans 0-400ms in 5ms steps');
      range.value = '125'; range.dispatchEvent(new Event('input', { bubbles:true }));
      check(appState.audioOffsetMs === 125 && document.getElementById('audioOffsetVal').textContent === '+125 ms', 'manual output offset updates app state and value label');
      document.getElementById('closeAudioOffsetBtn').click();

      startPractice();
      check(window.isPlaying && window.playSession, 'normal practice starts with no capture API');
      stopPractice();
      setCompactPractice(true);
      document.getElementById('compactPlayBtn').click();
      check(window.isPlaying && window.playSession, 'compact practice starts with no capture API');
      document.getElementById('compactPlayBtn').click();
      check(!window.isPlaying && window.playSession == null, 'compact practice stops with no capture API');
      setCompactPractice(false);
      startPractice();
      var otherSong = window.allSongs.find(function(song){ return song.id !== curSong.id; });
      changeSongById(otherSong.id);
      check(!window.isPlaying && window.playSession == null && curSong.id === otherSong.id, 'changing songs stops active practice without capture APIs');
      if (original.song && curSong.id !== original.song.id) changeSongById(original.song.id);
      check(audit.capture === 0 && audit.devices === 0 && audit.worklet === 0, 'practice, output settings, and song changes never request capture, enumerate devices, or load a worklet');
      return { checks:13, counters:{ capture:audit.capture, devices:audit.devices, worklet:audit.worklet } };
    } finally {
      if (window.isPlaying) stopPractice();
      appState.audioOffsetMs = original.offset;
      appState.guideSound = original.guide;
      setCompactPractice(original.compact);
      if (original.song && curSong.id !== original.song.id) changeSongById(original.song.id);
      window.playSession = original.session;
      window.isPlaying = original.playing;
      saveAppState();
      syncCompactPlayButtons();
    }
  })()`);
  assert.deepEqual(result.counters, { capture:0, devices:0, worklet:0 }, 'capture APIs and audio worklet remain unused after playback, modal, preset, and song changes');
  process.stdout.write('Checks: capture-free audio offset and practice workflow ' + result.checks + '\n');
}

async function importLegacyBackup(client) {
  await client.evaluate(`(function(){
    var song = buildStructuredSong({ id:'browser-legacy-backup-song', title:'Legacy backup song', badge:'Custom', capo:3, bpm:84, beats:4, lines:['[C] C4 - - -'] });
    var backup = { version:1, exportedAt:'2026-10-19T00:00:00.000Z', customSongs:[song], history:[{ sentinel:'old-backup-score' }], calib:{ lat:0.123, calibrated:true }, appState:{ bpm:84, audioOffsetMs:180, micScoring:true, micDeviceId:'removed-device', guideSound:true } };
    var file = new File([JSON.stringify(backup)], 'legacy-backup.json', { type:'application/json' });
    var transfer = new DataTransfer(); transfer.items.add(file);
    var input = document.getElementById('importFileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
    return true;
  })()`);
}

async function testBackupExport(client) {
  const result = await client.evaluate(`(async function(){
    var original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    var captured = null;
    var timeoutId = null;
    var resolveBlob;
    var blobCreated = new Promise(function(resolve){ resolveBlob = resolve; });
    try {
      Object.defineProperty(URL, 'createObjectURL', { configurable:true, value:function(blob){ captured = blob; resolveBlob(blob); return 'blob:test-backup'; } });
      var blobTimeout = new Promise(function(_, reject){ timeoutId = setTimeout(function(){ reject(new Error('Timed out waiting for backup Blob creation')); }, 5000); });
      document.getElementById('exportJsonBtn').click();
      await Promise.race([blobCreated, blobTimeout]);
      var payload = JSON.parse(await captured.text());
      return { keys:Object.keys(payload).sort(), version:payload.version, exportedAt:payload.exportedAt,
        appStateKeys:Object.keys(payload.appState || {}), songs:Array.isArray(payload.customSongs) };
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (original) Object.defineProperty(URL, 'createObjectURL', original);
      else delete URL.createObjectURL;
    }
  })()`);
  assert.deepEqual(result.keys, ['appState','customSongs','exportedAt','version'], 'backup export contains only the versioned app state and custom songs payload');
  assert.equal(result.version, 1, 'backup format version remains 1');
  assert.ok(result.exportedAt, 'backup export retains its exportedAt timestamp');
  assert.equal(result.songs, true, 'backup export retains customSongs');
  assert.ok(!result.appStateKeys.includes('micScoring') && !result.appStateKeys.includes('micDeviceId'), 'removed microphone settings are not re-exported');
  process.stdout.write('Checks: legacy-compatible backup export shape 5\n');
}

async function testSubdividedGuide(client) {
  const result = await client.evaluate(`(async function(){
    var original = {
      song: window.curSong,
      actx: window.actx,
      playGuitarNote: window.playGuitarNote,
      stopGuitarNotes: window.stopGuitarNotes,
      warmKsCache: window.warmKsCache,
      scheduleMetronomeClick: window.scheduleMetronomeClick,
      ensureAudioCtx: window.ensureAudioCtx,
      setTimeout: window.setTimeout,
      session: window.playSession,
      playing: window.isPlaying,
      measure: window.curMeasureIdx,
      beat: window.curBeatIdx,
      state: { guideSound: appState.guideSound, scoreView: appState.scoreView, beats: appState.beats, bpm: appState.bpm, loopStart: appState.loopStart, loopEnd: appState.loopEnd, loopEnable: appState.loopEnable }
    };
    var assertions = [];
    var emitted = [];
    var stopped = [];
    function check(ok, message){ if (!ok) throw new Error(message); assertions.push(message); }
    try {
      var parsedGuide = parseScore('[C] r/0E2+0G3+1C4/0D3+0A3+1F4 - -', 4);
      var song = { id: 'browser-guide-regression', title: 'Guide Capo 2', type: 'structured', beats: parsedGuide.beats, bpm: 60, capo: 2, measures: parsedGuide.measures };
      window.curSong = song;
      window.ensureAudioCtx = function(){};
      window.playGuitarNote = function(midi, duration, when, gain, articulation, str){ emitted.push({ midi: midi, duration: duration, when: when, gain: gain, articulation: articulation, str: str }); };
      window.stopGuitarNotes = function(when){ stopped.push(when); };
      window.scheduleMetronomeClick = function(){};
      window.actx = { currentTime: 2, outputLatency: 0, baseLatency: 0 };
      appState.guideSound = true;
      appState.scoreView = 'tab';
      appState.beats = 4;
      renderSong();
      emitted = [];
      updateActiveCursor(0, 0, true);
      check(emitted.length === 6, 'preview preserves both full chords after the leading rest');
      check(emitted.map(function(event){ return event.midi; }).join(',') === '42,57,62,52,59,67', 'preview applies capo while retaining every chord pitch');
      check(emitted.map(function(event){ return event.str; }).join(',') === '6,3,2,4,3,1', 'preview preserves each physical string');
      check(Math.abs(emitted[0].when - (2 + 1 / 3)) < 0.000001 && Math.abs(emitted[3].when - (2 + 2 / 3)) < 0.000001, 'preview starts chord groups at their subdivision positions');
      check(emitted.slice(0, 3).every(function(event){ return event.when === emitted[0].when && event.duration === emitted[0].duration; }) && emitted.slice(3).every(function(event){ return event.when === emitted[3].when && event.duration === emitted[3].duration; }), 'each chord shares one exact attack time and duration');
      var pills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="0"] .tab-fret-pill'));
      check(pills.length === 6 && pills.every(function(p){ return p.classList.contains('note-fret'); }), 'TAB grid renders every subdivided pitch with the same neutral note style');
      check(pills.filter(function(p){ return Math.abs(parseFloat(p.style.left) - 50) < 0.001; }).length === 3 && pills.filter(function(p){ return Math.abs(parseFloat(p.style.left) - 83.3333333333) < 0.001; }).length === 3, 'TAB chord fingering pills stay at each subdivision position');
      var tabTop = document.querySelector('#measuresGrid .beat-cell[data-b="0"] .tab-cell-en');
      check(tabTop && tabTop.textContent === '쉼·E+G+C·D+A+F', 'TAB top label distinguishes the rest from note components');
      appState.scoreView = 'card';
      renderSong();
      var rhythmCell = document.querySelector('#measuresGrid .beat-cell[data-b="0"]');
      check(rhythmCell.querySelector('.b-dur-badge').textContent.trim().length > 0 && /분할별 길이/.test(rhythmCell.title), 'duration badge and tooltip show subdivision duration details');
      appState.scoreView = 'tab';
      renderSong();

      emitted = [];
      var timers = [];
      window.setTimeout = function(fn, delay){ timers.push({ fn: fn, delay: delay }); return timers.length; };
      window.playSession = { inCountIn: false, nextBeatTime: 4, spb: 0.6, bpb: 4, bIdx: 0, mIdx: 0, loopCompleted: 0, endScheduled: false };
      window.isPlaying = true;
      window.actx.currentTime = 3.95;
      schedulerTick();
      check(emitted.length === 6 && emitted[0].when > 4, 'runtime does not sound notes at the leading rest');
      check(Math.abs(emitted[0].when - 4.2) < 0.000001 && Math.abs(emitted[3].when - 4.4) < 0.000001, 'runtime schedules both chords at their subdivisions');
      check(emitted.map(function(event){ return event.midi; }).join(',') === '42,57,62,52,59,67', 'runtime uses capo-adjusted pitches for every chord note');
      check(timers.length >= 3, 'runtime schedules beat and later subnote UI updates');

      var pairParsed = parseScore('[C] r/0E2+1C4/D4 - - -', 4);
      var pairBeat = pairParsed.measures[0].beats[0];
      var pairSong = { id: 'browser-guide-pair', title: 'Pair', badge: '', type: 'structured', beats: 4, measures: pairParsed.measures };
      window.curSong = pairSong;
      renderSong();
      var splitPairPills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="0"] .tab-fret-pill'));
      check(splitPairPills.length === 3 && splitPairPills.every(function(p){ return p.classList.contains('note-fret'); }), 'subdivided pair notes use the same neutral pill style');
      window.actx.currentTime = 7;
      emitted = [];
      updateActiveCursor(0, 0, true);
      check(emitted.map(function(event){ return event.midi; }).join(',') === '40,60,62', 'preview always plays every note in an explicitly entered pair');
      var pairEvents = getSubdividedGuideEvents(pairBeat, { startTime: 8, subStep: 0.2, capo: 0, beatsPerBar: 4, preview: false });
      check(Array.from(pairEvents, function(event){ return event.note.midi; }).join(',') === '40,60,62', 'subdivided guide always retains the explicit bass and both melodies');
      window.actx.currentTime = 7;
      emitted = [];
      updateActiveCursor(0, 0, true);
      check(emitted.map(function(event){ return event.midi; }).join(',') === '40,60,62' && Math.abs(emitted[0].when - (7 + (60 / appState.bpm) / 3)) < 0.000001, 'preview plays every explicit pair component at its subnote time');
      check(pairEvents[0].when === 8.2, 'explicit pair bass plays only at its own subnote time');

      emitted = [];
      window.playSession = { inCountIn: false, nextBeatTime: 8, spb: 0.6, bpb: 4, bIdx: 0, mIdx: 0, loopCompleted: 0, endScheduled: false };
      window.isPlaying = true;
      window.actx.currentTime = 7.95;
      schedulerTick();
      check(emitted.map(function(event){ return event.midi; }).join(',') === '40,60,62' && Math.abs(emitted[0].when - 8.2) < 0.000001, 'runtime plays explicit pair bass only at its subnote time');

      var sameStringSong = { id: 'browser-guide-same-string', title: 'Same String', badge: '', type: 'structured', beats: 4, measures: parseScore('[C] 0E2+3G2/D4 - - -', 4).measures };
      window.curSong = sameStringSong;
      renderSong();
      var sameStringPills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="0"] .tab-fret-pill')).filter(function(p){ return Math.abs(parseFloat(p.style.left) - 25) < 0.001; });
      check(sameStringPills.length === 2 && sameStringPills[0].style.transform === 'translate(-85%, -50%)' && sameStringPills[1].style.transform === 'translate(-15%, -50%)', 'same-string pair TAB frets separate horizontally');
      var sameFretSong = { id: 'browser-guide-same-fret', title: 'Same Fret', badge: '', type: 'structured', beats: 4, measures: parseScore('[C] 0E2+2E2/D4 - - -', 4).measures };
      window.curSong = sameFretSong;
      renderSong();
      var sameFretPills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="0"] .tab-fret-pill')).filter(function(p){ return Math.abs(parseFloat(p.style.left) - 25) < 0.001; });
      check(sameFretPills.length === 1 && sameFretPills[0].classList.contains('note-fret'), 'same-string same-fret pair draws one neutral note pill');

      var clockScore = parseScore('[C] 0E2 r 0G2 G2@6+B2@5\\n[G] - - - -\\n[D] - - E3 r', 4);
      check(clockScore.errors.length === 0 && clockScore.measures.length === 3 && clockScore.measures.every(function(measure){ return measure.beats.length === 4; }), 'fake-clock runtime fixture is a complete three-measure source score');
      window.curSong = { id:'browser-rhythm-clock', title:'Rhythm clock', type:'structured', beats:4, bpm:100, capo:2, measures:clockScore.measures };
      appState.beats = 4;
      appState.bpm = 100;
      appState.loopEnable = false;
      appState.loopStart = 1;
      appState.loopEnd = 3;
      renderSong();
      emitted = [];
      stopped = [];
      window.actx.currentTime = 39.99;
      window.playSession = { inCountIn:false, nextBeatTime:40, spb:0.6, bpb:4, bIdx:0, mIdx:0, loopCompleted:0, resumeNextHold:false, endScheduled:false };
      window.isPlaying = true;
      schedulerTick();
      window.actx.currentTime = 40.59;
      schedulerTick();
      window.actx.currentTime = 41.19;
      schedulerTick();
      check(stopped.length === 1 && stopped[0] === 40.6, 'a rest schedules voice stop at its exact slot time');
      check(emitted.length === 2 && emitted[1].when === 41.2, 'the note after a rest still schedules normally');

      emitted = [];
      window.actx.currentTime = 50.59;
      window.playSession = { inCountIn:false, nextBeatTime:50.6, spb:0.6, bpb:4, bIdx:1, mIdx:1, loopCompleted:0, resumeNextHold:false, endScheduled:false };
      schedulerTick();
      check(emitted.length === 0, 'an ordinary internal hold slot schedules no new note-on');

      emitted = [];
      appState.loopStart = 2;
      appState.loopEnd = 2;
      var loopStartHold = clockScore.measures[1].beats[0];
      var loopStartSource = GuitarRhythm.resolveHold(clockScore.measures, loopStartHold);
      check(loopStartHold.kind === 'hold' && loopStartSource && loopStartSource.tok === 'G2@6+B2@5', 'loop-start test targets a cross-bar hold linked to the original chord');
      window.actx.currentTime = 59.99;
      window.playSession = { inCountIn:false, nextBeatTime:60, spb:0.6, bpb:4, bIdx:0, mIdx:1, loopCompleted:0, resumeNextHold:false, endScheduled:false };
      schedulerTick();
      check(emitted.length === 2 && emitted[0].midi !== emitted[1].midi && emitted[0].when === emitted[1].when, 'loop-start hold resumes the original chord once with simultaneous attacks');
      check(emitted.every(function(event){ return event.duration === 2.4; }), 'loop-start resumed chord clips to the four slots remaining in the loop');

      emitted = [];
      appState.loopStart = 1;
      appState.loopEnd = 3;
      window.warmKsCache = function(){};
      window.curMeasureIdx = 1;
      window.curBeatIdx = 1;
      window.isPlaying = false;
      window.playSession = null;
      window.actx.currentTime = 70;
      stopped = [];
      await startPractice();
      var resumedSession = window.playSession;
      check(resumedSession && resumedSession.resumeNextHold === true && resumedSession.mIdx === 1 && resumedSession.bIdx === 1, 'middle-slot practice start arms one hold resume outside loop start (' + JSON.stringify(resumedSession && {resume:resumedSession.resumeNextHold,m:resumedSession.mIdx,b:resumedSession.bIdx}) + ')');
      check(stopped.length === 1 && stopped[0] === 70, 'practice start cuts the prior preview before count-in');
      for (var countInIndex = 0; countInIndex < 4; countInIndex++){
        window.actx.currentTime = resumedSession.nextBeatTime - 0.01;
        schedulerTick();
      }
      window.actx.currentTime = resumedSession.nextBeatTime - 0.01;
      schedulerTick();
      check(emitted.length === 2 && emitted[0].when === emitted[1].when, 'middle-slot first hold resumes its original chord once');
      window.actx.currentTime = resumedSession.nextBeatTime - 0.01;
      schedulerTick();
      check(emitted.length === 2, 'the next hold inside the resumed chain does not retrigger');
      window.isPlaying = false;
      window.playSession = null;

      window.curSong = original.song;
      renderSong();
      var clickSession = { inCountIn:false, nextBeatTime:10, spb:0.6, bpb:4, bIdx:0, mIdx:0, loopCompleted:0, endScheduled:false };
      window.playSession = clickSession;
      window.isPlaying = true;
      emitted = [];
      document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="1"]').click();
      check(window.isPlaying && window.playSession === clickSession && clickSession.bIdx === 0 && clickSession.mIdx === 0, 'clicking another slot during playback updates the view without seeking the scheduler');
      check(emitted.length === 0, 'clicking during playback does not layer an unintended preview note');
      window.isPlaying = false;

      var melodySong = { type: 'structured', measures: parseScore('[C] r/C4/D4 - - -', 4).measures };
      var melodyEvents = getSubdividedGuideEvents(melodySong.measures[0].beats[0], { startTime: 9, subStep: 0.2, capo: 0, beatsPerBar: 4, preview: false });
      check(melodyEvents.length === 2, 'single-note subnotes in a chord-named bar receive no added bass');
      check(melodyEvents.every(function(event){ return event.note.midi === 60 || event.note.midi === 62; }), 'single-note subnotes retain only the written pitches');

      var sourceText = '[C] C3@5 G3@3+C4@2 E4@1\\n[C] C3@5 G3@3+C4@2 E4@1';
      var source = parseScore(sourceText, 3);
      var sourceSong = { id:'browser-written-pair-capo', title:'Written pair', type:'structured', beats:3, bpm:60, capo:5, measures:source.measures };
      var originalPairToken = sourceSong.measures[0].beats[1].tok;
      appState.scoreView = 'tab';
      appState.beats = 3;
      window.curSong = sourceSong;
      renderSong();
      var tabPairs = [0, 1].map(function(measureIndex){
        var cell = document.querySelector('#measuresGrid .beat-cell[data-m="' + measureIndex + '"][data-b="1"]');
        var pills = Array.prototype.slice.call(cell.querySelectorAll('.tab-fret-pill'));
        return {
          label: cell.querySelector('.tab-cell-en').textContent,
          hasHandHint: !!cell.querySelector('.tab-cell-rh'),
          low: pills.some(function(p){ return p.classList.contains('note-fret') && p.textContent.trim() === '0' && p.style.top === '40%'; }),
          high: pills.some(function(p){ return p.classList.contains('note-fret') && p.textContent.trim().indexOf('1') === 0 && p.style.top === '20%'; }),
          styles: pills.map(function(p){ var style = getComputedStyle(p); return [style.color, style.backgroundColor, style.borderColor].join('|'); })
        };
      });
      check(tabPairs.every(function(pair){ return pair.label === 'G3+C4' && !pair.hasHandHint && pair.low && pair.high && pair.styles.length === 2 && pair.styles[0] === pair.styles[1]; }), 'both measures show G3+C4 with same-style neutral pills and no p+m hint');
      check(tabPairs[0].styles[0] === tabPairs[1].styles[0], 'pair pills have matching computed foreground, background, and border styles at rest');
      sourceSong.measures.forEach(function(measure){
        measure.beats.forEach(function(beat){
          if (beat.tok.indexOf('G3@3+C4@2') < 0) return;
          beat.lh = 3;
          beat.rh = 'p';
          if (beat.bass) { beat.bass.lh = 4; beat.bass.rh = 'p'; }
          (beat.chordNotes || []).forEach(function(component, index){ component.lh = index + 1; component.rh = index ? 'i' : 'p'; });
        });
      });
      renderSong();
      updateActiveCursor(0, 1, false);
      var oldMetadataPair = document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="1"]');
      check(oldMetadataPair.querySelectorAll('.tab-cell-lh').length === 0 && !oldMetadataPair.querySelector('.tab-cell-rh'), 'old inferred lh/rh metadata is ignored when original pair token has no LH digits');
      check(document.getElementById('guideLhTxt').textContent.indexOf('3줄 미지정 + 2줄 미지정') >= 0 && document.getElementById('guideRhTxt').textContent === '-', 'fretboard guide ignores old inferred hand metadata');

      var explicitHandText = '[C] 1C4 4D4@2 0E4 0G3@3+1C4@2';
      var explicitHandScore = parseScore(explicitHandText, 4);
      window.curSong = { id:'browser-explicit-left-hand', title:'Explicit LH', type:'structured', beats:4, measures:explicitHandScore.measures };
      renderSong();
      function pillLabels(beatIndex){
        return Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="' + beatIndex + '"] .tab-fret-pill')).map(function(p){ return p.textContent.trim(); });
      }
      check(pillLabels(0).join(',') === '1(1)' && pillLabels(1).join(',') === '3(4)' && pillLabels(2).join(',') === '0(0)' && pillLabels(3).join(',') === '0(0),1(1)', 'TAB displays only directly written LH digits, including zero, for single notes and pairs');
      updateActiveCursor(0, 0, false);
      check(document.getElementById('guideLhTxt').textContent.indexOf('1번') >= 0 && document.getElementById('guideRhTxt').textContent === '-', 'single-note fretboard guide shows explicit LH and no RH estimate');
      updateActiveCursor(0, 3, false);
      check(document.getElementById('guideLhTxt').textContent.indexOf('3줄 0 + 2줄 1번') >= 0 && document.getElementById('guideRhTxt').textContent === '-', 'pair fretboard guide shows each explicit LH component and no RH estimate');

      openConverterEditorModal({ title:'explicit LH editor', beats:4, rawText:explicitHandText });
      var explicitEditorCells = Array.prototype.slice.call(document.querySelectorAll('#veBarsGrid .ve-cell')).slice(0, 4).map(function(cell){ return cell.querySelector('b').textContent; });
      check(explicitEditorCells.join(',') === '1도,4레,0미,0솔+1도', 'visual editor displays source LH digits only for explicit notes');
      document.getElementById('padModeStringBtn').click();
      var padButtonText = document.querySelector('#notePadRows .np-btn b').textContent;
      check(padButtonText === '미4', 'note pad labels show pitch and octave without inferred LH digits');
      document.getElementById('nsTitle').value = 'Explicit LH round trip';
      document.getElementById('saveNewSongBtn').click();
      for (var waitIndex = 0; waitIndex < 50 && !window.curSong.title.includes('Explicit LH round trip'); waitIndex++){
        await new Promise(function(resolve){ original.setTimeout.call(window, resolve, 20); });
      }
      check(window.curSong.title === 'Explicit LH round trip', 'explicit LH score saves through the editor flow');
      document.getElementById('editStructuredBtn').click();
      var firstEditorCell = document.querySelector('#veBarsGrid .ve-cell');
      firstEditorCell.click();
      document.getElementById('veApoyandoBtn').click();
      document.getElementById('saveNewSongBtn').click();
      var secondSaveButton = document.getElementById('saveNewSongBtn');
      for (var saveWaitIndex = 0; saveWaitIndex < 50 && secondSaveButton.disabled; saveWaitIndex++){
        await new Promise(function(resolve){ original.setTimeout.call(window, resolve, 20); });
      }
      check(!secondSaveButton.disabled, 'edited explicit LH score completes its second save');
      document.getElementById('editStructuredBtn').click();
      var reopenedText = document.getElementById('nsMeasuresTxt').value;
      check(reopenedText.indexOf('!1C4') >= 0 && reopenedText.indexOf('4D4@2') >= 0 && reopenedText.indexOf('0E4') >= 0 && reopenedText.indexOf('0G3@3+1C4@2') >= 0, 'edited score reopens with explicit LH prefixes, including default-position fingers, intact');
      document.getElementById('closeNewSongBtn').click();

      window.curSong = sourceSong;
      renderSong();
      updateActiveCursor(0, 1, false);
      var activePair = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-m="0"][data-b="1"] .tab-fret-pill')).map(function(p){ var style = getComputedStyle(p); return [style.color, style.backgroundColor, style.borderColor].join('|'); });
      check(activePair.length === 2 && activePair[0] === activePair[1] && activePair[0] !== tabPairs[0].styles[0], 'active pair pills share the same active foreground, background, and border styles');
      appState.scoreView = 'card';
      renderSong();
      var pairCard = document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="1"]');
      check(pairCard.querySelector('.b-ko-main').textContent === '솔·도' && pairCard.querySelector('.b-note-sub').textContent === 'G3+C4', 'beat card shows both pair solfege and octave names');
      openConverterEditorModal({ title:'pair editor', beats:3, rawText:sourceText });
      var editorPairCell = document.querySelectorAll('#veBarsGrid .ve-cell')[1];
      check(editorPairCell.textContent.indexOf('솔+도') >= 0 && editorPairCell.textContent.indexOf('p솔') < 0, 'visual editor shows both pair notes without a bass prefix');
      var editorChordSelect = document.querySelector('#veBarsGrid .ve-chord-sel');
      editorChordSelect.value = 'G';
      editorChordSelect.dispatchEvent(new Event('change', { bubbles:true }));
      var generatedEditorText = document.getElementById('nsMeasuresTxt').value;
      check(generatedEditorText.indexOf('솔+도') >= 0 && generatedEditorText.indexOf('p솔') < 0, 'generated editor lyrics list every chord note without a bass prefix');
      document.getElementById('closeNewSongBtn').click();
      emitted = [];
      window.actx.currentTime = 12;
      updateActiveCursor(0, 1, true);
      check(emitted.map(function(event){ return event.midi; }).join(',') === '60,65' && emitted.map(function(event){ return event.str; }).join(',') === '3,2', 'preview plays both capo-adjusted pair pitches on strings three and two');
      var fretboardLow = document.querySelector('#fretboard .fb-open[data-str="3"]');
      var fretboardHigh = document.querySelector('#fretboard .fb-cell[data-str="2"][data-fret="1"] .target-note');
      var guideText = document.getElementById('guideNoteTxt').textContent;
      var guideHand = document.getElementById('guideRhTxt').textContent;
      check(fretboardLow && fretboardLow.textContent.indexOf('솔') >= 0 && fretboardLow.textContent.indexOf('p') < 0 && getComputedStyle(fretboardLow).color === 'rgb(98, 212, 145)' && fretboardHigh && fretboardHigh.textContent.indexOf('도') >= 0, 'fretboard shows both written notes in the same green target style without a p label');
      check(guideText.indexOf('겹음:') === 0 && guideText.indexOf('저음') < 0 && guideHand.indexOf('저음') < 0 && guideText.indexOf('엄지') < 0 && guideHand.indexOf('엄지') < 0 && guideText.indexOf('p(') < 0 && guideHand === '-', 'pair guide lists the notes without inferred hand roles');
      emitted = [];
      window.playSession = { inCountIn: false, nextBeatTime: 13, spb: 0.5, bpb: 3, bIdx: 1, mIdx: 0, loopCompleted: 0, endScheduled: false };
      window.isPlaying = true;
      window.actx.currentTime = 12.95;
      schedulerTick();
      check(emitted.map(function(event){ return event.midi; }).join(',') === '60,65' && emitted.map(function(event){ return event.str; }).join(',') === '3,2', 'runtime plays both capo-adjusted pair pitches on their written strings');
      check(sourceText === '[C] C3@5 G3@3+C4@2 E4@1\\n[C] C3@5 G3@3+C4@2 E4@1' && sourceSong.measures[0].beats[1].tok === originalPairToken, 'pair display and playback do not alter the source or saved token');
      return assertions;
    } finally {
      window.curSong = original.song;
      window.actx = original.actx;
      window.playGuitarNote = original.playGuitarNote;
      window.stopGuitarNotes = original.stopGuitarNotes;
      window.warmKsCache = original.warmKsCache;
      window.scheduleMetronomeClick = original.scheduleMetronomeClick;
      window.ensureAudioCtx = original.ensureAudioCtx;
      window.setTimeout = original.setTimeout;
      window.playSession = original.session;
      window.isPlaying = original.playing;
      window.curMeasureIdx = original.measure;
      window.curBeatIdx = original.beat;
      Object.keys(original.state).forEach(function(key){ appState[key] = original.state[key]; });
      if (original.song) renderSong();
      Object.keys(original.state).forEach(function(key){ appState[key] = original.state[key]; });
    }
  })()`);
  assert.ok(Array.isArray(result) && result.length >= 19, 'subdivided guide regressions pass');
  process.stdout.write('Checks: subdivided guide ' + result.length + '\n');
}

async function testStorageFailureRecovery(client) {
  const result = await client.evaluate(`(async function(){
    var originalSaveSong = window.dbSaveSong;
    var originalDeleteSong = window.dbDeleteSong;
    var originalSong = window.curSong;
    var originalCustomSongs = window.customSongs.slice();
    var assertions = [];
    function check(ok, message){ if (!ok) throw new Error(message); assertions.push(message); }
    try {
      var openSheet = document.getElementById('openSheetSyncBtn');
      openSheet.click();
      check(!document.getElementById('sheetSyncModal').hidden, 'sheet sync modal opens through module wiring');
      document.getElementById('closeSheetSyncBtn').click();
      check(document.getElementById('sheetSyncModal').hidden, 'sheet sync modal closes through module wiring');

      window.openConverterEditorModal({ title: 'browser storage failure', beats: 4, rawText: '[C] C4 - - -' });
      document.getElementById('nsTitle').value = 'browser storage failure';
      window.dbSaveSong = function(){ return Promise.reject(new Error('Injected storage failure')); };
      await document.getElementById('saveNewSongBtn').click();
      for (var failureWait = 0; failureWait < 100 && document.getElementById('saveNewSongBtn').disabled; failureWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      check(!document.getElementById('newSongModal').hidden, 'failed save keeps editor modal open');
      check(!document.getElementById('storageStatus').hidden && document.getElementById('storageStatus').textContent.length > 0, 'failed save displays storage guidance');
      check(document.getElementById('ocrStatusTxt').textContent.indexOf('저장하지 못했어요') >= 0, 'failed save displays guidance inside the editor');
      check(!document.getElementById('saveNewSongBtn').disabled, 'failed save restores button enabled state');
      check(window.curSong.id === originalSong.id, 'failed save preserves selected song');
      check(window.customSongs.length === originalCustomSongs.length, 'failed save preserves custom song list');
      window.dbSaveSong = originalSaveSong;
      await document.getElementById('saveNewSongBtn').click();
      for (var retryWait = 0; retryWait < 100 && !document.getElementById('newSongModal').hidden; retryWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      check(document.getElementById('newSongModal').hidden, 'retry success closes editor modal');
      check(window.customSongs.some(function(song){ return song.title === 'browser storage failure'; }), 'retry success adds the custom song');
      check((await dbGetAllSongs()).some(function(song){ return song.title === 'browser storage failure'; }), 'retry success persists the custom song in IndexedDB');
      check(document.getElementById('storageStatus').hidden, 'retry success clears storage guidance');
      check(document.getElementById('ocrStatusTxt').textContent === '', 'retry success clears editor guidance');
      return assertions;
    } finally {
      window.dbSaveSong = originalSaveSong;
      window.dbDeleteSong = originalDeleteSong;
      window.curSong = originalSong;
      if (document.getElementById('newSongModal') && !document.getElementById('newSongModal').hidden) document.getElementById('closeNewSongBtn').click();
    }
  })()`);
  assert.ok(Array.isArray(result) && result.length >= 11, 'storage failure recovery and sheet module wiring pass');
  process.stdout.write('Checks: storage recovery and sheet wiring ' + result.length + '\n');
}

async function testInvalidStructuredPersistence(client) {
  const result = await client.evaluate(`(async function(){
    var originalSong = window.curSong;
    var originalSongs = window.allSongs.slice();
    var originalCustomSongs = window.customSongs.slice();
    var originalSave = window.dbSaveSong;
    var originalState = { bpm: appState.bpm, loopStart: appState.loopStart, loopEnd: appState.loopEnd };
    var originalPlaying = window.isPlaying;
    var originalSession = window.playSession;
    var writes = [];
    try {
      var invalid = { id:'browser-invalid-personal', title:'Invalid personal', type:'structured', beats:4, measures:parseScore('[C] C4', 4).measures };
      window.customSongs.push(invalid);
      window.allSongs.push(invalid);
      window.dbSaveSong = function(song){ writes.push(song.id); return Promise.resolve(true); };
      changeSongById(invalid.id);
      await startPractice();
      var invalidPlaybackBlocked = window.isPlaying === false && window.playSession == null && /재생할 수 없는 악보/.test(document.getElementById('phaseTxt').textContent);
      saveAppState();
      appState.bpm = 88;
      saveAppState();
      window.isPlaying = true;
      window.playSession = {};
      stopPractice();
      return { writes:writes.slice(), source:invalid.measures[0].beats[0].tok, invalidPlaybackBlocked:invalidPlaybackBlocked, appStateSaved:JSON.parse(localStorage.getItem('gs.state')).bpm === 88, songMetadataUntouched:invalid.lastBpm === undefined && invalid.lastPracticedAt === undefined };
    } finally {
      window.dbSaveSong = originalSave;
      window.customSongs.splice(0, window.customSongs.length, ...originalCustomSongs);
      window.allSongs = originalSongs;
      window.curSong = originalSong;
      Object.keys(originalState).forEach(function(key){ appState[key] = originalState[key]; });
      window.isPlaying = originalPlaying;
      window.playSession = originalSession;
      renderSong();
    }
  })()`);
  assert.deepEqual(result.writes, [], 'invalid personal score selection, app-state save, BPM change, and stop do not overwrite IndexedDB');
  assert.equal(result.source, 'C4', 'invalid personal score source remains unchanged');
  assert.equal(result.invalidPlaybackBlocked, true, 'invalid structured score cannot start playback and reports its location');
  assert.equal(result.appStateSaved, true, 'app settings still save while invalid song persistence is skipped');
  assert.equal(result.songMetadataUntouched, true, 'invalid song metadata is not mutated during app-state save');
  process.stdout.write('Checks: invalid structured persistence guard 5\n');
}

async function main() {
  const browserBin = findBrowserBinary();
  if (!browserBin) {
    process.stdout.write('SKIP: No Chrome or Edge binary found for browser test\n');
    return;
  }

  const { server, port: httpPort } = await createStaticServer();
  const cdpPort = 9333 + Math.floor(Math.random() * 200);
  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-browser-smoke-'));

  const chromeProc = spawn(browserBin, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tempProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;

  try {
    const wsUrl = await waitForCdpEndpoint(cdpPort, 12000);
    cdp = new CdpClient(wsUrl);
    await cdp.connect();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source:`(function(){
      var key='__gsCaptureAudit';
      var audit={ capture:0, devices:0, worklet:0 };
      try {
        if(localStorage.getItem('gs.history')===null) localStorage.setItem('gs.history','legacy-history-marker');
        if(localStorage.getItem('gs.calib')===null) localStorage.setItem('gs.calib','legacy-calibration-marker');
      } catch(_){}
      try { var previous=JSON.parse(sessionStorage.getItem(key)||'null'); if(previous) audit=previous; } catch(_){}
      function save(){ try { sessionStorage.setItem(key,JSON.stringify(audit)); } catch(_){} }
      Object.defineProperty(window,'__gsCaptureAudit',{ configurable:true, get:function(){ return audit; } });
      Object.defineProperty(navigator,'mediaDevices',{ configurable:true, get:function(){ return {
        getUserMedia:function(){ audit.capture++; save(); throw new Error('Unexpected getUserMedia call'); },
        enumerateDevices:function(){ audit.devices++; save(); throw new Error('Unexpected enumerateDevices call'); },
        addEventListener:function(){}, removeEventListener:function(){}
      }; }});
      if(window.AudioWorklet && AudioWorklet.prototype && typeof AudioWorklet.prototype.addModule==='function'){
        var original=AudioWorklet.prototype.addModule;
        Object.defineProperty(AudioWorklet.prototype,'addModule',{ configurable:true, value:function(){ audit.worklet++; save(); return original.apply(this,arguments); } });
      }
    })();` });

    const appUrl = `http://127.0.0.1:${httpPort}/index.html`;
    await cdp.send('Page.navigate', { url: appUrl });

    // Wait until boot completes
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.allSongs.length === 14 && window.curSong != null', 8000);

    // Assert initial app state in real browser
    const songCount = await cdp.evaluate('window.allSongs.length');
    assert.equal(songCount, 14, 'browser loaded 14 songs from songs.json');

    const curSongId = await cdp.evaluate('window.curSong.id');
    assert.equal(curSongId, 'builtin-lv1-butterfly', 'default song selected in browser');

    const fretboardChildren = await cdp.evaluate('document.getElementById("fretboard").children.length');
    assert.equal(fretboardChildren, 7, 'fretboard DOM elements rendered (6 strings + header)');

    const measureCount = await cdp.evaluate('document.getElementById("measuresGrid").children.length');
    assert.ok(measureCount > 0, 'measures grid rendered in browser DOM');

    const audioBoot = await cdp.evaluate(`(async function(){
      ensureAudioCtx();
      if (window.actx && window.actx.state === 'suspended') await window.actx.resume();
      return { supported: !!(window.AudioContext || window.webkitAudioContext), instance: !!window.actx && (window.actx instanceof (window.AudioContext || window.webkitAudioContext)), state: window.actx && window.actx.state };
    })()`);
    assert.equal(audioBoot.supported, true, 'browser exposes a real Web Audio engine');
    assert.equal(audioBoot.instance, true, 'app initializes a real AudioContext');
    assert.equal(audioBoot.state, 'running', 'AudioContext resumes in the browser test');
    await testConcertHallRouting(cdp);
    await testConcertHallOfflineRender(cdp);
    const liveGuide = await cdp.evaluate(`(function(){
      var parsed = parseScore('[C] 0E2 r r r', 4);
      warmKsCache({ type:'structured', measures:parsed.measures, capo:2 });
      var start = actx.currentTime + 0.05;
      var noteEvents = scheduleBeatGuide(parsed.measures[0].beats[0], { startTime:start, slotDuration:0.12, measures:parsed.measures, capo:2, maxDurationSlots:1 });
      var restEvents = scheduleBeatGuide(parsed.measures[0].beats[1], { startTime:start + 0.12, slotDuration:0.12, measures:parsed.measures, capo:2, maxDurationSlots:1 });
      stopGuitarNotes(actx.currentTime + 0.01);
      return { noteKinds:noteEvents.map(function(event){ return event.kind; }), restKinds:restEvents.map(function(event){ return event.kind; }), audioState:actx.state };
    })()`);
    assert.deepEqual(liveGuide.noteKinds, ['note'], 'real audio scheduler emits a note from a parsed score');
    assert.deepEqual(liveGuide.restKinds, ['rest'], 'real audio scheduler processes a future rest event');
    assert.equal(liveGuide.audioState, 'running', 'real guide scheduler runs on the initialized AudioContext');

    const bassButtonAbsent = await cdp.evaluate('document.getElementById("toggleAutoBassBtn") === null');
    assert.equal(bassButtonAbsent, true, 'automatic bass accompaniment toggle is removed');
    process.stdout.write('Browser checkpoint: boot and initial DOM passed\n');

    const canonicalTsv = await cdp.evaluate(`window.formatSongToSheetTsv('slash lyric', 4, 90, 'badge', [
      '[C] C4 - - - | 너 / 나',
      '[G] G3 - - - | "https://example.test/a|b"'
    ])`);
    const canonicalColumns = canonicalTsv.split('\t');
    assert.equal(canonicalColumns.length, 5, 'canonical TSV keeps five columns');
    assert.ok(canonicalColumns[4].includes(' // '), 'canonical TSV joins measures with //');
    assert.equal(canonicalColumns[4].includes('\n'), false, 'canonical TSV score stays on one row');
    assert.ok(canonicalColumns[4].includes('| "너 / 나"'), 'slash lyric is JSON quoted and preserved');
    assert.ok(canonicalColumns[4].includes('"https://example.test/a|b"'), 'URL and pipe lyric characters are preserved');

    const notationUi = await cdp.evaluate(`(function(){
      var textarea = document.getElementById('nsMeasuresTxt');
      var status = document.getElementById('scoreValidationStatus');
      var raw = '[C] C4 D4 E4 F4 G4 | "overflow"';
      openConverterEditorModal({ title: 'overflow', beats: 4, rawText: raw });
      var preserved = textarea.value === raw && document.getElementById('veBarsGrid').children.length === 0;
      var overflowDiagnostic = status.textContent;
      var beatSelect = document.getElementById('nsBeats');
      beatSelect.value = '6';
      beatSelect.dispatchEvent(new Event('change', { bubbles: true }));
      var underfillPreserved = textarea.value === raw && veState.beats === 6 && veState.bars.length === 0 && /박/.test(status.textContent);
      var matchingRaw = '[C] C4 D4 E4 F4 G4 A4 | "matching"';
      textarea.value = matchingRaw;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      var beatRecovery = textarea.value === matchingRaw && veState.bars.length === 1 && veState.bars[0].notes.length === 6;
      openConverterEditorModal({ title: 'invalid save', beats: 4, rawText: raw });
      var before = customSongs.length;
      document.getElementById('saveNewSongBtn').click();
      var invalidSaveBlocked = customSongs.length === before && textarea.value === raw;
      document.getElementById('closeNewSongBtn').click();
      var invalidInputs = ['[C] - C4 r r', '[C] C4', '[C] C4 . r r'];
      var originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      var originalPrompt = window.prompt;
      var clipboardCalls = 0;
      var promptCalls = 0;
      var invalidExportsBlocked = false;
      try {
        Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:function(){ clipboardCalls++; return Promise.resolve(); } } });
        window.prompt = function(){ promptCalls++; };
        invalidExportsBlocked = invalidInputs.every(function(sourceText){
          openConverterEditorModal({ title:'invalid export', beats:4, rawText:sourceText });
          var countBefore = customSongs.length;
          var validation = validateScore(sourceText, 4);
          document.getElementById('saveNewSongBtn').click();
          document.getElementById('copyVeRowTsvBtn').click();
          var blocked = validation.errors.length > 0 && customSongs.length === countBefore && textarea.value === sourceText;
          document.getElementById('closeNewSongBtn').click();
          return blocked;
        });
      } finally {
        if (originalClipboardDescriptor) Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
        else delete navigator.clipboard;
        window.prompt = originalPrompt;
      }
      invalidExportsBlocked = invalidExportsBlocked && clipboardCalls === 0 && promptCalls === 0;
      var originalSong = curSong;
      var specialLyric = 'slash // pipe | quote " and /';
      var source = buildStructuredSong({ id:'browser-lyric-roundtrip', title:'lyric', beats:4, lines:['[C] C4 - - -'] });
      source.measures[0].lyric = specialLyric;
      curSong = source;
      document.getElementById('editStructuredBtn').click();
      var lyricRoundTrip = decodeMeasureLine(document.getElementById('nsMeasuresTxt').value).lyric === specialLyric;
      document.getElementById('closeNewSongBtn').click();
      curSong = originalSong;
      return { preserved:preserved, overflowDiagnostic:overflowDiagnostic, underfillPreserved:underfillPreserved, beatRecovery:beatRecovery, invalidSaveBlocked:invalidSaveBlocked, invalidExportsBlocked:invalidExportsBlocked, lyricRoundTrip:lyricRoundTrip };
    })()`);
    assert.equal(notationUi.preserved, true, 'overflow input remains intact and is not projected');
    assert.match(notationUi.overflowDiagnostic, /5박/, 'overflow input reports its excess beat');
    assert.equal(notationUi.underfillPreserved, true, 'changing meter preserves the source and does not fill missing slots');
    assert.equal(notationUi.beatRecovery, true, 'a complete six-slot source safely restores projection');
    assert.equal(notationUi.invalidSaveBlocked, true, 'invalid score cannot be saved');
    assert.equal(notationUi.invalidExportsBlocked, true, 'orphan hold, missing slots, and ambiguous dot cannot be saved or exported as TSV');
    assert.equal(notationUi.lyricRoundTrip, true, 'structured edit opening preserves JSON lyric delimiters');
    process.stdout.write('Browser checkpoint: notation UI passed\n');

    const imageUi = await cdp.evaluate(`(async function(){
      var savedSong = curSong;
      var savedBpm = appState.bpm;
      var savedScanner = window.scanImageBarlines;
      var savedAlert = window.alert;
      var alerts = [];
      var target = { id:'browser-image-convert', title:'Image source', type:'image', badge:'Source badge', beats:4, bpm:77, imageDataUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', systems:[{x:0.1,y:0.1,w:0.8,h:0.3,bars:[{chord:'C',note:'C4',memo:'keep',w:1,custom:'keep'}]}] };
      try {
        window.alert = function(message){ alerts.push(String(message)); };
        appState.bpm = 91;
        curSong = target;
        document.getElementById('convertImgToScoreBtn').click();
        var defaultText = document.getElementById('nsMeasuresTxt').value;
        var defaultOk = defaultText === '[-] r r r r';
        var metadataOk = document.getElementById('nsBpm').value === '91' && veState.sourceBadge === 'Source badge' && veState.refImageDataUrl === target.imageDataUrl;
        document.getElementById('closeNewSongBtn').click();

        var resolveScan;
        window.scanImageBarlines = function(){ return new Promise(function(resolve){ resolveScan = resolve; }); };
        document.getElementById('autoDetectBarsBtn').click();
        await new Promise(function(resolve){ setTimeout(resolve, 0); });
        var switched = Object.assign({}, target, { id:'browser-image-switched', systems:[{x:0.2,y:0.2,w:0.5,h:0.2,bars:[]}] });
        curSong = switched;
        resolveScan([0.1, 0.3, 0.5]);
        await new Promise(function(resolve){ setTimeout(resolve, 20); });
        var staleIgnored = target.systems[0].bars.length === 1 && switched.systems[0].bars.length === 0;

        curSong = target;
        window.scanImageBarlines = function(){ return Promise.resolve([0.1, 0.3]); };
        document.getElementById('autoDetectBarsBtn').click();
        await new Promise(function(resolve){ setTimeout(resolve, 20); });
        var metadataPreserved = target.systems[0].bars.length === 1 && target.systems[0].bars[0].chord === 'C' && target.systems[0].bars[0].note === 'C4' && target.systems[0].bars[0].memo === 'keep' && target.systems[0].bars[0].custom === 'keep';
        window.scanImageBarlines = function(){ return Promise.resolve([0.1, 0.2, 0.3]); };
        document.getElementById('autoDetectBarsBtn').click();
        await new Promise(function(resolve){ setTimeout(resolve, 20); });
        var countMismatchProtected = target.systems[0].bars.length === 1 && target.systems[0].bars[0].chord === 'C' && target.systems[0].bars[0].note === 'C4' && target.systems[0].bars[0].memo === 'keep' && target.systems[0].bars[0].custom === 'keep';
        return {defaultOk:defaultOk, metadataOk:metadataOk, staleIgnored:staleIgnored, metadataPreserved:metadataPreserved, countMismatchProtected:countMismatchProtected, sameCountAlert:alerts.some(function(message){ return message.indexOf('마디 영역만 추정') >= 0; }), mismatchAlert:alerts.some(function(message){ return message.indexOf('기존 음표·코드') >= 0; })};
      } finally {
        curSong = savedSong;
        appState.bpm = savedBpm;
        window.scanImageBarlines = savedScanner;
        window.alert = savedAlert;
        renderSong();
      }
    })()`);
    assert.equal(imageUi.defaultOk, true, 'image conversion begins with the blank score template');
    assert.equal(imageUi.metadataOk, true, 'image conversion carries selected BPM, source badge, and image');
    assert.equal(imageUi.staleIgnored, true, 'late image analysis cannot mutate after song switch');
    assert.equal(imageUi.metadataPreserved, true, 'auto-detection preserves existing bar metadata');
    assert.equal(imageUi.countMismatchProtected, true, 'bar-count change refuses to overwrite manual bar metadata');
    assert.equal(imageUi.sameCountAlert, true, 'same-count auto-detection reports successful boundary estimation');
    assert.equal(imageUi.mismatchAlert, true, 'manual-data bar-count mismatch reports that it was preserved');
    process.stdout.write('Browser checkpoint: image conversion safeguards passed\n');

    await testPracticeSessionLifecycle(cdp);
    process.stdout.write('Browser checkpoint: practice session passed\n');
    await testCaptureRemovalAndAudioOffset(cdp);
    await testBackupExport(cdp);
    await testSubdividedGuide(cdp);
    await testStorageFailureRecovery(cdp);
    await testInvalidStructuredPersistence(cdp);

    await importLegacyBackup(cdp);
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.customSongs.some(function(song){ return song.id === "browser-legacy-backup-song"; }) && appState.audioOffsetMs === 180', 8000);
    const legacyBackup = await cdp.evaluate(`({ imported:customSongs.some(function(song){return song.id==='browser-legacy-backup-song';}),
      offset:appState.audioOffsetMs, micScoring:Object.prototype.hasOwnProperty.call(appState,'micScoring'),
      micDeviceId:Object.prototype.hasOwnProperty.call(appState,'micDeviceId'), captureAudit:window.__gsCaptureAudit,
      savedState:JSON.parse(localStorage.getItem('gs.state')||'{}'),
      rawHistory:localStorage.getItem('gs.history'), rawCalibration:localStorage.getItem('gs.calib') })`);
    assert.equal(legacyBackup.imported, true, 'legacy backup import restores customSongs');
    assert.equal(legacyBackup.offset, 180, 'legacy backup import preserves the manual output offset');
    assert.equal(legacyBackup.micScoring, false, 'legacy backup import does not restore removed scoring state');
    assert.equal(legacyBackup.micDeviceId, false, 'legacy backup import does not restore removed device selection');
    assert.equal(Object.prototype.hasOwnProperty.call(legacyBackup.savedState, 'micScoring'), false, 'legacy import stores a cleaned appState');
    assert.equal(Object.prototype.hasOwnProperty.call(legacyBackup.savedState, 'micDeviceId'), false, 'cleaned appState does not persist the removed device selection');
    assert.equal(legacyBackup.rawHistory, 'legacy-history-marker', 'legacy raw history storage is left untouched');
    assert.equal(legacyBackup.rawCalibration, 'legacy-calibration-marker', 'legacy raw calibration storage is left untouched');
    assert.deepEqual(legacyBackup.captureAudit, { capture:0, devices:0, worklet:0 }, 'capture APIs and AudioWorklet remain unused through backup import and reload');
    process.stdout.write('Browser checkpoint: legacy backup import cleanup and capture-free reload passed\n');

    // Test editor modal interaction in browser
    await cdp.evaluate('window.openConverterEditorModal({ title: "browser-test-song", beats: 4, rawText: "[C] C4 -/D4 - - | browser test" })');
    const modalVisible = await cdp.evaluate('!document.getElementById("newSongModal").hidden');
    assert.equal(modalVisible, true, 'editor modal opened');

    const editorBars = await cdp.evaluate('document.getElementById("veBarsGrid").children.length');
    assert.ok(editorBars > 0, 'editor bars grid rendered in DOM');

    // Close modal
    await cdp.evaluate('document.getElementById("closeNewSongBtn").click()');
    const modalHidden = await cdp.evaluate('document.getElementById("newSongModal").hidden');
    assert.equal(modalHidden, true, 'editor modal closed cleanly');

    await cdp.evaluate('window.__gsInjected = 0; window.openConverterEditorModal({ beats: 4, rawText: "[-] <img/src=x/onerror=window.__gsInjected=1>/C4 - - -" });');
    const editorTokenSafety = await cdp.evaluate('({ images: document.querySelectorAll("#veBarsGrid img").length, raw: document.getElementById("nsMeasuresTxt").value, diagnostic: document.getElementById("scoreValidationStatus").textContent, injected: window.__gsInjected })');
    assert.equal(editorTokenSafety.images, 0, 'invalid editor token does not create preview image elements');
    assert.ok(editorTokenSafety.raw.includes('<img'), 'invalid editor source remains literal in the textarea');
    assert.match(editorTokenSafety.diagnostic, /알 수 없는 음표 토큰/, 'invalid editor token receives a validation error');
    assert.notEqual(editorTokenSafety.injected, 1, 'editor token cannot execute injected markup');
    await cdp.evaluate('document.getElementById("closeNewSongBtn").click()');

    // 1. Verify TAB mode does not render Korean solfege and renders English pitch names (CDE)
    const tabSolfegeCount = await cdp.evaluate('document.querySelectorAll(".tab-cell-solfege").length');
    assert.equal(tabSolfegeCount, 0, "tab mode does not render Korean solfege elements");
    const tabEnCount = await cdp.evaluate('document.querySelectorAll(".tab-cell-en").length');
    assert.ok(tabEnCount > 0, "tab mode renders English pitch names (CDE)");

    // 2. Verify compact practice mode toggle
    const initialCompact = await cdp.evaluate('document.body.classList.contains("practice-compact")');
    assert.equal(initialCompact, false, "compact practice mode is initially off after boot");
    await cdp.evaluate('document.getElementById("toggleCompactBtn").click()');
    const isCompact = await cdp.evaluate('document.body.classList.contains("practice-compact")');
    assert.equal(isCompact, true, "compact practice mode activated immediately on first click");
    await cdp.evaluate('document.getElementById("toggleCompactBtn").click()');
    const isCompactRestored = await cdp.evaluate('document.body.classList.contains("practice-compact")');
    assert.equal(isCompactRestored, false, "compact practice mode toggled off successfully on second click");

    // 3. Verify youtube quick links query excludes [Lv..] tags
    const ytLinkText = await cdp.evaluate('document.querySelector("#ytQuickLinks a") ? document.querySelector("#ytQuickLinks a").textContent : ""');
    assert.ok(ytLinkText.length > 0, "youtube quick links rendered");
    assert.equal(ytLinkText.includes("[Lv"), false, "youtube search query excludes [Lv..] tags");

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.BUILTIN_SONGS.length === 14 && window.customSongs.some(function(song){ return song.title === "browser storage failure"; })', 8000);
    const screenshotDir = path.join(__dirname, '..', 'test-artifacts');
    let screenshotTarget = path.join(screenshotDir, 'beginner-rhythm-review.png');
    if (fs.existsSync(screenshotTarget)) screenshotTarget = path.join(screenshotDir, 'beginner-rhythm-review-' + Date.now() + '.png');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate(`(function(){
      var parsed = parseScore('[C] C4 - - 1E4\\n[G] - r 0E2+1C4 -', 4);
      window.curSong = { id:'beginner-rhythm-review', title:'Beginner rhythm review', type:'structured', beats:4, bpm:80, measures:parsed.measures };
      appState.scoreView = 'tab';
      appState.beats = 4;
      appState.bpm = 80;
      window.curMeasureIdx = 0;
      window.curBeatIdx = 0;
      renderSong();
      return true;
    })()`);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(screenshotTarget), { recursive: true });
    fs.writeFileSync(screenshotTarget, Buffer.from(screenshot.data, 'base64'));
    const imageHeader = fs.readFileSync(screenshotTarget).subarray(0, 24);
    assert.equal(imageHeader.readUInt32BE(16), 1280, 'review screenshot is 1280px wide');
    assert.equal(imageHeader.readUInt32BE(20), 900, 'review screenshot is 900px tall');
    process.stdout.write('Artifact: ' + screenshotTarget + '\n');
    process.stdout.write('Browser checkpoint: reload persistence, Web Audio boot, and 1280x900 screenshot passed\n');

    // Verify no unhandled console errors occurred
    assert.deepEqual(cdp.consoleErrors, [], 'no unhandled console errors in real browser execution');

    process.stdout.write('Result: browser Headless Chrome smoke passed (clean boot, songs loaded, DOM rendered, modal interaction, 0 console errors)\n');
  } finally {
    if (cdp) cdp.close();
    chromeProc.kill();
    server.close();
    try {
      fs.rmSync(tempProfileDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch(err => {
  console.error('Browser smoke test failed:', err);
  process.exitCode = 1;
});
