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
const idb = {
  open(){
    const request = {};
    const db = {
      objectStoreNames: { contains(){ return true; } },
      createObjectStore(){},
      transaction(){
        const tx = {
          objectStore(){
            return {
              getAll(){
                const req = {};
                setTimeout(() => { req.result = [...songStore.values()]; if (req.onsuccess) req.onsuccess(); }, 0);
                return req;
              },
              put(song){ songStore.set(song.id, song); return {}; },
              delete(id){ songStore.delete(id); return {}; }
            };
          },
          oncomplete: null
        };
        setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
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
  alert(){}, confirm(){ return true; }, prompt(){ return ''; },
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

async function main(){
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['src/parser.js', 'src/score.js', 'src/audio.js', 'src/guide.js', 'src/fretboard.js', 'src/editor.js', 'src/app.js']);
  for (const script of scripts){
    const source = fs.readFileSync(path.join(root, script), 'utf8');
    vm.runInContext(source, context, { filename: script });
  }
  await waitFor(() => context.allSongs.length === 14 && context.curSong != null);
  assert.equal(context.allSongs.length, 14, 'songs.json loads through the app boot path');
  assert.equal(context.curSong.id, 'builtin-lv1-butterfly', 'saved/default song is selected');
  assert.equal(elements.get('fretboard').children.length, 7, 'fretboard initializes six strings and one header');
  assert.ok(elements.get('measuresGrid').children.length > 0, 'selected score renders measures');
  assert.equal(typeof context.parseScore, 'function', 'parser API is available to app scripts');
  assert.equal(typeof context.resolveEffectiveBass, 'function', 'state-aware bass helper is exported after fretboard initialization');

  await elements.get('copyAiPromptBtn').dispatch('click');
  assert.match(copiedText, /`-\/3D4`/, 'AI prompt examples use a slash without spaces inside a beat');
  assert.doesNotMatch(copiedText, /`- \/ 3D4`/, 'AI prompt has no spaced slash subdivision examples');
  assert.match(copiedText, /마디 구분자와 박 안의 서브토큰은 달라/, 'AI prompt explains bar and subdivision separators');
  const promptSubdivision = copiedText.match(/엇박자 \(8분 쉼표 \+ 8분음표\): `([^`]+)`/)[1];
  const promptExample = context.parseScore(['[C] C4 ' + promptSubdivision + ' - -'], 4);
  assert.equal(promptExample.measures.length, 1, 'the prompt subdivision example parses as one measure');
  assert.equal(promptExample.measures[0].beats[1].subNotes.length, 2, 'the prompt subdivision example parses as two subnotes');

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

  const existing = context.buildStructuredSong({ id: 'custom-edit-source', title: 'Existing song', badge: 'Custom', capo: 4, ytUrl: 'https://youtu.be/keep-me', bpm: 72, beats: 4, lines: ['[C] C4 - - -'] });
  context.customSongs.push(existing);
  context.curSong = existing;
  await elements.get('editStructuredBtn').dispatch('click');
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
  context.openConverterEditorModal({ title: 'unsafe token', beats: 4, rawText: '[-] ' + htmlPayload + '/C4 - - -' });
  const unsafeCell = elements.get('veBarsGrid').children[0].children[1].children[0];
  assert.equal(unsafeCell.children[0].tagName, 'B', 'subdivision label is created as a bold DOM element');
  assert.ok(unsafeCell.children[0].textContent.includes(htmlPayload), 'untrusted subdivision token remains literal text');
  assert.equal(unsafeCell.innerHTML, '', 'untrusted subdivision token is never assigned as HTML');
  assert.equal(unsafeCell.children.some(child => child.tagName === 'IMG'), false, 'untrusted subdivision token creates no image element');
  process.stdout.write('Result: app VM smoke passed (script loading, songs.json, fretboard, score render, editor projection/grid, save handler)\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
