function initFretboard(){
  'use strict';
  // ---------- 지판(Fretboard) 렌더링 및 업데이트
  function buildFretboard(){
    var fb = $('#fretboard');
    fb.textContent = '';
    var header = document.createElement('div');
    header.className = 'fb-frets-header';
    var openHead = document.createElement('span');
    openHead.textContent = '개방(0)';
    header.appendChild(openHead);
    for (var f = 1; f <= 12; f++){
      var sp = document.createElement('span');
      sp.textContent = f + '프렛' + ([3,5,7,9,12].indexOf(f) >= 0 ? ' •' : '');
      header.appendChild(sp);
    }
    fb.appendChild(header);

    STRINGS.forEach(function(st){
      var row = document.createElement('div');
      row.className = 'fb-row';
      row.style.setProperty('--str-h', st.thick);

      // 개방현 셀
      var openEl = document.createElement('div');
      openEl.className = 'fb-open';
      openEl.dataset.str = st.str;
      openEl.dataset.fret = 0;
      openEl.dataset.midi = st.midi;
      openEl.dataset.baseLabel = st.name.split(' ')[0];
      openEl.textContent = openEl.dataset.baseLabel;
      openEl.title = st.name + ' (클릭하면 소리 재생)';
      openEl.addEventListener('click', function(){ playGuitarNote(soundingMidi(st.midi, curCapo()), 0.9, null, null, null, st.str); });
      row.appendChild(openEl);

      for (var f = 1; f <= 12; f++){
        var cell = document.createElement('div');
        cell.className = 'fb-cell';
        var midi = st.midi + f;
        cell.dataset.str = st.str;
        cell.dataset.fret = f;
        cell.dataset.midi = midi;
        var inf = midiInfo(midi);
        cell.title = st.str + '번줄 ' + f + '프렛: ' + inf.en + ' (' + inf.ko + ')';
        cell.addEventListener('click', (function(m){ return function(){ playGuitarNote(soundingMidi(m, curCapo()), 0.9, null, null, null, st.str); }; })(midi));
        row.appendChild(cell);
      }
      fb.appendChild(row);
    });
  }

  var lastFbState = { chordName: 'C', targetNote: null, isAutoChord: false, bIdx: 0 };

  function syncChordDotsBtnUI(){
    var on = appState.showChordDots !== false;
    var btn = $('#toggleChordDotsBtn');
    if (btn){
      btn.classList.toggle('active', on);
      btn.textContent = on ? '파란 코드 점: 켜짐' : '파란 코드 점: 숨김';
    }
  }

  $('#toggleChordDotsBtn').addEventListener('click', function(){
    appState.showChordDots = !(appState.showChordDots !== false);
    saveAppState();
    syncChordDotsBtnUI();
    highlightFretboard(lastFbState.chordName, lastFbState.targetNote, false, lastFbState.isAutoChord, lastFbState.bIdx);
  });

  function highlightFretboard(chordName, targetNote, forceShowChord, isAutoChord, bIdx){
    lastFbState.chordName = chordName;
    lastFbState.targetNote = targetNote;
    lastFbState.isAutoChord = !!isAutoChord;
    lastFbState.bIdx = bIdx || 0;
    syncChordDotsBtnUI();

    // 모든 마커 제거 및 개방현 라벨 초기화
    $$('#fretboard .fb-marker').forEach(function(el){ el.remove(); });
    $$('#fretboard .fb-open').forEach(function(el){
      el.textContent = el.dataset.baseLabel || el.textContent;
      el.style.color = '#f3ece4';
      el.style.fontWeight = '600';
    });

    var ch = lookupChord(chordName);
    var autoSuffix = isAutoChord ? ' (자동)' : '';
    if (ch){
      $('#currentChordBadge').textContent = '현재 코드: ' + cleanChordToken(chordName) + autoSuffix;
    } else if (!chordName || chordName === '-'){
      $('#currentChordBadge').textContent = '현재 코드: 없음 (단선율)';
    } else {
      $('#currentChordBadge').textContent = '현재 코드: ' + chordName + ' (운지 미등록)';
    }

    // 1. 코드 구성음 표시 (등록된 코드이고 토글 켜짐 상태이거나 하단 코드 카드 직접 클릭 시에만 표시)
    var showBlue = forceShowChord || (appState.showChordDots !== false);
    if (ch && showBlue){
      // frets 배열은 [6번줄, 5번줄, 4번줄, 3번줄, 2번줄, 1번줄]
      for (var i = 0; i < 6; i++){
        var strNo = 6 - i;
        var fret = ch.frets[i];
        var finger = ch.fingers[i];
        if (fret > 0){
          var cell = $('#fretboard .fb-cell[data-str="' + strNo + '"][data-fret="' + fret + '"]');
          if (cell){
            var mk = document.createElement('span');
            mk.className = 'fb-marker chord-tone';
            mk.textContent = finger || fret;
            cell.appendChild(mk);
          }
        } else if (fret === 0){
          var op = $('#fretboard .fb-open[data-str="' + strNo + '"]');
          if (op) op.style.color = '#93abf5';
        }
      }
    }

    var lhNames = { 0: '0 (개방현)', 1: '1번 (검지)', 2: '2번 (중지)', 3: '3번 (약지)', 4: '4번 (소지)' };

    // 3. 현재 박자 목표 악보 음 표시 (초록 마커)
    if (targetNote && targetNote.midi){
      var info = midiInfo(targetNote.midi);
      var str = targetNote.str || (info.pos && info.pos.str);
      var fret = targetNote.fret != null ? targetNote.fret : (info.pos && info.pos.fret);
      var sourceToken = targetNote.tok || targetNote.customTok || targetNote.en;
      var lh = getExplicitLeftHand(sourceToken);
      var artic = targetNote.articulation;
      var articTag = targetNote.explicitArticulation && artic === 'apoyando'
        ? ' · 아포얀도(눌러치기·!)'
        : (targetNote.explicitArticulation && artic === 'tirando' ? ' · 티란도(뜯어치기·~)' : '');

      var songCapo = getSongCapo(curSong);
      var capoTag = songCapo > 0 ? (' [Capo ' + songCapo + ' 실음: ' + midiInfo(soundingMidi(targetNote.midi, songCapo)).en + ']') : '';

      if (targetNote.chordNotes && targetNote.chordNotes.length >= 2){
        var noteNames = targetNote.chordNotes.map(function(c){ return c.str + '줄 ' + c.ko + (c.fret === 0 ? '(개방)' : '(' + c.fret + '프)'); }).join(' + ');
        var noteHeading = targetNote.chordNotes.length === 2 ? '겹음: ' : (chordName ? cleanChordToken(chordName) + ' 화음: ' : '화음: ');
        $('#guideNoteTxt').textContent = noteHeading + noteNames + capoTag + articTag;
        var lhStrs = targetNote.chordNotes.map(function(c, componentIndex){
          var explicitLH = getExplicitLeftHand(sourceToken, componentIndex);
          return c.str + '줄 ' + (explicitLH == null ? '미지정' : (explicitLH === 0 ? '0' : explicitLH + '번'));
        }).join(' + ');
        $('#guideLhTxt').textContent = '왼손 운지: ' + lhStrs;
        var hasExplicitRH = targetNote.chordNotes.some(function(c, componentIndex){
          return !!getExplicitRightHand(sourceToken, componentIndex);
        });
        var rhParts = targetNote.chordNotes.map(function(c, componentIndex){
          var finger = getExplicitRightHand(sourceToken, componentIndex);
          return c.str + '줄 ' + (finger ? finger + ' (' + RIGHT_HAND_NAMES[finger] + ')' : '미지정');
        });
        $('#guideRhTxt').textContent = hasExplicitRH
          ? '오른손 운지: ' + rhParts.join(' + ')
          : '-';
      } else {
        $('#guideNoteTxt').textContent = info.en + ' (' + info.ko + ') · ' + str + '번줄 ' + (fret === 0 ? '개방현' : fret + '프렛') + capoTag + articTag;
        $('#guideLhTxt').textContent = lh == null ? '미지정' : (lhNames[lh] || (lh + '번 손가락'));
        var rhFinger = getExplicitRightHand(sourceToken, 0);
        $('#guideRhTxt').textContent = rhFinger ? rhFinger + ' (' + RIGHT_HAND_NAMES[rhFinger] + ')' : '-';
      }

      var notesToHighlight = (targetNote.chordNotes && targetNote.chordNotes.length >= 2)
        ? targetNote.chordNotes
        : [{ str: str, fret: fret, lh: lh, ko: info.ko }];

      notesToHighlight.forEach(function(nt, componentIndex){
        var explicitLH = getExplicitLeftHand(sourceToken, targetNote.chordNotes && targetNote.chordNotes.length >= 2 ? componentIndex : undefined);
        if (nt.fret === 0){
          var openEl = $('#fretboard .fb-open[data-str="' + nt.str + '"]');
          if (openEl){
            openEl.style.color = '#62d491';
            openEl.style.fontWeight = '700';
            openEl.textContent = (openEl.dataset.baseLabel || '') + '·' + nt.ko + (explicitLH != null ? '(' + explicitLH + ')' : '');
          }
        } else if (nt.str && nt.fret > 0){
          var targetCell = $('#fretboard .fb-cell[data-str="' + nt.str + '"][data-fret="' + nt.fret + '"]');
          if (targetCell){
            targetCell.textContent = '';
            var tmk = document.createElement('span');
            tmk.className = 'fb-marker target-note';
            tmk.textContent = nt.ko + (explicitLH != null ? '(' + explicitLH + ')' : '');
            targetCell.appendChild(tmk);
          }
        }
      });
    } else if (ch){
      $('#guideNoteTxt').textContent = ch.name;
      $('#guideLhTxt').textContent = ch.desc;
      $('#guideRhTxt').textContent = '-';
    } else {
      $('#guideNoteTxt').textContent = '쉼표 / 유지 박자';
      $('#guideLhTxt').textContent = '이전 음 여운 유지 또는 쉼';
      $('#guideRhTxt').textContent = '-';
    }

    // 코드 카드 액티브 표시
    $$('#chordCards .chord-card').forEach(function(c){
      c.classList.toggle('active', c.dataset.chord === chordName);
    });
  }

  function renderChordCards(chordsInSong){
    var box = $('#chordCards');
    box.textContent = '';
    var validList = (chordsInSong || []).filter(function(c){ return !!lookupChord(c); });
    var list = validList.length ? validList : ['C', 'G7', 'F', 'Am', 'Dm', 'Em'];
    list.forEach(function(chName){
      var ch = lookupChord(chName);
      if (!ch) return;
      var card = document.createElement('div');
      card.className = 'chord-card';
      card.dataset.chord = chName;

      var title = document.createElement('div');
      title.className = 'chord-card-title';
      title.textContent = chName;

      var svg = buildChordSvg(ch.frets, ch.fingers);
      var sub = document.createElement('div');
      sub.className = 'chord-card-sub';
      sub.textContent = '클릭: 화음 듣기';

      card.appendChild(title);
      card.appendChild(svg);
      card.appendChild(sub);

      card.addEventListener('click', function(){
        highlightFretboard(chName, null, true);
        playChordPreview(chName);
      });
      box.appendChild(card);
    });
  }

  function buildChordSvg(frets, fingers){
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 96 86');
    svg.setAttribute('width', '92');
    svg.setAttribute('height', '82');

    var x0 = 14, y0 = 16, sw = 13.5, fh = 15;
    // 너트
    var nut = document.createElementNS(ns, 'line');
    nut.setAttribute('x1', x0); nut.setAttribute('y1', y0);
    nut.setAttribute('x2', x0 + sw * 5); nut.setAttribute('y2', y0);
    nut.setAttribute('stroke', 'currentColor'); nut.setAttribute('stroke-width', '3');
    svg.appendChild(nut);

    // 프렛 가로선 4개
    for (var f = 1; f <= 4; f++){
      var fl = document.createElementNS(ns, 'line');
      fl.setAttribute('x1', x0); fl.setAttribute('y1', y0 + f * fh);
      fl.setAttribute('x2', x0 + sw * 5); fl.setAttribute('y2', y0 + f * fh);
      fl.setAttribute('stroke', 'currentColor'); fl.setAttribute('stroke-opacity', '0.35');
      svg.appendChild(fl);
    }
    // 6현 세로선
    for (var s = 0; s < 6; s++){
      var sl = document.createElementNS(ns, 'line');
      var x = x0 + s * sw;
      sl.setAttribute('x1', x); sl.setAttribute('y1', y0);
      sl.setAttribute('x2', x); sl.setAttribute('y2', y0 + 4 * fh);
      sl.setAttribute('stroke', 'currentColor'); sl.setAttribute('stroke-opacity', '0.55');
      svg.appendChild(sl);

      var fr = frets[s];
      var fg = fingers ? fingers[s] : 0;
      if (fr === -1 || fr === 0){
        var tx = document.createElementNS(ns, 'text');
        tx.setAttribute('x', x); tx.setAttribute('y', y0 - 5);
        tx.setAttribute('text-anchor', 'middle');
        tx.setAttribute('font-size', '10');
        tx.setAttribute('fill', 'currentColor');
        tx.textContent = fr === -1 ? 'X' : 'O';
        svg.appendChild(tx);
      } else if (fr > 0 && fr <= 4){
        var cy = y0 + (fr - 0.5) * fh;
        var cir = document.createElementNS(ns, 'circle');
        cir.setAttribute('cx', x); cir.setAttribute('cy', cy); cir.setAttribute('r', '5.5');
        cir.setAttribute('fill', '#2d4c9b');
        svg.appendChild(cir);
        if (fg){
          var ftx = document.createElementNS(ns, 'text');
          ftx.setAttribute('x', x); ftx.setAttribute('y', cy + 3.2);
          ftx.setAttribute('text-anchor', 'middle');
          ftx.setAttribute('font-size', '9');
          ftx.setAttribute('font-weight', '700');
          ftx.setAttribute('fill', '#fff');
          ftx.textContent = String(fg);
          svg.appendChild(ftx);
        }
      }
    }
    return svg;
  }


  window.buildFretboard = buildFretboard;
  window.highlightFretboard = highlightFretboard;
  window.renderChordCards = renderChordCards;
  window.buildChordSvg = buildChordSvg;
  window.syncChordDotsBtnUI = syncChordDotsBtnUI;
}
