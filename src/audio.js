'use strict';
  // ---------- WebAudio 신디사이저 (클래식 기타 바디 공명 + 콘서트홀 리버브 + 권선현/나일론현 배음 합성)
  // 콘서트홀 잔향 IR: 대역별 지수 감쇠(저음 1.9초 · 중음 1.6초 · 고음 1.0초)로 고음 잔향이 먼저 사라지고,
  // 확산 잔향은 30ms 시상수로 차오르며, 초기 반사음은 양 채널 같은 극성(모노 합산 시 빗살 필터 착색 없음)
  var REVERB_RT = { low: 1.9, mid: 1.6, high: 1.0 }; // <500Hz, 500Hz~3.5kHz, >3.5kHz
  var CONCERT_HALL_WET_GAIN = 0.35;
  // 기존 합성음의 저음 고배음이 지나치게 깎이지 않도록 cutoff 하한을 둠
  var CLASSIC_BASS_ATTACK_CUTOFF = 1200;
  var CLASSIC_BASS_DECAY_CUTOFF = 600;
  var NATURAL_TAIL_FADE = 0.04;
  // 클래식 기타 몸통 공명 모드 [주파수Hz, Q, 원음 대비 크기]: 공기(헬름홀츠) · 상판 기본 · 상판-뒤판 결합 · 고차 상판 모드
  var BODY_MODES = [
    [96, 8.5, 0.36],   // 헬름홀츠 공기 공명 (A0)
    [188, 9.5, 0.32],  // 상판 기본 모노폴 (T1)
    [242, 8.0, 0.16],  // 상판-뒤판 결합 (T2)
    [385, 7.5, 0.18],  // 상판 크로스그레인 (T3)
    [540, 7.0, 0.14],  // 상판 중역 울림
    [820, 5.5, 0.11],  // 브리지 힐(Bridge hill) 중심 대역
    [1350, 4.5, 0.07]  // 브리지 힐 고역 나무 윤곽
  ];
  var DRY_BODY_RATIO = 0.35; // 콘서트홀 OFF(드라이)에서도 유지하는 기본 상판 공명 비율
  var REVERB_EARLY = [ // [초, 크기] 채널별로 시간만 다르게 해 자연스러운 좌우 폭
    [[0.019, 0.42], [0.027, 0.33], [0.041, 0.27], [0.053, 0.21], [0.068, 0.16], [0.083, 0.12]],
    [[0.022, 0.40], [0.031, 0.31], [0.037, 0.26], [0.058, 0.20], [0.072, 0.15], [0.089, 0.11]]
  ];
  var trackedGuideVoices = [];

  function trackGuideVoice(voice, when){
    var now = actx ? actx.currentTime : when;
    trackedGuideVoices = trackedGuideVoices.filter(function(active){ return active && active.end > now; });
    trackedGuideVoices.push(voice);
  }

  function buildConcertHallReverbBuffer(ctx){
    var rate = ctx.sampleRate;
    var len = Math.floor(rate * 2.4);
    var buf = ctx.createBuffer(2, len, rate);
    var pre = 0.018;
    // 2단 1차 로우패스로 노이즈를 세 대역으로 나눠 각각 다른 속도로 감쇠
    var cLo = 1 - Math.exp(-2 * Math.PI * 500 / rate), cHi = 1 - Math.exp(-2 * Math.PI * 3500 / rate);
    var cAir = 1 - Math.exp(-2 * Math.PI * 5200 / rate);
    var cWall = 1 - Math.exp(-2 * Math.PI * 9000 / rate);

    for (var ch = 0; ch < 2; ch++){
      var data = buf.getChannelData(ch);
      var rnd = seededRandom(9001 + ch * 7919); // 매번 같은 잔향 음색 (좌우는 서로 다른 노이즈로 공간감)
      var lo = 0, loB = 0, hi = 0, hiB = 0, air = 0;
      for (var i = Math.floor(rate * pre); i < len; i++){
        var tt = i / rate - pre;
        var w = rnd() * 2 - 1;
        lo += cLo * (w - lo); loB += cLo * (lo - loB);
        hi += cHi * (w - hi); hiB += cHi * (hi - hiB);
        var highNoise = w - hiB;
        air += cAir * (highNoise - air);
        var env = loB * Math.exp(-6.91 * tt / REVERB_RT.low)
          + (hiB - loB) * Math.exp(-6.91 * tt / REVERB_RT.mid)
          + air * Math.exp(-6.91 * tt / REVERB_RT.high);
        data[i] = env * (1 - Math.exp(-tt / 0.03)) * 0.35;
      }
      // 초기 반사음: 2ms 폭으로 살짝 퍼뜨려 딱딱한 클릭 없이 벽면 반사의 입체감만 남김
      var spread = Math.floor(rate * 0.002);
      REVERB_EARLY[ch].forEach(function(er){
        var c = Math.floor(er[0] * rate);
        for (var k = -spread; k <= spread; k++){
          if (c + k >= 0 && c + k < len) data[c + k] += er[1] * (0.5 + 0.5 * Math.cos(Math.PI * k / spread)) / spread;
        }
      });
      // 벽면 고역 흡수를 모사하는 가벼운 1차 스무딩
      var sm = 0;
      for (var s = 0; s < len; s++){
        sm += cWall * (data[s] - sm);
        data[s] = sm;
      }
      var fade = Math.floor(rate * 0.1);
      for (var j = len - fade; j < len; j++) data[j] *= (len - j) / fade;
    }
    return buf;
  }

  function buildPluckNoiseBuffer(ctx){
    var rate = ctx.sampleRate;
    var len = Math.floor(rate * 0.026);
    var buf = ctx.createBuffer(1, len, rate);
    var data = buf.getChannelData(0);
    var prev = 0;
    for (var i = 0; i < len; i++){
      var env = Math.pow(1 - (i / len), 2.2);
      var w = Math.random() * 2 - 1;
      prev = (prev + 0.35 * w) * 0.72;
      data[i] = prev * env;
    }
    return buf;
  }

  function guitarVolumeGain(){
    var v = appState.guitarVol;
    return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1 ? v : 1.0;
  }

  // 연주음 슬라이더 값을 기타 버스 gain 에 짧은 램프로 반영 (콘서트홀 전환과 같은 40ms)
  function updateGuitarVolume(){
    if (!actx || !guitarBus || !guitarBus.gain) return;
    var now = actx.currentTime;
    guitarBus.gain.cancelScheduledValues(now);
    guitarBus.gain.setValueAtTime(guitarBus.gain.value, now);
    guitarBus.gain.linearRampToValueAtTime(guitarVolumeGain(), now + 0.04);
  }

  function ensureAudioCtx(){
    if (!actx){
      var AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC({ latencyHint: 'interactive' });
    }
    if (actx.state !== 'running') actx.resume();
    if (!outGain){
      // 기타 마스터: 리미터가 평소에는 개입하지 않도록 헤드룸 확보 (값과 실측 근거는 GUITAR_MASTER_GAIN 참고)
      outGain = actx.createGain();
      outGain.gain.value = GUITAR_MASTER_GAIN;

      // 마스터 리미터는 -3dB에서 여유를 확보해 여러 현의 순간 합산 피크를 누름
      // (DynamicsCompressorNode는 약 6ms 룩어헤드 지연이 있으므로 기타와 클릭이 이 노드를 거쳐 타이밍을 맞춤)
      var comp = actx.createDynamicsCompressor();
      comp.threshold.value = -3.0;
      comp.knee.value = 0;
      comp.ratio.value = 20.0;
      comp.attack.value = 0.001;
      comp.release.value = 0.10;

      // 메트로놈 클릭 전용 버스 (기타 마스터 음량과 독립, 리미터만 공유)
      clickBus = actx.createGain();
      clickBus.gain.value = 1.0;

      // 기타 소리 전부가 지나는 버스: 연주음 슬라이더(appState.guitarVol)가 이 gain 에 곱해진다. 클릭 버스는 영향받지 않음
      guitarBus = actx.createGain();
      guitarBus.gain.value = guitarVolumeGain();

      dryGainNode = actx.createGain();
      dryGainNode.gain.value = 0.88;

      wetGainNode = actx.createGain();
      wetGainNode.gain.value = appState.acousticFx ? CONCERT_HALL_WET_GAIN : 0.0;

      reverbNode = actx.createConvolver();
      reverbNode.buffer = buildConcertHallReverbBuffer(actx);

      // 클래식 기타 울림통 공명: 원음 + 공명 모드별 대역 통과 필터를 병렬로 더함
      // 각 모드가 짧게(0.04~0.27초) 울리고 모드 사이에는 자연스러운 골이 생겨, 넓게 부풀리는 EQ보다 덜 답답한 나무 울림통 소리
      var bodyOut = actx.createGain();
      guitarBus.connect(bodyOut);
      var bodyScale = appState.synthEngine === 'classic' ? 0 : (appState.acousticFx ? 1.0 : DRY_BODY_RATIO);
      bodyModes = BODY_MODES.map(function(m){
        var bp = actx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = m[0];
        bp.Q.value = m[1];
        var mg = actx.createGain();
        mg.gain.value = bodyScale * m[2] * appState.bodyAmount;
        guitarBus.connect(bp);
        bp.connect(mg);
        mg.connect(bodyOut);
        return { gain: mg, level: m[2] };
      });
      bodyOut.connect(dryGainNode);
      bodyOut.connect(reverbNode);
      reverbNode.connect(wetGainNode);

      dryGainNode.connect(outGain);
      wetGainNode.connect(outGain);
      outGain.connect(comp);
      clickBus.connect(comp);
      comp.connect(actx.destination);
    }
    return actx;
  }

  // 콘서트홀 음향 특수효과 (리버브·바디공명 EQ·서스테인) 실시간 라우팅 전환
  function updateAudioFxRouting(){
    if (!actx || !dryGainNode) return;
    var now = actx.currentTime;
    var on = !!appState.acousticFx;
    if (dryGainNode && dryGainNode.gain){
      dryGainNode.gain.cancelScheduledValues(now);
      dryGainNode.gain.setValueAtTime(dryGainNode.gain.value, now);
      dryGainNode.gain.linearRampToValueAtTime(0.88, now + 0.04);
    }
    if (wetGainNode && wetGainNode.gain){
      wetGainNode.gain.cancelScheduledValues(now);
      wetGainNode.gain.setValueAtTime(wetGainNode.gain.value, now);
      wetGainNode.gain.linearRampToValueAtTime(on ? CONCERT_HALL_WET_GAIN : 0.0, now + 0.04);
    }
    var bodyScale = appState.synthEngine === 'classic' ? 0 : (on ? 1.0 : DRY_BODY_RATIO);
    bodyModes.forEach(function(m){
      m.gain.gain.cancelScheduledValues(now);
      m.gain.gain.setValueAtTime(m.gain.gain.value, now);
      m.gain.gain.linearRampToValueAtTime(m.level * appState.bodyAmount * bodyScale, now + 0.04);
    });
  }

  // 어쿠스틱 우드블록(Woodblock) 메트로놈 클릭 (#volRange '클릭음' 슬라이더로 독립 조절, 0이면 무음)
  function scheduleMetronomeClick(t, isAccent, isSubBeat){
    if (appState.vol <= 0.01) return;
    ensureAudioCtx();
    var o = actx.createOscillator();
    var g = actx.createGain();
    o.type = 'triangle';
    var startFreq = isAccent ? 920 : (isSubBeat ? 540 : 700);
    var endFreq = isAccent ? 380 : (isSubBeat ? 250 : 310);
    var amp = isAccent ? 0.36 : (isSubBeat ? 0.09 : 0.21);
    var clickDur = isSubBeat ? 0.024 : 0.034;

    o.frequency.setValueAtTime(startFreq, t);
    o.frequency.exponentialRampToValueAtTime(endFreq, t + clickDur);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, appState.vol * amp), t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + clickDur);
    o.connect(g);
    g.connect(clickBus || actx.destination);
    o.start(t);
    o.stop(t + clickDur + 0.005);
  }

  // 같은 줄을 다시 튕기면 이전 진동은 새 탄현에 막혀 바로 멈춤: 이전 보이스를 12ms 시상수로 빠르게 감쇠시켜 음 겹침·탁함 제거
  // (30ms 이내 거의 동시 탄현은 롤·화음 표현이므로 함께 울리도록 둠)
  function dampSameStringVoices(strNo, t){
    var list = stringVoices[strNo];
    if (!list) return;
    stringVoices[strNo] = list.filter(function(v){
      if (v.end <= t) return false;
      if (t - v.start <= 0.03 && !v.symp) return true; // 공명현 울림은 그 줄을 직접 치면 항상 멈춤
      v.damp.gain.setValueAtTime(1, t);
      v.damp.gain.setTargetAtTime(0, t, v.harmonic ? 0.032 : 0.012);
      var cut = t + (v.harmonic ? 0.18 : 0.1);
      if (cut < v.end){
        v.srcs.forEach(function(o){ try { o.stop(cut); } catch (e){} });
        v.end = cut;
      }
      return false;
    });
  }

  // ---------- Karplus-Strong 확장형 나일론 현 물리 모델
  // 한 주기 길이의 지연선에 탄현 파형을 넣고 손실 필터로 되먹임: 고배음이 먼저 사라지는 실제 현의 감쇠와 배음 구조가 저절로 생김
  // 음·주법마다 처음 한 번만 AudioBuffer로 렌더링해 캐시하고, 연주할 때는 버퍼만 재생 (노드 수·CPU 부담 최소)
  var ksCache = new Map();
  var KS_CACHE_MAX = 64;
  // 내장곡 실측: 기존 합성음 대비 RMS가 대부분 곡에서 +0~1dB, 긴 저음이 많은 느린 곡(푸른 옷소매·로망스)은 -1~-2.6dB, 피크는 -4dBFS 이하
  // (두 방향 진동 도입으로 어택 직후가 빨리 줄어든 만큼 0.45에서 +0.6dB 보정)
  var KS_VOICE_GAIN = 0.48;

  function seededRandom(seed){ // 현 음색·잔향이 매번 똑같이 나오도록 시드 고정 난수 (mulberry32)
    return function(){
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var r = Math.imul(seed ^ seed >>> 15, 1 | seed);
      r = r + Math.imul(r ^ r >>> 7, 61 | r) ^ r;
      return ((r ^ r >>> 14) >>> 0) / 4294967296;
    };
  }

  // 1차 로우패스 손실 필터 (1-a)/(1-a·z^-1)의 각주파수 w에서의 감쇠량(neper)
  function ksLoopLoss(w, a){ return -Math.log((1 - a) / Math.sqrt(1 - 2 * a * Math.cos(w) + a * a)); }

  // 두 방향 진동(2단 감쇠): 실제 줄은 상판에 수직·수평 두 방향으로 함께 진동
  // 수직 진동은 상판을 세게 밀어 소리가 크지만 금방 줄고, 수평 진동은 약하게 전달돼 오래 남음 → "처음엔 빨리 줄고 꼬리는 길게" 울리는 기타 특유의 감쇠
  // 아포얀도는 줄을 상판 쪽으로 눌러 수직 성분이 많고(어택이 두툼), 표시 없는 음(티란도)은 옆으로 뜯어 수평 성분이 많음(여운이 김)
  var KS_POLAR = {
    vT60: 0.35, vHigh: 0.8,   // 수직: 기본 감쇠 시간 대비 배수 (기음, 3kHz)
    hT60: 1.4, hHigh: 1.15,   // 수평
    vDetuneCents: -0.8,       // 수직 진동만 아주 살짝 낮게 (미세한 맥놀이, 오래 남는 수평 진동은 정확한 음정)
    apo: [0.62, 0.48], tir: [0.48, 0.58] // [수직, 수평] 비율
  };

  function ksArticulationKey(articulation){
    if (articulation === 'slur') return 'slur';
    if (articulation === 'harmonic') return 'harmonic';
    if (articulation === 'apoyando' || articulation === true) return true;
    return false;
  }

  function getNaturalDecayProfile(midi, artOrApo, strNo){
    var art = ksArticulationKey(artOrApo);
    var isApoyando = art === true;
    var isHarmonic = art === 'harmonic';
    var isSlur = art === 'slur';
    var frequency = 440 * Math.pow(2, (midi - 69) / 12);
    var st = strNo ? STRINGS[strNo - 1] : null;
    var fret = st ? Math.max(0, midi - st.midi) : 0;
    var isWound = st ? strNo >= 4 : midi < 55;

    var noFretPenalty = isHarmonic || (typeof GuitarNotation !== 'undefined' && GuitarNotation.MAX_FRET ? fret > GuitarNotation.MAX_FRET : fret > 24);
    var fretFundPenalty = noFretPenalty ? 1.0 : (fret > 0 ? 0.92 : 1.0);
    var fretHighPenalty = noFretPenalty ? 1.0 : ((fret > 0 ? 0.95 : 1.0) * Math.max(0.88, 1 - 0.008 * fret));

    var t60Fund = 8.0 * Math.pow(frequency / 82.4, -0.33) * (isApoyando ? 1.15 : 1.0) * fretFundPenalty;
    var t60High = (isHarmonic ? (isWound ? 0.72 : 0.78) : (isWound ? 0.6 : (isApoyando ? 0.5 : 0.6))) * fretHighPenalty;

    if (isHarmonic){
      t60Fund *= 1.08;
    }
    if (isSlur){
      t60High *= 0.85;
    }

    var duration = Math.min(isWound ? 6 : 5, t60Fund * KS_POLAR.hT60);
    return {frequency:frequency,fret:fret,isWound:isWound,t60Fund:t60Fund,t60High:t60High,duration:duration};
  }

  // 한 방향 진동의 루프 필터·지연 설계: 기음과 3kHz 두 지점의 감쇠 시간(T60)과 정확한 음정을 동시에 맞춤
  function ksDesign(sr, f, t60Fund, t60High, dispCoeff){
    var w1 = 2 * Math.PI * f / sr, wh = 2 * Math.PI * 3000 / sr;
    var s1 = 6.91 / t60Fund, sh = 6.91 / t60High;
    // 루프 필터 g·(1-a)/(1-a·z^-1): 기음과 3kHz 두 지점의 감쇠가 목표와 맞도록 a를 이분 탐색한 뒤 g로 전체 길이 맞춤
    var need = (sh - s1) / f, lo = 0, hi = 0.999, a = 0;
    if (need > 0){
      if (ksLoopLoss(wh, hi) - ksLoopLoss(w1, hi) <= need) a = hi;
      else {
        for (var it = 0; it < 50; it++){
          var mid = (lo + hi) / 2;
          if (ksLoopLoss(wh, mid) - ksLoopLoss(w1, mid) < need) lo = mid; else hi = mid;
        }
        a = (lo + hi) / 2;
      }
    }
    var g = Math.min(0.99999, Math.exp(-(s1 / f - ksLoopLoss(w1, a))));
    // 정확한 음정: 지연선(정수) + 손실 필터 위상 지연 + 분산 올패스 위상 지연 + 1차 allpass 분수 지연의 합이 정확히 한 주기가 되도록
    var pd = Math.atan2(a * Math.sin(w1), 1 - a * Math.cos(w1)) / w1;
    var D = dispCoeff || 0;
    var dispDelay = D ? Math.atan2((1 - D * D) * Math.sin(w1), 2 * D + (1 + D * D) * Math.cos(w1)) / w1 : 0;
    var totalDelay = sr / f - pd - dispDelay;
    var N = Math.max(2, Math.floor(totalDelay - 0.1));
    var d = totalDelay - N;
    return { a: a, g: g, N: N, C: (1 - d) / (1 + d), D: D };
  }

  // 탄현 파형: 배음 크기를 |sin(kπβ)|/k^p * sinc(kπ·fleshWidth) 로 정해 한 주기를 합성 (β: 브리지에서 튕긴 위치)
  function ksExcitation(N, f, midi, artOrApo, betaScale, isWound){
    var art = ksArticulationKey(artOrApo);
    var isApoyando = art === true;
    var isHarmonic = art === 'harmonic';
    var isSlur = art === 'slur';

    var fleshWidth = isHarmonic ? 0.055 : (isSlur ? 0.065 : (isApoyando ? 0.042 : 0.032));
    var beta, p, K;
    if (isHarmonic){
      beta = 0.18;
      p = 1.95;
      K = Math.min(Math.floor(N / 2) - 1, 6);
    } else if (isSlur){
      beta = Math.min(0.45, 0.22 * (betaScale || 1));
      p = 1.95;
      K = Math.min(Math.floor(N / 2) - 1, Math.floor(10000 / f));
    } else if (isApoyando){
      beta = Math.min(0.45, 0.20 * (betaScale || 1));
      p = 1.65;
      K = Math.min(Math.floor(N / 2) - 1, Math.floor(10000 / f));
    } else {
      beta = Math.min(0.45, 0.135 * (betaScale || 1));
      p = isWound ? 1.32 : 1.48;
      K = Math.min(Math.floor(N / 2) - 1, Math.floor(10000 / f));
    }
    if (K < 1) K = 1;

    var rnd = seededRandom(midi * 977 + (isHarmonic ? 4 : (isSlur ? 3 : (isApoyando ? 1 : 2))));
    var tone = new Float32Array(N), nz = new Float32Array(N), s = 0, i, k;
    for (k = 1; k <= K; k++){
      var sincArg = k * Math.PI * fleshWidth;
      var sinc = sincArg !== 0 ? Math.sin(sincArg) / sincArg : 1;
      var amp = (Math.sin(k * Math.PI * beta) / Math.pow(k, p)) * sinc;
      var ph = 0.22 * k * k + (rnd() * 2 - 1) * 0.08;
      // sin을 매 샘플 계산하지 않고 복소 회전으로 누적 (렌더링 속도)
      var cs = Math.cos(2 * Math.PI * k / N), sn = Math.sin(2 * Math.PI * k / N), re = Math.cos(ph), im = Math.sin(ph);
      for (i = 0; i < N; i++){
        tone[i] += amp * im;
        var nr = re * cs - im * sn;
        im = re * sn + im * cs;
        re = nr;
      }
    }
    // 손끝·손톱이 줄을 스치는 질감용 약한 노이즈
    for (i = 0; i < N; i++){
      s += 0.5 * ((rnd() * 2 - 1) - s);
      nz[i] = s;
    }
    [tone, nz].forEach(function(x){ // 평균 0, RMS 1로 정규화
      var m = 0, r = 0, j;
      for (j = 0; j < x.length; j++) m += x[j];
      m /= x.length;
      for (j = 0; j < x.length; j++){ x[j] -= m; r += x[j] * x[j]; }
      r = Math.sqrt(r / x.length) || 1;
      for (j = 0; j < x.length; j++) x[j] /= r;
    });
    var nzRatio = isHarmonic ? 0.014 : (isSlur ? 0.015 : 0.025);
    var dl = new Float32Array(N);
    for (i = 0; i < N; i++) dl[i] = (1 - nzRatio) * tone[i] + nzRatio * nz[i];
    return dl;
  }

  // 한 방향 진동을 렌더링해 out에 w 비율로 더함
  function ksRunString(D, dl, out, w){
    var N = D.N, gb = D.g * (1 - D.a), a = D.a, C = D.C, dispD = D.D || 0;
    var idx = 0, lp = 0, apX = 0, apY = 0;
    var dpX = 0, dpY = 0;
    var hasDisp = dispD !== 0;
    for (var n = 0; n < out.length; n++){
      var x = dl[idx];
      lp = gb * x + a * lp;                        // 손실(고역 감쇠) 필터
      var sig = lp;
      if (hasDisp){
        var dp = dispD * lp + dpX - dispD * dpY;   // 1차 분산 올패스
        dpX = lp; dpY = dp;
        sig = dp;
      }
      var y = C * sig + apX - C * apY;             // 튜닝 allpass
      apX = sig; apY = y;
      dl[idx] = y;
      out[n] += w * x;
      if (++idx === N) idx = 0;
    }
  }

  // strNo: 실제로 튕기는 줄(1~6). 같은 음높이라도 줄과 프렛에 따라 음색이 달라짐
  // - 높은 프렛일수록 진동 길이가 짧아져 오른손 탄현 위치가 상대적으로 줄 가운데로 감 → 둥글고 어두움
  //   (연주자는 고음에서 오른손을 브리지 쪽으로 옮겨 보정하므로 물리적 이동량 2^(프렛/12)의 20%만 반영:
  //    100% 반영하면 로망스 12프렛 E5 아포얀도의 2배음이 -27dB까지 떨어져 음이 흐릿해짐)
  // - 손가락으로 짚은 줄은 손끝이 고음을 흡수해 개방현보다 고음 배음과 여운이 조금 짧음
  // - 4·5·6번줄은 금속 권선현이라 고음 배음이 더 오래 남음
  function renderKsString(ctx, midi, artOrApo, strNo){
    var sr = ctx.sampleRate;
    var art = ksArticulationKey(artOrApo);
    var isApoyando = art === true;
    var isHarmonic = art === 'harmonic';
    var isSlur = art === 'slur';

    var profile = getNaturalDecayProfile(midi, art, strNo);
    var f = profile.frequency;
    var fret = profile.fret;
    var isWound = profile.isWound;
    var t60Fund = profile.t60Fund;
    var t60High = profile.t60High;
    var P = KS_POLAR, wts = isApoyando ? P.apo : P.tir;

    var baseDisp = isHarmonic ? 0 : (isWound ? -0.28 : (strNo === 3 ? -0.20 : -0.10));
    var dispCoeff = baseDisp === 0 ? 0 : Math.max(baseDisp, -0.004 * (sr / f));

    var V = ksDesign(sr, f * Math.pow(2, P.vDetuneCents / 1200), t60Fund * P.vT60, t60High * P.vHigh, dispCoeff);
    var H = ksDesign(sr, f, t60Fund * P.hT60, t60High * P.hHigh, dispCoeff);

    var len = Math.floor(sr * profile.duration);
    var buf = ctx.createBuffer(1, len, sr);
    var out = buf.getChannelData(0);
    var betaScale = Math.pow(2, 0.2 * fret / 12);
    var exV = ksExcitation(V.N, f, midi, art, betaScale, isWound);
    var exH = H.N === V.N ? Float32Array.from(exV) : ksExcitation(H.N, f, midi, art, betaScale, isWound);
    ksRunString(V, exV, out, wts[0]);
    ksRunString(H, exH, out, wts[1]);

    // 현 진동 자체의 초반 250ms RMS를 먼저 측정해 음마다 들쭉날쭉하지 않도록 정규화
    // (단차 없는 연속 커브로 저음~고음 밸런스를 완만하게 보정)
    var early = Math.min(len, Math.floor(sr * 0.25));
    var sumSq = 0, n;
    for (n = 0; n < early; n++){
      sumSq += out[n] * out[n];
    }
    var rms = Math.sqrt(sumSq / Math.max(1, early));
    var pitchScale = Math.pow(2, -0.0045 * (midi - 58));
    // 자연 하모닉스는 단일 고주파에 에너지가 집중되므로 일반 음보다 은은하게 낮추고, C5(MIDI 72) 위 고음역일수록 더 부드럽게 감쇠
    var harmScale = isHarmonic ? 0.68 * (midi > 72 ? Math.pow(2, -0.025 * (midi - 72)) : 1.0) : 1.0;
    var targetLevel = 0.275 * pitchScale * harmScale;
    var nrm = rms > 0 ? targetLevel / rms : 1;
    for (n = 0; n < len; n++) out[n] *= nrm;

    // 브리지·상판 타격음(Bridge knock)과 손끝 마찰음: 하모닉스에도 약한 탄현 질감을 남겨 전자 사인파 같은 이질감 제거
    var knockAmp = (isHarmonic ? 0.011 : (isApoyando ? 0.055 : (isSlur ? 0.018 : 0.036))) * pitchScale;
    var knockLen = Math.min(len, Math.floor(sr * 0.016));
    for (var kIdx = 0; kIdx < knockLen; kIdx++){
      var tK = kIdx / sr;
      var envK = Math.exp(-tK / 0.0042);
      var waveK = 0.65 * Math.sin(2 * Math.PI * 188 * tK) + 0.35 * Math.sin(2 * Math.PI * 385 * tK);
      out[kIdx] += knockAmp * envK * waveK;
    }
    var brushAmp = (isHarmonic ? 0.008 : (isSlur ? 0.008 : (isApoyando ? 0.022 : 0.028))) * pitchScale;
    var brushLen = Math.min(len, Math.floor(sr * 0.009));
    var brushRnd = seededRandom(midi * 1013 + (isHarmonic ? 19 : (isApoyando ? 7 : (isSlur ? 13 : 11))));
    var cBrush = 1 - Math.exp(-2 * Math.PI * 4000 / sr);
    var lpBrush = 0;
    for (var bIdx = 0; bIdx < brushLen; bIdx++){
      var tB = bIdx / sr;
      var envB = (1 - bIdx / brushLen) * Math.exp(-tB / 0.003);
      var wB = brushRnd() * 2 - 1;
      lpBrush += cBrush * (wB - lpBrush);
      out[bIdx] += brushAmp * envB * lpBrush;
    }

    var fade = Math.floor(sr * NATURAL_TAIL_FADE);
    for (n = 0; n < len; n++){
      var fg = n > len - fade ? (len - n) / fade : 1;
      var s = out[n] * fg;
      if (s > 0.95){
        s = 0.95 + 0.05 * Math.tanh((s - 0.95) / 0.05);
      } else if (s < -0.95){
        s = -0.95 + 0.05 * Math.tanh((s + 0.95) / 0.05);
      }
      out[n] = s;
    }
    return buf;
  }

  function getKsBuffer(midi, artOrApo, strNo){
    var art = ksArticulationKey(artOrApo);
    var tag = art === 'slur' ? 's' : (art === 'harmonic' ? 'h' : (art === true ? 'a' : 't'));
    var key = midi + tag + (strNo || 0);
    var buf = ksCache.get(key);
    if (buf){
      ksCache.delete(key); // 최근 사용 순서 갱신 (LRU)
    } else {
      buf = renderKsString(actx, midi, art, strNo);
      if (ksCache.size >= KS_CACHE_MAX) ksCache.delete(ksCache.keys().next().value);
    }
    ksCache.set(key, buf);
    return buf;
  }

  // 줄 지정이 없는 음은 1포지션 표준 운지의 줄로 연주 (playGuitarNote·미리 렌더링이 같은 규칙을 써야 캐시가 맞음)
  function defaultStringFor(midi){
    var pos = midiInfo(midi).pos;
    return pos ? pos.str : null;
  }

  // 연습 시작 전에 곡에 나오는 음을 미리 렌더링해 두어, 재생 도중 새 음을 처음 만들 때 생기는 메인 스레드 지연을 없앰
  function warmKsCache(song){
    if (appState.synthEngine === 'classic' || !song) return;
    var capo = getSongCapo(song);
    var notes = {};
    function add(midi, art, str){
      if (!midi) return;
      midi = soundingMidi(midi, capo);
      var s = str || defaultStringFor(midi);
      var k = ksArticulationKey(art);
      var tag = k === 'slur' ? 's' : (k === 'harmonic' ? 'h' : (k === true ? 'a' : 't'));
      notes[midi + tag + (s || 0)] = [midi, k, s];
    }
    function addBeatNotes(beat){
      var eb = getExplicitBass(beat);
      if (beat.chordNotes && beat.chordNotes.length > 2){
        beat.chordNotes.forEach(function(cn){ add(cn.midi, cn.articulation, cn.str); });
      } else {
        if (eb && eb.midi) add(eb.midi, false, eb.str);
        if (beat.midi) add(beat.midi, beat.articulation, beat.str);
      }
    }
    if (song.type === 'structured'){
      song.measures.forEach(function(m){
        m.beats.forEach(function(b){
          if (b.isSubdivided && b.subNotes && b.subNotes.length){
            getSubdividedGuideEvents(b, {
              startTime: 0,
              subStep: 1 / b.subNotes.length,
              capo: capo,
              beatsPerBar: song.beats || 4,
              preview: false
            }).forEach(function(event){
              add(event.note.midi, event.articulation, event.str);
            });
          } else {
            addBeatNotes(b);
          }
        });
      });
    } else if (song.type === 'image'){
      // 이미지 악보는 마디마다 가이드 음 하나만 재생
      for (var i = 0; i < getMeasureCount(song); i++){
        var bar = getFlatImageBar(i), pn = bar && bar.note ? parseNoteToken(bar.note, 0) : null;
        if (pn && pn.midi) add(pn.midi, false, pn.pos && pn.pos.str);
      }
    }
    Object.keys(notes).slice(0, KS_CACHE_MAX).forEach(function(k){ getKsBuffer(notes[k][0], notes[k][1], notes[k][2]); });
  }

  function legacyToneDuration(durSec, isBass, isApoyando, isFx){
    return isFx
      ? Math.max(0.35, (durSec || 0.75) * (isBass ? 1.45 : (isApoyando ? 1.38 : 1.2)))
      : Math.max(0.18, (durSec || 0.5) * 0.85);
  }

  function boundExactVoiceStop(stopAt, hardStopAt){
    return Number.isFinite(hardStopAt) ? Math.min(stopAt, hardStopAt + 0.015) : stopAt;
  }

  function buildKsVoice(midi, t, dur, scale, isBass, artOrApo, isFx, strNo, exactDuration, hardStopAt, naturalDecay, glide){
    var art = ksArticulationKey(artOrApo);
    var isApoyando = art === true;
    exactDuration = !!exactDuration && !naturalDecay;
    var src = actx.createBufferSource();
    src.buffer = getKsBuffer(midi, art, strNo);
    if (glide){
      // 슬라이드: 출발 음 높이에서 제 높이로 미끄러진다(재생 속도 비율)
      src.playbackRate.setValueAtTime(Math.pow(2, (glide.fromMidi - midi) / 12), t);
      src.playbackRate.exponentialRampToValueAtTime(1, t + glide.sec);
    } else {
      // 강한 탄현 순간 장력이 커져 음정이 살짝 높게 시작했다 안착하는 현상 (아포얀도가 더 큼)
      var bendStart = isApoyando ? 1.004 : (art === 'harmonic' ? 1.0006 : (art === 'slur' ? 1.0012 : 1.002));
      src.playbackRate.setValueAtTime(bendStart, t);
      src.playbackRate.exponentialRampToValueAtTime(1, t + 0.03);
    }
    var g = actx.createGain();
    var peakGain = KS_VOICE_GAIN * 0.95 * scale;
    var attackTime = art === 'harmonic' ? 0.006 : (art === 'slur' ? 0.004 : 0.002);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peakGain, t + attackTime);
    // 현은 스스로 감쇠하므로 엔벨로프는 음 길이가 끝날 때 손가락으로 줄을 멈추는 동작만 담당 (드라이 모드는 더 짧게 끊음)
    var relAt = exactDuration ? t + dur : t + Math.max(0.06, dur * 0.75);
    if (!naturalDecay) g.gain.setTargetAtTime(0, relAt, isFx ? 0.06 : 0.035);
    var stopAt = naturalDecay
      ? t + src.buffer.duration
      : Math.min(t + src.buffer.duration, relAt + 0.4);
    if (exactDuration || naturalDecay) stopAt = boundExactVoiceStop(stopAt, hardStopAt);
    src.connect(g);
    src.start(t);
    src.stop(stopAt);
    return { out: g, srcs: [src], stopAt: stopAt };
  }

  var classicWaveCache = new Map();
  var classicWaveCacheCtx = null;
  function getClassicPeriodicWave(actx, midi){
    if (!actx || typeof actx.createPeriodicWave !== 'function') return null;
    if (classicWaveCacheCtx !== actx){
      classicWaveCache.clear();
      classicWaveCacheCtx = actx;
    }
    var cached = classicWaveCache.get(midi);
    if (cached) return cached;
    var freq = 440 * Math.pow(2, (midi - 69) / 12);
    var beta = 0.13;
    var feltWidth = 0.04 + 0.0012 * Math.max(0, midi - 40);
    var p = 1.65;
    var K = Math.max(3, Math.min(20, Math.floor(12000 / freq)));
    var real = new Float32Array(K + 1);
    var imag = new Float32Array(K + 1);
    for (var k = 1; k <= K; k++){
      if (k === 2 || k === 3) continue; // 2·3배음은 o2·o3가 개별 엔벨로프로 담당해 위상 간섭·맥놀이를 막음
      var sincArg = k * Math.PI * feltWidth;
      var sinc = sincArg !== 0 ? Math.sin(sincArg) / sincArg : 1;
      imag[k] = (Math.sin(k * Math.PI * beta) / Math.pow(k, p)) * sinc;
    }
    var wave;
    try {
      wave = actx.createPeriodicWave(real, imag, { disableNormalization: false });
    } catch (e){
      try {
        wave = actx.createPeriodicWave(real, imag);
      } catch (e2){
        wave = null;
      }
    }
    if (wave) classicWaveCache.set(midi, wave);
    return wave;
  }

  // 기존음원 (피아노 타현 배음 + 복현 디튠 + 버터워스 필터의 맑은 가이드 톤)
  function buildClassicVoice(midi, t, dur, scale, isBass, artOrApo, isFx, exactDuration, hardStopAt, naturalDecay, strNo, glide){
    var art = ksArticulationKey(artOrApo);
    var isApoyando = art === true;
    var freq = 440 * Math.pow(2, (midi - 69) / 12);
    exactDuration = !!exactDuration && !naturalDecay;
    var toneDuration = exactDuration || naturalDecay ? Math.max(dur, legacyToneDuration(dur, isBass, isApoyando, isFx)) : dur;
    var profile = naturalDecay ? getNaturalDecayProfile(midi, art, strNo) : null;

    var o1 = actx.createOscillator();
    var o2 = actx.createOscillator();
    var o3 = actx.createOscillator();
    var filter = actx.createBiquadFilter();
    var g = actx.createGain();

    o1.type = 'triangle';
    o2.type = 'triangle';
    o3.type = 'sine';

    var pw = getClassicPeriodicWave(actx, midi);
    if (pw && typeof o1.setPeriodicWave === 'function') o1.setPeriodicWave(pw);

    if (glide){
      // 슬라이드: 세 오실레이터가 출발 음 높이에서 제 높이로 미끄러진다
      var glideRatio = Math.pow(2, (glide.fromMidi - midi) / 12);
      o1.frequency.setValueAtTime(freq * glideRatio, t);
      o1.frequency.exponentialRampToValueAtTime(freq, t + glide.sec);
      o2.frequency.setValueAtTime(freq * 2 * glideRatio, t);
      o2.frequency.exponentialRampToValueAtTime(freq * 2, t + glide.sec);
      o3.frequency.setValueAtTime(freq * 3 * glideRatio, t);
      o3.frequency.exponentialRampToValueAtTime(freq * 3, t + glide.sec);
    } else {
      // 피아노 가이드톤: 피치 벤드·맥놀이 없이 정확한 배수 주파수
      o1.frequency.setValueAtTime(freq, t);
      o2.frequency.setValueAtTime(freq * 2, t);
      o3.frequency.setValueAtTime(freq * 3, t);
    }

    var isHarmonic = art === 'harmonic';
    // MIDI 55 경계의 급격한 음량 단차를 없애기 위해 음역 비율을 연속 보간
    var bassBlend = Math.max(0, Math.min(1, (60 - midi) / 16));
    var g1 = actx.createGain();
    var g2 = actx.createGain();
    var g3 = actx.createGain();
    g1.gain.value = 0.88 - 0.10 * bassBlend;
    g2.gain.value = isHarmonic ? 0.18 : (0.30 + 0.12 * bassBlend);
    g3.gain.setValueAtTime(isHarmonic ? 0.08 : (0.22 + 0.06 * bassBlend), t);
    g3.gain.exponentialRampToValueAtTime(0.003, t + Math.min(0.11, toneDuration * 0.45));

    filter.type = 'lowpass';
    filter.Q.value = 0.707;
    if (isFx){
      var startCutoffMult = 5.8 + 0.7 * bassBlend;
      var endCutoffMult = 2.5 + 0.1 * bassBlend;
      var attackCutoff = freq * startCutoffMult;
      var decayCutoff = freq * endCutoffMult;
      if (isBass){
        attackCutoff = Math.max(attackCutoff, CLASSIC_BASS_ATTACK_CUTOFF);
        decayCutoff = Math.max(decayCutoff, CLASSIC_BASS_DECAY_CUTOFF);
      }
      filter.frequency.setValueAtTime(attackCutoff, t);
      filter.frequency.exponentialRampToValueAtTime(decayCutoff, t + toneDuration * 0.75);
    } else {
      // 드라이 모드: 음정의 윤곽이 뚜렷하게 들리도록 필터를 시원하고 명료하게 유지
      filter.frequency.setValueAtTime(isBass ? Math.max(freq * 5.4, CLASSIC_BASS_ATTACK_CUTOFF) : freq * 5.4, t);
      filter.frequency.exponentialRampToValueAtTime(isBass ? Math.max(freq * 3.0, CLASSIC_BASS_DECAY_CUTOFF) : freq * 3.0, t + toneDuration * 0.85);
    }

    var peakGain = ((isFx ? 0.38 : 0.36) + 0.05 * bassBlend) * (isHarmonic ? 0.72 : 1.0) * scale;
    if (naturalDecay){
      var lifetime = profile.duration;
      var fadeStart = t + lifetime - NATURAL_TAIL_FADE;
      var decayTau = profile.t60Fund / Math.log(1000);
      var decayStart, startGain;
      if (isFx){
        g.gain.setValueAtTime(0.0008, t);
        g.gain.linearRampToValueAtTime(peakGain, t + 0.0025);
        decayStart = t + Math.min(0.16, toneDuration * 0.28);
        startGain = peakGain * 0.45;
        g.gain.exponentialRampToValueAtTime(startGain, decayStart);
      } else {
        g.gain.setValueAtTime(0.0008, t);
        g.gain.linearRampToValueAtTime(peakGain, t + 0.0025);
        decayStart = t + 0.0025;
        startGain = peakGain;
      }
      var targetGain = startGain * Math.exp(-(fadeStart - decayStart) / decayTau);
      g.gain.exponentialRampToValueAtTime(targetGain, fadeStart);
      g.gain.linearRampToValueAtTime(0, t + lifetime);
    } else if (isFx){
      g.gain.setValueAtTime(0.0008, t);
      g.gain.linearRampToValueAtTime(peakGain, t + 0.0025);
      g.gain.exponentialRampToValueAtTime(peakGain * 0.45, t + Math.min(0.16, toneDuration * 0.28));
      g.gain.exponentialRampToValueAtTime(0.0005, t + toneDuration);
    } else {
      // 드라이 모드: 1단 직관적 감쇠
      g.gain.setValueAtTime(0.0008, t);
      g.gain.linearRampToValueAtTime(peakGain, t + 0.0025);
      g.gain.exponentialRampToValueAtTime(0.0005, t + toneDuration);
    }

    o1.connect(g1); g1.connect(filter);
    o2.connect(g2); g2.connect(filter);
    o3.connect(g3); g3.connect(filter);
    filter.connect(g);
    var noteOut = g;
    var stopAt = naturalDecay ? t + profile.duration : t + dur + 0.03;
    if (exactDuration){
      var noteOffAt = t + dur;
      var gate = actx.createGain();
      gate.gain.setValueAtTime(1, t);
      gate.gain.setTargetAtTime(0, noteOffAt, isFx ? 0.06 : 0.035);
      g.connect(gate);
      noteOut = gate;
      stopAt = Math.min(t + toneDuration + 0.03, noteOffAt + 0.4);
      stopAt = boundExactVoiceStop(stopAt, hardStopAt);
    } else if (naturalDecay){
      stopAt = boundExactVoiceStop(stopAt, hardStopAt);
    }
    o1.start(t); o2.start(t); o3.start(t);
    o1.stop(stopAt); o2.stop(stopAt); o3.stop(stopAt);
    return { out: noteOut, srcs: [o1, o2, o3], stopAt: stopAt, toneDuration:toneDuration };
  }

  // 클래식 기타 나일론 현 + 저음 권선현(Wound Bass) + 아포얀도(Apoyando) 음색 재생(표시 없는 음은 티란도)
  // strNum: 실제 탄현하는 줄 번호(1~6). 생략하면 1포지션 표준 운지로 추정
  function playGuitarNote(midi, durSec, when, gainScale, articulation, strNum, options){
    if (!midi) return;
    ensureAudioCtx();
    var t = when != null ? when : actx.currentTime;
    var isBass = midi < 55; // 4·5·6번 저음 권선현(E2~F#3) 여부
    var artKey = ksArticulationKey(articulation);
    var isApoyando = artKey === true;
    var isFx = !!appState.acousticFx;
    var naturalDecay = !!(options && options.naturalDecay);
    var exactDuration = !!(options && options.exactDuration) && !naturalDecay;
    var dur = exactDuration || naturalDecay ? Math.max(0, Number(durSec) || 0) : legacyToneDuration(durSec, isBass, isApoyando, isFx); // 드라이 톤: 음간 중첩 없는 또렷하고 깔끔한 감쇠
    if (dur <= 0) return;
    var scale = gainScale != null ? gainScale : 1.0;
    var sNo = strNum || defaultStringFor(midi);

    var hardStopAt = (exactDuration || naturalDecay) && options ? Number(options.hardStopAt) : NaN;
    var glide = options && options.glide && Number.isFinite(options.glide.fromMidi) && options.glide.sec > 0
      ? { fromMidi:options.glide.fromMidi, sec:options.glide.sec } : null;
    var voice = appState.synthEngine === 'classic'
      ? buildClassicVoice(midi, t, dur, scale, isBass, artKey, isFx, exactDuration, hardStopAt, naturalDecay, sNo, glide)
      : buildKsVoice(midi, t, dur, scale, isBass, artKey, isFx, sNo, exactDuration, hardStopAt, naturalDecay, glide);

    // 같은 줄 재탄현 시 이 보이스만 독립적으로 끊을 수 있도록 엔벨로프 뒤에 별도 감쇠 게인을 둠
    var damp = actx.createGain();
    if (Number.isFinite(hardStopAt) && hardStopAt < voice.stopAt){
      damp.gain.setValueAtTime(1, t);
      damp.gain.setValueAtTime(1, hardStopAt);
      damp.gain.linearRampToValueAtTime(0, hardStopAt + 0.01);
    }
    voice.out.connect(damp);
    damp.connect(guitarBus || actx.destination);

    var voiceRecord = { start:t, end:voice.stopAt, damp:damp, srcs:voice.srcs, harmonic:artKey === 'harmonic' };
    if (sNo){
      dampSameStringVoices(sNo, t);
      (stringVoices[sNo] = stringVoices[sNo] || []).push(voiceRecord);
    }
    trackGuideVoice(voiceRecord, t);
    addSympatheticResonance(midi, t, scale, sNo);
  }

  // 가이드 쉼이나 위치 변경에서 기타 보이스만 끊고 클릭 경로는 유지한다.
  function stopGuitarNotes(when){
    if (!actx) return;
    var t = when != null ? Number(when) : actx.currentTime;
    if (!Number.isFinite(t)) t = actx.currentTime;
    var now = actx.currentTime;
    trackedGuideVoices.forEach(function(voice){
      if (!voice || voice.end <= t) return;
      var start = Number(voice.start) || 0;
      var candidateStop = start >= t ? start : t + 0.015;
      var stopAt = Math.min(Number(voice.end), candidateStop);
      if (stopAt >= voice.end) return;
      var cutoff = start >= t ? start : t;
      var gain = voice.damp && voice.damp.gain;
      if (gain){
        if (typeof gain.cancelScheduledValues === 'function') gain.cancelScheduledValues(cutoff);
        if (typeof gain.setValueAtTime === 'function') gain.setValueAtTime(start >= t ? 0 : 1, cutoff);
        if (start < t && typeof gain.linearRampToValueAtTime === 'function') gain.linearRampToValueAtTime(0, cutoff + 0.01);
      }
      (voice.srcs || []).forEach(function(source){ try { source.stop(stopAt); } catch (e){} });
      voice.end = stopAt;
    });
    trackedGuideVoices = trackedGuideVoices.filter(function(voice){ return voice && voice.end > now; });
    Object.keys(stringVoices).forEach(function(strNo){
      stringVoices[strNo] = stringVoices[strNo].filter(function(voice){ return voice && voice.end > now; });
    });
  }

  // ---------- 공명현: 연주한 음의 배음이 쉬고 있는 개방현의 배음과 겹치면 그 개방현이 저절로 살짝 울림
  // (예: 4번줄 2프렛 E3를 치면 6번줄 E2의 2배음과 1번줄 E4가 함께 울림) · 콘서트홀 모드에서만, 음색 설정의 공명현 세기로 조절
  var SYMP_LEVEL = 0.011; // 기본(100%)에서 연주 음 대비 약 -24dB

  // 개방현 p번째 배음의 감쇠 시상수(초): 저음 줄일수록, 낮은 배음일수록 길게 (물리음원 현 모델의 기음 T60 기준)
  function sympTau(openMidi, p){
    return 8.0 * Math.pow(440 * Math.pow(2, (openMidi - 69) / 12) / 82.4, -0.33) / Math.pow(p, 0.7) / 6.91;
  }

  function addSympatheticResonance(midi, t, scale, playedStr){
    if (appState.synthEngine === 'classic') return;
    if (!appState.acousticFx || !(appState.sympAmount > 0)) return;
    var capo = curCapo();
    var f = 440 * Math.pow(2, (midi - 69) / 12);
    var cands = [];
    STRINGS.forEach(function(st){
      if (st.str === playedStr) return;
      // 이미 울리고 있거나 짚고 있는 줄은 따로 공명하지 않음
      if ((stringVoices[st.str] || []).some(function(v){ return !v.symp && v.end > t; })) return;
      var openMidi = soundingMidi(st.midi, capo);
      var fOpen = 440 * Math.pow(2, (openMidi - 69) / 12);
      for (var p = 1; p <= 6; p++){        // 개방현의 p번째 배음
        var fp = p * fOpen;
        if (fp >= 4000) break;
        // 개방현 배음은 대역폭 1/(π·시상수)인 공진기: 연주 음 배음과의 주파수 차이에 따른 로렌츠 응답으로 공명 세기를 정함
        // (옥타브·유니즌은 그대로, 평균율 5도는 약 -4dB, 순정음과 13.7센트 어긋나는 평균율 장3도는 약 -18dB로 자연스럽게 약해짐)
        var bw = 1 / (Math.PI * sympTau(openMidi, p));
        for (var q = 1; q <= 5; q++){      // 연주 음의 q번째 배음
          var resp = 1 / Math.sqrt(1 + Math.pow(2 * Math.abs(fp - q * f) / bw, 2));
          if (resp > 0.1){
            cands.push({ st: st, freq: fp, p: p, w: resp / (q * Math.sqrt(p)) });
          }
        }
      }
    });
    cands.sort(function(a, b){ return b.w - a.w; });
    cands.slice(0, 3).forEach(function(c){
      var list = stringVoices[c.st.str] || [];
      // 같은 개방현이 이미 공명 중이면 새 울림으로 자연스럽게 이어받음 (이전 울림은 80ms 시상수로 페이드)
      stringVoices[c.st.str] = list.filter(function(v){
        if (!v.symp || v.end <= t) return !v.symp && v.end > t;
        if (v.start >= t - 0.001) return true; // 같은 음이 같은 줄의 여러 배음을 울리는 경우는 함께 유지
        v.damp.gain.setValueAtTime(1, t);
        v.damp.gain.setTargetAtTime(0, t, 0.08);
        v.srcs.forEach(function(o){ try { o.stop(t + 0.6); } catch (e){} });
        v.end = Math.min(v.end, t + 0.6);
        return false;
      });
      var o = actx.createOscillator();
      o.frequency.value = c.freq;
      var g = actx.createGain();
      var amp = SYMP_LEVEL * appState.sympAmount * scale * c.w;
      var tau = sympTau(soundingMidi(c.st.midi, capo), c.p);
      g.gain.setValueAtTime(0, t);
      g.gain.setTargetAtTime(amp, t, 0.04);              // 진동이 옮겨 가며 서서히 커짐
      g.gain.setTargetAtTime(0, t + 0.15, tau);
      var damp = actx.createGain();
      o.connect(g);
      g.connect(damp);
      damp.connect(guitarBus || actx.destination);
      var stopAt = t + 0.15 + Math.min(6, tau * 7);
      o.start(t);
      o.stop(stopAt);
      var voiceRecord = { start:t, end:stopAt, damp:damp, srcs:[o], symp:true };
      stringVoices[c.st.str].push(voiceRecord);
      trackGuideVoice(voiceRecord, t);
    });
  }

  function playChordPreview(chordName){
    var ch = lookupChord(chordName);
    if (!ch) return;
    ensureAudioCtx();
    var now = actx.currentTime;
    var step = 0;
    var cp = curCapo();
    // 6번줄부터 1번줄까지 아르페지오로 울리기 (카포 곡은 실음 피치로 보정)
    for (var i = 0; i < 6; i++){
      var fret = ch.frets[i];
      if (fret < 0) continue;
      var strObj = STRINGS[5 - i];
      var midi = soundingMidi(strObj.midi + fret, cp);
      playGuitarNote(midi, 1.1, now + step * 0.07, null, null, strObj.str);
      step++;
    }
  }
