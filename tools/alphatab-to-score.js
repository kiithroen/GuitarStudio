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
// D.S.·D.C. 가 적힌 마디의 박 글에 이 글이 있으면 이동 뒤 구간이 도돌이·1·2번 괄호를 다시 지킨다.
const WITH_REPEAT = /with\s*repeat/i;

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
  fermata: '페르마타',
  anacrusis: '못갖춘마디',
  overflow: '마디 길이를 넘는 음 생략',
  tempo: '템포 변화 생략',
  outOfRange: '음역 밖 → 옥타브 옮김',
  slurOtherString: '다른 줄 슬러 생략',
  noStringSlur: '줄 정보 없음: 슬러 생략',
  noStringSlide: '줄 정보 없음: 슬라이드 생략',
  noStringHarmonic: '줄 정보 없음: 하모닉스 생략',
  eightCells: '8칸(8분음표 칸): 4칸으로는 맞지 않는 리듬이 있음'
};

// alphaTab 의 이동 표시(Direction 중 Jump 로 시작하는 것)의 이름. 이동해서 다시 들어온 첫 마디의 메모는 이름 + JUMP_SUFFIX 다.
// 목표 표시(Segno·Coda·Fine)는 메모 없이 alphaTab 연주 순서가 따른다.
const JUMP_SUFFIX = ' 펼침';
const DIRECTION_LABEL = {
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

// 4/4 곡을 8분음표 8칸으로 다시 변환할 때 쓰는 격자
const EIGHT_CELL_GRID = { cells: 8, slotQuarter: 0.5, slotTicks: TICKS_PER_QUARTER * 0.5 };

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

// ---------- 연주 순서(도돌이·1/2번 괄호·이동 표시)

// 반복, 1·2번 괄호, D.S.·D.C.·Coda·Fine·To Coda 는 alphaTab의 재생 순서(MidiFileGenerator)를 그대로 쓴다.
// 예외: D.S.·D.C. 가 적힌 마디의 박 글에 "with Repeat" 가 있으면(책의 D.S. with Repeat) 그 이동 뒤 구간은 도돌이와 1·2번 괄호를 다시 지키는 순서로 바꾼다.
// alphaTab 은 이동한 뒤 도돌이를 건너뛰어서 alphaTex 로는 적을 수 없는 뜻이다.
function playOrder(score, staff){
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(new alphaTab.midi.MidiFile());
  const generator = new alphaTab.midi.MidiFileGenerator(score, newSettings(), handler);
  generator.generate();
  const order = generator.tickLookup.masterBars.map(function(item){ return item.masterBar.index; });
  const masterBars = score.masterBars;
  for (let position = 0; position < order.length; position++){
    const jump = jumpInfo(masterBars[order[position]]);
    if (!jump || !jump.repeating || !barTextMatches(staff, order[position], WITH_REPEAT)) continue;
    const segment = withRepeatSegment(masterBars, order[position], jump.name);
    return segment ? order.slice(0, position + 1).concat(segment) : order;
  }
  return order;
}

// 박 글(txt)이 그 마디 어디에든 있는가
function barTextMatches(staff, index, pattern){
  const bar = staff.bars[index];
  if (!bar) return false;
  return bar.voices.some(function(voice){
    return voice.beats.some(function(beat){ return typeof beat.text === 'string' && pattern.test(beat.text); });
  });
}

function hasDirection(masterBar, direction){
  return !!masterBar.directions && masterBar.directions.has(direction);
}

// from 부터 위(위쪽 번호)로 처음 나오는 direction 마디. 없으면 -1. reverse 이면 from 이하에서 가장 가까운 것(없으면 처음 것).
function findDirectionBar(masterBars, direction, from, reverse){
  if (reverse){
    for (let i = from; i >= 0; i--) if (hasDirection(masterBars[i], direction)) return i;
  }
  for (let i = reverse ? 0 : from; i < masterBars.length; i++) if (hasDirection(masterBars[i], direction)) return i;
  return -1;
}

// 마디 index 가 든 도돌이 구간의 마지막 바퀴인가. 구간 끝(도돌이 끝 마디)을 위쪽으로 찾고, 없으면 도돌이 안이 아니므로 마지막이다.
function isLastPass(masterBars, index, pass){
  for (let j = index; j < masterBars.length; j++){
    if (j > index && masterBars[j].isRepeatStart) return true;
    if (masterBars[j].isRepeatEnd) return pass >= masterBars[j].repeatCount;
  }
  return true;
}

// D.S.·D.C. 로 이동한 뒤 구간의 연주 순서(마디 index 목록). 도돌이와 1·2번 괄호를 첫 바퀴처럼 다시 지킨다.
// To Coda 와 Fine 은 그 구간의 마지막 바퀴에서만 따른다(al Coda 면 To Coda, al Fine 이면 Fine). 이동할 곳을 못 찾으면 null.
function withRepeatSegment(masterBars, jumpIndex, name){
  const total = masterBars.length;
  let start = 0;
  if (name.indexOf('JumpDaCapo') !== 0){
    const segno = name.indexOf('JumpDalSegnoSegno') === 0 ? model.Direction.TargetSegnoSegno : model.Direction.TargetSegno;
    start = findDirectionBar(masterBars, segno, jumpIndex, true);
    if (start < 0) return null;
  }
  const alFine = name.indexOf('AlFine') > 0;
  const toCoda = name.indexOf('AlDoubleCoda') > 0 ? model.Direction.JumpDaDoubleCoda : (name.indexOf('AlCoda') > 0 ? model.Direction.JumpDaCoda : null);
  const codaTarget = toCoda === model.Direction.JumpDaDoubleCoda ? model.Direction.TargetDoubleCoda : model.Direction.TargetCoda;
  let repeatStart = 0;
  for (let i = start; i >= 0; i--) if (masterBars[i].isRepeatStart){ repeatStart = i; break; }
  const result = [];
  let pass = 1;
  let i = start;
  let loopedBack = true;
  let guard = 0;
  while (i < total && guard++ < total * 50){
    const masterBar = masterBars[i];
    if (masterBar.isRepeatStart && !loopedBack){ repeatStart = i; pass = 1; }
    loopedBack = false;
    const endings = masterBar.alternateEndings;
    if (endings && !(endings & (1 << (pass - 1)))){ i++; continue; }
    result.push(i);
    const last = isLastPass(masterBars, i, pass);
    if (alFine && last && hasDirection(masterBar, model.Direction.TargetFine)) break;
    if (toCoda !== null && last && hasDirection(masterBar, toCoda)){
      const coda = findDirectionBar(masterBars, codaTarget, i + 1, false);
      if (coda >= 0){ i = coda; repeatStart = coda; pass = 1; loopedBack = true; continue; }
    }
    if (masterBar.isRepeatEnd && pass < masterBar.repeatCount){ pass++; i = repeatStart; loopedBack = true; continue; }
    if (masterBar.isRepeatEnd){ pass = 1; repeatStart = i + 1; }
    i++;
  }
  return result;
}

// 마디에 붙은 이동 표시(D.S.·D.C.·To Coda, Direction 이름이 Jump 로 시작하는 것). 없으면 null.
// repeating: D.S.·D.C. 계열(되돌아가는 이동). target(index): 그 이동의 도착지인 마디인가. 목표 표시(Segno·Coda·Fine)는 이동이 아니다.
function jumpInfo(masterBar){
  if (!masterBar.directions || !masterBar.directions.size) return null;
  let found = null;
  masterBar.directions.forEach(function(direction){
    const name = model.Direction[direction];
    if (!found && name.indexOf('Jump') === 0 && DIRECTION_LABEL[name]) found = { name: name, label: DIRECTION_LABEL[name] };
  });
  if (found) found.repeating = found.name.indexOf('JumpDalSegno') === 0 || found.name.indexOf('JumpDaCapo') === 0;
  return found;
}

// 이동 표시가 붙은 마디 다음에 온 마디가 그 이동의 도착지인가(D.S.류는 세뇨 표지 마디, D.C.류는 첫 마디, To Coda는 코다 표지 마디).
// 1·2번 괄호로 건너뛴 마디는 도착지가 아니다.
function isJumpArrival(jump, masterBar, index){
  if (jump.name.indexOf('JumpDaCapo') === 0) return index === 0;
  if (jump.name.indexOf('JumpDalSegnoSegno') === 0) return hasDirection(masterBar, model.Direction.TargetSegnoSegno);
  if (jump.name.indexOf('JumpDalSegno') === 0) return hasDirection(masterBar, model.Direction.TargetSegno);
  if (jump.name === 'JumpDaCoda') return hasDirection(masterBar, model.Direction.TargetCoda);
  if (jump.name === 'JumpDaDoubleCoda') return hasDirection(masterBar, model.Direction.TargetDoubleCoda);
  return false;
}

// 1·2번 괄호의 첫 마디면 "1번 괄호" 꼴의 글. 앞 마디가 같은 괄호면 그 괄호의 첫 마디가 아니다.
function endingText(masterBar, previous){
  const endings = masterBar.alternateEndings;
  if (!endings) return '';
  const fresh = endings & ~(previous ? previous.alternateEndings : 0);
  const numbers = [];
  for (let bit = 0; bit < 8; bit++) if (fresh & (1 << bit)) numbers.push(bit + 1);
  return numbers.length ? numbers.join('·') + '번 괄호' : '';
}

// 마디의 섹션(리허설 기호) 글. 마커와 글이 둘 다 있으면 공백으로 잇는다.
function sectionText(masterBar){
  const section = masterBar.section;
  if (!section) return '';
  return [section.marker, section.text].filter(function(part){ return typeof part === 'string' && part.trim(); }).join(' ').replace(/[\t\r\n]+/g, ' ').trim();
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

// 코드 사전에 없는 이름이면 괄호를 벗긴 이름, 7(9) 꼴이면 9 로 바꾼 이름 순으로 사전에 있는 첫 이름을 쓴다. 모두 없으면 원래 이름이다.
function dictionaryChordName(name){
  if (inChordDictionary(name)) return name;
  const stripped = name.replace(/[()]/g, '');
  const candidates = [stripped];
  if (name.indexOf('7(9)') >= 0) candidates.push(name.replace('7(9)', '9').replace(/[()]/g, ''));
  for (let i = 0; i < candidates.length; i++){
    if (candidates[i] !== name && isValidChordName(candidates[i]) && inChordDictionary(candidates[i])) return candidates[i];
  }
  return name;
}

const dictionaryChecks = new Map();
function inChordDictionary(name){
  if (!dictionaryChecks.has(name)){
    const result = parser.validateScore('[' + name + '] r', 1);
    dictionaryChecks.set(name, !result.warnings.some(function(warning){ return warning.code === 'UNSUPPORTED_CHORD'; }));
  }
  return dictionaryChecks.get(name);
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

// 한 조각(같은 칸·같은 분할 자리)에 같은 줄·같은 음높이(줄 없는 음이면 같은 음높이)의 음이 둘 이상이면 하나만 남긴다.
// 남기는 것은 끝이 가장 늦은 것이고, 비어 있는 운지·주법은 버린 것에서 가져온다. 두 성부가 같은 음을 치면 이런 기록이 둘 나온다.
function dedupeRecords(records){
  const kept = [];
  records.forEach(function(record){
    const index = kept.findIndex(function(other){ return other.str === record.str && other.midi === record.midi; });
    if (index < 0){ kept.push(record); return; }
    const other = kept[index];
    const winner = record.endRel > other.endRel ? record : other;
    const loser = winner === record ? other : record;
    ['left', 'right', 'articulation'].forEach(function(field){ if (!winner[field] && loser[field]) winner[field] = loser[field]; });
    kept[index] = winner;
  });
  return kept;
}

function sortTokens(parts){
  return parts.slice().sort(function(a, b){ return b.str - a.str || a.midi - b.midi; });
}

// 4/4 곡이 4칸 격자에 맞지 않는 리듬을 가지면(옮긴 음이 있으면) 8칸(8분음표 칸)으로 다시 변환해 보고, 옮긴 음이 줄면 8칸 결과를 쓴다.
// 2/4·3/4 등은 칸을 늘리면 앱이 박자를 다르게 읽어서 바꾸지 않는다.
function convertScore(score, options){
  try {
    const opts = options || {};
    const first = convert(score, opts, null);
    let result = first;
    if (first.eightCellsEligible && first.movedCount > 0){
      let second = null;
      try { second = convert(score, opts, EIGHT_CELL_GRID); } catch (error) { if (!(error instanceof Refusal)) throw error; }
      if (second && second.movedCount < first.movedCount) result = second;
    }
    delete result.movedCount;
    delete result.eightCellsEligible;
    return result;
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message };
    throw error;
  }
}

// forcedGrid 가 있으면 박자표로 고르지 않고 그 격자를 쓴다(4/4 곡의 8칸 다시 변환).
function convert(score, opts, forcedGrid){
  if (!score || !score.masterBars || !score.masterBars.length) refuse('마디가 없는 악보입니다.');
  const picked = selectStaff(score, opts.trackNumber);
  const staff = picked.staff;
  const hasStrings = picked.hasStrings;
  const masterBars = score.masterBars;

  // 박자표: 첫 마디(못갖춘마디면 그 다음)가 곡의 박자표다. 다른 박자표가 나오면 변환하지 않는다.
  // 예외: 격자 마디보다 짧고 칸 길이의 정수배인 마디는 변환한다(모자란 칸은 아래에서 채운다).
  const signatureBar = masterBars.find(function(masterBar){ return !masterBar.isAnacrusis; }) || masterBars[0];
  const meterChanges = masterBars.filter(function(masterBar){
    return masterBar.timeSignatureNumerator !== signatureBar.timeSignatureNumerator || masterBar.timeSignatureDenominator !== signatureBar.timeSignatureDenominator;
  });
  const quarterTempo = score.tempo;
  if (!(quarterTempo > 0)) refuse('템포를 읽을 수 없습니다.');
  const meterKey = signatureBar.timeSignatureNumerator + '/' + signatureBar.timeSignatureDenominator;
  const grid = forcedGrid || chooseGrid(signatureBar.timeSignatureNumerator, signatureBar.timeSignatureDenominator, quarterTempo);
  const barTicks = grid.cells * grid.slotTicks;
  // 박자표가 다른 마디: 못갖춘마디가 아니고, 격자 마디보다 짧고, 칸 길이의 정수배여야 한다. 아니면 변환하지 않는다.
  // shortBars[마디 index] = { ticks(원래 마디 길이), numerator, denominator }. 모자란 칸은 뒤쪽 빈칸 _ 으로 채운다.
  const shortBars = new Map();
  meterChanges.forEach(function(masterBar){
    const ticks = signatureTicks(masterBar);
    if (masterBar.isAnacrusis || !(ticks < barTicks) || ticks % grid.slotTicks !== 0){
      refuse('곡 중간에 박자표가 바뀝니다(' + (masterBar.index + 1) + '마디 ' + masterBar.timeSignatureNumerator + '/' + masterBar.timeSignatureDenominator + '). 변환하지 않습니다.');
    }
    shortBars.set(masterBar.index, { ticks: ticks, numerator: masterBar.timeSignatureNumerator, denominator: masterBar.timeSignatureDenominator });
  });

  const rawBpm = quarterTempo / grid.slotQuarter;
  let bpm = Math.round(rawBpm);
  const descriptionParts = [];
  if (bpm < BPM_MIN || bpm > BPM_MAX){
    descriptionParts.push('BPM 자름(원래 값 ' + bpm + ')');
    bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
  }
  if (forcedGrid) descriptionParts.push(MEMO.eightCells);

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
    const texts = [];
    const chords = [];
    if (!bar) return { records: records, memos: memos, texts: texts, chords: chords };
    function memo(text){ if (memos.indexOf(text) < 0) memos.push(text); }
    bar.voices.forEach(function(voice, voiceIndex){
      voice.beats.forEach(function(beat){
        if (beat.isEmpty) return;
        // 박의 글(alphaTex 의 txt)은 그대로 그 마디 메모가 된다. 변환기가 만드는 근사 메모는 그 뒤에 붙는다.
        if (typeof beat.text === 'string' && beat.text) texts.push({ start: beat.playbackStart, text: beat.text });
        if (beat.fermata) memo(MEMO.fermata);
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
        // 롤은 박마다가 아니라 합친 조각에서 음이 둘 이상일 때 붙인다(두 성부에 걸친 롤은 박마다 음이 하나다).
        const roll = beat.brushType === model.BrushType.ArpeggioDown || beat.brushType === model.BrushType.ArpeggioUp;
        if (beat.brushType === model.BrushType.ArpeggioUp) memo(MEMO.arpeggioUp);
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
          // 줄이 있는 음만 @줄을 붙인다. 6줄 트랙 안에서도 string 이 없는 음(음이름으로 적은 음)은 줄 정보 없는 트랙과 같은 규칙 하나(아래 else)를 쓴다.
          if (hasStrings && note.isStringed && note.string >= 1){
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
            // {slur 이름} 짝의 도착 음도 같은 규칙이다. 다른 줄이면 슬러를 빼고 메모를 남긴다.
            const slurFrom = note.isSlurDestination ? note.slurOrigin : null;
            if (slurFrom && !articulation && !harmonic){
              if (slurFrom.string !== note.string) memo(MEMO.slurOtherString);
              else if (slurFrom.fret !== note.fret) articulation = 's';
            }
            const slideOrigin = note.slideOrigin;
            if (slideOrigin && !articulation && !harmonic){
              if (slideOrigin.string === note.string && slideOrigin.fret !== note.fret) articulation = 'g';
              else memo(MEMO.slide);
            }
            if ((note.slideOutType !== model.SlideOutType.None && !note.slideTarget) || note.slideInType !== model.SlideInType.None) memo(MEMO.slide);
          } else {
            // 줄 정보 없음(트랙 전체이거나 음 하나): 음높이만 쓰고 @줄은 붙이지 않는다(앱이 기본 위치를 고른다). 줄이 있어야 하는 주법은 뺀다.
            midi = pitchOnly(note);
            if (midi == null) return;
            if (note.harmonicType !== model.HarmonicType.None) memo(MEMO.noStringHarmonic);
            // {slur 이름} 짝의 도착 음은 출발 음과 음높이가 다르면 s 로 옮긴다(같은 높이 짝은 주법 없이 둔다). 기본 줄 판정이 어긋나는 짝은 마디를 만든 뒤 걸러 낸다.
            const slurFrom = note.isSlurDestination ? note.slurOrigin : null;
            const slurFromMidi = slurFrom ? pitchOnly(slurFrom) : null;
            if (slurFromMidi != null && slurFromMidi !== midi) articulation = 's';
            if (note.isHammerPullOrigin || !!note.hammerPullOrigin || note.isEffectSlurOrigin || note.isEffectSlurDestination || (note.isSlurDestination && slurFromMidi == null)) memo(MEMO.noStringSlur);
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
    texts.sort(function(a, b){ return a.start - b.start; });
    // 두 성부에 같은 박 글이 있으면 마디 메모에 한 번만 쓴다.
    const uniqueTexts = texts.map(function(entry){ return entry.text; }).filter(function(text, position, all){ return all.indexOf(text) === position; });
    return { records: records, memos: memos, texts: uniqueTexts, chords: chords };
  }

  function tokenText(record, moved){
    const name = parser.noteNameForMidi(record.midi, false);
    return record.articulation + record.left + name + (record.str ? '@' + record.str : '') + (record.right ? ':' + record.right : '') + (moved || record.shifted ? '?' : '');
  }

  let movedCount = 0;
  const order = playOrder(score, staff);
  const counts = new Map();
  order.forEach(function(index){ counts.set(index, (counts.get(index) || 0) + 1); });
  const seen = new Map();
  const lines = [];
  let carry = 0;
  let endChord = '';
  let lastPiece = null;

  order.forEach(function(index, position){
    const masterBar = masterBars[index];
    const occurrence = seen.has(index) ? seen.get(index) : 0;
    seen.set(index, occurrence + 1);
    const collected = collectBar(index);
    const shortBar = shortBars.get(index) || null;
    // 이 마디의 실제 길이. 못갖춘마디는 안에 든 내용의 길이, 박자표가 바뀐 짧은 마디는 그 박자표의 길이, 곡의 마지막 마디는 내용의 길이(격자보다 짧을 때)다.
    // 격자 마디보다 모자란 길이 중 칸 길이의 정수배는 빈칸 _ 으로 채운다(못갖춘마디는 앞쪽, 나머지는 뒤쪽). 칸보다 작은 나머지는 그 칸 안의 쉼 r 이 된다.
    const anacrusis = masterBar.isAnacrusis && pad[index] > 0;
    let actualLen = shortBar ? shortBar.ticks : barTicks;
    if (anacrusis) actualLen = barTicks - pad[index];
    else if (position === order.length - 1 && staff.bars[index]){
      const content = staff.bars[index].calculateDuration();
      if (content > 0 && content < actualLen) actualLen = content;
    }
    let blankCount = Math.min(grid.cells - 1, Math.floor((Math.max(0, barTicks - actualLen) + TOLERANCE_TICKS) / grid.slotTicks));
    // 못갖춘마디의 음은 pad 만큼 밀려 있으니 그 프레임에서 마디 끝은 격자 마디 끝이다.
    const barLen = anacrusis ? barTicks : actualLen;
    const memos = collected.memos.slice();
    if (masterBar.isAnacrusis) memos.push(MEMO.anacrusis);
    // 이동 표시(D.S. 등)가 붙은 마디 다음에 순서대로가 아닌 마디가 오고 그 마디가 그 이동의 도착지면, 이동해서 들어온 첫 마디다.
    // 1·2번 괄호로 건너뛴 마디는 도착지가 아니다.
    if (position > 0 && index !== order[position - 1] + 1){
      const jump = jumpInfo(masterBars[order[position - 1]]);
      if (jump && isJumpArrival(jump, masterBar, index)) memos.push(jump.label + JUMP_SUFFIX);
    }
    const ending = endingText(masterBar, index > 0 ? masterBars[index - 1] : null);
    if (ending) memos.push(ending);
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
    // 빈칸 칸에는 음이 들어가지 않는다. 음이 있는 칸까지는 빈칸으로 만들지 않는다.
    let firstNoteCell = grid.cells;
    let lastNoteCell = -1;
    cells.forEach(function(cellRecords, c){
      if (!cellRecords.length) return;
      if (c < firstNoteCell) firstNoteCell = c;
      if (c > lastNoteCell) lastNoteCell = c;
    });
    if (lastNoteCell >= 0) blankCount = Math.min(blankCount, anacrusis ? firstNoteCell : grid.cells - 1 - lastNoteCell);
    const isBlankCell = function(c){ return blankCount > 0 && (anacrusis ? c < blankCount : c >= grid.cells - blankCount); };

    // 쉼이 시작하는 자리: 칸 안에서 음이 끝났는데 그 자리 뒤로 울리는 음(다른 성부, 붙임줄로 이어진 음, 앞 마디에서 이어진 음)이 하나도 없는 자리.
    const restsByCell = [];
    for (let c = 0; c < grid.cells; c++) restsByCell.push([]);
    collected.records.forEach(function(record){
      const end = record.endRel;
      if (!(end > TOLERANCE_TICKS && end < barLen - TOLERANCE_TICKS)) return;
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
      if (isBlankCell(c)) return { blank: true };
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
      // 빈칸은 시간이 없어서 유지 사슬(lastPiece)을 건드리지 않는다.
      if (cellPlan.blank){ cellTexts.push('_'); return; }
      const pieces = [];
      for (let k = 0; k < cellPlan.division; k++){
        const time = c * grid.slotTicks + k * grid.slotTicks / cellPlan.division;
        const here = cellPlan.byPosition[k];
        let text;
        if (here.length){
          const rollAny = here.some(function(record){ return record.roll; });
          const distinct = dedupeRecords(here);
          distinct.forEach(function(record){ if (record.moved) movedCount++; });
          const parts = sortTokens(distinct.map(function(record){ return { str: record.str, midi: record.midi, record: record }; }));
          const tokens = parts.map(function(part){ return tokenText(part.record, part.record.moved); });
          const rolled = tokens.length > 1 && rollAny;
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
    if (shortBar) memos.push('원본 ' + shortBar.numerator + '/' + shortBar.denominator + ' 마디');

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
    carry = Math.max(0, Math.max(carry, maxEnd) - barLen);

    // 코드 이름: 마디 안 첫 코드를 머리표에, 그 뒤에 바뀌는 코드는 메모에
    collected.chords.sort(function(a, b){ return a.start - b.start; });
    let chordName = '-';
    if (collected.chords.length){
      const first = collected.chords[0];
      if (isValidChordName(first.name)){
        const normalized = dictionaryChordName(first.name);
        chordName = normalized;
        if (normalized !== first.name) memos.push('원본 ' + first.name);
      } else memos.push('코드 이름 변환 불가: ' + first.name);
      collected.chords.slice(1).forEach(function(entry){
        if (entry.name === first.name) return;
        const cellNumber = Math.min(grid.cells, Math.max(0, Math.floor((entry.start + TOLERANCE_TICKS) / grid.slotTicks))) + 1;
        memos.push(cellNumber + '박부터 ' + entry.name);
      });
      const lastName = collected.chords[collected.chords.length - 1].name;
      endChord = isValidChordName(lastName) ? dictionaryChordName(lastName) : lastName;
    } else if (isValidChordName(endChord)){
      // 교본은 같은 코드가 이어지는 마디에 코드 이름을 다시 적지 않는데, 앱의 코드 카드는 마디 머리표로 그려서 비우면 카드가 끊긴다.
      chordName = endChord;
    }

    // 섹션(리허설 기호)은 그 마디 메모의 맨 앞이다. 펼친 사본마다 같다.
    const section = sectionText(masterBar);
    lines.push({ chord: chordName, cells: cellTexts, texts: section ? [section].concat(collected.texts) : collected.texts, memos: memos, overlap: overlap, hasNotes: collected.records.length > 0 });
  });

  // 길이가 다른 음의 겹침 메모는 한 마디라도 해당하면 설명에 한 번만 적는다. 두 성부 곡은 거의 모든 마디가 해당해 마디 메모가 다른 메모를 가린다.
  if (lines.some(function(line){ return line.hasNotes && line.overlap; })) descriptionParts.push(MEMO.overlap);

  function buildMeasureTexts(){
    return lines.map(function(line){
      const memos = line.texts.concat(line.memos);
      return '[' + line.chord + '] ' + line.cells.join(' ') + (memos.length ? ' | ' + JSON.stringify(memos.join(' · ')) : '');
    });
  }

  const title = String(score.title || '').trim() || opts.fallbackTitle || '제목 없음';
  // 탭·줄바꿈은 시트 열을 깨니 공백으로 바꾼다(MusicXML 제목에는 줄 바꿈 없는 공백 U+00A0 이 섞여 나오기도 한다).
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const sourceName = opts.sourceName ? String(opts.sourceName).replace(/\s+/g, ' ') : '';
  // 설명: alphaTex 머리의 notices 가 있으면 그대로(탭·줄바꿈만 공백으로) 쓰고 곡 전체 근사 메모만 뒤에 붙인다. 없으면 원본 파일 이름으로 시작한다.
  const noticeText = typeof score.notices === 'string' ? score.notices.replace(/[\t\r\n]+/g, ' ') : '';
  let description = noticeText.trim()
    ? [noticeText].concat(descriptionParts).join(' · ')
    : ['원본: ' + (sourceName || '(이름 없음)') + ' · alphaTab 변환']
      .concat(capo > 0 ? ['Capo ' + capo] : [])
      .concat(descriptionParts)
      .join(' · ');
  // 앱은 카포를 제목·설명의 표기(getSongCapo)로만 읽는다. \capo 가 있는데 표기가 없으면(notices 만 있는 경우) 설명 끝에 붙인다.
  if (capo > 0 && parser.getSongCapo({ title: cleanTitle, badge: description }) !== capo) description += ' · Capo ' + capo;
  // @줄 없는 슬러 음은 앱이 고른 기본 줄로 판정한다. 앞 음과 다른 줄이 잡혀 INVALID_SLUR 가 나면 그 마디의 그 s 만 빼고 메모를 남긴다.
  // 판정은 parser.validateScore 하나로 하고, 오류 메시지 끝의 토큰으로 칸 안의 음을 찾는다.
  let measureTexts = buildMeasureTexts();
  let validation = parser.validateScore(measureTexts.join('\n'), grid.cells);
  let slurFixed = false;
  validation.errors.forEach(function(error){
    if (error.code !== 'INVALID_SLUR') return;
    const line = lines[error.measure - 1];
    const token = String(error.message).slice(String(error.message).lastIndexOf(': ') + 2);
    if (!line || !(error.beat >= 1) || token.charAt(0) !== 's' || token.indexOf('@') >= 0) return;
    const pieces = line.cells[error.beat - 1].split('/').map(function(piece){
      return piece.split('+').map(function(part){
        const roll = part.charAt(0) === '~';
        return { roll: roll, text: roll ? part.slice(1) : part };
      });
    });
    let done = false;
    pieces.forEach(function(parts){
      parts.forEach(function(part){
        if (!done && part.text === token){ part.text = token.slice(1); done = true; }
      });
    });
    if (!done) return;
    line.cells[error.beat - 1] = pieces.map(function(parts){
      return parts.map(function(part){ return (part.roll ? '~' : '') + part.text; }).join('+');
    }).join('/');
    if (line.memos.indexOf(MEMO.noStringSlur) < 0) line.memos.push(MEMO.noStringSlur);
    slurFixed = true;
  });
  if (slurFixed){
    measureTexts = buildMeasureTexts();
    validation = parser.validateScore(measureTexts.join('\n'), grid.cells);
  }
  const scoreText = measureTexts.join(' // ');
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
    warnings: validation.warnings,
    movedCount: movedCount,
    eightCellsEligible: !forcedGrid && meterKey === '4/4' && Math.round(quarterTempo * 2) <= BPM_MAX
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
  selectStaff: selectStaff,
  describeTracks: describeTracks,
  Refusal: Refusal,
  MEMO: MEMO
};

if (require.main === module) process.exitCode = main(process.argv);
