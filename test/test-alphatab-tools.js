const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const Module = require('node:module');
const alphaTab = require('../vendor/alphatab/dist/alphaTab.min.js');
const converter = require('../src/score-to-alphatex.js');
const parser = require('../src/parser.js');
const notation = require('../src/notation.js');
const rhythm = require('../src/rhythm.js');

const TOOL_PATH = path.join(__dirname, '../tools/alphatab-to-score.js');
const FORWARD_PATH = path.join(__dirname, '../tools/score-to-alphatex.js');
const FIXTURES = path.join(__dirname, 'fixtures/alphatab');
const tool = require(TOOL_PATH);

let checks = 0;
let failed = 0;
// 하나가 실패해도 나머지 검사는 계속 돌리고, 마지막에 실패가 있으면 종료 코드 1로 끝낸다.
function test(name, fn){
  checks++;
  try {
    fn();
    process.stdout.write('ok ' + checks + ' - ' + name + '\n');
  } catch (error) {
    failed++;
    process.stdout.write('not ok ' + checks + ' - ' + name + '\n' + String(error && error.stack ? error.stack : error).split('\n').slice(0, 14).join('\n') + '\n');
  }
}

// ---------- 공통 도우미

// alphaTex를 alphaTab 가져오기로 읽는다. 진단이 하나라도 있으면(경고 포함) 호출한 쪽이 실패로 본다.
function importTex(tex){
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  let score = null;
  let thrown = null;
  try { score = importer.readScore(); } catch (error) { thrown = error; }
  const diagnostics = [importer.lexerDiagnostics, importer.parserDiagnostics, importer.semanticDiagnostics]
    .flatMap(function(bag){ return bag && Array.isArray(bag.items) ? bag.items : []; })
    .map(function(item){ return item.code + ' ' + item.message; });
  return { score: score, thrown: thrown, diagnostics: diagnostics };
}

function importCleanTex(tex, label){
  const imported = importTex(tex);
  assert.deepEqual(imported.diagnostics, [], label + ' alphaTab 진단');
  assert.equal(imported.thrown, null, label + ' 읽기');
  return imported.score;
}

function readFixture(name){
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// 음 이름은 파서의 개방현 표와 하모닉스 표에서 셈한다. 튜닝 값을 테스트에 옮겨 적지 않는다.
function pitchName(str, semitones){
  return parser.noteNameForMidi(parser.STRINGS[str - 1].midi + semitones, false);
}
function n(str, fret){ return pitchName(str, fret) + '@' + str; }
function harmonic(str, handFret){ return 'h' + pitchName(str, notation.NATURAL_HARMONICS[handFret]) + '@' + str; }

function convertTex(tex, options){
  return tool.convertScore(importCleanTex(tex, 'convert'), options || { sourceName: 'inline.tex' });
}

// ---------- 왕복 비교: 원본 악보 줄 ↔ 변환 결과 줄

function gcd(a, b){ return b ? gcd(b, a % b) : a; }
function fraction(numerator, denominator){
  const divisor = gcd(numerator, denominator);
  return (numerator / divisor) + '/' + (denominator / divisor);
}

// alphaTex를 거치면 버려지는 것(아포얀도 !는 articulation 에 안 넣어 지워지고, 확인 표시 ?와 왼손 0도 지운다)을 뺀 채 구성음 순서를 줄 번호 내림차순으로 맞춘 음 토큰.
function normalizedPiece(piece){
  let text = piece.trim();
  let rolled = false;
  if (text.charAt(0) === '~'){ rolled = true; text = text.slice(1); }
  const parts = text.split('+').map(function(component){
    const parsed = parser.parseNoteToken(component.trim().replace(/\?$/, ''), 0);
    if (!parsed || !parsed.pos) return { str: 0, text: '(읽을 수 없음)' + component };
    const articulation = parsed.articulation === 'harmonic' ? 'h' : parsed.articulation === 'slur' ? 's' : parsed.articulation === 'slide' ? 'g' : '';
    const left = parsed.pos.lh >= 1 && parsed.pos.lh <= 4 ? String(parsed.pos.lh) : '';
    return { str: parsed.pos.str, text: articulation + left + parsed.en + '@' + parsed.pos.str + (parsed.pos.rh ? ':' + parsed.pos.rh : '') };
  });
  parts.sort(function(a, b){ return b.str - a.str; });
  return (rolled ? '~' : '') + parts.map(function(part){ return part.text; }).join('+');
}

// 한 마디를 칸 구성과 상관없는 사건 목록으로 바꾼다: 마디 안 위치(분수)와 내용. 유지(-)는 앞 사건에 합치고 이어 오는 쉼은 하나로 본다.
// 칸 수가 달라도(4/4를 8칸으로 쓴 곡 ↔ 4칸) 같은 소리면 같은 목록이 된다.
function canonicalBar(line){
  const decoded = notation.decodeMeasureLine(line);
  let chord = parser.cleanChordToken(decoded.chordRaw || '');
  if (chord === '' || chord === '?') chord = '-';
  const cells = notation.tokenizeMeasureBeats(decoded.notation);
  const events = [];
  cells.forEach(function(cell, cellIndex){
    const pieces = notation.splitBeatSubtokens(cell);
    pieces.forEach(function(piece, pieceIndex){
      const at = fraction(cellIndex * 12 + pieceIndex * 12 / pieces.length, cells.length * 12);
      if (piece === '-'){
        if (!events.length) events.push(at + ' -');
        return;
      }
      if (notation.isRestToken(piece)){
        const last = events[events.length - 1];
        if (last && / r$/.test(last)) return;
        events.push(at + ' r');
        return;
      }
      events.push(at + ' ' + normalizedPiece(piece));
    });
  });
  return { chord: chord, events: events, memo: decoded.lyric };
}

function quarterTempo(beats, bpm){
  return bpm * rhythm.getGridInfo(beats).slotQuarterLength;
}

const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '../songs.json'), 'utf8'));

// 모든 구조화 내장곡을 우리 악보 → alphaTex → alphaTab → 우리 악보로 돌려 원래 악보와 견준다. 다른 곳의 목록을 돌려준다.
function roundTripFailures(toolModule, forwardModule){
  const forwardConverter = forwardModule || converter;
  const failures = [];
  songs.forEach(function(song){
    const capo = parser.getSongCapo({ title: song.title, badge: song.badge });
    const forward = forwardConverter.toAlphaTex({ title: song.title, beats: song.beats, bpm: song.bpm, capo: capo, description: song.badge, lines: song.lines });
    if (forward.error){ failures.push(song.id + ': alphaTex 변환 실패 ' + forward.error); return; }
    const imported = importTex(forward.tex);
    if (imported.diagnostics.length || imported.thrown){ failures.push(song.id + ': alphaTex 읽기 실패 ' + imported.diagnostics.join(' / ')); return; }
    const back = toolModule.convertScore(imported.score, { sourceName: song.id + '.tex' });
    if (!back.ok){ failures.push(song.id + ': 되돌리기 실패 ' + back.error); return; }
    const original = parser.splitScoreMeasures(song.lines.join('\n'));
    if (original.length !== back.measures.length){
      failures.push(song.id + ': 마디 수 ' + original.length + ' → ' + back.measures.length);
      return;
    }
    if (quarterTempo(song.beats, song.bpm) !== quarterTempo(back.beats, back.bpm)) failures.push(song.id + ': 4분음표 템포 ' + quarterTempo(song.beats, song.bpm) + ' → ' + quarterTempo(back.beats, back.bpm));
    if (back.capo !== capo || parser.getSongCapo({ title: back.title, badge: back.description }) !== capo) failures.push(song.id + ': 카포 ' + capo + ' → ' + back.capo);
    if (back.errors.length) failures.push(song.id + ': 변환 결과 검사 오류 ' + back.errors[0].code);
    if (back.description !== song.badge) failures.push(song.id + ': 설명 ' + JSON.stringify(song.badge) + ' → ' + JSON.stringify(back.description));
    if (back.title !== song.title) failures.push(song.id + ': 제목 ' + song.title + ' → ' + back.title);
    original.forEach(function(line, index){
      const want = canonicalBar(line);
      const got = canonicalBar(back.measures[index]);
      if (want.chord !== got.chord || want.memo !== got.memo || JSON.stringify(want.events) !== JSON.stringify(got.events)){
        failures.push(song.id + ' ' + (index + 1) + '마디\n      원본 ' + line + '\n      결과 ' + back.measures[index]);
      }
    });
  });
  return failures;
}

// ---------- 손으로 짠 예제

// ---------- 줄 정보 없는 파트의 기대 계산

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiOf(step, octave){ return (octave + 1) * 12 + STEP_SEMITONES[step]; }

// 줄 정보 없는 음 토큰: 음역(6번 줄 개방 ~ 1번 줄 MAX_FRET 프렛) 밖이면 옥타브를 옮기고 ? 를 단다.
function pitchToken(midi){
  const lowest = parser.STRINGS[parser.STRINGS.length - 1].midi;
  const highest = parser.STRINGS[0].midi + notation.MAX_FRET;
  let value = midi;
  let shifted = false;
  while (value < lowest){ value += 12; shifted = true; }
  while (value > highest){ value -= 12; shifted = true; }
  return parser.noteNameForMidi(value, false) + (shifted ? '?' : '');
}

// simple.musicxml 의 음(피치·길이)에서 기대하는 악보 줄을 셈한다. 마디 하나, 화음 없음을 가정한다.
function simpleMusicXmlMeasures(){
  const xml = fs.readFileSync(path.join(FIXTURES, 'simple.musicxml'), 'utf8');
  const divisions = Number(/<divisions>(\d+)/.exec(xml)[1]);
  const cells = [];
  const noteRe = /<note>([\s\S]*?)<\/note>/g;
  let match;
  while ((match = noteRe.exec(xml))){
    const body = match[1];
    const step = /<step>([A-G])<\/step>/.exec(body)[1];
    const alter = /<alter>(-?\d+)<\/alter>/.exec(body);
    const octave = Number(/<octave>(\d+)<\/octave>/.exec(body)[1]);
    const length = Number(/<duration>(\d+)<\/duration>/.exec(body)[1]) / divisions;
    cells.push(pitchToken(midiOf(step, octave) + (alter ? Number(alter[1]) : 0)));
    for (let i = 1; i < length; i++) cells.push('-');
  }
  return ['[-] ' + cells.join(' ')];
}

// 줄 번호 없는 음으로 바꾼다(음이름으로 적은 음과 같은 모양: string·fret -1, 옥타브·음 이름만). alphaTex 는 한 보표에 프렛.줄 음과 음이름 음을 섞어 쓰는 것을 오류로 읽어서, 섞인 트랙은 읽은 모델을 고쳐 만든다.
function unstring(score, bar, beat, noteIndex, midi){
  const note = score.tracks[0].staves[0].bars[bar].voices[0].beats[beat].notes[noteIndex];
  note.string = -1;
  note.fret = -1;
  note.octave = Math.floor(midi / 12);
  note.tone = midi % 12;
}

const SOURCE_MEMO = '원본: ';
// 곡 중간의 짧은 마디 메모와 4/4 곡의 8칸 설명 문구
const SHORT_BAR_MEMO = '원본 2/4 마디';
const EIGHT_CELLS_NOTE = '8칸(8분음표 칸): 4칸으로는 맞지 않는 리듬이 있음';
const EXAMPLES = [
  {
    file: 'two-voices.tex', title: 'Two Voices', beats: 4, bpm: 80, capo: 0, descriptionHas: ['긴 음은 시작만 적음'],
    measures: [
      '[-] ' + [n(6, 0) + '+' + n(1, 0) + '/' + n(1, 1), n(1, 3) + '/' + n(1, 1), n(5, 0) + '+' + n(1, 0) + '/' + n(1, 1), n(1, 3) + '/' + n(1, 1)].join(' '),
      '[-] ' + [n(6, 0) + '+' + n(1, 3) + '/' + n(1, 1), n(1, 0) + '/' + n(1, 1), n(5, 0) + '+' + n(1, 3) + '/' + n(1, 1), n(1, 0) + '/' + n(1, 1)].join(' ')
    ]
  },
  {
    file: 'triplet.tex', title: 'Triplet', beats: 4, bpm: 72, capo: 0, descriptionHas: [],
    measures: ['[-] ' + [n(1, 0) + '/' + n(1, 1) + '/' + n(1, 3), n(2, 0), n(3, 0), n(4, 0)].join(' ')]
  },
  {
    // A B C(1번 괄호, 도돌이) | D(2번 괄호) E 는 A B C A B D E 로 펼쳐진다.
    file: 'repeats.tex', title: 'Repeats', beats: 4, bpm: 90, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + n(1, 0) + ' - - - | "도돌이 펼침"',
      '[-] ' + n(1, 1) + ' - - -',
      '[-] ' + n(1, 3) + ' - - - | "1번 괄호"',
      '[-] ' + n(1, 0) + ' - - -',
      '[-] ' + n(1, 1) + ' - - -',
      '[-] ' + n(2, 0) + ' - - - | "2번 괄호"',
      '[-] ' + n(2, 1) + ' - - -'
    ]
  },
  {
    file: 'techniques.tex', title: 'Techniques', beats: 4, bpm: 70, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + [n(1, 0), 's' + n(1, 2), n(1, 3), 'g' + n(1, 5)].join(' '),
      '[-] ' + [harmonic(1, 12), harmonic(2, 7), harmonic(3, 5), 'r'].join(' '),
      '[-] ' + ['~' + [n(6, 0), n(4, 0), n(3, 0)].join('+'), '~' + [n(6, 0), n(4, 0), n(3, 0)].join('+'), [n(6, 0), n(4, 0), n(3, 0)].join('+'), 'r'].join(' ') + ' | "위에서 아래 롤 → 아래에서 위 · 스트로크 → 동시에"',
      '[-] ' + [n(1, 3), 'r', n(3, 0), n(4, 0)].join(' ') + ' | "꾸밈음 생략 · 데드 노트 생략"'
    ]
  },
  {
    // 6/8 은 8분음표 6칸, 4분음표 템포의 두 배가 BPM
    file: 'six-eight.tex', title: 'Six Eight', beats: 6, bpm: 120, capo: 0, descriptionHas: [],
    measures: ['[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0), n(2, 1), n(2, 3)].join(' ')]
  },
  {
    // 12/8 은 점4분음표 4칸(칸 안 3분할), 4분음표 템포의 2/3 가 BPM
    file: 'twelve-eight.tex', title: 'Twelve Eight', beats: 4, bpm: 40, capo: 0, descriptionHas: [],
    measures: ['[-] ' + [
      n(1, 0) + '/' + n(1, 1) + '/' + n(1, 3),
      n(2, 0) + '/' + n(2, 1) + '/' + n(2, 3),
      n(3, 0) + '/' + n(3, 2) + '/' + n(3, 4),
      n(4, 0) + '/' + n(4, 2) + '/' + n(4, 4)
    ].join(' ')]
  },
  {
    file: 'pickup.tex', title: 'Pickup', beats: 4, bpm: 100, capo: 0, descriptionHas: [],
    measures: ['[-] _ _ _ ' + n(1, 0) + ' | "못갖춘마디"', '[-] ' + n(1, 1) + ' - - -']
  },
  {
    // 카포는 음높이에 넣지 않고(프렛 그대로) 설명 열의 Capo 표기로 남긴다.
    file: 'capo.tex', title: 'Capo Two', beats: 3, bpm: 64, capo: 2, descriptionHas: ['Capo 2'],
    measures: ['[-] ' + [n(5, 3), n(3, 0), n(1, 0)].join(' ')]
  },
  {
    file: 'guitar.musicxml', title: 'Guitar XML', beats: 4, bpm: 100, capo: 0, descriptionHas: [],
    measures: ['[-] ' + [n(1, 0), n(1, 1), n(2, 0), n(6, 0)].join(' ')]
  },
  {
    // 조율 없이 줄·프렛만 적힌 MusicXML 파트: 음높이만 쓰고 @줄은 붙이지 않는다. 기대는 파일의 음에서 셈한다.
    file: 'simple.musicxml', title: 'simple', beats: 4, bpm: 120, capo: 0, descriptionHas: ['줄 정보 없음(기본 위치)'],
    measures: simpleMusicXmlMeasures()
  },
  {
    // 오선만 있는 파트: 음역 밖 음(C2, C6)은 옥타브를 옮겨 ? 를 달고, 슬러는 빼고 메모, 화음은 + 로 묶는다.
    file: 'no-strings.musicxml', title: 'No Strings', beats: 4, bpm: 90, capo: 0, descriptionHas: ['줄 정보 없음(기본 위치)'],
    measures: [
      '[-] ' + [pitchToken(midiOf('E', 4)), 's' + pitchToken(midiOf('F', 4) + 1), pitchToken(midiOf('C', 2)), pitchToken(midiOf('C', 6))].join(' ') + ' | "음역 밖 → 옥타브 옮김"',
      '[-] ' + [pitchToken(midiOf('G', 3)) + '+' + pitchToken(midiOf('B', 3)), '-', pitchToken(midiOf('A', 3)), '-'].join(' ')
    ]
  },
  {
    // 음이름으로만 적은 곡(줄 정보 없음): @줄 없이 음높이만. 왼손·오른손 운지, 화음, 붙임줄, 쉼은 그대로.
    file: 'named-notes.tex', title: 'Named Notes', beats: 4, bpm: 90, capo: 0, descriptionHas: ['줄 정보 없음(기본 위치)'],
    measures: [
      '[-] ' + ['1' + pitchToken(midiOf('C', 4)) + ':i', pitchToken(midiOf('F', 4) + 1), pitchToken(midiOf('C', 3)) + '+' + pitchToken(midiOf('G', 3)), pitchToken(midiOf('B', 3) - 1)].join(' '),
      '[-] ' + [pitchToken(midiOf('E', 4)), '-', '-', 'r'].join(' ')
    ]
  },
  {
    // 6줄 트랙 안에서 음 몇 개만 줄 정보가 없는 곡(읽은 모델을 고쳐 만든다): 그 음만 @줄 없이, 같은 화음의 다른 음은 @줄 그대로.
    // 슬러 출발 음이 줄 없는 음이면 슬러를 빼고 메모, 음역 밖(C2)이면 옥타브를 옮기고 ? 와 메모.
    file: 'mixed-strings.tex', title: 'Mixed Strings', beats: 4, bpm: 80, capo: 0, descriptionHas: [], editsModel: true,
    edit: function(score){
      unstring(score, 0, 0, 0, parser.STRINGS[0].midi);
      unstring(score, 1, 0, 2, parser.STRINGS[1].midi);
      unstring(score, 1, 1, 0, parser.STRINGS[0].midi + 1);
      unstring(score, 2, 0, 0, midiOf('C', 2));
    },
    measures: [
      '[-] ' + [pitchToken(parser.STRINGS[0].midi), n(1, 2), n(2, 3), n(3, 0)].join(' '),
      '[-] ' + [n(6, 0) + '+' + n(4, 0) + '+' + pitchToken(parser.STRINGS[1].midi), pitchToken(parser.STRINGS[0].midi + 1), n(1, 3), 'r'].join(' ') + ' | "줄 정보 없음: 슬러 생략"',
      '[-] ' + [pitchToken(midiOf('C', 2)), n(4, 0), n(3, 0), n(2, 0)].join(' ') + ' | "음역 밖 → 옥타브 옮김"'
    ]
  },
  {
    // 섹션(리허설 기호)은 마디 메모의 맨 앞, 페르마타는 변환기 메모(박의 글 뒤)
    file: 'section-fermata.tex', title: 'Section Fermata', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + [n(1, 0), '-', n(1, 1), '-'].join(' ') + ' | "A · 페르마타"',
      '[-] ' + [n(1, 2), '-', '-', '-'].join(' ') + ' | "B Fine"',
      '[-] ' + [n(1, 3), '-', '-', '-'].join(' ') + ' | "C · 메모"',
      '[-] ' + [n(1, 5), '-', '-', '-'].join(' ')
    ]
  },
  {
    // 1 | 2(segno) | 3(To Coda) | 4(D.S. al Coda) | 5(coda) 는 1 2 3 4 2 3 5 로 펼쳐진다. 이동해서 다시 들어온 첫 마디(2번째 2)와 코다로 건너뛴 마디(5)에 메모.
    file: 'ds-al-coda.tex', title: 'DS Coda', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + n(1, 0) + ' - - -',
      '[-] ' + n(1, 2) + ' - - -',
      '[-] ' + n(1, 3) + ' - - -',
      '[-] ' + n(1, 5) + ' - - -',
      '[-] ' + n(1, 2) + ' - - - | "D.S. al Coda 펼침"',
      '[-] ' + n(1, 3) + ' - - -',
      '[-] ' + n(1, 7) + ' - - - | "To Coda 펼침"'
    ]
  },
  {
    // 1 | 2 | 3(Fine) | 4(D.C. al Fine) 는 1 2 3 4 1 2 3 으로 펼쳐지고 Fine 에서 끝난다.
    file: 'dc-al-fine.tex', title: 'DC Fine', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + n(1, 0) + ' - - -',
      '[-] ' + n(1, 1) + ' - - -',
      '[-] ' + n(1, 2) + ' - - -',
      '[-] ' + n(1, 3) + ' - - -',
      '[-] ' + n(1, 0) + ' - - - | "D.C. al Fine 펼침"',
      '[-] ' + n(1, 1) + ' - - -',
      '[-] ' + n(1, 2) + ' - - -'
    ]
  },
  {
    // 36마디 뼈대(마디 N의 박 글은 bN). 5마디 도돌이 시작+세뇨, 11마디 To Coda, 12마디 1번 괄호+도돌이 끝, 13마디 2번 괄호, 34마디 D.S. al Coda, 35마디 코다.
    // 34마디 박 글에 with Repeat 가 있으면 이동한 뒤에도 도돌이와 1·2번 괄호를 다시 지킨다: 세뇨(5)부터 11, 1번 괄호(12), 5~11 다시, 마지막 바퀴의 To Coda 로 35, 36.
    file: 'ds-with-repeat.tex', title: 'DS With Repeat', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: skeletonMeasures(true)
  },
  {
    // 같은 뼈대에서 with Repeat 글만 뺀 것은 alphaTab 순서 그대로: 세뇨에서 11까지 가고 곧장 To Coda 로 35, 36. 1·2번 괄호 메모는 건너뛴 자리에도 붙지 않는 To Coda 메모와 따로다.
    file: 'ds-with-repeat.tex', title: 'DS With Repeat', beats: 4, bpm: 80, capo: 0, descriptionHas: [], editsModel: true,
    transformText: function(text){ return text.replace('b34 with Repeat', 'b34'); },
    measures: skeletonMeasures(false)
  },
  {
    // 4/4 곡 가운데 2/4 마디(끝이 음): 4칸으로 만들고 뒤 2칸은 빈칸 `_` 으로 채운다.
    file: 'short-bar.tex', title: 'Short Bar', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' '),
      '[-] ' + [n(3, 0), n(4, 0), '_', '_'].join(' ') + ' | "' + SHORT_BAR_MEMO + '"',
      '[-] ' + [n(3, 1), n(3, 3), n(4, 0), n(4, 1)].join(' ')
    ]
  },
  {
    // 2/4 마디의 끝이 쉼이어도 뒤 2칸은 빈칸 `_` 이고 쉼은 그대로 쉼이다.
    file: 'short-bar-rest.tex', title: 'Short Bar Rest', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' '),
      '[-] ' + [n(3, 0), 'r', '_', '_'].join(' ') + ' | "' + SHORT_BAR_MEMO + '"',
      '[-] ' + [n(3, 1), n(3, 3), n(4, 0), n(4, 1)].join(' ')
    ]
  },
  {
    // 도돌이 안의 짧은 마디는 펼친 사본마다 같은 빈칸과 메모를 단다.
    file: 'short-bar-repeat.tex', title: 'Short Bar Repeat', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' ') + ' | "도돌이 펼침"',
      '[-] ' + [n(3, 0), n(4, 0), '_', '_'].join(' ') + ' | "' + SHORT_BAR_MEMO + '"',
      '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' '),
      '[-] ' + [n(3, 0), n(4, 0), '_', '_'].join(' ') + ' | "' + SHORT_BAR_MEMO + '"',
      '[-] ' + [n(3, 1), n(3, 3), n(4, 0), n(4, 1)].join(' ')
    ]
  },
  {
    // 4/4·템포 60 에 32분음표: 4칸에서는 옮긴 음이 생기므로 8분음표 8칸(BPM 은 4분음표 템포의 두 배)으로 바꾸고, 옮긴 음(?)이 없다.
    file: 'thirty-second.tex', title: 'Thirty Second', beats: 8, bpm: 120, capo: 0, descriptionHas: [EIGHT_CELLS_NOTE],
    measures: [
      '[-] ' + [
        [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join('/'), [n(2, 1), n(2, 3), n(3, 0), n(3, 1)].join('/'),
        [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join('/'), [n(2, 1), n(2, 3), n(3, 0), n(3, 1)].join('/'),
        n(4, 0), '-', n(3, 0), '-'
      ].join(' '),
      '[-] ' + [n(1, 0), '-', n(2, 0), '-', n(3, 0), '-', n(4, 0), '-'].join(' ')
    ]
  },
  {
    // 두 성부가 같은 순간 같은 줄의 같은 음을 치면 토큰 하나, 같은 박 글(rit.)은 마디 메모에 한 번
    file: 'same-note-voices.tex', title: 'Same Note Voices', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + [n(5, 0), '-', [n(5, 3), n(1, 0)].join('+'), '-'].join(' ') + ' | "rit."'
    ]
  }
];

// 뼈대의 기대 악보 줄: 연주 순서(마디 번호)와 그 자리의 변환기 메모. 박 글은 bN(34마디는 with Repeat 가 붙을 수 있다).
function skeletonMeasures(withRepeat){
  const order = [];
  function run(from, to){ for (let bar = from; bar <= to; bar++) order.push({ bar: bar }); }
  function mark(bar, memo){ order.push({ bar: bar, memo: memo }); }
  run(1, 4); mark(5, '도돌이 펼침'); run(6, 11); mark(12, '1번 괄호'); run(5, 11); mark(13, '2번 괄호'); run(14, 34);
  mark(5, 'D.S. al Coda 펼침'); run(6, 11);
  if (withRepeat){ mark(12, '1번 괄호'); run(5, 11); }
  mark(35, 'To Coda 펼침'); run(36, 36);
  return order.map(function(entry){
    const text = entry.bar === 34 && withRepeat ? 'b34 with Repeat' : 'b' + entry.bar;
    return '[-] ' + n(1, 0) + ' - - - | ' + JSON.stringify(entry.memo ? text + ' · ' + entry.memo : text);
  });
}

// Guitar Pro 경로 테스트는 읽은 모델이나 글을 고치는 예제(editsModel)를 뺀다.
const TEX_ONLY = EXAMPLES.filter(function(example){ return /\.tex$/.test(example.file) && !example.editsModel; });

function loadExample(toolModule, example){
  const file = example.file;
  const full = path.join(FIXTURES, file);
  if (/\.tex$/.test(file)){
    let text = fs.readFileSync(full, 'utf8');
    if (example.transformText) text = example.transformText(text);
    const score = toolModule.parseAlphaTex(text);
    if (example.edit) example.edit(score);
    return score;
  }
  return toolModule.parseScoreBytes(fs.readFileSync(full));
}

// 예제 하나의 기대와 어긋난 곳의 목록
function exampleFailures(toolModule, example, score){
  const failures = [];
  const result = toolModule.convertScore(score || loadExample(toolModule, example), { sourceName: example.file, fallbackTitle: path.basename(example.file, path.extname(example.file)) });
  const label = example.file;
  if (!result.ok) return [label + ': 변환 실패 ' + result.error];
  if (result.title !== example.title) failures.push(label + ': 제목 ' + result.title);
  if (result.beats !== example.beats) failures.push(label + ': 칸 수 ' + result.beats + ' (기대 ' + example.beats + ')');
  if (result.bpm !== example.bpm) failures.push(label + ': BPM ' + result.bpm + ' (기대 ' + example.bpm + ')');
  if (result.capo !== example.capo) failures.push(label + ': 카포 ' + result.capo);
  if (parser.getSongCapo({ title: result.title, badge: result.description }) !== example.capo) failures.push(label + ': 설명 열 카포 표기');
  if (result.description.indexOf(SOURCE_MEMO + example.file + ' · alphaTab 변환') !== 0) failures.push(label + ': 설명 머리 ' + result.description);
  example.descriptionHas.forEach(function(text){
    if (result.description.indexOf(text) < 0) failures.push(label + ': 설명에 ' + text + ' 없음 (' + result.description + ')');
  });
  if (JSON.stringify(result.measures) !== JSON.stringify(example.measures)){
    failures.push(label + ': 마디\n      기대 ' + example.measures.join('\n           ') + '\n      결과 ' + result.measures.join('\n           '));
  }
  if (result.errors.length) failures.push(label + ': 검사 오류 ' + result.errors.map(function(error){ return error.code; }).join(','));
  return failures;
}

function allExampleFailures(toolModule){
  return EXAMPLES.flatMap(function(example){ return exampleFailures(toolModule, example); });
}

// ---------- 일부러 어긋난 사본

// 도구 소스의 한 줄을 바꾼 사본을 불러온다. 바꿀 자리가 없으면 테스트 자체가 틀린 것이다.
function loadMutant(from, to, targetPath){
  const target = targetPath || TOOL_PATH;
  const source = fs.readFileSync(target, 'utf8');
  assert.equal(source.split(from).length - 1, 1, '사본을 만들 자리가 하나여야 합니다: ' + from);
  const filename = path.join(path.dirname(target), path.basename(target, '.js') + '.mutant.js');
  const mutant = new Module(filename, module);
  mutant.filename = filename;
  mutant.paths = Module._nodeModulePaths(path.dirname(filename));
  mutant._compile(source.replace(from, to), filename);
  return mutant.exports;
}

// ---------- 테스트

test('round trip: every built-in song survives score -> alphaTex -> alphaTab -> score', function(){
  assert.ok(songs.length >= 20, '내장곡 수');
  const failures = roundTripFailures(tool);
  if (failures.length){
    process.stdout.write('왕복에서 다른 곳 ' + failures.length + '건 (곡 ' + songs.length + '개 중)\n    ' + failures.join('\n    ') + '\n');
  }
  assert.deepEqual(failures, []);
  process.stdout.write('  round trip songs: ' + songs.length + ', mismatches: 0\n');
});

test('branch alphaTex songs: convert without errors and keep the bar count (unsupported meters are refused with a reason)', function(){
  const list = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'branch-builtins.json'), 'utf8'));
  assert.equal(list.length, 16);
  // 이 목록은 도구와 따로 적은 지원 박자표다(Docs/alphatab.md 표).
  const supported = ['2/4', '3/4', '4/4', '2/2', '3/8', '6/8', '9/8', '12/8'];
  let converted = 0;
  const refused = [];
  list.forEach(function(entry){
    const score = importCleanTex(entry.alphaTex, entry.id);
    const first = score.masterBars[0];
    const meter = first.timeSignatureNumerator + '/' + first.timeSignatureDenominator;
    const result = tool.convertScore(score, { sourceName: entry.id + '.tex' });
    if (supported.indexOf(meter) < 0){
      assert.equal(result.ok, false, entry.id + ' ' + meter + ' 은 변환하지 않습니다');
      assert.match(result.error, /표에 없는 박자/, entry.id);
      refused.push(entry.id + ' ' + meter);
      return;
    }
    assert.equal(result.ok, true, entry.id + ': ' + result.error);
    assert.equal(result.errors.length, 0, entry.id + ' 검사 오류 ' + (result.errors[0] && result.errors[0].message));
    assert.equal(result.measures.length, score.masterBars.length, entry.id + ' 마디 수');
    assert.ok(notation.SHEET_BEAT_COUNTS.indexOf(result.beats) >= 0, entry.id + ' 칸 수');
    converted++;
  });
  assert.equal(converted + refused.length, list.length);
  assert.ok(converted >= 10, '변환된 곡 수');
  process.stdout.write('  branch songs: ' + converted + ' converted, refused: ' + (refused.join(', ') || 'none') + '\n');
});

test('hand-written alphaTex examples read with zero alphaTab diagnostics', function(){
  fs.readdirSync(FIXTURES).filter(function(file){ return /\.tex$/.test(file); }).forEach(function(file){
    importCleanTex(readFixture(file), file);
  });
});

test('hand-written examples convert to the expected score lines', function(){
  const failures = EXAMPLES.flatMap(function(example){ return exampleFailures(tool, example); });
  if (failures.length) process.stdout.write(failures.join('\n') + '\n');
  assert.deepEqual(failures, []);
});

test('Guitar Pro path: the same examples come out of a .gp written by alphaTab', function(){
  let count = 0;
  TEX_ONLY.forEach(function(example){
    const direct = importCleanTex(readFixture(example.file), example.file);
    const bytes = new alphaTab.exporter.Gp7Exporter().export(direct);
    const viaGp = tool.parseScoreBytes(bytes);
    assert.deepEqual(exampleFailures(tool, example, viaGp), [], example.file + ' (.gp 경유)');
    count++;
  });
  assert.equal(count, TEX_ONLY.length);
});

test('MusicXML path: parts with staff tuning keep their strings, parts without strings (simple, no-strings) convert by pitch', function(){
  ['guitar.musicxml', 'simple.musicxml', 'no-strings.musicxml'].forEach(function(file){
    const example = EXAMPLES.find(function(entry){ return entry.file === file; });
    assert.deepEqual(exampleFailures(tool, example), [], file);
  });
  // 줄 정보 없는 결과에는 @줄이 하나도 없고, 앱 검사를 오류 없이 통과한다
  const noStrings = tool.convertScore(tool.parseScoreBytes(fs.readFileSync(path.join(FIXTURES, 'no-strings.musicxml'))), { sourceName: 'no-strings.musicxml' });
  noStrings.measures.forEach(function(line){ assert.doesNotMatch(line.split('|')[0], /@/); });
  assert.equal(noStrings.errors.length, 0);
});

test('rest start: a note that ends inside a cell with nothing else sounding splits the cell, a sustained bass does not', function(){
  const out = convertTex('\\title "R" \\tempo 80 \\ts (4 4)\n0.1.8 r.8 0.2.4 0.3.8 r.8 0.4.4 |\n');
  assert.equal(out.ok, true);
  assert.deepEqual(out.measures, ['[-] ' + [n(1, 0) + '/r', n(2, 0), n(3, 0) + '/r', n(4, 0)].join(' ')]);
  const held = convertTex('\\title "H" \\tempo 80 \\ts (4 4)\n\\track "Guitar" \\staff {tabs} \\tuning (E4 B3 G3 D3 A2 E2)\n\\voice\n0.6.1 |\n\\voice\n:8 0.1 r 0.2 r 0.3 r 0.4 r |\n');
  assert.equal(held.ok, true);
  assert.deepEqual(held.measures, ['[-] ' + [n(6, 0) + '+' + n(1, 0), n(2, 0), n(3, 0), n(4, 0)].join(' ')]);
  assert.match(held.description, /긴 음은 시작만 적음/);
});

test('refusals: unsupported meter, non-standard tuning, meter change, non-guitar track, bad track number', function(){
  const five = tool.convertScore(importCleanTex(readFixture('five-four.tex'), 'five-four'), {});
  assert.equal(five.ok, false);
  assert.match(five.error, /표에 없는 박자입니다: 5\/4/);
  const dropD = tool.convertScore(importCleanTex(readFixture('drop-d.tex'), 'drop-d'), {});
  assert.equal(dropD.ok, false);
  assert.match(dropD.error, /표준 조율/);
  const change = tool.convertScore(importCleanTex('\\title "C" \\tempo 100 \\ts (4 4)\n0.1.1 | \\ts (5 4) 0.1.1 0.1.4 |\n', 'change'), {});
  assert.equal(change.ok, false);
  assert.match(change.error, /박자표가 바뀝니다/);
  const bass = tool.convertScore(importCleanTex('\\title "B" \\tempo 100 \\ts (4 4)\n\\track "Bass" \\staff {tabs} \\tuning (G2 D2 A1 E1)\n0.4.1 |\n', 'bass'), {});
  assert.equal(bass.ok, false);
  assert.match(bass.error, /기타로 읽을 트랙이 없습니다/);
  const empty = tool.convertScore(null, {});
  assert.equal(empty.ok, false);
  [five, dropD, change, bass].forEach(function(result){ assert.match(result.error, /\S/); });
});

test('track choice: tracks count from 1, default is the first standard 6-string track, --track picks another, a bass track is refused', function(){
  const score = importCleanTex(readFixture('two-tracks.tex'), 'two-tracks');
  const first = tool.convertScore(score, { sourceName: 'two-tracks.tex' });
  assert.equal(first.ok, true);
  assert.equal(first.trackNumber, 2);
  assert.deepEqual(first.measures, ['[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' ')]);
  const second = tool.convertScore(score, { sourceName: 'two-tracks.tex', trackNumber: 3 });
  assert.equal(second.ok, true);
  assert.equal(second.trackNumber, 3);
  assert.deepEqual(second.measures, ['[-] ' + n(6, 0) + ' - - -']);
  const bass = tool.convertScore(score, { trackNumber: 1 });
  assert.equal(bass.ok, false);
  assert.match(bass.error, /트랙 1번은 6줄 기타가 아닙니다/);
  assert.match(bass.error, /1: Bass · 4줄/);
  assert.match(bass.error, /2: Guitar · 6줄/);
  const missing = tool.convertScore(score, { trackNumber: 9 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /트랙 9번이 없습니다/);
  // 6줄 표준 조율 트랙이 앞서고, 표준이 아닌 6줄 트랙만 있으면 줄 정보 없는 트랙으로 넘어가지 않고 거절한다
  const mixed = tool.convertScore(importCleanTex(readFixture('drop-d.tex'), 'drop-d'), { trackNumber: 1 });
  assert.equal(mixed.ok, false);
  assert.match(mixed.error, /표준 조율/);
});

test('tempo and meter: fast 6/8 switches to dotted-quarter cells, BPM is clamped and the original value is noted', function(){
  const fast = convertTex('\\title "F" \\tempo 130 \\ts (6 8)\n0.1.8 1.1.8 3.1.8 0.2.8 1.2.8 3.2.8 |\n');
  assert.equal(fast.ok, true);
  assert.equal(fast.beats, 2);
  assert.equal(fast.bpm, Math.round(130 / 1.5));
  assert.deepEqual(fast.measures, ['[-] ' + [n(1, 0) + '/' + n(1, 1) + '/' + n(1, 3), n(2, 0) + '/' + n(2, 1) + '/' + n(2, 3)].join(' ')]);
  const slow = convertTex('\\title "S" \\tempo 60 \\ts (6 8)\n0.1.8 1.1.8 3.1.8 0.2.8 1.2.8 3.2.8 |\n');
  assert.equal(slow.beats, 6);
  assert.equal(slow.bpm, 60 * 2);

  const high = convertTex('\\title "H" \\tempo 300 \\ts (4 4)\n0.1.4 0.2.4 0.3.4 0.4.4 |\n');
  assert.equal(high.bpm, 240);
  assert.match(high.description, /BPM 자름\(원래 값 300\)/);
  const low = convertTex('\\title "L" \\tempo 20 \\ts (4 4)\n0.1.4 0.2.4 0.3.4 0.4.4 |\n');
  assert.equal(low.bpm, 30);
  assert.match(low.description, /BPM 자름\(원래 값 20\)/);
});

test('off-grid rhythm: a 5-tuplet is moved to the nearest position with ? and a note', function(){
  const out = convertTex('\\title "Q" \\tempo 80 \\ts (4 4)\n0.1.8 {tu 5} 1.1.8 {tu 5} 3.1.8 {tu 5} 0.2.8 {tu 5} 1.2.8 {tu 5} 0.3.4 0.4.4 |\n');
  assert.equal(out.ok, true);
  assert.deepEqual(out.measures, ['[-] ' + [
    n(1, 0) + '/-/' + n(1, 1) + '?/' + n(1, 3) + '?',
    '-/' + n(2, 0) + '?/' + n(2, 1) + '?/-',
    n(3, 0),
    n(4, 0)
  ].join(' ') + ' | "칸 분할에 맞지 않는 리듬 → 가까운 자리"']);
  assert.equal(out.errors.length, 0);
});

test('chord names: first chord in the bar, unsupported names become [-] with a note, later changes become measure-head multi-chords, padding is removed', function(){
  const out = convertTex('\\title "Ch" \\tempo 80 \\ts (4 4)\n0.1.4 {ch "Am"} 0.2.4 0.3.4 {ch "G7"} 0.4.4 |\n0.1.4 {ch "N.C."} 0.2.4 0.3.4 0.4.4 |\n');
  assert.equal(out.ok, true);
  assert.equal(out.measures[0], '[Am, 3:G7] ' + [n(1, 0), n(2, 0), n(3, 0), n(4, 0)].join(' '));
  assert.equal(out.measures[1], '[-] ' + [n(1, 0), n(2, 0), n(3, 0), n(4, 0)].join(' ') + ' | "코드 이름 변환 불가: N.C."');
  const forward = converter.toAlphaTex({ title: 'P', beats: 4, bpm: 60, capo: 0, lines: ['[CM7] E4 r r r', '[Cm7] E4 r r r'] });
  const back = tool.convertScore(importCleanTex(forward.tex, 'pad'), {});
  assert.deepEqual(back.measures.map(function(line){ return line.split(' ')[0]; }), ['[CM7]', '[Cm7]']);
  assert.equal(back.measures[1].indexOf(converter.CHORD_NAME_PAD), -1);
});

test('chord names: a bar without a chord takes the chord that sounded at the end of the previous bar in play order, with no memo', function(){
  const bar = function(chords){
    const beats = ['0.1.4', '0.2.4', '0.3.4', '0.4.4'];
    Object.keys(chords).forEach(function(index){ beats[index] += ' {ch "' + chords[index] + '"}'; });
    return beats.join(' ') + ' |\n';
  };
  const out = convertTex('\\title "Carry" \\tempo 80 \\ts (4 4)\n' + bar({}) + bar({ 0: 'Am' }) + bar({}) + bar({ 0: 'C', 2: 'G7' }) + bar({}) + bar({}) + bar({ 0: 'N.C.' }) + bar({}));
  assert.equal(out.ok, true);
  const heads = out.measures.map(function(line){ const m = line.match(/^\[([^\]]*)\]/); return m ? m[1] : ''; });
  assert.deepEqual(heads, ['-', 'Am', 'Am', 'C, 3:G7', 'G7', 'G7', '-', '-']);
  assert.doesNotMatch(out.measures[2], /\|/, 'a carried chord has no memo');
  assert.doesNotMatch(out.measures[3], /3박부터 G7/, 'a change inside the bar is in measure head, not in memo');
  assert.doesNotMatch(out.measures[3], /\|/);
  assert.doesNotMatch(out.measures[4], /\|/);
  assert.match(out.measures[6], /코드 이름 변환 불가: N\.C\./);
  assert.doesNotMatch(out.measures[7], /\|/, 'an unusable carried name leaves [-] with no memo');
});

test('slur pairs: a {slur} destination gets s, also on string-less notes; a default string the app would reject drops the s with a memo', function(){
  const head = '\\title "S" \\tempo 80 \\ts (4 4)\n';
  const tabs = '\\track "G" \\staff {tabs} \\tuning (E4 B3 G3 D3 A2 E2)\n';
  const firstLine = function(out){ assert.equal(out.ok, true); assert.deepEqual(out.errors, []); return out.measures[0]; };
  // 음이름 음: 기본 줄이 같으면 s, 같은 음높이 짝은 주법 없이 메모도 없다.
  const named = firstLine(convertTex(head + 'A3{slur s1}.16 G3{slur s1}.16 r.8 C4{slur s2}.8 D4{slur s2}.8 r.2 |'));
  assert.equal(named, '[-] A3/sG3/r/r C4/sD4 r r');
  const same = firstLine(convertTex(head + 'C4{slur s1}.16 C4{slur s1}.16 r.8 r.2 r.4 |'));
  assert.equal(same, '[-] C4/C4/r/r r r r');
  // 기본 줄이 갈리는 짝(D4 는 2번 줄, E4 는 1번 줄)은 s 를 빼고 그 마디 메모를 남긴다. 파서가 같은 쌍에 INVALID_SLUR 를 내는 것도 같이 확인한다.
  assert.ok(parser.validateScore('[-] D4 sE4 r r', 4).errors.some(function(error){ return error.code === 'INVALID_SLUR'; }));
  const split = firstLine(convertTex(head + 'D4{slur s1}.16 E4{slur s1}.16 r.8 r.2 r.4 |'));
  assert.equal(split, '[-] D4/E4/r/r r r r | "줄 정보 없음: 슬러 생략"');
  // 프렛.줄 음: 같은 줄이면 s, 다른 줄이면 s 없이 메모.
  const sameString = firstLine(convertTex(head + tabs + '\\voice\n3.2{slur s1}.4 5.2{slur s1}.4 r.2 |'));
  assert.equal(sameString, '[-] ' + [n(2, 3), 's' + n(2, 5), 'r', 'r'].join(' '));
  const otherString = firstLine(convertTex(head + tabs + '\\voice\n3.3{slur s1}.4 5.2{slur s1}.4 r.2 |'));
  assert.equal(otherString, '[-] ' + [n(3, 3), n(2, 5), 'r', 'r'].join(' ') + ' | "다른 줄 슬러 생략"');
});

test('chord names: a name missing from the chord dictionary is rewritten (parentheses stripped, 7(9) to 9) with an original memo; carried bars keep the rewritten name without a memo', function(){
  const bar = function(chord){
    const beats = ['0.1.4', '0.2.4', '0.3.4', '0.4.4'];
    if (chord) beats[0] += ' {ch "' + chord + '"}';
    return beats.join(' ') + ' |\n';
  };
  const out = convertTex('\\title "Norm" \\tempo 80 \\ts (4 4)\n' + bar('F7(b5)') + bar() + bar('Am7(9)') + bar('Am') + bar('C7(9)') + bar() + bar('F#m7(b5)'));
  assert.equal(out.ok, true);
  const cells = ' ' + [n(1, 0), n(2, 0), n(3, 0), n(4, 0)].join(' ');
  assert.deepEqual(out.measures, [
    '[F7b5]' + cells + ' | "원본 F7(b5)"',
    '[F7b5]' + cells,
    '[Am9]' + cells + ' | "원본 Am7(9)"',
    '[Am]' + cells,
    '[C7(9)]' + cells,
    '[C7(9)]' + cells,
    '[F#m7b5]' + cells + ' | "원본 F#m7(b5)"'
  ]);
  const mid = convertTex('\\title "Mid" \\tempo 80 \\ts (4 4)\n0.1.4 {ch "F7(b5)"} 0.2.4 0.3.4 {ch "Am7(9)"} 0.4.4 |\n');
  assert.ok(mid.measures[0].startsWith('[F7b5, 3:Am9] '));
  assert.match(mid.measures[0], /"원본 F7\(b5\) · 원본 Am7\(9\)"$/, 'a change inside the bar keeps the original names');
});

test('display transpose: \\displaytranspose 12 on a named-note song changes only the drawing height, not the converted result', function(){
  const body = 'C4.4 E4.4 G4.4 C5.4 |\n';
  const plain = convertTex('\\title "D" \\tempo 80 \\ts (4 4)\n' + body);
  const shifted = convertTex('\\title "D" \\tempo 80 \\ts (4 4)\n\\displaytranspose 12\n' + body);
  assert.equal(shifted.ok, true);
  assert.deepEqual(shifted.measures, plain.measures);
  assert.equal(shifted.description, plain.description);
});

test('voices: the long-note memo is written once in the description when only some bars have it, and never in a bar memo', function(){
  const tex = '\\title "Per Bar" \\tempo 80 \\ts (4 4)\n\\track "Guitar" \\staff {tabs} \\tuning (E4 B3 G3 D3 A2 E2)\n\\voice\n0.6.1 | 0.6.4 0.6.4 0.6.4 0.6.4\n\\voice\n:4 0.1 1.1 3.1 1.1 | :4 0.1 1.1 3.1 1.1\n';
  const out = convertTex(tex);
  assert.equal(out.ok, true);
  assert.equal(out.measures[0], '[-] ' + [n(6, 0) + '+' + n(1, 0), n(1, 1), n(1, 3), n(1, 1)].join(' '));
  assert.equal(out.measures[1], '[-] ' + [n(6, 0) + '+' + n(1, 0), n(6, 0) + '+' + n(1, 1), n(6, 0) + '+' + n(1, 3), n(6, 0) + '+' + n(1, 1)].join(' '));
  // 한 마디라도 해당하면 설명에 한 번만 적고 마디 메모에는 달지 않는다.
  assert.equal(out.description.split('긴 음은 시작만 적음').length - 1, 1);
  out.measures.forEach(function(line){ assert.doesNotMatch(line, /긴 음/); });
  const noOverlap = convertTex('\\title "N" \\tempo 80 \\ts (4 4)\n:4 0.1 1.1 3.1 1.1 | :4 0.1 1.1 3.1 1.1\n');
  assert.equal(noOverlap.ok, true);
  assert.doesNotMatch(noOverlap.description, /긴 음/);
  const whole = tool.convertScore(importCleanTex(readFixture('two-voices.tex'), 'two-voices'), { sourceName: 'two-voices.tex' });
  whole.measures.forEach(function(line){ assert.doesNotMatch(line, /긴 음/); });
  assert.match(whole.description, /긴 음은 시작만 적음/);
});

test('roll across two voices: one note per voice with {ad} gets the roll mark, and so does a roll on one voice only (judged on the merged piece)', function(){
  const head = '\\title "Roll" \\tempo 60 \\ts (4 4)\n\\track "Guitar" \\staff {tabs} \\tuning (E4 B3 G3 D3 A2 E2)\n';
  const firstCell = function(out){ return out.measures[0].split(' | ')[0].replace(/^\[-\] /, '').split(' ')[0]; };
  const chord = [n(6, 0), n(1, 4)].join('+');
  const both = convertTex(head + '\\voice\n4.1.1 {ad}\n\\voice\n0.6.1 {ad}\n');
  assert.equal(both.ok, true);
  assert.equal(firstCell(both), '~' + chord);
  const oneVoice = convertTex(head + '\\voice\n4.1.1 {ad}\n\\voice\n0.6.1\n');
  assert.equal(oneVoice.ok, true);
  assert.equal(firstCell(oneVoice), '~' + chord);
  const plain = convertTex(head + '\\voice\n4.1.1\n\\voice\n0.6.1\n');
  assert.equal(firstCell(plain), chord);
  const single = convertTex(head + '\\voice\n4.1.1 {ad}\n');
  assert.equal(firstCell(single), n(1, 4));
});

test('harmonics and effects: a fret outside the natural-harmonic table stays a plain note with a note, bends are noted once per bar', function(){
  const out = convertTex('\\title "E" \\tempo 80 \\ts (4 4)\n9.1{nh}.4 3.1{b (0 4)}.4 3.2{b (0 4)}.4 r.4 |\n');
  assert.equal(out.ok, true);
  assert.equal(out.measures[0], '[-] ' + [n(1, 9), n(1, 3), n(2, 3), 'r'].join(' ') + ' | "하모닉스 프렛 아님 · 벤딩"');
});

test('command lines: score-to-alphatex and alphatab-to-score run as processes', function(){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-alphatab-tools-'));
  try {
    function run(script, args){
      const result = childProcess.spawnSync(process.execPath, [script].concat(args), { encoding: 'utf8' });
      return { code: result.status, out: result.stdout, err: result.stderr };
    }
    const song = songs[0];
    const tsvPath = path.join(dir, 'one.tsv');
    const tsvLine = [song.title, song.beats, song.bpm, song.badge, song.lines.join(' // ')].join('\t');
    fs.writeFileSync(tsvPath, tsvLine + '\n', 'utf8');

    // 우리 악보 -> alphaTex
    const toTex = run(FORWARD_PATH, [tsvPath]);
    assert.equal(toTex.code, 0, toTex.err);
    const expectedTex = converter.toAlphaTex({ title: song.title, beats: song.beats, bpm: song.bpm, capo: 0, description: song.badge, lines: song.lines }).tex;
    assert.match(expectedTex, /\\notices /, 'the sheet description goes into \\notices');
    assert.equal(toTex.out, expectedTex);
    importCleanTex(toTex.out, 'score-to-alphatex stdout');
    const texPath = path.join(dir, 'one.tex');
    const toFile = run(FORWARD_PATH, [tsvPath, '-o', texPath]);
    assert.equal(toFile.code, 0, toFile.err);
    assert.equal(toFile.out, '');
    assert.equal(fs.readFileSync(texPath, 'utf8'), expectedTex);
    const builtin = run(FORWARD_PATH, ['--builtin', song.id]);
    assert.equal(builtin.code, 0, builtin.err);
    assert.equal(builtin.out, expectedTex);
    assert.equal(run(FORWARD_PATH, []).code, 2);
    assert.equal(run(FORWARD_PATH, ['--builtin']).code, 2);
    assert.equal(run(FORWARD_PATH, ['--builtin', 'no-such-song']).code, 2);
    assert.equal(run(FORWARD_PATH, [path.join(dir, 'missing.tsv')]).code, 2);
    assert.equal(run(FORWARD_PATH, [tsvPath, '--nope']).code, 2);
    const badPath = path.join(dir, 'bad.tsv');
    fs.writeFileSync(badPath, '시험곡\t4\t60\t설명\t[-] X9 r r r\n', 'utf8');
    const bad = run(FORWARD_PATH, [badPath]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /UNKNOWN_NOTE/);
    assert.match(bad.err, /니다/);

    // alphaTex 파일 -> 시트 한 행
    const toScore = run(TOOL_PATH, [texPath]);
    assert.equal(toScore.code, 0, toScore.err);
    const rows = toScore.out.split('\n').filter(Boolean);
    assert.equal(rows.length, 1);
    const cols = rows[0].split('\t');
    assert.equal(cols.length, 5);
    assert.equal(cols[0], song.title);
    assert.equal(cols[1], String(song.beats));
    assert.equal(cols[2], String(song.bpm));
    assert.equal(parser.splitScoreMeasures(cols[4]).length, song.lines.length);
    const tsvOut = path.join(dir, 'back.tsv');
    const toTsv = run(TOOL_PATH, [texPath, '-o', tsvOut]);
    assert.equal(toTsv.code, 0, toTsv.err);
    assert.equal(fs.readFileSync(tsvOut, 'utf8').trim(), rows[0]);
    // 만든 TSV 는 check-score 를 통과한다
    const checked = run(path.join(__dirname, '../tools/check-score.js'), [tsvOut]);
    assert.equal(checked.code, 0, checked.out);
    // 되돌린 alphaTex 가 다시 읽힌다
    assert.equal(run(FORWARD_PATH, [tsvOut]).code, 0);

    // Guitar Pro 파일과 MusicXML, --track
    const gpPath = path.join(dir, 'techniques.gp');
    fs.writeFileSync(gpPath, new alphaTab.exporter.Gp7Exporter().export(importCleanTex(readFixture('techniques.tex'), 'techniques')));
    const fromGp = run(TOOL_PATH, [gpPath]);
    assert.equal(fromGp.code, 0, fromGp.err);
    assert.equal(fromGp.out.split('\t')[0], 'Techniques');
    assert.match(fromGp.out.split('\t')[3], /^원본: techniques\.gp · alphaTab 변환/);
    const fromXml = run(TOOL_PATH, [path.join(FIXTURES, 'guitar.musicxml')]);
    assert.equal(fromXml.code, 0, fromXml.err);
    assert.equal(fromXml.out.split('\t').length, 5);
    const noStrings = run(TOOL_PATH, [path.join(FIXTURES, 'no-strings.musicxml')]);
    assert.equal(noStrings.code, 0, noStrings.err);
    assert.equal(noStrings.out.split('\t').length, 5);
    assert.match(noStrings.out.split('\t')[3], /줄 정보 없음\(기본 위치\)/);
    const simpleXml = run(TOOL_PATH, [path.join(FIXTURES, 'simple.musicxml')]);
    assert.equal(simpleXml.code, 0, simpleXml.err);
    assert.equal(simpleXml.out.split('\t')[0], 'simple');
    const track = run(TOOL_PATH, [path.join(FIXTURES, 'two-tracks.tex'), '--track', '3']);
    assert.equal(track.code, 0, track.err);
    assert.match(track.out, new RegExp(n(6, 0) + ' - - -'));

    // 변환하지 않는 것과 사용법
    const five = run(TOOL_PATH, [path.join(FIXTURES, 'five-four.tex')]);
    assert.equal(five.code, 1);
    assert.equal(five.out, '');
    assert.match(five.err, /표에 없는 박자/);
    assert.equal(run(TOOL_PATH, [path.join(FIXTURES, 'drop-d.tex')]).code, 1);
    const bassTrack = run(TOOL_PATH, [path.join(FIXTURES, 'two-tracks.tex'), '--track', '1']);
    assert.equal(bassTrack.code, 1);
    assert.match(bassTrack.err, /1: Bass/);
    assert.equal(run(TOOL_PATH, []).code, 2);
    assert.equal(run(TOOL_PATH, [texPath, '--track']).code, 2);
    assert.equal(run(TOOL_PATH, [texPath, '--track', 'x']).code, 2);
    assert.equal(run(TOOL_PATH, [texPath, '--track', '0']).code, 2);
    assert.equal(run(TOOL_PATH, [texPath, '--nope']).code, 2);
    assert.equal(run(TOOL_PATH, [path.join(dir, 'none.tex')]).code, 2);
    assert.equal(run(TOOL_PATH, [path.join(dir, 'one.txt')]).code, 2);
    const brokenPath = path.join(dir, 'broken.tex');
    fs.writeFileSync(brokenPath, '\\title "x"\n!!! nonsense\n', 'utf8');
    const broken = run(TOOL_PATH, [brokenPath]);
    assert.equal(broken.code, 1);
    assert.match(broken.err, /alphaTex를 읽지 못했습니다/);

    // 악보 검사에 걸리면 출력은 쓰되 종료 코드 1과 오류 목록
    const rangePath = path.join(dir, 'range.tex');
    // 같은 줄의 다른 프렛 화음은 STRING_COLLISION 이다(프렛 20 이상은 이제 오류가 아니라 줄 지정을 뗀 음이 된다).
    fs.writeFileSync(rangePath, '\\title "Range" \\tempo 80 \\ts (4 4)\n(0.1 1.1).4 0.2.4 0.3.4 0.4.4 |\n', 'utf8');
    const range = run(TOOL_PATH, [rangePath]);
    assert.equal(range.code, 1);
    assert.equal(range.out.split('\t').length, 5);
    assert.match(range.err, /STRING_COLLISION/);
    const rangeOut = path.join(dir, 'range.tsv');
    const rangeFile = run(TOOL_PATH, [rangePath, '-o', rangeOut]);
    assert.equal(rangeFile.code, 1);
    assert.equal(fs.existsSync(rangeOut), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 메모·설명·build-scores

const FORWARD_SOURCE_PATH = path.join(__dirname, '../src/score-to-alphatex.js');
const ROMANCE = songs.find(function(song){ return song.id === 'builtin-lv5-romance'; });
const BUILD_PATH = path.join(__dirname, '../tools/build-scores.js');
const CHECK_PATH = path.join(__dirname, '../tools/check-score.js');
const buildTool = require(BUILD_PATH);

function runNode(script, args){
  const result = childProcess.spawnSync(process.execPath, [script].concat(args), { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}


test('capo: a \\capo without a capo notation in the title or notices gets " · Capo n" at the end of the description, an existing notation is not doubled', function(){
  const noticesOnly = convertTex('\\title "K" \\notices "시트 설명" \\capo 2 \\tempo 80 \\ts (4 4)\n0.1.4 1.1.4 3.1.4 0.2.4 |\n');
  assert.equal(noticesOnly.ok, true, noticesOnly.error);
  assert.equal(noticesOnly.description, '시트 설명 · Capo 2');
  assert.equal(parser.getSongCapo({ title: noticesOnly.title, badge: noticesOnly.description }), 2, 'the app reads capo 2');
  assert.equal(noticesOnly.capo, 2);
  const inNotices = convertTex('\\title "K" \\notices "카포 2 연습" \\capo 2 \\tempo 80 \\ts (4 4)\n0.1.4 1.1.4 3.1.4 0.2.4 |\n');
  assert.equal(inNotices.description, '카포 2 연습', 'the notation already in notices is not repeated');
  const inTitle = convertTex('\\title "K (Capo 2)" \\notices "시트 설명" \\capo 2 \\tempo 80 \\ts (4 4)\n0.1.4 1.1.4 3.1.4 0.2.4 |\n');
  assert.equal(inTitle.description, '시트 설명', 'the notation in the title is enough');
  const noNotices = convertTex('\\title "K" \\capo 2 \\tempo 80 \\ts (4 4)\n0.1.4 1.1.4 3.1.4 0.2.4 |\n');
  assert.equal((noNotices.description.match(/Capo 2/g) || []).length, 1, 'without notices the usual "Capo n" is not doubled');
  const noCapo = convertTex('\\title "K" \\notices "시트 설명" \\tempo 80 \\ts (4 4)\n0.1.4 1.1.4 3.1.4 0.2.4 |\n');
  assert.equal(noCapo.description, '시트 설명');
});

test('memo and description: txt becomes the bar memo (before the approximation notes), notices becomes the description column', function(){
  const withText = '\\title "M" \\notices "설명 · 문구" \\tempo 80 \\ts (4 4)\n0.1.4 {txt "첫째 메모"} 1.1.4 3.1.4 {txt "둘째"} 0.2.4 |\n0.1.4 1.1.4 3.1.4 0.2.4 |\n';
  const out = convertTex(withText);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.description, '설명 · 문구', 'notices is the description as it is');
  assert.equal(out.measures[0], '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' ') + ' | "첫째 메모 · 둘째"');
  assert.equal(out.measures[1], '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' '));
  // 변환기가 만드는 근사 메모는 박의 글 뒤에 붙고, 곡 전체 근사 메모는 설명 notices 뒤에 붙는다
  const approx = convertTex('\\title "M" \\notices "설명" \\tempo 300 \\ts (4 4)\n0.1.4 {txt "글"} 1.1.4 3.1.4 x.2.4 |\n');
  assert.equal(approx.ok, true, approx.error);
  assert.match(approx.measures[0], / \| "글 · 데드 노트 생략"$/);
  assert.equal(approx.description, '설명 · BPM 자름(원래 값 300)');
  assert.doesNotMatch(approx.description, /원본:/);
  const without = convertTex('\\title "M" \\tempo 80 \\ts (4 4)\n0.1.4 1.1.4 3.1.4 0.2.4 |\n');
  assert.match(without.description, /^원본: inline\.tex · alphaTab 변환/, 'no notices keeps the source-file description');
});

test('build-scores: flattening keeps strings and refuses a line break inside one', function(){
  assert.equal(buildTool.flattenAlphaTex('\\title "a  b"\n\t\\tempo   80 \r\n 0.1.4   |\n').text, '\\title "a  b" \\tempo 80 0.1.4 |');
  assert.equal(buildTool.flattenAlphaTex("\\title 'x  y'\n0.1.4 |").text, "\\title 'x  y' 0.1.4 |");
  assert.equal(buildTool.flattenAlphaTex('\\title "q \\" r"\n0.1.4 |').text, '\\title "q \\" r" 0.1.4 |');
  assert.match(buildTool.flattenAlphaTex('\\title "a\nb"\n0.1.4 |').error, /문자열 안에 줄바꿈/);
  assert.match(buildTool.flattenAlphaTex('\\title "a\tb"\n0.1.4 |').error, /문자열 안에 줄바꿈이나 탭/);
  assert.match(buildTool.flattenAlphaTex('\\title "open\n').error, /문자열 안에 줄바꿈|닫히지 않은/);
});

test('build-scores: writes 6-column TSV with BOM, keeps TSV files without .tex, does not write files with errors, --check only reports', function(){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-build-scores-'));
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-build-scores-check-'));
  try {
    const romanceForward = converter.toAlphaTex({ title: ROMANCE.title, beats: ROMANCE.beats, bpm: ROMANCE.bpm, capo: 0, description: ROMANCE.badge, lines: ROMANCE.lines });
    // 줄바꿈·탭·연속 공백을 섞은 원본을 일부러 쓴다
    const messy = romanceForward.tex.replace(/ \\tempo/, '\n\n\t\\tempo').replace(/\n/g, '\r\n') + '\n\n';
    fs.writeFileSync(path.join(dir, 'romance.tex'), messy, 'utf8');
    fs.writeFileSync(path.join(dir, 'romance.tsv'), 'OLD\n', 'utf8');
    fs.copyFileSync(path.join(FIXTURES, 'techniques.tex'), path.join(dir, 'techniques.tex'));
    fs.writeFileSync(path.join(dir, 'broken.tex'), '\\title "x"\n!!! nonsense\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'broken.tsv'), 'KEEP-BROKEN\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'newline.tex'), '\\title "a\nb" \\tempo 80 \\ts (4 4)\n0.1.4 1.1.4 3.1.4 0.2.4 |\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'hand.tsv'), 'HAND-MADE\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.copyFileSync(path.join(FIXTURES, 'triplet.tex'), path.join(dir, 'sub', 'triplet.tex'));

    // --check: 아무것도 쓰지 않고 보고만
    const checkRun = runNode(BUILD_PATH, [dir, '--check']);
    assert.equal(checkRun.code, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'romance.tsv'), 'utf8'), 'OLD\n', '--check does not write');
    assert.equal(fs.existsSync(path.join(dir, 'techniques.tsv')), false, '--check does not create TSV files');
    assert.match(checkRun.out.trimEnd().split('\n').pop(), /^변환 2 · 오류 2 · 건너뜀 1$/);

    const run = runNode(BUILD_PATH, [dir]);
    assert.equal(run.code, 1, run.out + run.err);
    assert.equal(run.out.trimEnd().split('\n').pop(), '변환 2 · 오류 2 · 건너뜀 1', run.out);
    assert.match(run.err, /오류: broken\.tex/);
    assert.match(run.err, /오류: newline\.tex[\s\S]*문자열 안에 줄바꿈/);
    assert.doesNotMatch(run.err + run.out, /triplet/, 'subfolders are not read');
    assert.equal(fs.readFileSync(path.join(dir, 'broken.tsv'), 'utf8'), 'KEEP-BROKEN\n', 'a file with errors keeps its old TSV');
    assert.equal(fs.existsSync(path.join(dir, 'newline.tsv')), false, 'a file with errors writes no TSV');
    assert.equal(fs.readFileSync(path.join(dir, 'hand.tsv'), 'utf8'), 'HAND-MADE\n', 'a TSV without .tex is left alone');

    const bytes = fs.readFileSync(path.join(dir, 'romance.tsv'));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM');
    const text = bytes.toString('utf8');
    assert.equal(text.charCodeAt(0), 0xFEFF);
    assert.equal(text.endsWith('\n') && !text.endsWith('\n\n'), true, 'one trailing newline');
    assert.equal(text.slice(1, -1).indexOf('\n'), -1, 'one row');
    const cols = text.slice(1, -1).split('\t');
    assert.equal(cols.length, 6);
    assert.equal(cols[0], ROMANCE.title);
    assert.equal(cols[1], String(ROMANCE.beats));
    assert.equal(cols[2], String(ROMANCE.bpm));
    assert.equal(cols[3], ROMANCE.badge);
    assert.doesNotMatch(cols[4], /(^|[ +/~])!/, 'apoyando marks do not survive alphaTex');
    assert.doesNotMatch(cols[5], /[\r\n\t]|  /, 'alphaTex is one line without tabs or repeated spaces');
    assert.equal(cols[5], romanceForward.tex.trimEnd().replace(/\n/g, ' '), 'alphaTex is the file content folded to one line');
    const score = importCleanTex(cols[5], 'tsv alphaTex');
    assert.equal(score.masterBars.length, ROMANCE.lines.length);
    assert.equal(score.notices, ROMANCE.badge);
    const techniquesCols = fs.readFileSync(path.join(dir, 'techniques.tsv'), 'utf8').slice(1).split('\t');
    assert.equal(techniquesCols.length, 6);
    assert.match(techniquesCols[3], /^원본: techniques\.tex · alphaTab 변환/, 'no notices keeps the source-file description');
    const checked = runNode(CHECK_PATH, [path.join(dir, 'romance.tsv')]);
    assert.equal(checked.code, 0, checked.out);

    // 사용법 오류는 2, 오류 없는 폴더는 0 (--check 도 쓰지 않는다)
    assert.equal(runNode(BUILD_PATH, []).code, 2);
    assert.equal(runNode(BUILD_PATH, [path.join(dir, 'missing')]).code, 2);
    assert.equal(runNode(BUILD_PATH, [dir, '--nope']).code, 2);
    fs.writeFileSync(path.join(checkDir, 'one.tex'), romanceForward.tex, 'utf8');
    const clean = runNode(BUILD_PATH, [checkDir, '--check']);
    assert.equal(clean.code, 0, clean.err);
    assert.equal(clean.out.trimEnd().split('\n').pop(), '변환 1 · 오류 0 · 건너뜀 0');
    assert.deepEqual(fs.readdirSync(checkDir), ['one.tex'], '--check leaves the folder as it was');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(checkDir, { recursive: true, force: true });
  }
});

// ---------- Guitar Pro 파일 → alphaTex 원본(.tex) → TSV

const GP_TOOL_PATH = path.join(__dirname, '../tools/gp-to-alphatex.js');
const gpTool = require(GP_TOOL_PATH);
const GP_NAME = '두 트랙.gp';
// 바이트는 이 테스트 안에서 만든다: 예제 two-tracks.tex(Bass 4줄, Guitar, Guitar 2)를 Guitar Pro 7 로 쓴다.
const GP_BYTES = Buffer.from(new alphaTab.exporter.Gp7Exporter().export(importCleanTex(readFixture('two-tracks.tex'), 'two-tracks'), new alphaTab.Settings()));

function convertedColumns(result){
  const columns = result.tsv.split('\t');
  return [columns[1], columns[2], columns[4]];
}

// 한 판을 돌려 어긋난 것을 모은다. 일부러 어긋난 사본에 같은 판을 돌려 걸리는지 보려고 도구 경로를 받는다.
function gpScenarioFailures(buildScript, gpScript){
  const failures = [];
  function expect(ok, message){ if (!ok) failures.push(message); }
  function readTex(file){
    try { return fs.readFileSync(file, 'utf8'); } catch (error) { return null; }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-gp-build-'));
  try {
    // 1) build-scores 가 .tex 와 .tsv 를 만든다
    const buildDir = path.join(root, 'build');
    fs.mkdirSync(buildDir);
    fs.writeFileSync(path.join(buildDir, GP_NAME), GP_BYTES);
    const texPath = path.join(buildDir, '두 트랙.tex');
    const run = runNode(buildScript, [buildDir]);
    expect(run.code === 0, 'build 종료 코드 ' + run.code + ': ' + run.err);
    expect(run.out.indexOf('만듦: 두 트랙.gp → 두 트랙.tex (트랙 2/3 "Guitar")') >= 0, 'build 로그: ' + run.out);
    expect(run.out.trimEnd().split('\n').pop() === '변환 1 · 오류 0 · 건너뜀 0', 'build 마지막 줄: ' + run.out);
    const tex = readTex(texPath);
    expect(tex !== null, '.tex 가 만들어지지 않았습니다');
    let viaTex = null;
    if (tex !== null){
      expect(tex.indexOf('\r') < 0 && tex.charCodeAt(0) !== 0xFEFF, '.tex 는 BOM 없는 LF 여야 합니다');
      expect((tex.match(/\\track/g) || []).length === 1, '\\track 이 하나여야 합니다: ' + (tex.match(/\\track/g) || []).length);
      expect(tex.indexOf('Bass') < 0, '다른 트랙(Bass)이 남았습니다');
      const imported = importTex(tex);
      expect(imported.thrown === null && imported.diagnostics.length === 0, '.tex 읽기 진단: ' + imported.diagnostics.join(' / '));
      if (imported.score){
        const score = imported.score;
        expect(score.title === '두 트랙', '제목: ' + score.title);
        expect(score.notices.indexOf('원제 Two Tracks') >= 0, 'notices 에 원제가 없습니다: ' + score.notices);
        expect(score.notices.indexOf('Guitar Pro 파일(' + GP_NAME + ')에서 변환') >= 0, 'notices 에 변환 문구가 없습니다: ' + score.notices);
        expect(score.tracks.length === 1 && score.tracks[0].name === 'Guitar', '남은 트랙: ' + score.tracks.map(function(track){ return track.name; }).join(','));
        // 2) 뽑은 .tex 를 변환한 결과 == GP 를 --track 2 로 변환한 결과
        viaTex = tool.convertScore(score, { sourceName: '두 트랙.tex', fallbackTitle: '두 트랙' });
      }
    }
    const tsvText = readTex(path.join(buildDir, '두 트랙.tsv'));
    expect(tsvText !== null && tsvText.slice(1, -1).split('\t').length === 6, '.tsv 는 6열이어야 합니다');
    const direct = tool.convertScore(tool.parseScoreBytes(GP_BYTES), { trackNumber: 2, sourceName: GP_NAME, fallbackTitle: '두 트랙' });
    expect(direct.ok === true, 'GP 직접 변환: ' + direct.error);
    if (viaTex && direct.ok){
      expect(viaTex.ok === true, '.tex 변환: ' + viaTex.error);
      if (viaTex.ok) expect(JSON.stringify(convertedColumns(viaTex)) === JSON.stringify(convertedColumns(direct)), '칸 수·BPM·악보 열이 GP 직접 변환과 다릅니다');
    }

    // 3) 같은 이름의 .tex 가 있으면 GP 를 건너뛰고 .tex 는 그대로다
    if (tex !== null){
      const keepDir = path.join(root, 'keep');
      fs.mkdirSync(keepDir);
      fs.writeFileSync(path.join(keepDir, GP_NAME), GP_BYTES);
      const marked = tex.replace('\\title "두 트랙"', '\\title "손본 원본"');
      expect(marked !== tex, '표시 글을 넣을 자리가 없습니다');
      fs.writeFileSync(path.join(keepDir, '두 트랙.tex'), marked, 'utf8');
      // 이미 있는 .tex 에서 만드는 .tsv 는 옛 것을 덮어 다시 쓴다
      fs.writeFileSync(path.join(keepDir, '두 트랙.tsv'), 'OLD\n', 'utf8');
      const keepRun = runNode(buildScript, [keepDir]);
      expect(keepRun.out.indexOf('건너뜀: 두 트랙.gp (.tex 있음)') >= 0, '건너뜀 로그: ' + keepRun.out);
      expect(readTex(path.join(keepDir, '두 트랙.tex')) === marked, '이미 있는 .tex 가 바뀌었습니다');
      expect(keepRun.out.trimEnd().split('\n').pop() === '변환 1 · 오류 0 · 건너뜀 1', '건너뜀 판 마지막 줄: ' + keepRun.out);
      const rewritten = readTex(path.join(keepDir, '두 트랙.tsv'));
      expect(rewritten !== null && rewritten.indexOf('손본 원본') >= 0 && rewritten.indexOf('OLD') < 0, '.tex 에서 만드는 .tsv 는 다시 써야 합니다: ' + rewritten);
    }

    // 3b) .tex 가 없고 손으로 만든 .tsv 만 있으면 .tex 를 만들지 않고 .tsv 도 건드리지 않는다
    const handDir = path.join(root, 'hand');
    fs.mkdirSync(handDir);
    fs.writeFileSync(path.join(handDir, GP_NAME), GP_BYTES);
    fs.writeFileSync(path.join(handDir, '두 트랙.tsv'), 'HAND-MADE\n', 'utf8');
    const handRun = runNode(buildScript, [handDir]);
    expect(handRun.out.indexOf('건너뜀: 두 트랙.gp (손으로 만든 두 트랙.tsv 있음)') >= 0, '손으로 만든 .tsv 건너뜀 로그: ' + handRun.out);
    expect(!fs.existsSync(path.join(handDir, '두 트랙.tex')), '손으로 만든 .tsv 가 있는데 .tex 가 만들어졌습니다');
    expect(readTex(path.join(handDir, '두 트랙.tsv')) === 'HAND-MADE\n', '손으로 만든 .tsv 가 바뀌었습니다');
    expect(handRun.code === 0, '손으로 만든 .tsv 판 종료 코드 ' + handRun.code + ': ' + handRun.err);
    expect(/건너뜀 [1-9]/.test(handRun.out.trimEnd().split('\n').pop()), '건너뜀 수에 더해야 합니다: ' + handRun.out);
    const handCheck = runNode(buildScript, [handDir, '--check']);
    expect(handCheck.out.indexOf('건너뜀: 두 트랙.gp (손으로 만든 두 트랙.tsv 있음)') >= 0 && handCheck.out.indexOf('확인: 두 트랙.gp') < 0, '--check 도 손으로 만든 .tsv 가 있으면 건너뜁니다: ' + handCheck.out);

    // 4) --check 는 새 파일을 만들지 않는다
    const checkDir = path.join(root, 'check');
    fs.mkdirSync(checkDir);
    fs.writeFileSync(path.join(checkDir, GP_NAME), GP_BYTES);
    const checkRun = runNode(buildScript, [checkDir, '--check']);
    expect(checkRun.code === 0, '--check 종료 코드 ' + checkRun.code + ': ' + checkRun.err);
    expect(/확인: 두 트랙\.gp → 트랙 2 \(\d+마디\)/.test(checkRun.out), '--check 로그: ' + checkRun.out);
    expect(JSON.stringify(fs.readdirSync(checkDir)) === JSON.stringify([GP_NAME]), '--check 가 파일을 만들었습니다: ' + fs.readdirSync(checkDir).join(','));

    // 5) gp-to-alphatex 명령줄
    const cliDir = path.join(root, 'cli');
    fs.mkdirSync(cliDir);
    const cliGp = path.join(cliDir, GP_NAME);
    fs.writeFileSync(cliGp, GP_BYTES);
    const cliRun = runNode(gpScript, [cliGp, '--track', '3']);
    expect(cliRun.code === 0, 'CLI 종료 코드 ' + cliRun.code + ': ' + cliRun.err);
    expect(/^만듦: .*두 트랙\.tex \(트랙 3\/3 "Guitar 2"\)/.test(cliRun.out), 'CLI 로그: ' + cliRun.out);
    expect(cliRun.out.indexOf('Bass') >= 0, 'CLI 가 트랙 목록을 찍지 않았습니다');
    const cliTexPath = path.join(cliDir, '두 트랙.tex');
    const cliTex = readTex(cliTexPath);
    expect(cliTex !== null, 'CLI 가 .tex 를 만들지 않았습니다');
    if (cliTex !== null){
      const imported = importTex(cliTex);
      expect(imported.score && imported.score.tracks.length === 1 && imported.score.tracks[0].name === 'Guitar 2', 'CLI 트랙: ' + (imported.score ? imported.score.tracks.map(function(track){ return track.name; }).join(',') : imported.diagnostics.join('/')));
      const again = runNode(gpScript, [cliGp, '--track', '3']);
      expect(again.code === 1, '출력이 있을 때 종료 코드 ' + again.code);
      expect(readTex(cliTexPath) === cliTex, '이미 있는 출력이 바뀌었습니다');
      const other = runNode(gpScript, [cliGp, '-o', cliTexPath]);
      expect(other.code === 1 && readTex(cliTexPath) === cliTex, '-o 로 준 기존 출력도 덮으면 안 됩니다');
    }
    const defaultOut = path.join(cliDir, 'out.tex');
    const defaultRun = runNode(gpScript, [cliGp, '-o', defaultOut]);
    expect(defaultRun.code === 0 && /트랙 2\/3 "Guitar"/.test(defaultRun.out), '기본 트랙은 첫 표준 기타여야 합니다: ' + defaultRun.out + defaultRun.err);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return failures;
}

test('gpToAlphaTex: picks the first standard 6-string track by default, keeps only it, names the title after the file, refuses a bass track', function(){
  const result = gpTool.gpToAlphaTex(GP_BYTES, { fileName: GP_NAME });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.trackNumber, 2);
  assert.equal(result.trackName, 'Guitar');
  assert.equal(result.trackCount, 3);
  assert.match(result.trackList, /1: Bass · 4줄/);
  assert.match(result.trackList, /3: Guitar 2 · 6줄/);
  assert.deepEqual(gpTool.GP_EXTENSIONS, ['.gp', '.gp3', '.gp4', '.gp5', '.gpx']);
  const picked = gpTool.gpToAlphaTex(GP_BYTES, { fileName: GP_NAME, trackNumber: 3 });
  assert.equal(picked.ok, true, picked.error);
  assert.equal(picked.trackName, 'Guitar 2');
  const bass = gpTool.gpToAlphaTex(GP_BYTES, { fileName: GP_NAME, trackNumber: 1 });
  assert.equal(bass.ok, false);
  assert.match(bass.error, /트랙 1번은 6줄 기타가 아닙니다/);
  const missing = gpTool.gpToAlphaTex(GP_BYTES, { fileName: GP_NAME, trackNumber: 9 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /트랙 9번이 없습니다/);
  const broken = gpTool.gpToAlphaTex(Buffer.from('not a score'), { fileName: 'x.gp' });
  assert.equal(broken.ok, false);
  // 파일 안 제목이 파일 이름과 같으면 원제를 남기지 않는다
  const same = gpTool.gpToAlphaTex(GP_BYTES, { fileName: 'Two Tracks.gp' });
  assert.equal(same.ok, true, same.error);
  assert.doesNotMatch(same.tex, /원제/);
  assert.match(same.tex, /Guitar Pro 파일\(Two Tracks\.gp\)에서 변환/);
});

test('Guitar Pro files in build-scores: .tex and .tsv are made from the first guitar track, an existing .tex is kept, --check writes nothing, gp-to-alphatex --track picks another track and never overwrites', function(){
  assert.deepEqual(gpScenarioFailures(BUILD_PATH, GP_TOOL_PATH), []);
  // 도구 자체의 사용법 오류
  assert.equal(runNode(GP_TOOL_PATH, []).code, 2);
  assert.equal(runNode(GP_TOOL_PATH, ['a.txt']).code, 2);
  assert.equal(runNode(GP_TOOL_PATH, [path.join(os.tmpdir(), 'gs-no-such-file.gp')]).code, 2);
  assert.equal(runNode(GP_TOOL_PATH, ['a.gp', '--track', '0']).code, 2);
});

// 일부러 어긋난 사본: tools/ 에 임시 사본을 만들어 같은 판을 돌리고, 걸리는 어긋남이 있어야 한다.
function gpMutantFailures(label, gpReplacement, buildReplacements){
  const created = [];
  function copyOf(source, name, replacements){
    let text = fs.readFileSync(source, 'utf8');
    replacements.forEach(function(pair){
      assert.equal(text.split(pair[0]).length - 1, 1, label + ': 사본을 만들 자리가 하나여야 합니다: ' + pair[0]);
      text = text.replace(pair[0], function(){ return pair[1]; });
    });
    const file = path.join(path.dirname(source), name);
    fs.writeFileSync(file, text, 'utf8');
    created.push(file);
    return file;
  }
  try {
    let gpScript = GP_TOOL_PATH;
    const buildList = buildReplacements.slice();
    if (gpReplacement){
      gpScript = copyOf(GP_TOOL_PATH, 'gp-to-alphatex.mutant.js', [gpReplacement]);
      buildList.push(["require('./gp-to-alphatex.js')", "require('./gp-to-alphatex.mutant.js')"]);
    }
    const buildScript = copyOf(BUILD_PATH, 'build-scores.mutant.js', buildList);
    const caught = gpScenarioFailures(buildScript, gpScript);
    assert.ok(caught.length > 0, label + ' 사본이 검사에 걸리지 않았습니다');
    process.stdout.write('  ' + label + ': caught by ' + caught.length + ' failure(s), e.g. ' + caught[0].split('\n')[0] + '\n');
  } finally {
    created.forEach(function(file){ fs.rmSync(file, { force: true }); });
  }
}

test('mutant (가): not dropping the other tracks is caught', function(){
  gpMutantFailures('other tracks kept', ['score.tracks = [picked.track];', 'void 0;'], []);
});

test('mutant (나): not renaming the title to the file name is caught', function(){
  gpMutantFailures('title kept', ['score.title = title;', 'void 0;'], []);
});

test('mutant (다): overwriting an existing .tex is caught', function(){
  gpMutantFailures('overwrite', null, [['if (texBases.has(base)){', 'if (false){'], ["flag: 'wx'", "flag: 'w'"]]);
});

test('mutant (고): writing a .tex for a Guitar Pro file that has a hand-made .tsv is caught', function(){
  gpMutantFailures('overwrites hand-made tsv', null, [['if (tsvNames.has(base)){', 'if (false){']]);
});

test('mid-song meter change: a bar shorter than the grid bar and a whole number of cells gets trailing skip cells; a longer bar or a bar that is not a whole number of cells is refused with its number and meter', function(){
  // 모자란 칸은 빈칸 _ (예제 short-bar, short-bar-rest, short-bar-repeat 가 줄 전체를 견준다). 여기서는 거절과 칸 수를 본다.
  const head = '\\title "M" \\tempo 80 \\ts (4 4)\n0.1.4 1.1.4 3.1.4 0.2.4 |\n';
  const longer = tool.convertScore(importCleanTex(head + '\\ts (5 4) 0.1.4 1.1.4 3.1.4 0.2.4 0.3.4 |\n', 'longer'), {});
  assert.equal(longer.ok, false);
  assert.match(longer.error, /곡 중간에 박자표가 바뀝니다\(2마디 5\/4\)/);
  // 3/8 = 1.5 칸이라 4분음표 칸의 정수배가 아니다. 템포가 높아 8분음표 칸으로 다시 할 수 없으면(130 x 2 > 상한) 거절한다.
  const fastHead = head.replace('\\tempo 80', '\\tempo 130');
  const half = tool.convertScore(importCleanTex(fastHead + '\\ts (3 8) 0.1.8 1.1.8 3.1.8 |\n', 'half'), {});
  assert.equal(half.ok, false);
  assert.match(half.error, /곡 중간에 박자표가 바뀝니다\(2마디 3\/8\)/);
  // 4/4 가 아닌 곡도 8칸으로 다시 하지 않는다
  const threeFour = tool.convertScore(importCleanTex('\\title "T" \\tempo 80 \\ts (3 4)\n0.1.4 1.1.4 3.1.4 |\n\\ts (3 8) 0.1.8 1.1.8 3.1.8 |\n', 'three-four'), {});
  assert.equal(threeFour.ok, false);
  assert.match(threeFour.error, /곡 중간에 박자표가 바뀝니다\(2마디 3\/8\)/);
  // 템포가 상한 안이면 4/4 곡의 3/8·5/8·7/8 마디는 8칸 격자로 다시 해서 받는다(8칸 설명 문구, 빈칸으로 채운 뒤쪽, 원본 박자 메모)
  const eighths = convertTex(head + '\\ts (3 8) 0.1.8 1.1.8 3.1.8 | \\ts (5 8) 0.1.8 1.1.8 3.1.8 0.2.8 1.2.8 | \\ts (7 8) 0.1.8 1.1.8 3.1.8 0.2.8 1.2.8 3.2.8 0.3.8 |\n');
  assert.equal(eighths.ok, true, eighths.error);
  assert.equal(eighths.beats, 8);
  assert.equal(eighths.bpm, 160);
  assert.match(eighths.description, new RegExp(tool.MEMO.eightCells.replace(/[()]/g, '\\$&')));
  assert.deepEqual(eighths.errors, []);
  const eighthCells = function(index){ return eighths.measures[index].split(' | ')[0].replace('[-] ', '').split(' '); };
  assert.deepEqual(eighthCells(1), [n(1, 0), n(1, 1), n(1, 3), '_', '_', '_', '_', '_']);
  assert.deepEqual(eighthCells(2), [n(1, 0), n(1, 1), n(1, 3), n(2, 0), n(2, 1), '_', '_', '_']);
  assert.deepEqual(eighthCells(3), [n(1, 0), n(1, 1), n(1, 3), n(2, 0), n(2, 1), n(2, 3), n(3, 0), '_']);
  assert.match(eighths.measures[1], /원본 3\/8 마디/);
  assert.match(eighths.measures[3], /원본 7\/8 마디/);
  // 우리 악보 -> alphaTex -> 우리 악보: 8칸 곡의 가운데 7/8 마디(마지막 칸 빈칸)
  const middle = converter.toAlphaTex({ title: 'M', beats: 8, bpm: 120, capo: 0, description: '', lines: ['[-] _ _ _ _ _ _ _ E4@1', '[-] E4@1 - - - - - - -', '[-] E4@1 - - - - - - _'] });
  assert.equal(middle.error, undefined);
  const middleBack = tool.convertScore(importCleanTex(middle.tex, 'middle'), { sourceName: 'middle.tex' });
  assert.equal(middleBack.ok, true, middleBack.error);
  assert.equal(middleBack.beats, 8);
  assert.deepEqual(middleBack.errors, []);
  assert.deepEqual(middleBack.measures.map(withoutConverterMemo), ['[-] _ _ _ _ _ _ _ E4@1', '[-] E4@1 - - - - - - -', '[-] E4@1 - - - - - - _']);
  // 3/4 마디는 4칸 중 3칸을 쓰고 1칸은 빈칸이다
  const three = convertTex(head + '\\ts (3 4) 0.1.4 1.1.4 3.1.4 |\n');
  assert.equal(three.ok, true, three.error);
  assert.equal(three.measures[1], '[-] ' + [n(1, 0), n(1, 1), n(1, 3), '_'].join(' ') + ' | "원본 3/4 마디"');
  // 메모는 변환기 근사 메모 쪽이라 박의 글 뒤에 붙는다
  const withText = convertTex(head + '\\ts (2 4) 0.1.4 {txt "글"} 1.1.4 |\n');
  assert.equal(withText.measures[1], '[-] ' + [n(1, 0), n(1, 1), '_', '_'].join(' ') + ' | "글 · 원본 2/4 마디"');
  // 박자표 변경이 없는 곡 끝의 짧은 마디는 이 메모 없이 뒤를 빈칸으로 채운다
  const tail = convertTex(head + '0.1.4 1.1.4 |\n');
  assert.equal(tail.ok, true, tail.error);
  assert.equal(tail.measures[1], '[-] ' + [n(1, 0), n(1, 1), '_', '_'].join(' '));
  assert.equal(tail.measures[1].indexOf('원본 '), -1);
});

test('skip cells: pickup, small remainder inside a cell, short mid-song bar, short last bar, total time, and the round trip of a score with skip cells', function(){
  const failures = skipCellFailures(tool);
  if (failures.length) process.stdout.write(failures.join('\n') + '\n');
  assert.deepEqual(failures, []);
});

test('eight cells: a 4/4 song with rhythm the 4-cell grid cannot hold uses 8 cells only when it moves fewer notes and the doubled BPM stays within the limit; other meters keep their cells', function(){
  const bar16 = ':16 0.1 1.1 3.1 0.2 0.1 1.1 3.1 0.2 0.1 1.1 3.1 0.2 0.1 1.1 3.1 0.2 |\n';
  const bar32 = ':32 0.1 1.1 3.1 0.2 1.2 3.2 0.3 1.3 0.1 1.1 3.1 0.2 1.2 3.2 0.3 1.3 :4 0.4 0.3 |\n';
  const fast = convertTex('\\title "F" \\tempo 130 \\ts (4 4)\n' + bar32);
  assert.equal(fast.ok, true);
  assert.equal(fast.beats, 4, '130 x 2 is over the BPM limit');
  assert.equal(fast.bpm, 130);
  assert.doesNotMatch(fast.description, /8칸/);
  assert.match(fast.measures[0], /\?/);
  assert.match(fast.measures[0], /칸 분할에 맞지 않는 리듬 → 가까운 자리/);
  const edge = convertTex('\\title "E" \\tempo 120 \\ts (4 4)\n' + bar32);
  assert.equal(edge.beats, 8, '120 x 2 is exactly the BPM limit');
  assert.equal(edge.bpm, 240);
  const sixteenths = convertTex('\\title "S" \\tempo 60 \\ts (4 4)\n' + bar16);
  assert.equal(sixteenths.ok, true);
  assert.equal(sixteenths.beats, 4, 'sixteenth notes fit the 4-cell grid');
  assert.doesNotMatch(sixteenths.description, /8칸/);
  assert.doesNotMatch(sixteenths.measures[0], /\?/);
  // 4/4 가 아닌 박자는 칸을 바꾸지 않는다(2/4 에 32분음표 8개 = 1박)
  const duple = convertTex('\\title "D" \\tempo 60 \\ts (2 4)\n:32 0.1 1.1 3.1 0.2 1.2 3.2 0.3 1.3 :4 0.4 |\n');
  assert.equal(duple.ok, true);
  assert.equal(duple.beats, 2);
  assert.doesNotMatch(duple.description, /8칸/);
  // 5잇단은 8칸에서도 옮긴 음이 줄지 않아 4칸을 유지한다
  const quintuplet = convertTex('\\title "Q" \\tempo 60 \\ts (4 4)\n0.1.8 {tu 5} 1.1.8 {tu 5} 3.1.8 {tu 5} 0.2.8 {tu 5} 1.2.8 {tu 5} 0.3.4 0.4.4 |\n');
  assert.equal(quintuplet.beats, 4);
  assert.doesNotMatch(quintuplet.description, /8칸/);
});

test('same note in two voices: one token, empty fingers are taken from the dropped note, a different string keeps both, a repeated beat text is written once', function(){
  const head = '\\title "V" \\tempo 80 \\ts (4 4)\n\\track "Guitar" \\staff {tabs} \\tuning (E4 B3 G3 D3 A2 E2)\n';
  const second = function(out){ return out.measures[0].split(' ')[1]; };
  // 위 성부의 짧은 음에만 왼손 운지가 있고 아래 성부의 긴 음에는 없다: 긴 음 하나가 남고 운지를 가져온다(lf 2 = 검지 = 1)
  const merged = convertTex(head + '\\voice\n0.5{lf 2}.4 r.4 r.2 |\n\\voice\n0.5.2 r.2 |\n');
  assert.equal(merged.ok, true, merged.error);
  assert.equal(merged.measures[0].split(' ')[0], '[-]');
  assert.equal(second(merged), '1' + n(5, 0));
  const fingers = convertTex(head + '\\voice\n0.5{rf 1}.2 r.2 |\n\\voice\n0.5{lf 3}.2 r.2 |\n');
  assert.equal(fingers.ok, true, fingers.error);
  assert.equal(second(fingers), '2' + n(5, 0) + ':p');
  // 줄이 다르면 같은 음높이여도 둘 다 남는다(5번 줄 5프렛 = 4번 줄 개방)
  const strings = convertTex(head + '\\voice\n5.5.2 r.2 |\n\\voice\n0.4.2 r.2 |\n');
  assert.equal(second(strings), [n(5, 5), n(4, 0)].join('+'));
  // 박 글
  const sameText = convertTex(head + '\\voice\n0.5.2 {txt "rit."} r.2 |\n\\voice\n0.5.2 {txt "rit."} r.2 |\n');
  assert.match(sameText.measures[0], / \| "rit\."$/);
  const otherText = convertTex(head + '\\voice\n0.5.2 {txt "a"} r.2 |\n\\voice\n0.5.2 {txt "b"} r.2 |\n');
  assert.match(otherText.measures[0], / \| "a · b"$/);
});

// ---------- 빈칸 _ 검사 (alphaTex <-> 우리 악보)

// 변환기가 만드는 마디 메모 중 왕복에서 원래 악보에 없던 것(못갖춘마디, 박자표가 바뀐 마디)을 뗀다.
function withoutConverterMemo(line){
  return line.replace(/ \| "(?:못갖춘마디|원본 \d+\/\d+ 마디)"$/, '');
}

// 빈칸 악보의 기대 마디와 어긋난 곳의 목록. 변환기(toolModule)와 우리 악보 -> alphaTex 변환기(forwardModule)를 바꿔 끼워 일부러 어긋난 사본을 넣을 수 있다.
function skipCellFailures(toolModule, forwardModule){
  const forward = forwardModule || converter;
  const failures = [];
  function expectLines(label, result, want){
    if (!result.ok){ failures.push(label + ': 변환 실패 ' + result.error); return; }
    if (JSON.stringify(result.measures) !== JSON.stringify(want)) failures.push(label + ': 마디\n      기대 ' + want.join('\n           ') + '\n      결과 ' + result.measures.join('\n           '));
    if (result.errors.length) failures.push(label + ': 검사 오류 ' + result.errors.map(function(error){ return error.code; }).join(','));
  }
  function convertText(tex){ return toolModule.convertScore(importCleanTex(tex, 'skip'), { sourceName: 'skip.tex' }); }
  const head = '\\title "K" \\tempo 80 \\ts (4 4)\n';
  const full = [n(1, 0), n(1, 1), n(1, 3), n(2, 0)];

  // (1) 4/4 곡의 한 박 못갖춘마디: 앞쪽 빈칸 셋
  expectLines('한 박 못갖춘마디', convertText(head + '\\ac 0.1.4 |\n0.1.4 1.1.4 3.1.4 0.2.4 |\n'),
    ['[-] _ _ _ ' + n(1, 0) + ' | "못갖춘마디"', '[-] ' + full.join(' ')]);
  // (2) 칸보다 작은 못갖춘마디(2/4 곡의 16분음표 둘): 빈칸 하나 + 그 칸 안의 쉼
  expectLines('칸보다 작은 못갖춘마디', convertText('\\title "K" \\tempo 80 \\ts (2 4)\n\\ac :16 0.1 1.1 |\n0.1.4 1.1.4 |\n'),
    ['[-] _ r/r/' + n(1, 0) + '/' + n(1, 1) + ' | "못갖춘마디"', '[-] ' + [n(1, 0), n(1, 1)].join(' ')]);
  // (3) 곡 중간 2/4 마디: 음 음 _ _ + 메모(음이 쉼으로 끝나도 같다)
  expectLines('곡 중간 2/4 마디', convertText(head + '0.1.4 1.1.4 3.1.4 0.2.4 |\n\\ts (2 4) 0.1.4 1.1.4 |\n\\ts (4 4) 0.1.4 1.1.4 3.1.4 0.2.4 |\n'),
    ['[-] ' + full.join(' '), '[-] ' + [n(1, 0), n(1, 1), '_', '_'].join(' ') + ' | "원본 2/4 마디"', '[-] ' + full.join(' ')]);
  // (4) 짧은 끝마디: 박자표를 바꾸지 않아도 뒤가 빈칸이고 메모가 없다. 칸보다 작은 나머지는 그 칸의 쉼이다.
  expectLines('짧은 끝마디', convertText(head + '0.1.4 1.1.4 3.1.4 0.2.4 |\n0.1.4 1.1.4 |\n'),
    ['[-] ' + full.join(' '), '[-] ' + [n(1, 0), n(1, 1), '_', '_'].join(' ')]);
  expectLines('칸보다 짧은 끝마디', convertText(head + '0.1.4 1.1.4 3.1.4 0.2.4 |\n:16 0.1 1.1 3.1 |\n'),
    ['[-] ' + full.join(' '), '[-] ' + [n(1, 0), n(1, 1), n(1, 3)].join('/') + '/r _ _ _']);
  // 시간: 빈칸을 뺀 시간이 alphaTab 내용 길이의 합(한 박 못갖춘마디 + 4 + 2 + 2박)과 같다
  const timed = convertText(head + '\\ac 0.1.4 |\n0.1.4 1.1.4 3.1.4 0.2.4 |\n\\ts (2 4) 0.1.4 1.1.4 |\n\\ts (4 4) 0.1.4 1.1.4 |\n');
  if (!timed.ok) failures.push('시간: 변환 실패 ' + timed.error);
  else {
    const totalUnits = rhythm.annotate(parser.parseScore(timed.measures.join('\n'), timed.beats).measures, timed.beats).totalUnits;
    if (totalUnits !== (1 + 4 + 2 + 2) * rhythm.UNITS_PER_SLOT) failures.push('시간: 전체 길이 ' + totalUnits + ' (기대 ' + (1 + 4 + 2 + 2) * rhythm.UNITS_PER_SLOT + ')');
    if (timed.errors.length) failures.push('시간: 검사 오류 ' + timed.errors[0].code);
  }

  // (7) 왕복: 빈칸이 든 우리 악보 -> alphaTex -> 우리 악보(변환기 메모만 뗀다)
  const lines = [
    '[-] _ _ _ ' + n(1, 0),
    '[-] ' + [n(1, 1), n(1, 3), n(2, 0), n(2, 1)].join(' '),
    '[-] ' + [n(3, 0), n(3, 1), '_', '_'].join(' '),
    '[-] ' + full.join(' '),
    '[-] ' + [n(3, 0), 'r', '_', '_'].join(' ')
  ];
  const out = forward.toAlphaTex({ title: 'K', beats: 4, bpm: 80, capo: 0, lines: lines });
  if (out.error) failures.push('왕복: alphaTex 변환 실패 ' + out.error);
  else {
    const imported = importTex(out.tex);
    if (imported.diagnostics.length || imported.thrown) failures.push('왕복: alphaTex 읽기 실패 ' + imported.diagnostics.join(' / '));
    else {
      const back = toolModule.convertScore(imported.score, { sourceName: 'skip.tex' });
      if (!back.ok) failures.push('왕복: 되돌리기 실패 ' + back.error);
      else {
        if (back.errors.length) failures.push('왕복: 변환 결과 검사 오류 ' + back.errors[0].code);
        if (JSON.stringify(back.measures.map(withoutConverterMemo)) !== JSON.stringify(lines)) failures.push('왕복: 마디\n      원본 ' + lines.join('\n           ') + '\n      결과 ' + back.measures.join('\n           '));
        if (back.beats !== 4 || back.bpm !== 80) failures.push('왕복: 칸 수·BPM ' + back.beats + ' ' + back.bpm);
      }
    }
  }
  return failures;
}

// 새 검사가 실제로 잡는지: 일부러 어긋난 사본을 같은 검사에 넣어 사본에서만 새로 생기는 실패가 있어야 한다.
function mutantCaught(label, from, to){
  const baseline = new Set(roundTripFailures(tool).concat(allExampleFailures(tool), skipCellFailures(tool)));
  const mutant = loadMutant(from, to);
  const caught = roundTripFailures(mutant).concat(allExampleFailures(mutant), skipCellFailures(mutant)).filter(function(failure){ return !baseline.has(failure); });
  assert.ok(caught.length > 0, label + ' 사본이 검사에 걸리지 않았습니다');
  process.stdout.write('  ' + label + ': caught by ' + caught.length + ' failure(s), e.g. ' + caught[0].split('\n')[0] + '\n');
}

test('mutant (a): slur destination marker put on the origin note is caught', function(){
  mutantCaught('slur on origin', 'const hammerOrigin = note.hammerPullOrigin;', 'const hammerOrigin = note.hammerPullDestination;');
});

test('mutant (b): tie destination treated as a new onset is caught', function(){
  mutantCaught('tie as onset', 'const continuation = note.isTieDestination && !!note.tieOrigin;', 'const continuation = false;');
});

test('mutant (d): ignoring rest-start positions in the cell division is caught', function(){
  mutantCaught('no rest starts', 'const restOffsets = restsByCell[c];', 'const restOffsets = [];');
});

test('mutant (c): eighth-note cells without the BPM conversion are caught', function(){
  mutantCaught('no BPM conversion', 'const rawBpm = quarterTempo / grid.slotQuarter;', 'const rawBpm = quarterTempo;');
});

// 우리 악보 -> alphaTex 쪽 사본: src/score-to-alphatex.js 의 한 줄을 바꾼 사본으로 왕복을 돌린다.
test('mutant (e): not writing the bar memo as a txt effect is caught', function(){
  const baseline = new Set(roundTripFailures(tool));
  const mutant = loadMutant("effects.push('txt ' + quote(memo));", "void 0;", FORWARD_SOURCE_PATH);
  const caught = roundTripFailures(tool, mutant).filter(function(failure){ return !baseline.has(failure); });
  assert.ok(caught.length > 0, '메모를 txt로 안 쓰는 사본이 왕복에 걸리지 않았습니다');
  process.stdout.write('  no txt memo: caught by ' + caught.length + ' failure(s), e.g. ' + caught[0].split('\n')[0] + '\n');
});

test('mutant (f): not using notices as the description is caught', function(){
  mutantCaught('no notices', "const noticeText = typeof score.notices === 'string' ? score.notices.replace(/[\\t\\r\\n]+/g, ' ') : '';", "const noticeText = '';");
});

test('mutant (g): dropping the beat text memo is caught', function(){
  mutantCaught('no beat text', "if (typeof beat.text === 'string' && beat.text) texts.push(", "if (false) texts.push(");
});

test('mutant (h): writing @string on a note that has no string is caught', function(){
  mutantCaught('@string on a named note', "(record.str ? '@' + record.str : '')", "'@' + (record.str || 1)");
});

test('mutant (i): not following jump directions (D.S., D.C., Coda, Fine) in the play order is caught', function(){
  mutantCaught('no jumps', 'function playOrder(score, staff){', 'function playOrder(score, staff){ score.masterBars.forEach(function(masterBar){ masterBar.directions = null; });');
});

test('mutant (m): ignoring the with Repeat text after D.S. is caught', function(){
  mutantCaught('no with Repeat', '!barTextMatches(staff, order[position], WITH_REPEAT)', 'true');
});

test('mutant (n): putting the jump memo on any non-sequential bar (also on a skipped 1st/2nd ending) is caught', function(){
  mutantCaught('jump memo on every skip', 'if (jump && isJumpArrival(jump, masterBar, index))', 'if (jump)');
});

test('mutant (o): not writing the 1st/2nd ending memo is caught', function(){
  mutantCaught('no ending memo', 'if (ending) memos.push(ending);', 'void 0;');
});

test('mutant (j): dropping the section text from the bar memo is caught', function(){
  mutantCaught('no section memo', 'texts: section ? [section].concat(collected.texts) : collected.texts', 'texts: collected.texts');
});

test('mutant (k): dropping the fermata memo is caught', function(){
  mutantCaught('no fermata memo', 'if (beat.fermata) memo(MEMO.fermata);', 'void 0;');
});

test('mutant (l): treating a string-less note in a 6-string track as stringed is caught', function(){
  mutantCaught('stringed branch for every note', 'const stringed = hasStrings && note.isStringed && note.string >= 1;', 'const stringed = hasStrings;');
});

test('mutant (너): filling a pickup bar with rests instead of skip cells is caught', function(){
  mutantCaught('pickup filled with r', "if (cellPlan.blank){ cellTexts.push('_'); return; }", "if (cellPlan.blank){ cellTexts.push(anacrusis ? 'r' : '_'); return; }");
});

test('mutant (버): filling a short mid-song bar with holds instead of skip cells is caught', function(){
  mutantCaught('short bar filled with -', "if (cellPlan.blank){ cellTexts.push('_'); return; }", "if (cellPlan.blank){ cellTexts.push(shortBar ? '-' : '_'); return; }");
});

test('mutant (서): writing a skip cell as a quarter rest in alphaTex is caught', function(){
  const baseline = new Set(skipCellFailures(tool));
  const mutant = loadMutant("return prefix + out.join(' ') + ' |';", "return out.concat(new Array(skipCount + 1).join('r.4,').split(',').slice(0, skipCount)).join(' ') + ' |';", FORWARD_SOURCE_PATH);
  const caught = skipCellFailures(tool, mutant).filter(function(failure){ return !baseline.has(failure); });
  assert.ok(caught.length > 0, '빈칸을 4분쉼으로 내보내는 사본이 검사에 걸리지 않았습니다');
  process.stdout.write('  skip as rest: caught by ' + caught.length + ' failure(s), e.g. ' + caught[0].split('\n')[0] + '\n');
});

test('mutant (더): never switching a 4/4 song to 8 cells is caught', function(){
  mutantCaught('no 8 cells', 'if (first.eightCellsEligible && first.movedCount > 0){', 'if (false){');
});

test('mutant (러): keeping the duplicate tokens of two voices is caught', function(){
  mutantCaught('no duplicate removal', 'const distinct = dedupeRecords(here);', 'const distinct = here;');
});

test('mutant (머): writing a repeated beat text twice is caught', function(){
  mutantCaught('repeated text', '.filter(function(text, position, all){ return all.indexOf(text) === position; })', '');
});

// ---------- 리뷰에서 나온 변환기 고침(꾸밈음·쉼 뒤 슬러, n/8 마디, 붙임줄 첫 토막의 해머링, 끝마디 나머지, 높은 프렛)

// 높은 프렛 음의 기대 토큰: 줄 지정 없이 음높이만 쓰고(음역 밖이면 옥타브를 옮긴다) 항상 ? 가 붙는다. 값은 파서의 개방현 표와 MAX_FRET 에서 셈한다.
function highFretToken(str, fret){
  let midi = parser.STRINGS[str - 1].midi + fret;
  const highest = parser.STRINGS[0].midi + notation.MAX_FRET;
  let shifted = false;
  while (midi > highest){ midi -= 12; shifted = true; }
  return { token: parser.noteNameForMidi(midi, false) + '?', shifted: shifted };
}

// 변환 결과가 기대와 어긋난 곳의 목록. 변환기(toolModule)를 바꿔 끼워 일부러 어긋난 사본을 넣을 수 있다.
function reviewFixFailures(toolModule){
  const failures = [];
  const head = '\\title "R" \\tempo 80 \\ts (4 4)\n';
  function convertText(tex){ return toolModule.convertScore(importCleanTex(tex, 'review'), { sourceName: 'review.tex' }); }
  function expectBars(label, tex, want){
    const result = convertText(tex);
    if (!result.ok){ failures.push(label + ': 변환 실패 ' + result.error); return result; }
    if (JSON.stringify(result.measures) !== JSON.stringify(want)) failures.push(label + ': 마디\n      기대 ' + want.join('\n           ') + '\n      결과 ' + result.measures.join('\n           '));
    if (result.errors.length) failures.push(label + ': 검사 오류 ' + result.errors.map(function(error){ return error.code; }).join(','));
    return result;
  }

  // (1) 꾸밈음이 출발점인 해머링·슬라이드: s·g 를 달지 않고 꾸밈음 메모만 남긴다(전에는 곡 처음의 s 로 INVALID_SLUR, 또는 엉뚱한 앞 음에서 출발한 슬러)
  expectBars('꾸밈음 해머링, 마디 맨 앞', head + '3.2{h}.16 {gr} 5.2.4 0.1.4 0.1.2 |\n',
    ['[-] ' + [n(2, 5), n(1, 0), n(1, 0), '-'].join(' ') + ' | "꾸밈음 생략"']);
  expectBars('꾸밈음 해머링, 같은 줄 앞 음', head + '5.2.4 3.2{h}.16 {gr} 5.2.4 0.1.4 0.1.4 |\n',
    ['[-] ' + [n(2, 5), n(2, 5), n(1, 0), n(1, 0)].join(' ') + ' | "꾸밈음 생략"']);
  expectBars('꾸밈음 해머링, 다른 높이 앞 음', head + '1.2.4 3.2{h}.16 {gr} 5.2.4 0.1.4 0.1.4 |\n',
    ['[-] ' + [n(2, 1), n(2, 5), n(1, 0), n(1, 0)].join(' ') + ' | "꾸밈음 생략"']);
  expectBars('꾸밈음 슬라이드', head + '3.2{sl}.16 {gr} 5.2.4 0.1.4 0.1.4 0.1.8 r.8 |\n',
    ['[-] ' + [n(2, 5), n(1, 0), n(1, 0), n(1, 0) + '/r'].join(' ') + ' | "꾸밈음 생략"']);
  // 쉼 뒤 슬러·슬라이드는 앱이 잇지 못하니(INVALID_SLUR·INVALID_SLIDE) 그 s·g 만 빼고 메모를 남긴다. 파서가 같은 쌍에 오류를 내는 것도 같이 본다.
  expectBars('쉼 뒤 해머링', head + '0.1{h}.4 r.4 2.1.4 0.1.4 |\n',
    ['[-] ' + [n(1, 0), 'r', n(1, 2), n(1, 0)].join(' ') + ' | "슬러 생략"']);
  expectBars('쉼 뒤 슬라이드', head + '3.2{sl}.4 r.4 5.2.4 0.1.4 |\n',
    ['[-] ' + [n(2, 3), 'r', n(2, 5), n(1, 0)].join(' ') + ' | "슬라이드 생략"']);

  // (5) 붙임줄 첫 토막에 단 {h}·{sl}: 도착이 같은 프렛 붙임줄 음이라 주법을 달지 못한다. 메모를 남긴다. 마지막 토막에 달면 s 가 된다.
  expectBars('붙임줄 첫 토막의 해머링', head + '0.1{h}.2 0.1{t}.2 | 2.1.1 |\n',
    ['[-] ' + [n(1, 0), '-', '-', '-'].join(' ') + ' | "슬러 생략"', '[-] ' + [n(1, 2), '-', '-', '-'].join(' ')]);
  expectBars('붙임줄 첫 토막의 슬라이드', head + '0.1{sl}.2 0.1{t}.2 | 2.1.1 |\n',
    ['[-] ' + [n(1, 0), '-', '-', '-'].join(' ') + ' | "슬라이드 생략"', '[-] ' + [n(1, 2), '-', '-', '-'].join(' ')]);
  expectBars('붙임줄 마지막 토막의 해머링', head + '0.1.2 0.1{t h}.2 | 2.1.1 |\n',
    ['[-] ' + [n(1, 0), '-', '-', '-'].join(' '), '[-] ' + ['s' + n(1, 2), '-', '-', '-'].join(' ')]);

  // (6) 끝마디의 칸보다 작은 나머지: 마지막 음이 늘어나지 않고 그 칸 안의 쉼 r 이 된다
  expectBars('4/4 끝마디의 8분음표 나머지', head + '0.1.4 0.1.4 0.1.4 0.1.4 |\n0.1.4 0.1.4 0.1.8 |\n',
    ['[-] ' + [n(1, 0), n(1, 0), n(1, 0), n(1, 0)].join(' '), '[-] ' + [n(1, 0), n(1, 0), n(1, 0) + '/r', '_'].join(' ')]);
  expectBars('2/4 끝마디의 8분음표 + 16분음표', '\\title "R" \\tempo 80 \\ts (2 4)\n0.1.4 0.1.4 |\n0.1.4 0.1.8 0.1.16 |\n',
    ['[-] ' + [n(1, 0), n(1, 0)].join(' '), '[-] ' + [n(1, 0), [n(1, 0), '-', n(1, 0), 'r'].join('/')].join(' ')]);

  // (7) 프렛이 음역(MAX_FRET)을 넘는 음: 줄 지정을 떼고 음높이만 쓰고 ? 와 메모를 남긴다. 걸린 슬러·하모닉스는 줄 없는 음 규칙대로 뺀다.
  const over1 = notation.MAX_FRET + 1;
  const over3 = notation.MAX_FRET + 2;
  const a = highFretToken(1, over1);
  const b = highFretToken(3, over3);
  const highMemo = '높은 프렛 → 줄 지정 생략' + (a.shifted || b.shifted ? ' · 음역 밖 → 옥타브 옮김' : '');
  expectBars('높은 프렛', head + over1 + '.1.4 ' + over3 + '.3.4 0.1.2 |\n', ['[-] ' + [a.token, b.token, n(1, 0), '-'].join(' ') + ' | "' + highMemo + '"']);
  const withHammer = convertText(head + over1 + '.1{h}.4 5.1.4 12.2{nh}.4 0.1.4 |\n');
  if (!withHammer.ok) failures.push('높은 프렛 해머링: 변환 실패 ' + withHammer.error);
  else {
    if (withHammer.errors.length) failures.push('높은 프렛 해머링: 검사 오류 ' + withHammer.errors[0].code);
    if (/(^|[ +/~])s/.test(withHammer.measures[0].split(' | ')[0].replace('[-] ', ''))) failures.push('높은 프렛 해머링: s 가 남았습니다 ' + withHammer.measures[0]);
    if (withHammer.measures[0].indexOf('슬러 생략') < 0) failures.push('높은 프렛 해머링: 슬러 생략 메모가 없습니다 ' + withHammer.measures[0]);
  }

  // (2) 4/4 곡 가운데의 n/8 마디: 4분음표 칸에선 정수 칸이 아니니 8분음표 칸 8칸으로 다시 한다
  const eighths = convertText(head + '0.1.4 1.1.4 3.1.4 0.2.4 |\n\\ts (3 8) 0.1.8 1.1.8 3.1.8 | \\ts (5 8) 0.1.8 1.1.8 3.1.8 0.2.8 1.2.8 | \\ts (7 8) 0.1.8 1.1.8 3.1.8 0.2.8 1.2.8 3.2.8 0.3.8 |\n');
  if (!eighths.ok) failures.push('n/8 마디: 변환 실패 ' + eighths.error);
  else {
    if (eighths.beats !== 8) failures.push('n/8 마디: 칸 수 ' + eighths.beats);
    if (eighths.errors.length) failures.push('n/8 마디: 검사 오류 ' + eighths.errors[0].code);
    if (eighths.description.indexOf(toolModule.MEMO.eightCells) < 0) failures.push('n/8 마디: 8칸 설명 문구가 없습니다');
    const trailingBlanks = eighths.measures.slice(1).map(function(line){ return (line.split(' | ')[0].match(/ _/g) || []).length; });
    if (JSON.stringify(trailingBlanks) !== JSON.stringify([5, 3, 1])) failures.push('n/8 마디: 빈칸 수 ' + trailingBlanks.join(','));
  }
  return failures;
}

test('review fixes: a grace note or rest before a slur/slide drops only that mark, n/8 bars in 4/4 use 8 cells, a hammer-on on a tie\'s first piece is noted, a short last bar keeps its small remainder as a rest, frets above MAX_FRET lose the string mark', function(){
  const failures = reviewFixFailures(tool);
  if (failures.length) process.stdout.write(failures.join('\n') + '\n');
  assert.deepEqual(failures, []);
  // 파서가 같은 쌍을 오류로 보는 것(변환기가 빼는 이유)
  assert.ok(parser.validateScore('[-] sE4@1 r r r', 4).errors.some(function(error){ return error.code === 'INVALID_SLUR'; }));
  assert.ok(parser.validateScore('[-] D4@2 r gE4@2 r', 4).errors.some(function(error){ return error.code === 'INVALID_SLIDE'; }));
});

function reviewMutantCaught(label, from, to){
  const mutant = loadMutant(from, to);
  const caught = reviewFixFailures(mutant);
  assert.ok(caught.length > 0, label + ' 사본이 검사에 걸리지 않았습니다');
  process.stdout.write('  ' + label + ': caught by ' + caught.length + ' failure(s), e.g. ' + caught[0].split('\n')[0] + '\n');
}

test('mutant (소): treating a grace note as the origin of a slur is caught', function(){
  reviewMutantCaught('grace origin', 'if (isGraceNote(hammerOrigin)) memo(MEMO.grace);', 'if (false) memo(MEMO.grace);');
});

test('mutant (오): not re-trying a meter change with 8 cells is caught', function(){
  reviewMutantCaught('no 8-cell retry for n/8', 'refusal.retryEightCells = !forcedGrid &&', 'refusal.retryEightCells = false &&');
});

test('mutant (조): not widening the slur fix to tokens with @ and to slides is caught', function(){
  reviewMutantCaught('slur fix only for string-less s', "const letter = error.code === 'INVALID_SLUR' ? 's' : (error.code === 'INVALID_SLIDE' ? 'g' : '');", "const letter = error.code === 'INVALID_SLUR' && String(error.message).indexOf('@') < 0 ? 's' : '';");
});

test('mutant (초): judging the rest start by the content length instead of the filled length is caught', function(){
  reviewMutantCaught('content length', 'const filledLen = anacrusis ? barLen : (grid.cells - blankCount) * grid.slotTicks;', 'const filledLen = barLen;');
});

test('mutant (코): keeping @string on a fret above MAX_FRET is caught', function(){
  reviewMutantCaught('high fret keeps the string', '            highFret = note.fret > notation.MAX_FRET;', '            highFret = false;');
});

test('mutant (토): not noting a hammer-on whose destination has the same pitch is caught', function(){
  reviewMutantCaught('silent same-pitch hammer-on', 'else if (stringedPitch(hammerOrigin) === midi) memo(MEMO.slur);', '');
});

test('convert-chord-memos: transforms chord memos into measure-head multi-chords', function(){
  const { convertMeasureChordMemos, convertScoreText } = require('../tools/convert-chord-memos.js');
  const line1 = '[Am] E4 B3 C4 D4 | "2박부터 G/B · 3박부터 C · 4박부터 D7"';
  assert.equal(convertMeasureChordMemos(line1), '[Am, 2:G/B, 3:C, 4:D7] E4 B3 C4 D4');

  const line2 = '[Am] E4 B3 C4 D4 | "연습용 · 2박부터 G/B"';
  assert.equal(convertMeasureChordMemos(line2), '[Am, 2:G/B] E4 B3 C4 D4 | "연습용"');

  const multiLine = line1 + '\n' + line2;
  const convertedMulti = convertScoreText(multiLine);
  assert.equal(convertedMulti, '[Am, 2:G/B, 3:C, 4:D7] E4 B3 C4 D4\n[Am, 2:G/B] E4 B3 C4 D4 | "연습용"');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-chord-'));
  const tmpFile = path.join(tmpDir, 'score.txt');
  fs.writeFileSync(tmpFile, line1, 'utf8');

  const cliOut = childProcess.execFileSync(process.execPath, [path.join(__dirname, '../tools/convert-chord-memos.js'), tmpFile], { encoding: 'utf8' });
  assert.equal(cliOut.trim(), '[Am, 2:G/B, 3:C, 4:D7] E4 B3 C4 D4');

  childProcess.execFileSync(process.execPath, [path.join(__dirname, '../tools/convert-chord-memos.js'), '-i', tmpFile]);
  assert.equal(fs.readFileSync(tmpFile, 'utf8').trim(), '[Am, 2:G/B, 3:C, 4:D7] E4 B3 C4 D4');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

process.stdout.write('1..' + checks + '\n');
if (failed){
  process.stdout.write('실패 ' + failed + '개\n');
  process.exitCode = 1;
}
