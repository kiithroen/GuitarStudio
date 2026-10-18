(function(root, factory){
  'use strict';
  var isCommonJs = typeof module !== 'undefined' && module.exports;
  var api = factory(
    isCommonJs ? require('./notation.js') : root.GuitarNotation,
    isCommonJs ? require('./parser.js') : root.GuitarParser
  );
  if (isCommonJs) module.exports = api;
  else root.GuitarNotationMigration = api;
})(typeof window !== 'undefined' ? window : globalThis, function(Notation, Parser){
  'use strict';

  var SUPPORTED_BEATS = [2, 3, 4, 6, 8, 9];

  function splitLegacyBars(text, warnings){
    var bars = [];
    var start = 0;
    var square = 0;
    var paren = 0;
    var quoted = false;
    var escaped = false;
    var inLyric = false;

    for (var i = 0; i < text.length; i++){
      var character = text[i];
      if (quoted){
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"'){ quoted = true; continue; }
      if (character === '[') square++;
      else if (character === ']' && square) square--;
      else if (character === '(') paren++;
      else if (character === ')' && paren) paren--;

      if (!square && !paren && character === '|') inLyric = true;
      if (!square && !paren && character === '/' && text[i - 1] === ' ' && text[i + 1] === ' '){
        var remaining = text.slice(i + 2).trim();
        if (!inLyric || /^\[[^\]]+\]/.test(remaining)){
          bars.push(text.slice(start, i).trim());
          start = i + 1;
          inLyric = false;
        } else {
          warnings.push({
            code:'AMBIGUOUS_LEGACY_SLASH',
            measure:bars.length + 1,
            beat:null,
            message:'가사 뒤의 구형 마디 슬래시를 확정할 수 없어 그대로 보존했어.'
          });
        }
      }
      if (character === '\n' || character === '\r'){
        bars.push(text.slice(start, i).trim());
        if (character === '\r' && text[i + 1] === '\n') i++;
        start = i + 1;
        inLyric = false;
      }
    }
    bars.push(text.slice(start).trim());
    return bars.filter(Boolean);
  }

  function addMetadataErrors(result, metadata){
    var beatValue = Number(metadata.beats);
    var bpmValue = Number(metadata.bpm);
    if (!/^(2|3|4|6|8|9)$/.test(String(metadata.beats).trim()) || SUPPORTED_BEATS.indexOf(beatValue) < 0){
      result.errors.push({code:'INVALID_METADATA_BEATS', measure:null, beat:null, message:'TSV 박자는 2, 3, 4, 6, 8, 9 중 하나여야 해.'});
    }
    if (!/^\d+$/.test(String(metadata.bpm).trim()) || !Number.isFinite(bpmValue) || bpmValue < 1){
      result.errors.push({code:'INVALID_METADATA_BPM', measure:null, beat:null, message:'TSV BPM은 1 이상의 정수여야 해.'});
    }
    result.title = metadata.title;
    result.beats = beatValue;
    result.bpm = bpmValue;
    result.badge = metadata.badge;
  }

  function convertLegacyScoreText(raw, beats){
    var input = String(raw == null ? '' : raw);
    var columns = input.split('\t');
    var metadata = columns.length === 5 ? {
      title:columns[0], beats:columns[1], bpm:columns[2], badge:columns[3]
    } : null;
    var result = {text:'', errors:[], warnings:[]};
    if (metadata){
      input = columns[4];
      addMetadataErrors(result, metadata);
    }

    var measures = [];
    splitLegacyBars(input, result.warnings).forEach(function(line){
      var decoded = Notation.decodeMeasureLine(line);
      var rawChord = decoded.chordRaw || '-';
      var autoChord = /\?$|\(자동\)|\(추정\)/.test(rawChord);
      var chord = rawChord.replace(/\s*\(자동\)|\s*\(추정\)|\?+$/g, '').trim() || '-';
      measures.push({
        chord:chord,
        autoChord:autoChord,
        notes:Notation.tokenizeMeasureBeats(decoded.notation),
        lyric:decoded.lyric
      });
      decoded.errors.forEach(function(error){ result.errors.push(error); });
    });

    result.text = Notation.serializeScoreMeasures(measures, '\n');
    var validationBeats = metadata ? (SUPPORTED_BEATS.indexOf(Number(metadata.beats)) >= 0 ? Number(metadata.beats) : 4) : (Number(beats) || 4);
    var validation = Parser.validateScore(result.text, validationBeats);
    result.errors = result.errors.concat(validation.errors);
    result.warnings = result.warnings.concat(validation.warnings);
    if (metadata){
      var sheetScore = Notation.serializeScoreMeasures(measures, ' // ');
      result.tsv = [metadata.title, metadata.beats, metadata.bpm, metadata.badge, sheetScore].join('\t');
    }
    return result;
  }

  return {convertLegacyScoreText:convertLegacyScoreText};
});
