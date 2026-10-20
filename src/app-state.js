'use strict';

// 연습 화면과 악보 입력 화면이 같이 쓰는 앱 설정 상태와 오디오 런타임 전역

  function stripRemovedAudioSettings(state){
    var clean = Object.assign({}, state || {});
    delete clean.micScoring;
    delete clean.micDeviceId;
    return clean;
  }
  var CLICK_MODES = ['all', 'countin', 'off']; // 메트로놈 클릭: 'all' 카운트인+재생 내내 / 'countin' 시작 전 한 마디만 / 'off' 카운트인 없이 바로 시작
  var appState = stripRemovedAudioSettings(ls.get('gs.state', {
    lastSongId: 'builtin-lv1-butterfly',
    bpm: 64,
    beats: 4,
    vol: 0.55,
    guitarVol: 1,
    guideSound: true,
    acousticFx: true, // 고품질 음향 효과 (콘서트홀 리버브, 바디 공명, 2단 서스테인) 토글
    loopEnable: true,
    loopStart: 1,
    loopEnd: 8,
    speedTrainer: false,
    audioOffsetMs: 0
  }));
  if (typeof appState.acousticFx !== 'boolean') appState.acousticFx = true;
  // 클릭음 vol 은 0~2(100%를 넘기면 기본보다 크게), 기타 연주음 guitarVol 은 0~1. 숫자가 아니거나 범위 밖이면 기본값
  function normalizeVolume(v, def, max){ return typeof v === 'number' && isFinite(v) && v >= 0 && v <= max ? v : def; }
  appState.vol = normalizeVolume(appState.vol, 0.55, 2);
  appState.guitarVol = normalizeVolume(appState.guitarVol, 1, 1);
  if (typeof appState.audioOffsetMs !== 'number') appState.audioOffsetMs = 0;
  if (appState.synthEngine !== 'classic') appState.synthEngine = 'ks'; // 기타 음원: 'ks' 물리 모델 / 'classic' 기존 합성음
  if (typeof appState.bodyAmount !== 'number') appState.bodyAmount = 1.0; // 울림통 공명 세기 (0~2, 1이 기본)
  if (typeof appState.sympAmount !== 'number') appState.sympAmount = 1.0; // 공명현 세기 (0~2, 0이면 꺼짐)
  if (['tab', 'both', 'staff', 'card'].indexOf(appState.scoreView) < 0) appState.scoreView = 'tab'; // 악보 보기 모드: 'tab' 6현 타브(기본) / 'both' 타브+오선 / 'staff' 오선 / 'card' 박자 카드
  if (CLICK_MODES.indexOf(appState.clickMode) < 0) appState.clickMode = 'all';
  if (appState.notationMode !== 'solfege') appState.notationMode = 'cde';

  // 오디오 및 메트로놈 런타임 (어쿠스틱 바디 공명 + 콘서트홀 리버브 버스 포함)
  var actx = null, outGain = null;
  var guitarBus = null, reverbNode = null, pluckNoiseBuf = null, clickBus = null;
  var dryGainNode = null, wetGainNode = null, bodyModes = [];
  var stringVoices = {}; // 줄 번호(1~6)별 현재 울리고 있는 보이스 목록 (같은 줄 재탄현 시 이전 음 정지용)
  // 기타 마스터 음량: 화음과 명시 아포얀도의 동시 탄현을 고려한 공통 출력 레벨
  var GUITAR_MASTER_GAIN = 0.75;
