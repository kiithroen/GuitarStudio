(function(global){
  'use strict';
  // 텍스트 악보를 오선보 배치 데이터로 바꾸는 DOM 없는 계산. 규칙과 결정은 Docs/staff-notation.md.
  var isNode = typeof module !== 'undefined' && module.exports;
  var GuitarNotation = isNode ? require('./notation.js') : global.GuitarNotation;
  var GuitarRhythm = isNode ? require('./rhythm.js') : global.GuitarRhythm;
  var GuitarParser = isNode ? require('./parser.js') : global.GuitarParser;

  var UNITS = GuitarRhythm.UNITS_PER_SLOT;
  var LETTER_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
  var LETTER_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  var FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  var STAFF_BOTTOM_STEP = 0;   // E4: 아래 첫째 줄
  var STAFF_MIDDLE_STEP = 4;   // B4: 가운데 줄
  var KEY_MIN = -5;
  var KEY_MAX = 5;
  // 표준 음표 길이(4분음표 수)와 음표 값. 점 하나까지.
  var STANDARD_VALUES = [
    { q: 4, base: 'whole', dots: 0 }, { q: 3, base: 'half', dots: 1 }, { q: 2, base: 'half', dots: 0 },
    { q: 1.5, base: 'quarter', dots: 1 }, { q: 1, base: 'quarter', dots: 0 },
    { q: 0.75, base: 'eighth', dots: 1 }, { q: 0.5, base: 'eighth', dots: 0 },
    { q: 0.375, base: '16th', dots: 1 }, { q: 0.25, base: '16th', dots: 0 },
    { q: 0.1875, base: '32nd', dots: 1 }, { q: 0.125, base: '32nd', dots: 0 }
  ];
  var BEAM_LEVEL = { eighth: 1, '16th': 2, '32nd': 3 };
  var LONGEST_Q = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.125];

  function fail(message){ throw new Error(message); }

  function valueForQuarters(q, triplet){
    for (var i = 0; i < STANDARD_VALUES.length; i++){
      var v = STANDARD_VALUES[i];
      if (Math.abs(v.q - q) < 1e-9){
        if (triplet && v.dots) break;
        return { base: v.base, dots: v.dots, triplet: !!triplet };
      }
    }
    return fail('음표로 그릴 수 없는 길이입니다: ' + q + '(4분음표 수)');
  }

  // 길이(1/12칸 단위)를 음표 값으로. startInCell은 칸 안 시작 위치, 셋잇단 여부는 호출한 쪽이 정한다.
  function valueForUnits(length, cellQuarter, triplet){
    if (triplet){
      if (length === 4) return valueForQuarters(cellQuarter / 2, true);
      if (length === 8) return valueForQuarters(cellQuarter, true);
      return fail('셋잇단으로 그릴 수 없는 길이입니다: ' + length);
    }
    return valueForQuarters(length / UNITS * cellQuarter, false);
  }

  // ---------- 음 하나

  function parseComponent(component){
    var text = String(component || '').trim();
    var parsed = GuitarParser.parseNoteToken(text, 0);
    if (!parsed) return fail('읽을 수 없는 음입니다: ' + text);
    // 하모닉스는 손 대는 자리의 음(줄 개방현 + 손 대는 프렛)으로 그린다. 이름은 그 음에서 다시 만든다(Docs/staff-notation.md).
    var harmonic = parsed.articulation === 'harmonic' && !!parsed.pos;
    var drawMidi = harmonic ? GuitarParser.STRINGS[parsed.pos.str - 1].midi + parsed.pos.fret : parsed.midi;
    var core = harmonic ? GuitarParser.noteNameForMidi(drawMidi, false) : text.replace(/\?$/, '').replace(/^[!sg]/, '');
    var m = core.match(/^[0-4]?([A-G])([#b]?)([2-5])/);
    if (!m) return fail('음이름을 읽을 수 없습니다: ' + text);
    var letter = m[1];
    var alter = m[2] === '#' ? 1 : (m[2] === 'b' ? -1 : 0);
    var written = Number(m[3]) + 1;
    var step = written * 7 + LETTER_INDEX[letter] - (4 * 7 + LETTER_INDEX.E);
    return {
      name: letter + m[2] + m[3], letter: letter, alter: alter, octave: written, step: step,
      midi: drawMidi, soundMidi: parsed.midi, slur: parsed.articulation === 'slur', slide: parsed.articulation === 'slide', accidental: null, ledger: ledgerFor(step),
      str: parsed.pos ? parsed.pos.str : null, fret: parsed.pos ? parsed.pos.fret : null,
      lh: parsed.pos && parsed.pos.lh != null ? parsed.pos.lh : null, rh: parsed.pos && parsed.pos.rh != null ? parsed.pos.rh : null,
      uncertain: !!parsed.uncertain, harmonic: harmonic
    };
  }

  function ledgerFor(step){
    var list = [], s;
    if (step >= 10) for (s = 10; s <= step; s += 2) list.push(s);
    else if (step <= -2) for (s = -2; s >= step; s -= 2) list.push(s);
    return list;
  }

  function notesForPart(part){
    // 롤 기호 ~ 는 화음 맨 앞에 붙은 표시라 음 읽기 전에 뗀다(roll 여부는 buildLayout이 part.rolled로 싣는다).
    var notes = String(part.tok || '').replace(/^\s*~/, '').split('+').map(parseComponent);
    // 낮은 음부터. 같은 높이는 원래 순서를 지킨다.
    return notes.map(function(note, index){ return { note: note, index: index }; })
      .sort(function(a, b){ return a.note.midi - b.note.midi || a.index - b.index; })
      .map(function(entry){ return entry.note; });
  }

  // ---------- 조각 나누기

  // 한 구간(마디 안, 시작 start부터 끝 end까지)을 토막으로 자른다. 규칙은 Docs/staff-notation.md의 "길이를 음표로 나누기".
  function splitPiece(start, end, isChord, cellQuarter){
    var out = [], p = start;
    while (p < end){
      var u = p % UNITS, rem = end - p, length = null, triplet = false;
      if (isChord && u === 6 && rem >= UNITS && !(Math.floor(end / UNITS) === Math.floor(p / UNITS) + 1 && (end % UNITS === 4 || end % UNITS === 8))){
        length = UNITS;
      } else if (u !== 0 || rem < UNITS){
        var cellEnd = p - u + UNITS;
        length = Math.min(end, cellEnd) - p;
        var endInCell = u + length;
        triplet = u === 4 || u === 8 || endInCell === 4 || endInCell === 8;
      } else {
        var best = UNITS;
        LONGEST_Q.forEach(function(q){
          var units = q / cellQuarter * UNITS;
          if (Math.abs(units - Math.round(units)) > 1e-9) return;
          units = Math.round(units);
          if (units <= rem && units % 3 === 0 && units > best) best = units;
        });
        length = best;
      }
      if (triplet ? (length !== 4 && length !== 8) : (length % 3 !== 0)) return fail('음표로 그릴 수 없는 토막입니다: 위치 ' + p + ', 길이 ' + length);
      out.push({ start: p, length: length, triplet: triplet });
      p += length;
    }
    return out;
  }

  // ---------- 배치

  function keyAlterByLetter(key){
    var map = {};
    var list = key > 0 ? SHARP_ORDER : FLAT_ORDER;
    for (var i = 0; i < Math.abs(key); i++) map[list[i]] = key > 0 ? 1 : -1;
    return map;
  }

  function beatGroupCells(beats){
    if (beats === 6 || beats === 9 || beats === 12) return 3;
    if (beats === 8) return 2;
    return 1;
  }

  function accidentalName(alter){ return alter === 1 ? 'sharp' : (alter === -1 ? 'flat' : 'natural'); }

  function stemFor(items){
    var up = 0, down = 0;
    items.forEach(function(item){
      item.notes.forEach(function(note){
        var d = note.step - STAFF_MIDDLE_STEP;
        if (d > up) up = d;
        if (-d > down) down = -d;
      });
    });
    return down > up ? 'up' : 'down';
  }

  // 슬러 곡선·슬라이드 직선: 판정은 GuitarNotation.linkSlurs 하나이고, 여기서는 그 결과를 마디별 배치에 싣기만 한다(Docs/staff-notation.md 슬러 곡선·슬라이드 직선).
  // 붙임줄로 나뉜 음은 선이 출발 음의 마지막 토막에서 나가 도착 음의 첫 토막으로 들어간다.
  // 모든 항목에 kind('slur'|'slide', 도착 음의 종류)를 싣고, 슬라이드는 방향 dir('up'|'down')도 싣는다.
  function attachSlurs(result, segments, spanOfSegment){
    var pieces = segments.map(function(segment){
      if (segment.kind === 'rest') return { rest: true, hold: false, notes: [] };
      return { rest: false, hold: false, notes: segment.baseNotes.map(function(note){
        return { str: note.str, midi: note.soundMidi, slur: note.slur || note.slide, slide: note.slide };
      }) };
    });
    GuitarNotation.linkSlurs(pieces).forEach(function(results, pieceIndex){
      results.forEach(function(link, noteIndex){
        if (!link || !link.ok) return;
        var from = spanOfSegment.get(segments[link.from.piece]).last;
        var to = spanOfSegment.get(segments[pieceIndex]).first;
        var slide = !!segments[pieceIndex].baseNotes[noteIndex].slide;
        var extra = slide ? { kind: 'slide', dir: link.type === 'hammer' ? 'up' : 'down' } : { kind: 'slur' };
        function add(entry){
          Object.keys(extra).forEach(function(key){ entry[key] = extra[key]; });
          return entry;
        }
        if (from.measure === to.measure){
          result[from.measure].slurs.push(add({ fromItem: from.item, fromHead: link.from.note, toItem: to.item, toHead: noteIndex }));
        } else {
          result[from.measure].slurs.push(add({ fromItem: from.item, fromHead: link.from.note, toEdge: true }));
          result[to.measure].slurs.push(add({ fromEdge: true, toItem: to.item, toHead: noteIndex }));
        }
      });
    });
  }

  function buildLayout(text, beats, key){
    if (!Number.isInteger(key) || key < KEY_MIN || key > KEY_MAX) fail('조표는 ' + KEY_MIN + '~' + KEY_MAX + '의 정수여야 합니다: ' + key);
    var parsed = GuitarParser.parseScore(text, beats);
    if (parsed.errors && parsed.errors.length) return { error: parsed.errors[0].message || '악보를 읽을 수 없습니다.' };
    var measures = parsed.measures;
    var annotated = GuitarRhythm.annotate(measures, beats);
    if (annotated.errors && annotated.errors.length) return { error: annotated.errors[0].message || '악보를 읽을 수 없습니다.' };
    var grid = GuitarRhythm.getGridInfo(beats);
    var cellQuarter = grid.slotQuarterLength;
    var measureCount = measures.length;

    // 마디마다 실제 시간 경계. 빈칸 _ 은 시간이 없어서 마디 길이는 빈칸이 아닌 칸 수 × UNITS 이고, 마디 시작은 그 마디 첫 칸의 startUnits 다.
    // lead 는 마디 앞쪽 빈칸 수(못갖춘마디의 음을 TAB 칸 아래로 미는 만큼), hasSkip 은 앞뒤 어느 쪽이든 빈칸이 있는 마디다.
    var bounds = measures.map(function(measure){
      var cellList = measure.beats || [];
      var lead = 0, skips = 0;
      cellList.forEach(function(beat, index){
        if (!GuitarRhythm.isSkipBeat(beat)) return;
        skips++;
        if (lead === index) lead++;
      });
      var first = cellList[0];
      return {
        start: first && Number.isFinite(first.startUnits) ? first.startUnits : 0,
        units: (cellList.length - skips) * UNITS,
        lead: lead, hasSkip: skips > 0
      };
    });
    var boundsCursor = 0;
    function measureIndexAt(time){
      if (boundsCursor > 0 && time < bounds[boundsCursor].start) boundsCursor = 0;
      while (boundsCursor < measureCount - 1 && time >= bounds[boundsCursor].start + bounds[boundsCursor].units) boundsCursor++;
      return boundsCursor;
    }

    // 쉼 확인 표시: 쉼 토큰이 시작하는 위치(전체 1/12칸 단위).
    var uncertainRestStarts = [];
    measures.forEach(function(measure){
      (measure.beats || []).forEach(function(beat){
        var parts = beat && beat.isSubdivided && Array.isArray(beat.subNotes) ? beat.subNotes : [beat];
        parts.forEach(function(part){
          if (part && part.kind === 'rest' && GuitarNotation.hasUncertainMark(part.tok)) uncertainRestStarts.push(part.startUnits);
        });
      });
    });
    function restUncertain(from, to){
      return uncertainRestStarts.some(function(s){ return s >= from && s < to; });
    }

    // 전체 시간선: 음 사건과 그 사이의 쉼 구간.
    var segments = [];
    var cursor = 0;
    annotated.events.forEach(function(event){
      if (event.startUnits > cursor) segments.push({ kind: 'rest', start: cursor, end: event.startUnits });
      segments.push({ kind: 'chord', start: event.startUnits, end: event.startUnits + event.durationUnits, event: event });
      cursor = event.startUnits + event.durationUnits;
    });
    if (cursor < annotated.totalUnits) segments.push({ kind: 'rest', start: cursor, end: annotated.totalUnits });
    segments.forEach(function(segment){
      if (segment.kind === 'chord') segment.baseNotes = notesForPart(segment.event.part);
    });

    // 마디 경계에서 자른다.
    var perMeasure = [];
    for (var mi = 0; mi < measureCount; mi++) perMeasure.push([]);
    segments.forEach(function(segment){
      var a = segment.start;
      while (a < segment.end){
        var m = measureIndexAt(a);
        var b = Math.min(segment.end, bounds[m].start + bounds[m].units);
        perMeasure[m].push({ segment: segment, start: a - bounds[m].start, end: b - bounds[m].start, absStart: a, absEnd: b });
        a = b;
      }
    });

    var groupCells = beatGroupCells(beats);
    var keyMap = keyAlterByLetter(key);
    var pendingTie = {}; // 사건 -> 앞 토막 item (붙임줄 연결용)
    var lastItemOfSegment = new Map();
    var spanOfSegment = new Map(); // 사건 -> 첫·마지막 토막의 자리 { first: {measure, item}, last: {measure, item} } (슬러 곡선용)
    var result = [];

    perMeasure.forEach(function(pieces, measureIndex){
      var items = [];
      var measureUnits = bounds[measureIndex].units;
      var lead = bounds[measureIndex].lead;
      var accState = {}; // letter+적는 옥타브 -> 지금 변화
      function currentAlter(note){
        var k = note.letter + note.octave;
        return Object.prototype.hasOwnProperty.call(accState, k) ? accState[k] : (keyMap[note.letter] || 0);
      }

      // 온쉼표는 빈칸이 없는 마디에서만. 빈칸이 있는 마디의 쉼은 길이대로 나눈 쉼표로 그린다.
      var wholeRest = !bounds[measureIndex].hasSkip && pieces.length === 1 && pieces[0].segment.kind === 'rest' && pieces[0].start === 0 && pieces[0].end === measureUnits;
      if (wholeRest){
        items.push({
          type: 'rest', cell: 0, unit: 0, lengthUnits: measureUnits,
          value: { base: 'whole', dots: 0, triplet: false },
          uncertain: restUncertain(pieces[0].absStart, pieces[0].absEnd)
        });
      } else {
        pieces.forEach(function(piece){
          var isChord = piece.segment.kind === 'chord';
          var baseNotes = isChord ? piece.segment.baseNotes : null;
          var chordUncertain = isChord && baseNotes.some(function(note){ return note.uncertain; });
          splitPiece(piece.start, piece.end, isChord, cellQuarter).forEach(function(cut){
            var item = {
              type: isChord ? 'chord' : 'rest',
              cell: lead + Math.floor(cut.start / UNITS), unit: cut.start % UNITS,
              lengthUnits: cut.length,
              value: valueForUnits(cut.length, cellQuarter, cut.triplet),
              uncertain: false
            };
            var absStart = piece.absStart + (cut.start - piece.start);
            if (isChord){
              var event = piece.segment.event;
              var prev = lastItemOfSegment.get(piece.segment) || null;
              item.uncertain = chordUncertain;
              item.tieFromPrev = !!prev;
              item.tieToNext = false;
              if (prev) prev.tieToNext = true;
              item.source = { measureIndex: event.measureIndex, beatIndex: event.beatIndex, subIndex: event.subIndex };
              // 롤 물결선은 사건의 첫 토막에만(붙임줄로 이어진 뒤 토막은 다시 치지 않는다).
              item.roll = !spanOfSegment.has(piece.segment) && !!(event.part && event.part.rolled);
              item.notes = baseNotes.map(function(note){
                var copy = {
                  name: note.name, letter: note.letter, alter: note.alter, octave: note.octave, step: note.step,
                  accidental: null, ledger: note.ledger.slice(), str: note.str, fret: note.fret, uncertain: note.uncertain,
                  lh: note.lh, rh: note.rh // 오선 그리기에는 쓰지 않는다. 다른 보기(alphaTab 변환)가 운지를 읽는다.
                };
                if (note.harmonic) copy.harmonic = true;
                if (!item.tieFromPrev){
                  if (currentAlter(copy) !== copy.alter){
                    copy.accidental = accidentalName(copy.alter);
                    accState[copy.letter + copy.octave] = copy.alter;
                  }
                }
                return copy;
              });
              item.stem = item.value.base === 'whole' ? null : stemFor([item]);
              lastItemOfSegment.set(piece.segment, item);
            } else {
              item.uncertain = restUncertain(absStart, absStart + cut.length);
            }
            items.push(item);
            if (isChord){
              var spot = { measure: measureIndex, item: items.length - 1 };
              var span = spanOfSegment.get(piece.segment);
              if (!span) spanOfSegment.set(piece.segment, span = { first: spot, last: spot });
              span.last = spot;
            }
          });
        });
      }

      // 빔: 8분음표 이하 화음이 같은 박 묶음 안에서 이어질 때.
      var beams = [];
      var run = [];
      function flush(){
        if (run.length >= 2){
          beams.push({
            items: run.map(function(index){ return index; }),
            levels: run.map(function(index){ return BEAM_LEVEL[items[index].value.base]; })
          });
        }
        run = [];
      }
      items.forEach(function(item, index){
        var beamable = item.type === 'chord' && BEAM_LEVEL[item.value.base];
        if (!beamable){ flush(); return; }
        if (run.length && Math.floor(items[run[0]].cell / groupCells) !== Math.floor(item.cell / groupCells)) flush();
        run.push(index);
      });
      flush();

      // 기둥: 빔 묶음은 묶음 전체, 아니면 화음 하나.
      beams.forEach(function(beam){
        var group = beam.items.map(function(index){ return items[index]; });
        var stem = stemFor(group);
        group.forEach(function(item){ item.stem = stem; });
      });

      // 셋잇단: 셋잇단 토막이 있는 칸마다.
      var tuplets = [];
      items.forEach(function(item, index){
        if (!item.value.triplet) return;
        var last = tuplets[tuplets.length - 1];
        if (last && last.cell === item.cell) last.items.push(index);
        else tuplets.push({ cell: item.cell, items: [index] });
      });

      result.push({ index: measureIndex, items: items, beams: beams, tuplets: tuplets, slurs: [] });
    });

    attachSlurs(result, segments, spanOfSegment);

    return {
      beats: beats, key: key,
      time: { numerator: grid.numerator, denominator: grid.denominator },
      unitsPerCell: UNITS, cellQuarter: cellQuarter,
      measures: result
    };
  }

  function layoutScore(text, beats, key){
    var k = key == null ? 0 : key;
    try {
      return buildLayout(text, beats, k);
    } catch (error) {
      return { error: error && error.message ? error.message : String(error) };
    }
  }

  var api = {
    layoutScore: layoutScore,
    UNITS_PER_CELL: UNITS,
    KEY_MIN: KEY_MIN, KEY_MAX: KEY_MAX,
    STAFF_BOTTOM_STEP: STAFF_BOTTOM_STEP, STAFF_MIDDLE_STEP: STAFF_MIDDLE_STEP
  };
  if (typeof window !== 'undefined') window.GuitarStaffLayout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
