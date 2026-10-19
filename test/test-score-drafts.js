const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const parser = require('../src/parser.js');
const {createScoreDraftStore} = require('../src/score-drafts.js');

let checks = 0;
function test(name, fn){
  fn();
  checks++;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

function song(id, title, lines, beats, extra){
  return Object.assign(parser.buildStructuredSong(Object.assign({
    id:id, title:title, badge:'기본 배지', bpm:72, beats:beats || 4, capo:2, lines:lines
  }, extra || {})), extra || {});
}

function captureFailure(fn){
  let caught = null;
  try { fn(); } catch(error){ caught = error; }
  assert.ok(caught, 'invalid candidate must fail');
  assert.ok(caught.message && /마디/.test(caught.message), 'error message contains the first issue and its position');
  assert.ok(Array.isArray(caught.errors) && caught.errors.length, 'error exposes parser diagnostics');
  return caught;
}

test('CommonJS API and unknown status are available without global writes', function(){
  assert.equal(typeof createScoreDraftStore, 'function');
  assert.equal(global.GuitarParser, undefined);
  const store = createScoreDraftStore();
  assert.deepEqual(store.status('missing'), {dirty:false,temporary:false,origin:null});
  assert.equal(store.get('missing'), null);
  ['createBlank','apply','remove','undo'].forEach(name=>assert.equal(store[name], undefined, name + ' is removed'));
  assert.equal(typeof store.replaceScore, 'function');
});

test('structured sources are cloned, empty originals stay unchanged, and image sources pass through', function(){
  const original = {id:'empty',title:'빈 악보',type:'structured',beats:3,measures:[],capo:0};
  const frozen = JSON.parse(JSON.stringify(original));
  const image = {id:'image',type:'image',src:'scan.png'};
  const sources = [original,image];
  const store = createScoreDraftStore();
  const listed = store.list(sources);
  assert.deepEqual(original, frozen, 'registering a source does not mutate it');
  assert.notStrictEqual(listed[0], original);
  assert.strictEqual(listed[1], image);
  assert.equal(listed[0].measures.length, 0);
  assert.deepEqual(store.status('empty'), {dirty:false,temporary:false,origin:null});
  original.title = '입력 변경';
  assert.equal(store.get('empty').title, '빈 악보');
});

test('replaceScore makes a source without any state a draft: measures replaced, title bpm badge and extras kept', function(){
  const source = song('edit', '편집', ['[C] C4 - - - | "원본"','[G] D4 - - -'], 4, {fromSheet:'sheet-1',ytUrl:'https://example.test'});
  const frozen = JSON.parse(JSON.stringify(source));
  const store = createScoreDraftStore();
  assert.deepEqual(store.status('edit'), {dirty:false,temporary:false,origin:null}, 'no state before the call');
  const edited = store.replaceScore(source, ['[Am] E4 - - - | "수정"','[F] G4 - - -','[C] r r r r'], {key:2, origin:'tab-input'});
  assert.deepEqual(source, frozen, 'the source object is not mutated');
  assert.equal(edited.id, 'edit');
  assert.equal(edited.title, '편집');
  assert.equal(edited.bpm, 72);
  assert.equal(edited.badge, '기본 배지');
  assert.equal(edited.capo, 2);
  assert.equal(edited.fromSheet, 'sheet-1');
  assert.equal(edited.ytUrl, 'https://example.test');
  assert.equal(edited.measures.length, 3);
  assert.equal(edited.measures[0].chord, 'Am');
  assert.equal(edited.measures[0].lyric, '수정');
  assert.deepEqual(edited.measures[0].beats.map(beat=>beat.tok), ['E4','-','-','-']);
  assert.equal(edited.key, 2);
  assert.strictEqual(store.get('edit'), edited);
  assert.deepEqual(store.status('edit'), {dirty:true,temporary:false,origin:'tab-input'});
  const listed = store.list([source]);
  assert.strictEqual(listed[0], edited, 'a later list() keeps the draft instead of refreshing it');
});

test('replaceScore on a state that already exists replaces the song object and keeps the first original for reset', function(){
  const source = song('again', '다시', ['[C] C4 - - -'], 4);
  const store = createScoreDraftStore();
  const first = store.list([source])[0];
  const second = store.replaceScore(first, '[G] D4 - - -', {origin:'tab-input'});
  assert.notStrictEqual(second, first);
  assert.equal(first.measures[0].chord, 'C', 'the object returned before is not mutated');
  const third = store.replaceScore(second, ['[Am] E4 - - -'], {});
  assert.equal(third.measures[0].chord, 'Am');
  assert.equal(store.status('again').origin, null, 'origin follows the last call');
  const reset = store.reset('again');
  assert.equal(reset.measures[0].chord, 'C');
});

test('replaceScore key: -5..5 integers are stored, anything else removes the key', function(){
  const source = song('keyed', '조표', ['[C] C4 - - -'], 4, {key:3});
  const store = createScoreDraftStore();
  assert.equal(store.replaceScore(source, ['[C] D4 - - -'], {key:-5}).key, -5);
  assert.equal(store.replaceScore(source, ['[C] D4 - - -'], {key:0}).key, 0);
  [6, -6, 1.5, '2', null, undefined].forEach(function(bad){
    assert.equal('key' in store.replaceScore(source, ['[C] D4 - - -'], {key:bad}), false, 'key ' + bad + ' is removed');
  });
  assert.equal('key' in store.replaceScore(source, ['[C] D4 - - -']), false, 'no options removes the key');
});

test('a key-only difference makes the draft dirty, survives list(), and reset restores the original key', function(){
  const same = ['[C] C4 - - -'];
  const source = song('key-only', '조표만', same, 4);
  const store = createScoreDraftStore();
  const draft = store.replaceScore(source, same, {key:2, origin:'tab-input'});
  assert.equal(draft.key, 2);
  assert.deepEqual(store.status('key-only'), {dirty:true,temporary:false,origin:'tab-input'}, 'same measures with another key is a modified draft');
  assert.strictEqual(store.list([source])[0], draft, 'list() does not overwrite the draft with the source');
  assert.equal(store.get('key-only').key, 2, 'the key is still there after list()');
  const reset = store.reset('key-only');
  assert.equal('key' in reset, false, 'reset brings back the original, which had no key');
  assert.equal(store.status('key-only').dirty, false);
  store.replaceScore(source, same, {key:0});
  assert.equal(store.status('key-only').dirty, false, 'no key in the source and key 0 in the draft are the same thing');
  const keyed = song('key-kept', '조표 원본', same, 4, {key:3});
  const store2 = createScoreDraftStore();
  store2.replaceScore(keyed, same, {key:3});
  assert.equal(store2.status('key-kept').dirty, false, 'the same key is not a difference');
  store2.replaceScore(keyed, same, {});
  assert.equal(store2.status('key-kept').dirty, true, 'dropping the original key is a difference');
  assert.equal(store2.reset('key-kept').key, 3, 'reset brings back the original key');
});

test('replaceScore rejects unreadable lines atomically with the measure position', function(){
  const source = song('atomic', '원자성', ['[C] C4 - - -','[C] - - - -'], 4);
  const store = createScoreDraftStore();
  const failure = captureFailure(()=>store.replaceScore(source, ['[C] Q9 - - -','[C] - - - -'], {origin:'tab-input'}));
  assert.match(failure.message, /마디 1/);
  assert.equal(store.get('atomic'), null, 'a failed call registers no state');
  assert.deepEqual(store.status('atomic'), {dirty:false,temporary:false,origin:null});
  const baseline = store.replaceScore(source, ['[C] D4 - - -','[C] - - - -'], {origin:'tab-input'});
  const statusBefore = store.status('atomic');
  [
    ['[C] D4 - -'],
    ['[C] D4 - - -','[C] E4 - -'],
    ['[C] D4 - - - //'],
    ['// [C] D4 - - -']
  ].forEach(function(lines){
    const error = captureFailure(()=>store.replaceScore(source, lines, {origin:'tab-input'}));
    assert.ok(/마디 \d/.test(error.message));
    assert.strictEqual(store.get('atomic'), baseline, 'failed call preserves the current object');
    assert.deepEqual(store.status('atomic'), statusBefore);
  });
  assert.throws(()=>store.replaceScore({id:'pic',type:'image'}, ['[C] C4 - - -']), error=>Array.isArray(error.errors));
  assert.throws(()=>store.replaceScore(null, ['[C] C4 - - -']), error=>Array.isArray(error.errors));
});

test('reset after replaceScore brings back the original score and clears the origin', function(){
  const source = song('back', '되돌림', ['[C] C4 - - - | "원본"','[G] D4 - - -'], 4);
  const store = createScoreDraftStore();
  store.replaceScore(source, ['[Am] E4 - - - | "수정"'], {key:1, origin:'tab-input'});
  assert.equal(store.status('back').dirty, true);
  const reset = store.reset('back');
  assert.equal(reset.measures.length, 2);
  assert.equal(reset.measures[0].lyric, '원본');
  assert.equal('key' in reset, false);
  assert.deepEqual(store.status('back'), {dirty:false,temporary:false,origin:null});
  assert.deepEqual(source.measures[0].beats.map(beat=>beat.tok), ['C4','-','-','-']);
});

test('quoted slash memo and a hold continuing from the previous measure remain valid', function(){
  const source = song('joined','마디 연결',['[C] C4 - - -','[C] - - - -'],4);
  const store = createScoreDraftStore();
  const edited = store.replaceScore(source, ['[C] E4 - - - | "memo // / |"','[C] - - - -']);
  assert.equal(edited.measures[0].lyric,'memo // / |');
  assert.equal(edited.measures[1].beats[0].kind,'hold');
  assert.equal(edited.measures[1].beats[0].tieFrom.measureIndex,0);
});

test('explicit fingering, articulation, and JSON memo survive replaceScore and canonical round trip', function(){
  const source = song('written','표기',['[C] C4 - - -'],4);
  const store = createScoreDraftStore();
  const edited = store.replaceScore(source, ['[C] 0E4:p !1F4 3G4 r | "메모 *3"']);
  const serialized = parser.serializeScoreMeasures(edited.measures);
  assert.match(serialized,/0E4:p/);
  assert.match(serialized,/!1F4/);
  assert.match(serialized,/3G4/);
  assert.match(serialized, /"메모 \*3"/);
  const reparsed = parser.parseScore(serialized,4);
  assert.deepEqual(reparsed.errors,[]);
  assert.equal(reparsed.measures[0].lyric,'메모 *3');
  assert.deepEqual(reparsed.measures[0].beats.map(beat=>beat.tok),['0E4:p','!1F4','3G4','r']);
});

test('clean sources refresh while dirty drafts and their original reset snapshot survive re-registration', function(){
  const first = song('refresh','초기',['[C] C4 - - -'],4);
  const second = song('refresh','최신 clean',['[G] D4 - - -'],4,{capo:4});
  const third = song('refresh','새 원본',['[Am] E4 - - -'],4,{capo:5});
  const store = createScoreDraftStore();
  store.list([first]);
  store.list([second]);
  assert.equal(store.get('refresh').title,'최신 clean');
  assert.equal(store.get('refresh').capo,4);
  store.replaceScore(store.get('refresh'), ['[F] F4 - - -']);
  const dirtyDraft = store.get('refresh');
  const listed = store.list([third]);
  assert.strictEqual(listed[0],dirtyDraft);
  assert.equal(listed[0].title,'최신 clean');
  store.reset('refresh');
  assert.equal(store.get('refresh').title,'최신 clean');
  assert.equal(store.get('refresh').measures[0].chord,'G');
});

test('dirty drafts and created temporary scores remain visible when sources disappear', function(){
  const store = createScoreDraftStore();
  const persist = song('persist','유지',['[C] C4 - - -'],4);
  store.list([persist,song('clean','사라질 clean',['[C] E4 - - -'],4)]);
  store.replaceScore(persist, ['[C] D4 - - -']);
  const made = store.createFromScore({title:'임시',beats:4,bpm:64,lines:['[-] r r r r']});
  const results = store.list([]);
  assert.deepEqual(results.map(item=>item.id),['persist',made.id]);
  assert.equal(store.get('clean').title,'사라질 clean');
  assert.equal(store.status(made.id).temporary,true);
});

test('createFromScore builds a temporary structured song with origin and rejects invalid text', function(){
  const store = createScoreDraftStore();
  const lines = ['[-] E4@1 - G4@1 - | ""', '[Am] A2@5+E4@1 r r r | "끝"'];
  const made = store.createFromScore({title:'넘김 시험',beats:4,bpm:72,badge:'시험 · Capo 2',lines:lines,origin:'tab-input'});
  assert.match(made.id, /^temp-score-\d+$/);
  assert.equal(made.type, 'structured');
  assert.equal(made.builtin, false);
  assert.equal(made.measures.length, 2);
  assert.equal(made.title, '넘김 시험');
  assert.equal(made.bpm, 72);
  assert.equal(made.badge, '시험 · Capo 2');
  const status = store.status(made.id);
  assert.equal(status.dirty, false);
  assert.equal(status.temporary, true);
  assert.equal(status.origin, 'tab-input');
  assert.equal(store.get(made.id), made);
  const fromText = store.createFromScore({title:'문자열',beats:4,bpm:64,lines:lines.join('\n')});
  assert.equal(fromText.badge, '임시 악보', 'badge defaults to the temporary score label');
  assert.equal(fromText.measures.length, 2);
  assert.equal(store.status(fromText.id).origin, null);
  assert.notEqual(fromText.id, made.id);
  store.replaceScore(made, ['[-] E4@1 - G4@1 - | ""', '[Am] A2@5+E4@1 r r r | "고침"'], {origin:'tab-input'});
  assert.equal(store.status(made.id).dirty, true, 'editing marks the created score dirty');
  assert.equal(store.status(made.id).temporary, true);
  assert.equal(store.status(made.id).origin, 'tab-input');
  captureFailure(function(){ store.createFromScore({title:'틀림',beats:4,bpm:64,lines:['[-] Q9 r r r']}); });
});

test('createFromScore keeps a key signature of -5..5 on the song and ignores anything else', function(){
  const store = createScoreDraftStore();
  const lines = ['[-] E4@1 - G4@1 - | ""'];
  assert.equal(store.createFromScore({title:'조표',beats:4,bpm:72,lines:lines,key:1}).key, 1);
  assert.equal(store.createFromScore({title:'조표',beats:4,bpm:72,lines:lines,key:-5}).key, -5);
  assert.equal(store.createFromScore({title:'조표',beats:4,bpm:72,lines:lines,key:0}).key, 0);
  [6, -6, 1.5, '2', null].forEach(function(bad){
    assert.equal('key' in store.createFromScore({title:'조표',beats:4,bpm:72,lines:lines,key:bad}), false, 'key ' + bad + ' is not stored');
  });
  assert.equal('key' in store.createFromScore({title:'조표',beats:4,bpm:72,lines:lines}), false);
});

test('browser global export works in a VM without DOM or storage globals', function(){
  const context = vm.createContext({console:console,Map:Map,Set:Set,Array:Array,Number:Number,Math:Math,JSON:JSON,Error:Error,Object:Object,String:String,RegExp:RegExp});
  context.window = context;
  ['notation.js','rhythm.js','parser.js','score-drafts.js'].forEach(function(file){
    vm.runInContext(fs.readFileSync(path.join(__dirname,'..','src',file),'utf8'),context,{filename:file});
  });
  assert.equal(vm.runInContext('typeof document',context),'undefined');
  assert.equal(vm.runInContext('typeof localStorage',context),'undefined');
  assert.equal(vm.runInContext('typeof indexedDB',context),'undefined');
  assert.equal(vm.runInContext('typeof createScoreDraftStore',context),'function');
  assert.equal(vm.runInContext('createScoreDraftStore().createFromScore({title:"VM",beats:2,bpm:64,lines:["[-] r r"]}).measures[0].beats.length',context),2);
});

process.stdout.write('1..' + checks + '\n');
