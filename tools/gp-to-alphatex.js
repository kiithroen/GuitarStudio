'use strict';

// Guitar Pro 파일(.gp .gp3 .gp4 .gp5 .gpx)에서 기타 트랙 하나를 골라 alphaTex 원본(.tex)으로 쓰는 도구.
// 사용: node tools/gp-to-alphatex.js <입력 파일> [--track n(1부터)] [-o 출력.tex]
// 읽기와 트랙 고르기는 tools/alphatab-to-score.js 의 것을 그대로 쓰고, 쓰기는 vendor alphaTab 의 AlphaTexExporter 다.
// 출력 파일이 이미 있으면 덮지 않는다(손본 원본을 지키려고). 흐름과 결정은 Docs/alphatab.md 의 "원본은 alphaTex" 절.
const fs = require('node:fs');
const path = require('node:path');
const alphaTab = require('../vendor/alphatab/dist/alphaTab.min.js');
const converter = require('./alphatab-to-score.js');

const GP_EXTENSIONS = ['.gp', '.gp3', '.gp4', '.gp5', '.gpx'];
const USAGE = '사용법: node tools/gp-to-alphatex.js <입력.gp|.gp3|.gp4|.gp5|.gpx> [--track n(1부터)] [-o 출력.tex]';

// 바이트에서 읽은 악보 하나를 alphaTex 글로 바꾼다. 고른 트랙만 남기고, 제목은 파일 이름으로 한다.
// 성공: { ok: true, tex, trackNumber(1부터), trackName, trackCount, trackList }, 실패: { ok: false, error }
function gpToAlphaTex(bytes, options){
  const opts = options || {};
  const fileName = opts.fileName ? String(opts.fileName) : '';
  if (!fileName) return { ok: false, error: '파일 이름이 필요합니다.' };
  try {
    const score = converter.parseScoreBytes(bytes);
    const trackList = converter.describeTracks(score);
    const trackCount = score.tracks.length;
    const picked = converter.selectStaff(score, opts.trackNumber);
    const trackNumber = score.tracks.indexOf(picked.track) + 1;

    // 고른 트랙만 남기고 인덱스를 맞춘다.
    score.tracks = [picked.track];
    picked.track.index = 0;

    const title = path.basename(fileName, path.extname(fileName));
    const originalTitle = String(score.title || '').trim();
    const notices = [];
    if (originalTitle && originalTitle !== title) notices.push('원제 ' + originalTitle);
    if (score.notices && String(score.notices).trim()) notices.push(String(score.notices).trim());
    notices.push('Guitar Pro 파일(' + fileName + ')에서 변환');
    score.title = title;
    score.notices = notices.join(' · ');

    const settings = new alphaTab.Settings();
    settings.core.logLevel = alphaTab.LogLevel.None;
    let tex = new alphaTab.exporter.AlphaTexExporter().exportToString(score, settings);
    tex = tex.replace(/\r\n?/g, '\n');
    if (!tex.endsWith('\n')) tex += '\n';
    return { ok: true, tex: tex, trackNumber: trackNumber, trackName: picked.track.name || '', trackCount: trackCount, trackList: trackList };
  } catch (error) {
    if (error instanceof converter.Refusal) return { ok: false, error: error.message };
    return { ok: false, error: '변환 중 오류가 났습니다: ' + (error && error.message ? error.message : error) };
  }
}

function parseArgs(argv){
  const options = { file: null, trackNumber: undefined, output: null };
  for (let i = 0; i < argv.length; i++){
    const arg = argv[i];
    if (arg === '--track'){
      const value = argv[++i];
      if (!/^[1-9]\d*$/.test(value || '')) return { error: '--track 은 1 이상의 정수가 필요합니다.' };
      options.trackNumber = Number(value);
    } else if (arg === '-o'){
      const value = argv[++i];
      if (!value) return { error: '-o 에 출력 파일이 필요합니다.' };
      options.output = value;
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
  if (GP_EXTENSIONS.indexOf(extension) < 0){
    process.stderr.write('지원하지 않는 확장자입니다: ' + (extension || '(없음)') + '\n' + USAGE + '\n');
    return 2;
  }
  let bytes;
  try {
    if (!fs.statSync(options.file).isFile()) throw new Error('not a file');
    bytes = fs.readFileSync(options.file);
  } catch (error) {
    process.stderr.write('파일을 읽지 못했습니다: ' + options.file + '\n');
    return 2;
  }
  const output = options.output || path.join(path.dirname(options.file), path.basename(options.file, path.extname(options.file)) + '.tex');
  if (fs.existsSync(output)){
    process.stderr.write('출력 파일이 이미 있어 덮어쓰지 않습니다: ' + output + '\n');
    return 1;
  }
  const result = gpToAlphaTex(bytes, { fileName: path.basename(options.file), trackNumber: options.trackNumber });
  if (!result.ok){
    process.stderr.write('변환하지 못했습니다: ' + result.error + '\n');
    return 1;
  }
  try {
    fs.writeFileSync(output, result.tex, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    process.stderr.write('출력 파일을 쓰지 못했습니다: ' + output + '\n');
    return 1;
  }
  process.stdout.write('만듦: ' + output + ' (트랙 ' + result.trackNumber + '/' + result.trackCount + ' "' + result.trackName + '")\n');
  if (result.trackCount > 1) process.stdout.write('트랙 목록(1부터):\n' + result.trackList + '\n');
  return 0;
}

module.exports = { gpToAlphaTex: gpToAlphaTex, GP_EXTENSIONS: GP_EXTENSIONS };

if (require.main === module) process.exitCode = main(process.argv);
