'use strict';

// 원본 MIDI에서 내장곡 악보를 다시 만들어 songs.json 과 줄 단위로 견준다. songs.json 은 고치지 않는다.
// 사용: node tools/rebuild-builtins.js <원본 MIDI 폴더>
const fs = require('node:fs');
const path = require('node:path');
const converter = require('./midi-to-score.js');

const recipesPath = path.join(__dirname, 'builtin-recipes.json');
const songsPath = path.join(__dirname, '..', 'songs.json');

// 레시피 한 곡을 변환한다: 변환(+편집) -> 줄 수정 -> 줄 충돌 해소
function buildLines(recipe, midiBuffer) {
  const opt = recipe.options;
  const result = converter.convertMidi(converter.parseMidi(midiBuffer), {
    cells: opt.cells, pickup: opt.pickup, grace: opt.grace, transpose: opt.transpose,
    trackTranspose: opt.trackTranspose || {}, lowestOnly: opt.lowestOnly || [], downbeatOnly: opt.downbeatOnly || [], measureRange: opt.measureRange || null, edits: recipe.edits || []
  });
  let lines = result.measures.slice();
  (recipe.lineOverrides || []).forEach(function (ov) {
    const line = lines[ov.measure - 1];
    if (line === undefined) throw new Error('lineOverrides: 마디 ' + ov.measure + ' 없음');
    const bar = line.indexOf(' | "');
    const m = line.slice(0, bar).match(/^(\[[^\]]*\]\s+)(.*)$/);
    const cells = m[2].split(/\s+/);
    if (cells[ov.cell - 1] !== ov.from) {
      throw new Error('lineOverrides: ' + ov.measure + '마디 ' + ov.cell + '칸이 ' + ov.from + ' 이 아님: ' + cells[ov.cell - 1]);
    }
    cells[ov.cell - 1] = ov.to;
    lines[ov.measure - 1] = m[1] + cells.join(' ') + line.slice(bar);
  });
  let stops = [];
  if (opt.fixStrings) {
    const fixed = converter.fixStringCollisions(lines, opt.cells);
    lines = fixed.lines;
    stops = fixed.stops;
  }
  return { lines: lines, stops: stops };
}

function firstDifference(expected, actual) {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== actual[i]) {
      return { measure: i + 1, expected: expected[i], actual: actual[i] };
    }
  }
  return null;
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('사용: node tools/rebuild-builtins.js <원본 MIDI 폴더>');
    process.exit(2);
  }
  const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
  const songs = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
  let same = 0, differ = 0, missing = 0;
  recipes.forEach(function (recipe) {
    const file = path.join(dir, recipe.file);
    if (!fs.existsSync(file)) {
      missing++;
      console.log(recipe.id + ': 원본 없음 (' + recipe.file + ')');
      return;
    }
    const song = songs.find(function (s) { return s.id === recipe.id; });
    if (!song) {
      differ++;
      console.log(recipe.id + ': 불일치(songs.json 에 곡 없음)');
      return;
    }
    const built = buildLines(recipe, fs.readFileSync(file));
    built.stops.forEach(function (s) {
      console.log(recipe.id + ': 줄 충돌 미해결 ' + s.measure + '마디 ' + s.cell + '칸 ' + s.note + ' (' + s.reason + ')');
    });
    const diff = firstDifference(song.lines, built.lines);
    if (diff) {
      differ++;
      console.log(recipe.id + ': 불일치(' + diff.measure + ': 기대 ' + diff.expected + ' / 실제 ' + diff.actual + ')');
    } else {
      same++;
      console.log(recipe.id + ': 일치');
    }
  });
  console.log('결과: 일치 ' + same + ' · 불일치 ' + differ + ' · 원본 없음 ' + missing);
  if (differ > 0) process.exitCode = 1;
}

main();
