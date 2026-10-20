const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const alphaTab = require('../vendor/alphatab/dist/alphaTab.min.js');
const scorePrompt = require('../src/score-prompt.js');
const parser = require('../src/parser.js');
const notation = require('../src/notation.js');
const converter = require('../tools/alphatab-to-score.js');

let checks = 0;
function pass(name){
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

assert.equal(global.GuitarScorePrompt, undefined);
pass('module does not pollute the Node global');

const prompt = scorePrompt.buildScoreImagePrompt();
const promptLines = prompt.split('\n');

// ---------- alphaTex 읽기 도우미

// alphaTex 를 alphaTab 가져오기로 읽는다. 경고를 포함한 진단이 하나라도 있으면 diagnostics 에 담긴다.
function readTex(tex){
  const importer = new alphaTab.importer.AlphaTexImporter();
  const settings = new alphaTab.Settings();
  settings.core.logLevel = alphaTab.LogLevel.None;
  importer.initFromString(tex, settings);
  let score = null;
  let thrown = null;
  try { score = importer.readScore(); } catch (error) { thrown = error && error.message ? error.message : String(error); }
  const diagnostics = [importer.lexerDiagnostics, importer.parserDiagnostics, importer.semanticDiagnostics]
    .flatMap(function(bag){ return bag && Array.isArray(bag.items) ? bag.items : []; })
    .map(function(item){ return item.start.line + ':' + item.start.col + ' ' + item.message; });
  return { score: score, thrown: thrown, diagnostics: diagnostics };
}

function cleanScore(tex, label){
  const read = readTex(tex);
  assert.deepEqual(read.diagnostics, [], label + ' alphaTab 진단');
  assert.equal(read.thrown, null, label + ' 읽기');
  return read.score;
}

const HEADER = '\\title "t" \\tempo 80 \\ts (4 4)\n';

// ---------- 프롬프트 속 예시 코드블록

// 프롬프트에서 ```alphatex 코드블록을 꺼낸다.
function fencedBlocks(text){
  const blocks = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++){
    if (lines[i] !== '```alphatex') continue;
    const body = [];
    i++;
    while (i < lines.length && lines[i] !== '```'){ body.push(lines[i]); i++; }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

// 예시 코드블록 검사: 프롬프트의 블록이 내보낸 예시와 같고, 모두 진단 0으로 읽히고, 우리 악보로 바뀌어 검사 오류가 0이다.
// 문제 목록을 돌려준다(없으면 빈 배열). 일부러 어긋난 사본에도 같은 검사를 돌린다.
function exampleProblems(promptModule){
  const problems = [];
  const text = promptModule.buildScoreImagePrompt();
  const blocks = fencedBlocks(text);
  const examples = promptModule.ALPHATEX_EXAMPLES;
  if (blocks.length !== examples.length) problems.push('코드블록 수 ' + blocks.length + ' (예시 ' + examples.length + ')');
  examples.forEach(function(example, index){
    if (blocks[index] !== example.lines.join('\n')) problems.push('예시 ' + (index + 1) + ' 이 프롬프트의 코드블록과 다릅니다');
    const read = readTex(example.lines.join('\n'));
    if (read.diagnostics.length || read.thrown){
      problems.push('예시 ' + (index + 1) + ' 읽기: ' + (read.thrown || '') + ' ' + read.diagnostics.join(' / '));
      return;
    }
    const result = converter.convertScore(read.score, { sourceName: 'example-' + (index + 1) + '.tex' });
    if (!result.ok) problems.push('예시 ' + (index + 1) + ' 변환 실패: ' + result.error);
    else if (result.errors.length) problems.push('예시 ' + (index + 1) + ' 검사 오류: ' + result.errors.map(function(e){ return e.code; }).join(','));
  });
  return problems;
}

assert.ok(Array.isArray(scorePrompt.ALPHATEX_EXAMPLES) && scorePrompt.ALPHATEX_EXAMPLES.length >= 3);
assert.deepEqual(exampleProblems(scorePrompt), []);
pass('every example in the prompt is an alphatex code block that alphaTab reads with zero diagnostics and converts to a valid score');

// 예시가 가르치는 기능이 변환 결과에 실제로 나오는지(구조만 본다)
const exampleResults = scorePrompt.ALPHATEX_EXAMPLES.map(function(example, index){
  return converter.convertScore(cleanScore(example.lines.join('\n'), 'example ' + (index + 1)), { sourceName: 'example.tex' });
});
exampleResults.forEach(function(result){ assert.equal(result.ok, true, result.error); });
const [tabResult, staffResult, jumpResult] = exampleResults;
// 예시 1: 3마디 도돌이(\rc 2)는 6마디로 펼쳐진다. 롤 ~, 해머링 s, 슬라이드 g, 하모닉스 h, 왼손 운지, 오른손 운지가 우리 문법으로 나온다.
assert.equal(tabResult.measures.length, 6);
assert.match(tabResult.measures[0], /~/);
assert.match(tabResult.measures[0], /(^|[ \/+])s[A-G]/);
assert.match(tabResult.measures[0], /(^|[ \/+])g[A-G]/);
assert.match(tabResult.measures[1], /(^|[ \/+])h[A-G]/);
assert.match(tabResult.measures[0], /(^|[+ ])[1-4][A-G]/);
assert.match(tabResult.measures[0], /:[pima]/);
assert.match(tabResult.measures[0], /^\[Am\]/);
assert.match(tabResult.measures[0], /"A · 도돌이 펼침"$/, 'section text comes first in the bar memo');
assert.match(tabResult.measures[2], /페르마타/);
assert.equal(tabResult.capo, 2);
assert.match(tabResult.description, /Capo 2/);
assert.match(tabResult.measures[2], /꾸밈음 생략/);
// 예시 2: 음이름 곡은 @줄 없이, 두 성부가 합쳐져 4마디, 못갖춘마디와 섹션
assert.equal(staffResult.measures.length, 4);
// 오선만 있는 곡 예시는 \displaytranspose 12 로 기타 오선보처럼 한 옥타브 위에 그린다(소리는 그대로).
assert.equal(cleanScore(scorePrompt.ALPHATEX_EXAMPLES[1].lines.join('\n'), 'example 2').tracks[0].staves[0].displayTranspositionPitch, -12);
staffResult.measures.forEach(function(line){ assert.doesNotMatch(line.split('|')[0], /@/); });
assert.match(staffResult.measures[0], /못갖춘마디/);
assert.match(staffResult.measures[1], / \| "A"$/, 'section text is the whole bar memo: the long-note memo is in the description only');
assert.match(staffResult.measures[3], /페르마타/);
// 예시 3: D.S. al Coda 가 펼쳐진다(1 2 3 4 2 3 5)
assert.equal(jumpResult.measures.length, 7);
assert.match(jumpResult.measures[4], /D\.S\. al Coda 펼침/);
assert.match(jumpResult.measures[6], /To Coda 펼침/);
pass('the examples teach what they claim: repeats, techniques, fingerings, voices, pickup, sections, fermata and jumps all survive conversion');

// ---------- 규칙 문장 속 짧은 alphaTex 조각

// find: 프롬프트에 그대로 있어야 하는 조각. tex: 그 조각으로 만든 곡. check: 읽은 악보에 대한 추가 확인(선택).
const SNIPPETS = [
  { find: '\\tempo (90)', tex: '\\title "t" \\tempo (90) \\ts (4 4)\n0.1.1 |', check: function(score){ assert.equal(score.tempo, 90); } },
  { find: '\\ts (6 8)', tex: '\\title "t" \\tempo (60) \\ts (6 8)\n0.1.2 {d} |', check: function(score){ assert.equal(score.masterBars[0].timeSignatureNumerator, 6); assert.equal(score.masterBars[0].timeSignatureDenominator, 8); } },
  { find: '\\ts (3 4)', tex: '\\title "t" \\tempo (60) \\ts (3 4)\n0.1.4 0.2.4 0.3.4 |' },
  { find: '\\tuning (E4 B3 G3 D3 A2 D2)', tex: '\\title "t" \\tempo 80 \\ts (4 4)\n\\tuning (E4 B3 G3 D3 A2 D2)\n0.6.1 |', check: function(score){ assert.equal(score.tracks[0].staves[0].tuning[5], parser.STRINGS[5].midi - 2); } },
  { find: '\\notices "기타 바이엘 3권 17쪽 · 작곡가 · 원본 템포 점4분음표=60"', tex: '\\title "t" \\notices "기타 바이엘 3권 17쪽 · 작곡가 · 원본 템포 점4분음표=60" \\tempo 80 \\ts (4 4)\n0.1.1 |', check: function(score){ assert.equal(score.notices, '기타 바이엘 3권 17쪽 · 작곡가 · 원본 템포 점4분음표=60'); } },
  { find: '\\ro 0.1.1 | 1.1.1 | \\ae 1 \\rc 2 3.1.1 | \\ae 2 0.2.1 | 1.2.1 |', tex: HEADER + '\\ro 0.1.1 | 1.1.1 | \\ae 1 \\rc 2 3.1.1 | \\ae 2 0.2.1 | 1.2.1 |', check: function(score){ assert.equal(score.masterBars.length, 5); } },
  { find: '\\section ("A")', tex: HEADER + '\\section ("A") 0.1.1 |', check: function(score){ assert.equal(score.masterBars[0].section.text, 'A'); } },
  { find: '\\section ("B\'")', tex: HEADER + '\\section ("B\'") C4.1 |', check: function(score){ assert.equal(score.masterBars[0].section.text, 'B\''); } },
  { find: '`\\ts (2 4)`', tex: HEADER + '0.1.4 0.1.4 0.1.4 0.1.4 | \\ts (2 4) 0.1.4 0.1.4 | \\ts (4 4) 0.1.1 |', check: function(score){ assert.equal(score.masterBars.length, 3); assert.equal(score.masterBars[1].timeSignatureNumerator, 2); assert.equal(score.masterBars[1].timeSignatureDenominator, 4); assert.equal(score.masterBars[2].timeSignatureNumerator, 4); } },
  { find: '\\ae 1 \\rc 2 3.1.1', tex: HEADER + '\\ro 0.1.1 | \\ae 1 \\rc 2 3.1.1 | \\ae 2 0.2.1 |' },
  { find: '`0.1`', tex: HEADER + '0.1.1 |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].string, 6); } },
  { find: '`3.2`', tex: HEADER + '3.2.1 |' },
  { find: '`C4`', tex: HEADER + 'C4.1 |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].realValue, 60); } },
  { find: '`F#3`', tex: HEADER + 'F#3.4 Bb2.4 |' },
  { find: '`r.4`', tex: HEADER + 'r.4 0.1.4 r.2 |' },
  { find: '`r.1`', tex: HEADER + 'r.1 |' },
  { find: '`(0.6 2.4 2.3).4`', tex: HEADER + '(0.6 2.4 2.3).4 |' },
  { find: '`(C3 G3).2`', tex: HEADER + '(C3 G3).2 |' },
  { find: '`3.1.4 {d}`', tex: HEADER + '3.1.4 {d} 0.2.8 |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].dots, 1); } },
  { find: '`0.1.8 {tu 3} 1.1.8 {tu 3} 3.1.8 {tu 3}`', tex: HEADER + '0.1.8 {tu 3} 1.1.8 {tu 3} 3.1.8 {tu 3} |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].tupletNumerator, 3); } },
  { find: '`5.2.2 5.2{t}.2`', tex: HEADER + '5.2.2 5.2{t}.2 |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0].isTieDestination, true); } },
  { find: '`Bb3.4 Bb3{t}.4`', tex: HEADER + 'Bb3.4 Bb3{t}.4 |' },
  { find: '`(5.2{t} 3.3{t}).2`', tex: HEADER + '(5.2 3.3).2 (5.2{t} 3.3{t}).2 |' },
  { find: '`5.2{t}.2`', tex: HEADER + '5.2.2 5.2{t}.2 |' },
  { find: '`C4{lf 2}.4`', tex: HEADER + 'C4{lf 2}.4 |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].leftHandFinger, alphaTab.model.Fingers.IndexFinger); } },
  { find: '`(0.6 2.4).4 {ad ch "Am" txt "메모"}`', tex: HEADER + '(0.6 2.4).4 {ad ch "Am" txt "메모"} |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].text, '메모'); } },
  { find: '`0.1{h}.8 2.1.8`', tex: HEADER + '0.1{h}.8 2.1.8 |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].isHammerPullOrigin, true); } },
  { find: '`A3{slur s1}.16 G3{slur s1}.16`', tex: HEADER + 'A3{slur s1}.16 G3{slur s1}.16 C4.8 |', check: function(score){ const beats = score.tracks[0].staves[0].bars[0].voices[0].beats; assert.equal(beats[0].notes[0].isSlurOrigin, true); assert.equal(beats[1].notes[0].isSlurDestination, true); assert.equal(beats[1].notes[0].slurOrigin, beats[0].notes[0]); } },
  { find: '`\\displaytranspose 12`', tex: '\\title "t" \\tempo (60) \\ts (4 4)\n\\displaytranspose 12\nC4.1 |', check: function(score){ assert.equal(score.tracks[0].staves[0].displayTranspositionPitch, -12); assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].realValue, 60); } },
  { find: '`3.2{sl}.4 5.2.4`', tex: HEADER + '3.2{sl}.4 5.2.4 |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].slideOutType, alphaTab.model.SlideOutType.Legato); } },
  { find: '`12.1{nh}.4`', tex: HEADER + '12.1{nh}.4 |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].harmonicType, alphaTab.model.HarmonicType.Natural); } },
  { find: '`(0.6 2.4 2.3).4 {ad}`', tex: HEADER + '(0.6 2.4 2.3).4 {ad} (0.6 2.4 2.3).4 {au} |', check: function(score){ const beats = score.tracks[0].staves[0].bars[0].voices[0].beats; assert.equal(beats[0].brushType, alphaTab.model.BrushType.ArpeggioDown); assert.equal(beats[1].brushType, alphaTab.model.BrushType.ArpeggioUp); } },
  { find: '`{txt "스트로크"}`', tex: HEADER + '(0.6 2.4 2.3).4 {txt "스트로크"} |' },
  { find: '`{txt "글리산도 생략"}`', tex: HEADER + '0.1.4 {txt "글리산도 생략"} |' },
  { find: '`3.2.16 {gr} 5.2.4`', tex: HEADER + '3.2.16 {gr} 5.2.4 |', check: function(score){ assert.notEqual(score.tracks[0].staves[0].bars[0].voices[0].beats[0].graceType, alphaTab.model.GraceType.None); } },
  { find: '`{fermata medium}`', tex: HEADER + '0.1.4 {fermata medium} |', check: function(score){ assert.ok(score.tracks[0].staves[0].bars[0].voices[0].beats[0].fermata); } },
  { find: '`2.4{lf 2}`', tex: HEADER + '2.4{lf 2} |' },
  { find: '`1.2{rf 3}`', tex: HEADER + '1.2{rf 3}.4 |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].rightHandFinger, alphaTab.model.Fingers.MiddleFinger); } },
  { find: '`{ch "Am"}`', tex: HEADER + '0.1.4 {ch "Am"} |' },
  { find: '`{txt "확인: 3박 음 흐림"}`', tex: HEADER + '0.1.4 {txt "확인: 3박 음 흐림"} |' },
  { find: '`\\jump segno`', tex: HEADER + '\\jump segno 0.1.1 |' },
  { find: '`{txt "with Repeat"}`', tex: HEADER + '\\jump segno 0.1.1 | \\jump dalsegno 0.2.1 {txt "with Repeat"} |', check: function(score){ assert.equal(score.tracks[0].staves[0].bars[1].voices[0].beats[0].text, 'with Repeat'); } }
];

// 이동 표시 이름: 프롬프트가 적은 이름이 모두 alphaTab 이 읽는 이름인지. 문장 안의 백틱 조각에서 꺼낸다.
function jumpNames(text){
  const line = text.split('\n').find(function(l){ return l.indexOf('- 이동 표시는') === 0; });
  assert.ok(line, 'the jump marks rule exists');
  const names = [];
  (line.match(/`[^`]+`/g) || []).forEach(function(token){
    const body = token.slice(1, -1);
    const direct = /^\\jump ([a-z]+)$/.exec(body);
    if (direct) names.push(direct[1]);
    else if (/^[a-z]+$/.test(body)) names.push(body);
  });
  return names;
}

// 규칙 속 조각 검사. 문제 목록을 돌려준다.
function snippetProblems(text){
  const problems = [];
  SNIPPETS.forEach(function(entry){
    if (text.indexOf(entry.find) < 0){ problems.push('프롬프트에 없음: ' + entry.find); return; }
    const read = readTex(entry.tex);
    if (read.diagnostics.length || read.thrown){ problems.push('읽기 실패: ' + entry.find + ' ' + (read.thrown || '') + ' ' + read.diagnostics.join(' / ')); return; }
    if (entry.check){
      try { entry.check(read.score); } catch (error) { problems.push('확인 실패: ' + entry.find + ' ' + error.message.split('\n')[0]); }
    }
  });
  jumpNames(text).forEach(function(name){
    const read = readTex(HEADER + '\\jump ' + name + ' 0.1.1 |');
    if (read.diagnostics.length || read.thrown) problems.push('이동 표시 이름을 읽지 못함: ' + name);
  });
  return problems;
}

assert.deepEqual(snippetProblems(prompt), []);
pass('every alphaTex snippet in the rules is in the prompt and alphaTab reads it with zero diagnostics (header lines, marks, notes, effects, jump names)');

const names = jumpNames(prompt);
['segno', 'coda', 'dacoda', 'fine', 'dalsegno', 'dalsegnoalcoda', 'dalsegnoalfine', 'dacapo', 'dacapoalcoda', 'dacapoalfine'].forEach(function(name){
  assert.ok(names.indexOf(name) >= 0, 'the prompt names the jump mark ' + name);
});
pass('the prompt names the segno, coda, fine and D.S./D.C. jump marks');

// ---------- 규칙 문장이 빠지지 않았는지

const REQUIRED = [
  // 1 출력
  ['```alphatex', 'one alphatex code block'], ['코드블록 하나만', 'output only the code block'], ['섞거나 복사하지 마', 'examples are not mixed into the real reading'],
  // 2 머리
  ['\\title', 'title'], ['\\notices', 'notices'], [' · ', 'notices joiner'], ['\\tempo (', 'tempo'], ['4분음표 기준', 'tempo is quarter based'], ['\\tempo (64)', 'default tempo'], ['템포 표기 없음(64 가정)', 'default tempo note'],
  ['\\ts (', 'time signature'], ['\\capo', 'capo'], ['\\tuning', 'tuning'],
  // 3 마디
  ['`|`로 나눠', 'bars split by |'], ['\\ro', 'repeat open'], ['\\rc', 'repeat close'], ['\\ae', 'alternate ending'], ['\\ac', 'anacrusis'], ['박자표가 바뀌면', 'a mid-song meter change is written with \\ts, not filled with rests'], ['\\section', 'section'], ['\\jump', 'jump'], ['펼치지 말고', 'do not expand repeats'], ['(with Repeat)·(반복 있음)', 'D.S. with Repeat'], ['세뇨 옆에 적혀 있어도', 'with Repeat beside the segno goes on the D.S. bar'], ['al Coda·al Fine이 인쇄되지 않아도', 'D.S. without al Coda still jumps to the coda'],
  // 4 음
  ['프렛.줄', 'fret.string'], ['1번 줄이 가장 높은 줄', 'string 1 is the highest'], ['음이름+옥타브', 'note name plus octave'], ['한 옥타브 높게', 'guitar staff is written an octave up'], ['옥타브 숫자에서 1을 빼', 'minus one octave'], ['`#`·`b`', 'accidentals'], ['추측해서 만들지 마', 'do not guess strings'], ['섞지 마', 'do not mix fretted and named notes'],
  // 5 길이·묶음
  ['`.1` 온음표', 'whole note'], ['`.32` 32분음표', '32nd note'], ['`{d}`', 'dotted'], ['`{tu 3}`', 'triplet'], ['`{t}`', 'tie'], ['`\\voice`', 'voices'], ['첫째 성부에만', 'marks go to the first voice'],
  // 6 주법
  ['`{h}`', 'hammer-on/pull-off'], ['`{sl}`', 'slide'], ['`{nh}`', 'natural harmonic'], ['`{ad}`', 'roll down arrow'], ['`{slur s1}`', 'slur pair for named notes'], ['음이름 음에는', 'no {h} on named notes'], ['\\displaytranspose 12', 'display transpose for named-note songs'], ['두 성부의 그 박에 모두', 'a roll across two voices goes on both voices'], ['`{au}`', 'roll up arrow'], ['`{gr}`', 'grace note'], ['`{fermata medium}`', 'fermata'],
  ['`{lf 2}`~`{lf 5}`', 'left hand fingers'], ['`{rf 1}`~`{rf 4}`', 'right hand fingers'], ['`{ch "Am"}`', 'chord name'], ['글리산도 생략', 'glissando without a start note'], ['스트로크', 'strokes'],
  // 7 메모
  ['`{txt "…"}`', 'text memo'], ['`{txt "확인: 이유"}`', 'uncertain memo'], ['아포얀도 표시는 옮기지 마', 'no apoyando']
];

function requiredProblems(text){
  return REQUIRED.filter(function(entry){ return text.indexOf(entry[0]) < 0; }).map(function(entry){ return '규칙이 빠짐: ' + entry[1] + ' (' + entry[0] + ')'; });
}

assert.deepEqual(requiredProblems(prompt), []);
pass('the prompt keeps every rule sentence: output, header, bars and marks, notes, lengths, techniques, memos');

assert.doesNotMatch(prompt, /\{\{/);
pass('prompt has no unreplaced placeholder');

assert.doesNotMatch(prompt, /제미니|gemini|chatgpt|gpt|claude|클로드|안티그래비티|antigravity|copilot/i);
pass('prompt names no specific AI product');

assert.doesNotMatch(prompt, /TSV|\[코드\]|\[문법 7\]|확인 표시 `\?`/);
pass('the prompt no longer teaches the in-app text grammar');

// ---------- 일부러 어긋난 사본

// 소스의 한 곳을 바꾼 사본 모듈을 불러온다. 바꿀 자리가 하나가 아니면 테스트가 틀린 것이다.
const PROMPT_SOURCE_PATH = path.join(__dirname, '../src/score-prompt.js');
function loadPromptMutant(from, to){
  const source = fs.readFileSync(PROMPT_SOURCE_PATH, 'utf8');
  assert.equal(source.split(from).length - 1, 1, '사본을 만들 자리가 하나여야 합니다: ' + from);
  const filename = path.join(path.dirname(PROMPT_SOURCE_PATH), 'score-prompt.mutant.js');
  const mutant = new Module(filename, module);
  mutant.filename = filename;
  mutant.paths = Module._nodeModulePaths(path.dirname(filename));
  mutant._compile(source.replace(from, to), filename);
  return mutant.exports;
}

// (다) 예시 속 이동 표시 이름의 글자를 틀리게 한 사본: 예시 검사에 걸린다.
const brokenExample = loadPromptMutant("'\\\\jump segno 2.1.1 |'", "'\\\\jump segnoo 2.1.1 |'");
assert.notDeepEqual(exampleProblems(brokenExample), []);
// 예시의 효과 중괄호를 닫지 않은 사본도 걸린다.
const unclosedExample = loadPromptMutant("{ch \"Am\" ad}", "{ch \"Am\" ad");
assert.notDeepEqual(exampleProblems(unclosedExample), []);
// 규칙 속 조각의 문법 오류(없는 효과 이름)는 조각 검사에 걸린다.
const brokenRule = loadPromptMutant("`12.1{nh}.4`", "`12.1{nhx}.4`");
assert.notDeepEqual(snippetProblems(brokenRule.buildScoreImagePrompt()), []);
// 규칙 문장을 지운 사본은 규칙 검사에 걸린다.
const droppedRule = loadPromptMutant("'| 페르마타 | 박 효과 `{fermata medium}` |',", "");
assert.notDeepEqual(requiredProblems(droppedRule.buildScoreImagePrompt()), []);
// (라) 박자표 변경 줄을 뺀 사본은 규칙 검사와 조각 검사에 걸린다.
const droppedMeterRule = loadPromptMutant("    '- 곡 중간에 박자표가 바뀌면(예: 4/4 곡의 2/4 한 마디) 그 마디의 첫 음 앞에 `\\\\ts (2 4)`를 적고, 다음 마디가 원래 박자면 그 마디 첫 음 앞에 `\\\\ts (4 4)`를 다시 적어. 박자표를 바꾸지 않고 쉼으로 채우지 마.',\n", "");
assert.notDeepEqual(requiredProblems(droppedMeterRule.buildScoreImagePrompt()), []);
assert.notDeepEqual(snippetProblems(droppedMeterRule.buildScoreImagePrompt()), []);
pass('mutants are caught: a misspelled jump name or unclosed brace in an example, a wrong effect in a rule snippet, a deleted rule row, a deleted meter-change rule');

// ---------- 우리 악보 예시(검사 도구·시트 가져오기 스크립트 시험 자료)와 음 길이 표

const exampleText = scorePrompt.EXAMPLE_MEASURES.join('\n');
const validation = parser.validateScore(exampleText, scorePrompt.EXAMPLE_BEATS);
assert.deepEqual(validation.errors, []);
const parsedLines = parser.parseScore(exampleText, scorePrompt.EXAMPLE_BEATS);
assert.deepEqual(parsedLines.errors, []);
assert.equal(parsedLines.measures.length, scorePrompt.EXAMPLE_MEASURES.length);
pass('example measures validate and parse without errors under the current parser');

const columns = scorePrompt.EXAMPLE_TSV_ROW.split('\t');
assert.equal(columns.length, 5);
assert.equal(columns[1], String(scorePrompt.EXAMPLE_BEATS));
assert.equal(columns[2], String(scorePrompt.EXAMPLE_BPM));
const parsedRow = parser.parseScore(columns[4], scorePrompt.EXAMPLE_BEATS);
assert.deepEqual(parsedRow.errors, []);
assert.deepEqual(
  parsedRow.measures.map(function(m){ return m.beats.map(function(b){ return b.tok; }); }),
  parsedLines.measures.map(function(m){ return m.beats.map(function(b){ return b.tok; }); })
);
pass('example TSV row has five columns and its score column parses like the line form');

assert.ok(scorePrompt.EXAMPLE_MEASURES.some(function(line){
  return line.split('|')[0].trim().split(/\s+/).some(function(tok){ return notation.hasUncertainMark(tok); });
}), 'examples show at least one uncertain mark token');
pass('example measures include an uncertain-mark token');

const rhythmExamples = scorePrompt.RHYTHM_EXAMPLES;
assert.ok(Array.isArray(rhythmExamples) && rhythmExamples.length > 0);
const unitPerCell = parser.parseScore('[-] E4 r r r | ""', 4).measures[0].beats[0].durationUnits;
assert.ok(unitPerCell > 0);

function lengthToNumber(text){
  const parts = text.split('/');
  return parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(parts[0]);
}

function measureFor(example, cells){
  const used = example.notation.split(' ').length;
  const tokens = [example.notation];
  for (let i = used; i < cells; i++) tokens.push('r');
  return '[-] ' + tokens.join(' ') + ' | ""';
}

function flattenNotes(measure){
  const notes = [];
  measure.beats.forEach(function(beat){
    const pieces = beat.isSubdivided ? beat.subNotes : [beat];
    pieces.forEach(function(piece){
      if (piece.kind === 'note') notes.push(piece);
    });
  });
  return notes;
}

rhythmExamples.forEach(function(example){
  const text = measureFor(example, 4);
  assert.deepEqual(parser.validateScore(text, 4).errors, [], 'rhythm example validates: ' + example.notation);
});
pass('every rhythm table notation validates as a four-cell measure');

rhythmExamples.forEach(function(example){
  const parsed = parser.parseScore(measureFor(example, 4), 4);
  assert.deepEqual(parsed.errors, [], 'rhythm example parses: ' + example.notation);
  const notes = flattenNotes(parsed.measures[0]);
  assert.equal(notes.length, example.noteLengths.length, 'note count for ' + example.notation);
  notes.forEach(function(note, i){
    const cells = note.durationUnits / unitPerCell;
    const expected = lengthToNumber(example.noteLengths[i]);
    assert.ok(Math.abs(cells - expected) < 1e-9, 'length of note ' + (i + 1) + ' in ' + example.notation + ': parser ' + cells + ', table ' + example.noteLengths[i]);
  });
});
pass('every rhythm table notation parses to the note lengths the table states');

// ---------- 프로젝트 프롬프트

const projectPrompt = scorePrompt.buildProjectPrompt();
assert.doesNotMatch(projectPrompt, /제미니|gemini|chatgpt|gpt|claude|클로드|안티그래비티|antigravity|copilot/i);
pass('project prompt names no specific AI product');

const root = path.resolve(__dirname, '..');
['Docs/alphatab.md', 'tools/build-scores.js'].forEach(function(rel){
  assert.ok(projectPrompt.includes(rel), 'project prompt mentions ' + rel);
  assert.ok(fs.existsSync(path.join(root, rel)), rel + ' exists');
});
assert.ok(projectPrompt.includes('Temp/scores/<제목>.tex'), 'project prompt saves the alphaTex as .tex');
assert.ok(projectPrompt.includes('<제목>.tsv'), 'project prompt names the TSV that build-scores makes');
assert.doesNotMatch(projectPrompt, /check-score|score-format|\[문법 5\]/, 'project prompt no longer follows the old in-app grammar route');
pass('project prompt follows the alphaTex route: reads the doc, saves .tex, runs build-scores, and the named files exist');

const commandLines = projectPrompt.split('\n').filter(function(line){ return /^\s*node -e "/.test(line); });
assert.equal(commandLines.length, 1, 'project prompt has one node -e command line');
const code = commandLines[0].match(/node -e "(.*)"\s*$/)[1];
const run = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8' });
assert.equal(run.error, undefined);
assert.equal(run.status, 0, run.stderr);
assert.equal(run.stdout, prompt);
pass('the node -e command in the project prompt prints the full conversion rules');

process.stdout.write('1..' + checks + '\n');
