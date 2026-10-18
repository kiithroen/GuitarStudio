(function(root, factory){
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuitarNotation = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';

  function scan(text, splitBars){
    var out = [];
    var start = 0;
    var square = 0;
    var paren = 0;
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
      else if (c === '(') paren++;
      else if (c === ')' && paren) paren--;

      if (square || paren) continue;
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
    var paren = 0;
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
      else if (c === '(') paren++;
      else if (c === ')' && paren) paren--;

      if (/\s/.test(c) && !square && !paren){
        if (token){ tokens.push(token); token = ''; }
      } else token += c;
    }
    if (token) tokens.push(token);
    return tokens;
  }

  function splitBeatSubtokens(token){
    var body = String(token || '').trim();
    if (body.charAt(0) === '(' && body.charAt(body.length - 1) === ')'){
      body = body.slice(1, -1).trim();
    }
    if (body.indexOf('/') >= 0) return body.split('/').map(function(part){ return part.trim(); });
    if (body.indexOf(',') >= 0) return body.split(',').map(function(part){ return part.trim(); });
    return body ? body.split(/\s+/).map(function(part){ return part.trim(); }) : [];
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
          errors.push({code:'INVALID_LYRIC_QUOTE', message:'마디 메모·가사 JSON 문자열의 따옴표, escape 또는 닫힌 뒤 문자를 확인해줘.'});
          lyric = rawLyric;
        }
      } else lyric = rawLyric;
    }
    return {notation:text, chordRaw:chordRaw, lyric:lyric, errors:errors};
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

    function add(list, code, measure, beat, message){
      list.push({code:code, measure:measure, beat:beat, message:message});
    }

    if (!text.trim()) add(errors, 'EMPTY_SCORE', 1, null, '악보가 비어 있어.');
    if (!missingBeats && !validBeats){
      add(errors, 'INVALID_BEATS', 1, null, '박자 수는 1에서 12 사이의 유한한 정수여야 해. 미리보기는 4박으로 처리돼.');
    }
    segments.forEach(function(segment, index){
      if (segment.separator === '//' && !segment.value.trim()){
        add(errors, 'EMPTY_MEASURE', Math.max(1, index + 1), null, '// 구분자 사이에 비어 있는 마디가 있어.');
      }
      if (segment.separator === '//' && segments[index + 1] && !segments[index + 1].value.trim()){
        add(errors, 'EMPTY_MEASURE', index + 2, null, '악보 끝에 // 구분자만 남아 있어.');
      }
    });

    lines.forEach(function(line, measureIndex){
      var measureNo = measureIndex + 1;
      var decoded = decodeMeasureLine(line);
      var tokens = tokenizeMeasureBeats(decoded.notation);
      decoded.errors.forEach(function(error){ add(errors, error.code, measureNo, null, error.message); });

      if (/(?:^|\s)\/(?:\s|$)/.test(decoded.notation)){
        add(errors, 'ISOLATED_SLASH', measureNo, null, '음표 영역의 단독 슬래시는 마디 구분자로 사용할 수 없어. 박내 분할은 붙여 쓴 / 를 사용해줘.');
      }
      if ((decoded.notation.match(/\(/g) || []).length !== (decoded.notation.match(/\)/g) || []).length ||
          (decoded.notation.match(/\[/g) || []).length !== (decoded.notation.match(/\]/g) || []).length){
        add(errors, 'UNBALANCED_DELIMITER', measureNo, null, '괄호 또는 대괄호가 닫히지 않았어.');
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
      if (quoted) add(errors, 'UNBALANCED_DELIMITER', measureNo, null, '따옴표가 닫히지 않았어.');

      if (tokens.length > bpb) add(errors, 'TOO_MANY_BEATS', measureNo, bpb + 1, '마디의 박 수가 설정된 ' + bpb + '박을 초과해.');
      if (tokens.length < bpb) add(errors, 'MISSING_BEATS', measureNo, tokens.length + 1, '마디에 ' + (bpb - tokens.length) + '칸이 부족해. 누락된 칸을 r 또는 음표로 직접 입력해줘.');

      tokens.forEach(function(token, beatIndex){
        var parts = splitBeatSubtokens(token);
        if (!parts.length || parts.some(function(part){ return !part; })){
          add(errors, 'EMPTY_SUBDIVISION', measureNo, beatIndex + 1, '박 안에 비어 있는 분할 음표가 있어.');
        }

        parts.forEach(function(part){
          if (part === '.'){
            add(errors, 'AMBIGUOUS_REST_TOKEN', measureNo, beatIndex + 1, '점(.)은 쉼인지 유지인지 모호해. 쉼은 r, 유지는 -로 입력해줘.');
            return;
          }
          if (!part || /^(-|R|r)$/.test(part)) return;
          if (part.indexOf('/') >= 0){
            add(errors, 'ISOLATED_SLASH', measureNo, beatIndex + 1, '박 안의 단독 슬래시 표기를 확인해줘.');
            return;
          }
          var chordParts = part.split('+');
          if (chordParts.some(function(chordPart){ return !chordPart.trim(); })){
            add(errors, 'EMPTY_SUBDIVISION', measureNo, beatIndex + 1, '화음 안에 비어 있는 음표가 있어.');
          }
          var components = [];
          chordParts.forEach(function(chordPart){
            chordPart = chordPart.trim();
            if (!chordPart) return;
            var parsed = parseNoteToken ? parseNoteToken(chordPart, measureIndex * bpb + beatIndex) : null;
            if (!parsed){
              if (/@\d+(?::[pima])?$/.test(chordPart)){
                add(errors, 'INVALID_STRING_OVERRIDE', measureNo, beatIndex + 1, '현 지정 음표를 기타에서 연주할 수 없어: ' + chordPart);
              }
              add(errors, 'UNKNOWN_NOTE', measureNo, beatIndex + 1, '알 수 없는 음표 토큰 ' + chordPart + ' 가 있어.');
              return;
            }
            if (/@\d+(?::[pima])?$/.test(chordPart) && !parsed.pos){
              add(errors, 'INVALID_STRING_OVERRIDE', measureNo, beatIndex + 1, '현 지정 음표를 기타에서 연주할 수 없어: ' + chordPart);
            }
            if (!parsed.pos){
              add(errors, 'GUITAR_RANGE', measureNo, beatIndex + 1, '기타에서 연주할 수 없는 음역이야: ' + chordPart);
            }
            if (/^[!~]?[A-Ga-g][#b♯♭♮]?(?::[pima])?$/.test(chordPart)){
              add(warnings, 'AMBIGUOUS_OCTAVE', measureNo, beatIndex + 1, '옥타브가 생략된 음표 ' + chordPart + ' 는 기본 옥타브 4로 해석돼.');
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
                explicit ? '동시에 지정한 음들이 같은 현에서 다른 프렛을 사용해: ' + stringNo + '번 줄.' : '기본 운지 추정에서 같은 현 충돌이 있어: ' + stringNo + '번 줄.');
            }
            map[stringNo] = note.pos.fret;
          });
        });
      });
    });
    var rhythmApi = typeof GuitarRhythm !== 'undefined' ? GuitarRhythm : (typeof module !== 'undefined' && module.exports ? require('./rhythm.js') : null);
    if (rhythmApi && lines.length){
      var rhythmMeasures = lines.map(function(line){
        var decoded = decodeMeasureLine(line), tokens = tokenizeMeasureBeats(decoded.notation);
        return {beats:tokens.map(function(token){
          var parts = splitBeatSubtokens(token);
          var parsedParts = parts.map(function(part){ return {tok:part,midi:parseNoteToken ? (parseNoteToken(part,0)||{}).midi : null}; });
          return {tok:token,isSubdivided:parts.length > 1,subNotes:parts.length > 1 ? parsedParts : undefined,midi:parsedParts[0] && parsedParts[0].midi};
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
    validateScore:validateScore
  };
});
