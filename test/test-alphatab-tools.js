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
// 곡 중간의 짧은 마디 메모와 4/4 곡의 8칸 설명 문구(채운 칸 수와 종류가 뒤에 붙는다)
const SHORT_BAR_MEMO = '원본 2/4 마디 → 뒤 2칸 ';
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
    measures: ['[-] r r r ' + n(1, 0) + ' | "못갖춘마디"', '[-] ' + n(1, 1) + ' - - -']
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
    // 4/4 곡 가운데 2/4 마디(끝이 음): 4칸으로 만들고 뒤 2칸은 앞 음을 이어 `-` 로 채운다.
    file: 'short-bar.tex', title: 'Short Bar', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' '),
      '[-] ' + [n(3, 0), n(4, 0), '-', '-'].join(' ') + ' | "' + SHORT_BAR_MEMO + '유지"',
      '[-] ' + [n(3, 1), n(3, 3), n(4, 0), n(4, 1)].join(' ')
    ]
  },
  {
    // 2/4 마디의 끝이 쉼이면 `r` 로 채우고 메모는 `쉼`
    file: 'short-bar-rest.tex', title: 'Short Bar Rest', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' '),
      '[-] ' + [n(3, 0), 'r', 'r', 'r'].join(' ') + ' | "' + SHORT_BAR_MEMO + '쉼"',
      '[-] ' + [n(3, 1), n(3, 3), n(4, 0), n(4, 1)].join(' ')
    ]
  },
  {
    // 도돌이 안의 짧은 마디는 펼친 사본마다 같은 채움과 메모를 단다.
    file: 'short-bar-repeat.tex', title: 'Short Bar Repeat', beats: 4, bpm: 80, capo: 0, descriptionHas: [],
    measures: [
      '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' ') + ' | "도돌이 펼침"',
      '[-] ' + [n(3, 0), n(4, 0), '-', '-'].join(' ') + ' | "' + SHORT_BAR_MEMO + '유지"',
      '[-] ' + [n(1, 0), n(1, 1), n(1, 3), n(2, 0)].join(' '),
      '[-] ' + [n(3, 0), n(4, 0), '-', '-'].join(' ') + ' | "' + SHORT_BAR_MEMO + '유지"',
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

test('chord names: first chord in the bar, unsupported names become [-] with a note, later changes are noted, padding is removed', function(){
  const out = convertTex('\\title "Ch" \\tempo 80 \\ts (4 4)\n0.1.4 {ch "Am"} 0.2.4 0.3.4 {ch "G7"} 0.4.4 |\n0.1.4 {ch "N.C."} 0.2.4 0.3.4 0.4.4 |\n');
  assert.equal(out.ok, true);
  assert.equal(out.measures[0], '[Am] ' + [n(1, 0), n(2, 0), n(3, 0), n(4, 0)].join(' ') + ' | "3박부터 G7"');
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
  const heads = out.measures.map(function(line){ return line.split(' ')[0]; });
  assert.deepEqual(heads, ['[-]', '[Am]', '[Am]', '[C]', '[G7]', '[G7]', '[-]', '[-]']);
  assert.doesNotMatch(out.measures[2], /\|/, 'a carried chord has no memo');
  assert.match(out.measures[3], /"3박부터 G7"$/, 'a change inside the bar keeps its memo');
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
  assert.match(mid.measures[0], /"원본 F7\(b5\) · 3박부터 Am7\(9\)"$/, 'a change inside the bar keeps the original name');
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
    fs.writeFileSync(rangePath, '\\title "Range" \\tempo 80 \\ts (4 4)\n20.1.4 0.2.4 0.3.4 0.4.4 |\n', 'utf8');
    const range = run(TOOL_PATH, [rangePath]);
    assert.equal(range.code, 1);
    assert.equal(range.out.split('\t').length, 5);
    assert.match(range.err, /GUITAR_RANGE/);
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

test('mid-song meter change: a bar shorter than the grid bar and a whole number of cells is filled; a longer bar or a bar that is not a whole number of cells is refused with its number and meter', function(){
  // 끝이 음이면 유지, 끝이 쉼이면 r (예제 short-bar, short-bar-rest, short-bar-repeat 가 줄 전체를 견준다). 여기서는 거절과 칸 수를 본다.
  const head = '\\title "M" \\tempo 80 \\ts (4 4)\n0.1.4 1.1.4 3.1.4 0.2.4 |\n';
  const longer = tool.convertScore(importCleanTex(head + '\\ts (5 4) 0.1.4 1.1.4 3.1.4 0.2.4 0.3.4 |\n', 'longer'), {});
  assert.equal(longer.ok, false);
  assert.match(longer.error, /곡 중간에 박자표가 바뀝니다\(2마디 5\/4\)/);
  // 3/8 = 1.5 칸이라 칸 길이의 정수배가 아니다
  const half = tool.convertScore(importCleanTex(head + '\\ts (3 8) 0.1.8 1.1.8 3.1.8 |\n', 'half'), {});
  assert.equal(half.ok, false);
  assert.match(half.error, /곡 중간에 박자표가 바뀝니다\(2마디 3\/8\)/);
  // 3/4 마디는 4칸 중 3칸을 쓰고 1칸을 채운다
  const three = convertTex(head + '\\ts (3 4) 0.1.4 1.1.4 3.1.4 |\n');
  assert.equal(three.ok, true, three.error);
  assert.equal(three.measures[1], '[-] ' + [n(1, 0), n(1, 1), n(1, 3), '-'].join(' ') + ' | "원본 3/4 마디 → 뒤 1칸 유지"');
  // 메모는 변환기 근사 메모 쪽이라 박의 글 뒤에 붙는다
  const withText = convertTex(head + '\\ts (2 4) 0.1.4 {txt "글"} 1.1.4 |\n');
  assert.equal(withText.measures[1], '[-] ' + [n(1, 0), n(1, 1), '-', '-'].join(' ') + ' | "글 · 원본 2/4 마디 → 뒤 2칸 유지"');
  // 박자표 변경이 없는 곡 끝의 짧은 마디는 지금처럼 이 메모 없이 r 로 채운다
  const tail = convertTex(head + '0.1.4 1.1.4 |\n');
  assert.equal(tail.ok, true, tail.error);
  assert.equal(tail.measures[1].indexOf('원본 '), -1);
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

// 새 검사가 실제로 잡는지: 일부러 어긋난 사본을 같은 검사에 넣어 사본에서만 새로 생기는 실패가 있어야 한다.
function mutantCaught(label, from, to){
  const baseline = new Set(roundTripFailures(tool).concat(allExampleFailures(tool)));
  const mutant = loadMutant(from, to);
  const caught = roundTripFailures(mutant).concat(allExampleFailures(mutant)).filter(function(failure){ return !baseline.has(failure); });
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
  mutantCaught('stringed branch for every note', 'if (hasStrings && note.isStringed && note.string >= 1){', 'if (hasStrings){');
});

test('mutant (너): filling a short bar with rests only is caught', function(){
  mutantCaught('short bar filled with r', "if (!fillKind) fillKind = collected.records.length && lastPiece !== null && lastPiece !== 'rest' ? '-' : 'r';", "if (!fillKind) fillKind = 'r';");
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

process.stdout.write('1..' + checks + '\n');
if (failed){
  process.stdout.write('실패 ' + failed + '개\n');
  process.exitCode = 1;
}
