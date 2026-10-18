const assert = require('node:assert/strict');
const imageAnalysis = require('../src/image-analysis.js');

async function main(){
  let checks = 0;
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
