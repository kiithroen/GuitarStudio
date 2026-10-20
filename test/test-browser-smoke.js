const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const builtinSongsJson = JSON.parse(fs.readFileSync(path.join(root, 'songs.json'), 'utf8'));
const builtinSongCount = builtinSongsJson.length;
// 페이지 안에서 악보 보기 선택 목록을 사용자가 고른 것처럼 바꾸는 식(change 이벤트)
const pageSetScoreView = viewExpr => `(function(v){ var s = document.getElementById('scoreViewSelect'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); })(${viewExpr})`;

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
        if (msg.method === 'Page.javascriptDialogOpening' && this.dialogHandler){
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

async function waitForPageLoadAfter(client, previousLoadCount, timeoutMs = 10000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const count=client.events.filter(event=>event.method==='Page.loadEventFired').length;
    if(count>previousLoadCount)return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Timed out waiting for a new Page.loadEventFired event');
}

async function testTemporaryScoreEditor(client){
  const setup = await client.evaluate(`(function(){
    var edit = document.getElementById('editInInputBtn'), copy = document.getElementById('copyCurSongTsvBtn'), compact = document.getElementById('toggleCompactBtn');
    var controls = document.getElementById('scoreDraftControls');
    return {
      removed:['addBlankScoreBtn','blankScoreModal','undoScoreEditBtn'].every(function(id){ return !document.getElementById(id); }),
      controlsRow:!!controls && controls.contains(document.getElementById('scoreDraftStatus')) && controls.contains(document.getElementById('resetScoreDraftBtn')),
      editBeforeCopy:!!edit && edit.parentElement === compact.parentElement && edit.nextElementSibling === copy && copy.nextElementSibling === compact };
  })()`);
  assert.deepEqual(setup, { removed:true, controlsRow:true, editBeforeCopy:true }, 'draft controls and the edit button occupy their specified toolbar positions');

  const screenshotDir = path.join(root,'test-artifacts','temp-score-editor');
  fs.mkdirSync(screenshotDir,{recursive:true});
  const screenshotRun = Date.now();
  async function saveScreenshot(name,width,height,mobile){
    await client.send('Emulation.setDeviceMetricsOverride',{width:width,height:height,deviceScaleFactor:1,mobile:mobile});
    await client.evaluate('window.scrollTo(0,0)');
    const shot=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    const target=path.join(screenshotDir,name.replace('.png','-'+screenshotRun+'.png'));
    fs.writeFileSync(target,Buffer.from(shot.data,'base64'));
    const header=fs.readFileSync(target).subarray(0,24);
    assert.equal(header.readUInt32BE(16),width,'score toolbar screenshot width');
    assert.equal(header.readUInt32BE(20),height,'score toolbar screenshot height');
    process.stdout.write('Artifact: '+target+'\n');
    return target;
  }
  await saveScreenshot('toolbar-desktop.png',1280,900,false);
  await saveScreenshot('toolbar-mobile.png',390,844,true);
  await client.send('Emulation.clearDeviceMetricsOverride');

  await client.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  const ordinaryMobile=await client.evaluate(`(function(){
    var toolbar=document.getElementById('scoreToolbar'),right=document.querySelector('.score-toolbar-right'),panel=document.querySelector('section[aria-label="악보 및 메트로놈 커서"]');
    toolbar.scrollIntoView({block:'start'});
    var r=right.getBoundingClientRect(),p=panel.getBoundingClientRect();
    return {rightWithinPanel:r.right<=p.right+1,rightWithinViewport:r.right<=innerWidth+1,documentWithinViewport:document.documentElement.scrollWidth<=innerWidth+1,
      copyVisible:document.getElementById('copyCurSongTsvBtn').getClientRects().length>0,compactVisible:document.getElementById('toggleCompactBtn').getClientRects().length>0,
      editVisible:document.getElementById('editInInputBtn').getClientRects().length>0};
  })()`);
  assert.equal(ordinaryMobile.rightWithinPanel,true,'ordinary mobile score toolbar buttons stay inside the score panel');
  assert.equal(ordinaryMobile.rightWithinViewport,true,'ordinary mobile score toolbar stays within viewport');
  assert.equal(ordinaryMobile.documentWithinViewport,true,'ordinary mobile page has no document-wide horizontal overflow');
  assert.equal(ordinaryMobile.copyVisible,true,'ordinary mobile TSV copy control remains visible');
  assert.equal(ordinaryMobile.compactVisible,true,'ordinary mobile compact toggle remains visible');
  assert.equal(ordinaryMobile.editVisible,true,'ordinary mobile edit control remains visible');
  async function captureMobileToolbar(name){
    await client.evaluate(`document.getElementById('scoreToolbar').scrollIntoView({block:'start',inline:'nearest'})`);
    const shot=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    const target=path.join(screenshotDir,name+'-'+screenshotRun+'.png');
    fs.writeFileSync(target,Buffer.from(shot.data,'base64'));
    const header=fs.readFileSync(target).subarray(0,24);
    assert.equal(header.readUInt32BE(16),390,'mobile toolbar screenshot width');
    assert.equal(header.readUInt32BE(20),844,'mobile toolbar screenshot height');
    process.stdout.write('Artifact: '+target+'\n');
  }
  await captureMobileToolbar('ordinary-toolbar-mobile');
  const ordinaryToolbarCheck = await client.evaluate(`(function(){
    var play = document.getElementById('compactPlayBtn');
    var song = document.getElementById('compactSongSelect');
    return {
      playVisible: play && getComputedStyle(play).display !== 'none',
      songVisible: song && getComputedStyle(song).display !== 'none'
    };
  })()`);
  assert.equal(ordinaryToolbarCheck.playVisible, true, 'ordinary score toolbar exposes play button');
  assert.equal(ordinaryToolbarCheck.songVisible, true, 'ordinary score toolbar exposes song select');
  const rewindCheck = await client.evaluate(`(function(){
    var btn = document.getElementById('rewindToFirstBtn');
    if (!btn || getComputedStyle(btn).display === 'none') return { visible: false };
    // 임의 마디로 이동 후 버튼 클릭
    var lastCard = document.querySelector('#measuresGrid .measure-card:last-child');
    if (lastCard) lastCard.click();
    var beforeIdx = window.curMeasureIdx;
    btn.click();
    return {
      visible: true,
      beforeIdx: beforeIdx,
      afterIdx: window.curMeasureIdx
    };
  })()`);
  assert.equal(rewindCheck.visible, true, 'rewindToFirstBtn is visible in score toolbar');
  assert.equal(rewindCheck.afterIdx, 0, 'clicking rewindToFirstBtn restores active measure cursor to 0');
  const badStyleControl=await client.evaluate(`(function(){
    var style=document.createElement('style');style.textContent='.score-toolbar-right{min-width:420px !important;max-width:none !important;flex-shrink:0 !important}';document.head.appendChild(style);
    try {
      var right=document.querySelector('.score-toolbar-right').getBoundingClientRect();
      var panel=document.querySelector('section[aria-label="악보 및 메트로놈 커서"]').getBoundingClientRect();
      return {detected:right.right>panel.right+1||right.right>innerWidth+1||document.documentElement.scrollWidth>innerWidth+1};
    } finally {style.remove();}
  })()`);
  assert.equal(badStyleControl.detected,true,'mobile toolbar geometry checker detects an intentionally oversized CSS copy');
  const compactMobile=await client.evaluate(`(function(){
    var toolbar=document.getElementById('scoreToolbar');
    document.getElementById('toggleCompactBtn').click();
    toolbar.scrollLeft=0;
    var left={play:document.getElementById('compactPlayBtn').getClientRects().length>0&&getComputedStyle(document.getElementById('compactPlayBtn')).display!=='none',
      song:document.getElementById('compactSongSelect').getClientRects().length>0&&getComputedStyle(document.getElementById('compactSongSelect')).display!=='none',
      tab:document.getElementById('scoreViewSelect').getClientRects().length>0,
      noDocumentOverflow:document.documentElement.scrollWidth<=innerWidth+1};
    return left;
  })()`);
  assert.deepEqual(compactMobile,{play:true,song:true,tab:true,noDocumentOverflow:true},'390px compact toolbar exposes play, song selection, TAB control, and no page overflow');
  await captureMobileToolbar('compact-toolbar-mobile-left');
  const compactRight=await client.evaluate(`(function(){
    var toolbar=document.getElementById('scoreToolbar');toolbar.scrollLeft=toolbar.scrollWidth;
    var copy=document.getElementById('copyCurSongTsvBtn'),compact=document.getElementById('toggleCompactBtn');
    var c=copy.getBoundingClientRect(),t=compact.getBoundingClientRect(),r=toolbar.getBoundingClientRect();
    return {copyAccessible:copy.getClientRects().length>0&&!copy.hidden&&c.right<=innerWidth+1&&c.right<=r.right+1,
      compactAccessible:compact.getClientRects().length>0&&t.right<=innerWidth+1&&t.right<=r.right+1,
      noDocumentOverflow:document.documentElement.scrollWidth<=innerWidth+1};
  })()`);
  assert.deepEqual(compactRight,{copyAccessible:true,compactAccessible:true,noDocumentOverflow:true},'390px compact horizontal toolbar keeps copy and compact controls reachable without page overflow');
  await captureMobileToolbar('compact-toolbar-mobile-right');
  await client.evaluate(`document.getElementById('toggleCompactBtn').click()`);
  await client.send('Emulation.clearDeviceMetricsOverride');

  const copiedDraft=await client.evaluate(`(async function(){
    var previous=curSong,oldClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard'),copied='';
    var parsed=parseScore('[C] !1C4@2:i E4@1:p r r | "copy memo"',4);
    if(parsed.errors.length)throw new Error('TSV metadata fixture rejected: '+JSON.stringify(parsed.errors));
    try {
      curSong={id:'copy-metadata-fixture',title:'Copy metadata fixture',badge:'Capo 2',type:'structured',beats:4,bpm:77,capo:0,measures:parsed.measures};
      scoreEditorHooks.refreshStatus();
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:function(value){copied=value;return Promise.resolve();}}});
      document.getElementById('copyCurSongTsvBtn').click();
      await new Promise(function(resolve){setTimeout(resolve,0);});
      return {columns:copied.split('\t').length,hasChord:copied.includes('[C]'),hasApoyando:copied.includes('!1C4@2:i'),hasUnmarked:copied.includes(' E4@1:p'),hasTilde:copied.includes('~'),hasMemo:copied.includes('copy memo'),hasCapo:copied.includes('Capo 2'),statusVisible:!document.getElementById('scoreCopyStatus').hidden};
    } finally {curSong=previous;if(oldClipboard)Object.defineProperty(navigator,'clipboard',oldClipboard);else try{delete navigator.clipboard;}catch(_){};renderSong();}
  })()`);
  assert.deepEqual(copiedDraft,{columns:5,hasChord:true,hasApoyando:true,hasUnmarked:true,hasTilde:false,hasMemo:true,hasCapo:true,statusVisible:true},'actual TSV copy preserves score metadata and reveals its result status');

  const copiedPrompt=await client.evaluate(`(async function(){
    var oldClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard'),copied='';
    try {
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:function(value){copied=value;return Promise.resolve();}}});
      document.getElementById('copyScorePromptBtn').click();
      await new Promise(function(resolve){setTimeout(resolve,0);});
      return {same:copied===GuitarScorePrompt.buildScoreImagePrompt(),statusVisible:!document.getElementById('scorePromptStatus').hidden,buttonInSongBar:!!document.getElementById('copyScorePromptBtn').closest('.song-bar')};
    } finally {if(oldClipboard)Object.defineProperty(navigator,'clipboard',oldClipboard);else try{delete navigator.clipboard;}catch(_){}}
  })()`);
  assert.deepEqual(copiedPrompt,{same:true,statusVisible:true,buttonInSongBar:true},'photo conversion prompt button copies the generic prompt and reveals its status');

  const copiedProjectPrompt=await client.evaluate(`(async function(){
    var oldClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard'),copied='';
    try {
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:function(value){copied=value;return Promise.resolve();}}});
      document.getElementById('copyProjectPromptBtn').click();
      await new Promise(function(resolve){setTimeout(resolve,0);});
      return {same:copied===GuitarScorePrompt.buildProjectPrompt(),statusVisible:!document.getElementById('scorePromptStatus').hidden,buttonInSongBar:!!document.getElementById('copyProjectPromptBtn').closest('.song-bar')};
    } finally {if(oldClipboard)Object.defineProperty(navigator,'clipboard',oldClipboard);else try{delete navigator.clipboard;}catch(_){}}
  })()`);
  assert.deepEqual(copiedProjectPrompt,{same:true,statusVisible:true,buttonInSongBar:true},'project prompt button copies the short repository prompt and reveals its status');

  const uncertainMarks=await client.evaluate(`(function(){
    var previous=curSong,previousView=appState.scoreView;
    var parsed=parseScore('[C] C4 E4? G4 r? | "확인"',4);
    if(parsed.errors.length)throw new Error('uncertain fixture rejected: '+JSON.stringify(parsed.errors));
    var badge=document.getElementById('uncertainBadge');
    function count(){return document.querySelectorAll('#structuredScoreWrap .beat-cell.is-uncertain').length;}
    try {
      curSong={id:'uncertain-mark-fixture',title:'Uncertain mark fixture',badge:'fixture',type:'structured',beats:4,bpm:70,capo:0,measures:parsed.measures};
      ${pageSetScoreView("'tab'")};
      renderSong();
      var tab=count(),badgeHidden=badge.hidden,badgeText=badge.textContent;
      ${pageSetScoreView("'card'")};
      var card=count();
      return {tab:tab,card:card,badgeHidden:badgeHidden,badgeText:badgeText};
    } finally {
      curSong=previous;
      ${pageSetScoreView("previousView==='card'?'card':'tab'")};
      renderSong();
    }
  })()`);
  assert.deepEqual(uncertainMarks,{tab:2,card:2,badgeHidden:false,badgeText:'확인 2곳'},'uncertain-marked beats are highlighted in TAB and card views and counted in the toolbar badge');
  const badgeAfterRestore=await client.evaluate(`document.getElementById('uncertainBadge').hidden`);
  assert.equal(badgeAfterRestore,true,'uncertain badge hides again on a score without marks');

  // 입력 화면 출처(tab-input)가 아닌 초안은 떠날 때 경고하고, 새로고침하면 사라진다. 원본은 그대로다.
  let beforeUnloadDialogs=0;
  client.dialogHandler = async params => {
    if(params.type==='beforeunload') beforeUnloadDialogs++;
    await client.send('Page.handleJavaScriptDialog',{accept:true});
  };
  const sourceText = await client.evaluate(`(function(){
    var source=BUILTIN_SONGS.find(function(song){return song.id==='builtin-lv1-butterfly';});
    var text=serializeScoreMeasures(source.measures,'\\n');
    var lines=text.split('\\n');
    lines[lines.length-1]='[-] '+new Array(source.beats).fill('r').join(' ');
    scoreDrafts.replaceScore(source,lines);
    rebuildSongSelect(source.id);
    document.body.click();
    return text;
  })()`,{userGesture:true});
  assert.equal(await client.evaluate(`scoreDrafts.status('builtin-lv1-butterfly').dirty`),true,'a draft without the tab-input origin is dirty');
  const previousLoadCount=client.events.filter(event=>event.method==='Page.loadEventFired').length;
  await client.send('Page.reload',{ignoreCache:true});
  await waitForPageLoadAfter(client,previousLoadCount);
  await waitForCondition(client,'document.readyState === "complete" && window.allSongs && window.allSongs.length === '+builtinSongCount+' && window.curSong',8000);
  client.dialogHandler=null;
  assert.equal(beforeUnloadDialogs,1,'dirty draft without the tab-input origin raises the native beforeunload confirmation');
  const reloadState=await client.evaluate(`({tempCount:allSongs.filter(function(song){return String(song.id).startsWith('temp-score-');}).length,
    dirty:scoreDrafts.status('builtin-lv1-butterfly').dirty,sourceScore:serializeScoreMeasures(BUILTIN_SONGS.find(function(song){return song.id==='builtin-lv1-butterfly';}).measures,'\\n')})`);
  assert.equal(reloadState.tempCount,0,'temporary scores disappear on reload');
  assert.equal(reloadState.dirty,false,'edited builtin draft disappears on reload');
  assert.equal(reloadState.sourceScore,sourceText,'builtin source remains unchanged after reload');
  process.stdout.write('Browser checkpoint: draft controls, toolbar geometry, TSV copy, prompts, uncertain marks, and draft loss on reload passed\n');
}

// 연습 화면의 편집은 악보 입력 화면으로 넘기고, 고쳐 돌아오면 원래 곡의 수정 초안이 된다.
async function testEditHandoff(client, httpPort) {
  const SONG_ID = 'builtin-lv1-butterfly';
  const song = builtinSongsJson.find(item => item.id === SONG_ID);
  const practiceUrl = `http://127.0.0.1:${httpPort}/index.html`;
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  const practiceReady = 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null';
  const inputReady = 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1';
  const dialogs = [];
  let confirmAnswer = true;
  client.dialogHandler = async params => {
    dialogs.push({ type: params.type, message: params.message });
    await client.send('Page.handleJavaScriptDialog', { accept: params.type === 'confirm' ? confirmAnswer : true });
  };
  async function go(action, readyExpression) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await action();
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, readyExpression, 8000);
  }
  const navigate = (url, ready) => go(() => client.send('Page.navigate', { url }), ready);
  const clickAndLeave = (selector, ready) => go(() => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`, { userGesture: true }), ready);
  const errorsBefore = client.consoleErrors.length;
  const KEY_HELPER = `function key(k, code, mods){ document.body.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key:k, code:code, bubbles:true, cancelable:true }, mods || {}))); }`;
  const clearInputKeys = `(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`;
  const originalText = `serializeScoreMeasures(BUILTIN_SONGS.find(function(item){ return item.id === ${JSON.stringify(SONG_ID)}; }).measures, '\\n')`;
  async function selectSong() {
    await client.evaluate(`changeSongById(${JSON.stringify(SONG_ID)}); true`);
    assert.equal(await client.evaluate('curSong.id'), SONG_ID, 'the built-in song is selected');
  }

  // 1. 연습 화면: 지워진 편집 UI, 마디 머리 편집 단추, 툴바 악보 편집
  await navigate(practiceUrl, practiceReady);
  await client.evaluate(clearInputKeys);
  await selectSong();
  const practice = await client.evaluate(`(function(){
    var cards = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .measure-card'));
    var third = document.querySelector('#measuresGrid .measure-card[data-m="2"] .score-measure-edit');
    var tool = document.getElementById('editInInputBtn');
    return {
      removed:['addBlankScoreBtn', 'blankScoreModal', 'undoScoreEditBtn'].map(function(id){ return !!document.getElementById(id); }),
      oldMenus:document.querySelectorAll('.score-measure-menu, .score-measure-menu-button, .score-inline-editor').length,
      cards:cards.length,
      oneEditPerCard:cards.every(function(card){ return card.querySelectorAll('.m-head .score-measure-edit').length === 1; }),
      memo:(function(){
        var memos = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .m-lyric'));
        return {
          count:memos.length,
          allInHead:memos.every(function(el){ return !!el.closest('.m-head'); }),
          directChildren:document.querySelectorAll('#measuresGrid .measure-card > .m-lyric').length,
          titlesMatch:memos.every(function(el){ return el.title === el.textContent; }),
          ellipsis:memos.every(function(el){ var cs = getComputedStyle(el); return cs.whiteSpace === 'nowrap' && cs.textOverflow === 'ellipsis'; }),
          headsCompact:memos.every(function(el){ var head = el.closest('.m-head'); var btn = head && head.querySelector('.score-measure-edit'); return !!btn && head.getBoundingClientRect().height <= btn.getBoundingClientRect().height + 12; }),
          // 메모를 일부러 아주 길게 늘려도 마디 번호·코드 글자는 한 줄로 남고 머리 줄이 늘지 않는다
          // (줄바꿈되면 글 범위의 줄 상자가 둘 이상). 테스트 곡 메모는 짧아서 늘리지 않으면 이 경우를 못 본다.
          labelsOneLine:(function(){
            var el = memos[0];
            var head = el && el.closest('.m-head');
            var btn = head && head.querySelector('.score-measure-edit');
            if (!btn) return false;
            var original = el.textContent;
            el.textContent = original + ' ' + new Array(60).join('아주 긴 메모 ');
            var ok = Array.prototype.every.call(head.querySelectorAll('.m-num, .m-chord'), function(label){ var range = document.createRange(); range.selectNodeContents(label); return range.getClientRects().length === 1; })
              && head.getBoundingClientRect().height <= btn.getBoundingClientRect().height + 12;
            el.textContent = original;
            return ok;
          })()
        };
      })(),
      third:{ text:third.textContent, title:third.title, aria:third.getAttribute('aria-label') },
      tool:{ visible:!tool.hidden && tool.getClientRects().length > 0, text:tool.textContent.trim(), title:tool.title, before:tool.nextElementSibling === document.getElementById('copyCurSongTsvBtn') },
      resetHidden:document.getElementById('resetScoreDraftBtn').hidden,
      original:${originalText}
    };
  })()`);
  assert.deepEqual(practice.removed, [false, false, false], 'the blank score button, its modal and the undo button are gone');
  assert.equal(practice.oldMenus, 0, 'the measure menu and the inline editor are gone');
  assert.ok(practice.cards >= 3, 'the fixture song has at least three measures');
  assert.equal(practice.oneEditPerCard, true, 'every TAB card has exactly one edit button in its head');
  assert.ok(practice.memo.count >= 1, 'the fixture song shows measure memos');
  assert.equal(practice.memo.allInHead, true, 'every measure memo sits in the card head');
  assert.equal(practice.memo.directChildren, 0, 'no measure memo is a direct child of a card');
  assert.equal(practice.memo.titlesMatch, true, 'every measure memo title carries the full text');
  assert.equal(practice.memo.ellipsis, true, 'every measure memo truncates to one line with an ellipsis');
  assert.equal(practice.memo.headsCompact, true, 'a memo does not grow the card head beyond the edit button row');
  assert.equal(practice.memo.labelsOneLine, true, 'a long memo never wraps the measure number or chord label');
  assert.deepEqual(practice.third, { text: '편집', title: '이 마디부터 악보 입력에서 편집', aria: '3마디부터 편집' }, 'the measure edit button names the measure');
  assert.deepEqual(practice.tool, { visible: true, text: '악보 편집', title: '악보 입력 화면에서 이 곡을 고칩니다', before: true }, 'the toolbar edit button shows for a text score');
  assert.equal(practice.resetHidden, true, 'an untouched original has no revert button');
  assert.equal(await client.evaluate(`(function(){ var el = document.getElementById('capoBadge'); return curCapo() === 0 && !!el && el.hidden && getComputedStyle(el).display === 'none'; })()`), true, 'a built-in song without a capo hides the capo badge');
  const imageToolbar = await client.evaluate(`(function(){
    var previous = curSong;
    try {
      curSong = { id:'edit-link-image-fixture', title:'Image fixture', type:'image', badge:'fixture', bpm:77, imageDataUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', systems:[{ x:0.1, y:0.1, w:0.8, h:0.3, bars:[{ chord:'C', note:'C4', memo:'', w:1 }] }] };
      renderSong();
      return document.getElementById('editInInputBtn').hidden;
    } finally { curSong = previous; renderSong(); }
  })()`);
  assert.equal(imageToolbar, true, 'the toolbar edit button hides for an image score');
  assert.equal(await client.evaluate('document.getElementById("editInInputBtn").hidden'), false, 'the toolbar edit button shows again for the text score');
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  async function shot(name, width, height) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const data = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const target = path.join(root, 'test-artifacts', name);
    fs.writeFileSync(target, Buffer.from(data.data, 'base64'));
    const header = fs.readFileSync(target).subarray(0, 24);
    assert.equal(header.readUInt32BE(16), width, name + ' width');
    assert.equal(header.readUInt32BE(20), height, name + ' height');
    process.stdout.write('Artifact: ' + target + '\n');
    await client.send('Emulation.clearDeviceMetricsOverride');
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate('window.scrollTo(0, document.getElementById("scoreToolbar").getBoundingClientRect().top + window.scrollY - 8); true');
  await shot('edit-link-practice.png', 1280, 900);

  // 2. 3마디 편집 -> 악보 입력 화면이 그 곡을 3마디에서 연다
  await clickAndLeave('#measuresGrid .measure-card[data-m="2"] .score-measure-edit', inputReady);
  const input = await client.evaluate(`(function(){
    var info = document.getElementById('tiSourceInfo');
    return {
      path:location.pathname,
      title:document.getElementById('tiTitle').value,
      measures:document.querySelectorAll('#tiMeasures .ti-measure').length,
      expected:splitScoreMeasures(${JSON.stringify(song.lines)}.join('\\n')).length,
      cursor:document.getElementById('tiCursorLabel').textContent,
      sourceInfoShown:!info.hidden && info.getClientRects().length > 0,
      sourceInfo:info.textContent,
      status:document.getElementById('tiStatus').textContent,
      openKeyLeft:localStorage.getItem('gs.tabInput.open'),
      savedSourceId:JSON.parse(localStorage.getItem('gs.tabInput.doc')).sourceId
    };
  })()`);
  assert.equal(input.path, '/score-input.html', 'the edit button goes to the score input screen');
  assert.equal(input.title, song.title, 'the input screen opens the song title');
  assert.equal(input.measures, input.expected, 'the input screen has the same number of measures');
  assert.ok(input.cursor.startsWith('3마디 · '), 'the cursor starts at the measure the edit button belongs to (is ' + input.cursor + ')');
  assert.equal(input.sourceInfoShown, true, 'the input screen says which song is being edited');
  assert.match(input.sourceInfo, /연습 화면 곡을 고치는 중/);
  assert.equal(input.status, '연습 화면에서 "' + song.title + '"을 열었습니다 · 3마디부터', 'the status line reports the opened song and measure');
  assert.equal(input.openKeyLeft, null, 'the open key is consumed');
  assert.equal(input.savedSourceId, SONG_ID, 'the auto saved work remembers the source song id');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`(function(){ window.scrollTo(0, 0); var slot = document.querySelector('.ti-slot.is-cursor-slot'); if (slot) slot.scrollIntoView({ block: 'nearest' }); return true; })()`);
  await shot('edit-link-input.png', 1280, 900);

  // 3. 음 하나를 바꾸고 연습 화면에서 열기 -> 원래 곡의 수정 초안
  const edited = await client.evaluate(`(function(){
    ${KEY_HELPER}
    function line(){ return document.getElementById('tiScoreText').value.split('\\n')[2]; }
    var before = line();
    key('5', 'Digit5');
    if (line() === before) key('7', 'Digit7');
    return { before:before, after:line() };
  })()`);
  assert.notEqual(edited.after, edited.before, 'the keyboard changed a note in measure 3');
  await clickAndLeave('#tiOpenPracticeBtn', practiceReady);
  const draft = await client.evaluate(`(function(){
    var status = scoreDrafts.status(curSong.id);
    var lines = serializeScoreMeasures(curSong.measures, '\\n').split('\\n');
    var source = ${originalText}.split('\\n');
    return {
      path:location.pathname, id:curSong.id, selected:document.getElementById('songSelect').value, title:curSong.title, bpm:curSong.bpm,
      status:{ dirty:status.dirty, temporary:status.temporary, origin:status.origin },
      statusText:document.getElementById('scoreDraftStatus').textContent, resetShown:!document.getElementById('resetScoreDraftBtn').hidden,
      line:lines[2], count:lines.length, sourceLine:source[2], sourceCount:source.length,
      sourceUnchanged:source.join('\\n') === ${JSON.stringify(practice.original)}, handoffLeft:localStorage.getItem('gs.tabInput.handoff')
    };
  })()`);
  assert.equal(draft.path, '/index.html', 'open-in-practice goes to the practice screen');
  assert.equal(draft.id, SONG_ID, 'the edited song opens as the original song id');
  assert.equal(draft.selected, SONG_ID, 'the original song is selected in the song list');
  assert.deepEqual([draft.title, draft.bpm], [song.title, song.bpm], 'title and BPM stay the original ones');
  assert.deepEqual(draft.status, { dirty: true, temporary: false, origin: 'tab-input' }, 'the song is a modified draft from the input screen');
  assert.match(draft.statusText, /악보 입력에서 고친 수정 초안/, 'the status line names the draft');
  assert.equal(draft.resetShown, true, 'the revert button shows for the draft');
  assert.equal(draft.line, edited.after, 'the edited measure carries the typed note');
  assert.notEqual(draft.line, draft.sourceLine, 'the draft measure differs from the original measure');
  assert.equal(draft.count, draft.sourceCount, 'the draft keeps the measure count');
  assert.equal(draft.sourceUnchanged, true, 'the built-in source is untouched');
  assert.equal(draft.handoffLeft, null, 'the hand-off key is consumed');

  // 4. 원본 복원
  await client.evaluate(`document.getElementById('resetScoreDraftBtn').click(); true`);
  const reverted = await client.evaluate(`(function(){
    var status = scoreDrafts.status(curSong.id);
    return { text:serializeScoreMeasures(curSong.measures, '\\n'), dirty:status.dirty, origin:status.origin, resetHidden:document.getElementById('resetScoreDraftBtn').hidden, statusText:document.getElementById('scoreDraftStatus').textContent };
  })()`);
  assert.equal(reverted.text, practice.original, 'the revert button brings back the original measures');
  assert.deepEqual([reverted.dirty, reverted.origin, reverted.resetHidden, reverted.statusText], [false, null, true, ''], 'the revert clears the draft state');

  // 4-2. 마디 글은 그대로이고 조표만 바꿔 돌아오면 원래 곡의 수정 초안이다. 원본으로 되돌리면 조표도 원본대로다.
  await client.evaluate(`localStorage.setItem('gs.tabInput.handoff', JSON.stringify({ sourceId:${JSON.stringify(SONG_ID)}, title:'not used', beats:${song.beats}, bpm:${song.bpm}, badge:'', lines:${originalText}.split('\\n'), key:1, savedAt:Date.now() })); true`);
  await navigate(practiceUrl, practiceReady);
  const keyOnly = await client.evaluate(`(function(){
    var status = scoreDrafts.status(curSong.id);
    var source = BUILTIN_SONGS.find(function(item){ return item.id === ${JSON.stringify(SONG_ID)}; });
    return { id:curSong.id, key:curSong.key, sourceKey:source.key, dirty:status.dirty, origin:status.origin, temporary:status.temporary,
      sameText:serializeScoreMeasures(curSong.measures, '\\n') === ${JSON.stringify(practice.original)}, resetShown:!document.getElementById('resetScoreDraftBtn').hidden };
  })()`);
  assert.equal(keyOnly.id, SONG_ID, 'a key-only change opens as the original song id');
  assert.equal(keyOnly.sameText, true, 'the measures are the original ones');
  assert.equal(keyOnly.key, 1, 'the key signature follows the hand-off');
  assert.deepEqual([keyOnly.dirty, keyOnly.temporary, keyOnly.origin, keyOnly.resetShown], [true, false, 'tab-input', true], 'a key-only change is a modified draft with a revert button');
  await client.evaluate(`document.getElementById('resetScoreDraftBtn').click(); true`);
  const keyReverted = await client.evaluate(`({ key:curSong.key, dirty:scoreDrafts.status(curSong.id).dirty, resetHidden:document.getElementById('resetScoreDraftBtn').hidden })`);
  assert.equal(keyReverted.key == null ? null : keyReverted.key, keyOnly.sourceKey == null ? null : keyOnly.sourceKey, 'reverting restores the original key');
  assert.deepEqual([keyReverted.dirty, keyReverted.resetHidden], [false, true], 'reverting clears the draft state');

  // 4-2b. 입력 화면에서 콤보박스로 고른 카포가 연습 화면의 수정 초안에 들어가고, 원본 복원이 되돌린다.
  await selectSong();
  await clickAndLeave('#editInInputBtn', inputReady);
  await client.evaluate(`(function(){ var select = document.getElementById('tiCapoSelect'); select.value = '3'; select.dispatchEvent(new Event('change', { bubbles:true })); return true; })()`);
  await clickAndLeave('#tiOpenPracticeBtn', practiceReady);
  const capoBadgeProbe = `(function(){ var el = document.getElementById('capoBadge'); return { shown:!!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0, text:el ? el.textContent : null, title:el ? el.title : null }; })()`;
  const capoDraft = await client.evaluate(`({ id:curSong.id, capo:curCapo(), badge:${capoBadgeProbe}, resetShown:!document.getElementById('resetScoreDraftBtn').hidden, dirty:scoreDrafts.status(curSong.id).dirty })`);
  assert.equal(capoDraft.id, SONG_ID, 'a capo-only change opens as the original song id');
  assert.equal(capoDraft.capo, 3, 'the practice screen plays the capo picked on the input screen');
  assert.equal(capoDraft.badge.shown, true, 'the practice toolbar shows the capo badge for a capo 3 draft');
  assert.equal(capoDraft.badge.text, '카포 3', 'the capo badge names the capo');
  assert.equal(capoDraft.badge.title, '타브·지판은 카포 기준 프렛 · 소리 3반음 위', 'the capo badge tooltip explains the capo');
  assert.deepEqual([capoDraft.resetShown, capoDraft.dirty], [true, true], 'a capo-only change is a modified draft with a revert button');
  // 카포 배지가 보이는 상태에서도 툴바가 패널 안에 있고 페이지 가로 넘침이 없다.
  const capoToolbarFit = `(function(){
    var right = document.querySelector('.score-toolbar-right').getBoundingClientRect();
    var panel = document.querySelector('section[aria-label="악보 및 메트로놈 커서"]').getBoundingClientRect();
    return { rightWithinPanel:right.right <= panel.right + 1, rightWithinViewport:right.right <= innerWidth + 1, noDocumentOverflow:document.documentElement.scrollWidth <= innerWidth + 1 };
  })()`;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(await client.evaluate(capoToolbarFit), { rightWithinPanel:true, rightWithinViewport:true, noDocumentOverflow:true }, '1024px toolbar with the capo badge stays inside the panel');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.deepEqual(await client.evaluate(capoToolbarFit), { rightWithinPanel:true, rightWithinViewport:true, noDocumentOverflow:true }, '390px toolbar with the capo badge stays inside the panel');
  await client.evaluate(`setCompactPractice(true); true`);
  const capoCompactMobile = await client.evaluate(`(function(){ var r = ${capoBadgeProbe}; r.noDocumentOverflow = document.documentElement.scrollWidth <= innerWidth + 1; r.compact = document.body.classList.contains('practice-compact'); return r; })()`);
  assert.deepEqual([capoCompactMobile.compact, capoCompactMobile.shown, capoCompactMobile.text, capoCompactMobile.noDocumentOverflow], [true, true, '카포 3', true], '390px compact mode still shows the capo badge without page overflow');
  await client.evaluate(`setCompactPractice(false); true`);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`setCompactPractice(true); true`);
  const capoCompactDesktop = await client.evaluate(`(function(){ var r = ${capoBadgeProbe}; r.compact = document.body.classList.contains('practice-compact'); return r; })()`);
  assert.deepEqual([capoCompactDesktop.compact, capoCompactDesktop.shown, capoCompactDesktop.text], [true, true, '카포 3'], 'compact mode shows the capo badge for a capo 3 draft');
  await client.evaluate(`setCompactPractice(false); true`);
  assert.equal(await client.evaluate(`document.body.classList.contains('practice-compact')`), false, 'compact mode is off again');
  // 일반 모드 툴바 항목이 폭 640~1092에서 서로 겹치지 않는다(폴드7을 펼친 화면 근처 포함). BPM 배지는 일반 모드에서 숨는다.
  const toolbarFitProbe = `(function(){
    function visible(el){ return !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'; }
    var items = [];
    ['compactPlayBtn', 'rewindToFirstBtn', 'compactSongSelect', 'scoreViewSelect', 'capoBadge', 'uncertainBadge'].forEach(function(id){
      var el = document.getElementById(id);
      if (visible(el)) items.push({ id:id, el:el });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.score-toolbar-right > *'), function(el){
      if (visible(el)) items.push({ id:el.id || el.className, el:el });
    });
    var rects = items.map(function(item){ var r = item.el.getBoundingClientRect(); return { id:item.id, left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:Math.round(r.width * 10) / 10 }; });
    var overlaps = [];
    for (var i = 0; i < rects.length; i++) for (var j = i + 1; j < rects.length; j++) {
      var a = rects[i], b = rects[j];
      var overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      var overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > 1 && overlapY > 1) overlaps.push(a.id + ' x ' + b.id + ' (' + Math.round(overlapX * 10) / 10 + 'px)');
    }
    var toolbar = document.getElementById('scoreToolbar');
    var status = document.getElementById('compactStatusBadge');
    var capo = document.getElementById('capoBadge');
    return {
      overlaps:overlaps,
      widths:rects.map(function(r){ return r.id + '=' + r.width; }).join(' '),
      statusShown:status.getClientRects().length > 0,
      capoShown:visible(capo) && capo.textContent === '카포 3',
      scrollWidth:toolbar.scrollWidth, clientWidth:toolbar.clientWidth
    };
  })()`;
  for (const fitWidth of [640, 768, 900, 984, 1092]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width: fitWidth, height: 1000, deviceScaleFactor: 1, mobile: false });
    const fit = await client.evaluate(toolbarFitProbe);
    assert.deepEqual(fit.overlaps, [], fitWidth + 'px toolbar items overlap: ' + fit.overlaps.join(', ') + ' [' + fit.widths + ']');
    assert.equal(fit.statusShown, false, fitWidth + 'px normal mode hides the BPM badge');
    assert.equal(fit.capoShown, true, fitWidth + 'px toolbar shows the capo 3 badge');
    if (fitWidth >= 900) assert.ok(fit.scrollWidth <= fit.clientWidth + 1, fitWidth + 'px toolbar has no horizontal scroll (' + fit.scrollWidth + ' > ' + fit.clientWidth + ') [' + fit.widths + ']');
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`setCompactPractice(true); true`);
  assert.equal(await client.evaluate(`document.getElementById('compactStatusBadge').getClientRects().length > 0`), true, '900px compact mode still shows the BPM badge');
  await client.evaluate(`setCompactPractice(false); true`);
  // 코드 카드의 시작 프렛 글자("3fr", "10fr")가 그림 폭 안에 다 들어가는지 실제 글자 상자로 본다.
  const clippedFretLabels = await client.evaluate(`(function(){
    var host = document.createElement('div');
    document.body.appendChild(host);
    var clipped = [];
    Object.keys(GuitarParser.CHORD_DB).forEach(function(name){
      var svg = buildChordSvg(GuitarParser.CHORD_DB[name].frets, GuitarParser.CHORD_DB[name].fingers);
      host.appendChild(svg);
      var width = Number(svg.getAttribute('viewBox').split(' ')[2]);
      Array.prototype.forEach.call(svg.querySelectorAll('text'), function(text){
        if (!/fr$/.test(text.textContent)) return;
        var box = text.getBBox();
        if (box.x < 0 || box.x + box.width > width) clipped.push(name + ' ' + text.textContent + ' ' + Math.round(box.x + box.width) + '>' + width);
      });
    });
    host.remove();
    return clipped;
  })()`);
  assert.deepEqual(clippedFretLabels, [], 'chord card start-fret labels fit inside the drawing: ' + clippedFretLabels.join(', '));
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await client.evaluate('window.scrollTo(0, document.getElementById("scoreToolbar").getBoundingClientRect().top + window.scrollY - 8); true');
  await shot('practice-capo-badge.png', 1024, 768);
  await client.evaluate(`document.getElementById('resetScoreDraftBtn').click(); true`);
  assert.equal(await client.evaluate('curCapo()'), 0, 'reverting the draft restores the original capo');
  assert.equal((await client.evaluate(capoBadgeProbe)).shown, false, 'reverting the draft hides the capo badge');

  // 4-3. 입력 화면에서 칸 수를 바꿔 돌아오면 원래 곡 대신 새 임시 악보로 열고 알려 준다.
  await selectSong();
  await clickAndLeave('#editInInputBtn', inputReady);
  const newBeats = song.beats === 3 ? '2' : '3';
  await client.evaluate(`(function(){ var select = document.getElementById('tiBeats'); select.value = ${JSON.stringify(newBeats)}; select.dispatchEvent(new Event('change', { bubbles:true })); return true; })()`);
  assert.equal(await client.evaluate('document.getElementById("tiBeats").value'), newBeats, 'the input screen changed the cell count');
  await clickAndLeave('#tiOpenPracticeBtn', practiceReady);
  const beatsChanged = await client.evaluate(`(function(){
    var option = document.getElementById('songSelect').selectedOptions[0];
    var status = document.getElementById('storageStatus');
    return { id:curSong.id, title:curSong.title, beats:curSong.beats, group:option && option.parentElement ? option.parentElement.label : null,
      notice:status.textContent, noticeHidden:status.hidden, sourceDirty:scoreDrafts.status(${JSON.stringify(SONG_ID)}).dirty };
  })()`);
  assert.ok(/^temp-score-\d+$/.test(beatsChanged.id), 'a changed cell count opens a new temporary score (is ' + beatsChanged.id + ')');
  assert.equal(beatsChanged.beats, Number(newBeats), 'the temporary score has the new cell count');
  assert.equal(beatsChanged.group, '임시 악보');
  assert.equal(beatsChanged.noticeHidden, false, 'the storage status line is shown');
  assert.equal(beatsChanged.notice, '칸 수가 바뀌어서 원래 곡 대신 새 임시 악보로 열었습니다.', 'the storage status line explains the new temporary score');
  assert.equal(beatsChanged.sourceDirty, false, 'the original song gets no draft');

  // 5. 입력 화면에 다른 작업이 있으면 바꿀지 묻는다
  await navigate(inputUrl, inputReady);
  await client.evaluate(`(function(){
    window.confirm = function(){ return true; };
    document.getElementById('tiNewBtn').click();
    document.querySelector('.ti-slot[data-m="0"][data-c="0"][data-s="0"] .ti-pos[data-str="6"]').click();
    document.querySelector('.ti-fret[data-str="6"][data-fret="0"]').click();
    return true;
  })()`);
  const work = await client.evaluate(`({ text:document.getElementById('tiScoreText').value, title:document.getElementById('tiTitle').value })`);
  assert.equal(work.text.split('\n')[0], '[-] E2@6 - - - | ""', 'the other work has a note');
  await navigate(practiceUrl, practiceReady);
  await selectSong();
  dialogs.length = 0;
  confirmAnswer = false;
  await clickAndLeave('#editInInputBtn', inputReady);
  const refused = await client.evaluate(`({ text:document.getElementById('tiScoreText').value, title:document.getElementById('tiTitle').value, sourceInfoHidden:document.getElementById('tiSourceInfo').hidden,
    status:document.getElementById('tiStatus').textContent, openKeyLeft:localStorage.getItem('gs.tabInput.open') })`);
  const confirms = dialogs.filter(item => item.type === 'confirm');
  assert.equal(confirms.length, 1, 'one confirmation is asked when the input screen has other work');
  assert.ok(confirms[0].message.includes(song.title) && confirms[0].message.includes('지금 작업'), 'the confirmation names the song and the current work');
  assert.deepEqual([refused.text, refused.title, refused.sourceInfoHidden], [work.text, work.title, true], 'refusing keeps the current work');
  assert.equal(refused.status, '연습 화면에서 넘긴 악보를 열지 않았습니다.', 'the status line says the score was not opened');
  assert.equal(refused.openKeyLeft, null, 'a refused hand-off is consumed too');
  await navigate(practiceUrl, practiceReady);
  await selectSong();
  dialogs.length = 0;
  confirmAnswer = true;
  await clickAndLeave('#editInInputBtn', inputReady);
  const accepted = await client.evaluate(`({ title:document.getElementById('tiTitle').value, sourceInfoHidden:document.getElementById('tiSourceInfo').hidden, cursor:document.getElementById('tiCursorLabel').textContent,
    status:document.getElementById('tiStatus').textContent, undoDisabled:document.getElementById('tiUndoBtn').disabled })`);
  assert.equal(dialogs.filter(item => item.type === 'confirm').length, 1, 'accepting asks once');
  assert.equal(accepted.title, song.title, 'accepting replaces the work with the song');
  assert.equal(accepted.sourceInfoHidden, false, 'the replaced work shows the source info');
  assert.equal(accepted.cursor, '1마디 · 1칸 · 1번 줄', 'the toolbar edit starts at the first measure');
  assert.equal(accepted.status, '연습 화면에서 "' + song.title + '"을 열었습니다 · 1마디부터');
  assert.equal(accepted.undoDisabled, false, 'the replacement can be undone');
  await client.evaluate(`(function(){ ${KEY_HELPER} key('z', 'KeyZ', { ctrlKey:true }); return true; })()`);
  const undone = await client.evaluate(`({ text:document.getElementById('tiScoreText').value, sourceInfoHidden:document.getElementById('tiSourceInfo').hidden })`);
  assert.deepEqual([undone.text, undone.sourceInfoHidden], [work.text, true], 'undo brings the previous work back');

  // 6. 떠날 때 경고, 넘기기 키, 모르는 원래 곡
  await navigate(practiceUrl, practiceReady);
  await selectSong();
  dialogs.length = 0;
  await clickAndLeave('#editInInputBtn', inputReady);
  await client.evaluate(`(function(){ ${KEY_HELPER} key('5', 'Digit5'); document.body.click(); return true; })()`, { userGesture: true });
  await clickAndLeave('#tiOpenPracticeBtn', practiceReady);
  await client.evaluate('document.body.click(); true', { userGesture: true });
  assert.equal(await client.evaluate(`scoreDrafts.status(${JSON.stringify(SONG_ID)}).origin`), 'tab-input', 'the draft came from the input screen');
  const beforeLeave = dialogs.length;
  await navigate(practiceUrl, practiceReady);
  assert.equal(dialogs.slice(beforeLeave).filter(item => item.type === 'beforeunload').length, 0, 'leaving a draft from the input screen raises no beforeunload confirmation');
  await client.evaluate(`localStorage.setItem('gs.tabInput.handoff', JSON.stringify({ sourceId:'no-such-song', title:'모르는 곡', beats:4, bpm:70, badge:'시험', lines:['[-] E4@1 - G4@1 -'], key:0, savedAt:Date.now() })); true`);
  await navigate(practiceUrl, practiceReady);
  const unknownSource = await client.evaluate(`(function(){
    var option = document.getElementById('songSelect').selectedOptions[0];
    return { title:curSong.title, group:option && option.parentElement ? option.parentElement.label : null, tempOrigin:scoreDrafts.status(curSong.id) };
  })()`);
  assert.equal(unknownSource.title, '모르는 곡', 'a hand-off with an unknown source id opens as a new temporary score');
  assert.equal(unknownSource.group, '임시 악보');
  assert.equal(unknownSource.tempOrigin.temporary, true);
  const leftKeys = await client.evaluate(`({ open:localStorage.getItem('gs.tabInput.open'), handoff:localStorage.getItem('gs.tabInput.handoff') })`);
  assert.deepEqual(leftKeys, { open: null, handoff: null }, 'both hand-off keys are gone after a reload');
  assert.equal(dialogs.filter(item => item.type === 'beforeunload').length, 0, 'no beforeunload confirmation during the whole hand-off flow');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the hand-off flow raises no console errors');
  await client.evaluate(clearInputKeys);
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: edit hand-off to the score input screen and back (measure edit, toolbar edit, draft, revert, confirmation, no leave warning) passed\n');
}

async function testConcertHallRouting(client){
  const routing = await client.evaluate(`(async function(){
    var saved = { acousticFx:appState.acousticFx, bodyAmount:appState.bodyAmount,
      sympAmount:appState.sympAmount, synthEngine:appState.synthEngine };
    var button = document.getElementById('toggleFxBtn'), off, on, voiceScheduled = false;
    try {
      if (!appState.acousticFx){ button.click(); await new Promise(function(resolve){ setTimeout(resolve, 60); }); }
      button.click();
      await new Promise(function(resolve){ setTimeout(resolve, 60); });
      off = { state:appState.acousticFx, wet:wetGainNode.gain.value, dry:dryGainNode.gain.value,
        running:actx.state === 'running', bus:!!guitarBus && !!outGain };
      appState.sympAmount = 0;
      playGuitarNote(64, 0.125, actx.currentTime + 0.02, 1, null, 1, { exactDuration:true });
      voiceScheduled = trackedGuideVoices.some(function(voice){ return voice.start >= actx.currentTime; });
      button.click();
      await new Promise(function(resolve){ setTimeout(resolve, 60); });
      on = { state:appState.acousticFx, wet:wetGainNode.gain.value, dry:dryGainNode.gain.value,
        running:actx.state === 'running', bus:!!guitarBus && !!outGain };
      return { initial:saved.acousticFx, off:off, on:on, voiceScheduled:voiceScheduled };
    } finally {
      appState.acousticFx=saved.acousticFx; appState.bodyAmount=saved.bodyAmount;
      appState.sympAmount=saved.sympAmount; appState.synthEngine=saved.synthEngine;
      updateAudioFxRouting(); syncConsoleUI(); saveAppState(); stopGuitarNotes(actx.currentTime);
    }
  })()`);
  assert.equal(routing.off.state, false, 'the actual FX toggle changes app state to OFF');
  assert.ok(Math.abs(routing.off.wet) < 0.001, 'the live AudioContext wet gain reaches zero when OFF');
  assert.ok(Math.abs(routing.off.dry - 0.88) < 0.001, 'OFF preserves the dry route');
  assert.equal(routing.off.running, true, 'AudioContext remains running when FX is OFF');
  assert.equal(routing.off.bus, true, 'guitar bus and output graph remain connected when FX is OFF');
  assert.equal(routing.voiceScheduled, true, 'direct note scheduling remains active through the FX toggle');
  assert.equal(routing.on.state, true, 'the actual FX toggle changes app state to ON');
  assert.ok(Math.abs(routing.on.wet - 0.35) < 0.001, 'the live AudioContext wet gain reaches the hall level when ON');
  assert.ok(Math.abs(routing.on.dry - 0.88) < 0.001, 'ON preserves the dry route');
  assert.equal(routing.on.running, true, 'AudioContext remains running when FX is ON');
  assert.equal(routing.on.bus, true, 'guitar bus and output graph remain connected when FX is ON');
  process.stdout.write('Browser checkpoint: concert hall routing ON/OFF passed\n');
}

async function testConcertHallOfflineRender(client){
  const render = await client.evaluate(`(async function(){
    var saved = { actx:window.actx, outGain:window.outGain, clickBus:window.clickBus, guitarBus:window.guitarBus,
      dryGainNode:window.dryGainNode, wetGainNode:window.wetGainNode, reverbNode:window.reverbNode,
      bodyModes:window.bodyModes, trackedGuideVoices:window.trackedGuideVoices, stringVoices:window.stringVoices,
      acousticFx:appState.acousticFx, bodyAmount:appState.bodyAmount, sympAmount:appState.sympAmount, synthEngine:appState.synthEngine };
    async function renderAt(engine, midi, duration, wet, dry, hardStopAt){
      appState.acousticFx = wet > 0; appState.bodyAmount = 0; appState.sympAmount = 0; appState.synthEngine = engine;
      var rate = 48000, ctx = new OfflineAudioContext(2, rate * 3.2, rate), sourceStops = [];
      ctx.resume = function(){ return Promise.resolve(); };
      var originalCreateBufferSource = ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource = function(){ var source = originalCreateBufferSource(); var stop = source.stop.bind(source);
        source.stop = function(time){ sourceStops.push(time); return stop(time); }; return source; };
      var originalCreateOscillator = ctx.createOscillator.bind(ctx);
      ctx.createOscillator = function(){ var source = originalCreateOscillator(); var stop = source.stop.bind(source);
        source.stop = function(time){ sourceStops.push(time); return stop(time); }; return source; };
      window.actx = ctx; window.outGain = null; window.clickBus = null; window.guitarBus = null;
      window.dryGainNode = null; window.wetGainNode = null; window.reverbNode = null; window.bodyModes = [];
      window.trackedGuideVoices = []; window.stringVoices = {};
      ensureAudioCtx(); dryGainNode.gain.value = dry; wetGainNode.gain.value = wet;
      playGuitarNote(midi, duration, 0.1, 1, null, 1, { exactDuration:true, hardStopAt:hardStopAt });
      var buffer = await ctx.startRendering(), left = buffer.getChannelData(0), right = buffer.getChannelData(1);
      function rms(start, end){ var sum = 0, count = 0;
        for(var i=Math.floor(start*rate); i<Math.floor(end*rate); i++){ var x=(left[i]+right[i])*0.5; sum+=x*x; count++; }
        return Math.sqrt(sum/count); }
      var peak=0; for(var i=0;i<left.length;i++) peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));
      return { tailRms:rms(1.01,1.8), lateRms:rms(0.516,1.0), earlyRms:rms(0.11,0.45), peak:peak, sourceStops:sourceStops };
    }
    async function renderRomance(engine, hall, song){
      appState.acousticFx=hall; appState.bodyAmount=0; appState.sympAmount=0; appState.synthEngine=engine;
      var rate=48000, ctx=new OfflineAudioContext(2,rate*6,rate); ctx.resume=function(){ return Promise.resolve(); };
      window.actx=ctx; window.outGain=null; window.clickBus=null; window.guitarBus=null;
      window.dryGainNode=null; window.wetGainNode=null; window.reverbNode=null; window.bodyModes=[];
      window.trackedGuideVoices=[]; window.stringVoices={}; ensureAudioCtx();
      dryGainNode.gain.value=0.88; wetGainNode.gain.value=hall?CONCERT_HALL_WET_GAIN:0;
      var slotDuration=60/Number(song.bpm),totalSlots=song.measures.length*song.beats,scheduledEventCount=0;
      var originalPlayGuitarNote=window.playGuitarNote;
      window.playGuitarNote=function(){scheduledEventCount++;return originalPlayGuitarNote.apply(this,arguments);};
      try { song.measures[0].beats.forEach(function(beat,index){
          scheduleBeatGuide(beat,{startTime:0.1+index*slotDuration,slotDuration:slotDuration,measures:song.measures,
            maxDurationSlots:totalSlots-index,capo:getSongCapo(song)});
        });
      } finally { window.playGuitarNote=originalPlayGuitarNote; }
      var buffer=await ctx.startRendering(), peak=0, sum=0, count=0;
      for(var i=0;i<buffer.length;i++){
        var left=buffer.getChannelData(0)[i], right=buffer.getChannelData(1)[i];
        peak=Math.max(peak,Math.abs(left),Math.abs(right));
        if(i>=Math.floor(0.1*rate)&&i<Math.floor(4.5*rate)){var mono=(left+right)*0.5;sum+=mono*mono;count++;}
      }
      return {engine:engine,fx:hall?'hall':'dry',peak:peak,rms:Math.sqrt(sum/count),eventCount:scheduledEventCount};
    }
    async function renderIsolatedPart(engine, event, duration, slotDuration, slotsPerBar, startTime, windowStart, windowEnd, naturalDecay){
      appState.acousticFx=false; appState.bodyAmount=0; appState.sympAmount=0; appState.synthEngine=engine;
      var rate=48000, ctx=new OfflineAudioContext(2,rate*4.5,rate), sourceStops=[];
      ctx.resume=function(){ return Promise.resolve(); };
      var originalCreateBufferSource=ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource=function(){var source=originalCreateBufferSource(),stop=source.stop.bind(source);
        source.stop=function(time){sourceStops.push(time);return stop(time);};return source;};
      var originalCreateOscillator=ctx.createOscillator.bind(ctx);
      ctx.createOscillator=function(){var source=originalCreateOscillator(),stop=source.stop.bind(source);
        source.stop=function(time){sourceStops.push(time);return stop(time);};return source;};
      window.actx=ctx; window.outGain=null; window.clickBus=null; window.guitarBus=null;
      window.dryGainNode=null; window.wetGainNode=null; window.reverbNode=null; window.bodyModes=[];
      window.trackedGuideVoices=[]; window.stringVoices={}; ensureAudioCtx();
      dryGainNode.gain.value=0.88; wetGainNode.gain.value=0;
      if(naturalDecay){
        var durationUnits=Math.round(duration/slotDuration*GuitarRhythm.UNITS_PER_SLOT);
        var part={kind:'note',tok:event.note.tok,slotUnits:GuitarRhythm.UNITS_PER_SLOT,durationUnits:durationUnits,chordNotes:[event.note]};
        scheduleBeatGuide({kind:'note',subNotes:[part]},{startTime:startTime,slotDuration:slotDuration,measures:[],maxDurationSlots:slotsPerBar});
      } else playGuitarNote(event.note.midi,duration,startTime,event.gain,event.articulation,event.str,{exactDuration:true,hardStopAt:startTime+slotsPerBar*slotDuration});
      if(windowStart==null) windowStart=Math.max.apply(null,sourceStops)+0.02;
      var buffer=await ctx.startRendering(), left=buffer.getChannelData(0), right=buffer.getChannelData(1), sum=0, count=0, peak=0;
      for(var i=Math.floor(windowStart*rate);i<Math.floor(windowEnd*rate);i++){
        var sample=(left[i]+right[i])*0.5;sum+=sample*sample;count++;
      }
      for(var j=0;j<buffer.length;j++) peak=Math.max(peak,Math.abs(left[j]),Math.abs(right[j]));
      var bytes=new Uint8Array(44+buffer.length*4), view=new DataView(bytes.buffer);
      function putAscii(offset,value){for(var k=0;k<value.length;k++)view.setUint8(offset+k,value.charCodeAt(k));}
      putAscii(0,'RIFF');view.setUint32(4,bytes.length-8,true);putAscii(8,'WAVE');putAscii(12,'fmt ');
      view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,2,true);view.setUint32(24,rate,true);
      view.setUint32(28,rate*4,true);view.setUint16(32,4,true);view.setUint16(34,16,true);putAscii(36,'data');view.setUint32(40,bytes.length-44,true);
      for(var sampleIndex=0;sampleIndex<buffer.length;sampleIndex++){
        var leftSample=Math.max(-1,Math.min(1,left[sampleIndex])),rightSample=Math.max(-1,Math.min(1,right[sampleIndex]));
        view.setInt16(44+sampleIndex*4,leftSample<0?leftSample*32768:leftSample*32767,true);
        view.setInt16(46+sampleIndex*4,rightSample<0?rightSample*32768:rightSample*32767,true);
      }
      var binary='',chunkSize=0x8000;
      for(var byteIndex=0;byteIndex<bytes.length;byteIndex+=chunkSize){binary+=String.fromCharCode.apply(null,bytes.subarray(byteIndex,Math.min(bytes.length,byteIndex+chunkSize)));}
      return {engine:engine,duration:duration,startTime:startTime,windowStart:windowStart,windowEnd:windowEnd,
        windowRms:count?Math.sqrt(sum/count):0,peak:peak,sourceStops:sourceStops,wavBase64:btoa(binary)};
    }
    async function renderNaturalBoundaries(engine){
      async function renderScore(rawScore, loopSlots){
        var parsed=parseScore(rawScore,3);
        if(parsed.errors.length) throw new Error('natural boundary fixture parse failed: '+JSON.stringify(parsed.errors));
        var slotDuration=60/Number(100),rate=48000,ctx=new OfflineAudioContext(2,rate*3,rate),sourceStops=[],sourceStopEvents=[],sourceId=0;
        ctx.resume=function(){return Promise.resolve();};
        var originalCreate=ctx.createBufferSource.bind(ctx);
        ctx.createBufferSource=function(){var source=originalCreate(),stop=source.stop.bind(source),id=++sourceId;source.stop=function(time){sourceStops.push(time);sourceStopEvents.push({id:id,kind:'buffer',time:time});return stop(time);};return source;};
        var originalOscillator=ctx.createOscillator.bind(ctx);
        ctx.createOscillator=function(){var source=originalOscillator(),stop=source.stop.bind(source),id=++sourceId;source.stop=function(time){sourceStops.push(time);sourceStopEvents.push({id:id,kind:'oscillator',time:time});return stop(time);};return source;};
        window.actx=ctx;window.outGain=null;window.clickBus=null;window.guitarBus=null;window.dryGainNode=null;window.wetGainNode=null;
        window.reverbNode=null;window.bodyModes=[];window.trackedGuideVoices=[];window.stringVoices={};
        appState.acousticFx=false;appState.bodyAmount=0;appState.sympAmount=0;appState.synthEngine=engine;ensureAudioCtx();
        dryGainNode.gain.value=0.88;wetGainNode.gain.value=0;
        var startTime=0.1;
        if(loopSlots==null){
          parsed.measures[0].beats.forEach(function(beat,index){scheduleBeatGuide(beat,{startTime:startTime+index*slotDuration,slotDuration:slotDuration,
            measures:parsed.measures,maxDurationSlots:parsed.beats-index});});
        } else scheduleBeatGuide(parsed.measures[0].beats[0],{startTime:startTime,slotDuration:slotDuration,measures:parsed.measures,maxDurationSlots:loopSlots});
        var reattackTime=startTime+slotDuration,restTime=startTime+2*slotDuration,restWindowStart=restTime+0.04,restWindowEnd=restTime+0.2;
        var buffer=await ctx.startRendering(),left=buffer.getChannelData(0),right=buffer.getChannelData(1),peak=0,sum=0,count=0;
        for(var i=0;i<buffer.length;i++){peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));if(i>=Math.floor(restWindowStart*rate)&&i<Math.floor(restWindowEnd*rate)){var sample=(left[i]+right[i])*0.5;sum+=sample*sample;count++;}}
        var finalSourceStops=Object.values(sourceStopEvents.reduce(function(byId,event){byId[event.id]=event;return byId;},{}));
        return {sourceStops:sourceStops,sourceStopEvents:sourceStopEvents,finalSourceStops:finalSourceStops,afterRestRms:count?Math.sqrt(sum/count):0,peak:peak,slotDuration:slotDuration,startTime:startTime,
          reattackTime:loopSlots==null?reattackTime:null,restTime:loopSlots==null?restTime:null,restWindowStart:restWindowStart,restWindowEnd:restWindowEnd,
          loopStopAt:loopSlots==null?null:startTime+loopSlots*slotDuration};
      }
      return {engine:engine,restAndReattack:await renderScore('[C] 0E2@6:p 2F#2@6:p r',null),loopClip:await renderScore('[C] 0E2@6:p - -',0.5)};
    }
    async function renderChord(engine, chord, wet, amount){
      amount = amount == null ? 1 : amount;
      appState.acousticFx=wet; appState.bodyAmount=amount; appState.sympAmount=amount; appState.synthEngine=engine;
      var rate=48000, ctx=new OfflineAudioContext(2,rate*2.5,rate); ctx.resume=function(){ return Promise.resolve(); };
      window.actx=ctx; window.outGain=null; window.clickBus=null; window.guitarBus=null;
      window.dryGainNode=null; window.wetGainNode=null; window.reverbNode=null; window.bodyModes=[];
      window.trackedGuideVoices=[]; window.stringVoices={}; ensureAudioCtx(); dryGainNode.gain.value=0.88; wetGainNode.gain.value=wet?CONCERT_HALL_WET_GAIN:0;
      chord.forEach(function(midi,index){ playGuitarNote(midi,0.5,0.1,1,null,6-index,{exactDuration:true}); });
      var buffer=await ctx.startRendering(), peak=0, sum=0, count=0;
      for(var i=0;i<buffer.length;i++){
        var left=buffer.getChannelData(0)[i], right=buffer.getChannelData(1)[i];
        peak=Math.max(peak,Math.abs(left),Math.abs(right));
        if(i>=Math.floor(0.1*rate)&&i<Math.floor(1.2*rate)){var mono=(left+right)*0.5;sum+=mono*mono;count++;}
      }
      return {engine:engine,chord:chord.join('-'),fx:wet,bodyAmount:amount,sympAmount:amount,peak:peak,activeRms:Math.sqrt(sum/count)};
    }
    var result, matrix=[];
    try {
      for(var engine of ['ks','classic']) for(var duration of [0.125,0.5,1.5]) for(var wetMode of [false,true]){
        var item=await renderAt(engine,64,duration,wetMode?CONCERT_HALL_WET_GAIN:0,wetMode?0:0.88);
        matrix.push({engine:engine,duration:duration,fx:wetMode,peak:item.peak,earlyRms:item.earlyRms,tailRms:item.tailRms,sourceCount:item.sourceStops.length,
          maxSourceStop:item.sourceStops.length?Math.max.apply(null,item.sourceStops):null,sourceStops:item.sourceStops});
      }
      var dry = await renderAt('ks',64,0.5,0,0.88);
      var hall = await renderAt('ks',64,0.5,CONCERT_HALL_WET_GAIN,0);
      var forced = await renderAt('ks',64,1.5,0,0.88,0.5);
      var forcedClassic = await renderAt('classic',64,1.5,0,0.88,0.5);
      result = { matrix:matrix, dry:dry, hall:hall, forced:forced, gain:CONCERT_HALL_WET_GAIN,
        forcedClassic:forcedClassic,
        tailRatio:hall.tailRms/(await renderAt('ks',64,0.5,0.18,0)).tailRms,
        chords:[] };
      for(var engine of ['ks','classic']) for(var chordWet of [false,true]){
        result.chords.push(await renderChord(engine,[40,47,52,55,59,64],chordWet));
        result.chords.push(await renderChord(engine,[41,48,53,57,60,65],chordWet));
      }
      for(var engine of ['ks','classic']){
        result.chords.push(await renderChord(engine,[40,47,52,55,59,64],true,2));
        result.chords.push(await renderChord(engine,[41,48,53,57,60,65],true,2));
      }
      var lv6=allSongs.find(function(song){return song.id==='builtin-lv6-romance-full';});
      if(!lv6 || !lv6.measures || !lv6.measures[0]) throw new Error('Lv.6 Romance built-in score is unavailable for offline rendering');
      var lv6SlotDuration=60/Number(lv6.bpm || 56), lv6Events=[];
      lv6.measures[0].beats.forEach(function(beat,index){
        lv6Events=lv6Events.concat(getBeatGuideEvents(beat,{startTime:0.1+index*lv6SlotDuration,slotDuration:lv6SlotDuration,measures:lv6.measures}));
      });
      var lv6Renders=[];
      for(var engine of ['ks','classic']) for(var hallMode of [false,true]){
        lv6Renders.push(await renderRomance(engine,hallMode,lv6));
      }
      var lv6BassEvent=lv6Events.find(function(event){return event.note.midi===40;});
      var lv6BassPart=lv6.measures[0].beats[0].subNotes[0];
      var lv6OpeningChord=lv6BassPart.chordNotes;
      var lv6BassNote=lv6OpeningChord.find(function(note){return note.midi===40;});
      var lv6InnerParts=[lv6.measures[0].beats[0].subNotes[1],lv6.measures[0].beats[0].subNotes[2]];
      var lv6BassNominalDuration=Number(lv6BassPart.durationUnits)/GuitarRhythm.UNITS_PER_SLOT*lv6SlotDuration;
      var lv6BassStart=lv6BassEvent.when;
      var lv6BassNextStart=Infinity;
      lv6.measures.forEach(function(measure){measure.beats.forEach(function(beat){(beat.subNotes||[beat]).forEach(function(part){
        (part.chordNotes&&part.chordNotes.length?part.chordNotes:[part]).forEach(function(note){
          if(note.str===lv6BassNote.str&&Number.isFinite(Number(part.startUnits))&&part.startUnits>lv6BassPart.startUnits) lv6BassNextStart=Math.min(lv6BassNextStart,part.startUnits);
        });
      });});});
      if(!Number.isFinite(lv6BassNextStart)) throw new Error('Lv.6 opening bass has no later same-string attack for its natural-tail comparison');
      var lv6BassWindowEnd=lv6BassStart+(lv6BassNextStart-lv6BassPart.startUnits)/GuitarRhythm.UNITS_PER_SLOT*lv6SlotDuration-0.05;
      var lv6BassComparison=[];
      for(var bassEngine of ['ks','classic']){
        var gated=await renderIsolatedPart(bassEngine,lv6BassEvent,lv6BassNominalDuration,lv6SlotDuration,Number(lv6.beats),lv6BassStart,null,lv6BassWindowEnd,false);
        var natural=await renderIsolatedPart(bassEngine,lv6BassEvent,lv6BassNominalDuration,lv6SlotDuration,Number(lv6.beats),lv6BassStart,gated.windowStart,lv6BassWindowEnd,true);
        lv6BassComparison.push({engine:bassEngine,nominalDuration:lv6BassNominalDuration,sourceDurationUnits:Number(lv6BassPart.durationUnits),
          sourceStartUnits:Number(lv6BassPart.startUnits),nextSameStringUnits:lv6BassNextStart,windowStart:gated.windowStart,windowEnd:lv6BassWindowEnd,
          gatedWindowRms:gated.windowRms,naturalWindowRms:natural.windowRms,gatedSourceStops:gated.sourceStops,naturalSourceStops:natural.sourceStops,
          naturalPeak:natural.peak,gatedWavBase64:gated.wavBase64,naturalWavBase64:natural.wavBase64});
      }
      var m9=lv6.measures[8], m9Targets=[];
      m9.beats.forEach(function(beat,beatIndex){
        var guideEvents=getBeatGuideEvents(beat,{startTime:beatIndex*lv6SlotDuration,slotDuration:lv6SlotDuration,measures:lv6.measures,capo:getSongCapo(lv6)});
        guideEvents.forEach(function(event){if(((event.note.midi===66 && event.str===2) || (event.note.midi===63 && event.str===3)) &&
          !m9Targets.some(function(target){return target.event.note.midi===event.note.midi && target.event.str===event.str;})){
            var sourcePart=(beat.subNotes||[beat]).find(function(part){return (part.chordNotes&&part.chordNotes.length?part.chordNotes:[part]).indexOf(event.note)>=0;});
            m9Targets.push({event:event,sourcePart:sourcePart});
          }});
      });
      if(m9Targets.length!==2) throw new Error('Lv.6 measure 9 did not expose the expected F#4/D#4 inner notes on separate strings: '+JSON.stringify(m9.beats.map(function(beat){return getBeatGuideEvents(beat,{startTime:0,slotDuration:lv6SlotDuration,measures:lv6.measures}).map(function(event){return [event.note.midi,event.str,event.note.tok];});})));
      var m9Comparisons=[];
      for(var m9Target of m9Targets){
        var note=m9Target.event.note, sourcePart=m9Target.sourcePart, nextStart=Infinity;
        if(!sourcePart||!Number.isFinite(Number(sourcePart.startUnits))) throw new Error('Lv.6 m9 inner note did not retain its source part start position');
        lv6.measures.forEach(function(measure){measure.beats.forEach(function(beat){(beat.subNotes||[beat]).forEach(function(part){
          (part.chordNotes&&part.chordNotes.length?part.chordNotes:[part]).forEach(function(candidate){
            if(candidate.str===note.str && Number.isFinite(Number(part.startUnits)) && part.startUnits>sourcePart.startUnits) nextStart=Math.min(nextStart,part.startUnits);
          });
        });});});
        if(!Number.isFinite(nextStart)) throw new Error('Lv.6 measure 9 inner note has no later same-string attack for a bounded natural-tail window');
        var start=0.1, slotsUntilNext=(nextStart-sourcePart.startUnits)/GuitarRhythm.UNITS_PER_SLOT;
        var nextAt=start+slotsUntilNext*lv6SlotDuration, windowEnd=nextAt-0.02;
        var gate=await renderIsolatedPart('ks',m9Target.event,m9Target.event.duration,lv6SlotDuration,slotsUntilNext,start,null,windowEnd,false);
        var natural=await renderIsolatedPart('ks',m9Target.event,m9Target.event.duration,lv6SlotDuration,slotsUntilNext,start,gate.windowStart,windowEnd,true);
        var classicGate=await renderIsolatedPart('classic',m9Target.event,m9Target.event.duration,lv6SlotDuration,slotsUntilNext,start,null,windowEnd,false);
        var classicNatural=await renderIsolatedPart('classic',m9Target.event,m9Target.event.duration,lv6SlotDuration,slotsUntilNext,start,classicGate.windowStart,windowEnd,true);
        m9Comparisons.push({midi:note.midi,str:note.str,durationUnits:sourcePart.durationUnits,sourceStartUnits:sourcePart.startUnits,duration:m9Target.event.duration,
          nextSameStringUnits:nextStart,nextAt:nextAt,ks:{windowStart:gate.windowStart,windowEnd:windowEnd,gatedRms:gate.windowRms,naturalRms:natural.windowRms,
            peak:natural.peak,sourceStops:gate.sourceStops,wavBase64:natural.wavBase64},
          classic:{windowStart:classicGate.windowStart,windowEnd:windowEnd,gatedRms:classicGate.windowRms,naturalRms:classicNatural.windowRms,
            peak:classicNatural.peak,sourceStops:classicGate.sourceStops,wavBase64:classicNatural.wavBase64}});
      }
      var naturalBoundaries=[];
      for(var boundaryEngine of ['ks','classic']) naturalBoundaries.push(await renderNaturalBoundaries(boundaryEngine));
      result.naturalBoundaries=naturalBoundaries;
      result.lv6FirstMeasure={id:lv6.id,bpm:lv6.bpm,events:lv6Events.map(function(event){return {
        midi:event.note.midi,when:event.when,duration:event.duration,gain:event.gain,articulation:event.articulation,str:event.str
      };}),beats:Number(lv6.beats),unitsPerSlot:Number(GuitarRhythm.UNITS_PER_SLOT),
        bassDurationUnits:Number(lv6BassPart.durationUnits),melodyDurationUnits:Number(lv6BassPart.durationUnits),
        durationUnits:{bass:lv6BassPart.durationUnits,melody:lv6BassPart.durationUnits,
          inners:lv6InnerParts.map(function(part){return part.durationUnits;}),slotUnits:lv6.measures[0].beats[0].subNotes[0].slotUnits},
        bassNominalDuration:lv6BassNominalDuration,bassWindowEnd:lv6BassWindowEnd,
        bassComparison:lv6BassComparison.map(function(item){return {engine:item.engine,nominalDuration:item.nominalDuration,sourceDurationUnits:item.sourceDurationUnits,
          sourceStartUnits:item.sourceStartUnits,nextSameStringUnits:item.nextSameStringUnits,windowStart:item.windowStart,windowEnd:item.windowEnd,
          gatedWindowRms:item.gatedWindowRms,naturalWindowRms:item.naturalWindowRms,gatedSourceStops:item.gatedSourceStops,naturalSourceStops:item.naturalSourceStops,
          naturalPeak:item.naturalPeak,gatedWavBase64:item.gatedWavBase64,naturalWavBase64:item.naturalWavBase64};}),
        m9Comparisons:m9Comparisons,renders:lv6Renders};
    } finally {
      window.actx=saved.actx; window.outGain=saved.outGain; window.clickBus=saved.clickBus;
      window.guitarBus=saved.guitarBus; window.dryGainNode=saved.dryGainNode; window.wetGainNode=saved.wetGainNode;
      window.reverbNode=saved.reverbNode; window.bodyModes=saved.bodyModes;
      window.trackedGuideVoices=saved.trackedGuideVoices; window.stringVoices=saved.stringVoices;
      appState.acousticFx=saved.acousticFx; appState.bodyAmount=saved.bodyAmount;
      appState.sympAmount=saved.sympAmount; appState.synthEngine=saved.synthEngine;
    }
    result.restored = window.actx===saved.actx && window.outGain===saved.outGain && window.guitarBus===saved.guitarBus &&
      window.wetGainNode===saved.wetGainNode && appState.acousticFx===saved.acousticFx &&
      appState.bodyAmount===saved.bodyAmount && appState.sympAmount===saved.sympAmount && appState.synthEngine===saved.synthEngine;
    return result;
  })()`);
  assert.equal(render.gain, 0.35, 'offline render uses the production wet gain');
  assert.equal(render.restored, true, 'offline measurement restores the live AudioContext graph and app settings');
  assert.ok(render.dry.tailRms < 1e-8, 'dry KS render is silent after the natural release bound');
  assert.ok(render.hall.tailRms > 0, 'hall KS render has a real post-note-off convolver tail');
  assert.ok(render.matrix.every(function(item){ return item.earlyRms > 0; }), 'KS and classic actual audio graphs render audible nonzero samples');
  assert.ok(Math.abs(render.tailRatio / (0.35 / 0.18) - 1) < 0.05, 'isolated wet tail RMS follows the wet-gain ratio within 5%');
  assert.ok(render.matrix.every(function(item){ return item.peak < 1 && item.maxSourceStop <= 0.1 + item.duration + 0.4 + 1e-6; }), 'KS/classic, hall/dry, and .125/.5/1.5s renders stay below full scale and natural release bound');
  assert.ok(render.forced.sourceStops.length === 1 && Math.abs(render.forced.sourceStops[0] - 0.515) < 1e-6, 'hard loop boundary stops KS direct source within 15ms');
  assert.ok(render.forced.lateRms < 1e-8, 'hard loop boundary render is silent after its 15ms cutoff');
  assert.ok(render.forcedClassic.sourceStops.length === 3 && render.forcedClassic.sourceStops.every(function(stop){return Math.abs(stop - 0.515) < 1e-6;}), 'hard loop boundary stops all three classic oscillators within 15ms');
  assert.ok(render.forcedClassic.lateRms < 1e-8, 'hard loop boundary render is silent for classic output after its 15ms cutoff');
  assert.ok(render.chords.every(function(chord){ return chord.peak < 1 && chord.activeRms > 0; }), 'valid six-string Em/F chords render for KS/classic with dry/hall routing and body/sympathetic amount 1 or 2, without clipping');
  assert.equal(render.lv6FirstMeasure.id, 'builtin-lv6-romance-full', 'offline render uses the actual Lv.6 built-in score');
  assert.equal(render.lv6FirstMeasure.events.length, 10, 'Lv.6 first measure guide emits bass, melody, and inner voice notes');
  assert.deepEqual(render.lv6FirstMeasure.events.slice(0, 2).map(function(event){return [event.midi,event.gain,event.articulation,event.str];}),
    [[40,1,null,6],[71,1.16,'apoyando',1]], 'Lv.6 opening bass (unmarked, so tirando) and melody retain their written articulation and strings');
  assert.equal(render.lv6FirstMeasure.durationUnits.bass, render.lv6FirstMeasure.durationUnits.melody,
    'Lv.6 opening bass and melody use one shared chord duration');
  assert.equal(render.lv6FirstMeasure.durationUnits.bass, render.lv6FirstMeasure.durationUnits.slotUnits,
    'Lv.6 opening chord uses its parsed subdivision duration');
  assert.ok(render.lv6FirstMeasure.durationUnits.inners.every(function(units){return units === render.lv6FirstMeasure.durationUnits.slotUnits;}),
    'Lv.6 inner notes retain their default one-subdivision duration');
  const lv6BassEvent = render.lv6FirstMeasure.events.find(function(event){return event.midi === 40;});
  const lv6MelodyEvent = render.lv6FirstMeasure.events.find(function(event){return event.midi === 71;});
  assert.ok(Math.abs(lv6BassEvent.duration - render.lv6FirstMeasure.bassDurationUnits / 12 * 60 / render.lv6FirstMeasure.bpm) < 1e-9 &&
    Math.abs(lv6MelodyEvent.duration - lv6BassEvent.duration) < 1e-9,
    'Lv.6 chord event durations convert the common parsed part units through the song tempo');
  assert.equal(render.lv6FirstMeasure.bassComparison.length, 2, 'isolated Romance bass comparison covers both existing synth engines');
  assert.ok(render.lv6FirstMeasure.bassComparison.every(function(item){return item.sourceDurationUnits > 0 &&
    item.windowStart > Math.max.apply(null,item.gatedSourceStops) && item.windowEnd < 0.1 + item.nextSameStringUnits / render.lv6FirstMeasure.unitsPerSlot * 60 / render.lv6FirstMeasure.bpm &&
    item.windowEnd > item.windowStart && item.gatedWindowRms < 1e-8 && item.naturalWindowRms > 1e-8 && item.naturalPeak < 1;}),
    'KS and classic keep a short subdivision E2 ringing after its legacy gate and before the next same-string attack');
  assert.equal(render.lv6FirstMeasure.m9Comparisons.length, 2, 'actual measure 9 inner-note isolation covers F#4 and D#4');
  assert.deepEqual(render.lv6FirstMeasure.m9Comparisons.map(function(item){return [item.midi,item.str];}), [[66,2],[63,3]],
    'm9 sustain window targets parsed F#4 on string 2 and D#4 on string 3');
  assert.ok(render.lv6FirstMeasure.m9Comparisons.every(function(item){return item.durationUnits === render.lv6FirstMeasure.durationUnits.inners[0] &&
    item.ks.windowStart > Math.max.apply(null,item.ks.sourceStops) && item.classic.windowStart > Math.max.apply(null,item.classic.sourceStops) &&
    item.ks.windowEnd < item.nextAt && item.classic.windowEnd < item.nextAt && item.ks.windowEnd > item.ks.windowStart &&
    item.classic.windowEnd > item.classic.windowStart && item.ks.gatedRms < 1e-8 && item.classic.gatedRms < 1e-8 &&
    item.ks.naturalRms > 1e-8 && item.classic.naturalRms > 1e-8 && item.ks.peak < 1 && item.classic.peak < 1;}),
    'actual Lv.6 measure 9 F#4/D#4 inner notes ring on their independent strings after each nominal duration, before the next same-string attack');
  assert.ok(render.naturalBoundaries.length===2 && render.naturalBoundaries.every(function(item){
    var reattack=item.restAndReattack.reattackTime;
    var rest=item.restAndReattack.restTime;
    var loopHardStop=item.loopClip.loopStopAt;
    return item.restAndReattack.finalSourceStops.some(function(entry){return entry.time>=reattack&&entry.time<=reattack+0.12;}) &&
      item.restAndReattack.finalSourceStops.every(function(entry){return entry.time<=rest+0.02;}) &&
      item.restAndReattack.afterRestRms<1e-8 && item.loopClip.finalSourceStops.length>0 &&
      item.loopClip.finalSourceStops.every(function(entry){return entry.time>=loopHardStop&&entry.time<=loopHardStop+0.02;}) &&
      item.restAndReattack.peak<1 && item.loopClip.peak<1;}),
    'actual natural guide voices are cut by same-string reattack, a rest, and a loop hard stop in KS/classic offline rendering: '+JSON.stringify(render.naturalBoundaries));
  assert.ok(render.lv6FirstMeasure.renders.length === 4 && render.lv6FirstMeasure.renders.every(function(item){return item.peak < 1 && item.rms > 0 && item.eventCount === 10;}),
    'actual scheduleBeatGuide Lv.6 first measure renders audible, unclipped KS/classic dry/hall audio');
  const artifact = path.join(root, 'test-artifacts', 'clean-score-ui', 'audio-render-check-' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(artifact), { recursive:true });
  const bassWavPaths = [];
  render.lv6FirstMeasure.bassComparison.forEach(function(item){
    const gatedPath = path.join(path.dirname(artifact), 'romance-e2-gated-' + item.engine + '-' + Date.now() + '.wav');
    const naturalPath = path.join(path.dirname(artifact), 'romance-e2-natural-' + item.engine + '-' + Date.now() + '.wav');
    fs.writeFileSync(gatedPath, Buffer.from(item.gatedWavBase64, 'base64'));
    fs.writeFileSync(naturalPath, Buffer.from(item.naturalWavBase64, 'base64'));
    bassWavPaths.push(gatedPath, naturalPath);
  });
  render.lv6FirstMeasure.bassComparison.forEach(function(item){ delete item.gatedWavBase64; delete item.naturalWavBase64; });
  const m9WavPaths=[];
  render.lv6FirstMeasure.m9Comparisons.forEach(function(item){
    for(const engine of ['ks','classic']){
      const wavPath=path.join(path.dirname(artifact),'romance-m9-'+item.midi+'-'+engine+'-'+Date.now()+'.wav');
      fs.writeFileSync(wavPath,Buffer.from(item[engine].wavBase64,'base64')); delete item[engine].wavBase64; m9WavPaths.push(wavPath);
    }
  });
  fs.writeFileSync(artifact, JSON.stringify({ sampleRateHz:48000, peakDefinition:'max absolute sample across stereo channels',
    rmsDefinition:'RMS of stereo channel average; windows and note durations are derived from parsed events and captured source stops',
    gain:render.gain, wetTailRatio:render.tailRatio, chords:render.chords, matrix:render.matrix,
    dryTailRms:render.dry.tailRms, hallTailRms:render.hall.tailRms, forcedCutoffStopAt:render.forced.sourceStops[0],
    forcedClassicStops:render.forcedClassic.sourceStops, forcedClassicLateRms:render.forcedClassic.lateRms,
    forcedPostCutoffRms:render.forced.lateRms, naturalBoundaries:render.naturalBoundaries, lv6FirstMeasure:render.lv6FirstMeasure, bassWavPaths:bassWavPaths,m9WavPaths:m9WavPaths }, null, 2) + '\n');
  process.stdout.write('Artifact: ' + artifact + '\n');
  process.stdout.write('Romance E2 WAV evidence: ' + bassWavPaths.join(' ; ') + '\n');
  process.stdout.write('Romance m9 inner WAV evidence: ' + m9WavPaths.join(' ; ') + '\n');
  process.stdout.write('Browser checkpoint: OfflineAudioContext legacy exact API matrix, KS/classic hard cutoff, 12 duration/FX cases, isolated hall tail, 12 six-string chords, four actual scheduleBeatGuide Lv.6 first-measure renders, short-subdivision E2 natural-tail comparison, and m9 F#4/D#4 direct-sound sustain windows passed (wet tail ratio ' + render.tailRatio.toFixed(4) + ', max chord peak ' + Math.max.apply(null,render.chords.map(function(chord){return chord.peak;})).toFixed(4) + ')\n');
}

async function testPracticeSessionLifecycle(client) {
  const result = await client.evaluate(`(async function(){
    var original = {
      setTimeout: window.setTimeout,
      actx: window.actx,
      scheduleMetronomeClick: window.scheduleMetronomeClick,
      playGuitarNote: window.playGuitarNote,
      scheduleMetronomeClick: window.scheduleMetronomeClick,
      highlightFretboard: window.highlightFretboard,
      ensureAudioCtx: window.ensureAudioCtx,
      warmKsCache: window.warmKsCache,
      state: { guideSound: appState.guideSound, loopEnable: appState.loopEnable, loopStart: appState.loopStart, loopEnd: appState.loopEnd, bpm: appState.bpm, clickMode: appState.clickMode },
      isPlaying: window.isPlaying,
      playSession: window.playSession,
      song: window.curSong,
      measure: window.curMeasureIdx,
      beat: window.curBeatIdx
    };
    var assertions = [];
    function check(ok, message){ if (!ok) throw new Error(message); assertions.push(message); }
    try {
      var timers = [];
      var clicks = [];
      var highlights = 0;
      var notes = [];
      window.setTimeout = function(fn, delay){ timers.push({ fn: fn, delay: delay }); return timers.length; };
      window.scheduleMetronomeClick = function(time){ clicks.push(time); };
      window.highlightFretboard = function(){ highlights++; };
      window.playGuitarNote = function(midi, duration, time){ notes.push({ midi: midi, duration: duration, time: time }); };
      window.actx = { currentTime: 0, outputLatency: 0.02, baseLatency: 0.01 };
      appState.guideSound = false;
      appState.loopEnable = false;
      appState.loopStart = 1;
      appState.loopEnd = 1;
      window.curSong = { type: 'structured', measures: [{ beats: [{ isSubdivided: true, subNotes: [{}, { midi: 64, tok: 'E4' }] }, {}, {}, {}] }], title: 'lifecycle-test' };

      var staleSession = { inCountIn: false, nextBeatTime: 1, spb: 1, bpb: 4, bIdx: 0, mIdx: 0, loopCompleted: 0, endScheduled: false };
      window.playSession = staleSession;
      window.isPlaying = true;
      window.actx.currentTime = 0.95;
      schedulerTick();
      check(timers.length === 2, 'beat UI and guide-off subnote UI callbacks captured');
      var currentMeasureBefore = window.curMeasureIdx;
      var currentBeatBefore = window.curBeatIdx;
      window.playSession = { sentinel: true };
      timers[0].fn();
      timers[1].fn();
      check(window.curMeasureIdx === currentMeasureBefore && window.curBeatIdx === currentBeatBefore, 'stale beat UI callback ignored after session replacement');
      check(highlights === 0, 'stale subnote UI callback ignored after session replacement');
      window.isPlaying = false;

      [30, 60, 240].forEach(function(bpm){
        timers = [];
        clicks = [];
        notes = [];
        appState.guideSound = true;
        window.curSong.measures[0].beats = [{}, {}, {}, { isSubdivided: true, subNotes: [{ midi: 65, tok: 'F4' }, { midi: 67, tok: 'G4' }] }];
        appState.bpm = bpm;
        var spb = 60 / bpm;
        var session = { inCountIn: false, nextBeatTime: 1, spb: spb, bpb: 4, bIdx: 0, mIdx: 0, loopCompleted: 0, endScheduled: false };
        window.playSession = session;
        window.isPlaying = true;
        for (var beatIdx = 0; beatIdx < 4; beatIdx++){
          window.actx.currentTime = session.nextBeatTime - 0.01;
          schedulerTick();
        }
        check(session.endScheduled === true, 'tempo ' + bpm + ': final beat marks session ending');
        check(clicks.length === 4, 'tempo ' + bpm + ': exactly four in-range beats scheduled');
        check(notes.length === 2 && Math.abs(notes[1].time - (session.nextBeatTime - spb / 2)) < 0.000001, 'tempo ' + bpm + ': final beat subdivision is scheduled before session stop');
        var endTimers = timers.filter(function(timer){ return Math.abs(timer.delay - Math.max(0, (session.nextBeatTime + 0.03 - window.actx.currentTime) * 1000)) < 0.01; });
        check(endTimers.length === 1, 'tempo ' + bpm + ': one latency-aligned stop is scheduled');
        var clicksBefore = clicks.length;
        window.actx.currentTime = session.nextBeatTime + spb * 2;
        schedulerTick();
        check(clicks.length === clicksBefore, 'tempo ' + bpm + ': no out-of-range beat after final beat');
        var uiTimers = timers.filter(function(timer){ return timer !== endTimers[0]; });
        var replacement = { sentinel: true };
        window.playSession = replacement;
        window.curMeasureIdx = 42;
        window.curBeatIdx = 43;
        uiTimers.forEach(function(timer){ timer.fn(); });
        endTimers[0].fn();
        check(window.isPlaying === true && window.playSession === replacement, 'tempo ' + bpm + ': stale UI and stop callbacks ignored');
        window.isPlaying = false;
      });

      window.playSession = null;
      window.curSong = original.song;
      window.ensureAudioCtx = function(){};
      window.warmKsCache = function(){};
      window.actx = { currentTime: 0 };
      startPractice();
      var firstSession = window.playSession;
      check(window.isPlaying === true && firstSession && firstSession.inCountIn === true, 'practice starts synchronously with a count-in session');
      check(!Object.prototype.hasOwnProperty.call(firstSession, 'hits') && !Object.prototype.hasOwnProperty.call(firstSession, 'lastOnsetObj'), 'practice session has no scoring or onset state');
      check(document.getElementById('playBtn').textContent === '연습 정지', 'main play button immediately exposes stop action');
      startPractice();
      check(window.playSession === firstSession, 'duplicate start while playing is ignored');
      stopPractice();
      check(window.isPlaying === false && window.playSession == null, 'main play button session stops synchronously');

      document.getElementById('compactPlayBtn').click();
      check(window.isPlaying === true && window.playSession, 'compact play button starts immediately');
      document.getElementById('compactPlayBtn').click();
      check(window.isPlaying === false && window.playSession == null, 'compact play button stops immediately');

      startPractice();
      var previousSong = window.curSong.id;
      var nextSong = window.allSongs.find(function(song){ return song.id !== previousSong; });
      changeSongById(nextSong.id);
      check(window.isPlaying === false && window.playSession == null && window.curSong.id === nextSong.id, 'song change stops active practice');

      var spaceStart = new KeyboardEvent('keydown', { key: ' ', code:'Space', bubbles: true, cancelable: true });
      window.dispatchEvent(spaceStart);
      check(window.isPlaying === true && window.playSession, 'Space keyboard shortcut starts practice');
      var spaceStop = new KeyboardEvent('keydown', { key: ' ', code:'Space', bubbles: true, cancelable: true });
      window.dispatchEvent(spaceStop);
      check(window.isPlaying === false && window.playSession == null, 'Space keyboard shortcut stops practice');

      var clickSelect = document.getElementById('clickModeSelect');
      var clickOptionValues = Array.prototype.map.call(clickSelect.options, function(option){ return option.value; }).join(',');
      check(clickOptionValues === 'all,countin,off', 'click mode select offers all, count-in only, and off in order');
      check(clickSelect.value === appState.clickMode, 'click mode select shows the current click mode');
      var originalClickMode = appState.clickMode;
      clickSelect.value = 'countin';
      clickSelect.dispatchEvent(new Event('change', { bubbles: true }));
      check(appState.clickMode === 'countin' && ls.get('gs.state', {}).clickMode === 'countin', 'click mode change updates app state and saved settings');
      clickSelect.value = originalClickMode;
      clickSelect.dispatchEvent(new Event('change', { bubbles: true }));
      check(appState.clickMode === originalClickMode && ls.get('gs.state', {}).clickMode === originalClickMode, 'click mode restore updates app state and saved settings');

      appState.guideSound = false;
      ['all', 'countin', 'off'].forEach(function(mode){
        appState.clickMode = mode;
        clicks = [];
        window.actx = { currentTime: 0, outputLatency: 0.02, baseLatency: 0.01 };
        startPractice();
        var session = window.playSession;
        check(session && session.inCountIn === (mode !== 'off'), 'click mode ' + mode + ': count-in is ' + (mode !== 'off' ? 'scheduled' : 'skipped'));
        var countInTicks = mode === 'off' ? 0 : session.bpb;
        var startTime = session.startTime;
        if (mode === 'off') check(Math.abs(session.nextBeatTime - startTime) < 1e-9, 'click mode off: first playback beat is scheduled at the start time');
        var executedTicks = 0;
        for (var tickIdx = 0; tickIdx < countInTicks + session.bpb; tickIdx++){
          if (session.endScheduled) break;
          window.actx.currentTime = session.nextBeatTime - 0.01;
          schedulerTick();
          executedTicks++;
          if (mode === 'off' && tickIdx === 0) check(session.inCountIn === false, 'click mode off: first tick plays a playback beat, not a count-in beat');
        }
        var playbackBeats = executedTicks - countInTicks;
        var expectedClicks = mode === 'all' ? countInTicks + playbackBeats : (mode === 'countin' ? countInTicks : 0);
        check(playbackBeats > 0, 'click mode ' + mode + ': playback beats were scheduled after the count-in');
        check(clicks.length === expectedClicks, 'click mode ' + mode + ': click count matches the mode');
        stopPractice();
      });
      return assertions;
    } finally {
      window.setTimeout = original.setTimeout;
      window.actx = original.actx;
      window.scheduleMetronomeClick = original.scheduleMetronomeClick;
      window.playGuitarNote = original.playGuitarNote;
      window.highlightFretboard = original.highlightFretboard;
      window.ensureAudioCtx = original.ensureAudioCtx;
      window.warmKsCache = original.warmKsCache;
      Object.keys(original.state).forEach(function(key){ appState[key] = original.state[key]; });
      window.isPlaying = original.isPlaying;
      window.playSession = original.playSession;
      window.curSong = original.song;
      window.curMeasureIdx = original.measure;
      window.curBeatIdx = original.beat;
      document.getElementById('clickModeSelect').value = appState.clickMode;
      syncCompactPlayButtons();
    }
  })()`);
  assert.ok(Array.isArray(result) && result.length >= 20, 'practice session lifecycle regressions pass');
  process.stdout.write('Checks: practice lifecycle ' + result.length + '\n');
}

async function testCaptureRemovalAndAudioOffset(client) {
  const result = await client.evaluate(`(function(){
    var original = { song:curSong, compact:appState.isCompactPractice, guide:appState.guideSound,
      offset:appState.audioOffsetMs, playing:window.isPlaying, session:window.playSession };
    var audit = window.__gsCaptureAudit;
    function check(ok, message){ if (!ok) throw new Error(message); }
    try {
      var removedIds = ['tunerModal','tunerBtn','micScoreBtn','liveNote','liveErr','micFill','histBody','clearHistBtn','runCalibBtn'];
      check(removedIds.every(function(id){ return document.getElementById(id) === null; }), 'capture, tuner, calibration, and scoring history DOM is removed');
      check(typeof navigator.mediaDevices.getUserMedia === 'function' && typeof navigator.mediaDevices.enumerateDevices === 'function', 'capture audit stubs are installed before app startup');

      document.getElementById('audioOffsetOpenBtn').click();
      check(!document.getElementById('audioOffsetModal').hidden, 'manual output offset modal opens without requesting microphone access');
      document.getElementById('btPresetWired').click();
      check(appState.audioOffsetMs === 0 && document.getElementById('audioOffsetBadge').textContent === '0ms', 'wired preset keeps a zero output offset');
      document.getElementById('btPresetNormal').click();
      check(appState.audioOffsetMs === 180 && document.getElementById('audioOffsetBadge').textContent === '+180ms', 'normal Bluetooth preset applies 180ms');
      document.getElementById('btPresetHeavy').click();
      check(appState.audioOffsetMs === 240 && document.getElementById('audioOffsetBadge').textContent === '+240ms', 'heavy Bluetooth preset applies 240ms');
      var range = document.getElementById('audioOffsetRange');
      check(range.min === '0' && range.max === '400' && range.step === '5', 'manual output offset slider spans 0-400ms in 5ms steps');
      range.value = '125'; range.dispatchEvent(new Event('input', { bubbles:true }));
      check(appState.audioOffsetMs === 125 && document.getElementById('audioOffsetVal').textContent === '+125 ms', 'manual output offset updates app state and value label');
      document.getElementById('closeAudioOffsetBtn').click();

      startPractice();
      check(window.isPlaying && window.playSession, 'normal practice starts with no capture API');
      stopPractice();
      setCompactPractice(true);
      document.getElementById('compactPlayBtn').click();
      check(window.isPlaying && window.playSession, 'compact practice starts with no capture API');
      document.getElementById('compactPlayBtn').click();
      check(!window.isPlaying && window.playSession == null, 'compact practice stops with no capture API');
      setCompactPractice(false);
      startPractice();
      var otherSong = window.allSongs.find(function(song){ return song.id !== curSong.id; });
      changeSongById(otherSong.id);
      check(!window.isPlaying && window.playSession == null && curSong.id === otherSong.id, 'changing songs stops active practice without capture APIs');
      if (original.song && curSong.id !== original.song.id) changeSongById(original.song.id);
      check(audit.capture === 0 && audit.devices === 0 && audit.worklet === 0, 'practice, output settings, and song changes never request capture, enumerate devices, or load a worklet');
      return { checks:13, counters:{ capture:audit.capture, devices:audit.devices, worklet:audit.worklet } };
    } finally {
      if (window.isPlaying) stopPractice();
      appState.audioOffsetMs = original.offset;
      appState.guideSound = original.guide;
      setCompactPractice(original.compact);
      if (original.song && curSong.id !== original.song.id) changeSongById(original.song.id);
      window.playSession = original.session;
      window.isPlaying = original.playing;
      saveAppState();
      syncCompactPlayButtons();
    }
  })()`);
  assert.deepEqual(result.counters, { capture:0, devices:0, worklet:0 }, 'capture APIs and audio worklet remain unused after playback, modal, preset, and song changes');
  process.stdout.write('Checks: capture-free audio offset and practice workflow ' + result.checks + '\n');
}

async function importLegacyBackup(client) {
  await client.evaluate(`(function(){
    var textSong = buildStructuredSong({ id:'browser-legacy-backup-text', title:'Legacy text song', badge:'Custom', capo:3, bpm:84, beats:4, lines:['[C] C4 - - -'] });
    var imageSong = { id:'browser-legacy-backup-image', title:'Legacy image song', type:'image', imageDataUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', pdfPages:['data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='], curPageIdx:0, systems:[{ x:0.1,y:0.1,w:0.8,h:0.2,bars:[{ chord:'C',note:'C4',memo:'legacy image',w:1 }] }] };
    var backup = { version:1, exportedAt:'2026-10-19T00:00:00.000Z', customSongs:[textSong,imageSong], history:[{ sentinel:'old-backup-score' }], calib:{ lat:0.123, calibrated:true }, appState:{ bpm:84, audioOffsetMs:180, micScoring:true, micDeviceId:'removed-device', guideSound:true } };
    var file = new File([JSON.stringify(backup)], 'legacy-backup.json', { type:'application/json' });
    var transfer = new DataTransfer(); transfer.items.add(file);
    var input = document.getElementById('importFileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
    return true;
  })()`);
}
async function testBackupExport(client) {
  const result = await client.evaluate(`(async function(){
    var db = await openDB();
    await new Promise(function(resolve,reject){
      var tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put({ id:'browser-hidden-legacy-text', title:'legacy text', type:'structured', measures:[] });
      tx.oncomplete = resolve; tx.onerror = tx.onabort = function(){ reject(tx.error || new Error('fixture seed failed')); };
    });
    await dbSaveImageSong({ id:'browser-backup-image', title:'backup image', type:'image', imageDataUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', pdfPages:['data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='], curPageIdx:0, systems:[] });
    var original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    var captured = null;
    var timeoutId = null;
    var resolveBlob;
    var blobCreated = new Promise(function(resolve){ resolveBlob = resolve; });
    try {
      Object.defineProperty(URL, 'createObjectURL', { configurable:true, value:function(blob){ captured = blob; resolveBlob(blob); return 'blob:test-backup'; } });
      var blobTimeout = new Promise(function(_, reject){ timeoutId = setTimeout(function(){ reject(new Error('Timed out waiting for backup Blob creation')); }, 5000); });
      document.getElementById('exportJsonBtn').click();
      await Promise.race([blobCreated, blobTimeout]);
      var payload = JSON.parse(await captured.text());
      return { keys:Object.keys(payload).sort(), version:payload.version, exportedAt:payload.exportedAt,
        appStateKeys:Object.keys(payload.appState || {}), songs:Array.isArray(payload.customSongs), songTypes:(payload.customSongs || []).map(function(song){return song.type;}),
        hasImage:(payload.customSongs || []).some(function(song){return song.id==='browser-backup-image';}), hasLegacyText:(payload.customSongs || []).some(function(song){return song.id==='browser-hidden-legacy-text';}) };
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (original) Object.defineProperty(URL, 'createObjectURL', original);
      else delete URL.createObjectURL;
    }
  })()`);
  assert.deepEqual(result.keys, ['appState','customSongs','exportedAt','version'], 'backup export contains only the versioned app state and custom songs payload');
  assert.equal(result.version, 1, 'backup format version remains 1');
  assert.ok(result.exportedAt, 'backup export retains its exportedAt timestamp');
  assert.equal(result.songs, true, 'backup export retains customSongs');
  assert.ok(result.songTypes.length >= 1 && result.songTypes.every(type => type === 'image'), 'backup export includes only image records from mixed IndexedDB');
  assert.equal(result.hasImage, true, 'backup export includes image and PDF metadata records');
  assert.equal(result.hasLegacyText, false, 'backup export omits legacy structured IndexedDB rows');
  assert.ok(!result.appStateKeys.includes('micScoring') && !result.appStateKeys.includes('micDeviceId'), 'removed microphone settings are not re-exported');
  process.stdout.write('Checks: legacy-compatible backup export shape 8\n');
}

async function testSubdividedGuide(client) {
  const result = await client.evaluate(`(async function(){
    var original = {
      song: window.curSong,
      actx: window.actx,
      playGuitarNote: window.playGuitarNote,
      stopGuitarNotes: window.stopGuitarNotes,
      warmKsCache: window.warmKsCache,
      scheduleMetronomeClick: window.scheduleMetronomeClick,
      ensureAudioCtx: window.ensureAudioCtx,
      setTimeout: window.setTimeout,
      session: window.playSession,
      playing: window.isPlaying,
      measure: window.curMeasureIdx,
      beat: window.curBeatIdx,
      state: { guideSound: appState.guideSound, scoreView: appState.scoreView, beats: appState.beats, bpm: appState.bpm, loopStart: appState.loopStart, loopEnd: appState.loopEnd, loopEnable: appState.loopEnable }
    };
    var assertions = [];
    var emitted = [];
    var stopped = [];
    function check(ok, message){ if (!ok) throw new Error(message); assertions.push(message); }
    try {
      var parsedGuide = parseScore('[C] r/0E2+0G3+1C4/0D3+0A3+1F4 - -', 4);
      var song = { id: 'browser-guide-regression', title: 'Guide Capo 2', type: 'structured', beats: parsedGuide.beats, bpm: 60, capo: 2, measures: parsedGuide.measures };
      window.curSong = song;
      window.ensureAudioCtx = function(){};
      window.playGuitarNote = function(midi, duration, when, gain, articulation, str, options){ emitted.push({ midi: midi, duration: duration, when: when, gain: gain, articulation: articulation, str: str, options:options }); };
      window.stopGuitarNotes = function(when){ stopped.push(when); };
      window.scheduleMetronomeClick = function(){};
      window.actx = { currentTime: 2, outputLatency: 0, baseLatency: 0 };
      appState.guideSound = true;
      appState.scoreView = 'tab';
      appState.beats = 4;
      renderSong();
      emitted = [];
      updateActiveCursor(0, 0, true);
      check(emitted.length === 6, 'preview preserves both full chords after the leading rest');
      check(emitted.map(function(event){ return event.midi; }).join(',') === '42,57,62,52,59,67', 'preview applies capo while retaining every chord pitch');
      check(emitted.map(function(event){ return event.str; }).join(',') === '6,3,2,4,3,1', 'preview preserves each physical string');
      check(Math.abs(emitted[0].when - (2 + 1 / 3)) < 0.000001 && Math.abs(emitted[3].when - (2 + 2 / 3)) < 0.000001, 'preview starts chord groups at their subdivision positions');
      check(emitted.slice(0, 3).every(function(event){ return event.when === emitted[0].when && event.duration === emitted[0].duration; }) && emitted.slice(3).every(function(event){ return event.when === emitted[3].when && event.duration === emitted[3].duration; }), 'each chord shares one exact attack time and duration');
      var pills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="0"] .tab-fret-pill'));
      check(pills.length === 6 && pills.every(function(p){ return p.classList.contains('note-fret'); }), 'TAB grid renders every subdivided pitch with the same neutral note style');
      check(pills.filter(function(p){ return Math.abs(parseFloat(p.style.left) - 50) < 0.001; }).length === 3 && pills.filter(function(p){ return Math.abs(parseFloat(p.style.left) - 83.3333333333) < 0.001; }).length === 3, 'TAB chord fingering pills stay at each subdivision position');
      var tabTop = document.querySelector('#measuresGrid .beat-cell[data-b="0"] .tab-cell-en');
      check(tabTop && tabTop.textContent === '쉼·E+G+C·D+A+F', 'TAB top label distinguishes the rest from note components');
      appState.scoreView = 'card';
      renderSong();
      var rhythmCell = document.querySelector('#measuresGrid .beat-cell[data-b="0"]');
      check(rhythmCell.querySelector('.b-dur-badge').textContent.trim() === '3분할' && /분할별 길이/.test(rhythmCell.title), 'duration badge retains the three-way group label and tooltip shows subdivision duration details');
      appState.scoreView = 'tab';
      renderSong();

      emitted = [];
      var timers = [];
      window.setTimeout = function(fn, delay){ timers.push({ fn: fn, delay: delay }); return timers.length; };
      window.playSession = { inCountIn: false, nextBeatTime: 4, spb: 0.6, bpb: 4, bIdx: 0, mIdx: 0, loopCompleted: 0, endScheduled: false };
      window.isPlaying = true;
      window.actx.currentTime = 3.95;
      schedulerTick();
      check(emitted.length === 6 && emitted[0].when > 4, 'runtime does not sound notes at the leading rest');
      check(emitted.every(function(event){return event.options && event.options.naturalDecay === true && event.options.exactDuration === undefined;}), 'runtime structured guide requests natural decay without legacy exact-duration gating');
      check(Math.abs(emitted[0].when - 4.2) < 0.000001 && Math.abs(emitted[3].when - 4.4) < 0.000001, 'runtime schedules both chords at their subdivisions');
      check(emitted.map(function(event){ return event.midi; }).join(',') === '42,57,62,52,59,67', 'runtime uses capo-adjusted pitches for every chord note');
      check(timers.length >= 3, 'runtime schedules beat and later subnote UI updates');

      var pimaSubdivisionScore = parseScore('[C] E4@1:i/F4@1:m - - -', 4);
      window.curSong = { id:'browser-guide-pima-subdivision', title:'Pima subdivision', type:'structured', beats:4, measures:pimaSubdivisionScore.measures };
      renderSong();
      timers.length = 0;
      window.playSession = { inCountIn:false, nextBeatTime:9, spb:0.6, bpb:4, bIdx:0, mIdx:0, loopCompleted:0, endScheduled:false };
      window.isPlaying = true;
      window.actx.currentTime = 8.95;
      schedulerTick();
      var pimaUiTimers = timers.slice().sort(function(a, b){ return a.delay - b.delay; });
      check(pimaUiTimers.length >= 2, 'scheduler queues the note and later subdivision fretboard updates');
      pimaUiTimers[0].fn();
      check(document.getElementById('guideRhTxt').textContent === 'i (검지)', 'first scheduled subdivision shows its explicit right-hand finger');
      pimaUiTimers[pimaUiTimers.length - 1].fn();
      check(document.getElementById('guideRhTxt').textContent === 'm (중지)', 'later scheduled subdivision updates the fretboard right-hand finger');

      var pairParsed = parseScore('[C] r/0E2+1C4/D4 - - -', 4);
      var pairBeat = pairParsed.measures[0].beats[0];
      var pairSong = { id: 'browser-guide-pair', title: 'Pair', badge: '', type: 'structured', beats: 4, measures: pairParsed.measures };
      window.curSong = pairSong;
      renderSong();
      var splitPairPills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="0"] .tab-fret-pill'));
      check(splitPairPills.length === 3 && splitPairPills.every(function(p){ return p.classList.contains('note-fret'); }), 'subdivided pair notes use the same neutral pill style');
      window.actx.currentTime = 7;
      emitted = [];
      updateActiveCursor(0, 0, true);
      check(emitted.map(function(event){ return event.midi; }).join(',') === '40,60,62', 'preview always plays every note in an explicitly entered pair');
      var pairEvents = getSubdividedGuideEvents(pairBeat, { startTime: 8, subStep: 0.2, capo: 0, beatsPerBar: 4, preview: false });
      check(Array.from(pairEvents, function(event){ return event.note.midi; }).join(',') === '40,60,62', 'subdivided guide always retains the explicit bass and both melodies');
      window.actx.currentTime = 7;
      emitted = [];
      updateActiveCursor(0, 0, true);
      check(emitted.map(function(event){ return event.midi; }).join(',') === '40,60,62' && Math.abs(emitted[0].when - (7 + (60 / appState.bpm) / 3)) < 0.000001, 'preview plays every explicit pair component at its subnote time');
      check(pairEvents[0].when === 8.2, 'explicit pair bass plays only at its own subnote time');

      emitted = [];
      window.playSession = { inCountIn: false, nextBeatTime: 8, spb: 0.6, bpb: 4, bIdx: 0, mIdx: 0, loopCompleted: 0, endScheduled: false };
      window.isPlaying = true;
      window.actx.currentTime = 7.95;
      schedulerTick();
      check(emitted.map(function(event){ return event.midi; }).join(',') === '40,60,62' && Math.abs(emitted[0].when - 8.2) < 0.000001, 'runtime plays explicit pair bass only at its subnote time');

      var sameStringSong = { id: 'browser-guide-same-string', title: 'Same String', badge: '', type: 'structured', beats: 4, measures: parseScore('[C] 0E2+3G2/D4 - - -', 4).measures };
      window.curSong = sameStringSong;
      renderSong();
      var sameStringPills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="0"] .tab-fret-pill')).filter(function(p){ return Math.abs(parseFloat(p.style.left) - 25) < 0.001; });
      check(sameStringPills.length === 2 && sameStringPills[0].style.transform === 'translate(-85%, -50%)' && sameStringPills[1].style.transform === 'translate(-15%, -50%)', 'same-string pair TAB frets separate horizontally');
      var sameFretSong = { id: 'browser-guide-same-fret', title: 'Same Fret', badge: '', type: 'structured', beats: 4, measures: parseScore('[C] 0E2+2E2/D4 - - -', 4).measures };
      window.curSong = sameFretSong;
      renderSong();
      var sameFretPills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="0"] .tab-fret-pill')).filter(function(p){ return Math.abs(parseFloat(p.style.left) - 25) < 0.001; });
      check(sameFretPills.length === 1 && sameFretPills[0].classList.contains('note-fret'), 'same-string same-fret pair draws one neutral note pill');

      var durationScore = parseScore('[C] 0E2@6:p+!4B4@1:a - -', 3);
      check(durationScore.errors.length === 0, 'shared chord and whole-chord hold fixture parses as a valid three-beat score');
      window.curSong = { id:'browser-shared-duration', title:'Shared duration', type:'structured', beats:3, bpm:100, measures:durationScore.measures };
      appState.beats = 3;
      appState.bpm = 100;
      appState.loopStart = 1;
      appState.loopEnd = 1;
      appState.loopEnable = false;
      appState.guideSound = true;
      renderSong();
      emitted = [];
      stopped = [];
      window.actx.currentTime = 99.99;
      window.playSession = { inCountIn:false, nextBeatTime:100, spb:0.6, bpb:3, bIdx:0, mIdx:0, loopCompleted:0, resumeNextHold:false, endScheduled:false };
      window.isPlaying = true;
      schedulerTick();
      check(emitted.length === 2 && emitted.map(function(event){return event.midi;}).join(',') === '40,71', 'normal scheduler emits both shared-chord notes once');
      check(emitted.every(function(event){return event.options && event.options.naturalDecay === true && event.options.exactDuration === undefined;}), 'app scheduler passes natural decay to the actual guide notes');
      var sharedHoldUnits = durationScore.measures[0].beats[0].durationUnits;
      var sharedHoldDuration = sharedHoldUnits / GuitarRhythm.UNITS_PER_SLOT * window.playSession.spb;
      check(emitted.every(function(event){return event.when === 100 && Math.abs(event.duration-sharedHoldDuration)<1e-9;}),
        'normal scheduler preserves simultaneous onset and the shared whole-chord hold-chain duration');
      var guideButton = document.getElementById('guideSoundBtn');
      guideButton.click();
      check(appState.guideSound === false && stopped.length > 0, 'turning guide sound off cuts scheduled guide voices');
      guideButton.click();
      check(appState.guideSound === true && window.playSession.resumeNextHold === true, 'turning guide sound on arms one resume at the next scheduled beat');
      window.actx.currentTime = 100.59;
      schedulerTick();
      check(emitted.length === 4 && emitted.slice(2).map(function(event){return event.midi;}).sort().join(',') === '40,71' &&
        emitted.slice(2).every(function(event){return event.when === 100.6 && Math.abs(event.duration-1.2)<1e-9;}),
        'guide re-enable restores the whole still-sounding chord with its remaining duration');

      var previewResumeScore = parseScore('[C] 0E2@6:p+!4B4@1:a - -', 3);
      check(previewResumeScore.errors.length === 0, 'whole-chord preview fixture parses as a valid three-beat score');
      window.curSong = { id:'browser-shared-chord-preview-resume', title:'Shared chord preview resume', type:'structured', beats:3, bpm:100, measures:previewResumeScore.measures };
      appState.loopStart = 1;
      appState.loopEnd = 1;
      renderSong();
      emitted = [];
      window.actx.currentTime = 105;
      updateActiveCursor(0, 1, true);
      check(emitted.length === 2 && emitted.map(function(event){return event.midi;}).sort().join(',') === '40,71' &&
        emitted.every(function(event){return event.when === 105 && Math.abs(event.duration-1.2)<1e-9;}),
        'preview on a hold restores every note in the still-sounding chord once with its remaining duration');

      var sameStringDurationScore = parseScore('[C] 0E2@6:p 2F#2@6:p -', 3);
      window.curSong = { id:'browser-duration-same-string', title:'Duration same string', type:'structured', beats:3, bpm:100, measures:sameStringDurationScore.measures };
      renderSong();
      emitted = [];
      window.actx.currentTime = 110;
      updateActiveCursor(0, 2, true);
      check(emitted.length === 1 && emitted[0].midi === 42,
        'preview after a same-string reattack restores only the newer note, not the clipped earlier note');

      var loopClipScore = parseScore('[C] 0E2@6:p - -\\n[G] - - -\\n[D] - - -', 3);
      check(loopClipScore.errors.length === 0 && loopClipScore.measures.length === 3, 'loop-boundary hold fixture has three valid measures so its cutoff is before song end');
      window.curSong = { id:'browser-shared-hold-loop-clip', title:'Shared hold loop clip', type:'structured', beats:3, bpm:100, measures:loopClipScore.measures };
      appState.loopStart = 1;
      renderSong();
      appState.loopEnd = 2;
      emitted = [];
      window.actx.currentTime = 120;
      updateActiveCursor(1, 2, true);
      check(emitted.length === 1 && emitted[0].midi === 40 && Math.abs(emitted[0].duration - 0.6) < 1e-9,
        'last-slot preview clips a cross-bar shared hold at the loop boundary (' + JSON.stringify(emitted.map(function(event){return {midi:event.midi,duration:event.duration,when:event.when};})) + ')');

      var clockScore = parseScore('[C] 0E2 r 0G2 G2@6+B2@5\\n[G] - - - -\\n[D] - - E3 r', 4);
      check(clockScore.errors.length === 0 && clockScore.measures.length === 3 && clockScore.measures.every(function(measure){ return measure.beats.length === 4; }), 'fake-clock runtime fixture is a complete three-measure source score');
      window.curSong = { id:'browser-rhythm-clock', title:'Rhythm clock', type:'structured', beats:4, bpm:100, capo:2, measures:clockScore.measures };
      appState.beats = 4;
      appState.bpm = 100;
      appState.loopEnable = false;
      appState.loopStart = 1;
      appState.loopEnd = 3;
      renderSong();
      emitted = [];
      stopped = [];
      window.actx.currentTime = 39.99;
      window.playSession = { inCountIn:false, nextBeatTime:40, spb:0.6, bpb:4, bIdx:0, mIdx:0, loopCompleted:0, resumeNextHold:false, endScheduled:false };
      window.isPlaying = true;
      schedulerTick();
      window.actx.currentTime = 40.59;
      schedulerTick();
      window.actx.currentTime = 41.19;
      schedulerTick();
      check(stopped.length === 1 && stopped[0] === 40.6, 'a rest schedules voice stop at its exact slot time');
      check(emitted.length === 2 && emitted[1].when === 41.2, 'the note after a rest still schedules normally');

      emitted = [];
      window.actx.currentTime = 50.59;
      window.playSession = { inCountIn:false, nextBeatTime:50.6, spb:0.6, bpb:4, bIdx:1, mIdx:1, loopCompleted:0, resumeNextHold:false, endScheduled:false };
      schedulerTick();
      check(emitted.length === 0, 'an ordinary internal hold slot schedules no new note-on');

      emitted = [];
      appState.loopStart = 2;
      appState.loopEnd = 2;
      var loopStartHold = clockScore.measures[1].beats[0];
      var loopStartSource = GuitarRhythm.resolveHold(clockScore.measures, loopStartHold);
      check(loopStartHold.kind === 'hold' && loopStartSource && loopStartSource.tok === 'G2@6+B2@5', 'loop-start test targets a cross-bar hold linked to the original chord');
      window.actx.currentTime = 59.99;
      window.playSession = { inCountIn:false, nextBeatTime:60, spb:0.6, bpb:4, bIdx:0, mIdx:1, loopCompleted:0, resumeNextHold:false, endScheduled:false };
      schedulerTick();
      check(emitted.length === 2 && emitted[0].midi !== emitted[1].midi && emitted[0].when === emitted[1].when, 'loop-start hold resumes the original chord once with simultaneous attacks');
      check(emitted.every(function(event){ return event.duration === 2.4; }), 'loop-start resumed chord clips to the four slots remaining in the loop');

      emitted = [];
      appState.loopStart = 1;
      appState.loopEnd = 3;
      window.warmKsCache = function(){};
      window.curMeasureIdx = 1;
      window.curBeatIdx = 1;
      window.isPlaying = false;
      window.playSession = null;
      window.actx.currentTime = 70;
      stopped = [];
      await startPractice();
      var resumedSession = window.playSession;
      check(resumedSession && resumedSession.resumeNextHold === true && resumedSession.mIdx === 1 && resumedSession.bIdx === 1, 'middle-slot practice start arms one hold resume outside loop start (' + JSON.stringify(resumedSession && {resume:resumedSession.resumeNextHold,m:resumedSession.mIdx,b:resumedSession.bIdx}) + ')');
      check(stopped.length === 1 && stopped[0] === 70, 'practice start cuts the prior preview before count-in');
      for (var countInIndex = 0; countInIndex < 4; countInIndex++){
        window.actx.currentTime = resumedSession.nextBeatTime - 0.01;
        schedulerTick();
      }
      window.actx.currentTime = resumedSession.nextBeatTime - 0.01;
      schedulerTick();
      check(emitted.length === 2 && emitted[0].when === emitted[1].when, 'middle-slot first hold resumes its original chord once');
      window.actx.currentTime = resumedSession.nextBeatTime - 0.01;
      schedulerTick();
      check(emitted.length === 2, 'the next hold inside the resumed chain does not retrigger');
      window.isPlaying = false;
      window.playSession = null;

      window.curSong = original.song;
      renderSong();
      var clickSession = { inCountIn:false, nextBeatTime:10, spb:0.6, bpb:4, bIdx:0, mIdx:0, loopCompleted:0, endScheduled:false };
      window.playSession = clickSession;
      window.isPlaying = true;
      emitted = [];
      document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="1"]').click();
      check(window.isPlaying && window.playSession === clickSession && clickSession.bIdx === 0 && clickSession.mIdx === 0, 'clicking another slot during playback updates the view without seeking the scheduler');
      check(emitted.length === 0, 'clicking during playback does not layer an unintended preview note');
      window.isPlaying = false;

      var melodySong = { type: 'structured', measures: parseScore('[C] r/C4/D4 - - -', 4).measures };
      var melodyEvents = getSubdividedGuideEvents(melodySong.measures[0].beats[0], { startTime: 9, subStep: 0.2, capo: 0, beatsPerBar: 4, preview: false });
      check(melodyEvents.length === 2, 'single-note subnotes in a chord-named bar receive no added bass');
      check(melodyEvents.every(function(event){ return event.note.midi === 60 || event.note.midi === 62; }), 'single-note subnotes retain only the written pitches');

      var sourceText = '[C] C3@5 G3@3+C4@2 E4@1\\n[C] C3@5 G3@3+C4@2 E4@1';
      var source = parseScore(sourceText, 3);
      var sourceSong = { id:'browser-written-pair-capo', title:'Written pair', type:'structured', beats:3, bpm:60, capo:5, measures:source.measures };
      var originalPairToken = sourceSong.measures[0].beats[1].tok;
      appState.scoreView = 'tab';
      appState.beats = 3;
      window.curSong = sourceSong;
      renderSong();
      var tabPairs = [0, 1].map(function(measureIndex){
        var cell = document.querySelector('#measuresGrid .beat-cell[data-m="' + measureIndex + '"][data-b="1"]');
        var pills = Array.prototype.slice.call(cell.querySelectorAll('.tab-fret-pill'));
        return {
          label: cell.querySelector('.tab-cell-en').textContent,
          hasHandHint: !!cell.querySelector('.tab-cell-rh'),
          low: pills.some(function(p){ return p.classList.contains('note-fret') && p.textContent.trim() === '0' && p.style.top === '40%'; }),
          high: pills.some(function(p){ return p.classList.contains('note-fret') && p.textContent.trim().indexOf('1') === 0 && p.style.top === '20%'; }),
          styles: pills.map(function(p){ var style = getComputedStyle(p); return [style.color, style.backgroundColor, style.borderColor].join('|'); })
        };
      });
      check(tabPairs.every(function(pair){ return pair.label === 'G3+C4' && !pair.hasHandHint && pair.low && pair.high && pair.styles.length === 2 && pair.styles[0] === pair.styles[1]; }), 'both measures show G3+C4 with same-style neutral pills and no p+m hint');
      check(tabPairs[0].styles[0] === tabPairs[1].styles[0], 'pair pills have matching computed foreground, background, and border styles at rest');
      sourceSong.measures.forEach(function(measure){
        measure.beats.forEach(function(beat){
          if (beat.tok.indexOf('G3@3+C4@2') < 0) return;
          beat.lh = 3;
          beat.rh = 'p';
          if (beat.bass) { beat.bass.lh = 4; beat.bass.rh = 'p'; }
          (beat.chordNotes || []).forEach(function(component, index){ component.lh = index + 1; component.rh = index ? 'i' : 'p'; });
        });
      });
      renderSong();
      updateActiveCursor(0, 1, false);
      var oldMetadataPair = document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="1"]');
      check(oldMetadataPair.querySelectorAll('.fret-lh').length === 0 && !oldMetadataPair.querySelector('.tab-cell-rh'), 'old inferred lh/rh metadata is ignored when original pair token has no LH digits');
      check(document.getElementById('guideLhTxt').textContent.indexOf('3줄 미지정 + 2줄 미지정') >= 0 && document.getElementById('guideRhTxt').textContent === '-', 'fretboard guide ignores old inferred hand metadata');

      var explicitHandText = '[C] 1C4 4D4@2 0E4 0G3@3+1C4@2';
      var explicitHandScore = parseScore(explicitHandText, 4);
      window.curSong = { id:'browser-explicit-left-hand', title:'Explicit LH', type:'structured', beats:4, measures:explicitHandScore.measures };
      renderSong();
      function pillLabels(beatIndex){
        return Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="' + beatIndex + '"] .tab-fret-pill')).map(function(p){ var lh = p.querySelector('sup.fret-lh'); return p.querySelector('.fret-label').firstChild.textContent + (lh ? '(' + lh.textContent + ')' : ''); });
      }
      check(pillLabels(0).join(',') === '1(1)' && pillLabels(1).join(',') === '3(4)' && pillLabels(2).join(',') === '0(0)' && pillLabels(3).join(',') === '0(0),1(1)', 'TAB displays only directly written LH digits, including zero, for single notes and pairs');
      updateActiveCursor(0, 0, false);
      check(document.getElementById('guideLhTxt').textContent.indexOf('1번') >= 0 && document.getElementById('guideRhTxt').textContent === '-', 'single-note fretboard guide shows explicit LH and no RH estimate');
      updateActiveCursor(0, 3, false);
      check(document.getElementById('guideLhTxt').textContent.indexOf('3줄 0 + 2줄 1번') >= 0 && document.getElementById('guideRhTxt').textContent === '-', 'pair fretboard guide shows each explicit LH component and no RH estimate');

      var explicitRightHandText = '[C] !1C4@2:i E4@1:a+C3@5:p C3@5:p+E4@1 E4@1:i/F4@1:m';
      var explicitRightHandScore = parseScore(explicitRightHandText, 4);
      window.curSong = { id:'browser-explicit-right-hand', title:'Explicit right hand', type:'structured', beats:4, measures:explicitRightHandScore.measures };
      appState.scoreView = 'tab';
      renderSong();
      function rightHandPills(beatIndex){
        var cell = document.querySelector('#measuresGrid .beat-cell[data-b="' + beatIndex + '"]');
        return Array.prototype.slice.call(cell.querySelectorAll('.fret-rh')).map(function(span){ return span.textContent; });
      }
      var actualPimaPills = [0,1,2,3].map(function(index){ return rightHandPills(index).join(','); });
      check(actualPimaPills.join('|') === 'i|p,a|p|i,m', 'TAB note-on pills show explicit pima by source component for single notes, MIDI-sorted chords, partial chords, and subdivisions: ' + JSON.stringify(actualPimaPills));
      updateActiveCursor(0, 0, false);
      check(document.getElementById('guideRhTxt').textContent === 'i (검지)', 'single-note fretboard guide shows the written right-hand finger and name');
      updateActiveCursor(0, 1, false);
      check(document.getElementById('guideRhTxt').textContent === '오른손 운지: 5줄 p (엄지) + 1줄 a (약지)', 'fretboard guide maps MIDI-sorted chord fingers to their written strings');
      appState.scoreView = 'card';
      renderSong();
      var pimaCard = document.querySelector('#measuresGrid .beat-cell[data-b="1"]');
      check(pimaCard.querySelector('.b-right-hand').textContent === '5줄 p + 1줄 a', 'beat card shows MIDI-sorted chord fingers and strings');
      var partialPimaCard = document.querySelector('#measuresGrid .beat-cell[data-b="2"]');
      check(partialPimaCard.querySelector('.b-right-hand').textContent === '5줄 p + 1줄 미지정', 'beat card identifies a chord component without written right-hand fingering');
      var dividedPimaCard = document.querySelector('#measuresGrid .beat-cell[data-b="3"]');
      check(dividedPimaCard.querySelector('.b-right-hand').textContent === 'i / m', 'beat card lists right-hand fingers in subdivision order');
      var mixedSubHandScore = parseScore('[C] E4@1:i/C3@5+F4@1 - - -', 4);
      window.curSong = { id:'browser-mixed-sub-hand', title:'Mixed subdivision hand', type:'structured', beats:4, measures:mixedSubHandScore.measures };
      appState.scoreView = 'card';
      renderSong();
      var mixedSubHandCard = document.querySelector('#measuresGrid .beat-cell[data-b="0"]');
      check(mixedSubHandCard.querySelector('.b-right-hand').textContent === 'i / -', 'subdivided chord part with no explicit fingers is shown as a dash');
      var noSubHandScore = parseScore('[C] C3@5+E4@1/F4@2+G4@3 - - -', 4);
      window.curSong = { id:'browser-no-sub-hand', title:'No subdivision hand', type:'structured', beats:4, measures:noSubHandScore.measures };
      renderSong();
      check(!document.querySelector('#measuresGrid .beat-cell[data-b="0"] .b-right-hand'), 'subdivisions with no explicit right-hand fingers have no card label');
      var pimaTsv = formatSongToSheetTsv('Pima roundtrip', 4, 64, 'badge', explicitRightHandScore.measures);
      check(pimaTsv.indexOf('!1C4@2:i E4@1:a+C3@5:p C3@5:p+E4@1 E4@1:i/F4@1:m') >= 0, 'TSV serialization keeps articulation, chord, partial, and subdivision pima suffixes');
      var holdRightHandScore = parseScore('[C] C4:i - - -', 4);
      window.curSong = { id:'browser-right-hand-hold', title:'Right hand hold', type:'structured', beats:4, measures:holdRightHandScore.measures };
      appState.scoreView = 'tab';
      renderSong();
      check(rightHandPills(1).length === 0, 'hold ghost pill has no right-hand finger marker');

      window.curSong = sourceSong;
      renderSong();
      updateActiveCursor(0, 1, false);
      var activePair = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-m="0"][data-b="1"] .tab-fret-pill')).map(function(p){ var style = getComputedStyle(p); return [style.color, style.backgroundColor, style.borderColor].join('|'); });
      check(activePair.length === 2 && activePair[0] === activePair[1] && activePair[0] !== tabPairs[0].styles[0], 'active pair pills share the same active foreground, background, and border styles');
      appState.scoreView = 'card';
      renderSong();
      var pairCard = document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="1"]');
      var koMainText = pairCard.querySelector('.b-ko-main').textContent;
      check((koMainText === 'G·C' || koMainText === '솔·도') && pairCard.querySelector('.b-note-sub').textContent === 'G3+C4', 'beat card shows both pair solfege and octave names');
      emitted = [];
      window.actx.currentTime = 12;
      updateActiveCursor(0, 1, true);
      check(emitted.map(function(event){ return event.midi; }).join(',') === '60,65' && emitted.map(function(event){ return event.str; }).join(',') === '3,2', 'preview plays both capo-adjusted pair pitches on strings three and two');
      var fretboardLow = document.querySelector('#fretboard .fb-open[data-str="3"]');
      var fretboardLowMarker = fretboardLow && fretboardLow.querySelector('.fb-marker.target-note');
      var fretboardHigh = document.querySelector('#fretboard .fb-cell[data-str="2"][data-fret="1"] .target-note');
      var guideText = document.getElementById('guideNoteTxt').textContent;
      var guideHand = document.getElementById('guideRhTxt').textContent;
      function directText(element){return Array.prototype.filter.call(element.childNodes,function(node){return node.nodeType===3;}).map(function(node){return node.textContent;}).join('').trim();}
      var lowTargetStyle = fretboardLowMarker && getComputedStyle(fretboardLowMarker);
      var highTargetStyle = fretboardHigh && getComputedStyle(fretboardHigh);
      check(fretboardLow && fretboardLow.dataset.baseLabel==='3G' && directText(fretboardLow)==='' && fretboardLowMarker && (fretboardLowMarker.textContent.indexOf('G')>=0 || fretboardLowMarker.textContent.indexOf('솔')>=0) && fretboardHigh && (fretboardHigh.textContent.indexOf('C')>=0 || fretboardHigh.textContent.indexOf('도')>=0) &&
        lowTargetStyle.borderRadius===highTargetStyle.borderRadius && lowTargetStyle.height===highTargetStyle.height && lowTargetStyle.backgroundColor===highTargetStyle.backgroundColor,
        'open and fretted targets use matching green badge markers while the active open-string base label is hidden');
      var priorChordDots=appState.showChordDots;
      document.getElementById('toggleChordDotsBtn').click();
      check(!!document.querySelector('#fretboard .fb-open[data-str="3"] .fb-marker.target-note') && !!document.querySelector('#fretboard .fb-cell[data-str="2"][data-fret="1"] .fb-marker.target-note'), 'toggling blue chord dots preserves green open and fretted target markers');
      document.getElementById('toggleChordDotsBtn').click();
      appState.showChordDots=priorChordDots;
      var openPairScore=parseScore('[C] 0E4@1+0G3@3 - - -',4);
      highlightFretboard('C',openPairScore.measures[0].beats[0],false,false,0);
      check(document.querySelectorAll('#fretboard .fb-open .fb-marker.target-note').length===2,'simultaneous open-string targets each receive a green marker');
      window.curSong=sourceSong;
      highlightFretboard('C',sourceSong.measures[0].beats[0],false,false,0);
      var restoredOpenThree=document.querySelector('#fretboard .fb-open[data-str="3"]');
      check((restoredOpenThree.textContent===restoredOpenThree.dataset.baseLabel || (restoredOpenThree.querySelector('.fb-marker.chord-tone') && restoredOpenThree.querySelector('.fb-marker.chord-tone').textContent==='0')) && !restoredOpenThree.querySelector('.fb-marker.target-note'), 'moving the target restores the open-string base label or chord-tone zero');
      highlightFretboard('C', null, false, false, 0);
      var open3Chord = document.querySelector('#fretboard .fb-open[data-str="3"] .fb-marker.chord-tone');
      var open1Chord = document.querySelector('#fretboard .fb-open[data-str="1"] .fb-marker.chord-tone');
      check(open3Chord && open3Chord.textContent === '0' && open1Chord && open1Chord.textContent === '0', 'C chord displays zero markers on open strings 3 and 1');
      var open3Target = parseScore('0G3@3 - - -', 4).measures[0].beats[0];
      highlightFretboard('C', open3Target, false, false, 0);
      var open3Cell = document.querySelector('#fretboard .fb-open[data-str="3"]');
      var open3GreenMarker = open3Cell && open3Cell.querySelector('.fb-marker.target-note');
      var open3BlueMarker = open3Cell && open3Cell.querySelector('.fb-marker.chord-tone');
      check(open3GreenMarker && !open3BlueMarker, 'target note on open string 3 overwrites the blue chord-tone zero marker with green target marker');
      var open1StillBlue = document.querySelector('#fretboard .fb-open[data-str="1"] .fb-marker.chord-tone');
      check(open1StillBlue && open1StillBlue.textContent === '0', 'other open-string chord tone remains zero marker');
      highlightFretboard('C', sourceSong.measures[0].beats[0], false, false, 0);
      check(guideText.indexOf('겹음:') === 0 && guideText.indexOf('저음') < 0 && guideHand.indexOf('저음') < 0 && guideText.indexOf('엄지') < 0 && guideHand.indexOf('엄지') < 0 && guideText.indexOf('p(') < 0 && guideHand === '-', 'pair guide lists the notes without inferred hand roles');
      emitted = [];
      window.playSession = { inCountIn: false, nextBeatTime: 13, spb: 0.5, bpb: 3, bIdx: 1, mIdx: 0, loopCompleted: 0, endScheduled: false };
      window.isPlaying = true;
      window.actx.currentTime = 12.95;
      schedulerTick();
      check(emitted.map(function(event){ return event.midi; }).join(',') === '60,65' && emitted.map(function(event){ return event.str; }).join(',') === '3,2', 'runtime plays both capo-adjusted pair pitches on their written strings');
      check(sourceText === '[C] C3@5 G3@3+C4@2 E4@1\\n[C] C3@5 G3@3+C4@2 E4@1' && sourceSong.measures[0].beats[1].tok === originalPairToken, 'pair display and playback do not alter the source or saved token');
      return assertions;
    } finally {
      window.curSong = original.song;
      window.actx = original.actx;
      window.playGuitarNote = original.playGuitarNote;
      window.stopGuitarNotes = original.stopGuitarNotes;
      window.warmKsCache = original.warmKsCache;
      window.scheduleMetronomeClick = original.scheduleMetronomeClick;
      window.ensureAudioCtx = original.ensureAudioCtx;
      window.setTimeout = original.setTimeout;
      window.playSession = original.session;
      window.isPlaying = original.playing;
      window.curMeasureIdx = original.measure;
      window.curBeatIdx = original.beat;
      Object.keys(original.state).forEach(function(key){ appState[key] = original.state[key]; });
      if (original.song) renderSong();
      Object.keys(original.state).forEach(function(key){ appState[key] = original.state[key]; });
    }
  })()`);
  assert.ok(Array.isArray(result) && result.length >= 19, 'subdivided guide regressions pass');
  process.stdout.write('Checks: subdivided guide ' + result.length + '\n');
}

async function capturePimaScreenshots(client) {
  const original = await client.evaluate(`({ id:curSong && curSong.id, view:appState.scoreView })`);
  await client.evaluate(`(function(){
    var parsed = parseScore('[C] !1C4@2:i E4@1:a+C3@5:p C3@5:p+E4@1 E4@1:i/F4@1:m', 4);
    window.curSong = { id:'browser-pima-screenshot', title:'Explicit right hand', type:'structured', beats:4, measures:parsed.measures };
    appState.scoreView = 'tab';
    renderSong();
    var score = document.getElementById('structuredScoreWrap');
    if (score) score.scrollIntoView({ block:'start' });
  })()`);
  const screenshotDir = path.join(__dirname, '..', 'test-artifacts', 'clean-score-ui');
  fs.mkdirSync(screenshotDir, { recursive:true });
  const prefix = 'explicit-pima-' + process.pid + '-' + Date.now();
  const outputs = [];
  for (const viewport of [{ width:1280, height:900, label:'desktop' }, { width:390, height:844, label:'mobile' }]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width:viewport.width, height:viewport.height, deviceScaleFactor:1, mobile:viewport.width < 500 });
    const image = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    const target = path.join(screenshotDir, prefix + '-' + viewport.label + '.png');
    fs.writeFileSync(target, Buffer.from(image.data, 'base64'));
    outputs.push(target);
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false });
  await client.evaluate(`(function(){ if (window.changeSongById) changeSongById(${JSON.stringify(original.id)}); appState.scoreView = ${JSON.stringify(original.view)}; renderSong(); })()`);
  process.stdout.write('Pima screenshots: ' + outputs.join(' ; ') + '\n');
}

async function captureBuiltinRomanceScreenshots(client, browserBin){
  const screenshotDir = path.join(__dirname, '..', 'test-artifacts', 'clean-score-ui');
  fs.mkdirSync(screenshotDir, { recursive:true });
  const browserName = path.basename(browserBin, path.extname(browserBin)).toLowerCase();
  const timestamp = Date.now();
  const outputs = [], boundReports=[];
  try {
    for (const viewport of [{ width:1280, height:1600, label:'desktop' }, { width:390, height:1600, label:'mobile' }]) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width:viewport.width, height:viewport.height, deviceScaleFactor:1, mobile:viewport.width < 500
      });
      await client.evaluate(`(function(){
        changeSongById('builtin-lv6-romance-full');
        appState.scoreView='tab';
        renderSong();
        updateActiveCursor(0,0,false);
        var score=document.getElementById('structuredScoreWrap');
        if(score) score.scrollIntoView({block:'start'});
      })()`);
      const boundsEvidence = await client.evaluate(`(function(){
        function measure(){
          var markers=Array.from(document.querySelectorAll('#measuresGrid .tab-fret-pill.note-fret, #measuresGrid .fret-rh'));
          var failures=[], samples=[];
          markers.forEach(function(marker){
            var cell=marker.closest('.tab-cell'), stave=marker.closest('.tab-stave-wrap');
            if(!cell||!stave){failures.push({reason:'missing-container',className:marker.className});return;}
            var bounds=marker.getBoundingClientRect(), cellBounds=cell.getBoundingClientRect(), staveBounds=stave.getBoundingClientRect();
            var lineElements=Array.from(stave.querySelectorAll('.tab-line-h'));
            var markerCenter=(bounds.top+bounds.bottom)/2;
            var lineDelta=Math.min.apply(null,lineElements.map(function(line){return Math.abs(markerCenter-line.getBoundingClientRect().top);}));
            var bottomGap=staveBounds.bottom-bounds.bottom;
            samples.push({className:marker.className,top:bounds.top,bottom:bounds.bottom,bottomGap:bottomGap,lineDelta:lineDelta});
            if(bounds.left<cellBounds.left-1||bounds.right>cellBounds.right+1||bounds.left<staveBounds.left-1||bounds.right>staveBounds.right+1){
              failures.push({reason:'horizontal-bound',className:marker.className,left:bounds.left,right:bounds.right,cellLeft:cellBounds.left,cellRight:cellBounds.right,staveLeft:staveBounds.left,staveRight:staveBounds.right});
            }
            var isFinger=marker.classList.contains('fret-rh');
            if(bounds.top<staveBounds.top||bounds.bottom>=staveBounds.bottom||!(bottomGap>0)||(!isFinger&&lineDelta>2)){
              failures.push({reason:'vertical-bound-or-line-alignment',className:marker.className,top:bounds.top,bottom:bounds.bottom,staveTop:staveBounds.top,staveBottom:staveBounds.bottom,bottomGap:bottomGap,lineDelta:lineDelta});
            }
          });
          return {count:markers.length,failures:failures,samples:samples};
        }
        var actual=measure(), style=document.createElement('style');
        style.textContent='.beats-row.tab-mode{height:130px;gap:0}.beat-cell.tab-cell{padding-bottom:8px;gap:2px}.tab-stave-side{padding-bottom:8px}.tab-cell-top{flex-shrink:1}.tab-cell-grid{flex-shrink:1}';
        document.head.appendChild(style);
        var legacy;
        try{legacy=measure();}finally{style.remove();}
        var open6=document.querySelector('#fretboard .fb-open[data-str="6"] .target-note');
        var fret7=document.querySelector('#fretboard .fb-cell[data-str="1"][data-fret="7"] .target-note');
        return {actual:actual,legacy:legacy,open6:open6&&open6.textContent,fret7:fret7&&fret7.textContent};
      })()`);
      const pillBounds=boundsEvidence.actual;
      assert.ok(pillBounds.count>0, 'Lv.6 score renders fret pills and explicit right-hand markers');
      assert.deepEqual(pillBounds.failures, [], 'TAB fret pills and right-hand markers fit within their beat cells and stave');
      assert.ok(pillBounds.samples.every(function(sample){return sample.bottomGap>0 && (sample.className.indexOf('fret-rh')>=0 || sample.lineDelta<=2);}), 'TAB pills align with string lines and keep positive bottom clearance: '+JSON.stringify(pillBounds.samples.slice(-8)));
      assert.ok(boundsEvidence.legacy.failures.length>0,'legacy TAB geometry mutation is caught by the same bounds checker: '+JSON.stringify(boundsEvidence.legacy.failures.slice(-6)));
      assert.ok(boundsEvidence.open6&&boundsEvidence.fret7,'TAB/fretboard screenshot shows the actual Lv.6 E2 open-6 and B4 fret-7 target markers');
      const image = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
      const target = path.join(screenshotDir, 'builtin-romance-' + browserName + '-' + viewport.label + '-' + timestamp + '.png');
      fs.writeFileSync(target, Buffer.from(image.data, 'base64'));
      outputs.push(target);
      boundReports.push({viewport:viewport.label,width:viewport.width,height:viewport.height,count:pillBounds.count,
        minBottomGap:Math.min.apply(null,pillBounds.samples.map(function(sample){return sample.bottomGap;})),
        maxLineDelta:Math.max.apply(null,pillBounds.samples.map(function(sample){return sample.lineDelta;})),
        legacyFailureCount:boundsEvidence.legacy.failures.length,legacyFailures:boundsEvidence.legacy.failures,
        open6:boundsEvidence.open6,fret7:boundsEvidence.fret7,screenshot:target});
    }
  } finally {
    await client.send('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false });
  }
  const boundsPath=path.join(screenshotDir,'tab-fretboard-bounds-'+browserName+'-'+timestamp+'.json');
  fs.writeFileSync(boundsPath,JSON.stringify(boundReports,null,2)+'\n');
  process.stdout.write('Built-in Lv.6 Romance screenshots: ' + outputs.join(' ; ') + '\n');
  process.stdout.write('TAB/fretboard geometry evidence: ' + boundsPath + '\n');
}

async function testBuiltinScores(client, browserBin){
  const restoreKey = '__gsBuiltinScoreReviewRestore_' + process.pid;
  await client.evaluate(`(function(){
    var key=${JSON.stringify(restoreKey)};
    window[key]={song:curSong,state:Object.assign({},appState),measure:window.curMeasureIdx,beat:window.curBeatIdx,scrollX:window.scrollX,scrollY:window.scrollY};
  })()`);
  try {
    const review = await client.evaluate(`(function(){
      if(!Array.isArray(window.BUILTIN_SONGS)||window.BUILTIN_SONGS.length!==${builtinSongCount}) throw new Error('Expected the built-in catalog from songs.json');
      if(window.BUILTIN_SONGS.some(function(song){return /arirang|아리랑/i.test(song.id+' '+song.title+' '+song.badge);})) throw new Error('Arirang must not be present in built-in song options');
      var results=[];
      window.BUILTIN_SONGS.forEach(function(builtin){
        var song=window.allSongs.find(function(candidate){return candidate.id===builtin.id;});
        if(!song) throw new Error('Built-in score missing from loaded songs: '+builtin.id);
        if(song.type!=='structured') throw new Error('Built-in score is not structured: '+builtin.id);
        var validation=validateScore(serializeScoreMeasures(builtin.measures,'\\n'),builtin.beats);
        if(validation.errors.length) throw new Error('Built-in score validation failed: '+builtin.id+' '+JSON.stringify(validation.errors));
        changeSongById(builtin.id);
        ['tab','card'].forEach(function(view){
          appState.scoreView=view;
          renderSong();
          var grid=document.getElementById('measuresGrid');
          var cards=grid?grid.querySelectorAll('.measure-card'):[];
          var wrapper=document.getElementById('structuredScoreWrap');
          var hasNotes=view==='tab'
            ? !!(grid&&grid.querySelector('.tab-fret-pill.note-fret'))
            : !!(grid&&grid.querySelector('.beat-cell .b-note-sub'));
          if(cards.length!==song.measures.length) throw new Error('Rendered measure count mismatch: '+builtin.id+' '+view+' '+cards.length+'/'+song.measures.length);
          if(!hasNotes) throw new Error('Rendered score has no note content: '+builtin.id+' '+view);
          if(!wrapper||!wrapper.classList.contains(view==='tab'?'tab-view-active':'card-view-active')) throw new Error('Score view did not render: '+builtin.id+' '+view);
          results.push({id:builtin.id,view:view,measures:cards.length,hasNotes:hasNotes,errors:validation.errors.length});
        });
      });
      changeSongById('builtin-lv5-romance');
      appState.scoreView='card';
      renderSong();
      var lv5Card=document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="1"]');
      if(!lv5Card) throw new Error('Lv.5 single-melody card is missing');
      document.querySelectorAll('#measuresGrid .active-beat').forEach(function(cell){cell.classList.remove('active-beat');});
      lv5Card.style.transition='none';
      var lv5InactiveBackground=getComputedStyle(lv5Card).backgroundColor;
      var lv5HasOldArpClass=lv5Card.classList.contains('arp-melody')||lv5Card.classList.contains('arp-sub');
      updateActiveCursor(0,1,false);
      var lv5ActiveCard=document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="1"]');
      var lv5Active={classActive:lv5ActiveCard.classList.contains('active-beat'),background:getComputedStyle(lv5ActiveCard).backgroundColor};
      changeSongById('builtin-lv1-butterfly');
      appState.scoreView='card';
      renderSong();
      document.querySelectorAll('#measuresGrid .active-beat').forEach(function(cell){cell.classList.remove('active-beat');});
      var plainCard=document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="0"]');
      var lv1InactiveBackground=getComputedStyle(plainCard).backgroundColor;
      changeSongById('builtin-lv6-romance-full');
      appState.scoreView='tab';
      var romance=window.allSongs.find(function(song){return song.id==='builtin-lv6-romance-full';});
      if(!romance) throw new Error('Lv.6 Romance built-in score is missing');
      if(romance.beats!==3||Number(romance.bpm)!==56) throw new Error('Lv.6 Romance meter or tempo mismatch');
      appState.scoreView='tab';
      updateActiveCursor(0,0,false);
      var open6=document.querySelector('#fretboard .fb-open[data-str="6"]');
      var open6Marker=open6&&open6.querySelector('.fb-marker.target-note');
      var fret7Marker=document.querySelector('#fretboard .fb-cell[data-str="1"][data-fret="7"] .fb-marker.target-note');
      var openTargetStyle=open6Marker&&getComputedStyle(open6Marker),fretTargetStyle=fret7Marker&&getComputedStyle(fret7Marker);
      var firstOpenTarget={open6Marker:open6Marker&&open6Marker.textContent,fret7Marker:fret7Marker&&fret7Marker.textContent,
        baseLabel:open6&&open6.dataset.baseLabel,directLabel:open6?Array.prototype.filter.call(open6.childNodes,function(node){return node.nodeType===3;}).map(function(node){return node.textContent;}).join('').trim():null,
        sameBadgeStyle:!!(openTargetStyle&&fretTargetStyle&&openTargetStyle.borderRadius===fretTargetStyle.borderRadius&&openTargetStyle.height===fretTargetStyle.height&&openTargetStyle.backgroundColor===fretTargetStyle.backgroundColor)};
      var nextB3=romance.measures[0].beats[0].subNotes[1];
      highlightFretboard('Em',nextB3,false,false,0);
      var restoredOpen6=document.querySelector('#fretboard .fb-open[data-str="6"]');
      var movedOpen2=document.querySelector('#fretboard .fb-open[data-str="2"]');
      var fretboardTargets={first:firstOpenTarget,nextB3:nextB3.midi,open6Restored:restoredOpen6&&(restoredOpen6.textContent===restoredOpen6.dataset.baseLabel || (restoredOpen6.querySelector('.fb-marker.chord-tone') && restoredOpen6.querySelector('.fb-marker.chord-tone').textContent==='0')),
        open2Marker:movedOpen2&&movedOpen2.querySelector('.fb-marker.target-note')&&movedOpen2.querySelector('.fb-marker.target-note').textContent};
      updateActiveCursor(0,0,false);
      var slotDuration=1;
      var sourceScore=serializeScoreMeasures(romance.measures,'\\n');
      function guideSignature(){
        var signature=[];
        romance.measures[0].beats.forEach(function(beat,index){
          getBeatGuideEvents(beat,{startTime:index*slotDuration,slotDuration:slotDuration,measures:romance.measures}).forEach(function(event){
            signature.push([event.note.midi,event.when,event.duration,event.articulation]);
          });
        });
        return signature;
      }
      var sourceGuide=guideSignature();
      renderSong();
      var first=romance.measures[0];
      if(!first||first.beats.length!==3||!first.beats.every(function(beat){return beat.subNotes&&beat.subNotes.length===3;})) throw new Error('Lv.6 first measure must have three beats split into three notes');
      var firstMeasure=document.querySelector('#measuresGrid .measure-card[data-m="0"]');
      var fingers=firstMeasure?Array.from(firstMeasure.querySelectorAll('.fret-rh')).map(function(node){return node.textContent;}):[];
      if(fingers.slice(0,4).join('/')!=='p/a/m/i') throw new Error('Lv.6 first measure TAB does not show explicit p/a/m/i: '+fingers.join('/'));
      var tabCells=[0,1,2].map(function(index){return document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="'+index+'"]');});
      var tabLabels=tabCells.map(function(cell){return cell&&cell.querySelector('.tab-cell-en')?cell.querySelector('.tab-cell-en').textContent:null;});
      var tabTitles=tabCells.map(function(cell){return cell?cell.title:'';});
      var tabRhBadges=tabCells.map(function(cell){return !!(cell&&cell.querySelector('.tab-cell-rh'));});
      if(serializeScoreMeasures(romance.measures,'\\n')!==sourceScore||JSON.stringify(guideSignature())!==JSON.stringify(sourceGuide)) throw new Error('Lv.6 TAB rendering changed serialized score or guide event semantics');

      appState.scoreView='card';
      renderSong();
      var cardCells=[0,1,2].map(function(index){return document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="'+index+'"]');});
      var cardLabels=cardCells.map(function(cell){return cell&&cell.querySelector('.b-note-sub')?cell.querySelector('.b-note-sub').textContent:null;});
      var cardTitles=cardCells.map(function(cell){return cell?cell.title:'';});
      var cardDurationBadges=cardCells.map(function(cell){var badge=cell&&cell.querySelector('.b-dur-badge');return badge?badge.textContent.trim():'';});
      var cardArticulationClasses=cardCells.map(function(cell){return !!(cell&&(cell.classList.contains('arp-melody')||cell.classList.contains('arp-sub')));});
      if(serializeScoreMeasures(romance.measures,'\\n')!==sourceScore||JSON.stringify(guideSignature())!==JSON.stringify(sourceGuide)) throw new Error('Lv.6 card rendering changed serialized score or guide event semantics');
      appState.scoreView='tab';
      renderSong();
      if(serializeScoreMeasures(romance.measures,'\\n')!==sourceScore||JSON.stringify(guideSignature())!==JSON.stringify(sourceGuide)) throw new Error('Lv.6 restored TAB rendering changed serialized score or guide event semantics');

      var events=[];
      first.beats.forEach(function(beat,index){
        events=events.concat(getBeatGuideEvents(beat,{startTime:index*slotDuration,slotDuration:slotDuration,measures:romance.measures}));
      });
      var expectedTimes=[0,0,1/3,2/3,1,4/3,5/3,2,7/3,8/3];
      if(events.length!==10) throw new Error('Lv.6 first measure must produce 10 guide note events, got '+events.length);
      events.forEach(function(event,index){
        if(Math.abs(event.when-expectedTimes[index])>1e-9) throw new Error('Lv.6 guide event is not at the expected third-beat onset: '+index+' '+event.when);
      });
      if(events.filter(function(event){return event.note.midi===40;}).length!==1||
        events.filter(function(event){return event.note.midi===71;}).length!==3||
        events.filter(function(event){return event.note.midi!==40&&event.note.midi!==71;}).length!==6) throw new Error('Lv.6 bass/melody/inner note counts are not 1/3/6');
      if(events[0].note.midi!==40||events[0].gain!==1||events[0].articulation!==null||
        events[1].note.midi!==71||events[1].gain!==1.16||events[1].articulation!=='apoyando') throw new Error('Lv.6 opening bass/melody articulation or gain mismatch');
      var noArticulationGlyphs=tabLabels.concat(cardLabels,tabTitles,cardTitles).every(function(value){return !/[!~]/.test(value);});
      var cardTitleHasUniformArticulation=cardTitles.some(function(title){return title.indexOf('악보 지정 아포얀도')>=0;});
      var score=document.getElementById('structuredScoreWrap');
      if(score) score.scrollIntoView({block:'start'});
      return {catalogCount:window.BUILTIN_SONGS.length,rendered:results,lv5Card:{inactiveBackground:lv5InactiveBackground,plainBackground:lv1InactiveBackground,
        hasOldArpClass:lv5HasOldArpClass,activeClass:lv5Active.classActive,activeBackground:lv5Active.background},romance:{id:romance.id,bpm:romance.bpm,beats:romance.beats,
        firstMeasureBeats:first.beats.length,subdivisionCounts:first.beats.map(function(beat){return beat.subNotes.length;}),
        durationName:getBeatDurationInfo(first.beats,0,romance.beats).durName,fretboardTargets:fretboardTargets,
        fingers:fingers.slice(0,4),tabLabels:tabLabels,tabTitles:tabTitles,tabRhBadges:tabRhBadges,
         cardLabels:cardLabels,cardTitles:cardTitles,cardDurationBadges:cardDurationBadges,cardArticulationClasses:cardArticulationClasses,
        cardTitleHasUniformArticulation:cardTitleHasUniformArticulation,noArticulationGlyphs:noArticulationGlyphs,
        serializationPreserved:serializeScoreMeasures(romance.measures,'\\n')===sourceScore,
        sourceContainsArticulationTokens:/[!~]/.test(sourceScore),
        guidePreserved:JSON.stringify(guideSignature())===JSON.stringify(sourceGuide),
        guideEvents:events.map(function(event){return {midi:event.note.midi,when:event.when,gain:event.gain,
          articulation:event.articulation,str:event.str,duration:event.duration};})}};
    })()`);
    assert.equal(review.catalogCount, builtinSongCount, 'all built-in scores are reviewed');
    assert.equal(review.rendered.length, builtinSongCount * 2, 'each built-in score renders in tab and card views');
    assert.ok(review.rendered.every(function(item){return item.measures>0&&item.hasNotes&&item.errors===0;}), 'built-in score DOM and validation are clean');
    assert.equal(review.lv5Card.hasOldArpClass,false,'Lv.5 card has no old melodic-blue or sub-voice class');
    assert.equal(review.lv5Card.inactiveBackground,review.lv5Card.plainBackground,'inactive Lv.5 card uses the plain card background');
    assert.equal(review.lv5Card.activeClass,true,'active beat selection remains highlighted in Lv.5 card view');
    assert.notEqual(review.lv5Card.activeBackground,review.lv5Card.inactiveBackground,'active beat highlight remains distinct from the plain card background');
    assert.ok(review.romance.fretboardTargets.first.baseLabel==='6E'&&review.romance.fretboardTargets.first.directLabel===''&&
      (review.romance.fretboardTargets.first.open6Marker.indexOf('E')>=0||review.romance.fretboardTargets.first.open6Marker.indexOf('미')>=0)&&
      (review.romance.fretboardTargets.first.fret7Marker.indexOf('B')>=0||review.romance.fretboardTargets.first.fret7Marker.indexOf('시')>=0)&&
      review.romance.fretboardTargets.first.sameBadgeStyle,'actual Lv.6 first chord marks E2 open-6 and B4 fret-7 with the shared green badge style');
    assert.equal(review.romance.fretboardTargets.nextB3,59,'actual next B3 part remains the open-string target');
    assert.equal(review.romance.fretboardTargets.open6Restored,true,'moving the target to B3 restores the 6E open-string label');
    assert.ok(review.romance.fretboardTargets.open2Marker.indexOf('B')>=0||review.romance.fretboardTargets.open2Marker.indexOf('시')>=0,'moving the target places a green badge on B3 open-2');
    assert.equal(review.romance.bpm, 56, 'Lv.6 Romance tempo is 56');
    assert.equal(review.romance.beats, 3, 'Lv.6 Romance uses three beats per measure');
    assert.deepEqual(review.romance.subdivisionCounts, [3,3,3], 'all first-measure beats use three subdivisions');
    assert.deepEqual(review.romance.fingers, ['p','a','m','i'], 'first measure TAB shows explicit p/a/m/i fingers');
    assert.deepEqual(review.romance.tabLabels, ['E+B·B·G','B·B·G','B·B·G'], 'compact TAB labels show pitches without articulation glyphs');
    assert.deepEqual(review.romance.cardLabels, ['E2+B4 · B3 · G3','B4 · B3 · G3','B4 · B3 · G3'], 'card labels show pitches without articulation glyphs');
    assert.ok(review.romance.noArticulationGlyphs,'TAB/card labels and tooltips contain no ! or ~ glyphs');
    assert.ok(review.romance.tabTitles[0].includes('E2+B4 · B3 · G3'), 'first TAB title shows pitch names without articulation glyphs');
    assert.deepEqual(review.romance.tabRhBadges, [false,false,false], 'pitch labels have no articulation badges');
    assert.ok(review.romance.durationName && review.romance.tabTitles[0].includes(review.romance.durationName), 'TAB tooltip shows shared part durations for the subdivisions');
    assert.ok(review.romance.cardTitles[0].includes(review.romance.durationName), 'card tooltip shows shared part durations for the subdivisions');
    assert.deepEqual(review.romance.cardDurationBadges, ['3분할','3분할','3분할'], 'shared-length notation keeps the existing group badges');
    assert.equal(review.romance.cardTitleHasUniformArticulation, false, 'mixed articulation tooltip does not assign one technique to the whole beat');
    assert.deepEqual(review.romance.cardArticulationClasses, [false,false,false], 'mixed articulation card beats have no uniform apo/tir class');
    assert.equal(review.romance.serializationPreserved, true, 'TAB/card rendering leaves serialized built-in score unchanged');
    assert.equal(review.romance.sourceContainsArticulationTokens,true,'source score keeps its written ! and ~ articulation metadata');
    assert.equal(review.romance.guidePreserved, true, 'TAB/card rendering leaves pitch, time, duration, and articulation guide events unchanged');
    assert.equal(review.romance.guideEvents.length, 10, 'first measure produces 10 guide note events');
    process.stdout.write('Browser checkpoint: all built-in scores render in TAB/card; Lv.6 Romance first measure has explicit p/a/m/i and 10 timed guide notes\n');
    await captureBuiltinRomanceScreenshots(client,browserBin);
    // Capture Romance measure 3 card view for visual verification
    const cardScreenshotDir = path.join(__dirname, '..', 'test-artifacts', 'clean-score-ui');
    await client.evaluate(`(function(){
      changeSongById('builtin-lv6-romance-full');
      appState.scoreView = 'card';
      renderSong();
      updateActiveCursor(2, 0, false);
      var m3 = document.querySelector('#measuresGrid .measure-card[data-m="2"]');
      if (m3) m3.scrollIntoView();
    })()`);
    const cardScreenshot = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    fs.writeFileSync(path.join(cardScreenshotDir, 'romance-card-m3-cde.png'), Buffer.from(cardScreenshot.data, 'base64'));
    await client.evaluate(`(function(){
      appState.notationMode = 'solfege';
      syncNotationModeUI();
      renderSong();
      updateActiveCursor(2, 0, false);
      var m3 = document.querySelector('#measuresGrid .measure-card[data-m="2"]');
      if (m3) m3.scrollIntoView();
    })()`);
    const cardSolfegeScreenshot = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    fs.writeFileSync(path.join(cardScreenshotDir, 'romance-card-m3-solfege.png'), Buffer.from(cardSolfegeScreenshot.data, 'base64'));
    process.stdout.write('Romance card m3 screenshots captured (CDE & solfege)\n');
    await client.evaluate(`(function(){
      highlightFretboard('Am', null, true, false, 0);
      var fb = document.getElementById('fretboard');
      if (fb) fb.scrollIntoView();
    })()`);
    const amScreenshot = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    fs.writeFileSync(path.join(cardScreenshotDir, 'fretboard-am-open-zeros.png'), Buffer.from(amScreenshot.data, 'base64'));
    process.stdout.write('Am chord open zeros screenshot captured\n');
  } finally {
    await client.evaluate(`(function(){
      var key=${JSON.stringify(restoreKey)},saved=window[key];
      if(!saved) return;
      if(saved.song) window.curSong=saved.song;
      Object.keys(appState).forEach(function(name){if(!Object.prototype.hasOwnProperty.call(saved.state,name)) delete appState[name];});
      Object.keys(saved.state).forEach(function(name){appState[name]=saved.state[name];});
      window.curMeasureIdx=saved.measure; window.curBeatIdx=saved.beat;
      if(window.curSong){renderSong();saveAppState();}
      window.scrollTo(saved.scrollX,saved.scrollY);
      delete window[key];
    })()`);
  }
}

async function testStorageFailureRecovery(client) {
  const result = await client.evaluate(`(async function(){
    var openSheet = document.getElementById('openSheetSyncBtn');
    openSheet.click();
    var opened = !document.getElementById('sheetSyncModal').hidden;
    document.getElementById('closeSheetSyncBtn').click();
    var closed = document.getElementById('sheetSyncModal').hidden;
    var song = imageSongs[0];
    if (!song) throw new Error('expected image uploaded in prior lifecycle test');
    var oldSave = window.dbSaveImageSong;
    var originalChord = song.systems[0].bars[0].chord;
    changeSongById(song.id);
    window.selectedImgBar = { sysIdx:0, barIdx:0, globalIdx:0 };
    document.getElementById('editBarMetaBtn').click();
    document.getElementById('beChord').value = 'G';
    window.dbSaveImageSong = function(){ return Promise.reject(new Error('Injected image storage failure')); };
    document.getElementById('saveBarEditBtn').click();
    await new Promise(function(resolve){ setTimeout(resolve, 30); });
    var failedPreserves = song.systems[0].bars[0].chord === originalChord && !document.getElementById('barEditModal').hidden && !document.getElementById('storageStatus').hidden;
    window.dbSaveImageSong = oldSave;
    document.getElementById('saveBarEditBtn').click();
    for (var i=0; i<100 && song.systems[0].bars[0].chord !== 'G'; i++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
    var retrySaved = song.systems[0].bars[0].chord === 'G' && document.getElementById('barEditModal').hidden;
    changeSongById(song.id);
    window.confirm = function(){ return true; };
    document.getElementById('deleteSongBtn').click();
    for (var deleteWait=0; deleteWait<100 && imageSongs.some(function(item){ return item.id === song.id; }); deleteWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
    var deleted = !imageSongs.some(function(item){ return item.id === song.id; });
    window.dbSaveImageSong = oldSave;
    return { opened:opened, closed:closed, failedPreserves:failedPreserves, retrySaved:retrySaved, deleted:deleted };
  })()`);
  assert.deepEqual(result, { opened:true, closed:true, failedPreserves:true, retrySaved:true, deleted:true }, 'image save failure preserves edits for retry, delete works, and Sheets modal wiring remains live');
  process.stdout.write('Checks: image storage recovery, delete, and sheet wiring 5\n');
}
async function testInvalidStructuredPersistence(client) {
  const result = await client.evaluate(`(async function(){
    var originalSong = window.curSong;
    var originalSongs = window.allSongs.slice();
    var originalState = { bpm: appState.bpm, loopStart: appState.loopStart, loopEnd: appState.loopEnd };
    var originalPlaying = window.isPlaying;
    var originalSession = window.playSession;
    var oldSave = window.dbSaveImageSong;
    var writes = [];
    try {
      var invalidParse = parseScore('[C] 0E2@6:p*3 - -', 3);
      var invalid = { id:'browser-invalid-readonly', title:'Invalid read-only', type:'structured', beats:3, measures:invalidParse.measures, fromSheet:true };
      var sourceToken = invalid.measures[0].beats[0].tok;
      window.allSongs.push(invalid);
      window.dbSaveImageSong = function(song){ writes.push(song.id); return Promise.resolve(true); };
      changeSongById(invalid.id);
      await startPractice();
      var blocked = window.isPlaying === false && window.playSession == null && /재생할 수 없는 악보/.test(document.getElementById('phaseTxt').textContent);
      saveAppState();
      appState.bpm = 88;
      saveAppState();
      window.isPlaying = true;
      window.playSession = {};
      stopPractice();
      return { writes:writes, blocked:blocked, invalidErrors:invalidParse.errors.length, textMetadata:JSON.parse(localStorage.getItem('gs.state')).bpm === 88, sourcePreserved:invalid.measures[0].beats[0].tok === sourceToken };
    } finally {
      window.dbSaveImageSong = oldSave;
      window.allSongs = originalSongs;
      window.curSong = originalSong;
      Object.keys(originalState).forEach(function(key){ appState[key] = originalState[key]; });
      window.isPlaying = originalPlaying;
      window.playSession = originalSession;
      renderSong();
    }
  })()`);
  assert.deepEqual(result.writes, [], 'invalid read-only text selection and practice settings never write IndexedDB');
  assert.equal(result.blocked, true, 'invalid read-only score playback remains blocked');
  assert.ok(result.invalidErrors > 0, 'removed *N syntax is rejected by the parser before app playback');
  assert.equal(result.textMetadata, true, 'app settings remain in local storage');
  assert.equal(result.sourcePreserved, true, 'invalid read-only score source remains unchanged');
  process.stdout.write('Checks: invalid read-only playback guard 4\n');
}
// 악보 입력 화면(score-input.html): 실제 클릭·키 이벤트로 입력하고 결과 텍스트를 본다.
async function testScoreInputScreen(client, httpPort) {
  const inputHtml = fs.readFileSync(path.join(root, 'score-input.html'), 'utf8');
  const inputScripts = [...inputHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(inputScripts.map(src => src.split('?')[0]), ['src/storage.js', 'src/app-state.js', 'src/notation.js', 'src/rhythm.js', 'src/parser.js', 'src/score-ui.js', 'src/score-prompt.js', 'src/audio.js', 'src/staff-layout.js', 'src/staff-svg.js', 'src/tab-input.js', 'src/staff-input.js', 'src/tab-input-ui.js'], 'score-input.html classic scripts keep the required order');
  assert.ok(inputScripts.every(src => src.endsWith('?v=measure-scroll-1')), 'score-input.html scripts use the page revision');
  assert.match(inputHtml, /<link rel="stylesheet" href="src\/base\.css\?v=measure-scroll-1">/, 'score-input.html loads the shared base stylesheet');
  assert.match(inputHtml, /family=Noto\+Music/, 'score-input.html loads the Noto Music font for the staff');
  ['tiTitle', 'tiBeats', 'tiBpm', 'tiDescription', 'tiCapoSelect', 'tiKeySelect', 'tiNewBtn', 'tiImportBtn', 'tiUndoBtn', 'tiRedoBtn', 'tiSaveStatus', 'tiStatus',
    'tiSelectionBar', 'tiSelectionLabel', 'tiCopyBtn', 'tiPasteBtn', 'tiDuplicateBtn', 'tiClearBtn', 'tiDeleteBtn', 'tiInsertBtn', 'tiDeselectBtn', 'tiMeasures', 'tiAddMeasureBtn',
    'tiResultPanel', 'tiDiagnostics', 'tiScoreText', 'tiCopyTextBtn', 'tiCopyTsvBtn', 'tiOpenPracticeBtn', 'tiResultStatus', 'tiDock', 'tiCursorLabel', 'tiPrevBtn', 'tiNextBtn',
    'tiRestBtn', 'tiClearSlotBtn', 'tiDiv1', 'tiDiv2', 'tiDiv3', 'tiDiv4', 'tiPlaySlotBtn', 'tiAutoAdvance', 'tiSoundToggle', 'tiStaffToggle', 'tiDockToggle', 'tiFretboard', 'tiAttrs', 'tiUncertainBtn',
    'tiImportDialog', 'tiImportText', 'tiImportError', 'tiImportApplyBtn', 'tiImportCancelBtn', 'backToPracticeLink'
  ].forEach(id => assert.match(inputHtml, new RegExp('id="' + id + '"'), 'score-input.html includes #' + id));

  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  async function loadPage(url, readyExpression, action) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await action();
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, readyExpression, 8000);
  }
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  const inputReady = 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1';
  async function installHelpers() {
    await client.evaluate(`window.__tiTest = {
      key: function(key, code, mods){ var event = new KeyboardEvent('keydown', Object.assign({ key:key, code:code || '', bubbles:true, cancelable:true }, mods || {})); document.body.dispatchEvent(event); return event.defaultPrevented; },
      pos: function(m, c, s, str){ return document.querySelector('.ti-slot[data-m="'+m+'"][data-c="'+c+'"][data-s="'+s+'"] .ti-pos[data-str="'+str+'"]'); },
      fret: function(str, fret){ return document.querySelector('.ti-fret[data-str="'+str+'"][data-fret="'+fret+'"]'); },
      attr: function(name, value){ return document.querySelector('[data-attr="'+name+'"][data-value="'+value+'"]'); },
      text: function(){ return document.getElementById('tiScoreText').value; },
      count: function(){ return document.querySelectorAll('#tiMeasures .ti-measure').length; },
      id: function(id){ return document.getElementById(id); }
    }; true`);
  }
  const text = () => client.evaluate('window.__tiTest.text()');
  const firstLine = async () => (await text()).split('\n')[0];

  // 1. 깨끗한 상태로 열기
  await client.evaluate(`(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`);
  const errorsBefore = client.consoleErrors.length;
  await loadPage(inputUrl, inputReady, () => client.send('Page.navigate', { url: inputUrl }));
  await installHelpers();
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'score-input.html opens without console errors');
  const initial = await client.evaluate(`({ measures:__tiTest.count(), slots:document.querySelectorAll('.ti-slot').length, text:__tiTest.text(), title:document.title,
    back:document.getElementById('backToPracticeLink').getAttribute('href'), error:document.getElementById('tiDiagnostics').textContent })`);
  assert.deepEqual(initial, { measures: 1, slots: 4, text: '[-] r r r r | ""', title: '악보 입력 · 기타 스튜디오', back: 'index.html', error: '오류 없음' }, 'a clean start has one empty measure of four slots');

  // 2. 지판과 키보드로 음 넣기
  await client.evaluate(`(function(){ var t = __tiTest; t.pos(0,0,0,6).click(); t.fret(6,0).click(); return true; })()`);
  assert.equal(await firstLine(), '[-] E2@6 - - - | ""', 'tab position click then fretboard click writes the open sixth string');
  await client.evaluate(`(function(){ var t = __tiTest; t.key('ArrowRight','ArrowRight'); t.key('3','Digit3'); return true; })()`);
  assert.equal(await firstLine(), '[-] E2@6 G2@6 - - | ""', 'arrow then digit key writes the third fret on the cursor string');
  await client.evaluate(`(function(){ var t = __tiTest; t.key('ArrowRight','ArrowRight'); t.key('1','Digit1'); t.key('2','Digit2'); return true; })()`);
  assert.equal(await firstLine(), '[-] E2@6 G2@6 E3@6 - | ""', 'quick 1 then 2 writes fret 12');
  await client.evaluate(`(function(){ var t = __tiTest; t.key('ArrowRight','ArrowRight'); t.key('r','KeyR'); return true; })()`);
  assert.equal(await text(), '[-] E2@6 G2@6 E3@6 r | ""', 'the R key writes a rest');

  // 3. 칸 나누기, 운지, 확인 표시
  await client.evaluate(`(function(){ var t = __tiTest; document.querySelector('.ti-cell-head[data-c="0"]').click(); t.id('tiDiv2').click(); t.pos(0,0,1,1).click(); t.fret(1,0).click(); return true; })()`);
  assert.equal(await firstLine(), '[-] E2@6/E4@1 G2@6 E3@6 r | ""', 'dividing a cell and filling the second slot makes a slash token');
  await client.evaluate(`(function(){ var t = __tiTest; t.attr('lh','1').click(); t.attr('rh','i').click(); return true; })()`);
  assert.equal(await firstLine(), '[-] E2@6/1E4@1:i G2@6 E3@6 r | ""', 'left and right hand fingering attach to the cursor note');
  await client.evaluate(`__tiTest.id('tiUncertainBtn').click(); true`);
  assert.equal(await firstLine(), '[-] E2@6/1E4@1:i? G2@6 E3@6 r | ""', 'the check mark attaches to the cursor note');
  assert.equal(await client.evaluate(`!!document.querySelector('.ti-slot[data-m="0"][data-c="0"][data-s="1"] .ti-pos[data-str="1"].is-uncertain')`), true, 'a checked note is marked in the tab');
  assert.equal(await client.evaluate(`document.querySelector('.ti-slot[data-m="0"][data-c="0"][data-s="1"] .ti-pos[data-str="1"]').textContent`), '01i', 'tab text shows the fret, then the left hand and right hand as small figures');
  assert.deepEqual(await client.evaluate(`(function(){ var pos = document.querySelector('.ti-slot[data-m="0"][data-c="0"][data-s="1"] .ti-pos[data-str="1"]'); return [pos.querySelector('sup.fret-lh').textContent, pos.querySelector('sub.fret-rh').textContent, pos.querySelectorAll('.fret-fing').length]; })()`), ['1', 'i', 1], 'left hand is a superscript and right hand a subscript sharing one column');

  // 4. 되돌리기와 다시 하기
  await client.evaluate(`__tiTest.key('z','KeyZ',{ctrlKey:true}); true`);
  assert.equal(await firstLine(), '[-] E2@6/1E4@1:i G2@6 E3@6 r | ""', 'Ctrl+Z undoes the last edit');
  await client.evaluate(`__tiTest.key('y','KeyY',{ctrlKey:true}); true`);
  assert.equal(await firstLine(), '[-] E2@6/1E4@1:i? G2@6 E3@6 r | ""', 'Ctrl+Y redoes it');

  // 오른쪽 클릭으로 지우기
  const contextMenu = await client.evaluate(`(function(){
    var event = new MouseEvent('contextmenu', { bubbles:true, cancelable:true });
    __tiTest.pos(0,1,0,6).dispatchEvent(event);
    return { prevented:event.defaultPrevented, text:__tiTest.text() };
  })()`);
  assert.equal(contextMenu.prevented, true, 'the browser context menu is blocked on a tab position');
  assert.equal(contextMenu.text.split('\n')[0], '[-] E2@6/1E4@1:i? - E3@6 r | ""', 'right click erases the note');
  await client.evaluate(`__tiTest.key('z','KeyZ',{ctrlKey:true}); true`);
  assert.equal(await firstLine(), '[-] E2@6/1E4@1:i? G2@6 E3@6 r | ""', 'undo brings the erased note back');

  // 5. 마디 복제와 삭제
  const firstMeasureLine = await firstLine();
  await client.evaluate(`document.querySelector('.ti-measure-num').click(); true`);
  assert.equal(await client.evaluate(`document.getElementById('tiSelectionBar').hidden`), false, 'clicking a measure number shows the selection bar');
  assert.equal(await client.evaluate(`document.getElementById('tiSelectionLabel').textContent`), '1마디 선택', 'the selection label names the measure');
  await client.evaluate(`__tiTest.id('tiDuplicateBtn').click(); true`);
  const duplicated = (await text()).split('\n');
  assert.equal(await client.evaluate('__tiTest.count()'), 2, 'duplicate adds one measure');
  assert.equal(duplicated[1], firstMeasureLine, 'the duplicated measure writes the same line');
  await client.evaluate(`__tiTest.id('tiDeleteBtn').click(); true`);
  assert.equal(await client.evaluate('__tiTest.count()'), 1, 'delete removes the selected measure');

  // 6. 입력 시 자동 이동
  await client.evaluate(`(function(){ var t = __tiTest; t.id('tiAutoAdvance').click(); t.pos(0,3,0,2).click(); t.fret(2,0).click(); return true; })()`);
  const advanced = await client.evaluate(`({ measures:__tiTest.count(), label:document.getElementById('tiCursorLabel').textContent, pressed:document.getElementById('tiAutoAdvance').getAttribute('aria-pressed') })`);
  assert.deepEqual(advanced, { measures: 2, label: '2마디 · 1칸 · 2번 줄', pressed: 'true' }, 'auto advance appends a measure after the last slot and moves the cursor into it');
  await client.evaluate(`__tiTest.id('tiAutoAdvance').click(); true`);

  // 7. 새로고침 후에도 같은 악보
  const beforeReload = await text();
  const saveStatus = await client.evaluate(`document.getElementById('tiSaveStatus').textContent`);
  assert.match(saveStatus, /^자동 저장됨 \d\d:\d\d$/, 'the save status shows the time of the last auto save');
  await loadPage(inputUrl, inputReady, () => client.send('Page.reload', { ignoreCache: true }));
  await installHelpers();
  assert.equal(await text(), beforeReload, 'the score survives a reload through auto save');
  assert.equal(await client.evaluate(`document.getElementById('tiAutoAdvance').getAttribute('aria-pressed')`), 'false', 'the panel setting is restored');

  // 8. 불러오기
  const song = builtinSongsJson[0];
  const imported = await client.evaluate(`(function(){
    var song = ${JSON.stringify({ title: song.title, beats: song.beats, bpm: song.bpm, badge: song.badge, lines: song.lines })};
    var tsv = formatSongToSheetTsv(song.title, song.beats, song.bpm, song.badge || '', song.lines);
    window.confirm = function(){ return true; };
    document.getElementById('tiImportBtn').click();
    var opened = document.getElementById('tiImportDialog').open;
    var area = document.getElementById('tiImportText');
    area.value = tsv;
    area.dispatchEvent(new Event('input', { bubbles:true }));
    document.getElementById('tiImportApplyBtn').click();
    return { opened:opened, closed:!document.getElementById('tiImportDialog').open, measures:__tiTest.count(), expected:splitScoreMeasures(song.lines.join('\\n')).length,
      diagnostics:document.getElementById('tiDiagnostics').textContent, importError:document.getElementById('tiImportError').textContent,
      status:document.getElementById('tiStatus').textContent, title:document.getElementById('tiTitle').value, beats:document.getElementById('tiBeats').value };
  })()`);
  assert.equal(imported.opened, true, 'the import button opens the dialog');
  assert.equal(imported.closed, true, 'a successful import closes the dialog');
  assert.equal(imported.importError, '', 'a successful import shows no import error');
  assert.equal(imported.measures, imported.expected, 'the imported song has every measure');
  assert.ok(imported.measures > 1, 'the imported song replaced the typed measures');
  assert.ok(imported.diagnostics.includes('오류 없음'), 'the imported song passes validation');
  assert.equal(imported.status, '불러왔습니다 · ' + imported.measures + '마디', 'the status reports the imported measure count');
  assert.equal(imported.title, song.title, 'the imported title is shown');
  assert.equal(imported.beats, String(song.beats), 'the imported beat count is shown');
  const badImport = await client.evaluate(`(function(){
    document.getElementById('tiImportBtn').click();
    var area = document.getElementById('tiImportText');
    area.value = '[C] Q9 - - -';
    document.getElementById('tiImportApplyBtn').click();
    var result = { open:document.getElementById('tiImportDialog').open, error:document.getElementById('tiImportError').textContent, measures:__tiTest.count() };
    document.getElementById('tiImportCancelBtn').click();
    return result;
  })()`);
  assert.equal(badImport.open, true, 'a broken import keeps the dialog open');
  assert.ok(badImport.error.length > 0, 'a broken import explains the error in the dialog');
  assert.equal(badImport.measures, imported.measures, 'a broken import leaves the score as it was');

  // 10, 11. 화면 크기와 스크린샷
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  async function inputShot(name, width, height, mobile) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await client.evaluate(`(function(){ __tiTest.pos(0,0,0,1).click(); window.scrollTo(0, 0); return true; })()`);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const target = path.join(root, 'test-artifacts', name);
    fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
    const header = fs.readFileSync(target).subarray(0, 24);
    assert.equal(header.readUInt32BE(16), width, name + ' width');
    assert.equal(header.readUInt32BE(20), height, name + ' height');
    process.stdout.write('Artifact: ' + target + '\n');
    return client.evaluate('({ scroll:document.documentElement.scrollWidth, inner:window.innerWidth, dock:document.getElementById("tiDock").getBoundingClientRect().height })');
  }
  // 1024x768 높이 목표와 키보드 이동 때 입력판에 가리지 않는지
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`(function(){ window.scrollTo(0, 0); return true; })()`);
  const tablet = await client.evaluate(`({ dock:document.getElementById('tiDock').getBoundingClientRect().height,
    panel:document.getElementById('tiInfoPanel').getBoundingClientRect().height,
    hintVisible:getComputedStyle(document.querySelector('.ti-dock-hint')).display !== 'none' })`);
  assert.ok(tablet.dock <= 210, 'the 1024x768 input dock is at most 210px tall (is ' + tablet.dock + ')');
  assert.ok(tablet.panel <= 150, 'the 1024x768 song info panel is at most 150px tall (is ' + tablet.panel + ')');
  assert.equal(tablet.hintVisible, true, 'the shortcut hint is shown at 900px and wider');
  const keyScroll = await client.evaluate(`(function(){
    __tiTest.pos(0,0,0,1).click();
    for (var i = 0; i < 40; i++) __tiTest.key('ArrowRight', 'ArrowRight');
    var slot = document.querySelector('.ti-slot.is-cursor-slot');
    var rect = slot.getBoundingClientRect(), dock = document.getElementById('tiDock').getBoundingClientRect();
    return { top:rect.top, bottom:rect.bottom, dockTop:dock.top, label:document.getElementById('tiCursorLabel').textContent };
  })()`);
  assert.ok(keyScroll.bottom <= keyScroll.dockTop && keyScroll.top >= 0, 'keyboard cursor moves keep the cursor slot clear of the dock (' + JSON.stringify(keyScroll) + ')');
  const narrowHint = await client.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 768, deviceScaleFactor: 1, mobile: false }).then(() => client.evaluate(`getComputedStyle(document.querySelector('.ti-dock-hint')).display`));
  assert.equal(narrowHint, 'none', 'the shortcut hint is hidden below 900px');
  const desktopShot = await inputShot('score-input-desktop.png', 1280, 900, false);
  assert.ok(desktopShot.scroll <= desktopShot.inner, 'the desktop page does not overflow horizontally');
  const mobileShot = await inputShot('score-input-mobile.png', 375, 812, true);
  assert.ok(mobileShot.dock <= 812 * 0.4, 'the 375x812 input dock is at most 40% of the viewport (is ' + mobileShot.dock + ')');
  const attrsToggle = await client.evaluate(`(function(){
    var attrs = document.getElementById('tiAttrs'), toggle = document.getElementById('tiAttrsToggle');
    var out = { toggleVisible:toggle.offsetHeight > 0, closedHeight:attrs.offsetHeight, rowNoWrap:getComputedStyle(document.querySelector('.ti-dock-row')).flexWrap };
    toggle.click();
    out.openHeight = attrs.offsetHeight; out.pressed = toggle.getAttribute('aria-pressed'); out.saved = JSON.parse(localStorage.getItem('gs.tabInput.ui')).attrsOpen;
    toggle.click();
    out.reclosed = attrs.offsetHeight;
    return out;
  })()`);
  assert.deepEqual([attrsToggle.toggleVisible, attrsToggle.closedHeight, attrsToggle.rowNoWrap, attrsToggle.pressed, attrsToggle.saved, attrsToggle.reclosed], [true, 0, 'nowrap', 'true', true, 0], 'on a phone the finger row starts closed and the toggle opens and closes it');
  assert.ok(attrsToggle.openHeight > 0, 'the finger row is visible after the toggle');
  assert.ok(mobileShot.scroll <= mobileShot.inner, 'the 375px page does not overflow horizontally (scrollWidth ' + mobileShot.scroll + ' > ' + mobileShot.inner + ')');
  await client.send('Emulation.clearDeviceMetricsOverride');

  // 카포 콤보박스: 설명 글의 카포 표기를 읽고 고친다. 콤보를 고르면 한 단계(되돌리기 하나)로 글이 바뀐다.
  const capoErrorsBefore = client.consoleErrors.length;
  const capoState = () => client.evaluate('({ select:document.getElementById("tiCapoSelect").value, description:document.getElementById("tiDescription").value, info:document.getElementById("tiCapoInfo") })');
  assert.equal((await capoState()).info, null, 'the capo badge is gone');
  await client.evaluate(`(function(){ var d = document.getElementById('tiDescription'); d.value = '카포 2'; d.dispatchEvent(new Event('input', { bubbles:true })); d.dispatchEvent(new Event('change', { bubbles:true })); return true; })()`);
  assert.equal((await capoState()).select, '2', 'typing a capo mark in the description moves the combo box');
  const setCapo = value => client.evaluate(`(function(){ var select = document.getElementById('tiCapoSelect'); select.value = '${value}'; select.dispatchEvent(new Event('change', { bubbles:true })); return true; })()`);
  await setCapo(5);
  assert.equal((await capoState()).description, '카포 5', 'picking 5 rewrites the capo mark in the description');
  await setCapo(0);
  const capoZero = await capoState();
  assert.deepEqual([capoZero.select, capoZero.description], ['0', ''], 'picking none removes the capo mark');
  await client.evaluate('document.getElementById("tiUndoBtn").click(); true');
  const capoUndone = await capoState();
  assert.deepEqual([capoUndone.select, capoUndone.description], ['5', '카포 5'], 'one undo brings back the capo mark and the combo box');
  assert.equal(await client.evaluate('curCapo()'), 5, 'the capo the screen plays with follows the combo box');
  const capoWidths = [];
  for (const [width, height, mobile] of [[1024, 768, false], [375, 812, true]]) {
    const result = await inputShot(width === 1024 ? 'score-input-capo.png' : 'score-input-capo-mobile.png', width, height, mobile);
    capoWidths.push(result);
    assert.ok(result.scroll <= result.inner, 'the ' + width + 'px page does not overflow horizontally with the capo combo box (scrollWidth ' + result.scroll + ' > ' + result.inner + ')');
    const row = await client.evaluate('(function(){ var row = document.querySelector("#tiInfoPanel .ti-row"); return { scroll:row.scrollWidth, client:row.clientWidth, panel:document.getElementById("tiInfoPanel").getBoundingClientRect().height }; })()');
    assert.ok(row.scroll <= row.client, 'the song info row does not overflow at ' + width + 'px (' + JSON.stringify(row) + ')');
    if (width === 1024) assert.ok(row.panel <= 150, 'the 1024x768 song info panel is at most 150px tall with the capo combo box (is ' + row.panel + ')');
  }
  await client.send('Emulation.clearDeviceMetricsOverride');
  await setCapo(0);
  assert.equal(await client.evaluate('document.getElementById("tiDescription").value'), '', 'the capo mark is removed again');
  assert.deepEqual(client.consoleErrors.slice(capoErrorsBefore), [], 'the capo combo box runs without console errors');

  // 마디 영역 자체 스크롤: 마디가 많으면 마디 영역에 스크롤바가 서고 결과 영역이 멀지 않으며, 커서 조각은 입력판에 가리지 않는다.
  const scrollErrorsBefore = client.consoleErrors.length;
  const importScore = lineCount => client.evaluate(`(function(){
    window.confirm = function(){ return true; };
    var lines = [];
    for (var i = 0; i < ${lineCount}; i++) lines.push('[-] C4 - - - | ""');
    document.getElementById('tiImportBtn').click();
    var area = document.getElementById('tiImportText');
    area.value = lines.join('\\n');
    area.dispatchEvent(new Event('input', { bubbles:true }));
    document.getElementById('tiImportApplyBtn').click();
    return { measures:__tiTest.count(), error:document.getElementById('tiImportError').textContent, open:document.getElementById('tiImportDialog').open };
  })()`);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  const many = await importScore(40);
  assert.deepEqual(many, { measures: 40, error: '', open: false }, 'a 40-measure score is imported for the measure scroll checks');
  const scrollBox = await client.evaluate(`(function(){
    window.scrollTo(0, 0);
    var box = document.getElementById('tiMeasures'), result = document.getElementById('tiResultPanel');
    var boxTop = box.getBoundingClientRect().top + window.scrollY, resultTop = result.getBoundingClientRect().top + window.scrollY;
    return { overflowY:getComputedStyle(box).overflowY, scrollHeight:box.scrollHeight, clientHeight:box.clientHeight, inner:window.innerHeight,
      dock:document.getElementById('tiDock').getBoundingClientRect().height, gap:resultTop - boxTop };
  })()`);
  assert.equal(scrollBox.overflowY, 'auto', 'the measure area scrolls on its own (overflow-y auto)');
  assert.ok(scrollBox.scrollHeight > scrollBox.clientHeight, 'the 40-measure area has a scrollbar (' + JSON.stringify(scrollBox) + ')');
  assert.ok(scrollBox.clientHeight <= scrollBox.inner - scrollBox.dock - 32 + 1, 'the measure area fits between the top and the input dock (' + JSON.stringify(scrollBox) + ')');
  assert.ok(scrollBox.gap <= scrollBox.clientHeight + 120, 'the result panel sits right after the measure area (' + JSON.stringify(scrollBox) + ')');
  const lastSlot = await client.evaluate(`(function(){
    window.scrollTo(0, 0);
    document.getElementById('tiMeasures').scrollTop = 0;
    __tiTest.pos(0,0,0,1).click();
    window.scrollTo(0, 0);
    document.getElementById('tiMeasures').scrollTop = 0;
    for (var i = 0; i < 159; i++) __tiTest.key('ArrowRight', 'ArrowRight');
    var slot = document.querySelector('.ti-slot.is-cursor-slot');
    var rect = slot.getBoundingClientRect(), box = document.getElementById('tiMeasures').getBoundingClientRect();
    var dock = document.getElementById('tiDock').getBoundingClientRect(), bar = document.getElementById('tiSelectionBar');
    return { m:slot.dataset.m, c:slot.dataset.c, top:rect.top, bottom:rect.bottom, boxTop:box.top, boxBottom:box.bottom, dockTop:dock.top,
      barBottom:bar.hidden ? null : bar.getBoundingClientRect().bottom, boxScroll:document.getElementById('tiMeasures').scrollTop };
  })()`);
  assert.deepEqual([lastSlot.m, lastSlot.c], ['39', '3'], 'arrow keys reach the last cell of the last measure (' + JSON.stringify(lastSlot) + ')');
  assert.ok(lastSlot.boxScroll > 0, 'the measure area scrolled itself to the cursor (' + JSON.stringify(lastSlot) + ')');
  assert.ok(lastSlot.top >= lastSlot.boxTop - 1 && lastSlot.bottom <= lastSlot.boxBottom + 1, 'the cursor slot is inside the visible measure area (' + JSON.stringify(lastSlot) + ')');
  assert.ok(lastSlot.bottom <= lastSlot.dockTop && lastSlot.top >= 0, 'the cursor slot on the last measure stays above the input dock (' + JSON.stringify(lastSlot) + ')');
  if (lastSlot.barBottom !== null) assert.ok(lastSlot.top >= lastSlot.barBottom, 'the cursor slot stays below the selection bar (' + JSON.stringify(lastSlot) + ')');
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  await client.evaluate('window.scrollTo(0, document.documentElement.scrollHeight); true');
  const scrollShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const scrollShotPath = path.join(root, 'test-artifacts', 'score-input-measure-scroll.png');
  fs.writeFileSync(scrollShotPath, Buffer.from(scrollShot.data, 'base64'));
  const scrollShotHeader = fs.readFileSync(scrollShotPath).subarray(0, 24);
  assert.deepEqual([scrollShotHeader.readUInt32BE(16), scrollShotHeader.readUInt32BE(20)], [1024, 768], 'measure scroll screenshot size');
  process.stdout.write('Artifact: ' + scrollShotPath + '\n');
  const few = await importScore(2);
  assert.deepEqual(few, { measures: 2, error: '', open: false }, 'a 2-measure score is imported for the short score check');
  const shortBox = await client.evaluate('(function(){ var box = document.getElementById("tiMeasures"); return { scrollHeight:box.scrollHeight, clientHeight:box.clientHeight }; })()');
  assert.ok(shortBox.scrollHeight <= shortBox.clientHeight, 'two measures show no scrollbar (' + JSON.stringify(shortBox) + ')');
  await importScore(40);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  const phoneBox = await client.evaluate('(function(){ var box = document.getElementById("tiMeasures"); return { page:document.documentElement.scrollWidth, inner:window.innerWidth, scrollHeight:box.scrollHeight, clientHeight:box.clientHeight }; })()');
  assert.ok(phoneBox.page <= phoneBox.inner, 'the 375px page does not overflow horizontally with the measure scroll (' + JSON.stringify(phoneBox) + ')');
  assert.ok(phoneBox.clientHeight >= 280 || phoneBox.scrollHeight < 280, 'the 375x812 measure area keeps at least 280px (' + JSON.stringify(phoneBox) + ')');
  await client.send('Emulation.clearDeviceMetricsOverride');
  await importScore(2);
  assert.deepEqual(client.consoleErrors.slice(scrollErrorsBefore), [], 'the measure scroll checks run without console errors');
  process.stdout.write('Measure scroll 1024x768: ' + JSON.stringify(scrollBox) + '\n');

  // 9. 연습 화면에서 열기
  const inputTitle = await client.evaluate('document.getElementById("tiTitle").value.trim()');
  await loadPage(`http://127.0.0.1:${httpPort}/index.html`, 'document.readyState === "complete" && window.allSongs && window.curSong != null', () => client.evaluate(`document.getElementById('tiOpenPracticeBtn').click(); true`, { userGesture: true }));
  const practice = await client.evaluate(`(function(){
    var option = document.getElementById('songSelect').selectedOptions[0];
    return { path:location.pathname, title:curSong.title, group:option && option.parentElement ? option.parentElement.label : null, handoffLeft:localStorage.getItem('gs.tabInput.handoff') };
  })()`);
  assert.equal(practice.path, '/index.html', 'open-in-practice goes to the practice screen');
  assert.equal(practice.title, inputTitle, 'the practice screen opens the song typed in the input screen');
  assert.equal(practice.group, '임시 악보', 'the handed-over song sits in the temporary score group');
  assert.equal(practice.handoffLeft, null, 'the handoff key is consumed');
  await client.evaluate(`(function(){ ['gs.tabInput.doc', 'gs.tabInput.ui'].forEach(function(key){ localStorage.removeItem(key); }); return true; })()`);
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: score input screen typing, undo, measure operations, auto advance, reload, import, layout, and practice handoff passed\n');
}

// 악보 입력 화면의 오선 미리보기(src/staff-svg.js를 화면에 연결한 부분): 그려지는지, 조표, 켜고 끄기, 머리 클릭, 타브와 가로 정렬, 내장곡, 스크린샷.
async function testScoreInputStaff(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  const inputReady = 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1';
  async function loadPage(action) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await action();
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, inputReady, 8000);
  }
  async function installHelpers() {
    await client.evaluate(`window.__tiTest = {
      pos: function(m, c, s, str){ return document.querySelector('.ti-slot[data-m="'+m+'"][data-c="'+c+'"][data-s="'+s+'"] .ti-pos[data-str="'+str+'"]'); },
      fret: function(str, fret){ return document.querySelector('.ti-fret[data-str="'+str+'"][data-fret="'+fret+'"]'); },
      text: function(){ return document.getElementById('tiScoreText').value; },
      setKey: function(value){ var select = document.getElementById('tiKeySelect'); select.value = value; select.dispatchEvent(new Event('change', { bubbles:true })); },
      heads: function(m){ return document.querySelectorAll('#tiMeasures .ti-measure:nth-child('+(m + 1)+') .ti-staff-wrap svg .st-head').length; },
      acc: function(m){ return document.querySelectorAll('#tiMeasures .ti-measure:nth-child('+(m + 1)+') .ti-staff-wrap svg .st-acc').length; },
      keys: function(m){ return document.querySelectorAll('#tiMeasures .ti-measure:nth-child('+(m + 1)+') .ti-staff-wrap svg .st-key').length; },
      click: function(node){ node.dispatchEvent(new MouseEvent('click', { bubbles:true })); }
    }; true`);
  }
  const firstLine = async () => (await client.evaluate('window.__tiTest.text()')).split('\n')[0];
  const clearStorage = `(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`;

  // 깨끗한 상태로 열고 음 셋을 넣는다: 1칸 1번 줄 0프렛(E4), 2칸 1번 줄 2프렛, 3칸 3번 줄 0프렛(G3).
  await client.evaluate(clearStorage);
  const errorsBefore = client.consoleErrors.length;
  await loadPage(() => client.send('Page.navigate', { url: inputUrl }));
  await installHelpers();
  assert.equal(await client.evaluate('document.getElementById("tiKeySelect").value'), '0s', 'a clean start has no key signature, written with sharps');
  assert.equal(await client.evaluate('document.querySelectorAll("#tiMeasures .ti-measure .ti-staff-wrap svg").length'), 1, 'an empty measure already shows a staff');
  await client.evaluate(`(function(){ var t = __tiTest; t.pos(0,0,0,1).click(); t.fret(1,0).click(); t.pos(0,1,0,1).click(); t.fret(1,2).click(); t.pos(0,2,0,3).click(); t.fret(3,0).click(); return true; })()`);

  // (1) 오선이 그려지고 음 머리 수가 넣은 음 수와 같다
  assert.equal(await client.evaluate('window.__tiTest.heads(0)'), 3, 'staff note heads match the typed notes');
  assert.equal(await client.evaluate('document.querySelectorAll("#tiMeasures .ti-measure:first-child .ti-staff-wrap svg .st-clef").length'), 1, 'the first measure shows the clef');

  // (2) 조표: ♭으로 적기면 Gb4, ♯ 1개면 F#4(조표에 든 음이라 임시표 없음), ♯로 적기면 임시표 하나
  await client.evaluate(`__tiTest.setKey('0f'); true`);
  assert.ok((await firstLine()).startsWith('[-] E4@1 Gb4@1 G3@3'), 'flat spelling writes Gb4');
  assert.equal(await client.evaluate('window.__tiTest.acc(0)'), 1, 'a flat note outside the key signature gets a flat sign');
  await client.evaluate(`__tiTest.setKey('1'); true`);
  assert.ok((await firstLine()).startsWith('[-] E4@1 F#4@1 G3@3'), 'one-sharp key writes F#4');
  assert.equal(await client.evaluate('window.__tiTest.acc(0)'), 0, 'F# inside the key signature draws no accidental');
  assert.equal(await client.evaluate('window.__tiTest.keys(0)'), 1, 'the key signature shows one sharp');
  await client.evaluate(`__tiTest.setKey('0s'); true`);
  assert.ok((await firstLine()).startsWith('[-] E4@1 F#4@1 G3@3'), 'no key signature with sharp spelling writes F#4');
  assert.equal(await client.evaluate('window.__tiTest.acc(0)'), 1, 'F# without a key signature gets a sharp sign');
  assert.equal(await client.evaluate('document.getElementById("tiKeySelect").value'), '0s', 'the key list shows sharp spelling');
  await client.evaluate(`__tiTest.setKey('-2'); true`);
  assert.equal(await client.evaluate('window.__tiTest.keys(0)'), 2, 'a two-flat key shows two flats');
  await client.evaluate(`__tiTest.setKey('0s'); true`);

  // (5) 첫 마디 오선 첫 음 머리와 타브 첫 조각의 가운데 x가 맞는다(위아래 정렬)
  const align = await client.evaluate(`(function(){
    var head = document.querySelector('#tiMeasures .ti-measure:first-child .st-head').getBoundingClientRect();
    var slot = document.querySelector('#tiMeasures .ti-measure:first-child .ti-slot').getBoundingClientRect();
    return { head: head.left + head.width / 2, slot: slot.left + slot.width / 2 };
  })()`);
  assert.ok(Math.abs(align.head - align.slot) <= 2, 'the first note head is centered over the first tab slot (' + JSON.stringify(align) + ')');

  // (4) 음 머리를 누르면 커서가 그 조각과 줄로 간다
  await client.evaluate(`(function(){ var heads = document.querySelectorAll('#tiMeasures .ti-measure:first-child .st-head'); __tiTest.click(Array.prototype.filter.call(heads, function(h){ return h.dataset.str === '3'; })[0]); return true; })()`);
  assert.equal(await client.evaluate('document.getElementById("tiCursorLabel").textContent'), '1마디 · 3칸 · 3번 줄', 'clicking a note head moves the cursor to its slot and string');
  await client.evaluate(`(function(){ var heads = document.querySelectorAll('#tiMeasures .ti-measure:first-child .st-head'); __tiTest.click(Array.prototype.filter.call(heads, function(h){ return h.dataset.str === '1'; })[1]); return true; })()`);
  assert.equal(await client.evaluate('document.getElementById("tiCursorLabel").textContent'), '1마디 · 2칸 · 1번 줄', 'clicking another note head moves the cursor again');
  const band = await client.evaluate(`(function(){
    var band = document.querySelector('#tiMeasures .ti-measure:first-child .ti-staff-cursor'), slot = document.querySelector('.ti-slot.is-cursor-slot');
    var b = band.getBoundingClientRect(), s = slot.getBoundingClientRect();
    return { hidden: band.hidden, dx: Math.abs(b.left - s.left), dw: Math.abs(b.width - s.width), visibleBands: document.querySelectorAll('.ti-staff-cursor:not([hidden])').length };
  })()`);
  assert.deepEqual([band.hidden, band.visibleBands], [false, 1], 'one cursor band is shown above the staff');
  assert.ok(band.dx <= 1 && band.dw <= 1, 'the staff cursor band covers the cursor slot (' + JSON.stringify(band) + ')');

  // (3) 오선 보기 끄기·켜기와 새로고침 뒤 유지
  async function staffShown() { return client.evaluate('getComputedStyle(document.querySelector("#tiMeasures .ti-staff-wrap")).display !== "none"'); }
  assert.equal(await staffShown(), true, 'the staff is shown by default');
  assert.equal(await client.evaluate('document.getElementById("tiStaffToggle").getAttribute("aria-pressed")'), 'true', 'the staff toggle starts pressed');
  await client.evaluate('document.getElementById("tiStaffToggle").click(); true');
  assert.equal(await staffShown(), false, 'the staff toggle hides the staff');
  assert.equal(await client.evaluate('document.getElementById("tiStaffToggle").getAttribute("aria-pressed")'), 'false', 'the pressed state follows');
  await loadPage(() => client.send('Page.reload', { ignoreCache: true }));
  await installHelpers();
  assert.equal(await staffShown(), false, 'the hidden staff stays hidden after a reload');
  assert.equal(await client.evaluate('document.getElementById("tiStaffToggle").getAttribute("aria-pressed")'), 'false', 'the pressed state survives a reload');
  await client.evaluate('document.getElementById("tiStaffToggle").click(); true');
  assert.equal(await staffShown(), true, 'the staff toggle shows the staff again');
  assert.equal(await client.evaluate('window.__tiTest.heads(0)'), 3, 'the staff is drawn again with every note');
  assert.equal(await client.evaluate('JSON.parse(localStorage.getItem("gs.tabInput.ui")).staffOn'), true, 'the setting is saved in gs.tabInput.ui');

  // (6) 내장곡 로망스(셋잇단·화음·붙임줄)를 불러와도 콘솔 오류가 없고 셋잇단 숫자가 그려진다
  const song = builtinSongsJson.find(item => item.id === 'builtin-lv6-romance-full');
  assert.ok(song, 'builtin-lv6-romance-full exists');
  const imported = await client.evaluate(`(function(){
    var song = ${JSON.stringify({ title: song.title, beats: song.beats, bpm: song.bpm, badge: song.badge, lines: song.lines })};
    var tsv = formatSongToSheetTsv(song.title, song.beats, song.bpm, song.badge || '', song.lines);
    window.confirm = function(){ return true; };
    document.getElementById('tiImportBtn').click();
    document.getElementById('tiImportText').value = tsv;
    document.getElementById('tiImportApplyBtn').click();
    return { measures: document.querySelectorAll('#tiMeasures .ti-measure').length, svgs: document.querySelectorAll('#tiMeasures .ti-staff-wrap svg').length,
      tuplets: document.querySelectorAll('.st-tuplet').length, heads: document.querySelectorAll('.st-head').length, diagnostics: document.getElementById('tiDiagnostics').textContent };
  })()`);
  assert.ok(imported.diagnostics.includes('오류 없음'), 'the imported song passes validation');
  assert.equal(imported.svgs, imported.measures, 'every imported measure has a staff');
  assert.ok(imported.tuplets >= 1, 'triplet numbers are drawn for the imported song (' + imported.tuplets + ')');
  assert.ok(imported.heads > imported.measures, 'note heads are drawn for the imported song');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the staff preview runs without console errors');

  // 운지가 붙은 프렛 글자가 조각보다 넓어도 칸이 넓어져서 데스크톱 카드에 가로 스크롤이 생기지 않고, 오선 머리가 타브 조각과 계속 맞는다
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  const widths = await client.evaluate(`(function(){
    return Array.prototype.slice.call(document.querySelectorAll('#tiMeasures .ti-staff-scroll')).slice(0, 3).map(function(scroll, index){
      var card = scroll.closest('.ti-measure');
      var head = card.querySelector('.st-head').getBoundingClientRect(), slot = card.querySelector('.ti-slot').getBoundingClientRect();
      return { scroll: scroll.scrollWidth, client: scroll.clientWidth, dx: Math.abs((head.left + head.width / 2) - (slot.left + slot.width / 2)) };
    });
  })()`);
  assert.equal(widths.length, 3, 'the first three imported measures are checked');
  widths.forEach((item, index) => {
    assert.ok(item.scroll <= item.client, 'imported measure ' + (index + 1) + ' has no horizontal scrollbar at 1024px (' + JSON.stringify(item) + ')');
    assert.ok(item.dx <= 2, 'imported measure ' + (index + 1) + ' keeps the first note head over its tab slot (' + JSON.stringify(item) + ')');
  });

  const secondCard = await client.evaluate(`document.querySelectorAll('#tiMeasures .ti-measure')[1].getBoundingClientRect().width`);
  assert.ok(secondCard <= 360, 'the second imported measure card is at most 360px wide at 1024px (is ' + secondCard + ')');

  // (7) 스크린샷과 휴대폰 폭 가로 넘침
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  async function staffShot(name, width, height, mobile) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await client.evaluate('window.scrollTo(0, 0); true');
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const target = path.join(root, 'test-artifacts', name);
    fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
    const header = fs.readFileSync(target).subarray(0, 24);
    assert.equal(header.readUInt32BE(16), width, name + ' width');
    assert.equal(header.readUInt32BE(20), height, name + ' height');
    process.stdout.write('Artifact: ' + target + '\n');
    return client.evaluate('({ scroll:document.documentElement.scrollWidth, inner:window.innerWidth })');
  }
  const desktop = await staffShot('score-input-staff.png', 1280, 900, false);
  assert.ok(desktop.scroll <= desktop.inner, 'the desktop page with a staff does not overflow horizontally');
  const firstRow = await client.evaluate(`(function(){ var cards = Array.prototype.slice.call(document.querySelectorAll('#tiMeasures .ti-measure')); return cards.filter(function(card){ return card.offsetTop === cards[0].offsetTop; }).length; })()`);
  assert.ok(firstRow >= 2, 'at least two imported measure cards share the first row at 1280px (is ' + firstRow + ')');
  const phone = await staffShot('score-input-staff-mobile.png', 375, 812, true);
  assert.ok(phone.scroll <= phone.inner, 'the 375px page with a staff does not overflow horizontally (scrollWidth ' + phone.scroll + ' > ' + phone.inner + ')');
  await client.send('Emulation.clearDeviceMetricsOverride');
  await client.evaluate(clearStorage);
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: staff preview drawing, key signature, toggle, head click, tab alignment, built-in song, and screenshots passed\n');
}

// 악보 입력 화면의 오선 입력 모드(음 고르는 오선, 길이 단추, 키보드): 규칙은 Docs/staff-input.md, 계산은 src/staff-input.js.
async function testStaffInputMode(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const inputHtml = fs.readFileSync(path.join(root, 'score-input.html'), 'utf8');
  ['tiModeTab', 'tiModeStaff', 'tiStaffPanel', 'tiPitchPicker', 'tiPitchHint', 'tiDotBtn', 'tiTripletBtn', 'tiStaffRestBtn', 'tiSemiUpBtn', 'tiSemiDownBtn', 'tiStringCands'
  ].forEach(id => assert.match(inputHtml, new RegExp('id="' + id + '"'), 'score-input.html includes #' + id));
  ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'].forEach(value => assert.match(inputHtml, new RegExp('data-dur="' + value + '"'), 'score-input.html has the ' + value + ' length button'));
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  const inputReady = 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1';
  async function loadPage(action) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await action();
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, inputReady, 8000);
  }
  async function installHelpers() {
    await client.evaluate(`window.__tiTest = {
      key: function(key, code, mods){ var event = new KeyboardEvent('keydown', Object.assign({ key:key, code:code || '', bubbles:true, cancelable:true }, mods || {})); document.body.dispatchEvent(event); return event.defaultPrevented; },
      letter: function(letter, shift){ return this.key(shift ? letter.toUpperCase() : letter.toLowerCase(), 'Key' + letter.toUpperCase(), shift ? { shiftKey:true } : {}); },
      band: function(step){ return document.querySelector('#tiPitchPicker [data-step="' + step + '"]'); },
      clickBand: function(step, shift){ this.band(step).dispatchEvent(new MouseEvent('click', { bubbles:true, shiftKey:!!shift })); },
      hoverBand: function(step){ this.band(step).dispatchEvent(new MouseEvent('mouseover', { bubbles:true })); return document.getElementById('tiPitchHint').textContent; },
      text: function(){ return document.getElementById('tiScoreText').value; },
      status: function(){ return document.getElementById('tiStatus').textContent; },
      cursor: function(){ return document.getElementById('tiCursorLabel').textContent; },
      pos: function(m, c, s, str){ return document.querySelector('.ti-slot[data-m="'+m+'"][data-c="'+c+'"][data-s="'+s+'"] .ti-pos[data-str="'+str+'"]'); },
      setKey: function(value){ var select = document.getElementById('tiKeySelect'); select.value = value; select.dispatchEvent(new Event('change', { bubbles:true })); },
      shown: function(id){ var node = document.getElementById(id); return node.getClientRects().length > 0; },
      selectedMarks: function(){ return { tab: document.querySelectorAll('#tiMeasures .ti-pos.is-selected').length, staff: document.querySelectorAll('#tiMeasures .st-head.is-selected').length }; },
      dock: function(){ return document.getElementById('tiDock').getBoundingClientRect().height; }
    }; true`);
  }
  const text = () => client.evaluate('window.__tiTest.text()');
  const line = async index => (await text()).split('\n')[index];
  const clearStorage = `(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`;

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(clearStorage);
  const errorsBefore = client.consoleErrors.length;
  await loadPage(() => client.send('Page.navigate', { url: inputUrl }));
  await installHelpers();

  // 1. 모드 전환: 타브 모드가 기본이고, 오선으로 바꾸면 지판이 숨고 음 고르는 오선이 보이며 새로고침 뒤에도 유지된다.
  const tabMode = await client.evaluate(`({ tab:document.getElementById('tiModeTab').getAttribute('aria-pressed'), staff:document.getElementById('tiModeStaff').getAttribute('aria-pressed'),
    fretboard:__tiTest.shown('tiFretboard'), panel:__tiTest.shown('tiStaffPanel'), rest:__tiTest.shown('tiRestBtn') })`);
  assert.deepEqual(tabMode, { tab: 'true', staff: 'false', fretboard: true, panel: false, rest: true }, 'the tab input mode is the default');
  await client.evaluate(`document.getElementById('tiModeStaff').click(); true`);
  const staffMode = await client.evaluate(`({ tab:document.getElementById('tiModeTab').getAttribute('aria-pressed'), staff:document.getElementById('tiModeStaff').getAttribute('aria-pressed'),
    fretboard:__tiTest.shown('tiFretboard'), picker:__tiTest.shown('tiPitchPicker'),
    hidden:['tiRestBtn', 'tiClearSlotBtn', 'tiDiv1', 'tiDiv2', 'tiDiv3', 'tiDiv4', 'tiAutoAdvance'].filter(function(id){ return __tiTest.shown(id); }),
    kept:['tiPrevBtn', 'tiNextBtn', 'tiPlaySlotBtn', 'tiSoundToggle', 'tiStaffToggle', 'tiDockToggle', 'tiModeTab', 'tiModeStaff'].filter(function(id){ return !__tiTest.shown(id); }),
    saved:JSON.parse(localStorage.getItem('gs.tabInput.ui')).inputMode,
    dur:JSON.parse(localStorage.getItem('gs.tabInput.ui')).staffDur })`);
  assert.deepEqual(staffMode, { tab: 'false', staff: 'true', fretboard: false, picker: true, hidden: [], kept: [], saved: 'staff', dur: { value: 'quarter', dotted: false, triplet: false } }, 'the staff input mode hides the fretboard and the tab-only buttons and shows the pitch picker');
  assert.equal(await client.evaluate(`['eighth', 'quarter'].map(function(v){ return document.querySelector('[data-dur="' + v + '"]').getAttribute('aria-pressed'); }).join()`), 'false,true', 'a quarter note is the default length');
  await loadPage(() => client.send('Page.reload', { ignoreCache: true }));
  await installHelpers();
  assert.equal(await client.evaluate(`__tiTest.shown('tiPitchPicker') && !__tiTest.shown('tiFretboard') && document.getElementById('tiModeStaff').getAttribute('aria-pressed')`), 'true', 'the staff input mode survives a reload');

  // 2. 길이 키와 글자 키로 입력: 8분 E F, 4분 G, 2분 A. 음을 넣어도 커서는 그대로라 사이마다 →로 직접 넘긴다. 끝난 뒤 →를 누르면 2마디 첫 조각(2분음표가 쥔 4칸은 건너뜀)이다.
  const keys = [['4', 'Digit4'], ['E'], ['ArrowRight', 'ArrowRight'], ['F'], ['ArrowRight', 'ArrowRight'], ['5', 'Digit5'], ['G'], ['ArrowRight', 'ArrowRight'], ['6', 'Digit6'], ['A']];
  for (const [value, code] of keys) {
    if (code) await client.evaluate(`__tiTest.key('${value}', '${code}'); true`);
    else assert.equal(await client.evaluate(`__tiTest.letter('${value}', false)`), true, value + ' key is handled');
  }
  assert.equal(await line(0), '[-] E4@1/F4@1 G4@1 A4@1 - | ""', 'length keys and letter keys write the first measure');
  assert.ok((await client.evaluate('__tiTest.cursor()')).startsWith('1마디 · 3칸'), 'entering a note leaves the cursor on the slot it was entered in');
  assert.deepEqual(await client.evaluate('__tiTest.selectedMarks()'), { tab: 1, staff: 1 }, 'the entered note is marked in the tab and in the card staff');
  assert.equal(await client.evaluate(`document.querySelector('#tiMeasures .st-head.is-selected').dataset.str`), '1', 'the marked staff head is the entered note');
  assert.equal(await client.evaluate(`getComputedStyle(document.querySelector('#tiMeasures .st-head.is-selected')).stroke !== getComputedStyle(document.querySelector('#tiMeasures .st-head:not(.is-selected)')).stroke`), true, 'the selected note head has an accent outline');
  await client.evaluate(`__tiTest.key('ArrowRight', 'ArrowRight'); true`);
  assert.ok((await client.evaluate('__tiTest.cursor()')).startsWith('2마디 · 1칸'), 'the right arrow skips the cell the half note holds and lands on the first slot of the second measure');

  // 3. 음 고르는 오선의 가로띠: step 2(적는 G4)를 누르면 G3@3. 마우스를 올리면 이름과 위치가 보인다.
  assert.equal(await client.evaluate('__tiTest.hoverBand(2)'), 'G3 · 3번 줄 0프렛', 'hovering a picker band shows the note name and the default guitar position');
  assert.equal(await client.evaluate(`document.querySelector('#tiPitchPicker .ti-pick-ghost').getAttribute('visibility')`), 'visible', 'hovering a picker band shows a faint note head');
  await client.evaluate('__tiTest.clickBand(2, false); true');
  assert.ok((await line(1)).startsWith('[-] G3@3'), 'clicking a picker band writes the note at the cursor (' + await line(1) + ')');

  // 4. 음이 있는 조각에 Shift 없이 글자를 치면 그 조각의 화음에 더한다.
  const beforeChord = await text();
  await client.evaluate(`__tiTest.letter('E', false); true`);
  assert.ok((await line(1)).includes('+'), 'a letter on a slot that has a note adds a chord note without Shift (' + await line(1) + ')');
  assert.notEqual(await text(), beforeChord, 'the chord note changes the text');
  assert.deepEqual(await client.evaluate('__tiTest.selectedMarks()'), { tab: 1, staff: 1 }, 'the added chord note is the marked note');

  // 5. ArrowUp은 고른 음을 반음 올린다.
  const beforeUp = await line(1);
  await client.evaluate(`__tiTest.key('ArrowUp', 'ArrowUp'); true`);
  const afterUp = await line(1);
  assert.notEqual(afterUp, beforeUp, 'ArrowUp changes the selected note');
  assert.ok(afterUp.includes('F3') && !afterUp.includes('E3'), 'ArrowUp raises the added E3 to F3 (' + afterUp + ')');
  await client.evaluate(`__tiTest.key('ArrowDown', 'ArrowDown'); true`);
  assert.equal(await line(1), beforeUp, 'ArrowDown lowers it back');

  // 6. 조표 ♯ 1개: step 8(적는 F5)은 F#4. 조표 머리 그리기와 음역 밖 안내도 본다.
  await client.evaluate(`__tiTest.setKey('1'); __tiTest.key('ArrowRight', 'ArrowRight'); true`);
  assert.ok((await client.evaluate('__tiTest.cursor()')).startsWith('2마디 · 3칸'), 'the right arrow leaves the half note chord and lands on the rest after it');
  assert.equal(await client.evaluate(`document.querySelectorAll('#tiPitchPicker .st-key').length`), 1, 'the picker shows the key signature');
  assert.equal(await client.evaluate('__tiTest.hoverBand(8)'), 'F#4 · 1번 줄 2프렛', 'the hint follows the key signature');
  await client.evaluate('__tiTest.clickBand(8, false); true');
  assert.ok((await text()).includes('F#4@1'), 'a key signature sharp is written for F5 (' + await text() + ')');
  await client.evaluate(`__tiTest.setKey('-3'); true`);
  assert.equal(await client.evaluate('__tiTest.hoverBand(-7)'), '음역 밖', 'a note below the guitar range says so');
  await client.evaluate(`__tiTest.setKey('1'); true`);

  // 7. 4칸에서 32분음표는 못 적는다: 오류가 상태줄에 나오고 문서는 그대로다.
  const beforeShort = await text();
  const undoBefore = await client.evaluate(`document.getElementById('tiUndoBtn').disabled`);
  await client.evaluate(`__tiTest.key('ArrowRight', 'ArrowRight'); __tiTest.key('2', 'Digit2'); __tiTest.letter('C', false); true`);
  assert.ok((await client.evaluate('__tiTest.status()')).includes('8칸'), 'a 32nd note in four cells says to pick eight cells (' + await client.evaluate('__tiTest.status()') + ')');
  assert.equal(await text(), beforeShort, 'a rejected length leaves the text alone');
  assert.equal(await client.evaluate(`document.getElementById('tiUndoBtn').disabled`), undoBefore, 'a rejected length leaves the undo history alone');
  await client.evaluate(`__tiTest.key('6', 'Digit6'); true`);

  // 8. Delete는 커서 사건을 쉼으로 바꾸고 Ctrl+Z가 되돌린다.
  await client.evaluate(`__tiTest.pos(1, 2, 0, 1).click(); true`);
  assert.ok((await line(1)).includes('F#4@1'), 'the F# is on the third cell of the second measure');
  const beforeDelete = await text();
  await client.evaluate(`__tiTest.key('Delete', 'Delete'); true`);
  const afterDelete = await line(1);
  assert.ok(!afterDelete.includes('F#4@1') && afterDelete.split(' ').includes('r'), 'Delete turns the event into a rest (' + afterDelete + ')');
  await client.evaluate(`__tiTest.key('z', 'KeyZ', { ctrlKey:true }); true`);
  assert.equal(await text(), beforeDelete, 'Ctrl+Z undoes the delete');

  // 8b. 저음(6번 줄)만 있는 조각을 지나 →로 갔다가 ←로 돌아오면 커서 줄에 음이 없어도 그 조각의 가장 높은 음(여기서는 그 저음)이 고른 음이 된다.
  await client.evaluate(`__tiTest.pos(2, 0, 0, 1).click(); __tiTest.clickBand(-7, false); true`);
  assert.ok((await line(2)).startsWith('[-] E2@6'), 'the low E is written on the sixth string (' + await line(2) + ')');
  await client.evaluate(`__tiTest.pos(2, 2, 0, 1).click(); true`);
  assert.equal(await client.evaluate('__tiTest.selectedMarks().tab'), 0, 'an empty slot has no selected note');
  await client.evaluate(`__tiTest.key('ArrowRight', 'ArrowRight'); __tiTest.key('ArrowLeft', 'ArrowLeft'); __tiTest.key('ArrowLeft', 'ArrowLeft'); true`);
  assert.equal(await client.evaluate('__tiTest.cursor()'), '3마디 · 1칸 · 6번 줄', 'moving the cursor onto the bass slot also moves the cursor string to it');
  assert.equal(await client.evaluate(`__tiTest.pos(2, 0, 0, 6).classList.contains('is-selected')`), true, 'the bass note is the selected note after moving back onto its slot');
  await client.evaluate(`__tiTest.key('ArrowUp', 'ArrowUp'); true`);
  assert.ok((await line(2)).startsWith('[-] F2@6'), 'ArrowUp raises the bass note (' + await line(2) + ')');
  await client.evaluate(`__tiTest.key('ArrowDown', 'ArrowDown'); true`);

  // 9. 줄 후보 단추: 같은 음을 다른 줄로 옮긴다.
  await client.evaluate(`__tiTest.pos(1, 0, 0, 3).click(); true`);
  const cands = await client.evaluate(`Array.prototype.map.call(document.querySelectorAll('#tiStringCands button'), function(b){ return { str:b.dataset.str, text:b.textContent, pressed:b.getAttribute('aria-pressed') }; })`);
  assert.ok(cands.length >= 2, 'a G3 on the third string has other string candidates (' + JSON.stringify(cands) + ')');
  assert.deepEqual(cands.filter(item => item.pressed === 'true').map(item => item.str), ['3'], 'the current string is pressed');
  assert.match(cands[0].text, /^\d번 줄 \d+프렛$/, 'a candidate button reads string and fret');
  const other = cands.find(item => item.pressed !== 'true');
  await client.evaluate(`document.querySelector('#tiStringCands button[data-str="${other.str}"]').click(); true`);
  assert.ok((await line(1)).includes('G3@' + other.str) && !(await line(1)).includes('G3@3'), 'a candidate button moves the note to its string (' + await line(1) + ')');
  assert.equal(await client.evaluate(`document.querySelector('#tiStringCands button[aria-pressed="true"]').dataset.str`), other.str, 'the candidate list follows the moved note');

  // 9b. 되돌리기·다시 하기는 커서도 그 작업 직전의 자리로 돌린다. 음을 넣어도 커서는 그대로라 두 번째 음은 →로 넘긴 자리에 넣는다.
  await client.evaluate(`__tiTest.key('5', 'Digit5'); document.getElementById('tiAddMeasureBtn').click(); true`);
  const lastMeasure = (await client.evaluate(`document.querySelectorAll('#tiMeasures .ti-measure').length`)) - 1;
  await client.evaluate(`__tiTest.pos(${lastMeasure}, 0, 0, 1).click(); true`);
  const cellLabel = async () => (await client.evaluate('__tiTest.cursor()')).replace(/ · [0-9]번 줄$/, '');
  const label0 = await cellLabel();
  const emptyLine = await line(lastMeasure);
  await client.evaluate(`__tiTest.letter('G', false); true`);
  assert.equal(await cellLabel(), label0, 'entering a note leaves the cursor where it was');
  await client.evaluate(`__tiTest.key('ArrowRight', 'ArrowRight'); true`);
  const label1 = await cellLabel();
  assert.notEqual(label1, label0, 'the right arrow moves the cursor to the rest after the note');
  await client.evaluate(`__tiTest.letter('A', false); true`);
  assert.equal(await cellLabel(), label1, 'the second note leaves the cursor in place too');
  const ctrlZ = `__tiTest.key('z', 'KeyZ', { ctrlKey:true }); true`;
  await client.evaluate(ctrlZ);
  await client.evaluate(ctrlZ);
  assert.equal(await line(lastMeasure), emptyLine, 'two undos remove both notes');
  assert.equal(await cellLabel(), label0, 'two undos put the cursor back where it was before the first note');
  await client.evaluate(`__tiTest.key('y', 'KeyY', { ctrlKey:true }); true`);
  assert.equal(await cellLabel(), label1, 'redo puts the cursor where the second note was about to go');
  await client.evaluate(ctrlZ);
  await client.evaluate(`__tiTest.letter('G', false); true`);
  assert.match(await line(lastMeasure), /^\[-\] G\d@\d/, 'typing after undo starts at the undone position (' + await line(lastMeasure) + ')');
  assert.equal(await cellLabel(), label0, 'the cursor stays on the new note at the undone position');

  // 10. 높이, 오선 폭, 콘솔 오류, 스크린샷
  await client.evaluate(`__tiTest.key('5', 'Digit5'); true`);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`__tiTest.setKey('5'); window.scrollTo(0, 0); true`);
  const tablet = await client.evaluate(`({ dock:__tiTest.dock(), info:document.getElementById('tiInfoPanel').getBoundingClientRect().height,
    panel:(function(){ var p = document.getElementById('tiStaffPanel'); return { scroll:p.scrollWidth, client:p.clientWidth }; })(),
    picker:(function(){ var r = document.getElementById('tiPitchPicker').getBoundingClientRect(), p = document.getElementById('tiDock').getBoundingClientRect(); return { top:r.top - p.top, bottom:p.bottom - r.bottom, height:r.height }; })(),
    hint:getComputedStyle(document.getElementById('tiStaffHint')).display, tabHint:document.getElementById('tiTabHint').hidden })`);
  assert.ok(tablet.dock <= 230, 'the 1024x768 staff input dock is at most 230px tall (is ' + tablet.dock + ')');
  assert.ok(tablet.info <= 150, 'the 1024x768 song info panel is at most 150px tall (is ' + tablet.info + ')');
  assert.ok(tablet.panel.scroll <= tablet.panel.client, 'the picker and buttons fit the dock at 1024px even with five sharps (' + JSON.stringify(tablet.panel) + ')');
  assert.deepEqual([tablet.hint !== 'none', tablet.tabHint], [true, true], 'the staff shortcut hint replaces the tab hint at 900px and wider');
  await client.evaluate(`__tiTest.setKey('1'); true`);
  await client.evaluate(`document.getElementById('tiModeTab').click(); window.scrollTo(0, 0); true`);
  const tabDock = await client.evaluate('__tiTest.dock()');
  assert.ok(tabDock <= 210, 'the 1024x768 tab input dock stays at most 210px tall (is ' + tabDock + ')');
  await client.evaluate(`document.getElementById('tiModeStaff').click(); true`);

  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  async function shot(name, width, height, mobile) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await client.evaluate('window.scrollTo(0, 0); true');
    const image = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const target = path.join(root, 'test-artifacts', name);
    fs.writeFileSync(target, Buffer.from(image.data, 'base64'));
    const header = fs.readFileSync(target).subarray(0, 24);
    assert.equal(header.readUInt32BE(16), width, name + ' width');
    assert.equal(header.readUInt32BE(20), height, name + ' height');
    process.stdout.write('Artifact: ' + target + '\n');
    return client.evaluate('({ scroll:document.documentElement.scrollWidth, inner:window.innerWidth, dock:__tiTest.dock() })');
  }
  await client.evaluate(`(function(){ __tiTest.pos(1, 0, 0, 3).click(); __tiTest.hoverBand(5); return true; })()`);
  const desktopShot = await shot('score-input-staff-mode.png', 1280, 900, false);
  assert.ok(desktopShot.scroll <= desktopShot.inner, 'the desktop page in staff input mode does not overflow horizontally');
  const mobileShot = await shot('score-input-staff-mode-mobile.png', 375, 812, true);
  assert.ok(mobileShot.scroll <= mobileShot.inner, 'the 375px page in staff input mode does not overflow horizontally (scrollWidth ' + mobileShot.scroll + ' > ' + mobileShot.inner + ')');
  assert.ok(mobileShot.dock <= 360, 'the 375x812 staff input dock is at most 360px tall (is ' + mobileShot.dock + ')');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the staff input mode runs without console errors');

  // 11. 자동 넘김이 없고 Shift 없이 화음: 빈 새 악보(4칸), 오선 모드, 4분음표. 커서는 ←→로만 움직인다.
  const manualErrorsBefore = client.consoleErrors.length;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`document.getElementById('tiNewBtn').click(); __tiTest.key('5', 'Digit5'); true`);
  assert.equal(await text(), '[-] r r r r | ""', 'a new score is empty');
  const cellTokens = async (m, c) => ((await line(m)).split(' ')[c + 1] || '').split('+');
  const cellLabel11 = async () => client.evaluate('__tiTest.cursor()');
  // 11-1. 오선에서 C 자리(적는 C4, step -2)를 누르면 1마디 1칸에 음 1개, 커서는 그대로.
  await client.evaluate('__tiTest.clickBand(-2, false); true');
  assert.equal((await cellTokens(0, 0)).length, 1, 'clicking C writes one note in the first cell');
  assert.ok((await cellLabel11()).startsWith('1마디 · 1칸'), 'the cursor stays on the cell the note was entered in (' + await cellLabel11() + ')');
  // 11-2. Shift 없이 E 자리(step 0)를 누르면 같은 조각에 음이 2개가 되고 커서는 그대로다.
  await client.evaluate('__tiTest.clickBand(0, false); true');
  assert.equal((await cellTokens(0, 0)).length, 2, 'clicking E without Shift makes a two-note chord in the same slot (' + await line(0) + ')');
  assert.ok((await cellLabel11()).startsWith('1마디 · 1칸'), 'the chord keeps the cursor in place');
  // 11-3. 같은 E 자리를 다시 누르면 그 음이 빠져 음이 1개가 된다.
  await client.evaluate('__tiTest.clickBand(0, false); true');
  assert.equal((await cellTokens(0, 0)).length, 1, 'clicking the same E again removes it from the chord (' + await line(0) + ')');
  assert.ok((await line(0)).split(' ')[1].startsWith('C3@'), 'the remaining note is the C');
  // 11-4. →로 2칸(넣은 길이 뒤의 쉼)에 가서 G 자리(step 2)를 누르면 2칸에 음이 들어가고 1칸의 C는 그대로다.
  await client.evaluate(`__tiTest.key('ArrowRight', 'ArrowRight'); true`);
  assert.ok((await cellLabel11()).startsWith('1마디 · 2칸'), 'the right arrow goes to the rest the quarter note left behind (' + await cellLabel11() + ')');
  await client.evaluate('__tiTest.clickBand(2, false); true');
  assert.ok((await line(0)).split(' ')[1].startsWith('C3@') && (await cellTokens(0, 0)).length === 1, 'the C in the first cell is untouched');
  assert.ok((await line(0)).split(' ')[2].startsWith('G3@'), 'the G is written in the second cell (' + await line(0) + ')');
  assert.ok((await cellLabel11()).startsWith('1마디 · 2칸'), 'the cursor stays on the second cell');
  // 11-5. 같은 자리에서 Shift 없이 A, C 키를 치면 G·A·C 화음이 된다.
  await client.evaluate(`__tiTest.letter('A', false); __tiTest.letter('C', false); true`);
  assert.equal((await cellTokens(0, 1)).length, 3, 'A and C keys without Shift join the G as a three-note chord (' + await line(0) + ')');
  assert.ok((await cellLabel11()).startsWith('1마디 · 2칸'), 'the keys leave the cursor in place');
  // 11-6. 2분음표: →로 3칸에 가서 음을 넣고 →를 누르면 2분음표가 쥔 4칸을 건너뛰어 다음 마디 1칸이다. ←는 3칸으로 돌아온다.
  await client.evaluate(`__tiTest.key('ArrowRight', 'ArrowRight'); __tiTest.key('6', 'Digit6'); true`);
  assert.ok((await cellLabel11()).startsWith('1마디 · 3칸'), 'the right arrow reaches the third cell (' + await cellLabel11() + ')');
  await client.evaluate('__tiTest.clickBand(0, false); true');
  assert.ok((await line(0)).split(' ')[3].startsWith('E3@') && (await line(0)).split(' ')[4] === '-', 'a half note holds the third and fourth cells (' + await line(0) + ')');
  assert.ok((await cellLabel11()).startsWith('1마디 · 3칸'), 'the half note leaves the cursor on the third cell');
  await client.evaluate(`__tiTest.key('ArrowRight', 'ArrowRight'); true`);
  assert.ok((await cellLabel11()).startsWith('2마디 · 1칸'), 'the right arrow skips the held fourth cell and goes to the next measure (' + await cellLabel11() + ')');
  await client.evaluate(`__tiTest.key('ArrowLeft', 'ArrowLeft'); true`);
  assert.ok((await cellLabel11()).startsWith('1마디 · 3칸'), 'the left arrow comes back to the third cell (' + await cellLabel11() + ')');
  // 11-7. 0 키는 커서 자리를 쉼으로 바꾸고 커서는 그대로다.
  await client.evaluate(`__tiTest.key('0', 'Digit0'); true`);
  assert.equal((await line(0)).split(' ')[3], 'r', 'the 0 key makes the cursor slot a rest (' + await line(0) + ')');
  assert.ok((await cellLabel11()).startsWith('1마디 · 3칸'), 'the rest leaves the cursor in place');
  // 11-8. 높이, 가로 넘침, 콘솔 오류, 스크린샷
  await client.evaluate(`__tiTest.key('ArrowLeft', 'ArrowLeft'); __tiTest.key('5', 'Digit5'); true`);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await client.evaluate('window.scrollTo(0, 0); true');
  const manualDock = await client.evaluate('__tiTest.dock()');
  assert.ok(manualDock <= 230, 'the 1024x768 staff input dock stays at most 230px tall with the new hint (is ' + manualDock + ')');
  const manual1024 = await client.evaluate(`(function(){ return { scroll:document.documentElement.scrollWidth, inner:window.innerWidth }; })()`);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  const manualPhone = await client.evaluate(`({ scroll:document.documentElement.scrollWidth, inner:window.innerWidth })`);
  assert.ok(manualPhone.scroll <= manualPhone.inner, 'the 375px staff input page does not overflow horizontally (scrollWidth ' + manualPhone.scroll + ' > ' + manualPhone.inner + ')');
  assert.ok(manual1024.scroll <= manual1024.inner, 'the 1024px staff input page does not overflow horizontally');
  await shot('score-input-staff-manual.png', 1280, 900, false);
  assert.deepEqual(client.consoleErrors.slice(manualErrorsBefore), [], 'the manual advance and chord steps run without console errors');

  // 11-9. 커서를 옮겨 lastEntry가 지워진 뒤 음 있는 조각에서 글자를 치면 기준 음은 그 조각의 음이다(앞 사건의 음이 아니다).
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`document.getElementById('tiNewBtn').click(); __tiTest.key('5', 'Digit5'); __tiTest.clickBand(-7, false); __tiTest.key('ArrowRight', 'ArrowRight'); __tiTest.clickBand(7, false); __tiTest.key('ArrowLeft', 'ArrowLeft'); __tiTest.key('ArrowRight', 'ArrowRight'); true`);
  assert.ok((await line(0)).split(' ')[1].startsWith('E2@6'), 'the low E2 is in the first cell (' + await line(0) + ')');
  assert.ok((await line(0)).split(' ')[2].startsWith('E4@1'), 'the E4 is in the second cell (' + await line(0) + ')');
  assert.ok((await client.evaluate('__tiTest.cursor()')).startsWith('1마디 · 2칸'), 'the cursor came back to the second cell');
  assert.equal(await client.evaluate(`__tiTest.letter('G', false)`), true, 'the G key is handled');
  const chordCell = (await line(0)).split(' ')[2];
  assert.ok(chordCell.includes('G4@') && !chordCell.includes('G2@'), 'a letter on a slot with a note takes that slot as the reference note: G4 joins the E4, not G2 (' + chordCell + ')');

  // 12. 길이를 고르면 커서 자리의 음·쉼에 바로 반영된다(길이 바꾸기 단추는 없다). 빈 새 악보, 4칸, 오선 모드, 4분음표.
  const durErrorsBefore = client.consoleErrors.length;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`document.getElementById('tiNewBtn').click(); __tiTest.key('5', 'Digit5'); true`);
  assert.equal(await text(), '[-] r r r r | ""', 'a new score is empty for the length steps');
  const shape = async () => (await line(0)).split(' ').slice(1, 5).map(token => (token === '-' || token === 'r') ? token : 'N').join(' ');
  const cursor12 = () => client.evaluate('__tiTest.cursor()');
  // 12-1. C4 자리를 누른 뒤 6(2분음표)를 고르면 그 음이 2분음표가 된다.
  await client.evaluate('__tiTest.clickBand(-2, false); true');
  assert.equal(await shape(), 'N r r r', 'a quarter note is written first (' + await line(0) + ')');
  await client.evaluate(`__tiTest.key('6', 'Digit6'); true`);
  assert.equal(await shape(), 'N - r r', 'picking the half note length lengthens the note under the cursor at once (' + await line(0) + ')');
  assert.ok((await cursor12()).startsWith('1마디 · 1칸'), 'the cursor stays on the note when its length changes (' + await cursor12() + ')');
  // 12-2. 점은 점2분음표로, 한 번 더 누르면 2분음표로 돌아온다.
  await client.evaluate(`__tiTest.key('.', 'Period'); true`);
  assert.equal(await shape(), 'N - - r', 'the dot key makes it a dotted half note (' + await line(0) + ')');
  await client.evaluate(`__tiTest.key('.', 'Period'); true`);
  assert.equal(await shape(), 'N - r r', 'the dot key again returns it to a half note (' + await line(0) + ')');
  // 12-3. 이미 같은 길이를 다시 골라도 문서와 되돌리기 기록은 그대로다.
  const beforeSame = await text();
  await client.evaluate(`__tiTest.key('6', 'Digit6'); true`);
  assert.equal(await text(), beforeSame, 'picking the length the note already has leaves the text alone');
  await client.evaluate(`__tiTest.key('z', 'KeyZ', { ctrlKey:true }); true`);
  assert.equal(await shape(), 'N - - r', 'one undo goes back to the dotted half note: picking the same length added no undo step (' + await line(0) + ')');
  // 12-4. 길이 단추도 같다.
  await client.evaluate(`document.querySelector('[data-dur="quarter"]').click(); true`);
  assert.equal(await shape(), 'N r r r', 'the quarter button shortens the note at once (' + await line(0) + ')');
  // 12-5. 빈 조각에서는 고르기만 한다. 고른 길이로 다음 음이 들어간다.
  await client.evaluate(`document.getElementById('tiNewBtn').click(); __tiTest.key('6', 'Digit6'); true`);
  assert.equal(await text(), '[-] r r r r | ""', 'picking a length on an empty slot leaves the text alone');
  assert.equal(await client.evaluate(`document.querySelector('[data-dur="half"]').getAttribute('aria-pressed')`), 'true', 'the half note button is pressed');
  await client.evaluate('__tiTest.clickBand(-2, false); true');
  assert.equal(await shape(), 'N - r r', 'the next note is written with the picked length (' + await line(0) + ')');
  // 12-6. 이 칸 수에서 적을 수 없는 길이는 오류만 내고 문서는 그대로다.
  const beforeShort12 = await text();
  await client.evaluate(`__tiTest.key('2', 'Digit2'); true`);
  assert.ok((await client.evaluate('__tiTest.status()')).includes('적을 수 없습니다'), 'a length the cell count cannot write shows an error (' + await client.evaluate('__tiTest.status()') + ')');
  assert.equal(await text(), beforeShort12, 'the rejected length leaves the text alone');
  await client.evaluate(`__tiTest.key('5', 'Digit5'); true`);
  // 12-7. 길이 바꾸기 단추는 없고, 높이와 가로 넘침과 콘솔 오류도 본다.
  assert.equal(await client.evaluate(`document.getElementById('tiDurChangeBtn')`), null, 'the length change button is gone');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await client.evaluate('window.scrollTo(0, 0); true');
  const durDock = await client.evaluate('__tiTest.dock()');
  assert.ok(durDock <= 230, 'the 1024x768 staff input dock stays at most 230px tall without the length change button (is ' + durDock + ')');
  const durShot = await shot('score-input-staff-dur.png', 1024, 768, false);
  assert.ok(durShot.scroll <= durShot.inner, 'the 1024px staff input page does not overflow horizontally');
  assert.deepEqual(client.consoleErrors.slice(durErrorsBefore), [], 'the length steps run without console errors');

  await client.send('Emulation.clearDeviceMetricsOverride');
  await client.evaluate(clearStorage);
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: staff input mode switch, length and letter keys, picker click, chord, semitone, key signature, length error, delete, string candidates, heights, screenshots, manual cursor advance, Shift-free chords, and immediate length change passed\n');
}

// 악보 입력 화면의 텍스트로 입력 모드. 규칙은 Docs/tab-input.md 의 텍스트로 입력 절.
// 입력은 값 설정 뒤 input 이벤트, 글자 커서는 selectionStart 설정 뒤 keyup/click 으로 실제 사용자 경로를 탄다.
// 0.3초 디바운스는 벽시계로 재지 않고 결과가 나타날 때까지 waitForCondition 으로 기다린다.
async function testTextInputMode(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const inputHtml = fs.readFileSync(path.join(root, 'score-input.html'), 'utf8');
  ['tiModeText', 'tiTextPanel', 'tiTextEditor', 'tiTextError', 'tiTextRestoreBtn'
  ].forEach(id => assert.match(inputHtml, new RegExp('id="' + id + '"'), 'score-input.html includes #' + id));
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  const inputReady = 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1';
  async function loadPage(action) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await action();
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, inputReady, 8000);
  }
  async function installHelpers() {
    await client.evaluate(`window.__tx = {
      shown: function(id){ return document.getElementById(id).getClientRects().length > 0; },
      editor: function(){ return document.getElementById('tiTextEditor'); },
      value: function(){ return document.getElementById('tiTextEditor').value; },
      result: function(){ return document.getElementById('tiScoreText').value; },
      error: function(){ return document.getElementById('tiTextError').textContent; },
      cursor: function(){ return document.getElementById('tiCursorLabel').textContent; },
      cards: function(){ return document.querySelectorAll('#tiMeasures .ti-measure').length; },
      pos: function(m, c, s, str){ return document.querySelector('.ti-slot[data-m="'+m+'"][data-c="'+c+'"][data-s="'+s+'"] .ti-pos[data-str="'+str+'"]'); },
      type: function(value){ var e = this.editor(); e.focus(); e.value = value; e.dispatchEvent(new Event('input', { bubbles:true })); return true; },
      caret: function(offset, eventName){ var e = this.editor(); e.focus(); e.selectionStart = offset; e.selectionEnd = offset; e.dispatchEvent(new Event(eventName, { bubbles:true })); return true; },
      dock: function(){ return document.getElementById('tiDock').getBoundingClientRect().height; },
      draft: function(){ return JSON.parse(localStorage.getItem('gs.tabInput.text')); }
    }; true`);
  }
  const clearStorage = `(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`;
  const reflected = '__tx.error() === "미리보기에 반영됨"';

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(clearStorage);
  const errorsBefore = client.consoleErrors.length;
  await loadPage(() => client.send('Page.navigate', { url: inputUrl }));
  await installHelpers();

  // 1. 텍스트 모드: 편집기가 지금 문서 텍스트이고 지판·음 고르는 오선·운지 열이 숨으며 새로고침 뒤에도 유지된다.
  assert.equal(await client.evaluate('__tx.shown("tiTextPanel")'), false, 'the text panel is hidden in the default tab mode');
  await client.evaluate(`document.getElementById('tiModeText').click(); true`);
  const entered = await client.evaluate(`({ pressed:['tiModeTab', 'tiModeStaff', 'tiModeText'].map(function(id){ return document.getElementById(id).getAttribute('aria-pressed'); }).join(),
    panel:__tx.shown('tiTextPanel'), editor:__tx.shown('tiTextEditor'), value:__tx.value(), result:__tx.result(),
    hidden:['tiFretboard', 'tiStaffPanel', 'tiPitchPicker', 'tiAttrs', 'tiAttrsToggle', 'tiRestBtn', 'tiClearSlotBtn', 'tiDiv1', 'tiAutoAdvance', 'tiPrevBtn', 'tiNextBtn', 'tiTabHint', 'tiStaffHint'].filter(function(id){ return __tx.shown(id); }),
    kept:['tiPlaySlotBtn', 'tiSoundToggle', 'tiStaffToggle', 'tiDockToggle', 'tiModeTab', 'tiModeStaff', 'tiModeText', 'tiCursorLabel'].filter(function(id){ return !__tx.shown(id); }),
    restore:__tx.shown('tiTextRestoreBtn'), error:__tx.error(), saved:JSON.parse(localStorage.getItem('gs.tabInput.ui')).inputMode })`);
  assert.deepEqual([entered.pressed, entered.panel, entered.editor, entered.restore, entered.error, entered.saved], ['false,false,true', true, true, false, '미리보기에 반영됨', 'text'], 'the text mode shows the editor and the reflected line');
  assert.equal(entered.value, entered.result, 'the editor starts with the current document text');
  assert.deepEqual(entered.hidden, [], 'the text mode hides the fretboard, the pitch picker, the fingering column and the tab-only buttons');
  assert.deepEqual(entered.kept, [], 'the text mode keeps the shared buttons');
  await loadPage(() => client.send('Page.reload', { ignoreCache: true }));
  await installHelpers();
  assert.deepEqual(await client.evaluate(`[document.getElementById('tiModeText').getAttribute('aria-pressed'), __tx.shown('tiTextEditor'), __tx.shown('tiFretboard'), __tx.value() === __tx.result()]`), ['true', true, false, true], 'the text mode survives a reload');

  // 2. 끝에 한 마디를 더 치면 카드가 늘고, 결과는 앱 표준 꼴이지만 편집기 글자는 친 그대로다.
  const base = await client.evaluate('__tx.value()');
  await client.evaluate(`__tx.type(${JSON.stringify(base + '\n[-] G4 - - - | ""')})`);
  await waitForCondition(client, '__tx.cards() === 2 && ' + reflected, 5000);
  assert.equal(await client.evaluate(`__tx.pos(1, 0, 0, 1).textContent.trim()`), '3', 'the typed G4 shows as fret 3 on the first string of the new last card');
  assert.ok((await client.evaluate('__tx.result()')).includes('G4@1'), 'the result text uses the app standard form (G4@1)');
  const typed = await client.evaluate('__tx.value()');
  assert.ok(typed.includes('G4 - - -') && !typed.includes('G4@1'), 'the editor keeps the typed characters as they are (' + typed + ')');
  const draft2 = await client.evaluate('__tx.draft()');
  assert.deepEqual([draft2.raw, draft2.valid, typeof draft2.baseText], [typed, true, 'string'], 'the typed text is saved as a valid draft');
  assert.equal(await client.evaluate(`document.getElementById('tiUndoBtn').disabled`), false, 'the first reflect records an undo step');

  // 3. 틀린 글: 오류 줄에 마디가 든 첫 오류가 나오고 카드는 그대로다.
  const lines = typed.split('\n');
  lines[1] = '[-] Q9 - - - | ""';
  const wrong = lines.join('\n');
  await client.evaluate(`__tx.type(${JSON.stringify(wrong)})`);
  await waitForCondition(client, '__tx.error().indexOf("마디") >= 0', 5000);
  assert.equal(await client.evaluate(`document.getElementById('tiTextError').classList.contains('is-error')`), true, 'the error line uses the warning style');
  assert.deepEqual(await client.evaluate(`[__tx.cards(), __tx.pos(1, 0, 0, 1).textContent.trim(), __tx.result().includes('G4@1')]`), [2, '3', true], 'a wrong line leaves the cards on the last good document');
  assert.equal(await client.evaluate('__tx.draft().valid'), false, 'the wrong text is saved as an invalid draft');

  // 4. 오류 상태로 모드를 오가도, 새로고침해도 친 글자가 그대로 돌아온다.
  await client.evaluate(`document.getElementById('tiModeTab').click(); true`);
  assert.equal(await client.evaluate('__tx.shown("tiTextPanel")'), false, 'leaving the text mode hides the editor');
  await client.evaluate(`document.getElementById('tiModeText').click(); true`);
  assert.equal(await client.evaluate('__tx.value()'), wrong, 'coming back shows the characters typed before (Q9 kept)');
  assert.ok((await client.evaluate('__tx.error()')).includes('마디'), 'coming back shows the error again');
  assert.equal(await client.evaluate('__tx.shown("tiTextRestoreBtn")'), false, 'the restore button stays hidden while the draft still matches the document');
  await loadPage(() => client.send('Page.reload', { ignoreCache: true }));
  await installHelpers();
  assert.equal(await client.evaluate('__tx.value()'), wrong, 'a reload keeps the wrong characters too');
  assert.ok((await client.evaluate('__tx.error()')).includes('마디'), 'a reload shows the error again');

  // 5. 오류 상태에서 타브로 문서를 바꾸면 돌아온 편집기는 지금 문서 텍스트이고, 되살리기 단추로 전에 치던 글이 돌아온다.
  await client.evaluate(`document.getElementById('tiModeTab').click(); true`);
  await client.evaluate(`__tx.pos(0, 1, 0, 2).click(); document.querySelector('.ti-fret[data-str="2"][data-fret="1"]').click(); true`);
  const tabEdited = await client.evaluate('__tx.result()');
  assert.ok(tabEdited.split('\n')[0].includes('C4@2'), 'a tab edit changed the first measure (' + tabEdited + ')');
  await client.evaluate(`document.getElementById('tiModeText').click(); true`);
  assert.equal(await client.evaluate('__tx.value()'), tabEdited, 'the editor shows the current document text after the document changed in another mode');
  assert.ok(!(await client.evaluate('__tx.value()')).includes('Q9'), 'the wrong characters are not shown after the document changed');
  assert.equal(await client.evaluate('__tx.shown("tiTextRestoreBtn")'), true, 'the restore button appears');
  await client.evaluate(`document.getElementById('tiTextRestoreBtn').click(); true`);
  assert.ok((await client.evaluate('__tx.value()')).includes('Q9'), 'the restore button brings the earlier characters back');
  await waitForCondition(client, '__tx.error().indexOf("마디") >= 0', 5000);
  assert.equal(await client.evaluate('__tx.shown("tiTextRestoreBtn")'), false, 'the restore button hides after use');

  // 6. 글자 커서가 있는 줄이 문서 커서 마디가 된다(빈 줄은 세지 않는다).
  await client.evaluate(`__tx.caret(0, 'keyup')`);
  assert.ok((await client.evaluate('__tx.cursor()')).startsWith('1마디'), 'the caret on the first line puts the cursor on measure 1 (' + await client.evaluate('__tx.cursor()') + ')');
  await client.evaluate(`__tx.caret(__tx.value().indexOf('\\n') + 3, 'click')`);
  assert.ok((await client.evaluate('__tx.cursor()')).startsWith('2마디'), 'the caret on the second line puts the cursor on measure 2 (' + await client.evaluate('__tx.cursor()') + ')');
  await client.evaluate(`__tx.caret(__tx.value().length, 'keyup')`);
  assert.ok((await client.evaluate('__tx.cursor()')).startsWith('2마디'), 'the caret at the end of the last line keeps measure 2');

  // 6b. 텍스트 모드에서 카드는 미리보기다: 코드·메모 칸은 읽기 전용, 오른쪽 클릭 지우기·선택 막대·마디 추가는 막히고, 카드 클릭은 글자 커서를 그 마디 줄로 보낸다.
  const locked = await client.evaluate(`({ inputs:Array.prototype.map.call(document.querySelectorAll('#tiMeasures .ti-chord, #tiMeasures .ti-memo'), function(i){ return [i.readOnly, i.title]; }),
    add:__tx.shown('tiAddMeasureBtn') })`);
  assert.ok(locked.inputs.length >= 4 && locked.inputs.every(item => item[0] === true && item[1] === '텍스트 모드에서는 아래 편집기에서 고치세요'), 'the card chord and memo inputs are read-only with the editor hint in the text mode');
  assert.equal(locked.add, false, 'the add-measure button is hidden in the text mode');
  const beforeErase = await client.evaluate('__tx.result()');
  await client.evaluate(`__tx.pos(0, 1, 0, 2).dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true })); true`);
  assert.equal(await client.evaluate('__tx.result()'), beforeErase, 'a right click on a card tab position does not erase the note in the text mode');
  assert.ok(beforeErase.split('\n')[0].includes('C4@2'), 'the note the right click aimed at exists');
  await client.evaluate(`__tx.pos(1, 0, 0, 1).click(); true`);
  assert.equal(await client.evaluate('__tx.editor().selectionStart'), (await client.evaluate('__tx.value()')).indexOf('\n') + 1, 'clicking a card puts the editor caret at the start of that measure line');
  assert.ok((await client.evaluate('__tx.cursor()')).startsWith('2마디'), 'the card click moves the document cursor');
  await client.evaluate(`document.querySelector('#tiMeasures .ti-measure[data-m="0"] .ti-measure-num').click(); true`);
  assert.deepEqual(await client.evaluate(`[__tx.shown('tiSelectionBar'), __tx.editor().selectionStart, document.querySelectorAll('#tiMeasures .ti-measure.is-selected').length]`), [false, 0, 0], 'a measure number click opens no selection bar and sends the caret to that line');
  await client.evaluate(`document.getElementById('tiModeTab').click(); true`);
  assert.deepEqual(await client.evaluate(`({ inputs:Array.prototype.map.call(document.querySelectorAll('#tiMeasures .ti-chord, #tiMeasures .ti-memo'), function(i){ return [i.readOnly, i.hasAttribute('title')]; }), add:__tx.shown('tiAddMeasureBtn') })`).then(r => [r.inputs.every(item => item[0] === false && item[1] === false), r.add]), [true, true], 'the tab mode unlocks the card inputs and brings the add-measure button back');
  await client.evaluate(`document.getElementById('tiModeText').click(); true`);

  // 7. 맞는 글로 고친 흐름 전체(여러 번 반영)가 되돌리기 한 번으로 돌아가고 편집기는 문서 텍스트로 다시 채워진다.
  const beforeFlow = await client.evaluate('__tx.result()');
  const fixed = wrong.split('\n');
  fixed[1] = '[-] A4 - - - | ""';
  await client.evaluate(`__tx.type(${JSON.stringify(fixed.join('\n'))})`);
  await waitForCondition(client, reflected + ' && __tx.result().includes("A4@1")', 5000);
  fixed[1] = '[-] B4 - - - | ""';
  await client.evaluate(`__tx.type(${JSON.stringify(fixed.join('\n'))})`);
  await waitForCondition(client, reflected + ' && __tx.result().includes("B4@1")', 5000);
  assert.ok(!(await client.evaluate('__tx.result()')).includes('A4@1'), 'the second reflect replaced the first one');
  await client.evaluate(`document.getElementById('tiUndoBtn').click(); true`);
  assert.equal(await client.evaluate('__tx.result()'), beforeFlow, 'one undo returns the whole text-edited flow');
  assert.equal(await client.evaluate('__tx.value()'), beforeFlow, 'the editor is refilled with the document text after the undo');
  assert.equal(await client.evaluate(`document.getElementById('tiRedoBtn').disabled`), false, 'the undone flow can be redone');
  await client.evaluate(`document.getElementById('tiRedoBtn').click(); true`);
  assert.ok((await client.evaluate('__tx.value()')).includes('B4@1'), 'redo brings the flow back and refills the editor');

  // 8. 높이, 가로 넘침, 콘솔 오류, 스크린샷
  await client.evaluate(`__tx.type(${JSON.stringify(wrong)})`);
  await waitForCondition(client, '__tx.error().indexOf("마디") >= 0', 5000);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await client.evaluate('window.scrollTo(0, 0); true');
  const tablet = await client.evaluate(`({ dock:__tx.dock(), editor:__tx.editor().getBoundingClientRect().width, panel:document.getElementById('tiDock').getBoundingClientRect().width,
    rows:document.getElementById('tiDock').querySelector('.ti-dock-row').getBoundingClientRect().height, hint:__tx.shown('tiTextHint') })`);
  assert.ok(tablet.dock <= 230, 'the 1024x768 text input dock is at most 230px tall (is ' + tablet.dock + ')');
  assert.ok(tablet.editor >= tablet.panel - 60, 'the editor takes almost the whole dock width (' + tablet.editor + ' of ' + tablet.panel + ')');
  assert.equal(tablet.hint, true, 'the hint line shows at 900px and wider');
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  const image = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(root, 'test-artifacts', 'score-input-text-mode.png');
  fs.writeFileSync(target, Buffer.from(image.data, 'base64'));
  const header = fs.readFileSync(target).subarray(0, 24);
  assert.equal(header.readUInt32BE(16), 1024, 'text mode screenshot width');
  assert.equal(header.readUInt32BE(20), 768, 'text mode screenshot height');
  process.stdout.write('Artifact: ' + target + '\n');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await client.evaluate('window.scrollTo(0, 0); true');
  const phone = await client.evaluate('({ scroll:document.documentElement.scrollWidth, inner:window.innerWidth, hint:__tx.shown("tiTextHint"), dock:__tx.dock() })');
  assert.ok(phone.scroll <= phone.inner, 'the 375px page in text input mode does not overflow horizontally (scrollWidth ' + phone.scroll + ' > ' + phone.inner + ')');
  assert.equal(phone.hint, false, 'the hint line is hidden below 900px');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the text input mode runs without console errors');

  await client.send('Emulation.clearDeviceMetricsOverride');
  await client.evaluate(clearStorage);
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: text input mode switch, debounced reflect with typed characters kept, error line, draft kept across modes and reload, restore button, caret to cursor, one-step undo, heights, and screenshot passed\n');
}

// 연습 화면의 오선 보기(타브·둘 다·오선·카드). 규칙은 Docs/staff-notation.md 의 연습 화면 절.
async function testPracticeStaffView(client) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const errorsBefore = client.consoleErrors.length;
  const READY = 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null';
  async function reload(){
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.reload', { ignoreCache: true });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, READY, 8000);
  }
  const allLayersDrawn = '(function(){ var cards = document.querySelectorAll("#measuresGrid .measure-card"); return cards.length > 0 && cards.length === document.querySelectorAll("#measuresGrid .tab-staff-layer svg").length; })()';

  // (1) 기본은 타브이고 오선 층이 없다
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`(function(){ var state = JSON.parse(localStorage.getItem('gs.state') || '{}'); delete state.scoreView; localStorage.setItem('gs.state', JSON.stringify(state)); return true; })()`);
  await reload();
  const initial = await client.evaluate(`({
    view: appState.scoreView,
    selectValue: document.getElementById('scoreViewSelect').value,
    labels: Array.prototype.map.call(document.querySelectorAll('#scoreViewSelect option'), function(option){ return option.value + ':' + option.textContent.trim(); }),
    svgs: document.querySelectorAll('#measuresGrid .tab-staff-layer svg').length,
    staffCards: document.querySelectorAll('#measuresGrid .measure-card.staff-on').length,
    cards: document.querySelectorAll('#measuresGrid .measure-card').length
  })`);
  assert.equal(initial.view, 'tab', 'the default score view is the TAB view');
  assert.deepEqual(initial.labels, ['tab:타브', 'both:둘 다', 'staff:오선', 'card:카드'], 'four view options in order');
  assert.equal(initial.selectValue, 'tab', 'the view select starts on the TAB view');
  assert.equal(initial.svgs, 0, 'the TAB view draws no staff layer');
  assert.equal(initial.staffCards, 0, 'no card is staff-on in the TAB view');
  assert.ok(initial.cards > 1, 'the default song has several cards');

  // (2) 둘 다: 모든 카드에 오선 층, 첫 카드 왼쪽 열에 음자리표와 박자표, 둘째 카드에는 음자리표만
  await client.evaluate(`${pageSetScoreView("'both'")}; true`);
  await waitForCondition(client, allLayersDrawn, 5000);
  const both = await client.evaluate(`(function(){
    var cards = document.querySelectorAll('#measuresGrid .measure-card');
    function count(card, selector){ return card.querySelectorAll('.tab-stave-side ' + selector).length; }
    var layout = GuitarStaffLayout.layoutScore(serializeScoreMeasures(curSong.measures, '\\n'), curSong.beats, 0);
    var expected = 0;
    layout.measures.forEach(function(measure){ measure.items.forEach(function(item){ if (item.type === 'chord') expected += item.notes.length; }); });
    return {
      view: appState.scoreView,
      selected: document.getElementById('scoreViewSelect').value,
      firstClef: count(cards[0], '.st-clef'), firstTime: count(cards[0], '.st-time'),
      secondClef: count(cards[1], '.st-clef'), secondTime: count(cards[1], '.st-time'),
      heads: document.querySelectorAll('#measuresGrid .tab-staff-layer .st-head').length,
      expectedHeads: expected,
      everyCardStaffOn: cards.length === document.querySelectorAll('#measuresGrid .measure-card.staff-on').length,
      anyTabOff: document.querySelectorAll('#measuresGrid .measure-card.tab-off').length,
      gridVisible: document.querySelector('#measuresGrid .tab-cell-grid').getClientRects().length > 0
    };
  })()`);
  assert.equal(both.view, 'both');
  assert.equal(both.selected, 'both', 'the view select shows the both view');
  assert.deepEqual([both.firstClef, both.firstTime, both.secondClef, both.secondTime], [1, 1, 1, 0], 'the first card shows clef and time, later cards only the clef');
  assert.equal(both.heads, both.expectedHeads, 'staff note heads match the layout count');
  assert.ok(both.heads > 0, 'the default song draws note heads');
  assert.equal(both.everyCardStaffOn, true, 'every card is staff-on');
  assert.equal(both.anyTabOff, 0, 'the both view keeps the TAB');
  assert.equal(both.gridVisible, true, 'the both view keeps the TAB grid visible');

  // (3) 나눈 칸이 있는 곡: 오선 머리와 같은 조각의 타브 프렛 알약이 가로로 2px 안에서 맞는다
  await client.evaluate(`changeSongById('builtin-lv6-romance-full'); true`);
  await waitForCondition(client, allLayersDrawn, 5000);
  const alignment = await client.evaluate(`(function(){
    var layout = GuitarStaffLayout.layoutScore(serializeScoreMeasures(curSong.measures, '\\n'), curSong.beats, 0);
    var mIdx = -1;
    curSong.measures.forEach(function(measure, index){
      if (mIdx >= 0) return;
      var divided = measure.beats.filter(function(beat){ return beat.isSubdivided && beat.subNotes && beat.subNotes.length > 1; }).length;
      if (divided >= 2) mIdx = index;
    });
    var card = document.querySelector('#measuresGrid .measure-card[data-m="' + mIdx + '"]');
    var result = { measure: mIdx, checked: 0, divisions: {}, worst: 0, misses: [] };
    layout.measures[mIdx].items.forEach(function(item){
      if (item.type !== 'chord' || item.tieFromPrev) return;
      var group = card.querySelector('.tab-staff-layer .st-chord[data-cell="' + item.cell + '"][data-unit="' + item.unit + '"]');
      var cell = card.querySelector('.beat-cell[data-b="' + item.cell + '"]');
      var beat = curSong.measures[mIdx].beats[item.cell];
      var d = beat.isSubdivided && beat.subNotes ? beat.subNotes.length : 1;
      result.divisions[d] = (result.divisions[d] || 0) + 1;
      var headXs = Array.prototype.map.call(group.querySelectorAll('.st-head'), function(head){ var r = head.getBoundingClientRect(); return r.left + r.width / 2; });
      var pillXs = Array.prototype.map.call(cell.querySelectorAll('.tab-fret-pill'), function(pill){ var r = pill.getBoundingClientRect(); return r.left + r.width / 2; });
      var best = Infinity;
      headXs.forEach(function(hx){ pillXs.forEach(function(px){ best = Math.min(best, Math.abs(hx - px)); }); });
      result.checked++;
      result.worst = Math.max(result.worst, best);
      if (!(best <= 2)) result.misses.push({ cell: item.cell, unit: item.unit, best: best });
    });
    return result;
  })()`);
  assert.ok(alignment.measure >= 0, 'the song has a measure with divided cells');
  assert.ok(alignment.checked >= 4, 'several note starts are compared (' + JSON.stringify(alignment) + ')');
  assert.ok(Object.keys(alignment.divisions).some(key => Number(key) > 1), 'the compared measure includes divided cells (' + JSON.stringify(alignment.divisions) + ')');
  assert.deepEqual(alignment.misses, [], 'staff heads sit within 2px of the TAB fret of the same piece (worst ' + alignment.worst + ')');

  // (4) 오선 자리를 누르면 그 박으로 커서가 가고, 재생 중 활성 박 셀이 오선 높이까지 덮는다
  const clicked = await client.evaluate(`(function(){
    var cell = document.querySelector('#measuresGrid .beat-cell[data-m="1"][data-b="1"]');
    cell.scrollIntoView({ block: 'center', inline: 'nearest' });
    var layer = cell.closest('.measure-card').querySelector('.tab-staff-layer').getBoundingClientRect();
    var rect = cell.getBoundingClientRect();
    var x = rect.left + rect.width / 2, y = layer.top + 20;
    var hit = document.elementFromPoint(x, y);
    var target = hit && hit.closest('.beat-cell');
    var inStaff = y < layer.bottom && y >= layer.top;
    if (hit) hit.click();
    return { inStaff: inStaff, sameCell: target === cell, measure: curMeasureIdx, beat: curBeatIdx, activeIsCell: cell.classList.contains('active-beat') };
  })()`);
  assert.deepEqual(clicked, { inStaff: true, sameCell: true, measure: 1, beat: 1, activeIsCell: true }, 'a click on the staff area moves the cursor to that beat');
  const playing = await client.evaluate(`(async function(){
    appState.clickMode = 'off';
    document.getElementById('compactPlayBtn').click();
    var started = Date.now();
    while (Date.now() - started < 4000 && !document.querySelector('#measuresGrid .beat-cell.active-beat')) await new Promise(function(resolve){ setTimeout(resolve, 30); });
    var cell = document.querySelector('#measuresGrid .beat-cell.active-beat');
    var layer = cell && cell.closest('.measure-card').querySelector('.tab-staff-layer');
    var result = cell && layer ? {
      playing: isPlaying, cellTop: cell.getBoundingClientRect().top, layerTop: layer.getBoundingClientRect().top,
      cellBottom: cell.getBoundingClientRect().bottom, layerBottom: layer.getBoundingClientRect().bottom,
      background: getComputedStyle(cell).backgroundImage
    } : null;
    document.getElementById('compactPlayBtn').click();
    return result;
  })()`);
  assert.ok(playing, 'playback shows an active beat');
  assert.equal(playing.playing, true, 'the app is playing');
  assert.ok(Math.abs(playing.cellTop - playing.layerTop) <= 1, 'the active cell starts at the top of the staff layer (' + JSON.stringify(playing) + ')');
  assert.ok(playing.cellBottom >= playing.layerBottom, 'the active cell covers the whole staff height');
  assert.match(playing.background, /linear-gradient/, 'the active cell tints the staff part lighter than the TAB part');
  await client.evaluate(`appState.clickMode = 'all'; true`);

  // (5) 오선만: 타브 격자는 숨고 오선은 보인다. T 키는 tab, both, staff, card 순서로 돈다. 새로고침 뒤에도 유지된다.
  await client.evaluate(`${pageSetScoreView("'staff'")}; true`);
  await waitForCondition(client, allLayersDrawn, 5000);
  const staffOnly = await client.evaluate(`(function(){
    var card = document.querySelector('#measuresGrid .measure-card');
    var cell = card.querySelector('.beat-cell');
    return {
      grid: card.querySelector('.tab-cell-grid').getClientRects().length > 0,
      top: card.querySelector('.tab-cell-top').getClientRects().length > 0,
      lines: card.querySelector('.tab-lines-bg').getClientRects().length > 0,
      staff: card.querySelector('.tab-staff-layer svg').getClientRects().length > 0,
      tabOff: card.classList.contains('tab-off'),
      cellHeight: Math.round(cell.getBoundingClientRect().height),
      staffHeight: GuitarStaffSvg.STAFF_HEIGHT
    };
  })()`);
  assert.equal(staffOnly.grid, false, 'the staff-only view hides the TAB grid');
  assert.equal(staffOnly.top, false, 'the staff-only view hides the note names row');
  assert.equal(staffOnly.lines, false, 'the staff-only view hides the TAB lines');
  assert.equal(staffOnly.staff, true, 'the staff-only view shows the staff');
  assert.equal(staffOnly.tabOff, true, 'the card is tab-off');
  assert.ok(staffOnly.cellHeight >= staffOnly.staffHeight && staffOnly.cellHeight <= staffOnly.staffHeight + 16, 'the beat cell keeps the staff height for the cursor and clicks (' + staffOnly.cellHeight + ')');
  async function pressT(){
    await client.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', bubbles: true })); true`);
    return client.evaluate('appState.scoreView');
  }
  assert.equal(await pressT(), 'card', 'T goes from staff to card');
  assert.equal(await client.evaluate(`document.querySelectorAll('#measuresGrid .tab-staff-layer svg').length`), 0, 'the card view draws no staff layer');
  assert.equal(await pressT(), 'tab', 'T goes from card to tab');
  assert.equal(await pressT(), 'both', 'T goes from tab to both');
  assert.equal(await pressT(), 'staff', 'T goes from both to staff');
  await reload();
  assert.equal(await client.evaluate('appState.scoreView'), 'staff', 'the chosen view survives a reload');
  await waitForCondition(client, allLayersDrawn, 5000);
  assert.equal(await client.evaluate(`document.getElementById('scoreViewSelect').value`), 'staff', 'the reloaded view select shows the saved view');

  // (6) 악보 입력에서 넘긴 조표
  const handoff = { title: '조표 시험', beats: 4, bpm: 72, badge: '시험', key: 1, savedAt: Date.now(), lines: ['[-] E4@1 - G4@1 - | ""', '[Am] A2@5+E4@1 r r r | "끝"'] };
  await client.evaluate('localStorage.setItem("gs.tabInput.handoff", ' + JSON.stringify(JSON.stringify(handoff)) + '); true', { userGesture: true });
  await reload();
  await waitForCondition(client, allLayersDrawn, 5000);
  const keyed = await client.evaluate(`({
    title: curSong.title, key: curSong.key,
    keys: document.querySelectorAll('#measuresGrid .measure-card[data-m="0"] .tab-stave-side .st-key').length,
    laterKeys: document.querySelectorAll('#measuresGrid .measure-card[data-m="1"] .tab-stave-side .st-key').length
  })`);
  assert.equal(keyed.title, '조표 시험', 'the handed-over score opens');
  assert.equal(keyed.key, 1, 'the handed-over key signature is on the temporary score');
  assert.equal(keyed.keys, 1, 'the first card shows one sharp in its left column');
  assert.equal(keyed.laterKeys, 1, 'later cards repeat the key signature');

  // (7) 툴바: 보기 단추가 넷이어도 768px와 1024px에서 넘치지 않는다
  const toolbar = {};
  for (const width of [768, 1024]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    toolbar[width] = await client.evaluate(`(function(){ var bar = document.getElementById('scoreToolbar'); return { scroll: bar.scrollWidth, client: bar.clientWidth }; })()`);
    assert.ok(toolbar[width].scroll <= toolbar[width].client, 'the score toolbar does not overflow at ' + width + 'px (' + JSON.stringify(toolbar[width]) + ')');
  }
  process.stdout.write('  toolbar scrollWidth/clientWidth: ' + JSON.stringify(toolbar) + '\n');

  // (9) 스크린샷: 둘 다 상태, 로망스 1부 재생 중
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  async function practiceShot(name, width, height, mobile) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await client.evaluate(`(async function(){
      changeSongById('builtin-lv6-romance-full');
      ${pageSetScoreView("'both'")};
      appState.clickMode = 'off';
      curMeasureIdx = 0; curBeatIdx = 0;
      updateActiveCursor(0, 0, false);
      document.getElementById('compactPlayBtn').click();
      var started = Date.now();
      while (Date.now() - started < 4000 && !(curBeatIdx >= 1 || curMeasureIdx >= 1)) await new Promise(function(resolve){ setTimeout(resolve, 30); });
      return true;
    })()`);
    await waitForCondition(client, allLayersDrawn, 5000);
    await client.evaluate(`document.getElementById('scoreToolbar').scrollIntoView({ block: 'start', inline: 'nearest' }); true`);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await client.evaluate(`(function(){ if (isPlaying) document.getElementById('compactPlayBtn').click(); appState.clickMode = 'all'; return true; })()`);
    const target = path.join(root, 'test-artifacts', name);
    fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
    const header = fs.readFileSync(target).subarray(0, 24);
    assert.equal(header.readUInt32BE(16), width, name + ' width');
    assert.equal(header.readUInt32BE(20), height, name + ' height');
    process.stdout.write('Artifact: ' + target + '\n');
    return client.evaluate('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })');
  }
  await practiceShot('practice-staff.png', 1280, 900, false);
  const phone = await practiceShot('practice-staff-mobile.png', 375, 812, true);
  assert.ok(phone.scroll <= phone.inner, 'the 375px practice page with a staff does not overflow horizontally (scrollWidth ' + phone.scroll + ' > ' + phone.inner + ')');
  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the practice staff view runs without console errors');
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: practice staff view layers, alignment, cursor click, staff-only, T cycle, reload, handoff key, toolbar, and screenshots passed\n');
}

// TAB 프렛 글자(buildFretLabel): 연습 화면과 악보 입력 화면이 같은 모양이고 주법은 글자 색으로만 나온다.
async function testFretLabel(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const errorsBefore = client.consoleErrors.length;
  async function loadPage(url, readyExpression) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, readyExpression, 8000);
  }
  const probeColor = `function probeColor(name){ var probe = document.createElement('span'); probe.style.color = 'var(' + name + ')'; document.body.appendChild(probe); var color = getComputedStyle(probe).color; probe.remove(); return color; }`;
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  async function saveShot(name, width, height) {
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const target = path.join(root, 'test-artifacts', name);
    fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
    const header = fs.readFileSync(target).subarray(0, 24);
    assert.equal(header.readUInt32BE(16), width * 2, name + ' width');
    assert.equal(header.readUInt32BE(20), height * 2, name + ' height');
    process.stdout.write('Artifact: ' + target + '\n');
  }

  // (1) 연습 화면: 로망스 1부 첫 마디의 알약
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await loadPage(`http://127.0.0.1:${httpPort}/index.html`, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null');
  const practice = await client.evaluate(`(function(){
    ${probeColor}
    changeSongById('builtin-lv6-romance-full');
    ${pageSetScoreView("'both'")};
    appState.clickMode = 'off';
    curMeasureIdx = 1; curBeatIdx = 1;
    updateActiveCursor(1, 1, false);
    var cell = document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="0"]');
    var pills = Array.prototype.slice.call(cell.querySelectorAll('.tab-fret-pill'));
    function byTop(top){ return pills.filter(function(pill){ return pill.style.top === top; })[0]; }
    var melody = byTop('0%'), bass = byTop('100%');
    var inactive = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell.tab-cell:not(.active-beat) .fret-label.is-apoyando'))[0];
    return {
      melodyClass: melody && melody.querySelector('.fret-label').className,
      melodyLh: melody && melody.querySelector('sup.fret-lh') && melody.querySelector('sup.fret-lh').textContent,
      melodyRh: melody && melody.querySelector('sub.fret-rh') && melody.querySelector('sub.fret-rh').textContent,
      melodyText: melody && melody.textContent,
      bassClass: bass && bass.querySelector('.fret-label').className,
      bassText: bass && bass.textContent,
      bassHasFingering: !!(bass && bass.querySelector('.fret-fing')),
      apoyandoColor: inactive && getComputedStyle(inactive).color, near: probeColor('--near'),
      apoyandoWeight: inactive && getComputedStyle(inactive).fontWeight,
      legacyNodes: document.querySelectorAll('#measuresGrid .tab-cell-lh, #measuresGrid .tab-note-rh').length,
      anyGlyph: Array.prototype.some.call(document.querySelectorAll('#measuresGrid .tab-fret-pill'), function(pill){ return /[!~(]/.test(pill.textContent); })
    };
  })()`);
  assert.ok(/\bfret-label\b/.test(practice.melodyClass) && /\bis-apoyando\b/.test(practice.melodyClass), 'the written apoyando makes the first-string pill is-apoyando: ' + practice.melodyClass);
  assert.equal(practice.melodyLh, '4', 'the pill shows the left-hand finger as a superscript');
  assert.equal(practice.melodyRh, 'a', 'the pill shows the right-hand finger as a subscript');
  assert.ok(/^\d+4a$/.test(practice.melodyText), 'the pill text is the fret then the two small figures, with no ! or parentheses: ' + practice.melodyText);
  assert.ok(!/\bis-(apoyando|tirando)\b/.test(practice.bassClass), 'the unmarked sixth-string bass pill has no articulation class: ' + practice.bassClass);
  assert.equal(practice.bassHasFingering, true, 'the bass pill keeps its right-hand finger');
  assert.ok(practice.bassText.indexOf('(') < 0 && practice.bassText.indexOf('~') < 0, 'the bass pill has no tilde or parentheses: ' + practice.bassText);
  assert.equal(practice.anyGlyph, false, 'no TAB pill draws !, ~ or parentheses');
  assert.equal(practice.legacyNodes, 0, 'the old parenthesis and right-hand nodes are gone');
  assert.equal(practice.apoyandoColor, practice.near, 'an apoyando fret label is drawn in the --near color');
  assert.equal(practice.apoyandoWeight, '700', 'an apoyando fret label is bold');

  // (2) 재생 중 활성 박: 알약 안 글자가 알약 글자색을 따른다
  const playing = await client.evaluate(`(async function(){
    document.getElementById('compactPlayBtn').click();
    var started = Date.now();
    while (Date.now() - started < 6000 && !(curBeatIdx >= 1 || curMeasureIdx >= 1)) await new Promise(function(resolve){ setTimeout(resolve, 30); });
    var pills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell.tab-cell.active-beat .tab-fret-pill'));
    var result = pills.map(function(pill){
      var pillColor = getComputedStyle(pill).color;
      return Array.prototype.slice.call(pill.querySelectorAll('.fret-label, .fret-lh, .fret-rh')).map(function(node){ return getComputedStyle(node).color === pillColor; });
    });
    return { pillCount: pills.length, allFollow: result.every(function(list){ return list.length > 0 && list.every(Boolean); }), withArt: pills.filter(function(pill){ return !!pill.querySelector('.is-apoyando'); }).length };
  })()`);
  assert.ok(playing.pillCount > 0 && playing.withArt > 0, 'a playing beat has pills with written articulation');
  assert.equal(playing.allFollow, true, 'inside the active beat the fret label and its figures follow the pill text color');
  await client.evaluate(`document.getElementById('scoreToolbar').scrollIntoView({ block: 'start', inline: 'nearest' }); true`);
  await saveShot('practice-fret-label.png', 1280, 900);
  await client.evaluate(`(function(){ if (isPlaying) document.getElementById('compactPlayBtn').click(); appState.clickMode = 'all'; return true; })()`);

  // (3) 악보 입력 화면
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  await client.evaluate(`(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`);
  await loadPage(inputUrl, 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1');
  await client.evaluate(`window.__tiTest = {
    pos: function(m, c, s, str){ return document.querySelector('.ti-slot[data-m="'+m+'"][data-c="'+c+'"][data-s="'+s+'"] .ti-pos[data-str="'+str+'"]'); },
    fret: function(str, fret){ return document.querySelector('.ti-fret[data-str="'+str+'"][data-fret="'+fret+'"]'); },
    attr: function(name, value){ return document.querySelector('[data-attr="'+name+'"][data-value="'+value+'"]'); },
    text: function(){ return document.getElementById('tiScoreText').value; }
  }; true`);
  const input = await client.evaluate(`(function(){
    ${probeColor}
    var t = __tiTest;
    t.pos(0,0,0,1).click(); t.fret(1,3).click();
    t.attr('lh','1').click(); t.attr('rh','i').click(); t.attr('art','!').click();
    function label(){ return t.pos(0,0,0,1).querySelector('.ti-pos-label'); }
    var apo = label();
    var out = { apoClass: apo.className, apoText: apo.textContent, apoColor: getComputedStyle(apo).color, apoLh: apo.querySelector('sup.fret-lh').textContent, apoRh: apo.querySelector('sub.fret-rh').textContent,
      near: probeColor('--near'), muted: probeColor('--muted'), off: probeColor('--off'), scoreText: t.text().split('\\n')[0] };
    out.buttonApo = getComputedStyle(t.attr('art','!')).color;
    out.artButtons = Array.prototype.map.call(document.querySelectorAll('#tiAttrs [data-attr="art"]'), function(b){ return b.dataset.value + '|' + b.textContent.trim(); }).join(',');
    out.hasTildeButton = !!t.attr('art','~');
    out.attrsText = document.getElementById('tiAttrs').textContent;
    t.attr('art','!').click();
    document.getElementById('tiUncertainBtn').click();
    var unsure = label();
    out.unsureClass = unsure.className; out.unsureColor = getComputedStyle(unsure).color; out.unsureParent = t.pos(0,0,0,1).className;
    document.getElementById('tiUncertainBtn').click();
    return out;
  })()`);
  assert.ok(/\bis-apoyando\b/.test(input.apoClass) && /\bti-pos-label\b/.test(input.apoClass), 'choosing apoyando marks the tab label is-apoyando: ' + input.apoClass);
  assert.ok(input.apoText.indexOf('!') < 0 && input.apoText.indexOf('~') < 0, 'the tab label has no articulation glyph: ' + input.apoText);
  assert.deepEqual([input.apoLh, input.apoRh], ['1', 'i'], 'the tab label shows the left hand above and the right hand below');
  assert.equal(input.apoColor, input.near, 'the apoyando label is drawn in the --near color');
  assert.ok(input.scoreText.indexOf('!') >= 0, 'the score text still carries the ! mark: ' + input.scoreText);
  assert.equal(input.hasTildeButton, false, 'the input panel has no ~ tirando button');
  assert.equal(input.artButtons, '|없음,!|! 아포얀도', 'the articulation buttons are only none and apoyando: ' + input.artButtons);
  assert.ok(input.attrsText.indexOf('티란도') < 0, 'the input panel never mentions tirando');
  assert.equal(input.buttonApo, input.near, 'the apoyando button text is drawn in the --near color');
  assert.ok(/\bis-apoyando\b/.test(input.unsureClass) && /\bis-uncertain\b/.test(input.unsureParent), 'a checked note keeps its articulation class');
  assert.equal(input.unsureColor, input.off, 'a check mark (red) beats the articulation color');

  // 입력 화면 스크린샷: 로망스 1부
  const romance = builtinSongsJson.find(item => item.id === 'builtin-lv6-romance-full');
  await client.evaluate(`(function(){
    var song = ${JSON.stringify({ title: romance.title, beats: romance.beats, bpm: romance.bpm, badge: romance.badge, lines: romance.lines })};
    var tsv = formatSongToSheetTsv(song.title, song.beats, song.bpm, song.badge || '', song.lines);
    window.confirm = function(){ return true; };
    document.getElementById('tiImportBtn').click();
    var area = document.getElementById('tiImportText');
    area.value = tsv;
    area.dispatchEvent(new Event('input', { bubbles:true }));
    document.getElementById('tiImportApplyBtn').click();
    document.getElementById('tiMeasures').scrollIntoView({ block: 'start' });
    return true;
  })()`);
  assert.equal(await client.evaluate(`document.getElementById('tiImportError').textContent`), '', 'the Romance import has no error');
  assert.ok(await client.evaluate(`document.querySelectorAll('#tiMeasures .fret-label.is-apoyando').length > 0 && document.querySelectorAll('#tiMeasures .fret-label.is-tirando').length === 0`), 'the imported Romance shows the apoyando color and no tirando class');
  await saveShot('score-input-fret-label.png', 1280, 900);
  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the fret label steps run without console errors');
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: shared fret label in practice and score input (articulation colors, active beat, check mark, screenshots) passed\n');
}

async function main() {
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scriptTags = [...appHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scriptTags.map(src => src.split('?')[0]), ['src/storage.js', 'src/app-state.js', 'src/notation.js', 'src/rhythm.js', 'src/parser.js', 'src/staff-layout.js', 'src/staff-svg.js', 'src/score-drafts.js', 'src/score.js', 'src/audio.js', 'src/guide.js', 'src/image-analysis.js', 'src/fretboard.js', 'src/score-ui.js', 'src/sheets.js', 'src/score-prompt.js', 'src/score-editor.js', 'src/app.js'], 'app classic scripts keep the required order');
  assert.ok(scriptTags.every(src => src.endsWith('?v=chord-cards-1')), 'all app scripts use the shared revision');
  const htmlIds = ['editInInputBtn','resetScoreDraftBtn','scoreDraftStatus','copyCurSongTsvBtn','copyScorePromptBtn','copyProjectPromptBtn','scorePromptStatus','sheetLoadStatus','uncertainBadge'];
  htmlIds.forEach(function(id){assert.match(appHtml,new RegExp('id="'+id+'"'),'draft UI includes #'+id);});
  ['addBlankScoreBtn','blankScoreModal','undoScoreEditBtn'].forEach(function(id){assert.doesNotMatch(appHtml,new RegExp('id="'+id+'"'),'removed in-page editing UI has no #'+id);});
  assert.doesNotMatch(fs.readFileSync(path.join(root,'index.html'),'utf8'),/\.beat-cell\.arp-(?:melody|sub)\b/,'obsolete articulation color rules are removed from the score stylesheet');
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source:`(function(){
      var key='__gsCaptureAudit';
      var audit={ capture:0, devices:0, worklet:0 };
      try {
        if(localStorage.getItem('gs.history')===null) localStorage.setItem('gs.history','legacy-history-marker');
        if(localStorage.getItem('gs.calib')===null) localStorage.setItem('gs.calib','legacy-calibration-marker');
      } catch(_){}
      try { var previous=JSON.parse(sessionStorage.getItem(key)||'null'); if(previous) audit=previous; } catch(_){}
      function save(){ try { sessionStorage.setItem(key,JSON.stringify(audit)); } catch(_){} }
      Object.defineProperty(window,'__gsCaptureAudit',{ configurable:true, get:function(){ return audit; } });
      Object.defineProperty(navigator,'mediaDevices',{ configurable:true, get:function(){ return {
        getUserMedia:function(){ audit.capture++; save(); throw new Error('Unexpected getUserMedia call'); },
        enumerateDevices:function(){ audit.devices++; save(); throw new Error('Unexpected enumerateDevices call'); },
        addEventListener:function(){}, removeEventListener:function(){}
      }; }});
      if(window.AudioWorklet && AudioWorklet.prototype && typeof AudioWorklet.prototype.addModule==='function'){
        var original=AudioWorklet.prototype.addModule;
        Object.defineProperty(AudioWorklet.prototype,'addModule',{ configurable:true, value:function(){ audit.worklet++; save(); return original.apply(this,arguments); } });
      }
    })();` });

    const appUrl = `http://127.0.0.1:${httpPort}/index.html`;
    await cdp.send('Page.navigate', { url: appUrl });

    // Wait until boot completes
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.allSongs.length === ' + builtinSongCount + ' && window.curSong != null', 8000);

    // Assert initial app state in real browser
    const songCount = await cdp.evaluate('window.allSongs.length');
    assert.equal(songCount, builtinSongCount, 'browser loaded every song from songs.json');

    const curSongId = await cdp.evaluate('window.curSong.id');
    assert.equal(curSongId, 'builtin-lv1-butterfly', 'default song selected in browser');

    const levelGroups = await cdp.evaluate(`(function(){
      var result={names:window.BUILTIN_LEVEL_NAMES};
      ['compactSongSelect','songSelect'].forEach(function(id){
        result[id]=Array.prototype.slice.call(document.getElementById(id).querySelectorAll('optgroup')).filter(function(group){
          return group.label.indexOf('Lv.')===0;
        }).map(function(group){
          return {label:group.label,values:Array.prototype.slice.call(group.querySelectorAll('option')).map(function(option){return option.value;})};
        });
      });
      return result;
    })()`);
    const expectedLevels = Array.from(new Set(builtinSongsJson.map(song => song.level))).sort((a, b) => a - b);
    const expectedLevelGroups = expectedLevels.map(level => ({
      label: 'Lv.' + level + (levelGroups.names[level] ? ' ' + levelGroups.names[level] : ''),
      values: builtinSongsJson.filter(song => song.level === level).map(song => song.id)
    }));
    for (const selectId of ['compactSongSelect', 'songSelect']){
      assert.deepEqual(levelGroups[selectId].map(group => group.label), expectedLevelGroups.map(group => group.label), `${selectId} has one optgroup per level in ascending order`);
      assert.deepEqual(levelGroups[selectId].map(group => group.values), expectedLevelGroups.map(group => group.values), `${selectId} lists each level's songs in songs.json order`);
    }

    const fretboardChildren = await cdp.evaluate('document.getElementById("fretboard").children.length');
    assert.equal(fretboardChildren, 7, 'fretboard DOM elements rendered (6 strings + header)');

    const measureCount = await cdp.evaluate('document.getElementById("measuresGrid").children.length');
    assert.ok(measureCount > 0, 'measures grid rendered in browser DOM');

    const audioBoot = await cdp.evaluate(`(async function(){
      ensureAudioCtx();
      if (window.actx && window.actx.state === 'suspended') await window.actx.resume();
      return { supported: !!(window.AudioContext || window.webkitAudioContext), instance: !!window.actx && (window.actx instanceof (window.AudioContext || window.webkitAudioContext)), state: window.actx && window.actx.state };
    })()`);
    assert.equal(audioBoot.supported, true, 'browser exposes a real Web Audio engine');
    assert.equal(audioBoot.instance, true, 'app initializes a real AudioContext');
    assert.equal(audioBoot.state, 'running', 'AudioContext resumes in the browser test');
    await testConcertHallRouting(cdp);
    await testBuiltinScores(cdp, browserBin);
    await testConcertHallOfflineRender(cdp);
    const liveGuide = await cdp.evaluate(`(function(){
      var parsed = parseScore('[C] 0E2 r r r', 4);
      warmKsCache({ type:'structured', measures:parsed.measures, capo:2 });
      var start = actx.currentTime + 0.05;
      var noteEvents = scheduleBeatGuide(parsed.measures[0].beats[0], { startTime:start, slotDuration:0.12, measures:parsed.measures, capo:2, maxDurationSlots:1 });
      var restEvents = scheduleBeatGuide(parsed.measures[0].beats[1], { startTime:start + 0.12, slotDuration:0.12, measures:parsed.measures, capo:2, maxDurationSlots:1 });
      stopGuitarNotes(actx.currentTime + 0.01);
      return { noteKinds:noteEvents.map(function(event){ return event.kind; }), restKinds:restEvents.map(function(event){ return event.kind; }), audioState:actx.state };
    })()`);
    assert.deepEqual(liveGuide.noteKinds, ['note'], 'real audio scheduler emits a note from a parsed score');
    assert.deepEqual(liveGuide.restKinds, ['rest'], 'real audio scheduler processes a future rest event');
    assert.equal(liveGuide.audioState, 'running', 'real guide scheduler runs on the initialized AudioContext');

    const bassButtonAbsent = await cdp.evaluate('document.getElementById("toggleAutoBassBtn") === null');
    assert.equal(bassButtonAbsent, true, 'automatic bass accompaniment toggle is removed');
    const fretboardPreview = await cdp.evaluate(`(function(){
      var originalPlay = window.playGuitarNote;
      var beforeSong = curSong.id;
      var beforeToken = curSong.measures && curSong.measures[0] && curSong.measures[0].beats[0] && curSong.measures[0].beats[0].tok;
      var calls = 0;
      window.playGuitarNote = function(){ calls++; };
      var target = document.querySelector('#fretboard .fb-open[data-str="1"]') || document.querySelector('#fretboard .fb-cell[data-str="1"][data-fret="1"]');
      if (target) target.click();
      window.playGuitarNote = originalPlay;
      var afterToken = curSong.measures && curSong.measures[0] && curSong.measures[0].beats[0] && curSong.measures[0].beats[0].tok;
      return { calls:calls, sameSong:curSong.id===beforeSong, sameToken:beforeToken===afterToken };
    })()`);
    assert.deepEqual(fretboardPreview, { calls:1, sameSong:true, sameToken:true }, 'fretboard click previews a note without creating or changing a score');
    process.stdout.write('Browser checkpoint: boot and initial DOM passed\n');

    const canonicalTsv = await cdp.evaluate(`window.formatSongToSheetTsv('slash lyric', 4, 90, 'badge', [
      '[C] C4 - - - | "너 / 나"',
      '[G] G3 - - - | "https://example.test/a|b"'
    ])`);
    const canonicalColumns = canonicalTsv.split('\t');
    assert.equal(canonicalColumns.length, 5, 'canonical TSV keeps five columns');
    assert.ok(canonicalColumns[4].includes(' // '), 'canonical TSV joins measures with //');
    assert.equal(canonicalColumns[4].includes('\n'), false, 'canonical TSV score stays on one row');
    assert.ok(canonicalColumns[4].includes('| "너 / 나"'), 'slash lyric is JSON quoted and preserved');
    const unquotedMemoRejected = await cdp.evaluate(`(function(){ try { window.formatSongToSheetTsv('x', 4, 90, 'badge', ['[C] C4 - - - | 너 / 나']); return false; } catch (e) { return true; } })()`);
    assert.equal(unquotedMemoRejected, true, 'an unquoted memo is rejected instead of normalized');
    assert.ok(canonicalColumns[4].includes('"https://example.test/a|b"'), 'URL and pipe lyric characters are preserved');

    const literalTextSafety = await cdp.evaluate(`(function(){
      var originalSong = curSong;
      var originalView = appState.scoreView;
      window.__gsInjected = 0;
      var fixture = buildStructuredSong({ id:'readonly-literal-fixture', title:'Read only literal fixture', badge:'Sheet', beats:4, lines:['[C] C4 - - - | "<img/src=x/onerror=window.__gsInjected=1>"'] });
      fixture.fromSheet = true;
      curSong = fixture;
      function inspect(view){ appState.scoreView = view; renderSong(); return { literal:document.getElementById('measuresGrid').textContent.includes('<img/src=x/onerror=window.__gsInjected=1>'), images:document.querySelectorAll('#measuresGrid img').length, injected:window.__gsInjected }; }
      var tab = inspect('tab');
      var card = inspect('card');
      curSong = originalSong; appState.scoreView = originalView; renderSong();
      return { tab:tab, card:card };
    })()`);
    assert.deepEqual(literalTextSafety, { tab:{ literal:true, images:0, injected:0 }, card:{ literal:true, images:0, injected:0 } }, 'TAB and card score rendering keeps markup literal without DOM injection');

    const scoreEditorUi = await cdp.evaluate(`({
      editorApi:typeof window.openConverterEditorModal,
      editorInit:typeof window.initEditor,
      promptApi:typeof window.buildAiPromptText,
      scoreEditorHooks:typeof window.scoreEditorHooks,
      blankScoreButton:!!document.getElementById('addBlankScoreBtn'),
      blankScoreModal:!!document.getElementById('blankScoreModal'),
      undoScoreButton:!!document.getElementById('undoScoreEditBtn'),
      editInInputButton:!!document.getElementById('editInInputBtn'),
      resetScoreButton:!!document.getElementById('resetScoreDraftBtn'),
      draftStatus:!!document.getElementById('scoreDraftStatus'),
      copyButtonInToolbar:!!(document.getElementById('copyCurSongTsvBtn')&&document.getElementById('copyCurSongTsvBtn').closest('.score-toolbar')),
      imageConversion:!!document.getElementById('convertImgToScoreBtn'),
      imageUpload:!!document.getElementById('uploadImgBtn'),
      barEditor:!!document.getElementById('barEditModal')
    })`);
    assert.deepEqual(scoreEditorUi, { editorApi:'undefined', editorInit:'undefined', promptApi:'undefined', scoreEditorHooks:'object', blankScoreButton:false,
      blankScoreModal:false, undoScoreButton:false, editInInputButton:true, resetScoreButton:true, draftStatus:true, copyButtonInToolbar:true, imageConversion:false, imageUpload:true, barEditor:true },
      'draft controls are present without the removed in-page editor or converter');
    await testTemporaryScoreEditor(cdp);

    const imageScanSafety = await cdp.evaluate(`(async function(){
      var savedSong = curSong;
      var savedScanner = window.scanImageBarlines;
      var savedAlert = window.alert;
      var alerts = [];
      var target = { id:'browser-image-scan-safety', title:'Image scan safety', type:'image', badge:'Source badge', bpm:77, imageDataUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', systems:[{x:0.1,y:0.1,w:0.8,h:0.3,bars:[{chord:'C',note:'C4',memo:'keep',w:1,custom:'keep'}]}] };
      try {
        window.alert = function(message){ alerts.push(String(message)); };
        curSong = target; renderSong();
        var resolveScan;
        window.scanImageBarlines = function(){ return new Promise(function(resolve){ resolveScan = resolve; }); };
        document.getElementById('autoDetectBarsBtn').click();
        await new Promise(function(resolve){ setTimeout(resolve, 0); });
        var switched = { id:'browser-image-scan-switched', title:'Switched', type:'image', imageDataUrl:target.imageDataUrl, systems:[{x:0.2,y:0.2,w:0.5,h:0.2,bars:[]}] };
        curSong = switched;
        resolveScan([0.1,0.3,0.5]);
        await new Promise(function(resolve){ setTimeout(resolve, 20); });
        var staleIgnored = target.systems[0].bars.length === 1 && switched.systems[0].bars.length === 0;
        curSong = target; renderSong();
        window.scanImageBarlines = function(){ return Promise.resolve([0.1,0.9]); };
        document.getElementById('autoDetectBarsBtn').click();
        await new Promise(function(resolve){ setTimeout(resolve, 20); });
        var metadataPreserved = target.systems[0].bars.length === 1 && target.systems[0].bars[0].chord === 'C' && target.systems[0].bars[0].note === 'C4' && target.systems[0].bars[0].memo === 'keep' && target.systems[0].bars[0].custom === 'keep';
        window.scanImageBarlines = function(){ return Promise.resolve([0.1,0.3,0.6,0.9]); };
        document.getElementById('autoDetectBarsBtn').click();
        await new Promise(function(resolve){ setTimeout(resolve, 20); });
        var countMismatchProtected = target.systems[0].bars.length === 1 && target.systems[0].bars[0].chord === 'C' && target.systems[0].bars[0].note === 'C4' && target.systems[0].bars[0].memo === 'keep' && target.systems[0].bars[0].custom === 'keep';
        return { staleIgnored:staleIgnored, metadataPreserved:metadataPreserved, countMismatchProtected:countMismatchProtected,
          sameCountAlert:alerts.some(function(message){return message.indexOf('마디 영역만 추정')>=0;}), mismatchAlert:alerts.some(function(message){return message.indexOf('기존 음표·코드')>=0;}) };
      } finally { curSong = savedSong; window.scanImageBarlines = savedScanner; window.alert = savedAlert; renderSong(); }
    })()`);
    assert.deepEqual(imageScanSafety, { staleIgnored:true, metadataPreserved:true, countMismatchProtected:true, sameCountAlert:true, mismatchAlert:true }, 'image barline scan ignores stale results and preserves manual metadata');

    const imageLifecycle = await cdp.evaluate(`(async function(){
      var oldPrompt = window.prompt;
      var oldSave = window.dbSaveImageSong;
      var uploadInput = document.getElementById('fileInput');
      var bytes = Uint8Array.from(atob('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='), function(c){ return c.charCodeAt(0); });
      var file = new File([bytes], 'browser-score.gif', { type:'image/gif' });
      var transfer = new DataTransfer(); transfer.items.add(file);
      window.prompt = function(){ return 'Browser uploaded image'; };
      uploadInput.files = transfer.files;
      uploadInput.dispatchEvent(new Event('change', { bubbles:true }));
      for (var i=0; i<100 && !imageSongs.some(function(song){ return song.title === 'Browser uploaded image'; }); i++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      var song = imageSongs.find(function(item){ return item.title === 'Browser uploaded image'; });
      if (!song) throw new Error('image upload did not persist');
      changeSongById(song.id);
      window.selectedImgBar = { sysIdx:0, barIdx:0, globalIdx:0 };
      document.getElementById('editBarMetaBtn').click();
      document.getElementById('beChord').value = 'Am';
      document.getElementById('beNote').value = 'E4';
      document.getElementById('beMemo').value = 'browser memo';
      document.getElementById('saveBarEditBtn').click();
      for (var barWait=0; barWait<100 && song.systems[0].bars[0].chord !== 'Am'; barWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      var barSaved = song.systems[0].bars[0].chord === 'Am' && song.systems[0].bars[0].note === 'E4' && song.systems[0].bars[0].memo === 'browser memo';

      window.prompt = function(){ return 'Browser renamed image'; };
      document.getElementById('renameSongBtn').click();
      for (var renameWait=0; renameWait<100 && song.title !== 'Browser renamed image'; renameWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      var renamed = song.title === 'Browser renamed image';

      song.pdfPages = [song.imageDataUrl, 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='];
      song.curPageIdx = 0;
      await oldSave(song);
      renderImageScore();
      var finishSave;
      window.dbSaveImageSong = function(candidate){ return new Promise(function(resolve,reject){ finishSave = function(){ oldSave(candidate).then(resolve,reject); }; }); };
      var pagePending = document.getElementById('pdfNextBtn').click();
      for (var wait=0; wait<50 && !finishSave; wait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      if (!finishSave) throw new Error('PDF page save did not start');
      changeSongById('builtin-lv1-butterfly');
      var selectedId = curSong.id;
      finishSave();
      for (var pageWait=0; pageWait<100 && song.curPageIdx !== 1; pageWait++) await new Promise(function(resolve){ setTimeout(resolve, 10); });
      await pagePending;
      var storedPage = (await dbGetImageSongs()).find(function(item){ return item.id === song.id; });
      var pageRaceSafe = song.curPageIdx === 1 && song.imageDataUrl === song.pdfPages[1] && storedPage && storedPage.curPageIdx === 1 && curSong.id === selectedId;
      window.dbSaveImageSong = oldSave;
      return { uploaded:!!song, barSaved:barSaved, renamed:renamed, pageRaceSafe:pageRaceSafe };
    })()`);
    assert.deepEqual(imageLifecycle, { uploaded:true, barSaved:true, renamed:true, pageRaceSafe:true }, 'image upload, bar metadata, rename, and PDF page race pass');
    process.stdout.write('Browser checkpoint: temporary score editor and image library lifecycle passed\n');
    await testPracticeSessionLifecycle(cdp);
    process.stdout.write('Browser checkpoint: practice session passed\n');
    await testCaptureRemovalAndAudioOffset(cdp);
    await testBackupExport(cdp);
    await testSubdividedGuide(cdp);
    await capturePimaScreenshots(cdp);
    await testStorageFailureRecovery(cdp);
    await testInvalidStructuredPersistence(cdp);

    await importLegacyBackup(cdp);
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.imageSongs.some(function(song){ return song.id === "browser-legacy-backup-image"; }) && appState.audioOffsetMs === 180', 8000);
    const legacyBackup = await cdp.evaluate(`(async function(){
      var db = await openDB();
      var raw = await new Promise(function(resolve,reject){ var tx=db.transaction('songs','readonly'); var req=tx.objectStore('songs').getAll(); req.onsuccess=function(){resolve(req.result);}; req.onerror=function(){reject(req.error);}; });
      return { importedImage:imageSongs.some(function(song){return song.id==='browser-legacy-backup-image';}),
        importedText:allSongs.some(function(song){return song.id==='browser-legacy-backup-text';}), offset:appState.audioOffsetMs,
        micScoring:Object.prototype.hasOwnProperty.call(appState,'micScoring'), micDeviceId:Object.prototype.hasOwnProperty.call(appState,'micDeviceId'),
        captureAudit:window.__gsCaptureAudit, savedState:JSON.parse(localStorage.getItem('gs.state')||'{}'),
        rawHistory:localStorage.getItem('gs.history'), rawCalibration:localStorage.getItem('gs.calib'),
        legacyTextPreserved:raw.some(function(song){return song.id==='browser-hidden-legacy-text' && song.type==='structured';}),
        importedTextNotWritten:!raw.some(function(song){return song.id==='browser-legacy-backup-text';}) };
    })()`);
    assert.equal(legacyBackup.importedImage, true, 'mixed legacy backup restores image scores');
    assert.equal(legacyBackup.importedText, false, 'mixed legacy backup ignores structured text scores');
    assert.equal(legacyBackup.offset, 180, 'legacy backup import preserves the manual output offset');
    assert.equal(legacyBackup.micScoring, false, 'legacy backup import does not restore removed scoring state');
    assert.equal(legacyBackup.micDeviceId, false, 'legacy backup import does not restore removed device selection');
    assert.equal(Object.prototype.hasOwnProperty.call(legacyBackup.savedState, 'micScoring'), false, 'legacy import stores a cleaned appState');
    assert.equal(Object.prototype.hasOwnProperty.call(legacyBackup.savedState, 'micDeviceId'), false, 'cleaned appState does not persist the removed device selection');
    assert.equal(legacyBackup.rawHistory, 'legacy-history-marker', 'legacy raw history storage is left untouched');
    assert.equal(legacyBackup.rawCalibration, 'legacy-calibration-marker', 'legacy raw calibration storage is left untouched');
    assert.equal(legacyBackup.legacyTextPreserved, true, 'legacy structured IndexedDB rows remain physically untouched');
    assert.equal(legacyBackup.importedTextNotWritten, true, 'mixed backup import does not write structured text rows');
    assert.deepEqual(legacyBackup.captureAudit, { capture:0, devices:0, worklet:0 }, 'capture APIs and AudioWorklet remain unused through backup import and reload');
    process.stdout.write('Browser checkpoint: image-only backup import cleanup and capture-free reload passed\n');

    const removedApis = await cdp.evaluate(`({ editor:typeof window.openConverterEditorModal, initEditor:typeof window.initEditor, aiPrompt:typeof window.buildAiPromptText,
      editorDom:!!document.getElementById('newSongModal'), converter:!!document.getElementById('convertImgToScoreBtn') })`);
    assert.deepEqual(removedApis, { editor:'undefined', initEditor:'undefined', aiPrompt:'undefined', editorDom:false, converter:false }, 'removed text editor and image-to-text UI stay absent after import/reload');
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

    // Verify notation mode toggle button
    const notationToggleCheck = await cdp.evaluate(`(function(){
      var btn = document.getElementById('toggleNotationBtn');
      if (!btn) return { exists: false };
      var initialMode = appState.notationMode;
      var initialTxt = btn.textContent.trim();
      btn.click();
      var solfegeMode = appState.notationMode;
      var solfegeTxt = btn.textContent.trim();
      btn.click();
      var restoredMode = appState.notationMode;
      var restoredTxt = btn.textContent.trim();
      return {
        exists: true,
        initialMode: initialMode,
        initialTxt: initialTxt,
        solfegeMode: solfegeMode,
        solfegeTxt: solfegeTxt,
        restoredMode: restoredMode,
        restoredTxt: restoredTxt
      };
    })()`);
    assert.equal(notationToggleCheck.exists, true, '#toggleNotationBtn exists');
    assert.equal(notationToggleCheck.initialMode, 'cde', 'initial notation mode is cde');
    assert.equal(notationToggleCheck.initialTxt, '도레미 표기', 'initial button text is 도레미 표기');
    assert.equal(notationToggleCheck.solfegeMode, 'solfege', 'notation mode toggles to solfege');
    assert.equal(notationToggleCheck.solfegeTxt, 'CDE 표기', 'button text toggles to CDE 표기');
    assert.equal(notationToggleCheck.restoredMode, 'cde', 'notation mode restores to cde');
    assert.equal(notationToggleCheck.restoredTxt, '도레미 표기', 'button text restores to 도레미 표기');

    // Verify help modal opens and closes
    const helpModalOpen = await cdp.evaluate(`(function(){
      var openBtn = document.getElementById('helpModalOpenBtn');
      var modal = document.getElementById('helpModal');
      if (!openBtn || !modal) return false;
      openBtn.click();
      return !modal.hidden;
    })()`);
    assert.equal(helpModalOpen, true, 'help modal opens correctly');
    const helpShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'test-artifacts', 'clean-score-ui', 'help-modal-desktop.png'), Buffer.from(helpShot.data, 'base64'));
    const helpModalClose = await cdp.evaluate(`(function(){
      var modal = document.getElementById('helpModal');
      var closeBtn = document.getElementById('closeHelpBtn');
      if (!closeBtn || !modal) return false;
      closeBtn.click();
      return modal.hidden;
    })()`);
    assert.equal(helpModalClose, true, 'help modal closes correctly');

    // 3. Verify youtube quick links query excludes [Lv..] tags
    const ytLinkText = await cdp.evaluate('document.querySelector("#ytQuickLinks a") ? document.querySelector("#ytQuickLinks a").textContent : ""');
    assert.ok(ytLinkText.length > 0, "youtube quick links rendered");
    assert.equal(ytLinkText.includes("[Lv"), false, "youtube search query excludes [Lv..] tags");

    const previousLoadCount=cdp.events.filter(event=>event.method==='Page.loadEventFired').length;
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForPageLoadAfter(cdp,previousLoadCount);
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.BUILTIN_SONGS.length === ' + builtinSongCount + ' && window.imageSongs.some(function(song){ return song.id === "browser-backup-image"; })', 8000);
    const screenshotDir = path.join(__dirname, '..', 'test-artifacts', 'clean-score-ui');
    let screenshotTarget = path.join(screenshotDir, 'beginner-rhythm-review.png');
    if (fs.existsSync(screenshotTarget)) screenshotTarget = path.join(screenshotDir, 'beginner-rhythm-review-' + Date.now() + '.png');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate(`(function(){
      var parsed = parseScore('[C] C4 - - 1E4\\n[G] - r 0E2+1C4 -', 4);
      window.curSong = { id:'beginner-rhythm-review', title:'Beginner rhythm review', type:'structured', beats:4, bpm:80, measures:parsed.measures };
      appState.scoreView = 'tab';
      appState.beats = 4;
      appState.bpm = 80;
      window.curMeasureIdx = 0;
      window.curBeatIdx = 0;
      renderSong();
      return true;
    })()`);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(screenshotTarget), { recursive: true });
    fs.writeFileSync(screenshotTarget, Buffer.from(screenshot.data, 'base64'));
    const imageHeader = fs.readFileSync(screenshotTarget).subarray(0, 24);
    assert.equal(imageHeader.readUInt32BE(16), 1280, 'review screenshot is 1280px wide');
    assert.equal(imageHeader.readUInt32BE(20), 900, 'review screenshot is 900px tall');
    process.stdout.write('Artifact: ' + screenshotTarget + '\n');
    process.stdout.write('Browser checkpoint: reload persistence, Web Audio boot, and 1280x900 screenshot passed\n');

    // 악보 입력 화면 연결: 링크, 넘기기 받기, 오래된 넘기기 무시
    const scoreInputLink = await cdp.evaluate(`(function(){
      var link = document.getElementById('openScoreInputLink');
      return link ? { tag:link.tagName, href:link.getAttribute('href') } : null;
    })()`);
    assert.deepEqual(scoreInputLink, { tag:'A', href:'score-input.html' }, '#openScoreInputLink links to score-input.html');

    const handoffUnloadDialogs = { count: 0 };
    cdp.dialogHandler = async params => {
      if (params.type === 'beforeunload') handoffUnloadDialogs.count++;
      await cdp.send('Page.handleJavaScriptDialog', { accept: true });
    };
    const handoffPayload = {
      title: '넘김 시험', beats: 4, bpm: 72, badge: '시험 · Capo 2',
      lines: ['[-] E4@1 - G4@1 - | ""', '[Am] A2@5+E4@1 r r r | "끝"']
    };
    async function reloadWithHandoff(payload){
      await cdp.evaluate('localStorage.setItem("gs.tabInput.handoff", ' + JSON.stringify(JSON.stringify(payload)) + '); true', { userGesture: true });
      const before = cdp.events.filter(event => event.method === 'Page.loadEventFired').length;
      await cdp.send('Page.reload', { ignoreCache: true });
      await waitForPageLoadAfter(cdp, before);
      await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null', 8000);
    }
    await reloadWithHandoff(Object.assign({ savedAt: Date.now() }, handoffPayload));
    const handoffState = await cdp.evaluate(`(function(){
      var select = document.getElementById('songSelect');
      var option = select.selectedOptions[0];
      var status = document.getElementById('scoreDraftStatus');
      var draft = scoreDrafts.status(curSong.id);
      return {
        title: curSong.title,
        selectedText: option ? option.textContent : null,
        group: option && option.parentElement ? option.parentElement.label : null,
        measures: curSong.measures.length,
        bpm: curSong.bpm,
        keyLeft: localStorage.getItem('gs.tabInput.handoff'),
        statusText: status ? status.textContent : null,
        statusHidden: status ? status.hidden : null,
        capo: curCapo(),
        temporary: draft.temporary,
        dirty: draft.dirty,
        origin: draft.origin,
        storageStatusHidden: document.getElementById('storageStatus').hidden
      };
    })()`);
    assert.equal(handoffState.title, '넘김 시험', 'handoff opens the handed-over song');
    assert.equal(handoffState.selectedText, '넘김 시험', 'handoff song is selected in the song list');
    assert.equal(handoffState.group, '임시 악보', 'handoff song sits in the temporary score group');
    assert.equal(handoffState.measures, 2, 'handoff song has two measures');
    assert.equal(handoffState.bpm, 72, 'handoff BPM is applied');
    assert.equal(handoffState.keyLeft, null, 'handoff key is removed after reading');
    assert.equal(handoffState.statusHidden, false, 'temporary score status line is visible');
    assert.ok(handoffState.statusText.includes('악보 입력에서 연'), 'status line says the score came from the tab input screen');
    assert.equal(handoffState.capo, 2, 'capo from the handoff badge is read');
    assert.deepEqual([handoffState.temporary, handoffState.dirty, handoffState.origin], [true, false, 'tab-input'], 'handoff draft is temporary, clean, and tagged tab-input');
    assert.equal(handoffState.storageStatusHidden, true, 'a valid handoff shows no storage error');

    await cdp.evaluate('document.body.click(); true', { userGesture: true });
    await reloadWithHandoff(Object.assign({ savedAt: Date.now() - 11 * 60 * 1000 }, handoffPayload));
    assert.equal(handoffUnloadDialogs.count, 0, 'an unedited tab-input temporary score does not raise the beforeunload confirmation');
    cdp.dialogHandler = null;
    const staleState = await cdp.evaluate(`({
      keyLeft: localStorage.getItem('gs.tabInput.handoff'),
      tempCount: allSongs.filter(function(song){ return String(song.id).startsWith('temp-score-'); }).length,
      title: curSong.title
    })`);
    assert.equal(staleState.keyLeft, null, 'stale handoff key is removed');
    assert.equal(staleState.tempCount, 0, 'stale handoff creates no temporary score');
    assert.notEqual(staleState.title, '넘김 시험', 'stale handoff does not open the handed-over song');
    process.stdout.write('Browser checkpoint: tab-input link, handoff open, and stale handoff ignored passed\n');

    await testPracticeStaffView(cdp);
    await testScoreInputScreen(cdp, httpPort);
    await testEditHandoff(cdp, httpPort);
    await testScoreInputStaff(cdp, httpPort);
    await testStaffInputMode(cdp, httpPort);
    await testTextInputMode(cdp, httpPort);
    await testFretLabel(cdp, httpPort);

    // Verify no unhandled console errors occurred
    assert.deepEqual(cdp.consoleErrors, [], 'no unhandled console errors in real browser execution');

    process.stdout.write('Result: browser smoke passed (clean boot, songs loaded, edit hand-off to the score input screen, image library, Web Audio, 0 console errors)\n');
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
