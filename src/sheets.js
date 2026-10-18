'use strict';

  var sheetSongs = [];
  var sheetSyncInitialized = false;

  // ---------- 외부 songs.json (저작권 없는 기본 내장곡) 및 구글 스프레드시트 연동 엔진

  async function loadExternalSongsJson(){
    try {
      var res = await fetch('./songs.json', { cache: 'no-store' });
      if (!res.ok) return;
      var arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) return;
      BUILTIN_SONGS = arr.map(function(spec, idx){
        return buildStructuredSong({
          id: spec.id || ('builtin-json-' + idx),
          title: spec.title || ('내장곡 ' + (idx + 1)),
          badge: spec.badge || 'songs.json 내장 악보',
          builtin: true,
          bpm: Number(spec.bpm) || 64,
          beats: Number(spec.beats) || 4,
          ytUrl: spec.ytUrl || '',
          lines: Array.isArray(spec.lines) ? spec.lines : []
        });
      });
    } catch (e){
      // 로컬 file:// 환경 등에서 fetch 차단 시 코드 내장 BUILTIN_SONGS 폴백 사용
    }
  }

  // CORS 및 로컬 file:// 환경 제약을 100% 우회하는 Google Visualization JSONP 로더
  function extractSheetIdAndGid(rawInput){
    var str = (rawInput || '').trim();
    if (!str) return null;
    var m = str.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    var sheetId = m ? m[1] : (/^[a-zA-Z0-9-_]{20,}$/.test(str) ? str : null);
    if (!sheetId) return null;
    var gidMatch = str.match(/[#&?]gid=([0-9]+)/);
    var gid = gidMatch ? gidMatch[1] : '0';
    return { sheetId: sheetId, gid: gid };
  }

  function loadSheetViaJsonp(sheetId, gid){
    return new Promise(function(resolve, reject){
      var cbName = '__gsSheetCb_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      var script = document.createElement('script');
      var timer = setTimeout(function(){
        cleanup();
        reject(new Error('응답 시간 초과. 시트 공유 권한이 [링크가 있는 모든 사용자(뷰어)]인지 확인해 주세요.'));
      }, 8000);

      function cleanup(){
        clearTimeout(timer);
        try { delete window[cbName]; } catch (e){ window[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = function(res){
        cleanup();
        if (!res || res.status === 'error' || !res.table){
          reject(new Error('시트 데이터를 읽지 못했어요.'));
          return;
        }
        var rows = (res.table.rows || []).map(function(r){
          return (r.c || []).map(function(cell){
            if (!cell) return '';
            return cell.v != null ? String(cell.v) : (cell.f != null ? String(cell.f) : '');
          });
        });
        resolve(rows);
      };

      script.onerror = function(){
        cleanup();
        reject(new Error('시트 접근 실패. 시트 우측 상단 [공유] -> [링크가 있는 모든 사용자(뷰어)]로 설정되어 있는지 확인해 주세요.'));
      };

      script.src = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(sheetId) +
        '/gviz/tq?tqx=responseHandler:' + cbName + '&gid=' + encodeURIComponent(gid) + '&_=' + Date.now();
      document.head.appendChild(script);
    });
  }

  async function syncGoogleSheetSongs(rawUrl, silent){
    var info = extractSheetIdAndGid(rawUrl);
    if (!info){
      if (!silent) $('#sheetSyncStatus').textContent = '올바른 구글 스프레드시트 공유 링크(URL)를 입력해 주세요.';
      return false;
    }
    if (!silent) $('#sheetSyncStatus').textContent = '구글 드라이브 스프레드시트에서 악보 데이터를 불러오는 중...';
    try {
      var rows = await loadSheetViaJsonp(info.sheetId, info.gid);
      var parsedSongs = [];


      rows.forEach(function(cols, rIdx){
        var c0 = (cols[0] || '').trim();
        if (!c0) return;
        if (c0 === '곡 제목' || c0 === '제목' || c0.toLowerCase() === 'title') return;

        var title = c0;
        var beats = 4;
        var bpm = 64;
        var badge = '내 구글 시트 악보';
        var rawScoreParts = [];

        var c1 = (cols[1] || '').trim();
        if (c1.indexOf('[') === 0 || c1.indexOf('|') >= 0){
          rawScoreParts = cols.slice(1);
        } else {
          var beatText = c1.trim();
          var bpmText = (cols[2] || '').trim();
          var beatValue = beatText ? Number(beatText) : 4;
          var bpmValue = bpmText ? Number(bpmText) : 64;
          if (!Number.isFinite(beatValue) || Math.floor(beatValue) !== beatValue || [2,3,4,6,8,9].indexOf(beatValue) < 0){
            throw new Error('시트 ' + (rIdx + 1) + '행: 박자는 2, 3, 4, 6, 8, 9 중 하나여야 해.');
          }
          if (!Number.isFinite(bpmValue) || Math.floor(bpmValue) !== bpmValue || bpmValue < 1){
            throw new Error('시트 ' + (rIdx + 1) + '행: BPM은 1 이상의 정수여야 해.');
          }
          beats = beatValue;
          bpm = bpmValue;
          badge = (cols[3] || '').trim() || ('구글 시트 연동곡 · ' + beats + '/4박자');
          rawScoreParts = cols.slice(4);
        }

        var rawJoined = rawScoreParts.map(function(x){ return (x || '').trim(); }).filter(Boolean).join('\n');
        var lines = splitScoreMeasures(rawJoined);
        var validation = validateScore(rawJoined, beats);
        if (validation.errors.length){
          var detail = validation.errors[0];
          throw new Error('시트 ' + (rIdx + 1) + '행 ' + detail.measure + '마디' + (detail.beat ? ' ' + detail.beat + '박' : '') + ': ' + detail.message);
        }
        if (!lines.length) return;

        var songId = 'sheet-song-' + rIdx;

        var song = buildStructuredSong({
          id: songId,
          title: title,
          badge: badge,
          builtin: false,
          bpm: bpm,
          beats: beats,
          lines: lines
        });
        song.fromSheet = true;
        parsedSongs.push(song);
      });

      sheetSongs = parsedSongs;
      ls.set('gs.sheetUrl', rawUrl.trim());
      var nowStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      $('#sheetSyncStatus').textContent = '연동 완료 (' + nowStr + ') · 총 ' + parsedSongs.length + '곡을 내 구글 시트에서 불러왔어요.';
      $('#openSheetSyncBtn').textContent = '구글 시트 (' + parsedSongs.length + '곡)';
      rebuildSongSelect(parsedSongs.length && !silent ? parsedSongs[0].id : appState.lastSongId);
      return true;
    } catch (err){
      if (!silent){
        $('#sheetSyncStatus').textContent = '불러오기 실패: ' + err.message;
      }
      return false;
    }
  }



  function initSheetSync(){
    if (sheetSyncInitialized) return;
    sheetSyncInitialized = true;
    $('#openSheetSyncBtn').addEventListener('click', function(){
      $('#sheetUrlInput').value = ls.get('gs.sheetUrl', '');
      $('#sheetSyncModal').hidden = false;
    });
    $('#closeSheetSyncBtn').addEventListener('click', function(){
      $('#sheetSyncModal').hidden = true;
    });
    $('#syncSheetNowBtn').addEventListener('click', function(){
      syncGoogleSheetSongs($('#sheetUrlInput').value, false);
    });
    $('#clearSheetSyncBtn').addEventListener('click', function(){
      ls.set('gs.sheetUrl', '');
      sheetSongs = [];
      $('#sheetUrlInput').value = '';
      $('#openSheetSyncBtn').textContent = '구글 시트 연동';
      $('#sheetSyncStatus').textContent = '구글 시트 연동이 해제되었어요.';
      rebuildSongSelect((BUILTIN_SONGS[0] ? BUILTIN_SONGS[0].id : (allSongs[0] ? allSongs[0].id : null)));
    });

    $('#copySheetTemplateBtn').addEventListener('click', async function(){
      var header = ['곡 제목', '박자', 'BPM', '교본 쪽수/설명', '마디 악보 (줄바꿈 또는 // 로 마디 구분, 박내 분할은 /)'].join('\t');
      var sample1 = formatSongToSheetTsv(
        '징글 벨즈 (교본 24쪽)',
        4,
        64,
        '교본 24쪽 · 2,3번줄 연습',
        [
          '[G] B3 B3 B3 - | 0시 0시 0시',
          '[G] B3 B3 B3 - | 0시 0시 0시',
          '[G] B3 D4 G3 A3 | 0시 3레 0솔 2라',
          '[G] B3 - - - | 0시 4박 유지'
        ]
      );
      var tsv = header + '\n' + sample1;
      try {
        await navigator.clipboard.writeText(tsv);
        $('#sheetSyncStatus').textContent = '시트 기본 양식이 복사되었어요! 새 구글 스프레드시트의 A1 칸을 클릭하고 Ctrl+V를 누르세요.';
      } catch (e){
        prompt('새 구글 시트 A1 칸에 붙여넣을 양식:', tsv);
      }
    });

    $('#copyCurSongTsvBtn').addEventListener('click', async function(){
      if (scoreEditorHooks && !scoreEditorHooks.beforeAction('악보 복사')) return;
      if (!curSong || curSong.type !== 'structured'){
        alert('구조화된(계이름) 악보가 선택되어 있을 때만 시트 행으로 복사할 수 있어요.');
        return;
      }
      var copyStatus = $('#scoreCopyStatus');
      if (copyStatus) copyStatus.hidden = false;
      try {
        var lines = curSong.measures.map(function(m){
          return { chord: m.chord || '-', autoChord: !!m.autoChord, notes: m.beats.map(function(b){ return (b.tok && b.tok !== '-') ? b.tok : (b.en || '-'); }), lyric: m.lyric || '' };
        });
        var badge = curSong.badge || '';
        var songCapo = getSongCapo(curSong);
        if (songCapo > 0 && !/(?:capo|카포)\s*[:.]?\s*(?:fret\s*)?\d/i.test(badge)) badge = (badge ? badge + ' · ' : '') + 'Capo ' + songCapo;
        var tsv = formatSongToSheetTsv(curSong.title, curSong.beats, Number(curSong.bpm) || 64, badge, lines);
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
          await navigator.clipboard.writeText(tsv);
          if (copyStatus) copyStatus.textContent = '악보를 복사했어. Google Sheets의 빈 행 A열에 붙여넣어.';
        } catch (clipboardError){
          prompt('Google Sheets A열에 붙여넣을 내용:', tsv);
          if (copyStatus) copyStatus.textContent = '복사 권한이 없어 TSV를 입력창에 표시했어. 내용을 복사해 A열에 붙여넣어.';
        }
      } catch (error){
        if (copyStatus) copyStatus.textContent = error.message || '악보를 TSV로 만들지 못했어.';
      }
    });
  }
