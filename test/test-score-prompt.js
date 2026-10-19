const assert = require('node:assert/strict');
const scorePrompt = require('../src/score-prompt.js');
const parser = require('../src/parser.js');
const notation = require('../src/notation.js');

let checks = 0;
function pass(name){
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

assert.equal(global.GuitarScorePrompt, undefined);
pass('module does not pollute the Node global');

const prompt = scorePrompt.buildScoreImagePrompt();
const promptLines = prompt.split('\n');
scorePrompt.EXAMPLE_MEASURES.forEach(function(line){
  assert.ok(promptLines.includes(line), 'prompt contains example measure: ' + line);
});
assert.ok(promptLines.includes(scorePrompt.EXAMPLE_TSV_ROW), 'prompt contains the example TSV row');
pass('prompt embeds every example measure and the TSV row as whole lines');

const exampleText = scorePrompt.EXAMPLE_MEASURES.join('\n');
const validation = parser.validateScore(exampleText, scorePrompt.EXAMPLE_BEATS);
assert.deepEqual(validation.errors, []);
const parsedLines = parser.parseScore(exampleText, scorePrompt.EXAMPLE_BEATS);
assert.deepEqual(parsedLines.errors, []);
assert.equal(parsedLines.measures.length, scorePrompt.EXAMPLE_MEASURES.length);
pass('example measures validate and parse without errors under the current parser');

const columns = scorePrompt.EXAMPLE_TSV_ROW.split('\t');
assert.equal(columns.length, 5);
assert.equal(columns[1], String(scorePrompt.EXAMPLE_BEATS));
assert.equal(columns[2], String(scorePrompt.EXAMPLE_BPM));
const parsedRow = parser.parseScore(columns[4], scorePrompt.EXAMPLE_BEATS);
assert.deepEqual(parsedRow.errors, []);
assert.deepEqual(
  parsedRow.measures.map(function(m){ return m.beats.map(function(b){ return b.tok; }); }),
  parsedLines.measures.map(function(m){ return m.beats.map(function(b){ return b.tok; }); })
);
pass('example TSV row has five columns and its score column parses like the line form');

assert.ok(scorePrompt.EXAMPLE_MEASURES.some(function(line){
  return line.split('|')[0].trim().split(/\s+/).some(function(tok){ return notation.hasUncertainMark(tok); });
}), 'prompt examples show at least one uncertain mark token');
pass('prompt examples include an uncertain-mark token');

assert.doesNotMatch(prompt, /제미니|gemini|chatgpt|gpt|claude|클로드|안티그래비티|antigravity|copilot/i);
pass('prompt names no specific AI product');

const rhythmExamples = scorePrompt.RHYTHM_EXAMPLES;
assert.ok(Array.isArray(rhythmExamples) && rhythmExamples.length > 0);
const unitPerCell = parser.parseScore('[-] E4 r r r | ""', 4).measures[0].beats[0].durationUnits;
assert.ok(unitPerCell > 0);

function lengthToNumber(text){
  const parts = text.split('/');
  return parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(parts[0]);
}

function measureFor(example, cells){
  const used = example.notation.split(' ').length;
  const tokens = [example.notation];
  for (let i = used; i < cells; i++) tokens.push('r');
  return '[-] ' + tokens.join(' ') + ' | ""';
}

function flattenNotes(measure){
  const notes = [];
  measure.beats.forEach(function(beat){
    const pieces = beat.isSubdivided ? beat.subNotes : [beat];
    pieces.forEach(function(piece){
      if (piece.kind === 'note') notes.push(piece);
    });
  });
  return notes;
}

rhythmExamples.forEach(function(example){
  const text = measureFor(example, 4);
  assert.deepEqual(parser.validateScore(text, 4).errors, [], 'rhythm example validates: ' + example.notation);
});
pass('every rhythm table notation validates as a four-cell measure');

rhythmExamples.forEach(function(example){
  const parsed = parser.parseScore(measureFor(example, 4), 4);
  assert.deepEqual(parsed.errors, [], 'rhythm example parses: ' + example.notation);
  const notes = flattenNotes(parsed.measures[0]);
  assert.equal(notes.length, example.noteLengths.length, 'note count for ' + example.notation);
  notes.forEach(function(note, i){
    const cells = note.durationUnits / unitPerCell;
    const expected = lengthToNumber(example.noteLengths[i]);
    assert.ok(Math.abs(cells - expected) < 1e-9, 'length of note ' + (i + 1) + ' in ' + example.notation + ': parser ' + cells + ', table ' + example.noteLengths[i]);
  });
});
pass('every rhythm table notation parses to the note lengths the table states');

rhythmExamples.forEach(function(example){
  const prefix = '| `' + example.notation + '` |';
  assert.ok(promptLines.some(function(line){ return line.startsWith(prefix); }), 'prompt has a table row for ' + example.notation);
});
pass('prompt embeds a table row for every rhythm example');

assert.equal(prompt.includes('{{'), false);
pass('prompt has no unreplaced placeholder');

process.stdout.write('1..' + checks + '\n');
