'use strict';

var RIGHT_HAND_NAMES = { p: '엄지', i: '검지', m: '중지', a: '약지' };

function appendExplicitRightHand(parent, token, componentIndex){
  var finger = getExplicitRightHand(token, componentIndex);
  if (!finger) return;
  var span = document.createElement('span');
  span.className = 'tab-note-rh';
  span.textContent = finger;
  span.title = '오른손 ' + finger + ' (' + RIGHT_HAND_NAMES[finger] + ')';
  parent.appendChild(span);
}

function formatChordRightHandLabel(token, notes){
  return (notes || []).map(function(note, index){
    var finger = getExplicitRightHand(token, index);
    return (note.str || '?') + '줄 ' + (finger || '미지정');
  }).join(' + ');
}

function getBeatRightHandLabel(beat){
  if (!beat) return '';
  if (beat.isSubdivided && beat.subNotes){
    var hasExplicit = false;
    var labels = beat.subNotes.map(function(part){
      if (part.kind === 'rest' || part.kind === 'hold' || !part.midi && !(part.chordNotes && part.chordNotes.length)) return '-';
      var token = part.tok || part.customTok || part.en;
      if (part.chordNotes && part.chordNotes.length >= 2){
        var chordHasExplicit = part.chordNotes.some(function(note, index){ return !!getExplicitRightHand(token, index); });
        hasExplicit = hasExplicit || chordHasExplicit;
        return chordHasExplicit ? formatChordRightHandLabel(token, part.chordNotes) : '-';
      }
      var finger = getExplicitRightHand(token, 0);
      hasExplicit = hasExplicit || !!finger;
      return finger || '-';
    });
    return hasExplicit ? labels.join(' / ') : '';
  }
  if (beat.kind === 'rest' || beat.kind === 'hold' || !beat.midi) return '';
  var token = beat.tok || beat.customTok || beat.en;
  if (beat.chordNotes && beat.chordNotes.length >= 2){
    var chordLabel = formatChordRightHandLabel(token, beat.chordNotes);
    return beat.chordNotes.some(function(note, index){ return !!getExplicitRightHand(token, index); })
      ? chordLabel : '';
  }
  var finger = getExplicitRightHand(token, 0);
  return finger ? finger : '';
}

function syncScoreModeUI(){
  var isTab = appState.scoreView !== 'card';
  if ($('#scoreModeTabBtn')) $('#scoreModeTabBtn').setAttribute('aria-selected', String(isTab));
  if ($('#scoreModeCardBtn')) $('#scoreModeCardBtn').setAttribute('aria-selected', String(!isTab));
  if ($('#scoreModeSeg')) $('#scoreModeSeg').hidden = !curSong || curSong.type !== 'structured';
  if ($('#structuredScoreWrap')){
    $('#structuredScoreWrap').classList.toggle('tab-view-active', isTab);
    $('#structuredScoreWrap').classList.toggle('card-view-active', !isTab);
  }
}

function initScoreUi(){
  if ($('#scoreModeTabBtn')){
    $('#scoreModeTabBtn').addEventListener('click', function(){
      appState.scoreView = 'tab';
      syncScoreModeUI();
      saveAppState();
      if (curSong && curSong.type === 'structured') renderStructuredMeasures();
      updateActiveCursor(curMeasureIdx, curBeatIdx, false);
    });
  }
  if ($('#scoreModeCardBtn')){
    $('#scoreModeCardBtn').addEventListener('click', function(){
      appState.scoreView = 'card';
      syncScoreModeUI();
      saveAppState();
      if (curSong && curSong.type === 'structured') renderStructuredMeasures();
      updateActiveCursor(curMeasureIdx, curBeatIdx, false);
    });
  }
}

function formatSongToSheetTsv(title, beats, bpm, badge, linesArr){
  var cleanTitle = (title || '내 연습곡').replace(/\t|\r|\n/g, ' ').trim();
  var cleanBadge = (badge || '구글 시트 악보').replace(/\t|\r|\n/g, ' ').trim();
  var measures = linesArr || [];
  var raw = measures.length && typeof measures[0] === 'object'
    ? serializeScoreMeasures(measures, '\n')
    : measures.join('\n');
  var validation = validateScore(raw, Number(beats) || 4);
  if (validation.errors.length) throw new Error('악보 오류: ' + validation.errors[0].message);
  var parsed = parseScore(raw, Number(beats) || 4);
  var canonical = parsed.measures.map(function(m){
    return { chord: m.chord || '-', autoChord: !!m.autoChord, notes: m.beats.map(function(b){ return b.tok || '-'; }), lyric: m.lyric || '' };
  });
  var joinedMeasures = serializeScoreMeasures(canonical, ' // ');
  return [cleanTitle, String(beats || 4), String(bpm || 64), cleanBadge, joinedMeasures].join('\t');
}
