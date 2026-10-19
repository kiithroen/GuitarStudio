'use strict';

  var $ = function(s){ return document.querySelector(s); };
  var $$ = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };

  // ---------- 기본 내장 클래식 기타 동요 / 교본 명곡 (songs.json 단일 소스에서 로드)
  var BUILTIN_SONGS = [];
  var BUILTIN_LEVEL_NAMES = { 1: '입문', 2: '초급', 3: '초중급', 4: '중급', 5: '중상급' };

  // ---------- 저장 오류 안내
  var STORAGE_ERROR_MESSAGE = '이 기기에 저장하지 못했어요. 저장 공간과 브라우저 설정을 확인한 뒤 다시 시도해 주세요.';
  function reportStorageError(){
    var status = $('#storageStatus');
    if (status){
      status.textContent = STORAGE_ERROR_MESSAGE;
      status.hidden = false;
    }
  }
  function clearStorageError(){
    var status = $('#storageStatus');
    if (status) status.hidden = true;
  }
  async function persistImageSong(song){
    if (!song || song.type !== 'image'){ reportStorageError(); return false; }
    try { await dbSaveImageSong(song); return true; }
    catch (error){ reportStorageError(error); return false; }
  }
  async function removePersistedImageSong(id){
    try { await dbDeleteImageSong(id); return true; }
    catch (error){ reportStorageError(error); return false; }
  }

  // ---------- 앱 전역 상태
  var imageSongs = [];
  var allSongs = [];
  var curSong = null;
  var curMeasureIdx = 0;
  var curBeatIdx = 0;
  var songSessionStates = Object.create(null);

  function stripRemovedAudioSettings(state){
    var clean = Object.assign({}, state || {});
    delete clean.micScoring;
    delete clean.micDeviceId;
    return clean;
  }
  var CLICK_MODES = ['all', 'countin', 'off']; // 메트로놈 클릭: 'all' 카운트인+재생 내내 / 'countin' 시작 전 한 마디만 / 'off' 카운트인 없이 바로 시작
  var appState = stripRemovedAudioSettings(ls.get('gs.state', {
    lastSongId: 'builtin-lv1-butterfly',
    bpm: 64,
    beats: 4,
    vol: 0.55,
    guideSound: true,
    acousticFx: true, // 고품질 음향 효과 (콘서트홀 리버브, 바디 공명, 2단 서스테인) 토글
    loopEnable: true,
    loopStart: 1,
    loopEnd: 8,
    speedTrainer: false,
    audioOffsetMs: 0
  }));
  if (typeof appState.acousticFx !== 'boolean') appState.acousticFx = true;
  if (typeof appState.audioOffsetMs !== 'number') appState.audioOffsetMs = 0;
  if (appState.synthEngine !== 'classic') appState.synthEngine = 'ks'; // 기타 음원: 'ks' 물리 모델 / 'classic' 기존 합성음
  if (typeof appState.bodyAmount !== 'number') appState.bodyAmount = 1.0; // 울림통 공명 세기 (0~2, 1이 기본)
  if (typeof appState.sympAmount !== 'number') appState.sympAmount = 1.0; // 공명현 세기 (0~2, 0이면 꺼짐)
  if (appState.scoreView !== 'card') appState.scoreView = 'tab'; // 악보 보기 모드: 'tab' 6현 타브(기본) / 'card' 박자 카드
  if (CLICK_MODES.indexOf(appState.clickMode) < 0) appState.clickMode = 'all';
  if (appState.notationMode !== 'solfege') appState.notationMode = 'cde';
  appState.isCompactPractice = false;


function curCapo(){
  return curSong ? getSongCapo(curSong) : 0;
}


  // 이미지 악보 편집 상태
  var imgEditMode = true;
  var dragCreate = null;
  var selectedImgBar = null; // { sysIdx, barIdx }

  // 오디오 및 메트로놈 런타임 (어쿠스틱 바디 공명 + 콘서트홀 리버브 버스 포함)
  var actx = null, outGain = null;
  var guitarBus = null, reverbNode = null, pluckNoiseBuf = null, clickBus = null;
  var dryGainNode = null, wetGainNode = null, bodyModes = [];
  var stringVoices = {}; // 줄 번호(1~6)별 현재 울리고 있는 보이스 목록 (같은 줄 재탄현 시 이전 음 정지용)
  // 기타 마스터 음량: 화음과 명시 아포얀도의 동시 탄현을 고려한 공통 출력 레벨
  var GUITAR_MASTER_GAIN = 0.75;
  var isPlaying = false;
  var playSession = null;

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
  function fmtDate(ts){
    var d = new Date(ts), p = function(n){ return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function safeAppStateForPersistence(){
    var stored = Object.assign({}, appState);
    var draftStatus = curSong && curSong.type === 'structured' && scoreDrafts
      ? scoreDrafts.status(curSong.id)
      : {dirty:false,temporary:false};
    var isUnpersistedSong = !!(curSong && curSong.type === 'structured' && (draftStatus.dirty || draftStatus.temporary));
    if (isUnpersistedSong){
      var persisted = ls.get('gs.state', {});
      var sources = BUILTIN_SONGS.concat(sheetSongs).concat(imageSongs);
      var persistedSong = sources.find(function(song){ return song.id === (persisted && persisted.lastSongId); });
      if (persistedSong){
        stored.lastSongId = persistedSong.id;
        stored.beats = persisted.beats || persistedSong.beats || 4;
        stored.bpm = persisted.bpm || persistedSong.bpm || 64;
        stored.loopStart = persisted.loopStart || 1;
        stored.loopEnd = persisted.loopEnd || getMeasureCount(persistedSong);
      } else {
        var fallback = BUILTIN_SONGS[0] || sheetSongs[0] || imageSongs[0] || null;
        stored.lastSongId = fallback ? fallback.id : '';
        if (fallback){
          stored.beats = fallback.beats || 4;
          stored.bpm = Number(fallback.bpm) || 64;
          stored.loopStart = 1;
          stored.loopEnd = getMeasureCount(fallback);
        } else {
          stored.beats = 4;
          stored.bpm = 64;
          stored.loopStart = 1;
          stored.loopEnd = 1;
        }
      }
    }
    return stored;
  }

  function rememberCurrentSession(){
    if (!curSong) return;
    songSessionStates[curSong.id] = {
      bpm:appState.bpm,
      loopStart:appState.loopStart,
      loopEnd:appState.loopEnd,
      measure:curMeasureIdx,
      beat:curBeatIdx
    };
  }

  function restoreSongSession(song){
    var snapshot = song && songSessionStates[song.id];
    if (!snapshot || !song) return false;
    var count = Math.max(1, getMeasureCount(song));
    appState.bpm = Math.max(30, Math.min(240, Math.round(Number(snapshot.bpm) || Number(song.bpm) || 64)));
    appState.loopStart = Math.max(1, Math.min(count, Number(snapshot.loopStart) || 1));
    appState.loopEnd = Math.max(appState.loopStart, Math.min(count, Number(snapshot.loopEnd) || count));
    curMeasureIdx = Math.max(0, Math.min(count - 1, Number(snapshot.measure) || 0));
    curBeatIdx = Math.max(0, Math.min((song.beats || 1) - 1, Number(snapshot.beat) || 0));
    $('#loopStart').max = count;
    $('#loopEnd').max = count;
    $('#loopStart').value = appState.loopStart;
    $('#loopEnd').value = appState.loopEnd;
    syncConsoleUI();
    updateLoopClasses();
    updateActiveCursor(curMeasureIdx, curBeatIdx, false);
    return true;
  }

  function saveAppState(){
    if (curSong){
      rememberCurrentSession();
      curSong.lastBpm = appState.bpm;
      curSong.lastLoopStart = appState.loopStart;
      curSong.lastLoopEnd = appState.loopEnd;
      curSong.lastPracticedAt = Date.now();
      if (curSong.type === 'image') persistImageSong(curSong);
      else if (!(scoreDrafts && scoreDrafts.status(curSong.id).dirty) && !(scoreDrafts && scoreDrafts.status(curSong.id).temporary)) ls.set('gs.builtinMeta.' + curSong.id, {
        bpm: curSong.lastBpm,
        loopStart: curSong.lastLoopStart,
        loopEnd: curSong.lastLoopEnd,
        ytUrl: curSong.ytUrl || '',
        at: curSong.lastPracticedAt
      });
    }
    ls.set('gs.state', safeAppStateForPersistence());
  }

  // ---------- 악보 렌더링: 1) 내장/텍스트 구조화 악보
  function renderSong(){
    if (!curSong) return;
    if (curSong.type === 'structured' && Array.isArray(curSong.measures)){
      var tokenMeasures = curSong.measures.map(function(measure){
        return {
          chord:measure.chord || '-',
          autoChord:!!measure.autoChord,
          notes:(measure.beats || []).map(function(beat){ return beat && beat.tok != null ? beat.tok : ''; }),
          lyric:measure.lyric || ''
        };
      });
      var tokenSource = serializeScoreMeasures(tokenMeasures, '\n');
      var reparsedSong = parseScore(tokenSource, curSong.beats || 4);
      curSong.measures = reparsedSong.measures;
      if (reparsedSong.errors.length && $('#phaseTxt')){
        var sourceError = reparsedSong.errors[0];
        $('#phaseTxt').textContent = '악보 확인 필요 · ' + (sourceError.measure ? sourceError.measure + '마디 ' : '') + (sourceError.beat ? sourceError.beat + '박: ' : '') + sourceError.message;
      }
    }
    var uncertainBadgeEl = $('#uncertainBadge');
    if (uncertainBadgeEl){
      var uncertainCount = curSong.type === 'structured' && Array.isArray(curSong.measures) ? countUncertainBeats(curSong.measures) : 0;
      uncertainBadgeEl.hidden = uncertainCount === 0;
      if (uncertainCount > 0) uncertainBadgeEl.textContent = '확인 ' + uncertainCount + '곳';
    }
    var songCapo = getSongCapo(curSong);
    var capoBadgeTxt = (songCapo > 0 && !/(?:capo|카포)\s*[:.]?\s*(?:fret\s*)?\d/i.test(curSong.badge || '')) ? (' · Capo ' + songCapo) : '';
    $('#scoreTitle').textContent = curSong.title;
    $('#scoreTypeBadge').textContent = (curSong.badge || (curSong.type === 'image' ? '교본 사진/PDF 악보' : '텍스트 악보')) + capoBadgeTxt;
    var canRenameOrDelete = curSong.type === 'image';
    $('#deleteSongBtn').hidden = !canRenameOrDelete;
    $('#deleteSongBtn').textContent = '삭제';
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
      $('#editBarMetaBtn').hidden = true;
      syncScoreModeUI();
      renderStructuredMeasures();
      if (scoreEditorHooks) scoreEditorHooks.refreshStatus();
    } else {
      $('#structuredScoreWrap').hidden = true;
      $('#imageScoreWrap').hidden = false;
      $('#editBarMetaBtn').hidden = false;
      syncScoreModeUI();
      renderImageScore();
      if (scoreEditorHooks) scoreEditorHooks.refreshStatus();
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
    var maxSubParts = (curSong.measures || []).reduce(function(maxParts, measure){
      return (measure.beats || []).reduce(function(measureMax, beat){
        return Math.max(measureMax, beat.subNotes && beat.subNotes.length || 1);
      }, maxParts);
    }, 1);
    if (isTab){
      var requiredMinWidth = curSong.beats * maxSubParts * 48 + 56;
      var existingMinWidth = curSong.beats >= 9 ? 560 : (curSong.beats >= 8 ? 460 : (curSong.beats >= 6 ? 330 : 250));
      grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + Math.max(existingMinWidth, requiredMinWidth) + 'px,1fr))';
    } else {
      var cardBeatWidth = maxSubParts >= 3 ? 108 : (maxSubParts >= 2 ? 88 : 68);
      var requiredCardMinWidth = curSong.beats * cardBeatWidth + 32;
      var existingCardMinWidth = curSong.beats >= 9 ? 560 : (curSong.beats >= 8 ? 460 : (curSong.beats >= 6 ? 340 : 260));
      grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + Math.max(existingCardMinWidth, requiredCardMinWidth) + 'px,1fr))';
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
      if (scoreEditorHooks) scoreEditorHooks.appendMeasureMenu(head, mIdx);
      card.appendChild(head);

      if (scoreEditorHooks && scoreEditorHooks.isEditingMeasure(mIdx)){
        scoreEditorHooks.renderInlineEditor(card, mIdx);
        card.addEventListener('click', function(event){ event.stopPropagation(); });
        grid.appendChild(card);
        scoreEditorHooks.appendInsertDraftCard(grid, mIdx);
        return;
      }

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
          var uniformArticulation = getUniformBeatArticulation(b);
          if (((curSong.beats === 9 || curSong.beats === 6) && (bIdx === 3 || bIdx === 6)) || (curSong.beats === 8 && bIdx === 4)){
            extraCls += ' arp-group-start';
          }
          if (b.uncertain) extraCls += ' is-uncertain';
          cell.className = 'beat-cell' + extraCls;
          cell.dataset.m = mIdx;
          cell.dataset.b = bIdx;
          var beatToken = b.tok || b.customTok || b.en;
          var effBass = getExplicitBass(b);
          var pitchLabel = formatBeatPitchLabel(b, {compact:false, chord:cleanChordToken(m.chord || '')});
          var articDesc = uniformArticulation === 'apoyando'
            ? ' [악보 지정 아포얀도]'
            : (uniformArticulation === 'tirando' ? ' [악보 지정 티란도]' : '');
          var tabDurationInfo = getBeatDurationInfo(m.beats, bIdx, curSong.beats);
          cell.title = m.no + '마디 ' + (bIdx + 1) + '박' + (pitchLabel ? ': ' + pitchLabel : '') +
            (pitchLabel && tabDurationInfo.durName && tabDurationInfo.kind !== 'rest' && tabDurationInfo.kind !== 'hold' ? ' · 길이: ' + tabDurationInfo.durName : '') +
            articDesc + ' (클릭: 운지 보기 및 음 듣기)' + (b.uncertain ? ' · 확인 필요(?)' : '');

          var topRow = document.createElement('div');
          topRow.className = 'tab-cell-top';
          if (b.midi || (b.isSubdivided && b.subNotes) || b.kind === 'rest' || b.kind === 'hold'){
            var solfegeWrap = document.createElement('span');
            solfegeWrap.className = 'tab-cell-solfege-wrap';

            var enEl = document.createElement('span');
            enEl.className = 'tab-cell-en';

            enEl.textContent = formatBeatPitchLabel(b, {compact:true, chord:cleanChordToken(m.chord || '')});
            if (enEl.textContent){
              solfegeWrap.appendChild(enEl);
              topRow.appendChild(solfegeWrap);
            }
          }
          cell.appendChild(topRow);

          var gridEl = document.createElement('div');
          gridEl.className = 'tab-cell-grid';

          if (b.kind === 'rest' || b.kind === 'hold'){
            var marker = document.createElement('span');
            marker.className = 'tab-rest-dash ' + (b.kind === 'hold' ? 'tab-hold-mark' : 'tab-rest-mark');
            marker.textContent = b.kind === 'hold' ? '—' : 'r';
            marker.title = b.kind === 'hold' ? '앞 음을 다시 치지 않고 유지' : '쉼';
            gridEl.appendChild(marker);
            if (b.kind === 'hold' && typeof GuitarRhythm !== 'undefined'){
              var heldRecords = GuitarRhythm.getSoundingNotes(curSong.measures, b.startUnits);
              heldRecords.forEach(function(record){
                var heldNote = record.note;
                if (!heldNote.str) return;
                var heldPill = document.createElement('span');
                heldPill.className = 'tab-fret-pill note-fret tab-held-fret';
                heldPill.style.top = ((heldNote.str - 1) * 20) + '%';
                heldPill.textContent = String(heldNote.fret != null ? heldNote.fret : 0);
                var heldToken = heldNote.tok || heldNote.customTok || heldNote.en;
                var heldFinger = getExplicitLeftHand(heldToken);
                if (heldFinger != null){
                  var heldLh = document.createElement('span');
                  heldLh.className = 'tab-cell-lh';
                  heldLh.textContent = '(' + heldFinger + ')';
                  heldPill.appendChild(heldLh);
                }
                gridEl.appendChild(heldPill);
              });
            }
          } else if (!b.isSubdivided && b.chordNotes && b.chordNotes.length > 2){
            b.chordNotes.forEach(function(cn, cnIdx){
              if (cn.str){
                var cPill = document.createElement('span');
                cPill.className = 'tab-fret-pill note-fret';
                cPill.style.top = ((cn.str - 1) * 20) + '%';
                cPill.textContent = String(cn.fret != null ? cn.fret : 0);
                var explicitLH = getExplicitLeftHand(beatToken, cnIdx);
                if (explicitLH != null){
                  var clh = document.createElement('span');
                  clh.className = 'tab-cell-lh';
                  clh.textContent = '(' + explicitLH + ')';
                  cPill.appendChild(clh);
                }
                appendExplicitRightHand(cPill, beatToken, cnIdx);
                gridEl.appendChild(cPill);
              }
            });
          } else if (b.isSubdivided && b.subNotes && b.subNotes.length > 1){
            var numSubs = b.subNotes.length;
            b.subNotes.forEach(function(sn, sIdx){
              var leftPct = (((sIdx + 0.5) / numSubs) * 100) + '%';
              var subToken = sn.tok || sn.customTok || sn.en;
              function addSubPill(note, transform, componentIndex){
                if (!note || !note.str) return;
                var pill = document.createElement('span');
                pill.className = 'tab-fret-pill note-fret';
                pill.style.position = 'absolute';
                pill.style.top = ((note.str - 1) * 20) + '%';
                pill.style.left = leftPct;
                pill.style.transform = transform || 'translate(-50%, -50%)';
                pill.textContent = String(note.fret != null ? note.fret : 0);
                var explicitLH = getExplicitLeftHand(subToken, componentIndex);
                if (explicitLH != null){
                  var lh = document.createElement('span');
                  lh.className = 'tab-cell-lh';
                  lh.textContent = '(' + explicitLH + ')';
                  pill.appendChild(lh);
                }
                appendExplicitRightHand(pill, subToken, componentIndex);
                gridEl.appendChild(pill);
              }
              if (sn.kind === 'hold' || sn.kind === 'rest' || sn.tok === '-' || GuitarNotation.isRestToken(sn.tok)){
                var dash = document.createElement('span');
                dash.className = 'tab-rest-dash ' + (sn.kind === 'hold' || sn.tok === '-' ? 'tab-hold-mark' : 'tab-rest-mark');
                dash.textContent = (sn.kind === 'hold' || sn.tok === '-') ? '—' : 'r';
                dash.title = (sn.kind === 'hold' || sn.tok === '-') ? '앞 음을 다시 치지 않고 유지' : '쉼';
                dash.style.position = 'absolute';
                dash.style.left = leftPct;
                dash.style.top = '50%';
                dash.style.transform = 'translate(-50%, -50%)';
                dash.style.opacity = '0.4';
                gridEl.appendChild(dash);
                if ((sn.kind === 'hold' || sn.tok === '-') && typeof GuitarRhythm !== 'undefined'){
                  var subHeldRecords = GuitarRhythm.getSoundingNotes(curSong.measures, sn.startUnits);
                  subHeldRecords.forEach(function(record){
                    var heldNote = record.note;
                    if (!heldNote.str) return;
                    var heldPill = document.createElement('span');
                    heldPill.className = 'tab-fret-pill note-fret tab-held-fret';
                    heldPill.style.position = 'absolute';
                    heldPill.style.top = ((heldNote.str - 1) * 20) + '%';
                    heldPill.style.left = leftPct;
                    heldPill.style.transform = 'translate(-50%, -50%)';
                    heldPill.textContent = String(heldNote.fret != null ? heldNote.fret : 0);
                    var heldToken = heldNote.tok || heldNote.customTok || heldNote.en;
                    var heldFinger = getExplicitLeftHand(heldToken);
                    if (heldFinger != null){
                      var heldLh = document.createElement('span');
                      heldLh.className = 'tab-cell-lh';
                      heldLh.textContent = '(' + heldFinger + ')';
                      heldPill.appendChild(heldLh);
                    }
                    gridEl.appendChild(heldPill);
                  });
                }
              } else if (sn.chordNotes && sn.chordNotes.length > 2){
                sn.chordNotes.forEach(function(cn, componentIndex){ addSubPill(cn, null, componentIndex); });
              } else if (sn.chordNotes && sn.chordNotes.length === 2){
                var subBass = getExplicitBass(sn);
                var pairSameStr = !!(subBass && subBass.str && sn.str && subBass.str === sn.str);
                var pairSameFret = pairSameStr && subBass.fret === sn.fret;
                var pairBassTransform = pairSameStr && !pairSameFret ? 'translate(-85%, -50%)' : null;
                var pairMelTransform = pairSameStr && !pairSameFret ? 'translate(-15%, -50%)' : null;
                if (subBass && subBass.midi) addSubPill(subBass, pairBassTransform, 0);
                if (sn.midi && !pairSameFret) addSubPill(sn, pairMelTransform, 1);
              } else if (sn.midi && sn.str){
                var mPill = document.createElement('span');
                mPill.className = 'tab-fret-pill note-fret';
                mPill.style.position = 'absolute';
                mPill.style.top = ((sn.str - 1) * 20) + '%';
                mPill.style.left = leftPct;
                mPill.style.transform = 'translate(-50%, -50%)';
                mPill.textContent = String(sn.fret != null ? sn.fret : 0);
                var explicitLH = getExplicitLeftHand(subToken, 0);
                if (explicitLH != null){
                  var mlh = document.createElement('span');
                  mlh.className = 'tab-cell-lh';
                  mlh.textContent = '(' + explicitLH + ')';
                  mPill.appendChild(mlh);
                }
                appendExplicitRightHand(mPill, subToken, 0);
                gridEl.appendChild(mPill);
              }
            });
          } else {
            var hasBass = !!(effBass && effBass.str);
            var hasMel = !!(b.midi && b.str);
            var sameStr = hasBass && hasMel && (effBass.str === b.str);
            var sameFret = sameStr && (effBass.fret === b.fret);
            var diffFret = sameStr && (effBass.fret !== b.fret);

            // 1. 낮은 구성음 프렛
            if (hasBass){
              var bPill = document.createElement('span');
              bPill.className = 'tab-fret-pill note-fret';
              bPill.style.top = ((effBass.str - 1) * 20) + '%';
              if (diffFret){
                bPill.style.left = '38%';
              }
              bPill.textContent = String(effBass.fret != null ? effBass.fret : 0);
              var bassLH = getExplicitLeftHand(beatToken, 0);
              if (bassLH != null){
                var blh = document.createElement('span');
                blh.className = 'tab-cell-lh';
                blh.textContent = '(' + bassLH + ')';
                bPill.appendChild(blh);
              }
              appendExplicitRightHand(bPill, beatToken, 0);
              gridEl.appendChild(bPill);
            }

            // 2. 높은 구성음 프렛
            if (hasMel){
              if (!sameFret){
                var mPill = document.createElement('span');
                mPill.className = 'tab-fret-pill note-fret';
                mPill.style.top = ((b.str - 1) * 20) + '%';
                if (diffFret){
                  mPill.style.left = '62%';
                }
                mPill.textContent = String(b.fret != null ? b.fret : 0);
                var melodyLH = getExplicitLeftHand(beatToken, b.chordNotes && b.chordNotes.length >= 2 ? 1 : undefined);
                if (melodyLH != null){
                  var mlh = document.createElement('span');
                  mlh.className = 'tab-cell-lh';
                  mlh.textContent = '(' + melodyLH + ')';
                  mPill.appendChild(mlh);
                }
                appendExplicitRightHand(mPill, beatToken, b.chordNotes && b.chordNotes.length >= 2 ? 1 : 0);
                gridEl.appendChild(mPill);
              }
            } else if (!hasMel && !hasBass){
              var dash = document.createElement('span');
              dash.className = 'tab-rest-dash ' + (b.kind === 'hold' ? 'tab-hold-mark' : 'tab-rest-mark');
              dash.textContent = b.kind === 'hold' ? '—' : 'r';
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
          var uniformArticulation = getUniformBeatArticulation(b);
          if (((curSong.beats === 9 || curSong.beats === 6) && (bIdx === 3 || bIdx === 6)) || (curSong.beats === 8 && bIdx === 4)){
            extraCls += ' arp-group-start';
          }
          var mainKind = b.kind || (b.midi ? 'note' : 'rest');
          var pitchLabel = formatBeatPitchLabel(b, {compact:false, chord:cleanChordToken(m.chord || '')});
          if (mainKind === 'rest'){
            extraCls += ' is-rest';
          }
          if (b.uncertain) extraCls += ' is-uncertain';
          cell.className = 'beat-cell' + extraCls;
          cell.dataset.m = mIdx;
          cell.dataset.b = bIdx;

          var articDesc = uniformArticulation === 'apoyando'
            ? ' [악보 지정 아포얀도]'
            : (uniformArticulation === 'tirando' ? ' [악보 지정 티란도]' : '');

          var detailDesc = m.no + '마디 ' + (bIdx + 1) + '박: ' +
            (mainKind === 'rest' ? '쉼' : (mainKind === 'hold' ? '유지' : (pitchLabel + ' · ' + durInfo.durName))) +
            (durInfo.kind === 'group' ? ' · 분할별 길이: ' + durInfo.durName : '') +
            articDesc + ' (클릭: 음 듣기 및 지판 확인)' + (b.uncertain ? ' · 확인 필요(?)' : '');
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
            if (!durInfo.svg) durBadge.textContent = durInfo.label || durInfo.durName;
            durBadge.title = durInfo.durName;
            rhythmHead.appendChild(durBadge);
          }
          cell.appendChild(rhythmHead);

          // 2. 오선지 음이름 (계이름) 또는 쉼표 기호 (한글 쉼표 대신 1박 옆에 있던 음표/쉼표 기호만 표시)
          var isSolfege = appState.notationMode === 'solfege';
          var koEl = document.createElement('span');
          if (b.midi || (b.isSubdivided && b.subNotes)){
            koEl.className = 'b-ko-main';
            function getDisplayPitch(p){
              if (p.kind === 'rest' || GuitarNotation.isRestToken(p.tok)) return '쉼';
              if (p.kind === 'hold' || p.ko === '유지') return '유지';
              if (p.chordNotes && p.chordNotes.length >= 2){
                return p.chordNotes.map(function(c){ return isSolfege ? c.ko : (c.en ? c.en.replace(/\d+$/, '') : c.ko); }).join('·');
              }
              return isSolfege ? p.ko : (p.en ? p.en.replace(/\d+$/, '') : p.ko);
            }
            if (!b.isSubdivided && b.chordNotes && b.chordNotes.length >= 2){
              koEl.textContent = b.chordNotes.map(function(c){ return isSolfege ? c.ko : (c.en ? c.en.replace(/\d+$/, '') : c.ko); }).join('·');
            } else if (b.isSubdivided && b.subNotes){
              koEl.textContent = b.subNotes.map(getDisplayPitch).join(' · ');
            } else {
              koEl.textContent = isSolfege ? b.ko : (b.en ? b.en.replace(/\d+$/, '') : b.ko);
            }
            var koLen = koEl.textContent.length;
            if (koLen >= 7){
              koEl.classList.add('b-ko-ultra');
            } else if (koLen >= 5){
              koEl.classList.add('b-ko-dense');
            }
            cell.appendChild(koEl);

            // 3. 옥타브 위치 및 영문 음높이 서브 표기 (가온 C4, 중간 E4 등)
            var subEl = document.createElement('span');
            subEl.className = 'b-note-sub';
            subEl.textContent = (!b.isSubdivided && (!b.chordNotes || b.chordNotes.length < 2) ? getOctaveLabel(b.midi) + ' ' : '') + formatBeatPitchLabel(b, {compact:false, chord:cleanChordToken(m.chord || '')});
            cell.appendChild(subEl);
            var rightHandLabel = getBeatRightHandLabel(b);
            if (rightHandLabel){
              var rightHandEl = document.createElement('span');
              rightHandEl.className = 'b-right-hand';
              rightHandEl.textContent = rightHandLabel;
              cell.appendChild(rightHandEl);
            }
          } else if (mainKind === 'hold') {
            koEl.className = 'b-ko-main b-hold-label';
            koEl.textContent = '유지';
            cell.appendChild(koEl);
          } else {
            koEl.className = 'b-ko-main b-rest-sym';
            koEl.textContent = '쉼';
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
        updateActiveCursor(curMeasureIdx, curBeatIdx, false);
      });

      grid.appendChild(card);
      if (scoreEditorHooks) scoreEditorHooks.appendInsertDraftCard(grid, mIdx);
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
          if (sys.bars.length < 10){ sys.bars.push({ chord: '', note: '', memo: '', w: 1 }); syncAfterImageGridChange(); }
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
    persistImageSong(curSong);
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
        persistImageSong(curSong);
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
          bars: new Array(4).fill(null).map(function(){ return { chord: '', note: '', memo: '', w: 1 }; })
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
      var effBass = getExplicitBass(beatObj);
      var targetForFb = (beatObj && beatObj.isSubdivided && beatObj.subNotes)
        ? beatObj.subNotes[0]
        : beatObj;
      if (targetForFb && targetForFb.kind === 'hold' && typeof GuitarRhythm !== 'undefined'){
        targetForFb = GuitarRhythm.resolveHold(curSong.measures, targetForFb);
      } else if (targetForFb && targetForFb.kind === 'rest'){
        targetForFb = null;
      }
      highlightFretboard(m.chord, targetForFb, false, m.autoChord, bIdx);
      if (playPreviewSound){
        ensureAudioCtx();
        var nowT = actx.currentTime;
        if (typeof stopGuitarNotes === 'function') stopGuitarNotes(nowT);
        var songCapo = getSongCapo(curSong);
        if (beatObj && typeof scheduleBeatGuide === 'function'){
          var previewEndMeasure = Math.min(getMeasureCount(curSong) - 1, appState.loopEnd - 1);
          var previewRemainingSlots = Math.max(0, ((previewEndMeasure - mIdx + 1) * curSong.beats) - bIdx);
          scheduleBeatGuide(beatObj, {
            startTime:nowT,
            slotDuration:60 / appState.bpm,
            measures:curSong.measures,
            resumeHold:true,
            maxDurationSlots:previewRemainingSlots,
            capo:songCapo
          });
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
      var barData = getFlatImageBar(mIdx);
      var parsedNote = barData && barData.note ? parseNoteToken(barData.note, 0) : null;
      highlightFretboard(barData && barData.chord ? barData.chord : '', parsedNote, false, false, bIdx);
      if (playPreviewSound && parsedNote && parsedNote.midi){
        var songCapo = getSongCapo(curSong);
        playGuitarNote(soundingMidi(parsedNote.midi, songCapo), 0.75, null, null, null, parsedNote.pos && parsedNote.pos.str);
      }
    }
  }

  // ---------- 메트로놈 재생 루프 (카운트인 + 마디 진행 + 구간 반복 + 자동 가속)
  function startPractice(){
    if (scoreEditorHooks && !scoreEditorHooks.beforeAction('연습 시작')) return;
    if (isPlaying) return;
    if (curSong && curSong.type === 'structured'){
      var validation = validateScore(serializeScoreMeasures(curSong.measures, '\n'), curSong.beats || appState.beats);
      if (validation.errors.length){
        var firstError = validation.errors[0];
        $('#phaseTxt').textContent = '재생할 수 없는 악보 · ' + (firstError.measure ? firstError.measure + '마디 ' : '') + (firstError.beat ? firstError.beat + '박: ' : '') + firstError.message;
        return;
      }
    }
    ensureAudioCtx();
    if (typeof stopGuitarNotes === 'function') stopGuitarNotes(actx.currentTime);
    warmKsCache(curSong);

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

    var countIn = appState.clickMode !== 'off';
    playSession = {
      startTime: actx.currentTime + 0.15,
      measureStartTime: actx.currentTime + 0.15 + (countIn ? bpb * spb : 0),
      nextBeatTime: actx.currentTime + 0.15,
      spb: spb,
      bpb: bpb,
      inCountIn: countIn,
      countInBeat: 0,
      mIdx: curMeasureIdx,
      bIdx: curBeatIdx,
      loopCompleted: 0,
      resumeNextHold: true
    };

    isPlaying = true;
    syncCompactPlayButtons();
    $('#loopCountBadge').textContent = '0회 완주';
  }

  function syncCompactPlayButtons(){
    var active = isPlaying;
    if ($('#playBtn')){
      $('#playBtn').textContent = isPlaying ? '연습 정지' : '연습 시작';
      $('#playBtn').classList.toggle('running', active);
    }
    if ($('#compactPlayBtn')){
      $('#compactPlayBtn').textContent = isPlaying ? '⏹ 정지' : '▶ 시작';
      $('#compactPlayBtn').title = isPlaying ? '연습 정지 (단축키: Space)' : '연습 시작 (단축키: Space)';
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

  function stopPractice(){
    if (typeof stopGuitarNotes === 'function') stopGuitarNotes();
    if (!isPlaying){
      syncCompactPlayButtons();
      playSession = null;
      return;
    }
    isPlaying = false;
    syncCompactPlayButtons();
    $('#phaseTxt').textContent = '정지됨 · 마디를 클릭해 이어서 연습하세요';
    setLeds(-1);
    saveAppState();
    playSession = null;
  }

  function resetToFirstMeasure(){
    var wasPlaying = isPlaying;
    if (wasPlaying) stopPractice();
    curMeasureIdx = 0;
    curBeatIdx = 0;
    if (appState.loopStart > 1){
      appState.loopStart = 1;
      appState.loopEnd = getMeasureCount(curSong);
      if ($('#loopStart')) $('#loopStart').value = appState.loopStart;
      if ($('#loopEnd')) $('#loopEnd').value = appState.loopEnd;
      updateLoopClasses();
    }
    saveAppState();
    updateActiveCursor(0, 0, !wasPlaying);
    if ($('#structuredScoreWrap')){
      $('#structuredScoreWrap').scrollTo({ top: 0, left: 0, behavior: 'smooth' });
    }
    if ($('#imgStageScroll')){
      $('#imgStageScroll').scrollTo({ top: 0, left: 0, behavior: 'smooth' });
    }
    if (wasPlaying){
      startPractice();
    }
  }

  function schedulerTick(){
    if (!isPlaying || !playSession || !actx) return;
    var s = playSession;
    var now = actx.currentTime;

    while (!s.endScheduled && s.nextBeatTime < now + 0.08){
      var t = s.nextBeatTime;
      if (s.inCountIn){
        if (appState.clickMode !== 'off'){
          scheduleMetronomeClick(t, s.countInBeat === 0, s.bpb === 9 && s.countInBeat % 3 !== 0);
        }
        s.countInBeat++;
        s.nextBeatTime += s.spb;
        if (s.countInBeat >= s.bpb){
          s.inCountIn = false;
          s.measureStartTime = s.nextBeatTime;
        }
      } else {
        var isFirstBeat = s.bIdx === 0;
        var isTripletSub = (s.bpb === 9 && s.bIdx % 3 !== 0);
        if (appState.clickMode === 'all'){
          scheduleMetronomeClick(t, isFirstBeat, isTripletSub);
        }
        var m = curSong.type === 'structured' ? curSong.measures[s.mIdx] : null;

        // 구조화 악보의 명시 리듬과 음표 길이를 공통 가이드 스케줄러로 처리
        if (appState.guideSound){
          var songCapo = getSongCapo(curSong);
          if (curSong.type === 'structured'){
            if (m && m.beats[s.bIdx]){
              var bObj = m.beats[s.bIdx];
              var loopEndMeasure = Math.min(getMeasureCount(curSong) - 1, appState.loopEnd - 1);
              var remainingSlots = Math.max(0, ((loopEndMeasure - s.mIdx + 1) * s.bpb) - s.bIdx);
              scheduleBeatGuide(bObj, {
                startTime:t,
                slotDuration:s.spb,
                measures:curSong.measures,
                resumeHold:s.resumeNextHold || (isFirstBeat && s.mIdx === Math.max(0, appState.loopStart - 1)),
                maxDurationSlots:remainingSlots,
                capo:songCapo
              });
              s.resumeNextHold = false;
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
              if (sIdx > 0){
                var subDelay = Math.max(0, delay + (sIdx * subStepMs));
                setTimeout(function(){
                  if (playSession !== s) return;
                  if (curMeasureIdx === mI && curBeatIdx === bI){
                    var subTarget = sn;
                    if (sn.kind === 'rest') subTarget = null;
                    else if (sn.kind === 'hold' && typeof GuitarRhythm !== 'undefined') subTarget = GuitarRhythm.resolveHold(curSong.measures, sn);
                    highlightFretboard(curM ? curM.chord : null, subTarget, false, curM ? curM.autoChord : false, bI);
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
                if (playSession === s) stopPractice();
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
    $('#tempoName').textContent = tempoName(appState.bpm);
    if ($('#bpmUnitLabel') && typeof GuitarRhythm !== 'undefined'){
      $('#bpmUnitLabel').textContent = GuitarRhythm.getGridInfo(appState.beats).bpmUnitLabel;
    }
    $('#beatsSelect').value = String(appState.beats);
    $('#volRange').value = Math.round(appState.vol * 100);
    $('#clickModeSelect').value = appState.clickMode;
    $('#loopEnable').checked = appState.loopEnable;
    $('#speedTrainerChk').checked = appState.speedTrainer;
    $('#guideSoundBtn').setAttribute('aria-pressed', String(appState.guideSound));
    $('#guideSoundBtn').setAttribute('data-active', String(appState.guideSound));
    $('#guideSoundBtn').textContent = appState.guideSound ? '기타 시뮬레이션' : '기타 시뮬레이션 끔';
    var isKs = appState.synthEngine !== 'classic';
    $('#engineBtn').setAttribute('data-active', String(isKs));
    $('#engineBtn').textContent = isKs ? '물리음원' : '기존음원';
    $('#engineBtn').title = isKs
      ? '물리 모델(Karplus-Strong) 나일론 현 음원 사용 중 (클릭하면 기존 합성음과 비교)'
      : '기존 합성음(삼각파+필터) 사용 중 (클릭하면 물리 모델 음원으로 전환)';
    if ($('#toggleFxBtn')){
      var isFx = !!appState.acousticFx;
      $('#toggleFxBtn').setAttribute('data-active', String(isFx));
      $('#toggleFxBtn').textContent = isFx ? '콘서트홀' : '드라이';
      $('#toggleFxBtn').title = isFx
        ? '콘서트홀 풍성 음향 켜짐 (클릭 또는 F로 또렷한 드라이 톤 전환)'
        : '또렷한 드라이 톤 켜짐 (클릭 또는 F로 풍성한 콘서트홀 전환)';
    }
    updateAudioOffsetBadge();
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

  $('#clickModeSelect').addEventListener('change', function(e){
    appState.clickMode = CLICK_MODES.indexOf(e.target.value) >= 0 ? e.target.value : 'all';
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
    if (!appState.guideSound && typeof stopGuitarNotes === 'function') stopGuitarNotes();
    else if (appState.guideSound && isPlaying && playSession) playSession.resumeNextHold = true;
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
    if (isPlaying) stopPractice();
    else startPractice();
  });

  if ($('#compactPlayBtn')){
    $('#compactPlayBtn').addEventListener('click', function(){
      if (isPlaying) stopPractice();
      else startPractice();
    });
  }

  if ($('#rewindToFirstBtn')){
    $('#rewindToFirstBtn').addEventListener('click', function(){
      resetToFirstMeasure();
    });
  }

  if ($('#toggleCompactBtn')){
    $('#toggleCompactBtn').addEventListener('click', function(){
      setCompactPractice(!appState.isCompactPractice);
    });
  }

  // 메인 화면 키보드 단축키 (Space: 연습 시작/정지, G: 소리 토글, F: 특수효과 토글, T: 타브/박자카드 토글, P: 집중연습뷰, Home: 처음으로, Esc: 전체화면)
  window.addEventListener('keydown', function(e){
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!$('#audioOffsetModal').hidden || !$('#sheetSyncModal').hidden || !$('#backupModal').hidden || !$('#toneModal').hidden || !$('#blankScoreModal').hidden || ($('#helpModal') && !$('#helpModal').hidden)) return;

    if (e.code === 'Space'){
      e.preventDefault();
      $('#playBtn').click();
    } else if (e.key === 'Home'){
      e.preventDefault();
      if ($('#rewindToFirstBtn')) $('#rewindToFirstBtn').click();
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
    } else if (e.key === '?' || e.key === '/'){
      e.preventDefault();
      if ($('#helpModalOpenBtn')) $('#helpModalOpenBtn').click();
    } else if (e.key === 'Escape'){
      if ($('#helpModal') && !$('#helpModal').hidden){
        e.preventDefault();
        $('#helpModal').hidden = true;
        return;
      }
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
    function blankBars(){ return new Array(4).fill(null).map(function(){ return { chord: '', note: '', memo: '', w: 1 }; }); }
    var defaultSystems = pdfPages ? [
      { x: 0.08, y: 0.14, w: 0.84, h: 0.18, bars: blankBars() },
      { x: 0.08, y: 0.42, w: 0.84, h: 0.18, bars: blankBars() }
    ] : [
      { x: 0.12, y: 0.15, w: 0.55, h: 0.72, bars: blankBars() }
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
    if (!await persistImageSong(song)) return;
    imageSongs.push(song);
    clearStorageError();
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
      bars: new Array(4).fill(null).map(function(){ return { chord: '', note: '', memo: '', w: 1 }; })
    });
    syncAfterImageGridChange();
  });

  $('#pdfPrevBtn').addEventListener('click', async function(){
    if (!curSong || !curSong.pdfPages || curSong.curPageIdx <= 0) return;
    var targetSong = curSong;
    var nextIdx = targetSong.curPageIdx - 1;
    var candidate = Object.assign({}, targetSong, { curPageIdx: nextIdx, imageDataUrl: targetSong.pdfPages[nextIdx] });
    if (!await persistImageSong(candidate)) return;
    Object.assign(targetSong, candidate);
    if (curSong !== targetSong) return;
    renderImageScore();
  });

  $('#pdfNextBtn').addEventListener('click', async function(){
    if (!curSong || !curSong.pdfPages || curSong.curPageIdx >= curSong.pdfPages.length - 1) return;
    var targetSong = curSong;
    var nextIdx = targetSong.curPageIdx + 1;
    var candidate = Object.assign({}, targetSong, { curPageIdx: nextIdx, imageDataUrl: targetSong.pdfPages[nextIdx] });
    if (!await persistImageSong(candidate)) return;
    Object.assign(targetSong, candidate);
    if (curSong !== targetSong) return;
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
    $('#beChord').value = bar.chord || '';
    $('#beNote').value = bar.note || '';
    $('#beMemo').value = bar.memo || '';
    $('#barEditModal').hidden = false;
  }

  $('#editBarMetaBtn').addEventListener('click', openBarEditModal);
  $('#closeBarEditBtn').addEventListener('click', function(){ $('#barEditModal').hidden = true; });
  $('#saveBarEditBtn').addEventListener('click', async function(){
    if (!curSong || !selectedImgBar) return;
    var targetSong = curSong;
    var targetBar = Object.assign({}, selectedImgBar);
    var candidate = JSON.parse(JSON.stringify(targetSong));
    var bar = candidate.systems[targetBar.sysIdx].bars[targetBar.barIdx];
    bar.chord = $('#beChord').value.trim();
    bar.note = $('#beNote').value.trim();
    bar.memo = $('#beMemo').value.trim();
    if (!await persistImageSong(candidate)) return;
    Object.assign(targetSong, candidate);
    var customIdx = imageSongs.findIndex(function(s){ return s.id === candidate.id; });
    if (customIdx >= 0 && imageSongs[customIdx] !== targetSong) Object.assign(imageSongs[customIdx], candidate);
    var allSong = allSongs.find(function(s){ return s.id === candidate.id; });
    if (allSong && allSong !== targetSong) Object.assign(allSong, candidate);
    clearStorageError();
    if (curSong !== targetSong || !selectedImgBar || selectedImgBar.sysIdx !== targetBar.sysIdx || selectedImgBar.barIdx !== targetBar.barIdx || selectedImgBar.globalIdx !== targetBar.globalIdx) return;
    $('#barEditModal').hidden = true;
    renderImageSystemsOverlay();
    updateActiveCursor(targetBar.globalIdx, 0, true);
  });

  // ---------- 이미지에서 마디 경계만 자동 감지
  $('#autoDetectBarsBtn').addEventListener('click', async function(){
    if (!curSong || curSong.type !== 'image' || !curSong.systems.length) return;
    var targetSong = curSong;
    var targetSysIdx = 0;
    var targetSys = targetSong.systems[targetSysIdx];
    var targetImage = targetSong.imageDataUrl;
    var targetSysSnapshot = JSON.stringify(targetSys);
    try {
      var boundaries = await scanImageBarlines(targetImage, targetSys);
      if (curSong !== targetSong || targetSong.imageDataUrl !== targetImage || targetSong.systems[targetSysIdx] !== targetSys || JSON.stringify(targetSys) !== targetSysSnapshot) return;
      if (boundaries.length >= 2 && boundaries[boundaries.length - 1] - boundaries[0] > 0.12){
        var newBarCount = boundaries.length - 1;
        var oldBars = targetSys.bars || [];
        var hasManualData = oldBars.some(function(bar){ return !!(bar && (bar.chord || bar.note || bar.memo)); });
        if (newBarCount !== oldBars.length && hasManualData){
          alert('기존 음표·코드가 있어 마디 영역을 자동 교체하지 않았어요. 수동으로 영역을 조정해 주세요.');
          return;
        }
        var newBars = [];
        for (var i = 0; i < newBarCount; i++){
          var prior = newBarCount === oldBars.length ? oldBars[i] : null;
          var segmentWidth = boundaries[i + 1] - boundaries[i];
          newBars.push(Object.assign({}, prior || {}, {
            chord: prior && prior.chord || '',
            note: prior && prior.note || '',
            memo: prior && prior.memo || '',
            w: +Math.max(0.2, segmentWidth * 10).toFixed(3)
          }));
        }
        targetSys.x = +boundaries[0].toFixed(4);
        targetSys.w = +(boundaries[boundaries.length - 1] - boundaries[0]).toFixed(4);
        targetSys.bars = newBars;
        syncAfterImageGridChange();
        alert('마디 영역만 추정했어요. 음표·코드는 인식하지 않았어요.');
        return;
      }
      alert('뚜렷한 검은 세로 마디선을 찾지 못했어요. 먼저 줄 박스를 악보 줄 위치에 대략 맞춘 뒤 다시 눌러 보세요.');
    } catch (error){
      alert('이미지 마디 영역을 분석하지 못했어요. 이미지와 줄 영역을 확인한 뒤 다시 시도해 주세요.');
    }
  });
  // ---------- 이미지/PDF 악보 삭제
  $('#deleteSongBtn').addEventListener('click', async function(){
    if (!curSong || curSong.type !== 'image') return;
    var targetId = curSong.id;
    var targetTitle = curSong.title;


    if (!confirm('"' + targetTitle + '" 악보를 이 기기(IndexedDB)에서 영구 삭제할까요?')) return;
    if (!await removePersistedImageSong(targetId)) return;
    clearStorageError();
    imageSongs = imageSongs.filter(function(s){ return s.id !== targetId; });
    rebuildSongSelect(sheetSongs.length ? sheetSongs[0].id : (BUILTIN_SONGS[0] ? BUILTIN_SONGS[0].id : (allSongs[0] ? allSongs[0].id : null)));
  });

  // ---------- 이미지/PDF 악보 이름 변경
  async function renameCurrentSong(){
    var targetSong = curSong;
    if (!targetSong || targetSong.type !== 'image') return;
    var oldTitle = targetSong.title || '';
    var newTitle = prompt('악보 이름을 변경해 주세요:', oldTitle);
    if (newTitle == null) return;
    newTitle = newTitle.trim();
    if (!newTitle){
      alert('곡 이름을 1글자 이상 입력해 주세요.');
      return;
    }
    if (newTitle === oldTitle) return;

    var renamedSong = Object.assign({}, targetSong, { title: newTitle });
    if (!await persistImageSong(renamedSong)) return;
    Object.assign(targetSong, renamedSong);
    var cs = imageSongs.find(function(s){ return s.id === targetSong.id; });
    if (cs && cs !== targetSong) Object.assign(cs, renamedSong);

    var allSong = allSongs.find(function(s){ return s.id === targetSong.id; });
    if (allSong && allSong !== targetSong) Object.assign(allSong, targetSong);
    clearStorageError();
    if (curSong !== targetSong) return;
    rebuildSongSelect(targetSong.id);
  }

  if ($('#renameSongBtn')) $('#renameSongBtn').addEventListener('click', renameCurrentSong);
  if ($('#renameScoreTitleBtn')) $('#renameScoreTitleBtn').addEventListener('click', renameCurrentSong);
  $('#scoreTitle').addEventListener('click', function(){
    if (curSong && curSong.type === 'image') renameCurrentSong();
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

  // ---------- 계이름 / 음이름 표기법 전환 (CDE <-> 도레미)
  function syncNotationModeUI(){
    var isSolfege = appState.notationMode === 'solfege';
    var btn = $('#toggleNotationBtn');
    if (btn){
      btn.textContent = isSolfege ? 'CDE 표기' : '도레미 표기';
      btn.setAttribute('aria-pressed', String(isSolfege));
      btn.classList.toggle('active', isSolfege);
      btn.title = isSolfege
        ? '음이름 표기법을 CDE로 전환합니다 (현재: 도레미)'
        : '계이름 표기법을 도레미로 전환합니다 (현재: CDE)';
    }
    if (typeof updateFretboardCellTitles === 'function') updateFretboardCellTitles();
  }

  function setNotationMode(mode){
    appState.notationMode = (mode === 'solfege') ? 'solfege' : 'cde';
    saveAppState();
    syncNotationModeUI();
    if (curSong && curSong.type === 'structured') renderStructuredMeasures();
    updateActiveCursor(curMeasureIdx, curBeatIdx, false);
  }

  if ($('#toggleNotationBtn')){
    $('#toggleNotationBtn').addEventListener('click', function(){
      setNotationMode(appState.notationMode === 'solfege' ? 'cde' : 'solfege');
    });
  }

  // ---------- 수동 오디오 출력 지연 설정
  function updateAudioOffsetBadge(){
    var v = appState.audioOffsetMs || 0;
    var text = (v > 0 ? '+' : '') + v + 'ms';
    if ($('#audioOffsetBadge')) $('#audioOffsetBadge').textContent = text;
  }
  function updateAudioOffsetUI(){
    var v = appState.audioOffsetMs || 0;
    if ($('#audioOffsetRange')) $('#audioOffsetRange').value = v;
    if ($('#audioOffsetVal')) $('#audioOffsetVal').textContent = (v > 0 ? '+' : '') + v + ' ms';
    if ($('#btPresetWired')) $('#btPresetWired').classList.toggle('primary', v === 0);
    if ($('#btPresetNormal')) $('#btPresetNormal').classList.toggle('primary', v === 180);
    if ($('#btPresetHeavy')) $('#btPresetHeavy').classList.toggle('primary', v === 240);
    updateAudioOffsetBadge();
  }
  $('#audioOffsetOpenBtn').addEventListener('click', function(){
    updateAudioOffsetUI();
    $('#audioOffsetModal').hidden = false;
  });
  $('#closeAudioOffsetBtn').addEventListener('click', function(){
    $('#audioOffsetModal').hidden = true;
  });
  if ($('#audioOffsetRange')){
    $('#audioOffsetRange').addEventListener('input', function(e){
      appState.audioOffsetMs = Number(e.target.value) || 0;
      saveAppState();
      updateAudioOffsetUI();
    });
  }
  if ($('#btPresetWired')) $('#btPresetWired').addEventListener('click', function(){
    appState.audioOffsetMs = 0; saveAppState(); updateAudioOffsetUI();
  });
  if ($('#btPresetNormal')) $('#btPresetNormal').addEventListener('click', function(){
    appState.audioOffsetMs = 180; saveAppState(); updateAudioOffsetUI();
  });
  if ($('#btPresetHeavy')) $('#btPresetHeavy').addEventListener('click', function(){
    appState.audioOffsetMs = 240; saveAppState(); updateAudioOffsetUI();
  });

  // ---------- 백업 및 복원
  $('#backupBtn').addEventListener('click', function(){ $('#backupModal').hidden = false; });
  $('#closeBackupBtn').addEventListener('click', function(){ $('#backupModal').hidden = true; });

  // ---------- 단축키 및 사용 안내 도움말 모달
  if ($('#helpModalOpenBtn')){
    $('#helpModalOpenBtn').addEventListener('click', function(){
      if ($('#helpModal')) $('#helpModal').hidden = false;
    });
  }
  if ($('#closeHelpBtn')){
    $('#closeHelpBtn').addEventListener('click', function(){
      if ($('#helpModal')) $('#helpModal').hidden = true;
    });
  }
  if ($('#helpModal')){
    $('#helpModal').addEventListener('click', function(e){
      if (e.target === this) this.hidden = true;
    });
  }

  $('#exportJsonBtn').addEventListener('click', async function(){
    var songs;
    try { songs = await dbGetImageSongs(); }
    catch (error){ reportStorageError(error); return; }
    var payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      appState: safeAppStateForPersistence(),
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
      var data;
      try {
        data = JSON.parse(fr.result);
        if (!data || typeof data !== 'object' || (data.customSongs != null && !Array.isArray(data.customSongs))) throw new Error('Invalid backup format');
      } catch (err){
        alert('백업 파일 형식이 올바르지 않아요.');
        return;
      }
      try {
        if (Array.isArray(data.customSongs)){
          for (var i = 0; i < data.customSongs.length; i++){
            if (data.customSongs[i] && data.customSongs[i].type === 'image') await dbSaveImageSong(data.customSongs[i]);
          }
        }
        if (data.appState) ls.set('gs.state', stripRemovedAudioSettings(data.appState));
        clearStorageError();
        location.reload();
      } catch (err){
        reportStorageError(err);
      }
    };
    fr.readAsText(f);
  });

  // ---------- 초기화 및 곡 목록 구성
  function currentDraftOnlySongs(){
    var sourceIds = new Set(BUILTIN_SONGS.concat(sheetSongs).concat(imageSongs).map(function(song){ return song.id; }));
    return allSongs.filter(function(song){ return song && song.type === 'structured' && !sourceIds.has(song.id); });
  }

  function appendBuiltinSongGroups(selectEl){
    var levels = [];
    BUILTIN_SONGS.forEach(function(source){
      if (source.level != null && levels.indexOf(source.level) < 0) levels.push(source.level);
    });
    levels.sort(function(a, b){ return a - b; });
    var groups = levels.map(function(level){
      return { label: 'Lv.' + level + (BUILTIN_LEVEL_NAMES[level] ? ' ' + BUILTIN_LEVEL_NAMES[level] : ''),
        sources: BUILTIN_SONGS.filter(function(source){ return source.level === level; }) };
    });
    var unleveled = BUILTIN_SONGS.filter(function(source){ return source.level == null; });
    if (unleveled.length) groups.push({ label: '내장 악보', sources: unleveled });
    groups.forEach(function(group){
      var optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      group.sources.forEach(function(source){
        var s = allSongs.find(function(song){ return song.id === source.id; }) || source;
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.title;
        optgroup.appendChild(opt);
      });
      selectEl.appendChild(optgroup);
    });
  }

  function syncCompactSongSelectOptions(){
    var cSel = $('#compactSongSelect');
    if (!cSel) return;
    cSel.textContent = '';

    appendBuiltinSongGroups(cSel);

    if (sheetSongs.length){
      var grpSheet = document.createElement('optgroup');
      grpSheet.label = '구글 시트 연동';
      sheetSongs.forEach(function(source){
        var s = allSongs.find(function(song){ return song.id === source.id; }) || source;
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = '☁️ ' + s.title;
        grpSheet.appendChild(opt);
      });
      cSel.appendChild(grpSheet);
    }

    if (imageSongs.length){
      var grp2 = document.createElement('optgroup');
      grp2.label = '내 이미지·PDF 악보';
      imageSongs.forEach(function(s){
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.title;
        grp2.appendChild(opt);
      });
      cSel.appendChild(grp2);
    }

    var drafts = currentDraftOnlySongs();
    if (drafts.length){
      var draftGroup = document.createElement('optgroup');
      draftGroup.label = '임시 악보';
      drafts.forEach(function(song){
        var opt = document.createElement('option');
        opt.value = song.id;
        opt.textContent = song.title;
        draftGroup.appendChild(opt);
      });
      cSel.appendChild(draftGroup);
    }

    if (curSong) cSel.value = curSong.id;
  }

  function rebuildSongSelect(selectId){
    if (scoreEditorHooks && scoreEditorHooks.deferRebuild()){
      if (curSong){
        if ($('#songSelect')) $('#songSelect').value = curSong.id;
        if ($('#compactSongSelect')) $('#compactSongSelect').value = curSong.id;
      }
      return false;
    }
    if (curSong) rememberCurrentSession();
    stopPractice();
    allSongs = scoreDrafts.list(BUILTIN_SONGS.concat(sheetSongs).concat(imageSongs));
    var sel = $('#songSelect');
    sel.textContent = '';

    appendBuiltinSongGroups(sel);

    if (sheetSongs.length){
      var grpSheet = document.createElement('optgroup');
      grpSheet.label = '내 구글 드라이브 스프레드시트 연동 악보';
      sheetSongs.forEach(function(source){
        var s = allSongs.find(function(song){ return song.id === source.id; }) || source;
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = '☁️ ' + s.title;
        grpSheet.appendChild(opt);
      });
      sel.appendChild(grpSheet);
    }

    if (imageSongs.length){
      var grp2 = document.createElement('optgroup');
      grp2.label = '이 기기에 저장된 이미지·PDF 악보';
      imageSongs.forEach(function(s){
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.title;
        grp2.appendChild(opt);
      });
      sel.appendChild(grp2);
    }

    var draftSongs = currentDraftOnlySongs();
    if (draftSongs.length){
      var draftGroup = document.createElement('optgroup');
      draftGroup.label = '임시 악보';
      draftSongs.forEach(function(song){
        var opt = document.createElement('option');
        opt.value = song.id;
        opt.textContent = song.title;
        draftGroup.appendChild(opt);
      });
      sel.appendChild(draftGroup);
    }

    syncCompactSongSelectOptions();

    var target = allSongs.find(function(s){ return s.id === selectId; }) || allSongs[0];
    sel.value = target.id;
    if ($('#compactSongSelect')) $('#compactSongSelect').value = target.id;
    curSong = target;
    appState.lastSongId = target.id;
    appState.bpm = Number(target.bpm) || 64;
    renderSong();
    restoreSongSession(target);
    saveAppState();
  }

  function changeSongById(songId){
    if (scoreEditorHooks && !scoreEditorHooks.beforeAction('곡 변경')){
      if ($('#songSelect') && curSong) $('#songSelect').value = curSong.id;
      if ($('#compactSongSelect') && curSong) $('#compactSongSelect').value = curSong.id;
      return false;
    }
    if (curSong) rememberCurrentSession();
    stopPractice();
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
      restoreSongSession(found);
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
  initScoreUi();
  initSheetSync();
  GuitarScorePrompt.initScorePromptButton();
  scoreEditorHooks.init();
  buildFretboard();
  setCompactPractice(false);
  syncNotationModeUI();
  Promise.all([
    loadExternalSongsJson(),
    dbGetImageSongs().catch(function(error){ reportStorageError(error); return []; })
  ]).then(async function(results){
    imageSongs = results[1] || [];
    var savedSheetUrl = ls.get('gs.sheetUrl', '');
    if (savedSheetUrl){
      await syncGoogleSheetSongs(savedSheetUrl, true);
    }
    rebuildSongSelect(appState.lastSongId);
  }).catch(function(){
    reportStorageError();
    imageSongs = [];
    rebuildSongSelect(appState.lastSongId);
  });
