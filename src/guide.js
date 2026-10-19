function guideParts(beat){
  return beat && Array.isArray(beat.subNotes) && beat.subNotes.length ? beat.subNotes : (beat ? [beat] : []);
}

function guidePartKind(part){
  if (part && part.kind) return part.kind;
  var tok = String(part && part.tok || '').trim();
  var N = typeof GuitarNotation !== 'undefined' ? GuitarNotation : (typeof module !== 'undefined' && module.exports ? require('./notation.js') : null);
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
  var annotatedResume = options.resumeHold && firstKind !== 'rest' && beat && Number.isFinite(Number(beat.startUnits)) &&
    typeof GuitarRhythm !== 'undefined' && typeof GuitarRhythm.getSoundingNotes === 'function'
    ? GuitarRhythm.getSoundingNotes(measures, Number(beat.startUnits)) : [];
  var resumeSource = options.resumeHold && !Number.isFinite(Number(beat && beat.startUnits)) && firstKind === 'hold' && typeof GuitarRhythm !== 'undefined'
    ? GuitarRhythm.resolveHold(measures, parts[0]) : null;
  var events = [];

  function pushForPart(part, index, kind, noteSource){
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
    guideNotes(noteSource).forEach(function(note){
      if (!note || !note.midi) return;
      var hasChordComponents = Array.isArray(noteSource.chordNotes) && noteSource.chordNotes.length > 0;
      var articulation = hasChordComponents
        ? (note.articulation || null)
        : (note.articulation || noteSource.articulation || part.articulation || null);
      var gain = articulation === 'apoyando' ? 1.16 : 1.0;
      events.push({ kind:'note', note:note, duration:duration, when:when,
        gain:gain, articulation:articulation, str:note.str });
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
    pushForPart(part, index, kind, part);
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
    playGuitarNote(midi, event.duration, event.when, event.gain, event.articulation, event.str, { naturalDecay:true, hardStopAt:hardStopAt });
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
