const assert = require('node:assert/strict');
const buildAiPromptText = require('../src/ai-prompt.js');
const imageAnalysis = require('../src/image-analysis.js');
const parser = require('../src/parser.js');
assert.equal(global.buildAiPromptText, undefined, 'CommonJS loading does not write to the Node global');

async function main(){
  let checks = 0;
  function test(name, fn){
    fn();
    checks++;
    process.stdout.write('ok ' + checks + ' - ' + name + '\n');
  }

  [2, 3, 4, 6, 8, 9].forEach(function(beats){
    test('prompt examples parse correctly at ' + beats + ' slots', function(){
      const bpm = 72;
      const prompt = buildAiPromptText(beats, bpm);
      const exampleHeader = '[문법 예시: 실제 사진 변환 결과가 아님]';
      const exampleIdx = prompt.indexOf(exampleHeader);
      const outputIdx = prompt.indexOf('[실제 결과 출력 형식 1:');
      const example = prompt.slice(exampleIdx, outputIdx).split('\n').filter(function(line){ return /^\[C\] /.test(line); });
      const tsvLine = prompt.split('\n').find(function(line){ return line.startsWith('제목\t'); });
      assert.equal(example.length, 2);
      assert.ok(tsvLine);
      assert.equal(tsvLine.split('\t').length, 5);
      assert.equal(Number(tsvLine.split('\t')[1]), beats);
      assert.equal(Number(tsvLine.split('\t')[2]), bpm);
      const parsedLines = parser.parseScore(example, beats);
      const parsedTsv = parser.parseScore(tsvLine.split('\t')[4], beats);
      assert.equal(parsedLines.errors.length, 0);
      assert.equal(parsedTsv.errors.length, 0);
      assert.equal(parsedLines.measures.length, 2);
      assert.equal(parsedTsv.measures.length, 2);
      assert.deepEqual(parsedLines.measures.map(function(measure){ return measure.beats.map(function(beat){ return beat.tok; }); }), parsedTsv.measures.map(function(measure){ return measure.beats.map(function(beat){ return beat.tok; }); }));
      assert.deepEqual(parsedLines.measures[0].beats.map(function(beat){ return beat.tok; }), ['E4@1/F4@1'].concat(new Array(beats - 1).fill('-')));
      assert.equal(parsedLines.measures[1].beats[0].tok, 'C4@2');
    });
  });

  const originalImage = global.Image;
  const originalDocument = global.document;
  const width = 400, height = 100;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++){
    pixels[i * 4] = 255;
    pixels[i * 4 + 1] = 255;
    pixels[i * 4 + 2] = 255;
    pixels[i * 4 + 3] = 255;
  }
  [100, 200, 300].forEach(function(x){
    for (let y = 0; y < height; y++){
      const idx = (y * width + x) * 4;
      pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = 0;
    }
  });
  global.Image = class FakeImage {
    set src(value){ this._src = value; this.naturalWidth = width; this.naturalHeight = height; this.onload(); }
  };
  global.document = { createElement: function(){
    return {
      getContext: function(){ return {
        drawImage: function(){},
        getImageData: function(){ return { data: pixels }; }
      }; }
    };
  } };
  try {
    const boundaries = await imageAnalysis.scanImageBarlines('synthetic-image', { x: 0.1, y: 0, w: 0.8, h: 1 });
    assert.deepEqual(boundaries, [0.25, 0.5, 0.75]);
    assert.equal(boundaries.every(function(value){ return typeof value === 'number'; }), true);
    checks++;
    process.stdout.write('ok ' + checks + ' - image analysis returns only detected barline coordinates\n');
  } finally {
    if (originalImage === undefined) delete global.Image;
    else global.Image = originalImage;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
  }
  process.stdout.write('1..' + checks + '\n');
}

main().catch(function(error){
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
