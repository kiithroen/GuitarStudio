'use strict';

var scoreDrafts = createScoreDraftStore();
var scoreEditorHooks = (function(){
  var TAB_INPUT_OPEN_KEY = 'gs.tabInput.open';
  var TAB_INPUT_HANDOFF_KEY = 'gs.tabInput.handoff';
  var ALPHATAB_VIEW_KEY = 'gs.alphaTab.view';
  var TAB_INPUT_HANDOFF_MAX_AGE_MS = 600000;
  var TAB_INPUT_HANDOFF_MAX_FUTURE_MS = 60000;
  var EDIT_BUTTON_TITLE = '악보 입력 화면에서 이 곡을 고칩니다';
  var EDIT_BUTTON_TITLE_ALPHATEX = '악보 입력 화면에서 고치면 우리 악보 사본으로 저장됩니다';

  function statusNode(){ return document.getElementById('scoreDraftStatus'); }

  function snapshotSession(){
    return {
      songId:curSong && curSong.id,
      bpm:appState.bpm,
      loopStart:appState.loopStart,
      loopEnd:appState.loopEnd,
      measure:curMeasureIdx,
      beat:curBeatIdx
    };
  }

  function restoreSession(snapshot){
    if (!snapshot || !curSong) return;
    var count = Math.max(1, curSong.measures.length);
    appState.bpm = Math.max(30, Math.min(240, Math.round(Number(snapshot.bpm) || Number(curSong.bpm) || 64)));
    appState.loopStart = Math.max(1, Math.min(count, Number(snapshot.loopStart) || 1));
    appState.loopEnd = Math.max(appState.loopStart, Math.min(count, Number(snapshot.loopEnd) || count));
    curMeasureIdx = Math.max(0, Math.min(count - 1, Number(snapshot.measure) || 0));
    curBeatIdx = Math.max(0, Math.min((curSong.beats || 1) - 1, Number(snapshot.beat) || 0));
    $('#loopStart').max = count;
    $('#loopEnd').max = count;
    $('#loopStart').value = appState.loopStart;
    $('#loopEnd').value = appState.loopEnd;
    syncConsoleUI();
    updateLoopClasses();
    updateActiveCursor(curMeasureIdx, curBeatIdx, false);
    saveAppState();
  }

  function updateWorkingSong(song){
    curSong = song;
    var index = allSongs.findIndex(function(item){ return item.id === song.id; });
    if (index >= 0) allSongs[index] = song;
  }

  function draftMessage(status){
    if (status.temporary && status.origin === 'tab-input' && !status.dirty) return '악보 입력에서 연 임시 악보입니다. 수정하려면 악보 입력 화면으로 이동하세요.';
    if (status.temporary) return '임시 악보 · 새로고침 시 초기화됩니다. 보관 시 악보를 복사하세요.';
    if (status.dirty && status.origin === 'tab-input') return '악보 입력에서 고친 수정 초안입니다. 원래 상태로 복원하려면 원본 복원을 누르세요.';
    if (status.dirty) return '임시 수정됨 · 새로고침 시 초기화됩니다. 보관 시 악보를 복사하세요.';
    return '';
  }

  // 원본이 alphaTex 인 곡(시트 6열)은 앱에서 제자리에서 고치지 않는다. 고치면 우리 악보만 담은 사본으로 저장한다(Docs/alphatab.md).
  function hasAlphaTex(song){
    return !!(song && typeof song.alphaTex === 'string' && song.alphaTex.trim());
  }

  // 사본 제목: "<제목> (사본)", 이미 있으면 "(사본 2)", "(사본 3)"…
  function copyTitleFor(title, sources){
    var taken = {};
    (Array.isArray(sources) ? sources : []).concat(typeof allSongs !== 'undefined' && Array.isArray(allSongs) ? allSongs : []).forEach(function(song){
      if (song && typeof song.title === 'string') taken[song.title] = true;
    });
    var candidate = title + ' (사본)';
    for (var number = 2; taken[candidate]; number++) candidate = title + ' (사본 ' + number + ')';
    return candidate;
  }

  function refreshStatus(){
    var structured = !!(curSong && curSong.type === 'structured');
    var status = structured ? scoreDrafts.status(curSong.id) : {dirty:false,temporary:false,origin:null};
    var controls = document.getElementById('scoreDraftControls');
    var node = statusNode();
    var reset = document.getElementById('resetScoreDraftBtn');
    if (node){
      var msg = structured ? draftMessage(status) : '';
      node.textContent = msg;
      node.hidden = !msg;
    }
    if (reset) reset.hidden = !structured || (!status.dirty && !status.temporary);
    if (controls){
      var hasControlsContent = !!(node && !node.hidden && node.textContent) || (reset && !reset.hidden);
      controls.hidden = !structured || !hasControlsContent;
    }
    var edit = document.getElementById('editInInputBtn');
    if (edit){
      edit.hidden = !structured;
      edit.title = structured && hasAlphaTex(curSong) ? EDIT_BUTTON_TITLE_ALPHATEX : EDIT_BUTTON_TITLE;
    }
    var alphaTab = document.getElementById('openAlphaTabBtn');
    if (alphaTab) alphaTab.hidden = !structured;
    var copy = document.getElementById('copyCurSongTsvBtn');
    if (copy) copy.hidden = !structured;
    var copyStatus = document.getElementById('scoreCopyStatus');
    if (copyStatus) copyStatus.hidden = !structured || !copyStatus.textContent;
  }

  function reset(){
    if (!curSong || curSong.type !== 'structured') return;
    var snapshot = snapshotSession();
    stopPractice();
    var song = scoreDrafts.reset(curSong.id);
    if (!song) return;
    updateWorkingSong(song);
    renderSong();
    restoreSession(snapshot);
    refreshStatus();
  }

  function showStorageStatus(message){
    var node = document.getElementById('storageStatus');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
  }

  // 지금 곡(초안이면 초안 내용)을 악보 입력 화면으로 넘긴다. measure 는 0부터 센 시작 마디.
  function openInInput(measure){
    if (!curSong || curSong.type !== 'structured') return;
    stopPractice();
    var key = Number.isInteger(curSong.key) && curSong.key >= -5 && curSong.key <= 5 ? curSong.key : null;
    var ok = ls.set(TAB_INPUT_OPEN_KEY, {
      sourceId:curSong.id,
      title:curSong.title,
      beats:curSong.beats,
      bpm:Math.max(30, Math.min(240, Math.round(Number(curSong.bpm) || 64))),
      badge:curSong.badge || '',
      lines:serializeScoreMeasures(curSong.measures, '\n').split('\n'),
      key:key,
      measure:measure,
      savedAt:Date.now()
    });
    if (ok) location.href = 'score-input.html';
    else showStorageStatus('악보 입력 화면으로 전달하지 못했습니다. 악보 복사 기능을 이용하세요.');
  }

  // 지금 곡(초안이면 초안 내용)을 alphaTab 보기 창(새 탭)으로 넘긴다. 연습은 멈추지 않는다.
  // 곡에 원본 alphaTex가 있고 고친 초안이 아니면(scoreDrafts.status의 dirty·temporary가 아니면) 그 alphaTex를 그대로 넘긴다. 설명은 곡 badge(시트 설명 열)다.
  function openInAlphaTab(){
    if (!curSong || curSong.type !== 'structured') return;
    var draft = scoreDrafts.status(curSong.id);
    var payload = {
      title:curSong.title,
      beats:curSong.beats,
      bpm:Math.max(30, Math.min(240, Math.round(Number(curSong.bpm) || 64))),
      practiceBpm:appState.bpm, // 연습 화면이 지금 쓰는 BPM. 보기 창의 BPM 슬라이더가 이 값으로 시작한다
      capo:GuitarParser.getSongCapo(curSong),
      description:curSong.badge || '',
      lines:serializeScoreMeasures(curSong.measures, '\n').split('\n'),
      savedAt:Date.now()
    };
    if (hasAlphaTex(curSong) && !draft.dirty && !draft.temporary) payload.alphaTex = curSong.alphaTex;
    var ok = ls.set(ALPHATAB_VIEW_KEY, payload);
    if (ok) window.open('alphatab.html', '_blank');
    else showStorageStatus('alphaTab 보기로 전달하지 못했습니다. 브라우저 저장소를 확인하세요.');
  }

  function appendMeasureEditButton(head, index){
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn sm score-measure-edit';
    button.textContent = '편집';
    button.title = '이 마디부터 악보 입력에서 편집';
    button.setAttribute('aria-label', (index + 1) + '마디부터 편집');
    button.addEventListener('click', function(event){
      event.stopPropagation();
      openInInput(index);
    });
    head.appendChild(button);
  }

  function init(){
    document.getElementById('editInInputBtn').addEventListener('click', function(){ openInInput(0); });
    document.getElementById('openAlphaTabBtn').addEventListener('click', openInAlphaTab);
    document.getElementById('resetScoreDraftBtn').addEventListener('click', reset);
    window.addEventListener('beforeunload', function(event){
      var hasDraft = allSongs.some(function(song){
        if (!song || song.type !== 'structured') return false;
        var state = scoreDrafts.status(song.id);
        if (state.origin === 'tab-input') return false;
        return state.dirty || state.temporary;
      });
      if (!hasDraft) return;
      event.preventDefault();
      event.returnValue = '';
    });
    refreshStatus();
  }

  function reportTabInputHandoffFailure(message){
    showStorageStatus('악보 입력에서 넘긴 악보를 열지 못했습니다: ' + message);
  }

  // sources: 원본 곡 목록(내장곡·시트 곡). 넘긴 값의 sourceId 곡이 있으면 그 곡의 수정 초안으로, 없으면 새 임시 악보로 연다.
  function consumeTabInputHandoff(sources){
    var handoff = ls.get(TAB_INPUT_HANDOFF_KEY, null);
    if (!handoff) return null;
    ls.remove(TAB_INPUT_HANDOFF_KEY);
    var age = typeof handoff === 'object' && typeof handoff.savedAt === 'number' ? Date.now() - handoff.savedAt : NaN;
    if (!isFinite(age) || age > TAB_INPUT_HANDOFF_MAX_AGE_MS || age < -TAB_INPUT_HANDOFF_MAX_FUTURE_MS) return null;
    var validLines = Array.isArray(handoff.lines) && handoff.lines.every(function(line){ return typeof line === 'string'; });
    if (typeof handoff.title !== 'string' || !handoff.title || !validLines){
      reportTabInputHandoffFailure('넘긴 내용의 모양이 틀렸습니다.');
      return null;
    }
    var validKey = Number.isInteger(handoff.key) && handoff.key >= -5 && handoff.key <= 5;
    try {
      var source = typeof handoff.sourceId === 'string' && Array.isArray(sources)
        ? sources.find(function(song){ return song && song.type === 'structured' && song.id === handoff.sourceId; })
        : null;
      // 원본이 alphaTex인 곡은 칸 수가 바뀌어 돌아와도 같은 사본 규칙이다(칸 수는 고친 악보의 것).
      if (source && hasAlphaTex(source)){
        // 입력 화면에서 바꾼 카포(설명 글에 들어간다)·BPM·설명을 쓰고, 유효하지 않을 때만 원본 값으로 돌아간다.
        // 고친 것이 없으면(입력 화면이 unchanged 를 달면) 사본을 만들지 않고 원본 곡으로 돌아간다.
        if (handoff.unchanged === true) return source.id;
        var handoffBpm = Math.round(Number(handoff.bpm));
        var copy = scoreDrafts.createFromScore({
          title:copyTitleFor(source.title, sources),
          beats:Number(handoff.beats),
          bpm:Math.max(30, Math.min(240, isFinite(handoffBpm) && handoffBpm > 0 ? handoffBpm : (Math.round(Number(source.bpm)) || 64))),
          badge:typeof handoff.badge === 'string' ? handoff.badge : source.badge,
          lines:handoff.lines,
          key:validKey ? handoff.key : 0,
          origin:'tab-input'
        });
        showStorageStatus('원본이 alphaTex인 곡이라 고친 내용을 사본 「' + copy.title + '」으로 저장했습니다.');
        return copy.id;
      }
      if (source && Number(handoff.beats) !== source.beats){
        showStorageStatus('칸 수가 바뀌어서 원래 곡 대신 새 임시 악보로 열었습니다.');
        source = null;
      }
      if (source){
        return scoreDrafts.replaceScore(source, handoff.lines, {key:validKey ? handoff.key : null, capo:GuitarParser.getSongCapo({title:handoff.title, badge:handoff.badge}), origin:'tab-input'}).id;
      }
      var song = scoreDrafts.createFromScore({
        title:handoff.title,
        beats:Number(handoff.beats),
        bpm:Math.max(30, Math.min(240, Math.round(Number(handoff.bpm) || 64))),
        badge:handoff.badge,
        lines:handoff.lines,
        key:validKey ? handoff.key : 0,
        origin:'tab-input'
      });
      return song.id;
    } catch (error){
      reportTabInputHandoffFailure(error && error.message ? error.message : String(error));
      return null;
    }
  }

  return {
    init:init,
    appendMeasureEditButton:appendMeasureEditButton,
    refreshStatus:refreshStatus,
    consumeTabInputHandoff:consumeTabInputHandoff
  };
})();
