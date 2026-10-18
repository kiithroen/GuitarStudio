const assert = require('node:assert/strict');
const scorePrompt = require('../src/score-prompt.js');
const parser = require('../src/parser.js');

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

assert.doesNotMatch(prompt, /제미니|gemini|chatgpt|gpt|claude|클로드|안티그래비티|antigravity|copilot/i);
pass('prompt names no specific AI product');

process.stdout.write('1..' + checks + '\n');
