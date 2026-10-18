(function(root, factory){
  const alphaTab = typeof module === 'object' && module.exports
    ? require('../vendor/alphatab/dist/alphaTab.min.js')
    : root.alphaTab;
  const api = factory(alphaTab, root.document && root.document.currentScript ? root.document.currentScript.src : null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TabEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(alphaTab, engineScriptUrl){
  'use strict';

  if (!alphaTab) throw new Error('alphaTab 1.8.4 must be loaded before TabEngine');
  const { ScoreLoader } = alphaTab.importer;

  function parseAlphaTex(text){
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(String(text), new alphaTab.Settings());
    let score;
    let parseError = null;
    try {
      score = importer.readScore();
    } catch (error) {
      parseError = error;
    }
    const bags = [importer.lexerDiagnostics, importer.parserDiagnostics, importer.semanticDiagnostics];
    if (bags.some(bag => bag && bag.hasErrors)) {
      const diagnostics = bags.flatMap(bag => bag && Array.isArray(bag.items) ? bag.items : []);
      throw new Error(diagnostics.map(item => {
        const location = item.start ? `(${item.start.line}:${item.start.col}) ` : '';
        return `${location}${item.message || `AlphaTex error ${item.code}`}`;
      }).join('\n'));
    }
    if (parseError) throw parseError;
    return score;
  }

  function toBytes(value){
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value instanceof Uint8Array) return value;
    throw new TypeError('bytes must be a Uint8Array or ArrayBuffer');
  }

  function exportGp(score){
    return new alphaTab.exporter.Gp7Exporter().export(score, new alphaTab.Settings());
  }

  function findBarTicks(score, tickCache, barNumber){
    const bar = score.tracks[0]?.staves[0]?.bars[barNumber - 1];
    if (!bar) throw new RangeError('Loop bar is outside the score');
    const entries = tickCache.masterBars.filter(item => item.masterBar === bar.masterBar);
    if (!entries.length) throw new RangeError('The requested bar is missing from the alphaTab playback tick cache');
    return { start: entries[0].start, end: entries[entries.length - 1].end };
  }

  function create(element, callbacks){
    callbacks = callbacks || {};
    const emit = (name, value) => { if (typeof callbacks[name] === 'function') callbacks[name](value); };
    if (!engineScriptUrl) throw new Error('TabEngine must be loaded from a script file to resolve vendored alphaTab assets');
    const assetRoot = new URL('../vendor/alphatab/dist/', engineScriptUrl).href;
    const settings = {
      core: { scriptFile: assetRoot + 'alphaTab.min.js', fontDirectory: assetRoot + 'font/', engine: 'svg' },
      player: {
        enablePlayer: true,
        soundFont: assetRoot + 'soundfont/sonivox.sf2',
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        enableElementHighlighting: true,
        scrollElement: element.parentElement
      },
      display: { staveProfile: 'tab' },
      notation: { rhythmMode: alphaTab.TabRhythmMode.ShowWithBeams }
    };
    const api = new alphaTab.AlphaTabApi(element, settings);
    let score = null;
    let requestSequence = 0;
    let activeSequence = 0;
    let midiReady = false;
    let activeLoad = null;
    let loadQueue = Promise.resolve();
    let guideSound = true;
    let loopRange = null;
    let speed = 100;
    let volume = 1;
    let metronome = true;
    let lastPosition = { barIndex: 0, beatIndex: 0 };
    let destroyed = false;
    const unsubscriptions = [];
    const isCurrent = event => !destroyed && midiReady && !!score && activeSequence === requestSequence && api.score === score && (!event || !event.score || event.score === score);

    unsubscriptions.push(api.postRenderFinished.on(() => {
      if (!activeLoad) return;
      activeLoad.renderReady = true;
      completeLoadIfReady(activeLoad);
    }));
    unsubscriptions.push(api.playerReady.on(() => {
      if (!activeLoad) return;
      activeLoad.playerReady = true;
      applyPlayerPreferences();
      completeLoadIfReady(activeLoad);
    }));
    unsubscriptions.push(api.playerStateChanged.on(event => {
      if (isCurrent(event)) emit('onState', event.state === alphaTab.synth.PlayerState.Playing);
    }));
    unsubscriptions.push(api.playedBeatChanged.on(beat => {
      if (!isCurrent() || !score.tracks.includes(beat.voice.bar.staff.track)) return;
      emit('onBeat', beat);
      try {
        const bar = beat.voice.bar;
        const track = beat.voice.bar.staff.track;
        lastPosition = { barIndex: track.staves[0].bars.indexOf(bar), beatIndex: beat.voice.beats.indexOf(beat) };
      } catch (_) {}
    }));
    unsubscriptions.push(api.playerPositionChanged.on(event => {
      if (!isCurrent(event)) return;
      emit('onPosition', {
        currentTime: event.currentTime,
        endTime: event.endTime,
        currentTick: event.currentTick,
        barIndex: lastPosition.barIndex,
        beatIndex: lastPosition.beatIndex
      });
    }));
    unsubscriptions.push(api.error.on(error => {
      if (activeLoad) activeLoad.fail(error);
      else if (isCurrent(error)) emit('onError', error);
    }));
    emit('onReady', false);

    const controller = {
      api,
      getScore: () => score,
      loadSong(song){
        if (destroyed) return Promise.resolve(null);
        let next;
        try {
          next = song && song.format === 'alphatex'
            ? parseAlphaTex(song.alphaTex)
            : song && song.format === 'binary'
              ? ScoreLoader.loadScoreFromBytes(toBytes(song.bytes))
              : (() => { throw new TypeError('song.format must be alphatex or binary'); })();
        } catch (error) {
          return Promise.reject(error);
        }
        const sequence = ++requestSequence;
        midiReady = false;
        emit('onReady', false);
        const operation = loadQueue.then(async () => {
          if (destroyed || sequence !== requestSequence) return null;
          return startLoad(sequence, next);
        });
        loadQueue = operation.catch(error => {
          if (!destroyed && sequence === requestSequence) emit('onError', error);
          return null;
        });
        return operation;
      },
      play(){ if (!midiReady) return false; return api.play(); },
      pause(){ api.pause(); },
      stop(){ api.stop(); },
      setSpeed(percent){ if (!Number.isFinite(percent) || percent < 25 || percent > 200) throw new RangeError('speed must be 25..200'); speed = percent; api.playbackSpeed = percent / 100; },
      setVolume(value){ if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('volume must be 0..1'); volume = value; api.masterVolume = value; },
      setGuideSound(enabled){ guideSound = !!enabled; if (score) api.changeTrackMute(score.tracks, !guideSound); },
      setMetronome(enabled){ metronome = !!enabled; api.metronomeVolume = metronome ? 1 : 0; },
      setLoop(startBar, endBar, enabled){
        if (!enabled){ loopRange = null; api.isLooping = false; api.playbackRange = null; return; }
        if (!Number.isInteger(startBar) || !Number.isInteger(endBar) || startBar < 1 || endBar < startBar) throw new RangeError('invalid loop bar range');
        if (score && endBar > score.masterBars.length) throw new RangeError('loop bar is outside the score');
        loopRange = { startBar, endBar };
        api.isLooping = true;
        if (midiReady) applyLoop();
      },
      seekBar(bar){
        if (!Number.isInteger(bar) || bar < 1) throw new RangeError('bar must be a positive integer');
        if (!api.tickCache) throw new Error('The alphaTab playback tick cache is not ready');
        const bounds = findBarTicks(score, api.tickCache, bar);
        api.tickPosition = bounds.start;
      },
      destroy(){
        if (destroyed) return;
        destroyed = true;
        ++requestSequence;
        midiReady = false;
        if (activeLoad) activeLoad.finish(null);
        for (const unsubscribe of unsubscriptions.splice(0)) unsubscribe();
        api.destroy();
      }
    };
    function startLoad(sequence, nextScore){
      activeSequence = sequence;
      score = nextScore;
      lastPosition = { barIndex: 0, beatIndex: 0 };
      api.stop();
      api.playbackRange = null;
      api.isLooping = false;
      if (loopRange && loopRange.endBar > score.masterBars.length) loopRange = null;
      return new Promise((resolve, reject) => {
        let settled = false;
        const waiter = {
          sequence,
          settled: false,
          renderReady: false,
          playerReady: false,
          timer: null,
          fail(error){
            if (activeLoad === waiter && activeSequence === sequence) midiReady = false;
            this.finish(error);
          },
          finish(error, result = null){
            if (settled) return;
            settled = true;
            waiter.settled = true;
            clearTimeout(waiter.timer);
            if (activeLoad === waiter) activeLoad = null;
            if (error) reject(error);
            else resolve(result);
          },
          complete(){
            try {
              if (destroyed || sequence !== requestSequence) {
                this.finish(null, null);
                return;
              }
              midiReady = true;
              applyPlayerPreferences();
              if (loopRange) applyLoop();
              emit('onScore', score);
              if (destroyed || sequence !== requestSequence) {
                midiReady = false;
                this.finish(null, null);
                return;
              }
              emit('onReady', true);
              this.finish(null, !destroyed && sequence === requestSequence ? score : null);
            } catch (error) {
              this.fail(error);
            }
          }
        };
        activeLoad = waiter;
        waiter.timer = setTimeout(() => waiter.fail(new Error('alphaTab load did not finish rendering and preparing playback within 30 seconds')), 30000);
        try {
          const accepted = api.load(score);
          if (!waiter.settled) applyPlayerPreferences();
          if (accepted === false) waiter.fail(new Error('alphaTab rejected the score load'));
          completeLoadIfReady(waiter);
        } catch (error) {
          waiter.fail(error);
        }
      });
    }
    function completeLoadIfReady(waiter){
      if (waiter !== activeLoad || waiter.settled || !waiter.renderReady || !waiter.playerReady) return;
      waiter.complete();
    }
    function applyLoop(){
      const start = findBarTicks(score, api.tickCache, loopRange.startBar);
      const end = findBarTicks(score, api.tickCache, loopRange.endBar);
      api.playbackRange = { startTick: start.start, endTick: end.end };
      api.isLooping = true;
    }
    function applyPlayerPreferences(){
      api.playbackSpeed = speed / 100;
      api.masterVolume = volume;
      api.metronomeVolume = metronome ? 1 : 0;
      if (score) api.changeTrackMute(score.tracks, !guideSound);
    }
    return controller;
  }

  return {
    parseAlphaTex,
    importBytes(bytes){ return ScoreLoader.loadScoreFromBytes(toBytes(bytes)); },
    toAlphaTex(score){ return new alphaTab.exporter.AlphaTexExporter().exportToString(score, new alphaTab.Settings()); },
    exportGp,
    getBeatNotes(beat){
      if (!beat || !Array.isArray(beat.notes)) return [];
      const stringCount = beat.voice && beat.voice.bar && beat.voice.bar.staff && beat.voice.bar.staff.tuning
        ? beat.voice.bar.staff.tuning.length
        : 6;
      return beat.notes.filter(note => note.isStringed).map(note => {
        const left = note.leftHandFinger;
        const right = note.rightHandFinger;
        const fingers = alphaTab.model.Fingers;
        return {
          str: stringCount - note.string + 1,
          fret: note.fret,
          midi: note.realValue,
          lh: left === fingers.Thumb ? 'T' : left >= fingers.IndexFinger && left <= fingers.LittleFinger ? left : null,
          rh: right === fingers.Thumb ? 'p' : right === fingers.IndexFinger ? 'i' : right === fingers.MiddleFinger ? 'm' : right === fingers.AnnularFinger ? 'a' : right === fingers.LittleFinger ? 'c' : null
        };
      });
    },
    create
  };
});
