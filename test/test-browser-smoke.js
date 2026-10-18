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
  '.mjs': 'application/javascript; charset=utf-8',
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
    this.badResponses = [];
    this.failedRequests = [];
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
        if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
          this.badResponses.push(msg.params.response.url + ' ' + msg.params.response.status);
        }
        if (msg.method === 'Network.loadingFailed') {
          this.failedRequests.push(msg.params.errorText + ' ' + msg.params.requestId);
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

  async evaluate(expression, userGesture = false) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture
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

async function main() {
  const browserBinary = findBrowserBinary();
  if (!browserBinary) {
    process.stdout.write('SKIP: No Chrome or Edge binary found for browser test\n');
    return;
  }

  const { server, port } = await createStaticServer();
  const cdpPort = 9333 + Math.floor(Math.random() * 200);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-alpha-smoke-'));
  const resolvedTempDir = path.resolve(os.tmpdir());
  const resolvedProfileDir = path.resolve(profileDir);
  assert.ok(resolvedProfileDir.startsWith(resolvedTempDir + path.sep),
    'Chrome profile is inside the system temp directory');
  assert.ok(path.basename(resolvedProfileDir).startsWith('gs-alpha-smoke-'),
    'Chrome profile has the expected temporary prefix');
  const browser = spawn(browserBinary, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-gpu', 'about:blank'
  ], { stdio: 'ignore' });
  let cdp = null;

  try {
    const wsUrl = await waitForCdpEndpoint(cdpPort, 12000);
    cdp = new CdpClient(wsUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__micRequests=0;
        navigator.mediaDevices.getUserMedia=function(){window.__micRequests++;return Promise.reject(new Error("unexpected microphone request"));};
        Object.defineProperty(window, 'TabEngine', {
          configurable: true,
          set(engine) {
            Object.defineProperty(window, 'TabEngine', { configurable: true, writable: true, value: engine });
            const originalCreate = engine.create.bind(engine);
            engine.create = (element, callbacks) => {
              const observedCallbacks = {
                ...callbacks,
                onPosition(position) {
                  window.__testPosition = position;
                  callbacks?.onPosition?.(position);
                }
              };
              const controller = originalCreate(element, observedCallbacks);
              window.__testController = controller;
              return controller;
            };
          }
        });`
    });
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    } catch (_) {}

    const appUrl = `http://127.0.0.1:${port}/index.html`;
    await cdp.send('Page.navigate', { url: appUrl });
    try {
      await waitForCondition(cdp,
        'document.readyState==="complete" && document.getElementById("appStatus").textContent==="재생 준비 완료" && !document.getElementById("playPauseBtn").disabled',
        25000);
    } catch (error) {
      const state = await cdp.evaluate(`({
        readyState: document.readyState,
        appStatus: document.getElementById('appStatus')?.textContent,
        storageStatus: document.getElementById('storageStatus')?.textContent,
        playDisabled: document.getElementById('playPauseBtn')?.disabled,
        scoreSvg: !!document.querySelector('#score svg'),
        AlphaTabType: typeof window.AlphaTab,
        alphaTabType: typeof window.alphaTab,
        consoleErrors: window.__unused || null
      })`);
      throw new Error(error.message + '; initial state=' + JSON.stringify(state)
        + '; browser errors=' + JSON.stringify(cdp.consoleErrors)
        + '; bad responses=' + JSON.stringify(cdp.badResponses)
        + '; failed requests=' + JSON.stringify(cdp.failedRequests));
    }

    assert.ok(await cdp.evaluate('document.querySelector("#score svg")'), 'real alphaTab renderer produced SVG');
    assert.ok(await cdp.evaluate('document.querySelector("#score svg text")'), 'score notation was rendered');
    assert.deepEqual(cdp.consoleErrors, [], 'initial score render produces no worker errors');
    const songCount = await cdp.evaluate('document.getElementById("songSelect").options.length');
    assert.ok(songCount > 0, 'song library loaded');
    if (songCount > 1) {
      await cdp.evaluate(`(() => {
        const select = document.getElementById('songSelect');
        select.value = select.options[1].value;
        select.dispatchEvent(new Event('change'));
        select.value = select.options[0].value;
        select.dispatchEvent(new Event('change'));
      })()`);
      await waitForCondition(cdp,
        'document.getElementById("songTitle").textContent===document.getElementById("songSelect").selectedOptions[0].textContent.replace(/^시트 · /,"") && document.getElementById("appStatus").textContent==="재생 준비 완료"',
        20000);
      assert.deepEqual(cdp.consoleErrors, [], 'rapid song selection produces no worker errors');
    }

    const initialTick = await cdp.evaluate('window.__testPosition?.currentTime ?? null');
    await cdp.evaluate('document.getElementById("playPauseBtn").click()', true);
    await waitForCondition(cdp, 'document.getElementById("playPauseBtn").textContent==="일시정지"', 10000);
    const cursorStart = await cdp.evaluate(`(() => {
      const cursor = document.querySelector('.at-cursor-beat');
      if (!cursor) return null;
      const rect = cursor.getBoundingClientRect();
      const style = getComputedStyle(cursor);
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: style.backgroundColor, opacity: style.opacity };
    })()`);
    assert.ok(cursorStart, 'animated alphaTab beat cursor is present');
    assert.ok(cursorStart.width >= 3 && cursorStart.height > 0, 'cursor has a visible three pixel bar');
    assert.notEqual(cursorStart.color, 'rgba(0, 0, 0, 0)', 'cursor uses a visible color');
    await new Promise(resolve => setTimeout(resolve, 1200));
    const cursorEnd = await cdp.evaluate(`(() => {
      const cursor = document.querySelector('.at-cursor-beat');
      const rect = cursor.getBoundingClientRect();
      return { x: rect.x, y: rect.y, position: document.getElementById('positionTxt').textContent };
    })()`);
    assert.ok(Math.abs(cursorEnd.x - cursorStart.x) > 0.5 || Math.abs(cursorEnd.y - cursorStart.y) > 0.5,
      'cursor coordinate changes while playback advances');
    const advancedTick = await cdp.evaluate('window.__testPosition?.currentTime ?? null');
    assert.notEqual(advancedTick, initialTick, 'real alphaTab playback time advances');
    assert.deepEqual(cdp.consoleErrors, [], 'normal playback produces no worker errors');

    await cdp.evaluate('document.getElementById("guideSoundBtn").click(); document.getElementById("metronomeBtn").click()');
    assert.equal(await cdp.evaluate('document.getElementById("guideSoundBtn").getAttribute("aria-pressed")'), 'false');
    assert.equal(await cdp.evaluate('document.getElementById("metronomeBtn").getAttribute("aria-pressed")'), 'true');
    assert.equal(await cdp.evaluate('document.getElementById("playPauseBtn").textContent'), '일시정지',
      'guide mute leaves playback running');
    const mutedPosition = await cdp.evaluate('document.getElementById("positionTxt").textContent');
    await new Promise(resolve => setTimeout(resolve, 1200));
    const mutedPositionAfter = await cdp.evaluate('document.getElementById("positionTxt").textContent');
    assert.notEqual(mutedPositionAfter, mutedPosition, 'guide off and metronome on still advances score time');
    await cdp.evaluate(`(() => {
      const speed = document.getElementById('speedRange');
      speed.value = '200';
      speed.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.equal(await cdp.evaluate('document.getElementById("speedTxt").textContent'), '200%');
    assert.equal(await cdp.evaluate('window.__testController?.api.playbackSpeed'), 2,
      'controller sets the real alphaTab playback speed');
    assert.equal(await cdp.evaluate('window.__testController?.api.metronomeVolume'), 1,
      'metronome remains enabled in the real alphaTab player');
    await cdp.evaluate('document.getElementById("playPauseBtn").click()');
    await waitForCondition(cdp, 'document.getElementById("playPauseBtn").textContent==="재생"');
    await cdp.evaluate('document.getElementById("stopBtn").click()');

    await cdp.evaluate(`(() => {
      const start = document.getElementById('loopStart');
      const end = document.getElementById('loopEnd');
      start.value = '1';
      end.value = '1';
      document.getElementById('loopEnable').checked = false;
      document.getElementById('applyLoopBtn').click();
    })()`);
    assert.equal(await cdp.evaluate('document.getElementById("appStatus").classList.contains("error")'), false,
      'valid loop range is accepted');
    await cdp.evaluate(`(() => {
      document.getElementById('loopEnable').checked = true;
      document.getElementById('applyLoopBtn').click();
      document.getElementById('playPauseBtn').click();
    })()`);
    await waitForCondition(cdp, 'document.getElementById("playPauseBtn").textContent==="일시정지"');
    const cursorXs = [];
    const loopDeadline = Date.now() + 6500;
    while (Date.now() < loopDeadline) {
      const x = await cdp.evaluate('document.querySelector(".at-cursor-beat")?.getBoundingClientRect().x ?? null');
      if (Number.isFinite(x)) cursorXs.push(x);
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    const loopWrapped = cursorXs.some((value, index) => index > 1
      && cursorXs.slice(0, index).some(previous => previous > value + 5));
    assert.ok(loopWrapped, 'cursor position wraps inside the selected one-bar loop');
    const loopRuntime = await cdp.evaluate(`(() => {
      const api = window.__testController?.api;
      return api && {
        tickPosition: api.tickPosition,
        startTick: api.playbackRange?.startTick,
        endTick: api.playbackRange?.endTick,
        isLooping: api.isLooping
      };
    })()`);
    assert.ok(loopRuntime?.isLooping, 'real alphaTab API has looping enabled');
    assert.ok(loopRuntime.tickPosition >= loopRuntime.startTick
      && loopRuntime.tickPosition <= loopRuntime.endTick,
    'real playback tick wraps within the selected bar range');
    await cdp.evaluate('document.getElementById("playPauseBtn").click(); document.getElementById("stopBtn").click()');
    await waitForCondition(cdp, 'document.getElementById("playPauseBtn").textContent==="재생"');
    const beforeSeekX = await cdp.evaluate('document.querySelector(".at-cursor-beat")?.getBoundingClientRect().x ?? null');
    assert.notEqual(beforeSeekX, null, 'cursor remains available before score seeking');
    const seekPosition = await cdp.evaluate(`(() => {
      const fret = Array.from(document.querySelectorAll('#score svg text'))
        .filter(node => /^\\d+$/.test(node.textContent.trim())).at(-1);
      const rect = fret.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: seekPosition.x, y: seekPosition.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: seekPosition.x, y: seekPosition.y, button: 'left', clickCount: 1 });
    await waitForCondition(cdp, `(() => {
      const cursor = document.querySelector('.at-cursor-beat');
      return cursor && Math.abs(cursor.getBoundingClientRect().x - ${beforeSeekX}) > 0.5;
    })()`);
    const afterSeekX = await cdp.evaluate('document.querySelector(".at-cursor-beat").getBoundingClientRect().x');
    assert.notEqual(afterSeekX, beforeSeekX, 'score click seeks the animated cursor');
    const persisted = await cdp.evaluate('({settings:localStorage.getItem("gs.player.v3"),mic:window.__micRequests||0})');
    assert.equal(persisted.mic, 0, 'the app never requests microphone access');
    assert.ok(persisted.settings.includes('200'), 'speed setting is stored');

    const fixtureText = '\\title "GP fixture"\n\\ts (3 4)\n:4 3.5 (0.3 1.2) 0.1 |\n3.5 (0.3 1.2) 0.1';
    await cdp.evaluate('document.getElementById("openNewSongBtn").click()');
    await waitForCondition(cdp, 'document.getElementById("editorDialog").open');
    await cdp.evaluate('document.getElementById("editorTitle").value="Invalid";document.getElementById("editorAlphaTex").value="!invalid alphaTex!";document.getElementById("saveSongBtn").click()');
    await waitForCondition(cdp, 'document.getElementById("editorMessage").textContent.length > 0');
    assert.equal(await cdp.evaluate('document.getElementById("editorDialog").open'), true,
      'invalid alphaTex keeps the editor open');
    await cdp.evaluate('document.getElementById("closeEditorBtn").click()');

    const engine = require('../src/tab-engine');
    const fixtureScore = engine.parseAlphaTex(fixtureText);
    const originalBytes = Buffer.from(engine.exportGp(fixtureScore));
    const originalBase64 = originalBytes.toString('base64');
    await cdp.evaluate(`(async () => {
      const binary = Uint8Array.from(atob('${originalBase64}'), char => char.charCodeAt(0));
      const file = new File([binary], 'fixture.gp', { type: 'application/octet-stream' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.getElementById('scoreFileInput');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitForCondition(cdp, 'document.getElementById("editorDialog").open', 5000);
    assert.match(await cdp.evaluate('document.getElementById("editorFileInfo").textContent'), /fixture\.gp/);
    await cdp.evaluate(`(() => {
      document.getElementById('editorTitle').value = 'GP preserved';
      document.getElementById('saveSongBtn').click();
    })()`);
    await waitForCondition(cdp,
      '!document.getElementById("editorDialog").open && document.getElementById("songTitle").textContent==="GP preserved"',
      12000);
    assert.deepEqual(cdp.consoleErrors, [], 'GP import and playback produce no worker errors');

    const storedBinary = await cdp.evaluate(`(async () => {
      const result = await GuitarLibrary.loadAll();
      const song = result.songs.find(item => item.title === 'GP preserved');
      return {
        format: song && song.format,
        fileName: song && song.fileName,
        bytes: song && btoa(String.fromCharCode(...new Uint8Array(song.bytes)))
      };
    })()`);
    assert.equal(storedBinary.format, 'binary', 'unmodified binary import remains binary after save');
    assert.equal(storedBinary.fileName, 'fixture.gp', 'binary source filename is retained');
    assert.equal(storedBinary.bytes, originalBase64, 'stored binary bytes match the imported file');

    await cdp.evaluate('document.getElementById("editSongBtn").click()');
    await waitForCondition(cdp, 'document.getElementById("editorDialog").open', 5000);
    const textChanged = await cdp.evaluate(`(() => {
      const editor = document.getElementById('editorAlphaTex');
      const previous = editor.value;
      editor.value = previous.replace('GP fixture', 'GP fixture edited');
      document.getElementById('editorTitle').value = 'GP text edited';
      return editor.value !== previous;
    })()`);
    assert.equal(textChanged, true, 'binary exporter text is available for editing');
    await cdp.evaluate('document.getElementById("saveSongBtn").click()');
    await waitForCondition(cdp,
      '!document.getElementById("editorDialog").open && document.getElementById("songTitle").textContent==="GP text edited"',
      12000);
    const editedBinarySource = await cdp.evaluate(`(async () => {
      const result = await GuitarLibrary.loadAll();
      const song = result.songs.find(item => item.title === 'GP text edited');
      const original = song && song.sourceOriginal;
      return {
        format: song && song.format,
        sourceFormat: original && original.format,
        fileName: original && original.fileName,
        bytes: original && btoa(String.fromCharCode(...new Uint8Array(original.bytes)))
      };
    })()`);
    assert.equal(editedBinarySource.format, 'alphatex', 'body edit converts saved record to alphaTex');
    assert.equal(editedBinarySource.sourceFormat, 'binary', 'edited text retains its original binary source');
    assert.equal(editedBinarySource.fileName, 'fixture.gp', 'edited text retains the source filename');
    assert.equal(editedBinarySource.bytes, originalBase64, 'edited text retains the exact original bytes');

    await cdp.evaluate(`(() => {
      const originalCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        window.__downloadBlob = blob;
        return originalCreate(blob);
      };
      document.getElementById('downloadSourceBtn').click();
    })()`);
    const downloadedBase64 = await cdp.evaluate(`(async () => {
      const bytes = new Uint8Array(await window.__downloadBlob.arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    })()`);
    assert.equal(downloadedBase64, originalBase64,
      'original download bytes exactly match the imported GP file');

    await cdp.evaluate(`(async () => {
      const response = await fetch('/test/fixtures/alphatab/simple.musicxml');
      const blob = await response.blob();
      const file = new File([blob], 'simple.musicxml', { type: 'application/vnd.recordare.musicxml+xml' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.getElementById('scoreFileInput');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitForCondition(cdp, 'document.getElementById("editorDialog").open', 5000);
    assert.match(await cdp.evaluate('document.getElementById("editorFileInfo").textContent'), /simple\.musicxml/);
    await cdp.evaluate('document.getElementById("editorTitle").focus()');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    });
    await waitForCondition(cdp, '!document.getElementById("editorDialog").open');
    assert.equal(await cdp.evaluate('document.getElementById("editorPreview")._api || null'), null,
      'native dialog close destroys the editor preview API');
    assert.deepEqual(cdp.consoleErrors, [], 'MusicXML import produces no browser errors');

    const alphaTexLiteral = JSON.stringify(fixtureText);
    await cdp.evaluate(`(() => {
      document.getElementById('openNewSongBtn').click();
      document.getElementById('editorTitle').value = 'Browser Saved';
      document.getElementById('editorAlphaTex').value = ${alphaTexLiteral};
      document.getElementById('saveSongBtn').click();
    })()`);
    await waitForCondition(cdp,
      '!document.getElementById("editorDialog").open && document.getElementById("songTitle").textContent==="Browser Saved"',
      12000);
    const savedId = await cdp.evaluate('document.getElementById("songSelect").value');
    await cdp.evaluate('document.getElementById("editSongBtn").click()');
    await waitForCondition(cdp, 'document.getElementById("editorDialog").open');
    assert.equal(await cdp.evaluate('document.getElementById("editorTitle").value'), 'Browser Saved',
      'saved personal song reopens for editing');
    await cdp.evaluate('document.getElementById("closeEditorBtn").click()');

    await cdp.send('Page.navigate', { url: appUrl });
    await waitForCondition(cdp,
      'document.readyState==="complete" && document.getElementById("songTitle").textContent==="Browser Saved"',
      15000);
    const restored = await cdp.evaluate('JSON.parse(localStorage.getItem("gs.player.v3"))');
    assert.equal(restored.songId, savedId, 'selected personal song restores after reload');
    assert.equal(restored.speed, 200, 'speed restores after reload');
    assert.equal(restored.guide, false, 'guide setting restores after reload');
    assert.equal(restored.loopEnabled, true, 'loop settings restore after reload');
    assert.deepEqual(cdp.consoleErrors, [], 'reloaded selected score has no worker errors');
    const restLoopTex = '\\ts (4 4) :4 0.1 r r r | :1 r | :4 0.1 r r r';
    await cdp.evaluate('(async () => {\n'
      + '  const controller = window.__testController;\n'
      + '  const score = { format: "alphatex", alphaTex: ' + JSON.stringify(restLoopTex) + ' };\n'
      + '  await controller.loadSong(score);\n'
      + '})()');
    assert.deepEqual(cdp.consoleErrors, [], 'rest-only measure score loads without worker errors');
    const restBarRange = await cdp.evaluate(`(() => {
      window.__testController.setLoop(2, 2, true);
      const range = window.__testController.api.playbackRange;
      return range.endTick - range.startTick;
    })()`);
    assert.equal(restBarRange, 3840, 'whole-rest bar loop spans the complete 4/4 measure');
    const trailingRestRange = await cdp.evaluate(`(() => {
      window.__testController.setLoop(1, 1, true);
      const range = window.__testController.api.playbackRange;
      return range.endTick - range.startTick;
    })()`);
    assert.equal(trailingRestRange, 3840, 'end-of-bar rests are included in the loop range');
    const rapidScores = [
      { format: 'alphatex', alphaTex: '\\ts (3 4) :4 0.1 r r | :4 0.2 r r' },
      { format: 'alphatex', alphaTex: '\\ts (4 4) :4 0.3 r r r | :4 0.4 r r r | :4 0.5 r r r' },
      { format: 'alphatex', alphaTex: '\\ts (2 4) :4 0.6 r | :4 0.2 r | :4 0.1 r' },
    ];
    const rapidScoresLiteral = JSON.stringify(rapidScores);
    const rapidLoadResults = await cdp.evaluate(`(async () => {
      const controller = window.__testController;
      const scores = ${rapidScoresLiteral};
      const previousScore = controller.getScore();
      const firstLoad = controller.loadSong(scores[0]);
      await Promise.resolve();
      const activeScore = controller.api.score;
      const firstScoreStarted = activeScore !== previousScore
        && activeScore?.masterBars?.[0]?.timeSignatureNumerator === 3;
      const secondLoad = controller.loadSong(scores[1]);
      const thirdLoad = controller.loadSong(scores[2]);
      const results = await Promise.all([firstLoad, secondLoad, thirdLoad]);
      const currentScore = controller.getScore();
      controller.setLoop(1, 3, true);
      const range = controller.api.playbackRange;
      const tickBars = controller.api.tickCache.masterBars;
      return {
        firstScoreStarted,
        lastResultMatches: results[2] === currentScore && controller.api.score === currentScore,
        scoreBars: currentScore.masterBars.length,
        renderedTickBars: tickBars.length,
        rangeStartMatches: range.startTick === tickBars[0].start,
        rangeEndMatches: range.endTick === tickBars[tickBars.length - 1].end
      };
    })()`);
    assert.equal(rapidLoadResults.firstScoreStarted, true,
      'score A becomes the active alphaTab score before B and C are requested');
    assert.equal(rapidLoadResults.lastResultMatches, true,
      'rapid A/B/C load resolves to the final C score');
    assert.equal(rapidLoadResults.scoreBars, 3, 'final score C has its expected three bars');
    assert.equal(rapidLoadResults.renderedTickBars, 3,
      'final render tick bounds belong to score C');
    assert.equal(rapidLoadResults.rangeStartMatches, true,
      'final render loop start matches score C bounds');
    assert.equal(rapidLoadResults.rangeEndMatches, true,
      'final render loop end matches score C bounds');
    const initialSongId = await cdp.evaluate(`(() => {
      const select = document.getElementById('songSelect');
      return select.options[0]?.value || null;
    })()`);
    await cdp.evaluate(`(() => {
      const select = document.getElementById('songSelect');
      select.value = select.options[0].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitForCondition(cdp,
      'document.getElementById("appStatus").textContent==="재생 준비 완료" && !document.getElementById("playPauseBtn").disabled',
      12000);
    await cdp.evaluate('document.getElementById("playPauseBtn").click()', true);
    await waitForCondition(cdp, 'document.getElementById("playPauseBtn").textContent==="일시정지"');
    await new Promise(resolve => setTimeout(resolve, 400));
    await cdp.evaluate('document.getElementById("playPauseBtn").click()');
    await waitForCondition(cdp, 'document.getElementById("playPauseBtn").textContent==="재생"');
    assert.ok(initialSongId, 'review screenshot uses the first sample score');
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const screenshotDir = path.join(root, 'test-artifacts');
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, 'alphatab-player-review.png'), Buffer.from(screenshot.data, 'base64'));
    process.stdout.write('Screenshot: ' + path.join(screenshotDir, 'alphatab-player-review.png') + '\n');
    assert.deepEqual(cdp.consoleErrors, [], 'normal song selection and playback produce no worker errors');
    assert.deepEqual(cdp.badResponses, [], 'all local assets load without HTTP errors');
    assert.deepEqual(cdp.failedRequests, [], 'all local asset requests complete');
    assert.deepEqual(cdp.consoleErrors, [], 'browser console has no errors');
    process.stdout.write('Result: alphaTab browser smoke passed (cursor, playback and loop timing, score seek, storage/editing, GP byte preservation, MusicXML, local assets, 0 mic requests, 0 console errors)\n');
    process.stdout.write('Screenshot: ' + path.join(screenshotDir, 'alphatab-player-review.png') + '\n');
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    server.close();
    if (resolvedProfileDir.startsWith(resolvedTempDir + path.sep)
      && path.basename(resolvedProfileDir).startsWith('gs-alpha-smoke-')) {
      try { fs.rmSync(resolvedProfileDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

main().catch(error => {
  console.error('Browser smoke test failed:', error);
  process.exitCode = 1;
});
