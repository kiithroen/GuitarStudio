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
    async function renderRomance(engine, hall, guideEvents){
      appState.acousticFx=hall; appState.bodyAmount=0; appState.sympAmount=0; appState.synthEngine=engine;
      var rate=48000, ctx=new OfflineAudioContext(2,rate*6,rate); ctx.resume=function(){ return Promise.resolve(); };
      window.actx=ctx; window.outGain=null; window.clickBus=null; window.guitarBus=null;
      window.dryGainNode=null; window.wetGainNode=null; window.reverbNode=null; window.bodyModes=[];
      window.trackedGuideVoices=[]; window.stringVoices={}; ensureAudioCtx();
      dryGainNode.gain.value=0.88; wetGainNode.gain.value=hall?CONCERT_HALL_WET_GAIN:0;
      guideEvents.forEach(function(event){
        playGuitarNote(event.note.midi,event.duration,event.when,event.gain,event.articulation,event.str,{exactDuration:true});
      });
      var buffer=await ctx.startRendering(), peak=0, sum=0, count=0;
      for(var i=0;i<buffer.length;i++){
        var left=buffer.getChannelData(0)[i], right=buffer.getChannelData(1)[i];
        peak=Math.max(peak,Math.abs(left),Math.abs(right));
        if(i>=Math.floor(0.1*rate)&&i<Math.floor(4.5*rate)){var mono=(left+right)*0.5;sum+=mono*mono;count++;}
      }
      return {engine:engine,fx:hall?'hall':'dry',peak:peak,rms:Math.sqrt(sum/count),eventCount:guideEvents.length};
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
      var lv6=allSongs.find(function(song){return song.id==='builtin-lv6-romance-full';});
      if(!lv6 || !lv6.measures || !lv6.measures[0]) throw new Error('Lv.6 Romance built-in score is unavailable for offline rendering');
      var lv6SlotDuration=60/Number(lv6.bpm || 56), lv6Events=[];
      lv6.measures[0].beats.forEach(function(beat,index){
        lv6Events=lv6Events.concat(getBeatGuideEvents(beat,{startTime:0.1+index*lv6SlotDuration,slotDuration:lv6SlotDuration,measures:lv6.measures}));
      });
      var lv6Renders=[];
      for(var engine of ['ks','classic']) for(var hallMode of [false,true]){
        lv6Renders.push(await renderRomance(engine,hallMode,lv6Events));
      }
      result.lv6FirstMeasure={id:lv6.id,bpm:lv6.bpm,events:lv6Events.map(function(event){return {
        midi:event.note.midi,when:event.when,duration:event.duration,gain:event.gain,articulation:event.articulation,str:event.str
      };}),renders:lv6Renders};
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
  assert.equal(render.lv6FirstMeasure.id, 'builtin-lv6-romance-full', 'offline render uses the actual Lv.6 built-in score');
  assert.equal(render.lv6FirstMeasure.events.length, 10, 'Lv.6 first measure guide emits bass, melody, and inner voice notes');
  assert.deepEqual(render.lv6FirstMeasure.events.slice(0, 2).map(function(event){return [event.midi,event.gain,event.articulation,event.str];}),
    [[40,0.62,'tirando',6],[71,1.16,'apoyando',1]], 'Lv.6 opening bass and melody retain their written articulation and strings');
  assert.ok(render.lv6FirstMeasure.renders.length === 4 && render.lv6FirstMeasure.renders.every(function(item){return item.peak < 1 && item.rms > 0 && item.eventCount === 10;}),
    'actual Lv.6 first measure renders audible, unclipped KS/classic dry/hall audio');
  const artifact = path.join(root, 'test-artifacts', 'audio-release-check-' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(artifact), { recursive:true });
  fs.writeFileSync(artifact, JSON.stringify({ sampleRateHz:48000, peakDefinition:'max absolute sample across stereo channels',
    rmsDefinition:'RMS of stereo channel average; natural tail window 1.01-1.8s after a note starting at 0.1s with 0.5s duration',
    gain:render.gain, wetTailRatio:render.tailRatio, chords:render.chords, matrix:render.matrix,
    dryTailRms:render.dry.tailRms, hallTailRms:render.hall.tailRms, forcedCutoffStopAt:render.forced.sourceStops[0],
    forcedClassicStops:render.forcedClassic.sourceStops, forcedClassicLateRms:render.forcedClassic.lateRms,
    forcedPostCutoffRms:render.forced.lateRms, lv6FirstMeasure:render.lv6FirstMeasure }, null, 2) + '\n');
  process.stdout.write('Artifact: ' + artifact + '\n');
  process.stdout.write('Browser checkpoint: OfflineAudioContext natural releases, KS/classic hard cutoff, 12 KS/classic duration/FX cases, isolated hall tail, 12 valid six-string Em/F chord renders, and four actual Lv.6 first-measure renders passed (wet tail ratio ' + render.tailRatio.toFixed(4) + ', max chord peak ' + Math.max.apply(null,render.chords.map(function(chord){return chord.peak;})).toFixed(4) + ')\n');
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
    var textSong = buildStructuredSong({ id:'browser-legacy-backup-text', title:'Legacy text song', badge:'Custom', capo:3, bpm:84, beats:4, lines:['[C] C4 - - -'] });
    var imageSong = { id:'browser-legacy-backup-image', title:'Legacy image song', type:'image', imageDataUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', pdfPages:['data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='], curPageIdx:0, systems:[{ x:0.1,y:0.1,w:0.8,h:0.2,bars:[{ chord:'C',note:'C4',memo:'legacy image',w:1 }] }] };
    var backup = { version:1, exportedAt:'2026-10-19T00:00:00.000Z', customSongs:[textSong,imageSong], history:[{ sentinel:'old-backup-score' }], calib:{ lat:0.123, calibrated:true }, appState:{ bpm:84, audioOffsetMs:180, micScoring:true, micDeviceId:'removed-device', guideSound:true } };
    var file = new File([JSON.stringify(backup)], 'legacy-backup.json', { type:'application/json' });
    var transfer = new DataTransfer(); transfer.items.add(file);
    var input = document.getElementById('importFileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
    return true;
  })()`);
}
async function testBackupExport(client) {
  const result = await client.evaluate(`(async function(){
    var db = await openDB();
    await new Promise(function(resolve,reject){
      var tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put({ id:'browser-hidden-legacy-text', title:'legacy text', type:'structured', measures:[] });
      tx.oncomplete = resolve; tx.onerror = tx.onabort = function(){ reject(tx.error || new Error('fixture seed failed')); };
    });
    await dbSaveImageSong({ id:'browser-backup-image', title:'backup image', type:'image', imageDataUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', pdfPages:['data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='], curPageIdx:0, systems:[] });
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
        appStateKeys:Object.keys(payload.appState || {}), songs:Array.isArray(payload.customSongs), songTypes:(payload.customSongs || []).map(function(song){return song.type;}),
        hasImage:(payload.customSongs || []).some(function(song){return song.id==='browser-backup-image';}), hasLegacyText:(payload.customSongs || []).some(function(song){return song.id==='browser-hidden-legacy-text';}) };
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
  assert.ok(result.songTypes.length >= 1 && result.songTypes.every(type => type === 'image'), 'backup export includes only image records from mixed IndexedDB');
  assert.equal(result.hasImage, true, 'backup export includes image and PDF metadata records');
  assert.equal(result.hasLegacyText, false, 'backup export omits legacy structured IndexedDB rows');
  assert.ok(!result.appStateKeys.includes('micScoring') && !result.appStateKeys.includes('micDeviceId'), 'removed microphone settings are not re-exported');
  process.stdout.write('Checks: legacy-compatible backup export shape 8\n');
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

      var pimaSubdivisionScore = parseScore('[C] E4@1:i/F4@1:m - - -', 4);
      window.curSong = { id:'browser-guide-pima-subdivision', title:'Pima subdivision', type:'structured', beats:4, measures:pimaSubdivisionScore.measures };
      renderSong();
      timers.length = 0;
      window.playSession = { inCountIn:false, nextBeatTime:9, spb:0.6, bpb:4, bIdx:0, mIdx:0, loopCompleted:0, endScheduled:false };
      window.isPlaying = true;
      window.actx.currentTime = 8.95;
      schedulerTick();
      var pimaUiTimers = timers.slice().sort(function(a, b){ return a.delay - b.delay; });
      check(pimaUiTimers.length >= 2, 'scheduler queues the note and later subdivision fretboard updates');
      pimaUiTimers[0].fn();
      check(document.getElementById('guideRhTxt').textContent === 'i (검지)', 'first scheduled subdivision shows its explicit right-hand finger');
      pimaUiTimers[pimaUiTimers.length - 1].fn();
      check(document.getElementById('guideRhTxt').textContent === 'm (중지)', 'later scheduled subdivision updates the fretboard right-hand finger');

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

      var explicitRightHandText = '[C] !1C4@2:i E4@1:a+C3@5:p C3@5:p+E4@1 E4@1:i/F4@1:m';
      var explicitRightHandScore = parseScore(explicitRightHandText, 4);
      window.curSong = { id:'browser-explicit-right-hand', title:'Explicit right hand', type:'structured', beats:4, measures:explicitRightHandScore.measures };
      appState.scoreView = 'tab';
      renderSong();
      function rightHandPills(beatIndex){
        var cell = document.querySelector('#measuresGrid .beat-cell[data-b="' + beatIndex + '"]');
        return Array.prototype.slice.call(cell.querySelectorAll('.tab-note-rh')).map(function(span){ return span.textContent; });
      }
      var actualPimaPills = [0,1,2,3].map(function(index){ return rightHandPills(index).join(','); });
      check(actualPimaPills.join('|') === 'i|p,a|p|i,m', 'TAB note-on pills show explicit pima by source component for single notes, MIDI-sorted chords, partial chords, and subdivisions: ' + JSON.stringify(actualPimaPills));
      updateActiveCursor(0, 0, false);
      check(document.getElementById('guideRhTxt').textContent === 'i (검지)', 'single-note fretboard guide shows the written right-hand finger and name');
      updateActiveCursor(0, 1, false);
      check(document.getElementById('guideRhTxt').textContent === '오른손 운지: 5줄 p (엄지) + 1줄 a (약지)', 'fretboard guide maps MIDI-sorted chord fingers to their written strings');
      appState.scoreView = 'card';
      renderSong();
      var pimaCard = document.querySelector('#measuresGrid .beat-cell[data-b="1"]');
      check(pimaCard.querySelector('.b-right-hand').textContent === '오른손 5줄 p + 1줄 a', 'beat card shows MIDI-sorted chord fingers and strings');
      var partialPimaCard = document.querySelector('#measuresGrid .beat-cell[data-b="2"]');
      check(partialPimaCard.querySelector('.b-right-hand').textContent === '오른손 5줄 p + 1줄 미지정', 'beat card identifies a chord component without written right-hand fingering');
      var dividedPimaCard = document.querySelector('#measuresGrid .beat-cell[data-b="3"]');
      check(dividedPimaCard.querySelector('.b-right-hand').textContent === '오른손 i / m', 'beat card lists right-hand fingers in subdivision order');
      var mixedSubHandScore = parseScore('[C] E4@1:i/C3@5+F4@1 - - -', 4);
      window.curSong = { id:'browser-mixed-sub-hand', title:'Mixed subdivision hand', type:'structured', beats:4, measures:mixedSubHandScore.measures };
      appState.scoreView = 'card';
      renderSong();
      var mixedSubHandCard = document.querySelector('#measuresGrid .beat-cell[data-b="0"]');
      check(mixedSubHandCard.querySelector('.b-right-hand').textContent === '오른손 i / -', 'subdivided chord part with no explicit fingers is shown as a dash');
      var noSubHandScore = parseScore('[C] C3@5+E4@1/F4@2+G4@3 - - -', 4);
      window.curSong = { id:'browser-no-sub-hand', title:'No subdivision hand', type:'structured', beats:4, measures:noSubHandScore.measures };
      renderSong();
      check(!document.querySelector('#measuresGrid .beat-cell[data-b="0"] .b-right-hand'), 'subdivisions with no explicit right-hand fingers have no card label');
      var pimaTsv = formatSongToSheetTsv('Pima roundtrip', 4, 64, 'badge', explicitRightHandScore.measures);
      check(pimaTsv.indexOf('!1C4@2:i E4@1:a+C3@5:p C3@5:p+E4@1 E4@1:i/F4@1:m') >= 0, 'TSV serialization keeps articulation, chord, partial, and subdivision pima suffixes');
      var holdRightHandScore = parseScore('[C] C4:i - - -', 4);
      window.curSong = { id:'browser-right-hand-hold', title:'Right hand hold', type:'structured', beats:4, measures:holdRightHandScore.measures };
      appState.scoreView = 'tab';
      renderSong();
      check(rightHandPills(1).length === 0, 'hold ghost pill has no right-hand finger marker');

      window.curSong = sourceSong;
      renderSong();
      updateActiveCursor(0, 1, false);
      var activePair = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-m="0"][data-b="1"] .tab-fret-pill')).map(function(p){ var style = getComputedStyle(p); return [style.color, style.backgroundColor, style.borderColor].join('|'); });
      check(activePair.length === 2 && activePair[0] === activePair[1] && activePair[0] !== tabPairs[0].styles[0], 'active pair pills share the same active foreground, background, and border styles');
      appState.scoreView = 'card';
      renderSong();
      var pairCard = document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="1"]');
      check(pairCard.querySelector('.b-ko-main').textContent === '솔·도' && pairCard.querySelector('.b-note-sub').textContent === 'G3+C4', 'beat card shows both pair solfege and octave names');
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

async function capturePimaScreenshots(client) {
  const original = await client.evaluate(`({ id:curSong && curSong.id, view:appState.scoreView })`);
  await client.evaluate(`(function(){
    var parsed = parseScore('[C] !1C4@2:i E4@1:a+C3@5:p C3@5:p+E4@1 E4@1:i/F4@1:m', 4);
    window.curSong = { id:'browser-pima-screenshot', title:'Explicit right hand', type:'structured', beats:4, measures:parsed.measures };
    appState.scoreView = 'tab';
    renderSong();
    var score = document.getElementById('structuredScoreWrap');
    if (score) score.scrollIntoView({ block:'start' });
  })()`);
  const screenshotDir = path.join(__dirname, '..', 'test-artifacts');
  fs.mkdirSync(screenshotDir, { recursive:true });
  const prefix = 'explicit-pima-' + process.pid + '-' + Date.now();
  const outputs = [];
  for (const viewport of [{ width:1280, height:900, label:'desktop' }, { width:390, height:844, label:'mobile' }]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width:viewport.width, height:viewport.height, deviceScaleFactor:1, mobile:viewport.width < 500 });
    const image = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    const target = path.join(screenshotDir, prefix + '-' + viewport.label + '.png');
    fs.writeFileSync(target, Buffer.from(image.data, 'base64'));
    outputs.push(target);
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false });
  await client.evaluate(`(function(){ if (window.changeSongById) changeSongById(${JSON.stringify(original.id)}); appState.scoreView = ${JSON.stringify(original.view)}; renderSong(); })()`);
  process.stdout.write('Pima screenshots: ' + outputs.join(' ; ') + '\n');
}

async function captureBuiltinRomanceScreenshots(client, browserBin){
  const screenshotDir = path.join(__dirname, '..', 'test-artifacts');
  fs.mkdirSync(screenshotDir, { recursive:true });
  const browserName = path.basename(browserBin, path.extname(browserBin)).toLowerCase();
  const timestamp = Date.now();
  const outputs = [];
  try {
    for (const viewport of [{ width:1280, height:900, label:'desktop' }, { width:390, height:844, label:'mobile' }]) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width:viewport.width, height:viewport.height, deviceScaleFactor:1, mobile:viewport.width < 500
      });
      await client.evaluate(`(function(){
        var score=document.getElementById('structuredScoreWrap');
        if(score) score.scrollIntoView({block:'start'});
      })()`);
      const pillBounds = await client.evaluate(`(function(){
        var markers=Array.from(document.querySelectorAll('#measuresGrid .tab-fret-pill.note-fret, #measuresGrid .tab-note-rh'));
        var failures=[];
        markers.forEach(function(marker){
          var cell=marker.closest('.tab-cell'), stave=marker.closest('.tab-stave-wrap');
          if(!cell||!stave){failures.push({reason:'missing-container',className:marker.className});return;}
          var bounds=marker.getBoundingClientRect(), cellBounds=cell.getBoundingClientRect(), staveBounds=stave.getBoundingClientRect();
          if(bounds.left<cellBounds.left-1||bounds.right>cellBounds.right+1||bounds.left<staveBounds.left-1||bounds.right>staveBounds.right+1){
            failures.push({className:marker.className,left:bounds.left,right:bounds.right,cellLeft:cellBounds.left,cellRight:cellBounds.right,staveLeft:staveBounds.left,staveRight:staveBounds.right});
          }
        });
        return {count:markers.length,failures:failures};
      })()`);
      assert.ok(pillBounds.count>0, 'Lv.6 score renders fret pills and explicit right-hand markers');
      assert.deepEqual(pillBounds.failures, [], 'TAB fret pills and right-hand markers fit within their beat cells and stave');
      const image = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
      const target = path.join(screenshotDir, 'builtin-romance-' + browserName + '-' + viewport.label + '-' + timestamp + '.png');
      fs.writeFileSync(target, Buffer.from(image.data, 'base64'));
      outputs.push(target);
    }
  } finally {
    await client.send('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false });
  }
  process.stdout.write('Built-in Lv.6 Romance screenshots: ' + outputs.join(' ; ') + '\n');
}

async function testBuiltinScores(client, browserBin){
  const restoreKey = '__gsBuiltinScoreReviewRestore_' + process.pid;
  await client.evaluate(`(function(){
    var key=${JSON.stringify(restoreKey)};
    window[key]={song:curSong,state:Object.assign({},appState),measure:window.curMeasureIdx,beat:window.curBeatIdx,scrollX:window.scrollX,scrollY:window.scrollY};
  })()`);
  try {
    const review = await client.evaluate(`(function(){
      if(!Array.isArray(window.BUILTIN_SONGS)||window.BUILTIN_SONGS.length!==13) throw new Error('Expected the 13-song built-in catalog');
      if(window.BUILTIN_SONGS.some(function(song){return /arirang|아리랑/i.test(song.id+' '+song.title+' '+song.badge);})) throw new Error('Arirang must not be present in built-in song options');
      var results=[];
      window.BUILTIN_SONGS.forEach(function(builtin){
        var song=window.allSongs.find(function(candidate){return candidate.id===builtin.id;});
        if(!song) throw new Error('Built-in score missing from loaded songs: '+builtin.id);
        if(song.type!=='structured') throw new Error('Built-in score is not structured: '+builtin.id);
        var validation=validateScore(serializeScoreMeasures(builtin.measures,'\\n'),builtin.beats);
        if(validation.errors.length) throw new Error('Built-in score validation failed: '+builtin.id+' '+JSON.stringify(validation.errors));
        changeSongById(builtin.id);
        ['tab','card'].forEach(function(view){
          appState.scoreView=view;
          renderSong();
          var grid=document.getElementById('measuresGrid');
          var cards=grid?grid.querySelectorAll('.measure-card'):[];
          var wrapper=document.getElementById('structuredScoreWrap');
          var hasNotes=view==='tab'
            ? !!(grid&&grid.querySelector('.tab-fret-pill.note-fret'))
            : !!(grid&&grid.querySelector('.beat-cell .b-note-sub'));
          if(cards.length!==song.measures.length) throw new Error('Rendered measure count mismatch: '+builtin.id+' '+view+' '+cards.length+'/'+song.measures.length);
          if(!hasNotes) throw new Error('Rendered score has no note content: '+builtin.id+' '+view);
          if(!wrapper||!wrapper.classList.contains(view==='tab'?'tab-view-active':'card-view-active')) throw new Error('Score view did not render: '+builtin.id+' '+view);
          results.push({id:builtin.id,view:view,measures:cards.length,hasNotes:hasNotes,errors:validation.errors.length});
        });
      });
      changeSongById('builtin-lv6-romance-full');
      appState.scoreView='tab';
      var romance=window.allSongs.find(function(song){return song.id==='builtin-lv6-romance-full';});
      if(!romance) throw new Error('Lv.6 Romance built-in score is missing');
      if(romance.beats!==3||Number(romance.bpm)!==56) throw new Error('Lv.6 Romance meter or tempo mismatch');
      var slotDuration=1;
      var sourceScore=serializeScoreMeasures(romance.measures,'\\n');
      function guideSignature(){
        var signature=[];
        romance.measures[0].beats.forEach(function(beat,index){
          getBeatGuideEvents(beat,{startTime:index*slotDuration,slotDuration:slotDuration,measures:romance.measures}).forEach(function(event){
            signature.push([event.note.midi,event.when,event.duration,event.articulation]);
          });
        });
        return signature;
      }
      var sourceGuide=guideSignature();
      renderSong();
      var first=romance.measures[0];
      if(!first||first.beats.length!==3||!first.beats.every(function(beat){return beat.subNotes&&beat.subNotes.length===3;})) throw new Error('Lv.6 first measure must have three beats split into three notes');
      var firstMeasure=document.querySelector('#measuresGrid .measure-card[data-m="0"]');
      var fingers=firstMeasure?Array.from(firstMeasure.querySelectorAll('.tab-note-rh')).map(function(node){return node.textContent;}):[];
      if(fingers.slice(0,4).join('/')!=='p/a/m/i') throw new Error('Lv.6 first measure TAB does not show explicit p/a/m/i: '+fingers.join('/'));
      var tabCells=[0,1,2].map(function(index){return document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="'+index+'"]');});
      var tabLabels=tabCells.map(function(cell){return cell&&cell.querySelector('.tab-cell-en')?cell.querySelector('.tab-cell-en').textContent:null;});
      var tabTitles=tabCells.map(function(cell){return cell?cell.title:'';});
      var tabRhBadges=tabCells.map(function(cell){return !!(cell&&cell.querySelector('.tab-cell-rh'));});
      if(serializeScoreMeasures(romance.measures,'\\n')!==sourceScore||JSON.stringify(guideSignature())!==JSON.stringify(sourceGuide)) throw new Error('Lv.6 TAB rendering changed serialized score or guide event semantics');

      appState.scoreView='card';
      renderSong();
      var cardCells=[0,1,2].map(function(index){return document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="'+index+'"]');});
      var cardLabels=cardCells.map(function(cell){return cell&&cell.querySelector('.b-note-sub')?cell.querySelector('.b-note-sub').textContent:null;});
      var cardTitles=cardCells.map(function(cell){return cell?cell.title:'';});
      var cardArticulationClasses=cardCells.map(function(cell){return !!(cell&&(cell.classList.contains('arp-melody')||cell.classList.contains('arp-sub')));});
      if(serializeScoreMeasures(romance.measures,'\\n')!==sourceScore||JSON.stringify(guideSignature())!==JSON.stringify(sourceGuide)) throw new Error('Lv.6 card rendering changed serialized score or guide event semantics');
      appState.scoreView='tab';
      renderSong();
      if(serializeScoreMeasures(romance.measures,'\\n')!==sourceScore||JSON.stringify(guideSignature())!==JSON.stringify(sourceGuide)) throw new Error('Lv.6 restored TAB rendering changed serialized score or guide event semantics');

      var events=[];
      first.beats.forEach(function(beat,index){
        events=events.concat(getBeatGuideEvents(beat,{startTime:index*slotDuration,slotDuration:slotDuration,measures:romance.measures}));
      });
      var expectedTimes=[0,0,1/3,2/3,1,4/3,5/3,2,7/3,8/3];
      if(events.length!==10) throw new Error('Lv.6 first measure must produce 10 guide note events, got '+events.length);
      events.forEach(function(event,index){
        if(Math.abs(event.when-expectedTimes[index])>1e-9) throw new Error('Lv.6 guide event is not at the expected third-beat onset: '+index+' '+event.when);
      });
      if(events.filter(function(event){return event.note.midi===40;}).length!==1||
        events.filter(function(event){return event.note.midi===71;}).length!==3||
        events.filter(function(event){return event.note.midi!==40&&event.note.midi!==71;}).length!==6) throw new Error('Lv.6 bass/melody/inner note counts are not 1/3/6');
      if(events[0].note.midi!==40||events[0].gain!==0.62||events[0].articulation!=='tirando'||
        events[1].note.midi!==71||events[1].gain!==1.16||events[1].articulation!=='apoyando') throw new Error('Lv.6 opening bass/melody articulation or gain mismatch');
      var cardTitleHasPartArticulation=cardTitles[0].indexOf('E2~+B4! · B3~ · G3~')>=0&&cardTitles[1].indexOf('B4! · B3~ · G3~')>=0;
      var cardTitleHasUniformArticulation=cardTitles.some(function(title){return title.indexOf('악보 지정 아포얀도(!)')>=0||title.indexOf('악보 지정 티란도(~)')>=0;});
      var score=document.getElementById('structuredScoreWrap');
      if(score) score.scrollIntoView({block:'start'});
      return {catalogCount:window.BUILTIN_SONGS.length,rendered:results,romance:{id:romance.id,bpm:romance.bpm,beats:romance.beats,
        firstMeasureBeats:first.beats.length,subdivisionCounts:first.beats.map(function(beat){return beat.subNotes.length;}),
        fingers:fingers.slice(0,4),tabLabels:tabLabels,tabTitles:tabTitles,tabRhBadges:tabRhBadges,
        cardLabels:cardLabels,cardTitles:cardTitles,cardArticulationClasses:cardArticulationClasses,
        cardTitleHasPartArticulation:cardTitleHasPartArticulation,cardTitleHasUniformArticulation:cardTitleHasUniformArticulation,
        serializationPreserved:serializeScoreMeasures(romance.measures,'\\n')===sourceScore,
        guidePreserved:JSON.stringify(guideSignature())===JSON.stringify(sourceGuide),
        guideEvents:events.map(function(event){return {midi:event.note.midi,when:event.when,gain:event.gain,
          articulation:event.articulation,str:event.str,duration:event.duration};})}};
    })()`);
    assert.equal(review.catalogCount, 13, 'all built-in scores are reviewed');
    assert.equal(review.rendered.length, 26, 'each built-in score renders in tab and card views');
    assert.ok(review.rendered.every(function(item){return item.measures>0&&item.hasNotes&&item.errors===0;}), 'built-in score DOM and validation are clean');
    assert.equal(review.romance.bpm, 56, 'Lv.6 Romance tempo is 56');
    assert.equal(review.romance.beats, 3, 'Lv.6 Romance uses three beats per measure');
    assert.deepEqual(review.romance.subdivisionCounts, [3,3,3], 'all first-measure beats use three subdivisions');
    assert.deepEqual(review.romance.fingers, ['p','a','m','i'], 'first measure TAB shows explicit p/a/m/i fingers');
    assert.deepEqual(review.romance.tabLabels, ['E~+B!·B~·G~','B!·B~·G~','B!·B~·G~'], 'TAB labels show each Lv.6 note articulation independently');
    assert.ok(review.romance.tabTitles[0].includes('E2~+B4! · B3~ · G3~'), 'first TAB title shows the bass, melody, and inner-note techniques');
    assert.deepEqual(review.romance.tabRhBadges, [false,false,false], 'TAB articulation marks are included in pitch labels without old end badges');
    assert.deepEqual(review.romance.cardLabels, ['E2~+B4! · B3~ · G3~','B4! · B3~ · G3~','B4! · B3~ · G3~'], 'card labels show each Lv.6 note articulation independently');
    assert.ok(review.romance.cardTitleHasPartArticulation, 'card tooltip shows each pitch articulation');
    assert.equal(review.romance.cardTitleHasUniformArticulation, false, 'mixed articulation tooltip does not assign one technique to the whole beat');
    assert.deepEqual(review.romance.cardArticulationClasses, [false,false,false], 'mixed articulation card beats have no uniform apo/tir class');
    assert.equal(review.romance.serializationPreserved, true, 'TAB/card rendering leaves serialized built-in score unchanged');
    assert.equal(review.romance.guidePreserved, true, 'TAB/card rendering leaves pitch, time, duration, and articulation guide events unchanged');
    assert.equal(review.romance.guideEvents.length, 10, 'first measure produces 10 guide note events');
    process.stdout.write('Browser checkpoint: all 13 built-in scores render in TAB/card; Lv.6 Romance first measure has explicit p/a/m/i and 10 timed guide notes\n');
    await captureBuiltinRomanceScreenshots(client,browserBin);
  } finally {
    await client.evaluate(`(function(){
      var key=${JSON.stringify(restoreKey)},saved=window[key];
      if(!saved) return;
      if(saved.song) window.curSong=saved.song;
      Object.keys(appState).forEach(function(name){if(!Object.prototype.hasOwnProperty.call(saved.state,name)) delete appState[name];});
      Object.keys(saved.state).forEach(function(name){appState[name]=saved.state[name];});
      window.curMeasureIdx=saved.measure; window.curBeatIdx=saved.beat;
      if(window.curSong){renderSong();saveAppState();}
      window.scrollTo(saved.scrollX,saved.scrollY);
      delete window[key];
    })()`);
  }
}

async function testStorageFailureRecovery(client) {
  const result = await client.evaluate(`(async function(){
    var openSheet = document.getElementById('openSheetSyncBtn');
    openSheet.click();
    var opened = !document.getElementById('sheetSyncModal').hidden;
    document.getElementById('closeSheetSyncBtn').click();
    var closed = document.getElementById('sheetSyncModal').hidden;
    var song = imageSongs[0];
    if (!song) throw new Error('expected image uploaded in prior lifecycle test');
    var oldSave = window.dbSaveImageSong;
    var originalChord = song.systems[0].bars[0].chord;
    changeSongById(song.id);
    window.selectedImgBar = { sysIdx:0, barIdx:0, globalIdx:0 };
    document.getElementById('editBarMetaBtn').click();
    document.getElementById('beChord').value = 'G';
    window.dbSaveImageSong = function(){ return Promise.reject(new Error('Injected image storage failure')); };
    document.getElementById('saveBarEditBtn').click();
    await new Promise(function(resolve){ setTimeout(resolve, 30); });
    var failedPreserves = song.systems[0].bars[0].chord === originalChord && !document.getElementById('barEditModal').hidden && !document.getElementById('storageStatus').hidden;
    window.dbSaveImageSong = oldSave;
    document.getElementById('saveBarEditBtn').click();
    for (var i=0; i<100 && song.systems[0].bars[0].chord !== 'G'; i++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
    var retrySaved = song.systems[0].bars[0].chord === 'G' && document.getElementById('barEditModal').hidden;
    changeSongById(song.id);
    window.confirm = function(){ return true; };
    document.getElementById('deleteSongBtn').click();
    for (var deleteWait=0; deleteWait<100 && imageSongs.some(function(item){ return item.id === song.id; }); deleteWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
    var deleted = !imageSongs.some(function(item){ return item.id === song.id; });
    window.dbSaveImageSong = oldSave;
    return { opened:opened, closed:closed, failedPreserves:failedPreserves, retrySaved:retrySaved, deleted:deleted };
  })()`);
  assert.deepEqual(result, { opened:true, closed:true, failedPreserves:true, retrySaved:true, deleted:true }, 'image save failure preserves edits for retry, delete works, and Sheets modal wiring remains live');
  process.stdout.write('Checks: image storage recovery, delete, and sheet wiring 5\n');
}
async function testInvalidStructuredPersistence(client) {
  const result = await client.evaluate(`(async function(){
    var originalSong = window.curSong;
    var originalSongs = window.allSongs.slice();
    var originalState = { bpm: appState.bpm, loopStart: appState.loopStart, loopEnd: appState.loopEnd };
    var originalPlaying = window.isPlaying;
    var originalSession = window.playSession;
    var oldSave = window.dbSaveImageSong;
    var writes = [];
    try {
      var invalid = { id:'browser-invalid-readonly', title:'Invalid read-only', type:'structured', beats:4, measures:parseScore('[C] C4', 4).measures, fromSheet:true };
      var sourceToken = invalid.measures[0].beats[0].tok;
      window.allSongs.push(invalid);
      window.dbSaveImageSong = function(song){ writes.push(song.id); return Promise.resolve(true); };
      changeSongById(invalid.id);
      await startPractice();
      var blocked = window.isPlaying === false && window.playSession == null && /재생할 수 없는 악보/.test(document.getElementById('phaseTxt').textContent);
      saveAppState();
      appState.bpm = 88;
      saveAppState();
      window.isPlaying = true;
      window.playSession = {};
      stopPractice();
      return { writes:writes, blocked:blocked, textMetadata:JSON.parse(localStorage.getItem('gs.state')).bpm === 88, sourcePreserved:invalid.measures[0].beats[0].tok === sourceToken };
    } finally {
      window.dbSaveImageSong = oldSave;
      window.allSongs = originalSongs;
      window.curSong = originalSong;
      Object.keys(originalState).forEach(function(key){ appState[key] = originalState[key]; });
      window.isPlaying = originalPlaying;
      window.playSession = originalSession;
      renderSong();
    }
  })()`);
  assert.deepEqual(result.writes, [], 'invalid read-only text selection and practice settings never write IndexedDB');
  assert.equal(result.blocked, true, 'invalid read-only score playback remains blocked');
  assert.equal(result.textMetadata, true, 'app settings remain in local storage');
  assert.equal(result.sourcePreserved, true, 'invalid read-only score source remains unchanged');
  process.stdout.write('Checks: invalid read-only playback guard 4\n');
}
async function main() {
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scriptTags = [...appHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scriptTags.map(src => src.split('?')[0]), ['src/storage.js', 'src/notation.js', 'src/rhythm.js', 'src/parser.js', 'src/score.js', 'src/audio.js', 'src/guide.js', 'src/image-analysis.js', 'src/fretboard.js', 'src/score-ui.js', 'src/sheets.js', 'src/app.js'], 'app classic scripts keep the required order');
  assert.ok(scriptTags.every(src => src.endsWith('?v=note-strokes-1')), 'all app scripts use the shared note-strokes revision');
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
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.allSongs.length === 13 && window.curSong != null', 8000);

    // Assert initial app state in real browser
    const songCount = await cdp.evaluate('window.allSongs.length');
    assert.equal(songCount, 13, 'browser loaded 13 songs from songs.json');

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
    await testBuiltinScores(cdp, browserBin);
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
    const fretboardPreview = await cdp.evaluate(`(function(){
      var originalPlay = window.playGuitarNote;
      var beforeSong = curSong.id;
      var beforeToken = curSong.measures && curSong.measures[0] && curSong.measures[0].beats[0] && curSong.measures[0].beats[0].tok;
      var calls = 0;
      window.playGuitarNote = function(){ calls++; };
      var target = document.querySelector('#fretboard .fb-open[data-str="1"]') || document.querySelector('#fretboard .fb-cell[data-str="1"][data-fret="1"]');
      if (target) target.click();
      window.playGuitarNote = originalPlay;
      var afterToken = curSong.measures && curSong.measures[0] && curSong.measures[0].beats[0] && curSong.measures[0].beats[0].tok;
      return { calls:calls, sameSong:curSong.id===beforeSong, sameToken:beforeToken===afterToken };
    })()`);
    assert.deepEqual(fretboardPreview, { calls:1, sameSong:true, sameToken:true }, 'fretboard click previews a note without creating or changing a score');
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

    const literalTextSafety = await cdp.evaluate(`(function(){
      var originalSong = curSong;
      var originalView = appState.scoreView;
      window.__gsInjected = 0;
      var fixture = buildStructuredSong({ id:'readonly-literal-fixture', title:'Read only literal fixture', badge:'Sheet', beats:4, lines:['[C] C4 - - - | "<img/src=x/onerror=window.__gsInjected=1>"'] });
      fixture.fromSheet = true;
      curSong = fixture;
      function inspect(view){ appState.scoreView = view; renderSong(); return { literal:document.getElementById('measuresGrid').textContent.includes('<img/src=x/onerror=window.__gsInjected=1>'), images:document.querySelectorAll('#measuresGrid img').length, injected:window.__gsInjected }; }
      var tab = inspect('tab');
      var card = inspect('card');
      curSong = originalSong; appState.scoreView = originalView; renderSong();
      return { tab:tab, card:card };
    })()`);
    assert.deepEqual(literalTextSafety, { tab:{ literal:true, images:0, injected:0 }, card:{ literal:true, images:0, injected:0 } }, 'read-only TAB and card score rendering keeps markup literal without DOM injection');

    const removedTextUi = await cdp.evaluate(`({
      editorApi:typeof window.openConverterEditorModal,
      editorInit:typeof window.initEditor,
      promptApi:typeof window.buildAiPromptText,
      textEditor:!!document.getElementById('newSongModal'),
      imageConversion:!!document.getElementById('convertImgToScoreBtn'),
      imageUpload:!!document.getElementById('uploadImgBtn'),
      barEditor:!!document.getElementById('barEditModal')
    })`);
    assert.deepEqual(removedTextUi, { editorApi:'undefined', editorInit:'undefined', promptApi:'undefined', textEditor:false, imageConversion:false, imageUpload:true, barEditor:true }, 'text editor and AI prompt are absent while image bar editing remains');

    const imageScanSafety = await cdp.evaluate(`(async function(){
      var savedSong = curSong;
      var savedScanner = window.scanImageBarlines;
      var savedAlert = window.alert;
      var alerts = [];
      var target = { id:'browser-image-scan-safety', title:'Image scan safety', type:'image', badge:'Source badge', bpm:77, imageDataUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', systems:[{x:0.1,y:0.1,w:0.8,h:0.3,bars:[{chord:'C',note:'C4',memo:'keep',w:1,custom:'keep'}]}] };
      try {
        window.alert = function(message){ alerts.push(String(message)); };
        curSong = target; renderSong();
        var resolveScan;
        window.scanImageBarlines = function(){ return new Promise(function(resolve){ resolveScan = resolve; }); };
        document.getElementById('autoDetectBarsBtn').click();
        await new Promise(function(resolve){ setTimeout(resolve, 0); });
        var switched = { id:'browser-image-scan-switched', title:'Switched', type:'image', imageDataUrl:target.imageDataUrl, systems:[{x:0.2,y:0.2,w:0.5,h:0.2,bars:[]}] };
        curSong = switched;
        resolveScan([0.1,0.3,0.5]);
        await new Promise(function(resolve){ setTimeout(resolve, 20); });
        var staleIgnored = target.systems[0].bars.length === 1 && switched.systems[0].bars.length === 0;
        curSong = target; renderSong();
        window.scanImageBarlines = function(){ return Promise.resolve([0.1,0.9]); };
        document.getElementById('autoDetectBarsBtn').click();
        await new Promise(function(resolve){ setTimeout(resolve, 20); });
        var metadataPreserved = target.systems[0].bars.length === 1 && target.systems[0].bars[0].chord === 'C' && target.systems[0].bars[0].note === 'C4' && target.systems[0].bars[0].memo === 'keep' && target.systems[0].bars[0].custom === 'keep';
        window.scanImageBarlines = function(){ return Promise.resolve([0.1,0.3,0.6,0.9]); };
        document.getElementById('autoDetectBarsBtn').click();
        await new Promise(function(resolve){ setTimeout(resolve, 20); });
        var countMismatchProtected = target.systems[0].bars.length === 1 && target.systems[0].bars[0].chord === 'C' && target.systems[0].bars[0].note === 'C4' && target.systems[0].bars[0].memo === 'keep' && target.systems[0].bars[0].custom === 'keep';
        return { staleIgnored:staleIgnored, metadataPreserved:metadataPreserved, countMismatchProtected:countMismatchProtected,
          sameCountAlert:alerts.some(function(message){return message.indexOf('마디 영역만 추정')>=0;}), mismatchAlert:alerts.some(function(message){return message.indexOf('기존 음표·코드')>=0;}) };
      } finally { curSong = savedSong; window.scanImageBarlines = savedScanner; window.alert = savedAlert; renderSong(); }
    })()`);
    assert.deepEqual(imageScanSafety, { staleIgnored:true, metadataPreserved:true, countMismatchProtected:true, sameCountAlert:true, mismatchAlert:true }, 'image barline scan ignores stale results and preserves manual metadata');

    const imageLifecycle = await cdp.evaluate(`(async function(){
      var oldPrompt = window.prompt;
      var oldSave = window.dbSaveImageSong;
      var uploadInput = document.getElementById('fileInput');
      var bytes = Uint8Array.from(atob('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='), function(c){ return c.charCodeAt(0); });
      var file = new File([bytes], 'browser-score.gif', { type:'image/gif' });
      var transfer = new DataTransfer(); transfer.items.add(file);
      window.prompt = function(){ return 'Browser uploaded image'; };
      uploadInput.files = transfer.files;
      uploadInput.dispatchEvent(new Event('change', { bubbles:true }));
      for (var i=0; i<100 && !imageSongs.some(function(song){ return song.title === 'Browser uploaded image'; }); i++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      var song = imageSongs.find(function(item){ return item.title === 'Browser uploaded image'; });
      if (!song) throw new Error('image upload did not persist');
      changeSongById(song.id);
      window.selectedImgBar = { sysIdx:0, barIdx:0, globalIdx:0 };
      document.getElementById('editBarMetaBtn').click();
      document.getElementById('beChord').value = 'Am';
      document.getElementById('beNote').value = 'E4';
      document.getElementById('beMemo').value = 'browser memo';
      document.getElementById('saveBarEditBtn').click();
      for (var barWait=0; barWait<100 && song.systems[0].bars[0].chord !== 'Am'; barWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      var barSaved = song.systems[0].bars[0].chord === 'Am' && song.systems[0].bars[0].note === 'E4' && song.systems[0].bars[0].memo === 'browser memo';

      window.prompt = function(){ return 'Browser renamed image'; };
      document.getElementById('renameSongBtn').click();
      for (var renameWait=0; renameWait<100 && song.title !== 'Browser renamed image'; renameWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      var renamed = song.title === 'Browser renamed image';

      song.pdfPages = [song.imageDataUrl, 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='];
      song.curPageIdx = 0;
      await oldSave(song);
      renderImageScore();
      var finishSave;
      window.dbSaveImageSong = function(candidate){ return new Promise(function(resolve,reject){ finishSave = function(){ oldSave(candidate).then(resolve,reject); }; }); };
      var pagePending = document.getElementById('pdfNextBtn').click();
      for (var wait=0; wait<50 && !finishSave; wait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      if (!finishSave) throw new Error('PDF page save did not start');
      changeSongById('builtin-lv1-butterfly');
      var selectedId = curSong.id;
      finishSave();
      for (var pageWait=0; pageWait<100 && song.curPageIdx !== 1; pageWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      await pagePending;
      var storedPage = (await dbGetImageSongs()).find(function(item){ return item.id === song.id; });
      var pageRaceSafe = song.curPageIdx === 1 && song.imageDataUrl === song.pdfPages[1] && storedPage && storedPage.curPageIdx === 1 && curSong.id === selectedId;
      window.dbSaveImageSong = oldSave;
      return { uploaded:!!song, barSaved:barSaved, renamed:renamed, pageRaceSafe:pageRaceSafe };
    })()`);
    assert.deepEqual(imageLifecycle, { uploaded:true, barSaved:true, renamed:true, pageRaceSafe:true }, 'image upload, bar metadata, rename, and PDF page race pass');
    process.stdout.write('Browser checkpoint: read-only text scores and image library lifecycle passed\n');
    await testPracticeSessionLifecycle(cdp);
    process.stdout.write('Browser checkpoint: practice session passed\n');
    await testCaptureRemovalAndAudioOffset(cdp);
    await testBackupExport(cdp);
    await testSubdividedGuide(cdp);
    await capturePimaScreenshots(cdp);
    await testStorageFailureRecovery(cdp);
    await testInvalidStructuredPersistence(cdp);

    await importLegacyBackup(cdp);
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.imageSongs.some(function(song){ return song.id === "browser-legacy-backup-image"; }) && appState.audioOffsetMs === 180', 8000);
    const legacyBackup = await cdp.evaluate(`(async function(){
      var db = await openDB();
      var raw = await new Promise(function(resolve,reject){ var tx=db.transaction('songs','readonly'); var req=tx.objectStore('songs').getAll(); req.onsuccess=function(){resolve(req.result);}; req.onerror=function(){reject(req.error);}; });
      return { importedImage:imageSongs.some(function(song){return song.id==='browser-legacy-backup-image';}),
        importedText:allSongs.some(function(song){return song.id==='browser-legacy-backup-text';}), offset:appState.audioOffsetMs,
        micScoring:Object.prototype.hasOwnProperty.call(appState,'micScoring'), micDeviceId:Object.prototype.hasOwnProperty.call(appState,'micDeviceId'),
        captureAudit:window.__gsCaptureAudit, savedState:JSON.parse(localStorage.getItem('gs.state')||'{}'),
        rawHistory:localStorage.getItem('gs.history'), rawCalibration:localStorage.getItem('gs.calib'),
        legacyTextPreserved:raw.some(function(song){return song.id==='browser-hidden-legacy-text' && song.type==='structured';}),
        importedTextNotWritten:!raw.some(function(song){return song.id==='browser-legacy-backup-text';}) };
    })()`);
    assert.equal(legacyBackup.importedImage, true, 'mixed legacy backup restores image scores');
    assert.equal(legacyBackup.importedText, false, 'mixed legacy backup ignores structured text scores');
    assert.equal(legacyBackup.offset, 180, 'legacy backup import preserves the manual output offset');
    assert.equal(legacyBackup.micScoring, false, 'legacy backup import does not restore removed scoring state');
    assert.equal(legacyBackup.micDeviceId, false, 'legacy backup import does not restore removed device selection');
    assert.equal(Object.prototype.hasOwnProperty.call(legacyBackup.savedState, 'micScoring'), false, 'legacy import stores a cleaned appState');
    assert.equal(Object.prototype.hasOwnProperty.call(legacyBackup.savedState, 'micDeviceId'), false, 'cleaned appState does not persist the removed device selection');
    assert.equal(legacyBackup.rawHistory, 'legacy-history-marker', 'legacy raw history storage is left untouched');
    assert.equal(legacyBackup.rawCalibration, 'legacy-calibration-marker', 'legacy raw calibration storage is left untouched');
    assert.equal(legacyBackup.legacyTextPreserved, true, 'legacy structured IndexedDB rows remain physically untouched');
    assert.equal(legacyBackup.importedTextNotWritten, true, 'mixed backup import does not write structured text rows');
    assert.deepEqual(legacyBackup.captureAudit, { capture:0, devices:0, worklet:0 }, 'capture APIs and AudioWorklet remain unused through backup import and reload');
    process.stdout.write('Browser checkpoint: image-only backup import cleanup and capture-free reload passed\n');

    const removedApis = await cdp.evaluate(`({ editor:typeof window.openConverterEditorModal, initEditor:typeof window.initEditor, aiPrompt:typeof window.buildAiPromptText,
      editorDom:!!document.getElementById('newSongModal'), converter:!!document.getElementById('convertImgToScoreBtn') })`);
    assert.deepEqual(removedApis, { editor:'undefined', initEditor:'undefined', aiPrompt:'undefined', editorDom:false, converter:false }, 'removed text editor and image-to-text UI stay absent after import/reload');
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
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.BUILTIN_SONGS.length === 13 && window.imageSongs.some(function(song){ return song.id === "browser-backup-image"; })', 8000);
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

    process.stdout.write('Result: browser Headless Chrome smoke passed (clean boot, songs loaded, read-only rendering, image library, Web Audio, 0 console errors)\n');
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
