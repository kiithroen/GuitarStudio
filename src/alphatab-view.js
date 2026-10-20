(function(){
  'use strict';
  // alphaTab 보기 창(alphatab.html). 연습 화면이 localStorage에 넣은 곡을 alphaTex로 바꿔 alphaTab 플레이어로 띄운다. 규칙과 결정은 Docs/alphatab.md.
  var STORAGE_KEY = 'gs.alphaTab.view';
  var ASSET_ROOT = 'vendor/alphatab/dist/';
  var SOUND_FONT_URL = 'vendor/musescore-general/MuseScore_General.sf3'; // 약 38MB라 창을 열 때가 아니라 처음 재생할 때 불러온다
  var SOUND_LOADING_TEXT = '소리를 불러오는 중입니다(약 38MB, 처음 한 번만)';
  var SOUND_FAILED_TEXT = '소리를 불러오지 못했습니다. 네트워크를 확인하세요.';
  var PLAYBACK_PROGRAM = 24; // General MIDI Acoustic Guitar (nylon). 악보에 적힌 악기와 상관없이 모든 트랙을 이 소리로 재생한다
  var BPM_RATIO_MIN = 0.25; // BPM 슬라이더 범위: 곡 BPM 의 이 배수(올림)부터
  var BPM_RATIO_MAX = 1.5; // 이 배수(내림)까지
  var PREFS_KEY = 'gs.alphaTab.prefs'; // 보기 창만의 소리 설정. 연습 화면의 gs.state 는 읽지도 쓰지도 않는다
  var CLICK_VOLUME_MAX = 2; // 클릭음 슬라이더 최대(200%). 연습 화면과 같다
  var GUITAR_VOLUME_MAX = 1; // 연주음 슬라이더 최대(100%)
  var SCROLL_MARGIN = 8; // 자동 스크롤 때 지금 줄의 맨 위와 머리 막대 아랫단 사이 여유(px)
  var NARROW_SCALE = 0.7; // 폰 폭(500px 미만)에서는 악보 제목 줄까지 한 화면에 들어오게 줄여 그린다
  var METRONOME_BASE_VOLUME = 0.47; // 클릭음 100% 일 때 alphaTab 클릭 음량(배율). 연습 화면 클릭과 같은 크기로 잰 값. 근거는 Docs/alphatab.md
  var PLAYBACK_MASTER_VOLUME = 5.61; // 연습 화면 합성음과 비슷한 크기로 맞추되 가장 빽빽한 내장곡이 1.0을 넘지 않게 낮춘 alphaTab 마스터 음량(배율). 근거는 Docs/alphatab.md

  function byId(id){ return document.getElementById(id); }
  var els = {
    title: byId('atTitle'), play: byId('atPlayBtn'), rewind: byId('atRewindBtn'),
    bpm: byId('atBpmRange'), bpmValue: byId('atBpmValue'), view: byId('atViewSelect'), status: byId('atStatus'), host: byId('atHost'), source: byId('atSource'),
    click: byId('atClickToggle'), clickVol: byId('atClickVolRange'), guitarVol: byId('atGuitarVolRange')
  };

  // state: loading(불러오는 중) | ready | empty(넘긴 곡 없음) | error
  function setStatus(text, state){
    els.status.textContent = text;
    els.status.setAttribute('data-state', state || 'loading');
    document.body.setAttribute('data-at-state', state || 'loading');
  }

  var SOURCE_LABEL = { original: '원본 alphaTex', converted: '우리 악보에서 만든 미리보기' };

  // 악보 출처 꼬리표: original(시트의 원본 alphaTex를 그대로 읽음) | converted(우리 악보를 변환한 미리보기)
  function setSource(kind){
    els.source.textContent = SOURCE_LABEL[kind];
    els.source.setAttribute('data-source', kind);
    els.source.hidden = false;
    els.host.setAttribute('data-source', kind);
  }

  function readSong(){
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e){ raw = null; }
    if (!raw) return null;
    var song = null;
    try { song = JSON.parse(raw); } catch (e){ return null; }
    if (!song || typeof song !== 'object') return null;
    if (typeof song.title !== 'string' || !Array.isArray(song.lines) || !song.lines.every(function(line){ return typeof line === 'string'; })) return null;
    if (!Number.isInteger(song.beats) || !isFinite(Number(song.bpm))) return null;
    return {
      title: song.title, beats: song.beats, bpm: Number(song.bpm), capo: Number.isInteger(song.capo) ? song.capo : 0, lines: song.lines,
      description: typeof song.description === 'string' ? song.description : '',
      alphaTex: typeof song.alphaTex === 'string' && song.alphaTex.trim() ? song.alphaTex : '',
      practiceBpm: typeof song.practiceBpm === 'number' && isFinite(song.practiceBpm) ? song.practiceBpm : null // 연습 화면이 열 때 쓰던 BPM. 옛 넘기기 값에는 없다
    };
  }

  // 보기 창만의 소리 설정. 범위·형식이 틀린 값은 기본값(normalizeVolume 은 src/app-state.js)
  function readPrefs(){
    var raw = ls.get(PREFS_KEY, null);
    if (!raw || typeof raw !== 'object') raw = {};
    return {
      click: typeof raw.click === 'boolean' ? raw.click : true,
      clickVol: normalizeVolume(raw.clickVol, 1, CLICK_VOLUME_MAX),
      guitarVol: normalizeVolume(raw.guitarVol, 1, GUITAR_VOLUME_MAX)
    };
  }

  // BPM 슬라이더: 연습 화면과 같은 단위(분당 칸 수). 범위는 곡 BPM(base)의 비율이고 재생 속도는 value / base 로 준다.
  function bpmRange(base){
    var min = Math.max(1, Math.ceil(base * BPM_RATIO_MIN));
    var max = Math.max(min, Math.floor(base * BPM_RATIO_MAX));
    return { min: min, max: max };
  }
  function bpmStart(base, practiceBpm){
    var range = bpmRange(base);
    if (practiceBpm !== null && practiceBpm >= range.min && practiceBpm <= range.max) return Math.round(practiceBpm);
    return Math.max(range.min, Math.min(range.max, Math.round(base)));
  }

  // 재생 자동 스크롤: 줄이 바뀔 때 다음 줄이 화면 아래에 다 보이지 않거나 지금 줄이 머리 막대에 가릴 때만 지금 줄을 머리 막대 바로 아래로 올린다.
  // onBeatCursorUpdating 은 줄(staffSystem)이 바뀔 때만 판정하고 forceScrollTo 는 늘 판정한다. 넘어오는 startBeat 는 BeatBounds 다.
  function createScrollHandler(api, head){
    var lastSystem = -1;
    function judge(beatBounds, force){
      var system = beatBounds && beatBounds.barBounds && beatBounds.barBounds.masterBarBounds && beatBounds.barBounds.masterBarBounds.staffSystemBounds;
      if (!system) return;
      if (!force && system.index === lastSystem) return;
      lastSystem = system.index;
      var ui = api.uiFacade;
      var scroll = ui.getScrollContainer();
      var systems = system.boundsLookup ? system.boundsLookup.staffSystems : [];
      var next = systems[system.index + 1] || system;
      var origin = ui.getOffset(scroll, api.canvasElement).y; // 좌표 기준은 컨테이너(패딩·테두리 포함)가 아니라 그 안의 그리기 면(.at-surface)
      var top = origin + system.realBounds.y;
      var nextBottom = origin + next.realBounds.y + next.realBounds.h;
      var headHeight = head ? head.getBoundingClientRect().height : 0;
      var viewTop = scroll.element.scrollTop + headHeight + SCROLL_MARGIN;
      var viewBottom = scroll.element.scrollTop + document.documentElement.clientHeight;
      if (top < viewTop || nextBottom > viewBottom) ui.scrollToY(scroll, top - headHeight - SCROLL_MARGIN, api.settings.player.scrollSpeed);
    }
    return {
      forceScrollTo: function(currentBeatBounds){ judge(currentBeatBounds, true); },
      onBeatCursorUpdating: function(startBeat){ judge(startBeat, false); }
    };
  }

  // base.css 색 토큰을 alphaTab 표시 색으로. 다크 모드 토큰은 base.css가 :root 값을 바꿔서 여기서는 읽기만 한다.
  function tokenColors(){
    var style = getComputedStyle(document.documentElement);
    function token(name, fallback){
      var value = style.getPropertyValue(name).trim();
      return value || fallback;
    }
    return {
      mainGlyphColor: token('--fg', '#1c2320'),
      scoreInfoColor: token('--fg', '#1c2320'),
      secondaryGlyphColor: token('--muted', '#5d6862'),
      staffLineColor: token('--muted', '#5d6862'),
      barSeparatorColor: token('--muted', '#5d6862'),
      barNumberColor: token('--muted', '#5d6862')
    };
  }

  function importAlphaTex(tex){
    var importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(tex, new alphaTab.Settings());
    var score = null, thrown = null;
    try { score = importer.readScore(); } catch (error){ thrown = error; }
    var bags = [importer.lexerDiagnostics, importer.parserDiagnostics, importer.semanticDiagnostics];
    var messages = [];
    bags.forEach(function(bag){
      if (!bag || !Array.isArray(bag.items)) return;
      bag.items.forEach(function(item){ messages.push((item.start ? item.start.line + ':' + item.start.col + ' ' : '') + (item.message || item.code)); });
    });
    if (messages.length || thrown || !score) throw new Error(messages.length ? messages[0] : (thrown && thrown.message) || '악보를 읽지 못했습니다.');
    return score;
  }

  function useNylonGuitar(score){
    score.tracks.forEach(function(track){ track.playbackInfo.program = PLAYBACK_PROGRAM; });
  }

  function profileFor(value){
    var profile = alphaTab.StaveProfile;
    if (value === 'tab') return profile.Tab;
    if (value === 'score') return profile.Score;
    return profile.ScoreTab;
  }

  function start(){
    if (typeof alphaTab === 'undefined' || !window.GuitarAlphaTex || typeof ls === 'undefined' || typeof normalizeVolume !== 'function'){
      setStatus('alphaTab을 불러오지 못했습니다.', 'error');
      return;
    }
    var song = readSong();
    if (!song){
      setStatus('연습 화면의 alphaTab 단추로 여세요.', 'empty');
      return;
    }
    els.title.textContent = song.title || 'alphaTab 보기';
    document.title = (song.title ? song.title + ' · ' : '') + 'alphaTab 보기 · 기타 스튜디오';

    // 원본 alphaTex가 있으면 변환하지 않고 그대로 읽는다. alphaTab이 못 읽으면 상태 줄에 알리고 우리 악보에서 만든 미리보기로 대신 그린다.
    var score = null;
    var readyNote = '';
    if (song.alphaTex){
      try {
        score = importAlphaTex(song.alphaTex);
        setSource('original');
      } catch (error){
        readyNote = '원본 alphaTex를 alphaTab이 읽지 못해 우리 악보에서 만든 미리보기로 대신 그렸습니다: ' + (error && error.message ? error.message : error);
        setStatus(readyNote, 'loading');
      }
    }
    if (!score){
      var converted = GuitarAlphaTex.toAlphaTex(song);
      if (converted.error){
        setStatus('악보를 alphaTab으로 바꾸지 못했습니다: ' + converted.error, 'error');
        return;
      }
      try {
        score = importAlphaTex(converted.tex);
      } catch (error){
        setStatus('alphaTab이 악보를 읽지 못했습니다: ' + (error && error.message ? error.message : error), 'error');
        return;
      }
      setSource('converted');
    }

    useNylonGuitar(score);

    var assetBase = new URL(ASSET_ROOT, location.href).href;
    var soundFontUrl = new URL(SOUND_FONT_URL, location.href).href;
    var api;
    try {
      api = new alphaTab.AlphaTabApi(els.host, {
        core: { scriptFile: assetBase + 'alphaTab.min.js', fontDirectory: assetBase + 'font/', engine: 'svg' },
        player: {
          enablePlayer: true,
          enableCursor: true,
          enableAnimatedBeatCursor: true,
          enableElementHighlighting: true
        },
        display: { staveProfile: profileFor(els.view.value), resources: tokenColors(), scale: window.innerWidth < 500 ? NARROW_SCALE : 1 },
        notation: { rhythmMode: alphaTab.TabRhythmMode.ShowWithBeams }
      });
    } catch (error){
      setStatus('alphaTab을 시작하지 못했습니다: ' + (error && error.message ? error.message : error), 'error');
      return;
    }
    api.customScrollHandler = createScrollHandler(api, document.querySelector('.at-head'));

    // 소리 값(마스터·트랙 음량·클릭·카운트인)은 이 함수 하나가 준다. 연주음은 마스터가 아니라 트랙 음량으로 줘서 클릭 크기에 영향을 주지 않는다.
    // 트랙 음량은 플레이어(작업자)가 준비되기 전에는 버려지므로 준비·악보 열림·소리 불러옴 때마다 다시 준다.
    var prefs = readPrefs();
    function applySound(){
      var level = prefs.click ? METRONOME_BASE_VOLUME * prefs.clickVol : 0;
      api.masterVolume = PLAYBACK_MASTER_VOLUME;
      api.metronomeVolume = level;
      api.countInVolume = level;
      if (api.score){
        // alphaTab 은 플레이어가 준비되면 트랙마다 악보에 적힌 음량(playbackInfo.volume / 16)을 채널 음량으로 준다. 연주음 100% 는 그 기본값이라야 마스터 음량 보정이 그대로 맞는다.
        api.score.tracks.forEach(function(track){
          try { api.changeTrackVolume([track], prefs.guitarVol * track.playbackInfo.volume / 16); } catch (e){ /* 플레이어가 아직 없음. 준비되면 다시 준다 */ }
        });
      }
      document.body.setAttribute('data-at-guitar-volume', String(prefs.guitarVol));
    }
    function savePrefs(){ ls.set(PREFS_KEY, prefs); }
    els.click.checked = prefs.click;
    els.clickVol.value = String(Math.round(prefs.clickVol * 100));
    els.guitarVol.value = String(Math.round(prefs.guitarVol * 100));
    applySound();

    // BPM 슬라이더. 곡 BPM 이 잘못이면 악보의 템포(4분음표 기준)로 대신한다.
    var bpmBase = song.bpm > 0 ? song.bpm : Math.max(1, Math.round(score.tempo));
    var range = bpmRange(bpmBase);
    els.bpm.min = String(range.min);
    els.bpm.max = String(range.max);
    els.bpm.value = String(bpmStart(bpmBase, song.practiceBpm));
    function applyBpm(){
      var value = Number(els.bpm.value);
      api.playbackSpeed = value / bpmBase;
      els.bpmValue.textContent = value + ' · ' + Math.round(value * 100 / bpmBase) + '%';
    }
    applyBpm();

    // 사운드폰트는 처음 재생을 누를 때 불러온다. soundState: idle(아직) | loading | loaded. 다 불러오면 playerReady가 오고 그때 재생을 시작한다.

    var rendered = false, workerReady = false, failed = false, renders = 0;
    var soundState = 'idle', soundFailed = false, playAfterLoad = false;
    function setSoundAttr(value){ document.body.setAttribute('data-at-sound', value); }
    setSoundAttr('idle');
    function refreshReady(){
      if (failed) return;
      if (rendered && workerReady){
        if (soundState !== 'loading'){
          if (!soundFailed) setStatus(readyNote, 'ready');
          els.play.disabled = false;
        }
        [els.rewind, els.bpm, els.view].forEach(function(node){ node.disabled = false; });
      } else if (rendered){
        els.view.disabled = false;
      }
    }
    function fail(message){
      failed = true;
      setStatus(message, 'error');
    }

    api.renderFinished.on(function(){
      rendered = true;
      renders++;
      els.host.setAttribute('data-renders', String(renders));
      els.host.setAttribute('data-bars', String(score.masterBars.length));
      els.host.setAttribute('data-profile', els.view.value);
      refreshReady();
    });
    api.scoreLoaded.on(applySound);
    api.soundFontLoaded.on(applySound);
    api.playerReady.on(function(){
      applySound(); // 플레이어가 준비될 때 값이 사라졌을 경우를 대비해 다시 준다
      if (soundState !== 'loading') return;
      soundState = 'loaded';
      setSoundAttr('loaded');
      refreshReady();
      if (playAfterLoad){
        playAfterLoad = false;
        api.play();
      }
    });
    api.soundFontLoad.on(function(event){
      if (soundState !== 'loading' || failed || !event || !event.total) return;
      setStatus(SOUND_LOADING_TEXT + ' ' + Math.round(event.loaded * 100 / event.total) + '%', 'loading');
    });
    api.playerStateChanged.on(function(event){
      if (event.state === alphaTab.synth.PlayerState.Playing) applySound(); // alphaTab 이 준비 때 되돌린 채널 음량이 있으면 다시 맞춘다
      els.play.textContent = event.state === alphaTab.synth.PlayerState.Playing ? '일시정지' : '재생';
    });
    api.error.on(function(error){
      if (soundState === 'loading'){
        soundState = 'idle';
        playAfterLoad = false;
        soundFailed = true;
        setSoundAttr('failed');
        setStatus(SOUND_FAILED_TEXT, 'error');
        els.play.disabled = false;
        return;
      }
      fail('alphaTab 오류: ' + (error && error.message ? error.message : error));
    });

    function loadSoundFont(){
      soundState = 'loading';
      soundFailed = false;
      playAfterLoad = true;
      setSoundAttr('loading');
      els.play.disabled = true;
      setStatus(SOUND_LOADING_TEXT, 'loading');
      api.loadSoundFontFromUrl(soundFontUrl, false);
    }
    function togglePlay(){
      if (els.play.disabled) return;
      if (soundState === 'loaded') api.playPause();
      else if (soundState === 'idle') loadSoundFont();
    }
    els.play.addEventListener('click', togglePlay);
    els.rewind.addEventListener('click', function(){
      if (els.rewind.disabled) return;
      api.stop();
    });
    els.bpm.addEventListener('input', applyBpm);
    els.click.addEventListener('change', function(){
      prefs.click = els.click.checked;
      savePrefs();
      applySound();
      els.click.blur();
    });
    els.clickVol.addEventListener('input', function(){
      prefs.clickVol = normalizeVolume(Number(els.clickVol.value) / 100, 1, CLICK_VOLUME_MAX);
      savePrefs();
      applySound();
    });
    els.guitarVol.addEventListener('input', function(){
      prefs.guitarVol = normalizeVolume(Number(els.guitarVol.value) / 100, 1, GUITAR_VOLUME_MAX);
      savePrefs();
      applySound();
    });
    [els.bpm, els.clickVol, els.guitarVol].forEach(function(node){ node.addEventListener('change', function(){ node.blur(); }); });
    els.view.addEventListener('change', function(){
      api.settings.display.staveProfile = profileFor(els.view.value);
      api.updateSettings();
      api.render();
      els.host.setAttribute('data-profile', els.view.value);
      els.view.blur();
    });
    document.addEventListener('keydown', function(event){
      if (event.code !== 'Space' && event.key !== ' ') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      var tag = event.target && event.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      event.preventDefault();
      togglePlay();
    });

    // 시스템 색 구성이 바뀌면 색 토큰을 다시 읽어 그린다.
    if (window.matchMedia){
      var media = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function(){
        var colors = tokenColors();
        Object.keys(colors).forEach(function(key){ api.settings.display.resources[key] = alphaTab.model.Color.fromJson(colors[key]); });
        api.updateSettings();
        api.render();
      };
      if (media.addEventListener) media.addEventListener('change', onScheme);
      else if (media.addListener) media.addListener(onScheme);
    }
    window.addEventListener('pagehide', function(){ try { api.destroy(); } catch (e){ /* 닫는 중 */ } });

    try {
      api.load(score);
      // 플레이어는 악보를 연 뒤에 만들어진다. 작업자와 출력이 준비되면(소리 없이) 재생 단추를 켠다.
      window.__alphaTabApi = api; // 시험용: 커서를 옮겨 자동 스크롤을 확인한다
      if (api.player) api.player.ready.on(function(){ workerReady = true; applySound(); refreshReady(); });
      applySound();
      els.host.setAttribute('data-programs', api.score.tracks.map(function(track){ return track.playbackInfo.program; }).join(','));
    } catch (error){
      fail('alphaTab이 악보를 열지 못했습니다: ' + (error && error.message ? error.message : error));
    }
  }

  start();
})();
