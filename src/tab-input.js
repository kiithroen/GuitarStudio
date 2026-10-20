(function(global){
  'use strict';
  // 타브 입력 화면의 DOM 없는 모델: 문서 모양, 편집 연산, 되돌리기 기록, 텍스트 악보 변환과 불러오기.
  // 설계와 결정은 Docs/tab-input.md.
  var isNode = typeof module !== 'undefined' && module.exports;
  var GuitarNotation = isNode ? require('./notation.js') : global.GuitarNotation;
  var GuitarParser = isNode ? require('./parser.js') : global.GuitarParser;

  var STRING_COUNT = 6;
  var MAX_FRET = GuitarNotation.MAX_FRET;
  var DEFAULT_TITLE = '새 악보';
  var DEFAULT_BPM = 64;
  var MAX_HISTORY = 200;
  var BPM_MIN = 30;
  var BPM_MAX = 240;
  var MAX_DIVISION = 4;
  var KEY_MIN = -5;
  var KEY_MAX = 5;
  var RH_VALUES = ['p', 'i', 'm', 'a'];
  var ART_VALUES = ['!', 'h'];
  // 티란도 표시 ~ 를 없애기 전에 저장된 문서의 주법 값. 읽을 때 없음(null)으로 바꾼다.
  var REMOVED_ART_VALUE = '~';

  function isInt(value){ return typeof value === 'number' && Number.isInteger(value); }
  function isHarmonicFret(fret){ return Object.prototype.hasOwnProperty.call(GuitarNotation.NATURAL_HARMONICS, fret); }
  function beatsListText(){ return GuitarNotation.SHEET_BEAT_COUNTS.join(', '); }
  function isAllowedBeats(beats){ return GuitarNotation.SHEET_BEAT_COUNTS.indexOf(beats) >= 0; }
  function copyJson(value){ return JSON.parse(JSON.stringify(value)); }

  // ---------- 만들기

  function createSlot(){
    return { rest: false, restUncertain: false, notes: [null, null, null, null, null, null] };
  }

  function createCell(division){
    var count = division == null ? 1 : division;
    if (!isInt(count) || count < 1 || count > MAX_DIVISION) throw new Error('칸을 나눌 수는 1~' + MAX_DIVISION + '이어야 합니다: ' + division);
    var slots = [];
    for (var i = 0; i < count; i++) slots.push(createSlot());
    return { slots: slots };
  }

  function createMeasure(beats){
    if (!isAllowedBeats(beats)) throw new Error('칸 수는 ' + beatsListText() + ' 중 하나여야 합니다: ' + beats);
    var cells = [];
    for (var i = 0; i < beats; i++) cells.push(createCell(1));
    return { chord: '', memo: '', cells: cells };
  }

  function createDoc(options){
    var o = options || {};
    var beats = o.beats == null ? 4 : o.beats;
    return {
      version: 1,
      title: o.title == null ? DEFAULT_TITLE : o.title,
      beats: beats,
      bpm: o.bpm == null ? DEFAULT_BPM : o.bpm,
      description: o.description == null ? '' : o.description,
      accidentals: o.accidentals == null ? 'sharp' : o.accidentals,
      key: o.key == null ? 0 : o.key,
      sourceId: o.sourceId == null ? null : o.sourceId,
      measures: [createMeasure(beats)]
    };
  }

  function cloneDoc(doc){ return copyJson(doc); }

  // ---------- 검사

  function validateNoteShape(note, where){
    if (note === null) return null;
    if (!note || typeof note !== 'object') return where + ': 음이 올바르지 않습니다.';
    if (!isInt(note.fret) || note.fret < 0 || note.fret > MAX_FRET) return where + ': 프렛은 0~' + MAX_FRET + '의 정수여야 합니다.';
    if (note.lh !== null && !(isInt(note.lh) && note.lh >= 0 && note.lh <= 4)) return where + ': 왼손 운지는 없음 또는 0~4여야 합니다.';
    if (note.rh !== null && RH_VALUES.indexOf(note.rh) < 0) return where + ': 오른손 운지는 없음 또는 p·i·m·a여야 합니다.';
    if (note.art !== null && ART_VALUES.indexOf(note.art) < 0) return where + ': 주법은 없음, ! 또는 h여야 합니다.';
    if (note.art === 'h' && !isHarmonicFret(note.fret)) return where + ': 하모닉스 프렛은 ' + GuitarNotation.naturalHarmonicFretsText() + ' 중 하나여야 합니다.';
    if (typeof note.uncertain !== 'boolean') return where + ': 확인 표시는 true/false여야 합니다.';
    return null;
  }

  function isValidKey(key){ return isInt(key) && key >= KEY_MIN && key <= KEY_MAX; }

  function normalizeDoc(raw){
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '문서가 객체가 아닙니다.' };
    if (raw.version !== 1) return { error: '지원하지 않는 문서 버전입니다: ' + raw.version };
    if (!isInt(raw.beats) || !isAllowedBeats(raw.beats)) return { error: '칸 수는 ' + beatsListText() + ' 중 하나여야 합니다: ' + raw.beats };
    if (!isInt(raw.bpm) || raw.bpm < BPM_MIN || raw.bpm > BPM_MAX) return { error: 'BPM은 ' + BPM_MIN + '~' + BPM_MAX + '의 정수여야 합니다: ' + raw.bpm };
    if (typeof raw.title !== 'string') return { error: '제목이 문자열이 아닙니다.' };
    if (typeof raw.description !== 'string') return { error: '설명이 문자열이 아닙니다.' };
    if (raw.accidentals !== 'sharp' && raw.accidentals !== 'flat') return { error: '변화표는 sharp 또는 flat이어야 합니다: ' + raw.accidentals };
    if (raw.key !== undefined && !isValidKey(raw.key)) return { error: '조표는 ' + KEY_MIN + '~' + KEY_MAX + '의 정수여야 합니다: ' + raw.key };
    if (raw.sourceId !== undefined && raw.sourceId !== null && typeof raw.sourceId !== 'string') return { error: '원래 곡 id는 문자열이거나 null이어야 합니다: ' + raw.sourceId };
    if (!Array.isArray(raw.measures) || !raw.measures.length) return { error: '마디가 하나 이상 있어야 합니다.' };
    for (var m = 0; m < raw.measures.length; m++){
      var measure = raw.measures[m];
      var mWhere = '마디 ' + (m + 1);
      if (!measure || typeof measure !== 'object') return { error: mWhere + ': 마디가 올바르지 않습니다.' };
      if (typeof measure.chord !== 'string') return { error: mWhere + ': 코드가 문자열이 아닙니다.' };
      if (typeof measure.memo !== 'string') return { error: mWhere + ': 메모가 문자열이 아닙니다.' };
      if (!Array.isArray(measure.cells) || measure.cells.length !== raw.beats) return { error: mWhere + ': 칸 수가 ' + raw.beats + '개여야 합니다.' };
      for (var c = 0; c < measure.cells.length; c++){
        var cell = measure.cells[c];
        var cWhere = mWhere + ', 칸 ' + (c + 1);
        if (!cell || !Array.isArray(cell.slots) || cell.slots.length < 1 || cell.slots.length > MAX_DIVISION){
          return { error: cWhere + ': 나눈 수는 1~' + MAX_DIVISION + '이어야 합니다.' };
        }
        for (var s = 0; s < cell.slots.length; s++){
          var slot = cell.slots[s];
          var sWhere = cWhere + ', 조각 ' + (s + 1);
          if (!slot || typeof slot !== 'object') return { error: sWhere + ': 조각이 올바르지 않습니다.' };
          if (typeof slot.rest !== 'boolean' || typeof slot.restUncertain !== 'boolean') return { error: sWhere + ': 쉼 표시는 true/false여야 합니다.' };
          if (!Array.isArray(slot.notes) || slot.notes.length !== STRING_COUNT) return { error: sWhere + ': 음 목록은 ' + STRING_COUNT + '개여야 합니다.' };
          var hasNote = false;
          for (var n = 0; n < slot.notes.length; n++){
            var shapeNote = slot.notes[n];
            if (shapeNote && shapeNote.art === REMOVED_ART_VALUE) shapeNote = Object.assign({}, shapeNote, { art: null });
            var noteError = validateNoteShape(shapeNote, sWhere + ', ' + (n + 1) + '번 줄');
            if (noteError) return { error: noteError };
            if (slot.notes[n] !== null) hasNote = true;
          }
          if (slot.rest && hasNote) return { error: sWhere + ': 쉼인데 음이 있습니다.' };
        }
      }
    }
    var doc = cloneDoc(raw);
    if (doc.key === undefined) doc.key = 0;
    if (doc.sourceId === undefined) doc.sourceId = null;
    doc.measures.forEach(function(measure){
      measure.cells.forEach(function(cell){
        cell.slots.forEach(function(slot){
          slot.notes.forEach(function(note){ if (note && note.art === REMOVED_ART_VALUE) note.art = null; });
        });
      });
    });
    return { doc: doc };
  }

  function slotHasContent(slot){
    if (slot.rest) return true;
    for (var i = 0; i < slot.notes.length; i++) if (slot.notes[i]) return true;
    return false;
  }

  function hasContent(doc){
    if (doc.measures.length >= 2) return true;
    return doc.measures.some(function(measure){
      if (String(measure.chord).trim() || String(measure.memo).trim()) return true;
      return measure.cells.some(function(cell){ return cell.slots.some(slotHasContent); });
    });
  }

  // ---------- 위치

  function firstPos(){ return { m: 0, c: 0, s: 0 }; }

  function isValidPos(doc, pos){
    if (!pos || !isInt(pos.m) || !isInt(pos.c) || !isInt(pos.s)) return false;
    var measure = doc.measures[pos.m];
    if (!measure) return false;
    var cell = measure.cells[pos.c];
    if (!cell) return false;
    return pos.s >= 0 && pos.s < cell.slots.length && pos.m >= 0 && pos.c >= 0;
  }

  function getSlot(doc, pos){
    return isValidPos(doc, pos) ? doc.measures[pos.m].cells[pos.c].slots[pos.s] : null;
  }

  function nextPos(doc, pos){
    if (!isValidPos(doc, pos)) return null;
    var measure = doc.measures[pos.m];
    var cell = measure.cells[pos.c];
    if (pos.s + 1 < cell.slots.length) return { m: pos.m, c: pos.c, s: pos.s + 1 };
    if (pos.c + 1 < measure.cells.length) return { m: pos.m, c: pos.c + 1, s: 0 };
    if (pos.m + 1 < doc.measures.length) return { m: pos.m + 1, c: 0, s: 0 };
    return null;
  }

  function prevPos(doc, pos){
    if (!isValidPos(doc, pos)) return null;
    if (pos.s > 0) return { m: pos.m, c: pos.c, s: pos.s - 1 };
    if (pos.c > 0){
      var prevCell = doc.measures[pos.m].cells[pos.c - 1];
      return { m: pos.m, c: pos.c - 1, s: prevCell.slots.length - 1 };
    }
    if (pos.m > 0){
      var prevMeasure = doc.measures[pos.m - 1];
      var lastCell = prevMeasure.cells[prevMeasure.cells.length - 1];
      return { m: pos.m - 1, c: prevMeasure.cells.length - 1, s: lastCell.slots.length - 1 };
    }
    return null;
  }

  function clampInt(value, min, max){
    var n = isInt(value) ? value : (Number.isFinite(value) ? Math.round(value) : min);
    return Math.max(min, Math.min(max, n));
  }

  function clampPos(doc, pos){
    var p = pos || {};
    var m = clampInt(p.m, 0, doc.measures.length - 1);
    var cells = doc.measures[m].cells;
    var c = clampInt(p.c, 0, cells.length - 1);
    var s = clampInt(p.s, 0, cells[c].slots.length - 1);
    return { m: m, c: c, s: s };
  }

  // ---------- 편집

  function requireSlot(doc, pos){
    var slot = getSlot(doc, pos);
    if (!slot) throw new Error('올바르지 않은 위치입니다: ' + JSON.stringify(pos));
    return slot;
  }

  function requireStr(str){
    if (!isInt(str) || str < 1 || str > STRING_COUNT) throw new Error('줄은 1~' + STRING_COUNT + '이어야 합니다: ' + str);
  }

  function requireFret(fret){
    if (!isInt(fret) || fret < 0 || fret > MAX_FRET) throw new Error('프렛은 0~' + MAX_FRET + '이어야 합니다: ' + fret);
  }

  function setNote(doc, pos, str, fret){
    var slot = requireSlot(doc, pos);
    requireStr(str);
    requireFret(fret);
    slot.notes[str - 1] = { fret: fret, lh: null, rh: null, art: null, uncertain: false };
    slot.rest = false;
    slot.restUncertain = false;
    return { ok: true };
  }

  function removeNote(doc, pos, str){
    var slot = requireSlot(doc, pos);
    requireStr(str);
    if (!slot.notes[str - 1]) return { ok: false };
    slot.notes[str - 1] = null;
    return { ok: true };
  }

  function toggleNote(doc, pos, str, fret){
    var slot = requireSlot(doc, pos);
    requireStr(str);
    requireFret(fret);
    var existing = slot.notes[str - 1];
    if (existing && existing.fret === fret){
      slot.notes[str - 1] = null;
      return { ok: true, action: 'removed' };
    }
    setNote(doc, pos, str, fret);
    return { ok: true, action: 'set' };
  }

  function setNoteAttrs(doc, pos, str, attrs){
    var slot = requireSlot(doc, pos);
    requireStr(str);
    var a = attrs || {};
    if ('lh' in a && !(a.lh === null || (isInt(a.lh) && a.lh >= 0 && a.lh <= 4))) throw new Error('왼손 운지는 null 또는 0~4여야 합니다: ' + a.lh);
    if ('rh' in a && !(a.rh === null || RH_VALUES.indexOf(a.rh) >= 0)) throw new Error('오른손 운지는 null 또는 p·i·m·a여야 합니다: ' + a.rh);
    if ('art' in a && !(a.art === null || ART_VALUES.indexOf(a.art) >= 0)) throw new Error('주법은 null, ! 또는 h여야 합니다: ' + a.art);
    if ('uncertain' in a && typeof a.uncertain !== 'boolean') throw new Error('확인 표시는 true/false여야 합니다: ' + a.uncertain);
    var note = slot.notes[str - 1];
    if (!note) return { ok: false };
    if (a.art === 'h' && !isHarmonicFret(note.fret)) throw new Error('하모닉스 프렛은 ' + GuitarNotation.naturalHarmonicFretsText() + ' 중 하나여야 합니다: ' + note.fret);
    ['lh', 'rh', 'art', 'uncertain'].forEach(function(key){ if (key in a) note[key] = a[key]; });
    return { ok: true };
  }

  function setRest(doc, pos, on){
    var slot = requireSlot(doc, pos);
    if (!on){
      slot.rest = false;
      slot.restUncertain = false;
      return { ok: true, removedNotes: 0 };
    }
    var removed = 0;
    for (var i = 0; i < slot.notes.length; i++){
      if (slot.notes[i]){ removed++; slot.notes[i] = null; }
    }
    slot.rest = true;
    return { ok: true, removedNotes: removed };
  }

  function setRestUncertain(doc, pos, on){
    var slot = requireSlot(doc, pos);
    if (!slot.rest) return { ok: false };
    slot.restUncertain = !!on;
    return { ok: true };
  }

  function clearSlot(doc, pos){
    var slot = requireSlot(doc, pos);
    for (var i = 0; i < slot.notes.length; i++) slot.notes[i] = null;
    slot.rest = false;
    slot.restUncertain = false;
    return { ok: true };
  }

  function setDivision(doc, m, c, division){
    var measure = doc.measures[m];
    var cell = measure && measure.cells[c];
    if (!cell) throw new Error('올바르지 않은 칸입니다: 마디 ' + m + ', 칸 ' + c);
    if (!isInt(division) || division < 1 || division > MAX_DIVISION) throw new Error('칸을 나눌 수는 1~' + MAX_DIVISION + '이어야 합니다: ' + division);
    var oldSlots = cell.slots;
    var d = oldSlots.length;
    var next = createCell(division).slots;
    var lost = 0;
    oldSlots.forEach(function(slot, i){
      var j = i * division / d;
      if (Number.isInteger(j)) next[j] = slot;
      else if (slotHasContent(slot)) lost++;
    });
    cell.slots = next;
    return { ok: true, lost: lost };
  }

  function cellContentCount(cell){
    return cell.slots.filter(slotHasContent).length;
  }

  function setKey(doc, key){
    if (!isValidKey(key)) throw new Error('조표는 ' + KEY_MIN + '~' + KEY_MAX + '의 정수여야 합니다: ' + key);
    doc.key = key;
    return { ok: true };
  }

  function setBeats(doc, beats){
    if (!isAllowedBeats(beats)) throw new Error('칸 수는 ' + beatsListText() + ' 중 하나여야 합니다: ' + beats);
    var lost = 0;
    doc.measures.forEach(function(measure){
      if (measure.cells.length > beats){
        measure.cells.slice(beats).forEach(function(cell){ lost += cellContentCount(cell); });
        measure.cells = measure.cells.slice(0, beats);
      }
      while (measure.cells.length < beats) measure.cells.push(createCell(1));
    });
    doc.beats = beats;
    return { ok: true, lost: lost };
  }

  function setMeasureChord(doc, m, text){
    if (!doc.measures[m]) throw new Error('올바르지 않은 마디입니다: ' + m);
    if (typeof text !== 'string') throw new Error('코드는 문자열이어야 합니다.');
    doc.measures[m].chord = text;
    return { ok: true };
  }

  function setMeasureMemo(doc, m, text){
    if (!doc.measures[m]) throw new Error('올바르지 않은 마디입니다: ' + m);
    if (typeof text !== 'string') throw new Error('메모는 문자열이어야 합니다.');
    doc.measures[m].memo = text;
    return { ok: true };
  }

  function requireRange(doc, a, b){
    if (!isInt(a) || !isInt(b) || a < 0 || b < a || b >= doc.measures.length){
      throw new Error('올바르지 않은 마디 범위입니다: ' + a + '~' + b);
    }
  }

  function insertEmptyMeasure(doc, index){
    if (!isInt(index) || index < 0 || index > doc.measures.length) throw new Error('올바르지 않은 마디 위치입니다: ' + index);
    doc.measures.splice(index, 0, createMeasure(doc.beats));
    return { ok: true };
  }

  function copyRange(doc, a, b){
    requireRange(doc, a, b);
    return copyJson(doc.measures.slice(a, b + 1));
  }

  function duplicateRange(doc, a, b){
    var copies = copyRange(doc, a, b);
    Array.prototype.splice.apply(doc.measures, [b + 1, 0].concat(copies));
    return { ok: true, inserted: copies.length };
  }

  function deleteRange(doc, a, b){
    requireRange(doc, a, b);
    var count = b - a + 1;
    if (count >= doc.measures.length) return { ok: false };
    doc.measures.splice(a, count);
    return { ok: true, removed: count };
  }

  function clearRange(doc, a, b){
    requireRange(doc, a, b);
    for (var i = a; i <= b; i++) doc.measures[i] = createMeasure(doc.beats);
    return { ok: true };
  }

  function pasteAfter(doc, index, measures){
    if (!isInt(index) || index < -1 || index >= doc.measures.length) throw new Error('올바르지 않은 붙여넣기 위치입니다: ' + index);
    if (!Array.isArray(measures)) throw new Error('붙여넣을 마디 목록이 없습니다.');
    var lost = 0;
    var adapted = copyJson(measures).map(function(measure){
      if (!measure || !Array.isArray(measure.cells)) throw new Error('붙여넣을 마디가 올바르지 않습니다.');
      if (measure.cells.length > doc.beats){
        measure.cells.slice(doc.beats).forEach(function(cell){ lost += cellContentCount(cell); });
        measure.cells = measure.cells.slice(0, doc.beats);
      }
      while (measure.cells.length < doc.beats) measure.cells.push(createCell(1));
      return measure;
    });
    Array.prototype.splice.apply(doc.measures, [index + 1, 0].concat(adapted));
    return { ok: true, inserted: adapted.length, lost: lost };
  }

  // ---------- 되돌리기

  function createHistory(limit){
    var max = isInt(limit) && limit > 0 ? limit : MAX_HISTORY;
    var undoStack = [];
    var redoStack = [];
    function pushLimited(stack, json){
      stack.push(json);
      while (stack.length > max) stack.shift();
    }
    return {
      record: function(doc){
        pushLimited(undoStack, JSON.stringify(doc));
        redoStack.length = 0;
      },
      undo: function(current){
        if (!undoStack.length) return null;
        pushLimited(redoStack, JSON.stringify(current));
        return JSON.parse(undoStack.pop());
      },
      redo: function(current){
        if (!redoStack.length) return null;
        pushLimited(undoStack, JSON.stringify(current));
        return JSON.parse(redoStack.pop());
      },
      canUndo: function(){ return undoStack.length > 0; },
      canRedo: function(){ return redoStack.length > 0; },
      clear: function(){ undoStack.length = 0; redoStack.length = 0; }
    };
  }

  // ---------- 텍스트 악보로 바꾸기

  function noteMidi(str, fret){
    return GuitarParser.STRINGS[str - 1].midi + fret;
  }

  // 울리는 음의 MIDI. 하모닉스(art 'h')는 fret이 손 대는 프렛이라 개방현 + 표의 반음 수다.
  function noteMidiOf(str, note){
    if (note.art === 'h') return GuitarParser.STRINGS[str - 1].midi + GuitarNotation.NATURAL_HARMONICS[note.fret];
    return noteMidi(str, note.fret);
  }

  function midiLabel(doc, midi){
    var key = isInt(doc.key) ? doc.key : 0;
    var preferFlats = key < 0 || (key === 0 && doc.accidentals === 'flat');
    return GuitarParser.noteNameForMidi(midi, preferFlats);
  }

  function noteLabel(doc, str, fret){
    return midiLabel(doc, noteMidi(str, fret));
  }

  // 울리는 음의 이름(하모닉스는 손 대는 자리가 아니라 울리는 음).
  function noteLabelOf(doc, str, note){
    return midiLabel(doc, noteMidiOf(str, note));
  }

  function noteToken(doc, str, note){
    return (note.art || '') + (note.lh == null ? '' : String(note.lh)) +
      noteLabelOf(doc, str, note) + '@' + str +
      (note.rh ? ':' + note.rh : '') + (note.uncertain ? '?' : '');
  }

  function slotNoteToken(doc, slot){
    var items = [];
    slot.notes.forEach(function(note, index){
      if (note) items.push({ str: index + 1, midi: noteMidiOf(index + 1, note), note: note });
    });
    items.sort(function(a, b){ return a.midi - b.midi || b.str - a.str; });
    return items.map(function(item){ return noteToken(doc, item.str, item.note); }).join('+');
  }

  function isHoldingToken(tokens, i){
    var token = tokens[i];
    if (token === '-') return true;
    return token === 'r' && (tokens[i - 1] === 'r' || tokens[i - 1] === 'r?');
  }

  // 줄여도 같은 소리일 때만 줄인다(Docs/tab-input.md 변환 규칙 4).
  function reduceCellTokens(tokens){
    var d = tokens.length;
    if (d === 1) return tokens;
    var holds = [false];
    var all = true;
    for (var i = 1; i < d; i++){
      holds.push(isHoldingToken(tokens, i));
      if (!holds[i]) all = false;
    }
    if (all) return [tokens[0]];
    if (d === 4 && holds[1] && holds[3]) return [tokens[0], tokens[2]];
    return tokens;
  }

  // 마디마다, 칸마다, 조각마다 토큰 문자열 [m][c][s]. 빈 조각은 앞에 울리는 음이 있으면 '-', 아니면 'r'.
  function slotTokens(doc){
    var sounding = false;
    return doc.measures.map(function(measure){
      return measure.cells.map(function(cell){
        return cell.slots.map(function(slot){
          if (slot.rest){
            sounding = false;
            return slot.restUncertain ? 'r?' : 'r';
          }
          var text = slotNoteToken(doc, slot);
          if (text){
            sounding = true;
            return text;
          }
          return sounding ? '-' : 'r';
        });
      });
    });
  }

  function docToMeasureObjects(doc){
    var all = slotTokens(doc);
    return doc.measures.map(function(measure, m){
      var notes = all[m].map(function(tokens){ return reduceCellTokens(tokens).join('/'); });
      return { chord: String(measure.chord).trim(), autoChord: false, notes: notes, lyric: measure.memo };
    });
  }

  function docToScoreLines(doc){
    return docToMeasureObjects(doc).map(function(measure){
      return GuitarNotation.serializeScoreMeasures([measure]);
    });
  }

  function docScoreText(doc){
    return docToScoreLines(doc).join('\n');
  }

  function validateDoc(doc){
    return GuitarParser.validateScore(docScoreText(doc), doc.beats);
  }

  function docCapo(doc){
    return GuitarParser.getSongCapo({ title: doc.title, badge: doc.description });
  }

  function buildHandoff(doc, now){
    return {
      title: doc.title.trim() || DEFAULT_TITLE,
      beats: doc.beats,
      bpm: doc.bpm,
      badge: doc.description.trim(),
      lines: docToScoreLines(doc),
      key: doc.key,
      sourceId: doc.sourceId == null ? null : doc.sourceId,
      savedAt: now
    };
  }

  // ---------- 불러오기

  function firstErrorText(errors){
    var first = errors[0];
    var position = [];
    if (first.measure != null) position.push('마디 ' + first.measure);
    if (first.beat != null) position.push('박 ' + first.beat);
    var message = first.message || '악보를 읽을 수 없습니다.';
    return position.length ? message + ' (' + position.join(', ') + ')' : message;
  }

  function parseSlotPart(part, where, flags){
    var text = part.trim();
    var slot = createSlot();
    if (text === '-') return { slot: slot };
    if (GuitarNotation.isRestToken(text)){
      slot.rest = true;
      slot.restUncertain = text !== 'r';
      return { slot: slot };
    }
    var components = text.split('+');
    for (var i = 0; i < components.length; i++){
      var token = components[i].trim();
      var parsed = GuitarParser.parseNoteToken(token, 0);
      if (!parsed || !parsed.pos) return { error: where + ': 읽을 수 없는 음입니다: ' + token };
      var str = parsed.pos.str;
      if (slot.notes[str - 1]) return { error: where + ': 두 음이 ' + str + '번 줄에 겹칩니다. 원문에 @줄을 적으세요.' };
      var art = null;
      if (parsed.explicitArticulation){
        art = parsed.articulation === 'apoyando' ? '!' : (parsed.articulation === 'harmonic' ? 'h' : null);
      }
      slot.notes[str - 1] = {
        fret: parsed.pos.fret,
        lh: parsed.pos.lh == null ? null : parsed.pos.lh,
        rh: parsed.pos.rh == null ? null : parsed.pos.rh,
        art: art,
        uncertain: !!parsed.uncertain
      };
      if (/[A-G]b/.test(token)) flags.flat = true;
      if (/[A-G]#/.test(token)) flags.sharp = true;
    }
    return { slot: slot };
  }

  function scoreToDoc(spec){
    var s = spec || {};
    var beats = s.beats;
    if (!isInt(beats) || !isAllowedBeats(beats)) return { error: '칸 수는 ' + beatsListText() + ' 중 하나여야 합니다: ' + beats };
    var validation = GuitarParser.validateScore(s.raw, beats);
    if (validation.errors.length) return { error: firstErrorText(validation.errors) };

    var flags = { flat: false, sharp: false };
    var measures = [];
    var lines = GuitarNotation.splitScoreMeasures(s.raw);
    for (var m = 0; m < lines.length; m++){
      var decoded = GuitarNotation.decodeMeasureLine(lines[m]);
      var tokens = GuitarNotation.tokenizeMeasureBeats(decoded.notation);
      var measure = { chord: '', memo: decoded.lyric, cells: [] };
      if (decoded.chordRaw === '-') measure.chord = '';
      else if (decoded.chordRaw == null || decoded.chordRaw === '' || decoded.chordRaw === '?') measure.chord = '?';
      else measure.chord = decoded.chordRaw;
      for (var c = 0; c < tokens.length; c++){
        var parts = GuitarNotation.splitBeatSubtokens(tokens[c]);
        var where = '마디 ' + (m + 1) + ', 칸 ' + (c + 1);
        if (parts.length < 1 || parts.length > MAX_DIVISION) return { error: where + ': 칸을 ' + parts.length + '개로 나눌 수 없습니다.' };
        var cell = { slots: [] };
        for (var p = 0; p < parts.length; p++){
          var result = parseSlotPart(parts[p], where, flags);
          if (result.error) return { error: result.error };
          cell.slots.push(result.slot);
        }
        measure.cells.push(cell);
      }
      measures.push(measure);
    }
    return {
      doc: {
        version: 1,
        title: s.title == null ? DEFAULT_TITLE : s.title,
        beats: beats,
        bpm: s.bpm == null ? DEFAULT_BPM : s.bpm,
        description: s.description == null ? '' : s.description,
        accidentals: flags.flat && !flags.sharp ? 'flat' : 'sharp',
        key: 0,
        sourceId: null,
        measures: measures
      }
    };
  }

  // 텍스트 모드: 편집기 글로 마디만 바꾼 새 문서. 원래 doc은 바꾸지 않는다(Docs/tab-input.md 텍스트로 입력).
  function replaceMeasuresFromText(doc, text){
    var result = scoreToDoc({ title: doc.title, beats: doc.beats, bpm: doc.bpm, description: doc.description, raw: text });
    if (result.error) return { error: result.error };
    var next = cloneDoc(doc);
    next.measures = result.doc.measures;
    if (doc.key === 0) next.accidentals = result.doc.accidentals;
    return { doc: next };
  }

  function isIntegerText(text){ return /^[0-9]+$/.test(text); }

  function parseImportText(text, current){
    var source = String(text == null ? '' : text);
    var lines = source.split(/\r?\n/);
    var firstLine = null;
    for (var i = 0; i < lines.length; i++){
      if (lines[i].trim()){ firstLine = lines[i]; break; }
    }
    var cur = current || {};

    if (firstLine !== null && firstLine.indexOf('\t') >= 0){
      var cols = firstLine.split('\t');
      if (cols.length !== 5) return { error: '열이 5개여야 합니다(제목, 칸 수, BPM, 설명, 악보). 지금 ' + cols.length + '개.' };
      var beatsText = cols[1].trim();
      if (!isIntegerText(beatsText) || !isAllowedBeats(Number(beatsText))){
        return { error: '칸 수는 ' + beatsListText() + ' 중 하나여야 합니다: ' + beatsText };
      }
      var bpmText = cols[2].trim();
      if (!isIntegerText(bpmText) || Number(bpmText) < 1) return { error: 'BPM은 1 이상의 정수여야 합니다: ' + bpmText };
      var bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, Number(bpmText)));
      return scoreToDoc({ title: cols[0].trim(), beats: Number(beatsText), bpm: bpm, description: cols[3].trim(), raw: cols[4].trim() });
    }

    if (!source.trim()) return { error: '불러올 악보가 비어 있습니다.' };
    var measureLines = GuitarNotation.splitScoreMeasures(source);
    var firstMeasure = GuitarNotation.decodeMeasureLine(measureLines[0] || '');
    var beats = GuitarNotation.tokenizeMeasureBeats(firstMeasure.notation).length;
    if (!isAllowedBeats(beats)) return { error: '첫 마디 칸 수(' + beats + ')가 ' + beatsListText() + ' 중 하나가 아닙니다.' };
    return scoreToDoc({
      title: cur.title == null ? DEFAULT_TITLE : cur.title,
      beats: beats,
      bpm: cur.bpm == null ? DEFAULT_BPM : cur.bpm,
      description: cur.description == null ? '' : cur.description,
      raw: source
    });
  }

  var api = {
    STRING_COUNT: STRING_COUNT, MAX_FRET: MAX_FRET, DEFAULT_TITLE: DEFAULT_TITLE, DEFAULT_BPM: DEFAULT_BPM, MAX_HISTORY: MAX_HISTORY,
    createDoc: createDoc, createMeasure: createMeasure, createCell: createCell, createSlot: createSlot,
    cloneDoc: cloneDoc, normalizeDoc: normalizeDoc, hasContent: hasContent,
    getSlot: getSlot, isValidPos: isValidPos, firstPos: firstPos, nextPos: nextPos, prevPos: prevPos, clampPos: clampPos,
    setNote: setNote, removeNote: removeNote, toggleNote: toggleNote, setNoteAttrs: setNoteAttrs,
    setRest: setRest, setRestUncertain: setRestUncertain, clearSlot: clearSlot,
    setDivision: setDivision, setBeats: setBeats, setKey: setKey, setMeasureChord: setMeasureChord, setMeasureMemo: setMeasureMemo,
    insertEmptyMeasure: insertEmptyMeasure, duplicateRange: duplicateRange, deleteRange: deleteRange,
    clearRange: clearRange, copyRange: copyRange, pasteAfter: pasteAfter,
    createHistory: createHistory,
    noteMidi: noteMidi, noteMidiOf: noteMidiOf, noteLabel: noteLabel, noteLabelOf: noteLabelOf, noteToken: noteToken,
    slotTokens: slotTokens, docToMeasureObjects: docToMeasureObjects, docToScoreLines: docToScoreLines, docScoreText: docScoreText,
    validateDoc: validateDoc, docCapo: docCapo, buildHandoff: buildHandoff, isHarmonicFret: isHarmonicFret,
    scoreToDoc: scoreToDoc, parseImportText: parseImportText, replaceMeasuresFromText: replaceMeasuresFromText
  };
  if (typeof window !== 'undefined') window.GuitarTabInput = api;
  if (isNode) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
