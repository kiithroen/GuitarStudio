'use strict';

// 우리 악보(시트 한 행 TSV 또는 내장곡)를 alphaTex 파일로 바꾸는 도구. 변환은 src/score-to-alphatex.js(GuitarAlphaTex.toAlphaTex) 하나만 쓴다.
// 사용: node tools/score-to-alphatex.js <시트 한 행 TSV 파일 | --builtin <id>> [-o 출력.tex]
// 반대 방향은 tools/alphatab-to-score.js. 규칙은 Docs/alphatab.md 의 명령줄 도구 절.
const fs = require('node:fs');
const path = require('node:path');
const parser = require('../src/parser.js');
const converter = require('../src/score-to-alphatex.js');
const checkScore = require('./check-score.js');

const USAGE = '사용법: node tools/score-to-alphatex.js <시트 한 행 TSV 파일 | --builtin <id>> [-o 출력.tex]';
const HEADER_TITLES = ['곡 제목', '제목', 'title'];

// TSV 글에서 곡 하나({ title, beats, bpm, capo, lines })를 뽑는다. 행이 하나가 아니거나 검사에 걸리면 { error, code }.
function songFromTsv(text, label){
  const rows = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(function(line){
    if (!line.trim()) return false;
    return HEADER_TITLES.indexOf(line.split('\t')[0].trim().toLowerCase()) < 0;
  });
  if (rows.length !== 1) return { error: '시트 한 행만 받습니다(지금 ' + rows.length + '행).', code: 2 };
  const checked = checkScore.checkScoreText(rows[0], label);
  if (checked.totals.errors > 0) return { error: '악보 검사에 걸렸습니다.\n' + checked.output, code: 1 };
  const cols = rows[0].split('\t');
  const title = cols[0].trim();
  const badge = cols[3];
  return {
    song: {
      title: title,
      beats: Number(cols[1].trim()),
      bpm: Number(cols[2].trim()),
      capo: parser.getSongCapo({ title: title, badge: badge }),
      description: badge,
      lines: parser.splitScoreMeasures(cols[4].trim())
    }
  };
}

function songFromBuiltin(id){
  const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'songs.json'), 'utf8'));
  const found = songs.find(function(song){ return song.id === id; });
  if (!found) return { error: 'songs.json에 없는 내장곡 id입니다: ' + id, code: 2 };
  return {
    song: {
      title: found.title,
      beats: found.beats,
      bpm: found.bpm,
      capo: parser.getSongCapo({ title: found.title, badge: found.badge }),
      description: found.badge,
      lines: found.lines
    }
  };
}

function parseArgs(argv){
  const options = { file: null, builtin: null, output: null };
  for (let i = 0; i < argv.length; i++){
    const arg = argv[i];
    if (arg === '--builtin' || arg === '-o'){
      const value = argv[++i];
      if (value == null) return { error: arg + ' 뒤에 값이 필요합니다.' };
      if (arg === '-o') options.output = value;
      else options.builtin = value;
    } else if (arg.charAt(0) === '-' && arg.length > 1){
      return { error: '알 수 없는 옵션입니다: ' + arg };
    } else if (!options.file){
      options.file = arg;
    } else {
      return { error: '입력 파일은 하나만 받습니다: ' + arg };
    }
  }
  if (options.file && options.builtin) return { error: 'TSV 파일과 --builtin 은 같이 쓸 수 없습니다.' };
  if (!options.file && !options.builtin) return { error: 'TSV 파일이나 --builtin <id> 가 필요합니다.' };
  return { options: options };
}

function main(argv){
  const parsed = parseArgs(argv.slice(2));
  if (parsed.error){
    process.stderr.write(parsed.error + '\n' + USAGE + '\n');
    return 2;
  }
  const options = parsed.options;
  let picked;
  if (options.builtin){
    picked = songFromBuiltin(options.builtin);
  } else {
    let text;
    try {
      text = fs.readFileSync(options.file, 'utf8');
    } catch (error) {
      process.stderr.write('파일을 읽지 못했습니다: ' + options.file + '\n');
      return 2;
    }
    picked = songFromTsv(text, options.file);
  }
  if (picked.error){
    process.stderr.write(picked.error + '\n');
    return picked.code;
  }
  const result = converter.toAlphaTex(picked.song);
  if (result.error){
    process.stderr.write('변환하지 못했습니다: ' + result.error + '\n');
    return 1;
  }
  if (options.output){
    try {
      fs.writeFileSync(options.output, result.tex, 'utf8');
    } catch (error) {
      process.stderr.write('출력 파일을 쓰지 못했습니다: ' + options.output + '\n');
      return 1;
    }
    process.stderr.write('저장했습니다: ' + options.output + '\n');
  } else {
    process.stdout.write(result.tex);
  }
  return 0;
}

module.exports = { songFromTsv: songFromTsv, songFromBuiltin: songFromBuiltin };

if (require.main === module) process.exitCode = main(process.argv);
