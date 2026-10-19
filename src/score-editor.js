'use strict';

var scoreDrafts = createScoreDraftStore();
var scoreEditorHooks = (function(){
  var TAB_INPUT_OPEN_KEY = 'gs.tabInput.open';
  var TAB_INPUT_HANDOFF_KEY = 'gs.tabInput.handoff';
  var TAB_INPUT_HANDOFF_MAX_AGE_MS = 600000;
  var TAB_INPUT_HANDOFF_MAX_FUTURE_MS = 60000;

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
    if (edit) edit.hidden = !structured;
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
    showStorageStatus('악보 입력에서 넘긴 악보를 열지 못했어: ' + message);
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
      reportTabInputHandoffFailure('넘긴 내용의 모양이 틀렸어.');
      return null;
    }
    var validKey = Number.isInteger(handoff.key) && handoff.key >= -5 && handoff.key <= 5;
    try {
      var source = typeof handoff.sourceId === 'string' && Array.isArray(sources)
        ? sources.find(function(song){ return song && song.type === 'structured' && song.id === handoff.sourceId; })
        : null;
      if (source && Number(handoff.beats) !== source.beats){
        showStorageStatus('칸 수가 바뀌어서 원래 곡 대신 새 임시 악보로 열었어.');
        source = null;
      }
      if (source){
        return scoreDrafts.replaceScore(source, handoff.lines, {key:validKey ? handoff.key : null, origin:'tab-input'}).id;
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
