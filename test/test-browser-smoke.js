'use strict';

const {
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
} = require('./browser-harness');

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
  async function saveScreenshot(name,width,height,mobile){
    await client.send('Emulation.setDeviceMetricsOverride',{width:width,height:height,deviceScaleFactor:1,mobile:mobile});
    await client.evaluate('window.scrollTo(0,0)');
    const shot=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    const target=path.join(screenshotDir,name);
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
    const target=path.join(screenshotDir,name+'.png');
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

// 클릭음(0~200%)·연주음(0~100%) 슬라이더: 연주음은 기타 버스만 낮추고 클릭 버스는 그대로, 콘솔 행은 900px·1280px 에서 가로로 넘치지 않는다
async function testVolumeSliders(client){
  const errorsBefore = client.consoleErrors.length;
  const attrs = await client.evaluate(`(function(){
    var click = document.getElementById('volRange'), guitar = document.getElementById('guitarVolRange');
    return { click:!!click && [click.min, click.max, click.step], guitar:!!guitar && [guitar.min, guitar.max, guitar.step, guitar.value],
      guitarTitle:guitar ? guitar.parentElement.title : '' };
  })()`);
  assert.deepEqual(attrs.click, ['0', '200', '5'], 'the click slider goes from 0 to 200 percent');
  assert.deepEqual(attrs.guitar, ['0', '100', '5', '100'], 'the guitar slider goes from 0 to 100 percent and starts at 100');
  assert.match(attrs.guitarTitle, /메트로놈 클릭이 더 잘 들립니다/, 'the guitar slider explains why to lower it');

  const routing = await client.evaluate(`(async function(){
    var saved = { vol:appState.vol, guitarVol:appState.guitarVol };
    var wait = function(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); };
    try {
      ensureAudioCtx();
      var guitar = document.getElementById('guitarVolRange'), click = document.getElementById('volRange');
      var baseline = guitarBus.gain.value;
      guitar.value = '50'; guitar.dispatchEvent(new Event('input', { bubbles:true }));
      await wait(150);
      var half = { state:appState.guitarVol, bus:guitarBus.gain.value, click:clickBus.gain.value, saved:JSON.parse(localStorage.getItem('gs.state')).guitarVol };
      guitar.value = '100'; guitar.dispatchEvent(new Event('input', { bubbles:true }));
      await wait(150);
      var full = { state:appState.guitarVol, bus:guitarBus.gain.value };
      click.value = '200'; click.dispatchEvent(new Event('input', { bubbles:true }));
      var doubled = { state:appState.vol, saved:JSON.parse(localStorage.getItem('gs.state')).vol, shown:click.value };
      return { baseline:baseline, half:half, full:full, doubled:doubled };
    } finally {
      appState.vol = saved.vol; appState.guitarVol = saved.guitarVol;
      updateGuitarVolume(); syncConsoleUI(); saveAppState();
    }
  })()`);
  assert.ok(Math.abs(routing.baseline - 1) < 0.001, 'the guitar bus starts at its base gain');
  assert.equal(routing.half.state, 0.5, 'the guitar slider sets appState.guitarVol');
  assert.ok(Math.abs(routing.half.bus - routing.baseline * 0.5) < 0.001, 'the live guitar bus gain ends at half after the ramp (' + routing.half.bus + ')');
  assert.equal(routing.half.click, 1, 'the click bus gain is not touched by the guitar slider');
  assert.equal(routing.half.saved, 0.5, 'the guitar volume is saved in the app state');
  assert.ok(Math.abs(routing.full.bus - routing.baseline) < 0.001, 'moving the slider back restores the guitar bus gain');
  assert.deepEqual(routing.doubled, { state:2, saved:2, shown:'200' }, 'the click slider reaches 200 percent and saves it');

  const screenshotDir = path.join(root, 'test-artifacts');
  fs.mkdirSync(screenshotDir, { recursive:true });
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  for (const width of [900, 1280]){
    await client.send('Emulation.setDeviceMetricsOverride', { width, height:1000, deviceScaleFactor:1, mobile:false });
    await new Promise(resolve => setTimeout(resolve, 150));
    const row = await client.evaluate(`(function(){
      var pickRow = document.getElementById('beatsSelect').closest('.ctrl-row');
      var volumeRow = document.getElementById('volRange').closest('.ctrl-row');
      var box = pickRow.parentElement;
      box.scrollIntoView({ block:'center' });
      var b = box.getBoundingClientRect();
      function probe(rowEl){
        var items = Array.prototype.map.call(rowEl.children, function(el){ var c = el.getBoundingClientRect(); return { id:(el.querySelector('input,select') || el).id, left:c.left, right:c.right, top:c.top, height:c.height }; });
        var tops = [];
        items.forEach(function(item){ var t = item.top + item.height / 2; if (!tops.some(function(v){ return Math.abs(v - t) < 10; })) tops.push(t); });
        return { ids:items.map(function(item){ return item.id; }), scroll:rowEl.scrollWidth, client:rowEl.clientWidth, items:items, lines:tops.length };
      }
      return { sameBox:volumeRow.parentElement === box, volumeAfterPick:pickRow.nextElementSibling === volumeRow,
        pick:probe(pickRow), volume:probe(volumeRow), boxRight:b.right, boxLeft:b.left,
        page:document.documentElement.scrollWidth, inner:innerWidth,
        clip:{ x:Math.max(0, b.left - 8), y:Math.max(0, b.top - 8), width:b.width + 16, height:b.height + 16 } };
    })()`);
    assert.equal(row.sameBox && row.volumeAfterPick, true, width + 'px the volume row follows the pick row in the same box');
    assert.deepEqual(row.pick.ids, ['beatsSelect', 'clickModeSelect'], width + 'px the first console row holds the beat and click mode selects');
    assert.deepEqual(row.volume.ids, ['volRange', 'guitarVolRange'], width + 'px the second console row holds the two volume sliders');
    for (const name of ['pick', 'volume']){
      const part = row[name];
      assert.equal(part.lines, 1, width + 'px the ' + name + ' console row stays on one line');
      assert.ok(part.scroll <= part.client + 1, width + 'px the ' + name + ' console row has no horizontal overflow (' + part.scroll + ' > ' + part.client + ')');
      for (const item of part.items) assert.ok(item.right <= row.boxRight + 1 && item.left >= row.boxLeft - 1, width + 'px console item #' + item.id + ' stays inside its box');
    }
    assert.ok(row.page <= row.inner + 1, width + 'px page has no horizontal overflow (' + row.page + ' > ' + row.inner + ')');
    const shot = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false, clip:{ x:row.clip.x, y:row.clip.y, width:row.clip.width, height:row.clip.height, scale:1 } });
    const target = path.join(screenshotDir, 'practice-volume-sliders-' + width + '-dark.png');
    fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
    process.stdout.write('Artifact: ' + target + ' (console rows: ' + row.pick.lines + ' + ' + row.volume.lines + ' lines)\n');
  }
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] });
  await client.send('Emulation.setDeviceMetricsOverride', { width:1024, height:768, deviceScaleFactor:1, mobile:false });

  const beatsSelectState = await client.evaluate(`(function(){
    var sel = document.getElementById('beatsSelect');
    var isStructured = curSong && curSong.type === 'structured';
    var structuredDisabled = sel.disabled;
    var originalSong = curSong;
    var mockImage = { id:'mock-img', type:'image', beats:3, bpm:80 };
    curSong = mockImage;
    appState.beats = mockImage.beats;
    syncConsoleUI();
    var imageDisabled = sel.disabled;
    var imageVal = sel.value;
    curSong = originalSong;
    appState.beats = originalSong.beats;
    syncConsoleUI();
    return { isStructured: isStructured, structuredDisabled: structuredDisabled, imageDisabled: imageDisabled, imageVal: imageVal };
  })()`);
  assert.equal(beatsSelectState.isStructured, true, 'current song is structured');
  assert.equal(beatsSelectState.structuredDisabled, true, 'beatsSelect is disabled for structured songs');
  assert.equal(beatsSelectState.imageDisabled, false, 'beatsSelect is enabled for image songs');
  assert.equal(beatsSelectState.imageVal, '3', 'beatsSelect reflects image song beats');

  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the volume sliders raise no console errors');
  process.stdout.write('Browser checkpoint: click and guitar volume sliders passed\n');
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
        var countInTicks = mode === 'off' ? 0 : session.countInPositions.length;
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
      for (var countInIndex = 0; countInIndex < resumedSession.countInPositions.length; countInIndex++){
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
      check((koMainText === 'G+C' || koMainText === '솔+도') && pairCard.querySelector('.b-note-sub').textContent === 'G3+C4', 'beat card shows both pair solfege and octave names');
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

async function testBuiltinRomanceBounds(client){
  const boundReports=[];
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
      boundReports.push({viewport:viewport.label,width:viewport.width,height:viewport.height,count:pillBounds.count,
        minBottomGap:Math.min.apply(null,pillBounds.samples.map(function(sample){return sample.bottomGap;})),
        maxLineDelta:Math.max.apply(null,pillBounds.samples.map(function(sample){return sample.lineDelta;})),
        legacyFailureCount:boundsEvidence.legacy.failures.length,legacyFailures:boundsEvidence.legacy.failures,
        open6:boundsEvidence.open6,fret7:boundsEvidence.fret7});
    }
  } finally {
    await client.send('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false });
  }
  process.stdout.write('Browser checkpoint: Lv.6 Romance TAB/fretboard bounds passed (' + boundReports.length + ' viewports)\n');
}

async function testBuiltinScores(client){
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
    await testBuiltinRomanceBounds(client);
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

  // (2) 재생 중 활성 박: 활성 분할 알약 안 글자가 알약 글자색을 따른다
  const playing = await client.evaluate(`(async function(){
    document.getElementById('compactPlayBtn').click();
    var started = Date.now();
    while (Date.now() - started < 6000 && !(curBeatIdx >= 1 || curMeasureIdx >= 1)) await new Promise(function(resolve){ setTimeout(resolve, 30); });
    var pills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell.tab-cell.active-beat .tab-fret-pill.active-sub'));
    var allBeatPills = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell.tab-cell.active-beat .tab-fret-pill'));
    var result = pills.map(function(pill){
      var pillColor = getComputedStyle(pill).color;
      return Array.prototype.slice.call(pill.querySelectorAll('.fret-label, .fret-lh, .fret-rh')).map(function(node){ return getComputedStyle(node).color === pillColor; });
    });
    return { pillCount: pills.length, beatPillCount: allBeatPills.length, allFollow: result.every(function(list){ return list.length > 0 && list.every(Boolean); }), withArt: pills.filter(function(pill){ return !!pill.querySelector('.is-apoyando'); }).length };
  })()`);
  assert.ok(playing.pillCount > 0 && playing.withArt > 0, 'a playing beat highlights its active subdivision pill with written articulation');
  assert.ok(playing.beatPillCount > playing.pillCount, 'inactive subdivision pills inside the same active beat stay unhighlighted');
  assert.equal(playing.allFollow, true, 'inside the active subdivision pill the fret label and its figures follow the pill text color');
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
  assert.equal(input.artButtons, '|없음,!|! 아포얀도,h|<> 하모닉스,s|⌒ 슬러,g|/ 슬라이드', 'the articulation buttons are none, apoyando, harmonic, slur and slide: ' + input.artButtons);
  assert.ok(input.attrsText.indexOf('티란도') < 0, 'the input panel never mentions tirando');
  assert.equal(input.buttonApo, input.near, 'the apoyando button text is drawn in the --near color');
  assert.ok(/\bis-apoyando\b/.test(input.unsureClass) && /\bis-uncertain\b/.test(input.unsureParent), 'a checked note keeps its articulation class');
  assert.equal(input.unsureColor, input.off, 'a check mark (red) beats the articulation color');

  // 하모닉스 단추: 값은 NATURAL_HARMONICS, STRINGS에서 셈한다
  const harm = await client.evaluate(`(function(){
    var t = __tiTest;
    var table = GuitarNotation.NATURAL_HARMONICS;
    var hf = Number(Object.keys(table)[0]);
    var plainFret = 1;
    for (var f = 1; f <= 19; f++) { if (!Object.prototype.hasOwnProperty.call(table, f)) { plainFret = f; break; } }
    var string = GuitarParser.STRINGS[1];
    var hName = GuitarParser.noteNameForMidi(string.midi + table[hf], false);
    var plainName = GuitarParser.noteNameForMidi(string.midi + hf, false);
    var out = { hf: hf, hName: hName, plainName: plainName };
    function tokens(){ return t.text().split(/\\s+/); }
    function label(){ return t.pos(0,1,0,2).querySelector('.ti-pos-label'); }
    var hBtn = t.attr('art','h');
    t.pos(0,1,0,2).click();
    out.disabledEmpty = hBtn.disabled;
    t.fret(2, plainFret).click();
    out.disabledPlain = hBtn.disabled;
    t.fret(2, hf).click();
    out.disabledHarmonic = hBtn.disabled;
    hBtn.click();
    out.hTokens = tokens().filter(function(x){ return x.indexOf('h' + hName + '@2') >= 0; }).length;
    out.hLabel = label().textContent;
    out.hPressed = hBtn.getAttribute('aria-pressed');
    out.hDisabled = hBtn.disabled;
    t.attr('art','!').click();
    out.apoHTokens = tokens().filter(function(x){ return x.indexOf('h' + hName + '@2') >= 0; }).length;
    out.apoTokens = tokens().filter(function(x){ return x.indexOf('!' + plainName) === 0 && x.indexOf('@2') >= 0; }).length;
    out.apoHPressed = hBtn.getAttribute('aria-pressed');
    hBtn.click();
    t.attr('art','').click();
    out.noneHTokens = tokens().filter(function(x){ return x.indexOf('h' + hName + '@2') >= 0; }).length;
    out.nonePlain = tokens().filter(function(x){ return x.replace(/^[^A-G]*/, '').indexOf(plainName) === 0 && x.indexOf('@2') >= 0 && x.indexOf('h') < 0; }).length;
    out.noneLabel = label().textContent;
    return out;
  })()`);
  assert.equal(harm.disabledEmpty, true, 'the harmonic button is disabled without a cursor note');
  assert.equal(harm.disabledPlain, true, 'the harmonic button is disabled on a non-harmonic fret');
  assert.equal(harm.disabledHarmonic, false, 'the harmonic button is enabled on a harmonic fret');
  assert.ok(harm.hTokens >= 1, 'pressing it writes h + sounding pitch + @2: ' + JSON.stringify(harm));
  assert.ok(harm.hLabel.indexOf('<' + harm.hf + '>') >= 0, 'the TAB label shows <fret>: ' + harm.hLabel);
  assert.equal(harm.hPressed, 'true', 'the harmonic button is pressed while the note is a harmonic');
  assert.equal(harm.hDisabled, false, 'a harmonic note keeps the button enabled');
  assert.equal(harm.apoHTokens, 0, 'apoyando replaces the harmonic');
  assert.ok(harm.apoTokens >= 1, 'apoyando writes ! on the plain pitch: ' + JSON.stringify(harm));
  assert.equal(harm.apoHPressed, 'false', 'the harmonic button is released after apoyando');
  assert.equal(harm.noneHTokens, 0, 'none removes the harmonic');
  assert.ok(harm.nonePlain >= 1, 'none leaves the plain note of that fret: ' + JSON.stringify(harm));
  assert.ok(harm.noneLabel.indexOf('<') < 0, 'the TAB label has no brackets after none: ' + harm.noneLabel);

  // H 키 (타브 모드): 하모닉스 프렛이면 켜고 끄고, 아니면 안내만 하고 바꾸지 않는다
  const hkey = await client.evaluate(`(function(){
    var t = __tiTest;
    var table = GuitarNotation.NATURAL_HARMONICS;
    var hf = Number(Object.keys(table)[0]);
    var plainFret = 1;
    for (var f = 1; f <= 19; f++) { if (!Object.prototype.hasOwnProperty.call(table, f)) { plainFret = f; break; } }
    var hName = GuitarParser.noteNameForMidi(GuitarParser.STRINGS[1].midi + table[hf], false);
    function press(){ var e = new KeyboardEvent('keydown', { key:'h', code:'KeyH', bubbles:true, cancelable:true }); document.body.dispatchEvent(e); return e.defaultPrevented; }
    function count(){ return t.text().split(/\\s+/).filter(function(x){ return x.indexOf('h' + hName + '@2') >= 0; }).length; }
    var out = {};
    t.pos(0,1,0,2).click();
    if (!t.pos(0,1,0,2).querySelector('.ti-pos-label') || t.pos(0,1,0,2).querySelector('.ti-pos-label').textContent.indexOf(String(hf)) !== 0) t.fret(2, hf).click(); // 같은 프렛을 다시 누르면 지워지니 음이 없을 때만 넣는다
    out.beforeOn = count();
    out.prevented = press();
    out.on = count();
    out.pressed = t.attr('art','h').getAttribute('aria-pressed');
    press();
    out.off = count();
    t.fret(2, plainFret).click();
    var textBefore = t.text();
    press();
    out.plainStatus = document.getElementById('tiStatus').textContent;
    out.plainSame = t.text() === textBefore;
    out.expectedStatus = '하모닉스는 ' + GuitarNotation.naturalHarmonicFretsText() + '프렛 음에서만 됩니다.';
    out.tabHint = document.getElementById('tiTabHint').textContent;
    out.staffHint = document.getElementById('tiStaffHint').textContent;
    return out;
  })()`);
  assert.equal(hkey.beforeOn, 0, 'a plain harmonic-fret note is not a harmonic yet');
  assert.equal(hkey.prevented, true, 'the H key is handled');
  assert.ok(hkey.on >= 1, 'H turns a harmonic-fret note into h + sounding pitch + @2: ' + JSON.stringify(hkey));
  assert.equal(hkey.pressed, 'true', 'the harmonic button shows the harmonic state after H');
  assert.equal(hkey.off, 0, 'H again turns the harmonic off');
  assert.equal(hkey.plainStatus, hkey.expectedStatus, 'H on a non-harmonic fret says where harmonics work: ' + hkey.plainStatus);
  assert.equal(hkey.plainSame, true, 'H on a non-harmonic fret leaves the score text alone');
  assert.ok(hkey.tabHint.indexOf('H 하모닉스') >= 0, 'the tab hint mentions H: ' + hkey.tabHint);
  assert.ok(hkey.staffHint.indexOf('H 하모닉스') >= 0, 'the staff hint mentions H: ' + hkey.staffHint);
  assert.ok(hkey.tabHint.indexOf('S 슬러') >= 0, 'the tab hint mentions S: ' + hkey.tabHint);
  assert.ok(hkey.staffHint.indexOf('S 슬러') >= 0, 'the staff hint mentions S: ' + hkey.staffHint);
  assert.ok(hkey.tabHint.indexOf('/ 슬라이드') >= 0, 'the tab hint mentions /: ' + hkey.tabHint);
  assert.ok(hkey.staffHint.indexOf('/ 슬라이드') >= 0, 'the staff hint mentions /: ' + hkey.staffHint);

  // 슬러 단추와 S 키 (타브 모드): 앞의 같은 줄 음과 이어질 때만 켜고, 아니면 까닭을 상태 줄에 안내하고 문서는 그대로 둔다
  const slurTab = await client.evaluate(`(function(){
    var t = __tiTest;
    document.getElementById('tiNewBtn').click();
    var out = {};
    function put(c, str, fret){ t.pos(0,c,0,str).click(); t.fret(str, fret).click(); }
    function press(){ var e = new KeyboardEvent('keydown', { key:'s', code:'KeyS', bubbles:true, cancelable:true }); document.body.dispatchEvent(e); return e.defaultPrevented; }
    function status(){ return document.getElementById('tiStatus').textContent; }
    function token(c){ return t.text().split('\\n')[0].split(' ')[c + 1]; }
    var sBtn = t.attr('art','s');
    put(0, 2, 3); put(1, 2, 5); put(2, 2, 5); put(3, 3, 1);
    t.pos(0,0,0,2).click();
    out.firstDisabled = sBtn.disabled;
    t.pos(0,1,0,2).click();
    out.hammerDisabled = sBtn.disabled;
    out.hammerPressedBefore = sBtn.getAttribute('aria-pressed');
    sBtn.click();
    out.btnToken = token(1);
    out.btnPressed = sBtn.getAttribute('aria-pressed');
    sBtn.click();
    out.btnAgain = token(1);
    out.prevented = press();
    out.keyOff = token(1);
    out.keyOffPressed = sBtn.getAttribute('aria-pressed');
    press();
    out.keyOn = token(1);
    out.unslurred = [token(0), token(2), token(3)];
    t.pos(0,2,0,2).click();
    out.sameDisabled = sBtn.disabled;
    var before = t.text();
    out.samePrevented = press();
    out.sameStatus = status();
    out.sameUnchanged = t.text() === before;
    t.pos(0,3,0,3).click();
    out.noSourceDisabled = sBtn.disabled;
    before = t.text();
    press();
    out.noSourceStatus = status();
    out.noSourceUnchanged = t.text() === before;
    t.pos(0,1,0,1).click();
    out.noNoteDisabled = sBtn.disabled;
    before = t.text();
    press();
    out.noNoteStatus = status();
    out.noNoteUnchanged = t.text() === before;
    return out;
  })()`);
  assert.equal(slurTab.firstDisabled, true, 'the slur button is disabled on a note with no earlier note on its string');
  assert.equal(slurTab.hammerDisabled, false, 'the slur button is enabled when the note links to an earlier note on the same string');
  assert.equal(slurTab.hammerPressedBefore, 'false', 'the slur button is released before it is used');
  assert.ok(slurTab.btnToken.charAt(0) === 's', 'the slur button writes s on the token: ' + JSON.stringify(slurTab));
  assert.equal(slurTab.btnPressed, 'true', 'the slur button is pressed on a slur note');
  assert.equal(slurTab.btnAgain, slurTab.btnToken, 'the button on a slur note leaves it as it is');
  assert.equal(slurTab.prevented, true, 'the S key is handled');
  assert.ok(slurTab.keyOff.charAt(0) !== 's' && slurTab.keyOff === slurTab.btnToken.slice(1), 'S on a slur note turns it off: ' + JSON.stringify(slurTab));
  assert.equal(slurTab.keyOffPressed, 'false', 'the slur button is released after S');
  assert.equal(slurTab.keyOn, slurTab.btnToken, 'S turns it on again');
  assert.ok(slurTab.unslurred.every(token => token.charAt(0) !== 's'), 'the other notes stay plain: ' + JSON.stringify(slurTab.unslurred));
  assert.equal(slurTab.sameDisabled, true, 'the slur button is disabled on a note with the same pitch as the earlier one');
  assert.equal(slurTab.samePrevented, true, 'S is handled even when it cannot turn the slur on');
  assert.equal(slurTab.sameStatus, '앞의 같은 줄 음과 높이가 같아 슬러로 이을 수 없습니다.', 'S on the same pitch says why: ' + slurTab.sameStatus);
  assert.equal(slurTab.sameUnchanged, true, 'S on the same pitch leaves the score text alone');
  assert.equal(slurTab.noSourceDisabled, true, 'the slur button is disabled when the string has no earlier note');
  assert.equal(slurTab.noSourceStatus, '앞에 같은 줄 음이 없어 슬러로 이을 수 없습니다.', 'S with no earlier note says why: ' + slurTab.noSourceStatus);
  assert.equal(slurTab.noSourceUnchanged, true, 'S with no earlier note leaves the score text alone');
  assert.equal(slurTab.noNoteDisabled, true, 'the slur button is disabled without a cursor note');
  assert.equal(slurTab.noNoteStatus, '슬러로 바꿀 음이 없습니다.', 'S without a note says so: ' + slurTab.noNoteStatus);
  assert.equal(slurTab.noNoteUnchanged, true, 'S without a note leaves the score text alone');

  // 슬라이드 단추와 / 키 (타브 모드): 슬러와 같은 판정. 켜는 토큰은 g 로 시작하고, 이을 수 없으면 까닭을 상태 줄에 안내하고 문서는 그대로 둔다
  const slideErrorsBefore = client.consoleErrors.length;
  const slideTab = await client.evaluate(`(function(){
    var t = __tiTest;
    document.getElementById('tiNewBtn').click();
    var out = {};
    function put(c, str, fret){ t.pos(0,c,0,str).click(); t.fret(str, fret).click(); }
    function press(){ var e = new KeyboardEvent('keydown', { key:'/', code:'Slash', bubbles:true, cancelable:true }); document.body.dispatchEvent(e); return e.defaultPrevented; }
    function status(){ return document.getElementById('tiStatus').textContent; }
    function token(c){ return t.text().split('\\n')[0].split(' ')[c + 1]; }
    var gBtn = t.attr('art','g');
    out.hasButton = !!gBtn;
    put(0, 2, 3); put(1, 2, 5); put(2, 2, 5); put(3, 3, 1);
    t.pos(0,0,0,2).click();
    out.firstDisabled = gBtn.disabled;
    t.pos(0,1,0,2).click();
    out.hammerDisabled = gBtn.disabled;
    out.hammerPressedBefore = gBtn.getAttribute('aria-pressed');
    gBtn.click();
    out.btnToken = token(1);
    out.btnPressed = gBtn.getAttribute('aria-pressed');
    out.slurPressed = t.attr('art','s').getAttribute('aria-pressed');
    gBtn.click();
    out.btnAgain = token(1);
    out.prevented = press();
    out.keyOff = token(1);
    out.keyOffPressed = gBtn.getAttribute('aria-pressed');
    press();
    out.keyOn = token(1);
    out.unslid = [token(0), token(2), token(3)];
    t.pos(0,2,0,2).click();
    out.sameDisabled = gBtn.disabled;
    var before = t.text();
    out.samePrevented = press();
    out.sameStatus = status();
    out.sameUnchanged = t.text() === before;
    t.pos(0,3,0,3).click();
    out.noSourceDisabled = gBtn.disabled;
    before = t.text();
    press();
    out.noSourceStatus = status();
    out.noSourceUnchanged = t.text() === before;
    t.pos(0,1,0,1).click();
    out.noNoteDisabled = gBtn.disabled;
    before = t.text();
    press();
    out.noNoteStatus = status();
    out.noNoteUnchanged = t.text() === before;
    t.pos(0,1,0,2).click();
    before = t.text();
    var shiftEvent = new KeyboardEvent('keydown', { key:'?', code:'Slash', shiftKey:true, bubbles:true, cancelable:true });
    document.body.dispatchEvent(shiftEvent);
    out.shiftIgnored = t.text() === before && !shiftEvent.defaultPrevented;
    return out;
  })()`);
  assert.equal(slideTab.hasButton, true, 'the input panel has the slide button');
  assert.equal(slideTab.firstDisabled, true, 'the slide button is disabled on a note with no earlier note on its string');
  assert.equal(slideTab.hammerDisabled, false, 'the slide button is enabled when the note links to an earlier note on the same string');
  assert.equal(slideTab.hammerPressedBefore, 'false', 'the slide button is released before it is used');
  assert.ok(slideTab.btnToken.charAt(0) === 'g', 'the slide button writes g on the token: ' + JSON.stringify(slideTab));
  assert.equal(slideTab.btnPressed, 'true', 'the slide button is pressed on a slide note');
  assert.equal(slideTab.slurPressed, 'false', 'the slur button is released on a slide note');
  assert.equal(slideTab.btnAgain, slideTab.btnToken, 'the button on a slide note leaves it as it is');
  assert.equal(slideTab.prevented, true, 'the / key is handled');
  assert.ok(slideTab.keyOff.charAt(0) !== 'g' && slideTab.keyOff === slideTab.btnToken.slice(1), '/ on a slide note turns it off: ' + JSON.stringify(slideTab));
  assert.equal(slideTab.keyOffPressed, 'false', 'the slide button is released after /');
  assert.equal(slideTab.keyOn, slideTab.btnToken, '/ turns it on again');
  assert.ok(slideTab.unslid.every(token => token.charAt(0) !== 'g'), 'the other notes stay plain: ' + JSON.stringify(slideTab.unslid));
  assert.equal(slideTab.sameDisabled, true, 'the slide button is disabled on a note with the same pitch as the earlier one');
  assert.equal(slideTab.samePrevented, true, '/ is handled even when it cannot turn the slide on');
  assert.equal(slideTab.sameStatus, '앞의 같은 줄 음과 높이가 같아 슬라이드로 이을 수 없습니다.', '/ on the same pitch says why: ' + slideTab.sameStatus);
  assert.equal(slideTab.sameUnchanged, true, '/ on the same pitch leaves the score text alone');
  assert.equal(slideTab.noSourceDisabled, true, 'the slide button is disabled when the string has no earlier note');
  assert.equal(slideTab.noSourceStatus, '앞에 같은 줄 음이 없어 슬라이드로 이을 수 없습니다.', '/ with no earlier note says why: ' + slideTab.noSourceStatus);
  assert.equal(slideTab.noSourceUnchanged, true, '/ with no earlier note leaves the score text alone');
  assert.equal(slideTab.noNoteDisabled, true, 'the slide button is disabled without a cursor note');
  assert.equal(slideTab.noNoteStatus, '슬라이드로 바꿀 음이 없습니다.', '/ without a note says so: ' + slideTab.noNoteStatus);
  assert.equal(slideTab.noNoteUnchanged, true, '/ without a note leaves the score text alone');
  assert.equal(slideTab.shiftIgnored, true, 'Shift+/ (?) does not toggle the slide');

  // 슬라이드 들어보기: 슬라이드 음은 출발 음(카포 반영) 높이에서 미끄러지고, 평범한 음은 미끄럼 옵션이 없다
  const slidePlay = await client.evaluate(`(function(){
    var t = __tiTest;
    document.getElementById('tiNewBtn').click();
    function put(c, str, fret){ t.pos(0,c,0,str).click(); t.fret(str, fret).click(); }
    function press(key, code){ var e = new KeyboardEvent('keydown', { key:key, code:code, bubbles:true, cancelable:true }); document.body.dispatchEvent(e); return e.defaultPrevented; }
    put(0, 2, 3); put(1, 2, 5);
    var select = document.getElementById('tiCapoSelect'); select.value = '2'; select.dispatchEvent(new Event('change', { bubbles:true }));
    t.pos(0,1,0,2).click();
    t.attr('art','g').click();
    var original = window.playGuitarNote;
    var calls = [];
    window.playGuitarNote = function(midi, dur, when, gain, art, str, options){ calls.push({ midi: midi, dur: dur, art: art, str: str, options: options, gain: gain }); };
    var out = { capo: curCapo() };
    try {
      press(' ', 'Space');
      out.slide = calls.slice(); calls.length = 0;
      t.pos(0,0,0,2).click(); calls.length = 0;
      press(' ', 'Space');
      out.plain = calls.slice(); calls.length = 0;
      t.pos(0,1,0,2).click(); calls.length = 0;
      document.getElementById('tiPlaySlotBtn').click();
      out.byButton = calls.slice(); calls.length = 0;
      t.pos(0,0,0,2).click();
      t.attr('art','!').click(); calls.length = 0;
      press(' ', 'Space');
      out.apoyando = calls.slice(); calls.length = 0;
    } finally { window.playGuitarNote = original; }
    out.slurGain = SLUR_GAIN;
    out.apoyandoGain = APOYANDO_GAIN;
    out.expectedFrom = GuitarParser.STRINGS[1].midi + 3 + out.capo;
    out.expectedTo = GuitarParser.STRINGS[1].midi + 5 + out.capo;
    out.expectedSec = Math.min(SLIDE_GLIDE_SEC, 1.6 * SLIDE_MAX_SHARE);
    select.value = '0'; select.dispatchEvent(new Event('change', { bubbles:true }));
    return out;
  })()`);
  assert.equal(slidePlay.capo, 2, 'the slide play test runs with a capo');
  assert.equal(slidePlay.slide.length, 1, 'the slide note plays once: ' + JSON.stringify(slidePlay.slide));
  assert.equal(slidePlay.slide[0].midi, slidePlay.expectedTo, 'the slide note sounds at its own pitch with the capo');
  assert.equal(slidePlay.slide[0].art, 'slide', 'the slide note is played with the slide articulation');
  assert.ok(slidePlay.slide[0].options && slidePlay.slide[0].options.glide, 'the slide note passes a glide option: ' + JSON.stringify(slidePlay.slide[0]));
  assert.equal(slidePlay.slide[0].options.glide.fromMidi, slidePlay.expectedFrom, 'the glide starts at the earlier note pitch with the capo');
  assert.ok(Math.abs(slidePlay.slide[0].options.glide.sec - slidePlay.expectedSec) < 1e-9, 'the glide lasts the shared slide time: ' + slidePlay.slide[0].options.glide.sec);
  assert.equal(slidePlay.plain.length, 1, 'a plain note plays once');
  assert.ok(!slidePlay.plain[0].options || !slidePlay.plain[0].options.glide, 'a plain note has no glide: ' + JSON.stringify(slidePlay.plain[0]));
  assert.equal(slidePlay.byButton.length, 1, 'the play button plays the slide note');
  assert.equal(slidePlay.byButton[0].options && slidePlay.byButton[0].options.glide && slidePlay.byButton[0].options.glide.fromMidi, slidePlay.expectedFrom, 'the play button glides too');
  // 입력 화면 들어보기도 연습 화면처럼 주법별 gain(articulationGain)으로 친다
  assert.ok(slidePlay.slurGain < 1 && slidePlay.apoyandoGain > 1, 'the gain constants are readable as page globals');
  assert.equal(slidePlay.slide[0].gain, slidePlay.slurGain, 'the slide note plays at SLUR_GAIN: ' + slidePlay.slide[0].gain);
  assert.equal(slidePlay.byButton[0].gain, slidePlay.slurGain, 'the play button plays the slide note at SLUR_GAIN too');
  assert.equal(slidePlay.plain[0].gain, 1, 'a plain note plays at gain 1');
  assert.equal(slidePlay.apoyando.length, 1, 'the apoyando note plays once: ' + JSON.stringify(slidePlay.apoyando));
  assert.equal(slidePlay.apoyando[0].art, 'apoyando');
  assert.equal(slidePlay.apoyando[0].gain, slidePlay.apoyandoGain, 'the apoyando note plays at APOYANDO_GAIN: ' + slidePlay.apoyando[0].gain);
  assert.deepEqual(client.consoleErrors.slice(slideErrorsBefore), [], 'the slide input steps run without console errors');

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

// 자연 하모닉스(h): 연습 화면의 TAB 알약 <손 대는 프렛>, 지판 마름모 마커, 오선 마름모 머리. 값은 NATURAL_HARMONICS에서 셈한다.
async function testNaturalHarmonics(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const errorsBefore = client.consoleErrors.length;
  const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/index.html` });
  await waitForPageLoadAfter(client, before);
  await waitForCondition(client, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null', 8000);

  const result = await client.evaluate(`(function(){
    var table = GuitarNotation.NATURAL_HARMONICS;
    var handFret = Number(Object.keys(table)[0]);
    var string = GuitarParser.STRINGS[1];
    var soundName = GuitarParser.noteNameForMidi(string.midi + table[handFret], false);
    var plainFret = 3;
    var plainName = GuitarParser.noteNameForMidi(GuitarParser.STRINGS[0].midi + plainFret, false);
    var bassName = GuitarParser.noteNameForMidi(GuitarParser.STRINGS[5].midi, false);
    var topName = GuitarParser.noteNameForMidi(GuitarParser.STRINGS[0].midi + table[handFret], false);
    var lines = ['[-] h' + soundName + '@' + string.str + ' ' + plainName + '@1 ' + bassName + '@6+h' + topName + '@1 -'];
    var song = scoreDrafts.createFromScore({ title: '하모닉스 시험', beats: 4, bpm: 60, lines: lines, origin: 'tab-input' });
    rebuildSongSelect(song.id);
    var s = document.getElementById('scoreViewSelect'); s.value = 'both'; s.dispatchEvent(new Event('change', { bubbles: true }));
    appState.clickMode = 'off';
    function pills(beat){
      var cell = document.querySelector('#measuresGrid .beat-cell[data-m="0"][data-b="' + beat + '"]');
      return Array.prototype.map.call(cell.querySelectorAll('.tab-fret-pill'), function(pill){
        var label = pill.querySelector('.fret-label');
        return { top: pill.style.top, text: pill.textContent, cls: label.className, held: pill.classList.contains('tab-held-fret') };
      });
    }
    var out = { handFret: handFret, harmonic: pills(0), plain: pills(1), chord: pills(2), held: pills(3), plainFret: plainFret };
    // 지판: 하모닉스를 목표로 칠한다
    var beat0 = curSong.measures[0].beats[0];
    highlightFretboard('', beat0, false, false, 0);
    var marker = document.querySelector('#fretboard .fb-cell[data-str="' + string.str + '"][data-fret="' + handFret + '"] .fb-marker.target-note');
    var shown = marker && getComputedStyle(marker);
    var before = marker && getComputedStyle(marker, '::before');
    out.marker = marker && { cls: marker.className, text: marker.textContent, bg: shown.backgroundColor, matrix: shown.transform, beforeTransform: before.transform, beforeBg: before.backgroundColor, beforeContent: before.content };
    highlightFretboard('', curSong.measures[0].beats[1], false, false, 1);
    var plainMarker = document.querySelector('#fretboard .fb-marker.target-note');
    out.plainMarkerCls = plainMarker && plainMarker.className;
    highlightFretboard('', curSong.measures[0].beats[2], false, false, 2);
    out.chordMarkers = Array.prototype.map.call(document.querySelectorAll('#fretboard .fb-marker.target-note'), function(el){ return el.className; });
    // 오선: 손 대는 자리 음에 마름모
    out.staffPolygons = document.querySelectorAll('#measuresGrid .tab-staff-layer polygon.st-head.is-harmonic').length;
    out.staffEllipses = document.querySelectorAll('#measuresGrid .tab-staff-layer ellipse.st-head').length;
    updateActiveCursor(0, 0, false);
    return out;
  })()`);
  const handFret = result.handFret;
  assert.equal(result.harmonic.length, 1, 'one pill for the harmonic beat');
  assert.equal(result.harmonic[0].text, '<' + handFret + '>', 'the harmonic pill shows the hand fret in angle brackets: ' + result.harmonic[0].text);
  assert.ok(/\bis-harmonic\b/.test(result.harmonic[0].cls), 'the harmonic label has is-harmonic: ' + result.harmonic[0].cls);
  assert.equal(result.plain[0].text, String(result.plainFret), 'a plain note keeps its bare fret');
  assert.ok(!/\bis-harmonic\b/.test(result.plain[0].cls), 'a plain note is not is-harmonic');
  const chordTexts = result.chord.map(pill => pill.text).sort();
  assert.deepEqual(chordTexts, ['0', '<' + handFret + '>'].sort(), 'a chord marks only the harmonic component');
  assert.ok(result.held.length >= 1 && result.held.every(pill => pill.held), 'the held beat shows ghost pills');
  assert.ok(result.held.some(pill => pill.text === '<' + handFret + '>' && /\bis-harmonic\b/.test(pill.cls)), 'a held harmonic keeps the hand position label');
  assert.ok(result.marker, 'the harmonic target gets a marker on the hand fret');
  assert.ok(/\bis-harmonic\b/.test(result.marker.cls), 'the target marker has is-harmonic: ' + result.marker.cls);
  assert.equal(result.marker.bg, 'rgba(0, 0, 0, 0)', 'the harmonic marker itself is transparent (the diamond is its ::before)');
  const matrix = result.marker.matrix.match(/matrix\(([^)]+)\)/);
  assert.ok(matrix, 'marker transform is a matrix: ' + result.marker.matrix);
  const parts = matrix[1].split(',').map(Number);
  assert.ok(Math.abs(parts[0] - 1) < 1e-6 && Math.abs(parts[1]) < 1e-6, 'the marker text is not rotated: ' + result.marker.matrix);
  const behind = result.marker.beforeTransform.match(/matrix\(([^)]+)\)/);
  assert.ok(behind, 'the diamond has a transform: ' + result.marker.beforeTransform);
  const behindParts = behind[1].split(',').map(Number);
  assert.ok(Math.abs(Math.abs(behindParts[0]) - Math.SQRT1_2) < 1e-3 && Math.abs(Math.abs(behindParts[1]) - Math.SQRT1_2) < 1e-3, 'the diamond is rotated 45 degrees: ' + result.marker.beforeTransform);
  assert.notEqual(result.marker.beforeBg, 'rgba(0, 0, 0, 0)', 'the diamond is filled');
  assert.ok(!/\bis-harmonic\b/.test(result.plainMarkerCls), 'a plain target marker is not a diamond: ' + result.plainMarkerCls);
  assert.deepEqual(result.chordMarkers.map(cls => /\bis-harmonic\b/.test(cls)).sort(), [false, true], 'in a chord only the harmonic component marker is a diamond: ' + result.chordMarkers.join(' | '));
  assert.ok(result.staffPolygons >= 2, 'the staff draws the harmonic heads as polygons: ' + result.staffPolygons);
  assert.ok(result.staffEllipses >= 1, 'plain notes keep ellipse heads');

  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  const target = path.join(root, 'test-artifacts', 'practice-harmonic.png');
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  process.stdout.write('Artifact: ' + target + '\n');
  await client.evaluate(`highlightFretboard('', curSong.measures[0].beats[0], false, false, 0); document.getElementById('fretboard').scrollIntoView({ block: 'center' }); true`);
  const fbShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const fbTarget = path.join(root, 'test-artifacts', 'practice-harmonic-fretboard.png');
  fs.writeFileSync(fbTarget, Buffer.from(fbShot.data, 'base64'));
  process.stdout.write('Artifact: ' + fbTarget + '\n');

  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the natural harmonic steps run without console errors');
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: natural harmonic TAB label, fretboard diamond marker, staff diamond head passed\n');
}

// 슬러(s): 연습 화면 TAB 알약은 프렛 앞에 방향 글자(h 해머링, p 풀링)를 붙이고, 악보 입력 화면 카드도 같은 글자를 보인다. 프렛 값은 파서로 셈한다.
async function testSlurLabels(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const errorsBefore = client.consoleErrors.length;
  async function loadPage(url, readyExpression) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, readyExpression, 8000);
  }
  const slurLines = [
    '[-] E4@1 sF4@1 - sE4@1 | ""',
    '[-] E4@1/sF4@1/sE4@1 - - r | ""',
    '[-] E2@6+E4@1 E2@6+sF4@1 - r | ""'
  ];
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await loadPage(`http://127.0.0.1:${httpPort}/index.html`, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null');
  const practice = await client.evaluate(`(function(){
    var lines = ${JSON.stringify(slurLines)};
    var song = scoreDrafts.createFromScore({ title: '슬러 시험', beats: 4, bpm: 60, lines: lines, origin: 'tab-input' });
    rebuildSongSelect(song.id);
    var s = document.getElementById('scoreViewSelect'); s.value = 'both'; s.dispatchEvent(new Event('change', { bubbles: true }));
    appState.clickMode = 'off';
    function pills(m, b){
      var cell = document.querySelector('#measuresGrid .beat-cell[data-m="' + m + '"][data-b="' + b + '"]');
      return Array.prototype.map.call(cell.querySelectorAll('.tab-fret-pill'), function(pill){
        var label = pill.querySelector('.fret-label');
        var mark = label.querySelector('.fret-slur');
        return { top: pill.style.top, text: pill.textContent, cls: label.className, mark: mark && mark.textContent, markFirst: !!mark && label.firstChild === mark, held: pill.classList.contains('tab-held-fret'), left: parseFloat(pill.style.left) || 0 };
      }).sort(function(a, b){ return a.left - b.left || a.top.localeCompare(b.top); });
    }
    var out = {
      openFret: GuitarParser.parseNoteToken('E4@1', 0).pos.fret,
      upFret: GuitarParser.parseNoteToken('F4@1', 0).pos.fret,
      plain: pills(0, 0), hammer: pills(0, 1), held: pills(0, 2), pull: pills(0, 3),
      split: pills(1, 0), chord: pills(2, 1),
      staffEllipses: document.querySelectorAll('#measuresGrid .tab-staff-layer ellipse.st-head').length,
      staffSlurs: document.querySelectorAll('#measuresGrid .tab-staff-layer path.st-slur').length,
      mark: (function(){ var el = document.querySelector('#measuresGrid .fret-slur'); var cs = getComputedStyle(el); var label = getComputedStyle(el.parentNode); return { fontSize: parseFloat(cs.fontSize), labelFontSize: parseFloat(label.fontSize), weight: cs.fontWeight, opacity: cs.opacity, color: cs.color, labelColor: label.color }; })()
    };
    updateActiveCursor(0, 0, false);
    return out;
  })()`);
  const open = String(practice.openFret);
  const up = String(practice.upFret);
  assert.deepEqual(practice.plain.map(pill => pill.text), [open], 'a plain note has no direction letter');
  assert.ok(!/\bis-slur\b/.test(practice.plain[0].cls) && practice.plain[0].mark === null, 'a plain note has no slur mark');
  assert.deepEqual(practice.hammer.map(pill => pill.text), ['h' + up], 'a higher slurred note reads h + fret: ' + JSON.stringify(practice.hammer));
  assert.ok(/\bis-slur\b/.test(practice.hammer[0].cls) && practice.hammer[0].markFirst && practice.hammer[0].mark === 'h', 'the letter is a .fret-slur span before the fret number');
  assert.deepEqual(practice.pull.map(pill => pill.text), ['p' + open], 'a lower slurred note reads p + fret: ' + JSON.stringify(practice.pull));
  assert.ok(practice.pull[0].markFirst && practice.pull[0].mark === 'p');
  assert.ok(practice.held.length >= 1 && practice.held.every(pill => pill.held && pill.mark === null && !/\bis-slur\b/.test(pill.cls)), 'a held pill shows no slur mark: ' + JSON.stringify(practice.held));
  assert.deepEqual(practice.split.map(pill => pill.text), [open, 'h' + up, 'p' + open], 'subdivided slurs read h then p: ' + JSON.stringify(practice.split));
  assert.deepEqual(practice.chord.map(pill => pill.text).sort(), ['h' + up, open].sort(), 'in a chord only the slurred component has the letter: ' + JSON.stringify(practice.chord));
  assert.ok(practice.staffEllipses >= 1, 'the staff draws slurred notes as ordinary heads');
  assert.equal(practice.staffSlurs, 5, 'the staff layer draws one curve per slurred note (2 + 2 + 1): ' + practice.staffSlurs);
  assert.ok(practice.mark.fontSize < practice.mark.labelFontSize, 'the direction letter is smaller than the fret number: ' + JSON.stringify(practice.mark));
  assert.ok(Number(practice.mark.opacity) < 1 && Number(practice.mark.weight) >= 700, 'the letter is bold and slightly faded: ' + JSON.stringify(practice.mark));
  assert.equal(practice.mark.color, practice.mark.labelColor, 'the slur mark does not change the color');
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  const target = path.join(root, 'test-artifacts', 'practice-slur.png');
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  process.stdout.write('Artifact: ' + target + '\n');

  // 악보 입력 화면: 불러온 슬러 카드의 글자. 앞 음을 쉼으로 바꾸면 슬러가 끊겨 방향 없이 ⌒로 보이고 검사가 오류를 낸다.
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  const inputReady = 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1';
  await client.evaluate(`(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`);
  await loadPage(inputUrl, inputReady);
  await client.evaluate(`(function(){
    window.confirm = function(){ return true; };
    document.getElementById('tiImportBtn').click();
    var area = document.getElementById('tiImportText');
    area.value = ${JSON.stringify(slurLines.join('\n'))};
    area.dispatchEvent(new Event('input', { bubbles:true }));
    document.getElementById('tiImportApplyBtn').click();
    return true;
  })()`);
  assert.equal(await client.evaluate(`document.getElementById('tiImportError').textContent`), '', 'the slur score imports without error');
  const readLabels = () => client.evaluate(`(function(){
    function label(m, c, s, str){ var node = document.querySelector('.ti-slot[data-m="' + m + '"][data-c="' + c + '"][data-s="' + s + '"] .ti-pos[data-str="' + str + '"] .ti-pos-label'); return node && node.textContent; }
    return { plain: label(0, 0, 0, 1), hammer: label(0, 1, 0, 1), pull: label(0, 3, 0, 1), splitHammer: label(1, 0, 1, 1), splitPull: label(1, 0, 2, 1), chordTop: label(2, 1, 0, 1),
      text: document.getElementById('tiScoreText').value, errors: document.querySelectorAll('#tiDiagnostics .is-error').length };
  })()`);
  const labels = await readLabels();
  assert.equal(labels.plain, open);
  assert.equal(labels.hammer, 'h' + up, 'the input card shows h before a hammer-on: ' + JSON.stringify(labels));
  assert.equal(labels.pull, 'p' + open);
  assert.equal(labels.splitHammer, 'h' + up);
  assert.equal(labels.splitPull, 'p' + open);
  assert.equal(labels.chordTop, 'h' + up);
  assert.equal(labels.text, slurLines.join('\n'), 'the exported text is the imported text');
  assert.equal(labels.errors, 0, 'the diagnostics show no error');
  await client.evaluate(`(function(){
    document.querySelector('.ti-slot[data-m="0"][data-c="0"][data-s="0"] .ti-pos[data-str="1"]').click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key:'r', code:'KeyR', bubbles:true, cancelable:true }));
    return true;
  })()`);
  const cut = await readLabels();
  assert.equal(cut.hammer, '⌒' + up, 'a slur with no source falls back to the plain arc: ' + JSON.stringify(cut));
  assert.equal(cut.pull, 'p' + open, 'a later slur that still links keeps its direction');
  assert.ok(cut.errors >= 1, 'the diagnostics report the broken slur');
  assert.ok(await client.evaluate(`document.querySelector('#tiMeasures .ti-measure .ti-measure-error').textContent.indexOf('슬러 앞에 같은 줄에서 친 음이 없습니다') >= 0`), 'the measure card shows the slur error');
  await client.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key:'z', code:'KeyZ', ctrlKey:true, bubbles:true, cancelable:true })); true`);
  const restored = await readLabels();
  assert.equal(restored.hammer, 'h' + up, 'undoing the rest restores the direction letter');
  assert.equal(restored.errors, 0);
  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the slur steps run without console errors');
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: slur direction letters in practice TAB and score input cards passed\n');
}

// 슬라이드(g): 연습 화면 TAB 알약은 프렛 앞에 방향 글자(/ 위, \ 아래)를 붙이고, 악보 입력 화면 카드도 같은 글자를 보인다. 프렛 값은 파서로 셈한다.
async function testSlideLabels(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const errorsBefore = client.consoleErrors.length;
  async function loadPage(url, readyExpression) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, readyExpression, 8000);
  }
  const slideLines = [
    '[-] E4@1 gF4@1 - gE4@1 | ""',
    '[-] E4@1/gF4@1/gE4@1 - - r | ""',
    '[-] E2@6+E4@1 E2@6+gF4@1 - r | ""'
  ];
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await loadPage(`http://127.0.0.1:${httpPort}/index.html`, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null');
  const practice = await client.evaluate(`(function(){
    var lines = ${JSON.stringify(slideLines)};
    var song = scoreDrafts.createFromScore({ title: '슬라이드 시험', beats: 4, bpm: 60, lines: lines, origin: 'tab-input' });
    rebuildSongSelect(song.id);
    var s = document.getElementById('scoreViewSelect'); s.value = 'both'; s.dispatchEvent(new Event('change', { bubbles: true }));
    appState.clickMode = 'off';
    function pills(m, b){
      var cell = document.querySelector('#measuresGrid .beat-cell[data-m="' + m + '"][data-b="' + b + '"]');
      return Array.prototype.map.call(cell.querySelectorAll('.tab-fret-pill'), function(pill){
        var label = pill.querySelector('.fret-label');
        var mark = label.querySelector('.fret-slide');
        return { top: pill.style.top, text: pill.textContent, cls: label.className, mark: mark && mark.textContent, markFirst: !!mark && label.firstChild === mark, held: pill.classList.contains('tab-held-fret'), left: parseFloat(pill.style.left) || 0 };
      }).sort(function(a, b){ return a.left - b.left || a.top.localeCompare(b.top); });
    }
    var out = {
      openFret: GuitarParser.parseNoteToken('E4@1', 0).pos.fret,
      upFret: GuitarParser.parseNoteToken('F4@1', 0).pos.fret,
      plain: pills(0, 0), up: pills(0, 1), held: pills(0, 2), down: pills(0, 3),
      split: pills(1, 0), chord: pills(2, 1),
      staffSlides: document.querySelectorAll('#measuresGrid .tab-staff-layer line.st-slide').length,
      staffSlurs: document.querySelectorAll('#measuresGrid .tab-staff-layer path.st-slur').length,
      staffHeads: document.querySelectorAll('#measuresGrid .tab-staff-layer .st-head').length,
      mark: (function(){ var el = document.querySelector('#measuresGrid .fret-slide'); var cs = getComputedStyle(el); var label = getComputedStyle(el.parentNode); return { fontSize: parseFloat(cs.fontSize), labelFontSize: parseFloat(label.fontSize), weight: cs.fontWeight, opacity: cs.opacity, color: cs.color, labelColor: label.color }; })()
    };
    updateActiveCursor(0, 0, false);
    return out;
  })()`);
  const slideCount = (slideLines.join('\n').match(/g[A-G]/g) || []).length;
  assert.equal(slideCount, 5, 'the test score has five slides');
  assert.ok(practice.staffHeads > 0, 'the practice staff is drawn');
  assert.equal(practice.staffSlides, slideCount, 'the practice staff draws one line per slide: ' + JSON.stringify(practice));
  assert.equal(practice.staffSlurs, 0, 'a slide is not drawn as a slur curve on the staff');
  const practiceShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  const practiceTarget = path.join(root, 'test-artifacts', 'practice-slide.png');
  fs.writeFileSync(practiceTarget, Buffer.from(practiceShot.data, 'base64'));
  process.stdout.write('Artifact: ' + practiceTarget + '\n');
  const open = String(practice.openFret);
  const up = String(practice.upFret);
  const upMark = '/';
  const downMark = '\\';
  assert.deepEqual(practice.plain.map(pill => pill.text), [open], 'a plain note has no direction letter');
  assert.ok(!/\bis-slide\b/.test(practice.plain[0].cls) && practice.plain[0].mark === null, 'a plain note has no slide mark');
  assert.deepEqual(practice.up.map(pill => pill.text), [upMark + up], 'a higher slid note reads / + fret: ' + JSON.stringify(practice.up));
  assert.ok(/\bis-slide\b/.test(practice.up[0].cls) && practice.up[0].markFirst && practice.up[0].mark === upMark, 'the letter is a .fret-slide span before the fret number');
  assert.deepEqual(practice.down.map(pill => pill.text), [downMark + open], 'a lower slid note reads \\ + fret: ' + JSON.stringify(practice.down));
  assert.ok(practice.down[0].markFirst && practice.down[0].mark === downMark);
  assert.ok(practice.held.length >= 1 && practice.held.every(pill => pill.held && pill.mark === null && !/\bis-slide\b/.test(pill.cls)), 'a held pill shows no slide mark: ' + JSON.stringify(practice.held));
  assert.deepEqual(practice.split.map(pill => pill.text), [open, upMark + up, downMark + open], 'subdivided slides read / then \\: ' + JSON.stringify(practice.split));
  assert.deepEqual(practice.chord.map(pill => pill.text).sort(), [upMark + up, open].sort(), 'in a chord only the slid component has the letter: ' + JSON.stringify(practice.chord));
  assert.ok(practice.mark.fontSize < practice.mark.labelFontSize, 'the direction letter is smaller than the fret number: ' + JSON.stringify(practice.mark));
  assert.ok(Number(practice.mark.opacity) < 1 && Number(practice.mark.weight) >= 700, 'the letter is bold and slightly faded: ' + JSON.stringify(practice.mark));
  assert.equal(practice.mark.color, practice.mark.labelColor, 'the slide mark does not change the color');

  // 악보 입력 화면: 불러온 슬라이드 카드의 글자. 앞 음을 쉼으로 바꾸면 슬라이드가 끊겨 방향 없이 —로 보이고 검사가 오류를 낸다.
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  const inputReady = 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1';
  await client.evaluate(`(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`);
  await loadPage(inputUrl, inputReady);
  await client.evaluate(`(function(){
    window.confirm = function(){ return true; };
    document.getElementById('tiImportBtn').click();
    var area = document.getElementById('tiImportText');
    area.value = ${JSON.stringify(slideLines.join('\n'))};
    area.dispatchEvent(new Event('input', { bubbles:true }));
    document.getElementById('tiImportApplyBtn').click();
    return true;
  })()`);
  assert.equal(await client.evaluate(`document.getElementById('tiImportError').textContent`), '', 'the slide score imports without error');
  const readLabels = () => client.evaluate(`(function(){
    function label(m, c, s, str){ var node = document.querySelector('.ti-slot[data-m="' + m + '"][data-c="' + c + '"][data-s="' + s + '"] .ti-pos[data-str="' + str + '"] .ti-pos-label'); return node && node.textContent; }
    return { plain: label(0, 0, 0, 1), up: label(0, 1, 0, 1), down: label(0, 3, 0, 1), splitUp: label(1, 0, 1, 1), splitDown: label(1, 0, 2, 1), chordTop: label(2, 1, 0, 1),
      text: document.getElementById('tiScoreText').value, errors: document.querySelectorAll('#tiDiagnostics .is-error').length };
  })()`);
  const labels = await readLabels();
  const inputStaff = await client.evaluate(`({
    slides: document.querySelectorAll('#tiMeasures .ti-staff-wrap svg line.st-slide').length,
    slurs: document.querySelectorAll('#tiMeasures .ti-staff-wrap svg path.st-slur').length,
    heads: document.querySelectorAll('#tiMeasures .ti-staff-wrap svg .st-head').length
  })`);
  assert.ok(inputStaff.heads > 0, 'the cards draw a staff');
  assert.equal(inputStaff.slides, slideCount, 'the input cards draw one line per slide: ' + JSON.stringify(inputStaff));
  assert.equal(inputStaff.slurs, 0, 'a slide is not drawn as a slur curve on the cards');
  const inputShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const inputTarget = path.join(root, 'test-artifacts', 'score-input-slide.png');
  fs.writeFileSync(inputTarget, Buffer.from(inputShot.data, 'base64'));
  process.stdout.write('Artifact: ' + inputTarget + '\n');
  assert.equal(labels.plain, open);
  assert.equal(labels.up, upMark + up, 'the input card shows / before an upward slide: ' + JSON.stringify(labels));
  assert.equal(labels.down, downMark + open);
  assert.equal(labels.splitUp, upMark + up);
  assert.equal(labels.splitDown, downMark + open);
  assert.equal(labels.chordTop, upMark + up);
  assert.equal(labels.text, slideLines.join('\n'), 'the exported text is the imported text');
  assert.equal(labels.errors, 0, 'the diagnostics show no error');
  await client.evaluate(`(function(){
    document.querySelector('.ti-slot[data-m="0"][data-c="0"][data-s="0"] .ti-pos[data-str="1"]').click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key:'r', code:'KeyR', bubbles:true, cancelable:true }));
    return true;
  })()`);
  const cut = await readLabels();
  assert.equal(cut.up, '—' + up, 'a slide with no source falls back to the dash: ' + JSON.stringify(cut));
  assert.equal(cut.down, downMark + open, 'a later slide that still links keeps its direction');
  assert.ok(cut.errors >= 1, 'the diagnostics report the broken slide');
  assert.ok(await client.evaluate(`document.querySelector('#tiMeasures .ti-measure .ti-measure-error').textContent.indexOf('슬라이드 앞에 같은 줄에서 친 음이 없습니다') >= 0`), 'the measure card shows the slide error');
  await client.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key:'z', code:'KeyZ', ctrlKey:true, bubbles:true, cancelable:true })); true`);
  const restored = await readLabels();
  assert.equal(restored.up, upMark + up, 'undoing the rest restores the direction letter');
  assert.equal(restored.errors, 0);
  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the slide steps run without console errors');
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: slide direction letters in practice TAB and score input cards passed\n');
}

// 롤(~): 연습 화면 TAB 은 롤 화음 왼쪽에 세로 물결선(.roll-mark)을 그린다. 위치는 화음 알약의 실제 상자로 잰다.
async function testRollMarks(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const errorsBefore = client.consoleErrors.length;
  const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/index.html` });
  await waitForPageLoadAfter(client, before);
  await waitForCondition(client, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null', 8000);
  const rollLines = [
    '[-] ~E2@6+B3@2+G4@1 E2@6+B3@2+G4@1 ~E2@6+B3@2 E2@6+B3@2 | ""',
    '[-] C3@5/~A3@3+D4@2+F#4@1 ~E2@6+E4@1 - r | ""'
  ];
  const result = await client.evaluate(`(function(){
    var song = scoreDrafts.createFromScore({ title: '롤 시험', beats: 4, bpm: 60, lines: ${JSON.stringify(rollLines)}, origin: 'tab-input' });
    rebuildSongSelect(song.id);
    var s = document.getElementById('scoreViewSelect'); s.value = 'tab'; s.dispatchEvent(new Event('change', { bubbles: true }));
    appState.clickMode = 'off';
    function center(rect){ return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }
    function cellInfo(m, b){
      var cell = document.querySelector('#measuresGrid .beat-cell[data-m="' + m + '"][data-b="' + b + '"]');
      var pills = Array.prototype.slice.call(cell.querySelectorAll('.tab-fret-pill')).filter(function(pill){ return !pill.classList.contains('tab-held-fret'); });
      var marks = Array.prototype.map.call(cell.querySelectorAll('.roll-mark'), function(mark){
        var rect = mark.getBoundingClientRect();
        var centerCss = mark.style.left.replace('calc(', '').replace(' - 19px)', '');
        var chord = pills.filter(function(pill){ return (pill.style.left || '50%') === centerCss; }).map(function(pill){ return center(pill.getBoundingClientRect()); });
        var cs = getComputedStyle(mark);
        return {
          top: rect.top, bottom: rect.bottom, right: rect.right, width: rect.width,
          chordYs: chord.map(function(c){ return c.y; }), chordXs: chord.map(function(c){ return c.x; }),
          mask: cs.webkitMaskImage || cs.maskImage, position: cs.position, title: mark.title
        };
      });
      return { marks: marks, pillCount: pills.length, heldPills: cell.querySelectorAll('.tab-held-fret').length };
    }
    var out = { total: document.querySelectorAll('#measuresGrid .roll-mark').length, cells: {} };
    [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [1, 2], [1, 3]].forEach(function(p){ out.cells[p[0] + ',' + p[1]] = cellInfo(p[0], p[1]); });
    return out;
  })()`);
  assert.equal(result.total, 4, 'one wave per rolled chord: ' + result.total);
  const expectMarks = { '0,0': 1, '0,1': 0, '0,2': 1, '0,3': 0, '1,0': 1, '1,1': 1, '1,2': 0, '1,3': 0 };
  for (const [key, count] of Object.entries(expectMarks)) {
    assert.equal(result.cells[key].marks.length, count, 'cell ' + key + ' has ' + count + ' roll marks');
  }
  assert.ok(result.cells['1,2'].heldPills >= 1, 'the hold of a rolled chord draws faded pills');
  for (const [key, info] of Object.entries(result.cells)) {
    for (const mark of info.marks) {
      assert.ok(mark.chordYs.length >= 2, 'cell ' + key + ' the rolled chord has two or more pills');
      const top = Math.min(...mark.chordYs), bottom = Math.max(...mark.chordYs);
      assert.ok(mark.top <= top && mark.bottom >= bottom, 'cell ' + key + ' the wave covers the top and bottom string centers: ' + JSON.stringify({ wave: [mark.top, mark.bottom], strings: [top, bottom] }));
      const centerX = mark.chordXs.reduce((a, b) => a + b, 0) / mark.chordXs.length;
      assert.ok(mark.right <= centerX - 4, 'cell ' + key + ' the wave is at least 4px left of the pill center: ' + JSON.stringify({ right: mark.right, centerX }));
      assert.ok(mark.width > 0 && mark.position === 'absolute', 'cell ' + key + ' the wave is a positioned box');
      assert.ok(/svg/.test(mark.mask), 'cell ' + key + ' the wave shape comes from the mask image: ' + mark.mask);
      assert.ok(mark.title.indexOf('롤') === 0, 'the wave has a title');
    }
  }
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  const target = path.join(root, 'test-artifacts', 'practice-roll.png');
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  process.stdout.write('Artifact: ' + target + '\n');

  // 오선(둘 다): 롤 조각마다 물결선 하나. 붙임줄로 이어진 뒤 토막과 롤 아닌 화음에는 없다.
  const staffRolls = await client.evaluate(`(function(){
    var s = document.getElementById('scoreViewSelect'); s.value = 'both'; s.dispatchEvent(new Event('change', { bubbles: true }));
    var layer = '#measuresGrid .tab-staff-layer ';
    return { staffRolls: document.querySelectorAll(layer + 'path.st-roll').length, staffChords: document.querySelectorAll(layer + 'g.st-chord').length, tabMarks: document.querySelectorAll('#measuresGrid .roll-mark').length };
  })()`);
  assert.equal(staffRolls.staffRolls, result.total, 'the staff draws one wave per rolled piece (same count as the TAB marks): ' + JSON.stringify(staffRolls));
  assert.ok(staffRolls.staffChords > staffRolls.staffRolls, 'plain and tied chords of the staff have no wave');
  assert.equal(staffRolls.tabMarks, result.total, 'the TAB marks stay with the staff view on');
  const staffShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const staffTarget = path.join(root, 'test-artifacts', 'practice-roll-staff.png');
  fs.writeFileSync(staffTarget, Buffer.from(staffShot.data, 'base64'));
  process.stdout.write('Artifact: ' + staffTarget + '\n');

  // 악보 입력 화면 카드의 오선에도 같은 물결선이 그려진다.
  await client.evaluate(`(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`);
  const inputBefore = client.events.filter(event => event.method === 'Page.loadEventFired').length;
  await client.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/score-input.html` });
  await waitForPageLoadAfter(client, inputBefore);
  await waitForCondition(client, 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1', 8000);
  await client.evaluate(`(function(){
    window.confirm = function(){ return true; };
    document.getElementById('tiImportBtn').click();
    var area = document.getElementById('tiImportText');
    area.value = ${JSON.stringify(rollLines.join('\n'))};
    area.dispatchEvent(new Event('input', { bubbles:true }));
    document.getElementById('tiImportApplyBtn').click();
    return true;
  })()`);
  assert.equal(await client.evaluate(`document.getElementById('tiImportError').textContent`), '', 'the roll score imports without error');
  const inputRolls = await client.evaluate(`({
    waves: document.querySelectorAll('#tiMeasures .ti-staff-wrap svg path.st-roll').length,
    heads: document.querySelectorAll('#tiMeasures .ti-staff-wrap svg .st-head').length,
    text: document.getElementById('tiScoreText').value
  })`);
  assert.equal(inputRolls.text, rollLines.join('\n'), 'the exported text keeps the roll marks');
  assert.ok(inputRolls.heads > 0, 'the cards draw a staff');
  assert.equal(inputRolls.waves, result.total, 'the input cards draw one staff wave per rolled piece: ' + JSON.stringify(inputRolls));
  const inputShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const inputTarget = path.join(root, 'test-artifacts', 'score-input-roll.png');
  fs.writeFileSync(inputTarget, Buffer.from(inputShot.data, 'base64'));
  process.stdout.write('Artifact: ' + inputTarget + '\n');
  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the roll steps run without console errors');
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: roll waves in practice TAB and staff, and in score input card staffs, passed\n');
}

// 빈칸 _ 연습 화면: 칸 자리는 그대로 두고(slot-skip 클래스, 음·쉼 표시 없음), TAB·카드·오선 보기가 빈칸 마디에서 콘솔 오류를 내지 않는다. 규칙은 Docs/score-format.md 빈칸.
async function testSkipCells(client, httpPort) {
  const errorsBefore = client.consoleErrors.length;
  const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/index.html` });
  await waitForPageLoadAfter(client, before);
  await waitForCondition(client, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null', 8000);
  const skipLines = [
    '[-] _ _ _ E3@4/G3@3 | ""',
    '[G] B3 D4 _ _ | ""',
    '[Am] A2+E3 - - _ | ""',
    '[C] E4 F4 G4 A4 | ""'
  ];
  const probe = view => client.evaluate(`(function(){
    var s = document.getElementById('scoreViewSelect'); s.value = '${view}'; s.dispatchEvent(new Event('change', { bubbles: true }));
    var skip = Array.prototype.slice.call(document.querySelectorAll('#measuresGrid .beat-cell.slot-skip'));
    return {
      count: skip.length,
      cells: skip.map(function(cell){ return cell.dataset.m + ',' + cell.dataset.b; }),
      marks: skip.reduce(function(sum, cell){ return sum + cell.querySelectorAll('.tab-fret-pill, .tab-rest-dash').length; }, 0),
      titles: skip.map(function(cell){ return cell.title; }),
      labels: skip.map(function(cell){ var l = cell.querySelector('.b-skip-label'); return l ? l.textContent : ''; }),
      opacity: skip.length ? getComputedStyle(skip[skip.length - 1]).opacity : null, // 첫 칸은 커서가 있어 활성 표시가 이긴다
      stripes: skip.length ? getComputedStyle(skip[skip.length - 1]).backgroundImage : null,
      staffHeads: Array.prototype.map.call(document.querySelectorAll('#measuresGrid .tab-staff-layer .st-chord'), function(chord){
        var layer = chord.closest('.tab-staff-layer');
        var cell = document.querySelector('#measuresGrid .beat-cell[data-m="' + layer.dataset.m + '"][data-b="' + chord.dataset.cell + '"]');
        var chordRect = chord.getBoundingClientRect(), cellRect = cell ? cell.getBoundingClientRect() : null;
        var center = chordRect.left + chordRect.width / 2;
        return { m: layer.dataset.m, cell: chord.dataset.cell, inside: !!cellRect && center >= cellRect.left && center <= cellRect.right, skipCell: !!cell && cell.classList.contains('slot-skip') };
      }),
      staffLayers: document.querySelectorAll('#measuresGrid .tab-staff-layer').length,
      cards: document.querySelectorAll('#measuresGrid .measure-card').length
    };
  })()`);
  await client.evaluate(`(function(){
    var song = scoreDrafts.createFromScore({ title: '빈칸 시험', beats: 4, bpm: 60, lines: ${JSON.stringify(skipLines)}, origin: 'tab-input' });
    rebuildSongSelect(song.id);
    appState.clickMode = 'off';
    return true;
  })()`);
  const tab = await probe('tab');
  assert.equal(tab.count, 6, 'TAB: every skip cell is drawn with slot-skip: ' + JSON.stringify(tab));
  assert.deepEqual(tab.cells, ['0,0', '0,1', '0,2', '1,2', '1,3', '2,3']);
  assert.equal(tab.marks, 0, 'TAB: a skip cell draws no fret and no rest mark');
  assert.ok(tab.titles.every(title => title.includes('빈칸') && !title.includes('길이')), 'TAB: skip cell titles say 빈칸 and name no length: ' + JSON.stringify(tab.titles));
  assert.ok(Number(tab.opacity) < 1, 'TAB: skip cells are dimmed: ' + tab.opacity);
  assert.match(tab.stripes, /repeating-linear-gradient/, 'TAB: skip cells are hatched by the shared base.css rule: ' + tab.stripes);
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  const target = path.join(root, 'test-artifacts', 'practice-skip.png');
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  process.stdout.write('Artifact: ' + target + '\n');
  const card = await probe('card');
  assert.equal(card.count, 6, 'card view: every skip cell has slot-skip');
  assert.deepEqual(card.labels, Array(6).fill('빈칸'), 'card view: a skip cell reads 빈칸');
  const cardShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const cardTarget = path.join(root, 'test-artifacts', 'practice-skip-card.png');
  fs.writeFileSync(cardTarget, Buffer.from(cardShot.data, 'base64'));
  process.stdout.write('Artifact: ' + cardTarget + '\n');
  const both = await probe('both');
  assert.equal(both.count, 6, 'staff view on: skip cells keep the slot-skip class');
  assert.ok(both.staffHeads.length >= 8, 'staff view on: the staff layer draws the notes: ' + JSON.stringify(both.staffHeads));
  assert.ok(both.staffHeads.every(head => head.inside && !head.skipCell), 'staff view on: every staff note sits over its own TAB cell and none over a skip cell: ' + JSON.stringify(both.staffHeads));
  assert.deepEqual(both.staffHeads.filter(head => head.m === '0').map(head => head.cell), ['3', '3'], 'the pickup measure notes (a split cell) are in cell 3');
  assert.deepEqual(both.staffHeads.filter(head => head.m === '1').map(head => head.cell), ['0', '1'], 'the short measure notes are in cells 0 and 1');
  const bothShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bothTarget = path.join(root, 'test-artifacts', 'practice-skip-both.png');
  fs.writeFileSync(bothTarget, Buffer.from(bothShot.data, 'base64'));
  process.stdout.write('Artifact: ' + bothTarget + '\n');
  await probe('staff');
  await probe('tab');
  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the skip-cell steps run without console errors');
  process.stdout.write('Browser checkpoint: skip cells in practice TAB, card, and staff views passed\n');
}

async function testCountInCountdown(client, httpPort) {
  const errorsBefore = client.consoleErrors.length;
  const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/index.html` });
  await waitForPageLoadAfter(client, before);
  await waitForCondition(client, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null', 8000);

  const setup = await client.evaluate(`(function(){
    var song = scoreDrafts.createFromScore({ title: '카운트다운 시험', beats: 4, bpm: 120, lines: ['[-] _ _ C4 D4', '[G] E4 F4 G4 A4'], origin: 'tab-input' });
    rebuildSongSelect(song.id);
    appState.clickMode = 'all';
    appState.guideSound = false;
    appState.loopEnable = false;
    syncConsoleUI();
    window.__ciOriginal = {
      setTimeout: window.setTimeout,
      actx: window.actx,
      ensureAudioCtx: window.ensureAudioCtx,
      warmKsCache: window.warmKsCache,
      scheduleMetronomeClick: window.scheduleMetronomeClick,
      playGuitarNote: window.playGuitarNote,
      stopGuitarNotes: window.stopGuitarNotes
    };
    window.__ciTimers = [];
    window.ensureAudioCtx = function(){};
    window.warmKsCache = function(){};
    window.scheduleMetronomeClick = function(){};
    window.playGuitarNote = function(){};
    window.stopGuitarNotes = function(){};
    window.actx = { currentTime: 0, outputLatency: 0.02, baseLatency: 0.01 };
    window.setTimeout = function(fn, delay){ window.__ciTimers.push({ fn: fn, delay: delay }); return window.__ciTimers.length; };
    try {
      startPractice();
      var session = window.playSession;
      var countInTotal = session.countInPositions.length;
      for (var i = 0; i < countInTotal + 1; i++){
        window.actx.currentTime = session.nextBeatTime - 0.01;
        schedulerTick();
      }
      return { countInTotal: countInTotal, positions: session.countInPositions.slice(), timerCount: window.__ciTimers.length };
    } finally {
      window.setTimeout = window.__ciOriginal.setTimeout;
    }
  })()`);
  assert.equal(setup.countInTotal, 6, 'pickup measure at 120 BPM counts 6 beats (1 bar + 2 leading skip beats)');
  assert.deepEqual(setup.positions, [0, 1, 2, 3, 0, 1], 'count-in beat positions follow bar grid');
  assert.equal(setup.timerCount, 7, '6 count-in UI timers and 1st playback beat UI timer captured');

  const stepAndProbe = idx => client.evaluate(`(function(){
    window.__ciTimers[${idx}].fn();
    var card = document.querySelector('#measuresGrid .measure-card[data-m="0"]');
    var badge = card ? card.querySelector('.count-in-badge') : null;
    var activeBeat = document.querySelector('#measuresGrid .beat-cell.active-beat');
    var leds = Array.prototype.map.call(document.querySelectorAll('#leds .led'), function(el){ return el.classList.contains('on'); });
    var cr = card ? card.getBoundingClientRect() : null;
    var br = badge ? badge.getBoundingClientRect() : null;
    return {
      phase: document.getElementById('phaseTxt').textContent,
      compact: document.getElementById('compactStatusBadge').textContent,
      compactVisible: document.getElementById('compactStatusBadge').getClientRects().length > 0,
      badgeText: badge ? badge.textContent : null,
      badgeInside: !!(cr && br && br.width > 0 && br.left >= cr.left && br.right <= cr.right && br.top >= cr.top && br.bottom <= cr.bottom),
      anyBadgeCount: document.querySelectorAll('.count-in-badge').length,
      activeBar: !!(card && card.classList.contains('active-bar')),
      activeBeat: activeBeat ? activeBeat.dataset.m + ',' + activeBeat.dataset.b : null,
      leds: leds
    };
  })()`);

  const beat0 = await stepAndProbe(0);
  assert.equal(beat0.phase, '카운트인 · 첫 음까지 6박 (120 BPM)');
  assert.equal(beat0.compact, '120 BPM · 첫 음까지 6');
  assert.equal(beat0.badgeText, '첫 음까지6');
  assert.equal(beat0.badgeInside, true, 'TAB view: count-in badge sits inside the target measure card');
  assert.equal(beat0.activeBar, true, 'count-in moves active-bar to target measure');
  assert.equal(beat0.activeBeat, '0,2', 'count-in moves active-beat to the first sounding beat');
  assert.deepEqual(beat0.leds, [true, false, false, false], 'beat 0 lights LED 0');

  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  const tabShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const tabTarget = path.join(root, 'test-artifacts', 'practice-count-in-tab.png');
  fs.writeFileSync(tabTarget, Buffer.from(tabShot.data, 'base64'));
  process.stdout.write('Artifact: ' + tabTarget + '\n');

  await client.evaluate(`(function(){ var s = document.getElementById('scoreViewSelect'); s.value = 'both'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitForCondition(client, 'document.querySelectorAll("#measuresGrid .tab-staff-layer svg").length > 0', 4000);
  const beat1 = await stepAndProbe(1);
  assert.equal(beat1.badgeText, '첫 음까지5', 're-rendered both view keeps updating count-in badge');
  assert.equal(beat1.badgeInside, true, 'both view: count-in badge sits inside the target measure card');
  assert.deepEqual(beat1.leds, [false, true, false, false], 'beat 1 lights LED 1');
  const bothShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bothTarget = path.join(root, 'test-artifacts', 'practice-count-in-both.png');
  fs.writeFileSync(bothTarget, Buffer.from(bothShot.data, 'base64'));
  process.stdout.write('Artifact: ' + bothTarget + '\n');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`setCompactPractice(true); true`);
  const beat2 = await stepAndProbe(2);
  assert.equal(beat2.compactVisible, true, 'compact mode shows compactStatusBadge');
  assert.equal(beat2.compact, '120 BPM · 첫 음까지 4');
  assert.equal(beat2.badgeText, '첫 음까지4');
  const compactShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const compactTarget = path.join(root, 'test-artifacts', 'practice-count-in-compact.png');
  fs.writeFileSync(compactTarget, Buffer.from(compactShot.data, 'base64'));
  process.stdout.write('Artifact: ' + compactTarget + '\n');

  await client.evaluate(`setCompactPractice(false); var s = document.getElementById('scoreViewSelect'); s.value = 'tab'; s.dispatchEvent(new Event('change', { bubbles: true })); true`);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const beat3 = await stepAndProbe(3);
  const beat4 = await stepAndProbe(4);
  const beat5 = await stepAndProbe(5);
  assert.deepEqual([beat3.badgeText, beat4.badgeText, beat5.badgeText], ['첫 음까지3', '첫 음까지2', '첫 음까지1']);
  assert.deepEqual(beat5.leds, [false, true, false, false], 'final count-in beat lights LED 1 before beat 2');

  const play0 = await stepAndProbe(6);
  assert.equal(play0.anyBadgeCount, 0, 'first playback beat removes the count-in badge');
  assert.equal(play0.phase, '1마디 · 3/4박 진행 중 (120 BPM)');
  assert.equal(play0.compact, '120 BPM · 1마디 3박');
  assert.deepEqual(play0.leds, [false, false, true, false], 'first playback beat lights LED 2');

  // 카운트인 도중 정지하면 카드 배지와 콤팩트 상태 배지, LED가 모두 정리된다
  const stopped = await client.evaluate(`(function(){
    stopPractice();
    window.__ciTimers = [];
    window.actx = { currentTime: 0, outputLatency: 0.02, baseLatency: 0.01 };
    window.setTimeout = function(fn, delay){ window.__ciTimers.push({ fn: fn, delay: delay }); return window.__ciTimers.length; };
    try {
      startPractice();
      window.actx.currentTime = window.playSession.nextBeatTime - 0.01;
      schedulerTick();
    } finally {
      window.setTimeout = window.__ciOriginal.setTimeout;
    }
    window.__ciTimers[0].fn();
    var during = document.querySelectorAll('.count-in-badge').length;
    stopPractice();
    var after = {
      during: during,
      badgeCount: document.querySelectorAll('.count-in-badge').length,
      phase: document.getElementById('phaseTxt').textContent,
      compact: document.getElementById('compactStatusBadge').textContent,
      ledsOn: document.querySelectorAll('#leds .led.on').length
    };
    window.ensureAudioCtx = window.__ciOriginal.ensureAudioCtx;
    window.warmKsCache = window.__ciOriginal.warmKsCache;
    window.scheduleMetronomeClick = window.__ciOriginal.scheduleMetronomeClick;
    window.playGuitarNote = window.__ciOriginal.playGuitarNote;
    window.stopGuitarNotes = window.__ciOriginal.stopGuitarNotes;
    window.actx = window.__ciOriginal.actx;
    return after;
  })()`);
  assert.equal(stopped.during, 1, 'badge appeared before stop');
  assert.equal(stopped.badgeCount, 0, 'stopPractice removes count-in badge mid-count-in');
  assert.equal(stopped.phase, '정지됨 · 마디를 클릭하여 계속 연습');
  assert.equal(stopped.compact, '120 BPM · 1마디 3박', 'stopPractice resets compactStatusBadge away from countdown');
  assert.equal(stopped.ledsOn, 0, 'stopPractice turns off all LEDs');

  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'count-in countdown checks run without console errors');
  process.stdout.write('Browser checkpoint: count-in countdown badge, status line, compact badge, LEDs, and screenshots passed\n');
}

// 마디 폭: 마디마다 자기 분할로 필요 폭을 정하고, 기준 열 폭(90%)보다 넓은 마디는 열을 더 차지하며, 어떤 보기·폭에서도 가로로 넘치지 않는다. 규칙은 Docs/ui.md 마디 폭.
async function testMeasureWidth(client, httpPort) {
  const errorsBefore = client.consoleErrors.length;
  const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/index.html` });
  await waitForPageLoadAfter(client, before);
  await waitForCondition(client, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null', 8000);

  const pitches = ['E4', 'F4', 'G4', 'A4'];
  const cell = split => pitches.slice(0, split).join('/');
  const line = (beats, split) => '[C] ' + Array(beats).fill(cell(split)).join(' ') + ' | ""';
  // (A) 8칸: 분할 없는 마디 10, 2분할 8, 4분할(32분음표) 2 / (B) 3칸 99마디 중 4분할 하나 / (C) 분할 없는 4칸
  const splitsA = [1, 1, 1, 4, 2, 2, 1, 1, 2, 2, 1, 4, 2, 2, 1, 1, 2, 2, 1, 1];
  const songs = {
    A: { title: '마디 폭 A', beats: 8, lines: splitsA.map(split => line(8, split)) },
    B: { title: '마디 폭 B', beats: 3, lines: Array.from({ length: 99 }, (_, index) => line(3, index === 40 ? 4 : 1)) },
    C: { title: '마디 폭 C', beats: 4, lines: Array.from({ length: 12 }, () => line(4, 1)) },
    // (E) 3칸 20마디 중 4분할(span 3)과 2분할(span 2)이 하나씩: 넓게 연 뒤 좁히면 붙어 있던 span이 만든 암시 열을 열 수에 세지 않아야 한다
    E: { title: '마디 폭 E', beats: 3, lines: Array.from({ length: 20 }, (_, index) => line(3, index === 5 ? 4 : (index === 11 ? 2 : 1))) }
  };
  async function openSong(key) {
    const created = await client.evaluate(`(function(){
      var song = scoreDrafts.createFromScore({ title: ${JSON.stringify(songs[key].title)}, beats: ${songs[key].beats}, bpm: 60, lines: ${JSON.stringify(songs[key].lines)}, origin: 'tab-input' });
      rebuildSongSelect(song.id);
      return { measures: curSong.measures.length, beats: curSong.beats, title: curSong.title };
    })()`);
    assert.deepEqual(created, { measures: songs[key].lines.length, beats: songs[key].beats, title: songs[key].title }, 'test song ' + key + ' opens');
  }
  const settle = () => client.evaluate('new Promise(function(resolve){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ setTimeout(resolve, 250); }); }); })');
  async function setView(view) {
    await client.evaluate(`${pageSetScoreView(JSON.stringify(view))}; true`);
  }
  async function setWidth(width) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
    await settle();
  }
  const probe = () => client.evaluate(`(function(){
    var wrap = document.getElementById('structuredScoreWrap'), grid = document.getElementById('measuresGrid');
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.measure-card'));
    var firstTop = cards[0].getBoundingClientRect().top;
    return {
      wrap: [wrap.scrollWidth, wrap.clientWidth], grid: [grid.scrollWidth, grid.clientWidth],
      doc: [document.documentElement.scrollWidth, window.innerWidth],
      cols: Number(grid.dataset.cols), template: grid.style.gridTemplateColumns,
      gridWidth: grid.getBoundingClientRect().width,
      widths: cards.map(function(card){ return Math.round(card.getBoundingClientRect().width); }),
      spans: cards.map(function(card){ return card.style.gridColumn; }),
      firstRow: cards.filter(function(card){ return Math.abs(card.getBoundingClientRect().top - firstTop) < 2; }).length,
      overflowCards: cards.filter(function(card){ var r = card.getBoundingClientRect(), g = grid.getBoundingClientRect(); return r.right > g.right + 1 || r.left < g.left - 1; }).length
    };
  })()`);
  function assertNoOverflow(result, label) {
    assert.ok(result.wrap[0] <= result.wrap[1] + 1, label + ': #structuredScoreWrap does not scroll sideways ' + JSON.stringify(result.wrap));
    assert.ok(result.grid[0] <= result.grid[1] + 1, label + ': #measuresGrid does not overflow ' + JSON.stringify(result.grid));
    assert.ok(result.doc[0] <= result.doc[1] + 1, label + ': the page does not scroll sideways ' + JSON.stringify(result.doc));
    assert.equal(result.overflowCards, 0, label + ': every measure card stays inside the grid');
  }
  const probes = {};
  for (const key of ['A', 'B', 'C']) {
    await openSong(key);
    for (const view of ['tab', 'both', 'card']) {
      await setView(view);
      for (const width of [375, 900, 1024, 1280]) {
        await setWidth(width);
        const result = await probe();
        const label = key + ' ' + view + ' ' + width + 'px';
        assertNoOverflow(result, label);
        probes[label] = result;
      }
    }
  }
  const view = label => probes[label];
  // (B) 900px 타브: 분할 없는 마디는 한 줄에 둘 이상, 4분할 마디는 그보다 넓다
  const b900 = view('B tab 900px');
  assert.ok(b900.firstRow >= 2, 'B tab 900px: several plain measures share a row (' + b900.firstRow + ')');
  assert.ok(b900.widths[40] > b900.widths[0] * 1.5 && b900.spans[40] !== '', 'B tab 900px: the 4-split measure takes more columns: ' + JSON.stringify({ plain: b900.widths[0], split: b900.widths[40], span: b900.spans[40] }));
  assert.equal(b900.spans[0], '', 'B tab 900px: a plain measure takes one column');
  const b1280 = view('B tab 1280px');
  assert.ok(b1280.cols >= 3 && b1280.widths[40] > b1280.widths[0] * 1.5, 'B tab 1280px: more columns and the 4-split measure is still wider: ' + JSON.stringify({ cols: b1280.cols, plain: b1280.widths[0], split: b1280.widths[40] }));
  // (A) 900px: 4분할 마디는 한 줄 전체이고 넘치지 않는다
  const a900 = view('A tab 900px');
  assert.equal(a900.spans[3], '1 / -1', 'A tab 900px: the 4-split measure fills its row: ' + JSON.stringify(a900.spans.slice(0, 6)));
  assert.ok(Math.abs(a900.widths[3] - a900.gridWidth) <= 1, 'A tab 900px: the 4-split measure is as wide as the grid (' + a900.widths[3] + ' vs ' + a900.gridWidth + ')');
  assert.ok(a900.widths[3] < 1592, 'A tab 900px: the 4-split measure is narrower than its wanted width, so its cells shrink');
  // (C) 지금처럼 한 줄에 여러 마디
  assert.ok(view('C tab 900px').firstRow >= 2 && view('C tab 1280px').firstRow >= 3, 'C: a song without splits keeps several measures per row (' + view('C tab 900px').firstRow + ', ' + view('C tab 1280px').firstRow + ')');
  assert.ok(view('C card 900px').firstRow >= 2, 'C card view: several measures per row');
  process.stdout.write('  measure width rows: ' + JSON.stringify(Object.fromEntries(Object.entries(probes).map(([label, r]) => [label, r.cols + ' cols, ' + r.firstRow + ' in row 1']))) + '\n');

  // 콤팩트 뷰도 넘치지 않는다
  await openSong('A');
  await setView('tab');
  await client.evaluate("document.getElementById('toggleCompactBtn').click(); true");
  assert.equal(await client.evaluate("document.body.classList.contains('practice-compact')"), true, 'compact view is on');
  for (const width of [375, 900]) {
    await setWidth(width);
    assertNoOverflow(await probe(), 'A compact ' + width + 'px');
  }
  await client.evaluate("document.getElementById('toggleCompactBtn').click(); true");

  // 같은 페이지에서 넓게 연 뒤 창만 줄여도 넘치지 않는다. 붙어 있던 span이 만든 암시 열을 열 수로 세면 span 2가 실제 1열 격자에서 넘친다.
  // 일반 보기는 격자 폭이 1000px 안팎에서 멈춰 4열이 안 나오므로(span 3이 한 줄 전체가 된다) 폭 제한이 없는 콤팩트 뷰에서 연다.
  await setView('tab');
  await client.evaluate("document.getElementById('toggleCompactBtn').click(); true");
  await setWidth(1920);
  await openSong('E');
  await settle();
  const e1920 = await probe();
  assert.ok(e1920.cols >= 4 && e1920.spans.includes('span 3') && e1920.spans.includes('span 2'), 'E compact 1920px: wide grid with span 3 and span 2 measures: ' + JSON.stringify({ cols: e1920.cols, spans: e1920.spans.filter(Boolean) }));
  assertNoOverflow(e1920, 'E compact 1920px');
  await setWidth(400);
  const eNarrow = await probe();
  assertNoOverflow(eNarrow, 'E compact 1920px then 400px (same page)');
  assert.equal(eNarrow.cols, 1, 'E compact 400px: one real column, not the implicit columns of the old spans: ' + eNarrow.cols);
  assert.ok(eNarrow.spans.every(span => span === '' || span === '1 / -1'), 'E compact 400px: wide measures fill the single column: ' + JSON.stringify(eNarrow.spans.filter(Boolean)));
  await setWidth(900);
  assertNoOverflow(await probe(), 'E compact 400px then 900px');
  await client.evaluate("document.getElementById('toggleCompactBtn').click(); true");

  // 320px 콘솔·마디 폭과 375px 4분할 마디의 .is-dense 축소를 확인한다.
  await openSong('B');
  await setView('tab');
  await setWidth(320);
  assertNoOverflow(await probe(), 'B tab 320px');
  await setWidth(375);
  const dense375 = await client.evaluate(`(function(){
    var plain = document.querySelector('#measuresGrid .measure-card[data-m="0"]');
    var split4 = document.querySelector('#measuresGrid .measure-card[data-m="40"]');
    var plainPill = plain.querySelector('.tab-fret-pill');
    var splitPill = split4.querySelector('.tab-fret-pill');
    return {
      plainDense: plain.classList.contains('is-dense'),
      splitDense: split4.classList.contains('is-dense'),
      plainFont: parseFloat(getComputedStyle(plainPill).fontSize),
      splitFont: parseFloat(getComputedStyle(splitPill).fontSize)
    };
  })()`);
  assert.equal(dense375.plainDense, false, 'B tab 375px: plain 3-beat measure is not is-dense');
  assert.equal(dense375.splitDense, true, 'B tab 375px: 4-split measure is marked is-dense');
  assert.ok(dense375.splitFont < dense375.plainFont, 'B tab 375px: is-dense measure shrinks tab-fret-pill font size (' + dense375.splitFont + ' < ' + dense375.plainFont + ')');

  // 좁아진 4분할 마디에서 글자가 겹치는지 눈으로 보도록 캡처를 남긴다
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  async function capture(name, key, viewName, dark, targetIndex, width, lead) {
    await openSong(key);
    await setView(viewName);
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await settle();
    await client.evaluate(`(function(){
      document.getElementById('scoreToolbar').scrollIntoView({ block: 'start', inline: 'nearest' });
      var card = document.querySelector('#measuresGrid .measure-card[data-m="${targetIndex}"]');
      var wrap = document.getElementById('structuredScoreWrap');
      wrap.style.scrollBehavior = 'auto';
      wrap.scrollTop += card.getBoundingClientRect().top - wrap.getBoundingClientRect().top - ${lead};
      return true;
    })()`);
    await settle();
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const target = path.join(root, 'test-artifacts', name);
    fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
    process.stdout.write('Artifact: ' + target + '\n');
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] });
  }
  await capture('practice-measure-width-split-both-dark.png', 'A', 'both', true, 3, 900, 8);
  await capture('practice-measure-width-tab.png', 'B', 'tab', false, 40, 900, 215);

  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the measure width steps run without console errors');
  process.stdout.write('Browser checkpoint: per-measure widths, 90% base column, column spans, and no sideways overflow passed\n');
}

async function testTempoRamp(client, httpPort) {
  const errorsBefore = client.consoleErrors.length;
  const appUrl = `http://127.0.0.1:${httpPort}/index.html`;
  async function loadHome() {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url: appUrl });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= 1 && window.curSong != null', 8000);
  }
  await loadHome();

  // 1. 올림 폭 선택 및 새로고침 유지
  await client.evaluate("document.getElementById('tempoRampStep5').click(); true");
  const afterStep = await client.evaluate(`({
    step: appState.tempoRampStep,
    active5: document.getElementById('tempoRampStep5').getAttribute('data-active'),
    active0: document.getElementById('tempoRampStep0').getAttribute('data-active'),
    stored: JSON.parse(localStorage.getItem('gs.state') || '{}').tempoRampStep
  })`);
  assert.deepEqual(afterStep, { step: 5, active5: 'true', active0: 'false', stored: 5 }, 'TempoRamp step +5 is selected and stored');

  await loadHome();
  const afterReload = await client.evaluate(`({
    step: appState.tempoRampStep,
    active5: document.getElementById('tempoRampStep5').getAttribute('data-active')
  })`);
  assert.deepEqual(afterReload, { step: 5, active5: 'true' }, 'TempoRamp step +5 survives reload');

  // 2. 곡별 목표 BPM 조절, 다른 곡과 분리, 원래 BPM 복원 시 저장값 제거
  await client.evaluate(`(function(){
    changeSongById('builtin-lv1-butterfly');
    document.getElementById('targetBpmUp5').click();
    document.getElementById('targetBpmUp1').click();
    return true;
  })()`);
  const songATarget = await client.evaluate(`({
    def: clampBpm(curSong.bpm, 64),
    num: document.getElementById('targetBpmNum').textContent,
    status: document.getElementById('tempoRampStatus').textContent,
    targets: JSON.parse(localStorage.getItem('gs.state') || '{}').tempoTargets
  })`);
  assert.equal(songATarget.num, String(songATarget.def + 6), 'target BPM increases by +5 and +1');
  assert.equal(songATarget.status, '바퀴마다 +5 → 목표 ' + (songATarget.def + 6) + ' BPM', 'status shows ramp target');
  assert.equal(songATarget.targets['builtin-lv1-butterfly'], songATarget.def + 6, 'song A target is saved');

  await client.evaluate("changeSongById('builtin-lv2-jinglebells'); true");
  const songBDefault = await client.evaluate(`({
    def: clampBpm(curSong.bpm, 64),
    num: document.getElementById('targetBpmNum').textContent,
    status: document.getElementById('tempoRampStatus').textContent
  })`);
  assert.equal(songBDefault.num, String(songBDefault.def), 'song B keeps its own default target BPM');
  assert.equal(songBDefault.status, '목표가 시작 BPM 이하', 'when start == target, status warns');

  // 스크린샷 캡처 (데스크톱 & 320px 모바일 폭)
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  await client.evaluate("changeSongById('builtin-lv1-butterfly'); true");
  await client.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate("document.querySelector('.stage').scrollIntoView({ block: 'start', inline: 'nearest' }); true");
  await new Promise(resolve => setTimeout(resolve, 120));
  const shotDesktop = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(root, 'test-artifacts', 'tempo-ramp-console.png'), Buffer.from(shotDesktop.data, 'base64'));

  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate("document.querySelector('.stage').scrollIntoView({ block: 'start', inline: 'nearest' }); true");
  await new Promise(resolve => setTimeout(resolve, 120));
  const overflow320 = await client.evaluate("document.documentElement.scrollWidth > window.innerWidth");
  assert.equal(overflow320, false, 'TempoRamp console causes no horizontal overflow at 320px');
  const shotMobile = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(root, 'test-artifacts', 'tempo-ramp-console-320.png'), Buffer.from(shotMobile.data, 'base64'));
  await client.send('Emulation.clearDeviceMetricsOverride');

  // 복원: 원래 BPM 복원 시 저장값 제거 및 끔 상태로 초기화
  await client.evaluate("document.getElementById('targetBpmResetBtn').click(); document.getElementById('tempoRampStep0').click(); true");
  const resetDone = await client.evaluate(`({
    step: appState.tempoRampStep,
    hasKey: Object.prototype.hasOwnProperty.call(JSON.parse(localStorage.getItem('gs.state') || '{}').tempoTargets || {}, 'builtin-lv1-butterfly'),
    status: document.getElementById('tempoRampStatus').textContent,
    badge: document.getElementById('loopCountBadge').textContent
  })`);
  assert.deepEqual(resetDone, { step: 0, hasKey: false, status: '올림 꺼짐', badge: '0바퀴' }, 'reset removes stored target and returns to off state');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'no console errors in testTempoRamp');
  process.stdout.write('Browser checkpoint: TempoRamp step persistence, per-song target BPM, 320px layout, and reset passed\n');
}

// 분할 박 커서(TAB 알약 · 유지 음 · 오선 음표, 카드 제외, 재생 중에만 분할 이동)
async function testSubdivisionCursor(client, httpPort) {
  const errorsBefore = client.consoleErrors.length;
  const appUrl = `http://127.0.0.1:${httpPort}/index.html`;
  await client.evaluate("if (typeof isPlaying !== 'undefined' && isPlaying) stopPractice(); true");
  const navBefore = client.events.filter(event => event.method === 'Page.loadEventFired').length;
  await client.send('Page.navigate', { url: appUrl });
  await waitForPageLoadAfter(client, navBefore);
  await waitForCondition(client, 'document.readyState === "complete" && typeof curSong === "object" && curSong !== null && typeof startPractice === "function"', 8000);

  // 1) 정지 중에는 첫 분할(sub 0)만 칠해지고, 박 클릭 후에도 자동 진행하지 않는다
  const stoppedCheck = await client.evaluate(`(async function(){
    changeSongById('builtin-lv6-romance-full');
    setScoreView('tab');
    appState.clickMode = 'off';
    appState.bpm = 48;
    syncConsoleUI();
    var cell0 = document.querySelector('#measuresGrid .beat-cell.tab-cell[data-m="0"][data-b="0"]');
    var sub0Pills = Array.prototype.slice.call(cell0.querySelectorAll('.tab-fret-pill[data-sub="0"]'));
    var sub1Pills = Array.prototype.slice.call(cell0.querySelectorAll('.tab-fret-pill[data-sub="1"]'));
    var sub2Pills = Array.prototype.slice.call(cell0.querySelectorAll('.tab-fret-pill[data-sub="2"]'));
    var initial = {
      sub0Active: sub0Pills.every(function(p){ return p.classList.contains('active-sub'); }),
      sub1Inactive: sub1Pills.every(function(p){ return !p.classList.contains('active-sub'); }),
      sub2Inactive: sub2Pills.every(function(p){ return !p.classList.contains('active-sub'); }),
      bg0: getComputedStyle(sub0Pills[0]).backgroundColor,
      bg1: getComputedStyle(sub1Pills[0]).backgroundColor
    };
    var cell1 = document.querySelector('#measuresGrid .beat-cell.tab-cell[data-m="0"][data-b="1"]');
    cell1.click();
    await new Promise(function(resolve){ setTimeout(resolve, 450); });
    var afterClickSub = Array.prototype.map.call(cell1.querySelectorAll('.tab-fret-pill.active-sub'), function(p){ return p.dataset.sub; });
    return { initial: initial, afterClickSub: afterClickSub };
  })()`);
  assert.equal(stoppedCheck.initial.sub0Active, true, 'while stopped at beat 0, only sub 0 pills are active');
  assert.equal(stoppedCheck.initial.sub1Inactive && stoppedCheck.initial.sub2Inactive, true, 'sub 1 and sub 2 pills are inactive while stopped');
  assert.notEqual(stoppedCheck.initial.bg0, stoppedCheck.initial.bg1, 'active sub 0 pill fill differs from inactive sub 1 pill');
  assert.ok(stoppedCheck.afterClickSub.every(s => s === '0') && stoppedCheck.afterClickSub.length > 0, 'clicking a beat while stopped keeps cursor on sub 0 without animating');

  // 2) 타브 모드 재생: 한 박(48 BPM, 분할당 ~417ms) 안에서 sub 0 -> 1 -> 2 순서대로 이동한다
  await client.evaluate("curMeasureIdx = 0; curBeatIdx = 0; updateActiveCursor(0, 0, false); startPractice(); true");
  const tabSamples = await client.evaluate(`(async function(){
    var seen = [];
    var capturedMid = false;
    var started = Date.now();
    while (Date.now() - started < 2200) {
      var cell = document.querySelector('#measuresGrid .beat-cell.tab-cell.active-beat[data-m="0"][data-b="0"]');
      if (cell) {
        var activeSubs = Array.prototype.map.call(cell.querySelectorAll('.tab-fret-pill.active-sub'), function(p){ return Number(p.dataset.sub); });
        if (activeSubs.length && seen[seen.length - 1] !== activeSubs[0]) seen.push(activeSubs[0]);
        if (activeSubs.indexOf(1) >= 0) {
          var sub0Pill = cell.querySelector('.tab-fret-pill[data-sub="0"]');
          var sub2Pill = cell.querySelector('.tab-fret-pill[data-sub="2"]');
          window.__subCursorMidTab = {
            sub0Bg: getComputedStyle(sub0Pill).backgroundColor,
            sub1Bg: getComputedStyle(cell.querySelector('.tab-fret-pill[data-sub="1"]')).backgroundColor,
            sub2Bg: getComputedStyle(sub2Pill).backgroundColor,
            sub0Past: sub0Pill.classList.contains('past-sub'),
            sub0Opacity: Number(getComputedStyle(sub0Pill).opacity),
            sub2Opacity: Number(getComputedStyle(sub2Pill).opacity)
          };
          capturedMid = true;
          break;
        }
      }
      await new Promise(function(resolve){ setTimeout(resolve, 40); });
    }
    return { seen: seen, capturedMid: capturedMid, styles: window.__subCursorMidTab || null };
  })()`);
  assert.ok(tabSamples.capturedMid, 'during TAB playback, subdivision moves to index 1');
  assert.ok(tabSamples.seen.indexOf(0) >= 0 && tabSamples.seen.indexOf(1) >= 0, 'TAB active-sub advances 0 -> 1');
  assert.notEqual(tabSamples.styles.sub1Bg, tabSamples.styles.sub0Bg, 'at sub 1, sub 1 fill is accent yellow while sub 0 is normal');
  assert.equal(tabSamples.styles.sub0Bg, tabSamples.styles.sub2Bg, 'at sub 1, sub 0 and sub 2 share resting fill');
  assert.equal(tabSamples.styles.sub0Past, true, 'at sub 1, already-played sub 0 carries .past-sub');
  assert.ok(tabSamples.styles.sub0Opacity < 0.8 && tabSamples.styles.sub2Opacity === 1, 'at sub 1, sub 0 is dimmed and upcoming sub 2 is full opacity');
  await client.evaluate("document.getElementById('measuresGrid').scrollIntoView({ block: 'start', inline: 'nearest' }); true");
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  const shotTab = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(root, 'test-artifacts', 'sub-cursor-tab-sub1.png'), Buffer.from(shotTab.data, 'base64'));
  await client.evaluate(`(async function(){
    var started = Date.now();
    var saw2 = false;
    while (Date.now() - started < 1200) {
      var cell = document.querySelector('#measuresGrid .beat-cell.tab-cell.active-beat[data-m="0"][data-b="0"]');
      if (cell && cell.querySelector('.tab-fret-pill[data-sub="2"].active-sub')) { saw2 = true; break; }
      await new Promise(function(resolve){ setTimeout(resolve, 35); });
    }
    stopPractice();
    window.__sawSub2InTab = saw2;
  })()`);
  assert.equal(await client.evaluate('window.__sawSub2InTab'), true, 'TAB active-sub advances to sub 2');

  // 3) 둘 다 / 오선 모드: 오선 음표(.st-chord.active-sub)도 분할에 맞춰 강조색으로 이동하고 카드 보기는 제외한다
  await client.evaluate("setScoreView('both'); curMeasureIdx = 0; curBeatIdx = 0; updateActiveCursor(0, 0, false); true");
  await waitForCondition(client, 'document.querySelectorAll("#measuresGrid .tab-staff-layer .st-chord").length > 0', 4000);
  await client.evaluate("startPractice(); true");
  const bothCheck = await client.evaluate(`(async function(){
    var started = Date.now();
    var res = null;
    while (Date.now() - started < 2200) {
      var layer = document.querySelector('#measuresGrid .measure-card[data-m="0"] .tab-staff-layer');
      var cell = document.querySelector('#measuresGrid .beat-cell.tab-cell.active-beat[data-m="0"][data-b="0"]');
      var chord1 = layer && layer.querySelector('.st-chord[data-cell="0"][data-unit="4"]');
      var chord0 = layer && layer.querySelector('.st-chord[data-cell="0"][data-unit="0"]');
      var chord2 = layer && layer.querySelector('.st-chord[data-cell="0"][data-unit="8"]');
      if (cell && chord1 && chord1.classList.contains('active-sub')) {
        res = {
          tabSub1Active: cell.querySelector('.tab-fret-pill[data-sub="1"]').classList.contains('active-sub'),
          tabSub0Past: cell.querySelector('.tab-fret-pill[data-sub="0"]').classList.contains('past-sub'),
          chord0Active: chord0 ? chord0.classList.contains('active-sub') : null,
          chord0Past: chord0 ? chord0.classList.contains('past-sub') : null,
          chord0Opacity: chord0 ? Number(getComputedStyle(chord0).opacity) : null,
          chord2Opacity: chord2 ? Number(getComputedStyle(chord2).opacity) : null,
          chord1Color: getComputedStyle(chord1).color,
          chord0Color: chord0 ? getComputedStyle(chord0).color : null
        };
        break;
      }
      await new Promise(function(resolve){ setTimeout(resolve, 40); });
    }
    return res;
  })()`);
  assert.ok(bothCheck && bothCheck.tabSub1Active && bothCheck.tabSub0Past, 'in both view, staff note at unit 4 turns active in sync with TAB sub 1 and dims unit 0');
  assert.equal(bothCheck.chord0Active, false, 'previous staff note unit 0 is no longer active at sub 1');
  assert.equal(bothCheck.chord0Past, true, 'previous staff note unit 0 in the active beat carries .past-sub');
  assert.ok(bothCheck.chord0Opacity < 0.8 && bothCheck.chord2Opacity === 1, 'previous staff note is dimmed while upcoming unit 8 stays full opacity');
  assert.notEqual(bothCheck.chord1Color, bothCheck.chord0Color, 'active staff note color differs from inactive staff note color');
  await client.evaluate("document.getElementById('measuresGrid').scrollIntoView({ block: 'start', inline: 'nearest' }); true");
  const shotBoth = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(root, 'test-artifacts', 'sub-cursor-both-sub1.png'), Buffer.from(shotBoth.data, 'base64'));
  await client.evaluate("stopPractice(); true");
  await client.send('Emulation.clearDeviceMetricsOverride');

  // 오선 전용 보기 확인 및 카드 보기 제외 확인
  await client.evaluate("setScoreView('staff'); curMeasureIdx = 0; curBeatIdx = 0; updateActiveCursor(0, 0, false); true");
  await waitForCondition(client, 'document.querySelectorAll("#measuresGrid .tab-staff-layer .st-chord.active-sub").length === 1', 4000);
  await client.evaluate("setScoreView('card'); curMeasureIdx = 0; curBeatIdx = 0; updateActiveCursor(0, 0, false); true");
  const cardExcluded = await client.evaluate(`({
    activeSubCount: document.querySelectorAll('#measuresGrid .active-sub').length,
    activeBeatCount: document.querySelectorAll('#measuresGrid .beat-cell.active-beat').length
  })`);
  assert.deepEqual(cardExcluded, { activeSubCount: 0, activeBeatCount: 1 }, 'card view keeps beat-level cursor and excludes .active-sub');

  // 4) 유지(-) 음과 분할 유지 음: 파란 알약(.tab-held-fret.active-sub)과 오선 지속 음표가 같이 칠해진다
  const heldPlayback = await client.evaluate(`(async function(){
    var parsed = GuitarParser.parseScore('E3/- E3 - r', 4);
    var tempSong = { id: '__sub-held-test__', title: 'Held Test', type: 'structured', beats: 4, bpm: 60, measures: parsed.measures };
    allSongs.push(tempSong);
    changeSongById('__sub-held-test__');
    setScoreView('both');
    await new Promise(function(resolve){ setTimeout(resolve, 60); });
    curMeasureIdx = 0; curBeatIdx = 0;
    updateActiveCursor(0, 0, false);
    startPractice();
    var started = Date.now();
    var subHold = null, beatHold = null;
    while (Date.now() - started < 4500 && (!subHold || !beatHold)) {
      var c0 = document.querySelector('#measuresGrid .beat-cell.tab-cell.active-beat[data-m="0"][data-b="0"]');
      var c2 = document.querySelector('#measuresGrid .beat-cell.tab-cell.active-beat[data-m="0"][data-b="2"]');
      var layer = document.querySelector('#measuresGrid .measure-card[data-m="0"] .tab-staff-layer');
      if (!subHold && c0) {
        var hp0 = c0.querySelector('.tab-held-fret.active-sub');
        var ch0 = layer && layer.querySelector('.st-chord[data-cell="0"]');
        if (hp0) {
          subHold = {
            sub: hp0.dataset.sub,
            opacity: getComputedStyle(hp0).opacity,
            bgDiff: getComputedStyle(hp0).backgroundColor !== getComputedStyle(c0.querySelector('.tab-fret-pill[data-sub="0"]')).backgroundColor,
            staffChord0Active: ch0 ? ch0.classList.contains('active-sub') : false
          };
        }
      }
      if (!beatHold && c2) {
        var hp2 = c2.querySelector('.tab-held-fret.active-sub');
        var ch1 = layer && layer.querySelector('.st-chord[data-cell="1"]');
        if (hp2) {
          beatHold = {
            bgActive: getComputedStyle(hp2).backgroundColor,
            staffHalfActive: ch1 ? ch1.classList.contains('active-sub') : false
          };
        }
      }
      await new Promise(function(resolve){ setTimeout(resolve, 35); });
    }
    stopPractice();
    allSongs = allSongs.filter(function(s){ return s.id !== '__sub-held-test__'; });
    changeSongById(allSongs[0].id);
    setScoreView('tab');
    appState.clickMode = 'all';
    return { subHold: subHold, beatHold: beatHold };
  })()`);
  assert.ok(heldPlayback.subHold && heldPlayback.subHold.sub === '1' && heldPlayback.subHold.opacity === '1' && heldPlayback.subHold.bgDiff && heldPlayback.subHold.staffChord0Active,
    'subdivided hold pill lights up blue together with sustaining staff note: ' + JSON.stringify(heldPlayback.subHold));
  assert.ok(heldPlayback.beatHold && heldPlayback.beatHold.staffHalfActive,
    'full-beat hold lights up held pill and sustaining half note on staff: ' + JSON.stringify(heldPlayback.beatHold));

  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'no console errors in testSubdivisionCursor');
  process.stdout.write('Browser checkpoint: subdivision cursor (TAB pills, held notes, staff notes, card exclusion, playback-only motion) passed\n');
}

async function main() {
  const appHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scriptTags = [...appHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scriptTags.map(src => src.split('?')[0]), ['src/storage.js', 'src/app-state.js', 'src/notation.js', 'src/rhythm.js', 'src/parser.js', 'src/staff-layout.js', 'src/staff-svg.js', 'src/score-drafts.js', 'src/score.js', 'src/audio.js', 'src/guide.js', 'src/image-analysis.js', 'src/fretboard.js', 'src/score-ui.js', 'src/sheets.js', 'src/score-prompt.js', 'src/score-editor.js', 'src/gdrive.js', 'src/app.js'], 'app classic scripts keep the required order');
  assert.ok(scriptTags.every(src => src.endsWith('?v=sub-cursor-2')), 'all app scripts use the shared revision');
  const htmlIds = ['editInInputBtn','resetScoreDraftBtn','scoreDraftStatus','copyCurSongTsvBtn','copyScorePromptBtn','copyProjectPromptBtn','scorePromptStatus','sheetLoadStatus','uncertainBadge'];
  htmlIds.forEach(function(id){assert.match(appHtml,new RegExp('id="'+id+'"'),'draft UI includes #'+id);});
  ['addBlankScoreBtn','blankScoreModal','undoScoreEditBtn'].forEach(function(id){assert.doesNotMatch(appHtml,new RegExp('id="'+id+'"'),'removed in-page editing UI has no #'+id);});
  assert.doesNotMatch(fs.readFileSync(path.join(root,'index.html'),'utf8'),/\.beat-cell\.arp-(?:melody|sub)\b/,'obsolete articulation color rules are removed from the score stylesheet');

  await runBrowserSuite({
    onNewDocument: `(function(){
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
    })();`
  }, async ({ cdp, httpPort }) => {

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
    // 지판 칸 수는 GuitarNotation.MAX_FRET 하나가 정하고, 폴드를 펼친 폭(900)과 768에서 한 화면에 다 들어가며 머리 줄 글자가 칸 폭을 넘지 않는다
    const fretboardMaxFret = await cdp.evaluate('GuitarNotation.MAX_FRET');
    assert.equal(await cdp.evaluate('document.querySelector("#fretboard .fb-row").querySelectorAll(".fb-cell").length'), fretboardMaxFret, 'a fretboard row has one cell per fret up to GuitarNotation.MAX_FRET');
    for (const fretboardWidth of [900, 768]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: fretboardWidth, height: 1000, deviceScaleFactor: 1, mobile: false });
      const fit = await cdp.evaluate(`(function(){
        var wrap = document.getElementById('fretboardWrap');
        var board = document.getElementById('fretboard');
        var heads = Array.prototype.slice.call(board.querySelectorAll('.fb-frets-header span'));
        var cell = board.querySelector('.fb-row .fb-cell');
        return {
          wrapScroll: wrap.scrollWidth, wrapClient: wrap.clientWidth, boardWidth: board.getBoundingClientRect().width,
          cellWidth: cell.getBoundingClientRect().width,
          headCount: heads.length,
          clipped: heads.filter(function(span){ return span.scrollWidth > span.clientWidth + 1; }).map(function(span){ return span.textContent; }),
          wrapped: heads.filter(function(span){
            var range = document.createRange();
            range.selectNodeContents(span);
            return range.getClientRects().length !== 1;
          }).map(function(span){ return span.textContent; })
        };
      })()`);
      assert.ok(fit.wrapScroll <= fit.wrapClient + 1, 'the fretboard fits inside its wrapper without scrolling at width ' + fretboardWidth + ': ' + JSON.stringify(fit));
      assert.equal(fit.headCount, fretboardMaxFret + 1, 'the header row has the open label plus one label per fret');
      assert.deepEqual(fit.clipped, [], 'no fret header label is wider than its cell at width ' + fretboardWidth);
      assert.deepEqual(fit.wrapped, [], 'every fret header label stays on one line at width ' + fretboardWidth);
      process.stdout.write('Fretboard fit at width ' + fretboardWidth + ': cell ' + fit.cellWidth.toFixed(1) + 'px\n');
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');

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
    await testVolumeSliders(cdp);
    await testBuiltinScores(cdp);
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

    const imageUsability = await cdp.evaluate(`(async function(){
      var savedSong = curSong;
      var savedScanScoreSystems = window.GuitarImageAnalysis && window.GuitarImageAnalysis.scanScoreSystems;
      var alerts = [];
      var savedAlert = window.alert;
      window.alert = function(msg){ alerts.push(String(msg)); };

      var customSong = {
        id:'browser-image-usability-test',
        title:'Image usability',
        type:'image',
        imageDataUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
        systems:[{
          x: 0.15, y: 0.10, w: 0.72, h: 0.14,
          bars:[{ chord:'Am', note:'A3', memo:'first', w:1.8 }, { chord:'', note:'', memo:'', w:0.6 }]
        }]
      };
      curSong = customSong;
      renderSong();

      // 1. 새 줄 추가 시 직전 줄의 크기/위치 및 마디 구성 상속
      document.getElementById('addSystemRowBtn').click();
      var sys1 = customSong.systems[0];
      var sys2 = customSong.systems[1];
      var rowInherited = customSong.systems.length === 2 &&
        sys2.x === sys1.x && sys2.w === sys1.w && sys2.h === sys1.h &&
        sys2.bars.length === 2 && sys2.bars[0].w === 1.8 && sys2.bars[1].w === 0.6 &&
        sys2.bars[0].chord === '' && sys2.y >= sys1.y + sys1.h;

      // 2. 줄 복제 버튼 클릭
      var cloneBtn = document.querySelector('.sys-box[data-sys="0"] button[title*="복사"]');
      if (cloneBtn) cloneBtn.click();
      var duplicated = customSong.systems.length === 3 &&
        customSong.systems[1].x === sys1.x && customSong.systems[1].w === sys1.w &&
        customSong.systems[1].bars.length === 2;

      // 3. 전체 자동 감지 버튼 클릭
      window.GuitarImageAnalysis.scanScoreSystems = function(){
        return Promise.resolve([
          { x: 0.08, y: 0.12, w: 0.84, h: 0.15, bars: [{ chord:'', note:'', memo:'', w:1 }] },
          { x: 0.08, y: 0.35, w: 0.84, h: 0.15, bars: [{ chord:'', note:'', memo:'', w:1 }] }
        ]);
      };
      window.confirm = function(){ return true; };
      document.getElementById('autoDetectAllBtn').click();
      await new Promise(function(resolve){ setTimeout(resolve, 30); });
      var autoDetected = customSong.systems.length === 2 && alerts.some(function(m){ return m.indexOf('자동으로 감지') >= 0; });

      window.alert = savedAlert;
      if (savedScanScoreSystems) window.GuitarImageAnalysis.scanScoreSystems = savedScanScoreSystems;
      curSong = savedSong;
      renderSong();

      return { rowInherited: rowInherited, duplicated: duplicated, autoDetected: autoDetected };
    })()`);
    assert.deepEqual(imageUsability, { rowInherited: true, duplicated: true, autoDetected: true }, 'image score row inheritance, duplication, and auto-detection work as expected');

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
    const screenshotTarget = path.join(screenshotDir, 'beginner-rhythm-review.png');
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
    await testFretLabel(cdp, httpPort);
    await testNaturalHarmonics(cdp, httpPort);
    await testSlurLabels(cdp, httpPort);
    await testSlideLabels(cdp, httpPort);
    await testRollMarks(cdp, httpPort);
    await testSkipCells(cdp, httpPort);
    await testCountInCountdown(cdp, httpPort);
    await testMeasureWidth(cdp, httpPort);
    await testTempoRamp(cdp, httpPort);
    await testSubdivisionCursor(cdp, httpPort);

    process.stdout.write('Result: browser practice smoke passed (boot, scores, edit UI, image library, Web Audio, staff/TAB views, 0 console errors)\n');
  });
}

main().catch(err => {
  console.error('Browser smoke test failed:', err);
  process.exitCode = 1;
});