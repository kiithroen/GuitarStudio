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
const windowListeners = Object.create(null);
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
  addEventListener(type, fn){ (windowListeners[type] ||= []).push(fn); },
  removeEventListener(type, fn){ windowListeners[type] = (windowListeners[type] || []).filter(item => item !== fn); },
  dispatchWindowKey(event){
    const ev = Object.assign({ target: document.body, preventDefault(){ this.defaultPrevented = true; } }, event);
    for (const fn of windowListeners.keydown || []) fn(ev);
    return ev;
  },
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

// 저장된 클릭음 vol(0~2)·연주음 guitarVol(0~1) 정규화: 범위 안은 유지하고 숫자가 아니거나 범위 밖은 기본값
function testVolumeNormalization(){
  function loadedVolumes(saved){
    const store = { 'gs.state': JSON.stringify(saved) };
    const sb = {
      console, document: {}, Math, JSON, Date, Promise, Object, Array, Number, String, Map, Set,
      localStorage: { getItem(key){ return key in store ? store[key] : null; }, setItem(){}, removeItem(){} }
    };
    sb.window = sb;
    const ctx = vm.createContext(sb);
    for (const script of ['src/storage.js', 'src/app-state.js']) vm.runInContext(fs.readFileSync(path.join(root, script), 'utf8'), ctx, { filename: script });
    return JSON.parse(vm.runInContext('JSON.stringify([appState.vol, appState.guitarVol])', ctx));
  }
  assert.deepEqual(loadedVolumes({}), [0.55, 1], 'missing volumes fall back to the click default and full guitar volume');
  assert.deepEqual(loadedVolumes({ vol: 2, guitarVol: 0.5 }), [2, 0.5], 'click volume keeps values up to 2 and guitar volume keeps its value');
  assert.deepEqual(loadedVolumes({ vol: 0, guitarVol: 0 }), [0, 0], 'zero is a valid volume');
  assert.deepEqual(loadedVolumes({ vol: 2.5, guitarVol: 1.5 }), [0.55, 1], 'values above the range fall back to the defaults');
  assert.deepEqual(loadedVolumes({ vol: -1, guitarVol: -0.1 }), [0.55, 1], 'negative values fall back to the defaults');
  assert.deepEqual(loadedVolumes({ vol: '1', guitarVol: null }), [0.55, 1], 'non-numbers fall back to the defaults');
}

function testTempoRampNormalization(){
  function loadState(saved){
    const store = { 'gs.state': JSON.stringify(saved) };
    const sb = {
      console, document: {}, Math, JSON, Date, Promise, Object, Array, Number, String, Map, Set,
      localStorage: { getItem(key){ return key in store ? store[key] : null; }, setItem(){}, removeItem(){} }
    };
    sb.window = sb;
    const ctx = vm.createContext(sb);
    for (const script of ['src/storage.js', 'src/app-state.js']) vm.runInContext(fs.readFileSync(path.join(root, script), 'utf8'), ctx, { filename: script });
    return JSON.parse(vm.runInContext('JSON.stringify({ step: appState.tempoRampStep, targets: appState.tempoTargets, legacy: Object.prototype.hasOwnProperty.call(appState, "speedTrainer") })', ctx));
  }
  assert.deepEqual(loadState({}), { step: 0, targets: {}, legacy: false }, 'tempoRampStep defaults to 0 and tempoTargets to empty');
  for (const step of [0, 3, 5, 10]) assert.equal(loadState({ tempoRampStep: step }).step, step, 'valid tempoRampStep ' + step + ' survives reload');
  assert.equal(loadState({ tempoRampStep: 7 }).step, 0, 'invalid tempoRampStep falls back to 0');
  assert.equal(loadState({ speedTrainer: true }).step, 3, 'legacy speedTrainer true migrates to +3');
  assert.equal(loadState({ speedTrainer: true }).legacy, false, 'legacy speedTrainer property is removed');
  assert.deepEqual(loadState({ tempoTargets: { a: 90, b: 10, c: 999, d: 'bad', '': 80 } }).targets, { a: 90, b: 30, c: 240 }, 'tempoTargets clamps valid entries and drops invalid ones');
}

async function main(){
  testScoreViewNormalization();
  testVolumeNormalization();
  testTempoRampNormalization();
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  document.querySelector('#storageStatus');
  const scriptTags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  const scripts = scriptTags.map(src => src.split('?')[0]);
  assert.deepEqual(scripts, ['src/storage.js', 'src/app-state.js', 'src/notation.js', 'src/rhythm.js', 'src/parser.js', 'src/staff-layout.js', 'src/staff-svg.js', 'src/score-drafts.js', 'src/score.js', 'src/audio.js', 'src/guide.js', 'src/image-analysis.js', 'src/fretboard.js', 'src/score-ui.js', 'src/sheets.js', 'src/score-prompt.js', 'src/score-editor.js', 'src/gdrive.js', 'src/app.js']);
  assert.ok(scriptTags.every(src => src.endsWith('?v=sub-cursor-2')), 'every app script uses the shared revision');
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
  assert.equal(context.appState.guitarVol, 1, 'guitar volume defaults to full on a clean boot');
  assert.equal(elements.get('guitarVolRange').value, 100, 'the guitar volume slider shows the default');
  for (const [id, state, raw, expected] of [['volRange', 'vol', '200', 2], ['guitarVolRange', 'guitarVol', '50', 0.5]]){
    const slider = elements.get(id);
    slider.value = raw;
    await slider.dispatch('input');
    assert.equal(context.appState[state], expected, id + ' input updates appState.' + state);
    assert.equal(JSON.parse(localValues.get('gs.state'))[state], expected, id + ' value is saved with the app state');
  }
  Object.assign(context.appState, { vol: 0.55, guitarVol: 1 });
  context.syncConsoleUI();
  assert.equal(elements.get('volRange').value, 55, 'the click slider shows the restored default');
  assert.equal(elements.get('guitarVolRange').value, 100, 'the guitar slider shows the restored default');
  context.saveAppState();
  assert.ok(/id="guitarVolRange" min="0" max="100"/.test(html), 'index.html has the guitar volume slider');
  assert.ok(/id="volRange" min="0" max="200"/.test(html), 'the click volume slider goes up to 200%');
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
    stopGuitarNotes: context.stopGuitarNotes, highlightFretboard: context.highlightFretboard, ensureAudioCtx: context.ensureAudioCtx, warmKsCache: context.warmKsCache,
    appState: { bpm: context.appState.bpm, beats: context.appState.beats, loopStart: context.appState.loopStart, loopEnd: context.appState.loopEnd,
      loopEnable: context.appState.loopEnable, guideSound: context.appState.guideSound, clickMode: context.appState.clickMode }
  };
  try {
    context.warmKsCache = function(){};
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

    // 시작 칸이 빈칸이면 구간 안에서 다음 소리 나는 칸으로, 구간 끝까지 없으면 구간 시작으로 옮긴다
    const startAt = function(text, loopStart, loopEnd, measureIdx, beatIdx){
      const parsed = context.parseScore(text, 4);
      assert.equal(parsed.errors.length, 0, 'the start-seek score parses: ' + text);
      context.curSong = { id: 'skip-start', title: '빈칸 시작', type: 'structured', builtin: false, bpm: 120, beats: 4, capo: 0, measures: parsed.measures, notationVersion: 2 };
      Object.assign(context.appState, { bpm: 120, beats: 4, loopStart, loopEnd, loopEnable: true, guideSound: true, clickMode: 'all' });
      context.isPlaying = false;
      context.playSession = null;
      context.curMeasureIdx = measureIdx;
      context.curBeatIdx = beatIdx;
      context.startPractice();
      const started = { m: context.playSession.mIdx, b: context.playSession.bIdx, curM: context.curMeasureIdx, curB: context.curBeatIdx, loops: context.playSession.loopCompleted };
      context.isPlaying = false;
      context.playSession = null;
      return started;
    };
    assert.deepEqual(startAt('[C] C4 D4 E4 F4\n[C] G4 A4 _ _', 1, 2, 1, 2), { m: 0, b: 0, curM: 0, curB: 0, loops: 0 }, 'a start on the trailing skip cells of the last measure goes to the loop start');
    assert.deepEqual(startAt('[C] C4 D4 E4 F4\n[C] G4 A4 _ _\n[C] E4 F4 G4 A4', 1, 3, 1, 2), { m: 2, b: 0, curM: 2, curB: 0, loops: 0 }, 'a start on a skip cell moves to the next sounding cell of the next measure inside the loop');
    assert.deepEqual(startAt('[C] _ _ B4 C5', 1, 1, 0, 1), { m: 0, b: 2, curM: 0, curB: 2, loops: 0 }, 'a start on a skip cell moves to the next sounding cell of the same measure');
    assert.deepEqual(startAt('[C] C4 D4 E4 F4\n[C] G4 A4 _ _\n[C] E4 F4 G4 A4', 1, 2, 1, 3), { m: 0, b: 0, curM: 0, curB: 0, loops: 0 }, 'the next sounding cell outside the loop end does not count');
    assert.deepEqual(startAt('[C] C4 D4 E4 F4\n[C] G4 A4 _ _', 1, 2, 1, 1), { m: 1, b: 1, curM: 1, curB: 1, loops: 0 }, 'a start on a sounding cell stays');
    // 아래 검사가 쓰던 상태로 되돌린다
    context.curSong = skipSong;
    Object.assign(context.appState, { bpm: 120, beats: 4, loopStart: 1, loopEnd: 3, loopEnable: false, guideSound: true, clickMode: 'all' });
    context.playSession = session;
    context.isPlaying = true;

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
    context.warmKsCache = savedSkip.warmKsCache;
    Object.assign(context.appState, savedSkip.appState);
    context.renderSong();
  }

  // 카운트인: 처음 시작할 때는 COUNT_IN_MIN_SECONDS 를 넘기는 가장 적은 마디 수, 구간 반복으로 돌아갈 때는 한 마디를 센다.
  // 끝 마디의 뒤쪽 빈칸과 시작 마디의 앞쪽 빈칸만큼 박을 더 친다. 클릭 off 면 카운트인이 없다.
  const savedLoop = {
    song: context.curSong, measure: context.curMeasureIdx, beat: context.curBeatIdx, actx: context.actx,
    playing: context.isPlaying, session: context.playSession, setTimeout: context.setTimeout, showCountInRemaining: context.showCountInRemaining,
    scheduleMetronomeClick: context.scheduleMetronomeClick, playGuitarNote: context.playGuitarNote,
    stopGuitarNotes: context.stopGuitarNotes, highlightFretboard: context.highlightFretboard, ensureAudioCtx: context.ensureAudioCtx, warmKsCache: context.warmKsCache,
    appState: { bpm: context.appState.bpm, beats: context.appState.beats, loopStart: context.appState.loopStart, loopEnd: context.appState.loopEnd,
      loopEnable: context.appState.loopEnable, tempoRampStep: context.appState.tempoRampStep, guideSound: context.appState.guideSound, clickMode: context.appState.clickMode }
  };
  try {
    const clicks = [];
    const notes = [];
    const timers = [];
    const countdowns = [];
    const savedShowCountIn = context.showCountInRemaining;
    context.showCountInRemaining = function(remaining, target){ if (remaining > 0) countdowns.push(remaining); return savedShowCountIn(remaining, target); };
    context.warmKsCache = function(){};
    context.scheduleMetronomeClick = function(time, accent){ clicks.push({ time, accent }); };
    context.playGuitarNote = function(midi, duration, when){ notes.push({ midi, when }); };
    context.stopGuitarNotes = function(){};
    context.highlightFretboard = function(){};
    context.ensureAudioCtx = function(){};
    context.setTimeout = function(fn){ timers.push(fn); return 0; };
    const useSong = function(text, beats, bpm){
      const parsed = context.parseScore(text, beats);
      assert.equal(parsed.errors.length, 0, 'the count-in score parses without errors: ' + text);
      context.curSong = { id: 'count-in-test', title: '카운트인 시험', type: 'structured', builtin: false, bpm, beats, capo: 0, measures: parsed.measures, notationVersion: 2 };
      const measures = parsed.measures;
      const lead = measures[0].beats.findIndex(beat => !context.GuitarRhythm.isSkipBeat(beat));
      let trail = 0;
      for (let b = measures[measures.length - 1].beats.length - 1; b >= 0 && context.GuitarRhythm.isSkipBeat(measures[measures.length - 1].beats[b]); b--) trail++;
      return { lead, trail, loopEnd: measures.length };
    };
    const start = function(beats, bpm, clickMode, loopEnd){
      Object.assign(context.appState, { bpm, beats, loopStart: 1, loopEnd, loopEnable: true, tempoRampStep: 0, guideSound: true, clickMode });
      clicks.length = 0; notes.length = 0; timers.length = 0; countdowns.length = 0;
      context.actx = { currentTime: 0, outputLatency: 0, baseLatency: 0 };
      context.isPlaying = false;
      context.playSession = null;
      context.curMeasureIdx = 0;
      context.curBeatIdx = 0;
      context.startPractice();
      return context.playSession;
    };
    const startBars = (beats, bpm) => Math.max(1, Math.ceil(context.COUNT_IN_MIN_SECONDS / (beats * 60 / bpm) - 1e-9));

    // 처음 카운트인 마디 수: 한 마디 길이로 COUNT_IN_MIN_SECONDS 를 넘기는 가장 적은 마디 수
    const barCases = [[4, 120], [4, 150], [2, 120], [3, 80]];
    const seenBars = new Set();
    for (const [beats, bpm] of barCases){
      const cells = ['C4', 'D4', 'E4', 'F4'].slice(0, beats).join(' ');
      const song = useSong('[C] ' + cells, beats, bpm);
      const session = start(beats, bpm, 'countin', song.loopEnd);
      const bars = startBars(beats, bpm);
      seenBars.add(bars);
      assert.equal(session.countInPositions.length, bars * beats, beats + ' cells at ' + bpm + ' BPM: the start count-in is ' + bars + ' bar(s)');
      assert.ok(bars * beats * 60 / bpm >= context.COUNT_IN_MIN_SECONDS - 1e-9, beats + ' cells at ' + bpm + ' BPM: the start count-in reaches the minimum length');
      assert.ok(bars === 1 || (bars - 1) * beats * 60 / bpm < context.COUNT_IN_MIN_SECONDS - 1e-9, beats + ' cells at ' + bpm + ' BPM: one bar fewer would be too short');
      assert.deepEqual(session.countInPositions.filter(pos => pos === 0).length, bars, beats + ' cells at ' + bpm + ' BPM: each count-in bar starts on an accent');
      context.isPlaying = false;
      context.playSession = null;
    }
    assert.ok(seenBars.has(1) && seenBars.size > 1, 'the bar cases cover both a one-bar and a longer start count-in');

    const firstMidi = context.parseNoteToken('C4', 0).midi;
    const runTwoLoops = function(text, beats, bpm, lastToken, clickMode){
      const song = useSong(text, beats, bpm);
      const lastMidi = context.parseNoteToken(lastToken, 0).midi;
      const session = start(beats, bpm, clickMode, song.loopEnd);
      // 두 번째 반복 끝의 카운트인 첫 박까지 돌린다(그 박의 화면 동기화가 커서를 구간 시작으로 옮긴다)
      for (let guard = 0; guard < 200 && !(session.loopCompleted >= 2 && (clickMode === 'off' || session.countInBeat >= 1)); guard++){
        context.actx.currentTime = session.nextBeatTime - 0.01;
        context.schedulerTick();
      }
      timers.forEach(fn => fn());
      const firsts = notes.filter(note => note.midi === firstMidi).map(note => note.when);
      const lasts = notes.filter(note => note.midi === lastMidi).map(note => note.when);
      const gapClicks = clicks.filter(click => click.time > lasts[0] && click.time < firsts[1]);
      const result = { song, spb: session.spb, bpb: session.bpb, bars: startBars(beats, bpm), startTime: session.startTime, firsts, lasts, gapClicks, countdowns: countdowns.slice(), cursor: [context.curMeasureIdx, context.curBeatIdx], inCountIn: session.inCountIn };
      context.isPlaying = false;
      context.playSession = null;
      return result;
    };
    // 못갖춘마디(앞 빈칸 2)로 시작하는 곡과, 못갖춘마디(앞 빈칸 1)와 짧은 끝 마디(뒤 빈칸 1)가 짝을 이루는 곡
    const loopCases = [
      { text: '[-] _ _ C4 D4\n[C] E4 F4 G4 A4', last: 'A4' },
      { text: '[-] _ C4 D4 E4\n[C] F4 G4 A4 _', last: 'A4' }
    ];
    for (const loopCase of loopCases){
      for (const mode of ['all', 'countin']){
        const r = runTwoLoops(loopCase.text, 4, 120, loopCase.last, mode);
        const label = mode + ' ' + JSON.stringify(loopCase.text) + ': ';
        const restartBeats = r.song.trail + r.bpb + r.song.lead;
        assert.equal(r.firsts.length, 2, label + 'the loop start note plays once per pass');
        assert.ok(Math.abs(r.firsts[0] - (r.startTime + (r.bars * r.bpb + r.song.lead) * r.spb)) < 1e-9, label + 'the first note comes after the start count-in and the leading skip beats');
        assert.ok(Math.abs(r.firsts[1] - (r.lasts[0] + (1 + restartBeats) * r.spb)) < 1e-9, label + 'the restart waits for the trailing skip beats, one count-in bar, and the leading skip beats');
        assert.equal(r.gapClicks.length, restartBeats, label + 'every restart beat clicks');
        const wantAccents = [];
        for (let i = 0; i < r.song.trail; i++) wantAccents.push(false);
        for (let i = 0; i < r.bpb; i++) wantAccents.push(i === 0);
        for (let i = 0; i < r.song.lead; i++) wantAccents.push(i === 0);
        assert.deepEqual(r.gapClicks.map(click => click.accent), wantAccents, label + 'restart accents fall on bar starts of the beat grid');
        assert.equal(r.inCountIn, true, label + 'the second loop end starts another count-in');
        assert.deepEqual(r.cursor, [0, r.song.lead], label + 'the restart count-in moves the cursor to the first sounding cell of the loop');
        const countdownFrom = n => Array.from({ length: n }, (_, i) => n - i);
        const wantCountdowns = countdownFrom(r.bars * r.bpb + r.song.lead).concat(countdownFrom(restartBeats), [restartBeats]);
        assert.deepEqual(r.countdowns, wantCountdowns, label + 'each count-in beat shows the beats left to the first note, ending at 1');
      }
      const off = runTwoLoops(loopCase.text, 4, 120, loopCase.last, 'off');
      assert.ok(Math.abs(off.firsts[0] - off.startTime) < 1e-9, 'off: the first pass starts without a count-in');
      assert.ok(Math.abs(off.firsts[1] - (off.lasts[0] + off.spb)) < 1e-9, 'off: going back to the loop start continues on the next cell without a count-in');
      assert.equal(off.gapClicks.length, 0, 'off: no clicks between passes');
      assert.equal(off.inCountIn, false, 'off: the loop restart does not enter a count-in');
      assert.deepEqual(off.countdowns, [], 'off: no count-in countdown is shown');
    }
  } finally {
    context.showCountInRemaining = savedLoop.showCountInRemaining;
    context.curSong = savedLoop.song;
    context.curMeasureIdx = savedLoop.measure;
    context.curBeatIdx = savedLoop.beat;
    context.actx = savedLoop.actx;
    context.isPlaying = savedLoop.playing;
    context.playSession = savedLoop.session;
    context.setTimeout = savedLoop.setTimeout;
    context.scheduleMetronomeClick = savedLoop.scheduleMetronomeClick;
    context.playGuitarNote = savedLoop.playGuitarNote;
    context.stopGuitarNotes = savedLoop.stopGuitarNotes;
    context.highlightFretboard = savedLoop.highlightFretboard;
    context.ensureAudioCtx = savedLoop.ensureAudioCtx;
    context.warmKsCache = savedLoop.warmKsCache;
    Object.assign(context.appState, savedLoop.appState);
    context.renderSong();
  }

  // TempoRamp: 올림 폭 선택/저장, 곡별 목표 BPM 저장·복원·제거, 정지 중 조절 제한, 매 1바퀴 상승(준비 박 포함), 수동 변경 이어가기, 화면 표시
  {
    const savedRamp = {
      song: context.curSong, measure: context.curMeasureIdx, beat: context.curBeatIdx, actx: context.actx,
      playing: context.isPlaying, session: context.playSession, setTimeout: context.setTimeout,
      scheduleMetronomeClick: context.scheduleMetronomeClick, playGuitarNote: context.playGuitarNote,
      stopGuitarNotes: context.stopGuitarNotes, highlightFretboard: context.highlightFretboard, ensureAudioCtx: context.ensureAudioCtx, warmKsCache: context.warmKsCache,
      appState: {
        bpm: context.appState.bpm, beats: context.appState.beats, loopStart: context.appState.loopStart, loopEnd: context.appState.loopEnd,
        loopEnable: context.appState.loopEnable, tempoRampStep: context.appState.tempoRampStep,
        tempoTargets: Object.assign({}, context.appState.tempoTargets), guideSound: context.appState.guideSound, clickMode: context.appState.clickMode
      }
    };
    try {
      const rampTimers = [];
      const rampClicks = [];
      context.warmKsCache = function(){};
      context.scheduleMetronomeClick = function(time, accent){ rampClicks.push({ time, accent }); };
      context.playGuitarNote = function(){};
      context.stopGuitarNotes = function(){};
      context.highlightFretboard = function(){};
      context.ensureAudioCtx = function(){};
      context.setTimeout = function(fn){ rampTimers.push(fn); return 0; };

      // 1. 올림 폭 선택 및 전역 설정 저장
      await elements.get('tempoRampStep5').click();
      assert.equal(context.appState.tempoRampStep, 5, 'clicking +5 updates tempoRampStep');
      assert.equal(JSON.parse(localValues.get('gs.state')).tempoRampStep, 5, 'tempoRampStep is saved in gs.state');
      assert.equal(elements.get('tempoRampStep5').getAttribute('data-active'), 'true', '+5 button is active');
      assert.equal(elements.get('tempoRampStep0').getAttribute('data-active'), 'false', '0 button is inactive');

      // 2. 곡별 목표 BPM 저장·복원·원래 BPM 복원 시 저장값 제거
      context.changeSongById('builtin-lv1-butterfly');
      const songA = context.curSong;
      const songADefault = context.clampBpm(songA.bpm, 64);
      assert.equal(elements.get('targetBpmNum').textContent, String(songADefault), 'default target BPM equals song BPM');
      assert.equal(elements.get('tempoRampStatus').textContent, '목표가 시작 BPM 이하', 'warns when target <= start BPM');
      await elements.get('targetBpmUp5').click();
      await elements.get('targetBpmUp1').click();
      assert.equal(elements.get('targetBpmNum').textContent, String(songADefault + 6), 'target BPM adjusts by +5 and +1');
      assert.equal(JSON.parse(localValues.get('gs.state')).tempoTargets[songA.id], songADefault + 6, 'non-default target BPM is saved per song');
      assert.equal(elements.get('tempoRampStatus').textContent, '바퀴마다 +5 → 목표 ' + (songADefault + 6) + ' BPM', 'shows ramp plan when target > start BPM');

      // 다른 곡은 자기 원래 BPM을 유지하고 따로 목표를 저장한다
      context.changeSongById('builtin-lv2-jinglebells');
      const songB = context.curSong;
      const songBDefault = context.clampBpm(songB.bpm, 64);
      assert.equal(elements.get('targetBpmNum').textContent, String(songBDefault), 'other song uses its own default BPM');
      await elements.get('targetBpmDown5').click();
      assert.equal(JSON.parse(localValues.get('gs.state')).tempoTargets[songB.id], songBDefault - 5, 'other song stores its own target BPM');

      // 원래 곡으로 돌아와 원래 BPM으로 되돌리면 저장값이 제거된다
      context.changeSongById(songA.id);
      assert.equal(elements.get('targetBpmNum').textContent, String(songADefault + 6), 'switching back restores song A target BPM');
      await elements.get('targetBpmDown5').click();
      await elements.get('targetBpmDown1').click();
      assert.equal(Object.prototype.hasOwnProperty.call(context.appState.tempoTargets, songA.id), false, 'stepping back to original BPM removes stored target');
      assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(localValues.get('gs.state')).tempoTargets, songA.id), false, 'persisted tempoTargets removes key matching original BPM');
      await elements.get('targetBpmUp5').click();
      assert.equal(context.appState.tempoTargets[songA.id], songADefault + 5);
      await elements.get('targetBpmResetBtn').click();
      assert.equal(elements.get('targetBpmNum').textContent, String(songADefault), 'center reset button restores original BPM');
      assert.equal(Object.prototype.hasOwnProperty.call(context.appState.tempoTargets, songA.id), false, 'center reset removes stored target');

      // 3. 연주 중 동작: 목표 이하일 때 안 오름, 매 1바퀴마다 상승 + 카운트인 적용 + 목표 도달 유지 + 수동 변경 이어가기
      const parsedRamp = context.parseScore('[C] C4 D4 E4 F4', 4);
      context.curSong = { id: 'ramp-test-song', title: '템포 올림 시험', type: 'structured', builtin: false, bpm: 80, beats: 4, capo: 0, measures: parsedRamp.measures, notationVersion: 2 };
      delete context.appState.tempoTargets['ramp-test-song'];
      Object.assign(context.appState, { bpm: 80, beats: 4, loopStart: 1, loopEnd: 1, loopEnable: true, clickMode: 'all' });
      await elements.get('tempoRampStep5').click();
      context.syncConsoleUI();
      assert.equal(elements.get('tempoRampStatus').textContent, '목표가 시작 BPM 이하', 'when start == target, warns before play');
      context.actx = { currentTime: 0, outputLatency: 0, baseLatency: 0 };
      context.isPlaying = false;
      context.playSession = null;
      context.curMeasureIdx = 0;
      context.curBeatIdx = 0;
      context.startPractice();
      assert.equal(elements.get('targetBpmUp5').disabled, true, 'target BPM adjustment is disabled while playing');
      assert.equal(elements.get('targetBpmResetBtn').disabled, true, 'target BPM reset button is disabled while playing');
      await elements.get('targetBpmUp5').click();
      assert.equal(elements.get('targetBpmNum').textContent, '80', 'target BPM click is ignored while playing');
      for (let guard = 0; guard < 100 && context.playSession.loopCompleted < 2; guard++){
        context.actx.currentTime = context.playSession.nextBeatTime - 0.01;
        context.schedulerTick();
      }
      assert.equal(context.appState.bpm, 80, 'BPM does not increase when target <= start BPM');
      context.stopPractice();
      assert.equal(elements.get('targetBpmUp5').disabled, false, 'target BPM adjustment re-enables after stop');
      assert.equal(elements.get('loopCountBadge').textContent, '0바퀴', 'badge resets to 0바퀴 on stop');

      // 목표 75, 시작 60, +10 단계: 1바퀴(60) -> 2바퀴(70, 카운트인 포함) -> 3바퀴(75 도달) -> 4바퀴(75 유지)
      context.curSong = { id: 'ramp-test-song', title: '템포 올림 시험', type: 'structured', builtin: false, bpm: 75, beats: 4, capo: 0, measures: parsedRamp.measures, notationVersion: 2 };
      delete context.appState.tempoTargets['ramp-test-song'];
      Object.assign(context.appState, { bpm: 60, beats: 4, loopStart: 1, loopEnd: 1, loopEnable: true, clickMode: 'all' });
      await elements.get('tempoRampStep10').click();
      rampClicks.length = 0;
      rampTimers.length = 0;
      context.actx = { currentTime: 0, outputLatency: 0, baseLatency: 0 };
      context.isPlaying = false;
      context.playSession = null;
      context.curMeasureIdx = 0;
      context.curBeatIdx = 0;
      context.startPractice();
      assert.equal(elements.get('loopCountBadge').textContent, '1바퀴', 'start shows 1바퀴');
      assert.equal(elements.get('tempoRampStatus').textContent, '바퀴마다 +10 → 목표 75 BPM', 'shows ramping progress during lap 1');

      // 1바퀴 완료 직후 (restart count-in 시작 시점)
      for (let guard = 0; guard < 100 && context.playSession.loopCompleted < 1; guard++){
        context.actx.currentTime = context.playSession.nextBeatTime - 0.01;
        context.schedulerTick();
      }
      assert.equal(context.appState.bpm, 70, 'after lap 1, BPM increases from 60 to 70');
      assert.ok(Math.abs(context.playSession.spb - 60 / 70) < 1e-9, 'session spb updates to 70 BPM for restart count-in and lap 2');
      // 카운트인 2박 이상 진행시켜 카운트인 간격이 60/70인지 확인
      const countInClicksBefore = rampClicks.length;
      for (let k = 0; k < 3; k++){
        context.actx.currentTime = context.playSession.nextBeatTime - 0.01;
        context.schedulerTick();
      }
      assert.ok(rampClicks.length >= countInClicksBefore + 2, 'restart count-in schedules clicks');
      assert.ok(Math.abs((rampClicks[countInClicksBefore + 1].time - rampClicks[countInClicksBefore].time) - 60 / 70) < 1e-9, 'restart count-in beat spacing uses the new 70 BPM');
      while (rampTimers.length) rampTimers.shift()();
      assert.equal(elements.get('loopCountBadge').textContent, '2바퀴', 'lap 2 count-in updates badge to 2바퀴');

      // 수동으로 템포를 68로 바꿔도 멈추지 않고 다음 바퀴에 68 + 10 -> min(75, 78) = 75 적용
      context.setBpm(68);
      assert.equal(context.isPlaying, true, 'manual BPM change keeps playback running');
      assert.equal(elements.get('tempoRampStatus').textContent, '바퀴마다 +10 → 목표 75 BPM', 'manual change below target keeps ramping status');
      for (let guard = 0; guard < 100 && context.playSession.loopCompleted < 2; guard++){
        context.actx.currentTime = context.playSession.nextBeatTime - 0.01;
        context.schedulerTick();
      }
      assert.equal(context.appState.bpm, 75, 'after lap 2 from manual 68 BPM, clamps at min(75, 68 + 10) = 75');
      assert.equal(elements.get('tempoRampStatus').textContent, '목표 75 BPM 도달', 'reaching target displays goal reached message');
      context.actx.currentTime = context.playSession.nextBeatTime - 0.01;
      context.schedulerTick();
      while (rampTimers.length) rampTimers.shift()();
      assert.equal(elements.get('loopCountBadge').textContent, '3바퀴', 'lap 3 displays 3바퀴');

      // 목표 도달 후 추가 완주 시 75 유지
      for (let guard = 0; guard < 100 && context.playSession.loopCompleted < 3; guard++){
        context.actx.currentTime = context.playSession.nextBeatTime - 0.01;
        context.schedulerTick();
      }
      assert.equal(context.appState.bpm, 75, 'after reaching target, BPM holds at 75');

      // 끔(0) 선택 시 올리지 않음
      await elements.get('tempoRampStep0').click();
      context.setBpm(60);
      assert.equal(elements.get('tempoRampStatus').textContent, '올림 꺼짐', 'step 0 shows off status');
      for (let guard = 0; guard < 100 && context.playSession.loopCompleted < 4; guard++){
        context.actx.currentTime = context.playSession.nextBeatTime - 0.01;
        context.schedulerTick();
      }
      assert.equal(context.appState.bpm, 60, 'step 0 does not change BPM on loop completion');
      context.stopPractice();
    } finally {
      context.curSong = savedRamp.song;
      context.curMeasureIdx = savedRamp.measure;
      context.curBeatIdx = savedRamp.beat;
      context.actx = savedRamp.actx;
      context.isPlaying = savedRamp.playing;
      context.playSession = savedRamp.session;
      context.setTimeout = savedRamp.setTimeout;
      context.scheduleMetronomeClick = savedRamp.scheduleMetronomeClick;
      context.playGuitarNote = savedRamp.playGuitarNote;
      context.stopGuitarNotes = savedRamp.stopGuitarNotes;
      context.highlightFretboard = savedRamp.highlightFretboard;
      context.ensureAudioCtx = savedRamp.ensureAudioCtx;
      context.warmKsCache = savedRamp.warmKsCache;
      Object.assign(context.appState, savedRamp.appState);
      context.appState.tempoTargets = Object.assign({}, savedRamp.appState.tempoTargets);
      context.renderSong();
      context.saveAppState();
    }
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

  // 연습 화면 키보드 단축키: 마디 이동(←/→), BPM 조절([/], -/=), 구간 반복(R/ㄱ), 모달 닫기(Escape)
  {
    for (const id of ['helpModal', 'audioOffsetModal', 'sheetSyncModal', 'backupModal', 'toneModal', 'barEditModal']){
      document.querySelector('#' + id).hidden = true;
    }
    const origActx = context.actx;
    const origEnsureAudio = context.ensureAudioCtx;
    const origPlayNote = context.playGuitarNote;
    const origStopNotes = context.stopGuitarNotes;
    context.actx = { currentTime: 0 };
    context.ensureAudioCtx = function(){};
    context.playGuitarNote = function(){};
    context.stopGuitarNotes = function(){};
    try {
      context.changeSongById('builtin-lv1-butterfly');
      context.isPlaying = false;
      context.curMeasureIdx = 0;
      context.curBeatIdx = 2;
      const baseBpm = context.appState.bpm;
      sandbox.dispatchWindowKey({ key: 'ArrowRight', code: 'ArrowRight' });
      assert.deepEqual([context.curMeasureIdx, context.curBeatIdx], [1, 0], 'ArrowRight moves to the next measure first beat when stopped');
      sandbox.dispatchWindowKey({ key: 'ArrowLeft', code: 'ArrowLeft' });
      assert.deepEqual([context.curMeasureIdx, context.curBeatIdx], [0, 0], 'ArrowLeft moves back to the previous measure');
      sandbox.dispatchWindowKey({ key: 'ArrowLeft', code: 'ArrowLeft' });
      assert.equal(context.curMeasureIdx, 0, 'ArrowLeft clamps at the first measure');

      context.isPlaying = true;
      sandbox.dispatchWindowKey({ key: 'ArrowRight', code: 'ArrowRight' });
      assert.equal(context.curMeasureIdx, 0, 'ArrowRight is ignored while playing');
      context.isPlaying = false;

      sandbox.dispatchWindowKey({ key: ']', code: 'BracketRight' });
      assert.equal(context.appState.bpm, baseBpm + 2, '] increases BPM by 2');
      sandbox.dispatchWindowKey({ key: '[', code: 'BracketLeft' });
      assert.equal(context.appState.bpm, baseBpm, '[ decreases BPM by 2');
      sandbox.dispatchWindowKey({ key: '=', code: 'Equal' });
      assert.equal(context.appState.bpm, baseBpm + 2, '= increases BPM by 2');
      sandbox.dispatchWindowKey({ key: '-', code: 'Minus' });
      assert.equal(context.appState.bpm, baseBpm, '- decreases BPM by 2');

      const prevLoop = context.appState.loopEnable;
      sandbox.dispatchWindowKey({ key: 'r', code: 'KeyR' });
      assert.equal(context.appState.loopEnable, !prevLoop, 'R toggles loopEnable');
      assert.equal(elements.get('loopEnable').checked, !prevLoop, 'R syncs #loopEnable checkbox');
      sandbox.dispatchWindowKey({ key: 'ㄱ', code: 'KeyR' });
      assert.equal(context.appState.loopEnable, prevLoop, 'Korean ㄱ toggles loopEnable back');

      elements.get('helpModal').hidden = false;
      sandbox.dispatchWindowKey({ key: ']', code: 'BracketRight' });
      assert.equal(context.appState.bpm, baseBpm, 'shortcuts are ignored while a modal is open');
      sandbox.dispatchWindowKey({ key: 'Escape', code: 'Escape' });
      assert.equal(elements.get('helpModal').hidden, true, 'Escape closes the open modal');

      // 탭 템포: 첫 탭은 기준 시각만 기록하고, 두 번째 탭부터 평균 간격으로 BPM을 반영하며, 2.5초 초과 시 초기화한다
      assert.match(html, /id="tapTempoBtn"/, 'index.html includes #tapTempoBtn');
      context.setBpm(64);
      context.recordTapTempo(10000);
      assert.equal(context.appState.bpm, 64, 'first tap does not change BPM');
      context.recordTapTempo(10500);
      assert.equal(context.appState.bpm, 120, 'second tap 500ms later sets 120 BPM');
      context.recordTapTempo(11000);
      assert.equal(context.appState.bpm, 120, 'third tap at 500ms interval keeps 120 BPM');
      context.recordTapTempo(15000);
      assert.equal(context.appState.bpm, 120, 'a tap after >2.5s resets the sequence instead of computing a slow interval');
      context.recordTapTempo(16000);
      assert.equal(context.appState.bpm, 60, 'next tap 1000ms after reset sets 60 BPM');
      context.setBpm(baseBpm);
    } finally {
      context.actx = origActx;
      context.ensureAudioCtx = origEnsureAudio;
      context.playGuitarNote = origPlayNote;
      context.stopGuitarNotes = origStopNotes;
    }
  }

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

  context.dbSaveImageSong = originalImageSave;
  context.changeSongById(image.id);
  // PDF 쪽별 마디 그리드 분리: 다음 쪽으로 넘겨 줄·마디를 수정해도 1쪽의 코드·메모가 보존된다
  assert.equal(image.curPageIdx, 0, 'PDF starts on page 0');
  assert.equal(image.systems[0].bars[0].chord, 'Am', 'page 0 keeps its edited chord');
  await document.querySelector('#pdfNextBtn').click();
  assert.equal(image.curPageIdx, 1, 'pdfNextBtn moves to page 1');
  assert.equal(image.systems[0].bars[0].chord, '', 'page 1 has its own blank bar metadata');
  context.selectedImgBar = { sysIdx: 0, barIdx: 0, globalIdx: 0 };
  await elements.get('editBarMetaBtn').click();
  elements.get('beChord').value = 'G7';
  elements.get('beNote').value = 'B4';
  elements.get('beMemo').value = 'page 2 memo';
  await elements.get('saveBarEditBtn').click();
  assert.equal(image.systems[0].bars[0].chord, 'G7', 'page 1 stores its own edited chord');
  await document.querySelector('#pdfPrevBtn').click();
  assert.equal(image.curPageIdx, 0, 'pdfPrevBtn returns to page 0');
  assert.equal(image.systems[0].bars[0].chord, 'Am', 'returning to page 0 restores page 0 chord');
  assert.equal(image.systems[0].bars[0].memo, 'race update', 'returning to page 0 restores page 0 memo');
  await document.querySelector('#pdfNextBtn').click();
  assert.equal(image.systems[0].bars[0].chord, 'G7', 'returning to page 1 restores page 1 chord');
  await document.querySelector('#pdfPrevBtn').click();

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
  // Subdivided TAB pill tagging and active-sub behavior (TAB vs Card)
  context.changeSongById('builtin-lv6-romance-full');
  context.setScoreView('tab');
  const gridEl = elements.get('measuresGrid');
  const m0TabPills = gridEl.children[0].querySelectorAll('.tab-fret-pill');
  assert.ok(m0TabPills.some(p => p.dataset.sub === '0') && m0TabPills.some(p => p.dataset.sub === '1') && m0TabPills.some(p => p.dataset.sub === '2'),
    'subdivided TAB pills are tagged with their subdivision index');
  const heldHoldBeatSong = context.GuitarParser.parseScore('E3/- E3 - r', 4);
  const testHeldSong = {
    id: 'test-sub-held', title: 'Sub Held Test', type: 'structured',
    beats: 4, bpm: 60, measures: heldHoldBeatSong.measures
  };
  context.allSongs.push(testHeldSong);
  context.changeSongById('test-sub-held');
  const heldPills = elements.get('measuresGrid').querySelectorAll('.tab-held-fret');
  assert.ok(heldPills.length >= 2, 'subdivided and full-beat holds create .tab-held-fret pills');
  assert.ok(heldPills.some(p => p.dataset.sub === '1'), 'a subdivided hold pill keeps its subdivision index');
  assert.ok(heldPills.some(p => p.dataset.sub === '0'), 'a full-beat hold pill defaults to subdivision 0');
  context.setScoreView('card');
  assert.equal(elements.get('measuresGrid').querySelectorAll('.tab-fret-pill').length, 0, 'card view creates no TAB pills');
  assert.equal(elements.get('measuresGrid').querySelectorAll('.active-sub').length, 0, 'card view marks no .active-sub');
  context.allSongs.pop();

  process.stdout.write('Result: app VM smoke passed (versioned scripts, hand-off to score input and back, image-only persistence, fallback boot)\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
