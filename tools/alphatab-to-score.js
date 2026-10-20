'use strict';

// alphaTex·Guitar Pro(.gp .gp3~.gp5 .gpx)·MusicXML(.musicxml .xml)을 alphaTab이 읽은 모델에서 우리 악보 시트 한 행(TSV)으로 바꾸는 도구.
// 사용: node tools/alphatab-to-score.js <입력 파일> [--track n] [-o 출력.tsv]
// 규칙과 한계는 Docs/alphatab.md 의 명령줄 도구 절. 우리 악보를 alphaTex로 바꾸는 반대 방향은 tools/score-to-alphatex.js.
const fs = require('node:fs');
const path = require('node:path');
const alphaTab = require('../vendor/alphatab/dist/alphaTab.min.js');
const notation = require('../src/notation.js');
const parser = require('../src/parser.js');
const alphaTexApi = require('../src/score-to-alphatex.js');
const checkScore = require('./check-score.js');

const model = alphaTab.model;
const TICKS_PER_QUARTER = 960;
// 표준 조율은 파서의 개방현 표(1번 줄이 높은 미)와 같은 순서다. alphaTab의 staff.tuning도 높은 줄부터다.
const STANDARD_TUNING = parser.STRINGS.map(function(string){ return string.midi; });
// src/app.js 곡 적용부가 자르는 범위(check-score.js 와 같은 값)
// 줄 정보 없는 트랙에서 음역 밖 음을 옥타브로 옮겨 넣는 범위: 6번 줄 개방 ~ 1번 줄 MAX_FRET 프렛
const LOWEST_MIDI = STANDARD_TUNING[STANDARD_TUNING.length - 1];
const HIGHEST_MIDI = STANDARD_TUNING[0] + notation.MAX_FRET;
const BPM_MIN = 30;
const BPM_MAX = 240;
// 칸 안 시작 자리를 칸 격자에 맞출 때 같다고 보는 오차(틱)
const TOLERANCE_TICKS = 2;
const DIVISIONS = [1, 2, 3, 4];
const CAPO_MAX = 12;

// 마디 메모와 설명 문구
const MEMO = {
  grace: '꾸밈음 생략',
  dead: '데드 노트 생략',
  overlap: '긴 음은 시작만 적음',
  snap: '칸 분할에 맞지 않는 리듬 → 가까운 자리',
  arpeggioUp: '위에서 아래 롤 → 아래에서 위',
  stroke: '스트로크 → 동시에',
  harmonicFret: '하모닉스 프렛 아님',
  harmonicArtificial: '인공 하모닉스 → 보통 음',
  slide: '슬라이드 생략',
  bend: '벤딩',
  vibrato: '비브라토',
  tremolo: '트레몰로 → 한 번',
  whammy: '위미바',
  trill: '트릴',
  repeat: '도돌이 펼침',
  anacrusis: '못갖춘마디',
  overflow: '마디 길이를 넘는 음 생략',
  tempo: '템포 변화 생략',
  outOfRange: '음역 밖 → 옥타브 옮김',
  noStringSlur: '줄 정보 없음: 슬러 생략',
  noStringSlide: '줄 정보 없음: 슬라이드 생략',
  noStringHarmonic: '줄 정보 없음: 하모닉스 생략'
};

const DIRECTION_LABEL = {
  TargetFine: 'Fine',
  TargetSegno: 'Segno',
  TargetSegnoSegno: 'Segno Segno',
  TargetCoda: 'Coda',
  TargetDoubleCoda: 'Coda 2',
  JumpDaCapo: 'D.C.',
  JumpDaCapoAlCoda: 'D.C. al Coda',
  JumpDaCapoAlDoubleCoda: 'D.C. al Coda 2',
  JumpDaCapoAlFine: 'D.C. al Fine',
  JumpDalSegno: 'D.S.',
  JumpDalSegnoAlCoda: 'D.S. al Coda',
  JumpDalSegnoAlDoubleCoda: 'D.S. al Coda 2',
  JumpDalSegnoAlFine: 'D.S. al Fine',
  JumpDalSegnoSegno: 'D.S.S.',
  JumpDalSegnoSegnoAlCoda: 'D.S.S. al Coda',
  JumpDalSegnoSegnoAlDoubleCoda: 'D.S.S. al Coda 2',
  JumpDalSegnoSegnoAlFine: 'D.S.S. al Fine',
  JumpDaCoda: 'To Coda',
  JumpDaDoubleCoda: 'To Coda 2'
};

class Refusal extends Error {}

function refuse(message){
  throw new Refusal(message);
}

// ---------- 파일 읽기

function newSettings(){
  const settings = new alphaTab.Settings();
  settings.core.logLevel = alphaTab.LogLevel.None;
  return settings;
}

function diagnosticLines(importer){
  return [importer.lexerDiagnostics, importer.parserDiagnostics, importer.semanticDiagnostics]
    .flatMap(function(bag){ return bag && Array.isArray(bag.items) ? bag.items : []; })
    .filter(function(item){ return item.severity === 2; })
    .map(function(item){ return item.start.line + '행 ' + item.start.col + '열: ' + item.message; });
}

// alphaTex 글에서 악보를 읽는다. 읽지 못하면 이유를 담은 Refusal.
function parseAlphaTex(text){
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(text, newSettings());
  try {
    return importer.readScore();
  } catch (error) {
    const lines = diagnosticLines(importer);
    refuse('alphaTex를 읽지 못했습니다' + (lines.length ? ':\n  ' + lines.slice(0, 5).join('\n  ') : ': ' + (error && error.message ? error.message : error)));
  }
  return null;
}

// 바이트에서 Guitar Pro·MusicXML을 읽는다.
function parseScoreBytes(bytes){
  try {
    return alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(bytes), newSettings());
  } catch (error) {
    refuse('악보 파일을 읽지 못했습니다: ' + (error && error.message ? error.message : error));
  }
  return null;
}

const TEX_EXTENSIONS = ['.tex', '.alphatex'];
const BINARY_EXTENSIONS = ['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.musicxml', '.xml'];

// 파일 이름의 확장자로 읽는 방법을 고른다. 모르는 확장자면 null.
function loadScoreFile(file){
  const extension = path.extname(file).toLowerCase();
  if (TEX_EXTENSIONS.indexOf(extension) >= 0) return parseAlphaTex(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (BINARY_EXTENSIONS.indexOf(extension) >= 0) return parseScoreBytes(fs.readFileSync(file));
  return null;
}

// ---------- 박자표·템포 → 칸

// src/score-prompt.js [문법 5] 표. 박자표(분자/분모)와 한 칸의 길이를 정한다.
function chooseGrid(numerator, denominator, quarterTempo){
  const key = numerator + '/' + denominator;
  let cells;
  let slotQuarter;
  if (key === '2/4' || key === '3/4' || key === '4/4'){ cells = numerator; slotQuarter = 1; }
  else if (key === '2/2'){ cells = 4; slotQuarter = 1; }
  else if (key === '3/8'){ cells = 3; slotQuarter = 0.5; }
  else if (key === '6/8' || key === '9/8'){
    cells = numerator;
    slotQuarter = 0.5;
    if (Math.round(quarterTempo / slotQuarter) > BPM_MAX){ cells = numerator / 3; slotQuarter = 1.5; }
  }
  else if (key === '12/8'){ cells = 4; slotQuarter = 1.5; }
  else refuse('표에 없는 박자입니다: ' + key + ' (지원: 2/4, 3/4, 4/4, 2/2, 3/8, 6/8, 9/8, 12/8)');
  if (notation.SHEET_BEAT_COUNTS.indexOf(cells) < 0) refuse('칸 수를 시트가 받지 않습니다: ' + cells);
  return { cells: cells, slotQuarter: slotQuarter, slotTicks: TICKS_PER_QUARTER * slotQuarter };
}

// ---------- 트랙 고르기

function isStandardTuning(staff){
  return staff.tuning.length === STANDARD_TUNING.length && staff.tuning.every(function(value, index){ return value === STANDARD_TUNING[index]; });
}

function findStringStaff(track){
  return track.staves.find(function(staff){ return staff.tuning.length === STANDARD_TUNING.length; }) || null;
}

function hasPitchedNotes(staff){
  return staff.bars.some(function(bar){
    return bar.voices.some(function(voice){
      return voice.beats.some(function(beat){ return !beat.isEmpty && !beat.isRest && beat.notes.length > 0; });
    });
  });
}

// 조율(줄 정보)이 없고 음높이만 있는 보표. MusicXML 오선만 있는 기타 파트가 이 꼴이다.
function findPitchedStaff(track){
  return track.staves.find(function(staff){ return staff.tuning.length === 0 && !staff.isPercussion && hasPitchedNotes(staff); }) || null;
}

// 트랙 번호는 1부터 센다(Guitar Pro 같은 프로그램과 같다).
function describeTracks(score){
  return score.tracks.map(function(track, index){
    const staff = track.staves[0];
    let kind = '음높이 없음';
    if (staff && staff.tuning && staff.tuning.length) kind = staff.tuning.length + '줄';
    else if (staff && staff.isPercussion) kind = '타악기';
    else if (findPitchedStaff(track)) kind = '줄 정보 없음';
    return '  ' + (index + 1) + ': ' + (track.name || '(이름 없음)') + ' · ' + kind;
  }).join('\n');
}

function refuseTuning(staff){
  refuse('표준 조율(6줄)이 아닌 트랙은 변환하지 않습니다. 조율: ' + staff.tuning.join(' '));
}

// --track 이 없으면 6줄 표준 조율 트랙이 먼저, 없으면 음높이가 있는 첫 트랙(줄 정보 없음). 6줄인데 표준 조율이 아니면 거절한다.
function selectStaff(score, trackNumber){
  let track = null;
  let staff = null;
  if (trackNumber == null){
    for (let i = 0; i < score.tracks.length && !staff; i++){
      const found = findStringStaff(score.tracks[i]);
      if (found && isStandardTuning(found)){ track = score.tracks[i]; staff = found; }
    }
    if (!staff){
      const odd = score.tracks.map(findStringStaff).find(Boolean);
      if (odd) refuseTuning(odd);
      for (let i = 0; i < score.tracks.length && !staff; i++){
        const found = findPitchedStaff(score.tracks[i]);
        if (found){ track = score.tracks[i]; staff = found; }
      }
    }
    if (!staff) refuse('기타로 읽을 트랙이 없습니다. 트랙 목록(1부터):\n' + describeTracks(score));
  } else {
    track = score.tracks[trackNumber - 1];
    if (!track) refuse('트랙 ' + trackNumber + '번이 없습니다. 트랙 목록(1부터):\n' + describeTracks(score));
    staff = findStringStaff(track) || findPitchedStaff(track);
    if (!staff) refuse('트랙 ' + trackNumber + '번은 6줄 기타가 아닙니다. 트랙 목록(1부터):\n' + describeTracks(score));
    if (staff.tuning.length && !isStandardTuning(staff)) refuseTuning(staff);
  }
  return { track: track, staff: staff, hasStrings: staff.tuning.length > 0 };
}

// ---------- 연주 순서(도돌이·1/2번 괄호)

// 반복과 1·2번 괄호는 alphaTab의 재생 순서(MidiFileGenerator)를 그대로 쓴다. D.S.·D.C. 같은 이동 표시는 펼치지 않으려고 생성하는 동안만 뗀다.
function playOrder(score){
  const saved = score.masterBars.map(function(masterBar){ return masterBar.directions; });
  score.masterBars.forEach(function(masterBar){ masterBar.directions = null; });
  try {
    const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(new alphaTab.midi.MidiFile());
    const generator = new alphaTab.midi.MidiFileGenerator(score, newSettings(), handler);
    generator.generate();
    return generator.tickLookup.masterBars.map(function(item){ return item.masterBar.index; });
  } finally {
    score.masterBars.forEach(function(masterBar, index){ masterBar.directions = saved[index]; });
  }
}

function directionLabels(masterBar){
  if (!masterBar.directions || !masterBar.directions.size) return [];
  const labels = [];
  masterBar.directions.forEach(function(direction){
    const label = DIRECTION_LABEL[model.Direction[direction]];
    if (label) labels.push(label);
  });
  return labels;
}

// ---------- 음 하나 → 토큰

function leftFinger(note){
  const finger = note.leftHandFinger;
  return finger >= model.Fingers.IndexFinger && finger <= model.Fingers.LittleFinger ? String(finger) : '';
}

function rightFinger(note){
  const finger = note.rightHandFinger;
  const names = ['p', 'i', 'm', 'a'];
  return finger >= model.Fingers.Thumb && finger <= model.Fingers.AnnularFinger ? names[finger] : '';
}

// 줄 정보 없는 음의 높이(MIDI). 오선 음은 realValue(이조 반영), 조율 없이 줄·프렛만 있는 음은 realValue 가 0 이라 옥타브·음 이름으로 셈한다.
function pitchOnly(note){
  if (note.realValue > 0) return note.realValue;
  if (note.octave >= 0 && note.tone >= 0) return note.octave * 12 + note.tone;
  return null;
}

function ourString(note, staff){
  return staff.tuning.length - note.string + 1;
}

function chordLabelName(name){
  return String(name || '').split(alphaTexApi.CHORD_NAME_PAD).join('').trim();
}

const chordValidity = new Map();
// 우리 문법이 받는 코드 이름인지는 validateScore(INVALID_CHORD) 하나로 가른다.
function isValidChordName(name){
  if (!name || /[\[\]|"\s]/.test(name)) return false;
  if (!chordValidity.has(name)){
    const result = parser.validateScore('[' + name + '] r', 1);
    chordValidity.set(name, !result.errors.some(function(error){ return error.code === 'INVALID_CHORD'; }));
  }
  return chordValidity.get(name);
}

// ---------- 마디별 변환

function barSpan(masterBar, sigTicks){
  return masterBar.isAnacrusis ? masterBar.calculateDuration() : sigTicks(masterBar);
}

function signatureTicks(masterBar){
  return masterBar.timeSignatureNumerator * (TICKS_PER_QUARTER * 4 / masterBar.timeSignatureDenominator);
}

// 한 칸 안 시작 자리(칸 시작 기준 틱)와 쉼이 시작하는 자리 모두에 맞는 가장 작은 분할을 고른다.
// 쉼 시작 자리까지 맞는 분할이 없으면 쉼 시작 자리는 버리고, 시작 자리만으로 같은 일을 한다.
// 그래도 맞는 분할이 없으면 오차 합이 가장 작은 쪽(같으면 4). 돌려주는 positions 는 시작 자리 순서다.
function chooseDivision(offsets, restOffsets, slotTicks){
  const withRests = offsets.concat(restOffsets);
  if (restOffsets.length){
    for (let i = 0; i < DIVISIONS.length; i++){
      const candidate = fitDivision(withRests, DIVISIONS[i], slotTicks);
      if (candidate.exact) return { division: candidate.division, positions: candidate.positions.slice(0, offsets.length), total: 0, exact: true };
    }
  }
  for (let i = 0; i < DIVISIONS.length; i++){
    const candidate = fitDivision(offsets, DIVISIONS[i], slotTicks);
    if (candidate.exact) return candidate;
  }
  let best = null;
  [4, 3, 2, 1].forEach(function(division){
    const candidate = fitDivision(offsets, division, slotTicks);
    if (!best || candidate.total < best.total) best = candidate;
  });
  return best;
}

// 칸을 division 등분한 자리에 각 offset 을 가장 가까운 자리로 놓았을 때의 자리와 오차
function fitDivision(offsets, division, slotTicks){
  let total = 0;
  let exact = true;
  const positions = offsets.map(function(offset){
    const position = Math.min(division - 1, Math.max(0, Math.round(offset * division / slotTicks)));
    const error = Math.abs(offset - position * slotTicks / division);
    total += error;
    if (error > TOLERANCE_TICKS) exact = false;
    return position;
  });
  return { division: division, positions: positions, total: total, exact: exact };
}

function sortTokens(parts){
  return parts.slice().sort(function(a, b){ return b.str - a.str || a.midi - b.midi; });
}

function convertScore(score, options){
  try {
    return convert(score, options || {});
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message };
    throw error;
  }
}

function convert(score, opts){
  if (!score || !score.masterBars || !score.masterBars.length) refuse('마디가 없는 악보입니다.');
  const picked = selectStaff(score, opts.trackNumber);
  const staff = picked.staff;
  const hasStrings = picked.hasStrings;
  const masterBars = score.masterBars;

  // 박자표: 첫 마디(못갖춘마디면 그 다음)가 곡의 박자표이고, 다른 박자표가 나오면 변환하지 않는다.
  const signatureBar = masterBars.find(function(masterBar){ return !masterBar.isAnacrusis; }) || masterBars[0];
  masterBars.forEach(function(masterBar){
    if (masterBar.timeSignatureNumerator !== signatureBar.timeSignatureNumerator || masterBar.timeSignatureDenominator !== signatureBar.timeSignatureDenominator){
      refuse('곡 중간에 박자표가 바뀝니다(' + (masterBar.index + 1) + '마디 ' + masterBar.timeSignatureNumerator + '/' + masterBar.timeSignatureDenominator + '). 변환하지 않습니다.');
    }
  });
  const quarterTempo = score.tempo;
  if (!(quarterTempo > 0)) refuse('템포를 읽을 수 없습니다.');
  const grid = chooseGrid(signatureBar.timeSignatureNumerator, signatureBar.timeSignatureDenominator, quarterTempo);
  const barTicks = grid.cells * grid.slotTicks;

  const rawBpm = quarterTempo / grid.slotQuarter;
  let bpm = Math.round(rawBpm);
  const descriptionParts = [];
  if (bpm < BPM_MIN || bpm > BPM_MAX){
    descriptionParts.push('BPM 자름(원래 값 ' + bpm + ')');
    bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
  }

  if (!hasStrings) descriptionParts.push('줄 정보 없음(기본 위치)');

  const capo = staff.capo || 0;
  if (capo < 0 || capo > CAPO_MAX) refuse('카포는 0~' + CAPO_MAX + ' 사이여야 합니다: ' + capo);

  // 파일 순서의 마디 시작 위치(틱). 못갖춘마디는 안에 든 음 길이만큼만 차지한다.
  const barAbs = [];
  const pad = [];
  let cursor = 0;
  masterBars.forEach(function(masterBar, index){
    barAbs.push(cursor);
    const span = barSpan(masterBar, signatureTicks);
    pad.push(masterBar.isAnacrusis ? Math.max(0, barTicks - span) : 0);
    cursor += span;
  });

  function beatAbsStart(beat){
    return barAbs[beat.voice.bar.index] + beat.playbackStart;
  }

  function chainEndAbs(note){
    let end = beatAbsStart(note.beat) + note.beat.playbackDuration;
    let current = note;
    let guard = 0;
    while (current.tieDestination && guard++ < 10000){
      current = current.tieDestination;
      end = beatAbsStart(current.beat) + current.beat.playbackDuration;
    }
    return end;
  }

  const voiceCount = Math.max.apply(null, staff.bars.map(function(bar){
    return bar.voices.filter(function(voice){ return !voice.isEmpty; }).length;
  }).concat([0]));

  // 한 마디(파일 순서 index)에서 음 기록과 마디 메모 재료를 모은다.
  function collectBar(index){
    const bar = staff.bars[index];
    const offset = pad[index];
    const records = [];
    const memos = [];
    const chords = [];
    if (!bar) return { records: records, memos: memos, chords: chords };
    function memo(text){ if (memos.indexOf(text) < 0) memos.push(text); }
    bar.voices.forEach(function(voice, voiceIndex){
      voice.beats.forEach(function(beat){
        if (beat.isEmpty) return;
        if (beat.graceType !== model.GraceType.None){ memo(MEMO.grace); return; }
        const start = beat.playbackStart + offset;
        if (beat.hasChord){
          let chord = null;
          try { chord = beat.chord; } catch (error) { chord = null; }
          if (chord && chord.name) chords.push({ start: start, name: chordLabelName(chord.name) });
        }
        if (beat.isRest || !beat.notes.length) return;
        if (beat.hasWhammyBar) memo(MEMO.whammy);
        if (beat.isTremolo) memo(MEMO.tremolo);
        if (beat.vibrato !== model.VibratoType.None) memo(MEMO.vibrato);
        const roll = beat.notes.length > 1 && (beat.brushType === model.BrushType.ArpeggioDown || beat.brushType === model.BrushType.ArpeggioUp);
        if (beat.notes.length > 1 && beat.brushType === model.BrushType.ArpeggioUp) memo(MEMO.arpeggioUp);
        if (beat.notes.length > 1 && (beat.brushType === model.BrushType.BrushUp || beat.brushType === model.BrushType.BrushDown)) memo(MEMO.stroke);
        beat.notes.forEach(function(note){
          if (note.isDead){ memo(MEMO.dead); return; }
          if (note.hasBend) memo(MEMO.bend);
          if (note.vibrato !== model.VibratoType.None) memo(MEMO.vibrato);
          if (note.isTrill) memo(MEMO.trill);
          let str = 0;
          let midi;
          let harmonic = false;
          let articulation = '';
          let shifted = false;
          if (hasStrings){
            if (!note.isStringed) return;
            str = ourString(note, staff);
            if (str < 1 || str > 6) refuse('줄 번호가 6줄 범위를 벗어난 음이 있습니다(' + (index + 1) + '마디).');
            const open = STANDARD_TUNING[str - 1];
            midi = open + note.fret;
            if (note.harmonicType === model.HarmonicType.Natural){
              if (notation.NATURAL_HARMONICS[note.fret] != null){
                midi = open + notation.NATURAL_HARMONICS[note.fret];
                harmonic = true;
              } else memo(MEMO.harmonicFret);
            } else if (note.harmonicType !== model.HarmonicType.None) memo(MEMO.harmonicArtificial);

            // 슬러·슬라이드는 도착 음에 단다(우리 문법은 뒤 음에 s·g).
            const hammerOrigin = note.hammerPullOrigin;
            if (hammerOrigin && hammerOrigin.string === note.string && hammerOrigin.fret !== note.fret && !harmonic) articulation = 's';
            const slideOrigin = note.slideOrigin;
            if (slideOrigin && !articulation && !harmonic){
              if (slideOrigin.string === note.string && slideOrigin.fret !== note.fret) articulation = 'g';
              else memo(MEMO.slide);
            }
            if ((note.slideOutType !== model.SlideOutType.None && !note.slideTarget) || note.slideInType !== model.SlideInType.None) memo(MEMO.slide);
          } else {
            // 줄 정보 없음: 음높이만 쓰고 @줄은 붙이지 않는다(앱이 기본 위치를 고른다). 줄이 있어야 하는 주법은 뺀다.
            midi = pitchOnly(note);
            if (midi == null) return;
            if (note.harmonicType !== model.HarmonicType.None) memo(MEMO.noStringHarmonic);
            if (note.isHammerPullOrigin || !!note.hammerPullOrigin || note.isSlurOrigin || note.isSlurDestination || note.isEffectSlurOrigin || note.isEffectSlurDestination) memo(MEMO.noStringSlur);
            if (note.slideOutType !== model.SlideOutType.None || note.slideInType !== model.SlideInType.None) memo(MEMO.noStringSlide);
            while (midi < LOWEST_MIDI){ midi += 12; shifted = true; }
            while (midi > HIGHEST_MIDI){ midi -= 12; shifted = true; }
            if (shifted) memo(MEMO.outOfRange);
          }

          const continuation = note.isTieDestination && !!note.tieOrigin;
          records.push({
            note: note,
            beat: beat,
            voice: voiceIndex,
            str: str,
            midi: midi,
            harmonic: harmonic,
            articulation: harmonic ? 'h' : articulation,
            left: leftFinger(note),
            right: rightFinger(note),
            roll: roll,
            shifted: shifted,
            start: start,
            endRel: chainEndAbs(note) - barAbs[index] + offset,
            continuation: continuation
          });
        });
      });
    });
    return { records: records, memos: memos, chords: chords };
  }

  function tokenText(record, moved){
    const name = parser.noteNameForMidi(record.midi, false);
    return record.articulation + record.left + name + (record.str ? '@' + record.str : '') + (record.right ? ':' + record.right : '') + (moved || record.shifted ? '?' : '');
  }

  const order = playOrder(score);
  const counts = new Map();
  order.forEach(function(index){ counts.set(index, (counts.get(index) || 0) + 1); });
  const seen = new Map();
  const lines = [];
  let carry = 0;
  let lastPiece = null;

  order.forEach(function(index){
    const masterBar = masterBars[index];
    const occurrence = seen.has(index) ? seen.get(index) : 0;
    seen.set(index, occurrence + 1);
    const collected = collectBar(index);
    const memos = collected.memos.slice();
    if (masterBar.isAnacrusis) memos.push(MEMO.anacrusis);
    directionLabels(masterBar).forEach(function(label){ memos.push(label + ' 표시(펼치지 않음)'); });
    if (index > 0 && masterBar.tempoAutomations.length){
      const previous = masterBars[index - 1].tempoAutomations;
      const first = masterBar.tempoAutomations[0].value;
      const before = previous.length ? previous[previous.length - 1].value : quarterTempo;
      if (Math.round(first) !== Math.round(before)) memos.push(MEMO.tempo);
    }
    if (occurrence === 0 && masterBar.repeatGroup && masterBar.repeatGroup.isClosed && masterBar.repeatGroup.opening === masterBar && counts.get(index) > 1){
      memos.push(MEMO.repeat);
    }

    // 칸마다 시작 자리를 모은다.
    const starts = collected.records.filter(function(record){ return !record.continuation; });
    const cells = [];
    for (let c = 0; c < grid.cells; c++) cells.push([]);
    starts.forEach(function(record){
      const cell = Math.floor((record.start + TOLERANCE_TICKS) / grid.slotTicks);
      if (cell >= grid.cells){ if (memos.indexOf(MEMO.overflow) < 0) memos.push(MEMO.overflow); return; }
      record.cell = Math.max(0, cell);
      record.offset = Math.max(0, record.start - record.cell * grid.slotTicks);
      cells[record.cell].push(record);
    });

    // 쉼이 시작하는 자리: 칸 안에서 음이 끝났는데 그 자리 뒤로 울리는 음(다른 성부, 붙임줄로 이어진 음, 앞 마디에서 이어진 음)이 하나도 없는 자리.
    const restsByCell = [];
    for (let c = 0; c < grid.cells; c++) restsByCell.push([]);
    collected.records.forEach(function(record){
      const end = record.endRel;
      if (!(end > TOLERANCE_TICKS && end < barTicks - TOLERANCE_TICKS)) return;
      const cell = Math.floor(end / grid.slotTicks);
      const inCell = end - cell * grid.slotTicks;
      if (inCell <= TOLERANCE_TICKS || inCell >= grid.slotTicks - TOLERANCE_TICKS) return;
      const stillSounding = carry > end + TOLERANCE_TICKS || collected.records.some(function(other){
        return other !== record && other.start <= end + TOLERANCE_TICKS && other.endRel > end + TOLERANCE_TICKS;
      });
      if (!stillSounding) restsByCell[cell].push(inCell);
    });

    const cellTexts = [];
    let moved = false;
    const startTimes = [];
    // 1차: 칸별 분할과 자리 정하기
    const plan = cells.map(function(cellRecords, c){
      const restOffsets = restsByCell[c];
      if (!cellRecords.length && !restOffsets.length) return { division: 1, byPosition: [[]] };
      const choice = chooseDivision(cellRecords.map(function(record){ return record.offset; }), restOffsets, grid.slotTicks);
      const byPosition = [];
      for (let k = 0; k < choice.division; k++) byPosition.push([]);
      cellRecords.forEach(function(record, i){
        const position = choice.positions[i];
        record.position = position;
        record.snapped = position * grid.slotTicks / choice.division;
        record.moved = Math.abs(record.offset - record.snapped) > TOLERANCE_TICKS;
        if (record.moved) moved = true;
        byPosition[position].push(record);
      });
      return { division: choice.division, byPosition: byPosition };
    });
    if (moved) memos.push(MEMO.snap);
    starts.forEach(function(record){
      if (record.cell != null) startTimes.push({ record: record, time: record.cell * grid.slotTicks + record.snapped });
    });

    // 2차: 조각 문자열 만들기
    plan.forEach(function(cellPlan, c){
      const pieces = [];
      for (let k = 0; k < cellPlan.division; k++){
        const time = c * grid.slotTicks + k * grid.slotTicks / cellPlan.division;
        const here = cellPlan.byPosition[k];
        let text;
        if (here.length){
          const parts = sortTokens(here.map(function(record){ return { str: record.str, midi: record.midi, record: record }; }));
          const tokens = parts.map(function(part){ return tokenText(part.record, part.record.moved); });
          const rolled = tokens.length > 1 && here.some(function(record){ return record.roll; });
          text = (rolled ? '~' : '') + tokens.join('+');
          lastPiece = 'note';
        } else {
          let sounding = carry - time > TOLERANCE_TICKS;
          if (!sounding){
            sounding = startTimes.some(function(entry){ return entry.time < time && entry.record.endRel - time > TOLERANCE_TICKS; })
              || collected.records.some(function(record){ return record.continuation && record.start < time && record.endRel - time > TOLERANCE_TICKS; });
          }
          if (sounding && lastPiece !== null && lastPiece !== 'rest'){ text = '-'; lastPiece = 'hold'; }
          else { text = 'r'; lastPiece = 'rest'; }
        }
        pieces.push(text);
      }
      cellTexts.push(pieces.join('/'));
    });

    // 길이가 다른 음이 겹치는지(둘 이상의 성부가 있을 때)
    let overlap = false;
    if (voiceCount > 1){
      const all = collected.records.filter(function(record){ return !record.continuation; });
      all.forEach(function(a){
        all.forEach(function(b){
          if (a === b) return;
          const aLength = a.endRel - a.start;
          const bLength = b.endRel - b.start;
          if (a.start + TOLERANCE_TICKS < b.start && b.start < a.endRel - TOLERANCE_TICKS && Math.abs(aLength - bLength) > TOLERANCE_TICKS) overlap = true;
        });
      });
    }

    // 다음 마디로 이어지는 소리
    let maxEnd = 0;
    collected.records.forEach(function(record){ if (record.endRel > maxEnd) maxEnd = record.endRel; });
    carry = Math.max(0, Math.max(carry, maxEnd) - barTicks);

    // 코드 이름: 마디 안 첫 코드를 머리표에, 그 뒤에 바뀌는 코드는 메모에
    collected.chords.sort(function(a, b){ return a.start - b.start; });
    let chordName = '-';
    if (collected.chords.length){
      const first = collected.chords[0];
      if (isValidChordName(first.name)) chordName = first.name;
      else memos.push('코드 이름 변환 불가: ' + first.name);
      collected.chords.slice(1).forEach(function(entry){
        if (entry.name === first.name) return;
        const cellNumber = Math.min(grid.cells, Math.max(0, Math.floor((entry.start + TOLERANCE_TICKS) / grid.slotTicks))) + 1;
        memos.push(cellNumber + '박부터 ' + entry.name);
      });
    }

    lines.push({ chord: chordName, cells: cellTexts, memos: memos, overlap: overlap, hasNotes: collected.records.length > 0 });
  });

  // 길이가 다른 음의 겹침 메모는 곡 전체면 설명에 한 번만 적는다.
  const noteBars = lines.filter(function(line){ return line.hasNotes; });
  const overlapBars = noteBars.filter(function(line){ return line.overlap; });
  const overlapForWholeSong = overlapBars.length >= 2 && overlapBars.length === noteBars.length;
  if (overlapForWholeSong) descriptionParts.push(MEMO.overlap);

  const measureTexts = lines.map(function(line){
    const memos = line.memos.slice();
    if (line.overlap && !overlapForWholeSong) memos.push(MEMO.overlap);
    return '[' + line.chord + '] ' + line.cells.join(' ') + (memos.length ? ' | ' + JSON.stringify(memos.join(' · ')) : '');
  });

  const title = String(score.title || '').trim() || opts.fallbackTitle || '제목 없음';
  // 탭·줄바꿈은 시트 열을 깨니 공백으로 바꾼다(MusicXML 제목에는 줄 바꿈 없는 공백 U+00A0 이 섞여 나오기도 한다).
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const sourceName = opts.sourceName ? String(opts.sourceName).replace(/\s+/g, ' ') : '';
  const description = ['원본: ' + (sourceName || '(이름 없음)') + ' · alphaTab 변환']
    .concat(capo > 0 ? ['Capo ' + capo] : [])
    .concat(descriptionParts)
    .join(' · ');
  const scoreText = measureTexts.join(' // ');
  const validation = parser.validateScore(measureTexts.join('\n'), grid.cells);
  return {
    ok: true,
    title: cleanTitle,
    beats: grid.cells,
    bpm: bpm,
    capo: capo,
    description: description,
    measures: measureTexts,
    scoreText: scoreText,
    tsv: [cleanTitle, String(grid.cells), String(bpm), description, scoreText].join('\t'),
    trackNumber: picked.track.index + 1,
    errors: validation.errors,
    warnings: validation.warnings
  };
}

// ---------- 명령줄

const USAGE = '사용법: node tools/alphatab-to-score.js <입력 파일(.tex .alphatex .gp .gp3 .gp4 .gp5 .gpx .musicxml .xml)> [--track n] [-o 출력.tsv]';

function parseArgs(argv){
  const options = { file: null, trackNumber: null, output: null };
  for (let i = 0; i < argv.length; i++){
    const arg = argv[i];
    if (arg === '--track' || arg === '-o'){
      const value = argv[++i];
      if (value == null) return { error: arg + ' 뒤에 값이 필요합니다.' };
      if (arg === '-o') options.output = value;
      else {
        if (!/^[1-9][0-9]*$/.test(value)) return { error: '--track 은 1 이상의 정수(첫 트랙이 1)여야 합니다: ' + value };
        options.trackNumber = Number(value);
      }
    } else if (arg.charAt(0) === '-' && arg.length > 1){
      return { error: '알 수 없는 옵션입니다: ' + arg };
    } else if (!options.file){
      options.file = arg;
    } else {
      return { error: '입력 파일은 하나만 받습니다: ' + arg };
    }
  }
  if (!options.file) return { error: '입력 파일이 필요합니다.' };
  return { options: options };
}

function main(argv){
  const parsed = parseArgs(argv.slice(2));
  if (parsed.error){
    process.stderr.write(parsed.error + '\n' + USAGE + '\n');
    return 2;
  }
  const options = parsed.options;
  const extension = path.extname(options.file).toLowerCase();
  if (TEX_EXTENSIONS.concat(BINARY_EXTENSIONS).indexOf(extension) < 0){
    process.stderr.write('지원하지 않는 확장자입니다: ' + (extension || '(없음)') + '\n' + USAGE + '\n');
    return 2;
  }
  if (!fs.existsSync(options.file) || !fs.statSync(options.file).isFile()){
    process.stderr.write('파일을 읽지 못했습니다: ' + options.file + '\n');
    return 2;
  }
  let result;
  try {
    const score = loadScoreFile(options.file);
    result = convertScore(score, {
      trackNumber: options.trackNumber,
      sourceName: path.basename(options.file),
      fallbackTitle: path.basename(options.file, path.extname(options.file))
    });
  } catch (error) {
    result = { ok: false, error: error instanceof Refusal ? error.message : '변환 중 오류가 났습니다: ' + (error && error.message ? error.message : error) };
  }
  if (!result.ok){
    process.stderr.write('변환하지 못했습니다: ' + result.error + '\n');
    return 1;
  }
  if (options.output){
    try {
      fs.writeFileSync(options.output, result.tsv + '\n', 'utf8');
    } catch (error) {
      process.stderr.write('출력 파일을 쓰지 못했습니다: ' + options.output + '\n');
      return 1;
    }
    process.stderr.write('저장했습니다: ' + options.output + ' (' + result.beats + '칸 · ' + result.bpm + ' BPM · ' + result.measures.length + '마디)\n');
  } else {
    process.stdout.write(result.tsv + '\n');
  }
  const checked = checkScore.checkScoreText(result.tsv, options.output || options.file);
  if (checked.totals.errors > 0){
    process.stderr.write(checked.output + '\n');
    return 1;
  }
  return 0;
}

module.exports = {
  convertScore: convertScore,
  parseAlphaTex: parseAlphaTex,
  parseScoreBytes: parseScoreBytes,
  loadScoreFile: loadScoreFile,
  Refusal: Refusal,
  MEMO: MEMO
};

if (require.main === module) process.exitCode = main(process.argv);
