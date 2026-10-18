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
    return Promise.all((this.listeners[type] || []).map(fn => fn(event)));
  }
  appendChild(child){ if (child){ child.parentNode = this; child.parentElement = this; this.children.push(child); } return child; }
  append(...children){ children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children){ this.children = []; this.textContent = ''; children.forEach(child => this.appendChild(child)); }
  setAttribute(name, value){ this.attributes[name] = String(value); }
  getAttribute(name){ return this.attributes[name] == null ? null : this.attributes[name]; }
  removeAttribute(name){ delete this.attributes[name]; }
  querySelector(){ return null; }
  querySelectorAll(){ return []; }
  closest(){ return null; }
  matches(){ return false; }
  focus(){}
  blur(){}
  click(){ return this.dispatch('click'); }
  remove(){ if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  scrollIntoView(){}
  getContext(){ return { clearRect(){}, fillRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, fillText(){}, measureText(){ return { width: 8 }; } }; }
}

const root = process.cwd();
const elements = new Map();
const makeElement = (tag, id) => new MockElement(tag, id);
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
  querySelectorAll(){ return []; },
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
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  for (const script of scripts){
    vm.runInContext(fs.readFileSync(path.join(root, script), 'utf8'), unavailableContext, { filename: script });
  }
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await waitFor(() => unavailableContext.allSongs.length === 14 && unavailableContext.curSong != null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(unavailableContext.allSongs.length, 14, 'built-in songs render when IndexedDB is unavailable');
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
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['src/storage.js', 'src/notation.js', 'src/parser.js', 'src/score.js', 'src/audio.js', 'src/guide.js', 'src/ai-prompt.js', 'src/image-analysis.js', 'src/fretboard.js', 'src/editor.js', 'src/sheets.js', 'src/app.js']);
  for (const script of scripts){
    const source = fs.readFileSync(path.join(root, script), 'utf8');
    vm.runInContext(source, context, { filename: script });
  }
  await waitFor(() => context.allSongs.length === 14 && context.curSong != null);
  await testUnavailableIndexedDbBoot(html);
  assert.equal(context.allSongs.length, 14, 'songs.json loads through the app boot path');
  assert.equal(context.curSong.id, 'builtin-lv1-butterfly', 'saved/default song is selected');
  assert.match(html, /<p id="storageStatus" class="hint" role="status" aria-live="polite" hidden><\/p>/, 'storage failure status is accessible');
  assert.equal(elements.get('fretboard').children.length, 7, 'fretboard initializes six strings and one header');
  assert.ok(elements.get('measuresGrid').children.length > 0, 'selected score renders measures');
  assert.equal(typeof context.parseScore, 'function', 'parser API is available to app scripts');
  assert.equal(typeof context.getExplicitBass, 'function', 'parser exports the common explicit bass-note helper');
  const explicitBassBeat = context.parseScore('[C] G3@3+C4@2 - -', 3).measures[0].beats[0];
  const explicitBass = context.getExplicitBass(explicitBassBeat);
  assert.equal(explicitBass.midi, 55, 'common bass helper returns only the explicitly written lower note');
  assert.equal(context.getExplicitBass(context.parseScore('[C] C4 - -', 3).measures[0].beats[0]), null, 'common bass helper does not infer a note from a chord');

  await elements.get('copyAiPromptBtn').dispatch('click');
  assert.match(copiedText, /E4@1\/F4@1/, 'AI prompt example uses a slash without spaces inside a beat');
  assert.doesNotMatch(copiedText, /E4@1 \/ F4@1/, 'AI prompt has no spaced slash subdivision examples');
  assert.match(copiedText, /마디는 줄바꿈 또는 `\/\/`로만 나눠/, 'AI prompt explains the canonical bar separator');
  const promptExample = context.parseScore('[C] E4@1/F4@1 - - - | ""\n[C] C4@2 - - - | ""', 4);
  assert.equal(promptExample.measures.length, 2, 'the prompt sample parses as two measures');
  assert.equal(promptExample.measures[0].beats[0].subNotes.length, 2, 'the prompt subdivision sample parses as two subnotes');

  context.openConverterEditorModal({ title: 'smoke', beats: 4, capo: 4, ytUrl: 'https://youtu.be/original', rawText: '[C] C4 -/D4 - - | a/b' });
  assert.equal(context.veState.bars.length, 1, 'editor projection makes one bar');
  assert.equal(context.veState.bars[0].notes[1], '-/D4', 'editor keeps the subdivision token');
  assert.equal(context.veState.sourceCapo, 4, 'modal stores the source effective capo');
  assert.equal(context.veState.sourceYtUrl, 'https://youtu.be/original', 'modal stores the source YouTube URL');
  assert.equal(context.editorCapo(), 4, 'editor preview uses the stored source capo');
  elements.get('nsTitle').value = 'smoke (Capo 2)';
  assert.equal(context.editorCapo(), 2, 'title capo overrides the source capo in editor preview');
  elements.get('nsTitle').value = 'smoke saved';
  assert.equal(elements.get('newSongModal').hidden, false, 'editor modal opens');
  assert.ok(elements.get('veBarsGrid').children.length > 0, 'editor grid renders');

  await elements.get('saveNewSongBtn').dispatch('click');
  assert.ok(context.customSongs.some(song => song.title === 'smoke saved'), 'save handler builds and stores a structured song');
  assert.ok(songStore.has(context.customSongs.find(song => song.title === 'smoke saved').id), 'save handler reaches IndexedDB');

  const invalidRaw = '[C] C4 D4 E4 F4 G4 | "oversized"';
  context.openConverterEditorModal({ title: 'oversized', beats: 4, rawText: invalidRaw });
  assert.equal(elements.get('nsMeasuresTxt').value, invalidRaw, 'overflow score source stays intact');
  assert.equal(elements.get('veBarsGrid').children.length, 0, 'overflow score is not truncated into the visual editor');
  assert.match(elements.get('scoreValidationStatus').textContent, /1마디 5박/, 'overflow score reports the extra beat');
  await elements.get('saveNewSongBtn').dispatch('click');
  assert.equal(context.customSongs.some(song => song.title === 'oversized'), false, 'invalid score cannot be saved');

  const beforeFailedSave = context.customSongs.slice();
  const selectedBeforeFailedSave = context.curSong.id;
  const originalDbSaveSong = context.dbSaveSong;
  context.openConverterEditorModal({ title: 'save retry', beats: 4, rawText: '[C] C4 - - -' });
  elements.get('nsTitle').value = 'save retry';
  context.dbSaveSong = async () => { throw new Error('Injected save failure'); };
  await elements.get('saveNewSongBtn').dispatch('click');
  assert.equal(elements.get('newSongModal').hidden, false, 'failed save keeps editor modal open');
  assert.equal(elements.get('saveNewSongBtn').disabled, false, 'failed save re-enables save button');
  assert.equal(elements.get('storageStatus').hidden, false, 'failed save announces storage error');
  assert.ok(elements.get('ocrStatusTxt').textContent.includes('저장하지 못했어요'), 'failed save also shows storage guidance inside the editor');
  assert.deepEqual(context.customSongs.map(song => song.id), beforeFailedSave.map(song => song.id), 'failed save leaves custom songs unchanged');
  assert.equal(context.curSong.id, selectedBeforeFailedSave, 'failed save preserves selected song');
  context.dbSaveSong = originalDbSaveSong;
  await elements.get('saveNewSongBtn').dispatch('click');
  const retriedSong = context.customSongs.find(song => song.title === 'save retry');
  assert.ok(retriedSong && songStore.has(retriedSong.id), 'retry persists the song after transaction completion');
  assert.ok((await context.dbGetAllSongs()).some(song => song.id === retriedSong.id && song.title === 'save retry'), 'completed write is visible to a later read transaction');
  assert.equal(elements.get('newSongModal').hidden, true, 'successful retry closes the editor modal');
  assert.equal(elements.get('storageStatus').hidden, true, 'successful retry clears storage error status');
  assert.equal(elements.get('ocrStatusTxt').textContent, '', 'successful retry clears editor storage guidance');

  await elements.get('openSheetSyncBtn').click();
  assert.equal(elements.get('sheetSyncModal').hidden, false, 'sheet sync opens through extracted module');
  await elements.get('copySheetTemplateBtn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(copiedText, /곡 제목\t박자\tBPM/, 'sheet template copy is wired through extracted module');
  await elements.get('closeSheetSyncBtn').click();
  assert.equal(elements.get('sheetSyncModal').hidden, true, 'sheet sync closes through extracted module');

  const existing = context.buildStructuredSong({ id: 'custom-edit-source', title: 'Existing song', badge: 'Custom', capo: 4, ytUrl: 'https://youtu.be/keep-me', bpm: 72, beats: 4, lines: ['[C] C4 - - -'] });
  existing.measures[0].lyric = 'slash // pipe | quote " and /';
  context.customSongs.push(existing);
  context.curSong = existing;
  await elements.get('editStructuredBtn').dispatch('click');
  assert.equal(context.decodeMeasureLine(elements.get('nsMeasuresTxt').value).lyric, existing.measures[0].lyric, 'structured edit opening round trips JSON-quoted lyric delimiters');
  assert.equal(context.veState.sourceCapo, 4, 'editing a custom song captures its effective capo');
  assert.equal(context.veState.sourceYtUrl, 'https://youtu.be/keep-me', 'editing a custom song captures its YouTube URL');
  assert.equal(context.editorCapo(), 4, 'custom song edit preview uses source capo');
  elements.get('nsTitle').value = 'Existing song updated';
  await elements.get('saveNewSongBtn').dispatch('click');
  const edited = context.customSongs.find(song => song.id === existing.id);
  assert.equal(edited.capo, 4, 'editing preserves custom song capo');
  assert.equal(edited.ytUrl, 'https://youtu.be/keep-me', 'editing preserves custom song YouTube URL');
  assert.equal(songStore.get(existing.id).capo, 4, 'IndexedDB record preserves custom song capo');
  assert.equal(songStore.get(existing.id).ytUrl, 'https://youtu.be/keep-me', 'IndexedDB record preserves custom song YouTube URL');
  assert.equal(edited.fromSheet, undefined, 'custom edit does not copy source-only metadata');
  assert.equal(edited.builtin, false, 'custom edit stays a custom song');

  const originalTitle = edited.title;
  const originalSelected = context.curSong.id;
  promptResponse = 'Existing song renamed';
  const originalDbDeleteSong = context.dbDeleteSong;
  context.dbSaveSong = async () => { throw new Error('Injected rename failure'); };
  await elements.get('renameSongBtn').click();
  promptResponse = '';
  assert.equal(context.customSongs.find(song => song.id === existing.id).title, originalTitle, 'failed rename leaves custom song unchanged');
  assert.equal(context.curSong.id, originalSelected, 'failed rename preserves selected song');
  context.dbSaveSong = originalDbSaveSong;

  let finishRename;
  context.dbSaveSong = () => new Promise(resolve => { finishRename = resolve; });
  promptResponse = 'Existing song renamed';
  const pendingRename = elements.get('renameSongBtn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  context.changeSongById('builtin-lv1-butterfly');
  finishRename();
  await pendingRename;
  promptResponse = '';
  context.dbSaveSong = originalDbSaveSong;
  assert.equal(context.curSong.id, 'builtin-lv1-butterfly', 'completed rename does not replace a song selected during the save');
  assert.equal(context.customSongs.find(song => song.id === existing.id).title, 'Existing song renamed', 'completed rename updates its original song');

  context.changeSongById(existing.id);
  const selectedBeforeFailedDelete = context.curSong.id;
  context.dbDeleteSong = async () => { throw new Error('Injected delete failure'); };
  await elements.get('deleteSongBtn').click();
  context.dbDeleteSong = originalDbDeleteSong;
  assert.ok(context.customSongs.some(song => song.id === existing.id), 'failed delete leaves custom song in memory');
  assert.equal(context.curSong.id, selectedBeforeFailedDelete, 'failed delete preserves selected song');

  const imageSong = { id: 'image-bar-edit', title: 'Image bar edit', type: 'image', systems: [{ bars: [{ chord: 'C', note: 'C4', memo: 'old' }] }] };
  const originalUpdateActiveCursor = context.updateActiveCursor;
  context.updateActiveCursor = function(){};
  context.customSongs.push(imageSong);
  context.allSongs.push(imageSong);
  context.curSong = imageSong;
  context.selectedImgBar = { sysIdx: 0, barIdx: 0, globalIdx: 0 };
  await elements.get('editBarMetaBtn').click();
  assert.equal(elements.get('barEditModal').hidden, false, 'image bar edit modal opens');
  elements.get('beChord').value = 'G';
  elements.get('beNote').value = 'D4';
  elements.get('beMemo').value = 'new';
  context.dbSaveSong = async () => { throw new Error('Injected image bar failure'); };
  await elements.get('saveBarEditBtn').click();
  assert.equal(elements.get('barEditModal').hidden, false, 'failed image bar save keeps modal open');
  assert.equal(imageSong.systems[0].bars[0].chord, 'C', 'failed image bar save preserves original chord');
  assert.equal(imageSong.systems[0].bars[0].memo, 'old', 'failed image bar save preserves original memo');
  context.dbSaveSong = originalDbSaveSong;
  await elements.get('saveBarEditBtn').click();
  assert.equal(imageSong.systems[0].bars[0].chord, 'G', 'successful image bar save updates existing object');
  elements.get('beMemo').value = 'race update';
  let finishBarSave;
  context.dbSaveSong = () => new Promise(resolve => { finishBarSave = resolve; });
  const pendingBarSave = elements.get('saveBarEditBtn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  context.changeSongById('builtin-lv1-butterfly');
  finishBarSave();
  await pendingBarSave;
  context.dbSaveSong = originalDbSaveSong;
  assert.equal(context.curSong.id, 'builtin-lv1-butterfly', 'completed bar save does not replace a song selected during the save');
  assert.equal(imageSong.systems[0].bars[0].memo, 'race update', 'completed bar save updates the originally edited image song');
  context.changeSongById('builtin-lv1-butterfly');
  context.changeSongById(imageSong.id);
  assert.equal(context.curSong.systems[0].bars[0].memo, 'race update', 'image bar edits survive switching away and back');
  context.updateActiveCursor = originalUpdateActiveCursor;

  for (const source of [
    { ...context.buildStructuredSong({ id: 'builtin-copy-source', title: 'Builtin source', badge: '', capo: 3, ytUrl: 'https://youtu.be/builtin', bpm: 64, beats: 4, lines: ['[G] G3 - - -'] }), builtin: true },
    { ...context.buildStructuredSong({ id: 'sheet-copy-source', title: 'Sheet source', badge: '', capo: 5, ytUrl: 'https://youtu.be/sheet', bpm: 64, beats: 4, lines: ['[G] G3 - - -'] }), fromSheet: true }
  ]){
    context.curSong = source;
    await elements.get('editStructuredBtn').dispatch('click');
    assert.equal(context.veState.sourceCapo, source.capo, 'read-only source edit captures effective capo');
    assert.equal(context.veState.sourceYtUrl, source.ytUrl, 'read-only source edit captures YouTube URL');
    elements.get('nsTitle').value = source.title + ' (내 버전)';
    await elements.get('saveNewSongBtn').dispatch('click');
    const copy = context.customSongs.find(song => song.title === source.title + ' (내 버전)');
    assert.ok(copy, 'read-only source saves as a new version');
    assert.equal(copy.capo, source.capo, 'read-only source version preserves capo');
    assert.equal(copy.ytUrl, source.ytUrl, 'read-only source version preserves YouTube URL');
    assert.equal(copy.builtin, false, 'read-only source version is not marked builtin');
    assert.equal(copy.fromSheet, undefined, 'read-only source version does not copy fromSheet flag');
  }

  context.openConverterEditorModal({ title: '', beats: 4 });
  assert.equal(context.veState.sourceCapo, 0, 'new modal clears previous capo');
  assert.equal(context.veState.sourceYtUrl, '', 'new modal clears previous YouTube URL');
  assert.equal(context.editorCapo(), 0, 'new modal preview starts without a capo');

  const htmlPayload = '<img/src=x/onerror=alert(1)>';
  const unsafeRaw = '[-] ' + htmlPayload + '/C4 - - -';
  context.openConverterEditorModal({ title: 'unsafe token', beats: 4, rawText: unsafeRaw });
  assert.equal(elements.get('nsMeasuresTxt').value, unsafeRaw, 'invalid input remains untouched in the source textarea');
  assert.equal(elements.get('veBarsGrid').children.length, 0, 'invalid input is not projected into a misleading visual preview');
  assert.match(elements.get('scoreValidationStatus').textContent, /알 수 없는 음표 토큰/, 'invalid source text receives a validation diagnostic');

  process.stdout.write('Result: app VM smoke passed (script loading, songs.json, fretboard, score render, editor projection/grid, save handler)\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
