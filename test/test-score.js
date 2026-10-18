'use strict';

const assert = require('node:assert/strict');
const parser = require('../src/parser.js');
const score = require('../src/score.js');

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}
function firstBeat(source){
  const parsed = parser.parseScore(source, 4);
  assert.deepEqual(parsed.errors, [], source + ' parses without errors');
  return parsed.measures[0].beats[0];
}

test('labels keep per-component articulation on mixed chord subdivisions', function(){
  const beat = firstBeat('~E2+!B4/~B3/~G3 r r r');
  assert.equal(score.formatBeatPitchLabel(beat, {compact:true}), 'E~+B!·B~·G~', 'labels keep per-component articulation on mixed chord subdivisions');
  assert.equal(score.formatBeatPitchLabel(beat, {compact:false}), 'E2~+B4! · B3~ · G3~', 'noncompact labels preserve each component articulation');
});

test('duration details use component lengths for mixed and equally extended chords', function(){
  const mixed = firstBeat('~0E2@6:p*3+!4B4@1:a*1 D4@2 - -');
  const mixedInfo = score.getBeatDurationInfo([mixed], 0, 4);
  assert.equal(mixedInfo.label, '음별 길이');
  assert.equal(mixedInfo.durName, 'E2 3칸 + B4 1칸');
  assert.equal(score.formatBeatPitchLabel(mixed, {compact:false}), 'E2~+B4!', 'duration suffixes do not leak into the existing pitch and articulation label');

  const equal = firstBeat('C3*3+E4*3 D4 - -');
  assert.equal(score.getBeatDurationInfo([equal], 0, 4).durName, '점2분음표', 'same-duration chord uses the actual component length instead of the parent part duration');

});

test('marks on either chord component do not leak to the other component', function(){
  assert.equal(score.formatBeatPitchLabel(firstBeat('!C3+E4 D4 r G4'), {compact:false}), 'C3!+E4');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+!E4 D4 r G4'), {compact:false}), 'C3+E4!');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4 D4 r G4'), {compact:false}), 'C3+E4');
});

test('subdivision notes, three-note chords, and the legacy chord label follow compact rules', function(){
  assert.equal(score.formatBeatPitchLabel(firstBeat('!C3/E4/~G4 D4 r A3'), {compact:true}), 'C!·E·G~');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4+G4 D4 r A3'), {compact:true, chord:'C'}), 'C');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4+G4 D4 r A3'), {compact:true}), 'C+E+G');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4+G4 D4 r A3'), {compact:false, chord:'C'}), 'C3+E4+G4');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4+G4 D4 r A3'), {compact:false}), 'C3+E4+G4');
  assert.equal(score.formatBeatPitchLabel(firstBeat('!C3+E4+G4 D4 r A3'), {compact:true, chord:'C'}), 'C!+E+G');
});

test('single note, rest, hold, invalid, and parent articulation formatting are explicit', function(){
  assert.equal(score.formatBeatPitchLabel(firstBeat('!E4 D4 r A3'), {compact:true}), 'E4!');
  const restHold = parser.parseScore('E4 - r G4', 4).measures[0].beats;
  assert.equal(score.formatBeatPitchLabel(parser.parseScore('r r r r', 4).measures[0].beats[0]), '쉼');
  assert.equal(score.formatBeatPitchLabel(restHold[1]), '유지');
  assert.equal(score.formatBeatPitchLabel({kind:'invalid'}), '오류');
  const parentMarked = JSON.parse(JSON.stringify(firstBeat('C3+E4 D4 r A3')));
  parentMarked.articulation = 'apoyando';
  parentMarked.explicitArticulation = true;
  assert.equal(score.formatBeatPitchLabel(parentMarked, {compact:false}), 'C3+E4');
});

test('uniform articulation requires every attack component to have the same explicit mark', function(){
  assert.equal(score.getUniformBeatArticulation(firstBeat('!C3+!E4 D4 r A3')), 'apoyando');
  assert.equal(score.getUniformBeatArticulation(firstBeat('~C3+~E4 D4 r A3')), 'tirando');
  assert.equal(score.getUniformBeatArticulation(firstBeat('!C3+E4 D4 r A3')), null);
  assert.equal(score.getUniformBeatArticulation(firstBeat('!C3+~E4 D4 r A3')), null);
  assert.equal(score.getUniformBeatArticulation(firstBeat('!C3/!E4/!G4 D4 r A3')), 'apoyando');
  assert.equal(score.getUniformBeatArticulation(parser.parseScore('r r r r', 4).measures[0].beats[0]), null);
});

test('formatting leaves parser objects unchanged', function(){
  const beat = firstBeat('~E2+!B4/~B3/~G3 r r r');
  const before = JSON.stringify(beat);
  score.formatBeatPitchLabel(beat, {compact:true, chord:'Em'});
  score.formatBeatPitchLabel(beat, {compact:false});
  score.getUniformBeatArticulation(beat);
  assert.equal(JSON.stringify(beat), before);
});

process.stdout.write('1..' + checks + '\n');
