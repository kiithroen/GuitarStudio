'use strict';

var scoreDrafts = createScoreDraftStore();
var scoreEditorHooks = (function(){
  var pendingEdit = null;
  var queuedRebuild = false;
  var nextBlankTitle = 1;
  var lastUndoSession = Object.create(null);

  function statusNode(){ return document.getElementById('scoreDraftStatus'); }

  function showStatus(message){
    var node = statusNode();
    if (node) node.textContent = message || '';
  }

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

  function restoreSession(snapshot, mutation, index){
    if (!snapshot || !curSong) return;
    var count = Math.max(1, curSong.measures.length);
    var measure = snapshot.measure;
    var start = snapshot.loopStart;
    var end = snapshot.loopEnd;
    if (mutation === 'insert'){
      var previousCount = count - 1;
      if (measure > index) measure++;
      if (start > index + 1) start++;
      if (snapshot.loopStart === 1 && snapshot.loopEnd === previousCount) end = count;
      else if (end > index + 1) end++;
    } else if (mutation === 'remove'){
      if (measure > index) measure--;
      else if (measure === index) measure = Math.min(index, count - 1);
      if (start > index + 1) start--;
      else if (start === index + 1) start = Math.min(start, count);
      if (end > index + 1) end--;
      else if (end === index + 1) end = Math.min(end, count);
    }
    appState.bpm = Math.max(30, Math.min(240, Math.round(Number(snapshot.bpm) || Number(curSong.bpm) || 64)));
    appState.loopStart = Math.max(1, Math.min(count, Number(start) || 1));
    appState.loopEnd = Math.max(appState.loopStart, Math.min(count, Number(end) || count));
    curMeasureIdx = Math.max(0, Math.min(count - 1, Number(measure) || 0));
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

  function finishMutation(song, snapshot, mutation, index){
    updateWorkingSong(song);
    lastUndoSession[song.id] = snapshot;
    pendingEdit = null;
    renderSong();
    restoreSession(snapshot, mutation, index);
    refreshStatus();
    if (queuedRebuild){
      queuedRebuild = false;
      rebuildSongSelect(curSong.id);
    }
  }

  function currentErrorNode(){ return document.getElementById('scoreEditError'); }

  function setEditorError(error){
    var node = currentErrorNode();
    if (node) node.textContent = error && error.message ? error.message : String(error || '악보를 적용하지 못했어.');
    showStatus(error && error.message ? error.message : '악보를 적용하지 못했어.');
  }

  function refreshStatus(){
    var structured = !!(curSong && curSong.type === 'structured');
    var status = structured ? scoreDrafts.status(curSong.id) : {dirty:false,temporary:false,canUndo:false};
    var controls = document.getElementById('scoreDraftControls');
    var node = statusNode();
    var undo = document.getElementById('undoScoreEditBtn');
    var reset = document.getElementById('resetScoreDraftBtn');
    if (node){
      if (structured){
        var msg = pendingEdit && pendingEdit.songId === curSong.id
          ? (pendingEdit.kind === 'edit' ? (pendingEdit.index + 1) + '마디 편집 중 · 적용하거나 취소해줘.' : (pendingEdit.index + 2) + '마디 추가 초안 · 적용하거나 취소해줘.')
          : (status.temporary
            ? '임시 악보 · 새로고침하면 사라져. 보관하려면 악보 복사해.'
            : (status.dirty ? '임시 수정됨 · 새로고침하면 사라져. 보관하려면 악보 복사해.' : ''));
        node.textContent = msg;
        node.hidden = !msg;
      } else {
        node.textContent = '';
        node.hidden = true;
      }
    }
    if (undo){
      undo.hidden = !structured || !status.canUndo;
      undo.disabled = !!pendingEdit;
    }
    if (reset){
      reset.hidden = !structured || (!status.dirty && !status.temporary);
      reset.disabled = !!pendingEdit;
    }
    if (controls){
      var hasControlsContent = !!(node && !node.hidden && node.textContent) || (undo && !undo.hidden) || (reset && !reset.hidden);
      controls.hidden = !structured || !hasControlsContent;
    }
    var copy = document.getElementById('copyCurSongTsvBtn');
    if (copy) copy.hidden = !structured;
    var copyStatus = document.getElementById('scoreCopyStatus');
    if (copyStatus) copyStatus.hidden = !structured || !copyStatus.textContent;
    if (document.getElementById('scoreModeTabBtn')) document.getElementById('scoreModeTabBtn').disabled = !!pendingEdit;
    if (document.getElementById('scoreModeCardBtn')) document.getElementById('scoreModeCardBtn').disabled = !!pendingEdit;
  }

  function beforeAction(action){
    if (!pendingEdit) return true;
    showStatus('먼저 적용하거나 취소해줘. (' + (action || '다른 작업') + ')');
    return false;
  }

  function hasPending(){ return !!pendingEdit; }

  function deferRebuild(){
    if (!pendingEdit) return false;
    queuedRebuild = true;
    showStatus('먼저 적용하거나 취소해줘. 악보 목록은 그 뒤에 갱신할게.');
    return true;
  }

  function cancelPending(){
    if (!pendingEdit) return;
    pendingEdit = null;
    refreshStatus();
    if (queuedRebuild){
      queuedRebuild = false;
      rebuildSongSelect(curSong && curSong.id);
    } else {
      renderStructuredMeasures();
      refreshStatus();
    }
  }

  function beginPending(kind, index){
    if (!beforeAction('다른 마디 편집')) return;
    if (!curSong || curSong.type !== 'structured') return;
    stopPractice();
    if (kind === 'edit'){
      pendingEdit = {
        kind:kind,
        songId:curSong.id,
        index:index,
        text:serializeScoreMeasures([curSong.measures[index]], '\n')
      };
    } else {
      pendingEdit = {
        kind:'insert',
        songId:curSong.id,
        index:index,
        text:serializeScoreMeasures([{
          chord:'-',
          autoChord:false,
          notes:new Array(curSong.beats).fill('r'),
          lyric:''
        }], '\n')
      };
    }
    showStatus(kind === 'edit' ? (index + 1) + '마디 편집 중' : (index + 2) + '마디 추가 초안 · 적용 전에는 마디 수가 바뀌지 않아.');
    renderStructuredMeasures();
    var textarea = document.getElementById('scoreMeasureText');
    if (textarea){ textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); }
    refreshStatus();
  }

  function makeButton(label, action, className){
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className || 'btn sm';
    button.textContent = label;
    button.dataset.scoreAction = action;
    return button;
  }

  function appendMeasureMenu(head, index){
    var wrap = document.createElement('div');
    wrap.className = 'score-measure-actions';
    var trigger = makeButton('⋯', 'menu', 'btn sm score-measure-menu-button');
    trigger.setAttribute('aria-label', (index + 1) + '마디 작업 메뉴');
    trigger.setAttribute('aria-expanded', 'false');
    var menu = document.createElement('div');
    menu.className = 'score-measure-menu';
    menu.hidden = true;
    var editButton = makeButton('마디 원문 편집', 'edit');
    editButton.setAttribute('aria-label', (index + 1) + '마디 원문 편집');
    menu.appendChild(editButton);
    var insertButton = makeButton('뒤에 마디 추가', 'insert');
    insertButton.setAttribute('aria-label', (index + 1) + '마디 뒤에 새 마디 추가');
    menu.appendChild(insertButton);
    var remove = makeButton('마디 삭제', 'delete', 'btn sm danger');
    remove.setAttribute('aria-label', (index + 1) + '마디 삭제');
    remove.disabled = curSong.measures.length <= 1;
    menu.appendChild(remove);
    trigger.addEventListener('click', function(event){
      event.stopPropagation();
      if (!beforeAction('마디 메뉴')) return;
      var open = menu.hidden;
      closeMeasureMenus();
      menu.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
    });
    menu.addEventListener('click', function(event){
      event.stopPropagation();
      var action = event.target && event.target.dataset ? event.target.dataset.scoreAction : '';
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (action === 'edit') beginPending('edit', index);
      else if (action === 'insert') beginPending('insert', index);
      else if (action === 'delete') removeMeasure(index);
    });
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    head.appendChild(wrap);
  }

  function isEditingMeasure(index){
    return !!pendingEdit && pendingEdit.kind === 'edit' && pendingEdit.songId === curSong.id && pendingEdit.index === index;
  }

  function renderInlineEditor(card, index){
    var box = document.createElement('div');
    box.className = 'score-inline-editor';
    box.id = 'scoreMeasureEditor';
    box.dataset.measure = index;
    var label = document.createElement('label');
    label.className = 'label';
    label.htmlFor = 'scoreMeasureText';
    label.textContent = (index + 1) + '마디 원문';
    var textarea = document.createElement('textarea');
    textarea.id = 'scoreMeasureText';
    textarea.setAttribute('aria-label', (index + 1) + '마디 원문 편집');
    textarea.value = pendingEdit.text;
    textarea.addEventListener('input', function(){ pendingEdit.text = textarea.value; });
    textarea.addEventListener('click', function(event){ event.stopPropagation(); });
    box.appendChild(label);
    box.appendChild(textarea);
    var error = document.createElement('div');
    error.id = 'scoreEditError';
    error.className = 'hint score-edit-error';
    error.setAttribute('role', 'status');
    error.setAttribute('aria-live', 'polite');
    box.appendChild(error);
    var actions = document.createElement('div');
    actions.className = 'score-inline-actions';
    var apply = makeButton('적용', 'apply', 'btn primary sm');
    var cancel = makeButton('취소', 'cancel', 'btn sm');
    apply.addEventListener('click', function(){ applyPending(); });
    cancel.addEventListener('click', function(){ cancelPending(); });
    actions.appendChild(apply);
    actions.appendChild(cancel);
    box.appendChild(actions);
    box.addEventListener('click', function(event){ event.stopPropagation(); });
    card.appendChild(box);
  }

  function appendInsertDraftCard(grid, afterIndex){
    if (!pendingEdit || pendingEdit.kind !== 'insert' || pendingEdit.songId !== curSong.id || pendingEdit.index !== afterIndex) return;
    var card = document.createElement('div');
    card.className = 'measure-card score-insert-draft';
    card.dataset.draftAfter = afterIndex;
    var head = document.createElement('div');
    head.className = 'm-head';
    var title = document.createElement('span');
    title.className = 'm-num';
    title.textContent = '새 마디';
    head.appendChild(title);
    card.appendChild(head);
    renderInlineEditor(card, afterIndex + 1);
    grid.appendChild(card);
  }

  function applyPending(){
    if (!pendingEdit || pendingEdit.songId !== curSong.id) return;
    var edit = pendingEdit;
    var snapshot = snapshotSession();
    try {
      stopPractice();
      var song = scoreDrafts.apply(edit.songId, edit.index, edit.text.trim(), edit.kind === 'insert');
      finishMutation(song, snapshot, edit.kind === 'insert' ? 'insert' : null, edit.index);
    } catch (error){ setEditorError(error); }
  }

  function removeMeasure(index){
    if (!beforeAction('마디 삭제') || !curSong || curSong.type !== 'structured') return;
    var snapshot = snapshotSession();
    try {
      stopPractice();
      var song = scoreDrafts.remove(curSong.id, index);
      finishMutation(song, snapshot, 'remove', index);
    } catch (error){ showStatus(error.message || '마디를 삭제하지 못했어.'); }
  }

  function undo(){
    if (!beforeAction('되돌리기') || !curSong || curSong.type !== 'structured') return;
    var snapshot = lastUndoSession[curSong.id] || snapshotSession();
    stopPractice();
    var song = scoreDrafts.undo(curSong.id);
    if (!song) return;
    updateWorkingSong(song);
    delete lastUndoSession[curSong.id];
    renderSong();
    restoreSession(snapshot, null, null);
    refreshStatus();
  }

  function reset(){
    if (!beforeAction('원본으로 초기화') || !curSong || curSong.type !== 'structured') return;
    var snapshot = snapshotSession();
    stopPractice();
    var song = scoreDrafts.reset(curSong.id);
    if (!song) return;
    updateWorkingSong(song);
    lastUndoSession[curSong.id] = snapshot;
    renderSong();
    restoreSession(snapshot, null, null);
    refreshStatus();
  }

  function openBlankModal(){
    if (!beforeAction('빈 악보 추가')) return;
    var modal = document.getElementById('blankScoreModal');
    if (!modal) return;
    document.getElementById('blankScoreTitle').value = '빈 악보 ' + nextBlankTitle++;
    document.getElementById('blankScoreBeats').value = '4';
    document.getElementById('blankScoreBpm').value = '64';
    document.getElementById('blankScoreError').textContent = '';
    modal.hidden = false;
    document.getElementById('blankScoreTitle').focus();
  }

  function createBlank(){
    var title = document.getElementById('blankScoreTitle').value.trim();
    var beats = Number(document.getElementById('blankScoreBeats').value);
    var bpm = Number(document.getElementById('blankScoreBpm').value);
    var error = document.getElementById('blankScoreError');
    if (!title){ error.textContent = '곡 이름을 입력해줘.'; return; }
    if (!Number.isInteger(beats) || beats < 1 || beats > 12){ error.textContent = '칸수는 1에서 12 사이의 정수여야 해.'; return; }
    if (!Number.isInteger(bpm) || bpm < 30 || bpm > 240){ error.textContent = 'BPM은 30에서 240 사이의 정수여야 해.'; return; }
    try {
      stopPractice();
      var song = scoreDrafts.createBlank({title:title,beats:beats,bpm:bpm});
      document.getElementById('blankScoreModal').hidden = true;
      rebuildSongSelect(song.id);
    } catch (draftError){ error.textContent = draftError.message || '빈 악보를 만들지 못했어.'; }
  }

  function closeMeasureMenus(){
    document.querySelectorAll('.score-measure-menu').forEach(function(other){ other.hidden = true; });
    document.querySelectorAll('.score-measure-menu-button').forEach(function(other){ other.setAttribute('aria-expanded', 'false'); });
  }

  function init(){
    document.addEventListener('click', function(event){
      var target = event.target;
      if (target && target.closest && target.closest('.score-measure-actions')) return;
      closeMeasureMenus();
    }, true);
    document.getElementById('addBlankScoreBtn').addEventListener('click', openBlankModal);
    document.getElementById('cancelBlankScoreBtn').addEventListener('click', function(){ document.getElementById('blankScoreModal').hidden = true; });
    document.getElementById('createBlankScoreBtn').addEventListener('click', createBlank);
    document.getElementById('blankScoreModal').addEventListener('click', function(event){
      if (event.target === event.currentTarget) event.currentTarget.hidden = true;
    });
    document.getElementById('undoScoreEditBtn').addEventListener('click', undo);
    document.getElementById('resetScoreDraftBtn').addEventListener('click', reset);
    window.addEventListener('beforeunload', function(event){
      var hasDraft = !!pendingEdit || allSongs.some(function(song){
        if (!song || song.type !== 'structured') return false;
        var state = scoreDrafts.status(song.id);
        return state.dirty || state.temporary;
      });
      if (!hasDraft) return;
      event.preventDefault();
      event.returnValue = '';
    });
    refreshStatus();
  }

  return {
    init:init,
    beforeAction:beforeAction,
    deferRebuild:deferRebuild,
    isPending:hasPending,
    appendMeasureMenu:appendMeasureMenu,
    isEditingMeasure:isEditingMeasure,
    renderInlineEditor:renderInlineEditor,
    appendInsertDraftCard:appendInsertDraftCard,
    refreshStatus:refreshStatus
  };
})();
