'use strict';

(function(root, factory){
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LegacyMigration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  function clone(value){ return JSON.parse(JSON.stringify(value)); }
  function migrationNotice(){ return '구형 악보의 빈 칸은 앞 음 유지 또는 시작 쉼으로 변환했어. 변환 결과를 확인해줘.'; }
  function convertSong(record, tabEngine){
    if (!record || typeof record !== 'object') throw new TypeError('악보 레코드가 올바르지 않아.');
    if (record.type !== 'structured' && record.notationVersion === 3) return record;
    if (record.type === 'image' || record.image || record.imageData) throw new Error('이미지 전용 악보는 자동 변환할 수 없어. 원본 이미지는 보존했어.');
    if (!record || !Array.isArray(record.measures) || !record.measures.length) throw new Error('저장된 마디 구조가 없어 변환할 수 없어.');
    if (!tabEngine || typeof tabEngine.parseAlphaTex !== 'function') throw new Error('TabEngine.parseAlphaTex가 준비되지 않았어.');
    var beatsPerBar = Number(record.beats) || 4;
    var eighthGrid = beatsPerBar === 6 || beatsPerBar === 9 || beatsPerBar === 8;
    var numerator = beatsPerBar === 8 ? 4 : beatsPerBar;
    var denominator = beatsPerBar === 6 || beatsPerBar === 9 ? 8 : 4;
    var gridNoteLength = eighthGrid ? 8 : 4;
    var capoMatch = String(record.title || '').concat(' ', String(record.badge || '')).match(/(?:capo|카포)\s*[:.]?\s*(?:fret\s*)?(\d+)/i);
    var capo = capoMatch ? Number(capoMatch[1]) : Number(record.capo) || 0;
    if (!Number.isInteger(capo) || capo < 0 || capo > 12) throw new RangeError('카포는 0~12여야 해.');
    var tempo = Number(record.bpm) || 64;
    var quarterTempo = eighthGrid ? tempo / 2 : tempo;
    var warnings = [migrationNotice()];
    var warningSet = Object.create(null);
    var previousEvent = [];
    function warnOnce(message){ if (!warningSet[message]) { warningSet[message] = true; warnings.push(message); } }

    function getParts(beat){ return Array.isArray(beat && beat.subNotes) ? beat.subNotes : [beat || {}]; }
    function durationValue(partCount){
      var base = gridNoteLength;
      if (partCount === 1) return { value: base, tuplet: '' };
      if (partCount === 2) return { value: base * 2, tuplet: '' };
      if (partCount === 3) return { value: base * 2, tuplet: '{tu 3 2}' };
      if (partCount === 4) return { value: base * 4, tuplet: '' };
      throw new Error('한 박 안에 ' + partCount + '개로 나뉜 음은 alphaTex로 정확히 옮길 수 없어.');
    }
    function pitchNotes(part){ return Array.isArray(part.chordNotes) && part.chordNotes.length ? part.chordNotes : (part.midi == null ? [] : [part]); }
    function parseRawPitch(raw){
      var token = String(raw || '').replace(/^[!>^~]+|[!>^~]+$/g, '').trim();
      var fingerMatch = token.match(/^([0-4])(?=[A-Ga-g])/);
      var finger = fingerMatch ? Number(fingerMatch[1]) : null;
      if (fingerMatch) token = token.slice(1);
      var match = token.match(/^([A-Ga-g])([#b♯♭♮]?)([2-5])?(?:@([1-6]))?$/);
      if (!match) return null;
      var semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      var accidental = match[2].replace('♯', '#').replace('♭', 'b').replace('♮', '');
      return { finger: finger, midi: (Number(match[3] || 4) + 1) * 12 + semitones[match[1].toUpperCase()] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0), string: match[4] ? Number(match[4]) : null };
    }
    function explicitFinger(sourceToken, note, eventNotes){
      var rawTokens = String(sourceToken || '').split('+');
      var matches = [];
      rawTokens.forEach(function(raw){
        var parsed = parseRawPitch(raw);
        if (!parsed) {
          if (/^[!>^~]*[0-4](?=[A-Ga-g가-힣])/.test(String(raw || ''))) warnOnce('원문 손가락 표기를 음/현에 대응할 수 없어 운지를 생략했어.');
          return;
        }
        if (parsed.finger == null) return;
        var candidates = eventNotes.filter(function(candidate){
          return Number(candidate.midi) === parsed.midi && (parsed.string == null || Number(candidate.str) === parsed.string);
        });
        if (!candidates.length) { warnOnce('원문 손가락 표기를 음/현에 대응할 수 없어 운지를 생략했어.'); return; }
        if (candidates.length > 1) { warnOnce('같은 음/현으로 원문 운지를 구분할 수 없어 운지를 생략했어.'); return; }
        if (!candidates.length || candidates[0] !== note) return;
        matches.push(parsed.finger);
      });
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) warnOnce('같은 음/현에 대응하는 원문 운지가 중복돼 운지를 생략했어.');
      return null;
    }
    function oneNoteText(part, isTie, sourceToken, eventNotes){
      if (part.str == null || part.fret == null) return null;
      var finger = explicitFinger(sourceToken, part, eventNotes);
      var text = String(part.fret) + '.' + String(part.str);
      if (isTie) text += '{t}';
      else if (finger >= 1 && finger <= 4) text += '{lf ' + (finger + 1) + '}';
      else if (finger === 0 && Number(part.fret) > 0) warnOnce('구형 0 운지 접두와 프렛 ' + part.fret + '가 모순돼 운지는 생략했어.');
      return text;
    }
    function eventText(notes, tie, sourceToken){
      var rendered = notes.map(function(note){ return oneNoteText(note, tie, sourceToken, notes); }).filter(Boolean);
      if (!rendered.length) return 'r';
      return rendered.length === 1 ? rendered[0] : '(' + rendered.join(' ') + ')';
    }
    var bars = record.measures.map(function(measure, measureIndex){
      var entries = [];
      (measure.beats || []).forEach(function(beat){
        var parts = getParts(beat);
        var partDuration = durationValue(parts.length);
        parts.forEach(function(part){
          var dur = partDuration;
          if (!pitchNotes(part).length) {
            if (!previousEvent.length) { entries.push('r.' + dur.value + dur.tuplet); warnOnce('마디 ' + (measureIndex + 1) + '의 시작 빈 칸을 쉼표로 변환했어.'); return; }
            entries.push(eventText(previousEvent, true, null) + '.' + dur.value + dur.tuplet);
            return;
          }
          var notes = pitchNotes(part);
          var sourceToken = parts.length > 1 ? part.tok : beat.tok;
          var token = eventText(notes, false, sourceToken);
          entries.push(token + '.' + dur.value + dur.tuplet);
          previousEvent = notes.map(function(note){ return { midi: note.midi, str: note.str, fret: note.fret, tok: note.tok }; });
        });
      });
      return entries.join(' ');
    });
    var alphaTex = '\\title ' + JSON.stringify(record.title || '이름 없는 악보') + ' \\tempo ' + quarterTempo + ' \\ts (' + numerator + ' ' + denominator + ')';
    if (capo > 0) alphaTex += ' \\capo ' + capo;
    alphaTex += ' ' + bars.join(' | ');
    var converted = {
      id: record.id, title: record.title, badge: record.badge || '', description: record.description || '',
      format: 'alphatex', alphaTex: alphaTex, notationVersion: 3,
      builtin: !!record.builtin, fromSheet: !!record.fromSheet, legacyOriginal: clone(record), warnings: warnings
    };
    var score = tabEngine.parseAlphaTex(alphaTex);
    var actualBars = score.tracks[0].staves[0].bars;
    if (actualBars.length !== bars.length) throw new Error('변환 결과 마디 수가 달라: ' + bars.length + ' -> ' + actualBars.length);
    actualBars.forEach(function(bar, index){
      var beats = bar.voices[0].beats;
      var targetDuration = beatsPerBar * (gridNoteLength === 8 ? 480 : 960);
      var actualDuration = beats.reduce(function(sum, beat){ return sum + beat.playbackDuration; }, 0);
      if (actualDuration !== targetDuration) throw new Error('마디 ' + (index + 1) + ' 재생 길이가 달라: ' + targetDuration + ' -> ' + actualDuration);
      var oldBeats = record.measures[index].beats || [];
      var oldNotes = oldBeats.flatMap(getParts).flatMap(pitchNotes);
      var newNotes = beats.flatMap(function(beat){ return beat.notes || []; }).filter(function(note){ return !note.isTieDestination; });
      if (oldNotes.length !== newNotes.length) throw new Error('마디 ' + (index + 1) + ' 음표 수가 달라: ' + oldNotes.length + ' -> ' + newNotes.length);
      oldNotes.forEach(function(oldNote, noteIndex){
        var next = newNotes[noteIndex];
        if (7 - Number(oldNote.str) !== Number(next.string) || Number(oldNote.fret) !== Number(next.fret)) throw new Error('마디 ' + (index + 1) + ' 음의 현/프렛이 달라.');
        var oldPitch = Number(oldNote.midi) + capo;
        if (oldPitch !== Number(next.realValue)) throw new Error('마디 ' + (index + 1) + ' 음높이가 달라.');
      });
    });
    return converted;
  }
  return { convertSong: convertSong };
});
