(function(){
  'use strict';
  // 악보 입력 화면(score-input.html)의 그리기·입력·저장. 모델은 src/tab-input.js, 설계와 결정은 Docs/tab-input.md.
  var T = window.GuitarTabInput;
  var N = window.GuitarNotation;
  var Staff = window.GuitarStaffLayout;
  var StaffSvg = window.GuitarStaffSvg;
  var S = window.GuitarStaffInput;
  var P = window.GuitarParser;

  var DOC_KEY = 'gs.tabInput.doc';
  var UI_KEY = 'gs.tabInput.ui';
  var HANDOFF_KEY = 'gs.tabInput.handoff';
  var OPEN_KEY = 'gs.tabInput.open';
  var TEXT_KEY = 'gs.tabInput.text';
  var OPEN_MAX_AGE_MS = 600000;
  var OPEN_MAX_FUTURE_MS = 60000;
  var STRING_LETTERS = ['E', 'B', 'G', 'D', 'A', 'E'];
  var BEATS_LABELS = { 2: '2/4', 3: '3/4', 4: '4/4', 6: '6/8', 8: '4/4 (8박 핑거스타일)', 9: '9/8 (8분음표 9칸)' };
  var CELL_SLOT_MIN = 26;   // score-input.html의 .ti-cell 기본 조각 폭과 같다
  var CELL_SLOT_PAD = 6;
  var CELL_ROLL_ROOM = 9;   // 롤 조각이 든 칸은 조각 폭 양쪽에 이만큼씩 더한다(글자가 가운데라서)
  var POS_H = 24;           // .ti-pos 높이(px). score-input.html의 CSS height와 맞춰야 한다(롤 물결선 세로 위치)
  var ROLL_PLAY_SEC = 1.6;  // 들어보기 한 조각의 길이(초)
  var TEN_WINDOW_MS = 700;
  var SAVE_DEBOUNCE_MS = 300;
  var TEXT_DEBOUNCE_MS = 300;
  var TEXT_OK = '미리보기에 반영됨';
  var TEXT_LOCK_TITLE = '텍스트 모드에서는 아래 편집기에서 고치세요';
  var CONFIRM_REPLACE = '지금 작업을 지우고 바꾸시겠습니까? 되돌리기로 돌아올 수 있습니다.';
  var COPY_FAIL = '복사하지 못했습니다. 결과 칸에서 직접 복사하세요.';
  var SOURCE_INFO = '연습 화면 곡을 고치는 중 · 완료 후 연습 화면에서 열면 해당 곡의 수정 초안으로 반영됩니다.';

  var doc;
  var history = T.createHistory(T.MAX_HISTORY);
  var cursor = { m: 0, c: 0, s: 0, str: 1 };
  var sel = null;          // {a, b} 마디 선택(a <= b)
  var selAnchor = null;    // Shift 범위의 기준 마디
  var clip = null;         // 복사한 마디들
  var DUR_VALUES = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];
  var DUR_KEYS = { '7': 'whole', '6': 'half', '5': 'quarter', '4': 'eighth', '3': '16th', '2': '32nd' };
  var NOTE_LETTERS = 'CDEFGAB';
  var ui = { autoAdvance: false, sound: true, dockCollapsed: false, attrsOpen: false, staffOn: true,
    inputMode: 'tab', staffDur: { value: 'quarter', dotted: false, triplet: false } };
  var textSnapshot = null; // 글자 칸 입력 전의 문서
  var saveTimer = null;
  var pending = null;      // 방금 누른 숫자 1: {t, m, c, s, str, timer}
  var staffLayout = null;  // 지금 오선 배치(layoutScore 결과). 오류거나 오선을 끄면 null
  var noteSel = null;      // 오선 입력에서 고른 음 {pos:{m,c,s}, str}. 반음 옮기기·줄 후보가 이 음에 쓰인다
  var lastEntry = null;    // 방금 넣은 사건 {pos}. 커서를 옮기면 지운다(화음 대상·기준 음)
  var pickerKey;           // 음 고르는 오선을 그린 조표(바뀌면 다시 그린다)
  var fretButtons = [];
  var attrButtons = [];
  var textDraft = null;    // 텍스트 모드 초안 {raw, baseText, valid}. 편집기에 친 글자 그대로(Docs/tab-input.md 텍스트로 입력)
  var textTimer = null;    // 친 글을 문서에 반영하기 전의 디바운스
  var textSession = false; // 이번 텍스트 세션에서 되돌리기 기록을 이미 남겼나
  var restoreRaw = null;   // 되살릴 수 있는, 문서에 반영 못 했던 글
  var openedSignature = null; // 연습 화면에서 곡을 불러온 직후 내보낸 결과(T.handoffSignature). 넘길 때 같으면 handoff 에 unchanged 를 단다

  function $(id){ return document.getElementById(id); }
  function el(tag, className, text){
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------- 안내 줄

  function setStatus(text){ $('tiStatus').textContent = text || ''; }
  function setResultStatus(text){ $('tiResultStatus').textContent = text || ''; }
  function lostText(count){ return '조각 ' + count + '개가 지워졌습니다. 되돌리기로 돌아올 수 있습니다.'; }

  // ---------- 저장

  function pad2(n){ return (n < 10 ? '0' : '') + n; }

  function saveNow(){
    clearTimeout(saveTimer);
    saveTimer = null;
    var ok = ls.set(DOC_KEY, doc);
    var status = $('tiSaveStatus');
    if (ok){
      var now = new Date();
      status.textContent = '자동 저장됨 ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes());
      status.classList.remove('is-warn');
    } else {
      status.textContent = '이 기기에 저장하지 못했습니다. 시트용 TSV로 복사해 두세요.';
      status.classList.add('is-warn');
    }
    return ok;
  }

  function scheduleSave(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  function flushSave(){ if (saveTimer) saveNow(); }

  function saveUi(){ ls.set(UI_KEY, ui); }

  // ---------- 소리

  function articulationName(art){ return art === '!' ? 'apoyando' : (art === 'h' ? 'harmonic' : (art === 's' ? 'slur' : (art === 'g' ? 'slide' : null))); }

  // rolled 이면 연습 화면과 같은 rollDelays(src/guide.js) 순서와 간격으로 굴려 친다.
  // pos({m, c, s}, 그 음들이 든 조각)를 주면 슬라이드('g') 음이 연습 화면처럼 출발 음 높이에서 미끄러진다. 판정(T.slurLinks)이 실패한 음은 미끄럼 없이 친다.
  function playNotes(items, rolled, pos){
    if (!ui.sound || !items.length) return;
    try {
      var capo = T.docCapo(doc);
      var links = pos && items.some(function(item){ return item.note.art === 'g'; }) ? T.slurLinks(doc) : null;
      var glideOptions = function(item){
        if (!links || item.note.art !== 'g') return undefined;
        var link = links[pos.m] && links[pos.m][pos.c] && links[pos.m][pos.c][pos.s] ? links[pos.m][pos.c][pos.s][item.str - 1] : null;
        if (!link || !link.ok) return undefined;
        return { glide: { fromMidi: soundingMidi(link.fromMidi, capo), sec: Math.min(SLIDE_GLIDE_SEC, ROLL_PLAY_SEC * SLIDE_MAX_SHARE) } };
      };
      if (rolled && items.length >= 2){
        var now = ensureAudioCtx().currentTime;
        var timed = rollDelays(items.map(function(item){
          return { str: item.str, midi: T.noteMidiOf(item.str, item.note), item: item };
        }), ROLL_PLAY_SEC);
        timed.forEach(function(entry){
          var item = entry.note.item;
          playGuitarNote(soundingMidi(entry.note.midi, capo), ROLL_PLAY_SEC - entry.delay, now + entry.delay, articulationGain(articulationName(item.note.art)), articulationName(item.note.art), item.str, glideOptions(item));
        });
        return;
      }
      items.forEach(function(item){
        playGuitarNote(soundingMidi(T.noteMidiOf(item.str, item.note), capo), ROLL_PLAY_SEC, null, articulationGain(articulationName(item.note.art)), articulationName(item.note.art), item.str, glideOptions(item));
      });
    } catch (error) {
      // 오디오가 없거나 실패해도 입력은 계속한다
    }
  }

  function slotNotes(pos){
    var slot = T.getSlot(doc, pos);
    var items = [];
    if (!slot) return items;
    slot.notes.forEach(function(note, index){ if (note) items.push({ str: index + 1, note: note }); });
    return items;
  }

  // 오디오 모듈이 부르는 카포(연습 화면은 app.js가 정의한다)
  window.curCapo = function(){ return T.docCapo(doc); };

  // ---------- 문서 바꾸기

  // 되돌리기 기록은 문서와 그 시점의 커서를 함께 담는다(되돌리면 그 자리로 돌아간다).
  function historyEntry(d, c){ return { doc: d, cursor: { m: c.m, c: c.c, s: c.s, str: c.str } }; }

  function restoreEntry(entry){
    doc = entry.doc;
    var c = entry.cursor || cursor;
    cursor = { m: c.m, c: c.c, s: c.s, str: c.str >= 1 && c.str <= T.STRING_COUNT ? c.str : 1 };
  }

  function commitText(){
    flushTextReflect();
    if (!textSnapshot) return;
    var snapshot = textSnapshot;
    textSnapshot = null;
    if (JSON.stringify(snapshot) !== JSON.stringify(doc)){
      history.record(historyEntry(snapshot, cursor));
      refreshUndoRedo();
    }
  }

  function clampCursor(){
    var p = T.clampPos(doc, cursor);
    cursor.m = p.m;
    cursor.c = p.c;
    cursor.s = p.s;
  }

  function clampSelection(){
    if (!sel) return;
    var last = doc.measures.length - 1;
    if (sel.a > last){ sel = null; selAnchor = null; return; }
    sel.b = Math.min(sel.b, last);
    if (selAnchor != null) selAnchor = Math.min(selAnchor, last);
  }

  // fn은 문서를 고치고 결과를 돌려준다. ok:false면 기록하지 않는다. 던지면 전 문서로 되돌린다.
  function apply(fn, opts){
    var o = opts || {};
    commitText();
    setStatus('');
    var before = T.cloneDoc(doc);
    var beforeCursor = { m: cursor.m, c: cursor.c, s: cursor.s, str: cursor.str };
    var result;
    try {
      result = fn(doc);
    } catch (error) {
      doc = before;
      setStatus(error && error.message ? error.message : String(error));
      renderAll();
      return null;
    }
    if (result && result.ok === false) return result;
    history.record(historyEntry(before, beforeCursor));
    if (o.onDone) o.onDone(result);
    var all = o.all || doc.measures.length !== before.measures.length;
    clampCursor();
    clampSelection();
    saveNow();
    if (all) renderMeasures();
    else (o.measures || []).forEach(rebuildCard);
    refreshAfterEdit();
    syncTextToDoc();
    return result || { ok: true };
  }

  function replaceDoc(next){
    commitText();
    history.record(historyEntry(doc, cursor));
    doc = next;
    cursor = { m: 0, c: 0, s: 0, str: 1 };
    sel = null;
    selAnchor = null;
    lastEntry = null;
    noteSel = null;
    saveNow();
    renderAll();
    syncTextToDoc();
  }

  function undo(){
    commitText();
    var prev = history.undo(historyEntry(doc, cursor));
    if (!prev) return;
    setStatus('');
    restoreEntry(prev);
    afterHistory();
  }

  function redo(){
    commitText();
    var next = history.redo(historyEntry(doc, cursor));
    if (!next) return;
    setStatus('');
    restoreEntry(next);
    afterHistory();
  }

  function afterHistory(){
    clampCursor();
    clampSelection();
    lastEntry = null;
    noteSel = noteAtCursor();
    saveNow();
    renderAll();
    syncTextToDoc();
  }

  // ---------- 그리기: 마디 카드

  function noteTitle(str, note){
    var parts = [str + '번 줄 ' + note.fret + '프렛 · ' + T.noteLabelOf(doc, str, note)];
    if (note.lh != null) parts.push('왼손 ' + note.lh);
    if (note.rh) parts.push('오른손 ' + note.rh);
    if (note.art === '!') parts.push('아포얀도');
    if (note.art === 'h') parts.push('자연 하모닉스');
    if (note.art === 's') parts.push('슬러');
    if (note.art === 'g') parts.push('슬라이드');
    if (note.uncertain) parts.push('확인 필요');
    return parts.join(' · ');
  }

  function buildPos(str, note){
    var pos = el('div', 'ti-pos');
    pos.dataset.str = String(str);
    if (!note) return pos;
    pos.classList.add('has-note');
    if (note.uncertain) pos.classList.add('is-uncertain');
    pos.title = noteTitle(str, note);
    // 프렛 글자 모양은 연습 화면과 같은 buildFretLabel 이 만든다. 주법은 기호 대신 글자 색(아포얀도 주황 굵게).
    pos.appendChild(buildPosLabel(note, undefined));
    return pos;
  }

  // link: 슬러·슬라이드 음의 판정 결과(T.slurLinks 의 항목). 없거나 실패면 방향 없이 그린다.
  function buildPosLabel(note, link){
    var ok = !!(link && link.ok);
    var label = buildFretLabel({ fret: note.fret, lh: note.lh, rh: note.rh, art: articulationName(note.art),
      slurType: note.art === 's' && ok ? link.type : undefined,
      slideType: note.art === 'g' && ok ? (link.type === 'hammer' ? 'up' : 'down') : undefined });
    label.classList.add('ti-pos-label');
    return label;
  }

  // 슬러·슬라이드 음 TAB 글자의 방향(슬러 h·p, 슬라이드 /·\). 앞 음이 다른 마디에 있어도 바뀌니 편집마다 문서 전체를 다시 판정한다(규칙은 GuitarNotation.linkSlurs).
  // 판정이 실패한 슬러 음은 방향 없이 ⌒로, 슬라이드 음은 —로 그린다. 오류는 결과 영역의 검사가 보여 준다.
  function refreshSlurLabels(){
    var links = T.slurLinks(doc);
    Array.prototype.forEach.call($('tiMeasures').querySelectorAll('.ti-slot'), function(slotEl){
      var m = Number(slotEl.dataset.m);
      var c = Number(slotEl.dataset.c);
      var s = Number(slotEl.dataset.s);
      var slot = T.getSlot(doc, { m: m, c: c, s: s });
      if (!slot) return;
      Array.prototype.forEach.call(slotEl.querySelectorAll('.ti-pos.has-note'), function(posEl){
        var str = Number(posEl.dataset.str);
        var note = slot.notes[str - 1];
        if (!note || (note.art !== 's' && note.art !== 'g')) return;
        posEl.replaceChild(buildPosLabel(note, links[m][c][s][str - 1]), posEl.querySelector('.ti-pos-label'));
      });
    });
  }

  function buildSlot(m, c, s, slot, skip){
    var slotEl = el('div', 'ti-slot');
    if (skip) slotEl.classList.add('is-skip');
    slotEl.dataset.m = String(m);
    slotEl.dataset.c = String(c);
    slotEl.dataset.s = String(s);
    if (slot.rest){
      slotEl.classList.add('is-rest');
      slotEl.dataset.rest = slot.restUncertain ? 'r?' : 'r';
      if (slot.restUncertain) slotEl.classList.add('is-uncertain');
    }
    for (var str = 1; str <= T.STRING_COUNT; str++) slotEl.appendChild(buildPos(str, slot.notes[str - 1]));
    if (T.slotRollShown(slot)){
      var minStr = 0, maxStr = 0;
      slot.notes.forEach(function(note, index){
        if (!note) return;
        if (!minStr) minStr = index + 1;
        maxStr = index + 1;
      });
      var mark = buildRollMark();
      mark.style.top = ((minStr - 1) * POS_H + 4) + 'px';
      mark.style.height = ((maxStr - minStr) * POS_H + 16) + 'px';
      slotEl.classList.add('is-roll');
      slotEl.appendChild(mark);
    }
    return slotEl;
  }

  // 텍스트 모드에서 카드의 코드·메모 칸은 읽기 전용이다(편집기와 어긋나지 않게).
  function lockCardInput(input, locked){
    input.readOnly = locked;
    if (locked) input.title = TEXT_LOCK_TITLE;
    else input.removeAttribute('title');
  }

  function buildCard(m){
    var measure = doc.measures[m];
    var card = el('article', 'ti-measure');
    card.dataset.m = String(m);

    var head = el('div', 'ti-measure-head');
    var num = el('button', 'ti-measure-num', String(m + 1));
    num.type = 'button';
    num.setAttribute('aria-pressed', 'false');
    num.title = '마디 선택 (Shift: 범위)';
    var chord = el('input', 'ti-chord');
    chord.type = 'text';
    chord.placeholder = '코드';
    chord.value = measure.chord;
    chord.setAttribute('aria-label', (m + 1) + '마디 코드');
    chord.autocomplete = 'off';
    lockCardInput(chord, ui.inputMode === 'text');
    head.appendChild(num);
    head.appendChild(chord);
    card.appendChild(head);

    var scroll = el('div', 'ti-staff-scroll');
    var staffWrap = el('div', 'ti-staff-wrap');
    staffWrap.style.height = StaffSvg.STAFF_HEIGHT + 'px';
    var staffCursor = el('div', 'ti-staff-cursor');
    staffCursor.hidden = true;
    staffWrap.appendChild(staffCursor);
    staffWrap.appendChild(el('div', 'ti-staff-draw'));
    scroll.appendChild(staffWrap);
    var staff = el('div', 'ti-staff');
    var names = el('div', 'ti-names');
    names.appendChild(el('div', 'ti-names-head'));
    for (var i = 0; i < T.STRING_COUNT; i++) names.appendChild(el('div', 'ti-name', (i + 1) + ' ' + STRING_LETTERS[i]));
    staff.appendChild(names);
    var cells = el('div', 'ti-cells');
    measure.cells.forEach(function(cell, c){
      var d = cell.slots.length;
      var cellEl = el('div', 'ti-cell');
      // 빈칸 칸(시간 0)은 연습 화면 박 셀과 같은 .slot-skip 으로 빗금을 그린다(src/base.css)
      if (cell.skip === true) cellEl.classList.add('slot-skip');
      cellEl.style.setProperty('--d', String(d));
      var cellHead = el('div', 'ti-cell-head', String(c + 1) + (d >= 2 ? ' ÷' + d : ''));
      cellHead.dataset.c = String(c);
      cellEl.appendChild(cellHead);
      var slotsEl = el('div', 'ti-slots');
      cell.slots.forEach(function(slot, s){ slotsEl.appendChild(buildSlot(m, c, s, slot, cell.skip === true)); });
      cellEl.appendChild(slotsEl);
      cells.appendChild(cellEl);
    });
    staff.appendChild(cells);
    scroll.appendChild(staff);
    card.appendChild(scroll);

    var memo = el('input', 'ti-memo');
    memo.type = 'text';
    memo.placeholder = '메모';
    memo.value = measure.memo;
    memo.setAttribute('aria-label', (m + 1) + '마디 메모');
    memo.autocomplete = 'off';
    lockCardInput(memo, ui.inputMode === 'text');
    card.appendChild(memo);
    card.appendChild(el('code', 'ti-line'));
    var error = el('div', 'ti-measure-error');
    error.hidden = true;
    card.appendChild(error);
    return card;
  }

  function renderMeasures(){
    var box = $('tiMeasures');
    box.textContent = '';
    doc.measures.forEach(function(measure, m){ box.appendChild(buildCard(m)); });
  }

  function rebuildCard(m){
    var box = $('tiMeasures');
    var old = box.children[m];
    var card = buildCard(m);
    if (old) box.replaceChild(card, old);
    else box.appendChild(card);
  }

  // ---------- 그리기: 결과·곡 정보·선택·커서

  function refreshResults(){
    var lines = T.docToScoreLines(doc);
    var diag = T.validateDoc(doc);
    var cards = $('tiMeasures').children;
    var byMeasure = {};
    diag.errors.forEach(function(error){
      (byMeasure[error.measure] = byMeasure[error.measure] || []).push(error.message);
    });
    for (var i = 0; i < cards.length; i++){
      cards[i].querySelector('.ti-line').textContent = lines[i] == null ? '' : lines[i];
      var errorEl = cards[i].querySelector('.ti-measure-error');
      var messages = byMeasure[i + 1];
      errorEl.textContent = messages ? messages.join(' / ') : '';
      errorEl.hidden = !messages;
    }
    var list = $('tiDiagnostics');
    list.textContent = '';
    diag.errors.forEach(function(error){
      list.appendChild(el('li', 'is-error', (error.measure ? '마디 ' + error.measure + ' · ' : '') + error.message));
    });
    if (!diag.errors.length) list.appendChild(el('li', 'is-ok', '오류 없음'));
    (diag.warnings || []).forEach(function(warning){
      list.appendChild(el('li', 'is-warn', '경고 · ' + (warning.measure ? '마디 ' + warning.measure + ' · ' : '') + warning.message));
    });
    $('tiScoreText').value = lines.join('\n');
    refreshSlurLabels();
    fitCellWidths();
    refreshStaff(lines);
    var blocked = diag.errors.length > 0;
    $('tiCopyTextBtn').disabled = blocked;
    $('tiCopyTsvBtn').disabled = blocked;
    $('tiOpenPracticeBtn').disabled = blocked;
  }

  function setValue(input, value){
    var text = String(value);
    if (input.value !== text) input.value = text;
  }

  // 카포 콤보박스는 제목·설명 글의 카포 표기를 읽어 보여 준다(저장은 그 글이다).
  function refreshCapoSelect(){
    setValue($('tiCapoSelect'), T.docCapo(doc));
  }

  function refreshInfo(){
    setValue($('tiTitle'), doc.title);
    setValue($('tiBeats'), doc.beats);
    setValue($('tiBpm'), doc.bpm);
    setValue($('tiDescription'), doc.description);
    setValue($('tiKeySelect'), keyOptionValue());
    refreshCapoSelect();
    var sourceInfo = $('tiSourceInfo');
    sourceInfo.hidden = !doc.sourceId;
    sourceInfo.textContent = doc.sourceId ? SOURCE_INFO : '';
  }

  function refreshUndoRedo(){
    $('tiUndoBtn').disabled = !history.canUndo();
    $('tiRedoBtn').disabled = !history.canRedo();
  }

  function refreshSelectionUI(){
    var bar = $('tiSelectionBar');
    bar.hidden = !sel;
    document.documentElement.style.setProperty('--ti-sel-h', sel ? bar.offsetHeight + 'px' : '0px');
    var cards = $('tiMeasures').children;
    for (var i = 0; i < cards.length; i++){
      var on = !!sel && i >= sel.a && i <= sel.b;
      cards[i].classList.toggle('is-selected', on);
      cards[i].querySelector('.ti-measure-num').setAttribute('aria-pressed', String(on));
    }
    if (!sel) return;
    $('tiSelectionLabel').textContent = sel.a === sel.b ? (sel.a + 1) + '마디 선택' : (sel.a + 1) + '~' + (sel.b + 1) + '마디 선택';
    $('tiPasteBtn').disabled = !clip;
    $('tiDeleteBtn').disabled = sel.b - sel.a + 1 >= doc.measures.length;
  }

  function fretLabel(str, fret){ return T.noteLabel(doc, str, fret).replace(/\d+$/, ''); }

  function refreshFretLabels(){
    fretButtons.forEach(function(btn){
      var str = Number(btn.dataset.str);
      var fret = Number(btn.dataset.fret);
      btn.firstChild.textContent = fretLabel(str, fret);
      btn.setAttribute('aria-label', str + '번 줄 ' + fret + '프렛 ' + T.noteLabel(doc, str, fret));
    });
  }

  function refreshCursorUI(scroll){
    var box = $('tiMeasures');
    Array.prototype.forEach.call(box.querySelectorAll('.is-cursor, .is-cursor-slot'), function(node){
      node.classList.remove('is-cursor', 'is-cursor-slot');
    });
    var slotEl = box.querySelector('.ti-slot[data-m="' + cursor.m + '"][data-c="' + cursor.c + '"][data-s="' + cursor.s + '"]');
    if (slotEl){
      slotEl.classList.add('is-cursor-slot');
      var posEl = slotEl.querySelector('.ti-pos[data-str="' + cursor.str + '"]');
      if (posEl) posEl.classList.add('is-cursor');
      if (scroll && slotEl.scrollIntoView){
        slotEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        box.scrollIntoView({ block: 'nearest' });
      }
    }

    placeStaffCursor(slotEl);

    var slot = T.getSlot(doc, cursor);
    var division = doc.measures[cursor.m].cells[cursor.c].slots.length;
    var label = (cursor.m + 1) + '마디 · ' + (cursor.c + 1) + '칸';
    if (division > 1) label += ' · 조각 ' + (cursor.s + 1) + '/' + division;
    if (T.isSkipCell(doc, cursor)) label += ' · 빈칸';
    label += ' · ' + cursor.str + '번 줄';
    $('tiCursorLabel').textContent = label;
    var staffMove = ui.inputMode === 'staff';
    $('tiPrevBtn').disabled = !(staffMove ? S.prevEventPos(doc, cursor) : T.prevPos(doc, cursor));
    $('tiNextBtn').disabled = !(staffMove ? S.nextEventPos(doc, cursor) : T.nextPos(doc, cursor));
    $('tiRestBtn').setAttribute('aria-pressed', String(!!slot.rest));
    $('tiSkipBtn').setAttribute('aria-pressed', String(T.isSkipCell(doc, cursor)));
    for (var d = 1; d <= 4; d++) $('tiDiv' + d).setAttribute('aria-pressed', String(division === d));
    $('tiAutoAdvance').setAttribute('aria-pressed', String(ui.autoAdvance));
    $('tiSoundToggle').setAttribute('aria-pressed', String(ui.sound));
    $('tiStaffToggle').setAttribute('aria-pressed', String(ui.staffOn));

    fretButtons.forEach(function(btn){
      var str = Number(btn.dataset.str);
      var note = slot.notes[str - 1];
      var on = !!note && note.fret === Number(btn.dataset.fret);
      btn.classList.toggle('is-on', on);
      btn.classList.toggle('is-cursor-row', str === cursor.str);
      btn.setAttribute('aria-pressed', String(on));
    });
    Array.prototype.forEach.call($('tiFretboard').querySelectorAll('.ti-fb-row'), function(row){
      row.classList.toggle('is-cursor-row', Number(row.dataset.str) === cursor.str);
    });

    var cursorNote = slot.notes[cursor.str - 1];
    attrButtons.forEach(function(btn){
      var attr = btn.dataset.attr;
      var current = cursorNote ? (cursorNote[attr] == null ? '' : String(cursorNote[attr])) : null;
      btn.disabled = !cursorNote;
      if (attr === 'art' && btn.dataset.value === 'h' && cursorNote){
        if (ui.inputMode === 'staff') btn.disabled = !S.harmonicTarget(doc, cursor, cursor.str).ok;
        else if (cursorNote.art !== 'h' && !T.isHarmonicFret(cursorNote.fret)) btn.disabled = true;
      }
      var linkArt = attr === 'art' && (btn.dataset.value === 's' || btn.dataset.value === 'g') ? btn.dataset.value : null;
      if (linkArt && cursorNote && cursorNote.art !== linkArt){
        if (ui.inputMode === 'staff') btn.disabled = !S.linkTarget(doc, cursor, cursor.str, linkArt).ok;
        else btn.disabled = !T.linkCheck(doc, cursor, cursor.str, linkArt).ok;
      }
      btn.setAttribute('aria-pressed', String(cursorNote != null && current === btn.dataset.value));
    });
    var uncertain = $('tiUncertainBtn');
    uncertain.disabled = !(cursorNote || slot.rest);
    uncertain.setAttribute('aria-pressed', String(cursorNote ? cursorNote.uncertain : (slot.rest ? slot.restUncertain : false)));
    var rollBtn = $('tiRollBtn');
    var rollCount = slot.notes.filter(function(note){ return !!note; }).length;
    rollBtn.disabled = !!slot.rest || rollCount < 2;
    rollBtn.setAttribute('aria-pressed', String(T.slotRollShown(slot)));
    refreshStaffMode();
  }

  // ---------- 오선 미리보기 (배치 src/staff-layout.js, 그리기 src/staff-svg.js, 규칙 Docs/staff-notation.md)

  function keyOptionValue(){
    if (doc.key !== 0) return String(doc.key);
    return doc.accidentals === 'flat' ? '0f' : '0s';
  }

  // 카드의 타브 칸 격자 위치를 재서 칸 c, 칸 안 위치 unit(0~11)의 가운데 x를 돌려주는 함수를 만든다.
  function measureCardGeometry(card){
    var staffEl = card.querySelector('.ti-staff');
    var base = staffEl.getBoundingClientRect();
    var cells = Array.prototype.map.call(card.querySelectorAll('.ti-cell'), function(cellEl){
      var cellRect = cellEl.getBoundingClientRect();
      return {
        left: cellRect.left - base.left,
        width: cellRect.width,
        slots: Array.prototype.map.call(cellEl.querySelectorAll('.ti-slot'), function(slotEl){
          var rect = slotEl.getBoundingClientRect();
          return rect.left - base.left + rect.width / 2;
        })
      };
    });
    return {
      width: base.width,
      leftPad: card.querySelector('.ti-names').getBoundingClientRect().width,
      xAt: function(cell, unit){
        var info = cells[cell];
        if (!info) return 0;
        var d = info.slots.length;
        for (var s = 0; s < d; s++) if (s * 12 / d === unit) return info.slots[s];
        return info.left + info.width * unit / 12;
      }
    };
  }

  // 칸의 조각 폭 = max(26px, 그 칸 조각들의 프렛 글자 최대 폭 + 6px). 운지가 붙은 글자가 조각보다 넓어 가로 스크롤이 생기는 걸 막는다.
  // 글자 폭은 그린 뒤 DOM에서 재서 --sw로 넣는다(칸 너비 = max(48px, 나눈 수 × 조각 폭)). 오선 xAt은 이 뒤에 재니 넓어진 위치를 따른다.
  function fitCellWidths(){
    var cells = $('tiMeasures').querySelectorAll('.ti-cell');
    var widths = [];
    var i;
    for (i = 0; i < cells.length; i++){
      var max = 0;
      var room = cells[i].querySelector('.ti-slot.is-roll') ? CELL_ROLL_ROOM : 0;
      var labels = cells[i].querySelectorAll('.ti-pos-label');
      for (var j = 0; j < labels.length; j++){
        var range = document.createRange();
        range.selectNodeContents(labels[j]);
        max = Math.max(max, range.getBoundingClientRect().width);
      }
      widths.push(Math.max(CELL_SLOT_MIN, Math.ceil(max + CELL_SLOT_PAD)) + 2 * room);
    }
    for (i = 0; i < cells.length; i++){
      if (widths[i] === CELL_SLOT_MIN) cells[i].style.removeProperty('--sw');
      else cells[i].style.setProperty('--sw', widths[i] + 'px');
    }
  }

  function refreshStaff(lines){
    var box = $('tiMeasures');
    box.classList.toggle('staff-off', !ui.staffOn);
    if (!ui.staffOn){ staffLayout = null; return; }
    var cards = box.children;
    var result = Staff.layoutScore(lines.join('\n'), doc.beats, doc.key);
    staffLayout = !result.error && result.measures.length === cards.length ? result : null;
    var header = staffLayout ? { key: staffLayout.key, time: staffLayout.time } : null;
    var i;
    // 쓰기: 첫 마디 줄 이름 열을 머리 폭만큼 넓힌다(타브와 오선이 같이 밀려 칸이 위아래로 맞는다)
    for (i = 0; i < cards.length; i++) cards[i].style.removeProperty('--ti-names-w');
    var headerPx = header ? StaffSvg.headerWidth(header) : 0;
    if (cards.length && headerPx){
      var baseNames = cards[0].querySelector('.ti-names').getBoundingClientRect().width;
      cards[0].style.setProperty('--ti-names-w', (baseNames + headerPx) + 'px');
    }
    // 읽기: 모든 카드의 칸 위치
    var geos = [];
    for (i = 0; i < cards.length; i++) geos.push(staffLayout ? measureCardGeometry(cards[i]) : null);
    // 쓰기: SVG
    for (i = 0; i < cards.length; i++){
      var wrap = cards[i].querySelector('.ti-staff-wrap');
      var draw = wrap.querySelector('.ti-staff-draw');
      var svg = '';
      if (staffLayout){
        var geo = geos[i];
        geo.header = i === 0 ? header : null;
        wrap.style.width = geo.width + 'px';
        try {
          svg = StaffSvg.renderMeasure(staffLayout.measures[i], geo);
        } catch (error) {
          svg = '';   // 한 마디를 못 그려도 나머지 화면은 계속 갱신한다
        }
      }
      if (draw.__svg !== svg){
        draw.innerHTML = svg;
        draw.__svg = svg;
      }
    }
  }

  // 커서 조각 자리의 옅은 띠: 오선 위
  function placeStaffCursor(slotEl){
    var box = $('tiMeasures');
    Array.prototype.forEach.call(box.querySelectorAll('.ti-staff-cursor'), function(band){ band.hidden = true; });
    if (!slotEl || !ui.staffOn) return;
    var wrap = slotEl.closest('.ti-measure').querySelector('.ti-staff-wrap');
    var band = wrap.querySelector('.ti-staff-cursor');
    var slotRect = slotEl.getBoundingClientRect();
    var wrapRect = wrap.getBoundingClientRect();
    band.style.left = (slotRect.left - wrapRect.left) + 'px';
    band.style.width = slotRect.width + 'px';
    band.hidden = false;
  }

  // 오선 음 머리가 가리키는 타브 조각. 붙임줄로 이어진 뒷토막이면 앞쪽 첫 토막의 자리.
  function staffHeadPos(m, itemIndex){
    if (!staffLayout) return null;
    var mm = m;
    var ii = itemIndex;
    var item = staffLayout.measures[mm].items[ii];
    while (item && item.tieFromPrev){
      if (ii > 0) ii--;
      else {
        mm--;
        if (mm < 0) return null;
        ii = staffLayout.measures[mm].items.length - 1;
      }
      item = staffLayout.measures[mm].items[ii];
    }
    if (!item || item.type !== 'chord') return null;
    var division = doc.measures[mm].cells[item.cell].slots.length;
    return { m: mm, c: item.cell, s: Math.min(division - 1, Math.floor(item.unit * division / 12)) };
  }

  function staffHeadClick(headEl, m){
    var chordEl = headEl.closest('.st-chord');
    if (!chordEl) return;
    var pos = staffHeadPos(m, Number(chordEl.dataset.item));
    var str = Number(headEl.dataset.str);
    if (!pos || !(str >= 1 && str <= T.STRING_COUNT)) return;
    pos.str = str;
    setCursor(pos, false);
    var note = T.getSlot(doc, pos).notes[str - 1];
    if (note) playNotes([{ str: str, note: note }]);
  }

  function refreshDock(){
    var collapsed = ui.dockCollapsed;
    $('tiDockBody').hidden = collapsed;
    $('tiDockToggle').textContent = collapsed ? '입력판 펴기' : '입력판 접기';
    $('tiDockToggle').setAttribute('aria-expanded', String(!collapsed));
    $('tiDock').classList.toggle('is-collapsed', collapsed);
    $('tiDock').classList.toggle('attrs-open', ui.attrsOpen);
    $('tiAttrsToggle').setAttribute('aria-pressed', String(ui.attrsOpen));
  }

  function refreshAfterEdit(){
    refreshResults();
    refreshSelectionUI();
    refreshCursorUI(false);
    refreshUndoRedo();
    refreshInfo();
  }

  function renderAll(){
    renderMeasures();
    refreshFretLabels();
    refreshAfterEdit();
  }

  // ---------- 커서

  function samePos(a, b){ return a.m === b.m && a.c === b.c && a.s === b.s; }

  function setCursor(next, scroll){
    cursor.m = next.m;
    cursor.c = next.c;
    cursor.s = next.s;
    if (next.str) cursor.str = next.str;
    lastEntry = null;
    noteSel = noteAtCursor();
    refreshCursorUI(scroll);
  }

  function moveCursor(direction){
    var staff = ui.inputMode === 'staff';
    var p = direction > 0
      ? (staff ? S.nextEventPos(doc, cursor) : T.nextPos(doc, cursor))
      : (staff ? S.prevEventPos(doc, cursor) : T.prevPos(doc, cursor));
    if (p) setCursor(p, true);
  }

  function moveString(delta){
    cursor.str = Math.max(1, Math.min(T.STRING_COUNT, cursor.str + delta));
    noteSel = noteAtCursor();
    refreshCursorUI(false);
  }

  // ---------- 음 넣기

  function flushPending(advance){
    if (!pending) return;
    var p = pending;
    pending = null;
    clearTimeout(p.timer);
    if (advance && p.deferred && samePos(p, cursor)){
      var next = T.nextPos(doc, cursor);
      if (next) setCursor(next, true);
    }
  }

  // mode 'toggle'은 지판 클릭(같은 프렛이면 지움), 'set'은 숫자키(같은 프렛이면 그대로).
  // 켜져 있으면 다음 조각으로 가고 마지막이면 빈 마디를 붙인다. defer는 이동만 뒤로 미룬다.
  function inputFret(str, fret, mode, defer){
    var pos = { m: cursor.m, c: cursor.c, s: cursor.s };
    var advance = ui.autoAdvance;
    var slot = T.getSlot(doc, pos);
    var existing = slot ? slot.notes[str - 1] : null;
    cursor.str = str;
    if (mode === 'set' && existing && existing.fret === fret){
      playNotes([{ str: str, note: existing }]);
      if (advance && !defer){
        var again = T.nextPos(doc, pos);
        if (again) setCursor(again, true);
        else refreshCursorUI(false);
      } else refreshCursorUI(false);
      return;
    }
    var action = null;
    apply(function(d){
      var r;
      if (mode === 'toggle') r = T.toggleNote(d, pos, str, fret);
      else {
        r = T.setNote(d, pos, str, fret);
        r.action = 'set';
      }
      action = r.action;
      if (advance && action === 'set' && !T.nextPos(d, pos)) T.insertEmptyMeasure(d, d.measures.length);
      return r;
    }, {
      measures: [pos.m],
      onDone: function(){
        if (advance && action === 'set' && !defer){
          var next = T.nextPos(doc, pos);
          if (next){ cursor.m = next.m; cursor.c = next.c; cursor.s = next.s; }
        }
      }
    });
    if (action === 'set'){
      var placed = T.getSlot(doc, pos);
      if (placed && placed.notes[str - 1]) playNotes([{ str: str, note: placed.notes[str - 1] }]);
    }
  }

  function removeAtCursor(){
    var slot = T.getSlot(doc, cursor);
    if (slot.notes[cursor.str - 1]){
      var pos = { m: cursor.m, c: cursor.c, s: cursor.s };
      var str = cursor.str;
      apply(function(d){ return T.removeNote(d, pos, str); }, { measures: [pos.m] });
    } else if (slot.rest){
      var restPos = { m: cursor.m, c: cursor.c, s: cursor.s };
      apply(function(d){ return T.setRest(d, restPos, false); }, { measures: [restPos.m] });
    }
  }

  function toggleRest(){
    var pos = { m: cursor.m, c: cursor.c, s: cursor.s };
    var slot = T.getSlot(doc, pos);
    var on = !slot.rest;
    apply(function(d){ return T.setRest(d, pos, on); }, { measures: [pos.m] });
  }

  // 커서가 있는 칸 전체를 빈칸(시간 0)으로 켜고 끈다. 켜면 그 칸의 조각을 모두 비운다(Docs/tab-input.md 빈칸).
  function toggleSkip(){
    var pos = copyPos(cursor);
    var on = !T.isSkipCell(doc, pos);
    apply(function(d){ return T.setSkip(d, pos, on); }, {
      measures: [pos.m],
      onDone: function(){ lastEntry = null; noteSel = null; }
    });
  }

  function clearSlotAtCursor(){
    var pos = { m: cursor.m, c: cursor.c, s: cursor.s };
    apply(function(d){ return T.clearSlot(d, pos); }, { measures: [pos.m] });
  }

  function setDivision(count){
    var cell = doc.measures[cursor.m].cells[cursor.c];
    if (cell.slots.length === count) return;
    var m = cursor.m;
    var c = cursor.c;
    var result = apply(function(d){ return T.setDivision(d, m, c, count); }, { measures: [m] });
    if (result && result.lost > 0) setStatus(lostText(result.lost));
  }

  function setAttr(attr, value){
    var pos = { m: cursor.m, c: cursor.c, s: cursor.s };
    var str = cursor.str;
    var attrs = {};
    if (attr === 'lh') attrs.lh = value === '' ? null : Number(value);
    else attrs[attr] = value === '' ? null : value;
    apply(function(d){ return T.setNoteAttrs(d, pos, str, attrs); }, { measures: [pos.m] });
  }

  // 커서 음의 자연 하모닉스를 켜고 끈다. onlyOn 이면 이미 하모닉스인 음은 그대로 둔다(단추).
  // 오선 모드는 누른 자리를 손 대는 자리로 보고 필요하면 줄을 옮긴다(Docs/staff-input.md).
  function toggleHarmonic(onlyOn){
    var pos = copyPos(cursor);
    var str = cursor.str;
    var slot = T.getSlot(doc, pos);
    var note = slot ? slot.notes[str - 1] : null;
    if (!note){
      setStatus('하모닉스로 바꿀 음이 없습니다.');
      return;
    }
    if (note.art === 'h'){
      if (onlyOn) return;
      apply(function(d){ return T.setNoteAttrs(d, pos, str, { art: null }); }, { measures: [pos.m] });
      return;
    }
    if (ui.inputMode === 'staff'){
      var result = apply(function(d){ return S.makeHarmonic(d, pos, str); }, {
        measures: [pos.m],
        onDone: function(res){ noteSel = { pos: pos, str: res.str }; cursor.str = res.str; }
      });
      if (result && result.ok === false) setStatus(result.error);
      return;
    }
    if (!T.isHarmonicFret(note.fret)){
      setStatus('하모닉스는 ' + GuitarNotation.naturalHarmonicFretsText() + '프렛 음에서만 됩니다.');
      return;
    }
    apply(function(d){ return T.setNoteAttrs(d, pos, str, { art: 'h' }); }, { measures: [pos.m] });
  }

  // 커서 음의 슬러(해머링·풀링, art 's')나 슬라이드(art 'g')를 켜고 끈다. onlyOn 이면 이미 그 주법인 음은 그대로 둔다(단추).
  // 오선 모드는 바로 앞 음과 이어지도록 필요하면 줄을 옮기고, 타브 모드는 줄을 옮기지 않는다(Docs/tab-input.md, Docs/staff-input.md).
  function toggleLink(art, onlyOn){
    var pos = copyPos(cursor);
    var str = cursor.str;
    var slot = T.getSlot(doc, pos);
    var note = slot ? slot.notes[str - 1] : null;
    if (!note){
      setStatus(T.LINK_ERRORS[art]['no-note']);
      return;
    }
    if (note.art === art){
      if (onlyOn) return;
      apply(function(d){ return T.setNoteAttrs(d, pos, str, { art: null }); }, { measures: [pos.m] });
      return;
    }
    if (ui.inputMode === 'staff'){
      var result = apply(function(d){ return S.makeLink(d, pos, str, art); }, {
        measures: [pos.m],
        onDone: function(res){ noteSel = { pos: pos, str: res.str }; cursor.str = res.str; }
      });
      if (result && result.ok === false) setStatus(result.error);
      return;
    }
    var check = T.linkCheck(doc, pos, str, art);
    if (!check.ok){
      setStatus(check.error);
      return;
    }
    apply(function(d){ return T.setNoteAttrs(d, pos, str, { art: art }); }, { measures: [pos.m] });
  }

  function toggleUncertain(){
    var pos = { m: cursor.m, c: cursor.c, s: cursor.s };
    var str = cursor.str;
    var slot = T.getSlot(doc, pos);
    var note = slot.notes[str - 1];
    if (note){
      var next = !note.uncertain;
      apply(function(d){ return T.setNoteAttrs(d, pos, str, { uncertain: next }); }, { measures: [pos.m] });
    } else if (slot.rest){
      var on = !slot.restUncertain;
      apply(function(d){ return T.setRestUncertain(d, pos, on); }, { measures: [pos.m] });
    }
  }

  // 커서 조각 화음의 롤을 켜고 끈다. 켜는 조건(쉼 아님, 두 음 이상)은 T.slotRollShown/T.setRoll 이 정한다.
  function toggleRoll(){
    var pos = copyPos(cursor);
    var slot = T.getSlot(doc, pos);
    if (!slot) return;
    var on = !T.slotRollShown(slot);
    var result = apply(function(d){ return T.setRoll(d, pos, on); }, { measures: [pos.m] });
    if (result && result.ok === false) setStatus(T.ROLL_ERROR);
  }

  function playSlot(){ playNotes(slotNotes(cursor), T.slotRollShown(T.getSlot(doc, cursor)), copyPos(cursor)); }

  // ---------- 오선 입력 (계산은 src/staff-input.js, 규칙은 Docs/staff-input.md)

  var PICK_TOP_WRITTEN = P.noteNameForMidi(P.STRINGS[0].midi + N.MAX_FRET + 12, false); // 기타 음역 최고음의 적는 이름(실음 + 12)
  var PICK_TOP = writtenStep(PICK_TOP_WRITTEN.charAt(0), Number(/-?\d+$/.exec(PICK_TOP_WRITTEN)[0])); // 맨 위 띠: 기타 음역 최고음의 적는 음
  var PICK_BOTTOM = -7;       // 적는 E3
  var PICK_BODY = 114;        // 머리(음자리표·조표) 오른쪽 음 누르는 자리의 폭(좌표)
  function pickY(step){ return StaffSvg.BASE_Y - step * (StaffSvg.LINE_GAP / 2); } // pickerGeometry().yOf와 같은 식
  var PICK_VIEW_TOP = pickY(PICK_TOP) - 6;       // 보이는 세로 범위(좌표): 맨 위 음 머리와 맨 아래 음 머리가 잘리지 않게
  var PICK_VIEW_BOTTOM = pickY(PICK_BOTTOM) + 5;
  var PICK_HEIGHT_PX = 166;   // 음 고르는 오선의 화면 높이(px). 음역이 넓어져도 입력판 높이가 그대로이게 배율을 이 값에서 셈한다
  var PICK_SCALE = PICK_HEIGHT_PX / (PICK_VIEW_BOTTOM - PICK_VIEW_TOP); // src/staff-svg.js 좌표를 화면 px로 바꾸는 배율
  var PICK_LEDGERS = (function(){
    var list = [];
    for (var st = PICK_BOTTOM; st < 0; st++) if (st % 2 === 0) list.push(st);    // 아래 덧줄: PICK_BOTTOM까지의 짝수
    for (st = 10; st <= PICK_TOP; st += 2) list.push(st);                        // 위 덧줄: 10부터 PICK_TOP 이하의 짝수
    return list;
  })();

  function copyPos(p){ return { m: p.m, c: p.c, s: p.s }; }

  // 커서 조각의 고른 음. 커서 줄에 음이 있으면 그 음. 오선 모드에서는 없을 때 그 조각의 가장 높은 음을 고르고 cursor.str 도 그 줄로 맞춘다.
  function noteAtCursor(){
    var slot = T.getSlot(doc, cursor);
    if (!slot) return null;
    if (slot.notes[cursor.str - 1]) return { pos: copyPos(cursor), str: cursor.str };
    if (ui.inputMode !== 'staff') return null;
    var top = 0;
    var topMidi = -Infinity;
    slot.notes.forEach(function(note, index){
      if (!note) return;
      var midi = T.noteMidiOf(index + 1, note);
      if (midi > topMidi){ topMidi = midi; top = index + 1; }
    });
    if (!top) return null;
    cursor.str = top;
    return { pos: copyPos(cursor), str: top };
  }

  function noteSelNote(){
    if (!noteSel) return null;
    var slot = T.getSlot(doc, noteSel.pos);
    return slot && slot.notes[noteSel.str - 1] ? slot.notes[noteSel.str - 1] : null;
  }

  // 오선 위치(step 0 = 적는 E4)에서 적는 음이름 글자와 옥타브. 옥타브*7 + 글자 번호(C=0)로 센 값이 E4에서 30이다.
  function stepToWritten(step){
    var d = step + 30;
    return { letter: NOTE_LETTERS.charAt(d % 7), octave: Math.floor(d / 7) };
  }

  // stepToWritten의 역함수: 적는 음이름 글자와 옥타브에서 오선 위치.
  function writtenStep(letter, octave){
    return octave * 7 + NOTE_LETTERS.indexOf(letter) - 30;
  }

  function setInputMode(mode){
    if (ui.inputMode === mode) return;
    flushPending(false);
    if (ui.inputMode === 'text') endTextSession();
    ui.inputMode = mode;
    lastEntry = null;
    noteSel = noteAtCursor();
    saveUi();
    refreshCursorUI(false);
    if (mode === 'text'){
      clearSelection();
      enterTextMode(true);
    }
  }

  function pickerGeometry(){
    var base = StaffSvg.BASE_Y;
    var step = StaffSvg.LINE_GAP / 2;
    return { base: base, step: step, yOf: function(st){ return base - st * step; } };
  }

  // 조표가 바뀌면 다시 그린다. 음자리표와 조표는 연습 화면 오선과 같은 StaffSvg.renderHeader.
  function renderPicker(){
    if (pickerKey === doc.key) return;
    pickerKey = doc.key;
    var svg = $('tiPitchPicker');
    var header = { key: doc.key, time: null };
    var hw = StaffSvg.headerWidth(header);
    var width = hw + PICK_BODY;
    var viewH = PICK_VIEW_BOTTOM - PICK_VIEW_TOP;
    var g = pickerGeometry();
    var headX = hw + PICK_BODY / 2;
    var out = [];
    var i;
    for (i = 0; i < 5; i++){
      out.push('<line class="st-line" x1="' + hw + '" y1="' + g.yOf(i * 2) + '" x2="' + width + '" y2="' + g.yOf(i * 2) + '" stroke="currentColor" stroke-width="1"/>');
    }
    PICK_LEDGERS.forEach(function(st){
      out.push('<line class="ti-pick-ledger" x1="' + (headX - 10) + '" y1="' + g.yOf(st) + '" x2="' + (headX + 10) + '" y2="' + g.yOf(st) + '" stroke="currentColor"/>');
    });
    out.push(StaffSvg.renderHeader(header));
    out.push('<ellipse class="ti-pick-ghost" cx="' + headX + '" cy="0" rx="5.4" ry="4" visibility="hidden"/>');
    for (var st = PICK_TOP; st >= PICK_BOTTOM; st--){
      out.push('<rect class="ti-pick-band" data-step="' + st + '" x="' + hw + '" y="' + (g.yOf(st) - g.step / 2) + '" width="' + PICK_BODY + '" height="' + g.step + '"/>');
    }
    svg.setAttribute('width', String(width * PICK_SCALE));
    svg.setAttribute('height', String(viewH * PICK_SCALE));
    svg.setAttribute('viewBox', '0 ' + PICK_VIEW_TOP + ' ' + width + ' ' + viewH);
    svg.innerHTML = out.join('');
  }

  function showPitchHint(step){
    var ghost = $('tiPitchPicker').querySelector('.ti-pick-ghost');
    if (!ghost) return;
    var g = pickerGeometry();
    var cx = ghost.getAttribute('cx');
    var cy = g.yOf(step);
    ghost.setAttribute('cy', String(cy));
    ghost.setAttribute('transform', 'rotate(-20 ' + cx + ' ' + cy + ')');
    ghost.setAttribute('visibility', 'visible');
    var written = stepToWritten(step);
    var found = S.writtenToMidi(doc, cursor, written.letter, written.octave);
    var text = '음역 밖';
    if (!found.error){
      var info = P.midiInfo(found.midi);
      if (info && info.pos) text = T.noteLabel(doc, info.pos.str, info.pos.fret) + ' · ' + info.pos.str + '번 줄 ' + info.pos.fret + '프렛';
    }
    $('tiPitchHint').textContent = text;
  }

  function hidePitchHint(){
    var ghost = $('tiPitchPicker').querySelector('.ti-pick-ghost');
    if (ghost) ghost.setAttribute('visibility', 'hidden');
    $('tiPitchHint').textContent = '';
  }

  // 고른 음의 강조: 타브 글자와 카드 오선의 음 머리. 오선 입력 모드에서만 칠한다.
  function refreshNoteMarks(){
    var box = $('tiMeasures');
    Array.prototype.forEach.call(box.querySelectorAll('.ti-pos.is-selected, .st-head.is-selected'), function(node){
      node.classList.remove('is-selected');
    });
    if (ui.inputMode !== 'staff' || !noteSel) return;
    var p = noteSel.pos;
    var posEl = box.querySelector('.ti-slot[data-m="' + p.m + '"][data-c="' + p.c + '"][data-s="' + p.s + '"] .ti-pos[data-str="' + noteSel.str + '"]');
    if (posEl) posEl.classList.add('is-selected');
    var card = box.children[p.m];
    var measure = doc.measures[p.m];
    if (!card || !measure) return;
    var unit = p.s * 12 / measure.cells[p.c].slots.length;
    var chords = card.querySelectorAll('.st-chord[data-cell="' + p.c + '"][data-unit="' + unit + '"]');
    Array.prototype.forEach.call(chords, function(chord){
      Array.prototype.forEach.call(chord.querySelectorAll('.st-head[data-str="' + noteSel.str + '"]'), function(head){
        head.classList.add('is-selected');
      });
    });
  }

  function refreshStringCands(){
    var box = $('tiStringCands');
    box.textContent = '';
    if (!noteSel) return;
    S.stringCandidates(doc, noteSel.pos, noteSel.str).forEach(function(item){
      var btn = el('button', 'btn sm', item.str + '번 줄 ' + item.fret + '프렛');
      btn.type = 'button';
      btn.dataset.str = String(item.str);
      btn.setAttribute('aria-pressed', String(item.current));
      box.appendChild(btn);
    });
  }

  function refreshStaffMode(){
    var mode = ui.inputMode;
    var staff = mode === 'staff';
    $('tiModeTab').setAttribute('aria-pressed', String(mode === 'tab'));
    $('tiModeStaff').setAttribute('aria-pressed', String(staff));
    $('tiModeText').setAttribute('aria-pressed', String(mode === 'text'));
    // data-mode 는 그 요소가 보이는 입력 방식들(공백으로 구분)
    Array.prototype.forEach.call($('tiDock').querySelectorAll('[data-mode]'), function(node){
      node.hidden = node.dataset.mode.split(' ').indexOf(mode) < 0;
    });
    $('tiFretboard').hidden = mode !== 'tab';
    $('tiStaffPanel').hidden = !staff;
    $('tiTextPanel').hidden = mode !== 'text';
    $('tiTabHint').hidden = mode !== 'tab';
    $('tiStaffHint').hidden = !staff;
    // 텍스트 모드: 마디 추가 단추를 숨기고 카드 코드·메모 칸을 잠근다(선택 막대는 sel 이 없어 이미 숨는다)
    var text = mode === 'text';
    $('tiAddMeasureBtn').hidden = text;
    Array.prototype.forEach.call($('tiMeasures').querySelectorAll('.ti-chord, .ti-memo'), function(input){ lockCardInput(input, text); });
    if (noteSel && !noteSelNote()) noteSel = null;
    refreshNoteMarks();
    if (!staff) return;
    renderPicker();
    Array.prototype.forEach.call($('tiStaffPanel').querySelectorAll('[data-dur]'), function(btn){
      btn.setAttribute('aria-pressed', String(btn.dataset.dur === ui.staffDur.value));
    });
    $('tiDotBtn').setAttribute('aria-pressed', String(ui.staffDur.dotted));
    $('tiTripletBtn').setAttribute('aria-pressed', String(ui.staffDur.triplet));
    $('tiSemiUpBtn').disabled = !noteSel;
    $('tiSemiDownBtn').disabled = !noteSel;
    refreshStringCands();
  }

  function staffDuration(){
    var d = ui.staffDur;
    var result = S.durationUnits(doc.beats, d.value, d.dotted, d.triplet);
    if (result.error){
      setStatus(result.error);
      return null;
    }
    return result.units;
  }

  function playNoteSel(){
    var note = noteSelNote();
    if (note) playNotes([{ str: noteSel.str, note: note }]);
  }

  // 커서 자리에 사건(음·쉼·길이 바꾸기)을 넣는다. 커서는 그대로 둔다. 실패하면 문서와 되돌리기 기록은 그대로.
  function placeAtCursor(content){
    setStatus('');
    var units = staffDuration();
    if (units == null) return;
    var pos = copyPos(cursor);
    var opts = {
      measures: [pos.m],
      onDone: function(result){
        opts.measures = [];
        for (var m = pos.m; m <= result.next.m; m++) opts.measures.push(m);
        lastEntry = null;
        noteSel = null;
        if (result.placed && result.placed.length){
          lastEntry = { pos: pos };
          noteSel = { pos: pos, str: result.placed[result.placed.length - 1].str };
          cursor.str = noteSel.str;
        }
      }
    };
    var result = apply(function(d){ return S.placeEvent(d, pos, units, content); }, opts);
    if (!result) return;
    if (result.ok === false){
      setStatus(result.error);
      return;
    }
    refreshCursorUI(true);
    playNoteSel();
  }

  // 음높이 입력: 커서 조각에 음이 있으면 같은 음은 지우고 다른 음은 화음에 더한다. 음이 없으면 지금 길이로 새로 넣는다.
  function inputPitch(midi){
    var slot = T.getSlot(doc, cursor);
    var hasNote = !!slot && slot.notes.some(function(note){ return !!note; });
    if (!hasNote){
      placeAtCursor({ midis: [midi] });
      return;
    }
    setStatus('');
    var pos = copyPos(cursor);
    var result = apply(function(d){ return S.toggleChordNote(d, pos, midi); }, {
      measures: [pos.m],
      onDone: function(res){
        if (res.str){
          lastEntry = { pos: pos };
          noteSel = { pos: pos, str: res.str };
          cursor.str = res.str;
        } else {
          lastEntry = null;
          noteSel = null;
        }
      }
    });
    if (!result) return;
    if (result.ok === false){
      setStatus(result.error);
      return;
    }
    if (result.added) playNoteSel();
  }

  function enterLetter(letter){
    var slot = T.getSlot(doc, cursor);
    var hasNote = !!slot && slot.notes.some(function(note){ return !!note; });
    var refEntry = lastEntry || (hasNote ? { pos: copyPos(cursor) } : null);
    var ref = S.referenceMidi(doc, cursor, refEntry);
    var found = S.nearestMidi(doc, cursor, letter, ref);
    if (found.error){
      setStatus(found.error);
      return;
    }
    inputPitch(found.midi);
  }

  function deleteToRest(){
    var pos = copyPos(cursor);
    var result = apply(function(d){ return S.noteToRest(d, pos); }, {
      measures: [pos.m],
      onDone: function(){ lastEntry = null; noteSel = null; }
    });
    if (result && result.ok === false) setStatus(result.error);
  }

  function transposeSelected(semitones){
    if (!noteSel){
      setStatus('고른 음이 없습니다.');
      return;
    }
    var target = { pos: copyPos(noteSel.pos), str: noteSel.str };
    var result = apply(function(d){ return S.transposeNote(d, target.pos, target.str, semitones); }, {
      measures: [target.pos.m],
      onDone: function(res){ noteSel = { pos: target.pos, str: res.str }; cursor.str = res.str; }
    });
    if (!result) return;
    if (result.ok === false){
      setStatus(result.error);
      return;
    }
    playNoteSel();
  }

  function moveSelectedToString(toStr){
    if (!noteSel || toStr === noteSel.str) return;
    var target = { pos: copyPos(noteSel.pos), str: noteSel.str };
    var result = apply(function(d){ return S.moveToString(d, target.pos, target.str, toStr); }, {
      measures: [target.pos.m],
      onDone: function(res){ noteSel = { pos: target.pos, str: res.str }; cursor.str = res.str; }
    });
    if (!result) return;
    if (result.ok === false){
      setStatus(result.error);
      return;
    }
    playNoteSel();
  }

  function setStaffDur(change){
    Object.keys(change).forEach(function(name){ ui.staffDur[name] = change[name]; });
    setStatus('');
    saveUi();
    refreshCursorUI(false);
    // 커서 조각에 음이나 쉼이 있으면 고른 길이를 바로 넣는다(같은 길이면 건너뛰어 되돌리기 기록을 더하지 않는다)
    var slot = T.getSlot(doc, cursor);
    if (!slot || !(slot.rest || slot.notes.some(function(note){ return !!note; }))) return;
    var units = staffDuration();
    if (units == null) return;
    if (S.eventLength(doc, cursor) === units) return;
    placeAtCursor({ keep: true });
  }

  // 오선 모드 키(Docs/staff-input.md 키보드 표). 처리했으면 true. 글자는 event.code, 숫자와 점은 event.key.
  function onStaffKey(event){
    var key = event.key;
    var code = event.code;
    if (/^Key[A-G]$/.test(code)){
      event.preventDefault();
      if (!event.repeat) enterLetter(code.charAt(3));
      return true;
    }
    if (code === 'KeyT'){
      event.preventDefault();
      if (!event.repeat) setStaffDur({ triplet: !ui.staffDur.triplet });
      return true;
    }
    if (code === 'KeyR'){
      event.preventDefault();
      if (!event.repeat) placeAtCursor({ rest: true });
      return true;
    }
    if (key === '.'){
      event.preventDefault();
      if (!event.repeat) setStaffDur({ dotted: !ui.staffDur.dotted });
      return true;
    }
    if (key.length === 1 && key >= '0' && key <= '9'){
      event.preventDefault();
      if (event.repeat) return true;
      if (key === '0') placeAtCursor({ rest: true });
      else if (DUR_KEYS[key]) setStaffDur({ value: DUR_KEYS[key] });
      return true;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown'){
      event.preventDefault();
      transposeSelected(key === 'ArrowUp' ? 1 : -1);
      return true;
    }
    if (key === 'Delete' || key === 'Backspace'){
      event.preventDefault();
      deleteToRest();
      return true;
    }
    return false;
  }

  function bindStaffDock(){
    $('tiModeTab').addEventListener('click', function(){ setInputMode('tab'); });
    $('tiModeStaff').addEventListener('click', function(){ setInputMode('staff'); });
    $('tiModeText').addEventListener('click', function(){ setInputMode('text'); });
    Array.prototype.forEach.call($('tiStaffPanel').querySelectorAll('[data-dur]'), function(btn){
      btn.addEventListener('click', function(){ setStaffDur({ value: btn.dataset.dur }); });
    });
    $('tiDotBtn').addEventListener('click', function(){ setStaffDur({ dotted: !ui.staffDur.dotted }); });
    $('tiTripletBtn').addEventListener('click', function(){ setStaffDur({ triplet: !ui.staffDur.triplet }); });
    $('tiStaffRestBtn').addEventListener('click', function(){ placeAtCursor({ rest: true }); });
    $('tiSemiUpBtn').addEventListener('click', function(){ transposeSelected(1); });
    $('tiSemiDownBtn').addEventListener('click', function(){ transposeSelected(-1); });
    $('tiStringCands').addEventListener('click', function(event){
      var btn = event.target.closest('button');
      if (btn) moveSelectedToString(Number(btn.dataset.str));
    });
    var picker = $('tiPitchPicker');
    function bandOf(event){ return event.target.closest && event.target.closest('[data-step]'); }
    picker.addEventListener('mouseover', function(event){
      var band = bandOf(event);
      if (band) showPitchHint(Number(band.dataset.step));
    });
    picker.addEventListener('mouseleave', hidePitchHint);
    picker.addEventListener('click', function(event){
      var band = bandOf(event);
      if (!band) return;
      var written = stepToWritten(Number(band.dataset.step));
      var found = S.writtenToMidi(doc, cursor, written.letter, written.octave);
      if (found.error){
        setStatus(found.error);
        return;
      }
      inputPitch(found.midi);
    });
  }

  // ---------- 마디 선택과 연산

  function selectMeasure(m, shift){
    if (shift && selAnchor != null){
      sel = { a: Math.min(selAnchor, m), b: Math.max(selAnchor, m) };
    } else {
      sel = { a: m, b: m };
      selAnchor = m;
    }
    refreshSelectionUI();
  }

  function clearSelection(){
    sel = null;
    selAnchor = null;
    refreshSelectionUI();
  }

  function rangeList(a, b){
    var list = [];
    for (var i = a; i <= b; i++) list.push(i);
    return list;
  }

  function selectionAction(kind){
    if (!sel) return;
    var a = sel.a;
    var b = sel.b;
    if (kind === 'copy'){
      try {
        clip = T.copyRange(doc, a, b);
        setStatus(clip.length + '마디를 복사했습니다.');
      } catch (error) {
        setStatus(error.message);
      }
      refreshSelectionUI();
    } else if (kind === 'paste'){
      if (!clip) return;
      var pasteCopy = clip;
      var result = apply(function(d){ return T.pasteAfter(d, b, pasteCopy); }, {
        all: true,
        onDone: function(r){
          sel = { a: b + 1, b: b + r.inserted };
          selAnchor = b + 1;
        }
      });
      if (result && result.lost > 0) setStatus(lostText(result.lost));
    } else if (kind === 'duplicate'){
      apply(function(d){ return T.duplicateRange(d, a, b); }, { all: true });
    } else if (kind === 'clear'){
      apply(function(d){ return T.clearRange(d, a, b); }, { measures: rangeList(a, b) });
    } else if (kind === 'delete'){
      apply(function(d){ return T.deleteRange(d, a, b); }, {
        all: true,
        onDone: function(){ sel = null; selAnchor = null; }
      });
    } else if (kind === 'insert'){
      apply(function(d){ return T.insertEmptyMeasure(d, b + 1); }, { all: true });
    } else if (kind === 'deselect'){
      clearSelection();
    }
  }

  // ---------- 텍스트로 입력 (규칙은 Docs/tab-input.md 텍스트로 입력)

  function loadTextDraft(){
    var stored = ls.get(TEXT_KEY, null);
    if (stored && typeof stored === 'object' && typeof stored.raw === 'string' && typeof stored.baseText === 'string' && typeof stored.valid === 'boolean'){
      textDraft = { raw: stored.raw, baseText: stored.baseText, valid: stored.valid };
    }
  }

  function setTextDraft(raw, valid){
    textDraft = { raw: raw, baseText: T.docScoreText(doc), valid: valid };
    ls.set(TEXT_KEY, textDraft);
  }

  function endTextSession(){
    flushTextReflect();
    textSession = false;
  }

  function showTextStatus(error){
    var node = $('tiTextError');
    node.textContent = error || TEXT_OK;
    node.title = error || '';
    node.classList.toggle('is-error', !!error);
    node.classList.toggle('is-ok', !error);
  }

  function refreshTextRestore(){
    $('tiTextRestoreBtn').hidden = restoreRaw == null;
  }

  // 글자 커서가 있는 줄의 마디 번호(0부터). 빈 줄은 세지 않는다. 빈 줄 위에 있으면 바로 앞 글 줄의 마디.
  function caretMeasure(editor){
    var before = editor.value.slice(0, editor.selectionStart == null ? 0 : editor.selectionStart);
    var lines = editor.value.split('\n');
    var lineIndex = before.split('\n').length - 1;
    var count = 0;
    for (var i = 0; i <= lineIndex && i < lines.length; i++) if (lines[i].trim()) count++;
    return Math.max(0, count - 1);
  }

  // m번째(0부터) 글 줄의 첫머리 위치. 그 줄이 없으면 맨 끝.
  function measureLineStart(text, m){
    var lines = text.split('\n');
    var offset = 0;
    var count = 0;
    for (var i = 0; i < lines.length; i++){
      if (lines[i].trim()){
        if (count === m) return offset;
        count++;
      }
      offset += lines[i].length + 1;
    }
    return text.length;
  }

  function placeCaretAtCursorMeasure(focus){
    var editor = $('tiTextEditor');
    var at = measureLineStart(editor.value, cursor.m);
    if (focus) editor.focus();
    editor.setSelectionRange(at, at);
  }

  // 글자 커서 줄의 마디로 문서 커서를 옮기고 그 카드가 보이게 한다.
  function syncCursorFromCaret(){
    if (ui.inputMode !== 'text') return;
    var m = Math.min(caretMeasure($('tiTextEditor')), doc.measures.length - 1);
    if (m === cursor.m) return;
    setCursor({ m: m, c: 0, s: 0 }, true);
  }

  // 들어올 때 보여 줄 글을 고른다. 저장된 글이 지금 문서에서 나온 것이면 그 글, 아니면 지금 문서 텍스트.
  function enterTextMode(focus){
    var editor = $('tiTextEditor');
    var current = T.docScoreText(doc);
    restoreRaw = null;
    textSession = false;
    if (textDraft && textDraft.baseText === current){
      editor.value = textDraft.raw;
    } else {
      editor.value = current;
      if (textDraft && !textDraft.valid && textDraft.raw !== current) restoreRaw = textDraft.raw;
      else setTextDraft(current, true);
    }
    var error = textDraft && !textDraft.valid && textDraft.baseText === current ? T.replaceMeasuresFromText(doc, editor.value).error : null;
    showTextStatus(error);
    refreshTextRestore();
    placeCaretAtCursorMeasure(focus);
  }

  // 밖에서 문서가 바뀐 뒤(되돌리기, 칸 수, 불러오기 …) 텍스트 모드면 편집기를 지금 문서 텍스트로 다시 채운다.
  // 문서 텍스트가 그대로면(BPM 같은 것만 바뀜) 친 글자를 건드리지 않는다.
  function syncTextToDoc(){
    if (ui.inputMode !== 'text') return;
    var current = T.docScoreText(doc);
    if (textDraft && textDraft.baseText === current) return;
    clearTimeout(textTimer);
    textTimer = null;
    textSession = false;
    if (textDraft && !textDraft.valid && textDraft.raw !== current) restoreRaw = textDraft.raw;
    else {
      restoreRaw = null;
      setTextDraft(current, true);
    }
    $('tiTextEditor').value = current;
    showTextStatus(null);
    refreshTextRestore();
    placeCaretAtCursorMeasure(false);
  }

  function scheduleTextReflect(){
    clearTimeout(textTimer);
    textTimer = setTimeout(reflectText, TEXT_DEBOUNCE_MS);
  }

  function flushTextReflect(){
    if (textTimer) reflectText();
  }

  // 편집기 글을 문서에 반영한다. 맞으면 마디만 바꾸고 카드를 다시 그리며, 틀리면 문서는 그대로 두고 오류를 보인다.
  function reflectText(){
    clearTimeout(textTimer);
    textTimer = null;
    if (ui.inputMode !== 'text') return;
    var editor = $('tiTextEditor');
    var raw = editor.value;
    var result = T.replaceMeasuresFromText(doc, raw);
    if (result.error){
      setTextDraft(raw, false);
      showTextStatus(result.error);
      syncCursorFromCaret();
      return;
    }
    if (JSON.stringify(result.doc) !== JSON.stringify(doc)){
      commitText();
      if (!textSession){
        history.record(historyEntry(doc, cursor));
        textSession = true;
      }
      doc = result.doc;
      lastEntry = null;
      clampCursor();
      clampSelection();
      noteSel = noteAtCursor();
      saveNow();
      renderAll();
    }
    setTextDraft(raw, true);
    showTextStatus(null);
    syncCursorFromCaret();
  }

  function bindTextEditor(){
    var editor = $('tiTextEditor');
    editor.addEventListener('input', function(){
      restoreRaw = null;
      refreshTextRestore();
      scheduleTextReflect();
    });
    ['keyup', 'click', 'focus'].forEach(function(name){
      editor.addEventListener(name, syncCursorFromCaret);
    });
    editor.addEventListener('blur', endTextSession);
    $('tiTextRestoreBtn').addEventListener('click', function(){
      if (restoreRaw == null) return;
      editor.value = restoreRaw;
      restoreRaw = null;
      refreshTextRestore();
      reflectText();
      editor.focus();
    });
    window.addEventListener('pagehide', flushTextReflect);
    window.addEventListener('beforeunload', flushTextReflect);
  }

  // ---------- 불러오기와 새 악보

  function confirmReplace(){
    return !T.hasContent(doc) || window.confirm(CONFIRM_REPLACE);
  }

  function newScore(){
    if (!confirmReplace()) return;
    setStatus('');
    replaceDoc(T.createDoc());
  }

  function openImport(){
    $('tiImportText').value = '';
    var error = $('tiImportError');
    error.textContent = '';
    error.hidden = true;
    var dialog = $('tiImportDialog');
    if (!dialog.open) dialog.showModal();
    $('tiImportText').focus();
  }

  function applyImport(){
    var result = T.parseImportText($('tiImportText').value, doc);
    var error = $('tiImportError');
    if (result.error){
      error.textContent = result.error;
      error.hidden = false;
      return;
    }
    if (!confirmReplace()) return;
    error.textContent = '';
    error.hidden = true;
    replaceDoc(result.doc);
    $('tiImportDialog').close();
    setStatus('불러왔습니다 · ' + doc.measures.length + '마디');
  }

  // ---------- 결과 버튼

  async function copyScoreText(){
    var ok = await GuitarScorePrompt.copyText(T.docScoreText(doc));
    setResultStatus(ok ? '악보 텍스트를 복사했습니다.' : COPY_FAIL);
  }

  async function copyScoreTsv(){
    try {
      var tsv = formatSongToSheetTsv(doc.title.trim() || T.DEFAULT_TITLE, doc.beats, doc.bpm, doc.description.trim() || '악보 입력', T.docToScoreLines(doc));
      var ok = await GuitarScorePrompt.copyText(tsv);
      setResultStatus(ok ? '시트용 TSV 한 행을 복사했습니다. 시트의 빈 행 A열에 붙여 넣으세요.' : COPY_FAIL);
    } catch (error) {
      setResultStatus(error && error.message ? error.message : COPY_FAIL);
    }
  }

  function openPractice(){
    commitText();
    saveNow();
    var ok = ls.set(HANDOFF_KEY, T.buildHandoff(doc, Date.now(), openedSignature));
    if (ok) location.href = 'index.html';
    else setResultStatus('넘기지 못했습니다. 시트용 TSV로 복사해 연습 화면에서 불러오세요.');
  }

  // ---------- 연습 화면에서 넘어온 악보

  // 연습 화면이 gs.tabInput.open 에 쓴 값을 읽고 지운다. 없거나 10분이 지났거나 모양이 틀리면 null.
  function takeOpenRequest(){
    var request = ls.get(OPEN_KEY, null);
    if (request == null) return null;
    ls.remove(OPEN_KEY);
    if (typeof request !== 'object' || Array.isArray(request) || typeof request.savedAt !== 'number') return null;
    var age = Date.now() - request.savedAt;
    if (!isFinite(age) || age > OPEN_MAX_AGE_MS || age < -OPEN_MAX_FUTURE_MS) return null;
    return request;
  }

  function openFromPractice(){
    var request = takeOpenRequest();
    if (!request) return;
    var title = typeof request.title === 'string' && request.title.trim() ? request.title.trim() : T.DEFAULT_TITLE;
    var validLines = Array.isArray(request.lines) && request.lines.every(function(line){ return typeof line === 'string'; });
    var failure = '연습 화면에서 넘긴 "' + title + '"을 열지 못했습니다: ';
    if (!validLines){
      setStatus(failure + '넘긴 내용의 모양이 틀렸습니다.');
      return;
    }
    var result = T.scoreToDoc({
      title: title,
      beats: request.beats,
      bpm: Math.max(30, Math.min(240, Math.round(Number(request.bpm) || T.DEFAULT_BPM))),
      description: typeof request.badge === 'string' ? request.badge : '',
      raw: request.lines.join('\n')
    });
    if (result.error){
      setStatus(failure + result.error);
      return;
    }
    var next = result.doc;
    if (Number.isInteger(request.key) && request.key >= -5 && request.key <= 5) next.key = request.key;
    next.sourceId = typeof request.sourceId === 'string' ? request.sourceId : null;
    var differs = T.docScoreText(doc) !== T.docScoreText(next) || doc.sourceId !== next.sourceId;
    if (T.hasContent(doc) && differs &&
        !window.confirm('지금 작업을 "' + title + '"(으)로 바꾸시겠습니까? 되돌리기로 돌아올 수 있지만, TSV로 보관하지 않은 지금 작업은 새로고침하면 못 돌아옵니다.')){
      setStatus('연습 화면에서 넘긴 악보를 열지 않았습니다.');
      return;
    }
    var measure = Number.isInteger(request.measure) ? Math.max(0, Math.min(next.measures.length - 1, request.measure)) : 0;
    replaceDoc(next);
    openedSignature = T.handoffSignature(doc);
    setCursor({ m: measure, c: 0, s: 0, str: 1 }, true);
    setStatus('연습 화면에서 "' + title + '"을 열었습니다 · ' + (measure + 1) + '마디부터');
  }

  // ---------- 입력판 만들기

  function buildFretboard(){
    var board = $('tiFretboard');
    board.textContent = '';
    board.style.setProperty('--fret-cols', String(T.MAX_FRET + 1));
    fretButtons = [];
    board.appendChild(el('div', 'ti-fb-head'));
    for (var f = 0; f <= T.MAX_FRET; f++) board.appendChild(el('div', 'ti-fb-head', String(f)));
    for (var str = 1; str <= T.STRING_COUNT; str++){
      var row = el('div', 'ti-fb-row');
      row.dataset.str = String(str);
      row.appendChild(el('div', 'ti-fb-str', String(str)));
      for (var fret = 0; fret <= T.MAX_FRET; fret++){
        var btn = el('button', 'ti-fret');
        btn.type = 'button';
        btn.dataset.str = String(str);
        btn.dataset.fret = String(fret);
        btn.appendChild(document.createTextNode(''));
        row.appendChild(btn);
        fretButtons.push(btn);
      }
      board.appendChild(row);
    }
  }

  function buildBeatsOptions(){
    var select = $('tiBeats');
    N.SHEET_BEAT_COUNTS.forEach(function(count){
      var option = document.createElement('option');
      option.value = String(count);
      option.textContent = BEATS_LABELS[count] || (count + '칸');
      select.appendChild(option);
    });
  }

  // ---------- 이벤트

  function bindTextField(input, setField){
    input.addEventListener('focus', function(){ if (!textSnapshot) textSnapshot = T.cloneDoc(doc); });
    input.addEventListener('input', function(){
      if (!textSnapshot) textSnapshot = T.cloneDoc(doc);
      setField(input.value);
      scheduleSave();
      refreshResults();
    });
    input.addEventListener('change', commitText);
  }

  function bindInfo(){
    bindTextField($('tiTitle'), function(value){ doc.title = value; refreshCapoSelect(); });
    bindTextField($('tiDescription'), function(value){ doc.description = value; refreshCapoSelect(); });

    $('tiBpm').addEventListener('change', function(){
      var raw = $('tiBpm').value.trim();
      var value = Number(raw);
      if (!/^\d+$/.test(raw) || value < 30 || value > 240){
        $('tiBpm').value = String(doc.bpm);
        setStatus('BPM은 30에서 240 사이 정수여야 합니다.');
        return;
      }
      if (value === doc.bpm) return;
      apply(function(d){ d.bpm = value; return { ok: true }; });
    });

    $('tiBeats').addEventListener('change', function(){
      var value = Number($('tiBeats').value);
      if (value === doc.beats) return;
      var result = apply(function(d){ return T.setBeats(d, value); }, { all: true });
      if (result && result.lost > 0) setStatus(lostText(result.lost));
    });

    $('tiCapoSelect').addEventListener('change', function(){
      var value = Number($('tiCapoSelect').value);
      if (value === T.docCapo(doc)){
        refreshCapoSelect();
        return;
      }
      apply(function(d){
        var text = GuitarParser.setSongCapoText({ title: d.title, badge: d.description }, value);
        d.title = text.title;
        d.description = text.badge;
        return { ok: true };
      }, { measures: [] });
    });

    $('tiKeySelect').addEventListener('change', function(){
      var value = $('tiKeySelect').value;
      if (value === keyOptionValue()) return;
      apply(function(d){
        if (value === '0s' || value === '0f'){
          T.setKey(d, 0);
          d.accidentals = value === '0f' ? 'flat' : 'sharp';
        } else {
          T.setKey(d, Number(value));
        }
        return { ok: true };
      }, { all: true });
      refreshFretLabels();
    });

    $('tiNewBtn').addEventListener('click', newScore);
    $('tiImportBtn').addEventListener('click', openImport);
    $('tiUndoBtn').addEventListener('click', undo);
    $('tiRedoBtn').addEventListener('click', redo);

    $('tiImportApplyBtn').addEventListener('click', applyImport);
    $('tiImportCancelBtn').addEventListener('click', function(){ $('tiImportDialog').close(); });
  }

  function bindSelectionBar(){
    var map = { tiCopyBtn: 'copy', tiPasteBtn: 'paste', tiDuplicateBtn: 'duplicate', tiClearBtn: 'clear', tiDeleteBtn: 'delete', tiInsertBtn: 'insert', tiDeselectBtn: 'deselect' };
    Object.keys(map).forEach(function(id){
      $(id).addEventListener('click', function(){ selectionAction(map[id]); });
    });
    $('tiAddMeasureBtn').addEventListener('click', function(){
      apply(function(d){ return T.insertEmptyMeasure(d, d.measures.length); }, { all: true });
    });
  }

  function bindMeasures(){
    var box = $('tiMeasures');
    box.addEventListener('click', function(event){
      var target = event.target;
      var card = target.closest('.ti-measure');
      if (!card) return;
      var m = Number(card.dataset.m);
      // 텍스트 모드에서 카드는 미리보기다: 클릭은 커서만 옮기고 편집기 글자 커서를 그 마디 줄로 보낸다(선택 막대도 열지 않는다).
      var textMode = ui.inputMode === 'text';
      var num = target.closest('.ti-measure-num');
      if (num){
        if (textMode){ setCursor({ m: m, c: 0, s: 0 }, false); placeCaretAtCursorMeasure(false); }
        else selectMeasure(m, event.shiftKey);
        return;
      }
      var staffHead = target.closest('.st-head');
      if (staffHead){
        staffHeadClick(staffHead, m);
        if (textMode) placeCaretAtCursorMeasure(false);
        return;
      }
      var head = target.closest('.ti-cell-head');
      if (head){
        setCursor({ m: m, c: Number(head.dataset.c), s: 0 }, false);
        if (textMode) placeCaretAtCursorMeasure(false);
        return;
      }
      var posEl = target.closest('.ti-pos');
      if (posEl){
        var slotEl = posEl.closest('.ti-slot');
        var str = Number(posEl.dataset.str);
        var next = { m: m, c: Number(slotEl.dataset.c), s: Number(slotEl.dataset.s), str: str };
        setCursor(next, false);
        var note = T.getSlot(doc, next).notes[str - 1];
        if (note) playNotes([{ str: str, note: note }]);
        if (textMode) placeCaretAtCursorMeasure(false);
      }
    });
    box.addEventListener('contextmenu', function(event){
      if (ui.inputMode === 'text') return;   // 텍스트 모드에서는 카드로 문서를 고치지 않는다
      var posEl = event.target.closest('.ti-pos');
      if (!posEl) return;
      event.preventDefault();
      var slotEl = posEl.closest('.ti-slot');
      var next = { m: Number(slotEl.dataset.m), c: Number(slotEl.dataset.c), s: Number(slotEl.dataset.s), str: Number(posEl.dataset.str) };
      flushPending(false);
      setCursor(next, false);
      apply(function(d){ return T.removeNote(d, next, next.str); }, { measures: [next.m] });
    });

    box.addEventListener('input', function(event){
      var input = event.target;
      var card = input.closest && input.closest('.ti-measure');
      if (!card || !(input.classList.contains('ti-chord') || input.classList.contains('ti-memo'))) return;
      if (!textSnapshot) textSnapshot = T.cloneDoc(doc);
      var m = Number(card.dataset.m);
      if (input.classList.contains('ti-chord')) T.setMeasureChord(doc, m, input.value);
      else T.setMeasureMemo(doc, m, input.value);
      scheduleSave();
      refreshResults();
    });
    box.addEventListener('focusin', function(event){
      var input = event.target;
      if (input.classList && (input.classList.contains('ti-chord') || input.classList.contains('ti-memo')) && !textSnapshot){
        textSnapshot = T.cloneDoc(doc);
      }
    });
    box.addEventListener('change', function(event){
      var input = event.target;
      if (input.classList && (input.classList.contains('ti-chord') || input.classList.contains('ti-memo'))) commitText();
    });
  }

  function bindDock(){
    $('tiFretboard').addEventListener('click', function(event){
      var btn = event.target.closest('.ti-fret');
      if (!btn) return;
      inputFret(Number(btn.dataset.str), Number(btn.dataset.fret), 'toggle', false);
    });
    $('tiPrevBtn').addEventListener('click', function(){ moveCursor(-1); });
    $('tiNextBtn').addEventListener('click', function(){ moveCursor(1); });
    $('tiRestBtn').addEventListener('click', toggleRest);
    $('tiClearSlotBtn').addEventListener('click', clearSlotAtCursor);
    $('tiSkipBtn').addEventListener('click', toggleSkip);
    for (var d = 1; d <= 4; d++){
      (function(count){ $('tiDiv' + count).addEventListener('click', function(){ setDivision(count); }); })(d);
    }
    $('tiPlaySlotBtn').addEventListener('click', playSlot);
    $('tiAutoAdvance').addEventListener('click', function(){
      ui.autoAdvance = !ui.autoAdvance;
      saveUi();
      refreshCursorUI(false);
    });
    $('tiSoundToggle').addEventListener('click', function(){
      ui.sound = !ui.sound;
      saveUi();
      refreshCursorUI(false);
    });
    $('tiStaffToggle').addEventListener('click', function(){
      ui.staffOn = !ui.staffOn;
      saveUi();
      refreshStaff(T.docToScoreLines(doc));
      refreshCursorUI(false);
    });
    $('tiAttrsToggle').addEventListener('click', function(){
      ui.attrsOpen = !ui.attrsOpen;
      saveUi();
      refreshDock();
    });
    $('tiDockToggle').addEventListener('click', function(){
      ui.dockCollapsed = !ui.dockCollapsed;
      saveUi();
      refreshDock();
    });
    attrButtons = Array.prototype.slice.call($('tiAttrs').querySelectorAll('[data-attr]'));
    attrButtons.forEach(function(btn){
      if (btn.dataset.attr === 'art' && btn.dataset.value === 'h') btn.title = '자연 하모닉스(' + GuitarNotation.naturalHarmonicFretsText() + '프렛 음에서만)';
      btn.addEventListener('click', function(){
        if (btn.dataset.attr === 'art' && btn.dataset.value === 'h') toggleHarmonic(true);
        else if (btn.dataset.attr === 'art' && (btn.dataset.value === 's' || btn.dataset.value === 'g')) toggleLink(btn.dataset.value, true);
        else setAttr(btn.dataset.attr, btn.dataset.value);
      });
    });
    $('tiUncertainBtn').addEventListener('click', toggleUncertain);
    $('tiRollBtn').addEventListener('click', toggleRoll);

    $('tiCopyTextBtn').addEventListener('click', copyScoreText);
    $('tiCopyTsvBtn').addEventListener('click', copyScoreTsv);
    $('tiOpenPracticeBtn').addEventListener('click', openPractice);
    bindStaffDock();

    var dock = $('tiDock');
    function syncDockHeight(){
      document.documentElement.style.setProperty('--ti-dock-h', dock.offsetHeight + 'px');
    }
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncDockHeight).observe(dock);
    window.addEventListener('resize', syncDockHeight);
    syncDockHeight();
  }

  function isTextTarget(target){
    if (!target) return false;
    if (target.isContentEditable) return true;
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
  }

  function handleDigit(digit){
    var continuation = pending && digit <= 2 && Date.now() - pending.t <= TEN_WINDOW_MS &&
      samePos(pending, cursor) && pending.str === cursor.str;
    if (continuation){
      clearTimeout(pending.timer);
      pending = null;
      inputFret(cursor.str, 10 + digit, 'set', false);
      return;
    }
    flushPending(true);
    var defer = digit === 1 && ui.autoAdvance;
    inputFret(cursor.str, digit, 'set', defer);
    if (digit === 1){
      var p = { t: Date.now(), m: cursor.m, c: cursor.c, s: cursor.s, str: cursor.str, deferred: defer, timer: null };
      if (defer) p.timer = setTimeout(function(){ if (pending === p) flushPending(true); }, TEN_WINDOW_MS);
      pending = p;
    }
  }

  function onKeydown(event){
    if (isTextTarget(event.target) || $('tiImportDialog').open) return;
    var mod = event.ctrlKey || event.metaKey;
    if (event.altKey) return;
    if (mod){
      if (event.code === 'KeyZ'){
        event.preventDefault();
        flushPending(false);
        if (event.shiftKey) redo(); else undo();
      } else if (event.code === 'KeyY'){
        event.preventDefault();
        flushPending(false);
        redo();
      } else if (ui.inputMode === 'staff' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')){
        event.preventDefault();
        transposeSelected(event.key === 'ArrowUp' ? 12 : -12);
      }
      return;
    }
    if (ui.inputMode === 'text') return;   // 텍스트 모드에서 편집기 밖의 키는 문서를 고치지 않는다
    if (event.code === 'Minus'){   // 빈칸 켜고 끄기: 두 모드 공통, Shift(=_) 여부와 숫자패드 빼기는 구분하지 않거나 받지 않는다
      event.preventDefault();
      if (!event.repeat){
        flushPending(true);
        toggleSkip();
      }
      return;
    }
    if (ui.inputMode === 'staff' && onStaffKey(event)) return;
    var key = event.key;
    var isDigit = key.length === 1 && key >= '0' && key <= '9';
    if (isDigit){
      if (event.repeat) return;
      event.preventDefault();
      handleDigit(Number(key));
      return;
    }
    if (event.code === 'Space'){
      var tag = event.target && event.target.tagName;
      if (tag === 'BUTTON' || tag === 'A') return;
      event.preventDefault();
      flushPending(true);
      playSlot();
      return;
    }
    var handled = true;
    if (key === 'ArrowLeft'){ flushPending(true); moveCursor(-1); }
    else if (key === 'ArrowRight'){ flushPending(true); moveCursor(1); }
    else if (key === 'ArrowUp'){ flushPending(true); moveString(-1); }
    else if (key === 'ArrowDown'){ flushPending(true); moveString(1); }
    else if (key === 'Backspace' || key === 'Delete'){ flushPending(true); removeAtCursor(); }
    else if (event.code === 'KeyR'){
      if (event.repeat) return;
      flushPending(true);
      toggleRest();
    }
    else if (event.code === 'KeyH'){
      if (event.repeat) return;
      flushPending(true);
      toggleHarmonic(false);
    }
    else if (event.code === 'KeyS'){
      if (event.repeat) return;
      flushPending(true);
      toggleLink('s', false);
    }
    else if (event.code === 'Slash' && !event.shiftKey){
      if (event.repeat) return;
      flushPending(true);
      toggleLink('g', false);
    }
    else if (event.code === 'Backquote'){
      if (event.repeat) return;
      flushPending(true);
      toggleRoll();
    }
    else if (key === 'Escape'){ flushPending(true); clearSelection(); }
    else handled = false;
    if (handled) event.preventDefault();
  }

  function bindDocument(){
    document.addEventListener('keydown', onKeydown);
    // 마우스로 누른 버튼은 포커스를 놓아 Space가 그 버튼을 다시 누르지 않게 한다
    document.addEventListener('click', function(event){
      flushPending(false);
      if (event.detail > 0){
        var btn = event.target.closest && event.target.closest('button');
        if (btn) btn.blur();
      }
    }, true);
    // 숫자 글꼴이 늦게 뜨면 글자 폭이 바뀌니 칸 폭과 오선 위치를 다시 잰다
    if (document.fonts && document.fonts.addEventListener){
      document.fonts.addEventListener('loadingdone', function(){
        fitCellWidths();
        refreshStaff(T.docToScoreLines(doc));
        refreshCursorUI(false);
      });
    }
    window.addEventListener('pagehide', flushSave);
    window.addEventListener('beforeunload', flushSave);
  }

  // ---------- 시작

  function loadUi(){
    var stored = ls.get(UI_KEY, null);
    if (stored && typeof stored === 'object'){
      if (typeof stored.autoAdvance === 'boolean') ui.autoAdvance = stored.autoAdvance;
      if (typeof stored.sound === 'boolean') ui.sound = stored.sound;
      if (typeof stored.dockCollapsed === 'boolean') ui.dockCollapsed = stored.dockCollapsed;
      if (typeof stored.attrsOpen === 'boolean') ui.attrsOpen = stored.attrsOpen;
      if (typeof stored.staffOn === 'boolean') ui.staffOn = stored.staffOn;
      if (stored.inputMode === 'tab' || stored.inputMode === 'staff' || stored.inputMode === 'text') ui.inputMode = stored.inputMode;
      var dur = stored.staffDur;
      if (dur && typeof dur === 'object' && DUR_VALUES.indexOf(dur.value) >= 0){
        ui.staffDur = { value: dur.value, dotted: dur.dotted === true, triplet: dur.triplet === true };
      }
    }
  }

  function loadDoc(){
    var stored = ls.get(DOC_KEY, null);
    if (stored == null) return { doc: T.createDoc() };
    var result = T.normalizeDoc(stored);
    if (result.error) return { doc: T.createDoc(), notice: '저장된 작업을 읽지 못해 새 악보로 시작했습니다.' };
    return { doc: result.doc };
  }

  function init(){
    loadUi();
    var loaded = loadDoc();
    doc = loaded.doc;
    buildBeatsOptions();
    buildFretboard();
    bindInfo();
    bindSelectionBar();
    bindMeasures();
    bindDock();
    bindTextEditor();
    bindDocument();
    refreshDock();
    renderAll();
    loadTextDraft();
    if (ui.inputMode === 'text') enterTextMode(false);
    if (loaded.notice) setStatus(loaded.notice);
    openFromPractice();
  }

  init();
})();
