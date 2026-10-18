(function(root){
  'use strict';

  async function scanImageBarlines(dataUrl, sysRect){
    var im = await new Promise(function(resolve, reject){
      var image = new Image();
      image.onload = function(){ resolve(image); };
      image.onerror = reject;
      image.src = dataUrl;
    });
    var width = im.naturalWidth || im.width;
    var height = im.naturalHeight || im.height;
    var canvas = document.createElement('canvas');
    var scale = Math.min(1, 1000 / Math.max(width, 1));
    var cw = Math.max(100, Math.round(width * scale));
    var ch = Math.max(60, Math.round(height * scale));
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(im, 0, 0, cw, ch);
    var pixels = ctx.getImageData(0, 0, cw, ch).data;
    var rx0 = Math.floor((sysRect ? sysRect.x : 0.05) * cw);
    var ry0 = Math.floor((sysRect ? sysRect.y : 0.12) * ch);
    var rw = Math.floor((sysRect ? sysRect.w : 0.85) * cw);
    var rh = Math.floor((sysRect ? sysRect.h : 0.76) * ch);
    var colDark = new Float32Array(rw);
    for (var dx = 0; dx < rw; dx++){
      var darkCount = 0;
      for (var dy = Math.floor(rh * 0.1); dy < Math.floor(rh * 0.9); dy++){
        var idx = ((ry0 + dy) * cw + rx0 + dx) * 4;
        if (pixels[idx] < 75 && pixels[idx + 1] < 75 && pixels[idx + 2] < 75) darkCount++;
      }
      colDark[dx] = darkCount / (rh * 0.8);
    }
    var peaks = [];
    var minGap = Math.max(12, Math.floor(rw * 0.08));
    for (var x = 2; x < rw - 2; x++){
      if (colDark[x] > 0.42 && colDark[x] >= colDark[x - 1] && colDark[x] >= colDark[x + 1]){
        var normX = (rx0 + x) / cw;
        if (!peaks.length || x - peaks[peaks.length - 1].dx > minGap) peaks.push({ dx: x, normX: normX, strength: colDark[x] });
        else if (colDark[x] > peaks[peaks.length - 1].strength) peaks[peaks.length - 1] = { dx: x, normX: normX, strength: colDark[x] };
      }
    }
    return peaks.map(function(peak){ return peak.normX; });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { scanImageBarlines: scanImageBarlines };
  else {
    root.scanImageBarlines = scanImageBarlines;
    root.GuitarImageAnalysis = { scanImageBarlines: scanImageBarlines };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
