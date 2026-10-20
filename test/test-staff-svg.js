const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const layoutApi = require('../src/staff-layout.js');
const svgApi = require('../src/staff-svg.js');

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

const WIDTH_PER_CELL = 60;
const LEFT_PAD = 30;
const BEAM_LEVEL = { eighth: 1, '16th': 2, '32nd': 3 };

function layout(text, beats, key){
  const result = layoutApi.layoutScore(text, beats == null ? 4 : beats, key == null ? 0 : key);
  assert.equal(result.error, undefined, 'layout error: ' + result.error);
  return result;
}

// 한 마디를 그린다. 첫 마디만 머리(음자리표·조표·박자표)를 단다.
function draw(result, measureIndex){
  const measure = result.measures[measureIndex || 0];
  const header = (measureIndex || 0) === 0 ? { key: result.key, time: result.time } : null;
  const leftPad = LEFT_PAD + svgApi.headerWidth(header);
  const width = leftPad + result.beats * WIDTH_PER_CELL + 4;
  return svgApi.renderMeasure(measure, {
    width: width, leftPad: leftPad, header: header,
    xAt: function(cell, unit){ return leftPad + cell * WIDTH_PER_CELL + WIDTH_PER_CELL * unit / 12 + 12; }
  });
}

function count(svg, className){
  const matches = svg.match(new RegExp('class="' + className + '(?:[" ])', 'g'));
  return matches ? matches.length : 0;
}

// 배치에서 센 기대값
function expected(measure){
  const out = { heads: 0, ledger: 0, acc: 0, ties: 0, slurs: (measure.slurs || []).filter(function(entry){ return entry.kind !== 'slide'; }).length, slides: (measure.slurs || []).filter(function(entry){ return entry.kind === 'slide'; }).length, rolls: 0, rests: 0, tuplets: measure.tuplets.length, beams: 0, flags: 0, stems: 0, uncertainHeads: 0, uncertainRests: 0, dots: 0 };
  const inBeam = new Set();
  measure.beams.forEach(function(beam){
    beam.items.forEach(function(index){ inBeam.add(index); });
    const max = Math.max.apply(null, beam.levels);
    for (let level = 1; level <= max; level++){
      let open = false;
      beam.levels.forEach(function(itemLevel){
        if (itemLevel >= level){ if (!open){ out.beams++; open = true; } } else open = false;
      });
    }
  });
  measure.items.forEach(function(item, index){
    if (item.type === 'rest'){
      out.rests++;
      if (item.uncertain) out.uncertainRests++;
      if (item.value.dots) out.dots++;
      return;
    }
    out.heads += item.notes.length;
    item.notes.forEach(function(note){
      out.ledger += note.ledger.length;
      if (note.accidental) out.acc++;
      if (item.tieToNext) out.ties++;
      if (item.tieFromPrev && index === 0) out.ties++;
    });
    if (item.stem) out.stems++;
    if (item.roll) out.rolls++;
    out.uncertainHeads += item.notes.filter(function(note){ return note.uncertain; }).length;
    if (BEAM_LEVEL[item.value.base] && !inBeam.has(index)) out.flags += BEAM_LEVEL[item.value.base];
  });
  return out;
}

function checkCounts(svg, measure, label){
  const want = expected(measure);
  assert.equal(count(svg, 'st-line'), 5, label + ': five staff lines');
  assert.equal(count(svg, 'st-bar'), 2, label + ': two barlines');
  assert.equal(count(svg, 'st-head'), want.heads, label + ': heads');
  assert.equal(count(svg, 'st-ledger'), want.ledger, label + ': ledger lines');
  assert.equal(count(svg, 'st-acc'), want.acc, label + ': accidentals');
  assert.equal(count(svg, 'st-tie'), want.ties, label + ': ties');
  assert.equal(count(svg, 'st-slur'), want.slurs, label + ': slur curves');
  assert.equal(count(svg, 'st-slide'), want.slides, label + ': slide lines');
  assert.equal(count(svg, 'st-roll'), want.rolls, label + ': roll waves');
  assert.equal(count(svg, 'st-rest'), want.rests, label + ': rests');
  assert.equal(count(svg, 'st-tuplet'), want.tuplets, label + ': tuplet numbers');
  assert.equal(count(svg, 'st-beam'), want.beams, label + ': beams');
  assert.equal(count(svg, 'st-flag'), want.flags, label + ': flags');
  assert.equal(count(svg, 'st-stem'), want.stems, label + ': stems');
  assert.equal((svg.match(/class="st-head[^"]*is-uncertain/g) || []).length, want.uncertainHeads, label + ': uncertain heads');
  assert.equal((svg.match(/class="st-rest[^"]*is-uncertain/g) || []).length, want.uncertainRests, label + ': uncertain rests');
}

test('public api and size', function(){
  assert.equal(typeof svgApi.renderMeasure, 'function');
  assert.equal(typeof svgApi.headerWidth, 'function');
  assert.equal(typeof svgApi.STAFF_HEIGHT, 'number');
  assert.equal(svgApi.headerWidth(null), 0);
  assert.ok(svgApi.headerWidth({ key: 3, time: { numerator: 4, denominator: 4 } }) > svgApi.headerWidth({ key: 0, time: { numerator: 4, denominator: 4 } }), 'a key signature widens the header');
  assert.equal(svgApi.headerWidth({ key: -3, time: { numerator: 4, denominator: 4 } }), svgApi.headerWidth({ key: 3, time: { numerator: 4, denominator: 4 } }), 'sharps and flats take the same width');
  const svg = draw(layout('E4 r r r'));
  assert.match(svg, /^<svg [^>]*height="128"/, 'the svg height is STAFF_HEIGHT');
  assert.ok(svg.endsWith('</svg>'));
});

test('lines, heads, stems and the header of a simple measure', function(){
  const result = layout('G3 A3 B3 C4');
  const svg = draw(result);
  checkCounts(svg, result.measures[0], 'quarters');
  assert.equal(count(svg, 'st-head'), 4);
  assert.equal(count(svg, 'st-clef'), 1, 'one clef in the first measure');
  assert.equal(count(svg, 'st-key'), 0, 'no key signature');
  assert.equal(count(svg, 'st-time'), 1);
  assert.match(svg, /<text class="st-time-top"[^>]*>4<\/text>/);
  assert.match(svg, /<text class="st-time-bottom"[^>]*>4<\/text>/);
  const later = layout('G3 A3 B3 C4\nG3 A3 B3 C4');
  const second = draw(later, 1);
  assert.equal(count(second, 'st-clef'), 0, 'no clef after the first measure');
  assert.equal(count(second, 'st-time'), 0);
  checkCounts(second, later.measures[1], 'second measure');
});

test('key signature draws one symbol per sharp or flat', function(){
  [-5, -3, -1, 0, 2, 5].forEach(function(key){
    const result = layout('G3 A3 B3 C4', 4, key);
    const svg = draw(result);
    assert.equal(count(svg, 'st-key'), Math.abs(key), 'key ' + key);
    assert.equal(count(svg, 'st-clef'), 1);
  });
  const flats = draw(layout('G3 A3 B3 C4', 4, -2));
  assert.equal((flats.match(/♭/g) || []).length, 2);
  const sharps = draw(layout('G3 A3 B3 C4', 4, 2));
  assert.equal((sharps.match(/♯/g) || []).length, 2);
});

test('ledger lines, accidentals, dots and open heads', function(){
  const low = layout('E2 F#2 G2 r');
  const svgLow = draw(low);
  checkCounts(svgLow, low.measures[0], 'low notes');
  assert.ok(count(svgLow, 'st-ledger') >= 3, 'E2 sits on three ledger lines');
  const high = layout('E5 D5 C5 B4');
  checkCounts(draw(high), high.measures[0], 'high notes');
  const flat = layout('Bb3 B3 Bb3 r', 4, 0);
  const svgFlat = draw(flat);
  checkCounts(svgFlat, flat.measures[0], 'accidentals');
  assert.equal(count(svgFlat, 'st-acc'), 3, 'flat, natural, flat again');
  const long = layout('E4 - - r');
  const svgLong = draw(long);
  checkCounts(svgLong, long.measures[0], 'dotted half');
  assert.equal(count(svgLong, 'st-dot'), 1, 'a dotted half has one dot');
  assert.equal((svgLong.match(/is-open/g) || []).length, 1, 'a half note head is open');
  const whole = layout('E4 - - -');
  const svgWhole = draw(whole);
  assert.equal((svgWhole.match(/is-open/g) || []).length, 1);
  assert.equal(count(svgWhole, 'st-stem'), 0, 'no stem on a whole note');
});

test('natural harmonic heads are diamonds (polygon, is-harmonic) with the same center as a plain head', function(){
  const HARMONICS = require('../src/notation.js').NATURAL_HARMONICS;
  const parser = require('../src/parser.js');
  const fret = Number(Object.keys(HARMONICS)[Object.keys(HARMONICS).length - 1]);
  const string = parser.STRINGS[1];
  const soundName = parser.noteNameForMidi(string.midi + HARMONICS[fret], false);
  const handName = parser.noteNameForMidi(string.midi + fret, false);
  const harmonicLayout = layout('h' + soundName + '@' + string.str + ' r r r');
  const svg = draw(harmonicLayout);
  checkCounts(svg, harmonicLayout.measures[0], 'harmonic');
  assert.equal((svg.match(/<polygon class="st-head[^"]*is-harmonic/g) || []).length, 1, 'one diamond head');
  assert.equal((svg.match(/<ellipse class="st-head/g) || []).length, 0, 'no ellipse head');
  const plainSvg = draw(layout(handName + '@' + string.str + ' r r r'));
  assert.equal((plainSvg.match(/<ellipse class="st-head/g) || []).length, 1);
  assert.equal((plainSvg.match(/is-harmonic/g) || []).length, 0, 'a plain note has no harmonic class');
  const ellipse = plainSvg.match(/<ellipse class="st-head[^>]*cx="([\d.]+)" cy="([\d.]+)" rx="([\d.]+)" ry="([\d.]+)"/);
  const points = svg.match(/<polygon class="st-head[^>]*points="([^"]+)"/)[1].split(' ').map(function(pair){ return pair.split(',').map(Number); });
  assert.equal(points.length, 4);
  const xs = points.map(function(p){ return p[0]; }), ys = points.map(function(p){ return p[1]; });
  const near = function(a, b){ return Math.abs(a - b) < 0.11; };
  assert.ok(near((Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, Number(ellipse[1])), 'same center x');
  assert.ok(near((Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2, Number(ellipse[2])), 'same center y');
  assert.ok(near((Math.max.apply(null, xs) - Math.min.apply(null, xs)) / 2, Number(ellipse[3])), 'same horizontal radius');
  assert.ok(near((Math.max.apply(null, ys) - Math.min.apply(null, ys)) / 2, Number(ellipse[4])), 'same vertical radius');
  // 빈 머리(온음표)와 확인 표시
  const wholeLayout = layout('h' + soundName + '@' + string.str + ' - - -');
  const wholeSvg = draw(wholeLayout);
  checkCounts(wholeSvg, wholeLayout.measures[0], 'harmonic whole');
  assert.match(wholeSvg, /<polygon class="st-head is-open is-harmonic"[^>]*fill="none"/, 'an open diamond keeps fill none');
  const unsure = draw(layout('h' + soundName + '@' + string.str + '? r r r'));
  assert.match(unsure, /<polygon class="st-head is-uncertain is-harmonic"/, 'uncertain mark keeps its class on the diamond');
});

test('chords: second intervals stay beside the stem, every note has a head', function(){
  const chord = layout('E4+F4+G4 r r r');
  const svg = draw(chord);
  checkCounts(svg, chord.measures[0], 'cluster');
  const xs = (svg.match(/<ellipse class="st-head[^>]* cx="([\d.]+)"/g) || []).map(function(match){ return Number(match.match(/cx="([\d.]+)"/)[1]); });
  assert.equal(xs.length, 3);
  assert.equal(new Set(xs).size, 2, 'adjacent steps use two columns');
  const spread = layout('E2+B3+E5 r r r');
  checkCounts(draw(spread), spread.measures[0], 'wide chord');
  const dataNotes = (draw(chord).match(/data-note="\d"/g) || []).map(function(item){ return item.replace(/\D/g, ''); }).sort();
  assert.deepEqual(dataNotes, ['0', '1', '2'], 'data-note numbers the chord members');
});

test('beams, flags and tuplet numbers', function(){
  const beamed = layout('E4/F4 G4/A4 B3/C4 D4/E4');
  checkCounts(draw(beamed), beamed.measures[0], 'eighth pairs');
  assert.equal(count(draw(beamed), 'st-beam'), 4);
  const dotted = layout('E4/-/-/F4 r r r');
  const svgDotted = draw(dotted);
  checkCounts(svgDotted, dotted.measures[0], 'dotted eighth and sixteenth');
  assert.equal(count(svgDotted, 'st-beam'), 2, 'a main beam and a short second beam');
  const triplet = layout('E4/F4/G4 r r r');
  const svgTriplet = draw(triplet);
  checkCounts(svgTriplet, triplet.measures[0], 'triplet');
  assert.equal(count(svgTriplet, 'st-tuplet'), 1);
  const lone = layout('E4/r G4 r r');
  const svgLone = draw(lone, 0);
  checkCounts(svgLone, lone.measures[0], 'lone eighth');
  assert.equal(count(svgLone, 'st-flag'), 1, 'an unbeamed eighth gets one flag');
  const mixed = layout('E4/F4/- G4 A4 r');
  checkCounts(draw(mixed), mixed.measures[0], 'quarter-eighth triplet');
});

test('ties inside a measure and across the barline', function(){
  const across = layout('r r r E4\n- r r r');
  checkCounts(draw(across, 0), across.measures[0], 'tie to the right edge');
  checkCounts(draw(across, 1), across.measures[1], 'tie from the left edge');
  assert.equal(count(draw(across, 0), 'st-tie'), 1);
  assert.equal(count(draw(across, 1), 'st-tie'), 1);
  const inside = layout('F#3 - - - - - - - -', 9, 0);
  const svgInside = draw(inside);
  checkCounts(svgInside, inside.measures[0], 'tie inside a measure');
  assert.ok(count(svgInside, 'st-tie') >= 1);
  const chordTie = layout('E3+B3 - - -\n- r r r');
  assert.equal(count(draw(chordTie, 0), 'st-tie'), 2, 'a held whole-note chord ties both notes to the barline');
  const chordAcross = layout('r r r E3+B3\n- r r r');
  assert.equal(count(draw(chordAcross, 0), 'st-tie'), 2, 'one tie per chord note');
});

test('rests and check marks', function(){
  const rests = layout('E4 r r r');
  const svgRests = draw(rests);
  checkCounts(svgRests, rests.measures[0], 'half dotted rest');
  assert.ok(svgRests.includes('𝄼'), 'the half rest glyph is used');
  const whole = layout('r r r r');
  const svgWhole = draw(whole);
  checkCounts(svgWhole, whole.measures[0], 'whole rest');
  assert.ok(svgWhole.includes('𝄻'), 'the whole rest glyph is used');
  const marks = layout('E4? r? r r');
  const svgMarks = draw(marks);
  checkCounts(svgMarks, marks.measures[0], 'check marks');
  assert.equal((svgMarks.match(/is-uncertain/g) || []).length, 2, 'one note head and one rest are marked');
  const partial = layout('E4+G4? r r r');
  const svgPartial = draw(partial);
  checkCounts(svgPartial, partial.measures[0], 'chord with one checked note');
  assert.equal((svgPartial.match(/class="st-head[^"]*is-uncertain/g) || []).length, 1, 'only the checked note of a chord is marked');
  assert.equal(count(svgPartial, 'st-head'), 2);
  const sixteenth = layout('E4/-/-/- r r r');
  const quarterRest = layout('r E4 r r');
  assert.ok(draw(quarterRest).includes('𝄽'), 'the quarter rest glyph is used');
  checkCounts(draw(sixteenth), sixteenth.measures[0], 'eighth chord');
});

test('renderHeader draws the clef, key and an optional time signature', function(){
  assert.equal(typeof svgApi.renderHeader, 'function');
  const time = { numerator: 3, denominator: 4 };
  const withTime = svgApi.renderHeader({ key: 2, time: time });
  assert.equal(count(withTime, 'st-clef'), 1);
  assert.equal(count(withTime, 'st-key'), 2);
  assert.equal(count(withTime, 'st-time'), 1);
  assert.match(withTime, /<text class="st-time-top"[^>]*>3<\/text>/);
  assert.match(withTime, /^<svg [^>]*height="128"/, 'the header svg height is STAFF_HEIGHT');
  const noTime = svgApi.renderHeader({ key: 2, time: null });
  assert.equal(count(noTime, 'st-clef'), 1);
  assert.equal(count(noTime, 'st-key'), 2);
  assert.equal(count(noTime, 'st-time'), 0);
  assert.ok(svgApi.headerWidth({ key: 2, time: null }) < svgApi.headerWidth({ key: 2, time: time }), 'no time signature makes the header narrower');
  assert.match(withTime, new RegExp('^<svg [^>]*width="' + svgApi.headerWidth({ key: 2, time: time }) + '"'), 'the svg is as wide as headerWidth');
  assert.equal(count(withTime, 'st-line'), 5);
});

test('every built-in song draws with the counts the layout predicts', function(){
  const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '../songs.json'), 'utf8'));
  let measures = 0;
  songs.forEach(function(song){
    const result = layoutApi.layoutScore(song.lines.join('\n'), song.beats, 0);
    assert.equal(result.error, undefined, song.id);
    result.measures.forEach(function(measure, index){
      checkCounts(draw(result, index), measure, song.id + ' measure ' + (index + 1));
      measures++;
    });
  });
  assert.ok(measures > 500, 'drew many measures');
  process.stdout.write('  built-in measures: ' + measures + '\n');
});

test('the highest guitar note fits inside the SVG with its ledger lines, head and stem', function(){
  const parser = require('../src/parser.js');
  const top = parser.noteNameForMidi(parser.STRINGS[0].midi + require('../src/notation.js').MAX_FRET, false);
  const texts = [
    top + ' - - -',
    top + '/' + top + ' - - -',
    top + '/' + top + '/' + top + ' - - -',
    top + '/' + top + '/' + top + '/' + top + ' - - -',
    top + '? - - -'
  ];
  texts.forEach(function(text){
    const result = layout(text);
    const svg = draw(result);
    checkCounts(svg, result.measures[0], text);
    const values = function(className, attr){
      const out = [];
      const tagRe = new RegExp('<[a-z]+ class="' + className + '[" ][^>]*>', 'g');
      (svg.match(tagRe) || []).forEach(function(tag){
        const m = tag.match(new RegExp(' ' + attr + '="([-0-9.]+)"'));
        if (m) out.push(Number(m[1]));
      });
      return out;
    };
    const topLedgers = result.measures[0].items[0].notes.reduce(function(max, note){ return Math.max(max, note.ledger.length); }, 0);
    assert.ok(topLedgers >= 5, text + ': the highest note has its upper ledger lines');
    ['y1', 'y2'].forEach(function(attr){
      values('st-ledger', attr).forEach(function(y){ assert.ok(y >= 0 && y <= svgApi.STAFF_HEIGHT, text + ': ledger ' + attr + ' ' + y + ' is inside the SVG'); });
      values('st-stem', attr).forEach(function(y){ assert.ok(y >= 0 && y <= svgApi.STAFF_HEIGHT, text + ': stem ' + attr + ' ' + y + ' is inside the SVG'); });
    });
    values('st-head', 'cy').forEach(function(y){ assert.ok(y - svgApi.LINE_GAP / 2 >= 0 && y + svgApi.LINE_GAP / 2 <= svgApi.STAFF_HEIGHT, text + ': head cy ' + y + ' is inside the SVG'); });
  });
});

// 슬러 곡선: 도착 음의 기둥이 위면 머리 아래, 아래면 위. 마디를 넘으면 반쪽씩.
function slurPaths(svg){
  const out = [];
  (svg.match(/<path class="st-slur[^"]*"[^>]*>/g) || []).forEach(function(tag){
    const cls = tag.match(/class="([^"]*)"/)[1];
    const d = tag.match(/ d="([^"]*)"/)[1];
    const nums = d.match(/-?[0-9.]+/g).map(Number);   // M x y C x y x y x y
    assert.equal(nums.length, 8, 'a slur path is one cubic curve: ' + d);
    out.push({ cls: cls, d: d, x1: nums[0], y1: nums[1], c1y: nums[3], c2y: nums[5], x2: nums[6], y2: nums[7], all: nums });
  });
  return out;
}
function headYs(svg){
  return (svg.match(/<(?:ellipse|polygon) class="st-head[^>]*>/g) || []).map(function(tag){ return Number(tag.match(/ cy="([-0-9.]+)"/)[1]); });
}

test('slur curve: below the heads when the target stem is up, above when it is down, above for a stemless whole note', function(){
  const low = layout('G3 sA3 - -');
  assert.equal(low.measures[0].items[1].stem, 'up');
  const lowSvg = draw(low);
  checkCounts(lowSvg, low.measures[0], 'low slur');
  const lowPaths = slurPaths(lowSvg);
  assert.equal(lowPaths.length, 1);
  const lowHeads = headYs(lowSvg);
  assert.equal(lowPaths[0].cls, 'st-slur', 'a slur inside the measure has no half class');
  assert.ok(lowPaths[0].y1 > lowHeads[0] && lowPaths[0].y2 > lowHeads[1], 'the ends sit under the heads');
  assert.ok(lowPaths[0].c1y > lowHeads[0] && lowPaths[0].c2y > lowHeads[1], 'the control points are under the heads');
  assert.ok(lowPaths[0].c1y > lowPaths[0].y1, 'the curve bulges downward');

  const high = layout('B4 sC5 - -');
  assert.equal(high.measures[0].items[1].stem, 'down');
  const highSvg = draw(high);
  const highPaths = slurPaths(highSvg);
  const highHeads = headYs(highSvg);
  assert.ok(highPaths[0].y1 < highHeads[0] && highPaths[0].y2 < highHeads[1], 'the ends sit over the heads');
  assert.ok(highPaths[0].c1y < highHeads[0] && highPaths[0].c2y < highHeads[1], 'the control points are over the heads');

  const whole = layout('r r r E4\nsF4 - - -');
  assert.equal(whole.measures[1].items[0].stem, null);
  const wholeSvg = draw(whole, 1);
  const wholePaths = slurPaths(wholeSvg);
  assert.equal(wholePaths.length, 1);
  assert.ok(wholePaths[0].c1y < headYs(wholeSvg)[0], 'a stemless target gets the curve above');
});

test('slur curve: only the target note of a chord is curved, and the curve follows that head', function(){
  const result = layout('E2@6+E4@1 E2@6+sF4@1 - r');
  const svg = draw(result);
  checkCounts(svg, result.measures[0], 'chord slur');
  const paths = slurPaths(svg);
  assert.equal(paths.length, 1);
  const stem = result.measures[0].items[1].stem;
  const heads = (svg.match(/<(?:ellipse|polygon) class="st-head[^>]*data-note="1"[^>]*>/g) || []).map(function(tag){ return Number(tag.match(/ cy="([-0-9.]+)"/)[1]); });
  assert.equal(heads.length, 2, 'the upper heads of both chords');
  assert.ok(Math.abs(paths[0].y1 - heads[0]) < 10 && Math.abs(paths[0].y2 - heads[1]) < 10, 'the curve ends sit next to the upper heads');
  assert.equal(paths[0].y2 > heads[1], stem === 'up');
});

test('slur curve across the barline: a half leaves through the right edge, a half enters from the left', function(){
  const result = layout('r r r E4\nsF4 - - -');
  const first = draw(result, 0), second = draw(result, 1);
  checkCounts(first, result.measures[0], 'source measure');
  checkCounts(second, result.measures[1], 'target measure');
  const out = slurPaths(first);
  const into = slurPaths(second);
  assert.equal(out.length, 1);
  assert.equal(into.length, 1);
  assert.equal(out[0].cls, 'st-slur is-start');
  assert.equal(into[0].cls, 'st-slur is-end');
  const widthOf = function(svg){ return Number(svg.match(/^<svg [^>]*width="([0-9.]+)"/)[1]); };
  assert.equal(out[0].x2, widthOf(first) - 2, 'the outgoing half ends 2px before the right edge');
  assert.equal(out[0].y2, out[0].y1, 'the outgoing half stays level');
  assert.equal(into[0].x1, LEFT_PAD + 2, 'the incoming half starts 2px after the left edge of the first event area');
  assert.equal(into[0].y2, into[0].y1, 'the incoming half stays level');
  const held = layout('r r r E4\n- - - -\nsF4 - - -');
  assert.deepEqual(slurPaths(draw(held, 1)).map(function(p){ return p.cls; }), ['st-slur is-start'], 'a held measure between the halves draws only the outgoing half');
  assert.deepEqual(slurPaths(draw(held, 2)).map(function(p){ return p.cls; }), ['st-slur is-end']);
});

test('slur curve height: grows with the span up to a cap, and every coordinate stays inside the SVG', function(){
  const near = slurPaths(draw(layout('G3 sA3 - -')))[0];
  const wide = slurPaths(draw(layout('G3 - - sA3')))[0];
  const rise = function(p){ return Math.abs(((p.c1y + p.c2y) / 2 - (p.y1 + p.y2) / 2) * 0.75); };
  assert.ok(rise(wide) > rise(near), 'a wider slur arches higher');
  assert.ok(rise(wide) <= 10 + 0.1, 'the arch height is capped');
  // 높은 음 위로 그리는 곡선은 그림 높이 안으로 자른다
  const result = layout('A5 sB5 - -');
  const high = slurPaths(draw(result));
  assert.equal(high.length, 1);
  assert.equal(result.measures[0].items[1].stem, 'down');
  high[0].all.forEach(function(value, index){
    if (index % 2 === 1) assert.ok(value >= 0 && value <= svgApi.STAFF_HEIGHT, 'y ' + value + ' is inside the SVG');
  });
  assert.equal(Math.min(high[0].y1, high[0].c1y, high[0].c2y, high[0].y2), 2, 'the top is cut to 2px from the edge');
});

// 롤 물결선: 롤 화음 머리(임시표가 있으면 그 임시표) 왼쪽의 세로 물결. 화음마다 <g class="st-chord"> 안에 있다.
function chordGroups(svg){
  return svg.split('<g class="st-chord"').slice(1).map(function(part){ return part.slice(0, part.indexOf('</g>')); });
}
// 물결선 path 의 d(M, Q, T 절대 좌표)에서 끝점과 제어점을 모두 뽑는다. T 의 제어점은 앞 제어점을 현재 점에 대해 뒤집은 것이다.
function wavePoints(d){
  const points = [];
  let cur = null, control = null;
  (d.match(/[MQT][^MQT]*/g) || []).forEach(function(seg){
    const nums = seg.slice(1).trim().split(/[ ,]+/).map(Number);
    if (seg[0] === 'M'){ cur = { x: nums[0], y: nums[1] }; points.push(cur); return; }
    if (seg[0] === 'Q'){ control = { x: nums[0], y: nums[1] }; cur = { x: nums[2], y: nums[3] }; }
    else { control = { x: 2 * cur.x - control.x, y: 2 * cur.y - control.y }; cur = { x: nums[0], y: nums[1] }; }
    points.push(control, cur);
  });
  return points;
}
function chordFacts(group){
  const heads = (group.match(/<(?:ellipse|polygon) class="st-head[^>]*>/g) || []).map(function(tag){
    if (tag.startsWith('<ellipse')) return { x: Number(tag.match(/ cx="([-0-9.]+)"/)[1]), y: Number(tag.match(/ cy="([-0-9.]+)"/)[1]), rx: Number(tag.match(/ rx="([-0-9.]+)"/)[1]) };
    const pts = tag.match(/points="([^"]+)"/)[1].split(' ').map(function(pair){ return pair.split(',').map(Number); });
    const xs = pts.map(function(q){ return q[0]; }), ys = pts.map(function(q){ return q[1]; });
    return { x: (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, y: (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2, rx: (Math.max.apply(null, xs) - Math.min.apply(null, xs)) / 2 };
  });
  const accX = (group.match(/<text class="st-acc"[^>]* x="[-0-9.]+"/g) || []).map(function(tag){ return Number(tag.match(/ x="([-0-9.]+)"/)[1]); });
  const wave = group.match(/<path class="st-roll"[^>]* d="([^"]+)"/);
  const points = wave ? wavePoints(wave[1]) : [];
  return {
    heads: heads, accX: accX, rolled: !!wave, points: points,
    headLeft: Math.min.apply(null, heads.map(function(h){ return h.x - h.rx; })),
    headTop: Math.min.apply(null, heads.map(function(h){ return h.y; })), headBottom: Math.max.apply(null, heads.map(function(h){ return h.y; })),
    waveRight: Math.max.apply(null, points.map(function(q){ return q.x; })),
    waveTop: Math.min.apply(null, points.map(function(q){ return q.y; })), waveBottom: Math.max.apply(null, points.map(function(q){ return q.y; }))
  };
}

// 슬라이드 직선: 앞 음 머리 오른쪽에서 뒤 음 머리(임시표가 있으면 그 임시표) 왼쪽까지. 곡선 path.st-slur 는 그리지 않는다.
function slideLines(svg){
  return (svg.match(/<line class="st-slide[^"]*"[^>]*>/g) || []).map(function(tag){
    const num = function(name){ return Number(tag.match(new RegExp(' ' + name + '="([-0-9.]+)"'))[1]); };
    return { cls: tag.match(/class="([^"]*)"/)[1], x1: num('x1'), y1: num('y1'), x2: num('x2'), y2: num('y2') };
  });
}
const TOL = 0.11;   // 좌표는 소수 한 자리로 반올림된다
function svgWidth(svg){ return Number(svg.match(/^<svg [^>]*width="([0-9.]+)"/)[1]); }
function insideSvg(l){
  return [l.y1, l.y2].every(function(y){ return y >= 2 && y <= svgApi.STAFF_HEIGHT - 2; });
}

test('slide line: one line.st-slide per slide, no slur curve, and a slur draws no slide line', function(){
  const slide = layout('E3@4 gG3@4 - -');
  const svg = draw(slide);
  checkCounts(svg, slide.measures[0], 'slide');
  assert.equal(count(svg, 'st-slide'), 1);
  assert.equal(count(svg, 'st-slur'), 0, 'a slide is not drawn as a curve');
  assert.equal(slideLines(svg)[0].cls, 'st-slide', 'a slide inside the measure has no half class');
  const slur = layout('E3@4 sG3@4 - -');
  const slurSvg = draw(slur);
  checkCounts(slurSvg, slur.measures[0], 'slur');
  assert.equal(count(slurSvg, 'st-slide'), 0);
  assert.equal(count(slurSvg, 'st-slur'), 1);
  const chain = layout('E3@4 sG3@4 gA3@4 -');
  const chainSvg = draw(chain);
  checkCounts(chainSvg, chain.measures[0], 'slur then slide');
  assert.equal(count(chainSvg, 'st-slide'), 1);
  assert.equal(count(chainSvg, 'st-slur'), 1);
  assert.equal(typeof svgApi.SLIDE_PAD, 'number');
  assert.equal(svgApi.SLIDE_HALF_RISE, 2 * svgApi.LINE_GAP / 2, 'the half rise is two staff steps');
});

test('slide line in one measure: from the right of the source head to the left of the target head, at the head heights', function(){
  [['E3@4 gG3@4 - -', 'up'], ['G3@4 gE3@4 - -', 'down']].forEach(function(pair){
    const result = layout(pair[0]);
    assert.equal(result.measures[0].slurs[0].dir, pair[1]);
    const svg = draw(result);
    const groups = chordGroups(svg).map(chordFacts);
    const from = groups[0].heads[0], to = groups[1].heads[0];
    const lines = slideLines(svg);
    assert.equal(lines.length, 1);
    assert.ok(Math.abs(lines[0].x1 - (from.x + from.rx + svgApi.SLIDE_PAD)) < TOL, pair[0] + ': starts SLIDE_PAD right of the source head');
    assert.ok(Math.abs(lines[0].x2 - (to.x - to.rx - svgApi.SLIDE_PAD)) < TOL, pair[0] + ': ends SLIDE_PAD left of the target head');
    assert.ok(lines[0].x1 > from.x + from.rx && lines[0].x2 < to.x - to.rx, pair[0] + ': the line clears both heads');
    assert.ok(Math.abs(lines[0].y1 - from.y) < TOL && Math.abs(lines[0].y2 - to.y) < TOL, pair[0] + ': ends at the head heights');
    assert.equal(lines[0].y2 < lines[0].y1, pair[1] === 'up', pair[0] + ': goes up on the page for up');
  });
});

test('slide line stops left of the target accidental, and a chord uses the slid head only', function(){
  const sharp = layout('E3@4 gF#3@4 - -');
  assert.equal(sharp.measures[0].items[1].notes[0].accidental, 'sharp');
  const svg = draw(sharp);
  checkCounts(svg, sharp.measures[0], 'slide to an accidental');
  const to = chordGroups(svg).map(chordFacts)[1];
  assert.equal(to.accX.length, 1);
  const accLeft = to.accX[0] - svgApi.ROLL_ACC_W;
  const line = slideLines(svg)[0];
  assert.ok(Math.abs(line.x2 - (accLeft - svgApi.SLIDE_PAD)) < TOL, 'ends SLIDE_PAD left of the accidental glyph');
  assert.ok(line.x2 < accLeft && line.x2 < to.heads[0].x - to.heads[0].rx, 'the line does not reach the accidental or the head');
  // 화음: 아래 머리(F#3, 임시표 있음)가 아니라 미끄러지는 머리(G3, 임시표 없음) 기준
  const chord = layout('E3@4 F#3@5+gG3@4 - -');
  const chordNotes = chord.measures[0].items[1].notes;
  const slidHead = chordNotes.findIndex(function(note){ return note.name === 'G3'; });
  assert.equal(chord.measures[0].slurs[0].toHead, slidHead);
  assert.equal(chordNotes[slidHead].accidental, null);
  assert.ok(chordNotes.some(function(note){ return note.accidental; }), 'the other head has an accidental');
  const chordSvg = draw(chord);
  const target = chordGroups(chordSvg).map(chordFacts)[1].heads[slidHead];
  const chordLine = slideLines(chordSvg)[0];
  assert.ok(Math.abs(chordLine.x2 - (target.x - target.rx - svgApi.SLIDE_PAD)) < TOL, 'a head without an accidental ends at the head even if another head has one');
  assert.ok(Math.abs(chordLine.y2 - target.y) < TOL);
});

test('slide line across the barline: a half leaves through the right edge, a half enters from the left, tilted along the direction', function(){
  [['r r r E3@4\ngG3@4 - - -', 'up'], ['r r r G3@4\ngE3@4 - - -', 'down']].forEach(function(pair){
    const result = layout(pair[0]);
    const first = draw(result, 0), second = draw(result, 1);
    checkCounts(first, result.measures[0], 'source measure');
    checkCounts(second, result.measures[1], 'target measure');
    const out = slideLines(first), into = slideLines(second);
    assert.equal(out.length, 1);
    assert.equal(into.length, 1);
    assert.equal(out[0].cls, 'st-slide is-start');
    assert.equal(into[0].cls, 'st-slide is-end');
    const sign = pair[1] === 'up' ? -1 : 1;
    const fromHead = chordFacts(chordGroups(first)[0]).heads[0];
    const toHead = chordFacts(chordGroups(second)[0]).heads[0];
    assert.ok(Math.abs(out[0].x1 - (fromHead.x + fromHead.rx + svgApi.SLIDE_PAD)) < TOL);
    assert.equal(out[0].x2, svgWidth(first) - 2, 'ends 2px before the right edge');
    assert.ok(Math.abs(out[0].y1 - fromHead.y) < TOL);
    assert.ok(Math.abs(out[0].y2 - (out[0].y1 + sign * svgApi.SLIDE_HALF_RISE)) < TOL, pair[1] + ': tilts SLIDE_HALF_RISE toward the direction');
    assert.equal(into[0].x1, LEFT_PAD + 2, 'starts 2px after the left edge of the event area');
    assert.ok(Math.abs(into[0].x2 - (toHead.x - toHead.rx - svgApi.SLIDE_PAD)) < TOL);
    assert.ok(Math.abs(into[0].y2 - toHead.y) < TOL);
    assert.ok(Math.abs(into[0].y1 - (into[0].y2 - sign * svgApi.SLIDE_HALF_RISE)) < TOL, pair[1] + ': comes in from the opposite side');
    // 왼쪽에서 오른쪽으로 읽을 때 위로 가는 슬라이드는 y 가 줄어든다
    assert.equal(out[0].y2 < out[0].y1, pair[1] === 'up');
    assert.equal(into[0].y2 < into[0].y1, pair[1] === 'up');
    assert.equal(count(first, 'st-slur') + count(second, 'st-slur'), 0);
  });
});

test('slide line keeps every y inside the SVG, including the halves near the top and bottom of the staff', function(){
  slideLines(draw(layout('A5 gB5 - -'))).forEach(function(l){ assert.ok(insideSvg(l)); });
  const high = layout('r r r A5\ngB5 - - -');
  slideLines(draw(high, 0)).concat(slideLines(draw(high, 1))).forEach(function(l){ assert.ok(insideSvg(l)); });
  const low = layout('r r r F#3@4\ngE3@4 - - -');
  slideLines(draw(low, 0)).concat(slideLines(draw(low, 1))).forEach(function(l){ assert.ok(insideSvg(l)); });
});

test('roll wave: one path.st-roll per rolled chord, none on plain chords or rests', function(){
  const result = layout('~E2@6+B3@2+G4@1 E2@6+B3@2+G4@1 ~E2@6+B3@2 r');
  const svg = draw(result);
  checkCounts(svg, result.measures[0], 'rolls');
  assert.equal(count(svg, 'st-roll'), 2);
  const groups = chordGroups(svg);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(function(group){ return /class="st-roll"/.test(group); }), [true, false, true]);
  const restOnly = layout('r r r r');
  assert.equal(count(draw(restOnly), 'st-roll'), 0, 'a rest has no wave');
  assert.equal(count(draw(layout('E2@6+B3@2+G4@1 r r r')), 'st-roll'), 0, 'a plain chord has no wave');
  const tag = svg.match(/<path class="st-roll"[^>]*>/)[0];
  assert.match(tag, /fill="none"/);
  assert.match(tag, /stroke="currentColor"/);
});

test('roll wave sits left of the leftmost head, and left of the accidentals when there are some', function(){
  const gap = svgApi.ROLL_GAP, amp = svgApi.ROLL_AMP, accW = svgApi.ROLL_ACC_W;
  const plain = chordFacts(chordGroups(draw(layout('~E2@6+B3@2+G4@1 r r r')))[0]);
  assert.ok(plain.rolled && plain.accX.length === 0);
  assert.ok(plain.waveRight < plain.headLeft, 'the wave is left of the leftmost head: ' + plain.waveRight + ' < ' + plain.headLeft);
  assert.ok(Math.abs(plain.waveRight - (plain.headLeft - gap + amp)) < 0.2, 'the wave center sits ROLL_GAP left of the head and sticks out by ROLL_AMP');
  // 임시표가 있는 화음
  const one = chordFacts(chordGroups(draw(layout('~C#3@5+E4@2+G#4@1 r r r')))[0]);
  assert.ok(one.rolled && one.accX.length === 2, 'two accidentals');
  assert.ok(one.waveRight < Math.min.apply(null, one.accX) - accW, 'the wave is left of the left end of the accidentals: ' + JSON.stringify({ right: one.waveRight, acc: one.accX }));
  assert.ok(one.waveRight < one.headLeft);
  // 임시표가 여러 열로 갈라지는 화음(가까운 음에 모두 임시표)
  const stacked = chordFacts(chordGroups(draw(layout('~C#3+D#3+F#3 r r r')))[0]);
  assert.ok(stacked.rolled);
  assert.ok(new Set(stacked.accX).size >= 2, 'the accidentals use more than one column: ' + JSON.stringify(stacked.accX));
  assert.ok(stacked.waveRight < Math.min.apply(null, stacked.accX) - accW, 'the wave clears the leftmost accidental column: ' + JSON.stringify({ right: stacked.waveRight, acc: stacked.accX }));
  // 임시표가 있으면 물결이 머리에서 더 멀다
  assert.ok(plain.headLeft - plain.waveRight < one.headLeft - one.waveRight);
});

test('roll wave covers the top and bottom heads and stays inside the SVG', function(){
  const parser = require('../src/parser.js');
  const top = parser.noteNameForMidi(parser.STRINGS[0].midi + require('../src/notation.js').MAX_FRET, false);
  const low = parser.noteNameForMidi(parser.STRINGS[5].midi, false);
  ['~E2@6+B3@2+G4@1 r r r', '~' + low + '@6+' + top + '@1 r r r', '~E4+F4 r r r'].forEach(function(text){
    const facts = chordFacts(chordGroups(draw(layout(text)))[0]);
    assert.ok(facts.rolled, text);
    assert.ok(facts.waveTop <= facts.headTop && facts.waveBottom >= facts.headBottom, text + ': the wave covers the top and bottom heads ' + JSON.stringify({ wave: [facts.waveTop, facts.waveBottom], heads: [facts.headTop, facts.headBottom] }));
    facts.points.forEach(function(point){ assert.ok(point.y >= 0 && point.y <= svgApi.STAFF_HEIGHT, text + ': y ' + point.y + ' is inside the SVG'); });
  });
  // 물결 모양: 끝점 x 는 모두 같고 제어점 x 는 좌우로 번갈아 나온다
  const points = chordFacts(chordGroups(draw(layout('~E2@6+G4@1 r r r')))[0]).points;
  const ends = points.filter(function(q, i){ return i % 2 === 0; }), controls = points.filter(function(q, i){ return i % 2 === 1; });
  assert.ok(controls.length >= 2);
  assert.ok(ends.every(function(q){ return Math.abs(q.x - ends[0].x) < 0.2; }), 'the wave endpoints share one x');
  controls.forEach(function(q, i){ assert.ok((i % 2 === 0) === (q.x > ends[0].x), 'the control points alternate right and left'); });
});

test('roll wave across the barline: the tied piece after it has no wave', function(){
  const result = layout('r r r ~E2@6+B3@2+G4@1\n- - r r');
  const first = draw(result, 0), second = draw(result, 1);
  checkCounts(first, result.measures[0], 'rolled piece');
  checkCounts(second, result.measures[1], 'tied piece');
  assert.equal(count(first, 'st-roll'), 1);
  assert.equal(count(second, 'st-roll'), 0);
});

test('skip cells: the pickup note is drawn under its TAB cell and nothing is drawn in the skip cells', function(){
  const result = layout('[-] _ _ _ E4\n[C] E4 F4 G4 A4');
  const svg = draw(result, 0);
  checkCounts(svg, result.measures[0], 'pickup measure');
  assert.equal(count(svg, 'st-chord'), 1);
  assert.ok(/data-cell="3"/.test(svg), 'the note is in cell 3');
  assert.equal(/data-cell="[012]"/.test(svg), false, 'no chord or rest in the skip cells');
  const leftPad = LEFT_PAD + svgApi.headerWidth({ key: result.key, time: result.time });
  const cx = Number(/<ellipse[^>]* cx="([-0-9.]+)"/.exec(svg)[1]);
  assert.ok(cx >= leftPad + 3 * WIDTH_PER_CELL, 'the head x is inside cell 3 and later: ' + cx);
  const rest = layout('r r _ _\nE4 F4 G4 A4');
  const restSvg = draw(rest, 0);
  checkCounts(restSvg, rest.measures[0], 'rest measure with skips');
  assert.equal(count(restSvg, 'st-rest'), 1);
  assert.equal(rest.measures[0].items[0].value.base, 'half');
});

process.stdout.write('1..' + checks + '\n');
