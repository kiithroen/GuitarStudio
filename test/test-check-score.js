const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const parser = require('../src/parser.js');
const score = require('../src/score.js');
const scorePrompt = require('../src/score-prompt.js');
const checkScore = require('../tools/check-score.js');

const root = path.resolve(__dirname, '..');
const tool = path.join('tools', 'check-score.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-score-'));

let checks = 0;
function pass(name){
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

const exampleRow = scorePrompt.EXAMPLE_TSV_ROW;
const exampleCols = exampleRow.split('\t');
assert.equal(exampleCols.length, 5);

function rowWith(index, value){
  const cols = exampleCols.slice();
  cols[index] = value;
  return cols.join('\t');
}

let fileCount = 0;
function writeFixture(text){
  const file = path.join(tmpDir, 'fixture-' + (++fileCount) + '.tsv');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function runCli(args){
  const result = spawnSync(process.execPath, [tool].concat(args), { cwd: root, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, all: result.stdout + result.stderr };
}

function errorCodes(result){
  return result.rows[0].errors.map(function(e){ return e.code; });
}

try {
  // 1. 예시 행 한 줄
  {
    const file = writeFixture(exampleRow + '\n');
    const cli = runCli([file]);
    assert.equal(cli.status, 0, cli.all);
    const direct = checkScore.checkScoreText(exampleRow, file);
    assert.equal(direct.totals.errors, 0);
    const expectedUncertain = score.countUncertainBeats(parser.parseScore(exampleCols[4], exampleCols[1]).measures);
    assert.equal(direct.totals.uncertain, expectedUncertain);
    assert.ok(direct.totals.uncertain > 0, 'example row carries uncertain marks');
    assert.equal(direct.rows.length, 1);
    assert.ok(cli.stdout.includes('확인 ' + expectedUncertain + '곳'), cli.stdout);
    pass('example row: exit 0, no errors, uncertain count matches countUncertainBeats');
  }

  // 2. 머리 행
  {
    const header = '곡 제목\t박자\tBPM\t설명\t악보';
    const file = writeFixture(header + '\r\n' + exampleRow + '\r\n');
    const cli = runCli([file]);
    assert.equal(cli.status, 0, cli.all);
    const direct = checkScore.checkScoreText('﻿' + header + '\n\n  \n' + exampleRow + '\n', 'label');
    assert.equal(direct.rows.length, 1);
    assert.equal(direct.rows[0].line, 4, 'row number is the real file line');
    pass('header row, blank lines, BOM and CRLF are skipped; only the song row is checked');
  }

  // 3. 칸 하나가 빠진 마디
  {
    const measures = exampleCols[4].split(' // ');
    const parts = measures[0].split(' | ');
    const cells = parts[0].split(' ');
    cells.pop();
    measures[0] = [cells.join(' ')].concat(parts.slice(1)).join(' | ');
    const broken = rowWith(4, measures.join(' // '));
    const file = writeFixture(broken + '\n');
    const cli = runCli([file]);
    assert.equal(cli.status, 1, cli.all);
    assert.ok(cli.stdout.includes('MISSING_BEATS'), cli.stdout);
    assert.ok(errorCodes(checkScore.checkScoreText(broken, 'x')).includes('MISSING_BEATS'));
    assert.match(cli.stdout, /오류 1마디 ([0-9]+박 )?MISSING_BEATS/);
    pass('a measure missing one cell: exit 1 and MISSING_BEATS');
  }

  // 4. 탭이 공백으로 바뀐 행
  {
    const spaced = exampleRow.replace(/\t/g, ' ');
    const file = writeFixture(spaced + '\n');
    const cli = runCli([file]);
    assert.equal(cli.status, 1, cli.all);
    assert.ok(cli.stdout.includes('ROW_COLUMNS'), cli.stdout);
    assert.deepEqual(errorCodes(checkScore.checkScoreText(spaced, 'x')), ['ROW_COLUMNS']);
    pass('tabs replaced by spaces: exit 1 and ROW_COLUMNS');
  }

  // 5. 칸 수와 BPM 범위
  {
    const cases = [
      { index: 1, value: '5', code: 'ROW_BEATS' },
      { index: 2, value: '300', code: 'ROW_BPM' },
      { index: 2, value: '29', code: 'ROW_BPM' }
    ];
    cases.forEach(function(c){
      const row = rowWith(c.index, c.value);
      const cli = runCli([writeFixture(row + '\n')]);
      assert.equal(cli.status, 1, cli.all);
      assert.ok(cli.stdout.includes(c.code), cli.stdout);
      assert.deepEqual(errorCodes(checkScore.checkScoreText(row, 'x')), [c.code]);
    });
    pass('beats outside the allowed list and BPM outside the range are row errors');
  }

  // 6. 인자 없음, 없는 파일, 빈 파일
  {
    const noArg = runCli([]);
    assert.equal(noArg.status, 2);
    assert.ok(noArg.stderr.includes('사용법: node tools/check-score.js <파일.tsv>'), noArg.stderr);
    const missing = path.join(tmpDir, 'no-such-file.tsv');
    const noFile = runCli([missing]);
    assert.equal(noFile.status, 2);
    assert.ok(noFile.stderr.includes('파일을 읽지 못했어: ' + missing), noFile.stderr);
    const empty = runCli([writeFixture('')]);
    assert.equal(empty.status, 1);
    assert.ok(empty.all.includes('검사할 행이 없어.'), empty.all);
    pass('no argument and missing file exit 2; empty file exits 1 with the no-rows message');
  }

  // 7. 출력 마지막 줄
  {
    const cli = runCli([writeFixture(exampleRow + '\n')]);
    const lines = cli.stdout.trimEnd().split('\n');
    assert.ok(lines[lines.length - 1].startsWith('결과:'), lines[lines.length - 1]);
    const broken = checkScore.checkScoreText(rowWith(2, '300'), 'x');
    const brokenLines = broken.output.split('\n');
    assert.ok(brokenLines[brokenLines.length - 1].startsWith('결과:'));
    assert.equal(brokenLines[0], 'x');
    pass('the last output line starts with the result summary');
  }

  process.stdout.write('1..' + checks + '\n');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
