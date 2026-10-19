(function(root, factory){
  'use strict';
  var parser = typeof module !== 'undefined' && module.exports
    ? require('./parser.js')
    : root.GuitarParser;
  var createScoreDraftStore = factory(parser);
  if (typeof module !== 'undefined' && module.exports) module.exports = {createScoreDraftStore:createScoreDraftStore};
  else root.createScoreDraftStore = createScoreDraftStore;
})(typeof window !== 'undefined' ? window : globalThis, function(parser){
  'use strict';

  function cloneValue(value, seen){
    if (value == null || typeof value !== 'object') return value;
    seen = seen || new Map();
    if (seen.has(value)) return seen.get(value);
    var copy = Array.isArray(value) ? [] : {};
    seen.set(value, copy);
    Object.keys(value).forEach(function(key){ copy[key] = cloneValue(value[key], seen); });
    return copy;
  }

  function createScoreDraftStore(){
    if (!parser || typeof parser.parseScore !== 'function' || typeof parser.serializeScoreMeasures !== 'function' ||
        typeof parser.splitScoreMeasures !== 'function') throw new Error('GuitarParser must be loaded before creating a score draft store.');

    var entries = new Map();
    var nextTemporaryId = 1;

    function canonicalScore(song){
      return parser.serializeScoreMeasures(song && song.measures || []);
    }

    function beatsFor(song){
      return song && song.beats != null ? song.beats : 4;
    }

    function restMeasureScore(beats){
      var missingBeats = beats == null || (typeof beats === 'string' && beats.trim() === '');
      var numericBeats = missingBeats ? 4 : Number(beats);
      if (!Number.isFinite(numericBeats) || !Number.isInteger(numericBeats) || numericBeats < 1 || numericBeats > 12){
        var invalid = parser.parseScore('[-] r', beats).errors.filter(function(error){ return error.code === 'INVALID_BEATS'; });
        throw draftError(invalid);
      }
      var parsed = parser.parseScore('[-] ' + Array(numericBeats).fill('r').join(' '), numericBeats);
      if (parsed.errors.length) throw draftError(parsed.errors);
      return parsed;
    }

    function snapshotSource(song){
      return cloneValue(song);
    }

    function draftError(errors){
      var list = Array.isArray(errors) && errors.length ? errors : [{
        code:'INVALID_SCORE_EDIT', measure:1, beat:null, message:'악보를 적용할 수 없어.'
      }];
      var first = list[0];
      var position = [];
      if (first.measure != null) position.push('마디 ' + first.measure);
      if (first.beat != null) position.push('박 ' + first.beat);
      var message = first.message || '악보를 적용할 수 없어.';
      if (position.length) message += ' (' + position.join(', ') + ')';
      var error = new Error(message);
      error.errors = cloneValue(list);
      return error;
    }

    function stateFor(song){
      return {
        song:cloneValue(song),
        original:cloneValue(song),
        originalCanonical:canonicalScore(song),
        undoSnapshot:null,
        temporary:false,
        origin:null
      };
    }

    function isDirty(state){ return canonicalScore(state.song) !== state.originalCanonical; }

    function status(id){
      var state = entries.get(id);
      if (!state) return {dirty:false,temporary:false,canUndo:false,origin:null};
      return {dirty:isDirty(state),temporary:state.temporary,canUndo:!!state.undoSnapshot,origin:state.origin};
    }

    function get(id){
      var state = entries.get(id);
      return state ? state.song : null;
    }

    function list(sources){
      sources = Array.isArray(sources) ? sources : [];
      var result = [];
      var present = new Set();
      sources.forEach(function(source){
        if (!source || source.type !== 'structured'){
          result.push(source);
          return;
        }
        var id = source.id;
        present.add(id);
        var state = entries.get(id);
        if (!state){
          state = stateFor(snapshotSource(source));
          entries.set(id, state);
        } else if (!isDirty(state)){
          var refreshed = snapshotSource(source);
          if (canonicalScore(state.original) !== canonicalScore(refreshed)) state.undoSnapshot = null;
          state.song = cloneValue(refreshed);
          state.original = cloneValue(refreshed);
          state.originalCanonical = canonicalScore(refreshed);
        }
        result.push(state.song);
      });

      entries.forEach(function(state, id){
        if (present.has(id)) return;
        if (state.temporary || isDirty(state)) result.push(state.song);
      });
      return result;
    }

    function createBlank(spec){
      spec = spec || {};
      var beats = spec.beats == null ? 4 : spec.beats;
      var parsed = restMeasureScore(beats);
      var id;
      do { id = 'temp-score-' + nextTemporaryId++; }
      while (entries.has(id));
      var song = {
        id:id,
        title:spec.title,
        badge:'임시 악보',
        type:'structured',
        builtin:false,
        capo:0,
        beats:parsed.beats,
        bpm:spec.bpm,
        measures:cloneValue(parsed.measures),
        notationVersion:2
      };
      var state = stateFor(song);
      state.temporary = true;
      entries.set(id, state);
      return state.song;
    }

    function createFromScore(spec){
      spec = spec || {};
      var text = Array.isArray(spec.lines) ? spec.lines.join('\n') : String(spec.lines == null ? '' : spec.lines);
      var parsed = parser.parseScore(text, spec.beats);
      if (parsed.errors.length) throw draftError(parsed.errors);
      var id;
      do { id = 'temp-score-' + nextTemporaryId++; }
      while (entries.has(id));
      var song = {
        id:id,
        title:spec.title,
        badge:spec.badge || '임시 악보',
        type:'structured',
        builtin:false,
        capo:0,
        beats:parsed.beats,
        bpm:spec.bpm,
        measures:cloneValue(parsed.measures),
        notationVersion:2
      };
      var state = stateFor(song);
      state.temporary = true;
      state.origin = spec.origin || null;
      entries.set(id, state);
      return state.song;
    }

    function requireState(id, index){
      var state = entries.get(id);
      if (!state) throw draftError([{code:'UNKNOWN_DRAFT',measure:1,beat:null,message:'등록된 악보 작업본이 없어.'}]);
      if (!Number.isInteger(index) || index < 0 || index >= state.song.measures.length){
        throw draftError([{code:'INVALID_MEASURE_INDEX',measure:Number.isInteger(index) && index >= 0 ? index + 1 : 1,beat:null,message:'편집할 마디 위치가 올바르지 않아.'}]);
      }
      return state;
    }

    function currentLines(song){
      return parser.splitScoreMeasures(parser.serializeScoreMeasures(song.measures));
    }

    function commitCandidate(state, candidateLines){
      var parsed = parser.parseScore(candidateLines.join('\n'), beatsFor(state.song));
      if (parsed.errors.length) throw draftError(parsed.errors);
      var previous = cloneValue(state.song);
      var next = cloneValue(state.song);
      next.measures = cloneValue(parsed.measures);
      state.undoSnapshot = previous;
      state.song = next;
      return state.song;
    }

    function apply(id, index, text, insert){
      var state = requireState(id, index);
      var measureText = text == null ? '' : String(text).trim();
      var measureLines = parser.splitScoreMeasures(measureText);
      if (measureLines.length !== 1){
        throw draftError([{code:'ONE_MEASURE_REQUIRED',measure:index + 1,beat:null,message:'한 마디 텍스트만 적용할 수 있어.'}]);
      }
      var lines = currentLines(state.song);
      if (insert) lines.splice(index + 1, 0, measureText);
      else lines[index] = measureText;
      return commitCandidate(state, lines);
    }

    function remove(id, index){
      var state = requireState(id, index);
      if (state.song.measures.length <= 1){
        throw draftError([{code:'LAST_MEASURE',measure:index + 1,beat:null,message:'마지막 한 마디는 삭제할 수 없어.'}]);
      }
      var lines = currentLines(state.song);
      lines.splice(index, 1);
      return commitCandidate(state, lines);
    }

    function undo(id){
      var state = entries.get(id);
      if (!state || !state.undoSnapshot) return state ? state.song : null;
      var previous = cloneValue(state.undoSnapshot);
      state.undoSnapshot = null;
      state.song = previous;
      return state.song;
    }

    function reset(id){
      var state = entries.get(id);
      if (!state) return null;
      state.undoSnapshot = cloneValue(state.song);
      state.song = cloneValue(state.original);
      return state.song;
    }

    return {list:list,get:get,status:status,createBlank:createBlank,createFromScore:createFromScore,apply:apply,remove:remove,undo:undo,reset:reset};
  }

  return createScoreDraftStore;
});
