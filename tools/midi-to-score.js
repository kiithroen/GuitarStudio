'use strict';

// 표준 MIDI 파일(SMF)을 칸 격자 악보 줄로 바꾸는 도구.
// 사용: node tools/midi-to-score.js <파일.mid> [--cells N] [--pickup T] [--grace R] [--transpose N] [--edits 파일.json] [--fix-strings]
// --cells 를 생략하면 MIDI 정보만 출력한다. 결과는 표준 출력 JSON.
const fs = require('node:fs');
const parser = require('../src/parser.js');

function parseArgs(argv) {
  var o = { file: null, cells: 0, pickup: 0, grace: 0.125, transpose: 0, edits: null, fixStrings: false };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--cells') o.cells = parseInt(argv[++i], 10);
    else if (a === '--pickup') o.pickup = parseInt(argv[++i], 10);
    else if (a === '--grace') o.grace = parseFloat(argv[++i]);
    else if (a === '--transpose') o.transpose = parseInt(argv[++i], 10);
    else if (a === '--edits') o.edits = argv[++i];
    else if (a === '--fix-strings') o.fixStrings = true;
    else if (!o.file) o.file = a;
    else throw new Error('unknown arg ' + a);
  }
  return o;
}

// SMF 바이트열 읽기. 드럼 채널(9)은 버린다.
function parseMidi(buf) {
  var p = 0;
  function u32() { var v = buf.readUInt32BE(p); p += 4; return v; }
  function u16() { var v = buf.readUInt16BE(p); p += 2; return v; }
  if (buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('not MIDI');
  p = 4; var hl = u32(); var format = u16(); var ntrk = u16(); var ppq = u16();
  p = 8 + hl;
  if (ppq & 0x8000) throw new Error('SMPTE division not supported');
  var notes = [], tempos = [], timeSigs = [], keySigs = [], trackInfo = [];
  function readVar() { var v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; }
  for (var t = 0; t < ntrk; t++) {
    if (buf.toString('latin1', p, p + 4) !== 'MTrk') throw new Error('bad track');
    p += 4; var len = u32(); var end = p + len;
    var tick = 0, running = 0;
    var open = {};
    var tname = '', nnotes = 0;
    while (p < end) {
      tick += readVar();
      var st = buf[p];
      if (st === 0xff) {
        p++; var type = buf[p++]; var l = readVar(); var d = buf.slice(p, p + l); p += l;
        if (type === 0x51) tempos.push({ tick: tick, uspq: (d[0] << 16) | (d[1] << 8) | d[2] });
        else if (type === 0x58) timeSigs.push({ tick: tick, num: d[0], den: Math.pow(2, d[1]) });
        else if (type === 0x59) keySigs.push({ tick: tick, sf: d.readInt8(0), minor: d[1] });
        else if (type === 0x03) tname = d.toString('latin1');
        continue;
      }
      if (st === 0xf0 || st === 0xf7) { p++; var sl = readVar(); p += sl; continue; }
      if (st & 0x80) { running = st; p++; }
      var hi = running & 0xf0, ch = running & 0x0f;
      var d1 = buf[p++], d2 = 0;
      if (hi !== 0xc0 && hi !== 0xd0) d2 = buf[p++];
      if (hi === 0x90 && d2 > 0) {
        var key = ch + ':' + d1;
        (open[key] = open[key] || []).push({ start: tick, pitch: d1, ch: ch, vel: d2 });
      } else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
        var k2 = ch + ':' + d1;
        var q = open[k2];
        if (q && q.length) { var n = q.shift(); n.end = tick; if (ch !== 9) { notes.push(n); nnotes++; } }
      }
    }
    Object.keys(open).forEach(function (k) { open[k].forEach(function (n) { n.end = tick; if (n.ch !== 9) { notes.push(n); nnotes++; } }); });
    trackInfo.push({ name: tname, notes: nnotes });
    p = end;
  }
  return { format: format, ppq: ppq, notes: notes, tempos: tempos, timeSigs: timeSigs, keySigs: keySigs, tracks: trackInfo };
}

var SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
var FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
function noteName(m, flats) {
  return (flats ? FLAT : SHARP)[m % 12] + (Math.floor(m / 12) - 1);
}

function sortNotes(notes) {
  return notes.sort(function (a, b) { return a.start - b.start || a.pitch - b.pitch; });
}

// 원본 MIDI 요약(편집 전 기준)
function midiInfo(midi) {
  var ts = midi.timeSigs[0] || { num: 4, den: 4 };
  var ks = midi.keySigs[0] || { sf: 0, minor: 0 };
  var notes = sortNotes(midi.notes.slice());
  return {
    format: midi.format, ppq: midi.ppq, tracks: midi.tracks,
    timeSig: ts.num + '/' + ts.den, keySig: { sf: ks.sf, minor: ks.minor },
    timeSigCount: midi.timeSigs.length, keySigCount: midi.keySigs.length,
    tempoEvents: midi.tempos.map(function (t) { return { tick: t.tick, quarterBpm: 60000000 / t.uspq }; }),
    noteCount: notes.length,
    firstNoteTick: notes.length ? notes[0].start : null,
    endTick: notes.reduce(function (m, n) { return Math.max(m, n.end); }, 0),
    rawMinMidi: notes.length ? Math.min.apply(null, notes.map(function (n) { return n.pitch; })) : null,
    rawMaxMidi: notes.length ? Math.max.apply(null, notes.map(function (n) { return n.pitch; })) : null
  };
}

// options: { cells, pickup, grace, transpose, edits: [{op, start, pitch, ...}] }
function convertMidi(midi, options) {
  var o = Object.assign({ cells: 0, pickup: 0, grace: 0.125, transpose: 0, edits: [] }, options);
  if (!o.cells) throw new Error('cells is required');
  var ts = midi.timeSigs[0] || { num: 4, den: 4 };
  var ks = midi.keySigs[0] || { sf: 0, minor: 0 };
  var ppq = midi.ppq;
  var info = midiInfo(midi);
  // 편집이 입력 객체를 바꾸지 않게 복사한다
  var notes = sortNotes(midi.notes.map(function (n) { return Object.assign({}, n); }));
  var warnings = [];

  var editsApplied = [];
  if (o.edits && o.edits.length) {
    o.edits.forEach(function (e) {
      var hits = notes.filter(function (n) { return n.start === e.start && n.pitch === e.pitch; });
      if (hits.length !== 1) throw new Error('edit does not match exactly one note: ' + JSON.stringify(e) + ' hits=' + hits.length);
      var n = hits[0];
      var mi = Math.floor(n.start / (ppq * 4 * ts.num / ts.den)) + 1;
      var rec = { op: e.op, measureByRawTick: mi, start: e.start, pitch: e.pitch, name: noteName(e.pitch + o.transpose, ks.sf < 0), dur: n.end - n.start };
      if (e.op === 'drop') { notes.splice(notes.indexOf(n), 1); }
      else if (e.op === 'setStart') { rec.to = e.to; n.start = e.to; }
      else if (e.op === 'setEnd') { rec.to = e.to; n.end = e.to; }
      else if (e.op === 'split') { rec.at = e.at; var tail = { start: e.at, end: n.end, pitch: n.pitch, ch: n.ch, vel: n.vel }; n.end = e.at; notes.push(tail); }
      else throw new Error('unknown edit op ' + e.op);
      editsApplied.push(rec);
    });
    sortNotes(notes);
  }
  var uniqTs = {}; midi.timeSigs.forEach(function (t) { uniqTs[t.num + '/' + t.den] = 1; });
  if (Object.keys(uniqTs).length > 1) warnings.push('multiple time signatures: ' + Object.keys(uniqTs).join(','));
  var uniqT = {}; midi.tempos.forEach(function (t) { uniqT[t.uspq] = 1; });
  if (Object.keys(uniqT).length > 1) warnings.push('multiple tempos: ' + Object.keys(uniqT).length);
  if (midi.keySigs.length > 1) warnings.push('multiple key signatures: ' + midi.keySigs.length);

  var M = ppq * 4 * ts.num / ts.den;           // 마디 틱
  var cellLen = M / o.cells;
  var shift = o.pickup > 0 ? (M - o.pickup) : 0;
  var tol = cellLen / 48;
  var flats = ks.sf < 0;

  // 음 목록 (이동 반영)
  var ns = notes.map(function (n) { return { start: n.start + shift, end: n.end + shift, pitch: n.pitch + o.transpose }; });

  // 꾸밈음 판정: 길이 < grace*cellLen 이고 끝이 다음 onset(이 음보다 늦은 가장 가까운 onset)에 붙은 음
  var onsets = Array.from(new Set(ns.map(function (n) { return n.start; }))).sort(function (a, b) { return a - b; });
  var graceDropped = [];
  var kept = [];
  ns.forEach(function (n) {
    var dur = n.end - n.start;
    var next = null;
    for (var i = 0; i < onsets.length; i++) { if (onsets[i] > n.start) { next = onsets[i]; break; } }
    var isGrace = dur < o.grace * cellLen && next !== null && Math.abs(n.end - next) <= tol;
    if (isGrace) {
      var cpos = n.start / cellLen;
      var ci = Math.floor(cpos + 1 / 48);
      graceDropped.push({ measure: Math.floor(ci / o.cells) + 1, cell: (ci % o.cells) + 1, note: noteName(n.pitch, flats), durTicks: dur, startTick: n.start - shift });
    } else kept.push(n);
  });
  ns = kept;

  var endTick = ns.reduce(function (m, n) { return Math.max(m, n.end); }, 0);
  var nMeas = Math.ceil((endTick) / M - 1e-6);
  if (nMeas < 1) nMeas = 1;
  var totalCells = nMeas * o.cells;

  var minM = Infinity, maxM = -Infinity;
  ns.forEach(function (n) { minM = Math.min(minM, n.pitch); maxM = Math.max(maxM, n.pitch); });
  if (minM < 40 || maxM > 76) warnings.push('out of app range 40..76: min ' + minM + ' max ' + maxM);

  // 칸별 onset 묶기
  var cellsNotes = [];
  for (var c = 0; c < totalCells; c++) cellsNotes.push([]);
  ns.forEach(function (n) {
    var pos = n.start / cellLen;
    var ci = Math.floor(pos + 1 / 48);
    if (ci < 0) ci = 0;
    if (ci >= totalCells) ci = totalCells - 1;
    cellsNotes[ci].push({ frac: pos - ci, n: n });
  });

  var tokens = []; // 칸 문자열
  var everStarted = false;
  for (var ci = 0; ci < totalCells; ci++) {
    var list = cellsNotes[ci];
    var cellStart = ci * cellLen;
    // 분할 d 선택
    var chosen = 4, ok = false;
    for (var d = 1; d <= 4; d++) {
      var fit = list.every(function (e) {
        var g = e.frac * d;
        return Math.abs(g - Math.round(g)) * (cellLen / d) <= tol && Math.round(g) < d + 0.5;
      });
      if (fit) { chosen = d; ok = true; break; }
    }
    if (!ok) warnings.push('off-grid ' + (Math.floor(ci / o.cells) + 1) + ':' + ((ci % o.cells) + 1));
    var pieces = [];
    for (var j = 0; j < chosen; j++) pieces.push([]);
    list.forEach(function (e) {
      var j = Math.round(e.frac * chosen);
      if (j < 0) j = 0; if (j >= chosen) j = chosen - 1;
      pieces[j].push(e.n);
    });
    var toks = [];
    for (var j2 = 0; j2 < chosen; j2++) {
      var group = pieces[j2];
      var pStart = cellStart + j2 * cellLen / chosen;
      if (group.length) {
        var seen = {}, ps = [];
        group.forEach(function (n) { if (!seen[n.pitch]) { seen[n.pitch] = 1; ps.push(n.pitch); } });
        ps.sort(function (a, b) { return a - b; });
        toks.push(ps.map(function (m) { return noteName(m, flats); }).join('+'));
        everStarted = true;
      } else {
        var ringing = ns.some(function (n) { return n.start < pStart - tol && n.end > pStart + tol; });
        toks.push(ringing && everStarted ? '-' : 'r');
      }
    }
    tokens.push(toks.join('/'));
  }

  var measures = [];
  for (var m = 0; m < nMeas; m++) {
    measures.push('[-] ' + tokens.slice(m * o.cells, (m + 1) * o.cells).join(' ') + ' | ""');
  }

  var tempoQ = midi.tempos.length ? 60000000 / midi.tempos[0].uspq : 120;
  var cellQuarters = (4 * ts.num / ts.den) / o.cells;
  var bpmRaw = tempoQ / cellQuarters;
  var bpm = Math.round(bpmRaw);
  if (bpm < 30 || bpm > 240) warnings.push('bpm out of 30..240: ' + bpmRaw.toFixed(2));
  if (!midi.tempos.length) warnings.push('no tempo event; BPM defaulted from 120');

  return {
    cells: o.cells, bpm: bpm, measures: measures,
    minMidi: minM, maxMidi: maxM, ppq: ppq,
    timeSig: ts.num + '/' + ts.den, keySig: { sf: ks.sf, minor: ks.minor },
    tempoBpmQuarter: tempoQ, bpmRaw: bpmRaw,
    options: { cells: o.cells, pickup: o.pickup, grace: o.grace, transpose: o.transpose },
    measureCount: nMeas, noteCount: ns.length, firstNoteTick: info.firstNoteTick, endTick: info.endTick,
    graceDropped: graceDropped, editsApplied: editsApplied, warnings: warnings
  };
}

// 한 화음에서 기본 줄이 겹치는 음 중 낮은 음에 @줄을 붙인다.
// 높은 음 줄보다 번호가 큰 줄 중 0~12프렛으로 칠 수 있는 가장 작은 번호이고, 연쇄 충돌도 같은 규칙으로 푼다.
// lines: 마디 줄 배열("[코드] 칸 칸 … | \"메모\""), beats: 한 마디의 칸 수(맞지 않으면 오류).
// 반환: { lines, added, stops }. stops 는 풀지 못한 충돌.
function fixStringCollisions(lines, beats) {
  var OPEN = {};
  parser.STRINGS.forEach(function (s) { OPEN[s.str] = s.midi; });
  var added = [], stops = [];
  var out = lines.map(function (line, mi) {
    var bar = line.indexOf(' | "');
    var head = line.slice(0, bar), tail = line.slice(bar);
    var m = head.match(/^(\[[^\]]*\]\s+)(.*)$/);
    var cells = m[2].split(/\s+/);
    if (beats && cells.length !== beats) throw new Error('measure ' + (mi + 1) + ' has ' + cells.length + ' cells, expected ' + beats);
    cells = cells.map(function (cell, ci) {
      var pieces = cell.split('/');
      pieces = pieces.map(function (piece) {
        var toks = piece.split('+');
        if (toks.length < 2) return piece;
        var info = toks.map(function (t) { var p = parser.parseNoteToken(t, 0); return { tok: t, midi: p.midi, str: p.pos.str, explicit: t.indexOf('@') >= 0 }; });
        var order = info.slice().sort(function (a, b) { return b.midi - a.midi; });
        var used = {};
        order.forEach(function (n) {
          if (n.explicit) { used[n.str] = true; return; }
          if (!used[n.str]) { used[n.str] = true; return; }
          // 겹침: 이 음의 기본 줄은 더 높은 음이 이미 쓰고 있다
          var s0 = n.str, chosen = null;
          for (var s = s0 + 1; s <= 6; s++) {
            var fret = n.midi - OPEN[s];
            if (fret >= 0 && fret <= 12) { chosen = s; break; }
          }
          if (!chosen || used[chosen]) { stops.push({ measure: mi + 1, cell: ci + 1, piece: piece, note: n.tok, reason: chosen ? 'candidate string ' + chosen + ' also occupied' : 'no string' }); return; }
          used[chosen] = true;
          n.newStr = chosen;
          added.push({ measure: mi + 1, cell: ci + 1, note: n.tok, defaultString: s0, assigned: chosen, fret: n.midi - OPEN[chosen] });
        });
        return info.map(function (n) { return n.newStr ? n.tok.replace(/^([^@:?]*)/, '$1@' + n.newStr) : n.tok; }).join('+');
      });
      return pieces.join('/');
    });
    return m[1] + cells.join(' ') + tail;
  });
  return { lines: out, added: added, stops: stops };
}

function main() {
  var o = parseArgs(process.argv.slice(2));
  if (!o.file) throw new Error('usage: node tools/midi-to-score.js <file.mid> [--cells N] [--pickup T] [--grace R] [--transpose N] [--edits file.json] [--fix-strings]');
  var midi = parseMidi(fs.readFileSync(o.file));
  if (!o.cells) { console.log(JSON.stringify(midiInfo(midi), null, 1)); return; }
  var edits = o.edits ? JSON.parse(fs.readFileSync(o.edits, 'utf8')) : [];
  var result = convertMidi(midi, { cells: o.cells, pickup: o.pickup, grace: o.grace, transpose: o.transpose, edits: edits });
  var stops = [];
  if (o.fixStrings) {
    var fixed = fixStringCollisions(result.measures, o.cells);
    result.measures = fixed.lines;
    result.addedStrings = fixed.added;
    stops = fixed.stops;
  }
  console.log(JSON.stringify(result, null, 1));
  if (stops.length) {
    console.error(JSON.stringify({ stops: stops }));
    process.exitCode = 2;
  }
}

module.exports = { parseMidi: parseMidi, convertMidi: convertMidi, midiInfo: midiInfo, fixStringCollisions: fixStringCollisions };

if (require.main === module) main();
