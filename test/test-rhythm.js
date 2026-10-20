const assert = require('node:assert/strict');
const parser = require('../src/parser.js');
const rhythm = require('../src/rhythm.js');
const score = require('../src/score.js');

let checks = 0;
function test(name, fn){ fn(); checks++; process.stdout.write('ok ' + checks + ' - ' + name + '\n'); }
const parse = parser.parseScore;

test('grid mapping distinguishes nine-eighth from three-quarter subdivisions', function(){
  assert.deepEqual(rhythm.getGridInfo(9), {slotsPerBar:9,numerator:9,denominator:8,slotQuarterLength:0.5,bpmUnitLabel:'8분음표 한 칸'});
  assert.deepEqual(rhythm.getGridInfo(3), {slotsPerBar:3,numerator:3,denominator:4,slotQuarterLength:1,bpmUnitLabel:'4분음표 한 칸'});
  assert.equal(rhythm.UNITS_PER_SLOT,12);
});

test('duration display maps supported note values to matching names and SVGs', function(){
  const quarter=parse('C4 r r r',4).measures[0].beats;
  const quarterInfo=score.getBeatDurationInfo(quarter,0,4);
  assert.equal(quarterInfo.durName,'4분음표');
  assert.equal(quarterInfo.svg,score.NOTE_DUR_SVGS.quarter);
  const dottedEighth=parse('C4/-/-/D4 r r r',4).measures[0].beats[0].subNotes[0];
  const dottedInfo=score.getBeatDurationInfo([dottedEighth],0,4);
  assert.equal(dottedInfo.durName,'점8분음표');
  assert.equal(dottedInfo.svg,'');
  const simpleSixteenth=parse('C4/D4/E4/F4 r r r',4).measures[0].beats[0].subNotes[0];
  assert.equal(score.getBeatDurationInfo([simpleSixteenth],0,4).durName,'16분음표');
  const compoundSixteenth=parse('C4/D4 r r r r r',6).measures[0].beats[0].subNotes[0];
  assert.equal(score.getBeatDurationInfo([compoundSixteenth],0,6).durName,'16분음표');
});

test('C4 -/D4 - - retains a dotted-quarter attack and links trailing holds to D4', function(){
  const parsed=parse('C4 -/D4 - -',4);
  assert.deepEqual(parsed.errors,[]);
  const beats=parsed.measures[0].beats;
  assert.equal(beats[0].durationUnits,18);
  const firstInfo=score.getBeatDurationInfo([beats[0]],0,4);
  assert.equal(firstInfo.label,'점4분');
  assert.equal(firstInfo.svg,score.NOTE_DUR_SVGS.quarterDot);
  assert.equal(beats[1].subNotes[0].kind,'hold');
  assert.equal(beats[1].subNotes[0].durationUnits,6);
  assert.deepEqual(beats[1].subNotes[0].tieFrom,{measureIndex:0,beatIndex:0,subIndex:null});
  assert.equal(beats[1].subNotes[1].durationUnits,30);
  assert.equal(beats[2].durationUnits,24);
  assert.equal(beats[2].tieFrom.beatIndex,1);
  assert.equal(beats[2].tieFrom.subIndex,1);
  assert.equal(beats[3].durationUnits,12);
  assert.equal(beats[3].tieFrom.subIndex,1);
});

test('subdivision groups describe every part in order and preserve its kind', function(){
  const restGroup=parse('r/C4 r r r',4).measures[0].beats[0];
  const restInfo=score.getBeatDurationInfo([restGroup],0,4);
  assert.deepEqual({kind:restInfo.kind,isRest:restInfo.isRest,svg:restInfo.svg,label:restInfo.label},
    {kind:'group',isRest:false,svg:'',label:'2분할'});
  assert.equal(restInfo.durName,'쉼 · 8분음표');
  const holdGroup=parse('C4 -/D4 r r',4).measures[0].beats[1];
  const holdInfo=score.getBeatDurationInfo([holdGroup],0,4);
  assert.equal(holdInfo.kind,'group');
  assert.equal(holdInfo.durName,'유지 · 8분음표');
  assert.equal(score.getBeatDurationInfo([{kind:'invalid'}],0,4).durName,'오류');
});

test('long cross-bar duration uses an exact slot fraction fallback', function(){
  const beats=parse('C4 - - -//- - - -',4).measures;
  const first=beats[0].beats[0];
  const info=score.getBeatDurationInfo([first],0,4);
  assert.equal(info.durName,'8칸');
  assert.equal(info.svg,'');
});

test('rests, holds, and repeated notes have distinct meaning', function(){
  const held = parse('E4 r F4 -',4);
  assert.deepEqual(held.errors,[]);
  const beats = held.measures[0].beats;
  assert.deepEqual(beats.map(beat=>beat.kind),['note','rest','note','hold']);
  assert.deepEqual(beats.map(beat=>beat.ko),['미','쉼','파','유지']);
  assert.equal(beats[2].durationUnits,24);
  assert.equal(beats[3].tieFrom.beatIndex,2);
  assert.equal(rhythm.resolveHold(held.measures,beats[3]),beats[2]);
  const repeated = parse('E4 E4 F4 G4',4);
  assert.equal(repeated.measures[0].beats[0].durationUnits,12);
  assert.equal(repeated.measures[0].beats[1].kind,'note');
  const invalid=parse('C4 r - .',4).measures[0].beats;
  assert.equal(invalid[0].ko,'도');
  assert.equal(invalid[1].ko,'쉼');
  assert.equal(invalid[2].ko,'유지');
  assert.equal(invalid[3].ko,'');
});

test('every hold stores only the duration remaining from its own position', function(){
  const followedScore = parse('C4 - - D4',4);
  const followed = followedScore.measures[0].beats;
  assert.deepEqual(followed.map(beat=>beat.durationUnits),[36,24,12,12]);
  const followedAnalysis = rhythm.annotate(followedScore.measures,4);
  assert.equal(followedAnalysis.events[0].durationUnits,followed[0].durationUnits);
  const cutByRest = parse('C4 - - r',4).measures[0].beats;
  assert.deepEqual(cutByRest.map(beat=>beat.durationUnits),[36,24,12,12]);
  const split = parse('C4/-/-/D4 r r r',4).measures[0].beats;
  assert.deepEqual(split[0].subNotes.map(part=>part.durationUnits),[9,6,3,3]);
  const finalChain = parse('C4 - - -',4).measures[0].beats;
  assert.deepEqual(finalChain.map(beat=>beat.durationUnits),[48,36,24,12]);
});

test('holds link across bars and across a subdivided chain', function(){
  const across = parse('C4 - - -//- - - D4',4);
  assert.deepEqual(across.errors,[]);
  assert.equal(across.measures[0].beats[0].durationUnits,84);
  assert.equal(across.measures[1].beats[0].tieFrom.measureIndex,0);
  assert.deepEqual(across.measures[0].beats.slice(1).map(beat=>beat.durationUnits),[72,60,48]);
  assert.deepEqual(across.measures[1].beats.slice(0,3).map(beat=>beat.durationUnits),[36,24,12]);
  const afterRest = parse('C4 - - -//- - r D4',4);
  assert.deepEqual(afterRest.errors,[]);
  assert.equal(afterRest.measures[0].beats[0].durationUnits,72);
  assert.deepEqual(afterRest.measures[1].beats.slice(0,2).map(beat=>beat.durationUnits),[24,12]);
  assert.equal(afterRest.measures[1].beats[3].durationUnits,12);
  const split = parse('C4/-/-/D4 C4+E4/- - -',4);
  assert.deepEqual(split.errors,[]);
  assert.equal(split.measures[0].beats[0].subNotes[0].durationUnits,9);
  assert.equal(split.measures[0].beats[0].subNotes[3].durationUnits,3);
  assert.equal(split.measures[0].beats[1].subNotes[1].tieFrom.subIndex,0);
  assert.equal(split.measures[0].beats[1].subNotes[1].durationUnits,30);
});

test('orphan and ambiguous holds, unsupported split counts, and missing slots are errors', function(){
  for (const [raw,code] of [['- C4 D4 E4','ORPHAN_HOLD'],['r - C4 D4','ORPHAN_HOLD'],['. C4 D4 E4','AMBIGUOUS_REST_TOKEN'],['C4/D4/E4/F4/G4 - - -','UNSUPPORTED_SUBDIVISION'],['C4 D4','MISSING_BEATS']]){
    assert.ok(parse(raw,4).errors.some(error=>error.code===code),raw+' '+code);
    assert.ok(parser.validateScore(raw,4).errors.some(error=>error.code===code),raw+' validate '+code);
  }
});

test('two, three, and four equal parts use integer slot units', function(){
  for (const [count,units] of [[2,6],[3,4],[4,3]]){
    const tokens=Array.from({length:count},(_,i)=>i===0?'C4':'r').join('/');
    const beat=parse(tokens+' - - -',4).measures[0].beats[0];
    assert.deepEqual(beat.subNotes.map(part=>part.slotUnits),Array(count).fill(units));
    assert.deepEqual(beat.subNotes.map(part=>part.startUnits),Array.from({length:count},(_,i)=>i*units));
  }
});

test('underspecified preview preserves entered slots and source tokens', function(){
  const raw='[C] 4D4@2 r | "line"';
  const parsed=parse(raw,4);
  assert.ok(parsed.errors.some(error=>error.code==='MISSING_BEATS'));
  assert.deepEqual(parsed.measures[0].beats.map(beat=>beat.tok),['4D4@2','r']);
  assert.equal(parsed.measures[0].beats[0].str,2);
  assert.equal(parser.serializeScoreMeasures(parsed.measures),'[C] 4D4@2 r | "line"');
});

test('chord holds share one part duration and sounding lookup restores the whole chord', function(){
  const raw='[C] 0E2@6:p+!4B4@1:a - - r';
  const parsed=parse(raw,4);
  assert.deepEqual(parsed.errors,[]);
  const beats=parsed.measures[0].beats;
  const chordNotes=beats[0].chordNotes;
  assert.deepEqual([beats[0].startUnits,beats[0].durationUnits],[0,36]);
  assert.deepEqual([beats[1].durationUnits,beats[2].durationUnits],[24,12]);
  const sounding=rhythm.getSoundingNotes(parsed.measures,12);
  assert.deepEqual(sounding.map(item=>[item.note.midi,item.remainingUnits]),[[40,24],[71,24]]);
  assert.deepEqual(sounding.map(item=>item.note),chordNotes,'lookup returns references to each original chord component');
  assert.deepEqual(rhythm.getSoundingNotes(parsed.measures,0),[],'an onset at the requested position is not already sounding');
  assert.deepEqual(rhythm.getSoundingNotes(parsed.measures,36),[],'a note ending exactly at the position is not sounding');
  const before=JSON.stringify(beats.map(beat=>[beat.durationUnits,beat.chordNotes&&beat.chordNotes.map(note=>Object.keys(note))]));
  rhythm.annotate(parsed.measures,4);
  assert.equal(JSON.stringify(beats.map(beat=>[beat.durationUnits,beat.chordNotes&&beat.chordNotes.map(note=>Object.keys(note))])),before,'annotation is idempotent without adding component lengths');

  const nextNote=parse('E2@6 B3@2 A3@3 r',4).measures[0].beats;
  assert.equal(nextNote[0].durationUnits,12,'a note part ends when the next note part begins');
  assert.deepEqual(rhythm.getSoundingNotes([ {beats:nextNote} ],12),[],'a new onset does not restore a previous part');
  const restCut=parse('E2@6 - r r',4).measures[0].beats;
  assert.equal(restCut[0].durationUnits,24,'a whole rest ends the active tie chain');

  const across=parse('E2@6 - - - // - - - r',4);
  assert.deepEqual(across.errors,[]);
  const crossNote=across.measures[0].beats[0];
  assert.deepEqual([crossNote.startUnits,crossNote.durationUnits],[0,84]);
  assert.deepEqual(rhythm.getSoundingNotes(across.measures,48).map(item=>[item.note.midi,item.remainingUnits]),[[40,36]]);
  const songEnd=parse('E2@6 - - -',4);
  assert.equal(songEnd.measures[0].beats[0].durationUnits,48,'song end clips a duration beyond the score');
  const loopClip=parse('E2@6 - r r',4).measures;
  assert.equal(rhythm.getSoundingNotes(loopClip,6)[0].remainingUnits,18,'sounding lookup uses the hold chain through the next whole rest');
});

test('uncertain mark keeps rest and hold meaning in the rhythm chain', function(){
  assert.ok(parse('E4 r? - r',4).errors.some(error=>error.code==='ORPHAN_HOLD'),'r? still cuts the hold chain');
  assert.ok(parser.validateScore('E4 r? - r',4).errors.some(error=>error.code==='ORPHAN_HOLD'),'validate sees r? as a rest');
  const held=parse('E4? - r r',4);
  assert.deepEqual(held.errors,[],'E4? followed by a hold has no rhythm error');
  assert.equal(held.measures[0].beats[0].durationUnits,24);
  assert.deepEqual(parser.validateScore('E4? - r r',4).errors,[]);
  const restMark=parse('r? E4 ? E4',4);
  assert.deepEqual(restMark.errors,[],'r? and a lone ? are rests, not unknown notes');
  assert.deepEqual(restMark.measures[0].beats.map(beat=>beat.kind),['rest','note','rest','note']);
  assert.deepEqual(parser.validateScore('r? E4 ? E4',4).errors,[]);
});

test('skip cells: kind, zero length, and positions in real time', function(){
  const parsed=parse('[-] _ _ _ E4\n[C] E4 - - -',4);
  assert.deepEqual(parsed.errors,[]);
  const [pickup,full]=parsed.measures;
  for (const cell of pickup.beats.slice(0,3)){
    assert.deepEqual([cell.kind,cell.slotUnits,cell.durationUnits,cell.startUnits],['skip',0,0,0],'a skip part has no length and sits at the time reached so far');
  }
  assert.deepEqual([pickup.beats[3].startUnits,pickup.beats[3].durationUnits],[0,12],'the pickup note starts at time 0');
  assert.equal(full.beats[0].startUnits,12,'the next measure starts right after the pickup note');
  assert.equal(full.beats[0].durationUnits,48);
  assert.equal(rhythm.annotate(parsed.measures,4).totalUnits,5*12,'totalUnits leaves out the skip cells');
  assert.deepEqual(rhythm.annotate(parsed.measures,4).events.map(event=>[event.startUnits,event.durationUnits]),[[0,12],[12,48]],'skip cells make no event');
});
test('without skip cells startUnits and totalUnits are the measure and cell index times 12', function(){
  const parsed=parse('[C] E4 F4 G4 A4\n[C] B4 - r C5\n[C] E4/F4 G4 - A4',4);
  assert.deepEqual(parsed.errors,[]);
  parsed.measures.forEach((measure,mi)=>measure.beats.forEach((beat,bi)=>{
    assert.equal(beat.startUnits,(mi*4+bi)*12);
    if (beat.subNotes) beat.subNotes.forEach((sub,si)=>assert.equal(sub.startUnits,(mi*4+bi)*12+si*6));
  }));
  assert.equal(rhythm.annotate(parsed.measures,4).totalUnits,3*4*12);
  assert.equal(rhythm.countPlayableSlots(parsed.measures,0,0,2),12);
  assert.equal(rhythm.countPlayableSlots(parsed.measures,1,2,2),6);
});
test('a hold chain runs across skip cells and the skip cells add no length', function(){
  const parsed=parse('[Am] A2+E3 - - _\n[C] - E4 _ _\n[C] G4 - - -',4);
  assert.deepEqual(parsed.errors,[]);
  const [first,second,third]=parsed.measures;
  assert.equal(first.beats[0].durationUnits,48,'the chord lasts three cells and then the next measure hold continues it');
  assert.equal(second.beats[0].kind,'hold');
  assert.deepEqual(second.beats[0].tieFrom,{measureIndex:0,beatIndex:0,subIndex:null});
  assert.equal(first.beats[0].durationUnits,first.beats[1].durationUnits+12,'the chain length counts only the cells that take time');
  assert.equal(second.beats[0].startUnits,36,'the hold right after the skip cell continues at the time the skip cell reached');
  assert.equal(first.beats[3].startUnits,36);
  assert.deepEqual([second.beats[2].kind,second.beats[2].startUnits,second.beats[3].startUnits],['skip',60,60]);
  assert.equal(third.beats[0].startUnits,60,'the measure after the short measure starts at the end of its last real cell');
  const across=parse('[Am] A2+E3 - _ _\n[C] - - E4 F4',4);
  assert.deepEqual(across.errors,[]);
  assert.equal(across.measures[0].beats[0].durationUnits,48,'a chain through a skip run lasts only the cells that take time (A2+E3, hold, hold, hold)');
  assert.equal(across.measures[1].beats[1].durationUnits,12);
  const orphan=parse('[-] _ _ - E4',4);
  assert.ok(orphan.errors.some(error=>error.code==='ORPHAN_HOLD'),'a hold right after leading skip cells at the start of the song has no note to hold');
  const keepsChain=parse('[-] E4 - _ _\n[-] - r r r',4);
  assert.equal(keepsChain.measures[0].beats[0].durationUnits,36,'the chain survives the skip cells and ends at the next rest');
});
test('rest after a skip cell still cuts the chain and a skip cell is not a rest', function(){
  const parsed=parse('[-] E4 - _ _\n[-] r - r r',4);
  assert.ok(parsed.errors.some(error=>error.code==='ORPHAN_HOLD'));
  assert.equal(parsed.measures[0].beats[0].durationUnits,24);
  assert.equal(parsed.measures[0].beats[2].kind,'skip');
  assert.notEqual(parsed.measures[0].beats[2].kind,'rest');
});
test('getSoundingNotes uses the real-time position', function(){
  const parsed=parse('[Am] A2+E3 - - _\n[C] - E4 _ _',4);
  assert.deepEqual(parsed.errors,[]);
  const hold=parsed.measures[1].beats[0];
  assert.equal(hold.startUnits,36);
  assert.deepEqual(rhythm.getSoundingNotes(parsed.measures,hold.startUnits).map(item=>[item.note.midi,item.remainingUnits]),[[45,12],[52,12]],'the chord is still sounding at the hold after the skip cell');
  assert.deepEqual(rhythm.getSoundingNotes(parsed.measures,parsed.measures[1].beats[2].startUnits),[],'at the skip run after the last note nothing is sounding');
});

process.stdout.write('1..' + checks + '\n');
