var SLUR_GAIN = 0.6; // 슬러·슬라이드 음은 오른손으로 다시 치지 않아 작게
var APOYANDO_GAIN = 1.16; // 아포얀도는 세게
var ROLL_STEP = 0.04; // 롤(~) 구성음 사이 간격(초)
var ROLL_MAX_SHARE = 0.5; // 롤 전체 퍼짐이 그 조각 길이에서 차지할 수 있는 몫
var SLIDE_GLIDE_SEC = 0.08; // 슬라이드 음이 출발 음 높이에서 제 높이로 미끄러지는 시간(초)
var SLIDE_MAX_SHARE = 0.5; // 미끄럼 시간이 그 음 길이에서 차지할 수 있는 몫

// 주법 이름('apoyando', 'slur', 'slide', 그 밖은 null 포함)에 따른 gain 배율. 연습 화면 재생과 입력 화면 들어보기가 같이 쓴다.
function articulationGain(articulation){
  return articulation === 'apoyando' ? APOYANDO_GAIN : ((articulation === 'slur' || articulation === 'slide') ? SLUR_GAIN : 1.0);
}

// 롤(~): 줄 번호가 큰 음부터 간격을 두고 늦춰 친다(Docs/score-format.md 롤). notes는 { str, midi }를 가진 객체 배열.
// 롤 순서(줄 번호 큰 것 먼저, 같거나 없으면 midi 작은 것, 그다음 원래 순서)대로 [{ note, delay }]를 돌려준다. 음이 둘 미만이면 원래 순서에 delay 0.
function rollDelays(notes, duration){
  var list = (notes || []).slice();
  if (list.length < 2) return list.map(function(note){ return { note:note, delay:0 }; });
  var ordered = list.map(function(note, order){ return { note:note, order:order }; }).sort(function(a, b){
    var sa = Number.isFinite(Number(a.note.str)) ? Number(a.note.str) : null;
    var sb = Number.isFinite(Number(b.note.str)) ? Number(b.note.str) : null;
    if (sa != null && sb != null && sa !== sb) return sb - sa;
    if (a.note.midi !== b.note.midi) return a.note.midi - b.note.midi;
    return a.order - b.order;
  }).map(function(item){ return item.note; });
  var step = Math.min(ROLL_STEP, duration * ROLL_MAX_SHARE / (ordered.length - 1));
  return ordered.map(function(note, order){ return { note:note, delay:order * step }; });
}

function guideParts(beat){
  return beat && Array.isArray(beat.subNotes) && beat.subNotes.length ? beat.subNotes : (beat ? [beat] : []);
}

function guidePartKind(part){
  if (part && part.kind) return part.kind;
  var tok = String(part && part.tok || '').trim();
  var N = typeof GuitarNotation !== 'undefined' ? GuitarNotation : (typeof module !== 'undefined' && module.exports ? require('./notation.js') : null);
  if (N.isSkipToken(tok)) return 'skip';
  if (N.isRestToken(tok)) return 'rest';
  if (tok === '-') return 'hold';
  return part && part.midi != null ? 'note' : 'invalid';
}

function guideNotes(part){
  if (!part) return [];
  if (Array.isArray(part.chordNotes) && part.chordNotes.length) return part.chordNotes;
  return part.midi != null ? [part] : [];
}

function getBeatGuideEvents(beat, options){
  options = options || {};
  var parts = guideParts(beat);
  if (!parts.length) return [];
  var count = parts.length;
  var startTime = Number(options.startTime) || 0;
  var slotDuration = Number(options.slotDuration) || 0;
  if (!(slotDuration > 0)) return [];
  var measures = options.measures;
  var firstKind = guidePartKind(parts[0]);
  if (count === 1 && firstKind === 'skip') return []; // 빈칸 칸은 시간이 없고 소리도 없다
  var annotatedResume = options.resumeHold && firstKind !== 'rest' && beat && Number.isFinite(Number(beat.startUnits)) &&
    typeof GuitarRhythm !== 'undefined' && typeof GuitarRhythm.getSoundingNotes === 'function'
    ? GuitarRhythm.getSoundingNotes(measures, Number(beat.startUnits)) : [];
  var resumeSource = options.resumeHold && !Number.isFinite(Number(beat && beat.startUnits)) && firstKind === 'hold' && typeof GuitarRhythm !== 'undefined'
    ? GuitarRhythm.resolveHold(measures, parts[0]) : null;
  var events = [];

  function pushForPart(part, index, kind, noteSource, struck){
    var offsetSlots = index / count;
    var when = startTime + offsetSlots * slotDuration;
    var slotUnits = Number(part && part.slotUnits) || 12 / count;
    var durationValue = part && part.durationUnits;
    var durationUnits = durationValue == null ? slotUnits : Number(durationValue);
    var duration = durationUnits / 12 * slotDuration;
    if (Number.isFinite(Number(options.maxDurationSlots))){
      var remainingSlots = Math.max(0, Number(options.maxDurationSlots) - offsetSlots);
      duration = Math.min(duration, remainingSlots * slotDuration);
    }
    if (kind === 'rest'){
      events.push({ kind:'rest', when:when, duration:duration });
      return;
    }
    if (kind !== 'note' || duration <= 0) return;
    var playNotes = guideNotes(noteSource).filter(function(note){ return note && note.midi; });
    // 롤(~)이면 rollDelays 순서와 간격으로 친다. 끝 시각은 그대로.
    var timed = struck && noteSource.rolled
      ? rollDelays(playNotes, duration)
      : playNotes.map(function(note){ return { note:note, delay:0 }; });
    timed.forEach(function(item){
      var note = item.note;
      var delay = item.delay;
      var hasChordComponents = Array.isArray(noteSource.chordNotes) && noteSource.chordNotes.length > 0;
      var articulation = hasChordComponents
        ? (note.articulation || null)
        : (note.articulation || noteSource.articulation || part.articulation || null);
      var gain = articulationGain(articulation);
      var event = { kind:'note', note:note, duration:duration - delay, when:when + delay,
        gain:gain, articulation:articulation, str:note.str };
      // 슬라이드: 지금 치는 조각만 출발 음 높이에서 미끄러진다(resume 복원은 미끄러지지 않는다)
      if (struck && articulation === 'slide' && typeof note.slideFromMidi === 'number') event.glideFrom = note.slideFromMidi;
      events.push(event);
    });
  }

  parts.forEach(function(part, index){
    var kind = guidePartKind(part);
    if (kind === 'hold'){
      if (index === 0 && resumeSource){
        var resumeDuration = part.durationUnits == null
          ? (resumeSource.durationUnits == null ? 12 : Number(resumeSource.durationUnits))
          : Number(part.durationUnits);
        var resumePart = { slotUnits:part.slotUnits, durationUnits:resumeDuration };
        pushForPart(resumePart, index, 'note', resumeSource);
      }
      return;
    }
    pushForPart(part, index, kind, part, true);
  });
  annotatedResume.forEach(function(item){
    var note = item.note;
    if (!note || !note.midi || !(item.remainingUnits > 0)) return;
    pushForPart({slotUnits:item.remainingUnits,durationUnits:item.remainingUnits},0,'note',note);
  });
  return events.sort(function(a, b){
    if (a.when !== b.when) return a.when - b.when;
    if (a.kind === b.kind) return 0;
    return a.kind === 'rest' ? -1 : 1;
  });
}

function scheduleBeatGuide(beat, options){
  options = options || {};
  var events = getBeatGuideEvents(beat, options);
  var startTime = Number(options.startTime) || 0;
  var slotDuration = Number(options.slotDuration) || 0;
  var maxDurationSlots = Number(options.maxDurationSlots);
  var hardStopAt = Number.isFinite(maxDurationSlots) ? startTime + maxDurationSlots * slotDuration : undefined;
  events.forEach(function(event){
    if (event.kind === 'rest'){
      stopGuitarNotes(event.when);
      return;
    }
    var midi = soundingMidi(event.note.midi, options.capo);
    var playOptions = { naturalDecay:true, hardStopAt:hardStopAt };
    if (event.glideFrom != null){
      playOptions.glide = { fromMidi:soundingMidi(event.glideFrom, options.capo), sec:Math.min(SLIDE_GLIDE_SEC, event.duration * SLIDE_MAX_SHARE) };
    }
    playGuitarNote(midi, event.duration, event.when, event.gain, event.articulation, event.str, playOptions);
  });
  return events;
}

function getSubdividedGuideEvents(beat, options){
  if (!beat || !beat.subNotes || !beat.subNotes.length) return [];
  options = options || {};
  var subStep = Number(options.subStep) || 0;
  var guideOptions = Object.assign({}, options, {
    slotDuration: subStep * beat.subNotes.length
  });
  return getBeatGuideEvents(beat, guideOptions).filter(function(event){ return event.kind === 'note'; });
}

function scheduleSubdividedGuide(beat, options){
  options = options || {};
  var guideOptions = Object.assign({}, options, {
    slotDuration: (Number(options.subStep) || 0) * (beat && beat.subNotes ? beat.subNotes.length : 0)
  });
  return scheduleBeatGuide(beat, guideOptions);
}
