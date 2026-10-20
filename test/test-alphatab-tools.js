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

const SOURCE_MEMO = '원본: ';
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
      '[-] ' + n(1, 3) + ' - - -',
      '[-] ' + n(1, 0) + ' - - -',
      '[-] ' + n(1, 1) + ' - - -',
      '[-] ' + n(2, 0) + ' - - -',
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
      '[-] ' + [pitchToken(midiOf('E', 4)), pitchToken(midiOf('F', 4) + 1), pitchToken(midiOf('C', 2)), pitchToken(midiOf('C', 6))].join(' ') + ' | "줄 정보 없음: 슬러 생략 · 음역 밖 → 옥타브 옮김"',
      '[-] ' + [pitchToken(midiOf('G', 3)) + '+' + pitchToken(midiOf('B', 3)), '-', pitchToken(midiOf('A', 3)), '-'].join(' ')
    ]
  }
];

const TEX_ONLY = EXAMPLES.filter(function(example){ return /\.tex$/.test(example.file); });

function loadExample(toolModule, file){
  const full = path.join(FIXTURES, file);
  if (/\.tex$/.test(file)) return toolModule.parseAlphaTex(fs.readFileSync(full, 'utf8'));
  return toolModule.parseScoreBytes(fs.readFileSync(full));
}

// 예제 하나의 기대와 어긋난 곳의 목록
function exampleFailures(toolModule, example, score){
  const failures = [];
  const result = toolModule.convertScore(score || loadExample(toolModule, example.file), { sourceName: example.file, fallbackTitle: path.basename(example.file, path.extname(example.file)) });
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
  const failures = TEX_ONLY.concat(EXAMPLES.filter(function(example){ return /\.musicxml$/.test(example.file); }))
    .flatMap(function(example){ return exampleFailures(tool, example); });
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
  assert.deepEqual(held.measures, ['[-] ' + [n(6, 0) + '+' + n(1, 0), n(2, 0), n(3, 0), n(4, 0)].join(' ') + ' | "긴 음은 시작만 적음"']);
});

test('refusals: unsupported meter, non-standard tuning, meter change, non-guitar track, bad track number', function(){
  const five = tool.convertScore(importCleanTex(readFixture('five-four.tex'), 'five-four'), {});
  assert.equal(five.ok, false);
  assert.match(five.error, /표에 없는 박자입니다: 5\/4/);
  const dropD = tool.convertScore(importCleanTex(readFixture('drop-d.tex'), 'drop-d'), {});
  assert.equal(dropD.ok, false);
  assert.match(dropD.error, /표준 조율/);
  const change = tool.convertScore(importCleanTex('\\title "C" \\tempo 100 \\ts (4 4)\n0.1.1 | \\ts (3 4) 0.1.2 {d} |\n', 'change'), {});
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

test('voices: the long-note memo goes to the bar, or once to the description when every bar has it', function(){
  const tex = '\\title "Per Bar" \\tempo 80 \\ts (4 4)\n\\track "Guitar" \\staff {tabs} \\tuning (E4 B3 G3 D3 A2 E2)\n\\voice\n0.6.1 | 0.6.4 0.6.4 0.6.4 0.6.4\n\\voice\n:4 0.1 1.1 3.1 1.1 | :4 0.1 1.1 3.1 1.1\n';
  const out = convertTex(tex);
  assert.equal(out.ok, true);
  assert.equal(out.measures[0], '[-] ' + [n(6, 0) + '+' + n(1, 0), n(1, 1), n(1, 3), n(1, 1)].join(' ') + ' | "긴 음은 시작만 적음"');
  assert.equal(out.measures[1], '[-] ' + [n(6, 0) + '+' + n(1, 0), n(6, 0) + '+' + n(1, 1), n(6, 0) + '+' + n(1, 3), n(6, 0) + '+' + n(1, 1)].join(' '));
  assert.doesNotMatch(out.description, /긴 음은 시작만 적음/);
  const whole = tool.convertScore(importCleanTex(readFixture('two-voices.tex'), 'two-voices'), { sourceName: 'two-voices.tex' });
  whole.measures.forEach(function(line){ assert.doesNotMatch(line, /긴 음/); });
  assert.match(whole.description, /긴 음은 시작만 적음/);
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

process.stdout.write('1..' + checks + '\n');
if (failed){
  process.stdout.write('실패 ' + failed + '개\n');
  process.exitCode = 1;
}
