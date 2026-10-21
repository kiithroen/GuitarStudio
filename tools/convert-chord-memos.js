'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parser = require('../src/parser.js');

const CHORD_MEMO_RE = /(?:^|\s*·\s*|\s+)(\d+)박부터\s+([A-G][#b]?[A-Za-z0-9#+()/-]*)/g;

function convertMeasureChordMemos(line){
  if (typeof line !== 'string') return line;
  const decoded = parser.decodeMeasureLine(line);
  if (!decoded.lyric) return line;

  const matches = [];
  let m;
  CHORD_MEMO_RE.lastIndex = 0;
  while ((m = CHORD_MEMO_RE.exec(decoded.lyric)) !== null){
    matches.push({ beat: Number(m[1]), chord: m[2] });
  }

  if (!matches.length) return line;

  // lyric에서 해당 패턴과 구분자 제거
  const cleanedLyric = decoded.lyric.replace(CHORD_MEMO_RE, '');
  const remainingLyric = cleanedLyric
    .split(/\s*·\s*/)
    .map(function(s){ return s.trim(); })
    .filter(Boolean)
    .join(' · ');

  // 기존 chordRaw 파싱
  const chordByBeat = new Map();
  if (decoded.chordRaw != null && decoded.chordRaw !== ''){
    const parts = decoded.chordRaw.split(',');
    for (let i = 0; i < parts.length; i++){
      const part = parts[i].trim();
      if (!part) continue;
      const colonIdx = part.indexOf(':');
      let beat = null;
      let chordName = part;
      if (colonIdx >= 0){
        const bStr = part.slice(0, colonIdx).trim();
        chordName = part.slice(colonIdx + 1).trim();
        const num = Number(bStr);
        if (Number.isInteger(num)) beat = num;
      } else {
        if (i === 0) beat = 1;
      }
      if (beat != null && !chordByBeat.has(beat)){
        chordByBeat.set(beat, chordName);
      }
    }
  }

  // 메모에서 추출한 chord 매칭 병합 (중복 박자 방지)
  matches.forEach(function(entry){
    if (!chordByBeat.has(entry.beat)){
      chordByBeat.set(entry.beat, entry.chord);
    }
  });

  if (!chordByBeat.has(1)){
    chordByBeat.set(1, '-');
  }

  const sortedBeats = Array.from(chordByBeat.keys()).sort(function(a, b){ return a - b; });
  const chordParts = [];
  sortedBeats.forEach(function(b){
    const ch = chordByBeat.get(b);
    if (b === 1){
      chordParts.push(ch);
    } else {
      chordParts.push(b + ':' + ch);
    }
  });

  const chordBracket = '[' + chordParts.join(', ') + ']';
  const notation = decoded.notation;
  let result = chordBracket + (notation ? ' ' + notation : '');
  if (remainingLyric){
    result += ' | ' + JSON.stringify(remainingLyric);
  }
  return result;
}

function convertScoreText(text){
  if (typeof text !== 'string') return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.split(/\r?\n/).map(convertMeasureChordMemos).join(eol);
}

if (require.main === module){
  const args = process.argv.slice(2);
  let inPlace = false;
  let targetFile = null;
  for (let i = 0; i < args.length; i++){
    if (args[i] === '-i' || args[i] === '--in-place'){
      inPlace = true;
    } else if (!targetFile){
      targetFile = args[i];
    }
  }
  if (!targetFile){
    process.stderr.write('사용법: node tools/convert-chord-memos.js [-i] <파일경로>\n');
    process.exit(1);
  }
  const fullPath = path.resolve(process.cwd(), targetFile);
  const content = fs.readFileSync(fullPath, 'utf8');
  const converted = convertScoreText(content);
  if (inPlace){
    fs.writeFileSync(fullPath, converted, 'utf8');
  } else {
    process.stdout.write(converted);
  }
}

module.exports = {
  convertMeasureChordMemos: convertMeasureChordMemos,
  convertScoreText: convertScoreText
};
