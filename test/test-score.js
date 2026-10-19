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

test('labels show plain note names on mixed chord subdivisions', function(){
  const beat = firstBeat('E2+!B4/B3/G3 r r r');
  assert.equal(score.formatBeatPitchLabel(beat, {compact:true}), 'E+B·B·G', 'compact labels omit articulation symbols');
  assert.equal(score.formatBeatPitchLabel(beat, {compact:false}), 'E2+B4 · B3 · G3', 'noncompact labels omit articulation symbols');
});

test('chords and their hold chain display one common part duration', function(){
  const beats = parser.parseScore('C3+E4 - - -', 4).measures[0].beats;
  const chord = beats[0];
  const duration = score.getBeatDurationInfo(beats, 0, 4);
  assert.equal(duration.label, '온음');
  assert.equal(duration.durName, '온음표');
  assert.equal(score.formatBeatPitchLabel(chord, {compact:false}), 'C3+E4');
  assert.equal(score.getBeatDurationInfo(beats, 1, 4).durName, '유지');
});

test('articulation marks do not change plain chord component labels', function(){
  assert.equal(score.formatBeatPitchLabel(firstBeat('!C3+E4 D4 r G4'), {compact:false}), 'C3+E4');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+!E4 D4 r G4'), {compact:false}), 'C3+E4');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4 D4 r G4'), {compact:false}), 'C3+E4');
});

test('subdivision notes, three-note chords, and the legacy chord label follow compact rules', function(){
  assert.equal(score.formatBeatPitchLabel(firstBeat('!C3/E4/G4 D4 r A3'), {compact:true}), 'C·E·G');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4+G4 D4 r A3'), {compact:true, chord:'C'}), 'C');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4+G4 D4 r A3'), {compact:true}), 'C+E+G');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4+G4 D4 r A3'), {compact:false, chord:'C'}), 'C3+E4+G4');
  assert.equal(score.formatBeatPitchLabel(firstBeat('C3+E4+G4 D4 r A3'), {compact:false}), 'C3+E4+G4');
  assert.equal(score.formatBeatPitchLabel(firstBeat('!C3+E4+G4 D4 r A3'), {compact:true, chord:'C'}), 'C');
});

test('single note, rest, hold, invalid, and parent articulation formatting are explicit', function(){
  assert.equal(score.formatBeatPitchLabel(firstBeat('!E4 D4 r A3'), {compact:true}), 'E4');
  assert.equal(score.formatBeatPitchLabel(firstBeat('B4 C4 r G4'), {compact:false}), 'B4');
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
  assert.equal(score.getUniformBeatArticulation(firstBeat('C3+E4 D4 r A3')), null, 'unmarked notes have no uniform articulation');
  assert.equal(score.getUniformBeatArticulation(firstBeat('!C3+E4 D4 r A3')), null);
  assert.equal(score.getUniformBeatArticulation(firstBeat('!C3/!E4/!G4 D4 r A3')), 'apoyando');
  assert.equal(score.getUniformBeatArticulation(parser.parseScore('r r r r', 4).measures[0].beats[0]), null);
});

test('formatting leaves parser objects unchanged', function(){
  const beat = firstBeat('E2+!B4/B3/G3 r r r');
  const before = JSON.stringify(beat);
  score.formatBeatPitchLabel(beat, {compact:true, chord:'Em'});
  score.formatBeatPitchLabel(beat, {compact:false});
  score.getUniformBeatArticulation(beat);
  assert.equal(JSON.stringify(beat), before);
});

test('getNoteDisplayName formats note according to mode and omitOctave', function(){
  const note = { kind: 'note', en: 'C4', ko: '도' };
  assert.equal(score.getNoteDisplayName(note, 'cde', false), 'C4');
  assert.equal(score.getNoteDisplayName(note, 'cde', true), 'C');
  assert.equal(score.getNoteDisplayName(note, 'solfege', false), '도4');
  assert.equal(score.getNoteDisplayName(note, 'solfege', true), '도');

  assert.equal(score.getNoteDisplayName({ kind: 'rest' }, 'cde'), '쉼');
  assert.equal(score.getNoteDisplayName({ kind: 'hold' }, 'solfege'), '유지');
  assert.equal(score.getNoteDisplayName({ kind: 'invalid' }, 'cde'), '오류');
  assert.equal(score.getNoteDisplayName(null, 'cde'), '오류');
});

test('formatBeatPitchLabel supports notationMode for cde and solfege', function(){
  const single = firstBeat('E4 D4 r A3');
  assert.equal(score.formatBeatPitchLabel(single, {notationMode:'cde'}), 'E4');
  assert.equal(score.formatBeatPitchLabel(single, {notationMode:'solfege'}), '미4');

  const chord = firstBeat('C3+E4 D4 r A3');
  assert.equal(score.formatBeatPitchLabel(chord, {notationMode:'cde'}), 'C3+E4');
  assert.equal(score.formatBeatPitchLabel(chord, {notationMode:'solfege'}), '도3+미4');

  const chord3 = firstBeat('C3+E4+G4 D4 r A3');
  assert.equal(score.formatBeatPitchLabel(chord3, {compact:true, notationMode:'solfege'}), '도+미+솔');
  assert.equal(score.formatBeatPitchLabel(chord3, {compact:true, notationMode:'cde'}), 'C+E+G');


  const sub = firstBeat('C3/E4 D4 r A3');
  assert.equal(score.formatBeatPitchLabel(sub, {compact:false, notationMode:'cde'}), 'C3 · E4');
  assert.equal(score.formatBeatPitchLabel(sub, {compact:false, notationMode:'solfege'}), '도3 · 미4');
  assert.equal(score.formatBeatPitchLabel(sub, {compact:true, notationMode:'solfege'}), '도·미');
});

process.stdout.write('1..' + checks + '\n');

