function initEditor(){
  'use strict';
  var PAD_LAYOUTS = {
    string: [
      {
        tag: '1번줄 (E)',
        items: [
          { tok: 'E4',  ko: '0미 (미4)', sub: '1줄 개방' },
          { tok: 'F4',  ko: '1파 (파4)', sub: '1줄 1프렛' },
          { tok: 'F#4', ko: '2파#',      sub: '1줄 2프렛' },
          { tok: 'G4',  ko: '3솔 (솔4)', sub: '1줄 3프렛' },
          { tok: 'A4',  ko: '라4',       sub: '1줄 5프렛' },
          { tok: 'B4',  ko: '시4',       sub: '1줄 7프렛' },
          { tok: 'C5',  ko: '도5',       sub: '1줄 8프렛' },
          { tok: '-',   ko: '쉼/유지(-)',sub: 'Space / 0' }
        ]
      },
      {
        tag: '2·3번줄',
        items: [
          { tok: 'B3',  ko: '0시 (시3)', sub: '2줄 개방' },
          { tok: 'C4',  ko: '1도 (도4)', sub: '2줄 1프렛' },
          { tok: 'D4',  ko: '3레 (레4)', sub: '2줄 3프렛' },
          { tok: 'G3',  ko: '0솔 (솔3)', sub: '3줄 개방' },
          { tok: 'G#3', ko: '1솔#',      sub: '3줄 1프렛' },
          { tok: 'A3',  ko: '2라 (라3)', sub: '3줄 2프렛' }
        ]
      },
      {
        tag: '4~6번줄 (저음)',
        items: [
          { tok: 'D3',  ko: '0레 (레3)', sub: '4줄 개방' },
          { tok: 'E3',  ko: '2미 (미3)', sub: '4줄 2프렛' },
          { tok: 'F3',  ko: '3파 (파3)', sub: '4줄 3프렛' },
          { tok: 'F#3', ko: '4파#',      sub: '4줄 4프렛' },
          { tok: 'A2',  ko: '0라 (라2)', sub: '5줄 개방' },
          { tok: 'B2',  ko: '2시 (시2)', sub: '5줄 2프렛' },
          { tok: 'C3',  ko: '3도 (도3)', sub: '5줄 3프렛' },
          { tok: 'E2',  ko: '0미 (미2)', sub: '6줄 개방' },
          { tok: 'F2',  ko: '1파 (파2)', sub: '6줄 1프렛' },
          { tok: 'G2',  ko: '3솔 (솔2)', sub: '6줄 3프렛' }
        ]
      }
    ],
    solfege: [
      {
        tag: '가온~고음 (도4~)',
        items: [
          { tok: 'C4',  ko: '도 (1도)',  sub: '2줄 1프렛 (단축1)' },
          { tok: 'D4',  ko: '레 (3레)',  sub: '2줄 3프렛 (단축2)' },
          { tok: 'E4',  ko: '미 (0미)',  sub: '1줄 개방 (단축3)' },
          { tok: 'F4',  ko: '파 (1파)',  sub: '1줄 1프렛 (단축4)' },
          { tok: 'F#4', ko: '파# (2파#)',sub: '1줄 2프렛' },
          { tok: 'G4',  ko: '솔 (3솔)',  sub: '1줄 3프렛 (단축5)' },
          { tok: 'A4',  ko: '라4',       sub: '1줄 5프렛' },
          { tok: 'B4',  ko: '시4',       sub: '1줄 7프렛' },
          { tok: 'C5',  ko: '높은도',    sub: '1줄 8프렛 (단축8)' },
          { tok: '-',   ko: '쉼/유지(-)',sub: 'Space / 0' }
        ]
      },
      {
        tag: '중저음 (도3~시3)',
        items: [
          { tok: 'C3',  ko: '낮은도',    sub: '5줄 3프렛' },
          { tok: 'D3',  ko: '낮은레',    sub: '4줄 개방' },
          { tok: 'E3',  ko: '낮은미',    sub: '4줄 2프렛' },
          { tok: 'F3',  ko: '낮은파',    sub: '4줄 3프렛' },
          { tok: 'F#3', ko: '낮은파#',   sub: '4줄 4프렛' },
          { tok: 'G3',  ko: '솔3 (0솔)', sub: '3줄 개방' },
          { tok: 'G#3', ko: '솔#3(1솔#)',sub: '3줄 1프렛' },
          { tok: 'A3',  ko: '라3 (2라)', sub: '3줄 2프렛 (단축6)' },
          { tok: 'B3',  ko: '시3 (0시)', sub: '2줄 개방 (단축7)' }
        ]
      },
      {
        tag: '베이스 (미2~시2)',
        items: [
          { tok: 'E2',  ko: '6줄 미',    sub: '6줄 개방' },
          { tok: 'F2',  ko: '6줄 파',    sub: '6줄 1프렛' },
          { tok: 'G2',  ko: '6줄 솔',    sub: '6줄 3프렛' },
          { tok: 'A2',  ko: '5줄 라',    sub: '5줄 개방' },
          { tok: 'B2',  ko: '5줄 시',    sub: '5줄 2프렛' }
        ]
      }
    ]
  };

  var veState = {
    editingSongId: null,
    refImageDataUrl: null,
    padMode: ls.get('gs.padMode', 'string'),
    bassCombine: false,
    beats: 4,
    bars: [],
    selBar: 0,
    selBeat: 0
  };

  function syncVeBassCombineBtn(){
    var btn = $('#veBassCombineBtn');
    if (!btn) return;
    btn.classList.toggle('active', !!veState.bassCombine);
    btn.textContent = veState.bassCombine ? '+ 베이스 겹음 묶기: 켜짐' : '+ 베이스 겹음 묶기: 꺼짐';
  }

  $('#veBassCombineBtn').addEventListener('click', function(){
    veState.bassCombine = !veState.bassCombine;
    syncVeBassCombineBtn();
  });

  function toggleSelectedCellArticulation(forceMode){
    var bar = veState.bars[veState.selBar];
    if (!bar) return;
    var curTok = bar.notes[veState.selBeat] || '-';
    if (!curTok || curTok === '-') return;
    var inf = parseNoteToken(curTok, veState.selBeat);
    if (!inf || !inf.midi) return;

    var curArt = inf.explicitArticulation ? inf.articulation : null;
    var nextArt = forceMode !== undefined
      ? (curArt === forceMode ? null : forceMode)
      : (curArt === null ? 'apoyando' : (curArt === 'apoyando' ? 'tirando' : null));

    var pfx = nextArt === 'apoyando' ? '!' : (nextArt === 'tirando' ? '~' : '');
    var rawClean = curTok.replace(/[!>^~]/g, '');
    var nextRaw = rawClean.indexOf('+') >= 0
      ? rawClean.replace(/\+([^+]+)$/, '+' + pfx + '$1')
      : (pfx + rawClean);

    var nextInf = parseNoteToken(nextRaw, veState.selBeat);
    bar.notes[veState.selBeat] = nextInf ? (nextInf.customTok || nextInf.en) : nextRaw;
    if (nextInf && nextInf.midi){
      var sc = nextArt === 'apoyando' ? 1.16 : (nextArt === 'tirando' ? 0.62 : 1.0);
      playGuitarNote(soundingMidi(nextInf.midi, editorCapo()), nextArt === 'apoyando' ? 1.0 : 0.7, null, sc, nextArt);
    }
    syncVeToTextarea();
    renderVeBarsGrid();
  }

  $('#veApoyandoBtn').addEventListener('click', function(){
    toggleSelectedCellArticulation();
  });

  function buildNotePadButtons(){
    var mode = veState.padMode === 'solfege' ? 'solfege' : 'string';
    $('#padModeStringBtn').setAttribute('aria-selected', mode === 'string' ? 'true' : 'false');
    $('#padModeSolfegeBtn').setAttribute('aria-selected', mode === 'solfege' ? 'true' : 'false');

    var wrap = $('#notePadRows');
    wrap.textContent = '';
    var rows = PAD_LAYOUTS[mode];
    rows.forEach(function(r){
      var rowEl = document.createElement('div');
      rowEl.className = 'note-pad-row';
      var tagEl = document.createElement('span');
      tagEl.className = 'np-row-tag';
      tagEl.textContent = r.tag;
      rowEl.appendChild(tagEl);

      r.items.forEach(function(item){
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'np-btn';
        btn.innerHTML = '<b>' + item.ko + '</b><small>' + item.sub + '</small>';
        btn.addEventListener('click', function(e){
          applyNoteToSelectedCell(item.tok, e.shiftKey);
        });
        rowEl.appendChild(btn);
      });
      wrap.appendChild(rowEl);
    });
  }

  $('#padModeStringBtn').addEventListener('click', function(){
    veState.padMode = 'string';
    ls.set('gs.padMode', 'string');
    buildNotePadButtons();
  });
  $('#padModeSolfegeBtn').addEventListener('click', function(){
    veState.padMode = 'solfege';
    ls.set('gs.padMode', 'solfege');
    buildNotePadButtons();
  });
  buildNotePadButtons();

  function serializeVeBarsToText(){
    return veState.bars.map(function(bar){
      var koLyrics = bar.notes.map(function(n){
        if (!n || n === '-') return '-';
        if (n.indexOf('/') >= 0){
          return n.split('/').map(function(sub){
            var sn = parseNoteToken(sub, 0);
            if (!sn) return '-';
            return sn.bass ? ('p' + sn.bass.ko + '+' + sn.ko) : sn.ko;
          }).join('/');
        }
        var inf = parseNoteToken(n, 0);
        if (!inf) return '-';
        return inf.bass ? ('p' + inf.bass.ko + '+' + inf.ko) : inf.ko;
      }).join(' ');
      var chTag = (!bar.chord || bar.chord === '-')
        ? '-'
        : (bar.chord + (bar.autoChord ? '(자동)' : ''));
      return '[' + chTag + '] ' + bar.notes.join(' ') + ' | ' + (bar.lyric || koLyrics);
    }).join('\n');
  }

  function syncVeToTextarea(){
    $('#nsMeasuresTxt').value = serializeVeBarsToText();
  }

  function renderVeBarsGrid(){
    var box = $('#veBarsGrid');
    box.textContent = '';
    var bpb = veState.beats;
    var chordList = Object.keys(CHORD_DB).concat(['-']);

    veState.bars.forEach(function(bar, mIdx){
      var card = document.createElement('div');
      card.className = 've-bar';

      var head = document.createElement('div');
      head.className = 've-bar-head';
      var num = document.createElement('span');
      num.className = 'm-num';
      num.textContent = (mIdx + 1) + '마디';

      var sel = document.createElement('select');
      sel.className = 've-chord-sel';
      chordList.forEach(function(ch){
        var opt = document.createElement('option');
        opt.value = ch;
        var isCur = (ch === (bar.chord || '-'));
        opt.textContent = ch === '-' ? '코드 없음 (-)' : (isCur && bar.autoChord ? ch + ' (자동)' : ch);
        if (isCur) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function(){
        bar.chord = sel.value;
        bar.autoChord = false; // 사용자가 직접 선택하면 (자동) 표시 해제
        syncVeToTextarea();
        renderVeBarsGrid();
      });

      head.appendChild(num);
      head.appendChild(sel);
      card.appendChild(head);

      var beatsDiv = document.createElement('div');
      beatsDiv.className = 've-beats';
      beatsDiv.style.setProperty('--ve-bpb', bpb);

      for (var bIdx = 0; bIdx < bpb; bIdx++){
        var tok = bar.notes[bIdx] || '-';
        var inf = parseNoteToken(tok, bIdx);
        var cell = document.createElement('div');
        cell.className = 've-cell' + (veState.selBar === mIdx && veState.selBeat === bIdx ? ' selected' : '');
        var koLabel = inf ? ((inf.pos && inf.pos.lh != null ? inf.pos.lh : '') + inf.ko) : '-';
        var artBadge = '';
        if (inf && inf.explicitArticulation){
          artBadge = inf.articulation === 'apoyando'
            ? ' <span style="color:#1d4ed8;font-weight:800">!아포</span>'
            : ' <span style="color:#64748b;font-weight:700">~티란</span>';
        }
        if (tok.indexOf('/') >= 0){
          var subs = tok.split('/');
          var subKo = subs.map(function(stk){
            var sn = parseNoteToken(stk, bIdx);
            return sn ? ((sn.pos && sn.pos.lh != null ? sn.pos.lh : '') + sn.ko) : stk;
          }).join('/');
          cell.innerHTML = '<b>' + subKo + '</b><small style="color:#2563eb;font-weight:700">' + subs.length + '분할</small>';
        } else if (inf && inf.chordNotes && inf.chordNotes.length > 2){
          cell.innerHTML = '<b>' + inf.chordNotes.map(function(c){ return c.ko; }).join('+') + '</b><small style="color:#b45309;font-weight:700">화음' + artBadge + '</small>';
        } else if (inf && inf.bass){
          cell.innerHTML = '<b>p' + inf.bass.ko + '+' + koLabel + '</b><small style="color:#b45309;font-weight:700">' + inf.bass.str + '줄+' + (inf.pos ? inf.pos.str + '줄' + inf.pos.fret : '') + artBadge + '</small>';
        } else {
          cell.innerHTML = '<b>' + koLabel + '</b><small>' + (inf && inf.pos ? (inf.pos.str + '줄' + inf.pos.fret) : '쉼/유지') + artBadge + '</small>';
        }
        cell.addEventListener('click', (function(mI, bI){
          return function(){
            veState.selBar = mI;
            veState.selBeat = bI;
            updateVeSelectionLabel();
            renderVeBarsGrid();
          };
        })(mIdx, bIdx));
        beatsDiv.appendChild(cell);
      }

      card.appendChild(beatsDiv);
      box.appendChild(card);
    });
    updateVeSelectionLabel();
  }

  function updateVeSelectionLabel(){
    $('#veSelectedLabel').textContent = '선택된 위치: ' + (veState.selBar + 1) + '마디 ' + (veState.selBeat + 1) + '박 · 패드 클릭(Shift+클릭 시 베이스 겹음, ! 키로 아포얀도 강조)';
  }

  function applyNoteToSelectedCell(tok, isShift){
    if (!veState.bars.length){
      veState.bars.push({ chord: 'C', autoChord: true, notes: new Array(veState.beats).fill('-'), lyric: '' });
    }
    var bar = veState.bars[veState.selBar];
    if (!bar) return;
    var curTok = bar.notes[veState.selBeat] || '-';
    var combineMode = !!(veState.bassCombine || isShift);
    var nextRawTok = tok;

    if (combineMode && tok !== '-' && curTok && curTok !== '-'){
      // 기존 음에서 멜로디만 추출하거나 새 음과 결합해 베이스+멜로디 2성부 토큰 생성
      var baseParts = curTok.split('+');
      var otherTok = baseParts[baseParts.length - 1];
      nextRawTok = otherTok + '+' + tok;
    }

    var inf = parseNoteToken(nextRawTok, veState.selBeat);
    bar.notes[veState.selBeat] = inf ? (inf.customTok || inf.en) : '-';
    if (inf){
      var ecp = editorCapo();
      if (inf.chordNotes && inf.chordNotes.length > 2){
        inf.chordNotes.forEach(function(cn, i){
          playGuitarNote(soundingMidi(cn.midi, ecp), i === 0 ? 0.75 : 0.55, actx.currentTime + (i * 0.025), 0.9, null, cn.str);
        });
      } else {
        if (inf.bass && inf.bass.midi) playGuitarNote(soundingMidi(inf.bass.midi, ecp), 0.75);
        if (inf.midi) playGuitarNote(soundingMidi(inf.midi, ecp), 0.45);
      }
    }

    // 일반 입력이거나 겹음 결합이 완료된 경우 다음 박자 칸으로 자동 이동
    veState.selBeat++;
    if (veState.selBeat >= veState.beats){
      veState.selBeat = 0;
      if (veState.selBar < veState.bars.length - 1){
        veState.selBar++;
      }
    }
    syncVeToTextarea();
    renderVeBarsGrid();
  }

  // 모달 내 키보드 단축키로 초고속 계이름 입력
  window.addEventListener('keydown', function(e){
    if ($('#newSongModal').hidden) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    var keyMap = {
      '1': 'C4', '2': 'D4', '3': 'E4', '4': 'F4', '5': 'G4', '6': 'A3', '7': 'B3', '8': 'C5',
      '0': '-', '-': '-', ' ': '-'
    };
    if (e.key === '!' || e.key === '>'){
      e.preventDefault();
      toggleSelectedCellArticulation('apoyando');
    } else if (e.key === '~'){
      e.preventDefault();
      toggleSelectedCellArticulation('tirando');
    } else if (keyMap[e.key] !== undefined){
      e.preventDefault();
      applyNoteToSelectedCell(keyMap[e.key], e.shiftKey);
    } else if (e.key === 'ArrowRight'){
      e.preventDefault();
      veState.selBeat++;
      if (veState.selBeat >= veState.beats){
        veState.selBeat = 0;
        veState.selBar = Math.min(veState.bars.length - 1, veState.selBar + 1);
      }
      renderVeBarsGrid();
    } else if (e.key === 'ArrowLeft'){
      e.preventDefault();
      veState.selBeat--;
      if (veState.selBeat < 0){
        if (veState.selBar > 0){
          veState.selBar--;
          veState.selBeat = veState.beats - 1;
        } else {
          veState.selBeat = 0;
        }
      }
      renderVeBarsGrid();
    }
  });

  $('#veAutoChordBtn').addEventListener('click', function(){
    if (!veState.bars.length) return;
    // 사용자가 직접 입력/선택한 코드(!bar.autoChord && bar.chord !== '-')는 유지하고,
    // 코드가 비어 있거나('-') 기존에 (자동)으로 추론된 마디만 추론 대상으로 지정
    var targetIndices = [];
    veState.bars.forEach(function(bar, idx){
      var hasManualChord = bar.chord && bar.chord !== '-' && !bar.autoChord;
      if (!hasManualChord) targetIndices.push(idx);
    });

    var forceAll = false;
    if (targetIndices.length === 0){
      if (!confirm('모든 마디에 이미 직접 입력된 코드가 있어요.\n기존 코드를 지우고 전체 마디를 자동 추론(자동)으로 다시 채울까요?')) return;
      forceAll = true;
    }

    var tempMeasures = veState.bars.map(function(bar, idx){
      var shouldInfer = forceAll || (targetIndices.indexOf(idx) >= 0);
      return {
        chord: shouldInfer ? '' : bar.chord,
        autoChord: shouldInfer ? true : !!bar.autoChord,
        needsInfer: shouldInfer,
        beats: bar.notes.map(function(n, bIdx){
          var inf = parseNoteToken(n || '-', bIdx);
          return { midi: inf ? inf.midi : null };
        })
      };
    });
    inferChordsForMeasures(tempMeasures, veState.beats);
    veState.bars.forEach(function(bar, i){
      if (tempMeasures[i].needsInfer){
        bar.chord = tempMeasures[i].chord || 'C';
        bar.autoChord = true;
      }
    });
    syncVeToTextarea();
    renderVeBarsGrid();
    $('#ocrStatusTxt').textContent = forceAll
      ? '전체 마디의 반주 코드를 (자동)으로 다시 추론했어요.'
      : '직접 적어둔 코드는 그대로 유지하고, 비어 있거나 (자동)인 ' + targetIndices.length + '개 마디의 코드만 추론해 채웠어요.';
  });

  $('#veAddBarBtn').addEventListener('click', function(){
    veState.bars.push({
      chord: '-',
      autoChord: true,
      notes: new Array(veState.beats).fill('-'),
      lyric: ''
    });
    veState.selBar = veState.bars.length - 1;
    veState.selBeat = 0;
    syncVeToTextarea();
    renderVeBarsGrid();
  });

  $('#veDelBarBtn').addEventListener('click', function(){
    if (veState.bars.length <= 1) return;
    veState.bars.pop();
    veState.selBar = Math.min(veState.selBar, veState.bars.length - 1);
    syncVeToTextarea();
    renderVeBarsGrid();
  });

  $('#nsBeats').addEventListener('change', function(){
    var newB = Number($('#nsBeats').value) || 4;
    veState.beats = newB;
    veState.bars.forEach(function(bar){
      while (bar.notes.length < newB) bar.notes.push('-');
      if (bar.notes.length > newB) bar.notes = bar.notes.slice(0, newB);
    });
    veState.selBeat = Math.min(veState.selBeat, newB - 1);
    syncVeToTextarea();
    renderVeBarsGrid();
  });

  $('#nsMeasuresTxt').addEventListener('input', function(){
    veState.bars = parseTextToVeBars($('#nsMeasuresTxt').value, veState.beats);
    veState.selBar = Math.min(veState.selBar, Math.max(0, veState.bars.length - 1));
    renderVeBarsGrid();
  });

  function openConverterEditorModal(opts){
    veState.editingSongId = opts.editingSongId || null;
    veState.refImageDataUrl = opts.imageDataUrl || null;
    veState.beats = opts.beats || 4;
    $('#nsTitle').value = opts.title || '내 연습곡';
    $('#nsBeats').value = String(veState.beats);
    $('#nsBpm').value = opts.bpm || 64;

    if (veState.refImageDataUrl){
      $('#ocrImgBox').hidden = false;
      $('#ocrPreviewImg').src = veState.refImageDataUrl;
    } else {
      $('#ocrImgBox').hidden = true;
    }

    if (opts.rawText){
      $('#nsMeasuresTxt').value = opts.rawText;
    }
    veState.bars = parseTextToVeBars($('#nsMeasuresTxt').value, veState.beats);
    veState.selBar = 0;
    veState.selBeat = 0;
    renderVeBarsGrid();
    $('#newSongModal').hidden = false;
  }

  // 1) 새 곡 직접 입력 버튼
  $('#newTextSongBtn').addEventListener('click', function(){
    openConverterEditorModal({
      editingSongId: null,
      imageDataUrl: (curSong && curSong.type === 'image') ? curSong.imageDataUrl : null,
      title: '',
      beats: 4,
      bpm: 64,
      rawText: '[C] C4 - - - | 도\n[G7] A3 - D4 - | 라 레'
    });
  });

  // 2) 업로드한 사진 악보에서 [이 사진을 내 악보로 변환] 클릭 시
  $('#convertImgToScoreBtn').addEventListener('click', function(){
    if (!curSong || curSong.type !== 'image') return;
    openConverterEditorModal({
      editingSongId: curSong.id,
      imageDataUrl: curSong.imageDataUrl,
      title: curSong.title,
      beats: curSong.beats || 4,
      bpm: curSong.bpm || 64,
      rawText: '[G] B3 B3 B3 - | 종 소 리 -\n[G] B3 B3 B3 - | 울 려 라 -\n[G] B3 D4 G3 A3 | 종 소 리 울\n[G] B3 - - - | 려 - - -'
    });
    $('#ocrStatusTxt').textContent = '[제미니/안티그래비티 질문용 프롬프트 복사]를 눌러 채팅에서 변환한 텍스트를 붙여넣거나, 위 사진의 숫자를 보고 아래 패드로 톡톡 찍어 입력해 주세요.';
  });

  // 3) 기존 구조화 악보에서 [악보 마디·계이름 빠른 수정] 클릭 시
  $('#editStructuredBtn').addEventListener('click', function(){
    if (!curSong || curSong.type !== 'structured') return;
    var lines = curSong.measures.map(function(m){
      var bStr = m.beats.map(function(b){ return (b.tok && b.tok !== '-') ? b.tok : (b.en || '-'); }).join(' ');
      var chTag = !m.chord ? '-' : (m.chord + (m.autoChord ? '(자동)' : ''));
      return '[' + chTag + '] ' + bStr + ' | ' + (m.lyric || '');
    }).join('\n');
    var isReadOnlySource = !!(curSong.builtin || curSong.fromSheet);
    openConverterEditorModal({
      editingSongId: isReadOnlySource ? null : curSong.id,
      imageDataUrl: curSong.refImageDataUrl || null,
      title: isReadOnlySource ? (curSong.title + ' (내 버전)') : curSong.title,
      beats: curSong.beats || 4,
      bpm: curSong.bpm || 64,
      rawText: lines
    });
  });

  // ---------- 악보 보기 모드 (6현 타브 vs 박자 카드) 동기화 및 전환
  function syncScoreModeUI(){
    var isTab = (appState.scoreView !== 'card');
    if ($('#scoreModeTabBtn')) $('#scoreModeTabBtn').setAttribute('aria-selected', String(isTab));
    if ($('#scoreModeCardBtn')) $('#scoreModeCardBtn').setAttribute('aria-selected', String(!isTab));
    if ($('#scoreModeSeg')) $('#scoreModeSeg').hidden = !curSong || curSong.type !== 'structured';
    if ($('#structuredScoreWrap')){
      $('#structuredScoreWrap').classList.toggle('tab-view-active', isTab);
      $('#structuredScoreWrap').classList.toggle('card-view-active', !isTab);
    }
  }

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

  $('#ocrPickImgBtn').addEventListener('click', function(){
    $('#ocrModalFileInput').click();
  });
  $('#ocrModalFileInput').addEventListener('change', async function(e){
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    e.target.value = '';
    var dUrl = await readFileAsDataUrl(f);
    veState.refImageDataUrl = dUrl;
    $('#ocrImgBox').hidden = false;
    $('#ocrPreviewImg').src = dUrl;
    if (!$('#nsTitle').value.trim()) $('#nsTitle').value = f.name.replace(/\.[^.]+$/, '');
  });

  // ---------- AI 채팅(제미니 / 안티그래비티) 질문용 프롬프트 복사 & 시트 TSV 복사
  function buildAiPromptText(beats){
    var bpb = beats || 4;
    return [
      '첨부한 기타 악보 사진(오선보 또는 6선 타브 TAB 악보)을 보고 guitar-studio 앱에 바로 붙여넣을 수 있게 마디별로 정확히 변환해줘.',
      '',
      '[1. 타브(TAB) 6선 악보인 경우]',
      '- 6개의 선은 위에서부터 순서대로 1번줄(e고음), 2번줄(B), 3번줄(G), 4번줄(D), 5번줄(A), 6번줄(E저음)이야.',
      '- 선 위의 숫자는 프렛 번호(0은 개방현)를 뜻해.',
      '- 음 기호는 [왼손운지번호]+[음이름과 옥타브] 형태로 표기해줘 (기본 왼손: 0=개방현, 1=검지, 2=중지, 3=약지, 4=소지):',
      '  * 1번줄: 0=0E4, 1=1F4, 2=2F#4, 3=3G4, 4=4G#4, 5=4A4@1 등',
      '  * 2번줄: 0=0B3, 1=1C4, 2=2C#4, 3=3D4, 4=4D#4, 5=4E4@2 등',
      '  * 3번줄: 0=0G3, 1=1G#3, 2=2A3, 3=3A#3 등',
      '  * 4번줄: 0=0D3, 1=1D#3, 2=2E3, 3=3F3, 4=4F#3 등',
      '  * 5번줄: 0=0A2, 1=1A#2, 2=2B2, 3=3C3, 4=4C#3 등',
      '  * 6번줄: 0=0E2, 1=1F2(엄지 T), 2=2F#2, 3=3G2 등 (6줄 1프렛 F2를 엄지로 누르는 악보는 1F2 표기)',
      '- 특정 줄 지정이 필요한 고포지션은 뒤에 `@줄번호`를 붙일 수 있어 (예: `3D4@2`, `4E4@2`).',
      '',
      '[2. 핑거스타일 / 화음 (베이스 + 멜로디 동시 탄현)]',
      '- 같은 박자에 세로로 동시에 튕기는 음(엄지 베이스 저음 + 멜로디 고음)은 반드시 `베이스+멜로디`처럼 `+`로 묶어서 표기해줘.',
      '  * 예: `3C3+1C4` (5줄 3프렛 도 + 2줄 1프렛 도)',
      '  * 예: `3G2+3D4` (6줄 3프렛 솔 + 2줄 3프렛 레)',
      '  * 예: `0A2+0E4` (5줄 개방 라 + 1줄 개방 미)',
      '  * 예: `1F2+2A3` (6줄 1프렛 파 + 3줄 2프렛 라)',
      '- 3음 이상 동시에 치거나 롤 아르페지오(글리산도 스트럼)로 연주하는 화음은 `3C3+2E3+0G3+1C4`처럼 저음줄부터 고음줄까지 모든 구성음을 `+`로 연결해서 표기해줘.',
      '',
      '[3. 박자표 및 서브토큰(8분·16분·점음표) 분할 규칙 ★가장 중요★]',
      '- 원곡의 박자표(3/4박자는 마디당 3박, 4/4박자는 마디당 4박)를 반드시 그대로 유지해줘 (박자 수를 임의로 2배로 늘리지 말 것).',
      '- 한 박 안에서 음이 쪼개질 때는 슬래시(`/`)를 사용해 서브토큰으로 분할 표기해줘:',
      '  * 8분음표 2개 (반박+반박): `0E4/1F4` 또는 `3C3+1C4/3D4`',
      '  * 점4분음표(1.5박) + 8분음표(0.5박): 앞 박에 `0E4`, 뒷 박에 `- / 3D4` (앞 음이 1.5박 유지되고 엇박에 뒷음 탄현)',
      '  * 셋잇단음표 (한 박 3분할): `0E4/1F4/3G4`',
      '  * 16분음표 4개 (한 박 4분할): `(0E4/1F4/3G4/4A4)` 또는 `0E4/1F4/3G4/4A4`',
      '  * 엇박자 (8분 쉼표 + 8분음표): `- / 3D4`',
      '  * 정박 쉼표 또는 유지음: `-`',
      '  * 못갖춘마디(픽업): 앞의 빈 박은 `-`로 채우고 픽업 박 배치 (예: 3/4박자 3박 픽업 -> `- - 1C4/1C4`)',
      '',
      '[4. 카포(Capo) 표기 규칙 ★절대 혼동 금지★]',
      '- 악보 상단에 `Capo. fret 4`, `Capo 5` 등이 적혀 있더라도, 타브 선 위의 숫자는 카포를 0프렛으로 간주하는 **상대 프렛 번호 그대로** 적어줘 (절대 카포 숫자를 프렛에 더해서 7프렛, 9프렛 등으로 변조하지 말 것!).',
      '- 코드 기호와 음이름도 악보에 인쇄된 상대 폼(`[C]`, `[G]`, `0E4`, `1C4`, `3D4`...) 그대로 표기해줘.',
      '- 대신 곡 제목이나 설명에 `(Capo 4)` 또는 `(Capo 5)`라고 카포 위치를 반드시 적어줘 (앱 엔진이 이를 읽고 자동으로 실음 피치와 마이크 판정을 보정함).',
      '',
      '[5. 코드 기호]',
      '- 원본 악보 상단에 적힌 코드 기호는 `[C]`, `[G]`, `[Am]`, `[Em]`, `[F]`처럼 마디 맨 앞에 표기해줘.',
      '- 코드 표기가 없다면 조성과 강박 선율을 화성학적으로 분석해 `[C(자동)]`, `[G(자동)]`처럼 `(자동)`을 붙여 표기해줘.',
      '',
      '[출력 형식 1: 앱 내 [새 악보 만들기] 붙여넣기용 (한 줄에 한 마디, 파이프 | 뒤에 마디 설명)]',
      '[C] 3C3+1C4 0G3 1C4/3D4 | 1마디: 도(베이스)+도 솔 도-레(8분음표)',
      '[C] 3C3+0E4 0G3 3G4     | 2마디: 도(베이스)+미 솔 솔',
      '[G/B] 2B2+3D4 0G3 3D4   | 3마디: 시(베이스)+레 솔 레',
      '[Am] 0A2+1C4 2A3 0E4/1C4| 4마디: 라(베이스)+도 라 미-도(8분음표)',
      '',
      '[출력 형식 2: 구글 스프레드시트 A열 붙여넣기용 (코드블록 안에 탭 구분 1줄, 마디 사이는 / 로 연결)]',
      '곡제목 (Capo 4)\t' + bpb + '\t76\t핑거스타일 변환곡\t[C] 3C3+1C4 0G3 1C4/3D4 | 1마디: 도-레 / [C] 3C3+0E4 0G3 3G4 | 2마디: 솔 / [G/B] 2B2+3D4 0G3 3D4 | 3마디: 레'
    ].join('\n');
  }

  $('#copyAiPromptBtn').addEventListener('click', async function(){
    var txt = buildAiPromptText(veState.beats);
    try {
      await navigator.clipboard.writeText(txt);
      $('#ocrStatusTxt').textContent = '프롬프트가 복사되었어요! 제미니(또는 안티그래비티) 채팅창에 악보 사진과 함께 붙여넣으세요.';
    } catch (e){
      prompt('아래 프롬프트를 복사해 제미니 채팅에 붙여넣으세요:', txt);
    }
  });

  function formatSongToSheetTsv(title, beats, bpm, badge, linesArr){
    var cleanTitle = (title || '내 연습곡').replace(/\t|\r|\n/g, ' ').trim();
    var cleanBadge = (badge || '구글 시트 악보').replace(/\t|\r|\n/g, ' ').trim();
    var joinedMeasures = (linesArr || []).map(function(l){ return l.trim(); }).filter(Boolean).join(' / ');
    return [cleanTitle, String(beats || 4), String(bpm || 64), cleanBadge, joinedMeasures].join('\t');
  }

  $('#copyVeRowTsvBtn').addEventListener('click', async function(){
    var title = $('#nsTitle').value.trim() || '내 연습곡';
    var beats = Number($('#nsBeats').value) || 4;
    var bpm = Number($('#nsBpm').value) || 64;
    var lines = splitScoreMeasures($('#nsMeasuresTxt').value);
    var tsv = formatSongToSheetTsv(title, beats, bpm, '구글 시트 연동곡 · ' + beats + '/4박자', lines);
    try {
      await navigator.clipboard.writeText(tsv);
      $('#ocrStatusTxt').textContent = '구글 시트 한 줄(TSV) 복사 완료! 내 구글 스프레드시트 빈 행의 A열 칸을 클릭하고 Ctrl+V를 누르세요.';
    } catch (e){
      prompt('구글 시트 A열에 붙여넣을 내용:', tsv);
    }
  });

  $('#closeNewSongBtn').addEventListener('click', function(){
    $('#newSongModal').hidden = true;
  });

  $('#saveNewSongBtn').addEventListener('click', async function(){
    var title = $('#nsTitle').value.trim() || '내 연습곡';
    var beats = Number($('#nsBeats').value) || 4;
    var bpm = Number($('#nsBpm').value) || 64;
    var raw = $('#nsMeasuresTxt').value.trim();
    var lines = splitScoreMeasures(raw);
    if (!lines.length){
      alert('최소 1마디 이상 입력해 주세요.');
      return;
    }
    var targetId = veState.editingSongId || ('custom-' + Date.now());
    var song = buildStructuredSong({
      id: targetId,
      title: title,
      badge: veState.refImageDataUrl ? ('교본 변환 악보 · ' + beats + '/4박자') : ('직접 만든 악보 · ' + beats + '/4박자'),
      builtin: false,
      bpm: bpm,
      beats: beats,
      lines: lines
    });
    if (veState.refImageDataUrl){
      song.refImageDataUrl = veState.refImageDataUrl;
    }
    await dbSaveSong(song);
    var existIdx = customSongs.findIndex(function(s){ return s.id === targetId; });
    if (existIdx >= 0) customSongs[existIdx] = song;
    else customSongs.push(song);

    $('#newSongModal').hidden = true;
    rebuildSongSelect(song.id);
  });


  window.syncScoreModeUI = syncScoreModeUI;
  window.formatSongToSheetTsv = formatSongToSheetTsv;
  window.openConverterEditorModal = openConverterEditorModal;
  window.veState = veState;
}
