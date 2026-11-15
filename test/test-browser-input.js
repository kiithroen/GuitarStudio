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
      scrollWidth:toolbar.scrollWidth, clientWidth:toolbar.clientWidth,
      chordCards:document.querySelectorAll('#chordCards > *').length,
      page:(function(){
        // 코드가 많은 곡: 코드 카드 줄은 가로로 스크롤돼야지 페이지를 넓히면 안 된다
        var cards = document.getElementById('chordCards');
        var extra = [];
        for (var k = 0; cards.firstElementChild && k < 12; k++) extra.push(cards.appendChild(cards.firstElementChild.cloneNode(true)));
        var size = { scroll:document.documentElement.scrollWidth, client:document.documentElement.clientWidth };
        extra.forEach(function(el){ el.remove(); });
        return size;
      })()
    };
  })()`;
  for (const fitWidth of [640, 768, 900, 984, 1092]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width: fitWidth, height: 1000, deviceScaleFactor: 1, mobile: false });
    const fit = await client.evaluate(toolbarFitProbe);
    assert.deepEqual(fit.overlaps, [], fitWidth + 'px toolbar items overlap: ' + fit.overlaps.join(', ') + ' [' + fit.widths + ']');
    assert.equal(fit.statusShown, false, fitWidth + 'px normal mode hides the BPM badge');
    assert.equal(fit.capoShown, true, fitWidth + 'px toolbar shows the capo 3 badge');
    if (fitWidth >= 900) assert.ok(fit.scrollWidth <= fit.clientWidth + 1, fitWidth + 'px toolbar has no horizontal scroll (' + fit.scrollWidth + ' > ' + fit.clientWidth + ') [' + fit.widths + ']');
    // 아래 두 칸(.two-col, 운지 가이드·유튜브)까지 페이지 전체가 가로로 넘치지 않는다
    assert.ok(fit.chordCards > 0, fitWidth + 'px the loaded song shows chord cards to stretch');
    assert.ok(fit.page.scroll <= fit.page.client + 1, fitWidth + 'px page with many chord cards has no horizontal scroll (' + fit.page.scroll + ' > ' + fit.page.client + ')');
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

// 악보 입력 화면(score-input.html): 실제 클릭·키 이벤트로 입력하고 결과 텍스트를 본다.
async function testScoreInputScreen(client, httpPort) {
  const inputHtml = fs.readFileSync(path.join(root, 'score-input.html'), 'utf8');
  const inputScripts = [...inputHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(inputScripts.map(src => src.split('?')[0]), ['src/storage.js', 'src/app-state.js', 'src/notation.js', 'src/rhythm.js', 'src/parser.js', 'src/score-ui.js', 'src/score-prompt.js', 'src/audio.js', 'src/guide.js', 'src/staff-layout.js', 'src/staff-svg.js', 'src/tab-input.js', 'src/staff-input.js', 'src/tab-input-ui.js'], 'score-input.html classic scripts keep the required order');
  assert.ok(inputScripts.every(src => src.endsWith('?v=chord-label-1')), 'score-input.html scripts use the page revision');
  assert.match(inputHtml, /<link rel="stylesheet" href="src\/base\.css\?v=chord-label-1">/, 'score-input.html loads the shared base stylesheet');
  assert.match(inputHtml, /family=Noto\+Music/, 'score-input.html loads the Noto Music font for the staff');
  ['tiTitle', 'tiBeats', 'tiBpm', 'tiDescription', 'tiCapoSelect', 'tiKeySelect', 'tiNewBtn', 'tiImportBtn', 'tiUndoBtn', 'tiRedoBtn', 'tiSaveStatus', 'tiStatus',
    'tiSelectionBar', 'tiSelectionLabel', 'tiCopyBtn', 'tiPasteBtn', 'tiDuplicateBtn', 'tiClearBtn', 'tiDeleteBtn', 'tiInsertBtn', 'tiDeselectBtn', 'tiMeasures', 'tiAddMeasureBtn',
    'tiResultPanel', 'tiDiagnostics', 'tiScoreText', 'tiCopyTextBtn', 'tiCopyTsvBtn', 'tiOpenPracticeBtn', 'tiResultStatus', 'tiDock', 'tiCursorLabel', 'tiPrevBtn', 'tiNextBtn',
    'tiRestBtn', 'tiClearSlotBtn', 'tiDiv1', 'tiDiv2', 'tiDiv3', 'tiDiv4', 'tiPlaySlotBtn', 'tiPlayMeasureBtn', 'tiAutoAdvance', 'tiSoundToggle', 'tiStaffToggle', 'tiDockToggle', 'tiFretboard', 'tiAttrs', 'tiUncertainBtn', 'tiRollBtn',
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
  // 입력판 한 줄은 0프렛부터 GuitarNotation.MAX_FRET까지 칸 하나씩이고, 격자 열도 줄 번호 열 하나를 더해 그만큼이다
  const inputBoard = await client.evaluate(`(function(){
    var board = document.getElementById('tiFretboard');
    return {
      maxFret: GuitarNotation.MAX_FRET,
      perRow: Array.prototype.map.call(board.querySelectorAll('.ti-fb-row'), function(row){ return row.querySelectorAll('.ti-fret').length; }),
      columns: getComputedStyle(board).gridTemplateColumns.split(' ').length
    };
  })()`);
  assert.deepEqual(inputBoard.perRow, [1, 2, 3, 4, 5, 6].map(() => inputBoard.maxFret + 1), 'every string row of the input fretboard has one button per fret from 0 to GuitarNotation.MAX_FRET');
  assert.equal(inputBoard.columns, inputBoard.maxFret + 2, 'the input fretboard grid has the string-number column plus one column per fret');
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

  // 2b. 마디 듣기(단추와 Shift+Space): 커서가 있는 마디의 각 칸을 scheduleBeatGuide로 예약한다
  const measurePlay = await client.evaluate(`(function(){
    var calls = [];
    var origSchedule = window.scheduleBeatGuide;
    var origEnsure = window.ensureAudioCtx;
    var origStop = window.stopGuitarNotes;
    window.ensureAudioCtx = function(){ return { currentTime: 10 }; };
    window.stopGuitarNotes = function(){};
    window.scheduleBeatGuide = function(beat, opts){ calls.push({ tok: beat.tok, startTime: opts.startTime, maxDurationSlots: opts.maxDurationSlots }); return []; };
    try {
      document.getElementById('tiPlayMeasureBtn').click();
      var fromBtn = calls.length;
      __tiTest.key(' ', 'Space', { shiftKey: true });
      var fromKey = calls.length - fromBtn;
      return { fromBtn: fromBtn, fromKey: fromKey, first: calls[0], last: calls[calls.length - 1] };
    } finally {
      window.scheduleBeatGuide = origSchedule;
      window.ensureAudioCtx = origEnsure;
      window.stopGuitarNotes = origStop;
    }
  })()`);
  assert.equal(measurePlay.fromBtn, 4, 'clicking #tiPlayMeasureBtn schedules all 4 non-skip beats in the current measure');
  assert.equal(measurePlay.fromKey, 4, 'Shift+Space schedules all 4 non-skip beats in the current measure');
  assert.equal(measurePlay.first.maxDurationSlots, 4, 'first beat has 4 remaining slots in the measure');
  assert.equal(measurePlay.last.maxDurationSlots, 1, 'last beat has 1 remaining slot in the measure');

  // 2c. 마디 중반 코드 입력 (.ti-cell-chord-input 및 .ti-cell-chord 배지)
  const midChordUi = await client.evaluate(`(function(){
    var card = document.querySelector('#tiMeasures .ti-measure[data-m="0"]');
    var chordIn = card.querySelector('.ti-chord');
    var cellIn = card.querySelector('.ti-cell-chord-input');
    chordIn.value = 'Am';
    chordIn.dispatchEvent(new Event('input', { bubbles:true }));
    chordIn.dispatchEvent(new Event('change', { bubbles:true }));
    card.querySelector('.ti-cell-head[data-c="2"]').click();
    var ph = cellIn.placeholder;
    cellIn.value = 'G7';
    cellIn.dispatchEvent(new Event('input', { bubbles:true }));
    cellIn.dispatchEvent(new Event('change', { bubbles:true }));
    var badge = card.querySelector('.ti-cell-head[data-c="2"] .ti-cell-chord');
    var lineWithMid = __tiTest.text().split('\\n')[0];
    var syncedChord = chordIn.value;
    // 원상 복구
    chordIn.value = '';
    chordIn.dispatchEvent(new Event('input', { bubbles:true }));
    chordIn.dispatchEvent(new Event('change', { bubbles:true }));
    return { ph: ph, badge: badge ? badge.textContent : null, lineWithMid: lineWithMid, syncedChord: syncedChord };
  })()`);
  assert.equal(midChordUi.ph, '3칸 코드', 'clicking beat 3 updates the cell chord input placeholder to 3칸 코드');
  assert.equal(midChordUi.syncedChord, 'Am, 3:G7', 'typing G7 in 3칸 코드 updates the measure chord input to Am, 3:G7');
  assert.equal(midChordUi.badge, 'G7', 'beat 3 cell head shows the mid-measure chord badge G7');
  assert.ok(midChordUi.lineWithMid.startsWith('[Am, 3:G7] '), 'score line starts with [Am, 3:G7]');

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
// 입력판 운지 열(#tiAttrs, 폭 272px)이 넘치지 않고 단추가 잘리지 않으며 보이는 힌트와 겹치지 않는지. 입력판을 펼친 상태로 900×1000, 1024×768, 1280×900에서 잰다.
async function checkAttrsColumn(client, mode) {
  for (const [width, height] of [[900, 1000], [1024, 768], [1280, 900]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await client.evaluate('window.scrollTo(0, 0); true');
    const m = await client.evaluate(`(function(){
      var attrs = document.getElementById('tiAttrs');
      var box = attrs.getBoundingClientRect();
      var buttons = Array.prototype.slice.call(attrs.querySelectorAll('.btn'));
      var out = { collapsed: document.getElementById('tiDock').classList.contains('is-collapsed'), scroll: attrs.scrollWidth, client: attrs.clientWidth, buttons: buttons.length, overflowRight: 0, btnBottom: 0, labels: [], hints: [] };
      buttons.forEach(function(btn){
        var r = btn.getBoundingClientRect();
        out.overflowRight = Math.max(out.overflowRight, r.right - box.right);
        out.btnBottom = Math.max(out.btnBottom, r.bottom);
      });
      Array.prototype.forEach.call(attrs.querySelectorAll('.label'), function(label){
        var style = getComputedStyle(label);
        var lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
        out.labels.push({ text: label.textContent.trim(), height: label.getBoundingClientRect().height, lineHeight: lineHeight });
      });
      Array.prototype.forEach.call(document.querySelectorAll('.ti-dock-hint'), function(hint){
        if (getComputedStyle(hint).display === 'none' || hint.hidden || hint.getClientRects().length === 0) return;
        out.hints.push({ id: hint.id, top: hint.getBoundingClientRect().top });
      });
      return out;
    })()`);
    const where = mode + ' mode at ' + width + 'x' + height + ' ' + JSON.stringify(m);
    assert.equal(m.collapsed, false, 'the input dock is open: ' + where);
    assert.ok(m.buttons > 0, 'the attribute column has buttons: ' + where);
    assert.ok(m.scroll <= m.client + 1, 'the finger column does not overflow its width (scrollWidth ' + m.scroll + ' > clientWidth ' + m.client + '): ' + where);
    assert.ok(m.overflowRight <= 1, 'no attribute button sticks out of the finger column on the right (' + m.overflowRight + 'px): ' + where);
    m.labels.forEach(label => assert.ok(label.height <= label.lineHeight * 1.5, 'the label "' + label.text + '" stays on one line (height ' + label.height + ', line height ' + label.lineHeight + '): ' + where));
    assert.equal(m.hints.length, 1, 'exactly one shortcut hint is visible: ' + where);
    m.hints.forEach(hint => assert.ok(hint.top >= m.btnBottom, 'the shortcut hint does not overlap the attribute buttons (hint top ' + hint.top + ' < button bottom ' + m.btnBottom + '): ' + where));
    process.stdout.write('Checks: ' + mode + ' finger column ' + width + 'x' + height + ' scroll ' + m.scroll + '/' + m.client + ' overflow ' + m.overflowRight + ' buttonBottom ' + m.btnBottom + ' hintTop ' + (m.hints[0] ? m.hints[0].top : '-') + '\n');
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await client.evaluate('window.scrollTo(0, 0); true');
}

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

  // 1b. 음 고르는 오선의 음역: 맨 위 띠는 기타 음역 상한(1번 줄 개방 + MAX_FRET)의 적는 음(실음 + 12)이고 맨 아래는 적는 E3(-7).
  //     위 덧줄은 10부터 맨 위 띠까지 짝수마다 있고, 화면 높이는 늘지 않는다. 기대는 STRINGS·MAX_FRET에서 셈한다.
  const range = await client.evaluate(`(function(){
    var topMidi = GuitarParser.STRINGS[0].midi + GuitarNotation.MAX_FRET;
    var writtenName = GuitarParser.noteNameForMidi(topMidi + 12, false);
    var octave = Number(/-?\\d+$/.exec(writtenName)[0]);
    var expectedTop = octave * 7 + 'CDEFGAB'.indexOf(writtenName.charAt(0)) - 30;
    var steps = Array.prototype.map.call(document.querySelectorAll('#tiPitchPicker .ti-pick-band'), function(b){ return Number(b.dataset.step); });
    var ledgerYs = Array.prototype.map.call(document.querySelectorAll('#tiPitchPicker .ti-pick-ledger'), function(l){ return Number(l.getAttribute('y1')); });
    var expectedUp = [];
    for (var st = 10; st <= expectedTop; st += 2) expectedUp.push(GuitarStaffSvg.BASE_Y - st * GuitarStaffSvg.LINE_GAP / 2);
    var viewBox = document.getElementById('tiPitchPicker').getAttribute('viewBox').split(' ').map(Number);
    var rect = document.getElementById('tiPitchPicker').getBoundingClientRect();
    return { topMidi: topMidi, topName: GuitarParser.noteNameForMidi(topMidi, false), writtenName: writtenName, expectedTop: expectedTop, top: Math.max.apply(null, steps), bottom: Math.min.apply(null, steps), count: steps.length,
      upLedgers: ledgerYs.filter(function(y){ return y < GuitarStaffSvg.BASE_Y - 4 * GuitarStaffSvg.LINE_GAP; }).sort(function(a, b){ return b - a; }),
      expectedUp: expectedUp, viewTop: viewBox[1], viewBottom: viewBox[1] + viewBox[3], topBandY: GuitarStaffSvg.BASE_Y - expectedTop * GuitarStaffSvg.LINE_GAP / 2,
      height: rect.height, stepPx: rect.height / (viewBox[3] / (GuitarStaffSvg.LINE_GAP / 2)) };
  })()`);
  assert.ok(range.expectedTop > 14, 'the written top note is above the old E6 limit: ' + JSON.stringify(range));
  assert.equal(range.top, range.expectedTop, 'the top picker band is the written guitar range limit ' + range.writtenName);
  assert.equal(range.bottom, -7, 'the bottom picker band is the written E3');
  assert.equal(range.count, range.expectedTop + 7 + 1, 'every step between the bottom and the top has a band');
  assert.ok(range.expectedUp.length >= 3 && range.expectedUp.length === range.upLedgers.length, 'one upper ledger line per even step from 10 to the top: ' + JSON.stringify(range));
  assert.deepEqual(range.upLedgers.slice().sort((a, b) => b - a), range.expectedUp.slice().sort((a, b) => b - a), 'the upper ledger lines sit at the even steps from 10 up to the top band');
  assert.ok(range.viewTop < range.topBandY, 'the visible range reaches above the top band so its note head is not cut off: ' + JSON.stringify(range));
  assert.ok(Math.abs(range.height - 166) <= 1, 'the picker keeps the same on-screen height (is ' + range.height + ')');
  assert.ok(range.stepPx > 5 && range.stepPx < 7, 'a staff step is about 6px (is ' + range.stepPx + ')');
  const emptyText = await text();
  const emptyCursor = await client.evaluate('__tiTest.cursor()');
  await client.evaluate(`__tiTest.clickBand(${range.expectedTop}, false); true`);
  assert.ok((await line(0)).indexOf(range.topName + '@1') >= 0, 'clicking the top band writes the highest guitar note (' + await line(0) + ')');
  await client.evaluate(`__tiTest.key('z', 'KeyZ', { ctrlKey:true }); true`);
  assert.equal(await text(), emptyText, 'undo removes the note written from the top band');
  assert.equal(await client.evaluate('__tiTest.cursor()'), emptyCursor, 'undo leaves the cursor where it was');

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
  await checkAttrsColumn(client, 'staff');
  assert.ok(tablet.info <= 150, 'the 1024x768 song info panel is at most 150px tall (is ' + tablet.info + ')');
  assert.ok(tablet.panel.scroll <= tablet.panel.client, 'the picker and buttons fit the dock at 1024px even with five sharps (' + JSON.stringify(tablet.panel) + ')');
  assert.deepEqual([tablet.hint !== 'none', tablet.tabHint], [true, true], 'the staff shortcut hint replaces the tab hint at 900px and wider');
  await client.evaluate(`__tiTest.setKey('1'); true`);
  await client.evaluate(`document.getElementById('tiModeTab').click(); window.scrollTo(0, 0); true`);
  const tabDock = await client.evaluate('__tiTest.dock()');
  assert.ok(tabDock <= 210, 'the 1024x768 tab input dock stays at most 210px tall (is ' + tabDock + ')');
  await checkAttrsColumn(client, 'tab');
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

  // 13. H 키와 하모닉스 단추(오선 모드): 누른 자리를 손 대는 자리로 보고, 그 줄의 프렛이 하모닉스 프렛이 아니면 줄을 옮겨 켠다. 기대는 STRINGS·NATURAL_HARMONICS에서 따로 셈한다.
  const harmErrorsBefore = client.consoleErrors.length;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate(`document.getElementById('tiNewBtn').click(); __tiTest.key('5', 'Digit5'); true`);
  await client.evaluate('__tiTest.clickBand(2, false); true');
  const staffHarm = await client.evaluate(`(function(){
    var t = __tiTest;
    var table = GuitarNotation.NATURAL_HARMONICS;
    var frets = Object.keys(table).map(Number).sort(function(a, b){ return b - a; });
    var hBtn = document.querySelector('[data-attr="art"][data-value="h"]');
    function press(){ var e = new KeyboardEvent('keydown', { key:'h', code:'KeyH', bubbles:true, cancelable:true }); document.body.dispatchEvent(e); return e.defaultPrevented; }
    function firstToken(){ return t.text().split('\\n')[0].split(' ')[1]; }
    var out = { premise: {} };
    var start = firstToken().match(/@(\\d)$/);
    var str0 = Number(start[1]);
    var fret0 = Number(t.pos(0,0,0,str0).querySelector('.ti-pos-label').textContent);
    var midi = GuitarParser.STRINGS[str0 - 1].midi + fret0;
    var cands = [];
    for (var s = 1; s <= 6; s++) {
      if (s === str0) continue;
      var f = midi - GuitarParser.STRINGS[s - 1].midi;
      if (frets.indexOf(f) >= 0) cands.push({ str:s, fret:f });
    }
    cands.sort(function(a, b){ return frets.indexOf(a.fret) - frets.indexOf(b.fret) || a.str - b.str; });
    out.premise = { startHarmonic: frets.indexOf(fret0) >= 0, cands: cands.length };
    var doc = GuitarTabInput.createDoc();
    GuitarTabInput.setNote(doc, { m:0, c:0, s:0 }, str0, fret0);
    out.target = GuitarStaffInput.harmonicTarget(doc, { m:0, c:0, s:0 }, str0);
    out.expected = cands[0];
    out.btnEnabled = !hBtn.disabled;
    out.prevented = press();
    var token = firstToken();
    out.token = token;
    out.expectedToken = 'h' + GuitarParser.noteNameForMidi(GuitarParser.STRINGS[cands[0].str - 1].midi + table[cands[0].fret], false) + '@' + cands[0].str;
    out.cursor = t.cursor();
    out.pressed = hBtn.getAttribute('aria-pressed');
    out.btnAfter = !hBtn.disabled;
    var handNode = t.pos(0,0,0,cands[0].str).querySelector('.ti-pos-label'); out.handLabel = handNode ? handNode.textContent : '';
    var beforeButton = t.text();
    hBtn.click();
    out.buttonKeepsOn = t.text() === beforeButton;
    press();
    out.offToken = firstToken();
    out.expectedOff = GuitarParser.noteNameForMidi(GuitarParser.STRINGS[cands[0].str - 1].midi + cands[0].fret, false) + '@' + cands[0].str;
    out.offPressed = hBtn.getAttribute('aria-pressed');
    hBtn.click();
    out.buttonOn = firstToken();
    return out;
  })()`);
  assert.equal(staffHarm.premise.startHarmonic, false, 'the staff test note starts on a non-harmonic fret: ' + JSON.stringify(staffHarm.premise));
  assert.ok(staffHarm.premise.cands > 0, 'the staff test note has a harmonic alternative string: ' + JSON.stringify(staffHarm.premise));
  assert.equal(staffHarm.prevented, true, 'the H key is handled in staff mode');
  assert.equal(staffHarm.btnEnabled, true, 'the harmonic button is enabled when another string can play the harmonic');
  assert.deepEqual({ str: staffHarm.target.str, fret: staffHarm.target.fret, same: staffHarm.target.same }, { str: staffHarm.expected.str, fret: staffHarm.expected.fret, same: false }, 'harmonicTarget matches the independent calculation');
  assert.equal(staffHarm.token, staffHarm.expectedToken, 'H writes the harmonic on the target string: ' + JSON.stringify(staffHarm));
  assert.ok(staffHarm.cursor.indexOf(staffHarm.expected.str + '번 줄') >= 0, 'the cursor string follows the moved note: ' + staffHarm.cursor);
  assert.equal(staffHarm.pressed, 'true', 'the harmonic button is pressed after H');
  assert.equal(staffHarm.btnAfter, true, 'a harmonic note keeps the button enabled');
  assert.ok(staffHarm.handLabel.indexOf('<' + staffHarm.expected.fret + '>') >= 0, 'the TAB label shows the hand fret: ' + staffHarm.handLabel);
  assert.equal(staffHarm.buttonKeepsOn, true, 'the button on a harmonic note leaves it as it is');
  assert.equal(staffHarm.offToken, staffHarm.expectedOff, 'H again turns it off, the plain note stays on the moved string: ' + staffHarm.offToken);
  assert.equal(staffHarm.offPressed, 'false', 'the harmonic button is released after H again');
  assert.equal(staffHarm.buttonOn, staffHarm.expectedToken, 'the button turns it on again');
  assert.deepEqual(client.consoleErrors.slice(harmErrorsBefore), [], 'the staff harmonic steps run without console errors');

  // 14. S 키와 슬러 단추(오선 모드): 바로 앞 음과 같은 줄에서 이어지도록 줄을 옮겨 켠다. 기대 줄·토큰은 STRINGS와 앞 음에서 따로 셈한다.
  const slurErrorsBefore = client.consoleErrors.length;
  await client.evaluate(`document.getElementById('tiNewBtn').click(); __tiTest.key('5', 'Digit5'); __tiTest.letter('D', false); __tiTest.key('ArrowRight', 'ArrowRight'); __tiTest.letter('E', false); true`);
  const staffSlur = await client.evaluate(`(function(){
    var t = __tiTest;
    var sBtn = document.querySelector('[data-attr="art"][data-value="s"]');
    function press(){ var e = new KeyboardEvent('keydown', { key:'s', code:'KeyS', bubbles:true, cancelable:true }); document.body.dispatchEvent(e); return e.defaultPrevented; }
    function tokens(){ return t.text().split('\\n')[0].split(' '); }
    function strOf(token){ return Number(token.match(/@(\\d)$/)[1]); }
    function fretAt(c, str){ return Number(t.pos(0,c,0,str).querySelector('.ti-pos-label').textContent); }
    var out = {};
    var prevStr = strOf(tokens()[1]);
    var curStr = strOf(tokens()[2]);
    var prevMidi = GuitarParser.STRINGS[prevStr - 1].midi + fretAt(0, prevStr);
    var midi = GuitarParser.STRINGS[curStr - 1].midi + fretAt(1, curStr);
    var fretOnPrev = midi - GuitarParser.STRINGS[prevStr - 1].midi;
    out.premise = { moved: prevStr !== curStr, differs: prevMidi !== midi, inRange: fretOnPrev >= 0 && fretOnPrev <= GuitarTabInput.MAX_FRET };
    out.expectedStr = prevStr;
    out.expectedToken = 's' + GuitarParser.noteNameForMidi(midi, false) + '@' + prevStr;
    out.expectedOff = GuitarParser.noteNameForMidi(midi, false) + '@' + prevStr;
    out.expectedFret = fretOnPrev;
    out.expectedDirection = midi > prevMidi ? 'h' : 'p';
    out.btnEnabled = !sBtn.disabled;
    out.prevented = press();
    out.token = tokens()[2];
    out.cursor = t.cursor();
    out.pressed = sBtn.getAttribute('aria-pressed');
    out.btnAfter = !sBtn.disabled;
    var node = t.pos(0,1,0,prevStr).querySelector('.ti-pos-label');
    out.label = node ? node.textContent : '';
    var beforeButton = t.text();
    sBtn.click();
    out.buttonKeepsOn = t.text() === beforeButton;
    press();
    out.offToken = tokens()[2];
    out.offPressed = sBtn.getAttribute('aria-pressed');
    sBtn.click();
    out.buttonOn = tokens()[2];
    out.otherToken = tokens()[1];
    return out;
  })()`);
  assert.deepEqual(staffSlur.premise, { moved: true, differs: true, inRange: true }, 'the staff slur test note sits on another string than the earlier note: ' + JSON.stringify(staffSlur.premise));
  assert.equal(staffSlur.btnEnabled, true, 'the slur button is enabled when another string can link');
  assert.equal(staffSlur.prevented, true, 'the S key is handled in staff mode');
  assert.equal(staffSlur.token, staffSlur.expectedToken, 'S writes the slur on the string of the earlier note: ' + JSON.stringify(staffSlur));
  assert.ok(staffSlur.cursor.indexOf(staffSlur.expectedStr + '번 줄') >= 0, 'the cursor string follows the moved note: ' + staffSlur.cursor);
  assert.equal(staffSlur.pressed, 'true', 'the slur button is pressed after S');
  assert.equal(staffSlur.btnAfter, true, 'a slur note keeps the button enabled');
  assert.equal(staffSlur.label, staffSlur.expectedDirection + staffSlur.expectedFret, 'the TAB label shows the direction letter and the fret on the new string: ' + staffSlur.label);
  assert.equal(staffSlur.buttonKeepsOn, true, 'the button on a slur note leaves it as it is');
  assert.equal(staffSlur.offToken, staffSlur.expectedOff, 'S again turns it off, the plain note stays on the moved string: ' + staffSlur.offToken);
  assert.equal(staffSlur.offPressed, 'false', 'the slur button is released after S again');
  assert.equal(staffSlur.buttonOn, staffSlur.expectedToken, 'the button turns it on again');
  assert.deepEqual(client.consoleErrors.slice(slurErrorsBefore), [], 'the staff slur steps run without console errors');

  // 15. / 키와 슬라이드 단추(오선 모드): 슬러와 같이 바로 앞 음과 같은 줄에서 이어지도록 줄을 옮겨 켠다.
  const staffSlideErrorsBefore = client.consoleErrors.length;
  await client.evaluate(`document.getElementById('tiNewBtn').click(); __tiTest.key('5', 'Digit5'); __tiTest.letter('D', false); __tiTest.key('ArrowRight', 'ArrowRight'); __tiTest.letter('E', false); true`);
  const staffSlide = await client.evaluate(`(function(){
    var t = __tiTest;
    var gBtn = document.querySelector('[data-attr="art"][data-value="g"]');
    function press(){ var e = new KeyboardEvent('keydown', { key:'/', code:'Slash', bubbles:true, cancelable:true }); document.body.dispatchEvent(e); return e.defaultPrevented; }
    function tokens(){ return t.text().split('\\n')[0].split(' '); }
    function strOf(token){ return Number(token.match(/@(\\d)$/)[1]); }
    function fretAt(c, str){ return Number(t.pos(0,c,0,str).querySelector('.ti-pos-label').textContent); }
    var out = {};
    var prevStr = strOf(tokens()[1]);
    var curStr = strOf(tokens()[2]);
    var prevMidi = GuitarParser.STRINGS[prevStr - 1].midi + fretAt(0, prevStr);
    var midi = GuitarParser.STRINGS[curStr - 1].midi + fretAt(1, curStr);
    var fretOnPrev = midi - GuitarParser.STRINGS[prevStr - 1].midi;
    out.premise = { moved: prevStr !== curStr, differs: prevMidi !== midi, inRange: fretOnPrev >= 0 && fretOnPrev <= GuitarTabInput.MAX_FRET };
    out.expectedStr = prevStr;
    out.expectedToken = 'g' + GuitarParser.noteNameForMidi(midi, false) + '@' + prevStr;
    out.expectedOff = GuitarParser.noteNameForMidi(midi, false) + '@' + prevStr;
    out.btnEnabled = !gBtn.disabled;
    out.prevented = press();
    out.token = tokens()[2];
    out.cursor = t.cursor();
    out.pressed = gBtn.getAttribute('aria-pressed');
    out.btnAfter = !gBtn.disabled;
    var beforeButton = t.text();
    gBtn.click();
    out.buttonKeepsOn = t.text() === beforeButton;
    press();
    out.offToken = tokens()[2];
    out.offPressed = gBtn.getAttribute('aria-pressed');
    gBtn.click();
    out.buttonOn = tokens()[2];
    return out;
  })()`);
  assert.deepEqual(staffSlide.premise, { moved: true, differs: true, inRange: true }, 'the staff slide test note sits on another string than the earlier note: ' + JSON.stringify(staffSlide.premise));
  assert.equal(staffSlide.btnEnabled, true, 'the slide button is enabled when another string can link');
  assert.equal(staffSlide.prevented, true, 'the / key is handled in staff mode');
  assert.equal(staffSlide.token, staffSlide.expectedToken, '/ writes the slide on the string of the earlier note: ' + JSON.stringify(staffSlide));
  assert.ok(staffSlide.cursor.indexOf(staffSlide.expectedStr + '번 줄') >= 0, 'the cursor string follows the moved note: ' + staffSlide.cursor);
  assert.equal(staffSlide.pressed, 'true', 'the slide button is pressed after /');
  assert.equal(staffSlide.btnAfter, true, 'a slide note keeps the button enabled');
  assert.equal(staffSlide.buttonKeepsOn, true, 'the button on a slide note leaves it as it is');
  assert.equal(staffSlide.offToken, staffSlide.expectedOff, '/ again turns it off, the plain note stays on the moved string: ' + staffSlide.offToken);
  assert.equal(staffSlide.offPressed, 'false', 'the slide button is released after / again');
  assert.equal(staffSlide.buttonOn, staffSlide.expectedToken, 'the button turns it on again');
  assert.deepEqual(client.consoleErrors.slice(staffSlideErrorsBefore), [], 'the staff slide steps run without console errors');

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

// 빈칸 _ 악보 입력 화면: - 키·단추로 칸 전체를 켜고 끄기(두 모드), 카드 빗금과 오선 위치, 오선 모드의 거절·이동. 규칙은 Docs/tab-input.md, Docs/staff-input.md 빈칸.
async function testSkipInput(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const errorsBefore = client.consoleErrors.length;
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  async function load() {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url: inputUrl });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1', 8000);
  }
  async function shot(name) {
    const data = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
    const target = path.join(root, 'test-artifacts', name);
    fs.writeFileSync(target, Buffer.from(data.data, 'base64'));
    process.stdout.write('Artifact: ' + target + '\n');
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await load();
  await client.evaluate(`(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`);
  await load();
  await client.evaluate(`window.__tiTest = {
    pos: function(m, c, s, str){ return document.querySelector('.ti-slot[data-m="'+m+'"][data-c="'+c+'"][data-s="'+s+'"] .ti-pos[data-str="'+str+'"]'); },
    fret: function(str, fret){ return document.querySelector('.ti-fret[data-str="'+str+'"][data-fret="'+fret+'"]'); },
    text: function(){ return document.getElementById('tiScoreText').value; },
    press: function(key, code, extra){ var e = new KeyboardEvent('keydown', Object.assign({ key:key, code:code, bubbles:true, cancelable:true }, extra || {})); document.body.dispatchEvent(e); return e.defaultPrevented; },
    state: function(){ return {
      skips: Array.prototype.map.call(document.querySelectorAll('#tiMeasures .ti-measure:first-child .ti-cell'), function(cell){ return cell.classList.contains('slot-skip'); }),
      text: document.getElementById('tiScoreText').value.split('\\n')[0],
      cursor: document.getElementById('tiCursorLabel').textContent,
      pressed: document.getElementById('tiSkipBtn').getAttribute('aria-pressed'),
      diagnostics: document.getElementById('tiDiagnostics').textContent,
      status: document.getElementById('tiStatus').textContent
    }; }
  }; true`);
  const t = expression => client.evaluate('(function(){ var __tiTest = window.__tiTest; return ' + expression + '; })()');

  // 1. 타브 모드: 단추와 힌트, - 키로 앞 세 칸을 빈칸으로, 마지막 칸에 음
  assert.match(await t('document.getElementById("tiSkipBtn").textContent'), /빈칸/, 'the dock has a skip button');
  await t('(__tiTest.pos(0,3,0,1).click(), __tiTest.fret(1,0).click(), __tiTest.pos(0,0,0,1).click(), true)');
  assert.equal(await t('__tiTest.press("-", "Minus")'), true, 'the - key is handled');
  let state = await t('__tiTest.state()');
  assert.deepEqual(state.skips, [true, false, false, false], 'the - key makes the cursor cell a skip cell');
  assert.equal(state.pressed, 'true');
  assert.match(state.cursor, /빈칸/, 'the cursor label says 빈칸: ' + state.cursor);
  await t('(__tiTest.press("ArrowRight", "ArrowRight"), __tiTest.press("_", "Minus", { shiftKey: true }), true)');
  await t('(__tiTest.press("ArrowRight", "ArrowRight"), document.getElementById("tiSkipBtn").click(), true)');
  state = await t('__tiTest.state()');
  assert.deepEqual(state.skips, [true, true, true, false], 'Shift+- and the dock button also turn skip cells on');
  assert.equal(state.text, '[-] _ _ _ E4@1 | ""', 'the result text writes _ for the skip cells');
  assert.equal(state.diagnostics, '오류 없음', 'a leading run of skip cells passes the score check');
  // 숫자패드 빼기는 받지 않는다
  await t('(__tiTest.press("-", "NumpadSubtract"), true)');
  assert.deepEqual((await t('__tiTest.state()')).skips, [true, true, true, false], 'the numpad minus key does nothing');
  // 카드: 빗금 클래스와 흐림, 빈칸 글자, 오선의 음은 4번째 칸 아래
  const card = await t(`(function(){
    var cells = document.querySelectorAll('#tiMeasures .ti-measure:first-child .ti-cell');
    var skipCell = cells[0];
    var cs = getComputedStyle(skipCell);
    var chord = document.querySelector('#tiMeasures .ti-measure:first-child .st-chord');
    var chordRect = chord ? chord.getBoundingClientRect() : null;
    var fourth = cells[3].getBoundingClientRect();
    return { opacity: cs.opacity, stripes: cs.backgroundImage, label: getComputedStyle(skipCell.querySelector('.ti-slot'), '::after').content,
      chords: document.querySelectorAll('#tiMeasures .ti-measure:first-child .st-chord').length,
      chordCell: chord ? chord.dataset.cell : null,
      inFourth: !!chordRect && chordRect.left + chordRect.width / 2 >= fourth.left && chordRect.left + chordRect.width / 2 <= fourth.right,
      rests: document.querySelectorAll('#tiMeasures .ti-measure:first-child .st-rest').length };
  })()`);
  assert.ok(Number(card.opacity) < 1, 'a skip cell card is dimmed: ' + JSON.stringify(card));
  assert.match(card.stripes, /repeating-linear-gradient/, 'a skip cell card is hatched: ' + card.stripes);
  assert.match(card.label, /빈칸/, 'a skip slot reads 빈칸: ' + card.label);
  assert.equal(card.chords, 1, 'the card staff draws only the real note');
  assert.equal(card.chordCell, '3', 'the pickup note is in cell 3 of the card staff');
  assert.equal(card.inFourth, true, 'the card staff note is above the TAB fourth cell');
  assert.equal(card.rests, 0, 'nothing but the note is drawn: no rests in the skip cells');
  await shot('score-input-skip-tab.png');
  // 끄기와 되돌리기, 음을 넣으면 꺼진다
  await t('(__tiTest.pos(0,2,0,1).click(), document.getElementById("tiSkipBtn").click(), true)');
  assert.deepEqual((await t('__tiTest.state()')).skips, [true, true, false, false], 'the button turns the cursor cell back off');
  assert.equal((await t('__tiTest.state()')).text, '[-] _ _ r E4@1 | ""', 'a cell that was turned off is an ordinary empty cell');
  await t('(__tiTest.press("z", "KeyZ", { ctrlKey: true }), true)');
  assert.deepEqual((await t('__tiTest.state()')).skips, [true, true, true, false], 'undo turns the skip cell back on');
  await t('(__tiTest.pos(0,1,0,2).click(), __tiTest.fret(2,3).click(), true)');
  state = await t('__tiTest.state()');
  assert.deepEqual(state.skips, [true, false, true, false], 'putting a fret into a skip cell turns the skip off first');
  assert.match(state.diagnostics, /빈칸/, 'a skip run broken in the middle is reported by the score check: ' + state.diagnostics);
  await t('(__tiTest.press("z", "KeyZ", { ctrlKey: true }), true)');
  assert.deepEqual((await t('__tiTest.state()')).skips, [true, true, true, false]);

  // 2. 오선 모드: 빈칸에 걸리는 입력은 거절하고 문서는 그대로, 사건 이동은 빈칸을 건너뛴다
  await t('(document.getElementById("tiNewBtn").click(), true)');
  await client.evaluate(`(function(){
    window.confirm = function(){ return true; };
    document.getElementById('tiImportBtn').click();
    var area = document.getElementById('tiImportText');
    area.value = ${JSON.stringify('[-] E4@1 r _ _ | ""\n[-] F4@1 G4@1 A4@1 B3@2 | ""')};
    area.dispatchEvent(new Event('input', { bubbles:true }));
    document.getElementById('tiImportApplyBtn').click();
    document.getElementById('tiModeStaff').click();
    return true;
  })()`);
  assert.equal(await client.evaluate(`document.getElementById('tiImportError').textContent`), '', 'the skip score imports without error');
  state = await t('__tiTest.state()');
  assert.deepEqual(state.skips, [false, false, true, true], 'the imported skip cells are skip cells');
  assert.equal(state.text, '[-] E4@1 r _ _ | ""');
  await t('(document.querySelector(".ti-measure:first-child .ti-cell-head[data-c=\\"1\\"]").click(), true)');
  const textBefore = await t('__tiTest.text()');
  await t('(__tiTest.press("6", "Digit6"), true)');   // 2분음표: 쉼이 빈칸 칸으로 들어간다
  state = await t('__tiTest.state()');
  assert.equal(state.status, '빈칸을 건너서는 음을 넣을 수 없습니다.', 'a length that reaches a skip cell is refused with the status line: ' + state.status);
  assert.equal(await t('__tiTest.text()'), textBefore, 'the refused input leaves the document unchanged');
  await t('(__tiTest.press("5", "Digit5"), true)');   // 4분음표: 빈칸 앞에서 끝나는 길이
  await t('(__tiTest.press("d", "KeyD"), true)');
  state = await t('__tiTest.state()');
  assert.equal(state.status, '', 'a note that ends at the skip cell is accepted: ' + state.status);
  assert.deepEqual(state.skips, [false, false, true, true], 'the skip cells are kept');
  assert.match(state.text, /^\[-\] E4@1 [A-G][b#]?\d@\d _ _/, 'the new note is in the second cell: ' + state.text);
  // 빈칸 칸 위의 커서에서 입력
  await t('(document.querySelector(".ti-measure:first-child .ti-cell-head[data-c=\\"2\\"]").click(), true)');
  const skipText = await t('__tiTest.text()');
  await t('(__tiTest.press("c", "KeyC"), true)');
  assert.equal((await t('__tiTest.state()')).status, '빈칸을 건너서는 음을 넣을 수 없습니다.', 'a note on a skip cell is refused');
  await t('(__tiTest.press("Delete", "Delete"), true)');
  assert.match((await t('__tiTest.state()')).status, /빈칸/, 'Delete on a skip cell is refused with a skip message');
  assert.equal(await t('__tiTest.text()'), skipText, 'the document is unchanged');
  // 사건 이동: 둘째 칸에서 → 는 빈칸 두 칸을 건너 다음 마디 첫 칸
  await t('(document.querySelector(".ti-measure:first-child .ti-cell-head[data-c=\\"1\\"]").click(), __tiTest.press("ArrowRight", "ArrowRight"), true)');
  assert.ok((await t('__tiTest.state()')).cursor.startsWith('2마디 · 1칸'), 'the right arrow skips the skip cells: ' + (await t('__tiTest.state()')).cursor);
  await t('(__tiTest.press("ArrowLeft", "ArrowLeft"), true)');
  assert.ok((await t('__tiTest.state()')).cursor.startsWith('1마디 · 2칸'), 'the left arrow skips them back');
  // 오선 모드에서도 - 키로 켜고 끈다
  await t('(__tiTest.press("-", "Minus"), true)');
  assert.deepEqual((await t('__tiTest.state()')).skips, [false, true, true, true], 'the - key works in staff mode too');
  await t('(__tiTest.press("-", "Minus"), true)');
  assert.deepEqual((await t('__tiTest.state()')).skips, [false, false, true, true]);
  await shot('score-input-skip-staff.png');

  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the skip input steps run without console errors');
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: skip cells in score input (- key in both modes, card hatching, card staff position, staff mode refusal and moves) passed\n');
}

// 롤(~) 악보 입력 화면: 카드 TAB 물결선(위치는 실제 상자로 잰다), 입력판 단추, ` 키, 들어보기 소리. 규칙은 Docs/tab-input.md.
async function testRollInput(client, httpPort) {
  client.dialogHandler = async () => { await client.send('Page.handleJavaScriptDialog', { accept: true }); };
  const errorsBefore = client.consoleErrors.length;
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  async function load() {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url: inputUrl });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1', 8000);
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await load();
  await client.evaluate(`(function(){ Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); }); return true; })()`);
  await load();
  await client.evaluate(`window.__tiTest = {
    pos: function(m, c, s, str){ return document.querySelector('.ti-slot[data-m="'+m+'"][data-c="'+c+'"][data-s="'+s+'"] .ti-pos[data-str="'+str+'"]'); },
    fret: function(str, fret){ return document.querySelector('.ti-fret[data-str="'+str+'"][data-fret="'+fret+'"]'); },
    text: function(){ return document.getElementById('tiScoreText').value; },
    press: function(key, code, extra){ var e = new KeyboardEvent('keydown', Object.assign({ key:key, code:code, bubbles:true, cancelable:true }, extra || {})); document.body.dispatchEvent(e); return e.defaultPrevented; }
  }; true`);

  // 1. 두 화면의 힌트와 단추
  const hints = await client.evaluate(`({ tab: document.getElementById('tiTabHint').textContent, staff: document.getElementById('tiStaffHint').textContent, title: document.getElementById('tiRollBtn').title, label: document.getElementById('tiRollBtn').textContent })`);
  assert.ok(hints.tab.indexOf('~ 롤') >= 0, 'the tab hint mentions the roll key: ' + hints.tab);
  assert.ok(hints.staff.indexOf('~ 롤') >= 0, 'the staff hint mentions the roll key: ' + hints.staff);
  assert.ok(hints.label.indexOf('롤') >= 0 && hints.title.indexOf('롤') === 0, 'the roll button is labeled: ' + JSON.stringify(hints));

  // 2. 불러온 롤 악보의 카드: 물결선은 롤 조각에만, 프렛 글자의 왼쪽에, 위·아래 음 줄을 덮는다.
  const rollLines = [
    '[-] ~E2@6+B3@2+G4@1 E2@6+B3@2+G4@1 ~E2@6+B3@2 E2@6+B3@2 | ""',
    '[-] C3@5/~A3@3+D4@2+F#4@1 ~E2@6+E4@1 - r | ""'
  ];
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
  const rolled = [[0, 0, 0], [0, 2, 0], [1, 0, 1], [1, 1, 0]];
  const plain = [[0, 1, 0], [0, 3, 0], [1, 0, 0], [1, 2, 0], [1, 3, 0]];
  const geometry = await client.evaluate(`(function(){
    function slotEl(p){ return document.querySelector('.ti-slot[data-m="'+p[0]+'"][data-c="'+p[1]+'"][data-s="'+p[2]+'"]'); }
    function info(p){
      var slot = slotEl(p);
      var marks = slot.querySelectorAll('.roll-mark');
      var out = { marks: marks.length, isRoll: slot.classList.contains('is-roll') };
      if (marks.length){
        var rect = marks[0].getBoundingClientRect();
        var labels = Array.prototype.map.call(slot.querySelectorAll('.ti-pos-label'), function(label){ return label.getBoundingClientRect().left; });
        var centers = Array.prototype.filter.call(slot.querySelectorAll('.ti-pos'), function(pos){ return pos.querySelector('.ti-pos-label'); }).map(function(pos){
          var r = pos.getBoundingClientRect();
          return r.top + r.height / 2;
        });
        var slotRect = slot.getBoundingClientRect();
        out.slotLeft = slotRect.left; out.slotWidth = slotRect.width; out.labelWidths = Array.prototype.map.call(slot.querySelectorAll('.ti-pos-label'), function(label){ return label.getBoundingClientRect().width; });
        out.cellSw = slot.closest('.ti-cell').style.getPropertyValue('--sw');
        out.right = rect.right; out.top = rect.top; out.bottom = rect.bottom; out.minLabelLeft = Math.min.apply(null, labels);
        out.firstCenter = centers[0]; out.lastCenter = centers[centers.length - 1]; out.noteCount = centers.length;
        var cs = getComputedStyle(marks[0]);
        out.position = cs.position; out.width = rect.width; out.mask = cs.webkitMaskImage || cs.maskImage;
      }
      return out;
    }
    return { rolled: ${JSON.stringify(rolled)}.map(info), plain: ${JSON.stringify(plain)}.map(info) };
  })()`);
  geometry.rolled.forEach((info, k) => {
    const where = 'rolled slot ' + JSON.stringify(rolled[k]) + ' ' + JSON.stringify(info);
    assert.equal(info.marks, 1, 'one roll mark in the rolled slot: ' + where);
    assert.equal(info.isRoll, true, 'the rolled slot has the is-roll class: ' + where);
    assert.ok(info.noteCount >= 2, 'the rolled slot has two or more notes: ' + where);
    assert.ok(info.right <= info.minLabelLeft - 1, 'the wave is at least 1px left of every fret label: ' + where);
    assert.ok(info.top <= info.firstCenter && info.bottom >= info.lastCenter, 'the wave covers the top and bottom note rows: ' + where);
    assert.ok(info.width > 0 && info.position === 'absolute' && /svg/.test(info.mask), 'the wave is a positioned box with the shared mask shape: ' + where);
  });
  geometry.plain.forEach((info, k) => {
    assert.equal(info.marks, 0, 'no roll mark in a slot without a roll: ' + JSON.stringify(plain[k]));
    assert.equal(info.isRoll, false, 'no is-roll class without a roll: ' + JSON.stringify(plain[k]));
  });
  const innerShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.join(root, 'test-artifacts'), { recursive: true });
  const innerTarget = path.join(root, 'test-artifacts', 'score-input-roll-cards.png');
  fs.writeFileSync(innerTarget, Buffer.from(innerShot.data, 'base64'));
  process.stdout.write('Artifact: ' + innerTarget + '\n');

  // 3. 단추와 ` 키 (타브 모드, 오선 모드)
  const keys = await client.evaluate(`(function(){
    var t = __tiTest;
    var T = GuitarTabInput;
    document.getElementById('tiNewBtn').click();
    var btn = document.getElementById('tiRollBtn');
    var out = {};
    function cell(c){ return t.text().split('\\n')[0].split(' ')[c + 1]; }
    function status(){ return document.getElementById('tiStatus').textContent; }
    t.pos(0,0,0,1).click(); t.fret(1, 0).click();
    out.oneDisabled = btn.disabled;
    out.onePressed = btn.getAttribute('aria-pressed');
    t.pos(0,0,0,6).click(); t.fret(6, 0).click();
    out.twoDisabled = btn.disabled;
    out.twoPressedBefore = btn.getAttribute('aria-pressed');
    btn.click();
    out.btnPressed = btn.getAttribute('aria-pressed');
    out.btnCell = cell(0);
    out.btnMark = document.querySelectorAll('.ti-slot[data-m="0"][data-c="0"] .roll-mark').length;
    out.keyPrevented = t.press('\`', 'Backquote');
    out.keyOffPressed = btn.getAttribute('aria-pressed');
    out.keyOffCell = cell(0);
    out.keyOffMark = document.querySelectorAll('.ti-slot[data-m="0"][data-c="0"] .roll-mark').length;
    t.press('~', 'Backquote', { shiftKey:true });
    out.shiftCell = cell(0);
    t.press('\`', 'Backquote');
    out.offAgain = cell(0);
    t.pos(0,1,0,3).click(); t.fret(3, 2).click();
    out.singleDisabled = btn.disabled;
    var before = t.text();
    out.singlePrevented = t.press('\`', 'Backquote');
    out.singleStatus = status();
    out.singleSame = t.text() === before;
    out.expectedError = T.ROLL_ERROR;
    t.pos(0,2,0,1).click(); t.press('r', 'KeyR');
    out.restDisabled = btn.disabled;
    before = t.text();
    t.press('\`', 'Backquote');
    out.restStatus = status();
    out.restSame = t.text() === before;
    t.pos(0,0,0,1).click();
    document.getElementById('tiModeStaff').click();
    t.pos(0,0,0,1).click();
    out.staffModeOn = document.getElementById('tiModeStaff').getAttribute('aria-pressed');
    out.staffPrevented = t.press('\`', 'Backquote');
    out.staffCell = cell(0);
    out.staffPressed = btn.getAttribute('aria-pressed');
    t.press('\`', 'Backquote');
    out.staffOffCell = cell(0);
    document.getElementById('tiModeTab').click();
    return out;
  })()`);
  assert.equal(keys.oneDisabled, true, 'the roll button is disabled on a one-note slot: ' + JSON.stringify(keys));
  assert.equal(keys.onePressed, 'false');
  assert.equal(keys.twoDisabled, false, 'the roll button is enabled on a two-note slot');
  assert.equal(keys.twoPressedBefore, 'false', 'the roll button starts released');
  assert.equal(keys.btnPressed, 'true', 'the roll button is pressed after the click');
  assert.equal(keys.btnCell.charAt(0), '~', 'the exported cell starts with ~ after the button: ' + keys.btnCell);
  assert.equal(keys.btnMark, 1, 'the card draws the wave after the button');
  assert.equal(keys.keyPrevented, true, 'the ` key is handled');
  assert.equal(keys.keyOffPressed, 'false', 'the ` key releases the roll button');
  assert.equal(keys.keyOffCell, keys.btnCell.slice(1), 'the ` key turns the roll off');
  assert.equal(keys.keyOffMark, 0, 'the wave disappears with the roll');
  assert.equal(keys.shiftCell, keys.btnCell, 'Shift + ` (the ~ key) turns the roll on too');
  assert.equal(keys.offAgain, keys.keyOffCell, 'the key toggles back off');
  assert.equal(keys.singleDisabled, true, 'the roll button is disabled on a one-note slot');
  assert.equal(keys.singlePrevented, true, 'the ` key is handled even when it cannot turn the roll on');
  assert.equal(keys.singleStatus, keys.expectedError, 'the ` key on one note says why: ' + keys.singleStatus);
  assert.equal(keys.singleSame, true, 'the ` key on one note leaves the score text alone');
  assert.equal(keys.restDisabled, true, 'the roll button is disabled on a rest');
  assert.equal(keys.restStatus, keys.expectedError, 'the ` key on a rest says why');
  assert.equal(keys.restSame, true, 'the ` key on a rest leaves the score text alone');
  assert.equal(keys.staffModeOn, 'true', 'the staff input mode is on');
  assert.equal(keys.staffPrevented, true, 'the ` key is handled in the staff input mode');
  assert.equal(keys.staffCell, keys.btnCell, 'the ` key turns the roll on in the staff input mode: ' + keys.staffCell);
  assert.equal(keys.staffPressed, 'true');
  assert.equal(keys.staffOffCell, keys.keyOffCell, 'and off again');

  // 4. 들어보기: 롤 조각은 rollDelays 순서와 간격으로 치고 끝 시각이 같다. 롤이 아니면 같은 시각.
  const play = await client.evaluate(`(function(){
    var t = __tiTest;
    document.getElementById('tiNewBtn').click();
    t.pos(0,0,0,6).click(); t.fret(6, 0).click();
    t.pos(0,0,0,1).click(); t.fret(1, 0).click();
    t.pos(0,0,0,3).click(); t.fret(3, 2).click();
    var original = window.playGuitarNote;
    var calls = [];
    window.playGuitarNote = function(midi, dur, when, gain, art, str){ calls.push({ midi: midi, dur: dur, when: when, str: str }); };
    var out = {};
    try {
      t.press(' ', 'Space');
      out.plain = calls.slice(); calls.length = 0;
      t.press('\`', 'Backquote');
      out.pressed = document.getElementById('tiRollBtn').getAttribute('aria-pressed');
      t.press(' ', 'Space');
      out.rolled = calls.slice(); calls.length = 0;
      document.getElementById('tiPlaySlotBtn').click();
      out.rolledByButton = calls.slice(); calls.length = 0;
    } finally { window.playGuitarNote = original; }
    var items = out.rolled.map(function(call){ return { str: call.str, midi: call.midi }; });
    var expected = rollDelays(items, out.rolled.length ? out.rolled[0].dur : 1);
    out.expectedStrs = expected.map(function(entry){ return entry.note.str; });
    out.expectedDelays = expected.map(function(entry){ return entry.delay; });
    return out;
  })()`);
  assert.equal(play.plain.length, 3, 'a plain chord plays every note: ' + JSON.stringify(play.plain));
  assert.ok(play.plain.every(call => call.when === play.plain[0].when && call.dur === play.plain[0].dur), 'a plain chord plays at one time with one length: ' + JSON.stringify(play.plain));
  assert.equal(play.pressed, 'true', 'the ` key rolled the chord');
  assert.equal(play.rolled.length, 3, 'a rolled chord plays every note');
  assert.deepEqual(play.rolled.map(call => call.str), play.expectedStrs, 'the rolled chord plays in the rollDelays order: ' + JSON.stringify(play.rolled));
  assert.deepEqual(play.rolled.map(call => call.str), [...play.rolled.map(call => call.str)].sort((a, b) => b - a), 'the highest string number plays first');
  play.rolled.forEach((call, k) => {
    assert.ok(Number.isFinite(call.when), 'a rolled note has a start time');
    assert.ok(Math.abs((call.when - play.rolled[0].when) - play.expectedDelays[k]) < 1e-6, 'rolled note ' + k + ' is late by its roll delay (' + (call.when - play.rolled[0].when) + ' vs ' + play.expectedDelays[k] + ')');
    assert.ok(Math.abs((call.when + call.dur) - (play.rolled[0].when + play.rolled[0].dur)) < 1e-6, 'every rolled note ends together');
  });
  assert.ok(play.expectedDelays[2] > 0 && play.rolled[0].dur > 0, 'the roll actually spreads the chord');
  assert.deepEqual(play.rolledByButton.map(call => call.str), play.expectedStrs, 'the play button rolls too');

  // 5. 롤 조각이 든 칸은 조각 폭이 넓어진다(CELL_ROLL_ROOM): 같은 글자 폭의 롤 칸이 롤 아닌 칸보다 좁지 않다.
  const widths = await client.evaluate(`(function(){
    var t = __tiTest;
    document.getElementById('tiNewBtn').click();
    function put(c, strs){ strs.forEach(function(str){ t.pos(0,c,0,str).click(); t.fret(str, 0).click(); }); }
    put(0, [6, 1]); put(1, [6, 1]);
    function cellWidth(c){ return document.querySelectorAll('#tiMeasures .ti-measure')[0].querySelectorAll('.ti-cell')[c].getBoundingClientRect().width; }
    var before = [cellWidth(0), cellWidth(1)];
    t.pos(0,1,0,6).click();
    t.press('\`', 'Backquote');
    return { before: before, after: [cellWidth(0), cellWidth(1)] };
  })()`);
  assert.equal(widths.before[0], widths.before[1], 'two cells with the same labels start equally wide: ' + JSON.stringify(widths));
  assert.ok(widths.after[0] <= widths.before[0], 'the plain cell does not grow');
  assert.ok(widths.after[1] >= widths.before[1], 'the rolled cell does not shrink');

  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'the roll input steps run without console errors');
  client.dialogHandler = null;
  process.stdout.write('Browser checkpoint: roll in score input (card wave geometry, button, ` key in both modes, rolled playback) passed\n');
}

async function main() {
  await runBrowserSuite({
    startPath: '/score-input.html',
    readyExpr: 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1'
  }, async ({ cdp, httpPort }) => {
    await testScoreInputScreen(cdp, httpPort);
    await testEditHandoff(cdp, httpPort);
    await testScoreInputStaff(cdp, httpPort);
    await testStaffInputMode(cdp, httpPort);
    await testTextInputMode(cdp, httpPort);
    await testSkipInput(cdp, httpPort);
    await testRollInput(cdp, httpPort);
    process.stdout.write('Result: browser score-input suite passed (0 console errors)\n');
  });
}

main().catch(err => {
  console.error('Browser input test failed:', err);
  process.exitCode = 1;
});
