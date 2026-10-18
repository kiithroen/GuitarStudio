(function (root) {
  'use strict';

  const STATE_KEY = 'gs.player.v3';
  const DEFAULT_STATE = {
    songId: '', speed: 100, volume: 75, guide: true, metronome: false,
    loopStart: 1, loopEnd: 1, loopEnabled: false, sheetUrl: ''
  };
  const $ = id => document.getElementById(id);
  const ui = {
    select: $('songSelect'), title: $('songTitle'), description: $('songDescription'),
    appStatus: $('appStatus'), storageStatus: $('storageStatus'), score: $('score'),
    placeholder: $('scorePlaceholder'), play: $('playPauseBtn'), stop: $('stopBtn'),
    position: $('positionTxt'), guide: $('guideSoundBtn'), metronome: $('metronomeBtn'),
    volume: $('volumeRange'), speed: $('speedRange'), speedText: $('speedTxt'),
    loopEnabled: $('loopEnable'), loopStart: $('loopStart'), loopEnd: $('loopEnd'),
    fretboard: $('fretboard'), sheetStatus: $('sheetStatus')
  };

  let state = Object.assign({}, DEFAULT_STATE);
  let librarySongs = [];
  let loadedSheetSongs = [];
  let songs = [];
  let selectedId = '';
  let controller = null;
  let currentScore = null;
  let scoreBarCount = 1;
  let loadSequence = 0;
  let sheetSequence = 0;
  let ready = false;
  let playing = false;
  let libraryNotice = '';

  function normalizeState(value) {
    const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const intInRange = (candidate, fallback, min, max) => {
      const number = Number(candidate);
      return Number.isFinite(number)
        ? Math.min(max, Math.max(min, Math.round(number)))
        : fallback;
    };
    const positiveInt = (candidate, fallback) => {
      const number = Number(candidate);
      return Number.isInteger(number) && number > 0 ? number : fallback;
    };
    return {
      songId: typeof data.songId === 'string' ? data.songId : '',
      speed: intInRange(data.speed, DEFAULT_STATE.speed, 25, 200),
      volume: intInRange(data.volume, DEFAULT_STATE.volume, 0, 100),
      guide: typeof data.guide === 'boolean' ? data.guide : DEFAULT_STATE.guide,
      metronome: typeof data.metronome === 'boolean' ? data.metronome : DEFAULT_STATE.metronome,
      loopStart: positiveInt(data.loopStart, DEFAULT_STATE.loopStart),
      loopEnd: positiveInt(data.loopEnd, DEFAULT_STATE.loopEnd),
      loopEnabled: typeof data.loopEnabled === 'boolean' ? data.loopEnabled : DEFAULT_STATE.loopEnabled,
      sheetUrl: typeof data.sheetUrl === 'string' ? data.sheetUrl : ''
    };
  }

  function readState() {
    try {
      state = normalizeState(JSON.parse(localStorage.getItem(STATE_KEY) || '{}'));
    } catch (_) {
      state = Object.assign({}, DEFAULT_STATE);
    }
    if (!state.sheetUrl) {
      try {
        const oldUrl = localStorage.getItem('gs.sheetUrl');
        if (oldUrl) state.sheetUrl = oldUrl;
      } catch (_) {}
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      if (state.sheetUrl) localStorage.setItem('gs.sheetUrl', state.sheetUrl);
      if (!libraryNotice) ui.storageStatus.textContent = '설정 저장됨';
    } catch (error) {
      ui.storageStatus.textContent = '설정 저장 실패: ' + error.message;
    }
  }

  function report(message, error) {
    ui.appStatus.textContent = message + (error ? ': ' + (error.message || error) : '');
    ui.appStatus.classList.toggle('error', !!error);
  }

  function updateTransportButtons() {
    const disabled = !controller || !currentScore || !ready;
    ui.play.disabled = disabled;
    ui.stop.disabled = disabled;
    ui.play.textContent = playing ? '일시정지' : '재생';
  }

  function currentSong() {
    return songs.find(song => song.id === selectedId) || null;
  }

  function mergeSongs() {
    const sheetIds = new Set(loadedSheetSongs.map(song => song.id));
    songs = librarySongs.filter(song => !sheetIds.has(song.id)).concat(loadedSheetSongs);
  }

  function renderSongMenu(preferredId) {
    const wanted = preferredId || selectedId;
    ui.select.replaceChildren();
    songs.forEach(song => {
      const option = document.createElement('option');
      option.value = song.id;
      option.textContent = (song.fromSheet ? '시트 · ' : '') + song.title;
      ui.select.appendChild(option);
    });
    if (!songs.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '악보가 없어';
      ui.select.appendChild(option);
    }
    const next = songs.some(song => song.id === wanted)
      ? wanted
      : songs.some(song => song.id === state.songId)
        ? state.songId
        : (songs[0]?.id || '');
    ui.select.value = next;
    return next;
  }

  function updateSongInfo(song) {
    ui.title.textContent = song?.title || '악보 없음';
    ui.description.textContent = song?.description || song?.badge || '';
  }

  function formatTime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function updatePosition(position) {
    const bar = Math.max(1, (position.barIndex || 0) + 1);
    const currentTime = Number(position.currentTime) || 0;
    const endTime = Number(position.endTime) || 0;
    ui.position.textContent = '마디 ' + bar + ' · ' + formatTime(currentTime)
      + (endTime ? ' / ' + formatTime(endTime) : '');
  }

  function resetLoopForScore(score) {
    const bars = score?.tracks?.[0]?.staves?.[0]?.bars || [];
    scoreBarCount = Math.max(1, bars.length);
    ui.loopStart.max = String(scoreBarCount);
    ui.loopEnd.max = String(scoreBarCount);
    if (state.loopStart > scoreBarCount || state.loopEnd > scoreBarCount
        || state.loopEnd < state.loopStart) {
      state.loopStart = 1;
      state.loopEnd = scoreBarCount;
      state.loopEnabled = false;
      ui.loopEnabled.checked = false;
      controller.setLoop(1, scoreBarCount, false);
      saveState();
    }
    ui.loopStart.value = String(state.loopStart);
    ui.loopEnd.value = String(state.loopEnd);
    ui.loopEnabled.checked = state.loopEnabled;
  }

  function isCurrentScore(score) {
    return controller && score && controller.getScore() === score;
  }

  function createCallbacks() {
    return {
      onScore(score) {
        if (!isCurrentScore(score)) return;
        currentScore = score;
        resetLoopForScore(score);
        ui.placeholder.classList.add('hidden');
        updateTransportButtons();
      },
      onReady(isReady) {
        ready = !!isReady;
        updateTransportButtons();
        if (ready) report('재생 준비 완료');
      },
      onState(isPlaying) {
        playing = !!isPlaying;
        updateTransportButtons();
      },
      onPosition: updatePosition,
      onBeat(beat) {
        const track = beat?.voice?.bar?.staff?.track;
        if (root.GuitarFretboard && currentScore?.tracks?.includes(track)) {
          root.GuitarFretboard.render(ui.fretboard, beat);
        }
      },
      onError(error) {
        ready = false;
        updateTransportButtons();
        report('재생 오류', error);
      }
    };
  }

  function applySettings() {
    if (!controller) return;
    controller.setSpeed(state.speed);
    controller.setVolume(state.volume / 100);
    controller.setGuideSound(state.guide);
    controller.setMetronome(state.metronome);
    controller.setLoop(state.loopStart, state.loopEnd, state.loopEnabled);
  }

  async function chooseSong(id) {
    const song = songs.find(item => item.id === id);
    if (!song || !controller) return;

    const ticket = ++loadSequence;
    const previousReady = ready;
    ready = false;
    playing = false;
    updateTransportButtons();
    ui.position.textContent = '—';
    ui.placeholder.classList.remove('hidden');
    ui.placeholder.textContent = '악보를 불러오는 중…';
    report('악보 불러오는 중…');

    try {
      const score = await controller.loadSong(song);
      if (ticket !== loadSequence || !score || !isCurrentScore(score)) return;

      selectedId = song.id;
      state.songId = song.id;
      ui.select.value = song.id;
      updateSongInfo(song);
      currentScore = score;
      applySettings();
      saveState();
      report(ready ? '재생 준비 완료' : '악보 준비 완료 · 음원 준비 중');
      updateTransportButtons();
    } catch (error) {
      if (ticket !== loadSequence) return;
      const previousScoreStillCurrent = !!currentScore
        && controller.getScore() === currentScore;
      ready = previousReady && previousScoreStillCurrent;
      ui.placeholder.classList.toggle('hidden', previousScoreStillCurrent);
      ui.placeholder.textContent = '악보를 불러오지 못했어.';
      updateSongInfo(currentSong());
      ui.select.value = selectedId;
      report('악보 지원 또는 읽기 오류', error);
      updateTransportButtons();
    }
  }

  async function refreshSongs(preferredId) {
    const result = await root.GuitarLibrary.loadAll();
    librarySongs = result.songs;
    mergeSongs();
    const selected = renderSongMenu(preferredId);
    if (result.warnings?.length) {
      const messages = result.warnings.map(item => item.message).filter(Boolean);
      libraryNotice = '악보 안내: ' + messages.join(' · ');
      ui.storageStatus.textContent = libraryNotice;
    } else {
      libraryNotice = '';
      if (ui.storageStatus.textContent.startsWith('악보 안내:')) ui.storageStatus.textContent = '';
    }
    if (selected) await chooseSong(selected);
  }

  async function saveFromEditor(song) {
    let saved;
    try {
      saved = await root.GuitarLibrary.save(song);
    } catch (error) {
      ui.storageStatus.textContent = (libraryNotice ? libraryNotice + ' · ' : '') + '저장 실패: ' + error.message;
      throw error;
    }
    try {
      await refreshSongs(saved.id);
    } catch (error) {
      ui.storageStatus.textContent = '저장은 완료했지만 곡 목록을 새로 불러오지 못했어: ' + error.message;
    }
    return saved;
  }

  function showEditor(options) {
    root.GuitarEditor.open(Object.assign({ onSave: saveFromEditor }, options || {}));
  }

  function safeFilename(title, extension) {
    const base = (title || 'score').replace(/[\\/:*?"<>|]+/g, '_');
    return base + '.' + extension;
  }

  function download(data, name, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function handleFileImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    (async () => {
      try {
        const extension = file.name.split('.').pop().toLowerCase();
        const supported = ['gp3', 'gp4', 'gp5', 'gpx', 'gp', 'xml', 'musicxml', 'mxl', 'atex', 'txt'];
        if (!supported.includes(extension)) throw new Error('지원하는 파일 형식이 아니야.');
        let song;
        if (extension === 'atex' || extension === 'txt') {
          const alphaTex = await file.text();
          root.TabEngine.parseAlphaTex(alphaTex);
          song = { format: 'alphatex', alphaTex, title: file.name.replace(/\.[^.]+$/, ''), description: '', fileName: file.name };
        } else {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const score = root.TabEngine.importBytes(bytes);
          song = {
            format: 'binary', bytes, fileName: file.name,
            title: score.title || file.name.replace(/\.[^.]+$/, ''), description: ''
          };
        }
        showEditor({ mode: 'import', song });
      } catch (error) {
        report('파일 가져오기 실패', error);
      } finally {
        event.target.value = '';
      }
    })();
  }

  function applyLoopFromInputs() {
    const start = Number(ui.loopStart.value);
    const end = Number(ui.loopEnd.value);
    const enabled = ui.loopEnabled.checked;
    try {
      if (!Number.isInteger(start) || !Number.isInteger(end)
          || start < 1 || end < start || end > scoreBarCount) {
        throw new Error('구간은 1~' + scoreBarCount + '마디의 정수로 지정해줘.');
      }
      controller.setLoop(start, end, enabled);
      state.loopStart = start;
      state.loopEnd = end;
      state.loopEnabled = enabled;
      saveState();
      report(enabled ? '마디 ' + start + '–' + end + ' 반복 적용' : '구간 반복 꺼짐');
    } catch (error) {
      report('구간 반복 오류', error);
    }
  }

  function wireScoreSeeking() {
    const api = controller.api;
    if (!api?.beatMouseUp?.on) return;
    api.beatMouseUp.on(beat => {
      try {
        const entries = api.tickCache?.masterBars?.filter(item => item.masterBar === beat.voice.bar.masterBar);
        if (!entries?.length) throw new Error('클릭한 마디의 재생 위치가 준비되지 않았어.');
        api.tickPosition = entries[0].start + beat.playbackStart;
      } catch (error) {
        report('악보 위치 이동 실패', error);
      }
    });
  }

  async function syncSheet() {
    const ticket = ++sheetSequence;
    const url = $('sheetUrl').value.trim();
    state.sheetUrl = url;
    saveState();
    ui.sheetStatus.textContent = '시트 동기화 중…';
    ui.sheetStatus.classList.remove('error');
    try {
      const sheetSongs = await root.GuitarSheets.fetchSongs(url);
      if (ticket !== sheetSequence) return;
      loadedSheetSongs = sheetSongs;
      mergeSongs();
      const selected = renderSongMenu(selectedId);
      ui.sheetStatus.textContent = sheetSongs.length + '곡을 불러왔어.';
      if (selected) await chooseSong(selected);
    } catch (error) {
      if (ticket !== sheetSequence) return;
      ui.sheetStatus.textContent = '동기화 실패: ' + error.message;
      ui.sheetStatus.classList.add('error');
    }
  }

  function wire() {
    ui.select.addEventListener('change', () => chooseSong(ui.select.value));
    $('openNewSongBtn').addEventListener('click', () => showEditor({ mode: 'new' }));
    $('editSongBtn').addEventListener('click', () => {
      const song = currentSong();
      if (song) showEditor({ mode: 'edit', song });
    });
    $('deleteSongBtn').addEventListener('click', async () => {
      const song = currentSong();
      if (!song) return;
      if (song.builtin || song.fromSheet) {
        report(song.builtin ? '내장곡은 삭제할 수 없어.' : '시트 곡은 개인곡으로 저장한 뒤 관리해줘.');
        return;
      }
      if (!confirm('개인 악보를 삭제할까?')) return;
      try {
        await root.GuitarLibrary.remove(song.id);
        await refreshSongs();
      } catch (error) {
        ui.storageStatus.textContent = (libraryNotice ? libraryNotice + ' · ' : '') + '삭제 실패: ' + error.message;
        report('삭제 실패', error);
      }
    });
    $('importFileBtn').addEventListener('click', () => $('scoreFileInput').click());
    $('scoreFileInput').addEventListener('change', handleFileImport);
    $('downloadSourceBtn').addEventListener('click', () => {
      const song = currentSong();
      if (!song) return;
      const binarySource = song.format === 'binary'
        ? song
        : song.sourceOriginal?.format === 'binary' ? song.sourceOriginal : null;
      if (binarySource) {
        download(binarySource.bytes, binarySource.fileName || safeFilename(song.title, 'gp'), 'application/octet-stream');
      } else {
        download(song.alphaTex, safeFilename(song.title, 'atex'), 'text/plain;charset=utf-8');
      }
    });
    $('exportGpBtn').addEventListener('click', () => {
      try {
        if (!currentScore) throw new Error('악보가 준비되지 않았어.');
        download(root.TabEngine.exportGp(currentScore), safeFilename(currentSong()?.title, 'gp'), 'application/octet-stream');
      } catch (error) {
        report('GP 내보내기 실패', error);
      }
    });
    ui.play.addEventListener('click', () => {
      try {
        if (!ready) return;
        if (playing) controller.pause();
        else controller.play();
      } catch (error) {
        report('재생 오류', error);
      }
    });
    ui.stop.addEventListener('click', () => {
      if (!ready) return;
      controller.stop();
      playing = false;
      updateTransportButtons();
    });
    ui.guide.addEventListener('click', () => {
      state.guide = !state.guide;
      controller.setGuideSound(state.guide);
      ui.guide.setAttribute('aria-pressed', String(state.guide));
      ui.guide.textContent = '가이드음 ' + (state.guide ? '켬' : '끔');
      saveState();
    });
    ui.metronome.addEventListener('click', () => {
      state.metronome = !state.metronome;
      controller.setMetronome(state.metronome);
      ui.metronome.setAttribute('aria-pressed', String(state.metronome));
      ui.metronome.textContent = '메트로놈 ' + (state.metronome ? '켬' : '끔');
      saveState();
    });
    ui.volume.addEventListener('input', () => {
      state.volume = normalizeState({ volume: ui.volume.value }).volume;
      controller.setVolume(state.volume / 100);
      saveState();
    });
    ui.speed.addEventListener('input', () => {
      state.speed = normalizeState({ speed: ui.speed.value }).speed;
      ui.speedText.textContent = state.speed + '%';
      controller.setSpeed(state.speed);
      saveState();
    });
    $('applyLoopBtn').addEventListener('click', applyLoopFromInputs);
    $('sheetUrl').value = state.sheetUrl;
    $('syncSheetBtn').addEventListener('click', syncSheet);
    $('copySheetTsvBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(root.GuitarSheets.toTsv(currentSong()));
        ui.sheetStatus.classList.remove('error');
        ui.sheetStatus.textContent = '현재 곡 TSV를 복사했어.';
      } catch (error) {
        ui.sheetStatus.textContent = 'TSV 복사 실패: ' + error.message;
        ui.sheetStatus.classList.add('error');
      }
    });
    document.addEventListener('keydown', event => {
      if (event.target.matches('input,textarea,select,[contenteditable=true]') || $('editorDialog').open) return;
      if (event.code === 'Space') {
        event.preventDefault();
        ui.play.click();
      } else if (event.key === 'Escape') {
        $('editorDialog').close();
      } else if (event.key.toLowerCase() === 'g') {
        ui.guide.click();
      } else if (event.key.toLowerCase() === 'm') {
        ui.metronome.click();
      }
    });
    wireScoreSeeking();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    readState();
    ui.volume.value = String(state.volume);
    ui.speed.value = String(state.speed);
    ui.speedText.textContent = state.speed + '%';
    ui.guide.setAttribute('aria-pressed', String(state.guide));
    ui.guide.textContent = '가이드음 ' + (state.guide ? '켬' : '끔');
    ui.metronome.setAttribute('aria-pressed', String(state.metronome));
    ui.metronome.textContent = '메트로놈 ' + (state.metronome ? '켬' : '끔');
    ui.loopStart.value = String(state.loopStart);
    ui.loopEnd.value = String(state.loopEnd);
    ui.loopEnabled.checked = state.loopEnabled;
    updateTransportButtons();
    try {
      controller = root.TabEngine.create(ui.score, createCallbacks());
      applySettings();
      wire();
      await refreshSongs(state.songId);
    } catch (error) {
      ui.storageStatus.textContent = '저장소 오류: ' + error.message;
      report('앱을 시작하지 못했어', error);
      ui.placeholder.textContent = '악보 목록 또는 저장소를 읽지 못했어.';
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
