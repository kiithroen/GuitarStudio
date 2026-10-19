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

    function snapshotSource(song){
      return cloneValue(song);
    }

    function draftError(errors){
      var list = Array.isArray(errors) && errors.length ? errors : [{
        code:'INVALID_SCORE_EDIT', measure:1, beat:null, message:'악보를 적용할 수 없습니다.'
      }];
      var first = list[0];
      var position = [];
      if (first.measure != null) position.push('마디 ' + first.measure);
      if (first.beat != null) position.push('박 ' + first.beat);
      var message = first.message || '악보를 적용할 수 없습니다.';
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
        temporary:false,
        origin:null
      };
    }

    // 조표 없음(key 없음)과 key 0은 같은 것으로 본다.
    function keyOf(song){ return Number.isInteger(song && song.key) ? song.key : 0; }

    function isDirty(state){
      return canonicalScore(state.song) !== state.originalCanonical || keyOf(state.song) !== keyOf(state.original) ||
        parser.getSongCapo(state.song) !== parser.getSongCapo(state.original);
    }

    function status(id){
      var state = entries.get(id);
      if (!state) return {dirty:false,temporary:false,origin:null};
      return {dirty:isDirty(state),temporary:state.temporary,origin:state.origin};
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
      if (Number.isInteger(spec.key) && spec.key >= -5 && spec.key <= 5) song.key = spec.key;
      var state = stateFor(song);
      state.temporary = true;
      state.origin = spec.origin || null;
      entries.set(id, state);
      return state.song;
    }

    // 원래 곡(source)의 수정 초안을 만든다. 마디(와 조표)만 바꾸고 제목·BPM·배지는 원래 곡 그대로 둔다. opts.capo 가 있으면 제목·배지의 카포 표기만 그 값으로 맞춘다.
    // 읽을 수 없는 줄이면 아무것도 바꾸지 않고 던진다.
    function replaceScore(source, lines, opts){
      opts = opts || {};
      if (!source || source.type !== 'structured') throw draftError([{code:'UNKNOWN_DRAFT',measure:1,beat:null,message:'고칠 원래 악보가 없습니다.'}]);
      var text = Array.isArray(lines) ? lines.join('\n') : String(lines == null ? '' : lines);
      var parsed = parser.parseScore(text, source.beats);
      if (parsed.errors.length) throw draftError(parsed.errors);
      var state = entries.get(source.id);
      if (!state){
        state = stateFor(snapshotSource(source));
        entries.set(source.id, state);
      }
      var next = cloneValue(state.song);
      next.measures = cloneValue(parsed.measures);
      if (Number.isInteger(opts.key) && opts.key >= -5 && opts.key <= 5) next.key = opts.key;
      else delete next.key;
      if (Number.isInteger(opts.capo) && opts.capo >= 0 && opts.capo <= 12){
        var capoText = parser.setSongCapoText({title:next.title, badge:next.badge}, opts.capo);
        next.title = capoText.title;
        next.badge = capoText.badge;
        next.capo = opts.capo;
      }
      state.song = next;
      state.origin = opts.origin || null;
      return state.song;
    }

    function reset(id){
      var state = entries.get(id);
      if (!state) return null;
      state.song = cloneValue(state.original);
      state.origin = null;
      return state.song;
    }

    return {list:list,get:get,status:status,createFromScore:createFromScore,replaceScore:replaceScore,reset:reset};
  }

  return createScoreDraftStore;
});
