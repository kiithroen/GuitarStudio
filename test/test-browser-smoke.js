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
    var groups = Array.from(document.querySelectorAll('.top-actions'));
    var blank = document.getElementById('addBlankScoreBtn');
    return { blankIsLastTopAction:!!blank && blank.parentElement === groups[1] && groups[1].lastElementChild === blank,
      controlsRow:!!document.getElementById('scoreDraftControls') && document.getElementById('scoreDraftControls').contains(document.getElementById('scoreDraftStatus')) && document.getElementById('scoreDraftControls').contains(document.getElementById('undoScoreEditBtn')),
      copyNextToCompact:!!document.getElementById('copyCurSongTsvBtn') && document.getElementById('copyCurSongTsvBtn').parentElement === document.getElementById('toggleCompactBtn').parentElement && document.getElementById('copyCurSongTsvBtn').nextElementSibling === document.getElementById('toggleCompactBtn') };
  })()`);
  assert.deepEqual(setup, { blankIsLastTopAction:true, controlsRow:true, copyNextToCompact:true }, 'temporary score controls occupy their specified toolbar positions');

  const initial = await client.evaluate(`(function(){
    var button=document.getElementById('addBlankScoreBtn'); button.click();
    var defaults=[document.getElementById('blankScoreTitle').value,document.getElementById('blankScoreBeats').value,document.getElementById('blankScoreBpm').value];
    document.getElementById('cancelBlankScoreBtn').click();
    return {defaults:defaults,hidden:document.getElementById('blankScoreModal').hidden,count:allSongs.length};
  })()`);
  assert.deepEqual(initial, { defaults:['빈 악보 1','4','64'], hidden:true, count:13 }, 'blank modal cancel preserves the song list and shows configured defaults');

  const editFlow = await client.evaluate(`(async function(){
    function selectSong(id){var select=document.getElementById('songSelect');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));}
    function measureCard(index){return document.querySelector('#measuresGrid .measure-card[data-m="'+index+'"]');}
    function choose(index,action){var card=measureCard(index);if(!card)throw new Error('measure card missing: '+index);var menuButton=card.querySelector('.score-measure-menu-button');if(!menuButton)throw new Error('measure menu button missing');menuButton.click();var actionButton=card.querySelector('.score-measure-menu [data-score-action="'+action+'"]');if(!actionButton)throw new Error('measure action missing: '+action);if(actionButton.disabled)throw new Error('measure action is unexpectedly disabled: '+action);actionButton.click();}
    function measureText(song,label){return '[-] '+new Array(song.beats).fill('r').join(' ')+' | '+JSON.stringify(label);}
    function typeAndApply(text){var textarea=document.getElementById('scoreMeasureText');textarea.value=text;textarea.dispatchEvent(new Event('input',{bubbles:true}));var apply=document.querySelector('#scoreMeasureEditor [data-score-action="apply"]');if(!apply)throw new Error('inline apply button missing');apply.click();}
    function score(song){return serializeScoreMeasures(song.measures,'\\n');}
    function openEdit(index){choose(index,'edit');if(!document.getElementById('scoreMeasureText'))throw new Error('actual measure menu click did not open inline editor');}
    var sourceA=BUILTIN_SONGS.find(function(song){return song.id==='builtin-lv1-butterfly';});
    var sourceB=BUILTIN_SONGS.find(function(song){return song.id!=='builtin-lv1-butterfly';});
    if(!sourceA||!sourceB)throw new Error('expected builtin sources missing');
    var originalA=score(sourceA),originalB=score(sourceB);
    selectSong(sourceA.id);
    var countA=curSong.measures.length;
    curMeasureIdx=Math.min(2,countA-1);curBeatIdx=Math.min(1,curSong.beats-1);
    appState.bpm=Math.max(30,Math.min(240,Number(curSong.bpm)||64));
    var sourceBpm=Number(curSong.bpm)||64;
    var savedBpm=Math.max(30,Math.min(240,sourceBpm+7)),savedMeasure=curMeasureIdx,savedBeat=curBeatIdx;
    appState.bpm=savedBpm;appState.loopStart=countA>2?2:1;appState.loopEnd=countA>2?countA-1:countA;
    var savedLoop=[appState.loopStart,appState.loopEnd];
    openEdit(0);
    var pendingCount=curSong.measures.length;
    var pendingText=measureText(curSong,'browser-edit-a');
    var textarea=document.getElementById('scoreMeasureText');textarea.value=pendingText;textarea.dispatchEvent(new Event('input',{bubbles:true}));
    var pendingSongId=curSong.id;
    selectSong(sourceB.id);
    var songGuard=curSong.id===pendingSongId;
    var status=document.getElementById('scoreDraftStatus').textContent;
    var copied=0;var oldClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');
    try { Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:function(){copied++;return Promise.resolve();}}}); } catch(_){}
    document.getElementById('copyCurSongTsvBtn').click();
    document.getElementById('playBtn').click();
    var actionGuards={song:songGuard,copy:copied===0,play:!isPlaying,status:document.getElementById('scoreDraftStatus').textContent};
    if(oldClipboard)Object.defineProperty(navigator,'clipboard',oldClipboard);else try{delete navigator.clipboard;}catch(_){}
    typeAndApply('[-] r');
    var invalid={stillPending:!!document.getElementById('scoreMeasureText'),sameCount:curSong.measures.length===pendingCount,error:!!document.getElementById('scoreEditError').textContent};
    var sessionBefore={bpm:savedBpm,measure:savedMeasure,beat:savedBeat,loopStart:savedLoop[0],loopEnd:savedLoop[1]};
    var screenshotDir='test-artifacts/temp-score-editor/';
    return { sourceA:sourceA.id,sourceB:sourceB.id,originalA:originalA,originalB:originalB,countA:countA,sourceBpm:sourceBpm,savedBpm:savedBpm,savedMeasure:savedMeasure,savedBeat:savedBeat,savedLoop:savedLoop,
      actionGuards:actionGuards,invalid:invalid,pendingText:pendingText,sessionBefore:sessionBefore,screenshotDir:screenshotDir };
  })()`);
  assert.equal(editFlow.actionGuards.song, true, 'pending inline edit blocks song selection through the actual select control');
  assert.equal(editFlow.actionGuards.copy, true, 'pending inline edit blocks TSV copy through its actual toolbar button');
  assert.equal(editFlow.actionGuards.play, true, 'pending inline edit blocks practice through its actual play button');
  assert.match(editFlow.actionGuards.status, /먼저 적용하거나 취소/, 'pending guards explain how to continue');
  assert.deepEqual(editFlow.invalid, { stillPending:true, sameCount:true, error:true }, 'invalid full-score edit preserves original draft and pending text');

  const screenshotDir = path.join(root,'test-artifacts','temp-score-editor');
  fs.mkdirSync(screenshotDir,{recursive:true});
  const screenshotRun = Date.now();
  async function saveScreenshot(name,width,height,mobile,showEditor){
    await client.send('Emulation.setDeviceMetricsOverride',{width:width,height:height,deviceScaleFactor:1,mobile:mobile});
    if(showEditor){
      await client.evaluate(`(function(){document.getElementById('scoreMeasureEditor').scrollIntoView({block:'center'});var r=document.getElementById('scoreMeasureEditor').getBoundingClientRect();return r.top<innerHeight&&r.bottom>0;})()`);
      assert.equal(await client.evaluate(`(function(){var r=document.getElementById('scoreMeasureEditor').getBoundingClientRect();return r.top<innerHeight&&r.bottom>0;})()`),true,'editor screenshot includes inline edit controls');
    } else await client.evaluate('window.scrollTo(0,0)');
    const shot=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    const target=path.join(screenshotDir,name.replace('.png','-'+screenshotRun+'.png'));
    fs.writeFileSync(target,Buffer.from(shot.data,'base64'));
    const header=fs.readFileSync(target).subarray(0,24);
    assert.equal(header.readUInt32BE(16),width,'score editor screenshot width');
    assert.equal(header.readUInt32BE(20),height,'score editor screenshot height');
    process.stdout.write('Artifact: '+target+'\n');
    return target;
  }
  await saveScreenshot('toolbar-desktop.png',1280,900,false,false);
  await saveScreenshot('editor-desktop.png',1280,900,false,true);
  await saveScreenshot('toolbar-mobile.png',390,844,true,false);
  await saveScreenshot('editor-mobile.png',390,844,true,true);
  await client.send('Emulation.clearDeviceMetricsOverride');

  await client.evaluate(`document.querySelector('#scoreMeasureEditor [data-score-action="cancel"]').click()`);
  const menuClose = await client.evaluate(`(function(){
    var saved={m:curMeasureIdx,b:curBeatIdx,ls:appState.loopStart,le:appState.loopEnd,lsv:$('#loopStart').value,lev:$('#loopEnd').value};
    var c0=document.querySelector('#measuresGrid .measure-card[data-m="0"]');
    var btn=c0.querySelector('.score-measure-menu-button'),menu=c0.querySelector('.score-measure-menu');
    btn.click();var openedByTrigger=menu.hidden===false;
    btn.click();var toggleCloses=menu.hidden===true;
    btn.click();
    var c1=document.querySelector('#measuresGrid .measure-card[data-m="1"]');
    var other=c1.querySelector('.beat-cell')||c1;
    other.click();
    var outsideCloses=menu.hidden===true&&btn.getAttribute('aria-expanded')==='false';
    if(!menu.hidden)btn.click();
    btn.click();
    var reopened=menu.hidden===false;
    document.body.click();
    var bodyCloses=reopened&&menu.hidden===true;
    curMeasureIdx=saved.m;curBeatIdx=saved.b;appState.loopStart=saved.ls;appState.loopEnd=saved.le;
    $('#loopStart').value=saved.lsv;$('#loopEnd').value=saved.lev;
    updateLoopClasses();
    return {openedByTrigger:openedByTrigger,toggleCloses:toggleCloses,outsideCloses:outsideCloses,bodyCloses:bodyCloses};
  })()`);
  assert.deepEqual(menuClose, {openedByTrigger:true, toggleCloses:true, outsideCloses:true, bodyCloses:true}, 'measure menu closes on toggle and on outside clicks');
  const mutations = await client.evaluate(`(function(){
    function selectSong(id){var select=document.getElementById('songSelect');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));}
    function card(index){return document.querySelector('#measuresGrid .measure-card[data-m="'+index+'"]');}
    function action(index,name){var c=card(index);c.querySelector('.score-measure-menu-button').click();c.querySelector('.score-measure-menu [data-score-action="'+name+'"]').click();}
    function text(song,label){return '[-] '+new Array(song.beats).fill('r').join(' ')+' | '+JSON.stringify(label);}
    function apply(label){var t=document.getElementById('scoreMeasureText');t.value=text(curSong,label);t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#scoreMeasureEditor [data-score-action="apply"]').click();}
    function score(song){return serializeScoreMeasures(song.measures,'\\n');}
    var a=editFlowSourceA(),b=editFlowSourceB();
    selectSong(a.id);action(0,'edit');apply('browser-edit-a');
    var appliedA=score(curSong)!==editFlowOriginalA();var sourceUnchangedA=score(a)===editFlowOriginalA();
    var session={bpm:appState.bpm,measure:curMeasureIdx,beat:curBeatIdx,loopStart:appState.loopStart,loopEnd:appState.loopEnd};
    selectSong(b.id);
    var countB=curSong.measures.length;
    appState.bpm=Math.max(30,Math.min(240,(Number(curSong.bpm)||64)+9));
    appState.loopStart=countB>2?2:1;appState.loopEnd=countB>2?countB-1:countB;
    curMeasureIdx=Math.min(2,countB-1);curBeatIdx=Math.min(1,curSong.beats-1);
    var expectedB={bpm:appState.bpm,measure:curMeasureIdx,beat:curBeatIdx,loopStart:appState.loopStart,loopEnd:appState.loopEnd};
    action(0,'edit');apply('browser-edit-b');
    var appliedB=score(curSong)!==editFlowOriginalB();
    var sessionB={bpm:appState.bpm,measure:curMeasureIdx,beat:curBeatIdx,loopStart:appState.loopStart,loopEnd:appState.loopEnd};
    selectSong(a.id);document.getElementById('undoScoreEditBtn').click();
    var undoA=score(curSong)===editFlowOriginalA();
    selectSong(b.id);var bStillDirty=score(curSong)!==editFlowOriginalB()&&scoreDrafts.status(b.id).canUndo;
    document.getElementById('undoScoreEditBtn').click();
    var undoB=score(curSong)===editFlowOriginalB();
    var undoSessionB={bpm:appState.bpm,measure:curMeasureIdx,beat:curBeatIdx,loopStart:appState.loopStart,loopEnd:appState.loopEnd};
    selectSong(a.id);
    var beforeInsert=curSong.measures.length;curMeasureIdx=Math.min(1,beforeInsert-1);curBeatIdx=0;var oldCursor=curMeasureIdx;
    action(0,'insert');var previewUnapplied=curSong.measures.length===beforeInsert&&!!document.querySelector('.score-insert-draft');
    apply('insert-rest');var inserted=curSong.measures.length===beforeInsert+1;var cursorMapped=curMeasureIdx===(oldCursor>=1?oldCursor+1:oldCursor);
    document.getElementById('undoScoreEditBtn').click();var insertUndo=curSong.measures.length===beforeInsert;
    action(0,'delete');var deleted=curSong.measures.length===beforeInsert-1;document.getElementById('undoScoreEditBtn').click();var deleteUndo=curSong.measures.length===beforeInsert;
    var priorSheets=sheetSongs.slice();
    var sheetSource=buildStructuredSong({id:'browser-sheet-draft-source',title:'Sheet draft source',badge:'Capo 2',bpm:77,beats:4,lines:['[C] C4 - - - | "sheet source memo"']});
    sheetSource.fromSheet=true;sheetSongs=priorSheets.concat([sheetSource]);rebuildSongSelect(sheetSource.id);
    var originalSheet=score(sheetSource);action(0,'edit');apply('browser-sheet-draft');
    var sheetDraftIsolated=score(curSong)!==originalSheet&&score(sheetSource)===originalSheet;
    scoreDrafts.reset(sheetSource.id);sheetSongs=priorSheets;rebuildSongSelect(a.id);
    var sourceImmutable=score(a)===editFlowOriginalA()&&score(b)===editFlowOriginalB();
    return {appliedA:appliedA,sourceUnchangedA:sourceUnchangedA,appliedB:appliedB,undoA:undoA,bStillDirty:bStillDirty,undoB:undoB,session:session,sessionB:sessionB,expectedB:expectedB,undoSessionB:undoSessionB,
      previewUnapplied:previewUnapplied,inserted:inserted,cursorMapped:cursorMapped,insertUndo:insertUndo,deleted:deleted,deleteUndo:deleteUndo,sheetDraftIsolated:sheetDraftIsolated,sourceImmutable:sourceImmutable};
    function editFlowSourceA(){return BUILTIN_SONGS.find(function(song){return song.id==='builtin-lv1-butterfly';});}
    function editFlowSourceB(){return BUILTIN_SONGS.find(function(song){return song.id!== 'builtin-lv1-butterfly';});}
    function editFlowOriginalA(){return ${JSON.stringify(editFlow.originalA)};}
    function editFlowOriginalB(){return ${JSON.stringify(editFlow.originalB)};}
  })()`);
  for (const key of ['appliedA','sourceUnchangedA','appliedB','undoA','bStillDirty','undoB','previewUnapplied','inserted','cursorMapped','insertUndo','deleted','deleteUndo','sheetDraftIsolated','sourceImmutable']){
    assert.equal(mutations[key],true,'temporary score editor flow: '+key);
  }
  assert.notEqual(editFlow.savedBpm,editFlow.sourceBpm,'edit fixture uses a BPM different from the built-in default');
  assert.deepEqual(editFlow.sessionBefore,{bpm:editFlow.savedBpm,measure:editFlow.savedMeasure,beat:editFlow.savedBeat,loopStart:editFlow.savedLoop[0],loopEnd:editFlow.savedLoop[1]},'edit fixture uses non-default session values');
  assert.deepEqual(mutations.session,editFlow.sessionBefore,'the non-default BPM, cursor, and loop survive the edit apply');
  assert.deepEqual(mutations.sessionB,mutations.expectedB,'a second song keeps its own non-default BPM, cursor, and loop through editing');
  assert.deepEqual(mutations.undoSessionB,mutations.expectedB,'undo restores the edited song session instead of another song snapshot');

  await client.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  const ordinaryMobile=await client.evaluate(`(function(){
    var toolbar=document.getElementById('scoreToolbar'),right=document.querySelector('.score-toolbar-right'),panel=document.querySelector('section[aria-label="악보 및 메트로놈 커서"]');
    toolbar.scrollIntoView({block:'start'});
    var r=right.getBoundingClientRect(),p=panel.getBoundingClientRect();
    return {rightWithinPanel:r.right<=p.right+1,rightWithinViewport:r.right<=innerWidth+1,documentWithinViewport:document.documentElement.scrollWidth<=innerWidth+1,
      copyVisible:document.getElementById('copyCurSongTsvBtn').getClientRects().length>0,compactVisible:document.getElementById('toggleCompactBtn').getClientRects().length>0};
  })()`);
  assert.equal(ordinaryMobile.rightWithinPanel,true,'ordinary mobile score toolbar buttons stay inside the score panel');
  assert.equal(ordinaryMobile.rightWithinViewport,true,'ordinary mobile score toolbar stays within viewport');
  assert.equal(ordinaryMobile.documentWithinViewport,true,'ordinary mobile page has no document-wide horizontal overflow');
  assert.equal(ordinaryMobile.copyVisible,true,'ordinary mobile TSV copy control remains visible');
  assert.equal(ordinaryMobile.compactVisible,true,'ordinary mobile compact toggle remains visible');
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
      tab:document.getElementById('scoreModeTabBtn').getClientRects().length>0,
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

  const persistence = await client.evaluate(`(async function(){
    function card(index){return document.querySelector('#measuresGrid .measure-card[data-m="'+index+'"]');}
    function menu(index,action){var c=card(index);c.querySelector('.score-measure-menu-button').click();c.querySelector('.score-measure-menu [data-score-action="'+action+'"]').click();}
    function apply(label){var t=document.getElementById('scoreMeasureText');t.value='[-] '+new Array(curSong.beats).fill('r').join(' ')+' | '+JSON.stringify(label);t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#scoreMeasureEditor [data-score-action="apply"]').click();}
    var originalA=BUILTIN_SONGS.find(function(song){return song.id==='builtin-lv1-butterfly';});
    var sourceText=serializeScoreMeasures(originalA.measures,'\\n');
    document.getElementById('addBlankScoreBtn').click();
    document.getElementById('blankScoreTitle').value='Browser temporary draft marker';
    document.getElementById('blankScoreBeats').value='3';
    document.getElementById('blankScoreBpm').value='88';
    document.getElementById('createBlankScoreBtn').click();
    var temporaryId=curSong.id;
    var created={id:temporaryId,title:curSong.title,beats:curSong.beats,bpm:curSong.bpm,rests:curSong.measures[0].beats.every(function(beat){return beat.tok==='r';}),sourceUnchanged:serializeScoreMeasures(originalA.measures,'\\n')===sourceText};
    var initialBlankLoop={count:curSong.measures.length,start:appState.loopStart,end:appState.loopEnd};
    if(curSong.measures.length!==1)throw new Error('new blank score did not start with one measure');
    menu(0,'insert');apply('blank-second-measure');
    var blankInsert={count:curSong.measures.length,start:appState.loopStart,end:appState.loopEnd};
    document.getElementById('undoScoreEditBtn').click();
    var blankInsertUndo={count:curSong.measures.length,start:appState.loopStart,end:appState.loopEnd};
    menu(0,'edit');apply('temporary dirty marker');
    var db=await openDB();
    var rows=await new Promise(function(resolve,reject){var tx=db.transaction('songs','readonly');var req=tx.objectStore('songs').getAll();req.onsuccess=function(){resolve(req.result);};req.onerror=function(){reject(req.error);};});
    var localText=Object.keys(localStorage).map(function(key){return localStorage.getItem(key)||'';}).join('\\n');
    var storage={rowsHaveNoTemp:rows.every(function(row){return !String(row.id).startsWith('temp-score-')&&row.type!=='structured';}),
      noDraftTitle:!localText.includes(created.title)&&!rows.some(function(row){return JSON.stringify(row).includes(created.title);}),
      imageRowsRemain:rows.every(function(row){return row.type==='image';})};
    return {created:created,initialBlankLoop:initialBlankLoop,blankInsert:blankInsert,blankInsertUndo:blankInsertUndo,storage:storage,temporaryCount:allSongs.filter(function(song){return String(song.id).startsWith('temp-score-');}).length,
      dirty:scoreDrafts.status(temporaryId).dirty,sourceText:sourceText};
  })()`);
  assert.deepEqual(persistence.created, { id:'temp-score-1',title:'Browser temporary draft marker',beats:3,bpm:88,rests:true,sourceUnchanged:true }, 'blank-score UI creates a rest-only temporary score without mutating built-ins');
  assert.deepEqual(persistence.initialBlankLoop,{count:1,start:1,end:1},'new one-measure blank score starts with its full-measure loop');
  assert.deepEqual(persistence.blankInsert,{count:2,start:1,end:2},'inserting into a one-measure blank score expands its full-song loop');
  assert.deepEqual(persistence.blankInsertUndo,{count:1,start:1,end:1},'undo restores the one-measure blank score loop');
  assert.deepEqual(persistence.storage,{rowsHaveNoTemp:true,noDraftTitle:true,imageRowsRemain:true},'temporary score text is absent from localStorage and IndexedDB while image rows remain');
  assert.equal(persistence.temporaryCount,1,'created temporary score is listed in the current app session');
  assert.equal(persistence.dirty,true,'applied temporary score edit remains an in-memory draft');

  const copiedDraft=await client.evaluate(`(async function(){
    var previous=curSong,oldClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard'),copied='';
    var parsed=parseScore('[C] !1C4@2:i ~E4@1:p r r | "copy memo"',4);
    if(parsed.errors.length)throw new Error('TSV metadata fixture rejected: '+JSON.stringify(parsed.errors));
    try {
      curSong={id:'copy-metadata-fixture',title:'Copy metadata fixture',badge:'Capo 2',type:'structured',beats:4,bpm:77,capo:0,measures:parsed.measures};
      scoreEditorHooks.refreshStatus();
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:function(value){copied=value;return Promise.resolve();}}});
      document.getElementById('copyCurSongTsvBtn').click();
      await new Promise(function(resolve){setTimeout(resolve,0);});
      return {columns:copied.split('\t').length,hasChord:copied.includes('[C]'),hasApoyando:copied.includes('!1C4@2:i'),hasTirando:copied.includes('~E4@1:p'),hasMemo:copied.includes('copy memo'),hasCapo:copied.includes('Capo 2'),statusVisible:!document.getElementById('scoreCopyStatus').hidden};
    } finally {curSong=previous;if(oldClipboard)Object.defineProperty(navigator,'clipboard',oldClipboard);else try{delete navigator.clipboard;}catch(_){};renderSong();}
  })()`);
  assert.deepEqual(copiedDraft,{columns:5,hasChord:true,hasApoyando:true,hasTirando:true,hasMemo:true,hasCapo:true,statusVisible:true},'actual TSV copy preserves score metadata and reveals its result status');

  let beforeUnloadDialogs=0;
  client.dialogHandler = async params => {
    if(params.type==='beforeunload') beforeUnloadDialogs++;
    await client.send('Page.handleJavaScriptDialog',{accept:true});
  };
  await client.evaluate(`(function(){document.getElementById('addBlankScoreBtn').click();document.getElementById('cancelBlankScoreBtn').click();return true;})()`,{userGesture:true});
  const previousLoadCount=client.events.filter(event=>event.method==='Page.loadEventFired').length;
  await client.send('Page.reload',{ignoreCache:true});
  await waitForPageLoadAfter(client,previousLoadCount);
  await waitForCondition(client,'document.readyState === "complete" && window.allSongs && window.allSongs.length === 13 && window.curSong',8000);
  client.dialogHandler=null;
  assert.equal(beforeUnloadDialogs,1,'dirty temporary draft raises the native beforeunload confirmation');
  const reloadState=await client.evaluate(`({tempCount:allSongs.filter(function(song){return String(song.id).startsWith('temp-score-');}).length,
    dirty:scoreDrafts.status('builtin-lv1-butterfly').dirty,sourceScore:serializeScoreMeasures(BUILTIN_SONGS.find(function(song){return song.id==='builtin-lv1-butterfly';}).measures,'\\n')})`);
  assert.equal(reloadState.tempCount,0,'temporary scores disappear on reload');
  assert.equal(reloadState.dirty,false,'edited builtin draft disappears on reload');
  assert.equal(reloadState.sourceScore,persistence.sourceText,'builtin source remains unchanged after reload');
  process.stdout.write('Browser checkpoint: temporary score create/edit, guard, undo, session mapping, storage isolation, and reload loss passed\n');
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
    [[40,0.62,'tirando',6],[71,1.16,'apoyando',1]], 'Lv.6 opening bass and melody retain their written articulation and strings');
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

      var durationScore = parseScore('[C] ~0E2@6:p+!4B4@1:a - -', 3);
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
      check(oldMetadataPair.querySelectorAll('.tab-cell-lh').length === 0 && !oldMetadataPair.querySelector('.tab-cell-rh'), 'old inferred lh/rh metadata is ignored when original pair token has no LH digits');
      check(document.getElementById('guideLhTxt').textContent.indexOf('3줄 미지정 + 2줄 미지정') >= 0 && document.getElementById('guideRhTxt').textContent === '-', 'fretboard guide ignores old inferred hand metadata');

      var explicitHandText = '[C] 1C4 4D4@2 0E4 0G3@3+1C4@2';
      var explicitHandScore = parseScore(explicitHandText, 4);
      window.curSong = { id:'browser-explicit-left-hand', title:'Explicit LH', type:'structured', beats:4, measures:explicitHandScore.measures };
      renderSong();
      function pillLabels(beatIndex){
        return Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell[data-b="' + beatIndex + '"] .tab-fret-pill')).map(function(p){ return p.textContent.trim(); });
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
        return Array.prototype.slice.call(cell.querySelectorAll('.tab-note-rh')).map(function(span){ return span.textContent; });
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
          var markers=Array.from(document.querySelectorAll('#measuresGrid .tab-fret-pill.note-fret, #measuresGrid .tab-note-rh'));
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
            if(bounds.top<staveBounds.top||bounds.bottom>=staveBounds.bottom||!(bottomGap>0)||lineDelta>2){
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
      assert.ok(pillBounds.samples.every(function(sample){return sample.bottomGap>0 && sample.lineDelta<=2;}), 'TAB pills align with string lines and keep positive bottom clearance: '+JSON.stringify(pillBounds.samples.slice(-8)));
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
      if(!Array.isArray(window.BUILTIN_SONGS)||window.BUILTIN_SONGS.length!==13) throw new Error('Expected the 13-song built-in catalog');
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
      var fingers=firstMeasure?Array.from(firstMeasure.querySelectorAll('.tab-note-rh')).map(function(node){return node.textContent;}):[];
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
      if(events[0].note.midi!==40||events[0].gain!==0.62||events[0].articulation!=='tirando'||
        events[1].note.midi!==71||events[1].gain!==1.16||events[1].articulation!=='apoyando') throw new Error('Lv.6 opening bass/melody articulation or gain mismatch');
      var noArticulationGlyphs=tabLabels.concat(cardLabels,tabTitles,cardTitles).every(function(value){return !/[!~]/.test(value);});
      var cardTitleHasUniformArticulation=cardTitles.some(function(title){return title.indexOf('악보 지정 아포얀도')>=0||title.indexOf('악보 지정 티란도')>=0;});
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
    assert.equal(review.catalogCount, 13, 'all built-in scores are reviewed');
    assert.equal(review.rendered.length, 26, 'each built-in score renders in tab and card views');
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
    process.stdout.write('Browser checkpoint: all 13 built-in scores render in TAB/card; Lv.6 Romance first measure has explicit p/a/m/i and 10 timed guide notes\n');
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
async function main() {
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scriptTags = [...appHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scriptTags.map(src => src.split('?')[0]), ['src/storage.js', 'src/notation.js', 'src/rhythm.js', 'src/parser.js', 'src/score-drafts.js', 'src/score.js', 'src/audio.js', 'src/guide.js', 'src/image-analysis.js', 'src/fretboard.js', 'src/score-ui.js', 'src/sheets.js', 'src/score-editor.js', 'src/app.js'], 'app classic scripts keep the required order');
  assert.ok(scriptTags.every(src => src.endsWith('?v=click-mode-1')), 'all app scripts use the shared click mode revision');
  const htmlIds = ['addBlankScoreBtn','blankScoreModal','undoScoreEditBtn','resetScoreDraftBtn','scoreDraftStatus','copyCurSongTsvBtn'];
  htmlIds.forEach(function(id){assert.match(appHtml,new RegExp('id="'+id+'"'),'temporary score UI includes #'+id);});
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
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.allSongs.length === 13 && window.curSong != null', 8000);

    // Assert initial app state in real browser
    const songCount = await cdp.evaluate('window.allSongs.length');
    assert.equal(songCount, 13, 'browser loaded 13 songs from songs.json');

    const curSongId = await cdp.evaluate('window.curSong.id');
    assert.equal(curSongId, 'builtin-lv1-butterfly', 'default song selected in browser');

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
      '[C] C4 - - - | 너 / 나',
      '[G] G3 - - - | "https://example.test/a|b"'
    ])`);
    const canonicalColumns = canonicalTsv.split('\t');
    assert.equal(canonicalColumns.length, 5, 'canonical TSV keeps five columns');
    assert.ok(canonicalColumns[4].includes(' // '), 'canonical TSV joins measures with //');
    assert.equal(canonicalColumns[4].includes('\n'), false, 'canonical TSV score stays on one row');
    assert.ok(canonicalColumns[4].includes('| "너 / 나"'), 'slash lyric is JSON quoted and preserved');
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
      resetScoreButton:!!document.getElementById('resetScoreDraftBtn'),
      draftStatus:!!document.getElementById('scoreDraftStatus'),
      copyButtonInToolbar:!!(document.getElementById('copyCurSongTsvBtn')&&document.getElementById('copyCurSongTsvBtn').closest('.score-toolbar')),
      imageConversion:!!document.getElementById('convertImgToScoreBtn'),
      imageUpload:!!document.getElementById('uploadImgBtn'),
      barEditor:!!document.getElementById('barEditModal')
    })`);
    assert.deepEqual(scoreEditorUi, { editorApi:'undefined', editorInit:'undefined', promptApi:'undefined', scoreEditorHooks:'object', blankScoreButton:true,
      blankScoreModal:true, undoScoreButton:true, resetScoreButton:true, draftStatus:true, copyButtonInToolbar:true, imageConversion:false, imageUpload:true, barEditor:true },
      'temporary score editor is present without restoring the removed converter or AI prompt');
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

    // 3. Verify youtube quick links query excludes [Lv..] tags
    const ytLinkText = await cdp.evaluate('document.querySelector("#ytQuickLinks a") ? document.querySelector("#ytQuickLinks a").textContent : ""');
    assert.ok(ytLinkText.length > 0, "youtube quick links rendered");
    assert.equal(ytLinkText.includes("[Lv"), false, "youtube search query excludes [Lv..] tags");

    const previousLoadCount=cdp.events.filter(event=>event.method==='Page.loadEventFired').length;
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForPageLoadAfter(cdp,previousLoadCount);
    await waitForCondition(cdp, 'document.readyState === "complete" && window.allSongs && window.BUILTIN_SONGS.length === 13 && window.imageSongs.some(function(song){ return song.id === "browser-backup-image"; })', 8000);
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

    // Verify no unhandled console errors occurred
    assert.deepEqual(cdp.consoleErrors, [], 'no unhandled console errors in real browser execution');

    process.stdout.write('Result: browser smoke passed (clean boot, songs loaded, temporary score editing, image library, Web Audio, 0 console errors)\n');
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
