(function(global){
  'use strict';
  // 오선 입력 화면의 DOM 없는 계산: 음표 길이, 한 사건 넣기, 줄 정하기, 음높이 읽기, 반음 옮기기.
  // 설계와 결정은 Docs/staff-input.md. 문서 모양과 기본 편집 연산은 src/tab-input.js의 공개 API만 쓴다.
  var isNode = typeof module !== 'undefined' && module.exports;
  var GuitarNotation = isNode ? require('./notation.js') : global.GuitarNotation; // eslint-disable-line no-unused-vars
  var GuitarRhythm = isNode ? require('./rhythm.js') : global.GuitarRhythm;
  var GuitarParser = isNode ? require('./parser.js') : global.GuitarParser;
  var GuitarTabInput = isNode ? require('./tab-input.js') : global.GuitarTabInput;

  var UNITS_PER_CELL = GuitarRhythm.UNITS_PER_SLOT;
  var MIN_MIDI = 40; // E2
  var MAX_MIDI = 76; // E5
  var RANGE_ERROR = '기타 음역(E2~E5) 밖이야.';
  var NO_STRING_ERROR = '이 음을 칠 빈 줄이 없어.';
  var LETTER_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var SHARP_ORDER = 'FCGDAEB';
  var FLAT_ORDER = 'BEADGCF';
  // 음표값 하나의 길이를 32분음표 단위(4분음표 = 8)로 적은 표
  var VALUE_EIGHTHS = { whole: 32, half: 16, quarter: 8, eighth: 4, '16th': 2, '32nd': 1 };

  function isInt(value){ return typeof value === 'number' && Number.isInteger(value); }
  function fail(message){ return { ok: false, error: message }; }
  function slotIsEmpty(slot){
    if (slot.rest) return false;
    for (var i = 0; i < slot.notes.length; i++) if (slot.notes[i]) return false;
    return true;
  }
  function slotMidis(slot){
    var list = [];
    slot.notes.forEach(function(note, index){
      if (note) list.push(GuitarTabInput.noteMidi(index + 1, note.fret));
    });
    return list;
  }

  // ---------- 길이

  function durationUnits(beats, value, dotted, triplet){
    var eighths = VALUE_EIGHTHS[value];
    if (!eighths) return { error: '알 수 없는 음표값이야: ' + value };
    var info = GuitarRhythm.getGridInfo(beats);
    var cellEighths = info.slotQuarterLength * 8;
    var num = eighths * UNITS_PER_CELL * (dotted ? 3 : 1) * (triplet ? 2 : 1);
    var den = cellEighths * (dotted ? 2 : 1) * (triplet ? 3 : 1);
    if (num % den !== 0 || num / den < 1){
      var hint = info.slotQuarterLength === 1 ? ' 더 짧은 음표를 쓰려면 칸 수를 8칸으로 골라.' : '';
      return { error: '이 길이는 지금 칸 수에서 못 적어.' + hint };
    }
    return { units: num / den };
  }

  // ---------- 위치와 시간

  function totalUnits(doc){ return doc.measures.length * doc.beats * UNITS_PER_CELL; }

  function posToUnits(doc, pos){
    if (!GuitarTabInput.isValidPos(doc, pos)) return null;
    var cell = doc.measures[pos.m].cells[pos.c];
    return (pos.m * doc.beats + pos.c) * UNITS_PER_CELL + pos.s * (UNITS_PER_CELL / cell.slots.length);
  }

  function unitsToPos(doc, units){
    if (!isInt(units) || units < 0 || units >= totalUnits(doc)) return null;
    var cellIndex = Math.floor(units / UNITS_PER_CELL);
    var m = Math.floor(cellIndex / doc.beats);
    var c = cellIndex % doc.beats;
    var offset = units - cellIndex * UNITS_PER_CELL;
    var size = UNITS_PER_CELL / doc.measures[m].cells[c].slots.length;
    if (offset % size !== 0) return null;
    return { m: m, c: c, s: offset / size };
  }

  function eventEnd(doc, pos){
    var slot = GuitarTabInput.getSlot(doc, pos);
    if (!slot || slotIsEmpty(slot)) return null;
    var p = GuitarTabInput.nextPos(doc, pos);
    while (p){
      if (!slotIsEmpty(GuitarTabInput.getSlot(doc, p))) return posToUnits(doc, p);
      p = GuitarTabInput.nextPos(doc, p);
    }
    return totalUnits(doc);
  }

  // ---------- 줄 정하기

  function playableStrings(slot, midi, ignoreStr){
    var list = [];
    if (!isInt(midi)) return list;
    for (var str = 1; str <= GuitarTabInput.STRING_COUNT; str++){
      var fret = midi - GuitarParser.STRINGS[str - 1].midi;
      if (fret < 0 || fret > GuitarTabInput.MAX_FRET) continue;
      if (slot.notes[str - 1] && str !== ignoreStr) continue;
      list.push({ str: str, fret: fret });
    }
    return list;
  }

  function assignString(slot, midi, ignoreStr){
    var list = playableStrings(slot, midi, ignoreStr);
    if (!list.length) return null;
    var info = GuitarParser.midiInfo(midi);
    var preferred = info && info.pos ? info.pos.str : null;
    var best = null;
    for (var i = 0; i < list.length; i++){
      if (list[i].str === preferred) return preferred;
      if (!best || list[i].fret < best.fret) best = list[i];
    }
    return best.str;
  }

  function putNote(doc, pos, str, midi){
    GuitarTabInput.setNote(doc, pos, str, midi - GuitarParser.STRINGS[str - 1].midi);
  }

  function addToChord(doc, pos, midi){
    var slot = GuitarTabInput.getSlot(doc, pos);
    if (!slot) return fail('올바르지 않은 위치야.');
    if (slot.rest || slotIsEmpty(slot)) return fail('화음에 더할 음이 없어. 먼저 음을 넣어.');
    var str = assignString(slot, midi);
    if (str == null) return fail(midi < MIN_MIDI || midi > MAX_MIDI ? RANGE_ERROR : NO_STRING_ERROR);
    putNote(doc, pos, str, midi);
    return { ok: true, str: str };
  }

  function stringCandidates(doc, pos, str){
    var slot = GuitarTabInput.getSlot(doc, pos);
    if (!slot || !isInt(str) || str < 1 || str > GuitarTabInput.STRING_COUNT || !slot.notes[str - 1]) return [];
    var midi = GuitarTabInput.noteMidi(str, slot.notes[str - 1].fret);
    return playableStrings(slot, midi, str).map(function(item){
      return { str: item.str, fret: item.fret, current: item.str === str };
    });
  }

  // 한 음을 다른 줄로 옮긴다. 왼손 운지는 지우고 오른손·주법·확인 표시는 옮긴다.
  function relocateNote(slot, fromStr, toStr, midi){
    var old = slot.notes[fromStr - 1];
    slot.notes[fromStr - 1] = null;
    slot.notes[toStr - 1] = {
      fret: midi - GuitarParser.STRINGS[toStr - 1].midi,
      lh: null, rh: old.rh, art: old.art, uncertain: old.uncertain
    };
  }

  function moveToString(doc, pos, fromStr, toStr){
    var slot = GuitarTabInput.getSlot(doc, pos);
    if (!slot || !isInt(fromStr) || fromStr < 1 || fromStr > GuitarTabInput.STRING_COUNT || !slot.notes[fromStr - 1]){
      return fail('옮길 음이 없어.');
    }
    var midi = GuitarTabInput.noteMidi(fromStr, slot.notes[fromStr - 1].fret);
    var allowed = stringCandidates(doc, pos, fromStr).some(function(item){ return item.str === toStr; });
    if (!allowed) return fail('그 줄에서는 이 음을 칠 수 없어.');
    if (toStr === fromStr) return { ok: true, str: toStr };
    relocateNote(slot, fromStr, toStr, midi);
    return { ok: true, str: toStr };
  }

  // ---------- 음높이

  function alterFor(doc, pos, letter, soundingOctave){
    var name = String(letter).toUpperCase();
    var found = null;
    if (pos && doc.measures[pos.m]){
      var cells = doc.measures[pos.m].cells;
      scan: for (var c = 0; c < cells.length && c <= pos.c; c++){
        var slots = cells[c].slots;
        for (var s = 0; s < slots.length; s++){
          if (c === pos.c && s >= pos.s) break scan;
          for (var i = 0; i < slots[s].notes.length; i++){
            var note = slots[s].notes[i];
            if (!note) continue;
            var parsed = /^([A-G])(#|b)?(-?\d+)$/.exec(GuitarTabInput.noteLabel(doc, i + 1, note.fret));
            if (parsed && parsed[1] === name && Number(parsed[3]) === soundingOctave){
              found = parsed[2] === '#' ? 1 : (parsed[2] === 'b' ? -1 : 0);
            }
          }
        }
      }
    }
    if (found !== null) return found;
    var key = isInt(doc.key) ? doc.key : 0;
    if (key > 0) return SHARP_ORDER.slice(0, key).indexOf(name) >= 0 ? 1 : 0;
    if (key < 0) return FLAT_ORDER.slice(0, -key).indexOf(name) >= 0 ? -1 : 0;
    return 0;
  }

  function midiOf(doc, pos, letter, soundingOctave){
    var name = String(letter).toUpperCase();
    return (soundingOctave + 1) * 12 + LETTER_SEMITONE[name] + alterFor(doc, pos, name, soundingOctave);
  }

  function isLetter(letter){
    return typeof letter === 'string' && /^[A-Ga-g]$/.test(letter);
  }

  function writtenToMidi(doc, pos, letter, writtenOctave){
    if (!isLetter(letter) || !isInt(writtenOctave)) return { error: '올바르지 않은 음이야.' };
    var midi = midiOf(doc, pos, letter, writtenOctave - 1);
    if (midi < MIN_MIDI || midi > MAX_MIDI) return { error: RANGE_ERROR };
    return { midi: midi };
  }

  function nearestMidi(doc, pos, letter, refMidi){
    if (!isLetter(letter)) return { error: '올바르지 않은 음이야.' };
    var best = null;
    for (var octave = 2; octave <= 5; octave++){
      var midi = midiOf(doc, pos, letter, octave);
      if (midi < MIN_MIDI || midi > MAX_MIDI) continue;
      var distance = Math.abs(midi - refMidi);
      if (!best || distance < best.distance || (distance === best.distance && midi > best.midi)){
        best = { midi: midi, distance: distance };
      }
    }
    return best ? { midi: best.midi } : { error: RANGE_ERROR };
  }

  function highestMidi(slot){
    var list = slotMidis(slot);
    return list.length ? Math.max.apply(null, list) : null;
  }

  function referenceMidi(doc, pos, lastEntry){
    if (lastEntry && lastEntry.pos){
      var last = GuitarTabInput.getSlot(doc, lastEntry.pos);
      var top = last ? highestMidi(last) : null;
      if (top !== null) return top;
    }
    var p = GuitarTabInput.isValidPos(doc, pos) ? GuitarTabInput.prevPos(doc, pos) : null;
    while (p){
      var found = highestMidi(GuitarTabInput.getSlot(doc, p));
      if (found !== null) return found;
      p = GuitarTabInput.prevPos(doc, p);
    }
    return 59;
  }

  // ---------- 편집

  function transposeNote(doc, pos, str, semitones){
    var slot = GuitarTabInput.getSlot(doc, pos);
    if (!slot || !isInt(str) || str < 1 || str > GuitarTabInput.STRING_COUNT || !slot.notes[str - 1]) return fail('옮길 음이 없어.');
    if (!isInt(semitones)) return fail('옮길 반음 수가 올바르지 않아.');
    var note = slot.notes[str - 1];
    var target = GuitarTabInput.noteMidi(str, note.fret) + semitones;
    if (target < MIN_MIDI || target > MAX_MIDI) return fail(RANGE_ERROR);
    var fret = target - GuitarParser.STRINGS[str - 1].midi;
    if (fret >= 0 && fret <= GuitarTabInput.MAX_FRET){
      note.fret = fret;
      note.lh = null;
      return { ok: true, str: str };
    }
    var newStr = assignString(slot, target, str);
    if (newStr == null) return fail(NO_STRING_ERROR);
    relocateNote(slot, str, newStr, target);
    return { ok: true, str: newStr };
  }

  function noteToRest(doc, pos){
    if (!GuitarTabInput.isValidPos(doc, pos)) return fail('올바르지 않은 위치야.');
    GuitarTabInput.setRest(doc, pos, true);
    return { ok: true };
  }

  function appendMeasure(doc){
    GuitarTabInput.insertEmptyMeasure(doc, doc.measures.length);
  }

  // 칸 안에서 t1이 조각 시작이 되게 나눈 수를 고른다. 성공하면 true, 못 고르면 문서를 그대로 둔다.
  function makeBoundary(doc, t0, t1){
    var cellIndex = Math.floor(t1 / UNITS_PER_CELL);
    var m = Math.floor(cellIndex / doc.beats);
    var c = cellIndex % doc.beats;
    var cell = doc.measures[m].cells[c];
    var offset = t1 - cellIndex * UNITS_PER_CELL;
    var sameCell = Math.floor(t0 / UNITS_PER_CELL) === cellIndex;
    var offset0 = t0 - cellIndex * UNITS_PER_CELL;
    var tries = [cell.slots.length, 2, 3, 4];
    for (var i = 0; i < tries.length; i++){
      var division = tries[i];
      if (tries.indexOf(division) !== i) continue;
      var size = UNITS_PER_CELL / division;
      if (offset % size !== 0) continue;
      if (sameCell && offset0 % size !== 0) continue; // 커서 조각이 사라지면 안 돼
      var saved = JSON.parse(JSON.stringify(cell.slots));
      var result = GuitarTabInput.setDivision(doc, m, c, division);
      if (result.lost === 0) return true;
      cell.slots = saved;
    }
    return false;
  }

  function placeEvent(doc, pos, D, content){
    if (!GuitarTabInput.isValidPos(doc, pos)) return fail('올바르지 않은 위치야.');
    if (!isInt(D) || D < 1) return fail('올바르지 않은 길이야.');
    var mode = null;
    if (content && content.rest) mode = 'rest';
    else if (content && content.keep) mode = 'keep';
    else if (content && Array.isArray(content.midis)) mode = 'notes';
    if (!mode) return fail('넣을 내용이 없어.');
    var midis = [];
    if (mode === 'notes'){
      if (!content.midis.length) return fail('넣을 음이 없어.');
      for (var k = 0; k < content.midis.length; k++){
        if (!isInt(content.midis[k])) return fail('올바르지 않은 음이야.');
      }
      midis = content.midis.slice().sort(function(a, b){ return a - b; });
    }

    var work = GuitarTabInput.cloneDoc(doc);
    var t0 = posToUnits(work, pos);
    var t1 = t0 + D;
    var oldEnd = eventEnd(work, pos);
    if (mode === 'keep' && oldEnd === null) return fail('길이를 바꿀 음이나 쉼이 없어.');

    // 1. 곡 끝을 넘으면 빈 마디를 붙인다.
    var appended = 0;
    while (totalUnits(work) < t1){
      appendMeasure(work);
      appended++;
    }

    // 2. t0 다음부터 t1 앞까지 비우고, 통째로 든 칸은 나누기를 1로 되돌린다.
    var p = GuitarTabInput.nextPos(work, pos);
    while (p && posToUnits(work, p) < t1){
      GuitarTabInput.clearSlot(work, p);
      p = GuitarTabInput.nextPos(work, p);
    }
    for (var ci = Math.floor(t0 / UNITS_PER_CELL); ci * UNITS_PER_CELL < t1; ci++){
      if (ci * UNITS_PER_CELL >= t0 && (ci + 1) * UNITS_PER_CELL <= t1){
        GuitarTabInput.setDivision(work, Math.floor(ci / work.beats), ci % work.beats, 1);
      }
    }

    // 3. t1이 칸 안쪽이면 그 자리에 경계를 만든다.
    if (t1 < totalUnits(work) && !unitsToPos(work, t1)){
      if (!makeBoundary(work, t0, t1)) return fail('이 길이는 이 칸의 나눔과 맞지 않아. 뒤에 있는 음을 먼저 지우거나 다른 길이를 골라.');
    }

    // 4. t0 조각에 넣는다.
    var slot = GuitarTabInput.getSlot(work, pos);
    var placed = [];
    if (mode === 'rest'){
      GuitarTabInput.clearSlot(work, pos);
      GuitarTabInput.setRest(work, pos, true);
    } else if (mode === 'notes'){
      GuitarTabInput.clearSlot(work, pos);
      for (var i = 0; i < midis.length; i++){
        var str = assignString(slot, midis[i]);
        if (str == null) return fail(midis[i] < MIN_MIDI || midis[i] > MAX_MIDI ? RANGE_ERROR : NO_STRING_ERROR);
        putNote(work, pos, str, midis[i]);
        placed.push({ str: str, midi: midis[i] });
      }
    } else {
      slot.notes.forEach(function(note, index){
        if (note) placed.push({ str: index + 1, midi: GuitarTabInput.noteMidi(index + 1, note.fret) });
      });
      placed.sort(function(a, b){ return a.midi - b.midi || b.str - a.str; });
    }

    // 5. 끝 채우기: t1이 곡 끝이면 빈 마디를 붙이고, t1 조각이 비어 있으면 쉼으로 둔다.
    if (t1 >= totalUnits(work)){
      appendMeasure(work);
      appended++;
    }
    var next = unitsToPos(work, t1);
    if (slotIsEmpty(GuitarTabInput.getSlot(work, next))) GuitarTabInput.setRest(work, next, true);

    // 6. 커서는 t1 조각으로.

    doc.measures = work.measures;
    return { ok: true, next: next, appended: appended, placed: placed };
  }

  var api = {
    UNITS_PER_CELL: UNITS_PER_CELL, MIN_MIDI: MIN_MIDI, MAX_MIDI: MAX_MIDI,
    durationUnits: durationUnits, totalUnits: totalUnits, posToUnits: posToUnits, unitsToPos: unitsToPos, eventEnd: eventEnd,
    placeEvent: placeEvent, assignString: assignString, addToChord: addToChord,
    stringCandidates: stringCandidates, moveToString: moveToString,
    alterFor: alterFor, writtenToMidi: writtenToMidi, nearestMidi: nearestMidi, referenceMidi: referenceMidi,
    transposeNote: transposeNote, noteToRest: noteToRest
  };
  if (typeof window !== 'undefined') window.GuitarStaffInput = api;
  if (isNode) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
