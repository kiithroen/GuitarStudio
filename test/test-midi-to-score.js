'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const parser = require('../src/parser.js');
const converter = require('../tools/midi-to-score.js');

const root = path.resolve(__dirname, '..');
const recipes = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'builtin-recipes.json'), 'utf8'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midi-to-score-'));

let checks = 0;
function pass(name){
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

// --- 작은 SMF 만들기 (외부 파일 없음) ---
const PPQ = 96;

function vlq(n){
  const bytes = [n & 0x7f];
  while ((n >>= 7) > 0) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

// spec: { notes: [{start, end, pitch}], tempoUs, timeSig: [num, denPow2], keySig: [sf, minor] }
function buildSmf(spec){
  const events = [];
  if (spec.timeSig) events.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, spec.timeSig[0], spec.timeSig[1], 24, 8] });
  if (spec.keySig) events.push({ tick: 0, order: 0, bytes: [0xff, 0x59, 0x02, spec.keySig[0] & 0xff, spec.keySig[1]] });
  if (spec.tempoUs) events.push({ tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (spec.tempoUs >> 16) & 0xff, (spec.tempoUs >> 8) & 0xff, spec.tempoUs & 0xff] });
  spec.notes.forEach(function(n){
    events.push({ tick: n.start, order: 2, bytes: [0x90, n.pitch, 64] });
    events.push({ tick: n.end, order: 1, bytes: [0x80, n.pitch, 0] });
  });
  events.sort(function(a, b){ return a.tick - b.tick || a.order - b.order; });
  const body = [];
  let last = 0;
  events.forEach(function(e){
    body.push.apply(body, vlq(e.tick - last));
    body.push.apply(body, e.bytes);
    last = e.tick;
  });
  body.push(0x00, 0xff, 0x2f, 0x00);
  const head = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff]);
  const len = body.length;
  const trk = Buffer.from([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff].concat(body));
  return Buffer.concat([head, trk]);
}

function note(start, len, pitch){
  return { start: start, end: start + len, pitch: pitch };
}

function convert(spec, options){
  const smf = buildSmf(spec);
  return converter.convertMidi(converter.parseMidi(smf), Object.assign({ cells: 4 }, options));
}

function body(line){
  // '[-] 칸 칸 … | ""' 에서 칸 부분만
  return line.replace(/^\[[^\]]*\]\s+/, '').replace(/ \| ".*$/, '');
}

// 1. 4/4 에서 4분음표 4개
{
  const spec = { timeSig: [4, 2], tempoUs: 500000, notes: [note(0, 96, 60), note(96, 96, 62), note(192, 96, 64), note(288, 96, 65)] };
  const r = convert(spec);
  assert.equal(r.measureCount, 1);
  assert.equal(r.measures.length, 1);
  assert.equal(body(r.measures[0]), 'C4 D4 E4 F4');
  assert.equal(r.bpm, 120);
  assert.deepEqual(r.warnings, []);
  assert.equal(convert(Object.assign({}, spec, { tempoUs: 600000 })).bpm, 100);
  assert.equal(r.minMidi, 60);
  assert.equal(r.maxMidi, 65);
  // 두 마디째로 넘어가는 음이 있으면 마디가 늘어난다
  const two = convert({ timeSig: [4, 2], tempoUs: 500000, notes: spec.notes.concat([note(384, 96, 67)]) });
  assert.equal(two.measureCount, 2);
  assert.equal(two.measures.length, 2);
  pass('4분음표 4개는 한 마디 4칸이고 음이름·옥타브·bpm 이 맞다');
}

// 2. 칸 안 분할 선택
{
  const spec = {
    timeSig: [4, 2], tempoUs: 500000,
    notes: [
      note(0, 48, 60), note(48, 48, 62),                              // 8분 둘
      note(96, 32, 64), note(128, 32, 65), note(160, 32, 67),        // 셋잇단
      note(192, 72, 69), note(264, 24, 71),                          // 점8분 + 16분
      note(288, 96, 72)
    ]
  };
  const r = convert(spec);
  assert.deepEqual(body(r.measures[0]).split(' '), ['C4/D4', 'E4/F4/G4', 'A4/-/-/B4', 'C5']);
  assert.deepEqual(r.warnings, []);
  pass('8분 둘은 X/Y, 셋잇단은 X/Y/Z, 점8분+16분은 X/-/-/Y 로 나뉜다');
}

// 3. 같은 틱 화음, 유지(-), 쉼(r)
{
  const chord = convert({ timeSig: [4, 2], tempoUs: 500000, notes: [note(0, 96, 64), note(0, 96, 60), note(96, 96, 62), note(192, 96, 62), note(288, 96, 62)] });
  assert.equal(body(chord.measures[0]).split(' ')[0], 'C4+E4');
  const hold = convert({ timeSig: [4, 2], tempoUs: 500000, notes: [note(96, 192, 55)] });
  assert.deepEqual(body(hold.measures[0]).split(' '), ['r', 'G3', '-', 'r']);
  pass('같은 틱 시작 음은 낮은 음부터 +, 울리는 칸은 -, 빈 칸과 곡 첫 빈 칸은 r');
}

// 4. 꾸밈음
{
  const notes = [note(0, 96, 60), note(88, 8, 62), note(96, 96, 64), note(192, 96, 65), note(288, 96, 67)];
  const spec = { timeSig: [4, 2], tempoUs: 500000, notes: notes };
  const r = convert(spec);
  assert.equal(r.graceDropped.length, 1);
  assert.equal(r.graceDropped[0].note, 'D4');
  assert.equal(r.graceDropped[0].measure, 1);
  assert.equal(r.graceDropped[0].cell, 1);
  assert.equal(body(r.measures[0]), 'C4 E4 F4 G4');
  const kept = convert(spec, { grace: 0.01 });
  assert.equal(kept.graceDropped.length, 0);
  assert.notEqual(body(kept.measures[0]), 'C4 E4 F4 G4');
  pass('--grace 비율보다 짧고 다음 음 시작에 붙은 음은 버려져 graceDropped 에 들어간다');
}

// 5. transpose, 조표 표기
{
  const spec = { timeSig: [4, 2], tempoUs: 500000, notes: [note(0, 96, 70), note(96, 96, 72), note(192, 96, 61), note(288, 96, 66)] };
  assert.equal(body(convert(spec).measures[0]), 'A#4 C5 C#4 F#4');
  const flat = convert(Object.assign({ keySig: [-2, 0] }, spec));
  assert.equal(body(flat.measures[0]), 'Bb4 C5 Db4 Gb4');
  assert.equal(flat.keySig.sf, -2);
  const down = convert(Object.assign({ keySig: [-2, 0] }, spec), { transpose: -12 });
  assert.equal(body(down.measures[0]), 'Bb3 C4 Db3 Gb3');
  assert.equal(down.minMidi, 49);
  assert.equal(down.maxMidi, 60);
  pass('transpose 는 음높이를 옮기고 sf<0 이면 b 표기, 아니면 # 표기');
}

// 6. 편집 연산
{
  const base = [note(0, 96, 60), note(96, 96, 62), note(192, 96, 64), note(288, 96, 65)];
  const clean = convert({ timeSig: [4, 2], tempoUs: 500000, notes: base });
  // drop: 격자 밖의 짧은 음
  const strayNotes = base.concat([note(10, 20, 67)]);
  const strayRaw = convert({ timeSig: [4, 2], tempoUs: 500000, notes: strayNotes });
  assert.ok(strayRaw.warnings.length > 0 || body(strayRaw.measures[0]) !== body(clean.measures[0]));
  const dropped = convert({ timeSig: [4, 2], tempoUs: 500000, notes: strayNotes }, { edits: [{ op: 'drop', start: 10, pitch: 67 }] });
  assert.equal(body(dropped.measures[0]), body(clean.measures[0]));
  assert.deepEqual(dropped.warnings, []);
  assert.equal(dropped.editsApplied.length, 1);
  assert.equal(dropped.editsApplied[0].op, 'drop');
  // setStart: 박보다 늦게 시작한 음을 박에 맞춤
  const lateNotes = [note(0, 96, 60), note(100, 92, 62), note(192, 96, 64), note(288, 96, 65)];
  const lateRaw = convert({ timeSig: [4, 2], tempoUs: 500000, notes: lateNotes });
  assert.ok(lateRaw.warnings.length > 0);
  const moved = convert({ timeSig: [4, 2], tempoUs: 500000, notes: lateNotes }, { edits: [{ op: 'setStart', start: 100, pitch: 62, to: 96 }] });
  assert.equal(body(moved.measures[0]), body(clean.measures[0]));
  assert.deepEqual(moved.warnings, []);
  assert.equal(moved.editsApplied[0].to, 96);
  // split: 반으로 나눠 두 번째를 다시 침
  const longNotes = [note(0, 192, 60), note(192, 96, 64), note(288, 96, 65)];
  const longRaw = convert({ timeSig: [4, 2], tempoUs: 500000, notes: longNotes });
  assert.equal(body(longRaw.measures[0]), 'C4 - E4 F4');
  const split = convert({ timeSig: [4, 2], tempoUs: 500000, notes: longNotes }, { edits: [{ op: 'split', start: 0, pitch: 60, at: 96 }] });
  assert.equal(body(split.measures[0]), 'C4 C4 E4 F4');
  // 편집은 입력 파싱 결과를 바꾸지 않는다
  const parsed = converter.parseMidi(buildSmf({ timeSig: [4, 2], tempoUs: 500000, notes: longNotes }));
  converter.convertMidi(parsed, { cells: 4, edits: [{ op: 'split', start: 0, pitch: 60, at: 96 }] });
  assert.equal(converter.convertMidi(parsed, { cells: 4 }).measures[0], longRaw.measures[0]);
  // 한 음에 맞지 않는 편집은 오류
  assert.throws(function(){
    convert({ timeSig: [4, 2], tempoUs: 500000, notes: base }, { edits: [{ op: 'drop', start: 5, pitch: 60 }] });
  }, /exactly one note/);
  pass('편집 연산 drop·setStart·split 이 결과에 반영되고 맞는 음이 없으면 오류');
}

// 7. 줄 충돌 해소
{
  const before = '[-] E4+F4 r r r | ""';
  assert.ok(parser.validateScore(before, 4).warnings.some(function(w){ return w.code === 'DEFAULT_STRING_COLLISION'; }));
  const fixed = converter.fixStringCollisions([before], 4);
  assert.equal(fixed.lines[0], '[-] E4@2+F4 r r r | ""');
  assert.equal(fixed.added.length, 1);
  assert.deepEqual(fixed.stops, []);
  const afterReport = parser.validateScore(fixed.lines.join(' // '), 4);
  assert.equal(afterReport.warnings.length, 0);
  assert.equal(afterReport.errors.length, 0);
  // 연쇄: E4 가 2번 줄로 가면 B3 의 기본 줄과 겹쳐 B3 도 옮겨진다
  const chain = converter.fixStringCollisions(['[-] E4+B3+F4 r r r | ""'], 4);
  assert.equal(chain.lines[0], '[-] E4@2+B3@3+F4 r r r | ""');
  const chainReport = parser.validateScore(chain.lines.join(' // '), 4);
  assert.equal(chainReport.warnings.length, 0);
  // 겹침이 없는 줄과 이미 @줄 이 적힌 음은 그대로
  const same = converter.fixStringCollisions(['[-] C4+G3 E4@2+F4 r/r r | ""'], 4);
  assert.equal(same.lines[0], '[-] C4+G3 E4@2+F4 r/r r | ""');
  assert.deepEqual(same.added, []);
  assert.throws(function(){ converter.fixStringCollisions(['[-] C4 D4 | ""'], 4); }, /cells/);
  pass('fixStringCollisions 는 겹친 음에 @N 을 붙이고 결과는 validateScore 경고 0');
}

// 8. CLI 와 rebuild-builtins
{
  const mid = path.join(tmpDir, 'sample.mid');
  const notes = [note(0, 96, 60), note(96, 96, 62), note(192, 96, 64), note(288, 96, 65)];
  fs.writeFileSync(mid, buildSmf({ timeSig: [4, 2], tempoUs: 500000, notes: notes }));
  const cli = spawnSync(process.execPath, [path.join('tools', 'midi-to-score.js'), mid, '--cells', '4'], { cwd: root, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).measures[0], '[-] C4 D4 E4 F4 | ""');
  const info = spawnSync(process.execPath, [path.join('tools', 'midi-to-score.js'), mid], { cwd: root, encoding: 'utf8' });
  assert.equal(info.status, 0, info.stderr);
  assert.equal(JSON.parse(info.stdout).noteCount, 4);

  assert.ok(recipes.length > 0);
  const emptyDir = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
  const none = spawnSync(process.execPath, [path.join('tools', 'rebuild-builtins.js'), emptyDir], { cwd: root, encoding: 'utf8' });
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.ok(none.stdout.indexOf('원본 없음 ' + recipes.length) >= 0, none.stdout);
  assert.ok(none.stdout.indexOf('일치 0 · 불일치 0') >= 0, none.stdout);

  // 엉뚱한 원본이 있으면 불일치로 알리고 종료 코드 1
  const wrongDir = fs.mkdtempSync(path.join(tmpDir, 'wrong-'));
  fs.copyFileSync(mid, path.join(wrongDir, recipes[0].file));
  const wrong = spawnSync(process.execPath, [path.join('tools', 'rebuild-builtins.js'), wrongDir], { cwd: root, encoding: 'utf8' });
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
  assert.ok(wrong.stdout.indexOf(recipes[0].id + ': 불일치(') >= 0, wrong.stdout);
  assert.ok(wrong.stdout.indexOf('불일치 1 · 원본 없음 ' + (recipes.length - 1)) >= 0, wrong.stdout);
  pass('CLI 가 JSON 을 내고 rebuild-builtins 는 원본이 없으면 원본 없음, 다르면 불일치로 알린다');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
process.stdout.write('1..' + checks + '\n');
