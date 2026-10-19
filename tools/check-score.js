'use strict';

// 시트 한 행(TSV) 형식의 악보 파일을 검사하는 CLI. 문법 검사는 parser.validateScore 하나로만 한다.
const fs = require('node:fs');
const notation = require('../src/notation.js');
const parser = require('../src/parser.js');
const score = require('../src/score.js');

// src/sheets.js 시트 행 검사와 같은 목록
const ALLOWED_BEATS = notation.SHEET_BEAT_COUNTS;
// src/app.js 곡 적용부가 자르는 범위
const BPM_MIN = 30;
const BPM_MAX = 240;
const HEADER_TITLES = ['곡 제목', '제목', 'title'];

function isIntegerText(text){
  return /^[0-9]+$/.test(text);
}

// 행 모양 검사. 걸리는 첫 항목 하나만 돌려주고 통과하면 null.
function checkRowShape(cols){
  if (cols.length !== 5) return { code: 'ROW_COLUMNS', message: '열이 5개여야 합니다(제목, 칸 수, BPM, 설명, 악보를 탭으로 구분). 지금 ' + cols.length + '개.' };
  if (!cols[0].trim()) return { code: 'ROW_TITLE', message: '제목이 비어 있습니다.' };
  const beatsText = cols[1].trim();
  if (!isIntegerText(beatsText) || ALLOWED_BEATS.indexOf(Number(beatsText)) < 0){
    return { code: 'ROW_BEATS', message: '칸 수는 ' + ALLOWED_BEATS.join(', ') + ' 중 하나여야 합니다: ' + beatsText };
  }
  const bpmText = cols[2].trim();
  if (!isIntegerText(bpmText) || Number(bpmText) < BPM_MIN || Number(bpmText) > BPM_MAX){
    return { code: 'ROW_BPM', message: 'BPM은 ' + BPM_MIN + '~' + BPM_MAX + ' 사이의 정수여야 합니다: ' + bpmText };
  }
  return null;
}

function formatDiagnostic(kind, item){
  let where = '';
  if (item.measure != null){
    where = item.measure + '마디 ';
    if (item.beat != null) where += item.beat + '박 ';
  }
  return '  ' + kind + ' ' + where + item.code + ': ' + item.message;
}

function checkScoreText(text, label){
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const rows = [];
  const out = [String(label)];
  const totals = { errors: 0, warnings: 0, uncertain: 0 };

  lines.forEach(function(line, index){
    if (!line.trim()) return;
    const cols = line.split('\t');
    const first = cols[0].trim();
    if (HEADER_TITLES.indexOf(first.toLowerCase()) >= 0) return;

    const row = { line: index + 1, title: first, errors: [], warnings: [], uncertain: 0, measures: 0 };
    const shape = checkRowShape(cols);
    if (shape){
      row.errors.push(shape);
      out.push('[' + row.line + '] ' + (first || '(제목 없음)') + ' · 오류 1');
      out.push('  오류 ' + shape.code + ': ' + shape.message);
    } else {
      const beats = Number(cols[1].trim());
      const raw = cols[4].trim();
      const validation = parser.validateScore(raw, beats);
      row.errors = validation.errors;
      row.warnings = validation.warnings;
      row.measures = parser.splitScoreMeasures(raw).length;
      row.uncertain = score.countUncertainBeats(parser.parseScore(raw, beats).measures);
      out.push('[' + row.line + '] ' + first + ' · ' + beats + '칸 · ' + cols[2].trim() + ' BPM · ' + row.measures + '마디 · 오류 ' +
        row.errors.length + ' · 경고 ' + row.warnings.length + ' · 확인 ' + row.uncertain + '곳');
      row.errors.forEach(function(e){ out.push(formatDiagnostic('오류', e)); });
      row.warnings.forEach(function(w){ out.push(formatDiagnostic('경고', w)); });
    }
    totals.errors += row.errors.length;
    totals.warnings += row.warnings.length;
    totals.uncertain += row.uncertain;
    rows.push(row);
  });

  out.push('결과: 행 ' + rows.length + '개 · 오류 ' + totals.errors + ' · 경고 ' + totals.warnings + ' · 확인 ' + totals.uncertain + '곳');
  return { rows: rows, totals: totals, output: out.join('\n') };
}

function main(argv){
  const file = argv[2];
  if (!file){
    process.stderr.write('사용법: node tools/check-score.js <파일.tsv>\n');
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e){
    process.stderr.write('파일을 읽지 못했습니다: ' + file + '\n');
    return 2;
  }
  const result = checkScoreText(text, file);
  if (!result.rows.length){
    process.stderr.write('검사할 행이 없습니다.\n');
    return 1;
  }
  process.stdout.write(result.output + '\n');
  return result.totals.errors > 0 ? 1 : 0;
}

module.exports = { checkScoreText: checkScoreText };

if (require.main === module) process.exitCode = main(process.argv);
