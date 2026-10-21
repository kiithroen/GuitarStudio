(function(global){
  'use strict';
  // 우리 텍스트 악보를 alphaTex로 바꾼다. alphaTab 보기 창(alphatab.html)의 대체 미리보기와 명령줄 도구가 쓴다. 규칙과 결정은 Docs/alphatab.md.
  // 음 길이·점·붙임줄·셋잇단·슬러/슬라이드·롤 첫 토막은 GuitarStaffLayout.layoutScore 결과 하나만 쓰고 여기서 다시 셈하지 않는다.
  // 빈칸 _ (시간 0인 칸)은 내보내지 않는다. 첫 마디의 앞쪽 빈칸은 못갖춘마디 \ac 로, 그 밖의 빈칸이 든 마디는 빈칸이 아닌 칸 수만큼의 박자표 \ts 로 쓴다.
  var isNode = typeof module !== 'undefined' && module.exports;
  var GuitarRhythm = isNode ? require('./rhythm.js') : global.GuitarRhythm;
  var GuitarParser = isNode ? require('./parser.js') : global.GuitarParser;
  var GuitarStaffLayout = isNode ? require('./staff-layout.js') : global.GuitarStaffLayout;

  var DURATION_NUMBER = { whole: 1, half: 2, quarter: 4, eighth: 8, '16th': 16, '32nd': 32 };
  // 오른손 운지 -> alphaTex rf 인자(1 엄지, 2 검지, 3 중지, 4 약지).
  var RIGHT_FINGER = { p: 1, i: 2, m: 3, a: 4 };
  // alphaTab은 코드 이름을 소문자로 바꾼 값을 코드 키로 써서 CM7와 Cm7이 같은 코드가 된다. 같은 키로 겹치는 다른 이름 뒤에는 폭이 없는 글자를 붙여 가른다.
  var CHORD_NAME_PAD = '\u200b';

  function fail(message){ throw new Error(message); }

  function quote(text){
    return '"' + String(text == null ? '' : text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
  }

  function formatNumber(value){
    return String(Math.round(value * 100) / 100);
  }

  function noteProps(item, noteIndex, note, origins){
    var props = [];
    if (item.tieFromPrev) props.push('t');
    if (note.harmonic) props.push('nh');
    var origin = origins[item.index + ':' + noteIndex];
    if (origin === 'slur') props.push('h');
    else if (origin === 'slide') props.push('sl');
    if (!item.tieFromPrev){
      if (note.lh >= 1 && note.lh <= 4) props.push('lf ' + (note.lh + 1));
      if (note.rh && RIGHT_FINGER[note.rh]) props.push('rf ' + RIGHT_FINGER[note.rh]);
    }
    return props;
  }

  function noteText(item, noteIndex, note, origins){
    if (!Number.isInteger(note.str) || !Number.isInteger(note.fret)) fail('줄과 프렛을 읽을 수 없는 음이 있습니다.');
    var props = noteProps(item, noteIndex, note, origins);
    return note.fret + '.' + note.str + (props.length ? '{' + props.join(' ') + '}' : '');
  }

  function build(song){
    var beats = Number(song.beats);
    if (!Number.isInteger(beats) || beats < 1 || beats > 12) fail('칸 수를 읽을 수 없습니다.');
    var bpm = Number(song.bpm);
    if (!isFinite(bpm) || bpm <= 0) fail('BPM을 읽을 수 없습니다.');
    var capo = song.capo == null ? 0 : Number(song.capo);
    if (!Number.isInteger(capo) || capo < 0 || capo > 12) fail('카포는 0~12의 정수여야 합니다.');
    var lines = Array.isArray(song.lines) ? song.lines : [];
    var text = lines.join('\n');

    var layout = GuitarStaffLayout.layoutScore(text, beats, 0);
    if (layout.error) return { error: layout.error };
    var parsed = GuitarParser.parseScore(text, beats);
    if (parsed.errors && parsed.errors.length) return { error: parsed.errors[0].message || '악보를 읽을 수 없습니다.' };

    var grid = GuitarRhythm.getGridInfo(beats);
    var tempo;
    if (grid.slotQuarterLength === 1) tempo = bpm;
    else if (grid.slotQuarterLength === 0.5) tempo = bpm / 2;
    else return { error: '한 칸 길이를 alphaTab 템포로 바꿀 수 없습니다.' };

    var chordNames = Object.create(null);
    function chordLabel(name){
      var key = name.toLowerCase();
      var list = chordNames[key] || (chordNames[key] = []);
      var index = list.indexOf(name);
      if (index < 0) index = list.push(name) - 1;
      return name + new Array(index + 1).join(CHORD_NAME_PAD);
    }

    var head = ['\\title ' + quote(song.title)];
    var description = song.description == null ? '' : String(song.description);
    if (description.trim()) head.push('\\notices ' + quote(description));
    head.push('\\tempo (' + formatNumber(tempo) + ')', '\\ts (' + grid.numerator + ' ' + grid.denominator + ')');
    if (capo > 0) head.push('\\capo ' + capo);

    // 빈칸 _ 이 든 마디의 박자표: 빈칸이 아닌 칸 수 × 칸 음표(4분음표 칸이면 4, 8분음표 칸이면 8). 원래 박자표에서 바뀐 만큼만 적고 다음 마디가 원래 박자면 다시 적는다.
    var slotDenominator = grid.slotQuarterLength === 1 ? 4 : 8;
    var baseSignature = grid.numerator + ' ' + grid.denominator;
    var currentSignature = baseSignature;
    var bars = layout.measures.map(function(measure, measureIndex){
      var origins = {};
      measure.slurs.forEach(function(link){
        if (link.fromItem == null) return;
        origins[link.fromItem + ':' + link.fromHead] = link.kind === 'slide' ? 'slide' : 'slur';
      });
      var parsedMeasure = parsed.measures[measureIndex];
      var chord = parsedMeasure && parsedMeasure.chord;
      var chordsList = parsedMeasure && parsedMeasure.chords;
      var memo = parsedMeasure && parsedMeasure.lyric;
      var chordsByBeat = Object.create(null);
      if (chordsList && chordsList.length){
        chordsList.forEach(function(c){
          if (c && c.chord && c.beat) chordsByBeat[c.beat] = c.chord;
        });
      } else if (chord){
        chordsByBeat[1] = chord;
      }
      var emittedChordBeats = Object.create(null);
      var cellList = parsed.measures[measureIndex] && parsed.measures[measureIndex].beats || [];
      var skipCount = 0, leadingSkips = 0;
      cellList.forEach(function(beat, index){
        if (!GuitarRhythm.isSkipBeat(beat)) return;
        skipCount++;
        if (leadingSkips === index) leadingSkips++;
      });
      var prefix = '';
      var wanted = baseSignature;
      if (skipCount && measureIndex === 0 && leadingSkips === skipCount) prefix = '\\ac ';
      else if (skipCount) wanted = (cellList.length - skipCount) + ' ' + slotDenominator;
      if (!prefix && wanted !== currentSignature){
        prefix = '\\ts (' + wanted + ') ';
        currentSignature = wanted;
      }
      var out = measure.items.map(function(item, itemIndex){
        var duration = DURATION_NUMBER[item.value.base];
        if (!duration) fail('음표 길이를 바꿀 수 없습니다: ' + item.value.base);
        var effects = [];
        if (item.value.dots === 1) effects.push('d');
        else if (item.value.dots === 2) effects.push('dd');
        if (item.value.triplet) effects.push('tu 3');
        if (item.type === 'chord' && item.roll) effects.push('ad');
        var itemBeat = item.cell != null ? (item.cell + 1) : (itemIndex === 0 ? 1 : null);
        if (itemBeat && chordsByBeat[itemBeat] && !emittedChordBeats[itemBeat]){
          effects.push('ch ' + quote(chordLabel(chordsByBeat[itemBeat])));
          emittedChordBeats[itemBeat] = true;
        } else if (itemIndex === 0 && chordsByBeat[1] && !emittedChordBeats[1]){
          effects.push('ch ' + quote(chordLabel(chordsByBeat[1])));
          emittedChordBeats[1] = true;
        }
        if (itemIndex === 0 && typeof memo === 'string' && memo) effects.push('txt ' + quote(memo));
        var tail = '.' + duration + (effects.length ? ' {' + effects.join(' ') + '}' : '');
        if (item.type === 'rest') return 'r' + tail;
        var indexed = { index: itemIndex, tieFromPrev: item.tieFromPrev };
        var notes = item.notes.map(function(note, noteIndex){ return noteText(indexed, noteIndex, note, origins); });
        return (notes.length === 1 ? notes[0] : '(' + notes.join(' ') + ')') + tail;
      });
      return prefix + out.join(' ') + ' |';
    });

    return { tex: head.join('\n') + '\n' + bars.join('\n') + '\n' };
  }

  // song: { title, beats, bpm, capo, lines, description }. 성공하면 { tex }, 실패하면 { error }.
  function toAlphaTex(song){
    try {
      return build(song || {});
    } catch (error) {
      return { error: error && error.message ? error.message : String(error) };
    }
  }

  var api = { toAlphaTex: toAlphaTex, CHORD_NAME_PAD: CHORD_NAME_PAD };
  if (typeof window !== 'undefined') window.GuitarAlphaTex = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
