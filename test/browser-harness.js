'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const builtinSongsJson = JSON.parse(fs.readFileSync(path.join(root, 'songs.json'), 'utf8'));
const builtinSongCount = builtinSongsJson.length;
const pageSetScoreView = viewExpr => `(function(v){ var s = document.getElementById('scoreViewSelect'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); })(${viewExpr})`;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mjs': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.sf2': 'application/octet-stream',
  '.sf3': 'application/octet-stream'
};

function createStaticServer() {
  const servedPaths = [];
  const server = http.createServer((req, res) => {
    const rawPath = req.url.split('?')[0];
    servedPaths.push(rawPath);
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
      resolve({ server, port, servedPaths });
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
    this.dialogHandler = null;
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
        if (msg.method === 'Page.javascriptDialogOpening' && this.dialogHandler) {
          Promise.resolve(this.dialogHandler(msg.params)).catch(error => this.consoleErrors.push('dialog handler: ' + error.message));
        }
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

  async evaluate(expression, options = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: options.userGesture === true
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

async function waitForPageLoadAfter(client, previousLoadCount, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    if (count > previousLoadCount) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for a new Page.loadEventFired event');
}

const TEMP_PROFILE_PREFIX = 'gs-browser-smoke-';

function removeTempProfile(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// 이전 실행이 죽어서 남긴 임시 프로필(os.tmpdir() 바로 아래, 접두사가 같고 한 시간 넘은 폴더)만 치운다.
function removeStaleTempProfiles() {
  const base = os.tmpdir();
  const limit = Date.now() - 60 * 60 * 1000;
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(base); } catch (_) { return; }
  names.forEach(function(name) {
    if (!name.startsWith(TEMP_PROFILE_PREFIX)) return;
    const dir = path.join(base, name);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory() || stat.mtimeMs >= limit) return;
      removeTempProfile(dir);
      removed++;
    } catch (_) {}
  });
  if (removed > 0) process.stdout.write('Removed ' + removed + ' stale temp Chrome profiles\n');
}

// 우리가 띄운 크롬만 끄고(윈도에서는 프로세스 트리째), 프로세스가 실제로 끝날 때까지 기다린다.
function stopChrome(proc, timeoutMs) {
  return new Promise(function(resolve) {
    if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(resolve, timeoutMs);
    proc.once('exit', function() { clearTimeout(timer); resolve(); });
    if (process.platform === 'win32' && proc.pid) {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill();
    }
  });
}

async function runBrowserSuite(options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  const browserBin = findBrowserBinary();
  if (!browserBin) {
    process.stdout.write('SKIP: No Chrome or Edge binary found for browser test\n');
    return;
  }

  removeStaleTempProfiles();
  const { server, port: httpPort, servedPaths } = await createStaticServer();
  const cdpPort = 9333 + Math.floor(Math.random() * 200);
  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PROFILE_PREFIX));

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
    if (options.onNewDocument) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: options.onNewDocument });
    }

    if (options.startPath !== null) {
      const startPath = options.startPath || '/index.html';
      const readyExpr = options.readyExpr || ('document.readyState === "complete" && window.allSongs && window.allSongs.length === ' + builtinSongCount + ' && window.curSong != null');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}${startPath}` });
      await waitForCondition(cdp, readyExpr, options.readyTimeoutMs || 8000);
    }

    await fn({ cdp, httpPort, browserBin, servedPaths });
    assert.deepEqual(cdp.consoleErrors, [], 'no unhandled console errors in real browser execution');
  } finally {
    if (cdp) cdp.close();
    await stopChrome(chromeProc, 10000);
    server.close();
    try {
      removeTempProfile(tempProfileDir);
    } catch (error) {
      process.stderr.write('Warning: temp Chrome profile not removed: ' + tempProfileDir + ' (' + (error && error.code) + ')\n');
    }
  }
}

module.exports = {
  assert,
  fs,
  path,
  root,
  builtinSongsJson,
  builtinSongCount,
  pageSetScoreView,
  waitForCondition,
  waitForPageLoadAfter,
  runBrowserSuite
};
