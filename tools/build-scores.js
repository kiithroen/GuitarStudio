'use strict';

// 폴더의 alphaTex 원본(*.tex)을 시트용 TSV(6열)로 바꾸는 도구. 흐름과 규칙은 Docs/alphatab.md 의 "원본은 alphaTex" 절.
// 사용: node tools/build-scores.js <폴더> [--check]
// 폴더 안(하위 폴더 제외) 곡.tex 마다 alphatab-to-score 변환을 돌려 곡.tsv 를 쓴다.
// TSV 한 행 6열: 제목, 칸 수, BPM, 설명, 악보, alphaTex 원본(한 줄로 편 것). --check 는 쓰지 않고 보고만 한다.
const fs = require('node:fs');
const path = require('node:path');
const converter = require('./alphatab-to-score.js');
const checkScore = require('./check-score.js');

const USAGE = '사용법: node tools/build-scores.js <폴더> [--check]';
const BOM = '﻿';

// alphaTex 글을 한 줄로 편다: 문자열 밖의 줄바꿈·탭·연속 공백은 공백 하나로, 앞뒤 공백은 뗀다.
// 문자열("…" 또는 '…', 역슬래시 이스케이프 있음) 안은 그대로 두되, 줄바꿈이나 탭이 있으면 TSV 칸에 못 넣어서 { error }.
function flattenAlphaTex(text){
  const source = String(text).replace(/^﻿/, '');
  let out = '';
  let quote = null;
  let pendingSpace = false;
  for (let i = 0; i < source.length; i++){
    const ch = source[i];
    if (quote){
      if (ch === '\n' || ch === '\r' || ch === '\t') return { error: '문자열 안에 줄바꿈이나 탭이 있어 한 줄로 펼 수 없습니다.' };
      out += ch;
      if (ch === '\\' && i + 1 < source.length){
        i++;
        const next = source[i];
        if (next === '\n' || next === '\r' || next === '\t') return { error: '문자열 안에 줄바꿈이나 탭이 있어 한 줄로 펼 수 없습니다.' };
        out += next;
      } else if (ch === quote){
        quote = null;
      }
      continue;
    }
    if (/\s/.test(ch)){
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out) out += ' ';
    pendingSpace = false;
    out += ch;
    if (ch === '"' || ch === "'") quote = ch;
  }
  if (quote) return { error: '닫히지 않은 문자열이 있습니다.' };
  return { text: out };
}

function describeErrors(checked){
  const lines = [];
  checked.rows.forEach(function(row){
    row.errors.forEach(function(error){
      let where = '';
      if (error.measure != null) where = error.measure + '마디 ' + (error.beat != null ? error.beat + '박 ' : '');
      lines.push(where + error.code + ': ' + error.message);
    });
  });
  return lines;
}

// 파일 하나를 TSV 한 행으로 바꾼다. 성공하면 { row, measures }, 실패하면 { errors: [이유…] }.
function buildOne(texFile){
  let raw;
  try {
    raw = fs.readFileSync(texFile, 'utf8');
  } catch (error) {
    return { errors: ['파일을 읽지 못했습니다.'] };
  }
  const flat = flattenAlphaTex(raw);
  if (flat.error) return { errors: [flat.error] };

  const options = { sourceName: path.basename(texFile), fallbackTitle: path.basename(texFile, path.extname(texFile)) };
  function convertText(text){
    try {
      return converter.convertScore(converter.parseAlphaTex(text), options);
    } catch (error) {
      if (error instanceof converter.Refusal) return { ok: false, error: error.message };
      return { ok: false, error: '변환 중 오류가 났습니다: ' + (error && error.message ? error.message : error) };
    }
  }
  const original = convertText(raw.replace(/^﻿/, ''));
  if (!original.ok) return { errors: [original.error] };
  const folded = convertText(flat.text);
  if (!folded.ok) return { errors: [folded.error] };
  // 한 줄로 펴서 결과가 달라지면(줄 끝 주석 등) 시트에 넣는 alphaTex 가 원본과 다른 악보가 된다.
  if (original.tsv !== folded.tsv) return { errors: ['한 줄로 펴면 변환 결과가 달라집니다(줄 끝 주석 등을 확인하세요).'] };

  const row = folded.tsv + '\t' + flat.text;
  const checked = checkScore.checkScoreText(row, path.basename(texFile));
  if (checked.totals.errors > 0) return { errors: describeErrors(checked) };
  return { row: row, measures: folded.measures.length };
}

function parseArgs(argv){
  const options = { folder: null, check: false };
  for (let i = 0; i < argv.length; i++){
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg.charAt(0) === '-' && arg.length > 1) return { error: '알 수 없는 옵션입니다: ' + arg };
    else if (!options.folder) options.folder = arg;
    else return { error: '폴더는 하나만 받습니다: ' + arg };
  }
  if (!options.folder) return { error: '폴더가 필요합니다.' };
  return { options: options };
}

function main(argv){
  const parsed = parseArgs(argv.slice(2));
  if (parsed.error){
    process.stderr.write(parsed.error + '\n' + USAGE + '\n');
    return 2;
  }
  const options = parsed.options;
  let entries;
  try {
    entries = fs.readdirSync(options.folder, { withFileTypes: true }).filter(function(entry){ return entry.isFile(); }).map(function(entry){ return entry.name; });
  } catch (error) {
    process.stderr.write('폴더를 읽지 못했습니다: ' + options.folder + '\n');
    return 2;
  }
  entries.sort();
  const texNames = entries.filter(function(name){ return /\.tex$/i.test(name); });
  const texBases = new Set(texNames.map(function(name){ return path.basename(name, path.extname(name)); }));

  let converted = 0;
  let failed = 0;
  let skipped = 0;
  texNames.forEach(function(name){
    const texFile = path.join(options.folder, name);
    const base = path.basename(name, path.extname(name));
    const built = buildOne(texFile);
    if (built.errors){
      failed++;
      process.stderr.write('오류: ' + name + '\n' + built.errors.map(function(line){ return '  ' + line; }).join('\n') + '\n');
      return;
    }
    if (options.check){
      converted++;
      process.stdout.write('확인: ' + name + ' (' + built.measures + '마디)\n');
      return;
    }
    const tsvPath = path.join(options.folder, base + '.tsv');
    try {
      fs.writeFileSync(tsvPath, BOM + built.row + '\n', 'utf8');
    } catch (error) {
      failed++;
      process.stderr.write('오류: ' + name + '\n  TSV를 쓰지 못했습니다: ' + tsvPath + '\n');
      return;
    }
    converted++;
    process.stdout.write('변환: ' + name + ' → ' + base + '.tsv (' + built.measures + '마디)\n');
  });

  // .tex 가 없는 TSV(손으로 만든 것)는 건드리지 않는다.
  entries.filter(function(name){ return /\.tsv$/i.test(name); }).forEach(function(name){
    if (texBases.has(path.basename(name, path.extname(name)))) return;
    skipped++;
    process.stdout.write('건너뜀: ' + name + ' (.tex 없음)\n');
  });

  process.stdout.write('변환 ' + converted + ' · 오류 ' + failed + ' · 건너뜀 ' + skipped + '\n');
  return failed > 0 ? 1 : 0;
}

module.exports = { flattenAlphaTex: flattenAlphaTex, buildOne: buildOne };

if (require.main === module) process.exitCode = main(process.argv);
