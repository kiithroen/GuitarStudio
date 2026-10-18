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
    sourceCapo: 0,
    sourceYtUrl: '',
    sourceBadge: '',
    refImageDataUrl: null,
    padMode: ls.get('gs.padMode', 'string'),
    bassCombine: false,
    beats: 4,
    bars: [],
    selBar: 0,
    selBeat: 0
  };

  function scoreValidationText(result){
    return result.errors.concat(result.warnings).map(function(item){
      return (item.measure ? item.measure + '마디' : '') + (item.beat ? ' ' + item.beat + '박' : '') + ': ' + item.message;
    }).join('\n');
  }
  function refreshScoreValidation(){
    var status = $('#scoreValidationStatus');
    if (!status) return {errors:[],warnings:[]};
    var result = validateScore($('#nsMeasuresTxt').value, veState.beats);
    status.textContent = scoreValidationText(result);
    return result;
  }
  function stopVisualEditOnScoreError(){
    var result = refreshScoreValidation();
    if (!result.errors.length) return false;
    $('#scoreValidationStatus').textContent += '\n입력 오류를 고친 뒤 시각 편집을 사용해줘.';
    return true;
  }

  function syncVeBassCombineBtn(){
    var btn = $('#veBassCombineBtn');
    if (!btn) return;
    btn.classList.toggle('active', !!veState.bassCombine);
    btn.textContent = veState.bassCombine ? '+ 겹음 묶기: 켜짐' : '+ 겹음 묶기: 꺼짐';
  }

  $('#veBassCombineBtn').addEventListener('click', function(){
    veState.bassCombine = !veState.bassCombine;
    syncVeBassCombineBtn();
  });

  function toggleSelectedCellArticulation(forceMode){
    if (stopVisualEditOnScoreError()) return;
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
    var measures = veState.bars.map(function(bar){
      var koLyrics = bar.notes.map(function(n){
        if (!n || n === '-') return '-';
        function noteKo(note){
          if (!note) return '-';
          if (note.chordNotes && note.chordNotes.length >= 2) return note.chordNotes.map(function(component){ return component.ko; }).join('+');
          return note.ko;
        }
        if (n.indexOf('/') >= 0){
          return n.split('/').map(function(sub){
            var sn = parseNoteToken(sub, 0);
            return noteKo(sn);
          }).join('/');
        }
        var inf = parseNoteToken(n, 0);
        return noteKo(inf);
      }).join(' ');
      var chTag = (!bar.chord || bar.chord === '-')
        ? '-'
        : (bar.chord + (bar.autoChord ? '(자동)' : ''));
      return { chord: chTag, autoChord: false, notes: bar.notes, lyric: bar.lyric || koLyrics };
    });
    return serializeScoreMeasures(measures, '\n');
  }

  function syncVeToTextarea(){
    $('#nsMeasuresTxt').value = serializeVeBarsToText();
    refreshScoreValidation();
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
        if (stopVisualEditOnScoreError()) { sel.value = bar.chord || '-'; return; }
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
        function noteLabel(note){
          if (!note) return '-';
          if (note.chordNotes && note.chordNotes.length >= 2) return note.chordNotes.map(function(component){ return component.ko; }).join('+');
          return (note.pos && note.pos.lh != null ? note.pos.lh : '') + note.ko;
        }
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
            return sn ? noteLabel(sn) : stk;
          }).join('/');
          var subLabel = document.createElement('b');
          subLabel.textContent = subKo;
          var subCount = document.createElement('small');
          subCount.style.color = '#2563eb';
          subCount.style.fontWeight = '700';
          subCount.textContent = subs.length + '분할';
          cell.appendChild(subLabel);
          cell.appendChild(subCount);
        } else if (inf && inf.chordNotes && inf.chordNotes.length >= 2){
          var chordLabel = inf.chordNotes.length === 2 ? '겹음' : '화음';
          cell.innerHTML = '<b>' + inf.chordNotes.map(function(c){ return c.ko; }).join('+') + '</b><small style="color:var(--muted);font-weight:700">' + chordLabel + artBadge + '</small>';
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
    $('#veSelectedLabel').textContent = '선택된 위치: ' + (veState.selBar + 1) + '마디 ' + (veState.selBeat + 1) + '박 · 패드 클릭(Shift+클릭 시 겹음, ! 키로 아포얀도 강조)';
  }

  function applyNoteToSelectedCell(tok, isShift){
    if (stopVisualEditOnScoreError()) return;
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
    if (stopVisualEditOnScoreError()) return;
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
    if (stopVisualEditOnScoreError()) return;
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
    if (stopVisualEditOnScoreError()) return;
    if (veState.bars.length <= 1) return;
    veState.bars.pop();
    veState.selBar = Math.min(veState.selBar, veState.bars.length - 1);
    syncVeToTextarea();
    renderVeBarsGrid();
  });

  $('#nsBeats').addEventListener('change', function(){
    var newB = Number($('#nsBeats').value) || 4;
    veState.beats = newB;
    var validation = refreshScoreValidation();
    if (validation.errors.length){
      $('#scoreValidationStatus').textContent += '\n새 박자 기준 입력 오류를 고치기 전까지 원문과 미리보기를 보존했어.';
      return;
    }
    veState.bars = parseTextToVeBars($('#nsMeasuresTxt').value, newB);
    veState.selBeat = Math.min(veState.selBeat, newB - 1);
    renderVeBarsGrid();
  });

  $('#nsMeasuresTxt').addEventListener('input', function(){
    var validation = refreshScoreValidation();
    if (validation.errors.length){
      $('#scoreValidationStatus').textContent += '\n입력 오류를 고친 뒤 시각 편집을 사용해줘. 미리보기는 현재 오류 때문에 갱신하지 않았어.';
      return;
    }
    veState.bars = parseTextToVeBars($('#nsMeasuresTxt').value, veState.beats);
    veState.selBar = Math.min(veState.selBar, Math.max(0, veState.bars.length - 1));
    renderVeBarsGrid();
  });

  function openConverterEditorModal(opts){
    opts = opts || {};
    veState.editingSongId = opts.editingSongId || null;
    veState.sourceCapo = Number(opts.capo) || 0;
    veState.sourceYtUrl = opts.ytUrl || '';
    veState.sourceBadge = opts.badge || '';
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
    var validation = refreshScoreValidation();
    if (validation.errors.length){
      veState.bars = [];
      $('#scoreValidationStatus').textContent += '\n입력 오류 때문에 시각 미리보기를 만들지 않았어.';
    } else {
      veState.bars = parseTextToVeBars($('#nsMeasuresTxt').value, veState.beats);
    }
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
    var beats = curSong.beats || 4;
    var placeholder = '[-] ' + new Array(beats).fill('-').join(' ');
    openConverterEditorModal({
      editingSongId: curSong.id,
      imageDataUrl: curSong.imageDataUrl,
      title: curSong.title,
      beats: beats,
      bpm: appState.bpm || curSong.bpm || 64,
      capo: getSongCapo(curSong),
      ytUrl: curSong.ytUrl || '',
      badge: curSong.badge || '',
      rawText: placeholder
    });
    $('#ocrStatusTxt').textContent = '아직 음을 변환하지 않았어요. 사진을 확인해 직접 입력하거나, 프롬프트로 변환한 내용을 붙여넣어 주세요.';
  });

  // 3) 기존 구조화 악보에서 [악보 마디·계이름 빠른 수정] 클릭 시
  $('#editStructuredBtn').addEventListener('click', function(){
    if (!curSong || curSong.type !== 'structured') return;
    var lines = serializeScoreMeasures(curSong.measures, '\n');
    var isReadOnlySource = !!(curSong.builtin || curSong.fromSheet);
    openConverterEditorModal({
      editingSongId: isReadOnlySource ? null : curSong.id,
      imageDataUrl: curSong.refImageDataUrl || null,
      title: isReadOnlySource ? (curSong.title + ' (내 버전)') : curSong.title,
      beats: curSong.beats || 4,
      bpm: curSong.bpm || 64,
      capo: getSongCapo(curSong),
      ytUrl: curSong.ytUrl || '',
      badge: curSong.badge || '',
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
  $('#copyAiPromptBtn').addEventListener('click', async function(){
    var txt = buildAiPromptText(veState.beats, Number($('#nsBpm').value) || 64);
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
    var measures = linesArr || [];
    var raw = measures.length && typeof measures[0] === 'object'
      ? serializeScoreMeasures(measures, '\n')
      : measures.join('\n');
    var validation = validateScore(raw, Number(beats) || 4);
    if (validation.errors.length) throw new Error('악보 오류: ' + validation.errors[0].message);
    var parsed = parseScore(raw, Number(beats) || 4);
    var canonical = parsed.measures.map(function(m){
      return { chord: m.chord || '-', autoChord: !!m.autoChord, notes: m.beats.map(function(b){ return b.tok || '-' ; }), lyric: m.lyric || '' };
    });
    var joinedMeasures = serializeScoreMeasures(canonical, ' // ');
    return [cleanTitle, String(beats || 4), String(bpm || 64), cleanBadge, joinedMeasures].join('\t');
  }

  $('#copyVeRowTsvBtn').addEventListener('click', async function(){
    if (refreshScoreValidation().errors.length) return;
    var title = $('#nsTitle').value.trim() || '내 연습곡';
    var beats = Number($('#nsBeats').value) || 4;
    var bpm = Number($('#nsBpm').value) || 64;
    var tsv;
    try { tsv = formatSongToSheetTsv(title, beats, bpm, veState.sourceBadge || ('구글 시트 연동곡 · ' + beats + '/4박자'), [$('#nsMeasuresTxt').value]); }
    catch (e){ $('#ocrStatusTxt').textContent = e.message; return; }
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
    var saveButton = $('#saveNewSongBtn');
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    try {
    if (refreshScoreValidation().errors.length) return;
    var title = $('#nsTitle').value.trim() || '내 연습곡';
    var beats = Number($('#nsBeats').value) || 4;
    var bpm = Number($('#nsBpm').value) || 64;
    var raw = $('#nsMeasuresTxt').value.trim();
    var parsedText = parseScore(raw, beats);
    var lines = serializeScoreMeasures(parsedText.measures, '\n').split('\n');
    if (!lines.length){
      alert('최소 1마디 이상 입력해 주세요.');
      return;
    }
    var targetId = veState.editingSongId || ('custom-' + Date.now());
    var song = buildStructuredSong({
      id: targetId,
      title: title,
      badge: veState.sourceBadge || (veState.refImageDataUrl ? ('교본 변환 악보 · ' + beats + '/4박자') : ('직접 만든 악보 · ' + beats + '/4박자')),
      builtin: false,
      bpm: bpm,
      beats: beats,
      capo: veState.sourceCapo,
      ytUrl: veState.sourceYtUrl,
      lines: lines
    });
    if (veState.refImageDataUrl){
      song.refImageDataUrl = veState.refImageDataUrl;
    }
    if (!await persistSong(song)) return;
    var existIdx = customSongs.findIndex(function(s){ return s.id === targetId; });
    if (existIdx >= 0) customSongs[existIdx] = song;
    else customSongs.push(song);

    $('#newSongModal').hidden = true;
    clearStorageError();
    rebuildSongSelect(song.id);
    } catch (error){
      if (error && error.name === 'ScoreValidationError'){
        var result = {errors:error.errors || [{message:error.message}],warnings:[]};
        $('#scoreValidationStatus').textContent = scoreValidationText(result);
      } else {
        throw error;
      }
    } finally {
      saveButton.disabled = false;
    }
  });


  window.syncScoreModeUI = syncScoreModeUI;
  window.formatSongToSheetTsv = formatSongToSheetTsv;
  window.openConverterEditorModal = openConverterEditorModal;
  window.veState = veState;
}
