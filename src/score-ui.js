'use strict';

var RIGHT_HAND_NAMES = { p: '엄지', i: '검지', m: '중지', a: '약지' };

// TAB 프렛 글자 하나. 연습 화면 알약과 악보 입력 화면 칸이 같이 쓰는 유일한 생성 함수다.
// spec = {fret, lh: null|0~4, rh: null|'p'|'i'|'m'|'a', art: null|'apoyando'|'harmonic'}
// 하모닉스는 손 대는 프렛을 <7> 로 적는다(Guitar Pro 등 TAB 표기).
function buildFretLabel(spec){
  var label = document.createElement('span');
  label.className = 'fret-label' + (spec.art === 'apoyando' ? ' is-apoyando' : '') + (spec.art === 'harmonic' ? ' is-harmonic' : '');
  label.appendChild(document.createTextNode(spec.art === 'harmonic' ? '<' + spec.fret + '>' : String(spec.fret)));
  var hasLh = spec.lh != null;
  if (hasLh || spec.rh){
    var fing = document.createElement('span');
    fing.className = 'fret-fing';
    if (hasLh){
      var sup = document.createElement('sup');
      sup.className = 'fret-lh';
      sup.textContent = String(spec.lh);
      fing.appendChild(sup);
    }
    if (spec.rh){
      var sub = document.createElement('sub');
      sub.className = 'fret-rh';
      sub.textContent = spec.rh;
      sub.title = '오른손 ' + spec.rh + ' (' + RIGHT_HAND_NAMES[spec.rh] + ')';
      fing.appendChild(sub);
    }
    label.appendChild(fing);
  }
  return label;
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

// 악보 보기. T 키가 이 순서로 돈다.
var SCORE_VIEWS = ['tab', 'both', 'staff', 'card'];

function setScoreView(view){
  appState.scoreView = view;
  syncScoreModeUI();
  saveAppState();
  if (curSong && curSong.type === 'structured') renderStructuredMeasures();
  updateActiveCursor(curMeasureIdx, curBeatIdx, false);
}

function syncScoreModeUI(){
  var isTab = appState.scoreView !== 'card';
  var viewSelect = $('#scoreViewSelect');
  if (viewSelect){
    viewSelect.value = appState.scoreView;
    viewSelect.hidden = !curSong || curSong.type !== 'structured';
  }
  if ($('#structuredScoreWrap')){
    $('#structuredScoreWrap').classList.toggle('tab-view-active', isTab);
    $('#structuredScoreWrap').classList.toggle('card-view-active', !isTab);
  }
}

function initScoreUi(){
  var viewSelect = $('#scoreViewSelect');
  if (!viewSelect) return;
  viewSelect.addEventListener('change', function(){
    setScoreView(viewSelect.value);
    viewSelect.blur();
  });
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
