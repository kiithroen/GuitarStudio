'use strict';

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
