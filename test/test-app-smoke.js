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
    await waitFor(() => unavailableContext.allSongs.length === 13 && unavailableContext.curSong != null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(unavailableContext.allSongs.length, 13, 'built-in songs render when IndexedDB is unavailable');
    assert.ok(unavailableElements.get('measuresGrid').children.length > 0, 'built-in score renders when IndexedDB is unavailable');
    assert.equal(unavailableElements.get('storageStatus').hidden, false, 'unavailable IndexedDB displays storage guidance');
    assert.equal(unhandled.length, 0, 'unavailable IndexedDB causes no unhandled rejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

async function main(){
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  document.querySelector('#storageStatus');
  const scriptTags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  const scripts = scriptTags.map(src => src.split('?')[0]);
  assert.deepEqual(scripts, ['src/storage.js', 'src/notation.js', 'src/rhythm.js', 'src/parser.js', 'src/score-drafts.js', 'src/score.js', 'src/audio.js', 'src/guide.js', 'src/image-analysis.js', 'src/fretboard.js', 'src/score-ui.js', 'src/sheets.js', 'src/score-prompt.js', 'src/score-editor.js', 'src/app.js']);
  assert.ok(scriptTags.every(src => src.endsWith('?v=sheet-status-1')), 'every app script uses the shared revision');
  for (const id of ['addBlankScoreBtn', 'blankScoreModal', 'undoScoreEditBtn', 'resetScoreDraftBtn', 'scoreDraftStatus', 'copyCurSongTsvBtn']){
    assert.match(html, new RegExp('id="' + id + '"'), 'temporary score UI includes #' + id);
  }
  assert.doesNotMatch(html, /newTextSongBtn|editStructuredBtn|convertImgToScoreBtn|ocrModalFileInput|refImgDetails|refScoreImg|newSongModal|veBarsGrid/);
  for (const script of scripts){
    const source = fs.readFileSync(path.join(root, script), 'utf8');
    vm.runInContext(source, context, { filename: script });
  }
  await waitFor(() => context.allSongs.length === 13 && context.curSong != null);
  await testUnavailableIndexedDbBoot(html);
  assert.equal(context.allSongs.length, 13, 'songs.json loads through app boot');
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
    assert.deepEqual([previewBass.midi, previewBass.articulation, previewBass.str], [bass.midi, 'tirando', 6],
      'app preview keeps the written bass pitch, articulation, and string');
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

  const scoreMode = elements.get('scoreModeSeg');
  assert.equal(scoreMode.hidden, false, 'score view controls are available for structured songs');
  await elements.get('scoreModeCardBtn').click();
  assert.equal(context.appState.scoreView, 'card', 'card view updates saved app settings');
  await elements.get('scoreModeTabBtn').click();
  assert.equal(context.appState.scoreView, 'tab', 'TAB view remains selectable');

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

  const hasImageUi = html.includes('id="uploadImgBtn"') && html.includes('id="fileInput"') && html.includes('id="barEditModal"') && html.includes('id="renameSongBtn"') && html.includes('id="deleteSongBtn"');
  assert.equal(hasImageUi, true, 'image/PDF upload, bar metadata, rename, and delete controls remain');
  const originalSongCount = context.allSongs.length;
  await elements.get('addBlankScoreBtn').click();
  assert.equal(elements.get('blankScoreModal').hidden, false, 'blank-score button opens the creation modal');
  assert.deepEqual([elements.get('blankScoreTitle').value, elements.get('blankScoreBeats').value, elements.get('blankScoreBpm').value],
    ['빈 악보 1', '4', '64'], 'blank-score modal starts with the specified defaults');
  await elements.get('cancelBlankScoreBtn').click();
  assert.equal(context.allSongs.length, originalSongCount, 'canceling blank-score creation does not add a draft');
  await elements.get('addBlankScoreBtn').click();
  elements.get('blankScoreTitle').value = 'VM temporary score';
  elements.get('blankScoreBeats').value = '3';
  elements.get('blankScoreBpm').value = '88';
  await elements.get('createBlankScoreBtn').click();
  assert.equal(context.curSong.id, 'temp-score-1', 'blank-score creation selects the in-memory temporary score');
  assert.deepEqual([context.curSong.title, context.curSong.beats, context.curSong.bpm], ['VM temporary score', 3, 88],
    'blank-score creation applies the chosen title, cell count, and BPM');
  assert.deepEqual(Array.from(context.curSong.measures[0].beats, beat => beat.tok), ['r', 'r', 'r'], 'blank score starts with a full rest measure');
  assert.equal(context.scoreDrafts.status(context.curSong.id).temporary, true, 'blank score is marked as temporary');
  assert.equal(songStore.has(context.curSong.id), false, 'temporary text score is never written to IndexedDB');
  assert.equal([...localValues.values()].some(value => String(value).includes('VM temporary score')), false,
    'temporary score text is not written to localStorage');
  process.stdout.write('Result: app VM smoke passed (versioned scripts, temporary score editing, image-only persistence, fallback boot)\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
