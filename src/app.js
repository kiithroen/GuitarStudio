'use strict';

  var $ = function(s){ return document.querySelector(s); };
  var $$ = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };

  // ---------- 기본 내장 클래식 기타 동요 / 교본 명곡 (songs.json 단일 소스에서 로드)
  var BUILTIN_SONGS = [];

  // ---------- IndexedDB 및 상태 저장소
  var DB_NAME = 'guitar_studio_db';
  var DB_VER = 1;
  var dbInstance = null;

  function openDB(){
    if (dbInstance) return Promise.resolve(dbInstance);
    return new Promise(function(resolve, reject){
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function(e){
        var db = e.target.result;
        if (!db.objectStoreNames.contains('songs')){
          db.createObjectStore('songs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('kv')){
          db.createObjectStore('kv', { keyPath: 'k' });
        }
      };
      req.onsuccess = function(e){ dbInstance = e.target.result; resolve(dbInstance); };
      req.onerror = function(e){ reject(e.target.error); };
    });
  }

  function dbGetAllSongs(){
    return openDB().then(function(db){
      return new Promise(function(resolve){
        var tx = db.transaction('songs', 'readonly');
        var req = tx.objectStore('songs').getAll();
        req.onsuccess = function(){ resolve(req.result || []); };
        req.onerror = function(){ resolve([]); };
      });
    });
  }

  function dbSaveSong(song){
    return openDB().then(function(db){
      return new Promise(function(resolve){
        var tx = db.transaction('songs', 'readwrite');
        tx.objectStore('songs').put(song);
        tx.oncomplete = function(){ resolve(); };
      });
    });
  }

  function dbDeleteSong(id){
    return openDB().then(function(db){
      return new Promise(function(resolve){
        var tx = db.transaction('songs', 'readwrite');
        tx.objectStore('songs').delete(id);
        tx.oncomplete = function(){ resolve(); };
      });
    });
  }

  var ls = {
    get: function(k, d){ try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e){ return d; } },
    set: function(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e){} }
  };

  // ---------- 앱 전역 상태
  var customSongs = [];
  var allSongs = [];
  var curSong = null;
  var curMeasureIdx = 0;
  var curBeatIdx = 0;

  var appState = ls.get('gs.state', {
    lastSongId: 'builtin-lv1-butterfly',
    bpm: 64,
    beats: 4,
    vol: 0.55,
    guideSound: true,
    acousticFx: true, // 고품질 음향 효과 (콘서트홀 리버브, 바디 공명, 2단 서스테인) 토글
    autoBass: false,
    loopEnable: true,
    loopStart: 1,
    loopEnd: 8,
    speedTrainer: false,
    audioOffsetMs: 0
  });
  if (typeof appState.autoBass !== 'boolean') appState.autoBass = false;
  if (typeof appState.acousticFx !== 'boolean') appState.acousticFx = true;
  if (typeof appState.audioOffsetMs !== 'number') appState.audioOffsetMs = 0;
  if (typeof appState.micScoring !== 'boolean') appState.micScoring = true; // 연습 중 마이크 정박·음정 채점 사용 여부
  if (typeof appState.micDeviceId !== 'string') appState.micDeviceId = ''; // 마이크 입력 장치 (''이면 시스템 기본)
  if (appState.synthEngine !== 'classic') appState.synthEngine = 'ks'; // 기타 음원: 'ks' 물리 모델 / 'classic' 기존 합성음
  if (typeof appState.bodyAmount !== 'number') appState.bodyAmount = 1.0; // 울림통 공명 세기 (0~2, 1이 기본)
  if (typeof appState.sympAmount !== 'number') appState.sympAmount = 1.0; // 공명현 세기 (0~2, 0이면 꺼짐)
  if (appState.scoreView !== 'card') appState.scoreView = 'tab'; // 악보 보기 모드: 'tab' 6현 타브(기본) / 'card' 박자 카드
  appState.isCompactPractice = false;


function curCapo(){
  return curSong ? getSongCapo(curSong) : 0;
}

function editorCapo(){
  var el = document.getElementById('nsTitle');
  return getSongCapo({ title: el ? el.value : '', capo: typeof veState !== 'undefined' ? veState.sourceCapo : 0 });
}
  var calib = ls.get('gs.calib', { lat: 0.045, calibrated: false, at: null });
  var historyList = ls.get('gs.history', []);

  // 이미지 악보 편집 상태
  var imgEditMode = true;
  var dragCreate = null;
  var selectedImgBar = null; // { sysIdx, barIdx }

  // 오디오 및 메트로놈 런타임 (어쿠스틱 바디 공명 + 콘서트홀 리버브 버스 포함)
  var actx = null, workletNode = null, micStream = null, micSource = null, outGain = null;
  var guitarBus = null, reverbNode = null, pluckNoiseBuf = null, clickBus = null;
  var dryGainNode = null, wetGainNode = null, bodyModes = [];
  var stringVoices = {}; // 줄 번호(1~6)별 현재 울리고 있는 보이스 목록 (같은 줄 재탄현 시 이전 음 정지용)
  // 기타 마스터 음량 (0.90에서 -1.6dB): 내장곡 실측 기준 로망스 원곡 9/8 첫 박(베이스+아포얀도 동시 탄현)을 제외한 모든 곡의 피크가 -1dBFS 아래
  var GUITAR_MASTER_GAIN = 0.75;
  var isPlaying = false;
  var isStarting = false; // 연습 시작 중 마이크 권한·연결을 기다리는 동안 중복 시작 방지
  var practiceStartToken = 0;
  var isCalibrating = false;
  var isTunerActive = false;
  var playSession = null;
  var micLevel = 0;
  var lastDetectedMidi = null;

  // ---------- 유틸 함수
  function tempoName(b){
    if (b < 45) return 'Grave';
    if (b < 60) return 'Largo';
    if (b < 68) return 'Larghetto';
    if (b < 78) return 'Adagio';
    if (b < 108) return 'Andante';
    if (b < 124) return 'Moderato';
    if (b < 156) return 'Allegro';
    return 'Vivace';
  }
  function fmtSigned(v){ var r = Math.round(v); if (r === 0) return '±0'; return r > 0 ? '+' + r : '-' + (-r); }
  function classOfErr(ms){ var a = Math.abs(ms); return a <= 30 ? 'ok' : a <= 55 ? 'near' : 'off'; }
  function fmtDate(ts){
    var d = new Date(ts), p = function(n){ return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function saveAppState(){
    if (curSong){
      curSong.lastBpm = appState.bpm;
      curSong.lastLoopStart = appState.loopStart;
      curSong.lastLoopEnd = appState.loopEnd;
      curSong.lastPracticedAt = Date.now();
      if (!curSong.builtin && !curSong.fromSheet) dbSaveSong(curSong);
      else ls.set('gs.builtinMeta.' + curSong.id, {
        bpm: curSong.lastBpm,
        loopStart: curSong.lastLoopStart,
        loopEnd: curSong.lastLoopEnd,
        ytUrl: curSong.ytUrl || '',
        at: curSong.lastPracticedAt
      });
    }
    ls.set('gs.state', appState);
  }

  async function openMicStream(){
    var base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (appState.micDeviceId){
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: appState.micDeviceId } }, base) });
      } catch (e){
        // 저장해 둔 장치가 분리된 경우에만 시스템 기본 마이크로 대체 (권한 거부 등은 그대로 알림)
        if (!e || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e;
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: base });
  }

  async function ensureMicWorklet(){
    ensureAudioCtx();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      throw new Error('이 브라우저에서는 마이크 입력을 쓸 수 없어요.');
    }
    if (!micStream){
      micStream = await openMicStream();
      if (micSource){ micSource.disconnect(); micSource = null; }
    }
    if (!workletNode){
      var blob = new Blob([$('#worklet').textContent], { type: 'text/javascript' });
      var url = URL.createObjectURL(blob);
      await actx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      workletNode = new AudioWorkletNode(actx, 'onset', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      var sink = actx.createGain();
      sink.gain.value = 0;
      workletNode.connect(sink);
      sink.connect(actx.destination);
      workletNode.port.onmessage = onWorkletMessage;
    }
    if (!micSource){
      micSource = actx.createMediaStreamSource(micStream);
      micSource.connect(workletNode);
    }
    refreshMicDeviceList(); // 권한을 받은 뒤라 장치 이름이 보임
  }

  // 마이크를 열어 둔 채로 두면 블루투스 헤드셋이 통화 모드(HFP)에 머물러 재생 음질이 떨어지므로, 쓰는 곳이 없으면 바로 해제
  function releaseMic(){
    if (isTunerActive || isCalibrating || ((isPlaying || isStarting) && appState.micScoring)) return;
    if (micSource){ micSource.disconnect(); micSource = null; }
    if (micStream){
      micStream.getTracks().forEach(function(tr){ tr.stop(); });
      micStream = null;
    }
  }

  async function refreshMicDeviceList(){
    var sel = $('#micDeviceSelect');
    if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    var devs = [];
    try {
      devs = (await navigator.mediaDevices.enumerateDevices()).filter(function(d){ return d.kind === 'audioinput'; });
    } catch (e){}
    sel.textContent = '';
    var defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = '시스템 기본 마이크';
    sel.appendChild(defOpt);
    var named = 0;
    devs.forEach(function(d){
      // 'default'·'communications'는 실제 장치의 별칭이라 목록에서 제외
      if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') return;
      var o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || ('마이크 ' + (named + 1));
      sel.appendChild(o);
      named++;
    });
    if (!named){
      var hintOpt = document.createElement('option');
      hintOpt.disabled = true;
      hintOpt.textContent = '(목록 불러오기를 눌러 마이크 권한을 허용하면 장치가 보여요)';
      sel.appendChild(hintOpt);
    }
    sel.value = appState.micDeviceId;
    if (sel.value !== appState.micDeviceId) sel.value = '';
  }

  function onWorkletMessage(e){
    var d = e.data;
    if (!d) return;
    if (d.t === 'lv'){
      if (d.l > micLevel) micLevel = d.l;
      return;
    }
    if (d.t === 'tune'){
      if (isTunerActive) updateTunerReading(d.hz);
      return;
    }
    if (d.t === 'pitch'){
      lastDetectedMidi = d.midi;
      if (d.midi != null){
        var inf = midiInfo(d.midi);
        $('#liveNote').textContent = inf.en;
        $('#liveNoteKo').textContent = inf.ko + (inf.pos ? ' (' + inf.pos.str + '줄 ' + inf.pos.fret + '프렛)' : '');
      }
      if (isPlaying && playSession && playSession.lastOnsetObj && playSession.lastOnsetObj.rawTime === d.time){
        playSession.lastOnsetObj.midi = d.midi;
        evaluateHitPitch(playSession.lastOnsetObj);
      }
      return;
    }
    if (d.t === 'on'){
      if (isCalibrating && d.k === 1 && playSession && playSession.calClicks){
        playSession.calHeard.push(d.time);
        return;
      }
      if (d.k === 0 && isPlaying && playSession){
        handleGuitarOnset(d.time);
      }
    }
  }

  function handleGuitarOnset(rawTime){
    var s = playSession;
    if (!s) return;
    var totalOffset = calib.lat + ((appState.audioOffsetMs || 0) / 1000);
    var t = rawTime - totalOffset;
    if (t < s.measureStartTime - s.spb * 0.4) return;
    var beatFloat = (t - s.measureStartTime) / s.spb;
    var nearestBeat = Math.round(beatFloat);
    var errMs = (beatFloat - nearestBeat) * s.spb * 1000;
    if (Math.abs(errMs) > 220) return;

    var cls = classOfErr(errMs);
    $('#liveErr').textContent = fmtSigned(errMs) + ' ms';
    $('#liveErr').dataset.cls = cls;

    var needle = $('#liveNeedle');
    needle.hidden = false;
    needle.dataset.cls = cls;
    var pct = 50 + Math.max(-100, Math.min(100, errMs)) / 2;
    needle.style.left = pct + '%';

    var hitObj = {
      rawTime: rawTime,
      t: t,
      errMs: errMs,
      cls: cls,
      mIdx: curMeasureIdx,
      bIdx: Math.max(0, Math.min(s.bpb - 1, nearestBeat % s.bpb)),
      midi: null
    };
    s.hits.push(hitObj);
    s.lastOnsetObj = hitObj;

    // 구조화 악보 셀에 즉시 타이밍 피드백 표시
    var cell = $('#measuresGrid .beat-cell[data-m="' + hitObj.mIdx + '"][data-b="' + hitObj.bIdx + '"]');
    if (cell) cell.dataset.judge = cls;
  }

  function evaluateHitPitch(hitObj){
    if (curSong.type !== 'structured') return;
    var m = curSong.measures[hitObj.mIdx];
    if (!m) return;
    var b = m.beats[hitObj.bIdx];
    if (!b || !hitObj.midi) return;
    var cell = $('#measuresGrid .beat-cell[data-m="' + hitObj.mIdx + '"][data-b="' + hitObj.bIdx + '"]');
    if (!cell) return;
    var songCapo = getSongCapo(curSong);
    var effBass = resolveEffectiveBass(m.chord, b, hitObj.bIdx);
    var matchMel = false;
    if (b.isSubdivided && b.subNotes && b.subNotes.length > 0){
      matchMel = b.subNotes.some(function(sn){ return sn.midi && (hitObj.midi % 12 === (soundingMidi(sn.midi, songCapo)) % 12); });
    } else if (b.midi){
      matchMel = (hitObj.midi % 12 === (soundingMidi(b.midi, songCapo)) % 12);
    }
    var matchBass = effBass && (hitObj.midi % 12 === (soundingMidi(effBass.midi, songCapo)) % 12);
    // 멜로디와 베이스 중 어느 쪽과도 음정이 다르면 off 표시
    if (!matchMel && !matchBass){
      cell.dataset.judge = 'off';
    }
  }

  // ---------- 악보 렌더링: 1) 내장/텍스트 구조화 악보
  function renderSong(){
    if (!curSong) return;
    var songCapo = getSongCapo(curSong);
    var capoBadgeTxt = (songCapo > 0 && !/(?:capo|카포)\s*[:.]?\s*(?:fret\s*)?\d/i.test(curSong.badge || '')) ? (' · Capo ' + songCapo) : '';
    $('#scoreTitle').textContent = curSong.title;
    $('#scoreTypeBadge').textContent = (curSong.badge || (curSong.type === 'image' ? '교본 사진/PDF 악보' : '직접 만든 악보')) + capoBadgeTxt;
    var canRenameOrDelete = !curSong.builtin;
    $('#deleteSongBtn').hidden = !canRenameOrDelete;
    $('#deleteSongBtn').textContent = curSong.fromSheet ? '목록에서 삭제' : '삭제';
    if ($('#renameSongBtn')) $('#renameSongBtn').hidden = !canRenameOrDelete;
    if ($('#renameScoreTitleBtn')) $('#renameScoreTitleBtn').hidden = !canRenameOrDelete;
    if (canRenameOrDelete){
      $('#scoreTitle').title = '클릭하여 악보 이름 변경';
      $('#scoreTitle').style.cursor = 'pointer';
    } else {
      $('#scoreTitle').title = '';
      $('#scoreTitle').style.cursor = 'default';
    }

    // 곡별 저장된 설정 복원
    var savedMeta = (curSong.builtin || curSong.fromSheet) ? ls.get('gs.builtinMeta.' + curSong.id, null) : curSong;
    var totalM = getMeasureCount(curSong);
    appState.beats = curSong.beats || 4;
    var defaultBpm = Number(curSong.bpm) || 64;
    appState.bpm = defaultBpm;
    appState.loopStart = Math.min(totalM, Math.max(1, (savedMeta && savedMeta.loopStart) || 1));
    appState.loopEnd = Math.min(totalM, Math.max(appState.loopStart, (savedMeta && savedMeta.loopEnd) || totalM));
    if (savedMeta && savedMeta.ytUrl) curSong.ytUrl = savedMeta.ytUrl;

    $('#loopStart').max = totalM;
    $('#loopEnd').max = totalM;
    $('#loopStart').value = appState.loopStart;
    $('#loopEnd').value = appState.loopEnd;

    if (savedMeta && savedMeta.at){
      $('#resumeBanner').hidden = false;
      var lastPracticedBpm = savedMeta.bpm || defaultBpm;
      $('#resumeText').textContent = '이어가기 안내: 마지막 연습 ' + fmtDate(savedMeta.at) + ' (당시 ' + lastPracticedBpm + ' BPM) · 구간 ' + appState.loopStart + '~' + appState.loopEnd + '마디';
    } else {
      $('#resumeBanner').hidden = true;
    }

    if ($('#songSelect') && curSong && $('#songSelect').value !== curSong.id){
      $('#songSelect').value = curSong.id;
    }
    if ($('#compactSongSelect') && curSong && $('#compactSongSelect').value !== curSong.id){
      $('#compactSongSelect').value = curSong.id;
    }

    syncConsoleUI();
    renderYoutubePanel();

    if (curSong.type === 'structured'){
      $('#structuredScoreWrap').hidden = false;
      $('#imageScoreWrap').hidden = true;
      $('#convertImgToScoreBtn').hidden = true;
      $('#editStructuredBtn').hidden = false;
      $('#editBarMetaBtn').hidden = true;
      syncScoreModeUI();
      if (curSong.refImageDataUrl){
        $('#refImgDetails').hidden = false;
        $('#refScoreImg').src = curSong.refImageDataUrl;
      } else {
        $('#refImgDetails').hidden = true;
      }
      renderStructuredMeasures();
    } else {
      $('#structuredScoreWrap').hidden = true;
      $('#imageScoreWrap').hidden = false;
      $('#convertImgToScoreBtn').hidden = false;
      $('#editStructuredBtn').hidden = true;
      $('#editBarMetaBtn').hidden = false;
      syncScoreModeUI();
      renderImageScore();
    }

    curMeasureIdx = appState.loopStart - 1;
    curBeatIdx = 0;
    updateActiveCursor(curMeasureIdx, 0, false);
  }

  function getMeasureCount(song){
    if (!song) return 1;
    if (song.type === 'structured') return song.measures.length;
    var cnt = 0;
    (song.systems || []).forEach(function(sys){ cnt += sys.bars.length; });
    return Math.max(1, cnt);
  }

  function getOctaveLabel(midi){
    if (midi == null) return '';
    var oct = Math.floor(midi / 12) - 1;
    if (oct <= 2) return '저음';
    if (oct === 3) return '낮은';
    if (oct === 4) return (midi === 60 ? '가온' : '중간');
    if (oct === 5) return '높은';
    return '고음';
  }

  function renderStructuredMeasures(){
    var grid = $('#measuresGrid');
    grid.textContent = '';
    var isTab = (appState.scoreView !== 'card');
    if (curSong && curSong.beats >= 9){
      grid.style.gridTemplateColumns = isTab ? 'repeat(auto-fill, minmax(560px, 1fr))' : 'repeat(auto-fill, minmax(560px, 1fr))';
    } else if (curSong && curSong.beats >= 8){
      grid.style.gridTemplateColumns = isTab ? 'repeat(auto-fill, minmax(460px, 1fr))' : 'repeat(auto-fill, minmax(460px, 1fr))';
    } else if (curSong && curSong.beats >= 6){
      grid.style.gridTemplateColumns = isTab ? 'repeat(auto-fill, minmax(330px, 1fr))' : 'repeat(auto-fill, minmax(340px, 1fr))';
    } else {
      grid.style.gridTemplateColumns = isTab ? 'repeat(auto-fill, minmax(250px, 1fr))' : 'repeat(auto-fill, minmax(260px, 1fr))';
    }
    var chordsSet = [];

    curSong.measures.forEach(function(m, mIdx){
      if (m.chord && chordsSet.indexOf(m.chord) < 0) chordsSet.push(m.chord);

      var card = document.createElement('div');
      card.className = 'measure-card' + (isTab ? ' tab-mode' : '');
      card.dataset.m = mIdx;
      var inLoop = (mIdx + 1) >= appState.loopStart && (mIdx + 1) <= appState.loopEnd;
      card.classList.toggle('in-loop', inLoop);

      var head = document.createElement('div');
      head.className = 'm-head';
      var num = document.createElement('span');
      num.className = 'm-num';
      num.textContent = m.no + '마디';
      head.appendChild(num);
      if (m.chord){
        var chord = document.createElement('span');
        chord.className = 'm-chord' + (m.autoChord ? ' auto-chord' : '');
        chord.textContent = m.chord + (m.autoChord ? ' (자동)' : '');
        if (m.autoChord) chord.title = '멜로디 구성음과 곡의 조성을 분석해 자동 추론된 반주 코드입니다';
        head.appendChild(chord);
      }
      card.appendChild(head);

      if (isTab){
        var staveWrap = document.createElement('div');
        staveWrap.className = 'tab-stave-wrap';

        var side = document.createElement('div');
        side.className = 'tab-stave-side';
        var sideTitle = document.createElement('div');
        sideTitle.className = 'tab-badge-title';
        sideTitle.textContent = 'TAB';
        var strNames = document.createElement('div');
        strNames.className = 'tab-str-names';
        ['1E', '2B', '3G', '4D', '5A', '6E'].forEach(function(s, idx){
          var sn = document.createElement('span');
          sn.textContent = s;
          sn.style.top = (idx * 20) + '%';
          strNames.appendChild(sn);
        });
        side.appendChild(sideTitle);
        side.appendChild(strNames);
        staveWrap.appendChild(side);

        var body = document.createElement('div');
        body.className = 'tab-stave-body';

        var linesBg = document.createElement('div');
        linesBg.className = 'tab-lines-bg';
        for (var l = 0; l < 6; l++){
          var lh = document.createElement('div');
          lh.className = 'tab-line-h';
          lh.style.top = (l * 20) + '%';
          linesBg.appendChild(lh);
        }
        body.appendChild(linesBg);

        var beatsRow = document.createElement('div');
        beatsRow.className = 'beats-row tab-mode';
        beatsRow.style.setProperty('--bpb', curSong.beats);

        m.beats.forEach(function(b, bIdx){
          var cell = document.createElement('div');
          var extraCls = ' tab-cell';
          if (b.articulation === 'apoyando') extraCls += ' arp-melody';
          else if (b.articulation === 'tirando') extraCls += ' arp-sub';
          if (((curSong.beats === 9 || curSong.beats === 6) && (bIdx === 3 || bIdx === 6)) || (curSong.beats === 8 && bIdx === 4)){
            extraCls += ' arp-group-start';
          }
          cell.className = 'beat-cell' + extraCls;
          cell.dataset.m = mIdx;
          cell.dataset.b = bIdx;
          var effBass = resolveEffectiveBass(m.chord, b, bIdx);

          var articDesc = b.articulation === 'apoyando'
            ? (' [아포얀도 주선율 · ' + (b.explicitArticulation ? '악보지정(!)' : '최고음 자동추론') + ']')
            : (b.articulation === 'tirando' ? (' [티란도 반주 · ' + (b.explicitArticulation ? '악보지정(~)' : '자동추론') + ']') : '');
          cell.title = m.no + '마디 ' + (bIdx + 1) + '박' + articDesc + ' (클릭: 운지 보기 및 음 듣기)';

          var topRow = document.createElement('div');
          topRow.className = 'tab-cell-top';
          if (b.midi || (b.isSubdivided && b.subNotes)){
            var solfegeWrap = document.createElement('span');
            solfegeWrap.className = 'tab-cell-solfege-wrap';

            var enEl = document.createElement('span');
            enEl.className = 'tab-cell-en';

            if (!b.isSubdivided && b.chordNotes && b.chordNotes.length > 2){
              if (m.chord){
                enEl.textContent = cleanChordToken(m.chord);
              } else {
                enEl.textContent = b.chordNotes.map(function(c){
                  return (c.en || '').replace(/\d+$/, '') || c.en || '';
                }).filter(Boolean).join('·');
              }
            } else if (b.isSubdivided && b.subNotes){
              enEl.textContent = b.subNotes.map(function(s){
                if (s.tok === '-' || !s.en || s.en === '-') return '-';
                if (s.chordNotes && s.chordNotes.length > 2){
                  return s.chordNotes.map(function(cn){ return (cn.en || '').replace(/\d+$/, ''); }).filter(Boolean).join('+');
                }
                return s.en.replace(/\d+$/, '');
              }).join('·');
            } else {
              enEl.textContent = b.en || '';
            }
            if (enEl.textContent){
              solfegeWrap.appendChild(enEl);
              topRow.appendChild(solfegeWrap);
            }
          }
          if (b.rh || effBass){
            var rhEl = document.createElement('span');
            rhEl.className = 'tab-cell-rh';
            var rhText = effBass ? 'p+' + (b.rh || '') : (b.rh || '');
            if (!b.isSubdivided && b.chordNotes && b.chordNotes.length > 2){
              rhText = '↑';
            } else if (b.articulation === 'apoyando'){
              rhText += '!';
            }
            rhEl.textContent = rhText;
            topRow.appendChild(rhEl);
          }
          cell.appendChild(topRow);

          var gridEl = document.createElement('div');
          gridEl.className = 'tab-cell-grid';

          if (!b.isSubdivided && b.chordNotes && b.chordNotes.length > 2){
            var strTops = b.chordNotes.map(function(cn){ return (cn.str - 1) * 20; });
            var minTop = Math.min.apply(null, strTops);
            var maxTop = Math.max.apply(null, strTops);
            if (maxTop > minTop){
              var rollSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
              rollSvg.setAttribute('class', 'tab-roll-svg');
              rollSvg.setAttribute('viewBox', '0 0 12 60');
              rollSvg.setAttribute('preserveAspectRatio', 'none');
              rollSvg.style.position = 'absolute';
              rollSvg.style.left = '16%';
              rollSvg.style.top = minTop + '%';
              rollSvg.style.height = (maxTop - minTop) + '%';
              rollSvg.style.width = '12px';
              rollSvg.style.transform = 'translateX(-50%)';
              rollSvg.style.color = 'var(--accent)';
              rollSvg.style.zIndex = '2';
              rollSvg.style.pointerEvents = 'none';
              rollSvg.innerHTML = '<line x1="6" y1="58" x2="6" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><polyline points="2,11 6,3 10,11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
              gridEl.appendChild(rollSvg);
            }
            b.chordNotes.forEach(function(cn, cnIdx){
              if (cn.str){
                var cPill = document.createElement('span');
                var isBass = (cnIdx === 0);
                cPill.className = 'tab-fret-pill ' + (isBass ? 'bass-fret' : 'mel-fret');
                cPill.style.top = ((cn.str - 1) * 20) + '%';
                cPill.textContent = String(cn.fret != null ? cn.fret : 0);
                if (cn.lh != null && cn.lh > 0){
                  var clh = document.createElement('span');
                  clh.className = 'tab-cell-lh';
                  clh.textContent = '(' + cn.lh + ')';
                  cPill.appendChild(clh);
                }
                gridEl.appendChild(cPill);
              }
            });
          } else if (b.isSubdivided && b.subNotes && b.subNotes.length > 1){
            var numSubs = b.subNotes.length;
            var firstSub = b.subNotes[0];
            var hasExplicitSubBass = b.subNotes.some(function(sn){ return sn && sn.bass && sn.bass.midi; });
            var sameStrOnFirst = !!(effBass && !hasExplicitSubBass && effBass.str && firstSub && firstSub.str && effBass.str === firstSub.str);
            var sameFretOnFirst = sameStrOnFirst && (effBass.fret === firstSub.fret);
            var diffFretOnFirst = sameStrOnFirst && (effBass.fret !== firstSub.fret);

            if (effBass && !hasExplicitSubBass && effBass.str){
              var bPill = document.createElement('span');
              bPill.className = 'tab-fret-pill bass-fret';
              bPill.style.position = 'absolute';
              bPill.style.top = ((effBass.str - 1) * 20) + '%';
              bPill.style.left = ((0.5 / numSubs) * 100) + '%';
              bPill.style.transform = diffFretOnFirst ? 'translate(-85%, -50%)' : 'translate(-50%, -50%)';
              bPill.textContent = String(effBass.fret != null ? effBass.fret : 0);
              if (effBass.lh){
                var blh = document.createElement('span');
                blh.className = 'tab-cell-lh';
                blh.textContent = '(' + effBass.lh + ')';
                bPill.appendChild(blh);
              }
              gridEl.appendChild(bPill);
            }
            b.subNotes.forEach(function(sn, sIdx){
              var leftPct = (((sIdx + 0.5) / numSubs) * 100) + '%';
              function addSubPill(note, role, transform){
                if (!note || !note.str) return;
                var pill = document.createElement('span');
                pill.className = 'tab-fret-pill ' + role;
                pill.style.position = 'absolute';
                pill.style.top = ((note.str - 1) * 20) + '%';
                pill.style.left = leftPct;
                pill.style.transform = transform || 'translate(-50%, -50%)';
                pill.textContent = String(note.fret != null ? note.fret : 0);
                if (note.lh != null && note.lh > 0){
                  var lh = document.createElement('span');
                  lh.className = 'tab-cell-lh';
                  lh.textContent = '(' + note.lh + ')';
                  pill.appendChild(lh);
                }
                gridEl.appendChild(pill);
              }
              if (sn.tok === '-'){
                var dash = document.createElement('span');
                dash.className = 'tab-rest-dash';
                dash.textContent = '-';
                dash.style.position = 'absolute';
                dash.style.left = leftPct;
                dash.style.top = '50%';
                dash.style.transform = 'translate(-50%, -50%)';
                dash.style.opacity = '0.4';
                gridEl.appendChild(dash);
              } else if (sn.chordNotes && sn.chordNotes.length > 2){
                sn.chordNotes.forEach(function(cn, cnIdx){ addSubPill(cn, cnIdx === 0 ? 'bass-fret' : 'mel-fret'); });
              } else if (sn.chordNotes && sn.chordNotes.length === 2){
                var subBass = resolveEffectiveBass(m.chord, sn, bIdx);
                var pairSameStr = !!(subBass && subBass.str && sn.str && subBass.str === sn.str);
                var pairSameFret = pairSameStr && subBass.fret === sn.fret;
                var pairBassTransform = pairSameStr && !pairSameFret ? 'translate(-85%, -50%)' : null;
                var pairMelTransform = pairSameStr && !pairSameFret ? 'translate(-15%, -50%)' : null;
                if (subBass && subBass.midi) addSubPill(subBass, 'bass-fret', pairBassTransform);
                if (sn.midi && !pairSameFret) addSubPill(sn, 'mel-fret', pairMelTransform);
              } else if (sn.midi && sn.str){
                if (sIdx === 0 && sameFretOnFirst){
                  return;
                }
                var mPill = document.createElement('span');
                mPill.className = 'tab-fret-pill mel-fret';
                mPill.style.position = 'absolute';
                mPill.style.top = ((sn.str - 1) * 20) + '%';
                mPill.style.left = leftPct;
                mPill.style.transform = (sIdx === 0 && diffFretOnFirst) ? 'translate(-15%, -50%)' : 'translate(-50%, -50%)';
                mPill.textContent = String(sn.fret != null ? sn.fret : 0);
                if (sn.lh != null && sn.lh > 0){
                  var mlh = document.createElement('span');
                  mlh.className = 'tab-cell-lh';
                  mlh.textContent = '(' + sn.lh + ')';
                  mPill.appendChild(mlh);
                }
                gridEl.appendChild(mPill);
              }
            });
          } else {
            var hasBass = !!(effBass && effBass.str);
            var hasMel = !!(b.midi && b.str);
            var sameStr = hasBass && hasMel && (effBass.str === b.str);
            var sameFret = sameStr && (effBass.fret === b.fret);
            var diffFret = sameStr && (effBass.fret !== b.fret);

            // 1. 베이스 프렛 (주황/골드)
            if (hasBass){
              var bPill = document.createElement('span');
              bPill.className = 'tab-fret-pill bass-fret';
              bPill.style.top = ((effBass.str - 1) * 20) + '%';
              if (diffFret){
                bPill.style.left = '38%';
              }
              bPill.textContent = String(effBass.fret != null ? effBass.fret : 0);
              if (effBass.lh){
                var blh = document.createElement('span');
                blh.className = 'tab-cell-lh';
                blh.textContent = '(' + effBass.lh + ')';
                bPill.appendChild(blh);
              }
              gridEl.appendChild(bPill);
            }

            // 2. 멜로디 프렛 (인디고/블루)
            if (hasMel){
              if (!sameFret){
                var mPill = document.createElement('span');
                mPill.className = 'tab-fret-pill mel-fret';
                mPill.style.top = ((b.str - 1) * 20) + '%';
                if (diffFret){
                  mPill.style.left = '62%';
                }
                mPill.textContent = String(b.fret != null ? b.fret : 0);
                if (b.lh != null){
                  var mlh = document.createElement('span');
                  mlh.className = 'tab-cell-lh';
                  mlh.textContent = '(' + b.lh + ')';
                  mPill.appendChild(mlh);
                }
                gridEl.appendChild(mPill);
              }
            } else if (!hasMel && !hasBass){
              var dash = document.createElement('span');
              dash.className = 'tab-rest-dash';
              dash.textContent = '-';
              gridEl.appendChild(dash);
            }
          }

          cell.appendChild(gridEl);

          cell.addEventListener('click', function(e){
            if (e.shiftKey) return;
            e.stopPropagation();
            curMeasureIdx = mIdx;
            curBeatIdx = bIdx;
            if (mIdx + 1 < appState.loopStart || mIdx + 1 > appState.loopEnd){
              appState.loopStart = mIdx + 1;
              appState.loopEnd = getMeasureCount(curSong);
              $('#loopStart').value = appState.loopStart;
              $('#loopEnd').value = appState.loopEnd;
              updateLoopClasses();
            }
            saveAppState();
            updateActiveCursor(mIdx, bIdx, !isPlaying);
          });

          beatsRow.appendChild(cell);
        });

        body.appendChild(beatsRow);
        staveWrap.appendChild(body);
        card.appendChild(staveWrap);
      } else {
        var beatsRow = document.createElement('div');
        beatsRow.className = 'beats-row';
        beatsRow.style.setProperty('--bpb', curSong.beats);

        m.beats.forEach(function(b, bIdx){
          var durInfo = getBeatDurationInfo(m.beats, bIdx, curSong.beats);
          var cell = document.createElement('div');
          var extraCls = '';
          if (b.articulation === 'apoyando'){
            extraCls += ' arp-melody';
          } else if (b.articulation === 'tirando'){
            extraCls += ' arp-sub';
          }
          if (((curSong.beats === 9 || curSong.beats === 6) && (bIdx === 3 || bIdx === 6)) || (curSong.beats === 8 && bIdx === 4)){
            extraCls += ' arp-group-start';
          }
          if (!b.midi){
            extraCls += ' is-rest';
          }
          cell.className = 'beat-cell' + extraCls;
          cell.dataset.m = mIdx;
          cell.dataset.b = bIdx;

          var effBass = resolveEffectiveBass(m.chord, b, bIdx);
          var articDesc = b.articulation === 'apoyando'
            ? (' [아포얀도 주선율 · ' + (b.explicitArticulation ? '악보지정(!)' : '최고음 자동추론') + ']')
            : (b.articulation === 'tirando' ? (' [티란도 반주 · ' + (b.explicitArticulation ? '악보지정(~)' : '자동추론') + ']') : '');

          var detailDesc = m.no + '마디 ' + (bIdx + 1) + '박: ' +
            (b.midi ? (b.ko + ' (' + b.en + ', ' + getOctaveLabel(b.midi) + ') · ' + durInfo.durName) : '쉼/울림 유지') +
            articDesc + ' (클릭: 음 듣기 및 지판 확인)';
          cell.title = detailDesc;

          // 1. 박자 번호 및 음표 길이 헤더 (친절한 리듬 표기)
          var rhythmHead = document.createElement('div');
          rhythmHead.className = 'b-rhythm-head';

          var idxBadge = document.createElement('span');
          idxBadge.className = 'b-idx-badge';
          idxBadge.textContent = (bIdx + 1) + '박';
          rhythmHead.appendChild(idxBadge);

          if (b.midi || (b.isSubdivided && b.subNotes)){
            var durBadge = document.createElement('span');
            durBadge.className = 'b-dur-badge';
            durBadge.innerHTML = durInfo.svg || '';
            durBadge.title = durInfo.durName;
            rhythmHead.appendChild(durBadge);
          }
          cell.appendChild(rhythmHead);

          // 2. 오선지 음이름 (계이름) 또는 쉼표 기호 (한글 쉼표 대신 1박 옆에 있던 음표/쉼표 기호만 표시)
          var koEl = document.createElement('span');
          if (b.midi || (b.isSubdivided && b.subNotes)){
            koEl.className = 'b-ko-main';
            if (!b.isSubdivided && b.chordNotes && b.chordNotes.length > 2){
              koEl.textContent = b.chordNotes.map(function(c){ return c.ko; }).join('·');
            } else if (b.isSubdivided && b.subNotes){
              koEl.textContent = b.subNotes.map(function(s){
                if (s.tok === '-' || s.ko === '유지') return '-';
                if (s.chordNotes && s.chordNotes.length > 2) return s.chordNotes.map(function(c){ return c.ko; }).join('·');
                return s.ko;
              }).join(' · ');
            } else {
              koEl.textContent = b.ko;
            }
            cell.appendChild(koEl);

            // 3. 옥타브 위치 및 영문 음높이 서브 표기 (가온 C4, 중간 E4 등)
            var subEl = document.createElement('span');
            subEl.className = 'b-note-sub';
            if (!b.isSubdivided && b.chordNotes && b.chordNotes.length > 2){
              subEl.textContent = '화음 ' + b.chordNotes[0].en + '~' + b.en;
            } else if (b.isSubdivided && b.subNotes){
              subEl.textContent = b.subNotes.map(function(s){
                if (s.tok === '-' || s.en === '-') return '-';
                if (s.chordNotes && s.chordNotes.length > 2) return s.chordNotes.map(function(c){ return c.en; }).join('+');
                return s.en;
              }).join(' · ');
            } else {
              subEl.textContent = getOctaveLabel(b.midi) + ' ' + b.en;
            }
            cell.appendChild(subEl);
          } else {
            koEl.className = 'b-ko-main b-rest-sym';
            koEl.innerHTML = durInfo.svg || '';
            koEl.title = durInfo.durName;
            cell.appendChild(koEl);
          }

          cell.addEventListener('click', function(e){
            if (e.shiftKey) return;
            e.stopPropagation();
            curMeasureIdx = mIdx;
            curBeatIdx = bIdx;
            if (mIdx + 1 < appState.loopStart || mIdx + 1 > appState.loopEnd){
              appState.loopStart = mIdx + 1;
              appState.loopEnd = getMeasureCount(curSong);
              $('#loopStart').value = appState.loopStart;
              $('#loopEnd').value = appState.loopEnd;
              updateLoopClasses();
            }
            saveAppState();
            updateActiveCursor(mIdx, bIdx, !isPlaying);
          });

          beatsRow.appendChild(cell);
        });

        card.appendChild(beatsRow);
      }

      if (m.lyric){
        var lyr = document.createElement('div');
        lyr.className = 'm-lyric';
        lyr.textContent = m.lyric;
        card.appendChild(lyr);
      }

      card.addEventListener('click', function(e){
        if (e.shiftKey){
          appState.loopEnd = Math.max(appState.loopStart, mIdx + 1);
        } else {
          curMeasureIdx = mIdx;
          curBeatIdx = 0;
          if (mIdx + 1 < appState.loopStart || mIdx + 1 > appState.loopEnd){
            appState.loopStart = mIdx + 1;
            appState.loopEnd = getMeasureCount(curSong);
          }
        }
        $('#loopStart').value = appState.loopStart;
        $('#loopEnd').value = appState.loopEnd;
        saveAppState();
        updateLoopClasses();
        updateActiveCursor(curMeasureIdx, curBeatIdx, true);
      });

      grid.appendChild(card);
    });

    renderChordCards(chordsSet);
  }

  // ---------- 악보 렌더링: 2) 이미지 / PDF 악보 + 마디 그리드 매퍼 (B안 주력)
  function renderImageScore(){
    var img = $('#scoreImg');
    img.src = curSong.imageDataUrl;
    $('#pdfPageCtrl').hidden = !(curSong.pdfPages && curSong.pdfPages.length > 1);
    if (curSong.pdfPages && curSong.pdfPages.length > 1){
      $('#pdfPageTxt').textContent = (curSong.curPageIdx + 1) + ' / ' + curSong.pdfPages.length;
    }
    renderImageSystemsOverlay();
  }

  function renderImageSystemsOverlay(){
    var host = $('#systemsOverlay');
    host.textContent = '';
    if (!curSong || curSong.type !== 'image') return;

    var systems = curSong.systems || [];
    var globalBarNo = 1;
    var chordsSet = [];

    systems.forEach(function(sys, sysIdx){
      var box = document.createElement('div');
      box.className = 'sys-box' + (imgEditMode ? '' : ' playing-mode');
      box.dataset.sys = sysIdx;
      box.style.left = (sys.x * 100) + '%';
      box.style.top = (sys.y * 100) + '%';
      box.style.width = (sys.w * 100) + '%';
      box.style.height = (sys.h * 100) + '%';

      if (imgEditMode){
        var lbl = document.createElement('div');
        lbl.className = 'sys-label';

        var grip = document.createElement('span');
        grip.className = 'sys-drag-grip';
        grip.dataset.action = 'move-sys';
        grip.dataset.sys = sysIdx;
        grip.title = '드래그하여 이 줄 전체 위치를 이동합니다';
        grip.textContent = ':: 이동 · ' + (sysIdx + 1) + '번째 줄 (' + sys.bars.length + '마디)';
        lbl.appendChild(grip);

        var minusB = document.createElement('button');
        minusB.type = 'button';
        minusB.textContent = '-마디';
        minusB.style.cssText = 'border:0;background:rgba(0,0,0,.35);color:#fff;border-radius:3px;padding:1px 6px;font-size:11px';
        minusB.addEventListener('click', function(e){
          e.stopPropagation();
          if (sys.bars.length > 1){ sys.bars.pop(); syncAfterImageGridChange(); }
        });

        var plusB = document.createElement('button');
        plusB.type = 'button';
        plusB.textContent = '+마디';
        plusB.style.cssText = 'border:0;background:rgba(0,0,0,.35);color:#fff;border-radius:3px;padding:1px 6px;font-size:11px';
        plusB.addEventListener('click', function(e){
          e.stopPropagation();
          if (sys.bars.length < 10){ sys.bars.push({ chord: 'C', note: '', memo: '', w: 1 }); syncAfterImageGridChange(); }
        });

        var eqB = document.createElement('button');
        eqB.type = 'button';
        eqB.textContent = '균등 간격';
        eqB.title = '마디 간격을 똑같이 초기화합니다';
        eqB.style.cssText = 'border:0;background:rgba(0,0,0,.35);color:#fff;border-radius:3px;padding:1px 6px;font-size:11px';
        eqB.addEventListener('click', function(e){
          e.stopPropagation();
          sys.bars.forEach(function(b){ b.w = 1; });
          syncAfterImageGridChange();
        });

        var delSys = document.createElement('button');
        delSys.type = 'button';
        delSys.textContent = '줄 삭제';
        delSys.style.cssText = 'border:0;background:#c03f2a;color:#fff;border-radius:3px;padding:1px 6px;font-size:11px';
        delSys.addEventListener('click', function(e){
          e.stopPropagation();
          curSong.systems.splice(sysIdx, 1);
          syncAfterImageGridChange();
        });

        lbl.appendChild(minusB);
        lbl.appendChild(plusB);
        lbl.appendChild(eqB);
        lbl.appendChild(delSys);
        box.appendChild(lbl);

        // 좌/우/하/우하단 크기 조절 핸들
        ['w', 'e', 's', 'se'].forEach(function(dir){
          var hd = document.createElement('div');
          hd.className = 'sys-resize-handle sys-resize-' + dir;
          hd.dataset.action = 'resize-' + dir;
          hd.dataset.sys = sysIdx;
          hd.title = '드래그하여 줄 영역 크기를 조절합니다';
          box.appendChild(hd);
        });
      }

      sys.bars.forEach(function(bar, barIdx){
        if (typeof bar.w !== 'number' || bar.w <= 0) bar.w = 1;
        var gIdx = globalBarNo - 1;
        if (bar.chord && chordsSet.indexOf(bar.chord) < 0) chordsSet.push(bar.chord);

        var cell = document.createElement('div');
        cell.className = 'img-bar-cell';
        cell.style.flexGrow = String(bar.w);
        cell.dataset.m = gIdx;
        cell.dataset.sys = sysIdx;
        cell.dataset.bar = barIdx;
        if (globalBarNo >= appState.loopStart && globalBarNo <= appState.loopEnd){
          cell.classList.add('in-loop');
        }

        var top = document.createElement('div');
        top.className = 'img-bar-top';
        var noSpan = document.createElement('span');
        noSpan.className = 'img-bar-no';
        noSpan.textContent = globalBarNo;
        top.appendChild(noSpan);

        if (bar.chord){
          var chSpan = document.createElement('span');
          chSpan.className = 'img-bar-chord';
          chSpan.textContent = bar.chord;
          top.appendChild(chSpan);
        }
        cell.appendChild(top);

        if (bar.memo){
          var memoSpan = document.createElement('div');
          memoSpan.className = 'img-bar-memo';
          memoSpan.textContent = bar.memo;
          cell.appendChild(memoSpan);
        }

        // 마디 사이 경계선 좌우 이동 핸들 (마지막 마디 제외)
        if (imgEditMode && barIdx < sys.bars.length - 1){
          var divGrip = document.createElement('div');
          divGrip.className = 'bar-divider-grip';
          divGrip.dataset.action = 'move-divider';
          divGrip.dataset.sys = sysIdx;
          divGrip.dataset.bar = barIdx;
          divGrip.title = '좌우로 드래그하여 마디 경계선을 옮깁니다';
          cell.appendChild(divGrip);
        }

        cell.addEventListener('click', (function(targetGlobalIdx, sI, bI){
          return function(e){
            if (e.target.closest('.bar-divider-grip')) return;
            e.stopPropagation();
            selectedImgBar = { sysIdx: sI, barIdx: bI, globalIdx: targetGlobalIdx };
            if (e.shiftKey){
              appState.loopEnd = Math.max(appState.loopStart, targetGlobalIdx + 1);
              $('#loopEnd').value = appState.loopEnd;
            } else {
              curMeasureIdx = targetGlobalIdx;
              curBeatIdx = 0;
            }
            updateLoopClasses();
            updateActiveCursor(curMeasureIdx, 0, true);
          };
        })(gIdx, sysIdx, barIdx));

        cell.addEventListener('dblclick', (function(sI, bI, gI){
          return function(e){
            if (e.target.closest('.bar-divider-grip')) return;
            e.stopPropagation();
            selectedImgBar = { sysIdx: sI, barIdx: bI, globalIdx: gI };
            openBarEditModal();
          };
        })(sysIdx, barIdx, gIdx));

        box.appendChild(cell);
        globalBarNo++;
      });

      host.appendChild(box);
    });

    renderChordCards(chordsSet.length ? chordsSet : ['C', 'G7', 'F', 'Am']);
  }

  function syncAfterImageGridChange(){
    var total = getMeasureCount(curSong);
    appState.loopStart = 1;
    appState.loopEnd = total;
    $('#loopStart').max = total;
    $('#loopEnd').max = total;
    $('#loopStart').value = 1;
    $('#loopEnd').value = total;
    dbSaveSong(curSong);
    renderImageSystemsOverlay();
  }

  // 이미지 위에서 줄 이동 / 크기 조절 / 마디 경계선 드래그 / 새 줄 그리기 통합 처리
  (function initImageDragMapper(){
    var cont = $('#imgContainer');
    var previewBox = null;
    var activeOp = null;

    function relPos(e){
      var rect = cont.getBoundingClientRect();
      var cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
      var cy = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);
      return {
        x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height)),
        pxW: rect.width,
        pxH: rect.height
      };
    }

    cont.addEventListener('pointerdown', function(e){
      if (!imgEditMode || !curSong || curSong.type !== 'image') return;
      var actEl = e.target.closest('[data-action]');
      var p = relPos(e);

      if (actEl){
        e.preventDefault();
        e.stopPropagation();
        var act = actEl.dataset.action;
        var sIdx = Number(actEl.dataset.sys);
        var sys = curSong.systems[sIdx];
        if (!sys) return;

        if (act === 'move-divider'){
          var bIdx = Number(actEl.dataset.bar);
          var totalW = sys.bars.reduce(function(sum, b){ return sum + (b.w || 1); }, 0);
          activeOp = {
            type: 'divider',
            sys: sys,
            sIdx: sIdx,
            bIdx: bIdx,
            startX: p.x,
            sysW: sys.w,
            totalW: totalW,
            wLeft0: sys.bars[bIdx].w || 1,
            wRight0: sys.bars[bIdx + 1].w || 1
          };
        } else {
          activeOp = {
            type: act,
            sys: sys,
            sIdx: sIdx,
            startX: p.x,
            startY: p.y,
            x0: sys.x,
            y0: sys.y,
            w0: sys.w,
            h0: sys.h
          };
        }
        return;
      }

      if (e.target.closest('.sys-box')) return;
      dragCreate = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      previewBox = document.createElement('div');
      previewBox.className = 'sys-box';
      $('#systemsOverlay').appendChild(previewBox);
    });

    window.addEventListener('pointermove', function(e){
      if (activeOp){
        e.preventDefault();
        var p = relPos(e);
        var dx = p.x - activeOp.startX;
        var dy = p.y - activeOp.startY;
        var sys = activeOp.sys;
        var boxEl = $('#systemsOverlay .sys-box[data-sys="' + activeOp.sIdx + '"]');

        if (activeOp.type === 'move-sys'){
          sys.x = Math.max(0, Math.min(1 - sys.w, +(activeOp.x0 + dx).toFixed(4)));
          sys.y = Math.max(0.02, Math.min(1 - sys.h, +(activeOp.y0 + dy).toFixed(4)));
          if (boxEl){
            boxEl.style.left = (sys.x * 100) + '%';
            boxEl.style.top = (sys.y * 100) + '%';
          }
        } else if (activeOp.type === 'resize-e'){
          sys.w = Math.max(0.10, Math.min(1 - sys.x, +(activeOp.w0 + dx).toFixed(4)));
          if (boxEl) boxEl.style.width = (sys.w * 100) + '%';
        } else if (activeOp.type === 'resize-w'){
          var maxRight = activeOp.x0 + activeOp.w0 - 0.10;
          var newX = Math.max(0, Math.min(maxRight, +(activeOp.x0 + dx).toFixed(4)));
          sys.w = +(activeOp.w0 + (activeOp.x0 - newX)).toFixed(4);
          sys.x = newX;
          if (boxEl){
            boxEl.style.left = (sys.x * 100) + '%';
            boxEl.style.width = (sys.w * 100) + '%';
          }
        } else if (activeOp.type === 'resize-s'){
          sys.h = Math.max(0.05, Math.min(1 - sys.y, +(activeOp.h0 + dy).toFixed(4)));
          if (boxEl) boxEl.style.height = (sys.h * 100) + '%';
        } else if (activeOp.type === 'resize-se'){
          sys.w = Math.max(0.10, Math.min(1 - sys.x, +(activeOp.w0 + dx).toFixed(4)));
          sys.h = Math.max(0.05, Math.min(1 - sys.y, +(activeOp.h0 + dy).toFixed(4)));
          if (boxEl){
            boxEl.style.width = (sys.w * 100) + '%';
            boxEl.style.height = (sys.h * 100) + '%';
          }
        } else if (activeOp.type === 'divider'){
          var deltaWeight = (dx / activeOp.sysW) * activeOp.totalW;
          var pairSum = activeOp.wLeft0 + activeOp.wRight0;
          var newLeft = Math.max(0.15, Math.min(pairSum - 0.15, activeOp.wLeft0 + deltaWeight));
          var newRight = pairSum - newLeft;
          sys.bars[activeOp.bIdx].w = +newLeft.toFixed(4);
          sys.bars[activeOp.bIdx + 1].w = +newRight.toFixed(4);
          if (boxEl){
            var cells = boxEl.querySelectorAll('.img-bar-cell');
            if (cells[activeOp.bIdx]) cells[activeOp.bIdx].style.flexGrow = String(sys.bars[activeOp.bIdx].w);
            if (cells[activeOp.bIdx + 1]) cells[activeOp.bIdx + 1].style.flexGrow = String(sys.bars[activeOp.bIdx + 1].w);
          }
        }
        return;
      }

      if (!dragCreate || !previewBox) return;
      var p2 = relPos(e);
      dragCreate.x1 = p2.x;
      dragCreate.y1 = p2.y;
      var x = Math.min(dragCreate.x0, dragCreate.x1);
      var y = Math.min(dragCreate.y0, dragCreate.y1);
      var w = Math.abs(dragCreate.x1 - dragCreate.x0);
      var h = Math.abs(dragCreate.y1 - dragCreate.y0);
      previewBox.style.left = (x * 100) + '%';
      previewBox.style.top = (y * 100) + '%';
      previewBox.style.width = (w * 100) + '%';
      previewBox.style.height = (h * 100) + '%';
    });

    window.addEventListener('pointerup', function(){
      if (activeOp){
        activeOp = null;
        dbSaveSong(curSong);
        renderImageSystemsOverlay();
        return;
      }
      if (!dragCreate) return;
      var x = Math.min(dragCreate.x0, dragCreate.x1);
      var y = Math.min(dragCreate.y0, dragCreate.y1);
      var w = Math.abs(dragCreate.x1 - dragCreate.x0);
      var h = Math.abs(dragCreate.y1 - dragCreate.y0);
      dragCreate = null;
      if (previewBox){ previewBox.remove(); previewBox = null; }
      if (w > 0.12 && h > 0.04){
        curSong.systems.push({
          x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4),
          bars: [
            { chord: 'C', note: 'C4', memo: '', w: 1 },
            { chord: 'G7', note: 'D4', memo: '', w: 1 },
            { chord: 'C', note: 'E4', memo: '', w: 1 },
            { chord: 'C', note: 'C4', memo: '', w: 1 }
          ]
        });
        syncAfterImageGridChange();
      }
    });
  })();

  // ---------- 활성 마디/박자 커서 이동 및 지판 동기화
  function updateLoopClasses(){
    $$('#measuresGrid .measure-card, #systemsOverlay .img-bar-cell').forEach(function(el){
      var m = Number(el.dataset.m) + 1;
      el.classList.toggle('in-loop', m >= appState.loopStart && m <= appState.loopEnd);
    });
  }

  function getFlatImageBar(globalIdx){
    if (!curSong || curSong.type !== 'image') return null;
    var idx = 0;
    for (var s = 0; s < curSong.systems.length; s++){
      var bars = curSong.systems[s].bars;
      for (var b = 0; b < bars.length; b++){
        if (idx === globalIdx) return bars[b];
        idx++;
      }
    }
    return null;
  }

  // 현재 연주 중인 마디를 스크롤 창 상단(~16%)에 배치하여 아래쪽 다음 줄들을 항상 미리 보여주고,
  // 줄의 마지막 마디 중반을 지나면 다음 줄로 살짝 미리 선행 스크롤합니다.
  function scrollScoreLookAhead(containerEl, activeEl, nextEl, beatRatio){
    if (!containerEl || !activeEl) return;
    var cRect = containerEl.getBoundingClientRect();
    if (!cRect.height) return;
    var aRect = activeEl.getBoundingClientRect();
    var activeTopInScroll = (aRect.top - cRect.top) + containerEl.scrollTop;

    // 상단 여백을 약 15%(최대 44px)만 남겨 아래쪽 85% 영역에 다음 2~3줄이 항상 보이게 유지
    // 콤팩트 모드에서는 2줄(2단) 악보가 잘리지 않고 온전히 다 들어오도록 상단 오프셋을 2px로 고정
    var isCompact = document.body.classList.contains('practice-compact');
    var topAnchor = isCompact ? 2 : Math.min(44, Math.max(10, cRect.height * 0.15));
    var targetScroll = activeTopInScroll - topAnchor;

    // 다음 마디가 아래 줄(개행)에 있고, 현재 마디의 절반 이상 진행되었을 때 미리 선행 스크롤 (콤팩트 모드에서는 마디 행 점프 시에만 정렬)
    if (nextEl && !isCompact){
      var nRect = nextEl.getBoundingClientRect();
      var rowDelta = nRect.top - aRect.top;
      if (rowDelta > aRect.height * 0.5 && beatRatio >= 0.4){
        var preProgress = Math.min(1, (beatRatio - 0.4) / 0.6);
        // 현재 마디가 상단 밖으로 잘리지 않는 선(최대 rowDelta의 42%)에서 미리 아래로 스크롤
        targetScroll += Math.min(topAnchor - 4, rowDelta * 0.42) * preProgress;
      }
    }

    targetScroll = Math.max(0, targetScroll);
    if (Math.abs(containerEl.scrollTop - targetScroll) > 4){
      containerEl.scrollTo({ top: targetScroll, behavior: 'smooth' });
    }
  }

  function updateActiveCursor(mIdx, bIdx, playPreviewSound, beatFraction){
    $$('.active-bar').forEach(function(el){ el.classList.remove('active-bar'); });
    $$('.active-beat').forEach(function(el){ el.classList.remove('active-beat'); });
    $$('.img-playhead').forEach(function(el){ el.remove(); });

    if (!curSong) return;
    var bpb = Math.max(1, Number(appState.beats) || 4);
    var prog = beatFraction != null ? beatFraction : (bIdx / bpb);

    if (curSong.type === 'structured'){
      var m = curSong.measures[mIdx];
      if (!m) return;
      var card = $('#measuresGrid .measure-card[data-m="' + mIdx + '"]');
      var nextCard = $('#measuresGrid .measure-card[data-m="' + (mIdx + 1) + '"]');
      if (card){
        card.classList.add('active-bar');
        scrollScoreLookAhead($('#structuredScoreWrap'), card, nextCard, prog);
      }
      var cell = $('#measuresGrid .beat-cell[data-m="' + mIdx + '"][data-b="' + bIdx + '"]');
      if (cell) cell.classList.add('active-beat');
      if ($('#compactStatusBadge')){
        $('#compactStatusBadge').textContent = appState.bpm + ' BPM · ' + (mIdx + 1) + '마디 ' + (bIdx + 1) + '박' + (m.chord ? ' [' + m.chord + ']' : '');
      }

      var beatObj = m.beats[bIdx];
      var effBass = resolveEffectiveBass(m.chord, beatObj, bIdx);
      var targetForFb = (beatObj && beatObj.isSubdivided && beatObj.subNotes)
        ? (beatObj.subNotes.find(function(s){ return s.midi != null; }) || beatObj)
        : beatObj;
      highlightFretboard(m.chord, targetForFb, false, m.autoChord, bIdx);
      if (playPreviewSound){
        ensureAudioCtx();
        var nowT = actx.currentTime;
        var songCapo = getSongCapo(curSong);
        if (beatObj && !beatObj.isSubdivided && beatObj.chordNotes && beatObj.chordNotes.length > 2){
          beatObj.chordNotes.forEach(function(cn, idx){
            var arpTime = nowT + (idx * 0.028);
            var isBass = (idx === 0);
            playGuitarNote(soundingMidi(cn.midi, songCapo), isBass ? 1.5 : 1.2, arpTime, isBass ? 1.12 : 0.95, null, cn.str);
          });
        } else if (beatObj && beatObj.isSubdivided && beatObj.subNotes && beatObj.subNotes.length > 1){
          scheduleSubdividedGuide(beatObj, {
            chordName: m.chord,
            beatIndex: bIdx,
            startTime: nowT,
            subStep: 0.22,
            capo: songCapo,
            beatsPerBar: curSong.beats,
            preview: true
          });
        } else {
          var hasB = !!(effBass && effBass.midi);
          if (hasB) playGuitarNote(soundingMidi(effBass.midi, songCapo), 1.25, nowT, 1.12, null, effBass.str);
          if (beatObj && beatObj.midi){
            var pvArt = beatObj.articulation;
            var pvScale = pvArt === 'apoyando' ? 1.15 : (pvArt === 'tirando' ? 0.65 : 1.0);
            var pvDur = pvArt === 'apoyando' ? 1.05 : 0.80;
            playGuitarNote(soundingMidi(beatObj.midi, songCapo), pvDur, nowT + (hasB ? 0.018 : 0), pvScale, pvArt, beatObj.str);
          }
        }
      }
    } else {
      var imgCell = $('#systemsOverlay .img-bar-cell[data-m="' + mIdx + '"]');
      var nextImgCell = $('#systemsOverlay .img-bar-cell[data-m="' + (mIdx + 1) + '"]');
      if (imgCell){
        imgCell.classList.add('active-bar');
        var ph = document.createElement('div');
        ph.className = 'img-playhead';
        ph.style.left = Math.min(98, Math.max(0, prog * 100)) + '%';
        imgCell.appendChild(ph);
        scrollScoreLookAhead($('#imgStageScroll'), imgCell, nextImgCell, prog);
      }
      var barData = getFlatImageBar(mIdx) || { chord: 'C', note: 'C4' };
      var parsedNote = parseNoteToken(barData.note || 'C4', 0);
      highlightFretboard(barData.chord || 'C', parsedNote, false, false, bIdx);
      if (playPreviewSound && parsedNote && parsedNote.midi){
        var songCapo = getSongCapo(curSong);
        playGuitarNote(soundingMidi(parsedNote.midi, songCapo), 0.75, null, null, null, parsedNote.pos && parsedNote.pos.str);
      }
    }
  }

  // ---------- 메트로놈 재생 루프 (카운트인 + 마디 진행 + 구간 반복 + 자동 가속)
  async function startPractice(){
    if (isPlaying || isStarting) return;
    var startToken = ++practiceStartToken;
    ensureAudioCtx();
    if (appState.micScoring){
      isStarting = true;
      syncCompactPlayButtons();
      try {
        await ensureMicWorklet();
      } catch (e){
        // 마이크가 없어도 메트로놈+악보 커서 연습은 정상 동작하도록 허용
        if (startToken === practiceStartToken) $('#liveNoteKo').textContent = '마이크 없음 (뷰어 모드)';
      } finally {
        if (startToken === practiceStartToken){
          isStarting = false;
          syncCompactPlayButtons();
        }
      }
    } else {
      $('#liveNoteKo').textContent = '마이크 꺼짐 (채점 안 함)';
    }
    if (startToken !== practiceStartToken){
      releaseMic();
      return;
    }
    warmKsCache(curSong);

    // 이전 판정 흔적 초기화
    $$('#measuresGrid .beat-cell').forEach(function(c){ delete c.dataset.judge; });

    var bpb = appState.beats;
    var spb = 60 / appState.bpm;
    var startM = Math.max(0, appState.loopStart - 1);
    var endM = Math.min(getMeasureCount(curSong) - 1, appState.loopEnd - 1);

    if (curMeasureIdx < startM || curMeasureIdx > endM){
      curMeasureIdx = startM;
      curBeatIdx = 0;
    } else {
      curBeatIdx = Math.max(0, Math.min(bpb - 1, curBeatIdx || 0));
    }

    playSession = {
      startTime: actx.currentTime + 0.15,
      measureStartTime: actx.currentTime + 0.15 + bpb * spb,
      nextBeatTime: actx.currentTime + 0.15,
      spb: spb,
      bpb: bpb,
      inCountIn: true,
      countInBeat: 0,
      mIdx: curMeasureIdx,
      bIdx: curBeatIdx,
      loopCompleted: 0,
      hits: [],
      lastOnsetObj: null
    };

    isPlaying = true;
    syncCompactPlayButtons();
    $('#loopCountBadge').textContent = '0회 완주';
  }

  function syncCompactPlayButtons(){
    var active = isPlaying || isStarting;
    if ($('#playBtn')){
      $('#playBtn').textContent = isPlaying ? '연습 정지' : (isStarting ? '연습 취소' : '연습 시작');
      $('#playBtn').classList.toggle('running', active);
    }
    if ($('#compactPlayBtn')){
      $('#compactPlayBtn').textContent = isPlaying ? '⏹ 정지' : (isStarting ? '⏹ 취소' : '▶ 시작');
      $('#compactPlayBtn').title = isPlaying ? '연습 정지 (단축키: Space)' : (isStarting ? '연습 시작 취소 (단축키: Space)' : '연습 시작 (단축키: Space)');
      $('#compactPlayBtn').classList.toggle('danger', active);
      $('#compactPlayBtn').classList.toggle('primary', !active);
      $('#compactPlayBtn').classList.toggle('running', active);
    }
  }

  function setCompactPractice(active){
    appState.isCompactPractice = !!active;
    document.body.classList.toggle('practice-compact', appState.isCompactPractice);
    if ($('#toggleCompactBtn')){
      $('#toggleCompactBtn').textContent = appState.isCompactPractice ? '일반 뷰' : '콤팩트 뷰';
      $('#toggleCompactBtn').title = appState.isCompactPractice ? '모든 악보 정보 및 설정 보기 (단축키: P / Esc)' : '악보 2줄과 실시간 지판만 보는 콤팩트 집중 모드 (단축키: P / Esc)';
      $('#toggleCompactBtn').classList.toggle('active', appState.isCompactPractice);
    }
    syncCompactPlayButtons();
    syncScoreModeUI();
    if (appState.isCompactPractice && curSong){
      if (curSong.type === 'structured'){
        var card = $('#measuresGrid .measure-card[data-m="' + curMeasureIdx + '"]');
        var nextCard = $('#measuresGrid .measure-card[data-m="' + (curMeasureIdx + 1) + '"]');
        if (card) scrollScoreLookAhead($('#structuredScoreWrap'), card, nextCard, 0);
      } else {
        var imgCell = $('#systemsOverlay .img-bar-cell[data-m="' + curMeasureIdx + '"]');
        var nextImgCell = $('#systemsOverlay .img-bar-cell[data-m="' + (curMeasureIdx + 1) + '"]');
        if (imgCell) scrollScoreLookAhead($('#imgStageScroll'), imgCell, nextImgCell, 0);
      }
    }
  }

  function stopPractice(saveRecord){
    practiceStartToken++;
    isStarting = false;
    if (!isPlaying){
      syncCompactPlayButtons();
      releaseMic();
      return;
    }
    isPlaying = false;
    syncCompactPlayButtons();
    $('#phaseTxt').textContent = '정지됨 · 마디를 클릭해 이어서 연습하세요';
    setLeds(-1);

    if (saveRecord && playSession && playSession.hits.length >= 2){
      var hits = playSession.hits;
      var sum = 0, okCnt = 0;
      hits.forEach(function(h){
        sum += h.errMs;
        if (Math.abs(h.errMs) <= 30) okCnt++;
      });
      var mean = sum / hits.length;
      var okRate = okCnt / hits.length;
      historyList.unshift({
        at: Date.now(),
        songTitle: curSong.title,
        range: appState.loopStart + '~' + appState.loopEnd + '마디',
        bpm: appState.bpm,
        n: hits.length,
        mean: mean,
        okRate: okRate
      });
      historyList = historyList.slice(0, 40);
      ls.set('gs.history', historyList);
      renderHistoryTable();
    }
    saveAppState();
    playSession = null;
    releaseMic();
  }

  function schedulerTick(){
    if (!isPlaying || !playSession || !actx) return;
    var s = playSession;
    var now = actx.currentTime;

    while (!s.endScheduled && s.nextBeatTime < now + 0.08){
      var t = s.nextBeatTime;
      if (s.inCountIn){
        scheduleMetronomeClick(t, s.countInBeat === 0, s.bpb === 9 && s.countInBeat % 3 !== 0);
        s.countInBeat++;
        s.nextBeatTime += s.spb;
        if (s.countInBeat >= s.bpb){
          s.inCountIn = false;
          s.measureStartTime = s.nextBeatTime;
        }
      } else {
        var isFirstBeat = s.bIdx === 0;
        var isTripletSub = (s.bpb === 9 && s.bIdx % 3 !== 0);
        scheduleMetronomeClick(t, isFirstBeat, isTripletSub);
        var m = curSong.type === 'structured' ? curSong.measures[s.mIdx] : null;

        // 가이드 음 재생 (2성부·3성부 엄지 베이스 + 아포얀도 주선율 + 티란도 내성 아르페지오 다이나믹 재생 지원)
        if (appState.guideSound){
          var songCapo = getSongCapo(curSong);
          if (curSong.type === 'structured'){
            if (m && m.beats[s.bIdx]){
              var bObj = m.beats[s.bIdx];
              if (bObj.isSubdivided && bObj.subNotes && bObj.subNotes.length > 1){
                scheduleSubdividedGuide(bObj, {
                  chordName: m.chord,
                  beatIndex: s.bIdx,
                  startTime: t,
                  subStep: s.spb / bObj.subNotes.length,
                  capo: songCapo,
                  beatsPerBar: s.bpb,
                  preview: false
                });
              } else if (bObj.chordNotes && bObj.chordNotes.length > 2){
                // 3음 이상 화음 / 롤 아르페지오 (상행 화음 스트럼)
                var rollStep = s.spb < 0.4 ? 0.018 : 0.028;
                bObj.chordNotes.forEach(function(cn, idx){
                  var nTime = t + (idx * rollStep);
                  var isBass = (idx === 0);
                  var dur = isBass ? (s.spb * 3.5) : (s.spb * 2.5);
                  var gain = isBass ? 1.12 : (idx === bObj.chordNotes.length - 1 ? 1.05 : 0.85);
                  playGuitarNote(soundingMidi(cn.midi, songCapo), dur, nTime, gain, cn.articulation, cn.str);
                });
              } else {
                var effB = resolveEffectiveBass(m.chord, bObj, s.bIdx);
                var hasB = !!(effB && effB.midi);
                if (hasB){
                  var bassDur = (s.bpb === 9 || s.bpb === 6) ? (s.spb * 8.2) : (s.spb * 2.2);
                  playGuitarNote(soundingMidi(effB.midi, songCapo), bassDur, t, 1.12, null, effB.str);
                }
                if (bObj.midi){
                  // 엄지(p) 베이스와 멜로디(a/m/i) 동시 탄현 미세 롤(Roll): 빠른 템포(BPM 150+)에서는 롤을 4ms로 축소하여 어택 타이밍이 밀리지 않도록 최적화
                  var rollOffset = hasB ? (s.spb < 0.4 ? 0.004 : 0.014) : 0;
                  var melTime = t + rollOffset;
                  var artic = bObj.articulation;
                  var isApoyando = (artic === 'apoyando');
                  var isTirando = (artic === 'tirando');
                  var melDur = isApoyando ? (s.spb * 3.1) : (isTirando ? (s.spb * 1.5) : (s.spb * 1.15));
                  var melGain = isApoyando ? 1.16 : (isTirando ? 0.62 : 1.0);
                  playGuitarNote(soundingMidi(bObj.midi, songCapo), melDur, melTime, melGain, artic, bObj.str);
                }
              }
            }
          } else if (isFirstBeat){
            var bar = getFlatImageBar(s.mIdx);
            if (bar && bar.note){
              var pn = parseNoteToken(bar.note, 0);
              if (pn && pn.midi) playGuitarNote(soundingMidi(pn.midi, songCapo), s.spb * 1.2, t, 1.0, null, pn.pos && pn.pos.str);
            }
          }
        }

        // UI 동기화 예약 (WebAudio 하드웨어 버퍼 출력 지연 baseLatency + outputLatency + 블루투스 오프셋 보정)
        (function(mI, bI, loopCnt, beatTime, spbVal, curBObj, curM){
          var hwLat = (actx.outputLatency || 0.025) + (actx.baseLatency || 0.010) + ((appState.audioOffsetMs || 0) / 1000);
          var delay = Math.max(0, (beatTime + hwLat - actx.currentTime) * 1000);
          setTimeout(function(){
            if (playSession !== s) return;
            curMeasureIdx = mI;
            curBeatIdx = bI;
            setLeds(bI);
            $('#phaseTxt').textContent = (mI + 1) + '마디 · ' + (bI + 1) + '/' + appState.beats + '박 진행 중 (' + appState.bpm + ' BPM)';
            updateActiveCursor(mI, bI, false, bI / appState.beats);
            $('#loopCountBadge').textContent = loopCnt + '회 완주';
          }, delay);

          if (curBObj && curBObj.isSubdivided && curBObj.subNotes && curBObj.subNotes.length > 1){
            var numSubs = curBObj.subNotes.length;
            var subStepMs = (spbVal / numSubs) * 1000;
            curBObj.subNotes.forEach(function(sn, sIdx){
              if (sIdx > 0 && sn.midi && sn.tok !== '-'){
                var subDelay = Math.max(0, delay + (sIdx * subStepMs));
                setTimeout(function(){
                  if (playSession !== s) return;
                  if (curMeasureIdx === mI && curBeatIdx === bI){
                    highlightFretboard(curM ? curM.chord : null, sn, false, curM ? curM.autoChord : false, bI);
                  }
                }, subDelay);
              }
            });
          }
        })(s.mIdx, s.bIdx, s.loopCompleted, t, s.spb, m && m.beats ? m.beats[s.bIdx] : null, m);

        // 다음 박자/마디 이동
        s.bIdx++;
        s.nextBeatTime += s.spb;
        if (s.bIdx >= s.bpb){
          s.bIdx = 0;
          s.mIdx++;
          s.measureStartTime = s.nextBeatTime;

          var endM = Math.min(getMeasureCount(curSong) - 1, appState.loopEnd - 1);
          var startM = Math.max(0, appState.loopStart - 1);

          if (s.mIdx > endM){
            s.loopCompleted++;
            if (appState.loopEnable){
              s.mIdx = startM;
              // Speed Trainer: 2회 완주마다 +3 BPM 가속
              if (appState.speedTrainer && s.loopCompleted % 2 === 0 && appState.bpm < 180){
                appState.bpm = Math.min(180, appState.bpm + 3);
                s.spb = 60 / appState.bpm;
                syncConsoleUI();
              }
            } else {
              s.endScheduled = true;
              var endHwLat = (actx.outputLatency || 0.025) + (actx.baseLatency || 0.010) + ((appState.audioOffsetMs || 0) / 1000);
              var endDelay = Math.max(0, (s.nextBeatTime + endHwLat - actx.currentTime) * 1000);
              setTimeout(function(){
                if (playSession === s) stopPractice(true);
              }, endDelay);
              return;
            }
          }
        }
      }
    }

    // 이미지 악보일 때 부드러운 Playhead 이동 (하드웨어 레이턴시 hwLat + 블루투스 오프셋 보정)
    if (curSong && curSong.type === 'image' && !s.inCountIn){
      var hwLat = (actx.outputLatency || 0.025) + (actx.baseLatency || 0.010) + ((appState.audioOffsetMs || 0) / 1000);
      var audioNow = now - hwLat;
      var elapsedInBar = audioNow - (s.measureStartTime - s.spb * s.bpb);
      var barDur = s.spb * s.bpb;
      var frac = ((audioNow - (s.nextBeatTime - s.spb)) / s.spb + ((s.bIdx + s.bpb - 1) % s.bpb)) / s.bpb;
      var ph = $('#systemsOverlay .img-playhead');
      if (ph && isFinite(frac)){
        ph.style.left = Math.min(98, Math.max(0, frac * 100)) + '%';
      }
    }
  }

  setInterval(schedulerTick, 25);

  function frameLoop(){
    requestAnimationFrame(frameLoop);
    micLevel *= 0.86;
    var pct = Math.min(100, Math.max(0, micLevel * 320));
    $('#micFill').style.width = pct + '%';
  }
  requestAnimationFrame(frameLoop);

  // ---------- 콘솔 UI 바인딩
  function buildLeds(){
    var box = $('#leds');
    box.textContent = '';
    for (var i = 0; i < appState.beats; i++){
      var sp = document.createElement('span');
      sp.className = 'led';
      box.appendChild(sp);
    }
  }
  function setLeds(activeIdx){
    var ch = $('#leds').children;
    for (var i = 0; i < ch.length; i++){
      var on = i === activeIdx;
      ch[i].classList.toggle('on', on);
      ch[i].classList.toggle('accent', on && i === 0);
    }
  }

  function syncConsoleUI(){
    $('#bpmNum').textContent = appState.bpm;
    $('#bpmRange').value = appState.bpm;
    $('#tempoName').textContent = appState.beats === 9
      ? ('3/4 환산 ' + Math.round(appState.bpm / 3) + ' BPM')
      : (appState.beats === 8
        ? ('4/4 환산 ' + Math.round(appState.bpm / 2) + ' BPM')
        : tempoName(appState.bpm));
    $('#beatsSelect').value = String(appState.beats);
    $('#volRange').value = Math.round(appState.vol * 100);
    $('#loopEnable').checked = appState.loopEnable;
    $('#speedTrainerChk').checked = appState.speedTrainer;
    $('#guideSoundBtn').setAttribute('aria-pressed', String(appState.guideSound));
    $('#guideSoundBtn').textContent = appState.guideSound ? '기타 시뮬레이션: 켜짐' : '기타 시뮬레이션: 꺼짐 (메트로놈만)';
    var isKs = appState.synthEngine !== 'classic';
    $('#engineBtn').setAttribute('data-active', String(isKs));
    $('#engineBtn').textContent = isKs ? '물리음원' : '기존음원';
    $('#engineBtn').title = isKs
      ? '물리 모델(Karplus-Strong) 나일론 현 음원 사용 중 (클릭하면 기존 합성음과 비교)'
      : '기존 합성음(삼각파+필터) 사용 중 (클릭하면 물리 모델 음원으로 전환)';
    $('#micScoreBtn').setAttribute('data-active', String(appState.micScoring));
    $('#micScoreBtn').textContent = appState.micScoring ? '마이크 채점' : '마이크 꺼짐';
    $('#micScoreBtn').title = appState.micScoring
      ? '연습 중 마이크로 정박·음정을 채점합니다 (클릭하면 끔 · 블루투스 이어폰만 쓸 때 끄면 재생 음질이 유지돼요)'
      : '마이크를 쓰지 않고 메트로놈과 악보 커서만으로 연습합니다 (클릭하면 채점 켬)';
    if ($('#toggleFxBtn')){
      var isFx = !!appState.acousticFx;
      $('#toggleFxBtn').setAttribute('data-active', String(isFx));
      $('#toggleFxBtn').textContent = isFx ? '콘서트홀' : '드라이';
      $('#toggleFxBtn').title = isFx
        ? '콘서트홀 풍성 음향 켜짐 (클릭 또는 F로 또렷한 드라이 톤 전환)'
        : '또렷한 드라이 톤 켜짐 (클릭 또는 F로 풍성한 콘서트홀 전환)';
    }
    var btTxt = (appState.audioOffsetMs > 0) ? (' · BT +' + appState.audioOffsetMs + 'ms') : '';
    $('#calibBadge').textContent = (calib.calibrated ? Math.round(calib.lat * 1000) + 'ms' : '기본 45ms') + btTxt;
    var defBpm = curSong ? (Number(curSong.bpm) || 64) : 64;
    if ($('#defaultBpmTxt')) $('#defaultBpmTxt').textContent = defBpm;
    if ($('#bpmResetBtn')){
      var isDiff = (appState.bpm !== defBpm);
      $('#bpmResetBtn').classList.toggle('active', isDiff);
      $('#bpmResetBtn').textContent = '기본 BPM (' + defBpm + ')';
      $('#bpmResetBtn').title = '이 악보의 기본 권장 BPM(' + defBpm + ')으로 초기화합니다' + (isDiff ? ' (현재: ' + appState.bpm + ')' : '');
    }
    buildLeds();
  }

  function setBpm(v){
    appState.bpm = Math.max(30, Math.min(240, Math.round(Number(v) || 64)));
    if (playSession) playSession.spb = 60 / appState.bpm;
    syncConsoleUI();
    saveAppState();
  }

  $('#bpmRange').addEventListener('input', function(e){ setBpm(e.target.value); });
  $('#bpmDown').addEventListener('click', function(){ setBpm(appState.bpm - 2); });
  $('#bpmUp').addEventListener('click', function(){ setBpm(appState.bpm + 2); });
  if ($('#bpmResetBtn')){
    $('#bpmResetBtn').addEventListener('click', function(){
      if (!curSong) return;
      var defBpm = Number(curSong.bpm) || 64;
      setBpm(defBpm);
    });
  }

  $('#beatsSelect').addEventListener('change', function(e){
    appState.beats = Number(e.target.value);
    if (curSong) curSong.beats = appState.beats;
    syncConsoleUI();
    saveAppState();
  });

  $('#volRange').addEventListener('input', function(e){
    appState.vol = Number(e.target.value) / 100;
    saveAppState();
  });

  $('#loopStart').addEventListener('change', function(e){
    var maxM = getMeasureCount(curSong);
    appState.loopStart = Math.max(1, Math.min(maxM, Number(e.target.value) || 1));
    if (appState.loopEnd < appState.loopStart) appState.loopEnd = appState.loopStart;
    $('#loopStart').value = appState.loopStart;
    $('#loopEnd').value = appState.loopEnd;
    updateLoopClasses();
    saveAppState();
  });

  $('#loopEnd').addEventListener('change', function(e){
    var maxM = getMeasureCount(curSong);
    appState.loopEnd = Math.max(appState.loopStart, Math.min(maxM, Number(e.target.value) || maxM));
    $('#loopEnd').value = appState.loopEnd;
    updateLoopClasses();
    saveAppState();
  });

  $('#loopAllBtn').addEventListener('click', function(){
    appState.loopStart = 1;
    appState.loopEnd = getMeasureCount(curSong);
    $('#loopStart').value = appState.loopStart;
    $('#loopEnd').value = appState.loopEnd;
    updateLoopClasses();
    saveAppState();
  });

  $('#resetLoopBtn').addEventListener('click', function(){
    $('#loopAllBtn').click();
    $('#resumeBanner').hidden = true;
  });

  $('#loopEnable').addEventListener('change', function(e){
    appState.loopEnable = e.target.checked;
    saveAppState();
  });

  $('#speedTrainerChk').addEventListener('change', function(e){
    appState.speedTrainer = e.target.checked;
    saveAppState();
  });

  $('#guideSoundBtn').addEventListener('click', function(){
    appState.guideSound = !appState.guideSound;
    syncConsoleUI();
    saveAppState();
  });

  $('#engineBtn').addEventListener('click', function(){
    appState.synthEngine = appState.synthEngine === 'classic' ? 'ks' : 'classic';
    syncConsoleUI();
    saveAppState();
    // 두 음원 차이를 바로 비교할 수 있도록 정지 상태에서는 짧은 저음+멜로디 프리뷰 재생
    if (!isPlaying && appState.guideSound){
      ensureAudioCtx();
      var now = actx.currentTime + 0.02;
      playGuitarNote(45, 1.4, now, 1.12, null, 5);
      playGuitarNote(64, 1.0, now + 0.014, 1.0, 'apoyando', 1);
    }
  });

  $('#micScoreBtn').addEventListener('click', async function(){
    appState.micScoring = !appState.micScoring;
    syncConsoleUI();
    saveAppState();
    if (!appState.micScoring){
      releaseMic();
      $('#liveNoteKo').textContent = '마이크 꺼짐 (채점 안 함)';
    } else if (isPlaying){
      // 연습 도중 다시 켜면 그 시점부터 바로 채점
      try {
        await ensureMicWorklet();
        $('#liveNoteKo').textContent = '마이크 대기';
      } catch (e){
        $('#liveNoteKo').textContent = '마이크 없음 (뷰어 모드)';
      }
    } else {
      $('#liveNoteKo').textContent = '마이크 대기';
    }
  });
  if (!appState.micScoring) $('#liveNoteKo').textContent = '마이크 꺼짐 (채점 안 함)';

  if ($('#toggleFxBtn')){
    $('#toggleFxBtn').addEventListener('click', function(){
      appState.acousticFx = !appState.acousticFx;
      updateAudioFxRouting();
      syncConsoleUI();
      saveAppState();
      // 청음 피드백을 위해 살짝 단음 프리뷰 재생 (연습 정지 상태일 때 사용자가 음색 차이를 바로 체감)
      if (!isPlaying && appState.guideSound){
        ensureAudioCtx();
        playGuitarNote(64, 0.45, actx.currentTime + 0.02, 0.9, 'tirando');
      }
    });
  }

  $('#playBtn').addEventListener('click', function(){
    if (isPlaying || isStarting) stopPractice(true);
    else startPractice();
  });

  if ($('#compactPlayBtn')){
    $('#compactPlayBtn').addEventListener('click', function(){
      if (isPlaying || isStarting) stopPractice(true);
      else startPractice();
    });
  }

  if ($('#toggleCompactBtn')){
    $('#toggleCompactBtn').addEventListener('click', function(){
      setCompactPractice(!appState.isCompactPractice);
    });
  }

  // 메인 화면 키보드 단축키 (Space: 연습 시작/정지, G: 소리 토글, F: 특수효과 토글, T: 타브/박자카드 토글, P: 집중연습뷰, Esc: 전체화면)
  window.addEventListener('keydown', function(e){
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!$('#newSongModal').hidden || !$('#tunerModal').hidden || !$('#calibModal').hidden || !$('#sheetSyncModal').hidden || !$('#backupModal').hidden || !$('#toneModal').hidden) return;

    if (e.code === 'Space'){
      e.preventDefault();
      $('#playBtn').click();
    } else if (e.key === 'g' || e.key === 'G' || e.key === 'ㅎ'){
      e.preventDefault();
      $('#guideSoundBtn').click();
    } else if (e.key === 'f' || e.key === 'F' || e.key === 'ㄹ'){
      e.preventDefault();
      if ($('#toggleFxBtn')) $('#toggleFxBtn').click();
    } else if (e.key === 't' || e.key === 'T' || e.key === 'ㅅ'){
      e.preventDefault();
      if (curSong && curSong.type === 'structured'){
        if (appState.scoreView === 'card'){
          if ($('#scoreModeTabBtn')) $('#scoreModeTabBtn').click();
        } else {
          if ($('#scoreModeCardBtn')) $('#scoreModeCardBtn').click();
        }
      }
    } else if (e.key === 'p' || e.key === 'P' || e.key === 'ㅔ'){
      e.preventDefault();
      setCompactPractice(!appState.isCompactPractice);
    } else if (e.key === 'Escape'){
      if (appState.isCompactPractice){
        e.preventDefault();
        setCompactPractice(false);
      }
    }
  });

  // ---------- 유튜브 레퍼런스 연동
  var ytPlayer = null;
  var ytApiReady = false;

  function extractYoutubeId(url){
    if (!url) return null;
    var m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
    return m ? m[1] : (url.length === 11 ? url : null);
  }

  function renderYoutubePanel(){
    var qBox = $('#ytQuickLinks');
    qBox.textContent = '';
    var cleanTitle = curSong
      ? curSong.title.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
      : '클래식 기타 동요';
    if (!cleanTitle && curSong && curSong.title) {
      cleanTitle = curSong.title.trim();
    }
    var queries = [
      { label: cleanTitle + ' 클래식 기타', q: cleanTitle + ' 클래식 기타' },
      { label: cleanTitle + ' 기타 타브 운지법', q: cleanTitle + ' 기타 타브 강좌' },
      { label: cleanTitle + ' 느린 연주', q: cleanTitle + ' guitar tutorial slow' }
    ];
    queries.forEach(function(item){
      var a = document.createElement('a');
      a.className = 'btn sm';
      a.href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(item.q);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '검색: ' + item.label;
      qBox.appendChild(a);
    });

    $('#ytUrlInput').value = (curSong && curSong.ytUrl) || '';
    var vid = extractYoutubeId(curSong && curSong.ytUrl);
    if (vid){
      loadYoutubeVideo(vid);
      $('#ytClearBtn').hidden = false;
    } else {
      $('#ytPlaceholder').hidden = false;
      $('#ytIframeHost').hidden = true;
      $('#ytClearBtn').hidden = true;
    }
  }

  function ensureYtApi(){
    if (window.YT && window.YT.Player){ ytApiReady = true; return Promise.resolve(); }
    return new Promise(function(resolve){
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function(){
        ytApiReady = true;
        if (prev) prev();
        resolve();
      };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')){
        var tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
    });
  }

  function loadYoutubeVideo(videoId){
    $('#ytPlaceholder').hidden = true;
    var host = $('#ytIframeHost');
    host.hidden = false;
    ensureYtApi().then(function(){
      if (ytPlayer && ytPlayer.loadVideoById){
        ytPlayer.loadVideoById(videoId);
      } else {
        host.innerHTML = '<div id="ytPlayerInner"></div>';
        ytPlayer = new window.YT.Player('ytPlayerInner', {
          width: '100%',
          height: '100%',
          videoId: videoId,
          playerVars: { rel: 0, playsinline: 1 }
        });
      }
    });
  }

  $('#ytLoadBtn').addEventListener('click', function(){
    var url = $('#ytUrlInput').value.trim();
    var vid = extractYoutubeId(url);
    if (!vid){
      alert('올바른 유튜브 영상 주소(URL)를 입력해 주세요.');
      return;
    }
    if (curSong){
      curSong.ytUrl = url;
      saveAppState();
      renderYoutubePanel();
    }
  });

  $('#ytClearBtn').addEventListener('click', function(){
    if (!curSong) return;
    curSong.ytUrl = '';
    $('#ytUrlInput').value = '';
    saveAppState();
    renderYoutubePanel();
  });

  $$('.yt-rate').forEach(function(btn){
    btn.addEventListener('click', function(){
      var r = Number(btn.dataset.rate);
      $$('.yt-rate').forEach(function(b){ b.classList.toggle('active', b === btn); });
      if (ytPlayer && ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(r);
    });
  });

  // ---------- 교본 이미지 / PDF 업로드 처리 (B안 핵심)
  $('#uploadImgBtn').addEventListener('click', function(){
    $('#fileInput').click();
  });

  $('#fileInput').addEventListener('change', async function(e){
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';

    var baseName = file.name.replace(/\.[^.]+$/, '');
    var inputTitle = prompt('새로 올릴 악보의 이름을 입력해 주세요:\n(취소하거나 비워두면 파일명이 사용됩니다)', baseName);
    var title = (inputTitle && inputTitle.trim()) ? inputTitle.trim() : baseName;

    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)){
      await handlePdfUpload(file, title);
    } else {
      var dataUrl = await readFileAsDataUrl(file);
      await createImageSong(title, dataUrl, null);
    }
  });

  function readFileAsDataUrl(file){
    return new Promise(function(resolve){
      var fr = new FileReader();
      fr.onload = function(){ resolve(fr.result); };
      fr.readAsDataURL(file);
    });
  }

  async function loadPdfJs(){
    if (window.pdfjsLib) return window.pdfjsLib;
    return new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = function(){
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = function(){ reject(new Error('PDF 라이브러리를 불러오지 못했어요.')); };
      document.head.appendChild(s);
    });
  }

  async function handlePdfUpload(file, title){
    try {
      var pdfjs = await loadPdfJs();
      var buf = await file.arrayBuffer();
      var pdf = await pdfjs.getDocument({ data: buf }).promise;
      var pages = [];
      var maxPages = Math.min(pdf.numPages, 6);
      for (var p = 1; p <= maxPages; p++){
        var page = await pdf.getPage(p);
        var vp = page.getViewport({ scale: 1.6 });
        var cv = document.createElement('canvas');
        cv.width = vp.width;
        cv.height = vp.height;
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        pages.push(cv.toDataURL('image/jpeg', 0.86));
      }
      await createImageSong(title, pages[0], pages);
    } catch (err){
      alert('PDF 변환 중 오류가 발생했어요. 악보를 캡처한 이미지(JPG/PNG)로 올려 주세요.');
    }
  }

  async function createImageSong(title, firstDataUrl, pdfPages){
    var defaultSystems = pdfPages ? [
      { x: 0.08, y: 0.14, w: 0.84, h: 0.18, bars: [{ chord: 'C', note: 'C4', memo: '', w: 1 }, { chord: 'G7', note: 'D4', memo: '', w: 1 }, { chord: 'C', note: 'E4', memo: '', w: 1 }, { chord: 'C', note: 'C4', memo: '', w: 1 }] },
      { x: 0.08, y: 0.42, w: 0.84, h: 0.18, bars: [{ chord: 'F', note: 'F4', memo: '', w: 1 }, { chord: 'C', note: 'E4', memo: '', w: 1 }, { chord: 'G7', note: 'D4', memo: '', w: 1 }, { chord: 'C', note: 'C4', memo: '', w: 1 }] }
    ] : [
      { x: 0.12, y: 0.15, w: 0.55, h: 0.72, bars: [{ chord: 'C', note: 'C4', memo: '', w: 1 }, { chord: 'G7', note: 'D4', memo: '', w: 1 }, { chord: 'C', note: 'E4', memo: '', w: 1 }, { chord: 'C', note: 'C4', memo: '', w: 1 }] }
    ];
    var song = {
      id: 'song-' + Date.now(),
      title: title,
      badge: pdfPages ? 'PDF 교본 악보 (' + pdfPages.length + '쪽)' : '교본 사진 악보',
      type: 'image',
      builtin: false,
      bpm: 64,
      beats: 4,
      imageDataUrl: firstDataUrl,
      pdfPages: pdfPages || null,
      curPageIdx: 0,
      systems: defaultSystems,
      ytUrl: ''
    };
    await dbSaveSong(song);
    customSongs.push(song);
    rebuildSongSelect(song.id);
  }

  $('#toggleEditGridBtn').addEventListener('click', function(){
    imgEditMode = !imgEditMode;
    $('#toggleEditGridBtn').classList.toggle('active', imgEditMode);
    $('#toggleEditGridBtn').textContent = imgEditMode ? '마디 영역 편집 켜짐' : '마디 영역 편집 꺼짐';
    $('#imgContainer').classList.toggle('editing', imgEditMode);
    renderImageSystemsOverlay();
  });

  $('#addSystemRowBtn').addEventListener('click', function(){
    if (!curSong || curSong.type !== 'image') return;
    var n = curSong.systems.length;
    var nextY = Math.min(0.80, 0.12 + n * 0.22);
    curSong.systems.push({
      x: 0.10, y: nextY, w: 0.70, h: 0.20,
      bars: [
        { chord: 'C', note: 'C4', memo: '', w: 1 },
        { chord: 'G7', note: 'D4', memo: '', w: 1 },
        { chord: 'C', note: 'E4', memo: '', w: 1 },
        { chord: 'C', note: 'C4', memo: '', w: 1 }
      ]
    });
    syncAfterImageGridChange();
  });

  $('#pdfPrevBtn').addEventListener('click', function(){
    if (!curSong || !curSong.pdfPages || curSong.curPageIdx <= 0) return;
    curSong.curPageIdx--;
    curSong.imageDataUrl = curSong.pdfPages[curSong.curPageIdx];
    dbSaveSong(curSong);
    renderImageScore();
  });

  $('#pdfNextBtn').addEventListener('click', function(){
    if (!curSong || !curSong.pdfPages || curSong.curPageIdx >= curSong.pdfPages.length - 1) return;
    curSong.curPageIdx++;
    curSong.imageDataUrl = curSong.pdfPages[curSong.curPageIdx];
    dbSaveSong(curSong);
    renderImageScore();
  });

  // 마디 코드/메모 수정 모달
  function openBarEditModal(){
    if (!curSong || curSong.type !== 'image') return;
    if (!selectedImgBar){
      selectedImgBar = { sysIdx: 0, barIdx: 0, globalIdx: 0 };
    }
    var sys = curSong.systems[selectedImgBar.sysIdx];
    var bar = sys && sys.bars[selectedImgBar.barIdx];
    if (!bar) return;
    $('#barEditTitle').textContent = (selectedImgBar.globalIdx + 1) + '마디 코드 · 운지 메모 설정';
    $('#beChord').value = bar.chord || 'C';
    $('#beNote').value = bar.note || 'C4';
    $('#beMemo').value = bar.memo || '';
    $('#barEditModal').hidden = false;
  }

  $('#editBarMetaBtn').addEventListener('click', openBarEditModal);
  $('#closeBarEditBtn').addEventListener('click', function(){ $('#barEditModal').hidden = true; });
  $('#saveBarEditBtn').addEventListener('click', function(){
    if (!curSong || !selectedImgBar) return;
    var bar = curSong.systems[selectedImgBar.sysIdx].bars[selectedImgBar.barIdx];
    bar.chord = $('#beChord').value.trim() || 'C';
    bar.note = $('#beNote').value.trim() || 'C4';
    bar.memo = $('#beMemo').value.trim();
    $('#barEditModal').hidden = true;
    dbSaveSong(curSong);
    renderImageSystemsOverlay();
    updateActiveCursor(selectedImgBar.globalIdx, 0, true);
  });

  // ---------- 검은 세로 마디선 자동 감지 (이미지 픽셀 스캔)
  async function loadImageElement(src){
    return new Promise(function(resolve, reject){
      var im = new Image();
      im.onload = function(){ resolve(im); };
      im.onerror = reject;
      im.src = src;
    });
  }

  async function scanBarlinesAndNotesFromImage(dataUrl, sysRect){
    var im = await loadImageElement(dataUrl);
    var W = im.naturalWidth || im.width;
    var H = im.naturalHeight || im.height;
    var cv = document.createElement('canvas');
    var scale = Math.min(1, 1000 / Math.max(W, 1));
    var cw = Math.max(100, Math.round(W * scale));
    var ch = Math.max(60, Math.round(H * scale));
    cv.width = cw;
    cv.height = ch;
    var ctx = cv.getContext('2d');
    ctx.drawImage(im, 0, 0, cw, ch);
    var imgData = ctx.getImageData(0, 0, cw, ch).data;

    var rx0 = Math.floor((sysRect ? sysRect.x : 0.05) * cw);
    var ry0 = Math.floor((sysRect ? sysRect.y : 0.12) * ch);
    var rw  = Math.floor((sysRect ? sysRect.w : 0.85) * cw);
    var rh  = Math.floor((sysRect ? sysRect.h : 0.76) * ch);

    // 1. 각 x열마다 세로로 어두운 픽셀(검은 마디선) 밀도 계산
    var colDark = new Float32Array(rw);
    for (var dx = 0; dx < rw; dx++){
      var x = rx0 + dx;
      var darkCnt = 0;
      for (var dy = Math.floor(rh * 0.1); dy < Math.floor(rh * 0.9); dy++){
        var y = ry0 + dy;
        var idx = (y * cw + x) * 4;
        var r = imgData[idx], g = imgData[idx + 1], b = imgData[idx + 2];
        if (r < 75 && g < 75 && b < 75) darkCnt++;
      }
      colDark[dx] = darkCnt / (rh * 0.8);
    }

    // 피크(세로 마디선) 추출 (최소 간격 rw * 0.08)
    var barXs = [];
    var minGap = Math.max(12, Math.floor(rw * 0.08));
    for (var i = 2; i < rw - 2; i++){
      if (colDark[i] > 0.42 && colDark[i] >= colDark[i - 1] && colDark[i] >= colDark[i + 1]){
        if (!barXs.length || (i - barXs[barXs.length - 1].dx) > minGap){
          barXs.push({ dx: i, strength: colDark[i], normX: (rx0 + i) / cw });
        } else if (colDark[i] > barXs[barXs.length - 1].strength){
          barXs[barXs.length - 1] = { dx: i, strength: colDark[i], normX: (rx0 + i) / cw };
        }
      }
    }

    // 2. 마디 구간 안에 있는 유채색 음표 스티커(교본의 도/라/레 컬러 블럭 등) 위치 스캔
    // 왼쪽 줄 이름 라벨 영역(첫 번째 굵은 너트선 왼쪽)은 제외
    var startDx = barXs.length >= 2 ? barXs[0].dx + 8 : Math.floor(rw * 0.12);
    var endDx = barXs.length >= 2 ? barXs[barXs.length - 1].dx : Math.floor(rw * 0.85);
    var colorBlobs = [];
    var stepX = Math.max(2, Math.floor(rw / 120));
    var stepY = Math.max(2, Math.floor(rh / 60));

    for (var cx = startDx; cx < endDx; cx += stepX){
      for (var cy = Math.floor(rh * 0.05); cy < Math.floor(rh * 0.95); cy += stepY){
        var pIdx = ((ry0 + cy) * cw + (rx0 + cx)) * 4;
        var pr = imgData[pIdx], pg = imgData[pIdx + 1], pb = imgData[pIdx + 2];
        var maxC = Math.max(pr, pg, pb), minC = Math.min(pr, pg, pb);
        // 따뜻하거나 선명한 유채색 스티커(주황/연두/노랑 등)이고 파란색/보라색 원(p/i/m)은 제외
        if (maxC > 130 && (maxC - minC) > 45 && pr > pb + 25){
          colorBlobs.push({ dx: cx, dy: cy, relY: cy / rh });
        }
      }
    }

    // 인접한 컬러 점들을 클러스터링해서 개별 음표 위치 추출
    colorBlobs.sort(function(a, b){ return a.dx - b.dx; });
    var noteClusters = [];
    colorBlobs.forEach(function(pt){
      var last = noteClusters[noteClusters.length - 1];
      if (last && Math.abs(pt.dx - last.dx) < rw * 0.045){
        last.sumX += pt.dx; last.sumY += pt.relY; last.n++;
        last.dx = last.sumX / last.n; last.relY = last.sumY / last.n;
      } else {
        noteClusters.push({ dx: pt.dx, relY: pt.relY, sumX: pt.dx, sumY: pt.relY, n: 1 });
      }
    });
    noteClusters = noteClusters.filter(function(c){ return c.n >= 3; });

    // y위치(0~1)를 클래식 기타 1~6번줄 대표 1포지션 음으로 매핑
    function mapRelYToNote(relY){
      if (relY < 0.22) return 'E4'; // 1번줄 미/파/솔
      if (relY < 0.38) return 'C4'; // 2번줄 도/레
      if (relY < 0.54) return 'A3'; // 3번줄 솔/라
      if (relY < 0.70) return 'D3'; // 4번줄 레/미/파
      if (relY < 0.85) return 'A2'; // 5번줄 라/시/도
      return 'E2';                  // 6번줄 미
    }

    noteClusters.forEach(function(c){
      c.normX = (rx0 + c.dx) / cw;
      c.guessNote = mapRelYToNote(c.relY);
    });

    return { barXs: barXs, noteClusters: noteClusters, cw: cw, ch: ch };
  }

  $('#autoDetectBarsBtn').addEventListener('click', async function(){
    if (!curSong || curSong.type !== 'image' || !curSong.systems.length) return;
    var sys = curSong.systems[0];
    var res = await scanBarlinesAndNotesFromImage(curSong.imageDataUrl, sys);
    if (res.barXs.length >= 2){
      var firstX = res.barXs[0].normX;
      var lastX = res.barXs[res.barXs.length - 1].normX;
      if (lastX - firstX > 0.12){
        sys.x = +firstX.toFixed(4);
        sys.w = +(lastX - firstX).toFixed(4);
        var newBars = [];
        for (var i = 0; i < res.barXs.length - 1; i++){
          var segW = res.barXs[i + 1].normX - res.barXs[i].normX;
          newBars.push({
            chord: i % 2 === 0 ? 'C' : 'G7',
            note: 'C4',
            memo: '',
            w: +Math.max(0.2, segW * 10).toFixed(3)
          });
        }
        sys.bars = newBars;
        syncAfterImageGridChange();
        return;
      }
    }
    alert('뚜렷한 검은 세로 마디선을 찾지 못했어요. 먼저 줄 박스를 악보 줄 위치에 대략 맞춘 뒤 다시 눌러 보세요.');
  });

  // ---------- 원클릭 계이름 비주얼 에디터 (모드 전환: 1. 기타 줄별 / 2. 계이름 도레미파솔라시 순서)
  // ---------- 곡 삭제 (IndexedDB 저장곡 & 구글 시트 연동곡 모두 지원)
  $('#deleteSongBtn').addEventListener('click', async function(){
    if (!curSong || curSong.builtin) return;
    var targetId = curSong.id;
    var targetTitle = curSong.title;

    if (curSong.fromSheet){
      if (!confirm('"' + targetTitle + '" 곡을 목록에서 삭제(숨김)할까요?\n(다시 보려면 [구글 시트] -> [시트에서 다시 불러오기]를 누르면 복구됩니다.)')) return;
      var hiddenList = ls.get('gs.hiddenSheetSongs', []);
      if (hiddenList.indexOf(targetTitle) < 0) hiddenList.push(targetTitle);
      ls.set('gs.hiddenSheetSongs', hiddenList);
      sheetSongs = sheetSongs.filter(function(s){ return s.id !== targetId && s.title !== targetTitle; });
      // 혹시 이전에 IndexedDB에 중복 저장된 흔적이 있다면 함께 제거
      await dbDeleteSong(targetId);
      customSongs = customSongs.filter(function(s){ return s.id !== targetId; });
      $('#openSheetSyncBtn').textContent = '구글 시트 (' + sheetSongs.length + '곡)';
      rebuildSongSelect(sheetSongs.length ? sheetSongs[0].id : (BUILTIN_SONGS[0] ? BUILTIN_SONGS[0].id : (allSongs[0] ? allSongs[0].id : null)));
      return;
    }

    if (!confirm('"' + targetTitle + '" 악보를 이 기기(IndexedDB)에서 영구 삭제할까요?')) return;
    await dbDeleteSong(targetId);
    customSongs = customSongs.filter(function(s){ return s.id !== targetId; });
    rebuildSongSelect(sheetSongs.length ? sheetSongs[0].id : (BUILTIN_SONGS[0] ? BUILTIN_SONGS[0].id : (allSongs[0] ? allSongs[0].id : null)));
  });

  // ---------- 악보 이름 변경 (직접 올린 교본 이미지/PDF, 직접 입력 악보, 구글 시트 연동곡)
  async function renameCurrentSong(){
    if (!curSong || curSong.builtin){
      alert('내장 기본 악보는 이름을 변경할 수 없어요.');
      return;
    }
    var oldTitle = curSong.title || '';
    var newTitle = prompt('악보 이름을 변경해 주세요:', oldTitle);
    if (newTitle == null) return;
    newTitle = newTitle.trim();
    if (!newTitle){
      alert('곡 이름을 1글자 이상 입력해 주세요.');
      return;
    }
    if (newTitle === oldTitle) return;

    curSong.title = newTitle;

    if (curSong.fromSheet){
      var titleOverrides = ls.get('gs.sheetTitleOverrides', {});
      titleOverrides[curSong.id] = newTitle;
      ls.set('gs.sheetTitleOverrides', titleOverrides);
      var ss = sheetSongs.find(function(s){ return s.id === curSong.id; });
      if (ss) ss.title = newTitle;
    } else {
      await dbSaveSong(curSong);
      var cs = customSongs.find(function(s){ return s.id === curSong.id; });
      if (cs) cs.title = newTitle;
    }

    rebuildSongSelect(curSong.id);
  }

  if ($('#renameSongBtn')) $('#renameSongBtn').addEventListener('click', renameCurrentSong);
  if ($('#renameScoreTitleBtn')) $('#renameScoreTitleBtn').addEventListener('click', renameCurrentSong);
  $('#scoreTitle').addEventListener('click', function(){
    if (curSong && !curSong.builtin) renameCurrentSong();
  });

  // ---------- 6현 튜너 모달 (워크릿 YIN 연속 음정 추정 → 센트 단위 바늘)
  var tunerTarget = null;  // 직접 고른 줄 (null이면 가장 가까운 줄 자동 선택)
  var tunerHist = [];      // 최근 추정값(Hz): 중앙값으로 순간적인 튐 제거
  var tunerCents = null;   // 바늘 떨림을 줄인 평활 센트값
  var tunerSilent = 0;     // 소리가 없는 연속 프레임 수 (프레임 약 21ms)

  function initTunerModal(){
    var box = $('#tunerStrings');
    box.textContent = '';
    STRINGS.slice().reverse().forEach(function(st){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn sm';
      b.dataset.str = st.str;
      b.style.flexDirection = 'column';
      b.style.padding = '8px 4px';
      b.innerHTML = '<b>' + st.name.split(' ')[0] + '</b><span style="font-size:11px;color:var(--muted)">' + st.name.split(' ')[1] + '</span>';
      b.addEventListener('click', function(){
        // 줄을 고르면 그 줄 기준으로 고정하고 기준음을 들려줌
        tunerTarget = st;
        syncTunerTargetUI(null);
        playGuitarNote(st.midi, 1.8, null, null, null, st.str);
      });
      box.appendChild(b);
    });
  }
  initTunerModal();

  function syncTunerTargetUI(autoStr){
    $$('#tunerStrings button').forEach(function(b){
      var s = Number(b.dataset.str);
      b.classList.toggle('active', tunerTarget ? s === tunerTarget.str : s === autoStr);
    });
    $('#tunerAutoBtn').classList.toggle('active', !tunerTarget);
  }

  function updateTunerReading(hz){
    var guide = $('#tunerGuide');
    if (!hz){
      // 소리가 0.5초 이상 끊기면 대기 상태로 (마지막 표시는 흐리게 남김)
      if (++tunerSilent === 24){
        tunerHist = [];
        tunerCents = null;
        $('#tunerReadout').style.opacity = '0.45';
        $('#tunerNeedle').dataset.cls = '';
        guide.textContent = '줄을 하나씩 튕겨 보세요';
        guide.style.color = 'var(--d-muted)';
      }
      return;
    }
    tunerSilent = 0;
    tunerHist.push(hz);
    if (tunerHist.length > 5) tunerHist.shift();
    var med = tunerHist.slice().sort(function(a, b){ return a - b; })[tunerHist.length >> 1];
    var midiF = 69 + 12 * Math.log2(med / 440);
    var target = tunerTarget, autoStr = null;
    if (!target){
      target = STRINGS.reduce(function(best, s){ return Math.abs(midiF - s.midi) < Math.abs(midiF - best.midi) ? s : best; });
      autoStr = target.str;
    }
    var cents = (midiF - target.midi) * 100;
    // 다른 줄로 넘어가는 큰 변화는 즉시, 작은 흔들림은 부드럽게 따라감
    tunerCents = (tunerCents == null || Math.abs(cents - tunerCents) > 30) ? cents : tunerCents + (cents - tunerCents) * 0.35;
    var c = Math.round(tunerCents);
    var cls = Math.abs(c) <= 3 ? 'ok' : (Math.abs(c) <= 15 ? 'near' : 'off');

    $('#tunerReadout').style.opacity = '1';
    $('#tunerReadout').textContent = target.name.split(' ')[0] + ' · ' + midiInfo(Math.round(midiF)).en;
    $('#tunerCents').textContent = (c > 0 ? '+' + c : (c < 0 ? String(c) : '±0')) + ' 센트 · ' + med.toFixed(1) + ' Hz';
    var needle = $('#tunerNeedle');
    needle.style.left = (50 + Math.max(-50, Math.min(50, c))) + '%';
    needle.dataset.cls = cls;
    if (cls === 'ok'){
      guide.textContent = target.name + ' 음정이 맞았어요!';
      guide.style.color = 'var(--d-ok)';
    } else {
      guide.textContent = (Math.abs(c) > 100 ? '많이 ' : '') + (c < 0 ? '낮아요 · 줄감개를 조여 음을 올리세요' : '높아요 · 줄감개를 풀어 음을 내리세요');
      guide.style.color = cls === 'near' ? 'var(--d-near)' : 'var(--d-off)';
    }
    syncTunerTargetUI(autoStr);
  }

  function setTunerAnalysis(on){
    if (workletNode) workletNode.port.postMessage({ t: 'tuner', on: on });
  }

  $('#tunerAutoBtn').addEventListener('click', function(){
    tunerTarget = null;
    tunerCents = null;
    syncTunerTargetUI(null);
  });
  $('#tunerBtn').addEventListener('click', function(){
    isTunerActive = true;
    $('#tunerModal').hidden = false;
  });
  $('#closeTunerBtn').addEventListener('click', function(){
    isTunerActive = false;
    $('#tunerModal').hidden = true;
    setTunerAnalysis(false);
    $('#tunerStartMicBtn').disabled = false;
    $('#tunerStartMicBtn').textContent = '마이크로 튜닝 시작';
    releaseMic();
  });
  $('#tunerStartMicBtn').addEventListener('click', async function(){
    try {
      await ensureMicWorklet();
      if (!isTunerActive){ releaseMic(); return; } // 권한을 기다리는 사이 튜너를 닫은 경우
      tunerHist = [];
      tunerCents = null;
      tunerSilent = 0;
      setTunerAnalysis(true);
      $('#tunerStartMicBtn').disabled = true;
      $('#tunerStartMicBtn').textContent = '튜닝 중 (마이크 켜짐)';
      $('#tunerGuide').textContent = '마이크가 켜졌어요. 기타 줄을 한 줄씩 튕겨 보세요.';
    } catch (e){
      $('#tunerGuide').textContent = e.message;
    }
  });

  // ---------- 음색 설정 모달 (울림통 공명 세기 · 공명현 세기)
  function syncToneUI(){
    var b = Math.round(appState.bodyAmount * 100), s = Math.round(appState.sympAmount * 100);
    $('#bodyAmountRange').value = b;
    $('#bodyAmountVal').textContent = b + '%';
    $('#sympAmountRange').value = s;
    $('#sympAmountVal').textContent = s ? s + '%' : '꺼짐';
    $('#toneFxNote').hidden = !!appState.acousticFx;
  }
  $('#toneOpenBtn').addEventListener('click', function(){
    syncToneUI();
    $('#toneModal').hidden = false;
  });
  $('#closeToneBtn').addEventListener('click', function(){
    $('#toneModal').hidden = true;
  });
  // 드라이 모드에서는 슬라이더를 움직여도 들리지 않으므로 창 안에서 바로 콘서트홀로 전환
  $('#toneFxOnBtn').addEventListener('click', function(){
    appState.acousticFx = true;
    updateAudioFxRouting();
    syncConsoleUI();
    saveAppState();
    syncToneUI();
  });
  // 드래그 중에는 소리만 바로 반영하고, 손을 뗐을 때 저장
  $('#bodyAmountRange').addEventListener('input', function(e){
    appState.bodyAmount = Number(e.target.value) / 100;
    updateAudioFxRouting();
    syncToneUI();
  });
  $('#sympAmountRange').addEventListener('input', function(e){
    appState.sympAmount = Number(e.target.value) / 100;
    syncToneUI();
  });
  $('#bodyAmountRange').addEventListener('change', saveAppState);
  $('#sympAmountRange').addEventListener('change', saveAppState);
  // 미리 듣기: 개방현이 비어 있도록 짚은 음만 이어서 쳐서 울림통과 공명현 효과가 잘 들리게 함
  // (4번줄 2프렛 E3 → 3번줄 2프렛 A3 → 2번줄 3프렛 D4 → 2번줄 5프렛 E4)
  $('#tonePreviewBtn').addEventListener('click', function(){
    ensureAudioCtx();
    var now = actx.currentTime + 0.05;
    [[52, 4], [57, 3], [62, 2], [64, 2]].forEach(function(n, i){
      playGuitarNote(n[0], 1.3, now + i * 0.65, 1.0, null, n[1]);
    });
  });

  // ---------- 지연 보정 모달 (블루투스 출력 + 마이크 입력)
  function updateAudioOffsetUI(){
    var v = appState.audioOffsetMs || 0;
    if ($('#audioOffsetRange')) $('#audioOffsetRange').value = v;
    if ($('#audioOffsetVal')) $('#audioOffsetVal').textContent = (v > 0 ? '+' : '') + v + ' ms';
    if ($('#btPresetWired')) $('#btPresetWired').classList.toggle('primary', v === 0);
    if ($('#btPresetNormal')) $('#btPresetNormal').classList.toggle('primary', v === 180);
    if ($('#btPresetHeavy')) $('#btPresetHeavy').classList.toggle('primary', v === 240);
    syncConsoleUI();
  }
  $('#calibOpenBtn').addEventListener('click', function(){
    updateAudioOffsetUI();
    refreshMicDeviceList();
    $('#calibModal').hidden = false;
  });

  // 마이크 입력 장치 선택: 사용 중이면 새 장치로 즉시 교체
  $('#micDeviceSelect').addEventListener('change', async function(e){
    appState.micDeviceId = e.target.value;
    saveAppState();
    if (!micStream) return;
    if (micSource){ micSource.disconnect(); micSource = null; }
    micStream.getTracks().forEach(function(tr){ tr.stop(); });
    micStream = null;
    try {
      await ensureMicWorklet();
    } catch (err){
      $('#calibModalStatus').textContent = '선택한 마이크를 열지 못했어요: ' + err.message;
    }
  });
  // 권한을 아직 안 받았으면 장치 이름이 숨겨지므로 잠깐 마이크를 열어 권한만 받고 바로 닫음
  $('#micDeviceRefreshBtn').addEventListener('click', async function(){
    if (!micStream && navigator.mediaDevices && navigator.mediaDevices.getUserMedia){
      try {
        var tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach(function(tr){ tr.stop(); });
      } catch (err){
        $('#calibModalStatus').textContent = '마이크 권한이 없어 장치 목록을 볼 수 없어요.';
      }
    }
    refreshMicDeviceList();
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener){
    navigator.mediaDevices.addEventListener('devicechange', refreshMicDeviceList);
  }
  $('#closeCalibBtn').addEventListener('click', function(){
    $('#calibModal').hidden = true;
  });
  if ($('#audioOffsetRange')){
    $('#audioOffsetRange').addEventListener('input', function(e){
      appState.audioOffsetMs = Number(e.target.value) || 0;
      saveAppState();
      updateAudioOffsetUI();
    });
  }
  if ($('#btPresetWired')){
    $('#btPresetWired').addEventListener('click', function(){
      appState.audioOffsetMs = 0;
      saveAppState();
      updateAudioOffsetUI();
    });
  }
  if ($('#btPresetNormal')){
    $('#btPresetNormal').addEventListener('click', function(){
      appState.audioOffsetMs = 180;
      saveAppState();
      updateAudioOffsetUI();
    });
  }
  if ($('#btPresetHeavy')){
    $('#btPresetHeavy').addEventListener('click', function(){
      appState.audioOffsetMs = 240;
      saveAppState();
      updateAudioOffsetUI();
    });
  }
  $('#runCalibBtn').addEventListener('click', async function(){
    if (isCalibrating) return;
    try {
      await ensureMicWorklet();
    } catch (e){
      $('#calibModalStatus').textContent = e.message;
      return;
    }
    isCalibrating = true;
    $('#runCalibBtn').disabled = true;
    $('#calibModalStatus').textContent = '삐 소리를 내며 지연 시간을 측정 중입니다 (약 5초)...';

    var t0 = actx.currentTime + 0.4;
    var clicks = [];
    for (var i = 0; i < 8; i++){
      var ct = t0 + i * 0.55;
      clicks.push(ct);
      var o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = 4200;
      g.gain.setValueAtTime(0, ct);
      g.gain.linearRampToValueAtTime(0.8, ct + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, ct + 0.05);
      // 메트로놈 클릭과 같은 출력 경로(리미터 룩어헤드 포함)로 내보내야 측정 지연이 실제 연습 상황과 일치
      o.connect(g); g.connect(clickBus || actx.destination);
      o.start(ct); o.stop(ct + 0.06);
    }
    playSession = { calClicks: clicks, calHeard: [] };

    setTimeout(function(){
      var heard = playSession ? playSession.calHeard : [];
      var lats = [];
      clicks.forEach(function(ct){
        for (var j = 0; j < heard.length; j++){
          var d = heard[j] - ct;
          if (d >= 0.005 && d <= 0.45){ lats.push(d); break; }
        }
      });
      isCalibrating = false;
      releaseMic();
      $('#runCalibBtn').disabled = false;
      if (lats.length >= 4){
        lats.sort(function(a, b){ return a - b; });
        var med = lats[Math.floor(lats.length / 2)];
        calib = { lat: med, calibrated: true, at: Date.now() };
        ls.set('gs.calib', calib);
        $('#calibModalStatus').textContent = '보정 완료: 지연 시간 ' + Math.round(med * 1000) + ' ms';
      } else {
        $('#calibModalStatus').textContent = '소리를 충분히 감지하지 못했어요. 볼륨을 높이고 다시 시도해 주세요 (기본 45ms 유지).';
      }
      syncConsoleUI();
    }, 5200);
  });

  // ---------- 백업 및 복원
  $('#backupBtn').addEventListener('click', function(){ $('#backupModal').hidden = false; });
  $('#closeBackupBtn').addEventListener('click', function(){ $('#backupModal').hidden = true; });

  $('#exportJsonBtn').addEventListener('click', async function(){
    var songs = await dbGetAllSongs();
    var payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      appState: appState,
      calib: calib,
      history: historyList,
      customSongs: songs
    };
    var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'guitar-studio-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('#importJsonBtn').addEventListener('click', function(){ $('#importFileInput').click(); });
  $('#importFileInput').addEventListener('change', function(e){
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = async function(){
      try {
        var data = JSON.parse(fr.result);
        if (Array.isArray(data.customSongs)){
          for (var i = 0; i < data.customSongs.length; i++){
            await dbSaveSong(data.customSongs[i]);
          }
        }
        if (data.appState) ls.set('gs.state', data.appState);
        if (data.history) ls.set('gs.history', data.history);
        location.reload();
      } catch (err){
        alert('백업 파일 형식이 올바르지 않아요.');
      }
    };
    fr.readAsText(f);
  });

  // ---------- 기록 테이블 렌더링
  function renderHistoryTable(){
    var tb = $('#histBody');
    tb.textContent = '';
    if (!historyList.length){
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 6;
      td.style.textAlign = 'center';
      td.style.color = 'var(--muted)';
      td.textContent = '아직 연습 기록이 없어요. 연습 시작 후 정지를 누르면 기록이 남아요.';
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    historyList.forEach(function(h){
      var tr = document.createElement('tr');
      var okPct = Math.round((h.okRate || 0) * 100);
      var cells = [
        { t: fmtDate(h.at) },
        { t: h.songTitle + ' (' + h.range + ')' },
        { t: h.bpm + ' BPM' },
        { t: h.n + '음' },
        { t: fmtSigned(h.mean) + ' ms', cls: classOfErr(h.mean) },
        { t: okPct + '%', cls: okPct >= 70 ? 'ok' : okPct >= 45 ? 'near' : 'off' }
      ];
      cells.forEach(function(c){
        var td = document.createElement('td');
        td.textContent = c.t;
        if (c.cls) td.dataset.cls = c.cls;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
  }

  $('#clearHistBtn').addEventListener('click', function(){
    if (!confirm('연습 기록을 모두 지울까요?')) return;
    historyList = [];
    ls.set('gs.history', historyList);
    renderHistoryTable();
  });

  // ---------- 외부 songs.json (저작권 없는 기본 내장곡) 및 구글 스프레드시트 연동 엔진
  var sheetSongs = [];

  async function loadExternalSongsJson(){
    try {
      var res = await fetch('./songs.json', { cache: 'no-store' });
      if (!res.ok) return;
      var arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) return;
      BUILTIN_SONGS = arr.map(function(spec, idx){
        return buildStructuredSong({
          id: spec.id || ('builtin-json-' + idx),
          title: spec.title || ('내장곡 ' + (idx + 1)),
          badge: spec.badge || 'songs.json 내장 악보',
          builtin: true,
          bpm: Number(spec.bpm) || 64,
          beats: Number(spec.beats) || 4,
          ytUrl: spec.ytUrl || '',
          lines: Array.isArray(spec.lines) ? spec.lines : []
        });
      });
    } catch (e){
      // 로컬 file:// 환경 등에서 fetch 차단 시 코드 내장 BUILTIN_SONGS 폴백 사용
    }
  }

  // CORS 및 로컬 file:// 환경 제약을 100% 우회하는 Google Visualization JSONP 로더
  function extractSheetIdAndGid(rawInput){
    var str = (rawInput || '').trim();
    if (!str) return null;
    var m = str.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    var sheetId = m ? m[1] : (/^[a-zA-Z0-9-_]{20,}$/.test(str) ? str : null);
    if (!sheetId) return null;
    var gidMatch = str.match(/[#&?]gid=([0-9]+)/);
    var gid = gidMatch ? gidMatch[1] : '0';
    return { sheetId: sheetId, gid: gid };
  }

  function loadSheetViaJsonp(sheetId, gid){
    return new Promise(function(resolve, reject){
      var cbName = '__gsSheetCb_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      var script = document.createElement('script');
      var timer = setTimeout(function(){
        cleanup();
        reject(new Error('응답 시간 초과. 시트 공유 권한이 [링크가 있는 모든 사용자(뷰어)]인지 확인해 주세요.'));
      }, 8000);

      function cleanup(){
        clearTimeout(timer);
        try { delete window[cbName]; } catch (e){ window[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = function(res){
        cleanup();
        if (!res || res.status === 'error' || !res.table){
          reject(new Error('시트 데이터를 읽지 못했어요.'));
          return;
        }
        var rows = (res.table.rows || []).map(function(r){
          return (r.c || []).map(function(cell){
            if (!cell) return '';
            return cell.v != null ? String(cell.v) : (cell.f != null ? String(cell.f) : '');
          });
        });
        resolve(rows);
      };

      script.onerror = function(){
        cleanup();
        reject(new Error('시트 접근 실패. 시트 우측 상단 [공유] -> [링크가 있는 모든 사용자(뷰어)]로 설정되어 있는지 확인해 주세요.'));
      };

      script.src = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(sheetId) +
        '/gviz/tq?tqx=responseHandler:' + cbName + '&gid=' + encodeURIComponent(gid) + '&_=' + Date.now();
      document.head.appendChild(script);
    });
  }

  async function syncGoogleSheetSongs(rawUrl, silent){
    var info = extractSheetIdAndGid(rawUrl);
    if (!info){
      if (!silent) $('#sheetSyncStatus').textContent = '올바른 구글 스프레드시트 공유 링크(URL)를 입력해 주세요.';
      return false;
    }
    if (!silent) $('#sheetSyncStatus').textContent = '구글 드라이브 스프레드시트에서 악보 데이터를 불러오는 중...';
    try {
      var rows = await loadSheetViaJsonp(info.sheetId, info.gid);
      var parsedSongs = [];

      var hiddenTitles = silent ? ls.get('gs.hiddenSheetSongs', []) : [];
      if (!silent) ls.set('gs.hiddenSheetSongs', []);

      rows.forEach(function(cols, rIdx){
        var c0 = (cols[0] || '').trim();
        if (!c0) return;
        if (c0 === '곡 제목' || c0 === '제목' || c0.toLowerCase() === 'title') return;
        if (hiddenTitles.indexOf(c0) >= 0) return;

        var title = c0;
        var beats = 4;
        var bpm = 64;
        var badge = '내 구글 시트 악보';
        var rawScoreParts = [];

        var c1 = (cols[1] || '').trim();
        if (c1.indexOf('[') === 0 || c1.indexOf('|') >= 0){
          rawScoreParts = cols.slice(1);
        } else {
          beats = Math.round(Number(c1)) || 4;
          bpm = Math.round(Number((cols[2] || '').trim())) || 64;
          badge = (cols[3] || '').trim() || ('구글 시트 연동곡 · ' + beats + '/4박자');
          rawScoreParts = cols.slice(4);
        }

        var rawJoined = rawScoreParts.map(function(x){ return (x || '').trim(); }).filter(Boolean).join('\n');
        var lines = splitScoreMeasures(rawJoined);

        if (!lines.length) return;

        var songId = 'sheet-song-' + rIdx;
        var titleOverrides = ls.get('gs.sheetTitleOverrides', {});
        var finalTitle = titleOverrides[songId] || title;

        var song = buildStructuredSong({
          id: songId,
          title: finalTitle,
          badge: badge,
          builtin: false,
          bpm: bpm,
          beats: beats,
          lines: lines
        });
        song.fromSheet = true;
        parsedSongs.push(song);
      });

      sheetSongs = parsedSongs;
      ls.set('gs.sheetUrl', rawUrl.trim());
      var nowStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      $('#sheetSyncStatus').textContent = '연동 완료 (' + nowStr + ') · 총 ' + parsedSongs.length + '곡을 내 구글 시트에서 불러왔어요.';
      $('#openSheetSyncBtn').textContent = '구글 시트 (' + parsedSongs.length + '곡)';
      rebuildSongSelect(parsedSongs.length && !silent ? parsedSongs[0].id : appState.lastSongId);
      return true;
    } catch (err){
      if (!silent){
        $('#sheetSyncStatus').textContent = '불러오기 실패: ' + err.message;
      }
      return false;
    }
  }

  $('#openSheetSyncBtn').addEventListener('click', function(){
    $('#sheetUrlInput').value = ls.get('gs.sheetUrl', '');
    $('#sheetSyncModal').hidden = false;
  });
  $('#closeSheetSyncBtn').addEventListener('click', function(){
    $('#sheetSyncModal').hidden = true;
  });
  $('#syncSheetNowBtn').addEventListener('click', function(){
    syncGoogleSheetSongs($('#sheetUrlInput').value, false);
  });
  $('#clearSheetSyncBtn').addEventListener('click', function(){
    ls.set('gs.sheetUrl', '');
    sheetSongs = [];
    $('#sheetUrlInput').value = '';
    $('#openSheetSyncBtn').textContent = '구글 시트 연동';
    $('#sheetSyncStatus').textContent = '구글 시트 연동이 해제되었어요.';
    rebuildSongSelect((BUILTIN_SONGS[0] ? BUILTIN_SONGS[0].id : (allSongs[0] ? allSongs[0].id : null)));
  });

  $('#copySheetTemplateBtn').addEventListener('click', async function(){
    var header = ['곡 제목', '박자', 'BPM', '교본 쪽수/설명', '마디 악보 (줄바꿈 또는 / 로 마디 구분)'].join('\t');
    var sample1 = formatSongToSheetTsv(
      '징글 벨즈 (교본 24쪽)',
      4,
      64,
      '교본 24쪽 · 2,3번줄 연습',
      [
        '[G] B3 B3 B3 - | 종 소 리 - (0시 0시 0시)',
        '[G] B3 B3 B3 - | 울 려 라 - (0시 0시 0시)',
        '[G] B3 D4 G3 A3 | 종 소 리 울 (0시 3레 0솔 2라)',
        '[G] B3 - - - | 려 - - - (0시 4박)'
      ]
    );
    var tsv = header + '\n' + sample1;
    try {
      await navigator.clipboard.writeText(tsv);
      $('#sheetSyncStatus').textContent = '시트 기본 양식이 복사되었어요! 새 구글 스프레드시트의 A1 칸을 클릭하고 Ctrl+V를 누르세요.';
    } catch (e){
      prompt('새 구글 시트 A1 칸에 붙여넣을 양식:', tsv);
    }
  });

  $('#copyCurSongTsvBtn').addEventListener('click', async function(){
    if (!curSong || curSong.type !== 'structured'){
      alert('구조화된(계이름) 악보가 선택되어 있을 때만 시트 행으로 복사할 수 있어요.');
      return;
    }
    var lines = curSong.measures.map(function(m){
      var bStr = m.beats.map(function(b){ return (b.tok && b.tok !== '-') ? b.tok : (b.en || '-'); }).join(' ');
      var chTag = !m.chord ? '-' : (m.chord + (m.autoChord ? '(자동)' : ''));
      return '[' + chTag + '] ' + bStr + ' | ' + (m.lyric || '');
    });
    var tsv = formatSongToSheetTsv(curSong.title, curSong.beats, curSong.bpm, curSong.badge, lines);
    try {
      await navigator.clipboard.writeText(tsv);
      $('#sheetSyncStatus').textContent = '"' + curSong.title + '" 곡이 한 줄(TSV)로 복사되었어요! 구글 시트 빈 행의 A열에 Ctrl+V로 붙여넣으세요.';
    } catch (e){
      prompt('구글 시트 A열에 붙여넣을 내용:', tsv);
    }
  });

  // ---------- 초기화 및 곡 목록 구성
  function syncCompactSongSelectOptions(){
    var cSel = $('#compactSongSelect');
    if (!cSel) return;
    cSel.textContent = '';

    var grp1 = document.createElement('optgroup');
    grp1.label = '내장 악보';
    BUILTIN_SONGS.forEach(function(s){
      var opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      grp1.appendChild(opt);
    });
    cSel.appendChild(grp1);

    if (sheetSongs.length){
      var grpSheet = document.createElement('optgroup');
      grpSheet.label = '구글 시트 연동';
      sheetSongs.forEach(function(s){
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = '☁️ ' + s.title;
        grpSheet.appendChild(opt);
      });
      cSel.appendChild(grpSheet);
    }

    if (customSongs.length){
      var grp2 = document.createElement('optgroup');
      grp2.label = '내 저장 악보';
      customSongs.forEach(function(s){
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.title;
        grp2.appendChild(opt);
      });
      cSel.appendChild(grp2);
    }

    if (curSong) cSel.value = curSong.id;
  }

  function rebuildSongSelect(selectId){
    stopPractice(false);
    allSongs = BUILTIN_SONGS.concat(sheetSongs).concat(customSongs);
    var sel = $('#songSelect');
    sel.textContent = '';

    var grp1 = document.createElement('optgroup');
    grp1.label = '내장 악보 (songs.json · 저작권 무료 동요/교본)';
    BUILTIN_SONGS.forEach(function(s){
      var opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      grp1.appendChild(opt);
    });
    sel.appendChild(grp1);

    if (sheetSongs.length){
      var grpSheet = document.createElement('optgroup');
      grpSheet.label = '내 구글 드라이브 스프레드시트 연동 악보';
      sheetSongs.forEach(function(s){
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = '☁️ ' + s.title;
        grpSheet.appendChild(opt);
      });
      sel.appendChild(grpSheet);
    }

    if (customSongs.length){
      var grp2 = document.createElement('optgroup');
      grp2.label = '이 기기에 저장된 악보 (IndexedDB)';
      customSongs.forEach(function(s){
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.title;
        grp2.appendChild(opt);
      });
      sel.appendChild(grp2);
    }

    syncCompactSongSelectOptions();

    var target = allSongs.find(function(s){ return s.id === selectId; }) || allSongs[0];
    sel.value = target.id;
    if ($('#compactSongSelect')) $('#compactSongSelect').value = target.id;
    curSong = target;
    appState.lastSongId = target.id;
    appState.bpm = Number(target.bpm) || 64;
    renderSong();
    saveAppState();
  }

  function changeSongById(songId){
    stopPractice(false);
    curMeasureIdx = 0;
    curBeatIdx = 0;
    var found = allSongs.find(function(s){ return s.id === songId; });
    if (found){
      curSong = found;
      appState.lastSongId = found.id;
      appState.bpm = Number(found.bpm) || 64;
      if ($('#songSelect')) $('#songSelect').value = found.id;
      if ($('#compactSongSelect')) $('#compactSongSelect').value = found.id;
      renderSong();
      saveAppState();
      if (appState.isCompactPractice && curSong.type === 'structured'){
        var card = $('#measuresGrid .measure-card[data-m="0"]');
        var nextCard = $('#measuresGrid .measure-card[data-m="1"]');
        if (card) scrollScoreLookAhead($('#structuredScoreWrap'), card, nextCard, 0);
      }
    }
  }

  $('#songSelect').addEventListener('change', function(e){
    changeSongById(e.target.value);
  });

  if ($('#compactSongSelect')){
    $('#compactSongSelect').addEventListener('change', function(e){
      changeSongById(e.target.value);
    });
  }

  // 앱 부팅: songs.json 로드 + IndexedDB 로드 + 구글 시트 자동 동기화
  initFretboard();
  initEditor();
  buildFretboard();
  renderHistoryTable();
  setCompactPractice(false);
  Promise.all([
    loadExternalSongsJson(),
    dbGetAllSongs()
  ]).then(async function(results){
    var rawDbSongs = results[1] || [];
    var cleanCustom = [];
    for (var i = 0; i < rawDbSongs.length; i++){
      var s = rawDbSongs[i];
      // 이전 버그로 인해 구글 시트 곡(sheet-song-*)이 IndexedDB에 중복 저장된 경우 자동 정리
      if (s && (s.fromSheet || String(s.id).indexOf('sheet-song-') === 0)){
        await dbDeleteSong(s.id);
      } else if (s){
        cleanCustom.push(s);
      }
    }
    customSongs = cleanCustom;
    var savedSheetUrl = ls.get('gs.sheetUrl', '');
    if (savedSheetUrl){
      await syncGoogleSheetSongs(savedSheetUrl, true);
    }
    rebuildSongSelect(appState.lastSongId);
  });
