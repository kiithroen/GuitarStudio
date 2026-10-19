(function(){
  'use strict';
  // 악보 입력 화면(score-input.html)의 그리기·입력·저장. 모델은 src/tab-input.js, 설계와 결정은 Docs/tab-input.md.
  var T = window.GuitarTabInput;
  var N = window.GuitarNotation;
  var Staff = window.GuitarStaffLayout;
  var StaffSvg = window.GuitarStaffSvg;

  var DOC_KEY = 'gs.tabInput.doc';
  var UI_KEY = 'gs.tabInput.ui';
  var HANDOFF_KEY = 'gs.tabInput.handoff';
  var STRING_LETTERS = ['E', 'B', 'G', 'D', 'A', 'E'];
  var BEATS_LABELS = { 2: '2/4', 3: '3/4', 4: '4/4', 6: '6/8', 8: '4/4 (8박 핑거스타일)', 9: '9/8 (8분음표 9칸)' };
  var CELL_SLOT_MIN = 26;   // score-input.html의 .ti-cell 기본 조각 폭과 같다
  var CELL_SLOT_PAD = 6;
  var TEN_WINDOW_MS = 700;
  var SAVE_DEBOUNCE_MS = 300;
  var CONFIRM_REPLACE = '지금 작업을 지우고 바꿀까? 되돌리기로 돌아올 수 있어.';
  var COPY_FAIL = '복사하지 못했어. 결과 칸에서 직접 복사해.';

  var doc;
  var history = T.createHistory(T.MAX_HISTORY);
  var cursor = { m: 0, c: 0, s: 0, str: 1 };
  var sel = null;          // {a, b} 마디 선택(a <= b)
  var selAnchor = null;    // Shift 범위의 기준 마디
  var clip = null;         // 복사한 마디들
  var ui = { autoAdvance: false, sound: true, dockCollapsed: false, attrsOpen: false, staffOn: true };
  var textSnapshot = null; // 글자 칸 입력 전의 문서
  var saveTimer = null;
  var pending = null;      // 방금 누른 숫자 1: {t, m, c, s, str, timer}
  var staffLayout = null;  // 지금 오선 배치(layoutScore 결과). 오류거나 오선을 끄면 null
  var fretButtons = [];
  var attrButtons = [];

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
  function lostText(count){ return '조각 ' + count + '개가 지워졌어. 되돌리기로 돌아올 수 있어.'; }

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
      status.textContent = '이 기기에 저장하지 못했어. 시트용 TSV로 복사해 둬.';
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

  function articulationName(art){ return art === '!' ? 'apoyando' : (art === '~' ? 'tirando' : null); }

  function playNotes(items){
    if (!ui.sound || !items.length) return;
    try {
      var capo = T.docCapo(doc);
      items.forEach(function(item){
        playGuitarNote(soundingMidi(T.noteMidi(item.str, item.note.fret), capo), 1.6, null, null, articulationName(item.note.art), item.str);
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

  function commitText(){
    if (!textSnapshot) return;
    var snapshot = textSnapshot;
    textSnapshot = null;
    if (JSON.stringify(snapshot) !== JSON.stringify(doc)){
      history.record(snapshot);
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
    history.record(before);
    if (o.onDone) o.onDone(result);
    var all = o.all || doc.measures.length !== before.measures.length;
    clampCursor();
    clampSelection();
    saveNow();
    if (all) renderMeasures();
    else (o.measures || []).forEach(rebuildCard);
    refreshAfterEdit();
    return result || { ok: true };
  }

  function replaceDoc(next){
    commitText();
    history.record(doc);
    doc = next;
    cursor = { m: 0, c: 0, s: 0, str: 1 };
    sel = null;
    selAnchor = null;
    saveNow();
    renderAll();
  }

  function undo(){
    commitText();
    var prev = history.undo(doc);
    if (!prev) return;
    setStatus('');
    doc = prev;
    afterHistory();
  }

  function redo(){
    commitText();
    var next = history.redo(doc);
    if (!next) return;
    setStatus('');
    doc = next;
    afterHistory();
  }

  function afterHistory(){
    clampCursor();
    clampSelection();
    saveNow();
    renderAll();
  }

  // ---------- 그리기: 마디 카드

  function noteTitle(str, note){
    var parts = [str + '번 줄 ' + note.fret + '프렛 · ' + T.noteLabel(doc, str, note.fret)];
    if (note.lh != null) parts.push('왼손 ' + note.lh);
    if (note.rh) parts.push('오른손 ' + note.rh);
    if (note.art) parts.push(note.art === '!' ? '아포얀도' : '티란도');
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
    // 프렛 글자 모양은 연습 화면과 같은 buildFretLabel 이 만든다. 주법은 기호 대신 글자 색(아포얀도 주황 굵게, 티란도 회색).
    var label = buildFretLabel({ fret: note.fret, lh: note.lh, rh: note.rh, art: articulationName(note.art) });
    label.classList.add('ti-pos-label');
    pos.appendChild(label);
    return pos;
  }

  function buildSlot(m, c, s, slot){
    var slotEl = el('div', 'ti-slot');
    slotEl.dataset.m = String(m);
    slotEl.dataset.c = String(c);
    slotEl.dataset.s = String(s);
    if (slot.rest){
      slotEl.classList.add('is-rest');
      slotEl.dataset.rest = slot.restUncertain ? 'r?' : 'r';
      if (slot.restUncertain) slotEl.classList.add('is-uncertain');
    }
    for (var str = 1; str <= T.STRING_COUNT; str++) slotEl.appendChild(buildPos(str, slot.notes[str - 1]));
    return slotEl;
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
      cellEl.style.setProperty('--d', String(d));
      var cellHead = el('div', 'ti-cell-head', String(c + 1) + (d >= 2 ? ' ÷' + d : ''));
      cellHead.dataset.c = String(c);
      cellEl.appendChild(cellHead);
      var slotsEl = el('div', 'ti-slots');
      cell.slots.forEach(function(slot, s){ slotsEl.appendChild(buildSlot(m, c, s, slot)); });
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

  function refreshCapoInfo(){
    var capo = T.docCapo(doc);
    var badge = $('tiCapoInfo');
    badge.hidden = capo === 0;
    badge.textContent = capo === 0 ? '' : '카포 ' + capo;
  }

  function refreshInfo(){
    setValue($('tiTitle'), doc.title);
    setValue($('tiBeats'), doc.beats);
    setValue($('tiBpm'), doc.bpm);
    setValue($('tiDescription'), doc.description);
    setValue($('tiKeySelect'), keyOptionValue());
    refreshCapoInfo();
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
      if (scroll && slotEl.scrollIntoView) slotEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    placeStaffCursor(slotEl);

    var slot = T.getSlot(doc, cursor);
    var division = doc.measures[cursor.m].cells[cursor.c].slots.length;
    var label = (cursor.m + 1) + '마디 · ' + (cursor.c + 1) + '칸';
    if (division > 1) label += ' · 조각 ' + (cursor.s + 1) + '/' + division;
    label += ' · ' + cursor.str + '번 줄';
    $('tiCursorLabel').textContent = label;
    $('tiPrevBtn').disabled = !T.prevPos(doc, cursor);
    $('tiNextBtn').disabled = !T.nextPos(doc, cursor);
    $('tiRestBtn').setAttribute('aria-pressed', String(!!slot.rest));
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
      btn.setAttribute('aria-pressed', String(cursorNote != null && current === btn.dataset.value));
    });
    var uncertain = $('tiUncertainBtn');
    uncertain.disabled = !(cursorNote || slot.rest);
    uncertain.setAttribute('aria-pressed', String(cursorNote ? cursorNote.uncertain : (slot.rest ? slot.restUncertain : false)));
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
      var labels = cells[i].querySelectorAll('.ti-pos-label');
      for (var j = 0; j < labels.length; j++){
        var range = document.createRange();
        range.selectNodeContents(labels[j]);
        max = Math.max(max, range.getBoundingClientRect().width);
      }
      widths.push(Math.max(CELL_SLOT_MIN, Math.ceil(max + CELL_SLOT_PAD)));
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
    refreshCursorUI(scroll);
  }

  function moveCursor(direction){
    var p = direction > 0 ? T.nextPos(doc, cursor) : T.prevPos(doc, cursor);
    if (p) setCursor(p, true);
  }

  function moveString(delta){
    cursor.str = Math.max(1, Math.min(T.STRING_COUNT, cursor.str + delta));
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

  function playSlot(){ playNotes(slotNotes(cursor)); }

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
        setStatus(clip.length + '마디를 복사했어.');
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
    setStatus('불러왔어 · ' + doc.measures.length + '마디');
  }

  // ---------- 결과 버튼

  async function copyScoreText(){
    var ok = await GuitarScorePrompt.copyText(T.docScoreText(doc));
    setResultStatus(ok ? '악보 텍스트를 복사했어.' : COPY_FAIL);
  }

  async function copyScoreTsv(){
    try {
      var tsv = formatSongToSheetTsv(doc.title.trim() || T.DEFAULT_TITLE, doc.beats, doc.bpm, doc.description.trim() || '악보 입력', T.docToScoreLines(doc));
      var ok = await GuitarScorePrompt.copyText(tsv);
      setResultStatus(ok ? '시트용 TSV 한 행을 복사했어. 시트의 빈 행 A열에 붙여 넣어.' : COPY_FAIL);
    } catch (error) {
      setResultStatus(error && error.message ? error.message : COPY_FAIL);
    }
  }

  function openPractice(){
    commitText();
    saveNow();
    var ok = ls.set(HANDOFF_KEY, T.buildHandoff(doc, Date.now()));
    if (ok) location.href = 'index.html';
    else setResultStatus('넘기지 못했어. 시트용 TSV로 복사해 연습 화면에서 불러와.');
  }

  // ---------- 입력판 만들기

  function buildFretboard(){
    var board = $('tiFretboard');
    board.textContent = '';
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
    bindTextField($('tiTitle'), function(value){ doc.title = value; refreshCapoInfo(); });
    bindTextField($('tiDescription'), function(value){ doc.description = value; refreshCapoInfo(); });

    $('tiBpm').addEventListener('change', function(){
      var raw = $('tiBpm').value.trim();
      var value = Number(raw);
      if (!/^\d+$/.test(raw) || value < 30 || value > 240){
        $('tiBpm').value = String(doc.bpm);
        setStatus('BPM은 30에서 240 사이 정수여야 해.');
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
      var num = target.closest('.ti-measure-num');
      if (num){ selectMeasure(m, event.shiftKey); return; }
      var staffHead = target.closest('.st-head');
      if (staffHead){ staffHeadClick(staffHead, m); return; }
      var head = target.closest('.ti-cell-head');
      if (head){ setCursor({ m: m, c: Number(head.dataset.c), s: 0 }, false); return; }
      var posEl = target.closest('.ti-pos');
      if (posEl){
        var slotEl = posEl.closest('.ti-slot');
        var str = Number(posEl.dataset.str);
        var next = { m: m, c: Number(slotEl.dataset.c), s: Number(slotEl.dataset.s), str: str };
        setCursor(next, false);
        var note = T.getSlot(doc, next).notes[str - 1];
        if (note) playNotes([{ str: str, note: note }]);
      }
    });
    box.addEventListener('contextmenu', function(event){
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
      btn.addEventListener('click', function(){ setAttr(btn.dataset.attr, btn.dataset.value); });
    });
    $('tiUncertainBtn').addEventListener('click', toggleUncertain);

    $('tiCopyTextBtn').addEventListener('click', copyScoreText);
    $('tiCopyTsvBtn').addEventListener('click', copyScoreTsv);
    $('tiOpenPracticeBtn').addEventListener('click', openPractice);

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
      }
      return;
    }
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
    }
  }

  function loadDoc(){
    var stored = ls.get(DOC_KEY, null);
    if (stored == null) return { doc: T.createDoc() };
    var result = T.normalizeDoc(stored);
    if (result.error) return { doc: T.createDoc(), notice: '저장된 작업을 읽지 못해 새 악보로 시작했어.' };
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
    bindDocument();
    refreshDock();
    renderAll();
    if (loaded.notice) setStatus(loaded.notice);
  }

  init();
})();
