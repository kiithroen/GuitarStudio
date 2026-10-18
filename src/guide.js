function getSubdividedGuideEvents(beat, options){
  if (!beat || !beat.subNotes || !beat.subNotes.length) return [];
  options = options || {};
  var noteCount = beat.subNotes.length;
  var subStep = Number(options.subStep) || 0;
  var startTime = Number(options.startTime) || 0;
  var preview = !!options.preview;
  var beatsPerBar = Number(options.beatsPerBar) || 4;
  var beatDuration = subStep * noteCount;
  var bassDuration = preview ? 1.25 : beatDuration * ((beatsPerBar === 6 || beatsPerBar === 9) ? 8.2 : 2.2);

  var events = [];
  function addEvent(note, duration, when, gain, articulation, str){
    if (!note || !note.midi) return;
    events.push({ note: note, duration: duration, when: when, gain: gain, articulation: articulation, str: str });
  }

  beat.subNotes.forEach(function(note, noteIndex){
    if (!note || note.tok === '-' || note.midi == null) return;
    var noteTime = startTime + noteIndex * subStep;
    var melDuration = preview ? 0.75 : subStep * 1.5;
    var articulation = note.articulation || beat.articulation;
    var melodyGain = preview ? 1.0 : (articulation === 'apoyando' ? 1.16 : 1.0);

    if (note.chordNotes && note.chordNotes.length > 2){
      var rollStep = Math.min(0.028, subStep / (note.chordNotes.length + 1));
      note.chordNotes.forEach(function(chordNote, chordIndex){
        var isBass = chordIndex === 0;
        addEvent(chordNote, isBass ? bassDuration : melDuration, noteTime + chordIndex * rollStep, isBass ? 1.12 : 1.0, chordNote.articulation || articulation, chordNote.str);
      });
      return;
    }

    if (note.chordNotes && note.chordNotes.length === 2){
      var explicitBass = getExplicitBass(note);
      if (explicitBass){
        addEvent(explicitBass, bassDuration, noteTime, 1.12, null, explicitBass.str);
      }
    }

    addEvent(note, melDuration, noteTime, melodyGain, articulation, note.str);
  });

  return events;
}

function scheduleSubdividedGuide(beat, options){
  options = options || {};
  getSubdividedGuideEvents(beat, options).forEach(function(event){
    playGuitarNote(soundingMidi(event.note.midi, options.capo), event.duration, event.when, event.gain, event.articulation, event.str);
  });
}
