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
  assert.deepEqual(store.status('missing'), {dirty:false,temporary:false,canUndo:false,origin:null});
  assert.equal(store.get('missing'), null);
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
  assert.deepEqual(store.status('empty'), {dirty:false,temporary:false,canUndo:false,origin:null});
  original.title = '입력 변경';
  assert.equal(store.get('empty').title, '빈 악보');
  const blank = store.createBlank({title:'쉼표 시작',beats:3});
  assert.deepEqual(blank.measures[0].beats.map(beat=>beat.tok), ['r','r','r']);
});

test('blank drafts use parser-valid rest bars and retain temporary metadata', function(){
  const store = createScoreDraftStore();
  const blank = store.createBlank({title:'새 악보',beats:'3',bpm:80});
  assert.match(blank.id, /^temp-score-\d+$/);
  assert.equal(blank.title, '새 악보');
  assert.equal(blank.badge, '임시 악보');
  assert.equal(blank.type, 'structured');
  assert.equal(blank.builtin, false);
  assert.equal(blank.capo, 0);
  assert.equal(blank.beats, 3);
  assert.equal(blank.bpm, 80);
  assert.deepEqual(blank.measures[0].beats.map(beat=>beat.tok), ['r','r','r']);
  assert.deepEqual(store.status(blank.id), {dirty:false,temporary:true,canUndo:false,origin:null});
  assert.throws(()=>store.createBlank({beats:0}), error=>error.errors.some(item=>item.code === 'INVALID_BEATS'));
});

test('apply, insert, remove, one-step undo, and reset replace objects without mutating older returns', function(){
  const source = song('edit', '편집', ['[C] C4 - - - | "원본"','[G] D4 - - -'], 4, {fromSheet:'sheet-1',ytUrl:'https://example.test'});
  const store = createScoreDraftStore();
  store.list([source]);
  const before = store.get('edit');
  const edited = store.apply('edit',0,'[Am] E4 - - - | "수정"',false);
  assert.notStrictEqual(edited,before);
  assert.equal(before.measures[0].lyric,'원본');
  assert.equal(edited.measures[0].chord,'Am');
  assert.equal(edited.fromSheet,'sheet-1');
  assert.equal(edited.ytUrl,'https://example.test');
  assert.equal(store.status('edit').dirty,true);
  assert.equal(store.status('edit').canUndo,true);
  const inserted = store.apply('edit',0,'[F] G4 - - -',true);
  assert.equal(inserted.measures.length,3);
  assert.equal(inserted.measures[1].chord,'F');
  assert.equal(store.undo('edit').measures.length,2);
  assert.equal(store.status('edit').canUndo,false);
  const removed = store.remove('edit',1);
  assert.equal(removed.measures.length,1);
  assert.equal(store.undo('edit').measures.length,2);
  const preReset = store.get('edit');
  const reset = store.reset('edit');
  assert.notStrictEqual(reset,preReset);
  assert.equal(reset.measures[0].lyric,'원본');
  assert.equal(store.status('edit').dirty,false);
  assert.equal(store.status('edit').canUndo,true);
  assert.equal(store.undo('edit').measures[0].lyric,'수정');
  assert.equal(store.status('edit').dirty,true);
  assert.deepEqual(source.measures[0].beats.map(beat=>beat.tok), ['C4','-','-','-']);
});

test('measure-only and whole-score validation failures are atomic and report locations', function(){
  const store = createScoreDraftStore();
  store.list([song('atomic','원자성',['[C] C4 - - -','[C] - - - -'],4)]);
  const id = 'atomic';
  const baseline = store.get(id);
  const baselineStatus = store.status(id);
  const failures = [
    ()=>store.apply(id,0,'[C] D4 - - -\n[C] E4 - - -',false),
    ()=>store.apply(id,0,'[C] D4 - -',false),
    ()=>store.apply(id,0,'[C] r r r r',false)
  ];
  failures.forEach(function(fail){
    captureFailure(fail);
    assert.strictEqual(store.get(id),baseline,'failed operation preserves the current returned object');
    assert.deepEqual(store.status(id),baselineStatus,'failed operation preserves dirty and undo state');
  });
  [
    '[C] D4 - - - //',
    '// [C] D4 - - -'
  ].forEach(function(raw){
    const error = captureFailure(()=>store.apply(id,0,raw,false));
    assert.ok(error.errors.some(item=>item.code === 'EMPTY_MEASURE'), 'boundary double slash is validated as part of the full score');
    assert.strictEqual(store.get(id),baseline,'boundary failure leaves the score object unchanged');
    assert.deepEqual(store.status(id),baselineStatus,'boundary failure leaves dirty and undo state unchanged');
  });
  assert.throws(()=>store.remove(id,0), error=>error.errors.some(item=>/HOLD/.test(item.code)), 'removing an attack that feeds a later bar hold is rejected');
  assert.strictEqual(store.get(id),baseline);
  assert.deepEqual(store.status(id),baselineStatus);
});

test('quoted slash memo and a hold continuing from the previous measure remain valid edits', function(){
  const store = createScoreDraftStore();
  store.list([song('joined','마디 연결',['[C] C4 - - -','[C] - - - -'],4)]);
  const edited = store.apply('joined',0,'[C] E4 - - - | "memo // / |"',false);
  assert.equal(edited.measures[0].lyric,'memo // / |');
  assert.equal(edited.measures[1].beats[0].tieFrom.measureIndex,0);
  const held = store.apply('joined',1,'[C] - - - -',false);
  assert.equal(held.measures[1].beats[0].kind,'hold');
  assert.equal(held.measures[1].beats[0].tieFrom.measureIndex,0);
});

test('last-bar deletion is blocked and remains atomic', function(){
  const store = createScoreDraftStore();
  store.list([song('last','한 마디',['[C] C4 - - -'],4)]);
  const before = store.get('last');
  assert.throws(()=>store.remove('last',0), error=>error.errors.some(item=>item.code === 'LAST_MEASURE'));
  assert.strictEqual(store.get('last'),before);
  assert.equal(store.status('last').canUndo,false);
});

test('explicit fingering, articulation, and JSON memo survive full-score edits and canonical round trip', function(){
  const store = createScoreDraftStore();
  store.list([song('written','표기',['[C] C4 - - -'],4)]);
  const edited = store.apply('written',0,'[C] 0E4:p !1F4 3G4 r | "메모 *3"',false);
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
  store.apply('refresh',0,'[F] F4 - - -',false);
  const dirtyDraft = store.get('refresh');
  const listed = store.list([third]);
  assert.strictEqual(listed[0],dirtyDraft);
  assert.equal(listed[0].title,'최신 clean');
  store.reset('refresh');
  assert.equal(store.get('refresh').title,'최신 clean');
  assert.equal(store.get('refresh').measures[0].chord,'G');
});

test('source score changes invalidate stale undo snapshots after a clean refresh', function(){
  const store = createScoreDraftStore();
  store.list([song('undo-refresh','초기',['[C] C4 - - -'],4)]);
  store.apply('undo-refresh',0,'[G] D4 - - -',false);
  store.reset('undo-refresh');
  assert.equal(store.status('undo-refresh').canUndo,true);
  store.list([song('undo-refresh','새 원본',['[Am] E4 - - -'],4)]);
  assert.equal(store.get('undo-refresh').title,'새 원본');
  assert.equal(store.status('undo-refresh').canUndo,false);
  assert.equal(store.undo('undo-refresh').measures[0].chord,'Am');
});

test('dirty drafts and blank drafts remain visible when sources disappear', function(){
  const store = createScoreDraftStore();
  store.list([song('persist','유지',['[C] C4 - - -'],4),song('clean','사라질 clean',['[C] E4 - - -'],4)]);
  store.apply('persist',0,'[C] D4 - - -',false);
  const blank = store.createBlank({title:'임시'});
  const results = store.list([]);
  assert.deepEqual(results.map(item=>item.id),['persist',blank.id]);
  assert.equal(store.get('clean').title,'사라질 clean');
  assert.equal(store.status(blank.id).temporary,true);
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
  store.apply(made.id, 1, '[Am] A2@5+E4@1 r r r | "고침"', false);
  assert.equal(store.status(made.id).dirty, true, 'editing marks the created score dirty');
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
  assert.equal(vm.runInContext('createScoreDraftStore().createBlank({title:"VM",beats:2}).measures[0].beats.length',context),2);
});

process.stdout.write('1..' + checks + '\n');
