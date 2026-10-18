(function(global){
  'use strict';
  var GuitarNotation = typeof module !== 'undefined' && module.exports ? require('./notation.js') : global.GuitarNotation;
  // ---------- 음악 이론 & 클래식 기타 1포지션 매핑 사전
  var NOTE_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var NOTE_KO = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];

  // 클래식 기타 6현 개방현 MIDI: 1번줄(E4=64), 2번줄(B3=59), 3번줄(G3=55), 4번줄(D3=50), 5번줄(A2=45), 6번줄(E2=40)
  var STRINGS = [
    { str: 1, name: '1E (높은 미)', midi: 64, thick: '1.2px' },
    { str: 2, name: '2B (시)',      midi: 59, thick: '1.5px' },
    { str: 3, name: '3G (솔)',      midi: 55, thick: '1.8px' },
    { str: 4, name: '4D (레)',      midi: 50, thick: '2.2px' },
    { str: 5, name: '5A (라)',      midi: 45, thick: '2.6px' },
    { str: 6, name: '6E (낮은 미)', midi: 40, thick: '3.0px' }
  ];

  // 클래식 기타 제1포지션 현·프렛 테이블 (MIDI -> {str, fret})
  var FIRST_POS = {
    40: { str: 6, fret: 0 }, // E2 미
    41: { str: 6, fret: 1 }, // F2 파
    43: { str: 6, fret: 3 }, // G2 솔
    45: { str: 5, fret: 0 }, // A2 라
    47: { str: 5, fret: 2 }, // B2 시
    48: { str: 5, fret: 3 }, // C3 도
    50: { str: 4, fret: 0 }, // D3 레
    52: { str: 4, fret: 2 }, // E3 미
    53: { str: 4, fret: 3 }, // F3 파
    54: { str: 4, fret: 4 }, // F#3 파# (4번줄 4프렛)
    55: { str: 3, fret: 0 }, // G3 솔
    56: { str: 3, fret: 1 }, // G#3 솔# (3번줄 1프렛)
    57: { str: 3, fret: 2 }, // A3 라
    59: { str: 2, fret: 0 }, // B3 시
    60: { str: 2, fret: 1 }, // C4 도 (가온 도)
    62: { str: 2, fret: 3 }, // D4 레
    63: { str: 2, fret: 4 }, // D#4 레# (2번줄 4프렛 - B7 핵심 구성음)
    64: { str: 1, fret: 0 }, // E4 미
    65: { str: 1, fret: 1 }, // F4 파
    66: { str: 1, fret: 2 }, // F#4 파#
    67: { str: 1, fret: 3 }, // G4 솔
    69: { str: 1, fret: 5 }, // A4 라
    71: { str: 1, fret: 7 }, // B4 시
    72: { str: 1, fret: 8 }, // C5 높은 도
    74: { str: 1, fret: 10 },// D5 높은 레 (1번줄 10프렛)
    75: { str: 1, fret: 11 },// D#5 높은 레# (1번줄 11프렛)
    76: { str: 1, fret: 12 } // E5 높은 미 (1번줄 12프렛 - 로망스 하이라이트)
  };

  // 코드 운지 사전 (strings 배열: [6번줄, 5번줄, 4번줄, 3번줄, 2번줄, 1번줄] 프렛 번호, -1은 뮤트)
  // fingers: 왼손 손가락 번호 (0:개방, 1:검지, 2:중지, 3:약지, 4:소지)
  var CHORD_DB = {
    'C':   { name: 'C (다장조)',   frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0], desc: '5번줄 3프렛(약지), 4번줄 2프렛(중지), 2번줄 1프렛(검지)' },
    'G7':  { name: 'G7 (솔7)',     frets: [3, 2, 0, 0, 0, 1],  fingers: [3, 2, 0, 0, 0, 1], desc: '1번줄 1프렛(검지)만 짚는 약식 G7로도 동요에서 자주 연주해요' },
    'G':   { name: 'G (사장조)',   frets: [3, 2, 0, 0, 0, 3],  fingers: [2, 1, 0, 0, 0, 3], desc: '6번줄 3프렛, 5번줄 2프렛, 1번줄 3프렛' },
    'F':   { name: 'F (바장조)',   frets: [-1, -1, 3, 2, 1, 1],fingers: [0, 0, 3, 2, 1, 1], desc: '입문 단계에서는 1·2번줄 1프렛(검지 미니바레) + 3번줄 2프렛 + 4번줄 3프렛 약식 추천' },
    'D':   { name: 'D (라장조)',   frets: [-1, -1, 0, 2, 3, 2],fingers: [0, 0, 0, 1, 3, 2], desc: '3번줄 2프렛(검지), 1번줄 2프렛(중지), 2번줄 3프렛(약지)' },
    'A':   { name: 'A (가장조)',   frets: [-1, 0, 2, 2, 2, 0], fingers: [0, 0, 1, 2, 3, 0], desc: '4·3·2번줄 2프렛을 나란히 짚어요' },
    'E':   { name: 'E (마장조)',   frets: [0, 2, 2, 1, 0, 0],  fingers: [0, 2, 3, 1, 0, 0], desc: '3번줄 1프렛(검지), 5·4번줄 2프렛(중지·약지)' },
    'Am':  { name: 'Am (가단조)',  frets: [-1, 0, 2, 2, 1, 0], fingers: [0, 0, 2, 3, 1, 0], desc: 'C 코드에서 약지(3번)만 3번줄 2프렛으로 옮기면 돼요' },
    'Dm':  { name: 'Dm (라단조)',  frets: [-1, -1, 0, 2, 3, 1],fingers: [0, 0, 0, 2, 3, 1], desc: '1번줄 1프렛(검지), 3번줄 2프렛(중지), 2번줄 3프렛(약지)' },
    'Em':  { name: 'Em (마단조)',  frets: [0, 2, 2, 0, 0, 0],  fingers: [0, 2, 3, 0, 0, 0], desc: '5번줄·4번줄 2프렛만 짚는 가장 쉬운 코드예요' },
    'Bm':  { name: 'Bm (나단조)',  frets: [-1, 2, 4, 4, 3, 2], fingers: [0, 1, 3, 4, 2, 1], desc: '2프렛 바레(1번 검지) + 2번줄 3프렛(중지) + 4·3번줄 4프렛(약지·소지)' },
    'Fm':  { name: 'Fm (바단조)',  frets: [-1, -1, 3, 1, 1, 1],fingers: [0, 0, 3, 1, 1, 1], desc: '1·2·3번줄 1프렛 미니바레(검지) + 4번줄 3프렛(약지)' },
    'F#m': { name: 'F#m (올림바단조)', frets: [2, 4, 4, 2, 2, 2], fingers: [1, 3, 4, 1, 1, 1], desc: '2프렛 바레(검지) + 5·4번줄 4프렛(약지·소지)' },
    'Gm':  { name: 'Gm (사단조)',  frets: [3, 5, 5, 3, 3, 3],  fingers: [1, 3, 4, 1, 1, 1], desc: '3프렛 바레(검지) + 5·4번줄 5프렛(약지·소지)' },
    'Cm':  { name: 'Cm (다단조)',  frets: [-1, 3, 5, 5, 4, 3], fingers: [0, 1, 3, 4, 2, 1], desc: '3프렛 바레(검지) + 2번줄 4프렛(중지) + 4·3번줄 5프렛' },
    'C7':  { name: 'C7 (도7)',     frets: [-1, 3, 2, 3, 1, 0], fingers: [0, 3, 2, 4, 1, 0], desc: 'C 코드 운지에서 3번줄 3프렛에 소지(4번)만 추가해요' },
    'E7':  { name: 'E7 (미7)',     frets: [0, 2, 0, 1, 0, 0],  fingers: [0, 2, 0, 1, 0, 0], desc: '3번줄 1프렛(검지), 5번줄 2프렛(중지)' },
    'D7':  { name: 'D7 (레7)',     frets: [-1, -1, 0, 2, 1, 2],fingers: [0, 0, 0, 2, 1, 3], desc: '2번줄 1프렛(검지), 3번줄 2프렛(중지), 1번줄 2프렛(약지)' },
    'A7':  { name: 'A7 (라7)',     frets: [-1, 0, 2, 0, 2, 0], fingers: [0, 0, 2, 0, 3, 0], desc: '4번줄 2프렛(중지), 2번줄 2프렛(약지)' },
    'B7':  { name: 'B7 (시7)',     frets: [-1, 2, 1, 2, 0, 2], fingers: [0, 2, 1, 3, 0, 4], desc: '로망스 중반부에 등장하는 핵심 코드예요' }
  };

  function cleanChordToken(rawName){
    if (!rawName) return '';
    return String(rawName).replace(/\s*\(자동\)\s*|\s*\(추정\)\s*|\?+$/g, '').trim();
  }

  function lookupChord(rawName){
    var s = cleanChordToken(rawName);
    if (!s || s === '-' || s === '없음' || /^n\.?c\.?$/i.test(s)) return null;
    if (CHORD_DB[s]) return CHORD_DB[s];
    // 대소문자 오타 자동 보정 (예: am -> Am, e7 -> E7, f#m -> F#m)
    var norm = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    if (CHORD_DB[norm]) return CHORD_DB[norm];
    return null;
  }

  // 화성학 기반 코드 구성음 피치클래스(0=C ~ 11=B) 사전: [근음(1도), 3도, 5도, 7도(선택)]
  var CHORD_TONES_PC = {
    'C':   [0, 4, 7],
    'G7':  [7, 11, 2, 5],
    'G':   [7, 11, 2],
    'F':   [5, 9, 0],
    'D':   [2, 6, 9],
    'A':   [9, 1, 4],
    'E':   [4, 8, 11],
    'Am':  [9, 0, 4],
    'Dm':  [2, 5, 9],
    'Em':  [4, 7, 11],
    'Bm':  [11, 2, 6],
    'Fm':  [5, 8, 0],
    'F#m': [6, 9, 1],
    'Gm':  [7, 10, 2],
    'Cm':  [0, 3, 7],
    'C7':  [0, 4, 7, 10],
    'E7':  [4, 8, 11, 2],
    'D7':  [2, 6, 9, 0],
    'A7':  [9, 1, 4, 7],
    'B7':  [11, 3, 6, 9]
  };

  var KEY_PALETTES = {
    'C':  { tonic: 'C',  dom: 'G7', chords: ['C', 'G7', 'F', 'G', 'Am', 'Dm', 'Em'] },
    'Am': { tonic: 'Am', dom: 'E7', chords: ['Am', 'E7', 'G', 'C', 'Dm', 'F'] },
    'G':  { tonic: 'G',  dom: 'D7', chords: ['G', 'D7', 'C', 'Em', 'Am', 'D'] },
    'Em': { tonic: 'Em', dom: 'B7', chords: ['Em', 'B7', 'Am', 'G', 'C', 'D'] },
    'D':  { tonic: 'D',  dom: 'A7', chords: ['D', 'A7', 'G', 'Bm', 'Em', 'A'] },
    'Dm': { tonic: 'Dm', dom: 'A7', chords: ['Dm', 'A7', 'Gm', 'F', 'C'] },
    'F':  { tonic: 'F',  dom: 'C7', chords: ['F', 'C7', 'Dm', 'C', 'Gm'] }
  };

  // 곡 전체의 조성(Key) 판별 + 마디별 강박·지속음 가중치로 반주 코드를 자동 추측합니다.
  function inferChordsForMeasures(measures, beatsPerBar){
    if (!measures || !measures.length) return;
    var bpb = beatsPerBar || 4;
    var pcHist = new Array(12).fill(0);
    var lastPc = null;

    measures.forEach(function(m){
      (m.beats || []).forEach(function(b){
        if (b && b.midi != null){
          var pc = b.midi % 12;
          pcHist[pc]++;
          lastPc = pc;
        }
      });
    });

    // 1단계: 마지막 종지 음(lastPc)과 변화표(F#=6, G#=8, C#=1)로 곡의 조성(Key) 결정
    var detectedKey = 'C';
    if (lastPc === 9 || (pcHist[8] > 0 && pcHist[9] >= pcHist[0])) detectedKey = 'Am';
    else if (lastPc === 4 && (pcHist[6] > 0 || pcHist[3] > 0)) detectedKey = 'Em';
    else if (lastPc === 7 || (pcHist[6] > 0 && pcHist[5] === 0)) detectedKey = 'G';
    else if (lastPc === 2 && pcHist[1] > 0) detectedKey = 'D';
    else if (lastPc === 2) detectedKey = 'Dm';
    else if (lastPc === 5 && pcHist[10] > 0) detectedKey = 'F';

    var palette = KEY_PALETTES[detectedKey] || KEY_PALETTES['C'];

    // 2단계: 각 마디별 멜로디 가중치 집계 및 최적 코드 매칭
    measures.forEach(function(m, mIdx){
      if (!m.needsInfer) return;
      var weights = new Array(12).fill(0);
      var totalWeight = 0;
      var activePc = null;
      var firstBeatPc = null;

      (m.beats || []).forEach(function(b, bIdx){
        if (b && b.midi != null){
          activePc = b.midi % 12;
          if (firstBeatPc == null) firstBeatPc = activePc;
          var w = (bIdx === 0) ? 2.8 : (bIdx === Math.floor(bpb / 2) ? 1.8 : 1.1);
          weights[activePc] += w;
          totalWeight += w;
        } else if (activePc != null){
          // 유지 박자(-)는 직전 음의 화성 중요도를 높임
          weights[activePc] += 0.85;
          totalWeight += 0.85;
        }
      });

      if (totalWeight === 0){
        // 무음 마디면 직전 마디 코드 또는 으뜸화음
        var prev = mIdx > 0 && measures[mIdx - 1].chord ? measures[mIdx - 1].chord : palette.tonic;
        m.chord = prev;
        m.autoChord = true;
        return;
      }

      var bestChord = palette.tonic;
      var bestScore = -999;

      palette.chords.forEach(function(chName, orderIdx){
        var tones = CHORD_TONES_PC[chName];
        if (!tones) return;
        var score = 0;
        // 근음(1도), 3도, 5도, 7도 매칭 점수
        tones.forEach(function(pc, tIdx){
          var roleMul = tIdx === 0 ? 1.35 : (tIdx === 1 ? 1.25 : (tIdx === 2 ? 1.05 : 1.3));
          score += weights[pc] * roleMul;
        });

        // 강박 첫 음이 해당 코드의 구성음이면 가산점
        if (firstBeatPc != null && tones.indexOf(firstBeatPc) >= 0){
          score += 1.4;
        }
        // 첫 마디(못갖춘마디 제외)와 마지막 마디는 으뜸화음(Tonic) 우대
        if ((mIdx === measures.length - 1 || (mIdx === 0 && totalWeight > 1.5)) && chName === palette.tonic){
          score += 2.2;
        }
        // 끝에서 두 번째 마디는 딸림7화음(Dominant V7) 우대
        if (mIdx === measures.length - 2 && chName === palette.dom){
          score += 1.1;
        }
        // 특징적인 변화음 보너스 (예: G# 등장 시 E7, F#+C 등장 시 D7)
        if (chName === 'E7' && weights[8] > 0) score += 3.5;
        if (chName === 'D7' && (weights[6] > 0 || weights[0] > 0)) score += 1.2;
        if (chName === 'G7' && weights[5] > 0) score += 1.3;

        // 동점일 때 기본 주요 3화음(I, V7, IV) 우선
        score -= orderIdx * 0.08;

        if (score > bestScore){
          bestScore = score;
          bestChord = chName;
        }
      });

      m.chord = bestChord;
      m.autoChord = true;
    });
  }

  function midiInfo(m){
    if (m == null) return null;
    var en = NOTE_EN[m % 12] + (Math.floor(m / 12) - 1);
    var ko = NOTE_KO[m % 12];
    var pos = FIRST_POS[m] ? { str:FIRST_POS[m].str, fret:FIRST_POS[m].fret } : null;
    if (!pos){
      // 가까운 줄에서 계산
      for (var i = 0; i < STRINGS.length; i++){
        var f = m - STRINGS[i].midi;
        if (f >= 0 && f <= 12){
          pos = { str: STRINGS[i].str, fret: f };
          break;
        }
      }
    }
    if (pos){ pos.lh = null; pos.rh = null; }
    return { midi: m, en: en, ko: ko, pos: pos };
  }

  function parseNoteToken(tok, altIdx){
    if (!tok || tok === '-' || tok === '.') return null;
    tok = tok.trim();

    // 악보 주법 명시 기호 추출: ! 또는 > (아포얀도/주선율 강조), ~ (티란도/여린 반주 내성)
    var explicitArtic = null;
    if (/^[!>^]/.test(tok)){
      explicitArtic = 'apoyando';
      tok = tok.slice(1).trim();
    } else if (/^~/.test(tok)){
      explicitArtic = 'tirando';
      tok = tok.slice(1).trim();
    } else if (/[!>^]$/.test(tok)){
      explicitArtic = 'apoyando';
      tok = tok.slice(0, -1).trim();
    } else if (/~$/.test(tok)){
      explicitArtic = 'tirando';
      tok = tok.slice(0, -1).trim();
    }
    if (!tok || tok === '-' || tok === '.') return null;

    // 2성부 및 다성부(엄지 베이스 + 내성 + 주선율 화음 탄현) 표기 예: 0E2+4B4, 3C3+2E3+0G3+1C4
    if (tok.indexOf('+') >= 0){
      var subParts = tok.split('+').map(function(s){ return s.trim(); });
      if (subParts.some(function(s){ return !s; })) return null;
      var parsedSub = subParts.map(function(sp){ return parseNoteToken(sp, altIdx); });
      if (!parsedSub.length || parsedSub.some(function(note){ return !note; })) return null;
      if (parsedSub.length === 1){
        if (explicitArtic){
          parsedSub[0].articulation = explicitArtic;
          parsedSub[0].explicitArticulation = true;
        }
        return parsedSub[0];
      }
      var inheritedArtic = explicitArtic;
      parsedSub.forEach(function(ps){
        if (ps.explicitArticulation && ps.articulation) inheritedArtic = ps.articulation;
      });
      parsedSub.sort(function(a, b){ return a.midi - b.midi; });
      var bassInf = parsedSub[0];
      var melInf = parsedSub[parsedSub.length - 1];
      var bassPos = bassInf.pos ? Object.assign({}, bassInf.pos) : { str: 6, fret: 0, lh: null, rh: null };
      var cleanBassCustom = (bassInf.customTok || '').replace(/^[!>^~]+|[!>^~]+$/g, '');
      var bassTokStr = cleanBassCustom || bassInf.en;
      var melPos = melInf.pos ? Object.assign({}, melInf.pos) : null;
      var cleanMelCustom = (melInf.customTok || '').replace(/^[!>^~]+|[!>^~]+$/g, '');
      var melTokStr = cleanMelCustom || melInf.en;
      var articPrefix = inheritedArtic === 'apoyando' ? '!' : (inheritedArtic === 'tirando' ? '~' : '');
      melInf.bass = {
        tok: bassTokStr,
        midi: bassInf.midi,
        en: bassInf.en,
        ko: bassInf.ko,
        str: bassPos.str,
        fret: bassPos.fret,
        lh: bassPos.lh,
        rh: null
      };
      if (inheritedArtic){
        melInf.articulation = inheritedArtic;
        melInf.explicitArticulation = true;
      }

      // 3음 이상 화음(코드 롤/아르페지오) 지원
      var chordNotes = parsedSub.map(function(ps){
        var pos = ps.pos ? Object.assign({}, ps.pos) : { str: 1, fret: 0, lh: null, rh: null };
        var cleanTok = (ps.customTok || '').replace(/^[!>^~]+|[!>^~]+$/g, '');
        var tokStr = cleanTok || ps.en;
        return {
          tok: tokStr,
          midi: ps.midi,
          en: ps.en,
          ko: ps.ko,
          str: pos.str,
          fret: pos.fret,
          lh: pos.lh,
          rh: null,
          articulation: ps.articulation || inheritedArtic
        };
      });
      melInf.chordNotes = chordNotes;

      if (parsedSub.length > 2){
        melInf.customTok = chordNotes.map(function(cn){ return cn.tok; }).join('+');
      } else {
        melInf.customTok = bassTokStr + '+' + articPrefix + melTokStr;
      }
      return melInf;
    }

    // 괄호 표기 예: D4(4) -> 4D4 정규화
    var parenMatch = tok.match(/^([A-Ga-g]#?[2-5]?|[가-힣]+#?[2-5]?)\(([0-4])\)$/);
    if (parenMatch) tok = parenMatch[2] + parenMatch[1];

    var koMap = {
      '0솔': 55, '솔3': 55, '1솔#': 56, '솔#3': 56,
      '2라': 57, '3라': 57, '라3': 57, '0시': 59, '시3': 59,
      '1도': 60, '도': 60, '도4': 60,
      '3레': 62, '4레': 62, '레': 62, '레4': 62,
      '0미': 64, '미': 64, '미4': 64, '2미': 52, '미3': 52,
      '1파': 65, '파': 65, '파4': 65, '3파': 53, '파3': 53,
      '2파#': 66, '파#': 66, '파#4': 66, '4파#': 54, '파#3': 54,
      '3솔': 67, '4솔': 67, '솔': 67, '솔4': 67,
      '2라4': 69, '라': 69, '라4': 69,
      '시': 71, '시4': 71, '도5': 72
    };

    var leadDigitMatch = tok.match(/^([0-4])(.+)$/);
    var customLh = leadDigitMatch ? Number(leadDigitMatch[1]) : null;
    var bareKo = leadDigitMatch ? leadDigitMatch[2] : tok;
    var articPfx = explicitArtic === 'apoyando' ? '!' : (explicitArtic === 'tirando' ? '~' : '');

    var resolvedMidi = koMap[tok] != null ? koMap[tok] : (koMap[bareKo] != null ? koMap[bareKo] : null);
    if (resolvedMidi != null){
      var info = midiInfo(resolvedMidi);
      if (info && info.pos){
        var newPos = Object.assign({}, info.pos);
        if (customLh != null) newPos.lh = customLh;
        info.pos = newPos;
        var baseKoTok = customLh != null ? customLh + info.en : info.en;
        if (articPfx || customLh != null){
          info.customTok = articPfx + baseKoTok;
        }
      }
      if (explicitArtic){
        info.articulation = explicitArtic;
        info.explicitArticulation = true;
      }
      return info;
    }

    var m = tok.match(/^([0-4])?([A-Ga-g])([#b♯♭♮]?)([2-5])?(?:@([1-6]))?$/);
    if (m){
      var lhOverride = m[1] !== undefined && m[1] !== '' ? Number(m[1]) : null;
      var accidental = (m[3] || '').replace('♯','#').replace('♭','b').replace('♮','');
      var semitones = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
      var pitch = semitones[m[2].toUpperCase()] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
      var oct = m[4] ? Number(m[4]) : 4;
      var strOverride = m[5] ? Number(m[5]) : null;
      if (pitch >= -1){
        var midi = (oct + 1) * 12 + pitch;
        var inf = midiInfo(midi);
        if (inf && inf.pos){
          var posCopy = Object.assign({}, inf.pos);
          if (strOverride && STRINGS[strOverride - 1]){
            var customFret = midi - STRINGS[strOverride - 1].midi;
            if (customFret >= 0 && customFret <= 12){
              posCopy.str = strOverride;
              posCopy.fret = customFret;
            } else return null;
          }
          posCopy.lh = null;
          posCopy.rh = null;
          if (lhOverride != null) posCopy.lh = lhOverride;
          inf.pos = posCopy;
          var coreTok = inf.en;
          if (strOverride){
            coreTok = (lhOverride != null ? lhOverride : '') + inf.en + '@' + strOverride;
          } else if (lhOverride != null){
            coreTok = lhOverride + inf.en;
          }
          if (articPfx || strOverride || lhOverride != null){
            inf.customTok = articPfx + coreTok;
          }
        }
        if (explicitArtic){
          inf.articulation = explicitArtic;
          inf.explicitArticulation = true;
        }
        return inf;
      }
    }
    return null;
  }

  function getExplicitLeftHand(token, componentIndex){
    var parts = GuitarNotation.splitBeatSubtokens(token);
    if (parts.length !== 1) return null;
    var parsed = parseNoteToken(parts[0], 0);
    if (!parsed) return null;
    if (componentIndex != null){
      if (parsed.chordNotes){
        var component = parsed.chordNotes[componentIndex];
        return component && component.lh != null ? component.lh : null;
      }
      if (componentIndex !== 0) return null;
    }
    return parsed.pos && parsed.pos.lh != null ? parsed.pos.lh : null;
  }

  // 마디 내 박자별 아포얀도(주선율 강조) / 티란도(내성 반주) 자동 추론 및 명시 기호(!, ~) 반영
  // - 6/8, 9/8박자에서는 3음 묶음(셋잇단) 내 실제 음높이(midi)를 비교하여 최고음을 아포얀도 주선율로 자동 감지
  //   (하행 a-m-i 로망스는 1·4·7박, 상행 i-m-a 카르카시는 3·6·9박, 쉼표 칸은 강조 제외)
  function annotateMeasureArticulation(beats, bpb){
    if (!Array.isArray(beats)) return;
    var isTripletMeter = (bpb === 6 || bpb === 9);

    if (isTripletMeter){
      for (var gStart = 0; gStart < beats.length; gStart += 3){
        var grp = beats.slice(gStart, gStart + 3);
        var pitched = grp.filter(function(b){ return b && b.midi != null; });
        if (!pitched.length) continue;

        if (pitched.length === 1){
          // 묶음 내 음이 1개뿐이고 나머지가 쉼표(-)인 경우(예: 종지 마디): 해당 음만 주선율 강조, 쉼표 칸은 제외
          var onlyB = pitched[0];
          if (!onlyB.explicitArticulation){
            onlyB.articulation = 'apoyando';
            onlyB.autoArticulation = true;
          }
        } else {
          var maxMidi = -1, minMidi = 999;
          pitched.forEach(function(b){
            if (b.midi > maxMidi) maxMidi = b.midi;
            if (b.midi < minMidi) minMidi = b.midi;
          });
          grp.forEach(function(b, k){
            if (!b || !b.midi) return;
            if (b.explicitArticulation) return;
            if (maxMidi > minMidi){
              b.articulation = (b.midi === maxMidi) ? 'apoyando' : 'tirando';
            } else {
              // 3음 모두 같은 음(트레몰로 등)일 때는 묶음 첫 박을 주선율로 처리
              b.articulation = (k === 0) ? 'apoyando' : 'tirando';
            }
            b.autoArticulation = true;
          });
        }

      }
    }
  }

  function getExplicitBass(beat){
    return beat && beat.bass && beat.bass.midi ? beat.bass : null;
  }

  function parseBracketChordSpec(rawChord){
    var s = (rawChord || '').trim();
    if (s === '-' || s === '없음' || /^n\.?c\.?$/i.test(s)){
      return { chord: '', autoChord: false, needsInfer: false };
    }
    if (!s || s === '?' || s === '자동' || s === '(자동)'){
      return { chord: '', autoChord: true, needsInfer: true };
    }
    var isMarkedAuto = /\(자동\)|\(추정\)|\?+$/.test(s);
    var cleaned = cleanChordToken(s);
    // 대소문자 정규화
    var norm = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    if (CHORD_DB[norm]) cleaned = norm;
    return { chord: cleaned, autoChord: isMarkedAuto, needsInfer: false };
  }

  function getSongCapo(song){
    if (!song) return 0;
    // 제목/배지 표기를 우선 적용 (저장 후 곡 이름을 바꿔 카포를 추가/변경해도 즉시 반영)
    var str = (song.title || '') + ' ' + (song.badge || '');
    var m = str.match(/(?:capo|카포)\s*[:.]?\s*(?:fret\s*)?(\d+)/i);
    if (m) return Math.max(0, Math.min(12, Number(m[1])));
    if (song.capo != null && isFinite(song.capo)) return Math.max(0, Math.min(12, Number(song.capo)));
    return 0;
  }

  function tokenizeMeasureBeats(str){ return GuitarNotation.tokenizeMeasureBeats(str); }



  function soundingMidi(midi, capo){
    var offset = Number(capo);
    if (!isFinite(offset)) offset = 0;
    offset = Math.max(0, Math.min(12, offset));
    return Number(midi) + offset;
  }

  function splitScoreMeasures(raw){ return GuitarNotation.splitScoreMeasures(raw); }
  function validateScore(raw, beats){
    var result = GuitarNotation.validateScore(raw, beats, parseNoteToken);
    splitScoreMeasures(raw).forEach(function(line, index){
      var decoded = GuitarNotation.decodeMeasureLine(line);
      if (decoded.chordRaw == null) return;
      var chord = parseBracketChordSpec(decoded.chordRaw);
      if (chord.chord && !CHORD_DB[chord.chord]) result.warnings.push({
        code:'UNSUPPORTED_CHORD', measure:index + 1, beat:null,
        message:'코드 사전에 없는 코드 표기야: '+chord.chord+'.'
      });
    });
    return result;
  }
  function serializeScoreMeasures(measures, separator){ return GuitarNotation.serializeScoreMeasures(measures, separator); }

  function parseScore(raw, beats){
    var missingBeats = beats == null || (typeof beats === 'string' && beats.trim() === '');
    var numericBeats = missingBeats ? 4 : Number(beats);
    var validBeats = Number.isFinite(numericBeats) && Number.isInteger(numericBeats) && numericBeats >= 1 && numericBeats <= 12;
    var bpb = validBeats ? numericBeats : 4;
    var lines = splitScoreMeasures(raw);
    var anyNeedInfer = false, diagnostics = validateScore(raw, beats);
    var measures = lines.map(function(line, mIdx){
      var decoded = GuitarNotation.decodeMeasureLine(line);
      var left = decoded.notation;
      var lyric = decoded.lyric;
      var chordSpec = { chord: '', autoChord: true, needsInfer: true };
      if (decoded.chordRaw != null){ chordSpec = parseBracketChordSpec(decoded.chordRaw); left = left.replace(/^\[[^\]]*\]\s*/, '').trim(); }
      if (chordSpec.needsInfer) anyNeedInfer = true;
      var tokens = tokenizeMeasureBeats(left);
      var parsedBeats = [];
      for (var b = 0; b < bpb; b++){
        var tok = tokens[b] || '-';
        var rawSubToks = GuitarNotation.splitBeatSubtokens(tok);
        if (rawSubToks.length > 1){
          var parsedSubs = rawSubToks.map(function(stk){
            var note = parseNoteToken(stk, mIdx * bpb + b);
            return {
              tok: stk, midi: note ? note.midi : null, en: note ? note.en : '-',
              ko: note ? note.ko : (stk === '-' ? '유지' : '쉼'),
              str: note && note.pos ? note.pos.str : null,
              fret: note && note.pos ? note.pos.fret : null,
              lh: note && note.pos ? note.pos.lh : null,
              rh: note && note.pos ? note.pos.rh : null,
              bass: note && note.bass ? note.bass : null,
              chordNotes: note && note.chordNotes ? note.chordNotes : null,
              articulation: note && note.articulation ? note.articulation : null,
              explicitArticulation: !!(note && note.explicitArticulation),
              durFrac: 1 / rawSubToks.length
            };
          });
          var first = parsedSubs.find(function(note){ return note.midi != null; });
          parsedBeats.push({
            tok: tok, isSubdivided: true, subNotes: parsedSubs,
            midi: first ? first.midi : null,
            en: parsedSubs.map(function(note){ return note.en; }).join('/'),
            ko: parsedSubs.map(function(note){ return note.ko; }).join('/'),
            str: first ? first.str : null, fret: first ? first.fret : null,
            lh: first ? first.lh : null, rh: first ? first.rh : null,
            bass: first ? first.bass : null, chordNotes: first ? first.chordNotes : null,
            articulation: first ? first.articulation : null,
            explicitArticulation: !!(first && first.explicitArticulation), autoArticulation: false
          });
        } else {
          var noteInfo = parseNoteToken(rawSubToks[0] || tok, mIdx * bpb + b);
          parsedBeats.push({
            tok: tok, isSubdivided: false,
            midi: noteInfo ? noteInfo.midi : null,
            en: noteInfo ? noteInfo.en : '-', ko: noteInfo ? noteInfo.ko : '쉼/유지',
            str: noteInfo && noteInfo.pos ? noteInfo.pos.str : null,
            fret: noteInfo && noteInfo.pos ? noteInfo.pos.fret : null,
            lh: noteInfo && noteInfo.pos ? noteInfo.pos.lh : null,
            rh: noteInfo && noteInfo.pos ? noteInfo.pos.rh : null,
            bass: noteInfo && noteInfo.bass ? noteInfo.bass : null,
            chordNotes: noteInfo && noteInfo.chordNotes ? noteInfo.chordNotes : null,
            articulation: noteInfo && noteInfo.articulation ? noteInfo.articulation : null,
            explicitArticulation: !!(noteInfo && noteInfo.explicitArticulation), autoArticulation: false
          });
        }
      }
      annotateMeasureArticulation(parsedBeats, bpb);
      return { no: mIdx + 1, chord: chordSpec.chord, autoChord: chordSpec.autoChord,
        needsInfer: chordSpec.needsInfer, lyric: lyric, beats: parsedBeats };
    });
    if (anyNeedInfer) inferChordsForMeasures(measures, bpb);
    return { lines: lines, beats: bpb, measures: measures, errors: diagnostics.errors, warnings: diagnostics.warnings };
  }

  function buildStructuredSong(spec){
    var score = parseScore(spec.lines || spec.raw || [], spec.beats);
    if (score.errors.length){ var error = new Error('악보에 저장할 수 없는 오류가 있어.'); error.name = 'ScoreValidationError'; error.errors = score.errors; throw error; }
    return {
      id: spec.id, title: spec.title, badge: spec.badge, type: 'structured',
      builtin: !!spec.builtin, bpm: spec.bpm, beats: score.beats,
      capo: getSongCapo(spec), ytUrl: spec.ytUrl || '', measures: score.measures, notationVersion: 2
    };
  }

  function projectScoreToEditorBars(raw, beats){
    var lines = splitScoreMeasures(raw);
    if (!lines.length) lines = ['[C] C4 - - - |'];
    var score = parseScore(lines, beats);
    return score.measures.map(function(measure){
      return { chord: measure.chord || '-', autoChord: !!measure.autoChord,
        notes: measure.beats.map(function(beat){ return beat.tok || '-'; }), lyric: measure.lyric };
    });
  }

  function parseTextToVeBars(raw, beats){ return projectScoreToEditorBars(raw, beats); }

  var api = {
    NOTE_EN: NOTE_EN, NOTE_KO: NOTE_KO, STRINGS: STRINGS, FIRST_POS: FIRST_POS,
    CHORD_DB: CHORD_DB,
    cleanChordToken: cleanChordToken, lookupChord: lookupChord, midiInfo: midiInfo,
    inferChordsForMeasures: inferChordsForMeasures,
    parseNoteToken: parseNoteToken, annotateMeasureArticulation: annotateMeasureArticulation,
    getExplicitLeftHand: getExplicitLeftHand,
    parseBracketChordSpec: parseBracketChordSpec, tokenizeMeasureBeats: tokenizeMeasureBeats,
    decodeMeasureLine: GuitarNotation.decodeMeasureLine, serializeScoreMeasures: serializeScoreMeasures, validateScore: validateScore,
    getSongCapo: getSongCapo, soundingMidi: soundingMidi, splitScoreMeasures: splitScoreMeasures,
    getExplicitBass: getExplicitBass,
    parseScore: parseScore, buildStructuredSong: buildStructuredSong,
    projectScoreToEditorBars: projectScoreToEditorBars, parseTextToVeBars: parseTextToVeBars
  };
  if (typeof window !== 'undefined'){
    Object.keys(api).forEach(function(key){ window[key] = api[key]; });
    window.GuitarParser = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
