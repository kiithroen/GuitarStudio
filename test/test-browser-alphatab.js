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

// alphaTab 보기 창: 연습 화면 단추가 곡을 넘기고, 넘긴 곡을 alphatab.html이 alphaTab으로 그린다.
// 보기 창의 BPM 슬라이더 범위 상수는 소스에서 읽는다(숫자를 테스트에 옮겨 적지 않는다).
const alphaTabViewSource = fs.readFileSync(path.join(root, 'src', 'alphatab-view.js'), 'utf8');
const BPM_RATIO_MIN = Number(alphaTabViewSource.match(/var BPM_RATIO_MIN = ([0-9.]+);/)[1]);
const BPM_RATIO_MAX = Number(alphaTabViewSource.match(/var BPM_RATIO_MAX = ([0-9.]+);/)[1]);
function expectedBpmSlider(base, practiceBpm) {
  const min = Math.max(1, Math.ceil(base * BPM_RATIO_MIN));
  const max = Math.max(min, Math.floor(base * BPM_RATIO_MAX));
  const inRange = typeof practiceBpm === 'number' && practiceBpm >= min && practiceBpm <= max;
  return { min, max, value: inRange ? practiceBpm : Math.max(min, Math.min(max, Math.round(base))) };
}
function bpmText(value, base) { return value + ' · ' + Math.round(value * 100 / base) + '%'; }

async function testAlphaTabView(client, httpPort, servedPaths) {
  const SONG_ID = 'builtin-lv1-butterfly';
  const VIEW_KEY = 'gs.alphaTab.view';
  const practiceUrl = `http://127.0.0.1:${httpPort}/index.html`;
  const viewUrl = `http://127.0.0.1:${httpPort}/alphatab.html`;
  const practiceReady = 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null';
  const viewSettled = 'document.readyState === "complete" && ["ready","empty","error"].indexOf(document.body.getAttribute("data-at-state")) >= 0';
  const errorsBefore = client.consoleErrors.length;
  async function navigate(url, ready, timeoutMs) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, ready, timeoutMs || 8000);
  }
  const setKey = value => client.evaluate(`localStorage.setItem(${JSON.stringify(VIEW_KEY)}, ${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))}); true`);
  const readStatus = () => client.evaluate(`({ state: document.body.getAttribute('data-at-state'), text: document.getElementById('atStatus').textContent, title: document.getElementById('atTitle').textContent })`);
  const soundFontHits = () => servedPaths.filter(p => p === '/vendor/musescore-general/MuseScore_General.sf3').length;
  const SOUND_LOADING = '소리를 불러오는 중입니다(약 38MB, 처음 한 번만)';

  // 1. 연습 화면 단추: 구조화 곡에서만 보이고, 누르면 지금 곡을 넘기고 새 탭을 연다
  await navigate(practiceUrl, practiceReady);
  await client.evaluate(`localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); changeSongById(${JSON.stringify(SONG_ID)}); true`);
  const button = await client.evaluate(`(function(){
    var b = document.getElementById('openAlphaTabBtn');
    var help = document.getElementById('helpModalOpenBtn');
    return { exists: !!b, hidden: !!b && b.hidden, shown: !!b && b.getClientRects().length > 0, text: b && b.textContent, besideHelp: !!b && b.previousElementSibling === help, type: b && b.type };
  })()`);
  assert.deepEqual(button, { exists: true, hidden: false, shown: true, text: 'alphaTab', besideHelp: true, type: 'button' }, 'the alphaTab button sits next to the help button and is visible for a structured song');
  await client.evaluate(`(function(){ window.__alphaTabOpens = []; window.open = function(url, target){ window.__alphaTabOpens.push([String(url), target]); return {}; }; return true; })()`);
  await client.evaluate(`document.getElementById('openAlphaTabBtn').click(); true`, { userGesture: true });
  const handoff = await client.evaluate(`(function(){
    var stored = JSON.parse(localStorage.getItem(${JSON.stringify(VIEW_KEY)}) || 'null');
    return { stored: stored, opens: window.__alphaTabOpens, lines: serializeScoreMeasures(curSong.measures, '\\n').split('\\n'), title: curSong.title, beats: curSong.beats, bpm: curSong.bpm, appBpm: appState.bpm, capo: GuitarParser.getSongCapo(curSong) };
  })()`);
  assert.ok(handoff.stored, 'clicking the alphaTab button writes ' + VIEW_KEY);
  assert.deepEqual(handoff.opens, [['alphatab.html', '_blank']], 'the button opens alphatab.html in a new tab');
  assert.equal(handoff.stored.title, handoff.title, 'handoff carries the song title');
  assert.equal(handoff.stored.beats, handoff.beats, 'handoff carries the cell count');
  assert.equal(handoff.stored.bpm, handoff.bpm, 'handoff carries the BPM');
  assert.equal(handoff.stored.practiceBpm, handoff.appBpm, 'handoff carries the practice screen BPM at click time');
  assert.equal(handoff.stored.capo, handoff.capo, 'handoff carries the capo');
  assert.deepEqual(handoff.stored.lines, handoff.lines, 'handoff carries the current score lines');
  assert.equal(typeof handoff.stored.savedAt, 'number', 'handoff carries a save time');
  const butterfly = builtinSongsJson.find(item => item.id === SONG_ID);
  assert.equal(handoff.stored.lines.length, butterfly.lines.length, 'handoff has one line per measure');

  // 지금 곡이 초안·카포 곡이면 그 내용을 넘긴다
  const fixture = await client.evaluate(`(function(){
    var previous = curSong;
    var previousBpm = appState.bpm;
    var parsed = parseScore('[C] !1C4@2:i E4@1:p r r | "copy memo"', 4);
    try {
      appState.bpm = 91;
      curSong = { id:'alphatab-handoff-fixture', title:'Handoff fixture', badge:'Capo 2', type:'structured', beats:4, bpm:77, capo:0, measures:parsed.measures };
      scoreEditorHooks.refreshStatus();
      window.__alphaTabOpens.length = 0;
      document.getElementById('openAlphaTabBtn').click();
      var stored = JSON.parse(localStorage.getItem(${JSON.stringify(VIEW_KEY)}));
      var opens = window.__alphaTabOpens.slice();
      curSong = { id:'alphatab-image-fixture', title:'Image fixture', type:'image', beats:4, bpm:60, measures:[] };
      scoreEditorHooks.refreshStatus();
      var hiddenForImage = document.getElementById('openAlphaTabBtn').hidden;
      return { stored: stored, opens: opens, hiddenForImage: hiddenForImage };
    } finally { curSong = previous; appState.bpm = previousBpm; scoreEditorHooks.refreshStatus(); renderSong(); }
  })()`);
  assert.equal(fixture.stored.title, 'Handoff fixture');
  assert.equal(fixture.stored.practiceBpm, 91, 'the practice BPM is handed over even when it differs from the song BPM');
  assert.equal(fixture.stored.bpm, 77);
  assert.equal(fixture.stored.capo, 2, 'capo from the song title/badge is handed over');
  assert.deepEqual(fixture.stored.lines, ['[C] !1C4@2:i E4@1:p r r | "copy memo"'], 'a draft hands over its current content');
  assert.equal(fixture.opens.length, 1);
  assert.equal(fixture.hiddenForImage, true, 'the alphaTab button hides for a non-structured song');
  // 저장이 막히면 알림 줄에 알리고 새 탭은 열지 않는다
  const storageFail = await client.evaluate(`(function(){
    var original = Storage.prototype.setItem;
    window.__alphaTabOpens.length = 0;
    Storage.prototype.setItem = function(){ throw new Error('quota'); };
    try { document.getElementById('openAlphaTabBtn').click(); } finally { Storage.prototype.setItem = original; }
    var status = document.getElementById('storageStatus');
    return { opens: window.__alphaTabOpens.length, shown: !status.hidden, text: status.textContent };
  })()`);
  assert.equal(storageFail.opens, 0, 'no new tab opens when the handoff cannot be saved');
  assert.equal(storageFail.shown, true);
  assert.match(storageFail.text, /alphaTab/);
  await client.evaluate(`document.getElementById('storageStatus').hidden = true; true`);

  // 2. 보기 창: 넘기기 값이 없거나 모양이 틀리면 안내만 한다
  await client.evaluate(`localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); true`);
  await navigate(viewUrl, viewSettled);
  let status = await readStatus();
  assert.deepEqual([status.state, status.text], ['empty', '연습 화면의 alphaTab 단추로 여세요.'], 'no handoff shows the guidance line');
  await setKey('{not json');
  await navigate(viewUrl, viewSettled);
  status = await readStatus();
  assert.deepEqual([status.state, status.text], ['empty', '연습 화면의 alphaTab 단추로 여세요.'], 'a broken handoff shows the guidance line');
  await setKey({ title: 'x', beats: 4, bpm: 60, lines: 'not an array' });
  await navigate(viewUrl, viewSettled);
  assert.equal((await readStatus()).state, 'empty', 'a handoff of the wrong shape shows the guidance line');
  await setKey({ title: 'Bad score', beats: 4, bpm: 60, capo: 0, lines: ['E4 r r'], savedAt: Date.now() });
  await navigate(viewUrl, viewSettled);
  status = await readStatus();
  assert.equal(status.state, 'error', 'a score the converter rejects shows an error');
  assert.match(status.text, /^악보를 alphaTab으로 바꾸지 못했습니다: .+/, 'the converter error is shown in the status line');
  assert.equal(status.title, 'Bad score');
  assert.equal(await client.evaluate(`document.getElementById('atPlayBtn').disabled`), true, 'play stays disabled after an error');

  // 3. 보기 창: 연습 화면이 넘긴 곡을 그린다
  await setKey(handoff.stored);
  await navigate(viewUrl, viewSettled, 45000);
  status = await readStatus();
  assert.equal(status.state, 'ready', 'alphaTab finished rendering and the player is ready: ' + JSON.stringify(status));
  assert.equal(status.title, handoff.title, 'the head shows the song title');
  // 소리 없이도 플레이어가 준비되니 ready 가 그림이 DOM 에 다 들어오기 전에 올 수 있다. 그려질 때까지 기다린 뒤 읽는다.
  await waitForCondition(client, `document.querySelectorAll('#atHost svg *[fill]').length > 0`, 15000);
  const drawn = await client.evaluate(`(function(){
    var host = document.getElementById('atHost');
    return { svgs: host.querySelectorAll('svg').length, bars: host.getAttribute('data-bars'), renders: Number(host.getAttribute('data-renders')), profile: host.getAttribute('data-profile'), height: host.scrollHeight,
      playEnabled: !document.getElementById('atPlayBtn').disabled, rewindEnabled: !document.getElementById('atRewindBtn').disabled, playText: document.getElementById('atPlayBtn').textContent,
      order: Array.prototype.map.call(document.querySelectorAll('.at-controls button, .at-controls input, .at-controls select'), function(node){ return node.id; }).join(','),
      noSpeedSelect: document.getElementById('atSpeedSelect') === null,
      views: Array.prototype.map.call(document.getElementById('atViewSelect').options, function(o){ return o.textContent; }).join(','),
      bpm: { min: Number(document.getElementById('atBpmRange').min), max: Number(document.getElementById('atBpmRange').max), value: Number(document.getElementById('atBpmRange').value), text: document.getElementById('atBpmValue').textContent, disabled: document.getElementById('atBpmRange').disabled, speed: window.__alphaTabApi.playbackSpeed } };
  })()`);
  assert.ok(drawn.svgs >= 1, 'alphaTab drew SVG');
  assert.equal(drawn.bars, String(butterfly.lines.length), 'alphaTab loaded one bar per measure');
  assert.equal(drawn.profile, 'scoreTab');
  assert.equal(drawn.playEnabled && drawn.rewindEnabled, true, 'play and rewind are enabled once ready');
  assert.equal(drawn.playText, '재생');
  assert.equal(drawn.noSpeedSelect, true, 'the speed select is replaced by the BPM slider');
  assert.equal(drawn.order, 'atPlayBtn,atRewindBtn,atBpmRange,atViewSelect,atPagesBtn,atZoomOutBtn,atZoomInBtn,atLoopToggle,atClickToggle,atClickVolRange,atGuitarVolRange', 'controls are in the order play, rewind, BPM, view, two pages, zoom out, zoom in, loop, click, click volume, guitar volume');
  const butterflyExpected = expectedBpmSlider(handoff.stored.bpm, handoff.stored.practiceBpm);
  assert.deepEqual(drawn.bpm, { min: butterflyExpected.min, max: butterflyExpected.max, value: butterflyExpected.value, text: bpmText(butterflyExpected.value, handoff.stored.bpm), disabled: false, speed: butterflyExpected.value / handoff.stored.bpm }, 'the BPM slider starts at the practice BPM with the song-BPM ratio range');
  assert.equal(drawn.views, '오선+타브,타브,오선');
  assert.equal(await client.evaluate(`document.body.getAttribute('data-at-sound')`), 'idle', 'the sound font is not requested when the view opens');
  const programs = await client.evaluate(`document.getElementById('atHost').getAttribute('data-programs')`);
  assert.ok(programs && programs.split(',').every(program => program === '24'), 'every track plays as the nylon guitar (GM program 24): ' + programs);
  // 오선과 타브가 같이 그려진다: 타브 글자(TAB 자리표)와 오선 음자리표 글리프
  const lightColors = await client.evaluate(`(function(){
    var fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim().toUpperCase();
    var fills = {};
    Array.prototype.forEach.call(document.querySelectorAll('#atHost svg *'), function(el){ var f = el.getAttribute('fill'); if (f) fills[f.toUpperCase()] = true; });
    return { fg: fg, fills: Object.keys(fills) };
  })()`);
  assert.ok(lightColors.fills.indexOf(lightColors.fg) >= 0, 'alphaTab glyph color follows the --fg token (' + lightColors.fg + ' in ' + lightColors.fills.join(',') + ')');

  // 보기 선택을 바꾸면 다시 그린다
  async function chooseView(value, previousHeight) {
    const renders = Number(await client.evaluate(`document.getElementById('atHost').getAttribute('data-renders')`));
    await client.evaluate(`(function(){ var s = document.getElementById('atViewSelect'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitForCondition(client, `Number(document.getElementById('atHost').getAttribute('data-renders')) > ${renders} && document.getElementById('atHost').getAttribute('data-profile') === ${JSON.stringify(value)} && document.getElementById('atHost').scrollHeight !== ${previousHeight}`, 15000);
    return client.evaluate(`document.getElementById('atHost').scrollHeight`);
  }
  const tabHeight = await chooseView('tab', drawn.height);
  assert.ok(tabHeight < drawn.height, 'tab-only view is shorter than staff+tab (' + tabHeight + ' < ' + drawn.height + ')');
  const scoreHeight = await chooseView('score', tabHeight);
  assert.ok(scoreHeight < drawn.height, 'staff-only view is shorter than staff+tab (' + scoreHeight + ' < ' + drawn.height + ')');
  const backHeight = await chooseView('scoreTab', scoreHeight);
  assert.ok(Math.abs(backHeight - drawn.height) <= 2, 'switching back restores the staff+tab layout');

  // 재생 자동 스크롤은 testAlphaTabScroll, 컨트롤(클릭·음량·BPM)은 testAlphaTabControls 가 본다.

  // 소리(사운드폰트)는 처음 재생을 누를 때 불러온다. 지금까지 보기 창을 여러 번 열었어도 요청이 없어야 한다.
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(soundFontHits(), 0, 'opening and switching the view never requests the sound font');

  // 재생·일시정지·처음으로·Space
  await client.evaluate(`(function(){
    window.__statusLog = [];
    new MutationObserver(function(){ window.__statusLog.push(document.getElementById('atStatus').textContent); }).observe(document.getElementById('atStatus'), { childList: true, characterData: true, subtree: true });
    return true;
  })()`);
  const loadingNow = await client.evaluate(`(function(){
    document.getElementById('atPlayBtn').click();
    return { disabled: document.getElementById('atPlayBtn').disabled, text: document.getElementById('atStatus').textContent, sound: document.body.getAttribute('data-at-sound') };
  })()`, { userGesture: true });
  assert.equal(loadingNow.disabled, true, 'the play button is disabled while the sound loads');
  assert.equal(loadingNow.text, SOUND_LOADING, 'the status line says the sound is loading');
  assert.equal(loadingNow.sound, 'loading');
  await waitForCondition(client, `document.getElementById('atPlayBtn').textContent === '일시정지'`, 90000);
  assert.equal(soundFontHits(), 1, 'the first play requests the sound font once');
  const afterLoad = await client.evaluate(`({ disabled: document.getElementById('atPlayBtn').disabled, text: document.getElementById('atStatus').textContent, state: document.body.getAttribute('data-at-state'), sound: document.body.getAttribute('data-at-sound'), log: window.__statusLog })`);
  assert.equal(afterLoad.disabled, false, 'the play button is enabled again once playing');
  assert.deepEqual([afterLoad.text, afterLoad.state, afterLoad.sound], ['', 'ready', 'loaded'], 'the loading text goes away after the sound loaded');
  assert.ok(afterLoad.log.some(text => text.startsWith(SOUND_LOADING + ' ') && /\d+%$/.test(text)), 'the status line shows the loading progress in percent: ' + JSON.stringify(afterLoad.log.slice(0, 5)));
  await new Promise(resolve => setTimeout(resolve, 1200)); // 소리가 실제로 시작된 뒤에 멈춘다(바로 멈추면 alphaTab 내부에서 시작 전 정지 오류가 난다)
  await client.evaluate(`document.getElementById('atPlayBtn').click(); true`, { userGesture: true });
  await waitForCondition(client, `document.getElementById('atPlayBtn').textContent === '재생'`, 8000);
  await client.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })); true`, { userGesture: true });
  await waitForCondition(client, `document.getElementById('atPlayBtn').textContent === '일시정지'`, 8000);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await client.evaluate(`document.getElementById('atRewindBtn').click(); true`, { userGesture: true });
  await waitForCondition(client, `document.getElementById('atPlayBtn').textContent === '재생'`, 8000);
  assert.equal(soundFontHits(), 1, 'later plays reuse the loaded sound font');

  // 소리를 불러오지 못하면 알리고 단추를 다시 살린다: 사운드폰트 주소를 없는 파일로 바꿔 요청한다
  await navigate(viewUrl, viewSettled, 45000);
  const errorsBeforeFailure = client.consoleErrors.length;
  await client.evaluate(`(function(){
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){ return open.apply(this, [method, String(url).replace('MuseScore_General.sf3', 'missing-sound.sf3')].concat(Array.prototype.slice.call(arguments, 2))); };
    document.getElementById('atPlayBtn').click();
    return true;
  })()`, { userGesture: true });
  await waitForCondition(client, `document.body.getAttribute('data-at-sound') === 'failed'`, 30000);
  const failedSound = await client.evaluate(`({ disabled: document.getElementById('atPlayBtn').disabled, text: document.getElementById('atStatus').textContent, state: document.body.getAttribute('data-at-state') })`);
  assert.deepEqual(failedSound, { disabled: false, text: '소리를 불러오지 못했습니다. 네트워크를 확인하세요.', state: 'error' }, 'a failed sound font load is reported and the play button is usable again');
  assert.equal(servedPaths.filter(p => p === '/vendor/musescore-general/missing-sound.sf3').length, 1, 'the failed request went to the replaced address');
  assert.equal(soundFontHits(), 1, 'the failed attempt did not request the real sound font again');
  // alphaTab 이 읽지 못한 사운드폰트를 콘솔 오류로 남기는 것은 이 시험이 일부러 부른 것이다. 다른 오류는 남겨 아래 검사가 잡게 한다.
  const expectedErrors = client.consoleErrors.splice(errorsBeforeFailure);
  assert.ok(expectedErrors.length >= 1 && expectedErrors.every(text => /Soundfont/.test(String(text))), 'only the sound font read error is logged for the failed load: ' + JSON.stringify(expectedErrors));

  // 폭 900 다크와 375에서 가로로 넘치지 않는다
  const screenshotDir = path.join(root, 'test-artifacts');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const overflowProbe = `(function(){ var head = document.querySelector('.at-head').getBoundingClientRect(); return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, headRight: head.right, width: innerWidth }; })()`;
  async function capture(name, width, height, mobile) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await navigate(viewUrl, viewSettled, 45000); // 화면 폭에 맞는 배율은 불러올 때 정한다
    await waitForCondition(client, `document.querySelectorAll('#atHost svg *[fill]').length > 0`, 10000);
    const before = Number(await client.evaluate(`document.getElementById('atHost').getAttribute('data-renders')`));
    await new Promise(resolve => setTimeout(resolve, 800));
    await client.evaluate('window.scrollTo(0, 0); true');
    const probe = await client.evaluate(overflowProbe);
    assert.ok(probe.scroll <= probe.client + 1, width + 'px alphaTab page has no horizontal overflow (' + probe.scroll + ' > ' + probe.client + ')');
    assert.ok(probe.headRight <= probe.width + 1, width + 'px alphaTab head stays inside the viewport');
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const target = path.join(screenshotDir, name);
    fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
    process.stdout.write('Artifact: ' + target + ' (renders ' + before + ')\n');
  }
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await navigate(viewUrl, viewSettled, 45000);
  assert.equal((await readStatus()).state, 'ready', 'dark mode view is ready');
  // alphaTab 은 나눠서 그린다. 첫 요소만 보고 읽으면 줄(--muted)이 아직 없어 부하가 클 때 헛되이 실패했다.
  await waitForCondition(client, `(function(){
    var style = getComputedStyle(document.documentElement);
    var want = [style.getPropertyValue('--fg').trim().toUpperCase(), style.getPropertyValue('--muted').trim().toUpperCase()];
    var fills = Array.prototype.map.call(document.querySelectorAll('#atHost svg *[fill]'), function(el){ return el.getAttribute('fill').toUpperCase(); });
    return want.every(function(color){ return fills.indexOf(color) >= 0; });
  })()`, 15000);
  const darkColors = await client.evaluate(`(function(){
    var fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim().toUpperCase();
    var muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim().toUpperCase();
    var fills = {};
    Array.prototype.forEach.call(document.querySelectorAll('#atHost svg *'), function(el){ var f = el.getAttribute('fill'); if (f) fills[f.toUpperCase()] = true; });
    return { fg: fg, muted: muted, fills: Object.keys(fills) };
  })()`);
  assert.notEqual(darkColors.fg, lightColors.fg, 'dark mode changes the --fg token');
  assert.ok(darkColors.fills.indexOf(darkColors.fg) >= 0 && darkColors.fills.indexOf(darkColors.muted) >= 0, 'dark mode alphaTab colors follow the --fg and --muted tokens (' + darkColors.fills.join(',') + ')');
  assert.equal(darkColors.fills.indexOf('#000000'), -1, 'no pure black glyphs on the dark background');
  await capture('alphatab-view.png', 900, 1000, false);
  await capture('alphatab-view-375.png', 375, 812, true);
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await navigate(viewUrl, viewSettled, 45000);
  await capture('alphatab-view-375-light.png', 375, 812, true);

  // 모든 효과가 든 악보도 오류 없이 그려진다
  await setKey({ title: 'Effects "demo"', beats: 4, bpm: 60, capo: 2, lines: ['[Am] ~E2@6+B3@2+G4@1 hE5@1 hF#5@2 r', '[CM7] 1E4@1:i/s2F4@1:m 3G3@3/gA3@3 E3@4 -', '[Cm7] E4/F4/G4 - E4 -/F4', '- r r r'], savedAt: Date.now() });
  await navigate(viewUrl, viewSettled, 45000);
  status = await readStatus();
  assert.equal(status.state, 'ready', 'a score with roll, harmonics, slur, slide, tie and triplet renders: ' + JSON.stringify(status));
  assert.equal(await client.evaluate(`document.getElementById('atHost').getAttribute('data-bars')`), '4');
  assert.equal(status.title, 'Effects "demo"');

  await client.send('Emulation.clearDeviceMetricsOverride');
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] });
  await client.evaluate(`localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); true`);
  await navigate(practiceUrl, practiceReady);
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'no console errors on the practice button and the alphaTab view');
  process.stdout.write('Browser checkpoint: alphaTab view (practice button hand-off, alphatab.html render, view switch, play/pause, dark and 375px layout) passed\n');
}

// 재생 자동 스크롤: 아래 악보(다음 줄)가 모자랄 때나 지금 줄이 머리 막대에 가릴 때만 지금 줄을 머리 막대 바로 아래로 올린다.
// 사용자 처리기(customScrollHandler)를 줄마다 첫 박의 bounds 로 직접 불러 본다. 기대 위치는 DOM 에서 따로 잰 줄 위치로 셈한다.
async function testAlphaTabScroll(client, httpPort) {
  const SONG_ID = 'builtin-bach-minuet-g'; // 오선+타브가 900px 폭에서 줄을 여럿 이루는 긴 곡
  const VIEW_KEY = 'gs.alphaTab.view';
  const viewUrl = `http://127.0.0.1:${httpPort}/alphatab.html`;
  const practiceUrl = `http://127.0.0.1:${httpPort}/index.html`;
  const viewSettled = 'document.readyState === "complete" && ["ready","empty","error"].indexOf(document.body.getAttribute("data-at-state")) >= 0';
  const margin = Number(alphaTabViewSource.match(/var SCROLL_MARGIN = ([0-9.]+);/)[1]);
  const errorsBefore = client.consoleErrors.length;
  async function navigate(url, ready, timeoutMs) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, ready, timeoutMs || 8000);
  }
  const song = builtinSongsJson.find(item => item.id === SONG_ID);
  assert.ok(song, SONG_ID + ' exists in songs.json');
  await navigate(practiceUrl, 'document.readyState === "complete" && window.allSongs && window.curSong != null');
  await client.evaluate(`localStorage.setItem(${JSON.stringify(VIEW_KEY)}, ${JSON.stringify(JSON.stringify({ title: song.title, beats: song.beats, bpm: song.bpm, capo: 0, lines: song.lines, savedAt: Date.now() }))}); true`);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await navigate(viewUrl, viewSettled, 45000);
  await waitForCondition(client, `document.querySelectorAll('#atHost svg *[fill]').length > 0`, 15000);
  assert.equal(await client.evaluate(`typeof window.__alphaTabApi.customScrollHandler.onBeatCursorUpdating + '/' + typeof window.__alphaTabApi.customScrollHandler.forceScrollTo`), 'function/function', 'the view installs its own scroll handler');
  assert.equal(await client.evaluate(`window.__alphaTabApi.renderer.boundsLookup === window.__alphaTabApi.boundsLookup && window.__alphaTabApi.renderer.boundsLookup.staffSystems[0].boundsLookup === window.__alphaTabApi.boundsLookup`), true, 'the bounds lookup is reachable through api.renderer.boundsLookup and each staff system points back to it');

  // alphaTab 은 나눠서 그리므로 문서 높이가 멈출 때까지 기다린다.
  let lastHeight = -1, stableHeights = 0;
  for (let i = 0; i < 100 && stableHeights < 6; i++) {
    const now = await client.evaluate('document.documentElement.scrollHeight');
    stableHeights = now === lastHeight ? stableHeights + 1 : 0;
    lastHeight = now;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(stableHeights >= 6, 'the document height settled after drawing');

  // 줄 위치(문서 안 y). 세 번째 줄까지 다 보이는 높이로 창을 줄인다.
  const geometry = await client.evaluate(`(function(){
    var api = window.__alphaTabApi;
    var surface = document.querySelector('#atHost .at-surface').getBoundingClientRect();
    var origin = surface.top + window.scrollY;
    return { head: document.querySelector('.at-head').getBoundingClientRect().height, systems: api.renderer.boundsLookup.staffSystems.map(function(system){ return { top: origin + system.realBounds.y, bottom: origin + system.realBounds.y + system.realBounds.h }; }) };
  })()`);
  const systems = geometry.systems;
  assert.ok(systems.length >= 5, 'the 900px view has several systems to scroll between: ' + systems.length);
  const height = Math.ceil(systems[2].bottom) + 10;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 900, height, deviceScaleFactor: 1, mobile: false });
  await waitForCondition(client, `document.documentElement.clientHeight === ${height}`, 3000);
  const frame = await client.evaluate(`({ clientHeight: document.documentElement.clientHeight, maxScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight })`);
  assert.ok(frame.maxScroll > systems[4].top, 'the page is long enough to scroll to the fifth system');

  const scrollY = () => client.evaluate('window.scrollY');
  async function settle() {
    let last = -1, stable = 0;
    const deadline = Date.now() + 5000;
    await new Promise(resolve => setTimeout(resolve, 150));
    while (Date.now() < deadline && stable < 3) {
      const now = await scrollY();
      stable = Math.abs(now - last) < 0.5 ? stable + 1 : 0;
      last = now;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return last;
  }
  const beatOf = index => `window.__alphaTabApi.renderer.boundsLookup.staffSystems[${index}].bars[0].bars[0].beats[0]`;
  const callUpdating = index => client.evaluate(`window.__alphaTabApi.customScrollHandler.onBeatCursorUpdating(${beatOf(index)}); true`);
  const callForce = index => client.evaluate(`window.__alphaTabApi.customScrollHandler.forceScrollTo(${beatOf(index)}); true`);
  const clamp = value => Math.max(0, Math.min(frame.maxScroll, value));

  await client.evaluate('window.scrollTo(0, 0); true');
  await settle();
  const afterForward = [];
  let kept = 0, moved = 0;
  for (let i = 0; i < systems.length; i++) {
    const before = await scrollY();
    const next = systems[Math.min(i + 1, systems.length - 1)];
    const fits = next.bottom <= before + frame.clientHeight;
    const topVisible = systems[i].top >= before + geometry.head + margin;
    await callUpdating(i);
    const after = await settle();
    afterForward.push(after);
    if (fits && topVisible) {
      kept++;
      assert.ok(Math.abs(after - before) < 0.5, `system ${i}: the next system is fully visible, so the scroll stays (${before} -> ${after})`);
    } else {
      moved++;
      const want = clamp(systems[i].top - geometry.head - margin);
      assert.ok(Math.abs(after - want) <= 2, `system ${i}: the system top moves just below the head bar (scrollY ${after}, want ${want})`);
    }
  }
  assert.ok(kept >= 1, 'at least one system was reached without scrolling (' + kept + ')');
  assert.ok(moved >= 2, 'at least two systems needed scrolling (' + moved + ')');

  // 화면 위로 지나간 줄로 돌아가면(도돌이) 그 줄이 같은 자리에 온다
  const back = afterForward.findIndex((value, index) => index >= 2 && value > 0 && value < frame.maxScroll - 2 && Math.abs(value - (systems[index].top - geometry.head - margin)) <= 2);
  assert.ok(back > 0, 'a middle system scrolled to the head bar position on the forward pass');
  await callUpdating(systems.length - 1);
  await settle();
  await callUpdating(back);
  const returned = await settle();
  assert.ok(Math.abs(returned - afterForward[back]) <= 2, `going back to system ${back} lands where the forward pass put it (${afterForward[back]} -> ${returned})`);

  // 같은 줄 안의 박 갱신은 다시 판정하지 않고, forceScrollTo 는 늘 판정한다
  await client.evaluate('window.scrollTo(0, 0); true');
  await settle();
  await callUpdating(back);
  assert.ok(Math.abs(await settle()) < 0.5, 'the same system again does not scroll');
  await callForce(back);
  const forced = await settle();
  assert.ok(Math.abs(forced - afterForward[back]) <= 2, 'forceScrollTo judges again even for the same system (' + forced + ')');

  await client.evaluate('window.scrollTo(0, 0); true');
  await client.send('Emulation.clearDeviceMetricsOverride');
  await client.evaluate(`localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); true`);
  await navigate(practiceUrl, 'document.readyState === "complete" && window.allSongs && window.curSong != null');
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'no console errors while checking the scroll handler');
  process.stdout.write('Browser checkpoint: alphaTab auto scroll (scrolls only when the next system is cut off or the current one is hidden, goes back to the same place) passed\n');
}

// 보기 창 컨트롤: 클릭(메트로놈)·클릭음·연주음 값과 저장, BPM 슬라이더.
async function testAlphaTabControls(client, httpPort) {
  const VIEW_KEY = 'gs.alphaTab.view';
  const PREFS_KEY = 'gs.alphaTab.prefs';
  const viewUrl = `http://127.0.0.1:${httpPort}/alphatab.html`;
  const practiceUrl = `http://127.0.0.1:${httpPort}/index.html`;
  const practiceReady = 'document.readyState === "complete" && window.allSongs && window.curSong != null';
  const viewSettled = 'document.readyState === "complete" && ["ready","empty","error"].indexOf(document.body.getAttribute("data-at-state")) >= 0';
  const errorsBefore = client.consoleErrors.length;
  const metronomeBase = Number(alphaTabViewSource.match(/var METRONOME_BASE_VOLUME = ([0-9.]+);/)[1]);
  const masterVolume = Number(alphaTabViewSource.match(/var PLAYBACK_MASTER_VOLUME = ([0-9.]+);/)[1]);
  const twoPageDefaultScale = Number(alphaTabViewSource.match(/var TWO_PAGE_DEFAULT_SCALE = ([0-9.]+);/)[1]);
  async function navigate(url, ready, timeoutMs) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, ready, timeoutMs || 8000);
  }
  const butterfly = builtinSongsJson.find(item => item.id === 'builtin-lv1-butterfly');
  const canon = builtinSongsJson.find(item => item.id === 'builtin-carcassi-op60-16');
  assert.equal(canon.beats, 8, 'builtin-carcassi-op60-16 is an 8-cell song');
  const handoffOf = (song, extra) => Object.assign({ title: song.title, beats: song.beats, bpm: Number(song.bpm), capo: 0, lines: song.lines, savedAt: Date.now() }, extra || {});
  const setLocal = (key, value) => client.evaluate(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))}); true`);
  async function openView(handoff, prefs) {
    await navigate(practiceUrl, practiceReady);
    await client.evaluate(`localStorage.removeItem(${JSON.stringify(PREFS_KEY)}); true`);
    if (prefs !== undefined) await setLocal(PREFS_KEY, prefs);
    await setLocal(VIEW_KEY, handoff);
    await navigate(viewUrl, viewSettled, 45000);
    assert.equal(await client.evaluate(`document.body.getAttribute('data-at-state')`), 'ready', 'the view is ready');
  }
  const soundFacts = () => client.evaluate(`(function(){
    var api = window.__alphaTabApi;
    return { loop: document.getElementById('atLoopToggle').checked, isLooping: !!api.isLooping, click: document.getElementById('atClickToggle').checked, clickVol: Number(document.getElementById('atClickVolRange').value), guitarVol: Number(document.getElementById('atGuitarVolRange').value),
      metronome: api.metronomeVolume, countIn: api.countInVolume, master: api.masterVolume, guitar: document.body.getAttribute('data-at-guitar-volume'), stored: localStorage.getItem(${JSON.stringify(PREFS_KEY)}) };
  })()`);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const fire = (id, props, eventName) => client.evaluate(`(function(){ var n = document.getElementById(${JSON.stringify(id)}); Object.assign(n, ${JSON.stringify(props)}); n.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true })); return true; })()`);

  // 1. 처음 값, 그리고 이 창이 gs.state 를 건드리지 않고 localStorage 에 아무것도 쓰지 않는다
  await navigate(practiceUrl, practiceReady);
  await client.evaluate(`localStorage.removeItem(${JSON.stringify(PREFS_KEY)}); localStorage.removeItem('gs.state'); true`);
  await setLocal(VIEW_KEY, handoffOf(butterfly));
  const spy = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(function(){
    window.__storageWrites = [];
    ['setItem', 'removeItem', 'clear'].forEach(function(name){ var original = Storage.prototype[name]; Storage.prototype[name] = function(){ window.__storageWrites.push(name + ':' + arguments[0]); return original.apply(this, arguments); }; });
  })();` });
  try {
    await navigate(viewUrl, viewSettled, 45000);
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: spy.identifier });
  }
  assert.deepEqual(await client.evaluate('window.__storageWrites'), [], 'opening the view (storage.js and app-state.js included) writes nothing to localStorage');
  assert.equal(await client.evaluate(`localStorage.getItem('gs.state')`), null, 'the view does not write the practice screen state');
  let facts = await soundFacts();
  assert.deepEqual([facts.loop, facts.isLooping, facts.click, facts.clickVol, facts.guitarVol], [false, false, true, 100, 100], 'the controls start with loop off, click on, 100% and 100%');
  assert.ok(near(facts.metronome, metronomeBase) && near(facts.countIn, metronomeBase), 'click and count-in volumes are METRONOME_BASE_VOLUME at 100%: ' + JSON.stringify(facts));
  assert.ok(near(facts.master, masterVolume), 'the master volume stays PLAYBACK_MASTER_VOLUME');
  assert.equal(facts.guitar, '1');
  assert.equal(facts.stored, null, 'nothing is stored until a control changes');
  await fire('atLoopToggle', { checked: true }, 'change');
  facts = await soundFacts();
  assert.deepEqual([facts.loop, facts.isLooping, facts.stored], [true, true, null], 'turning loop on sets api.isLooping without writing prefs');
  await client.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true })); true`);
  facts = await soundFacts();
  assert.deepEqual([facts.loop, facts.isLooping, facts.stored], [false, false, null], 'pressing R toggles loop off without writing prefs');
  const labels = await client.evaluate(`(function(){ var l = function(id){ return document.getElementById(id).closest('label'); }; return { click: l('atClickToggle').textContent.trim(), clickVol: l('atClickVolRange').textContent.trim(), guitarVol: l('atGuitarVolRange').textContent.trim(), clickTitle: !!l('atClickVolRange').title, guitarTitle: !!l('atGuitarVolRange').title, width: [document.getElementById('atClickVolRange'), document.getElementById('atGuitarVolRange')].map(function(n){ return Math.round(n.getBoundingClientRect().width); }) }; })()`);
  assert.deepEqual([labels.click, labels.clickVol, labels.guitarVol, labels.clickTitle, labels.guitarTitle], ['클릭', '클릭음', '연주음', true, true], 'labels are 클릭, 클릭음, 연주음 with tooltips and no value text');
  assert.deepEqual(labels.width, [68, 68], 'the volume sliders are as narrow as on the practice screen');
  assert.deepEqual(await client.evaluate(`['atClickVolRange', 'atGuitarVolRange'].map(function(id){ var n = document.getElementById(id); return [n.min, n.max, n.step].join('/'); })`), ['0/200/5', '0/100/5'], 'slider ranges are 0-200% and 0-100% in steps of 5');

  // 2. 컨트롤을 바꾸면 값이 적용되고 저장된다
  await fire('atClickToggle', { checked: false }, 'change');
  facts = await soundFacts();
  assert.deepEqual([facts.metronome, facts.countIn], [0, 0], 'turning the click off silences the click and the count-in');
  assert.deepEqual(JSON.parse(facts.stored), { click: false, clickVol: 1, guitarVol: 1, twoPage: false, twoPageScale: twoPageDefaultScale }, 'prefs are saved');
  await fire('atClickVolRange', { value: '150' }, 'input');
  facts = await soundFacts();
  assert.deepEqual([facts.metronome, facts.countIn], [0, 0], 'the click stays silent while it is off');
  await fire('atClickToggle', { checked: true }, 'change');
  facts = await soundFacts();
  assert.ok(near(facts.metronome, metronomeBase * 1.5) && near(facts.countIn, metronomeBase * 1.5), 'click and count-in follow METRONOME_BASE_VOLUME x click volume: ' + JSON.stringify(facts));
  assert.ok(near(facts.master, masterVolume), 'the click volume does not touch the master volume');
  await fire('atGuitarVolRange', { value: '50' }, 'input');
  facts = await soundFacts();
  assert.equal(facts.guitar, '0.5', 'the guitar volume is applied as a track volume');
  assert.ok(near(facts.master, masterVolume) && near(facts.metronome, metronomeBase * 1.5), 'the guitar volume leaves the master volume and the click alone');
  assert.deepEqual(JSON.parse(facts.stored), { click: true, clickVol: 1.5, guitarVol: 0.5, twoPage: false, twoPageScale: twoPageDefaultScale });
  await fire('atClickToggle', { checked: false }, 'change');
  // 새로 열면 저장한 값으로 시작한다
  await navigate(viewUrl, viewSettled, 45000);
  facts = await soundFacts();
  assert.deepEqual([facts.click, facts.clickVol, facts.guitarVol, facts.metronome, facts.countIn, facts.guitar], [false, 150, 50, 0, 0, '0.5'], 'the saved prefs come back when the view is opened again');
  assert.equal(await client.evaluate(`localStorage.getItem('gs.state')`), null, 'changing controls does not write the practice screen state');
  // 틀린 값은 기본값
  for (const bad of [{ click: 'yes', clickVol: 5, guitarVol: -1 }, '{not json', { click: true, clickVol: '1', guitarVol: 2 }, [1, 2]]) {
    await openView(handoffOf(butterfly), bad);
    facts = await soundFacts();
    assert.deepEqual([facts.click, facts.clickVol, facts.guitarVol], [true, 100, 100], 'wrong prefs fall back to the defaults: ' + JSON.stringify(bad));
  }
  await openView(handoffOf(butterfly), { click: false, clickVol: 2, guitarVol: 0 });
  facts = await soundFacts();
  assert.deepEqual([facts.click, facts.clickVol, facts.guitarVol, facts.guitar], [false, 200, 0, '0'], 'the range ends are valid prefs');

  // 3. BPM 슬라이더 (연습 화면과 같은 단위, 곡 BPM 에 대한 비율 범위)
  const sliderFacts = () => client.evaluate(`(function(){ var r = document.getElementById('atBpmRange'); return { min: Number(r.min), max: Number(r.max), step: r.step, value: Number(r.value), text: document.getElementById('atBpmValue').textContent, speed: window.__alphaTabApi.playbackSpeed, tempo: window.__alphaTabApi.score.tempo, stored: localStorage.getItem(${JSON.stringify(PREFS_KEY)}) }; })()`);
  const base = Number(butterfly.bpm);
  const range = expectedBpmSlider(base, undefined);
  await openView(handoffOf(butterfly, { practiceBpm: 48 }));
  let slider = await sliderFacts();
  assert.deepEqual([slider.min, slider.max, slider.step], [range.min, range.max, '1'], 'the range is the song BPM times the ratio constants, in steps of 1');
  assert.deepEqual([slider.value, slider.text, slider.speed], [48, bpmText(48, base), 48 / base], 'the slider starts at the practice BPM');
  for (const value of [range.min, Math.round((range.min + range.max) / 2) + 1, range.max]) {
    await fire('atBpmRange', { value: String(value) }, 'input');
    slider = await sliderFacts();
    assert.deepEqual([slider.value, slider.text, slider.speed], [value, bpmText(value, base), value / base], 'slider value ' + value + ' sets playbackSpeed = value / song BPM');
  }
  assert.ok(near(slider.speed, BPM_RATIO_MAX), 'the upper end plays at the upper ratio');
  await fire('atBpmRange', { value: String(range.min) }, 'input');
  assert.ok(near((await sliderFacts()).speed, BPM_RATIO_MIN), 'the lower end plays at the lower ratio');
  assert.equal(slider.stored, null, 'the BPM is not saved');
  await fire('atClickToggle', { checked: false }, 'change');
  assert.deepEqual(Object.keys(JSON.parse((await sliderFacts()).stored)).sort(), ['click', 'clickVol', 'guitarVol', 'twoPage', 'twoPageScale'], 'the prefs hold no BPM');
  for (const practiceBpm of [range.max + 1, range.min - 1, 0, 'x', null, undefined]) {
    await openView(handoffOf(butterfly, practiceBpm === undefined ? {} : { practiceBpm }));
    slider = await sliderFacts();
    assert.deepEqual([slider.value, slider.text, slider.speed], [base, bpmText(base, base), 1], 'an out-of-range or missing practice BPM (' + String(practiceBpm) + ') starts at the song BPM');
  }
  await openView(handoffOf(butterfly, { practiceBpm: range.min }));
  assert.equal((await sliderFacts()).value, range.min, 'the range ends are accepted as the start value');
  await openView(handoffOf(butterfly, { practiceBpm: range.max }));
  assert.equal((await sliderFacts()).value, range.max);
  // 곡 BPM 이 잘못이면 악보의 템포로
  const TEX = '\\title "Tempo only" \\tempo 90 \\ts (4 4)\n0.1.4 0.2.4 0.3.4 0.4.4 |\n0.1.1 |\n';
  await openView(handoffOf(butterfly, { bpm: 0, alphaTex: TEX }));
  slider = await sliderFacts();
  assert.equal(slider.tempo, 90);
  assert.deepEqual([slider.value, slider.text, slider.speed], [90, bpmText(90, 90), 1], 'an invalid song BPM falls back to the score tempo');
  // 8칸 곡: 숫자는 연습 화면의 단위(분당 칸 수)이고 alphaTab 템포(4분음표)와 다르다
  await openView(handoffOf(canon));
  slider = await sliderFacts();
  assert.deepEqual([slider.value, slider.text, slider.speed], [Number(canon.bpm), bpmText(Number(canon.bpm), Number(canon.bpm)), 1], 'the 8-cell song starts at 100% showing the song BPM');
  assert.equal(slider.tempo * 2, Number(canon.bpm), 'alphaTab tempo is per quarter note, half of the cell BPM for an 8-cell song');
  await fire('atBpmRange', { value: String(Math.round(Number(canon.bpm) * 0.5)) }, 'input');
  slider = await sliderFacts();
  assert.ok(near(slider.speed, Math.round(Number(canon.bpm) * 0.5) / Number(canon.bpm)), 'the 8-cell song speed is the ratio of the practice-screen numbers');

  await client.evaluate(`localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); localStorage.removeItem(${JSON.stringify(PREFS_KEY)}); true`);
  await navigate(practiceUrl, practiceReady);
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'no console errors on the alphaTab controls (storage.js and app-state.js load cleanly)');
  process.stdout.write('Browser checkpoint: alphaTab controls (click, click volume, guitar volume, saved prefs, BPM slider, no localStorage writes on load) passed\n');
}

// 두 쪽 보기(가로 화면): 켜기·끄기, 잘림 없음, 쪽 넘김, 커서 거울, 오른쪽 클릭, 세로 전환, 작은 가로 화면의 배율.
async function testAlphaTabTwoPage(client, httpPort) {
  const SONG_ID = 'builtin-sor-op35-22';
  const VIEW_KEY = 'gs.alphaTab.view';
  const PREFS_KEY = 'gs.alphaTab.prefs';
  const viewUrl = `http://127.0.0.1:${httpPort}/alphatab.html`;
  const practiceUrl = `http://127.0.0.1:${httpPort}/index.html`;
  const practiceReady = 'document.readyState === "complete" && window.allSongs && window.curSong != null';
  const viewSettled = 'document.readyState === "complete" && ["ready","empty","error"].indexOf(document.body.getAttribute("data-at-state")) >= 0';
  const errorsBefore = client.consoleErrors.length;
  const twoPagePadding = JSON.parse(alphaTabViewSource.match(/var TWO_PAGE_PADDING = (\[[^\]]*\]);/)[1]);
  const minScale = Number(alphaTabViewSource.match(/var TWO_PAGE_MIN_SCALE = ([0-9.]+);/)[1]);
  const defaultScale = Number(alphaTabViewSource.match(/var TWO_PAGE_DEFAULT_SCALE = ([0-9.]+);/)[1]);
  const scaleStep = Number(alphaTabViewSource.match(/var TWO_PAGE_SCALE_STEP = ([0-9.]+);/)[1]);
  const maxScale = Number(alphaTabViewSource.match(/var TWO_PAGE_MAX_SCALE = ([0-9.]+);/)[1]);
  const swipeMin = Number(alphaTabViewSource.match(/var SWIPE_MIN_DISTANCE = ([0-9.]+);/)[1]);
  const wheelCooldown = Number(alphaTabViewSource.match(/var WHEEL_COOLDOWN_MS = ([0-9.]+);/)[1]);
  const wheelMinDelta = Number(alphaTabViewSource.match(/var WHEEL_MIN_DELTA = ([0-9.]+);/)[1]);
  const round2 = value => Math.round(value * 100) / 100;
  const song = builtinSongsJson.find(item => item.id === SONG_ID);
  assert.ok(song, SONG_ID + ' exists in songs.json');
  async function navigate(url, ready, timeoutMs) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, ready, timeoutMs || 8000);
  }
  const setSize = async (width, height) => client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const twoSettled = `document.body.getAttribute('data-at-layout') === 'two' && document.body.getAttribute('data-at-pages-match') === 'true' && Number(document.body.getAttribute('data-at-page-count')) >= 1 && !!window.__alphaTabPages && document.querySelectorAll('#atHostR svg *[fill]').length > 0`;
  const state = () => client.evaluate(`(function(){
    var b = document.body, btn = document.getElementById('atPagesBtn');
    return { layout: b.getAttribute('data-at-layout'), spread: b.getAttribute('data-at-spread'), match: b.getAttribute('data-at-pages-match'), count: b.getAttribute('data-at-page-count'),
      btnHidden: btn.hidden, btnText: btn.textContent, pressed: btn.getAttribute('aria-pressed'), active: btn.classList.contains('active'), rightApi: typeof window.__alphaTabApiR,
      nums: Array.prototype.map.call(document.querySelectorAll('.at-page-num'), function(n){ return n.textContent; }), stored: localStorage.getItem(${JSON.stringify(PREFS_KEY)}) };
  })()`);
  // 두 쪽 창 안에 다 들어 있는지: 문서가 스크롤되지 않고, 쪽 창이 화면 안이고, 보이는 범위와 겹치는 조각이 범위 밖으로 삐져나가지 않는다.
  const fit = () => client.evaluate(`(function(){
    var de = document.documentElement;
    var out = { scrollOk: de.scrollHeight <= de.clientHeight, clientHeight: de.clientHeight, pageBottoms: Array.prototype.map.call(document.querySelectorAll('.at-page'), function(p){ return p.getBoundingClientRect().bottom; }), hosts: [] };
    [[document.getElementById('atHost'), window.__alphaTabApi], [document.getElementById('atHostR'), window.__alphaTabApiR]].forEach(function(pair){
      var host = pair[0], surface = pair[1].canvasElement.element;
      var top = host.scrollTop, bottom = top + host.clientHeight, overlapping = 0, bad = [];
      Array.prototype.forEach.call(surface.children, function(child){
        var t = (parseFloat(child.style.top) || 0) + surface.offsetTop, h = parseFloat(child.style.height) || 0;
        if (h > 0 && t + h > top + 1 && t < bottom - 1){ overlapping++; if (t < top - 1 || t + h > bottom + 1) bad.push([t, h, top, bottom]); }
      });
      out.hosts.push({ overlapping: overlapping, bad: bad });
    });
    return out;
  })()`);
  const svgTexts = () => client.evaluate(`(function(){
    var read = function(id){ return Array.prototype.map.call(document.querySelectorAll('#' + id + ' svg text'), function(t){ return t.textContent.trim(); }); };
    return { left: read('atHost'), right: document.getElementById('atHostR') ? read('atHostR') : [] };
  })()`);
  // 쪽 번호(0부터)의 첫 줄 번호와 그 줄 첫 마디 번호(0부터)
  const firstBarOfPage = pageIndex => client.evaluate(`(function(){
    var api = window.__alphaTabApi, pages = window.__alphaTabPages;
    var systems = api.renderer.boundsLookup.staffSystems, bar = 0;
    for (var i = 0; i < systems.length; i++){
      var mid = systems[i].realBounds.y + systems[i].realBounds.h / 2;
      if (mid >= pages[${pageIndex}].top) return { system: i, bar: bar };
      bar += systems[i].bars.length;
    }
    return null;
  })()`);
  const jumpToPage = async pageIndex => {
    const where = await firstBarOfPage(pageIndex);
    assert.ok(where, 'page ' + (pageIndex + 1) + ' has a first system');
    await client.evaluate(`(function(){
      var api = window.__alphaTabApi;
      var beat = api.score.tracks[0].staves[0].bars[${where.bar}].voices[0].beats[0];
      var bb = api.renderer.boundsLookup.findBeat(beat);
      if (!bb) throw new Error('no beat bounds for bar ${where.bar}');
      api.customScrollHandler.onBeatCursorUpdating(bb);
      return true;
    })()`);
    return where;
  };
  const press = async key => {
    const code = { ArrowLeft: 37, ArrowRight: 39 }[key];
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
    await sleep(150);
  };
  const clickPagesButton = () => client.evaluate(`document.getElementById('atPagesBtn').click(); true`, { userGesture: true });

  try {
    // 1. 가로 1920x960: 처음에는 한 쪽 보기, 단추는 보이고 꺼져 있다
    await navigate(practiceUrl, practiceReady);
    await client.evaluate(`localStorage.removeItem(${JSON.stringify(PREFS_KEY)}); localStorage.setItem(${JSON.stringify(VIEW_KEY)}, ${JSON.stringify(JSON.stringify({ title: song.title, beats: song.beats, bpm: Number(song.bpm), capo: 0, lines: song.lines, savedAt: Date.now() }))}); true`);
    await setSize(1920, 960);
    await navigate(viewUrl, viewSettled, 45000);
    await waitForCondition(client, `document.querySelectorAll('#atHost svg *[fill]').length > 0`, 15000);
    let facts = await state();
    assert.deepEqual([facts.btnHidden, facts.btnText, facts.pressed, facts.active, facts.layout, facts.rightApi], [false, '두 쪽', 'false', false, 'one', 'undefined'], 'landscape shows the two-page button off by default: ' + JSON.stringify(facts));
    const onePagePadding = await client.evaluate('window.__alphaTabApi.settings.display.padding');
    assert.equal(await client.evaluate(`window.__alphaTabApi.settings.core.enableLazyLoading`), true, 'the one-page view keeps lazy loading');
    const oneTexts = await svgTexts();
    assert.ok(oneTexts.left.includes('Guitar Standard Tuning'), 'the one-page view draws the tuning line (so the hidden-header check below is not vacuous)');
    assert.ok(oneTexts.left.some(text => text.includes(song.title)), 'the one-page view draws the song title in the score header');

    assert.equal(await client.evaluate(`document.getElementById('atZoom').hidden`), true, 'the zoom buttons are hidden in the one-page view');

    // 2. 단추를 누르면 두 쪽 보기
    await clickPagesButton();
    await waitForCondition(client, twoSettled + ' && Number(document.body.getAttribute("data-at-page-count")) >= 3', 20000);
    facts = await state();
    assert.deepEqual([facts.layout, facts.match, facts.pressed, facts.active, facts.spread], ['two', 'true', 'true', true, '0,1'], 'the button switches to two pages: ' + JSON.stringify(facts));
    assert.deepEqual(JSON.parse(facts.stored), { click: true, clickVol: 1, guitarVol: 1, twoPage: true, twoPageScale: defaultScale }, 'the choice is saved with the other prefs unchanged');
    const structure = await client.evaluate(`(function(){
      var pages = document.querySelectorAll('.at-page');
      var L = window.__alphaTabApi, R = window.__alphaTabApiR;
      return { count: pages.length, leftParent: document.getElementById('atHost').parentNode === pages[0], rightParent: document.getElementById('atHostR').parentNode === pages[1],
        paddingL: L.settings.display.padding, paddingR: R.settings.display.padding, scaleL: L.settings.display.scale, scaleR: R.settings.display.scale, lazyL: L.settings.core.enableLazyLoading, lazyR: R.settings.core.enableLazyLoading,
        rightPlayer: !!R.player, nums: Array.prototype.map.call(document.querySelectorAll('.at-page-num'), function(n){ return n.textContent; }) };
    })()`);
    assert.deepEqual([structure.count, structure.leftParent, structure.rightParent], [2, true, true], 'the two hosts sit in the two page frames');
    assert.deepEqual(structure.paddingL, twoPagePadding, 'the left instance uses TWO_PAGE_PADDING');
    assert.deepEqual(structure.paddingR, twoPagePadding, 'the right instance uses TWO_PAGE_PADDING');
    assert.equal(structure.scaleL, structure.scaleR, 'both instances draw at the same scale');
    assert.equal(structure.scaleL, defaultScale, 'the two-page view starts at the default scale');
    const zoomFacts = await client.evaluate(`({ hidden: document.getElementById('atZoom').hidden, text: document.getElementById('atZoomValue').textContent })`);
    assert.deepEqual(zoomFacts, { hidden: false, text: Math.round(defaultScale * 100) + '%' }, 'the zoom buttons show the default scale in the two-page view');
    assert.deepEqual([structure.lazyL, structure.lazyR, structure.rightPlayer], [false, false, false], 'lazy loading is off and the right instance has no player');
    const pageCount = Number(facts.count);
    assert.deepEqual(structure.nums, ['1 / ' + pageCount, '2 / ' + pageCount], 'the page numbers are shown');

    // 3. 잘림 없음과 스크롤 없음
    const checkFit = async label => {
      const f = await fit();
      assert.equal(f.scrollOk, true, label + ': the document does not scroll');
      assert.ok(f.pageBottoms.every(bottom => bottom <= f.clientHeight + 0.5), label + ': the page frames end inside the window: ' + JSON.stringify(f.pageBottoms) + ' / ' + f.clientHeight);
      f.hosts.forEach((host, index) => {
        assert.ok(host.overlapping > 0, label + ': the ' + (index ? 'right' : 'left') + ' window shows at least one piece');
        assert.deepEqual(host.bad, [], label + ': no piece is cut at the edge of the ' + (index ? 'right' : 'left') + ' window');
      });
    };
    await checkFit('start');

    // 4. 악보 머리 글이 숨는다
    const twoTexts = await svgTexts();
    for (const side of ['left', 'right']) {
      assert.ok(!twoTexts[side].includes('Guitar Standard Tuning'), side + ' page hides the tuning line');
      assert.ok(!twoTexts[side].some(text => text.includes(song.title)), side + ' page hides the score title');
    }

    // 4b. 확대·축소
    const readZoom = () => client.evaluate(`({ l: window.__alphaTabApi.settings.display.scale, r: window.__alphaTabApiR.settings.display.scale, text: document.getElementById('atZoomValue').textContent,
      stored: JSON.parse(localStorage.getItem(${JSON.stringify(PREFS_KEY)})).twoPageScale, count: Number(document.body.getAttribute('data-at-page-count')), match: document.body.getAttribute('data-at-pages-match') })`);
    const zoomClick = async (id, expected) => {
      const before = await client.evaluate('JSON.stringify(window.__alphaTabPages)');
      await client.evaluate(`document.getElementById('${id}').click(); true`);
      await waitForCondition(client, `JSON.stringify(window.__alphaTabPages) !== ${JSON.stringify(before)} && document.body.getAttribute('data-at-pages-match') === 'true'`, 20000);
      await sleep(700);
      const f = await readZoom();
      assert.deepEqual([f.l, f.r, f.stored, f.text, f.match], [expected, expected, expected, Math.round(expected * 100) + '%', 'true'], id + ' sets both instances, the saved value and the text to ' + expected + ': ' + JSON.stringify(f));
      return f;
    };
    const baseCount = (await readZoom()).count;
    const zoomedIn = await zoomClick('atZoomInBtn', round2(defaultScale + scaleStep));
    assert.ok(zoomedIn.count >= baseCount, 'zooming in does not reduce the page count: ' + zoomedIn.count + ' vs ' + baseCount);
    await zoomClick('atZoomOutBtn', defaultScale);
    await zoomClick('atZoomOutBtn', round2(defaultScale - scaleStep));
    const zoomedOut = await readZoom();
    assert.ok(zoomedOut.count <= baseCount, 'zooming out does not increase the page count: ' + zoomedOut.count + ' vs ' + baseCount);
    await zoomClick('atZoomInBtn', defaultScale);
    assert.equal((await readZoom()).count, baseCount, 'back at the default scale the page count is the same');
    assert.equal((await state()).spread, '0,1', 'zooming keeps the spread');

    // 5. 재생 따라가기는 반쪽씩: 2쪽(번호 1) → 3·2쪽, 3쪽(번호 2) → 3·4쪽
    await jumpToPage(1);
    facts = await state();
    assert.equal(facts.spread, '2,1', 'following into page 2 puts page 3 on the left and page 2 on the right');
    assert.deepEqual(facts.nums, ['3 / ' + pageCount, '2 / ' + pageCount], 'the page numbers follow the spread');
    await checkFit('page 2');
    await jumpToPage(2);
    assert.equal((await state()).spread, '2,3', 'following into page 3 puts pages 3 and 4 side by side');
    await checkFit('page 3');

    // 6. 키: 손으로 넘기기는 펼침째. 포커스를 본문에 두고 ←, →, 처음으로
    await client.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); true`);
    const lastLeft = 2 * Math.floor((pageCount - 1) / 2);
    await client.evaluate(`document.getElementById('atRewindBtn').click(); true`, { userGesture: true });
    await sleep(300);
    assert.equal((await state()).spread, '0,1', 'rewind before the key checks');
    await press('ArrowLeft');
    assert.equal((await state()).spread, '0,1', 'ArrowLeft on the first spread stays');
    await press('ArrowRight');
    assert.equal((await state()).spread, '2,3', 'ArrowRight turns to the next spread');
    await press('ArrowLeft');
    assert.equal((await state()).spread, '0,1', 'ArrowLeft turns back to the previous spread');
    await jumpToPage(1);
    assert.equal((await state()).spread, '2,1', 'following into page 2 makes the half-turned state');
    await press('ArrowRight');
    assert.equal((await state()).spread, '2,3', 'ArrowRight from the half-turned state goes to the next spread');
    await jumpToPage(1);
    assert.equal((await state()).spread, '2,1', 'following into page 2 again');
    await press('ArrowLeft');
    assert.equal((await state()).spread, '0,1', 'ArrowLeft from the half-turned state goes to the spread holding the current page');
    for (let i = 0; i < pageCount + 1; i++) await press('ArrowRight');
    assert.equal(Number((await state()).spread.split(',')[0]), lastLeft, 'repeated ArrowRight stops at the last spread');
    await client.evaluate(`document.getElementById('atRewindBtn').click(); true`, { userGesture: true });
    await sleep(300);
    assert.equal((await state()).spread, '0,1', 'the rewind button returns to page 1');

    // 7. 커서 거울: 2쪽 첫 박으로 옮기면 오른쪽 커서가 왼쪽과 같은 자리에 선다
    const secondPage = await firstBarOfPage(1);
    await client.evaluate(`(function(){
      var api = window.__alphaTabApi;
      api.tickPosition = api.tickCache.getBeatStart(api.score.tracks[0].staves[0].bars[${secondPage.bar}].voices[0].beats[0]);
      return true;
    })()`);
    const cursors = `(function(){
      var read = function(host, sel){ var node = document.querySelector(host + ' ' + sel); return node ? node.style.transform : null; };
      var bar = function(host){ var node = document.querySelector(host + ' .at-cursor-bar'); return node ? node.style.cssText : null; };
      return { beatL: read('#atHost', '.at-cursor-beat'), beatR: read('#atHostR .at-cursors', '.at-cursor-beat'), barL: bar('#atHost'), barR: bar('#atHostR .at-cursors') };
    })()`;
    await waitForCondition(client, `(function(){ var c = ${cursors}; return !!c.beatR && c.beatR === c.beatL && !!c.barR && c.barR === c.barL; })()`, 3000);
    const mirrored = await client.evaluate(cursors);
    assert.ok(mirrored.beatR && mirrored.beatR === mirrored.beatL, 'the right beat cursor copies the left one: ' + JSON.stringify(mirrored));
    assert.ok(mirrored.barR && mirrored.barR === mirrored.barL, 'the right bar cursor copies the left one');

    // 8. 오른쪽 클릭: 오른쪽 쪽 첫 줄 가운데 마디의 한가운데
    await client.evaluate(`document.getElementById('atRewindBtn').click(); true`, { userGesture: true });
    await sleep(300);
    assert.equal((await state()).spread, '0,1');
    const target = await client.evaluate(`(function(){
      var api = window.__alphaTabApi, R = window.__alphaTabApiR;
      var rightPage = Number(document.body.getAttribute('data-at-spread').split(',')[1]);
      var systems = api.renderer.boundsLookup.staffSystems, bar = 0, firstSystem = -1;
      for (var i = 0; i < systems.length; i++){
        if (systems[i].realBounds.y + systems[i].realBounds.h / 2 >= window.__alphaTabPages[rightPage].top){ firstSystem = i; break; }
        bar += systems[i].bars.length;
      }
      var rs = R.renderer.boundsLookup.staffSystems[firstSystem];
      var mid = Math.floor(rs.bars.length / 2), vb = rs.bars[mid].visualBounds;
      var masterBar = api.score.masterBars[bar + mid];
      var rect = R.canvasElement.element.getBoundingClientRect();
      var start = api.tickCache.getMasterBarStart(masterBar);
      return { x: rect.left + vb.x + vb.w / 2, y: rect.top + vb.y + vb.h / 2, start: start, end: start + masterBar.calculateDuration() };
    })()`);
    assert.ok(target.x > 0 && target.y > 0, 'the click target is on screen: ' + JSON.stringify(target));
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(500);
    const tick = await client.evaluate('window.__alphaTabApi.tickPosition');
    assert.ok(tick >= target.start && tick < target.end, 'clicking a bar on the right page moves the position into that bar: ' + tick + ' not in [' + target.start + ', ' + target.end + ')');

    // 8b. 터치 밀기
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    try {
      const swipeAt = async (dx, dy) => {
        const box = await client.evaluate(`(function(){ var r = document.querySelector('.at-page').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        const touch = (x, y) => [{ x, y, id: 1 }];
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(box.x, box.y) });
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(box.x + dx / 2, box.y + dy / 2) });
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(box.x + dx, box.y + dy) });
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(250);
        return (await state()).spread;
      };
      assert.equal((await state()).spread, '0,1');
      assert.equal(await swipeAt(-200, 0), '2,3', 'swiping left turns to the next spread');
      assert.equal(await swipeAt(200, 0), '0,1', 'swiping right turns back to the previous spread');
      assert.equal(await swipeAt(200, 0), '0,1', 'swiping right on the first spread stays');
      assert.equal(await swipeAt(-Math.floor(swipeMin / 2), 0), '0,1', 'a short swipe does not turn the page');
      assert.equal(await swipeAt(-20, 200), '0,1', 'a mostly vertical swipe does not turn the page');
    } finally {
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }

    // 8c. 마우스 휠 넘김
    const wheelOnPages = async (deltaY, waitMs = 50) => {
      await client.evaluate(`(function(){
        var el = document.querySelector('.at-pages');
        if (el) el.dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, bubbles: true, cancelable: true }));
      })()`);
      if (waitMs > 0) await sleep(waitMs);
      return (await state()).spread;
    };
    assert.equal((await state()).spread, '0,1');
    assert.equal(await wheelOnPages(100, 50), '2,3', 'scrolling wheel down turns to the next spread');
    assert.equal(await wheelOnPages(100, 50), '2,3', 'scrolling within cooldown does not turn page again');
    await sleep(wheelCooldown + 50);
    assert.equal(await wheelOnPages(-100, 50), '0,1', 'scrolling wheel up turns back to the previous spread');
    assert.equal(await wheelOnPages(-100, 50), '0,1', 'scrolling wheel up on the first spread stays');
    assert.equal(await wheelOnPages(Math.floor(wheelMinDelta / 2), 50), '0,1', 'a minor wheel movement below threshold does not turn the page');

    // 9. 다시 열면 단추를 안 눌러도 두 쪽
    await navigate(viewUrl, viewSettled, 45000);
    await waitForCondition(client, twoSettled, 20000);
    assert.equal((await state()).layout, 'two', 'the saved choice opens the two-page view');

    // 10. 세로로 돌리면 한 쪽 보기로 돌아간다(새로 고치지 않는다)
    await setSize(800, 1200);
    await waitForCondition(client, `document.body.getAttribute('data-at-layout') === 'one' && Array.prototype.some.call(document.querySelectorAll('#atHost svg text'), function(t){ return t.textContent.trim() === 'Guitar Standard Tuning'; })`, 20000);
    facts = await state();
    assert.deepEqual([facts.btnHidden, facts.spread, facts.match, facts.count], [true, null, null, null], 'portrait hides the button and clears the two-page attributes: ' + JSON.stringify(facts));
    const back = await client.evaluate(`(function(){
      var api = window.__alphaTabApi, host = document.getElementById('atHost');
      return { right: !!document.getElementById('atHostR'), pages: !!document.querySelector('.at-pages'), api: window.__alphaTabApiR, parentIsWrap: host.parentNode === document.querySelector('.wrap'), height: host.style.height,
        lazy: api.settings.core.enableLazyLoading, padding: api.settings.display.padding, tuning: Array.prototype.some.call(host.querySelectorAll('svg text'), function(t){ return t.textContent.trim() === 'Guitar Standard Tuning'; }) };
    })()`);
    assert.deepEqual([back.right, back.pages, back.api, back.parentIsWrap, back.height, back.lazy], [false, false, null, true, '', true], 'leaving two pages removes the right instance and restores the host');
    assert.deepEqual(back.padding, onePagePadding, 'the one-page padding comes back');
    assert.equal(back.tuning, true, 'the score header comes back in the one-page view');

    // 11. 다시 가로 1280x720
    await setSize(1280, 720);
    await waitForCondition(client, twoSettled, 20000);
    assert.equal((await state()).match, 'true', 'landscape again switches back to two pages');

    // 11b. 창 높이만 바뀌는 경우: 폭이 그대로면 alphaTab 이 다시 그리지 않으므로, 줄이기 판단이 resize 에서 돌아야 한다
    const fitsSmall = `(function(){
      var pageL = document.querySelector('.at-page'); if (!pageL || !window.__alphaTabApiR || !window.__alphaTabApiR.canvasElement) return false;
      var cs = getComputedStyle(pageL), hc = pageL.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      var tallest = 0;
      [window.__alphaTabApi, window.__alphaTabApiR].forEach(function(inst){ Array.prototype.forEach.call(inst.canvasElement.element.children, function(c){ tallest = Math.max(tallest, parseFloat(c.style.height) || 0); }); });
      return document.body.getAttribute('data-at-layout') === 'two' && document.body.getAttribute('data-at-pages-match') === 'true' && tallest > 0 && tallest <= hc + 1;
    })()`;
    const readScales = () => client.evaluate(`({ l: window.__alphaTabApi.settings.display.scale, r: window.__alphaTabApiR.settings.display.scale, saved: JSON.parse(localStorage.getItem(${JSON.stringify(PREFS_KEY)})).twoPageScale })`);
    const widthNow = await client.evaluate('window.innerWidth');
    const heightBefore = await client.evaluate('window.innerHeight');
    // 지금 쪽 창 안쪽 높이(hc)와 가장 높은 줄을 재서, 줄이 쪽 창의 85% 보다 높아지는 창 높이를 고른다(쪽 창 높이는 창 높이와 같이 줄어든다)
    const lineFacts = await client.evaluate(`(function(){
      var pageL = document.querySelector('.at-page'), cs = getComputedStyle(pageL), tallest = 0;
      var hc = pageL.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      [window.__alphaTabApi, window.__alphaTabApiR].forEach(function(inst){ Array.prototype.forEach.call(inst.canvasElement.element.children, function(c){ tallest = Math.max(tallest, parseFloat(c.style.height) || 0); }); });
      return { hc: hc, tallest: tallest };
    })()`);
    assert.ok(lineFacts.tallest > 0 && lineFacts.tallest <= lineFacts.hc + 1, 'the roomy landscape window holds every piece before the height-only change: ' + JSON.stringify(lineFacts));
    const shortHeight = heightBefore - Math.ceil(lineFacts.hc - lineFacts.tallest * 0.85);
    assert.ok(widthNow > shortHeight, 'the height-only check keeps a landscape window');
    await setSize(widthNow, shortHeight);
    await waitForCondition(client, `${fitsSmall} && window.__alphaTabApi.settings.display.scale === window.__alphaTabApiR.settings.display.scale && window.__alphaTabApi.settings.display.scale < JSON.parse(localStorage.getItem(${JSON.stringify(PREFS_KEY)})).twoPageScale`, 25000);
    await sleep(500);
    assert.equal(await client.evaluate(fitsSmall), true, 'lowering only the window height still fits every piece inside the page window');
    const heightOnly = await readScales();
    assert.equal(heightOnly.l, heightOnly.r, 'both instances use the same scale after a height-only change');
    assert.ok(heightOnly.l < heightOnly.saved, 'a height-only change shrinks the scale below the saved two-page scale: ' + JSON.stringify(heightOnly));
    await checkFit('height-only window');
    process.stdout.write(`Two-page height-only fit ${widthNow}x${shortHeight}: scale ${heightOnly.l}\n`);
    await setSize(widthNow, heightBefore);
    await waitForCondition(client, `${fitsSmall} && window.__alphaTabApi.settings.display.scale === window.__alphaTabApiR.settings.display.scale && window.__alphaTabApi.settings.display.scale === JSON.parse(localStorage.getItem(${JSON.stringify(PREFS_KEY)})).twoPageScale`, 25000);
    await sleep(500);
    const restored = await readScales();
    assert.deepEqual([restored.l, restored.r], [restored.saved, restored.saved], 'raising only the window height brings both instances back to the saved two-page scale: ' + JSON.stringify(restored));
    assert.equal(await client.evaluate(fitsSmall), true, 'the restored height settles with every piece inside the page window');

    // 12. 작은 가로 화면: 줄이 쪽 창보다 높으면 배율을 줄여 다시 그린다
    await setSize(760, 340);
    await waitForCondition(client, fitsSmall, 25000);
    await sleep(500);
    assert.equal(await client.evaluate(fitsSmall), true, 'the small landscape window settles with every piece inside the page window');
    const small = await client.evaluate(`({ scaleL: window.__alphaTabApi.settings.display.scale, scaleR: window.__alphaTabApiR.settings.display.scale })`);
    assert.equal(small.scaleL, small.scaleR, 'both instances use the same scale in the small window');
    assert.ok(small.scaleL >= minScale - 1e-9, 'the scale stays at or above TWO_PAGE_MIN_SCALE: ' + small.scaleL);
    assert.ok(small.scaleL <= defaultScale + 1e-9, 'the small window never draws larger than the saved two-page scale: ' + small.scaleL);
    await checkFit('small window');
    process.stdout.write(`Two-page fit 760x340: scale ${small.scaleL}\n`);

    // 13. 단추를 다시 누르면 꺼진다
    await clickPagesButton();
    await waitForCondition(client, `document.body.getAttribute('data-at-layout') === 'one'`, 20000);
    facts = await state();
    assert.deepEqual([facts.pressed, JSON.parse(facts.stored).twoPage], ['false', false], 'the button turns two pages off and saves it');
    assert.equal(await client.evaluate(`document.getElementById('atZoom').hidden`), true, 'turning two pages off hides the zoom buttons');

    // 14. 끝값과 틀린 저장값
    const openWithScale = async value => {
      await setSize(1920, 960);
      await client.evaluate(`localStorage.setItem(${JSON.stringify(PREFS_KEY)}, ${JSON.stringify(JSON.stringify({ click: true, clickVol: 1, guitarVol: 1, twoPage: true, twoPageScale: value }))}); true`);
      await navigate(viewUrl, viewSettled, 45000);
      await waitForCondition(client, twoSettled, 20000);
      return client.evaluate(`({ text: document.getElementById('atZoomValue').textContent, outDisabled: document.getElementById('atZoomOutBtn').disabled, inDisabled: document.getElementById('atZoomInBtn').disabled, scale: window.__alphaTabApi.settings.display.scale })`);
    };
    let ends = await openWithScale(maxScale);
    assert.deepEqual([ends.inDisabled, ends.outDisabled, ends.text], [true, false, Math.round(maxScale * 100) + '%'], 'at the upper end only + is disabled: ' + JSON.stringify(ends));
    ends = await openWithScale(minScale);
    assert.deepEqual([ends.inDisabled, ends.outDisabled, ends.text], [false, true, Math.round(minScale * 100) + '%'], 'at the lower end only - is disabled: ' + JSON.stringify(ends));
    ends = await openWithScale(maxScale + 1);
    assert.deepEqual([ends.inDisabled, ends.text], [true, Math.round(maxScale * 100) + '%'], 'a saved scale above the range is cut to the upper end: ' + JSON.stringify(ends));
    ends = await openWithScale('x');
    assert.deepEqual([ends.inDisabled, ends.outDisabled, ends.text], [false, false, Math.round(defaultScale * 100) + '%'], 'a saved scale that is not a number reads as the default: ' + JSON.stringify(ends));
  } finally {
    await client.evaluate(`localStorage.removeItem(${JSON.stringify(PREFS_KEY)}); localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); true`).catch(() => {});
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'no console errors in the two-page view');
  process.stdout.write('Browser checkpoint: alphaTab two-page view (toggle, no clipping, page turns, cursor mirror, right click, portrait, small landscape fit) passed\n');
}

// 원본 alphaTex가 있는 곡(시트 6열): 보기 창이 그 alphaTex를 그대로 그리고, 앱에서 고치면 제자리 초안이 아니라 우리 악보 사본이 된다.
async function testAlphaTexSongs(client, httpPort) {
  const VIEW_KEY = 'gs.alphaTab.view';
  const HANDOFF_KEY = 'gs.tabInput.handoff';
  const practiceUrl = `http://127.0.0.1:${httpPort}/index.html`;
  const viewUrl = `http://127.0.0.1:${httpPort}/alphatab.html`;
  const practiceReady = 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null';
  const viewSettled = 'document.readyState === "complete" && ["ready","empty","error"].indexOf(document.body.getAttribute("data-at-state")) >= 0';
  const errorsBefore = client.consoleErrors.length;
  async function navigate(url, ready, timeoutMs) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, ready, timeoutMs || 8000);
  }
  const setKey = value => client.evaluate(`localStorage.setItem(${JSON.stringify(VIEW_KEY)}, ${JSON.stringify(JSON.stringify(value))}); true`);
  const viewState = () => client.evaluate(`({ state: document.body.getAttribute('data-at-state'), status: document.getElementById('atStatus').textContent, programs: document.getElementById('atHost').getAttribute('data-programs'),
    label: document.getElementById('atSource').textContent, labelHidden: document.getElementById('atSource').hidden, source: document.getElementById('atSource').getAttribute('data-source'),
    bars: document.getElementById('atHost').getAttribute('data-bars') })`);

  // 우리 악보와 눈에 띄게 다른 원본: 마디 3개(우리 악보는 2개)와 우리 악보에 없는 제목
  const plainLines = lines => lines.map(line => line.replace(/ \| ""$/, '')); // serializeScoreMeasures는 빈 메모를 | ""로 쓴다
  const FIXTURE_ID = 'sheet-song-alphatex-fixture';
  const FIXTURE_LINES = ['[C] C4 - - -', '[G] G3 - - -'];
  const FIXTURE_BADGE = 'Capo 2 시트 설명';
  const TEX = '\\title "Only In Tex" \\tempo 70 \\ts (4 4)\n0.1.4 0.2.4 0.3.4 0.4.4 |\n0.1.4 0.2.4 0.3.4 0.4.4 |\n0.1.1 |\n';
  const BROKEN_TEX = '\\title "Broken" \\tempo 70 \\ts (4 4)\n!!! nonsense\n';

  await navigate(practiceUrl, practiceReady);
  await client.evaluate(`localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); localStorage.removeItem(${JSON.stringify(HANDOFF_KEY)}); window.__opens = []; window.open = function(url){ window.__opens.push(String(url)); return {}; }; true`);
  const fixture = await client.evaluate(`(function(){
    var spec = buildStructuredSong({ id:${JSON.stringify(FIXTURE_ID)}, title:'Sheet fixture', badge:${JSON.stringify(FIXTURE_BADGE)}, builtin:false, bpm:70, beats:4, lines:${JSON.stringify(FIXTURE_LINES)} });
    spec.fromSheet = true;
    spec.alphaTex = ${JSON.stringify(TEX)};
    sheetSongs = [spec];
    rebuildSongSelect(spec.id);
    return { id:curSong.id, alphaTex:curSong.alphaTex, status:scoreDrafts.status(curSong.id), editTitle:document.getElementById('editInInputBtn').title };
  })()`);
  assert.equal(fixture.id, FIXTURE_ID, 'the sheet fixture song is the current song');
  assert.equal(fixture.alphaTex, TEX, 'the alphaTex survives the draft store and reaches the current song');
  assert.equal(fixture.editTitle, '악보 입력 화면에서 고치면 우리 악보 사본으로 저장됩니다', 'the edit button explains that an alphaTex song is saved as a copy');

  // 1. 단추: 원본이면 alphaTex와 설명을 넘긴다
  await client.evaluate(`document.getElementById('openAlphaTabBtn').click(); true`, { userGesture: true });
  const original = await client.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(VIEW_KEY)}))`);
  assert.equal(original.alphaTex, TEX, 'an unmodified alphaTex song hands the alphaTex over');
  assert.equal(original.description, FIXTURE_BADGE, 'the description is the song badge (the sheet description column)');
  assert.deepEqual(plainLines(original.lines), FIXTURE_LINES);

  // 2. 고친 초안은 alphaTex를 넘기지 않는다(앱은 alphaTex 곡에 초안을 만들지 않지만, 만들어졌다면 원본과 다르니 넘기지 않는다)
  const forcedDraft = await client.evaluate(`(function(){
    scoreDrafts.replaceScore(sheetSongs[0], ['[C] D4 - - -', '[G] G3 - - -'], {});
    rebuildSongSelect(${JSON.stringify(FIXTURE_ID)});
    var draft = scoreDrafts.status(curSong.id);
    document.getElementById('openAlphaTabBtn').click();
    var stored = JSON.parse(localStorage.getItem(${JSON.stringify(VIEW_KEY)}));
    scoreDrafts.reset(${JSON.stringify(FIXTURE_ID)});
    rebuildSongSelect(${JSON.stringify(FIXTURE_ID)});
    return { dirty:draft.dirty, hasAlphaTex:'alphaTex' in stored, lines:stored.lines, description:stored.description, restored:curSong.alphaTex, restoredDirty:scoreDrafts.status(curSong.id).dirty };
  })()`);
  assert.equal(forcedDraft.dirty, true, 'the forced edit is a draft');
  assert.equal(forcedDraft.hasAlphaTex, false, 'a modified draft does not hand the alphaTex over');
  assert.deepEqual(plainLines(forcedDraft.lines), ['[C] D4 - - -', '[G] G3 - - -'], 'the draft hands its current score lines');
  assert.equal(forcedDraft.description, FIXTURE_BADGE);
  assert.deepEqual([forcedDraft.restored, forcedDraft.restoredDirty], [TEX, false], 'reverting the draft brings the alphaTex song back');

  // 3. 입력 화면에서 고쳐 돌아오면 사본이 새로 생기고 선택된다. 원래 곡은 그대로다.
  const editedLines = ['[C] E4 - - -', '[G] G3 - - -'];
  // extra: 입력 화면이 넘기는 값을 덮어쓴다(기본은 원래 곡의 BPM·설명을 그대로 넘기는 경우). undefined 인 키는 넘긴 값에서 뺀다.
  function consumeHandoff(sourceId, lines, beats, extra) {
    const payload = Object.assign({ sourceId, title: 'not used', beats: beats || 4, bpm: 70, badge: FIXTURE_BADGE, lines, key: 0 }, extra || {});
    Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });
    return client.evaluate(`(function(){
      localStorage.setItem(${JSON.stringify(HANDOFF_KEY)}, JSON.stringify(Object.assign(${JSON.stringify(payload)}, { savedAt:Date.now() })));
      var id = scoreEditorHooks.consumeTabInputHandoff(BUILTIN_SONGS.concat(sheetSongs));
      rebuildSongSelect(id);
      var status = document.getElementById('storageStatus');
      var option = document.getElementById('songSelect').selectedOptions[0];
      var source = sheetSongs.find(function(song){ return song.id === ${JSON.stringify(FIXTURE_ID)}; });
      var draft = scoreDrafts.status(curSong.id);
      return { id:id, selected:document.getElementById('songSelect').value, curId:curSong.id, title:curSong.title, badge:curSong.badge, bpm:curSong.bpm, beats:curSong.beats, capo:GuitarParser.getSongCapo(curSong),
        hasAlphaTex:'alphaTex' in curSong, lines:serializeScoreMeasures(curSong.measures, '\\n').split('\\n'), group:option && option.parentElement ? option.parentElement.label : null,
        draft:{ dirty:draft.dirty, temporary:draft.temporary, origin:draft.origin }, statusText:status.textContent, statusShown:!status.hidden, handoffLeft:localStorage.getItem(${JSON.stringify(HANDOFF_KEY)}),
        sourceTitle:source && source.title, sourceAlphaTex:source && source.alphaTex, sourceLines:source ? serializeScoreMeasures(source.measures, '\\n').split('\\n') : null,
        sourceDraft:scoreDrafts.status(${JSON.stringify(FIXTURE_ID)}), sourceCapo:source ? GuitarParser.getSongCapo(source) : null };
    })()`);
  }
  const first = await consumeHandoff(FIXTURE_ID, editedLines);
  assert.notEqual(first.id, FIXTURE_ID, 'the edit does not open as the original song id');
  assert.equal(first.selected, first.id, 'the copy is selected in the song list');
  assert.equal(first.title, 'Sheet fixture (사본)', 'the copy title is "<original title> (사본)"');
  assert.equal(first.hasAlphaTex, false, 'the copy carries no alphaTex');
  assert.deepEqual(plainLines(first.lines), editedLines, 'the copy holds the edited score');
  assert.deepEqual([first.badge, first.bpm, first.beats, first.capo], [FIXTURE_BADGE, 70, 4, first.sourceCapo], 'description, BPM, cell count and capo are the ones handed over (here the same as the original song)');
  assert.equal(first.capo, 2);
  assert.equal(first.group, '임시 악보', 'the copy is saved the same way as a new score from the input screen');
  assert.deepEqual(first.draft, { dirty: false, temporary: true, origin: 'tab-input' });
  assert.equal(first.statusText, '원본이 alphaTex인 곡이라 고친 내용을 사본 「Sheet fixture (사본)」으로 저장했습니다.');
  assert.equal(first.statusShown, true);
  assert.equal(first.handoffLeft, null, 'the hand-off key is consumed');
  assert.equal(first.sourceTitle, 'Sheet fixture', 'the original keeps its title');
  assert.equal(first.sourceAlphaTex, TEX, 'the original keeps its alphaTex');
  assert.deepEqual(plainLines(first.sourceLines), FIXTURE_LINES, 'the original keeps its score lines');
  assert.deepEqual([first.sourceDraft.dirty, first.sourceDraft.temporary], [false, false], 'the original has no draft');

  // 4. 사본에서 alphaTab 단추 -> 우리 악보에서 만든 미리보기용 값(alphaTex 없음)
  await client.evaluate(`document.getElementById('storageStatus').hidden = true; document.getElementById('openAlphaTabBtn').click(); true`, { userGesture: true });
  const copyPayload = await client.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(VIEW_KEY)}))`);
  assert.equal('alphaTex' in copyPayload, false, 'a copy hands no alphaTex over');
  assert.equal(copyPayload.title, 'Sheet fixture (사본)');
  assert.deepEqual(plainLines(copyPayload.lines), editedLines);

  // 5. 같은 제목이 이미 있으면 번호를 붙인다
  const second = await consumeHandoff(FIXTURE_ID, ['[C] F4 - - -', '[G] G3 - - -']);
  assert.equal(second.title, 'Sheet fixture (사본 2)');
  assert.equal(second.statusText, '원본이 alphaTex인 곡이라 고친 내용을 사본 「Sheet fixture (사본 2)」으로 저장했습니다.');
  const third = await consumeHandoff(FIXTURE_ID, ['[C] G4 - - -', '[G] G3 - - -']);
  assert.equal(third.title, 'Sheet fixture (사본 3)');
  assert.notEqual(new Set([first.id, second.id, third.id]).size, 2, 'every copy is its own song');
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  assert.deepEqual([third.sourceAlphaTex, plainLines(third.sourceLines)], [TEX, FIXTURE_LINES], 'the original is still untouched after several copies');

  // 5-2. 칸 수를 바꿔 돌아와도 같은 사본 규칙이다(기존의 "새 임시 악보" 경로로 가지 않는다)
  const resized = await consumeHandoff(FIXTURE_ID, ['[C] C4 - -', '[G] G3 - -'], 3);
  assert.equal(resized.title, 'Sheet fixture (사본 4)', 'a cell-count change still makes a numbered copy of the original, not a copy of the hand-off title');
  assert.equal(resized.statusText, '원본이 alphaTex인 곡이라 고친 내용을 사본 「Sheet fixture (사본 4)」으로 저장했습니다.');
  assert.equal(resized.beats, 3, 'the copy has the edited cell count');
  assert.deepEqual(plainLines(resized.lines), ['[C] C4 - -', '[G] G3 - -']);
  assert.equal(resized.hasAlphaTex, false);
  assert.deepEqual([resized.badge, resized.capo, resized.group], [FIXTURE_BADGE, 2, '임시 악보']);
  assert.notEqual(resized.id, FIXTURE_ID);
  assert.equal(resized.selected, resized.id);
  assert.deepEqual([resized.sourceAlphaTex, plainLines(resized.sourceLines)], [TEX, FIXTURE_LINES], 'the original is untouched');

  // 5-3. 입력 화면에서 바꾼 카포(설명 글)·BPM·설명이 사본에 간다. 유효하지 않은 값만 원본 값으로 돌아간다
  const retuned = await consumeHandoff(FIXTURE_ID, editedLines, 4, { bpm: 88, badge: 'Capo 5 바꾼 설명' });
  assert.equal(retuned.title, 'Sheet fixture (사본 5)');
  assert.deepEqual([retuned.badge, retuned.bpm, retuned.capo], ['Capo 5 바꾼 설명', 88, 5], 'the copy takes the capo, BPM and description the input screen handed over');
  const cleared = await consumeHandoff(FIXTURE_ID, editedLines, 4, { bpm: 66, badge: '' });
  assert.deepEqual([cleared.badge, cleared.bpm, cleared.capo], ['임시 악보', 66, 0], 'an emptied description (capo removed) is not replaced by the original one (createFromScore labels an empty description 임시 악보, as for any new score)');
  const invalid = await consumeHandoff(FIXTURE_ID, editedLines, 4, { bpm: 'fast', badge: undefined });
  assert.deepEqual([invalid.badge, invalid.bpm, invalid.capo], [FIXTURE_BADGE, 70, 2], 'a handed-over value that is not a string or a number falls back to the original song');

  // 5-4. 고친 것이 없다고 표시한 채(unchanged:true) 돌아오면 사본 없이 원본 곡이 열린다
  const copiesBefore = await client.evaluate(`allSongs.filter(function(song){ return /\\(사본/.test(song.title); }).length`);
  await client.evaluate(`document.getElementById('storageStatus').hidden = true; document.getElementById('storageStatus').textContent = ''; true`);
  const untouched = await consumeHandoff(FIXTURE_ID, editedLines, 4, { unchanged: true });
  assert.equal(untouched.id, FIXTURE_ID, 'an unchanged hand-off opens the original song');
  assert.deepEqual([untouched.curId, untouched.selected], [FIXTURE_ID, FIXTURE_ID]);
  assert.equal(untouched.statusShown, false, 'no copy message for an unchanged hand-off');
  assert.equal(untouched.handoffLeft, null, 'the hand-off key is consumed');
  assert.equal(await client.evaluate(`allSongs.filter(function(song){ return /\\(사본/.test(song.title); }).length`), copiesBefore, 'no copy was made');
  assert.deepEqual([untouched.sourceDraft.dirty, untouched.sourceDraft.temporary, untouched.hasAlphaTex], [false, false, true], 'the original has no draft and keeps its alphaTex');
  // unchanged 가 true 가 아니면(문자열 등) 사본을 만든다
  const notReallyUnchanged = await consumeHandoff(FIXTURE_ID, editedLines, 4, { unchanged: 'true' });
  assert.notEqual(notReallyUnchanged.id, FIXTURE_ID, 'only unchanged === true skips the copy');

  // 6. alphaTex가 없는 곡은 지금처럼 제자리 수정 초안이다
  const butterfly = builtinSongsJson.find(item => item.id === 'builtin-lv1-butterfly');
  const butterflyLines = butterfly.lines.slice();
  butterflyLines[0] = butterflyLines[0] === '[C] C4 - - -' ? '[C] D4 - - -' : '[C] C4 - - -';
  const inPlace = await client.evaluate(`(function(){
    localStorage.setItem(${JSON.stringify(HANDOFF_KEY)}, JSON.stringify({ sourceId:'builtin-lv1-butterfly', title:'not used', beats:${butterfly.beats}, bpm:${butterfly.bpm}, badge:'', lines:${JSON.stringify(butterflyLines)}, key:0, savedAt:Date.now() }));
    document.getElementById('storageStatus').hidden = true;
    var id = scoreEditorHooks.consumeTabInputHandoff(BUILTIN_SONGS.concat(sheetSongs));
    rebuildSongSelect(id);
    var draft = scoreDrafts.status(curSong.id);
    return { id:id, title:curSong.title, draft:{ dirty:draft.dirty, temporary:draft.temporary, origin:draft.origin }, editTitle:document.getElementById('editInInputBtn').title,
      storageHidden:document.getElementById('storageStatus').hidden, copies:allSongs.filter(function(song){ return /\\(사본/.test(song.title) && song.title.indexOf(${JSON.stringify(butterfly.title)}) === 0; }).length };
  })()`);
  assert.equal(inPlace.id, 'builtin-lv1-butterfly', 'a song without alphaTex is still edited in place');
  assert.equal(inPlace.title, butterfly.title);
  assert.deepEqual(inPlace.draft, { dirty: true, temporary: false, origin: 'tab-input' });
  assert.equal(inPlace.copies, 0, 'no copy is made');
  assert.equal(inPlace.storageHidden, true, 'no copy message for an in-place draft');
  assert.equal(inPlace.editTitle, '악보 입력 화면에서 이 곡을 고칩니다', 'the edit button keeps its normal title');
  await client.evaluate(`scoreDrafts.reset('builtin-lv1-butterfly'); true`);

  // 6-2. 실제 입력 화면: 곡을 불러온 직후와 내보낸 결과가 같으면 handoff에 unchanged 를 달고, 카포·BPM·악보를 바꾸면 달지 않는다
  const inputUrl = `http://127.0.0.1:${httpPort}/score-input.html`;
  const inputReady = 'document.readyState === "complete" && document.querySelectorAll("#tiMeasures .ti-measure").length >= 1';
  async function inputRoundTrip(change) {
    await navigate(practiceUrl, practiceReady);
    await client.evaluate(`(function(){
      Object.keys(localStorage).filter(function(key){ return key.indexOf('gs.tabInput.') === 0; }).forEach(function(key){ localStorage.removeItem(key); });
      sessionStorage.removeItem('capturedHandoff');
      localStorage.setItem('gs.tabInput.open', JSON.stringify({ sourceId:${JSON.stringify(FIXTURE_ID)}, title:'Sheet fixture', beats:4, bpm:70, badge:${JSON.stringify(FIXTURE_BADGE)}, lines:${JSON.stringify(FIXTURE_LINES)}, key:0, measure:0, savedAt:Date.now() }));
      return true;
    })()`);
    await navigate(inputUrl, inputReady);
    await client.evaluate(`(function(){
      var original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value){ if (key === ${JSON.stringify(HANDOFF_KEY)}) sessionStorage.setItem('capturedHandoff', value); return original.apply(this, arguments); };
      ${change || ''}
      return true;
    })()`);
    const loadsBefore = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.evaluate(`document.getElementById('tiOpenPracticeBtn').click(); true`, { userGesture: true });
    await waitForPageLoadAfter(client, loadsBefore);
    await waitForCondition(client, practiceReady, 8000);
    return client.evaluate(`JSON.parse(sessionStorage.getItem('capturedHandoff'))`);
  }
  const untouchedHandoff = await inputRoundTrip('');
  assert.equal(untouchedHandoff.sourceId, FIXTURE_ID, 'the input screen hands over the source song id');
  assert.equal(untouchedHandoff.unchanged, true, 'nothing edited on the input screen -> unchanged');
  const capoHandoff = await inputRoundTrip(`var select = document.getElementById('tiCapoSelect'); select.value = '4'; select.dispatchEvent(new Event('change', { bubbles:true }));`);
  assert.equal('unchanged' in capoHandoff, false, 'a changed capo is not unchanged');
  assert.equal(capoHandoff.badge.startsWith('Capo 4'), true, 'the capo goes into the description: ' + capoHandoff.badge);
  const bpmHandoff = await inputRoundTrip(`var bpm = document.getElementById('tiBpm'); bpm.value = '90'; bpm.dispatchEvent(new Event('input', { bubbles:true })); bpm.dispatchEvent(new Event('change', { bubbles:true }));`);
  assert.equal('unchanged' in bpmHandoff, false, 'a changed BPM is not unchanged');
  assert.equal(bpmHandoff.bpm, 90);
  const noteHandoff = await inputRoundTrip(`document.querySelector('.ti-slot[data-m="0"][data-c="1"][data-s="0"] .ti-pos[data-str="1"]').click(); document.querySelector('.ti-fret[data-str="1"][data-fret="3"]').click();`);
  assert.equal('unchanged' in noteHandoff, false, 'an edited note is not unchanged');

  // 7. 보기 창: 원본 alphaTex는 변환 없이 그대로 읽는다(마디 3개, 우리 악보는 2개)
  await setKey(original);
  await navigate(viewUrl, viewSettled, 45000);
  let view = await viewState();
  assert.equal(view.state, 'ready', 'the original alphaTex rendered: ' + JSON.stringify(view));
  assert.equal(view.label, '원본 alphaTex');
  assert.equal(view.source, 'original');
  assert.equal(view.labelHidden, false);
  assert.equal(view.bars, '3', 'the view drew the alphaTex itself (3 bars), not the 2-bar score of the song');
  assert.equal(view.status, '', 'no status line text when everything went well');
  assert.equal(view.programs, '24', 'the original alphaTex plays as the nylon guitar (GM program 24)');

  // 8. 사본(alphaTex 없음)은 우리 악보에서 만든 미리보기
  await setKey(copyPayload);
  await navigate(viewUrl, viewSettled, 45000);
  view = await viewState();
  assert.equal(view.state, 'ready');
  assert.equal(view.label, '우리 악보에서 만든 미리보기');
  assert.equal(view.source, 'converted');
  assert.equal(view.bars, String(editedLines.length));
  assert.equal(view.programs, '24', 'the converted preview plays as the nylon guitar (GM program 24)');

  // 9. 원본이 alphaTab 오류면 상태 줄에 알리고 변환 미리보기로 대신 그린다
  await setKey(Object.assign({}, original, { alphaTex: BROKEN_TEX }));
  await navigate(viewUrl, viewSettled, 45000);
  view = await viewState();
  assert.equal(view.state, 'ready', 'the fallback preview rendered');
  assert.equal(view.label, '우리 악보에서 만든 미리보기');
  assert.equal(view.bars, String(FIXTURE_LINES.length));
  assert.match(view.status, /^원본 alphaTex를 alphaTab이 읽지 못해 우리 악보에서 만든 미리보기로 대신 그렸습니다/, 'the status line says why the preview was drawn instead');

  await client.evaluate(`localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); true`);
  await navigate(practiceUrl, practiceReady);
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'no console errors for alphaTex songs');
  process.stdout.write('Browser checkpoint: alphaTex songs (original alphaTex drawn as is, copy instead of draft, numbered copies, in-place draft without alphaTex, fallback preview) passed\n');
}

// 연습 화면 합성음과 alphaTab 보기 창의 실제 출력 크기를 같은 곡으로 재서 견준다.
// 출력 쪽 AudioDestinationNode 로 가는 연결을 가로채(탭) 두 채널의 모든 표본을 센다. 크기는 400ms 블록(표본 수)의 평균 제곱을 -60 dBFS 문턱으로 거른 RMS 와 표본 최대값이다.
// 재생을 시작하고 첫 문턱 위 블록부터 오디오 표본 시간으로 LOUDNESS_WINDOW_SECONDS 초를 모은다(벽시계로 재지 않는다).
const LOUDNESS_WINDOW_SECONDS = 8;
const LOUDNESS_TAP_SOURCE = `(function(){
  if (window.__loudnessTap) return;
  var BLOCK_SECONDS = 0.4, WINDOW_SECONDS = ${LOUDNESS_WINDOW_SECONDS}, GATE_DB = -60;
  var originalConnect = AudioNode.prototype.connect;
  var originalDisconnect = AudioNode.prototype.disconnect;
  var tapOf = new WeakMap();
  var tap = { contexts: [], active: false, reset: function(){ tap.active = true; tap.contexts.forEach(function(state){ state.reset(); }); } };
  window.__loudnessTap = tap;
  function createState(ctx){
    var state = { rate: ctx.sampleRate, blockLen: Math.round(BLOCK_SECONDS * ctx.sampleRate), windowBlocks: Math.round(WINDOW_SECONDS / BLOCK_SECONDS) };
    state.reset = function(){
      state.fill = 0; state.sum = 0; state.blockPeak = 0; state.started = false; state.blocks = 0; state.gated = 0; state.gatedSum = 0; state.peak = 0; state.done = false; state.levels = [];
    };
    state.reset();
    var gain = ctx.createGain();
    var processor = ctx.createScriptProcessor(4096, 2, 2);
    var zero = ctx.createGain();
    zero.gain.value = 0;
    originalConnect.call(gain, ctx.destination);
    originalConnect.call(gain, processor);
    originalConnect.call(processor, zero);
    originalConnect.call(zero, ctx.destination);
    processor.onaudioprocess = function(event){
      if (!tap.active || state.done) return;
      var input = event.inputBuffer, channels = [];
      for (var c = 0; c < input.numberOfChannels && c < 2; c++) channels.push(input.getChannelData(c));
      var length = input.length;
      for (var i = 0; i < length && !state.done; i++){
        for (var k = 0; k < channels.length; k++){
          var v = channels[k][i];
          state.sum += v * v;
          var a = v < 0 ? -v : v;
          if (a > state.blockPeak) state.blockPeak = a;
        }
        if (++state.fill === state.blockLen){
          var meanSquare = state.sum / (2 * state.blockLen);
          var db = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -Infinity;
          if (!state.started && db > GATE_DB) state.started = true;
          if (state.started){
            state.blocks++;
            state.levels.push(db);
            if (state.blockPeak > state.peak) state.peak = state.blockPeak;
            if (db > GATE_DB){ state.gated++; state.gatedSum += meanSquare; }
            if (state.blocks >= state.windowBlocks) state.done = true;
          }
          state.fill = 0; state.sum = 0; state.blockPeak = 0;
        }
      }
    };
    state.gain = gain;
    tap.contexts.push(state);
    return state;
  }
  function stateFor(dest){
    var ctx = dest.context;
    if (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext) return null;
    var state = tapOf.get(ctx);
    if (!state){ state = createState(ctx); tapOf.set(ctx, state); }
    return state;
  }
  AudioNode.prototype.connect = function(dest){
    if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode){
      var state = stateFor(dest);
      if (state){
        var args = Array.prototype.slice.call(arguments);
        args[0] = state.gain;
        originalConnect.apply(this, args);
        return dest;
      }
    }
    return originalConnect.apply(this, arguments);
  };
  AudioNode.prototype.disconnect = function(dest){
    if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode){
      var state = stateFor(dest);
      if (state){
        var args = Array.prototype.slice.call(arguments);
        args[0] = state.gain;
        return originalDisconnect.apply(this, args);
      }
    }
    return originalDisconnect.apply(this, arguments);
  };
  tap.result = function(){
    var best = null;
    tap.contexts.forEach(function(state){ if (!best || state.blocks > best.blocks) best = state; });
    if (!best) return { contexts: 0 };
    return { contexts: tap.contexts.length, rate: best.rate, done: best.done, started: best.started, blocks: best.blocks, gated: best.gated,
      rmsDb: best.gated ? 10 * Math.log10(best.gatedSum / best.gated) : -Infinity, peak: best.peak, levels: best.levels };
  };
})();`;

// 재는 구간 안에서 한 번에 치는 음이 가장 많은 내장곡(같으면 그 구간의 음 수가 많은 곡). 최대 음량 검사가 카탈로그에서 가장 센 경우를 재도록 songs.json 에서 고른다.
function densestOpeningSongId() {
  const parser = require(path.join(root, 'src', 'parser.js'));
  const rhythm = require(path.join(root, 'src', 'rhythm.js'));
  let best = null;
  builtinSongsJson.forEach(song => {
    const measures = parser.parseScore(song.lines, song.beats).measures;
    const limit = LOUDNESS_WINDOW_SECONDS * Number(song.bpm) / 60 * rhythm.UNITS_PER_SLOT;
    let chord = 0, notes = 0;
    rhythm.annotate(measures, song.beats).events.forEach(event => {
      if (event.startUnits >= limit) return;
      const count = (event.part.chordNotes && event.part.chordNotes.length) || 1;
      chord = Math.max(chord, count);
      notes += count;
    });
    if (!best || chord > best.chord || (chord === best.chord && notes > best.notes)) best = { id: song.id, chord, notes };
  });
  return best.id;
}

async function testPlaybackLoudness(client, httpPort) {
  const SONG_IDS = ['builtin-lv1-butterfly', densestOpeningSongId()]; // 가장 성긴 한 줄 선율 곡과 재는 구간에 동시음이 가장 많은 곡
  const VIEW_KEY = 'gs.alphaTab.view';
  const PREFS_KEY = 'gs.alphaTab.prefs';
  const CLICK_SONG_ID = 'builtin-lv1-butterfly'; // 한 칸 = 4분음표(4/4)라 연습 화면과 alphaTab 의 클릭 수가 같다
  const TOLERANCE_DB = 3;
  const practiceUrl = `http://127.0.0.1:${httpPort}/index.html`;
  const viewUrl = `http://127.0.0.1:${httpPort}/alphatab.html`;
  const practiceReady = 'document.readyState === "complete" && window.allSongs && window.allSongs.length >= ' + builtinSongCount + ' && window.curSong != null';
  const viewSettled = 'document.readyState === "complete" && ["ready","empty","error"].indexOf(document.body.getAttribute("data-at-state")) >= 0';
  const errorsBefore = client.consoleErrors.length;
  const viewSource = fs.readFileSync(path.join(root, 'src', 'alphatab-view.js'), 'utf8');
  const volumeMatch = viewSource.match(/var PLAYBACK_MASTER_VOLUME = ([0-9.]+);/);
  async function navigate(url, ready, timeoutMs) {
    const before = client.events.filter(event => event.method === 'Page.loadEventFired').length;
    await client.send('Page.navigate', { url });
    await waitForPageLoadAfter(client, before);
    await waitForCondition(client, ready, timeoutMs || 8000);
  }
  const tapScript = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: LOUDNESS_TAP_SOURCE });
  const measurements = [];
  let clickMeasurement = null, maxMeasurement = null;
  try {
    for (const songId of SONG_IDS) {
      const song = builtinSongsJson.find(item => item.id === songId);
      assert.ok(song, songId + ' exists in songs.json');

      // 연습 화면: 기본 음색(KS, 어쿠스틱 효과 켬, 연주음 100%), 클릭·카운트인 없음, 1마디 첫 칸부터 BPM 은 곡의 값
      await navigate(practiceUrl, practiceReady);
      const appSide = await client.evaluate(`(async function(){
        var savedSongId = curSong.id;
        var saved = { synthEngine:appState.synthEngine, acousticFx:appState.acousticFx, guitarVol:appState.guitarVol, clickMode:appState.clickMode, loopStart:appState.loopStart, loopEnd:appState.loopEnd };
        window.open = function(){ return {}; };
        changeSongById(${JSON.stringify(songId)});
        appState.synthEngine = 'ks'; appState.acousticFx = true; appState.guitarVol = 1; appState.clickMode = 'off';
        ensureAudioCtx();
        if (actx.state !== 'running') await actx.resume();
        updateGuitarVolume();
        appState.loopStart = 1; appState.loopEnd = getMeasureCount(curSong);
        curMeasureIdx = 0; curBeatIdx = 0;
        document.getElementById('openAlphaTabBtn').click();
        localStorage.setItem(${JSON.stringify(PREFS_KEY)}, JSON.stringify({ click: false, clickVol: 1, guitarVol: 1 }));
        var view = JSON.parse(localStorage.getItem(${JSON.stringify(VIEW_KEY)}));
        var bpm = appState.bpm;
        window.__loudnessTap.reset();
        startPractice();
        return { saved: saved, savedSongId: savedSongId, bpm: bpm, handoffBpm: view && view.bpm, playing: isPlaying, ctxState: actx.state };
      })()`, { userGesture: true });
      assert.equal(appSide.playing, true, songId + ': the practice screen started playing');
      assert.equal(appSide.bpm, Number(song.bpm), songId + ': the practice screen plays at the song BPM');
      await waitForCondition(client, `window.__loudnessTap.result().done === true`, 40000);
      const app = await client.evaluate(`window.__loudnessTap.result()`);
      await client.evaluate(`(function(){
        stopPractice();
        var saved = ${JSON.stringify(appSide.saved)};
        changeSongById(${JSON.stringify(appSide.savedSongId)});
        Object.keys(saved).forEach(function(key){ appState[key] = saved[key]; });
        updateGuitarVolume(); saveAppState(); return true;
      })()`);
      assert.ok(app.contexts >= 1, songId + ': the tap caught the practice screen output context');
      assert.ok(app.started && Number.isFinite(app.rmsDb), songId + ': the practice screen produced sound above the silence gate: ' + JSON.stringify({ contexts: app.contexts, blocks: app.blocks, gated: app.gated }));

      // alphaTab 보기 창: 연습 화면 단추가 넘긴 값 그대로 열고 재생(처음 재생이 사운드폰트를 불러온다)
      await navigate(viewUrl, viewSettled, 45000);
      assert.equal((await client.evaluate(`document.body.getAttribute('data-at-state')`)), 'ready', songId + ': the alphaTab view is ready');
      const viewSide = await client.evaluate(`(function(){
        window.__loudnessTap.reset();
        document.getElementById('atPlayBtn').click();
        return { masterVolume: window.__alphaTabApi.masterVolume };
      })()`, { userGesture: true });
      await waitForCondition(client, `window.__loudnessTap.result().done === true`, 120000);
      const alpha = await client.evaluate(`window.__loudnessTap.result()`);
      const afterRead = await client.evaluate(`window.__alphaTabApi.masterVolume`);
      await client.evaluate(`document.getElementById('atPlayBtn').click(); true`, { userGesture: true });
      await waitForCondition(client, `document.getElementById('atPlayBtn').textContent === '재생'`, 8000);
      assert.ok(alpha.contexts >= 1, songId + ': the tap caught the alphaTab output context (worklet output goes through AudioContext.destination)');
      assert.ok(alpha.started && Number.isFinite(alpha.rmsDb), songId + ': alphaTab produced sound above the silence gate: ' + JSON.stringify({ contexts: alpha.contexts, blocks: alpha.blocks, gated: alpha.gated }));
      measurements.push({ id: songId, app, alpha, masterVolume: viewSide.masterVolume, masterVolumeAfter: afterRead });
    }
    // 메트로놈 클릭: 기타 소리 없이 클릭만 재서 같은 곡의 두 플레이어를 견준다(METRONOME_BASE_VOLUME 이 맞추는 값)
    const clickSong = builtinSongsJson.find(item => item.id === CLICK_SONG_ID);
    await navigate(practiceUrl, practiceReady);
    const clickAppSide = await client.evaluate(`(async function(){
      var savedSongId = curSong.id;
      var saved = { synthEngine:appState.synthEngine, acousticFx:appState.acousticFx, guitarVol:appState.guitarVol, vol:appState.vol, clickMode:appState.clickMode, loopStart:appState.loopStart, loopEnd:appState.loopEnd };
      window.open = function(){ return {}; };
      changeSongById(${JSON.stringify(CLICK_SONG_ID)});
      appState.synthEngine = 'ks'; appState.acousticFx = true; appState.guitarVol = 0; appState.vol = 1; appState.clickMode = 'all';
      ensureAudioCtx();
      if (actx.state !== 'running') await actx.resume();
      updateGuitarVolume();
      appState.loopStart = 1; appState.loopEnd = getMeasureCount(curSong);
      curMeasureIdx = 0; curBeatIdx = 0;
      document.getElementById('openAlphaTabBtn').click();
      localStorage.setItem(${JSON.stringify(PREFS_KEY)}, JSON.stringify({ click: true, clickVol: 1, guitarVol: 0 }));
      window.__loudnessTap.reset();
      startPractice();
      return { saved: saved, savedSongId: savedSongId, playing: isPlaying };
    })()`, { userGesture: true });
    assert.equal(clickAppSide.playing, true, 'click: the practice screen started playing');
    await waitForCondition(client, `window.__loudnessTap.result().done === true`, 40000);
    const clickApp = await client.evaluate(`window.__loudnessTap.result()`);
    await client.evaluate(`(function(){
      stopPractice();
      var saved = ${JSON.stringify(clickAppSide.saved)};
      changeSongById(${JSON.stringify(clickAppSide.savedSongId)});
      Object.keys(saved).forEach(function(key){ appState[key] = saved[key]; });
      updateGuitarVolume(); saveAppState(); return true;
    })()`);
    assert.ok(clickApp.started && Number.isFinite(clickApp.rmsDb), 'click: the practice screen click is above the silence gate');
    async function playView(label) {
      await navigate(viewUrl, viewSettled, 45000);
      assert.equal((await client.evaluate(`document.body.getAttribute('data-at-state')`)), 'ready', label + ': the alphaTab view is ready');
      await client.evaluate(`window.__loudnessTap.reset(); document.getElementById('atPlayBtn').click(); true`, { userGesture: true });
      await waitForCondition(client, `window.__loudnessTap.result().done === true`, 120000);
      const result = await client.evaluate(`window.__loudnessTap.result()`);
      await client.evaluate(`document.getElementById('atPlayBtn').click(); true`, { userGesture: true });
      await waitForCondition(client, `document.getElementById('atPlayBtn').textContent === '재생'`, 8000);
      assert.ok(result.started && Number.isFinite(result.rmsDb), label + ': alphaTab produced sound above the silence gate');
      return result;
    }
    const clickAlpha = await playView('click');
    clickMeasurement = { id: CLICK_SONG_ID, app: clickApp, alpha: clickAlpha };

    // 보기 창 최대 설정(클릭음 200%, 연주음 100%)에서 가장 빽빽한 곡의 표본 최대값
    const PEAK_SONG_ID = SONG_IDS[1];
    const peakSong = builtinSongsJson.find(item => item.id === PEAK_SONG_ID);
    await navigate(practiceUrl, practiceReady);
    await client.evaluate(`localStorage.setItem(${JSON.stringify(VIEW_KEY)}, ${JSON.stringify(JSON.stringify({ title: peakSong.title, beats: peakSong.beats, bpm: Number(peakSong.bpm), capo: 0, lines: peakSong.lines, savedAt: Date.now() }))}); localStorage.setItem(${JSON.stringify(PREFS_KEY)}, JSON.stringify({ click: true, clickVol: 2, guitarVol: 1 })); true`);
    const peakAlpha = await playView('max');
    maxMeasurement = { id: PEAK_SONG_ID, alpha: peakAlpha };
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: tapScript.identifier });
  }
  await navigate(practiceUrl, practiceReady);
  await client.evaluate(`localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); localStorage.removeItem(${JSON.stringify(PREFS_KEY)}); true`);

  measurements.forEach(item => {
    const diff = item.app.rmsDb - item.alpha.rmsDb;
    process.stdout.write('Loudness ' + item.id + ': app ' + item.app.rmsDb.toFixed(1) + ' dBFS, alphaTab ' + item.alpha.rmsDb.toFixed(1) + ' dBFS (diff ' + diff.toFixed(1) + ' dB, alphaTab peak ' + item.alpha.peak.toFixed(3) + ')\n');
  });
  {
    const clickDiff = clickMeasurement.app.rmsDb - clickMeasurement.alpha.rmsDb;
    process.stdout.write('Loudness click ' + clickMeasurement.id + ': app ' + clickMeasurement.app.rmsDb.toFixed(1) + ' dBFS, alphaTab ' + clickMeasurement.alpha.rmsDb.toFixed(1) + ' dBFS (diff ' + clickDiff.toFixed(1) + ' dB, alphaTab peak ' + clickMeasurement.alpha.peak.toFixed(3) + ')\n');
    process.stdout.write('Loudness max (click 200%, guitar 100%) ' + maxMeasurement.id + ': alphaTab peak ' + maxMeasurement.alpha.peak.toFixed(3) + ', ' + maxMeasurement.alpha.rmsDb.toFixed(1) + ' dBFS\n');
    assert.ok(Math.abs(clickDiff) <= TOLERANCE_DB, 'the practice screen click and the alphaTab click (METRONOME_BASE_VOLUME) play within ' + TOLERANCE_DB + ' dB of each other (diff ' + clickDiff.toFixed(1) + ' dB)');
    assert.ok(maxMeasurement.alpha.peak < 1, 'the alphaTab output does not clip at click volume 200% and guitar volume 100% (peak ' + maxMeasurement.alpha.peak.toFixed(3) + ')');
  }
  process.stdout.write('Loudness alphaTab masterVolume read back: ' + measurements.map(item => item.masterVolume + '/' + item.masterVolumeAfter).join(' ; ') + '\n');
  if (volumeMatch) {
    const expected = Number(volumeMatch[1]);
    measurements.forEach(item => {
      assert.ok(Math.abs(item.masterVolume - expected) < 1e-6 && Math.abs(item.masterVolumeAfter - expected) < 1e-6, item.id + ': api.masterVolume is PLAYBACK_MASTER_VOLUME (' + item.masterVolume + ' / ' + item.masterVolumeAfter + ' vs ' + expected + ')');
    });
  }
  measurements.forEach(item => {
    const diff = item.app.rmsDb - item.alpha.rmsDb;
    assert.ok(Math.abs(diff) <= TOLERANCE_DB, item.id + ': the practice screen and the alphaTab view play within ' + TOLERANCE_DB + ' dB of each other (diff ' + diff.toFixed(1) + ' dB)');
    assert.ok(item.alpha.peak < 1, item.id + ': the alphaTab output does not clip (peak ' + item.alpha.peak.toFixed(3) + ')');
  });
  assert.deepEqual(client.consoleErrors.slice(errorsBefore), [], 'no console errors while measuring playback loudness');
  process.stdout.write('Browser checkpoint: playback loudness (practice screen vs alphaTab view, gated RMS over 400ms blocks, ' + LOUDNESS_WINDOW_SECONDS + ' seconds, two built-in songs) passed\n');
}


async function main() {
  await runBrowserSuite(async ({ cdp, httpPort, servedPaths }) => {
    await testAlphaTabView(cdp, httpPort, servedPaths);
    await testAlphaTabScroll(cdp, httpPort);
    await testAlphaTabControls(cdp, httpPort);
    await testAlphaTabTwoPage(cdp, httpPort);
    await testAlphaTexSongs(cdp, httpPort);
    await testPlaybackLoudness(cdp, httpPort);
    process.stdout.write('Result: browser alphaTab suite passed (0 console errors)\n');
  });
}

main().catch(err => {
  console.error('Browser alphaTab test failed:', err);
  process.exitCode = 1;
});
