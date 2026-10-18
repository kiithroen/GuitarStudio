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

    const bassBtnText = await cdp.evaluate('document.getElementById("toggleAutoBassBtn").textContent');
    assert.ok(bassBtnText.includes("꺼짐"), "autoBass toggle is off by default");
    const bassBtnActive = await cdp.evaluate('document.getElementById("toggleAutoBassBtn").classList.contains("active")');
    assert.equal(bassBtnActive, false, "autoBass button does not have active class by default");

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
