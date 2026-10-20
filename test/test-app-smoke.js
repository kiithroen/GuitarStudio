const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MockElement {
  constructor(tagName, id){
    this.tagName = tagName.toUpperCase();
    this.id = id || '';
    this.children = [];
    this.listeners = Object.create(null);
    this.dataset = {};
    this.attributes = {};
    this._className = '';
    this.style = { setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; } };
    this.classList = {
      values: new Set(),
      add: (...xs) => xs.forEach(x => this.classList.values.add(x)),
      remove: (...xs) => xs.forEach(x => this.classList.values.delete(x)),
      contains: x => this.classList.values.has(x),
      toggle: (x, force) => {
        const on = force === undefined ? !this.classList.values.has(x) : !!force;
        if (on) this.classList.values.add(x); else this.classList.values.delete(x);
        return on;
      }
    };
    this.value = '';
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.scrollTop = 0;
    this.clientHeight = 600;
    this.clientWidth = 1000;
    this.offsetHeight = 100;
    this.offsetWidth = 1000;
    this.files = [];
    this._textContent = '';
    this._innerHTML = '';
  }
  set textContent(value){ this._textContent = String(value == null ? '' : value); this.children = []; }
  get textContent(){ return this._textContent; }
  set className(value){ this._className = String(value || ''); this.classList.values = new Set(this._className.split(/\s+/).filter(Boolean)); }
  get className(){ return this._className; }
  set innerHTML(value){ this._innerHTML = String(value == null ? '' : value); this.children = []; }
  get innerHTML(){ return this._innerHTML; }
  get options(){ return this.children; }
  get firstElementChild(){ return this.children[0] || null; }
  get lastElementChild(){ return this.children[this.children.length - 1] || null; }
  getBoundingClientRect(){ return { top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600 }; }
  addEventListener(type, fn){ (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn){ this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn); }
  async dispatch(type, event = {}){
    event.target ||= this;
    event.currentTarget = this;
    event.stopPropagation ||= function(){ event.cancelBubble = true; };
    event.preventDefault ||= function(){ event.defaultPrevented = true; };
    const results = await Promise.all((this.listeners[type] || []).map(fn => fn(event)));
    if (!event.cancelBubble && this.parentNode) await this.parentNode.dispatch(type, event);
    return results;
  }
  appendChild(child){ if (child){ child.parentNode = this; child.parentElement = this; this.children.push(child); } return child; }
  append(...children){ children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children){ this.children = []; this.textContent = ''; children.forEach(child => this.appendChild(child)); }
  setAttribute(name, value){ this.attributes[name] = String(value); }
  getAttribute(name){ return this.attributes[name] == null ? null : this.attributes[name]; }
  removeAttribute(name){ delete this.attributes[name]; }
  querySelector(selector){ return queryTree(this, selector)[0] || null; }
  querySelectorAll(selector){ return queryTree(this, selector); }
  closest(){ return null; }
  matches(){ return false; }
  focus(){}
  blur(){}
  setSelectionRange(){}
  click(){ return this.dispatch('click'); }
  remove(){ if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  scrollIntoView(){}
  getContext(){ return { clearRect(){}, fillRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, fillText(){}, measureText(){ return { width: 8 }; } }; }
}

const root = process.cwd();
const songCount = JSON.parse(fs.readFileSync(path.join(root, 'songs.json'), 'utf8')).length;
const elements = new Map();
const makeElement = (tag, id) => new MockElement(tag, id);
function queryTree(node, selector){
  if (!node || !selector) return [];
  const match = selector[0] === '.' ? node.classList.contains(selector.slice(1))
    : selector[0] === '#' ? node.id === selector.slice(1)
    : false;
  const found = match ? [node] : [];
  for (const child of node.children || []) found.push(...queryTree(child, selector));
  return found;
}
const document = {
  readyState: 'complete',
  body: makeElement('body'),
  head: makeElement('head'),
  documentElement: makeElement('html'),
  createElement(tag){ return makeElement(tag); },
  createElementNS(ns, tag){ return makeElement(tag); },
  createTextNode(text){ const el = makeElement('#text'); el.textContent = text; return el; },
  createDocumentFragment(){ return makeElement('#fragment'); },
  getElementById(id){ return this.querySelector('#' + id); },
  querySelector(selector){
    if (!selector || selector.charAt(0) !== '#') return null;
    const id = selector.slice(1);
    if (!elements.has(id)) elements.set(id, makeElement('div', id));
    return elements.get(id);
  },
  querySelectorAll(selector){
    if (selector && selector[0] === '.'){
      const roots = [this.body, this.head, this.documentElement, ...elements.values()];
      return [...new Set(roots.flatMap(node => queryTree(node, selector)))];
    }
    return [];
  },
  addEventListener(){},
  removeEventListener(){},
  contains(){ return true; }
};

const localValues = new Map();
const songStore = new Map();
let copiedText = '';
let promptResponse = '';
let failNextTransaction = false;
const idb = {
  open(){
    const request = {};
    const db = {
      objectStoreNames: { contains(){ return true; } },
      createObjectStore(){},
      transaction(){
        let staged = new Map();
        let deletes = new Set();
        const tx = {
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore(){
            return {
              getAll(){
                const req = {};
                setTimeout(() => { req.result = [...songStore.values()]; if (req.onsuccess) req.onsuccess(); }, 0);
                return req;
              },
              put(song){
                const req = {};
                staged.set(song.id, song);
                setTimeout(() => { req.result = song.id; if (req.onsuccess) req.onsuccess(); }, 0);
                return req;
              },
              delete(id){
                const req = {};
                deletes.add(id);
                setTimeout(() => { req.result = undefined; if (req.onsuccess) req.onsuccess(); }, 0);
                return req;
              }
            };
          }
        };
        setTimeout(() => {
          if (failNextTransaction){
            failNextTransaction = false;
            tx.error = new Error('Injected transaction abort');
            if (tx.onabort) tx.onabort({ target: tx });
            return;
          }
          for (const id of deletes) songStore.delete(id);
          for (const [id, song] of staged){
            songStore.set(id, song);
          }
          if (tx.oncomplete) tx.oncomplete({ target: tx });
        }, 10);
        return tx;
      }
    };
    setTimeout(() => {
      if (request.onupgradeneeded) request.onupgradeneeded({ target: { result: db } });
      if (request.onsuccess) request.onsuccess({ target: { result: db } });
    }, 0);
    return request;
  }
};
const sandbox = {
  console,
  document,
  indexedDB: idb,
  localStorage: {
    getItem(key){ return localValues.has(key) ? localValues.get(key) : null; },
    setItem(key, value){ localValues.set(key, String(value)); },
    removeItem(key){ localValues.delete(key); }
  },
  navigator: { clipboard: { async writeText(text){ copiedText = text; } } },
  fetch: async input => ({ ok: true, async json(){ return JSON.parse(fs.readFileSync(path.join(root, String(input).replace(/^\.\//, '')), 'utf8')); } }),
  requestAnimationFrame(){ return 0; },
  cancelAnimationFrame(){},
  getComputedStyle(){ return { getPropertyValue(){ return ''; } }; },
  alert(){}, confirm(){ return true; }, prompt(){ return promptResponse; },
  Blob, URL, Map, Set, Date, Math, Promise, Intl,
  setTimeout, clearTimeout, setInterval(){ return 0; }, clearInterval(){},
  innerWidth: 1200,
  innerHeight: 800,
  devicePixelRatio: 1,
  addEventListener(){},
  removeEventListener(){},
  matchMedia(){ return { matches: false, addListener(){}, addEventListener(){} }; }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
const context = vm.createContext(sandbox);

async function waitFor(predicate, timeoutMs = 2000){
  const deadline = Date.now() + timeoutMs;
  while (!predicate()){
    if (Date.now() >= deadline) throw new Error('Timed out waiting for app boot');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function testUnavailableIndexedDbBoot(html){
  const unavailableElements = new Map();
  const unavailableDocument = Object.assign({}, document, {
    getElementById(id){ return this.querySelector('#' + id); },
    querySelector(selector){
      if (!selector || selector.charAt(0) !== '#') return null;
      const id = selector.slice(1);
      if (!unavailableElements.has(id)) unavailableElements.set(id, makeElement('div', id));
      return unavailableElements.get(id);
    }
  });
  const unavailableSandbox = {
    ...sandbox,
    document: unavailableDocument,
    indexedDB: { open(){ throw new Error('IndexedDB unavailable'); } },
    localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} }
  };
  unavailableSandbox.window = unavailableSandbox;
  unavailableSandbox.self = unavailableSandbox;
  const unavailableContext = vm.createContext(unavailableSandbox);
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1].split('?')[0]);
  for (const script of scripts){
    vm.runInContext(fs.readFileSync(path.join(root, script), 'utf8'), unavailableContext, { filename: script });
  }
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await waitFor(() => unavailableContext.allSongs.length === songCount && unavailableContext.curSong != null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(unavailableContext.allSongs.length, songCount, 'built-in songs render when IndexedDB is unavailable');
    assert.ok(unavailableElements.get('measuresGrid').children.length > 0, 'built-in score renders when IndexedDB is unavailable');
    assert.equal(unavailableElements.get('storageStatus').hidden, false, 'unavailable IndexedDB displays storage guidance');
    assert.equal(unhandled.length, 0, 'unavailable IndexedDB causes no unhandled rejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

// 저장된 scoreView 정규화: 네 값은 유지하고 그 밖은 tab
function testScoreViewNormalization(){
  function loadedView(saved){
    const store = { 'gs.state': JSON.stringify(saved) };
    const sb = {
      console, document: {}, Math, JSON, Date, Promise, Object, Array, Number, String, Map, Set,
      localStorage: { getItem(key){ return key in store ? store[key] : null; }, setItem(){}, removeItem(){} }
    };
    sb.window = sb;
    const ctx = vm.createContext(sb);
    for (const script of ['src/storage.js', 'src/app-state.js']) vm.runInContext(fs.readFileSync(path.join(root, script), 'utf8'), ctx, { filename: script });
    return vm.runInContext('appState.scoreView', ctx);
  }
  for (const view of ['tab', 'both', 'staff', 'card']) assert.equal(loadedView({ scoreView: view }), view, 'saved scoreView ' + view + ' survives a reload');
  assert.equal(loadedView({ scoreView: 'xyz' }), 'tab', 'an unknown scoreView falls back to tab');
  assert.equal(loadedView({}), 'tab', 'a missing scoreView falls back to tab');
}

async function main(){
  testScoreViewNormalization();
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  document.querySelector('#storageStatus');
  const scriptTags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  const scripts = scriptTags.map(src => src.split('?')[0]);
  assert.deepEqual(scripts, ['src/storage.js', 'src/app-state.js', 'src/notation.js', 'src/rhythm.js', 'src/parser.js', 'src/staff-layout.js', 'src/staff-svg.js', 'src/score-drafts.js', 'src/score.js', 'src/audio.js', 'src/guide.js', 'src/image-analysis.js', 'src/fretboard.js', 'src/score-ui.js', 'src/sheets.js', 'src/score-prompt.js', 'src/score-editor.js', 'src/app.js']);
  assert.ok(scriptTags.every(src => src.endsWith('?v=nylon-sf-1')), 'every app script uses the shared revision');
  for (const id of ['editInInputBtn', 'resetScoreDraftBtn', 'scoreDraftStatus', 'copyCurSongTsvBtn']){
    assert.match(html, new RegExp('id="' + id + '"'), 'draft UI includes #' + id);
  }
  for (const id of ['addBlankScoreBtn', 'blankScoreModal', 'undoScoreEditBtn']){
    assert.doesNotMatch(html, new RegExp('id="' + id + '"'), 'removed in-page editing UI has no #' + id);
  }
  assert.doesNotMatch(html, /score-measure-menu|score-inline-editor|scoreMeasureText/);
  assert.doesNotMatch(html, /newTextSongBtn|editStructuredBtn|convertImgToScoreBtn|ocrModalFileInput|refImgDetails|refScoreImg|newSongModal|veBarsGrid/);
  for (const script of scripts){
    const source = fs.readFileSync(path.join(root, script), 'utf8');
    vm.runInContext(source, context, { filename: script });
  }
  await waitFor(() => context.allSongs.length === songCount && context.curSong != null);
  await testUnavailableIndexedDbBoot(html);
  assert.equal(context.allSongs.length, songCount, 'songs.json loads through app boot');
  assert.equal(context.curSong.id, 'builtin-lv1-butterfly', 'saved/default built-in song is selected');
  assert.equal(elements.get('fretboard').children.length, 7, 'fretboard renders six strings and one header');
  assert.ok(elements.get('measuresGrid').children.length > 0, 'selected score renders measures');
  assert.equal(typeof context.parseScore, 'function', 'parser API remains available to built-in and sheet scores');
  assert.equal(typeof context.scoreEditorHooks, 'object', 'temporary score editor integration hooks are available');
  assert.equal(context.appState.clickMode, 'all', 'click mode defaults to all on a clean boot');
  assert.equal(typeof context.initEditor, 'undefined', 'removed editor bootstrap is absent');
  assert.equal(typeof context.openConverterEditorModal, 'undefined', 'removed text editor API is absent');
  assert.equal(typeof context.buildAiPromptText, 'undefined', 'removed AI prompt API is absent');

  const savedPractice = {
    song: context.curSong,
    measure: context.curMeasureIdx,
    beat: context.curBeatIdx,
    actx: context.actx,
    ensureAudioCtx: context.ensureAudioCtx,
    playGuitarNote: context.playGuitarNote,
    stopGuitarNotes: context.stopGuitarNotes,
    appState: { bpm: context.appState.bpm, beats: context.appState.beats, loopStart: context.appState.loopStart,
      loopEnd: context.appState.loopEnd, loopEnable: context.appState.loopEnable, guideSound: context.appState.guideSound }
  };
  try {
    context.changeSongById('builtin-lv6-romance-full');
    const romance = context.curSong;
    const romanceText = context.serializeScoreMeasures(romance.measures, '\n');
    const reparsedRomance = context.parseScore(romanceText, romance.beats);
    assert.equal(reparsedRomance.errors.length, 0, 'simple beat and subdivision notation round-trips through the common parser');
    assert.doesNotMatch(romanceText, /\*\d/, 'built-in score serialization has no per-note length syntax');
    const firstBeat = romance.measures[0].beats[0];
    const bass = firstBeat.subNotes[0].chordNotes.find(note => note.midi === 40);
    const melody = firstBeat.subNotes[0].chordNotes.find(note => note.midi === 71);
    const openingPart = firstBeat.subNotes[0];
    assert.equal(Object.hasOwn(bass, 'explicitDurationSlots') || Object.hasOwn(bass, 'startUnits') || Object.hasOwn(bass, 'durationUnits'), false,
      'Romance bass has no removed per-component duration metadata');
    assert.equal(Object.hasOwn(melody, 'explicitDurationSlots') || Object.hasOwn(melody, 'startUnits') || Object.hasOwn(melody, 'durationUnits'), false,
      'Romance melody has no removed per-component duration metadata');
    assert.equal(openingPart.durationUnits, openingPart.slotUnits, 'Romance opening chord uses its shared subdivision duration');
    const roundTripBass = reparsedRomance.measures[0].beats[0].subNotes[0].chordNotes.find(note => note.midi === 40);
    assert.equal(Object.hasOwn(roundTripBass, 'durationUnits'), false, 'serialized score restores the bass without per-note duration metadata');
    assert.equal(reparsedRomance.measures[0].beats[0].subNotes[0].durationUnits, openingPart.durationUnits,
      'serialized score recomputes the shared chord duration from its subdivision');

    const removedLengthSyntax = context.parseScore('[C] 0E2@6:p*3 - -', 3);
    assert.ok(removedLengthSyntax.errors.length > 0, 'removed per-note length syntax is rejected instead of upgraded');

    const slotDuration = 60 / Number(romance.bpm);
    const previewCalls = [];
    context.actx = { currentTime: 30 };
    context.ensureAudioCtx = function(){};
    context.stopGuitarNotes = function(){};
    context.playGuitarNote = function(midi, duration, when, gain, articulation, str, options){
      previewCalls.push({ midi, duration, when, gain, articulation, str, options });
    };
    context.appState.guideSound = true;
    context.appState.bpm = romance.bpm;
    context.appState.beats = romance.beats;
    context.appState.loopStart = 1;
    context.appState.loopEnd = romance.measures.length;
    context.updateActiveCursor(0, 0, true);
    const previewBass = previewCalls.find(event => event.midi === 40);
    const previewMelody = previewCalls.find(event => event.midi === 71);
    const sharedDuration = openingPart.durationUnits / context.GuitarRhythm.UNITS_PER_SLOT * slotDuration;
    assert.equal(previewBass.duration, sharedDuration, 'app preview schedules the bass for its shared chord subdivision duration');
    assert.equal(previewMelody.duration, sharedDuration, 'app preview schedules the melody for the same shared chord duration');
    assert.equal(previewBass.when, previewMelody.when, 'chord components preserve their shared attack');
    assert.deepEqual([previewBass.midi, previewBass.articulation, previewBass.str], [bass.midi, null, 6],
      'app preview keeps the written bass pitch and string, with no articulation mark');
    assert.deepEqual([previewMelody.midi, previewMelody.articulation, previewMelody.str], [melody.midi, 'apoyando', 1],
      'app preview keeps the written melody pitch, articulation, and string');
    assert.equal(previewBass.options.naturalDecay, true, 'structured app preview requests the natural sound lifetime');
    assert.equal(previewMelody.options.naturalDecay, true, 'structured app preview requests natural decay for every chord component');
    assert.equal(previewBass.options.exactDuration, undefined, 'structured app preview does not use the legacy exact-duration gate');
    assert.ok(Number.isFinite(previewBass.options.hardStopAt), 'structured app preview still carries its loop or song hard stop');

    const openingPartSlots = openingPart.durationUnits / context.GuitarRhythm.UNITS_PER_SLOT;
    const clipSlots = openingPartSlots / 2;
    const clipped = context.getBeatGuideEvents(firstBeat, {
      startTime: 0, slotDuration, measures: romance.measures, maxDurationSlots: clipSlots
    });
    assert.equal(clipped.find(event => event.note.midi === 40).duration, clipSlots * slotDuration,
      'guide event clips its shared chord duration at a shorter loop boundary');
  } finally {
    context.curSong = savedPractice.song;
    context.curMeasureIdx = savedPractice.measure;
    context.curBeatIdx = savedPractice.beat;
    context.actx = savedPractice.actx;
    context.ensureAudioCtx = savedPractice.ensureAudioCtx;
    context.playGuitarNote = savedPractice.playGuitarNote;
    context.stopGuitarNotes = savedPractice.stopGuitarNotes;
    Object.assign(context.appState, savedPractice.appState);
    context.renderSong();
  }

  // 빈칸 _ : 재생 스케줄러가 빈칸 칸에서 클릭·가이드음을 예약하지 않고 시간도 더하지 않는다
  const savedSkip = {
    song: context.curSong, measure: context.curMeasureIdx, beat: context.curBeatIdx, actx: context.actx,
    playing: context.isPlaying, session: context.playSession,
    scheduleMetronomeClick: context.scheduleMetronomeClick, playGuitarNote: context.playGuitarNote,
    stopGuitarNotes: context.stopGuitarNotes, highlightFretboard: context.highlightFretboard, ensureAudioCtx: context.ensureAudioCtx,
    appState: { bpm: context.appState.bpm, beats: context.appState.beats, loopStart: context.appState.loopStart, loopEnd: context.appState.loopEnd,
      loopEnable: context.appState.loopEnable, guideSound: context.appState.guideSound, clickMode: context.appState.clickMode }
  };
  try {
    const skipParsed = context.parseScore('[-] _ _ _ E4\n[Am] G4 - _ _\n[C] A4 B4 C5 D5', 4);
    assert.equal(skipParsed.errors.length, 0, 'the skip-cell score parses without errors');
    const skipSong = { id: 'skip-test', title: '빈칸 시험', type: 'structured', builtin: false, bpm: 120, beats: 4, capo: 0, measures: skipParsed.measures, notationVersion: 2 };
    const clicks = [];
    const noteCalls = [];
    context.scheduleMetronomeClick = function(time, accent){ clicks.push({ time, accent }); };
    context.playGuitarNote = function(midi, duration, when, gain, articulation, str, options){ noteCalls.push({ midi, duration, when, hardStopAt: options && options.hardStopAt }); };
    context.stopGuitarNotes = function(){};
    context.highlightFretboard = function(){};
    context.ensureAudioCtx = function(){};
    context.curSong = skipSong;
    context.actx = { currentTime: 0, outputLatency: 0.02, baseLatency: 0.01 };
    Object.assign(context.appState, { bpm: 120, beats: 4, loopStart: 1, loopEnd: 3, loopEnable: false, guideSound: true, clickMode: 'all' });
    const spb = 0.5;
    const session = { inCountIn: false, nextBeatTime: 1, measureStartTime: 1, spb, bpb: 4, bIdx: 0, mIdx: 0, loopCompleted: 0, endScheduled: false, resumeNextHold: true };
    context.playSession = session;
    context.isPlaying = true;
    for (let guard = 0; guard < 40 && !session.endScheduled; guard++){
      context.actx.currentTime = session.nextBeatTime - 0.01;
      context.schedulerTick();
    }
    assert.equal(session.endScheduled, true, 'a score that starts on skip cells still reaches its end');
    assert.deepEqual(clicks.map(click => click.time), [0, 1, 2, 3, 4, 5, 6].map(i => 1 + i * spb), 'seven playable cells click on consecutive cell times; the five skip cells add no time');
    assert.deepEqual(clicks.map(click => click.accent), [false, true, false, true, false, false, false], 'a pickup does not click an accent; the first real cell of a measure that starts on a note does');
    assert.deepEqual(noteCalls.map(call => [call.when, call.duration]), [[1, 0.5], [1.5, 1], [2.5, 0.5], [3, 0.5], [3.5, 0.5], [4, 0.5]], 'notes start on their real cell times and the hold lasts only the cells that take time');
    assert.equal(session.nextBeatTime, 1 + 7 * spb, 'the session clock moved only for the playable cells');
    for (const call of noteCalls) assert.equal(call.hardStopAt, 1 + 7 * spb, 'the remaining length to the song end leaves out the skip cells');

    // 정지 상태 미리듣기: 빈칸 칸은 소리 없이 지나가고 다음 칸의 유지가 이어 울린다
    noteCalls.length = 0;
    context.appState.guideSound = true;
    context.updateActiveCursor(0, 1, true);
    assert.equal(noteCalls.length, 0, 'clicking a skip cell previews no sound');
    context.updateActiveCursor(1, 0, true);
    assert.deepEqual(noteCalls.map(call => call.midi), [context.parseNoteToken('G4', 0).midi], 'the first real cell previews its note');

    // 화면: 빈칸 칸은 slot-skip 클래스를 달고 음 표시가 없다
    context.renderSong();
    const skipCells = elements.get('measuresGrid').querySelectorAll('.beat-cell').filter(cell => cell.classList.contains('slot-skip'));
    assert.equal(skipCells.length, 5, 'every skip cell is drawn with the slot-skip class');
    assert.equal(skipCells[0].querySelectorAll('.tab-fret-pill').length + skipCells[0].querySelectorAll('.tab-rest-dash').length, 0, 'a skip cell draws no fret and no rest mark');
  } finally {
    context.curSong = savedSkip.song;
    context.curMeasureIdx = savedSkip.measure;
    context.curBeatIdx = savedSkip.beat;
    context.actx = savedSkip.actx;
    context.isPlaying = savedSkip.playing;
    context.playSession = savedSkip.session;
    context.scheduleMetronomeClick = savedSkip.scheduleMetronomeClick;
    context.playGuitarNote = savedSkip.playGuitarNote;
    context.stopGuitarNotes = savedSkip.stopGuitarNotes;
    context.highlightFretboard = savedSkip.highlightFretboard;
    context.ensureAudioCtx = savedSkip.ensureAudioCtx;
    Object.assign(context.appState, savedSkip.appState);
    context.renderSong();
  }

  const scoreMode = elements.get('scoreViewSelect');
  assert.equal(scoreMode.hidden, false, 'score view select is available for structured songs');
  const chooseScoreView = async view => { scoreMode.value = view; await scoreMode.dispatch('change'); };
  await chooseScoreView('both');
  assert.equal(context.appState.scoreView, 'both', 'both view updates saved app settings');
  await chooseScoreView('staff');
  assert.equal(context.appState.scoreView, 'staff', 'staff view updates saved app settings');
  await chooseScoreView('card');
  assert.equal(context.appState.scoreView, 'card', 'card view updates saved app settings');
  await chooseScoreView('tab');
  assert.equal(context.appState.scoreView, 'tab', 'TAB view remains selectable');
  assert.equal(scoreMode.value, 'tab', 'the select follows the saved view');

  const image = { id:'vm-image', title:'VM image', type:'image', imageDataUrl:'data:image/png;base64,AA==', pdfPages:['data:image/png;base64,AA==','data:image/png;base64,AQ=='], curPageIdx:0, systems:[{ x:0.1,y:0.1,w:0.8,h:0.2,bars:[{ chord:'C',note:'C4',memo:'old',w:1 }] }] };
  const originalImageSave = context.dbSaveImageSong;
  const originalImageDelete = context.dbDeleteImageSong;
  context.imageSongs = [image];
  context.allSongs.push(image);
  context.curSong = image;
  const originalUpdateActiveCursor = context.updateActiveCursor;
  context.updateActiveCursor = function(){};
  context.selectedImgBar = { sysIdx:0, barIdx:0, globalIdx:0 };
  await elements.get('editBarMetaBtn').click();
  elements.get('beChord').value = 'Am';
  elements.get('beNote').value = 'E4';
  elements.get('beMemo').value = 'new';
  context.dbSaveImageSong = async () => { throw new Error('Injected image save failure'); };
  await elements.get('saveBarEditBtn').click();
  assert.equal(elements.get('barEditModal').hidden, false, 'failed image metadata save leaves the edit modal open');
  assert.equal(image.systems[0].bars[0].chord, 'C', 'failed image metadata save preserves the original bar');
  context.dbSaveImageSong = originalImageSave;
  await elements.get('saveBarEditBtn').click();
  assert.equal(image.systems[0].bars[0].memo, 'new', 'retry persists and applies image bar metadata');

  elements.get('beMemo').value = 'race update';
  let finishBarSave;
  context.dbSaveImageSong = candidate => new Promise(resolve => { finishBarSave = () => originalImageSave(candidate).then(resolve); });
  const pendingBarSave = elements.get('saveBarEditBtn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  context.changeSongById('builtin-lv1-butterfly');
  finishBarSave();
  await pendingBarSave;
  assert.equal(context.curSong.id, 'builtin-lv1-butterfly', 'late image metadata save does not replace a newly selected score');
  assert.equal(image.systems[0].bars[0].memo, 'race update', 'late image metadata save updates the originally edited image');

  context.changeSongById(image.id);
  let promptResponse = 'VM renamed image';
  const oldPrompt = context.prompt;
  context.prompt = () => promptResponse;
  context.dbSaveImageSong = async () => { throw new Error('Injected image rename failure'); };
  await elements.get('renameSongBtn').click();
  assert.equal(image.title, 'VM image', 'failed image rename preserves its original title');
  context.dbSaveImageSong = originalImageSave;
  let finishRename;
  context.dbSaveImageSong = candidate => new Promise(resolve => { finishRename = () => originalImageSave(candidate).then(resolve); });
  const pendingRename = elements.get('renameSongBtn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  context.changeSongById('builtin-lv1-butterfly');
  finishRename();
  await pendingRename;
  assert.equal(context.curSong.id, 'builtin-lv1-butterfly', 'late rename does not switch away from a newly selected score');
  assert.equal(image.title, 'VM renamed image', 'late rename updates its original image record');
  context.dbSaveImageSong = originalImageSave;
  context.prompt = oldPrompt;

  context.changeSongById(image.id);
  context.dbDeleteImageSong = async () => { throw new Error('Injected image delete failure'); };
  await elements.get('deleteSongBtn').click();
  assert.ok(context.imageSongs.some(song => song.id === image.id), 'failed image delete preserves the record');
  context.dbDeleteImageSong = originalImageDelete;
  await elements.get('deleteSongBtn').click();
  assert.equal(context.imageSongs.some(song => song.id === image.id), false, 'successful image delete removes the record');
  context.dbSaveImageSong = originalImageSave;
  context.dbDeleteImageSong = originalImageDelete;
  context.updateActiveCursor = originalUpdateActiveCursor;
  context.curSong = context.allSongs.find(song => song.id === 'builtin-lv1-butterfly');
  await context.persistImageSong(image);
  assert.ok(songStore.has(image.id), 'image score save reaches IndexedDB');
  await assert.rejects(context.dbSaveImageSong({ id:'vm-text', type:'structured' }), /Only image scores can be saved/);
  assert.equal(songStore.has('vm-text'), false, 'structured score is rejected without a database write');
  context.imageSongs = [image];
  context.allSongs.push(image);
  context.curSong = context.allSongs.find(song => song.id === 'builtin-lv1-butterfly');
  context.saveAppState();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(songStore.has('vm-image'), true, 'built-in practice settings do not remove or rewrite image records');

  await elements.get('openSheetSyncBtn').click();
  assert.equal(elements.get('sheetSyncModal').hidden, false, 'Google Sheets modal opens');
  await elements.get('copyCurSongTsvBtn').click();
  assert.match(copiedText, /\t4\t/, 'selected score copies through the five-column TSV path');
  await elements.get('closeSheetSyncBtn').click();
  copiedText = '';
  await elements.get('copyScorePromptBtn').click();
  assert.equal(copiedText, context.GuitarScorePrompt.buildScoreImagePrompt(), 'photo conversion prompt button copies the generic prompt');
  copiedText = '';
  await elements.get('copyProjectPromptBtn').click();
  assert.equal(copiedText, context.GuitarScorePrompt.buildProjectPrompt(), 'project prompt button copies the short repository prompt');

  const hasImageUi = html.includes('id="uploadImgBtn"') && html.includes('id="fileInput"') && html.includes('id="barEditModal"') && html.includes('id="renameSongBtn"') && html.includes('id="deleteSongBtn"');
  assert.equal(hasImageUi, true, 'image/PDF upload, bar metadata, rename, and delete controls remain');
  // 연습 화면의 편집은 악보 입력 화면으로 넘기고, 고쳐 돌아오면 원래 곡의 수정 초안이 된다. 텍스트 악보는 저장소에 남지 않는다.
  context.changeSongById('builtin-lv1-butterfly');
  assert.equal(elements.get('editInInputBtn').hidden, false, 'edit button shows for a text score');
  assert.equal(elements.get('scoreDraftControls').hidden, true, 'an untouched original shows no draft controls');
  context.location = { href: '' };
  await elements.get('editInInputBtn').click();
  assert.equal(context.location.href, 'score-input.html', 'toolbar edit goes to the score input screen');
  const opened = JSON.parse(localValues.get('gs.tabInput.open'));
  localValues.delete('gs.tabInput.open');
  const source = context.BUILTIN_SONGS.find(song => song.id === 'builtin-lv1-butterfly');
  assert.deepEqual([opened.sourceId, opened.title, opened.beats, opened.measure], ['builtin-lv1-butterfly', source.title, source.beats, 0], 'hand-off carries the source id, title, cell count and start measure');
  assert.equal(opened.lines.length, source.measures.length, 'hand-off carries one line per measure');
  assert.equal(opened.key, null, 'a song without a key signature hands off null');
  assert.ok(Math.abs(Date.now() - opened.savedAt) < 60000, 'hand-off is time stamped');
  assert.equal(context.scoreDrafts.status(source.id).dirty, false, 'handing off does not make a draft');

  const returnedLines = opened.lines.slice();
  returnedLines[returnedLines.length - 1] = '[-] ' + new Array(source.beats).fill('r').join(' ');
  const returnedPayload = { sourceId: source.id, title: 'not used', beats: source.beats, bpm: 99, badge: 'not used', lines: returnedLines, key: 2, savedAt: Date.now() };
  localValues.set('gs.tabInput.handoff', JSON.stringify(returnedPayload));
  const draftId = context.scoreEditorHooks.consumeTabInputHandoff(context.BUILTIN_SONGS.concat(context.sheetSongs));
  assert.equal(draftId, source.id, 'a hand-off with a known source id opens that song');
  assert.equal(localValues.has('gs.tabInput.handoff'), false, 'the hand-off key is consumed');
  assert.deepEqual({ ...context.scoreDrafts.status(draftId) }, { dirty: true, temporary: false, origin: 'tab-input' }, 'the song becomes a modified draft');
  const draft = context.scoreDrafts.get(draftId);
  assert.deepEqual([draft.title, draft.bpm, draft.badge, draft.key], [source.title, source.bpm, source.badge, 2], 'title, BPM and badge stay the original, the key follows the hand-off');
  assert.equal(Array.from(draft.measures[draft.measures.length - 1].beats, beat => beat.tok).join(' '), new Array(source.beats).fill('r').join(' '), 'the draft carries the edited measure');
  assert.equal(Array.from(source.measures[source.measures.length - 1].beats, beat => beat.tok).join(' ') === new Array(source.beats).fill('r').join(' '), false, 'the original source is untouched');
  context.rebuildSongSelect(draftId);
  assert.match(elements.get('scoreDraftStatus').textContent, /악보 입력에서 고친 수정 초안/, 'status line names the draft');
  assert.equal(elements.get('resetScoreDraftBtn').hidden, false, 'revert button shows for the draft');
  await elements.get('resetScoreDraftBtn').click();
  assert.equal(context.curSong.measures.length, source.measures.length, 'revert restores the original measures');
  assert.equal(Array.from(context.curSong.measures[context.curSong.measures.length - 1].beats, beat => beat.tok).join(' ') === new Array(source.beats).fill('r').join(' '), false, 'revert restores the original last measure');
  assert.deepEqual({ ...context.scoreDrafts.status(draftId) }, { dirty: false, temporary: false, origin: null }, 'revert clears the draft state');

  localValues.set('gs.tabInput.handoff', JSON.stringify(Object.assign({}, returnedPayload, { beats: source.beats === 3 ? 2 : 3, lines: ['[-] ' + new Array(source.beats === 3 ? 2 : 3).fill('r').join(' ')] })));
  const beatsDraftId = context.scoreEditorHooks.consumeTabInputHandoff(context.BUILTIN_SONGS.concat(context.sheetSongs));
  assert.match(beatsDraftId, /^temp-score-\d+$/, 'a hand-off whose cell count differs from the source opens a new temporary score');
  assert.equal(elements.get('storageStatus').textContent, '칸 수가 바뀌어서 원래 곡 대신 새 임시 악보로 열었습니다.', 'the storage status explains the new temporary score');
  assert.equal(elements.get('storageStatus').hidden, false);
  assert.equal(context.scoreDrafts.status(source.id).dirty, false, 'the source song keeps no draft');

  localValues.set('gs.tabInput.handoff', JSON.stringify(Object.assign({}, returnedPayload, { sourceId: null, title: 'VM temporary score', bpm: 88 })));
  const temporaryId = context.scoreEditorHooks.consumeTabInputHandoff(context.BUILTIN_SONGS.concat(context.sheetSongs));
  assert.match(temporaryId, /^temp-score-\d+$/, 'a hand-off without a source id opens a new temporary score');
  assert.deepEqual([context.scoreDrafts.get(temporaryId).title, context.scoreDrafts.get(temporaryId).bpm], ['VM temporary score', 88]);
  assert.equal(context.scoreDrafts.status(temporaryId).temporary, true, 'the new score is temporary');
  assert.equal(songStore.has(temporaryId), false, 'temporary text score is never written to IndexedDB');
  assert.equal([...localValues.values()].some(value => String(value).includes('VM temporary score')), false,
    'temporary score text is not written to localStorage');
  const chordDb = context.GuitarParser.CHORD_DB;
  assert.ok(chordDb && Object.keys(chordDb).length > 0, 'the chord dictionary is reachable from the app context');
  for (const chordName of Object.keys(chordDb)){
    const chord = chordDb[chordName];
    const frets = Array.from(chord.frets);
    const svg = context.buildChordSvg(chord.frets, chord.fingers);
    const circles = svg.children.filter(el => el.tagName === 'CIRCLE');
    const texts = svg.children.filter(el => el.tagName === 'TEXT');
    const lines = svg.children.filter(el => el.tagName === 'LINE');
    const pressed = frets.filter(fr => fr > 0);
    assert.equal(circles.length, pressed.length, chordName + ': one dot per pressed string');
    const cys = circles.map(el => Number(el.getAttribute('cy')));
    for (let a = 0; a < pressed.length; a++){
      for (let b = 0; b < pressed.length; b++){
        if (pressed[a] < pressed[b]) assert.ok(cys[a] < cys[b], chordName + ': a lower fret is drawn higher');
        if (pressed[a] === pressed[b]) assert.equal(cys[a], cys[b], chordName + ': the same fret is drawn at the same height');
      }
    }
    const rowYs = lines.filter(el => el.getAttribute('y1') === el.getAttribute('y2')).map(el => Number(el.getAttribute('y1')));
    const topY = Math.min(...rowYs), bottomY = Math.max(...rowYs);
    cys.forEach(cy => assert.ok(cy > topY && cy < bottomY, chordName + ': every dot sits inside the drawn window'));
    const frLabels = texts.filter(el => /fr$/.test(el.textContent));
    if (pressed.length && Math.max(...pressed) > 4){
      assert.equal(frLabels.length, 1, chordName + ': exactly one start-fret label');
      assert.equal(frLabels[0].textContent, Math.min(...pressed) + 'fr', chordName + ': the label shows the lowest pressed fret');
    } else {
      assert.equal(frLabels.length, 0, chordName + ': no start-fret label within 4 frets');
    }
  }
  process.stdout.write('Result: app VM smoke passed (versioned scripts, hand-off to score input and back, image-only persistence, fallback boot)\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
