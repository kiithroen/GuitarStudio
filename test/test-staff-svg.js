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
  const out = { heads: 0, ledger: 0, acc: 0, ties: 0, rests: 0, tuplets: measure.tuplets.length, beams: 0, flags: 0, stems: 0, uncertainHeads: 0, uncertainRests: 0, dots: 0 };
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

process.stdout.write('1..' + checks + '\n');
