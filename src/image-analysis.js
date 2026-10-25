(function(root){
  'use strict';

  function loadImage(dataUrl){
    return new Promise(function(resolve, reject){
      var image = new Image();
      image.onload = function(){ resolve(image); };
      image.onerror = reject;
      image.src = dataUrl;
    });
  }

  function renderToCanvas(image, maxDim){
    var width = image.naturalWidth || image.width;
    var height = image.naturalHeight || image.height;
    var canvas = document.createElement('canvas');
    var scale = Math.min(1, (maxDim || 1000) / Math.max(width, 1));
    var cw = Math.max(100, Math.round(width * scale));
    var ch = Math.max(60, Math.round(height * scale));
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, cw, ch);
    return { canvas: canvas, ctx: ctx, cw: cw, ch: ch, pixels: ctx.getImageData(0, 0, cw, ch).data };
  }

  function findBarlinePeaks(pixels, cw, ch, sysRect){
    var rx0 = Math.floor((sysRect ? sysRect.x : 0.05) * cw);
    var ry0 = Math.floor((sysRect ? sysRect.y : 0.12) * ch);
    var rw = Math.floor((sysRect ? sysRect.w : 0.85) * cw);
    var rh = Math.floor((sysRect ? sysRect.h : 0.76) * ch);
    rx0 = Math.max(0, Math.min(cw - 1, rx0));
    ry0 = Math.max(0, Math.min(ch - 1, ry0));
    rw = Math.max(10, Math.min(cw - rx0, rw));
    rh = Math.max(10, Math.min(ch - ry0, rh));

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
        if (!peaks.length || x - peaks[peaks.length - 1].dx > minGap){
          peaks.push({ dx: x, normX: normX, strength: colDark[x] });
        } else if (colDark[x] > peaks[peaks.length - 1].strength){
          peaks[peaks.length - 1] = { dx: x, normX: normX, strength: colDark[x] };
        }
      }
    }
    return peaks.map(function(peak){ return peak.normX; });
  }

  async function scanImageBarlines(dataUrl, sysRect){
    var im = await loadImage(dataUrl);
    var frame = renderToCanvas(im, 1000);
    return findBarlinePeaks(frame.pixels, frame.cw, frame.ch, sysRect);
  }

  async function scanScoreSystems(dataUrl){
    var im = await loadImage(dataUrl);
    var frame = renderToCanvas(im, 1000);
    var cw = frame.cw;
    var ch = frame.ch;
    var pixels = frame.pixels;

    // 1. 행(row)별 수평선 런(run) 밀도 측정
    var rowDarkRuns = new Float32Array(ch);
    var minRunLength = Math.max(6, Math.floor(cw * 0.015));
    for (var y = 0; y < ch; y++){
      var run = 0;
      var longRunPixels = 0;
      var rowOffset = y * cw * 4;
      for (var x = 0; x < cw; x++){
        var idx = rowOffset + x * 4;
        var isDark = pixels[idx] < 85 && pixels[idx + 1] < 85 && pixels[idx + 2] < 85;
        if (isDark){
          run++;
        } else {
          if (run >= minRunLength) longRunPixels += run;
          run = 0;
        }
      }
      if (run >= minRunLength) longRunPixels += run;
      rowDarkRuns[y] = longRunPixels / cw;
    }

    // 2. 오선 밀집 행 클러스터링
    var activeRows = [];
    for (var y = 0; y < ch; y++){
      if (rowDarkRuns[y] >= 0.08){
        activeRows.push(y);
      }
    }
    if (!activeRows.length) return [];

    var lineGapThreshold = Math.max(5, Math.floor(ch * 0.035));
    var clusters = [];
    var curCluster = [activeRows[0]];
    for (var i = 1; i < activeRows.length; i++){
      var prev = activeRows[i - 1];
      var curr = activeRows[i];
      if (curr - prev <= lineGapThreshold){
        curCluster.push(curr);
      } else {
        clusters.push(curCluster);
        curCluster = [curr];
      }
    }
    if (curCluster.length) clusters.push(curCluster);

    // 3. 클러스터 유효성 검사 및 정제
    var validClusters = [];
    clusters.forEach(function(c){
      var top = c[0];
      var bottom = c[c.length - 1];
      var height = bottom - top;
      if (height < 2 && c.length <= 1) return;
      var maxScore = 0;
      for (var k = 0; k < c.length; k++){
        if (rowDarkRuns[c[k]] > maxScore) maxScore = rowDarkRuns[c[k]];
      }
      if (maxScore < 0.12) return;
      validClusters.push({ top: top, bottom: bottom, height: height, count: c.length });
    });

    if (!validClusters.length) return [];

    // 4. 각 클러스터의 상하/좌우 bounding box 및 마디선 산출
    var systems = [];
    for (var cIdx = 0; cIdx < validClusters.length; cIdx++){
      var cluster = validClusters[cIdx];
      var prevCluster = validClusters[cIdx - 1];
      var nextCluster = validClusters[cIdx + 1];

      // 상하 패딩: 음표/기호/코드 수용
      var padY = Math.max(Math.floor(ch * 0.02), Math.round(cluster.height * 0.65));
      var topBound = prevCluster ? Math.floor((prevCluster.bottom + cluster.top) / 2) : 0;
      var bottomBound = nextCluster ? Math.ceil((cluster.bottom + nextCluster.top) / 2) : ch;

      var y0 = Math.max(topBound, cluster.top - padY);
      var y1 = Math.min(bottomBound, cluster.bottom + padY);

      // 5. 좌우 범위 (수직 투영)
      var colHits = new Int32Array(cw);
      for (var sy = cluster.top; sy <= cluster.bottom; sy++){
        var rOff = sy * cw * 4;
        for (var sx = 0; sx < cw; sx++){
          var pIdx = rOff + sx * 4;
          if (pixels[pIdx] < 85 && pixels[pIdx + 1] < 85 && pixels[pIdx + 2] < 85){
            colHits[sx]++;
          }
        }
      }
      var x0 = 0;
      var x1 = cw - 1;
      var minColHits = Math.max(1, Math.floor(cluster.count * 0.3));
      for (var col = 0; col < cw; col++){
        if (colHits[col] >= minColHits){ x0 = col; break; }
      }
      for (var col = cw - 1; col >= 0; col--){
        if (colHits[col] >= minColHits){ x1 = col; break; }
      }
      if (x1 - x0 < cw * 0.35){
        x0 = Math.floor(cw * 0.08);
        x1 = Math.floor(cw * 0.92);
      }

      var sysRect = {
        x: Math.max(0.02, +((x0 - 8) / cw).toFixed(4)),
        y: Math.max(0.02, +(y0 / ch).toFixed(4)),
        w: Math.min(0.96, +((x1 - x0 + 16) / cw).toFixed(4)),
        h: Math.min(0.96, +((y1 - y0) / ch).toFixed(4))
      };
      if (sysRect.x + sysRect.w > 0.98) sysRect.w = +(0.98 - sysRect.x).toFixed(4);
      if (sysRect.y + sysRect.h > 0.98) sysRect.h = +(0.98 - sysRect.y).toFixed(4);

      // 6. 마디선 감지
      var boundaries = findBarlinePeaks(pixels, cw, ch, sysRect);
      var bars = [];
      if (boundaries.length >= 2 && boundaries[boundaries.length - 1] - boundaries[0] > 0.12){
        var newBarCount = boundaries.length - 1;
        for (var b = 0; b < newBarCount; b++){
          var segmentWidth = boundaries[b + 1] - boundaries[b];
          bars.push({
            chord: '',
            note: '',
            memo: '',
            w: +Math.max(0.2, segmentWidth * 10).toFixed(3)
          });
        }
        sysRect.x = +boundaries[0].toFixed(4);
        sysRect.w = +(boundaries[boundaries.length - 1] - boundaries[0]).toFixed(4);
      } else {
        for (var b = 0; b < 4; b++){
          bars.push({ chord: '', note: '', memo: '', w: 1 });
        }
      }
      sysRect.bars = bars;
      systems.push(sysRect);
    }

    return systems;
  }

  var exportsObj = {
    scanImageBarlines: scanImageBarlines,
    scanScoreSystems: scanScoreSystems
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
  else {
    root.scanImageBarlines = scanImageBarlines;
    root.scanScoreSystems = scanScoreSystems;
    root.GuitarImageAnalysis = exportsObj;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
