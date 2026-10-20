(function(){
  'use strict';
  // alphaTab 보기 창(alphatab.html). 연습 화면이 localStorage에 넣은 곡을 alphaTex로 바꿔 alphaTab 플레이어로 띄운다. 규칙과 결정은 Docs/alphatab.md.
  var STORAGE_KEY = 'gs.alphaTab.view';
  var ASSET_ROOT = 'vendor/alphatab/dist/';
  var SOUND_FONT_URL = 'vendor/musescore-general/MuseScore_General.sf3'; // 약 38MB라 창을 열 때가 아니라 처음 재생할 때 불러온다
  var SOUND_LOADING_TEXT = '소리를 불러오는 중입니다(약 38MB, 처음 한 번만)';
  var SOUND_FAILED_TEXT = '소리를 불러오지 못했습니다. 네트워크를 확인하세요.';
  var PLAYBACK_PROGRAM = 24; // General MIDI Acoustic Guitar (nylon). 악보에 적힌 악기와 상관없이 모든 트랙을 이 소리로 재생한다
  var SPEEDS = [50, 75, 100];
  var SCROLL_MARGIN = 8; // 자동 스크롤 때 지금 줄의 맨 위와 머리 막대 아랫단 사이 여유(px)
  var NARROW_SCALE = 0.7; // 폰 폭(500px 미만)에서는 악보 제목 줄까지 한 화면에 들어오게 줄여 그린다

  function byId(id){ return document.getElementById(id); }
  var els = {
    title: byId('atTitle'), play: byId('atPlayBtn'), rewind: byId('atRewindBtn'),
    speed: byId('atSpeedSelect'), view: byId('atViewSelect'), status: byId('atStatus'), host: byId('atHost'), source: byId('atSource')
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
      alphaTex: typeof song.alphaTex === 'string' && song.alphaTex.trim() ? song.alphaTex : ''
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
    if (typeof alphaTab === 'undefined' || !window.GuitarAlphaTex){
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

    // 사운드폰트는 처음 재생을 누를 때 불러온다. soundState: idle(아직) | loading | loaded. 다 불러오면 playerReady가 오고 그때 재생을 시작한다.
    // alphaTab은 재생 중 지금 줄의 맨 위를 화면 맨 위에 맞춰 스크롤한다(스크롤 요소는 기본값 html,body = 문서 전체).
    // 위에 붙은 머리 막대가 줄바꿈으로 높이가 바뀌므로 실제 높이를 재서 오프셋으로 준다. 스크롤할 때마다 settings.player.scrollOffsetY를 읽으니 updateSettings는 필요 없다.
    var head = document.querySelector('.at-head');
    function fitScrollOffset(){
      if (!head) return;
      api.settings.player.scrollOffsetY = -Math.round(head.getBoundingClientRect().height + SCROLL_MARGIN);
    }
    fitScrollOffset();
    if (window.ResizeObserver && head) new ResizeObserver(fitScrollOffset).observe(head);
    window.addEventListener('resize', fitScrollOffset);

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
        [els.rewind, els.speed, els.view].forEach(function(node){ node.disabled = false; });
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
    api.playerReady.on(function(){
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
    els.speed.addEventListener('change', function(){
      var percent = Number(els.speed.value);
      if (SPEEDS.indexOf(percent) >= 0) api.playbackSpeed = percent / 100;
      els.speed.blur();
    });
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
      if (api.player) api.player.ready.on(function(){ workerReady = true; refreshReady(); });
      els.host.setAttribute('data-programs', api.score.tracks.map(function(track){ return track.playbackInfo.program; }).join(','));
    } catch (error){
      fail('alphaTab이 악보를 열지 못했습니다: ' + (error && error.message ? error.message : error));
    }
  }

  start();
})();
