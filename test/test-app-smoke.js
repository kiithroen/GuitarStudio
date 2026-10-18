const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.children = [];
    this.listeners = Object.create(null);
    this.attributes = Object.create(null);
    this.classNames = new Set();
    this.classList = {
      add: name => this.classNames.add(name),
      remove: name => this.classNames.delete(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classNames.has(name) : !!force;
        if (enabled) this.classNames.add(name);
        else this.classNames.delete(name);
        return enabled;
      },
      contains: name => this.classNames.has(name)
    };
    this.checked = false;
    this.disabled = false;
    this.files = [];
    this.open = false;
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  matches() { return false; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return (this.listeners.click || []).map(handler => handler({ target: this })); }

  async dispatch(type, event = {}) {
    event.target ||= this;
    return Promise.all((this.listeners[type] || []).map(handler => handler(event)));
  }
}

async function main() {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML ids are unique');

  const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)]
    .map(match => match[1]);
  assert.deepEqual(scripts, [
    'vendor/alphatab/dist/alphaTab.min.js', 'src/storage.js', 'src/tab-engine.js',
    'src/legacy-migration.js', 'src/library.js', 'src/sheets.js', 'src/ai-prompt.js',
    'src/fretboard.js', 'src/editor.js', 'src/app.js'
  ], 'browser modules load in dependency order');

  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const document = {
    listeners: Object.create(null),
    getElementById(id) { return elements.get(id) || new FakeElement(id); },
    createElement(tag) { return new FakeElement(tag); },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  };
  const song = {
    id: 'builtin-demo', title: 'Demo', description: '', badge: '',
    format: 'alphatex', alphaTex: '3.5', builtin: true
  };
  const invalidSong = {
    id: 'broken-demo', title: 'Broken', description: '', badge: '',
    format: 'alphatex', alphaTex: '!invalid!', builtin: false
  };
  const renderFailedSong = {
    id: 'render-failed', title: 'Render failed', description: '', badge: '',
    format: 'alphatex', alphaTex: '3.4', builtin: false
  };
  const score = { tracks: [{ staves: [{ bars: [{}, {}] }] }] };
  const failedRenderScore = { tracks: [{ staves: [{ bars: [{}, {}, {}] }] }] };
  let currentScore = null;
  let callbacks;
  const controller = {
    async loadSong(songToLoad) {
      if (songToLoad.id === 'broken-demo') throw new Error('parser rejection');
      if (songToLoad.id === 'render-failed') {
        currentScore = failedRenderScore;
        callbacks.onReady(false);
        throw new Error('render rejection');
      }
      currentScore = score;
      callbacks.onScore(score);
      return score;
    },
    getScore() { return currentScore; },
    setSpeed() {}, setVolume() {}, setGuideSound() {}, setMetronome() {}, setLoop() {},
    stop() {}, play() { return true; }, pause() {}, destroy() {}
  };
  const values = new Map([[
    'gs.player.v3', JSON.stringify({
      speed: 999, volume: -3, loopStart: 1.2, loopEnd: 'bad', loopEnabled: 'yes'
    })
  ]]);
  const context = {
    document, console, URL, Blob, Uint8Array, ArrayBuffer, Promise, Map, Set, Math, Date,
    JSON, Error, TypeError, RangeError, localStorage: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, value); }
    },
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => true, setTimeout, clearTimeout,
    crypto: { randomUUID: () => 'new-id' },
    TabEngine: {
      create(_element, registeredCallbacks) { callbacks = registeredCallbacks; return controller; },
      parseAlphaTex() { return score; }, importBytes() { return score; },
      toAlphaTex() { return '3.5'; }, exportGp() { return new Uint8Array([1]); },
      getBeatNotes() { return []; }
    },
    GuitarLibrary: {
      loadAll: async () => ({ songs: [song, invalidSong, renderFailedSong], warnings: [{ message: '변환 내용을 확인해줘.' }] }),
      save: async value => value, remove: async () => {}
    },
    GuitarSheets: { fetchSongs: async () => [], toTsv: () => '' },
    GuitarFretboard: { render() {} },
    buildAiPromptText: () => 'prompt'
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);

  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'src/editor.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'src/app.js'), 'utf8'), context);
  for (const handler of document.listeners.DOMContentLoaded || []) await handler();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(elements.get('songSelect').value, 'builtin-demo');
  assert.equal(elements.get('songTitle').textContent, 'Demo');
  assert.match(elements.get('storageStatus').textContent, /악보 안내: 변환 내용을 확인해줘/,
    'migration notices remain visible after song selection');
  assert.equal(elements.get('speedRange').value, '200', 'invalid stored speed is clamped');
  assert.equal(elements.get('volumeRange').value, '0', 'invalid stored volume is clamped');
  assert.equal(elements.get('loopStart').value, '1', 'fractional stored loop bar is normalized');
  assert.equal(elements.get('loopEnd').value, '1', 'invalid stored loop end is normalized');
  assert.equal(elements.get('loopEnable').checked, false, 'nonboolean stored loop flag is normalized');
  assert.equal(elements.get('playPauseBtn').disabled, true, 'play stays disabled until MIDI is ready');

  callbacks.onReady(false);
  assert.equal(elements.get('playPauseBtn').disabled, true, 'onReady(false) keeps transport disabled');
  callbacks.onReady(true);
  assert.equal(elements.get('playPauseBtn').disabled, false, 'MIDI ready enables transport');
  callbacks.onReady(false);
  callbacks.onState(true);
  assert.equal(elements.get('playPauseBtn').disabled, true, 'playing state cannot override readiness');

  const select = elements.get('songSelect');
  select.value = 'broken-demo';
  await select.dispatch('change');
  assert.equal(select.value, 'builtin-demo', 'failed score load restores the prior selection');
  assert.equal(elements.get('songTitle').textContent, 'Demo', 'failed score load preserves selected metadata');
  assert.equal(elements.get('scorePlaceholder').classList.contains('hidden'), true,
    'parse failure leaves the previous rendered score visible');

  callbacks.onReady(true);
  select.value = 'render-failed';
  await select.dispatch('change');
  assert.equal(select.value, 'builtin-demo', 'render failure restores the previous selection');
  assert.equal(elements.get('playPauseBtn').disabled, true,
    'render failure does not restore readiness for a replaced score');
  assert.equal(elements.get('scorePlaceholder').classList.contains('hidden'), false,
    'render failure shows a load error placeholder');

  elements.get('loopStart').value = '1.5';
  elements.get('loopEnd').value = '2';
  await elements.get('applyLoopBtn').click();
  const savedState = JSON.parse(values.get('gs.player.v3'));
  assert.equal(savedState.loopStart, 1, 'invalid loop input does not change stored state');
  assert.equal(elements.get('appStatus').classList.contains('error'), true,
    'fractional loop input is rejected');

  process.stdout.write('Result: app VM smoke passed (unique DOM, ordered scripts, normalized state, readiness gating)\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
