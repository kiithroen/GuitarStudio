'use strict';

const {
  assert,
  fs,
  path,
  root,
  builtinSongsJson,
  builtinSongCount,
  pageSetScoreView,
  waitForCondition,
  waitForPageLoadAfter,
  runBrowserSuite
} = require('./browser-harness');

async function testConcertHallOfflineRender(client){
  const render = await client.evaluate(`(async function(){
    var saved = { actx:window.actx, outGain:window.outGain, clickBus:window.clickBus, guitarBus:window.guitarBus,
      dryGainNode:window.dryGainNode, wetGainNode:window.wetGainNode, reverbNode:window.reverbNode,
      bodyModes:window.bodyModes, trackedGuideVoices:window.trackedGuideVoices, stringVoices:window.stringVoices,
      acousticFx:appState.acousticFx, bodyAmount:appState.bodyAmount, sympAmount:appState.sympAmount, synthEngine:appState.synthEngine };
    async function renderAt(engine, midi, duration, wet, dry, hardStopAt){
      appState.acousticFx = wet > 0; appState.bodyAmount = 0; appState.sympAmount = 0; appState.synthEngine = engine;
      var rate = 48000, ctx = new OfflineAudioContext(2, rate * 3.2, rate), sourceStops = [];
      ctx.resume = function(){ return Promise.resolve(); };
      var originalCreateBufferSource = ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource = function(){ var source = originalCreateBufferSource(); var stop = source.stop.bind(source);
        source.stop = function(time){ sourceStops.push(time); return stop(time); }; return source; };
      var originalCreateOscillator = ctx.createOscillator.bind(ctx);
      ctx.createOscillator = function(){ var source = originalCreateOscillator(); var stop = source.stop.bind(source);
        source.stop = function(time){ sourceStops.push(time); return stop(time); }; return source; };
      window.actx = ctx; window.outGain = null; window.clickBus = null; window.guitarBus = null;
      window.dryGainNode = null; window.wetGainNode = null; window.reverbNode = null; window.bodyModes = [];
      window.trackedGuideVoices = []; window.stringVoices = {};
      ensureAudioCtx(); dryGainNode.gain.value = dry; wetGainNode.gain.value = wet;
      playGuitarNote(midi, duration, 0.1, 1, null, 1, { exactDuration:true, hardStopAt:hardStopAt });
      var buffer = await ctx.startRendering(), left = buffer.getChannelData(0), right = buffer.getChannelData(1);
      function rms(start, end){ var sum = 0, count = 0;
        for(var i=Math.floor(start*rate); i<Math.floor(end*rate); i++){ var x=(left[i]+right[i])*0.5; sum+=x*x; count++; }
        return Math.sqrt(sum/count); }
      var peak=0; for(var i=0;i<left.length;i++) peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));
      return { tailRms:rms(1.01,1.8), lateRms:rms(0.516,1.0), earlyRms:rms(0.11,0.45), peak:peak, sourceStops:sourceStops };
    }
    async function renderRomance(engine, hall, song){
      appState.acousticFx=hall; appState.bodyAmount=0; appState.sympAmount=0; appState.synthEngine=engine;
      var rate=48000, ctx=new OfflineAudioContext(2,rate*6,rate); ctx.resume=function(){ return Promise.resolve(); };
      window.actx=ctx; window.outGain=null; window.clickBus=null; window.guitarBus=null;
      window.dryGainNode=null; window.wetGainNode=null; window.reverbNode=null; window.bodyModes=[];
      window.trackedGuideVoices=[]; window.stringVoices={}; ensureAudioCtx();
      dryGainNode.gain.value=0.88; wetGainNode.gain.value=hall?CONCERT_HALL_WET_GAIN:0;
      var slotDuration=60/Number(song.bpm),totalSlots=song.measures.length*song.beats,scheduledEventCount=0;
      var originalPlayGuitarNote=window.playGuitarNote;
      window.playGuitarNote=function(){scheduledEventCount++;return originalPlayGuitarNote.apply(this,arguments);};
      try { song.measures[0].beats.forEach(function(beat,index){
          scheduleBeatGuide(beat,{startTime:0.1+index*slotDuration,slotDuration:slotDuration,measures:song.measures,
            maxDurationSlots:totalSlots-index,capo:getSongCapo(song)});
        });
      } finally { window.playGuitarNote=originalPlayGuitarNote; }
      var buffer=await ctx.startRendering(), peak=0, sum=0, count=0;
      for(var i=0;i<buffer.length;i++){
        var left=buffer.getChannelData(0)[i], right=buffer.getChannelData(1)[i];
        peak=Math.max(peak,Math.abs(left),Math.abs(right));
        if(i>=Math.floor(0.1*rate)&&i<Math.floor(4.5*rate)){var mono=(left+right)*0.5;sum+=mono*mono;count++;}
      }
      return {engine:engine,fx:hall?'hall':'dry',peak:peak,rms:Math.sqrt(sum/count),eventCount:scheduledEventCount};
    }
    async function renderIsolatedPart(engine, event, duration, slotDuration, slotsPerBar, startTime, windowStart, windowEnd, naturalDecay){
      appState.acousticFx=false; appState.bodyAmount=0; appState.sympAmount=0; appState.synthEngine=engine;
      var rate=48000, ctx=new OfflineAudioContext(2,rate*4.5,rate), sourceStops=[];
      ctx.resume=function(){ return Promise.resolve(); };
      var originalCreateBufferSource=ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource=function(){var source=originalCreateBufferSource(),stop=source.stop.bind(source);
        source.stop=function(time){sourceStops.push(time);return stop(time);};return source;};
      var originalCreateOscillator=ctx.createOscillator.bind(ctx);
      ctx.createOscillator=function(){var source=originalCreateOscillator(),stop=source.stop.bind(source);
        source.stop=function(time){sourceStops.push(time);return stop(time);};return source;};
      window.actx=ctx; window.outGain=null; window.clickBus=null; window.guitarBus=null;
      window.dryGainNode=null; window.wetGainNode=null; window.reverbNode=null; window.bodyModes=[];
      window.trackedGuideVoices=[]; window.stringVoices={}; ensureAudioCtx();
      dryGainNode.gain.value=0.88; wetGainNode.gain.value=0;
      if(naturalDecay){
        var durationUnits=Math.round(duration/slotDuration*GuitarRhythm.UNITS_PER_SLOT);
        var part={kind:'note',tok:event.note.tok,slotUnits:GuitarRhythm.UNITS_PER_SLOT,durationUnits:durationUnits,chordNotes:[event.note]};
        scheduleBeatGuide({kind:'note',subNotes:[part]},{startTime:startTime,slotDuration:slotDuration,measures:[],maxDurationSlots:slotsPerBar});
      } else playGuitarNote(event.note.midi,duration,startTime,event.gain,event.articulation,event.str,{exactDuration:true,hardStopAt:startTime+slotsPerBar*slotDuration});
      if(windowStart==null) windowStart=Math.max.apply(null,sourceStops)+0.02;
      var buffer=await ctx.startRendering(), left=buffer.getChannelData(0), right=buffer.getChannelData(1), sum=0, count=0, peak=0;
      for(var i=Math.floor(windowStart*rate);i<Math.floor(windowEnd*rate);i++){
        var sample=(left[i]+right[i])*0.5;sum+=sample*sample;count++;
      }
      for(var j=0;j<buffer.length;j++) peak=Math.max(peak,Math.abs(left[j]),Math.abs(right[j]));
      return {engine:engine,duration:duration,startTime:startTime,windowStart:windowStart,windowEnd:windowEnd,
        windowRms:count?Math.sqrt(sum/count):0,peak:peak,sourceStops:sourceStops};
    }
    async function renderNaturalBoundaries(engine){
      async function renderScore(rawScore, loopSlots){
        var parsed=parseScore(rawScore,3);
        if(parsed.errors.length) throw new Error('natural boundary fixture parse failed: '+JSON.stringify(parsed.errors));
        var slotDuration=60/Number(100),rate=48000,ctx=new OfflineAudioContext(2,rate*3,rate),sourceStops=[],sourceStopEvents=[],sourceId=0;
        ctx.resume=function(){return Promise.resolve();};
        var originalCreate=ctx.createBufferSource.bind(ctx);
        ctx.createBufferSource=function(){var source=originalCreate(),stop=source.stop.bind(source),id=++sourceId;source.stop=function(time){sourceStops.push(time);sourceStopEvents.push({id:id,kind:'buffer',time:time});return stop(time);};return source;};
        var originalOscillator=ctx.createOscillator.bind(ctx);
        ctx.createOscillator=function(){var source=originalOscillator(),stop=source.stop.bind(source),id=++sourceId;source.stop=function(time){sourceStops.push(time);sourceStopEvents.push({id:id,kind:'oscillator',time:time});return stop(time);};return source;};
        window.actx=ctx;window.outGain=null;window.clickBus=null;window.guitarBus=null;window.dryGainNode=null;window.wetGainNode=null;
        window.reverbNode=null;window.bodyModes=[];window.trackedGuideVoices=[];window.stringVoices={};
        appState.acousticFx=false;appState.bodyAmount=0;appState.sympAmount=0;appState.synthEngine=engine;ensureAudioCtx();
        dryGainNode.gain.value=0.88;wetGainNode.gain.value=0;
        var startTime=0.1;
        if(loopSlots==null){
          parsed.measures[0].beats.forEach(function(beat,index){scheduleBeatGuide(beat,{startTime:startTime+index*slotDuration,slotDuration:slotDuration,
            measures:parsed.measures,maxDurationSlots:parsed.beats-index});});
        } else scheduleBeatGuide(parsed.measures[0].beats[0],{startTime:startTime,slotDuration:slotDuration,measures:parsed.measures,maxDurationSlots:loopSlots});
        var reattackTime=startTime+slotDuration,restTime=startTime+2*slotDuration,restWindowStart=restTime+0.04,restWindowEnd=restTime+0.2;
        var buffer=await ctx.startRendering(),left=buffer.getChannelData(0),right=buffer.getChannelData(1),peak=0,sum=0,count=0;
        for(var i=0;i<buffer.length;i++){peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));if(i>=Math.floor(restWindowStart*rate)&&i<Math.floor(restWindowEnd*rate)){var sample=(left[i]+right[i])*0.5;sum+=sample*sample;count++;}}
        var finalSourceStops=Object.values(sourceStopEvents.reduce(function(byId,event){byId[event.id]=event;return byId;},{}));
        return {sourceStops:sourceStops,sourceStopEvents:sourceStopEvents,finalSourceStops:finalSourceStops,afterRestRms:count?Math.sqrt(sum/count):0,peak:peak,slotDuration:slotDuration,startTime:startTime,
          reattackTime:loopSlots==null?reattackTime:null,restTime:loopSlots==null?restTime:null,restWindowStart:restWindowStart,restWindowEnd:restWindowEnd,
          loopStopAt:loopSlots==null?null:startTime+loopSlots*slotDuration};
      }
      return {engine:engine,restAndReattack:await renderScore('[C] 0E2@6:p 2F#2@6:p r',null),loopClip:await renderScore('[C] 0E2@6:p - -',0.5)};
    }
    async function renderChord(engine, chord, wet, amount){
      amount = amount == null ? 1 : amount;
      appState.acousticFx=wet; appState.bodyAmount=amount; appState.sympAmount=amount; appState.synthEngine=engine;
      var rate=48000, ctx=new OfflineAudioContext(2,rate*2.5,rate); ctx.resume=function(){ return Promise.resolve(); };
      window.actx=ctx; window.outGain=null; window.clickBus=null; window.guitarBus=null;
      window.dryGainNode=null; window.wetGainNode=null; window.reverbNode=null; window.bodyModes=[];
      window.trackedGuideVoices=[]; window.stringVoices={}; ensureAudioCtx(); dryGainNode.gain.value=0.88; wetGainNode.gain.value=wet?CONCERT_HALL_WET_GAIN:0;
      chord.forEach(function(midi,index){ playGuitarNote(midi,0.5,0.1,1,null,6-index,{exactDuration:true}); });
      var buffer=await ctx.startRendering(), peak=0, sum=0, count=0;
      for(var i=0;i<buffer.length;i++){
        var left=buffer.getChannelData(0)[i], right=buffer.getChannelData(1)[i];
        peak=Math.max(peak,Math.abs(left),Math.abs(right));
        if(i>=Math.floor(0.1*rate)&&i<Math.floor(1.2*rate)){var mono=(left+right)*0.5;sum+=mono*mono;count++;}
      }
      return {engine:engine,chord:chord.join('-'),fx:wet,bodyAmount:amount,sympAmount:amount,peak:peak,activeRms:Math.sqrt(sum/count)};
    }
    var result, matrix=[];
    try {
      for(var engine of ['ks','classic']) for(var duration of [0.125,0.5,1.5]) for(var wetMode of [false,true]){
        var item=await renderAt(engine,64,duration,wetMode?CONCERT_HALL_WET_GAIN:0,wetMode?0:0.88);
        matrix.push({engine:engine,duration:duration,fx:wetMode,peak:item.peak,earlyRms:item.earlyRms,tailRms:item.tailRms,sourceCount:item.sourceStops.length,
          maxSourceStop:item.sourceStops.length?Math.max.apply(null,item.sourceStops):null,sourceStops:item.sourceStops});
      }
      var dry = await renderAt('ks',64,0.5,0,0.88);
      var hall = await renderAt('ks',64,0.5,CONCERT_HALL_WET_GAIN,0);
      var forced = await renderAt('ks',64,1.5,0,0.88,0.5);
      var forcedClassic = await renderAt('classic',64,1.5,0,0.88,0.5);
      result = { matrix:matrix, dry:dry, hall:hall, forced:forced, gain:CONCERT_HALL_WET_GAIN,
        forcedClassic:forcedClassic,
        tailRatio:hall.tailRms/(await renderAt('ks',64,0.5,0.18,0)).tailRms,
        chords:[] };
      for(var engine of ['ks','classic']) for(var chordWet of [false,true]){
        result.chords.push(await renderChord(engine,[40,47,52,55,59,64],chordWet));
        result.chords.push(await renderChord(engine,[41,48,53,57,60,65],chordWet));
      }
      for(var engine of ['ks','classic']){
        result.chords.push(await renderChord(engine,[40,47,52,55,59,64],true,2));
        result.chords.push(await renderChord(engine,[41,48,53,57,60,65],true,2));
      }
      var lv6=allSongs.find(function(song){return song.id==='builtin-lv6-romance-full';});
      if(!lv6 || !lv6.measures || !lv6.measures[0]) throw new Error('Lv.6 Romance built-in score is unavailable for offline rendering');
      var lv6SlotDuration=60/Number(lv6.bpm || 56), lv6Events=[];
      lv6.measures[0].beats.forEach(function(beat,index){
        lv6Events=lv6Events.concat(getBeatGuideEvents(beat,{startTime:0.1+index*lv6SlotDuration,slotDuration:lv6SlotDuration,measures:lv6.measures}));
      });
      var lv6Renders=[];
      for(var engine of ['ks','classic']) for(var hallMode of [false,true]){
        lv6Renders.push(await renderRomance(engine,hallMode,lv6));
      }
      var lv6BassEvent=lv6Events.find(function(event){return event.note.midi===40;});
      var lv6BassPart=lv6.measures[0].beats[0].subNotes[0];
      var lv6OpeningChord=lv6BassPart.chordNotes;
      var lv6BassNote=lv6OpeningChord.find(function(note){return note.midi===40;});
      var lv6InnerParts=[lv6.measures[0].beats[0].subNotes[1],lv6.measures[0].beats[0].subNotes[2]];
      var lv6BassNominalDuration=Number(lv6BassPart.durationUnits)/GuitarRhythm.UNITS_PER_SLOT*lv6SlotDuration;
      var lv6BassStart=lv6BassEvent.when;
      var lv6BassNextStart=Infinity;
      lv6.measures.forEach(function(measure){measure.beats.forEach(function(beat){(beat.subNotes||[beat]).forEach(function(part){
        (part.chordNotes&&part.chordNotes.length?part.chordNotes:[part]).forEach(function(note){
          if(note.str===lv6BassNote.str&&Number.isFinite(Number(part.startUnits))&&part.startUnits>lv6BassPart.startUnits) lv6BassNextStart=Math.min(lv6BassNextStart,part.startUnits);
        });
      });});});
      if(!Number.isFinite(lv6BassNextStart)) throw new Error('Lv.6 opening bass has no later same-string attack for its natural-tail comparison');
      var lv6BassWindowEnd=lv6BassStart+(lv6BassNextStart-lv6BassPart.startUnits)/GuitarRhythm.UNITS_PER_SLOT*lv6SlotDuration-0.05;
      var lv6BassComparison=[];
      for(var bassEngine of ['ks','classic']){
        var gated=await renderIsolatedPart(bassEngine,lv6BassEvent,lv6BassNominalDuration,lv6SlotDuration,Number(lv6.beats),lv6BassStart,null,lv6BassWindowEnd,false);
        var natural=await renderIsolatedPart(bassEngine,lv6BassEvent,lv6BassNominalDuration,lv6SlotDuration,Number(lv6.beats),lv6BassStart,gated.windowStart,lv6BassWindowEnd,true);
        lv6BassComparison.push({engine:bassEngine,nominalDuration:lv6BassNominalDuration,sourceDurationUnits:Number(lv6BassPart.durationUnits),
          sourceStartUnits:Number(lv6BassPart.startUnits),nextSameStringUnits:lv6BassNextStart,windowStart:gated.windowStart,windowEnd:lv6BassWindowEnd,
          gatedWindowRms:gated.windowRms,naturalWindowRms:natural.windowRms,gatedSourceStops:gated.sourceStops,naturalSourceStops:natural.sourceStops,
          naturalPeak:natural.peak});
      }
      var m9=lv6.measures[8], m9Targets=[];
      m9.beats.forEach(function(beat,beatIndex){
        var guideEvents=getBeatGuideEvents(beat,{startTime:beatIndex*lv6SlotDuration,slotDuration:lv6SlotDuration,measures:lv6.measures,capo:getSongCapo(lv6)});
        guideEvents.forEach(function(event){if(((event.note.midi===66 && event.str===2) || (event.note.midi===63 && event.str===3)) &&
          !m9Targets.some(function(target){return target.event.note.midi===event.note.midi && target.event.str===event.str;})){
            var sourcePart=(beat.subNotes||[beat]).find(function(part){return (part.chordNotes&&part.chordNotes.length?part.chordNotes:[part]).indexOf(event.note)>=0;});
            m9Targets.push({event:event,sourcePart:sourcePart});
          }});
      });
      if(m9Targets.length!==2) throw new Error('Lv.6 measure 9 did not expose the expected F#4/D#4 inner notes on separate strings: '+JSON.stringify(m9.beats.map(function(beat){return getBeatGuideEvents(beat,{startTime:0,slotDuration:lv6SlotDuration,measures:lv6.measures}).map(function(event){return [event.note.midi,event.str,event.note.tok];});})));
      var m9Comparisons=[];
      for(var m9Target of m9Targets){
        var note=m9Target.event.note, sourcePart=m9Target.sourcePart, nextStart=Infinity;
        if(!sourcePart||!Number.isFinite(Number(sourcePart.startUnits))) throw new Error('Lv.6 m9 inner note did not retain its source part start position');
        lv6.measures.forEach(function(measure){measure.beats.forEach(function(beat){(beat.subNotes||[beat]).forEach(function(part){
          (part.chordNotes&&part.chordNotes.length?part.chordNotes:[part]).forEach(function(candidate){
            if(candidate.str===note.str && Number.isFinite(Number(part.startUnits)) && part.startUnits>sourcePart.startUnits) nextStart=Math.min(nextStart,part.startUnits);
          });
        });});});
        if(!Number.isFinite(nextStart)) throw new Error('Lv.6 measure 9 inner note has no later same-string attack for a bounded natural-tail window');
        var start=0.1, slotsUntilNext=(nextStart-sourcePart.startUnits)/GuitarRhythm.UNITS_PER_SLOT;
        var nextAt=start+slotsUntilNext*lv6SlotDuration, windowEnd=nextAt-0.02;
        var gate=await renderIsolatedPart('ks',m9Target.event,m9Target.event.duration,lv6SlotDuration,slotsUntilNext,start,null,windowEnd,false);
        var natural=await renderIsolatedPart('ks',m9Target.event,m9Target.event.duration,lv6SlotDuration,slotsUntilNext,start,gate.windowStart,windowEnd,true);
        var classicGate=await renderIsolatedPart('classic',m9Target.event,m9Target.event.duration,lv6SlotDuration,slotsUntilNext,start,null,windowEnd,false);
        var classicNatural=await renderIsolatedPart('classic',m9Target.event,m9Target.event.duration,lv6SlotDuration,slotsUntilNext,start,classicGate.windowStart,windowEnd,true);
        m9Comparisons.push({midi:note.midi,str:note.str,durationUnits:sourcePart.durationUnits,sourceStartUnits:sourcePart.startUnits,duration:m9Target.event.duration,
          nextSameStringUnits:nextStart,nextAt:nextAt,ks:{windowStart:gate.windowStart,windowEnd:windowEnd,gatedRms:gate.windowRms,naturalRms:natural.windowRms,
            peak:natural.peak,sourceStops:gate.sourceStops},
          classic:{windowStart:classicGate.windowStart,windowEnd:windowEnd,gatedRms:classicGate.windowRms,naturalRms:classicNatural.windowRms,
            peak:classicNatural.peak,sourceStops:classicGate.sourceStops}});
      }
      var naturalBoundaries=[];
      for(var boundaryEngine of ['ks','classic']) naturalBoundaries.push(await renderNaturalBoundaries(boundaryEngine));
      result.naturalBoundaries=naturalBoundaries;
      result.lv6FirstMeasure={id:lv6.id,bpm:lv6.bpm,events:lv6Events.map(function(event){return {
        midi:event.note.midi,when:event.when,duration:event.duration,gain:event.gain,articulation:event.articulation,str:event.str
      };}),beats:Number(lv6.beats),unitsPerSlot:Number(GuitarRhythm.UNITS_PER_SLOT),
        bassDurationUnits:Number(lv6BassPart.durationUnits),melodyDurationUnits:Number(lv6BassPart.durationUnits),
        durationUnits:{bass:lv6BassPart.durationUnits,melody:lv6BassPart.durationUnits,
          inners:lv6InnerParts.map(function(part){return part.durationUnits;}),slotUnits:lv6.measures[0].beats[0].subNotes[0].slotUnits},
        bassNominalDuration:lv6BassNominalDuration,bassWindowEnd:lv6BassWindowEnd,
        bassComparison:lv6BassComparison.map(function(item){return {engine:item.engine,nominalDuration:item.nominalDuration,sourceDurationUnits:item.sourceDurationUnits,
          sourceStartUnits:item.sourceStartUnits,nextSameStringUnits:item.nextSameStringUnits,windowStart:item.windowStart,windowEnd:item.windowEnd,
          gatedWindowRms:item.gatedWindowRms,naturalWindowRms:item.naturalWindowRms,gatedSourceStops:item.gatedSourceStops,naturalSourceStops:item.naturalSourceStops,
          naturalPeak:item.naturalPeak};}),
        m9Comparisons:m9Comparisons,renders:lv6Renders};
    } finally {
      window.actx=saved.actx; window.outGain=saved.outGain; window.clickBus=saved.clickBus;
      window.guitarBus=saved.guitarBus; window.dryGainNode=saved.dryGainNode; window.wetGainNode=saved.wetGainNode;
      window.reverbNode=saved.reverbNode; window.bodyModes=saved.bodyModes;
      window.trackedGuideVoices=saved.trackedGuideVoices; window.stringVoices=saved.stringVoices;
      appState.acousticFx=saved.acousticFx; appState.bodyAmount=saved.bodyAmount;
      appState.sympAmount=saved.sympAmount; appState.synthEngine=saved.synthEngine;
    }
    result.restored = window.actx===saved.actx && window.outGain===saved.outGain && window.guitarBus===saved.guitarBus &&
      window.wetGainNode===saved.wetGainNode && appState.acousticFx===saved.acousticFx &&
      appState.bodyAmount===saved.bodyAmount && appState.sympAmount===saved.sympAmount && appState.synthEngine===saved.synthEngine;
    return result;
  })()`);
  assert.equal(render.gain, 0.35, 'offline render uses the production wet gain');
  assert.equal(render.restored, true, 'offline measurement restores the live AudioContext graph and app settings');
  assert.ok(render.dry.tailRms < 1e-8, 'dry KS render is silent after the natural release bound');
  assert.ok(render.hall.tailRms > 0, 'hall KS render has a real post-note-off convolver tail');
  assert.ok(render.matrix.every(function(item){ return item.earlyRms > 0; }), 'KS and classic actual audio graphs render audible nonzero samples');
  assert.ok(Math.abs(render.tailRatio / (0.35 / 0.18) - 1) < 0.05, 'isolated wet tail RMS follows the wet-gain ratio within 5%');
  assert.ok(render.matrix.every(function(item){ return item.peak < 1 && item.maxSourceStop <= 0.1 + item.duration + 0.4 + 1e-6; }), 'KS/classic, hall/dry, and .125/.5/1.5s renders stay below full scale and natural release bound');
  assert.ok(render.forced.sourceStops.length === 1 && Math.abs(render.forced.sourceStops[0] - 0.515) < 1e-6, 'hard loop boundary stops KS direct source within 15ms');
  assert.ok(render.forced.lateRms < 1e-8, 'hard loop boundary render is silent after its 15ms cutoff');
  assert.ok(render.forcedClassic.sourceStops.length === 3 && render.forcedClassic.sourceStops.every(function(stop){return Math.abs(stop - 0.515) < 1e-6;}), 'hard loop boundary stops all three classic oscillators within 15ms');
  assert.ok(render.forcedClassic.lateRms < 1e-8, 'hard loop boundary render is silent for classic output after its 15ms cutoff');
  assert.ok(render.chords.every(function(chord){ return chord.peak < 1 && chord.activeRms > 0; }), 'valid six-string Em/F chords render for KS/classic with dry/hall routing and body/sympathetic amount 1 or 2, without clipping');
  assert.equal(render.lv6FirstMeasure.id, 'builtin-lv6-romance-full', 'offline render uses the actual Lv.6 built-in score');
  assert.equal(render.lv6FirstMeasure.events.length, 10, 'Lv.6 first measure guide emits bass, melody, and inner voice notes');
  assert.deepEqual(render.lv6FirstMeasure.events.slice(0, 2).map(function(event){return [event.midi,event.gain,event.articulation,event.str];}),
    [[40,1,null,6],[71,1.16,'apoyando',1]], 'Lv.6 opening bass (unmarked, so tirando) and melody retain their written articulation and strings');
  assert.equal(render.lv6FirstMeasure.durationUnits.bass, render.lv6FirstMeasure.durationUnits.melody,
    'Lv.6 opening bass and melody use one shared chord duration');
  assert.equal(render.lv6FirstMeasure.durationUnits.bass, render.lv6FirstMeasure.durationUnits.slotUnits,
    'Lv.6 opening chord uses its parsed subdivision duration');
  assert.ok(render.lv6FirstMeasure.durationUnits.inners.every(function(units){return units === render.lv6FirstMeasure.durationUnits.slotUnits;}),
    'Lv.6 inner notes retain their default one-subdivision duration');
  const lv6BassEvent = render.lv6FirstMeasure.events.find(function(event){return event.midi === 40;});
  const lv6MelodyEvent = render.lv6FirstMeasure.events.find(function(event){return event.midi === 71;});
  assert.ok(Math.abs(lv6BassEvent.duration - render.lv6FirstMeasure.bassDurationUnits / 12 * 60 / render.lv6FirstMeasure.bpm) < 1e-9 &&
    Math.abs(lv6MelodyEvent.duration - lv6BassEvent.duration) < 1e-9,
    'Lv.6 chord event durations convert the common parsed part units through the song tempo');
  assert.equal(render.lv6FirstMeasure.bassComparison.length, 2, 'isolated Romance bass comparison covers both existing synth engines');
  assert.ok(render.lv6FirstMeasure.bassComparison.every(function(item){return item.sourceDurationUnits > 0 &&
    item.windowStart > Math.max.apply(null,item.gatedSourceStops) && item.windowEnd < 0.1 + item.nextSameStringUnits / render.lv6FirstMeasure.unitsPerSlot * 60 / render.lv6FirstMeasure.bpm &&
    item.windowEnd > item.windowStart && item.gatedWindowRms < 1e-8 && item.naturalWindowRms > 1e-8 && item.naturalPeak < 1;}),
    'KS and classic keep a short subdivision E2 ringing after its legacy gate and before the next same-string attack');
  assert.equal(render.lv6FirstMeasure.m9Comparisons.length, 2, 'actual measure 9 inner-note isolation covers F#4 and D#4');
  assert.deepEqual(render.lv6FirstMeasure.m9Comparisons.map(function(item){return [item.midi,item.str];}), [[66,2],[63,3]],
    'm9 sustain window targets parsed F#4 on string 2 and D#4 on string 3');
  assert.ok(render.lv6FirstMeasure.m9Comparisons.every(function(item){return item.durationUnits === render.lv6FirstMeasure.durationUnits.inners[0] &&
    item.ks.windowStart > Math.max.apply(null,item.ks.sourceStops) && item.classic.windowStart > Math.max.apply(null,item.classic.sourceStops) &&
    item.ks.windowEnd < item.nextAt && item.classic.windowEnd < item.nextAt && item.ks.windowEnd > item.ks.windowStart &&
    item.classic.windowEnd > item.classic.windowStart && item.ks.gatedRms < 1e-8 && item.classic.gatedRms < 1e-8 &&
    item.ks.naturalRms > 1e-8 && item.classic.naturalRms > 1e-8 && item.ks.peak < 1 && item.classic.peak < 1;}),
    'actual Lv.6 measure 9 F#4/D#4 inner notes ring on their independent strings after each nominal duration, before the next same-string attack');
  assert.ok(render.naturalBoundaries.length===2 && render.naturalBoundaries.every(function(item){
    var reattack=item.restAndReattack.reattackTime;
    var rest=item.restAndReattack.restTime;
    var loopHardStop=item.loopClip.loopStopAt;
    return item.restAndReattack.finalSourceStops.some(function(entry){return entry.time>=reattack&&entry.time<=reattack+0.12;}) &&
      item.restAndReattack.finalSourceStops.every(function(entry){return entry.time<=rest+0.02;}) &&
      item.restAndReattack.afterRestRms<1e-8 && item.loopClip.finalSourceStops.length>0 &&
      item.loopClip.finalSourceStops.every(function(entry){return entry.time>=loopHardStop&&entry.time<=loopHardStop+0.02;}) &&
      item.restAndReattack.peak<1 && item.loopClip.peak<1;}),
    'actual natural guide voices are cut by same-string reattack, a rest, and a loop hard stop in KS/classic offline rendering: '+JSON.stringify(render.naturalBoundaries));
  assert.ok(render.lv6FirstMeasure.renders.length === 4 && render.lv6FirstMeasure.renders.every(function(item){return item.peak < 1 && item.rms > 0 && item.eventCount === 10;}),
    'actual scheduleBeatGuide Lv.6 first measure renders audible, unclipped KS/classic dry/hall audio');
  process.stdout.write('Browser checkpoint: OfflineAudioContext legacy exact API matrix, KS/classic hard cutoff, 12 duration/FX cases, isolated hall tail, 12 six-string chords, four actual scheduleBeatGuide Lv.6 first-measure renders, short-subdivision E2 natural-tail comparison, and m9 F#4/D#4 direct-sound sustain windows passed (wet tail ratio ' + render.tailRatio.toFixed(4) + ', max chord peak ' + Math.max.apply(null,render.chords.map(function(chord){return chord.peak;})).toFixed(4) + ')\n');
}

async function main() {
  await runBrowserSuite(async ({ cdp }) => {
    await cdp.evaluate('(async function(){ ensureAudioCtx(); if (window.actx && window.actx.state === "suspended") await window.actx.resume(); })()');
    await testConcertHallOfflineRender(cdp);
    process.stdout.write('Result: browser audio offline-render suite passed (0 console errors)\n');
  });
}

main().catch(err => {
  console.error('Browser audio test failed:', err);
  process.exitCode = 1;
});
