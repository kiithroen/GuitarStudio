(function(root, factory){
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuitarRhythm = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  var UNITS_PER_SLOT = 12;

  function getGridInfo(slotsPerBar){
    var slots = Number(slotsPerBar);
    if (!Number.isInteger(slots) || slots < 1 || slots > 12) slots = 4;
    var compound = slots === 6 || slots === 9 || slots === 12;
    var eighth = compound || slots === 8;
    return { slotsPerBar:slots, numerator:slots === 8 ? 4 : slots, denominator:slots === 8 ? 4 : (eighth ? 8 : 4),
      slotQuarterLength:eighth ? 0.5 : 1,
      bpmUnitLabel:eighth ? '8분음표 한 칸' : '4분음표 한 칸' };
  }

  function partsFor(beat){ return beat && beat.isSubdivided && Array.isArray(beat.subNotes) ? beat.subNotes : [beat]; }
  function kindFor(part){
    var tok = String(part && part.tok || '').trim();
    var N = typeof GuitarNotation !== 'undefined' ? GuitarNotation : (typeof module !== 'undefined' && module.exports ? require('./notation.js') : null);
    if (N.isSkipToken(tok)) return 'skip';
    if (N.isRestToken(tok)) return 'rest';
    if (tok === '-') return 'hold';
    if (tok === '.') return 'invalid';
    if (part && part.midi != null) return 'note';
    return 'invalid';
  }

  // 빈칸 칸(칸 하나 통째로 _ )인가. 분할 조각 안의 _ 는 오류 악보에서만 나오며 빈칸 칸이 아니다.
  function isSkipBeat(beat){
    if (!beat || beat.isSubdivided) return false;
    return beat.kind === 'skip' || kindFor(beat) === 'skip';
  }

  // (fromMeasure, fromBeat) 칸부터 toMeasure(포함) 끝까지의 빈칸이 아닌 칸 수. 재생·루프 끝까지 남은 칸 수가 쓴다.
  function countPlayableSlots(measures, fromMeasure, fromBeat, toMeasure){
    measures = Array.isArray(measures) ? measures : [];
    var count = 0;
    for (var mi = Math.max(0, fromMeasure); mi <= toMeasure && mi < measures.length; mi++){
      var beats = measures[mi] && Array.isArray(measures[mi].beats) ? measures[mi].beats : [];
      for (var bi = mi === fromMeasure ? Math.max(0, fromBeat) : 0; bi < beats.length; bi++){
        if (!isSkipBeat(beats[bi])) count++;
      }
    }
    return count;
  }

  function annotate(measures, slotsPerBar){
    measures = Array.isArray(measures) ? measures : [];
    var slots = Number(slotsPerBar);
    if (!Number.isInteger(slots) || slots < 1 || slots > 12) slots = 4;
    var events = [], errors = [], activeChain = null;
    var locationMap = [];
    var skipCount = 0; // 지금까지 지난 빈칸 칸 수. 위치(startUnits)는 빈칸을 뺀 실제 시간이다.
    measures.forEach(function(measure, mi){
      var beats = measure && Array.isArray(measure.beats) ? measure.beats : [];
      beats.forEach(function(beat, bi){
        var parts = partsFor(beat), count = parts.length;
        var supported = count === 1 || count === 2 || count === 3 || count === 4;
        if (!supported) errors.push({code:'UNSUPPORTED_SUBDIVISION',measure:mi+1,beat:bi+1,message:'한 박은 2, 3 또는 4개로만 나눌 수 있습니다.'});
        var slotUnits = supported ? UNITS_PER_SLOT / count : UNITS_PER_SLOT;
        if (!Number.isInteger(slotUnits)) slotUnits = 1;
        var groupStart = (mi * slots + bi - skipCount) * UNITS_PER_SLOT;
        var skipBeat = count === 1 && !!parts[0] && kindFor(parts[0]) === 'skip';
        beat.startUnits = groupStart;
        if (count > 1) beat.kind = 'group';
        parts.forEach(function(part, si){
          if (!part) return;
          var kind = kindFor(part), subIndex = count > 1 ? si : null;
          var start = groupStart + si * slotUnits;
          part.kind = kind;
          part.startUnits = start;
          part.slotUnits = skipBeat ? 0 : slotUnits;
          part.durationUnits = skipBeat ? 0 : slotUnits;
          part.tieFrom = null;
          locationMap.push({part:part, measureIndex:mi, beatIndex:bi, subIndex:subIndex, startUnits:start});
          if (kind === 'invalid' && String(part.tok || '').trim() !== '.') errors.push({code:'UNKNOWN_NOTE',measure:mi+1,beat:bi+1,message:'알 수 없거나 모호한 음표 토큰 ' + String(part.tok || '') + ' 가 있습니다.'});
        });
        if (skipBeat) skipCount++;
      });
    });
    function finalizeChain(endUnits){
      if (!activeChain) return;
      var durationUnits = endUnits - activeChain.attack.startUnits;
      activeChain.attack.part.durationUnits = durationUnits;
      activeChain.event.durationUnits = durationUnits;
      activeChain.holds.forEach(function(hold){ hold.part.durationUnits = endUnits - hold.startUnits; });
      activeChain = null;
    }
    locationMap.forEach(function(entry){
      var part = entry.part;
      if (part.kind === 'skip') return; // 시간이 흐르지 않으니 유지 사슬은 빈칸을 건너 이어진다
      if (part.kind === 'rest') { finalizeChain(entry.startUnits); return; }
      if (part.kind === 'note') {
        finalizeChain(entry.startUnits);
        part.durationUnits = part.slotUnits;
        var event = {kind:'note',startUnits:entry.startUnits,durationUnits:part.slotUnits,measureIndex:entry.measureIndex,beatIndex:entry.beatIndex,subIndex:entry.subIndex,part:part};
        events.push(event);
        activeChain = {attack:entry,event:event,holds:[],endUnits:entry.startUnits+part.slotUnits};
        return;
      }
      if (part.kind === 'hold') {
        if (!activeChain) {
          errors.push({code:'ORPHAN_HOLD',measure:entry.measureIndex+1,beat:entry.beatIndex+1,message:'유지는 바로 앞 음 또는 화음 뒤에만 올 수 있습니다.'});
          return;
        }
        part.tieFrom = {measureIndex:activeChain.attack.measureIndex,beatIndex:activeChain.attack.beatIndex,subIndex:activeChain.attack.subIndex};
        activeChain.holds.push({part:part,startUnits:entry.startUnits});
        activeChain.endUnits = entry.startUnits + part.slotUnits;
      } else finalizeChain(entry.startUnits);
    });
    if (activeChain) finalizeChain(activeChain.endUnits);

    return {events:events,totalUnits:(measures.length * slots - skipCount) * UNITS_PER_SLOT,errors:errors};
  }

  function getSoundingNotes(measures, positionUnits){
    if (!Array.isArray(measures) || !Number.isFinite(Number(positionUnits))) return [];
    var position = Number(positionUnits), result = [];
    measures.forEach(function(measure){
      (measure && measure.beats || []).forEach(function(beat){
        var parts = partsFor(beat);
        parts.forEach(function(part){
          if (!part || part.kind !== 'note') return;
          var start = Number(part.startUnits), duration = Number(part.durationUnits);
          if (!Number.isFinite(start) || !Number.isFinite(duration)) return;
          var end = start + duration;
          if (!(start < position && end > position)) return;
          var notes = Array.isArray(part.chordNotes) && part.chordNotes.length ? part.chordNotes : [part];
          notes.forEach(function(note){
            if (note) result.push({note:note,remainingUnits:end-position});
          });
        });
      });
    });
    return result;
  }

  function resolveHold(measures, part){
    var ref = part && part.tieFrom;
    if (!ref || !Array.isArray(measures) || !Number.isInteger(ref.measureIndex) || !Number.isInteger(ref.beatIndex)) return null;
    var measure = measures[ref.measureIndex], beat = measure && measure.beats && measure.beats[ref.beatIndex];
    if (!beat) return null;
    if (ref.subIndex == null) return beat.kind === 'note' ? beat : null;
    var sub = beat.subNotes && beat.subNotes[ref.subIndex];
    return sub && sub.kind === 'note' ? sub : null;
  }

  return {UNITS_PER_SLOT:UNITS_PER_SLOT,getGridInfo:getGridInfo,isSkipBeat:isSkipBeat,countPlayableSlots:countPlayableSlots,annotate:annotate,resolveHold:resolveHold,getSoundingNotes:getSoundingNotes};
});
