'use strict';
var GuitarRhythm = typeof module !== 'undefined' && module.exports ? require('./rhythm.js') : window.GuitarRhythm;
  var NOTE_DUR_SVGS = {
    whole: '<svg class="dur-svg" viewBox="0 0 16 16" width="12" height="12"><ellipse cx="8" cy="8.5" rx="5.5" ry="3.5" transform="rotate(-25 8 8.5)" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    half: '<svg class="dur-svg" viewBox="0 0 14 16" width="10" height="12"><ellipse cx="4.5" cy="11.5" rx="3.3" ry="2.2" transform="rotate(-20 4.5 11.5)" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/></svg>',
    halfDot: '<svg class="dur-svg" viewBox="0 0 16 16" width="12" height="12"><ellipse cx="4.5" cy="11.5" rx="3.3" ry="2.2" transform="rotate(-20 4.5 11.5)" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/><circle cx="12.5" cy="11.5" r="1.3" fill="currentColor"/></svg>',
    quarter: '<svg class="dur-svg" viewBox="0 0 14 16" width="10" height="12"><ellipse cx="4.5" cy="11.5" rx="3.5" ry="2.4" transform="rotate(-20 4.5 11.5)" fill="currentColor"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/></svg>',
    quarterDot: '<svg class="dur-svg" viewBox="0 0 16 16" width="12" height="12"><ellipse cx="4.5" cy="11.5" rx="3.5" ry="2.4" transform="rotate(-20 4.5 11.5)" fill="currentColor"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/><circle cx="12.5" cy="11.5" r="1.3" fill="currentColor"/></svg>',
    eighth: '<svg class="dur-svg" viewBox="0 0 14 16" width="10" height="12"><ellipse cx="4.5" cy="11.5" rx="3.5" ry="2.4" transform="rotate(-20 4.5 11.5)" fill="currentColor"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/><path d="M8 1 C9.5 3.5 12 4.5 13 7.5 C12 6 10.5 5.2 8 5 Z" fill="currentColor"/></svg>',
    restQuarter: '<svg class="dur-svg" viewBox="0 0 10 16" width="8" height="12"><path d="M6 1 L2 6 L6.5 8.5 L1.5 12.5 C2.5 14.5 4.5 14 4.5 14.8 C4.5 15.6 3 15.5 2 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    restEighth: '<svg class="dur-svg" viewBox="0 0 10 16" width="8" height="12"><circle cx="4" cy="5" r="1.6" fill="currentColor"/><path d="M4 4 C6.5 4 7.5 6 7.5 7.5 L5 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
  };

  function getBeatDurationInfo(beats, bIdx, bpb){
    var b = beats[bIdx];
    var Rhythm = GuitarRhythm;
    var grid = Rhythm ? Rhythm.getGridInfo(bpb) : {slotQuarterLength:1};
    function gcd(a,b){ return b ? gcd(b,a % b) : a; }
    function exactSlots(units){
      var divisor = gcd(units,12) || 1;
      return (units/divisor) + (12/divisor === 1 ? '' : '/' + (12/divisor)) + '칸';
    }
    function noteLengthName(note, fallbackUnits){
      var units = Number.isFinite(note && note.durationUnits) ? note.durationUnits : fallbackUnits;
      var noteName = note && (note.en || note.name) || '';
      return (noteName ? noteName + ' ' : '') + exactSlots(units);
    }
    function infoForPart(part){
      var kind = part && part.kind;
      if (kind === 'rest'){
        var restUnits = part.durationUnits;
        var restLength = restUnits / 12 * grid.slotQuarterLength;
        var restSvg = restLength === 1 ? NOTE_DUR_SVGS.restQuarter : (restLength === 0.5 ? NOTE_DUR_SVGS.restEighth : '');
        return {isRest:true,kind:'rest',svg:restSvg,label:'쉼',durName:'쉼'};
      }
      if (kind === 'hold') return {isRest:false,kind:'hold',svg:'',label:'유지',durName:'유지'};
      if (kind === 'invalid' || !part || part.kind !== 'note') return {isRest:false,kind:'invalid',svg:'',label:'오류',durName:'오류'};
      var units = part.durationUnits;
      if (!Number.isFinite(units)) units = part.slotUnits || 12;
      if (Array.isArray(part.chordNotes) && part.chordNotes.length > 1){
        var componentUnits = part.chordNotes.map(function(note){
          return Number.isFinite(note.durationUnits) ? note.durationUnits : units;
        });
        if (componentUnits.some(function(value){ return value !== componentUnits[0]; })){
          return {
            isRest:false,
            kind:'note',
            svg:'',
            label:'음별 길이',
            durName:part.chordNotes.map(function(note){ return noteLengthName(note, units); }).join(' + ')
          };
        }
        units = componentUnits[0];
      }
      var quarterLength = grid.slotQuarterLength * units / 12;
      var entries = [
        [0.125,'32분','32분음표',''],
        [0.25,'16분','16분음표',''],
        [0.5,'8분','8분음표',NOTE_DUR_SVGS.eighth],
        [0.75,'점8분','점8분음표',''],
        [1,'4분','4분음표',NOTE_DUR_SVGS.quarter],
        [1.5,'점4분','점4분음표',NOTE_DUR_SVGS.quarterDot],
        [2,'2분','2분음표',NOTE_DUR_SVGS.half],
        [3,'점2분','점2분음표',NOTE_DUR_SVGS.halfDot],
        [4,'온음','온음표',NOTE_DUR_SVGS.whole]
      ];
      for (var i=0;i<entries.length;i++){
        if (quarterLength === entries[i][0]) return {isRest:false,kind:'note',svg:entries[i][3],label:entries[i][1],durName:entries[i][2]};
      }
      var exact = exactSlots(units);
      return {isRest:false,kind:'note',svg:'',label:exact,durName:exact};
    }
    if (b && b.kind === 'group' && Array.isArray(b.subNotes)){
      var descriptions = b.subNotes.map(function(part){ return infoForPart(part).durName; });
      return {isRest:false,kind:'group',svg:'',label:b.subNotes.length + '분할',durName:descriptions.join(' · ')};
    }
    return infoForPart(b);
  }

  function formatBeatPitchLabel(beat, options){
    var opts = options || {};
    var compact = opts.compact === true;
    var isGroup = !!(beat && beat.kind === 'group' && Array.isArray(beat.subNotes));
    function articulationSuffix(note){
      if (!note || note.explicitArticulation !== true) return '';
      if (note.articulation === 'apoyando') return '!';
      if (note.articulation === 'tirando') return '~';
      return '';
    }
    function formatNote(note, omitOctave){
      if (!note || note.kind === 'invalid') return '오류';
      if (note.kind === 'rest') return '쉼';
      if (note.kind === 'hold') return '유지';
      var name = note.en || '';
      if (omitOctave) name = name.replace(/\d+$/, '');
      return name + articulationSuffix(note);
    }
    function formatPart(part, omitOctave){
      if (!part || part.kind === 'invalid') return '오류';
      if (part.kind === 'rest') return '쉼';
      if (part.kind === 'hold') return '유지';
      if (Array.isArray(part.chordNotes) && part.chordNotes.length){
        return part.chordNotes.map(function(note){ return formatNote(note, omitOctave); }).join('+');
      }
      return formatNote(part, omitOctave);
    }
    if (!beat) return '';
    if (beat.kind === 'invalid') return '오류';
    if (beat.kind === 'rest') return '쉼';
    if (beat.kind === 'hold') return '유지';
    if (isGroup){
      return beat.subNotes.map(function(part){ return formatPart(part, compact); }).join(compact ? '·' : ' · ');
    }
    if (Array.isArray(beat.chordNotes) && beat.chordNotes.length > 2){
      var hasExplicitMark = beat.chordNotes.some(function(note){ return articulationSuffix(note) !== ''; });
      if (compact && !hasExplicitMark && opts.chord) return String(opts.chord);
      return beat.chordNotes.map(function(note){ return formatNote(note, compact); }).join('+');
    }
    return formatPart(beat, false);
  }

  function getUniformBeatArticulation(beat){
    if (!beat) return null;
    var notes = [];
    function collect(part){
      if (!part || part.kind === 'rest' || part.kind === 'hold' || part.kind === 'invalid') return;
      if (Array.isArray(part.chordNotes) && part.chordNotes.length){
        part.chordNotes.forEach(function(note){ collect(note); });
      } else if (part.kind === 'note' || part.midi != null){
        notes.push(part);
      }
    }
    if (beat.kind === 'group' && Array.isArray(beat.subNotes)) beat.subNotes.forEach(collect);
    else collect(beat);
    if (!notes.length || notes.some(function(note){ return note.explicitArticulation !== true; })) return null;
    var articulation = notes[0].articulation;
    if (articulation !== 'apoyando' && articulation !== 'tirando') return null;
    return notes.every(function(note){ return note.articulation === articulation; }) ? articulation : null;
  }



if (typeof module !== 'undefined' && module.exports){ module.exports = { NOTE_DUR_SVGS: NOTE_DUR_SVGS, getBeatDurationInfo: getBeatDurationInfo, formatBeatPitchLabel: formatBeatPitchLabel, getUniformBeatArticulation: getUniformBeatArticulation }; }
