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

    // 2. 다중 줄 악보 자동 감지 (scanScoreSystems) 테스트
    const w2 = 400, h2 = 200;
    const pixels2 = new Uint8ClampedArray(w2 * h2 * 4);
    pixels2.fill(255);
    function drawHorizLine(y, xStart, xEnd){
      for (let x = xStart; x <= xEnd; x++){
        const idx = (y * w2 + x) * 4;
        pixels2[idx] = pixels2[idx + 1] = pixels2[idx + 2] = 0;
      }
    }
    function drawVertLine(x, yStart, yEnd){
      for (let y = yStart; y <= yEnd; y++){
        const idx = (y * w2 + x) * 4;
        pixels2[idx] = pixels2[idx + 1] = pixels2[idx + 2] = 0;
      }
    }
    // 줄 1: 5개 오선 (y=28, 32, 36, 40, 44), 마디선 (x=40, 140, 240, 340)
    [28, 32, 36, 40, 44].forEach(y => drawHorizLine(y, 40, 340));
    [40, 140, 240, 340].forEach(x => drawVertLine(x, 28, 44));

    // 줄 2: 5개 오선 (y=128, 132, 136, 140, 144), 마디선 (x=40, 140, 240, 340)
    [128, 132, 136, 140, 144].forEach(y => drawHorizLine(y, 40, 340));
    [40, 140, 240, 340].forEach(x => drawVertLine(x, 128, 144));

    global.Image = class FakeImage2 {
      set src(value){ this._src = value; this.naturalWidth = w2; this.naturalHeight = h2; this.onload(); }
    };
    global.document = { createElement: function(){
      return {
        getContext: function(){ return {
          drawImage: function(){},
          getImageData: function(){ return { data: pixels2 }; }
        }; }
      };
    } };

    const detectedSystems = await imageAnalysis.scanScoreSystems('synthetic-systems');
    assert.equal(detectedSystems.length, 2, 'detects 2 staff systems from image');
    assert.ok(detectedSystems[0].y < detectedSystems[1].y, 'systems are ordered vertically');
    assert.equal(detectedSystems[0].bars.length, 3, 'first system has 3 detected measures');
    assert.equal(detectedSystems[1].bars.length, 3, 'second system has 3 detected measures');
    checks++;
    process.stdout.write('ok ' + checks + ' - scanScoreSystems detects multi-system staff rows and barlines\n');
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
