(function(root, factory){
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuitarNotation = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';

  // 시트 행·검사 도구·타브 입력 화면이 같이 쓰는 허용 칸 수 목록
  var SHEET_BEAT_COUNTS = [2, 3, 4, 6, 8, 9];
  var MAX_FRET = 19; // 클래식 기타 표준 19프렛. 음역은 E2(6번 줄 개방)~B5(1번 줄 19프렛)
  var NATURAL_HARMONICS = { 12: 12, 7: 19, 5: 24, 4: 28 }; // 자연 하모닉스: 손 대는 프렛 → 개방현에서 울리는 음까지 반음 수(1/2·1/3·1/4·1/5 지점)

  // 하모닉스 오류 문구의 프렛 목록(큰 순). 표의 키에서 만든다.
  function naturalHarmonicFretsText(){
    return Object.keys(NATURAL_HARMONICS).map(Number).sort(function(a, b){ return b - a; }).join('·');
  }

  // 없앤 티란도 표시 ~ 가 붙은 음 토큰에 보이는 오류 문구 (이 문구를 만드는 곳은 여기 하나)
  var TIRANDO_MARK_REMOVED_MESSAGE = '티란도 표시 ~는 더 이상 쓰지 않습니다. ~를 지우세요(따로 적지 않은 음은 티란도로 칩니다).';

  function scan(text, splitBars){
    var out = [];
    var start = 0;
    var square = 0;
    var quoted = false;
    var escaped = false;

    for (var i = 0; i < text.length; i++){
      var c = text[i];
      if (quoted){
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"'){ quoted = true; continue; }
      if (c === '[') square++;
      else if (c === ']' && square) square--;

      if (square) continue;
      if (splitBars && c === '|'){
        out.push({value:text.slice(start, i), index:i, separator:'|'});
        start = i + 1;
      } else if (!splitBars && c === '/' && text[i + 1] === '/'){
        out.push({value:text.slice(start, i), index:i, separator:'//'});
        i++;
        start = i + 1;
      } else if (!splitBars && (c === '\n' || c === '\r')){
        out.push({value:text.slice(start, i), index:i, separator:'newline'});
        if (c === '\r' && text[i + 1] === '\n') i++;
        start = i + 1;
      }
    }
    out.push({value:text.slice(start), index:text.length, separator:null});
    return out;
  }

  function sourceText(raw){
    return Array.isArray(raw) ? raw.join('\n') : String(raw == null ? '' : raw);
  }

  function splitScoreMeasures(raw){
    return scan(sourceText(raw), false)
      .map(function(segment){ return segment.value.trim(); })
      .filter(Boolean);
  }

  function tokenizeMeasureBeats(text){
    var tokens = [];
    var token = '';
    var square = 0;
    var quoted = false;
    var escaped = false;
    text = String(text || '');

    for (var i = 0; i < text.length; i++){
      var c = text[i];
      if (quoted){
        token += c;
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"'){ quoted = true; token += c; continue; }
      if (c === '[') square++;
      else if (c === ']' && square) square--;

      if (/\s/.test(c) && !square){
        if (token){ tokens.push(token); token = ''; }
      } else token += c;
    }
    if (token) tokens.push(token);
    return tokens;
  }

  function splitBeatSubtokens(token){
    var body = String(token || '').trim();
    if (body.indexOf('/') >= 0) return body.split('/').map(function(part){ return part.trim(); });
    return body ? [body] : [];
  }

  function decodeMeasureLine(line){
    var bars = scan(String(line || ''), true);
    var head = bars.shift();
    var errors = [];
    var text = head.value.trim();
    var chordRaw = null;
    var chordMatch = text.match(/^\[([^\]]*)\]\s*(.*)$/s);
    if (chordMatch){
      chordRaw = chordMatch[1].trim();
      text = chordMatch[2].trim();
    }

    var lyric = '';
    if (bars.length){
      var rawLyric = bars.map(function(segment){ return segment.value; }).join('|').trim();
      if (rawLyric.charAt(0) === '"'){
        try {
          var parsed = JSON.parse(rawLyric);
          if (typeof parsed !== 'string') throw Error('lyric must be string');
          lyric = parsed;
        } catch(e){
          errors.push({code:'INVALID_LYRIC_QUOTE', message:'마디 메모·가사 JSON 문자열의 따옴표, escape 또는 닫힌 뒤 문자를 확인하세요.'});
          lyric = rawLyric;
        }
      } else {
        if (rawLyric) errors.push({code:'INVALID_LYRIC_QUOTE', message:'마디 메모는 큰따옴표 JSON 문자열로 적으세요. 예: | "메모"'});
        lyric = rawLyric;
      }
    }
    return {notation:text, chordRaw:chordRaw, lyric:lyric, errors:errors};
  }

  // 쉼 토큰 판별의 SSOT. 확인 표시가 붙은 r?, 단독 ?도 쉼이다.
  function isRestToken(tok){
    return /^(?:r\??|\?)$/.test(String(tok || '').trim());
  }

  // 슬러(해머링·풀링) 잇기 규칙의 SSOT. 검사·파싱 결과·악보 입력 화면이 같이 쓴다(Docs/score-format.md 슬러).
  // pieces: 시간 순 조각 [{rest, hold, notes:[{str, midi, slur}]}]. 마디를 넘어 이어 본다.
  // 돌려주는 값: 조각마다 notes와 같은 순서의 배열. 슬러가 아닌 음은 null,
  // 슬러 음은 {ok:true, type:'hammer'|'pull', fromMidi} 또는 {ok:false, reason:'no-source'|'same-pitch'}.
  function linkSlurs(pieces){
    var last = Object.create(null); // 줄 번호 → 그 줄에서 마지막으로 친 음의 midi
    return (pieces || []).map(function(piece){
      var notes = piece && Array.isArray(piece.notes) ? piece.notes : [];
      var none = notes.map(function(){ return null; });
      if (piece && piece.rest){
        last = Object.create(null);
        return none;
      }
      if (!piece || piece.hold || !notes.length) return none;
      var results = notes.map(function(note){
        if (!note.slur) return null;
        var from = last[note.str];
        if (from == null) return {ok:false, reason:'no-source'};
        if (from === note.midi) return {ok:false, reason:'same-pitch'};
        return {ok:true, type:note.midi > from ? 'hammer' : 'pull', fromMidi:from};
      });
      notes.forEach(function(note){ last[note.str] = note.midi; });
      return results;
    });
  }

  // 구성음 중 하나라도 ? 로 끝나면 확인 표시가 있는 토큰이다(단독 ? 포함).
  function hasUncertainMark(tok){
    return String(tok || '').trim().split('+').some(function(part){ return part.trim().charAt(part.trim().length - 1) === '?'; });
  }

  function serializeScoreMeasures(measures, separator){
    return (measures || []).map(function(measure){
      var chord = measure.chord || '-';
      var notes = measure.notes || (measure.beats && measure.beats.map(function(beat){ return beat.tok; })) || [];
      if (measure.autoChord && chord !== '-' && !/\?$/.test(chord)) chord += '?';
      var lyric = String(measure.lyric || '');
      return '[' + chord + '] ' + notes.join(' ') + ' | ' + JSON.stringify(lyric);
    }).join(separator == null ? '\n' : separator);
  }

  function validateScore(raw, beats, parseNoteToken){
    var text = sourceText(raw);
    var segments = scan(text, false);
    var lines = segments.map(function(segment){ return segment.value.trim(); }).filter(Boolean);
    var missingBeats = beats == null || (typeof beats === 'string' && beats.trim() === '');
    var numericBeats = missingBeats ? 4 : Number(beats);
    var validBeats = Number.isFinite(numericBeats) && Number.isInteger(numericBeats) && numericBeats >= 1 && numericBeats <= 12;
    var bpb = validBeats ? numericBeats : 4;
    var errors = [];
    var warnings = [];
    var slurPieces = [];
    var slurMeta = [];

    function add(list, code, measure, beat, message){
      list.push({code:code, measure:measure, beat:beat, message:message});
    }

    if (!text.trim()) add(errors, 'EMPTY_SCORE', 1, null, '악보가 비어 있습니다.');
    if (!missingBeats && !validBeats){
      add(errors, 'INVALID_BEATS', 1, null, '박자 수는 1에서 12 사이의 유한한 정수여야 합니다. 미리보기는 4박으로 처리됩니다.');
    }
    segments.forEach(function(segment, index){
      if (segment.separator === '//' && !segment.value.trim()){
        add(errors, 'EMPTY_MEASURE', Math.max(1, index + 1), null, '// 구분자 사이에 비어 있는 마디가 있습니다.');
      }
      if (segment.separator === '//' && segments[index + 1] && !segments[index + 1].value.trim()){
        add(errors, 'EMPTY_MEASURE', index + 2, null, '악보 끝에 // 구분자만 남아 있습니다.');
      }
    });

    lines.forEach(function(line, measureIndex){
      var measureNo = measureIndex + 1;
      var decoded = decodeMeasureLine(line);
      var tokens = tokenizeMeasureBeats(decoded.notation);
      decoded.errors.forEach(function(error){ add(errors, error.code, measureNo, null, error.message); });

      if (/(?:^|\s)\/(?:\s|$)/.test(decoded.notation)){
        add(errors, 'ISOLATED_SLASH', measureNo, null, '음표 영역의 단독 슬래시는 마디 구분자로 사용할 수 없습니다. 박내 분할은 붙여 쓴 / 를 사용하세요.');
      }
      if ((decoded.notation.match(/\(/g) || []).length !== (decoded.notation.match(/\)/g) || []).length ||
          (decoded.notation.match(/\[/g) || []).length !== (decoded.notation.match(/\]/g) || []).length){
        add(errors, 'UNBALANCED_DELIMITER', measureNo, null, '괄호 또는 대괄호가 닫히지 않았습니다.');
      }
      var quoted = false;
      var escaped = false;
      for (var q = 0; q < decoded.notation.length; q++){
        var quoteChar = decoded.notation[q];
        if (quoted){
          if (escaped) escaped = false;
          else if (quoteChar === '\\') escaped = true;
          else if (quoteChar === '"') quoted = false;
        } else if (quoteChar === '"') quoted = true;
      }
      if (quoted) add(errors, 'UNBALANCED_DELIMITER', measureNo, null, '따옴표가 닫히지 않았습니다.');

      if (tokens.length > bpb) add(errors, 'TOO_MANY_BEATS', measureNo, bpb + 1, '마디의 박 수가 설정된 ' + bpb + '박을 초과합니다.');
      if (tokens.length < bpb) add(errors, 'MISSING_BEATS', measureNo, tokens.length + 1, '마디에 ' + (bpb - tokens.length) + '칸이 부족합니다. 누락된 칸을 r 또는 음표로 직접 입력하세요.');

      tokens.forEach(function(token, beatIndex){
        var parts = splitBeatSubtokens(token);
        if (!parts.length || parts.some(function(part){ return !part; })){
          add(errors, 'EMPTY_SUBDIVISION', measureNo, beatIndex + 1, '박 안에 비어 있는 분할 음표가 있습니다.');
        }

        parts.forEach(function(part){
          if (part === '.'){
            add(errors, 'AMBIGUOUS_REST_TOKEN', measureNo, beatIndex + 1, '점(.)은 쉼인지 유지인지 모호합니다. 쉼은 r, 유지는 -로 입력하세요.');
            return;
          }
          if (part === '-'){
            slurPieces.push({rest:false, hold:true, notes:[]});
            slurMeta.push([]);
            return;
          }
          if (isRestToken(part)){
            slurPieces.push({rest:true, hold:false, notes:[]});
            slurMeta.push([]);
            return;
          }
          if (!part) return;
          if (part.indexOf('/') >= 0){
            add(errors, 'ISOLATED_SLASH', measureNo, beatIndex + 1, '박 안의 단독 슬래시 표기를 확인하세요.');
            return;
          }
          var chordParts = part.split('+');
          if (chordParts.some(function(chordPart){ return !chordPart.trim(); })){
            add(errors, 'EMPTY_SUBDIVISION', measureNo, beatIndex + 1, '화음 안에 비어 있는 음표가 있습니다.');
          }
          var components = [];
          chordParts.forEach(function(chordPart){
            chordPart = chordPart.trim();
            if (!chordPart) return;
            var parsed = parseNoteToken ? parseNoteToken(chordPart, measureIndex * bpb + beatIndex) : null;
            var plainChordPart = chordPart.replace(/\?$/, '');
            if (!parsed){
              if (plainChordPart.charAt(0) === '~'){
                add(errors, 'UNKNOWN_NOTE', measureNo, beatIndex + 1, TIRANDO_MARK_REMOVED_MESSAGE);
                return;
              }
              if (plainChordPart.charAt(0) === 'h'){
                add(errors, 'INVALID_HARMONIC', measureNo, beatIndex + 1,
                  '하모닉스는 @줄을 적고, 그 줄의 ' + naturalHarmonicFretsText() + '프렛 자연 하모닉스 음이어야 합니다: ' + chordPart);
                return;
              }
              if (/@\d+(?::[pima])?$/.test(plainChordPart)){
                add(errors, 'INVALID_STRING_OVERRIDE', measureNo, beatIndex + 1, '현 지정 음표를 기타에서 연주할 수 없습니다: ' + chordPart);
              }
              add(errors, 'UNKNOWN_NOTE', measureNo, beatIndex + 1, '알 수 없는 음표 토큰 ' + chordPart + ' 가 있습니다.');
              return;
            }
            if (/@\d+(?::[pima])?$/.test(plainChordPart) && !parsed.pos){
              add(errors, 'INVALID_STRING_OVERRIDE', measureNo, beatIndex + 1, '현 지정 음표를 기타에서 연주할 수 없습니다: ' + chordPart);
            }
            if (!parsed.pos){
              add(errors, 'GUITAR_RANGE', measureNo, beatIndex + 1, '기타에서 연주할 수 없는 음역입니다: ' + chordPart);
            }
            components.push({token:chordPart, note:parsed});
          });
          var explicitStrings = Object.create(null);
          var defaultStrings = Object.create(null);
          components.forEach(function(component){
            var note = component.note;
            if (!note.pos) return;
            var explicit = component.token.indexOf('@') >= 0;
            var map = explicit ? explicitStrings : defaultStrings;
            var stringNo = note.pos.str;
            if (Object.prototype.hasOwnProperty.call(map, stringNo) && (!explicit || map[stringNo] !== note.pos.fret)){
              add(explicit ? errors : warnings,
                explicit ? 'STRING_COLLISION' : 'DEFAULT_STRING_COLLISION', measureNo, beatIndex + 1,
                explicit ? '동시에 지정한 음들이 같은 현에서 다른 프렛을 사용합니다: ' + stringNo + '번 줄.' : '기본 운지 추정에서 같은 현 충돌이 있습니다: ' + stringNo + '번 줄.');
            }
            map[stringNo] = note.pos.fret;
          });
          var slurNotes = [];
          var slurNotesMeta = [];
          components.forEach(function(component){
            if (!component.note.pos) return;
            slurNotes.push({str:component.note.pos.str, midi:component.note.midi, slur:component.note.articulation === 'slur'});
            slurNotesMeta.push({measure:measureNo, beat:beatIndex + 1, token:component.token});
          });
          slurPieces.push({rest:false, hold:false, notes:slurNotes});
          slurMeta.push(slurNotesMeta);
        });
      });
    });
    linkSlurs(slurPieces).forEach(function(results, pieceIndex){
      results.forEach(function(result, noteIndex){
        if (!result || result.ok) return;
        var where = slurMeta[pieceIndex][noteIndex];
        add(errors, 'INVALID_SLUR', where.measure, where.beat, result.reason === 'same-pitch'
          ? '슬러는 다른 높이로 이어져야 합니다. 같은 음을 잇는 붙임줄은 -로 적으세요: ' + where.token
          : '슬러 앞에 같은 줄에서 친 음이 없습니다(쉼 뒤나 곡 처음은 안 됩니다): ' + where.token);
      });
    });
    var rhythmApi = typeof GuitarRhythm !== 'undefined' ? GuitarRhythm : (typeof module !== 'undefined' && module.exports ? require('./rhythm.js') : null);
    if (rhythmApi && lines.length){
      var rhythmMeasures = lines.map(function(line){
        var decoded = decodeMeasureLine(line), tokens = tokenizeMeasureBeats(decoded.notation);
        return {beats:tokens.map(function(token){
          var parts = splitBeatSubtokens(token);
          var parsedParts = parts.map(function(part){
            var parsed = parseNoteToken ? parseNoteToken(part,0) : null;
            return {tok:part,midi:parsed ? parsed.midi : null,
              str:parsed && parsed.pos ? parsed.pos.str : null,
              chordNotes:parsed && parsed.chordNotes ? parsed.chordNotes : null};
          });
          var first = parsedParts[0];
          return {tok:token,isSubdivided:parts.length > 1,subNotes:parts.length > 1 ? parsedParts : undefined,
            midi:first && first.midi,
            str:first && first.str,chordNotes:first && first.chordNotes};
        })};
      });
      rhythmApi.annotate(rhythmMeasures,bpb).errors.forEach(function(error){
        add(errors,error.code,error.measure,error.beat,error.message);
      });
    }
    return {errors:errors, warnings:warnings};
  }

  return {
    splitScoreMeasures:splitScoreMeasures,
    tokenizeMeasureBeats:tokenizeMeasureBeats,
    splitBeatSubtokens:splitBeatSubtokens,
    decodeMeasureLine:decodeMeasureLine,
    serializeScoreMeasures:serializeScoreMeasures,
    isRestToken:isRestToken,
    linkSlurs:linkSlurs,
    hasUncertainMark:hasUncertainMark,
    validateScore:validateScore,
    SHEET_BEAT_COUNTS:SHEET_BEAT_COUNTS,
    MAX_FRET:MAX_FRET,
    NATURAL_HARMONICS:NATURAL_HARMONICS,
    naturalHarmonicFretsText:naturalHarmonicFretsText
  };
});
