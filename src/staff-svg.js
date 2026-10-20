(function(global){
  'use strict';
  // 오선 배치(src/staff-layout.js의 layoutScore 결과 마디 하나)를 SVG 문자열로 그린다. DOM 없음. 규칙과 결정은 Docs/staff-notation.md.
  var LINE_GAP = 8;                 // 줄 간격(px)
  var STEP = LINE_GAP / 2;          // 오선 위치 한 칸(px)
  var BASE_Y = 88;                  // E4(step 0) 아래 줄의 y
  var STAFF_HEIGHT = 128;           // E3(step -7)~B6(step 18), 기둥·셋잇단 숫자까지 담는 SVG 높이
  var HEAD_RX = 5.4;
  var HEAD_RY = 4;
  var STEM_LENGTH = 3.5 * LINE_GAP;
  var STEM_MIN = 2.5 * LINE_GAP;
  var BEAM_THICKNESS = 3;
  var BEAM_GAP = 6;
  var STUB_LENGTH = 8;
  var TIP_MIN = 12;                 // 기둥 끝이 올라갈 수 있는 가장 높은 y
  var TIP_MAX = STAFF_HEIGHT - 12;  // 내려갈 수 있는 가장 낮은 y
  // 속성 값 안이라 홑따옴표로 쓴다
  var MUSIC_FONT = "'Noto Music','Segoe UI Symbol','Apple Symbols',serif";
  var MUSIC_SIZE = 32;              // 음자리표·쉼표 글자 크기(Noto Music은 이 크기에서 줄 간격 8px에 맞는다)
  var ACC_SIZE = 28;                // 임시표·조표 글자 크기
  // 글자의 세로 기준선(baseline)이 음의 줄에서 얼마나 아래인지(px). Noto Music의 글자 먹물 범위를 재서 정했다.
  var ACC_BASELINE = { sharp: 3.5, flat: 1.5, natural: 4.2 };
  var CLEF_BASELINE = 7;            // 소용돌이가 G 줄에 오도록 G 줄 아래로 내린 기준선
  var BEAM_LEVEL = { eighth: 1, '16th': 2, '32nd': 3 };
  var REST_GLYPH = { whole: '𝄻', half: '𝄼', quarter: '𝄽', eighth: '𝄾', '16th': '𝄿', '32nd': '𝅀' };
  var CLEF_GLYPH = '𝄞';
  var SHARP_STEPS = [8, 5, 9, 6, 3];   // F5 C5 G5 D5 A4
  var FLAT_STEPS = [4, 7, 3, 6, 2];    // B4 E5 A4 D5 G4
  var ACC_GLYPH = { sharp: '♯', flat: '♭', natural: '♮' };
  // 머리(첫 마디)의 가로 구성
  var HEADER_LEFT = 4;
  var CLEF_W = 20;
  var KEY_GAP = 4;
  var KEY_W = 10;
  var TIME_GAP = 6;
  var TIME_W = 14;
  var HEADER_RIGHT = 6;

  function yOf(step){ return BASE_Y - step * STEP; }
  function n(value){ return String(Math.round(value * 10) / 10); }
  function clamp(value, lo, hi){ return Math.max(lo, Math.min(hi, value)); }

  // header.time이 null이면 박자표 없이 그린다(연습 화면의 둘째 카드부터). 없으면(undefined) 4/4로 그린다.
  function headerWidth(header){
    if (!header) return 0;
    var keyCount = Math.abs(header.key || 0);
    return HEADER_LEFT + CLEF_W + (keyCount ? KEY_GAP + KEY_W * keyCount : 0) + (header.time === null ? 0 : TIME_GAP + TIME_W) + HEADER_RIGHT;
  }

  function attrs(map){
    return Object.keys(map).map(function(name){ return ' ' + name + '="' + map[name] + '"'; }).join('');
  }

  function line(className, x1, y1, x2, y2, width){
    return '<line class="' + className + '"' + attrs({ x1: n(x1), y1: n(y1), x2: n(x2), y2: n(y2), stroke: 'currentColor', 'stroke-width': width }) + '/>';
  }

  function text(className, x, y, content, extra){
    var map = { x: n(x), y: n(y), fill: 'currentColor', 'text-anchor': 'middle' };
    Object.keys(extra || {}).forEach(function(name){ map[name] = extra[name]; });
    return '<text class="' + className + '"' + attrs(map) + '>' + content + '</text>';
  }

  // ---------- 화음 하나의 머리 자리

  // 2도로 붙은 음은 기둥 반대쪽으로 비켜 놓는다(기둥이 없으면 위 음을 오른쪽으로).
  function headOffsets(steps, dir){
    var count = steps.length, shifted = [], i;
    for (i = 0; i < count; i++) shifted.push(false);
    if (dir === 'up'){
      for (i = 1; i < count; i++) if (steps[i] - steps[i - 1] <= 1 && !shifted[i - 1]) shifted[i] = true;
    } else {
      for (i = count - 2; i >= 0; i--) if (steps[i + 1] - steps[i] <= 1 && !shifted[i + 1]) shifted[i] = true;
    }
    return shifted.map(function(flag){ return flag ? (dir === 'up' ? 2 * HEAD_RX : -2 * HEAD_RX) : 0; });
  }

  function chordInfo(item, cx){
    var steps = item.notes.map(function(note){ return note.step; });
    var dir = item.stem || 'up';
    var offsets = headOffsets(steps, dir);
    var heads = item.notes.map(function(note, index){
      return { note: note, index: index, x: cx + offsets[index], y: yOf(note.step) };
    });
    var top = Math.min.apply(null, heads.map(function(head){ return head.y; }));
    var bottom = Math.max.apply(null, heads.map(function(head){ return head.y; }));
    return {
      item: item, cx: cx, heads: heads, top: top, bottom: bottom,
      left: Math.min.apply(null, heads.map(function(head){ return head.x - HEAD_RX; })),
      right: Math.max.apply(null, heads.map(function(head){ return head.x + HEAD_RX; })),
      stemX: item.stem === 'up' ? cx + HEAD_RX : (item.stem === 'down' ? cx - HEAD_RX : null),
      tip: null
    };
  }

  // 빔 없는 기둥 끝, 빔 묶음은 평평한 빔의 바깥 가장자리 y.
  function singleTip(info){
    if (info.item.stem === 'up') return Math.min(clamp(info.top - STEM_LENGTH, TIP_MIN, TIP_MAX), info.top - STEM_MIN);
    return Math.max(clamp(info.bottom + STEM_LENGTH, TIP_MIN, TIP_MAX), info.bottom + STEM_MIN);
  }

  function beamTip(infos, dir){
    if (dir === 'up'){
      var top = Math.min.apply(null, infos.map(function(info){ return info.top; }));
      return Math.min(clamp(top - STEM_LENGTH, TIP_MIN, TIP_MAX), top - STEM_MIN);
    }
    var bottom = Math.max.apply(null, infos.map(function(info){ return info.bottom; }));
    return Math.max(clamp(bottom + STEM_LENGTH, TIP_MIN, TIP_MAX), bottom + STEM_MIN);
  }

  // ---------- 그리기 조각

  function drawHead(head, item, open){
    if (head.note.harmonic) return drawHarmonicHead(head, open);
    var map = { cx: n(head.x), cy: n(head.y), rx: HEAD_RX, ry: HEAD_RY, 'data-str': head.note.str == null ? '' : head.note.str, 'data-note': head.index };
    if (open){
      map.fill = 'none';
      map.stroke = 'currentColor';
      map['stroke-width'] = 1.5;
    } else {
      map.fill = 'currentColor';
      map.transform = 'rotate(-20 ' + n(head.x) + ' ' + n(head.y) + ')';
    }
    var cls = 'st-head' + (open ? ' is-open' : '') + (head.note.uncertain ? ' is-uncertain' : '');
    return '<ellipse class="' + cls + '"' + attrs(map) + '/>';
  }

  // 하모닉스 머리: 같은 중심·반지름의 마름모. 빈 머리와 확인 표시 처리는 보통 머리와 같다.
  function drawHarmonicHead(head, open){
    var cx = head.x, cy = head.y;
    var points = [[cx - HEAD_RX, cy], [cx, cy - HEAD_RY], [cx + HEAD_RX, cy], [cx, cy + HEAD_RY]]
      .map(function(point){ return n(point[0]) + ',' + n(point[1]); }).join(' ');
    var map = { points: points, 'data-str': head.note.str == null ? '' : head.note.str, 'data-note': head.index };
    if (open){
      map.fill = 'none';
      map.stroke = 'currentColor';
      map['stroke-width'] = 1.5;
    } else {
      map.fill = 'currentColor';
    }
    var cls = 'st-head' + (open ? ' is-open' : '') + (head.note.uncertain ? ' is-uncertain' : '') + ' is-harmonic';
    return '<polygon class="' + cls + '"' + attrs(map) + '/>';
  }

  function drawLedgers(info){
    var out = [];
    info.heads.forEach(function(head){
      head.note.ledger.forEach(function(step){
        out.push(line('st-ledger', head.x - HEAD_RX - 3.5, yOf(step), head.x + HEAD_RX + 3.5, yOf(step), 1.2));
      });
    });
    return out;
  }

  function drawAccidentals(info){
    var out = [];
    var columns = [];   // 열마다 마지막으로 놓은 음의 step
    info.heads.slice().sort(function(a, b){ return b.note.step - a.note.step; }).forEach(function(head){
      var kind = head.note.accidental;
      if (!kind) return;
      var col = 0;
      while (col < columns.length && columns[col] - head.note.step < 6) col++;
      columns[col] = head.note.step;
      var x = info.left - 3 - col * 11;
      out.push(text('st-acc', x, head.y + ACC_BASELINE[kind], ACC_GLYPH[kind], {
        'text-anchor': 'end', 'font-size': ACC_SIZE, 'font-family': MUSIC_FONT
      }));
    });
    return out;
  }

  function dotSteps(info){
    var seen = {}, list = [];
    info.heads.forEach(function(head){
      var step = head.note.step % 2 === 0 ? head.note.step + 1 : head.note.step;   // 줄 위 머리는 반 칸 위
      if (!seen[step]){ seen[step] = true; list.push(step); }
    });
    return list;
  }

  function drawDot(x, step){
    return '<circle class="st-dot"' + attrs({ cx: n(x), cy: n(yOf(step)), r: 1.5, fill: 'currentColor' }) + '/>';
  }

  function drawFlags(x, tip, dir, levels){
    var out = [];
    for (var k = 0; k < levels; k++){
      var sign = dir === 'up' ? 1 : -1;
      var y = tip + sign * 6 * k;
      out.push('<path class="st-flag"' + attrs({
        d: 'M' + n(x) + ' ' + n(y) + ' c0.5 ' + n(sign * 6) + ' 9 ' + n(sign * 8) + ' 7 ' + n(sign * 18),
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6
      }) + '/>');
    }
    return out;
  }

  // 음자리표·조표·박자표. renderMeasure의 첫 마디 머리와 renderHeader가 같이 쓴다.
  function drawHeader(x0, header, hw){
    var out = [];
    var clefX = x0 + HEADER_LEFT + CLEF_W / 2;
    out.push(text('st-clef', clefX, yOf(2) + CLEF_BASELINE, CLEF_GLYPH, { 'font-size': MUSIC_SIZE, 'font-family': MUSIC_FONT }));
    out.push(text('st-clef8', clefX, yOf(-4), '8', { 'font-size': 11, 'font-weight': 700, 'font-family': 'serif' }));
    var key = header.key || 0;
    var keySteps = key > 0 ? SHARP_STEPS : FLAT_STEPS;
    for (var ki = 0; ki < Math.abs(key); ki++){
      var kx = x0 + HEADER_LEFT + CLEF_W + KEY_GAP + ki * KEY_W + KEY_W / 2;
      var keyKind = key > 0 ? 'sharp' : 'flat';
      out.push(text('st-key', kx, yOf(keySteps[ki]) + ACC_BASELINE[keyKind], ACC_GLYPH[keyKind], {
        'font-size': ACC_SIZE, 'font-family': MUSIC_FONT
      }));
    }
    if (header.time !== null){
      var timeX = x0 + hw - HEADER_RIGHT - TIME_W / 2;
      var time = header.time || { numerator: 4, denominator: 4 };
      var timeStyle = { 'dominant-baseline': 'central', 'font-size': 17, 'font-weight': 700, 'font-family': 'serif' };
      out.push('<g class="st-time">' + text('st-time-top', timeX, yOf(6), time.numerator, timeStyle) + text('st-time-bottom', timeX, yOf(2), time.denominator, timeStyle) + '</g>');
    }
    return out;
  }

  // 머리만 따로 그린 SVG(음자리표, 조표, 있으면 박자표, 오선 줄). 연습 화면 카드의 왼쪽 열에 쓴다.
  function renderHeader(header){
    var hw = headerWidth(header);
    var out = ['<svg class="st-svg st-header-svg" xmlns="http://www.w3.org/2000/svg"' + attrs({
      width: n(hw), height: STAFF_HEIGHT, viewBox: '0 0 ' + n(hw) + ' ' + STAFF_HEIGHT, role: 'img', 'aria-label': '음자리표'
    }) + '>'];
    for (var li = 0; li < 5; li++) out.push(line('st-line', 0, yOf(li * 2), hw, yOf(li * 2), 1));
    Array.prototype.push.apply(out, drawHeader(0, header, hw));
    out.push('</svg>');
    return out.join('');
  }

  // ---------- 마디

  function renderMeasure(layout, geo){
    var width = geo.width;
    var leftPad = geo.leftPad;
    var header = geo.header || null;
    var hw = headerWidth(header);
    var x0 = header ? Math.max(0, leftPad - hw) : leftPad;
    var items = layout.items || [];
    var out = [];

    out.push('<svg class="st-svg" xmlns="http://www.w3.org/2000/svg"' + attrs({
      width: n(width), height: STAFF_HEIGHT, viewBox: '0 0 ' + n(width) + ' ' + STAFF_HEIGHT, role: 'img', 'aria-label': '오선 미리보기'
    }) + '>');

    for (var li = 0; li < 5; li++) out.push(line('st-line', x0, yOf(li * 2), width, yOf(li * 2), 1));
    out.push(line('st-bar', x0 + 0.5, yOf(8), x0 + 0.5, yOf(0), 1.2));
    out.push(line('st-bar', width - 1, yOf(8), width - 1, yOf(0), 1.2));

    if (header) Array.prototype.push.apply(out, drawHeader(x0, header, hw));

    // 화음 자리 계산
    var infos = items.map(function(item){
      return item.type === 'chord' ? chordInfo(item, geo.xAt(item.cell, item.unit)) : null;
    });

    // 기둥 끝: 빔 묶음은 평평한 빔, 아니면 화음마다.
    var beamOf = {};
    (layout.beams || []).forEach(function(beam, bi){
      var group = beam.items.map(function(index){ return infos[index]; });
      var dir = items[beam.items[0]].stem;
      var tip = beamTip(group, dir);
      beam.items.forEach(function(index){ beamOf[index] = bi; infos[index].tip = tip; });
    });
    infos.forEach(function(info){
      if (info && info.tip == null && info.item.stem) info.tip = singleTip(info);
    });

    // 화음과 쉼
    items.forEach(function(item, index){
      var cx = geo.xAt(item.cell, item.unit);
      var unc = item.uncertain ? ' is-uncertain' : '';
      if (item.type === 'rest'){
        var whole = items.length === 1 && item.value.base === 'whole';
        out.push(drawRest(item, index, cx, unc, whole, leftPad, width));
        return;
      }
      var info = infos[index];
      var open = item.value.base === 'whole' || item.value.base === 'half';
      var g = ['<g class="st-chord"' + attrs({ 'data-cell': item.cell, 'data-unit': item.unit, 'data-item': index }) + '>'];
      Array.prototype.push.apply(g, drawLedgers(info));
      info.heads.forEach(function(head){ g.push(drawHead(head, item, open)); });
      Array.prototype.push.apply(g, drawAccidentals(info));
      if (item.value.dots){
        dotSteps(info).forEach(function(step){ g.push(drawDot(info.right + 4, step)); });
      }
      if (item.stem){
        var from = item.stem === 'up' ? info.bottom : info.top;
        g.push(line('st-stem', info.stemX, from, info.stemX, info.tip, 1.2));
        var levels = BEAM_LEVEL[item.value.base] || 0;
        if (levels && beamOf[index] == null) Array.prototype.push.apply(g, drawFlags(info.stemX, info.tip, item.stem, levels));
      }
      g.push('</g>');
      out.push(g.join(''));
    });

    // 빔
    (layout.beams || []).forEach(function(beam){
      var dir = items[beam.items[0]].stem;
      var tip = infos[beam.items[0]].tip;
      var maxLevel = Math.max.apply(null, beam.levels);
      for (var level = 1; level <= maxLevel; level++){
        var y = dir === 'up' ? tip + BEAM_THICKNESS / 2 + BEAM_GAP * (level - 1) : tip - BEAM_THICKNESS / 2 - BEAM_GAP * (level - 1);
        var run = [];
        var flushRun = function(){
          if (!run.length) return;
          var xs = run.map(function(position){ return infos[beam.items[position]].stemX; });
          var xa = xs[0], xb = xs[xs.length - 1];
          if (run.length === 1){
            var last = run[0] === beam.items.length - 1;
            xa = last ? xs[0] - STUB_LENGTH : xs[0];
            xb = last ? xs[0] : xs[0] + STUB_LENGTH;
          } else {
            xa -= 0.6;
            xb += 0.6;
          }
          out.push(line('st-beam', xa, y, xb, y, BEAM_THICKNESS));
          run = [];
        };
        beam.levels.forEach(function(itemLevel, position){
          if (itemLevel >= level) run.push(position); else flushRun();
        });
        flushRun();
      }
    });

    // 붙임줄
    items.forEach(function(item, index){
      if (item.type !== 'chord') return;
      var info = infos[index];
      var below = item.stem === 'up';
      if (item.tieToNext){
        var next = infos[index + 1];
        info.heads.forEach(function(head){
          var target = next && next.heads[head.index] ? next.heads[head.index].x - 3 : width - 3;
          out.push(drawTie(head.x + 3, target, head.y, below));
        });
      }
      if (item.tieFromPrev && index === 0){
        info.heads.forEach(function(head){ out.push(drawTie(leftPad + 2, head.x - 3, head.y, below)); });
      }
    });

    // 슬러 곡선: 도착 음의 기둥이 위면 머리 아래, 아래면 머리 위. 마디를 넘는 슬러는 이 마디 쪽 반쪽만 그린다.
    (layout.slurs || []).forEach(function(slur){
      var from = slur.fromEdge ? null : infos[slur.fromItem];
      var to = slur.toEdge ? null : infos[slur.toItem];
      var fromHead = from && from.heads[slur.fromHead];
      var toHead = to && to.heads[slur.toHead];
      var anchor = to || from;   // 반쪽은 이 마디에 있는 음의 기둥을 따른다
      if (!anchor || (!fromHead && !slur.fromEdge) || (!toHead && !slur.toEdge)) return;
      var below = anchor.item.stem === 'up';
      if (fromHead && toHead) out.push(drawSlur(fromHead.x, fromHead.y, toHead.x, toHead.y, below, ''));
      else if (fromHead) out.push(drawSlur(fromHead.x, fromHead.y, width - 2, fromHead.y, below, 'is-start'));
      else out.push(drawSlur(leftPad + 2, toHead.y, toHead.x, toHead.y, below, 'is-end'));
    });

    // 셋잇단 숫자
    (layout.tuplets || []).forEach(function(tuplet){
      out.push(drawTuplet(tuplet, items, infos, geo));
    });

    out.push('</svg>');
    return out.join('');
  }

  function drawTie(x1, x2, y, below){
    var sign = below ? 1 : -1;
    var yy = y + sign * (HEAD_RY + 1);
    var span = Math.max(x2 - x1, 6);
    var d = 'M' + n(x1) + ' ' + n(yy) + ' Q' + n(x1 + span / 2) + ' ' + n(yy + sign * 8) + ' ' + n(x1 + span) + ' ' + n(yy);
    return '<path class="st-tie"' + attrs({ d: d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }) + '/>';
  }

  // 슬러 곡선(3차 베지어). 양 끝은 머리에서 띄우고, 가운데 높이는 가로 거리에 따라 늘린다. 모든 y는 그림 안에 넣는다.
  function drawSlur(x1, y1, x2, y2, below, cls){
    var sign = below ? 1 : -1;
    var ya = y1 + sign * (HEAD_RY + 1);
    var yb = y2 + sign * (HEAD_RY + 1);
    var rise = Math.min(10, 4 + Math.abs(x2 - x1) * 0.08);
    var reach = rise * 4 / 3;   // 양쪽 제어점이 이만큼 올라가면 가운데는 rise 만큼 올라간다
    var dx = x2 - x1;
    function cy(y){ return n(clamp(y, 2, STAFF_HEIGHT - 2)); }
    var d = 'M' + n(x1) + ' ' + cy(ya) + ' C' + n(x1 + dx * 0.25) + ' ' + cy(ya + sign * reach) + ' ' + n(x1 + dx * 0.75) + ' ' + cy(yb + sign * reach) + ' ' + n(x2) + ' ' + cy(yb);
    return '<path class="st-slur' + (cls ? ' ' + cls : '') + '"' + attrs({ d: d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }) + '/>';
  }

  function drawTuplet(tuplet, items, infos, geo){
    var xs = tuplet.items.map(function(index){
      var info = infos[index];
      return info ? (info.stemX == null ? info.cx : info.stemX) : geo.xAt(items[index].cell, items[index].unit);
    });
    var x = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
    var stemmed = tuplet.items.filter(function(index){ return infos[index] && infos[index].tip != null; });
    var y;
    if (stemmed.length){
      var dir = items[stemmed[0]].stem;
      var tips = stemmed.filter(function(index){ return items[index].stem === dir; }).map(function(index){ return infos[index].tip; });
      if (dir === 'up') y = Math.min.apply(null, tips) - 4;
      else y = Math.max.apply(null, tips) + 12;
    } else {
      y = yOf(8) - 8;
    }
    y = clamp(y, 11, STAFF_HEIGHT - 3);
    return text('st-tuplet', x, y, '3', { 'font-size': 11, 'font-style': 'italic', 'font-weight': 700, 'font-family': 'serif' });
  }

  // 쉼 글자의 세로 자리는 글꼴마다 달라서 Noto Music 기준으로 맞춘다. 온쉼표·2분쉼표는 글자가 넓어 줄여 그린다.
  // 온쉼표는 넷째 줄(step 6) 아래에 매달리고, 2분쉼표는 가운데 줄(step 4) 위에 앉고, 나머지는 가운데 줄에 가운데를 맞춘다.
  var REST_STYLE = {
    whole: { size: 28, step: 6, offset: 14.9, half: 13 },
    half: { size: 28, step: 4, offset: 7, half: 13 },
    quarter: { size: MUSIC_SIZE, step: 4, offset: 15.5, half: 9 },
    eighth: { size: MUSIC_SIZE, step: 4, offset: 15.5, half: 9 },
    '16th': { size: MUSIC_SIZE, step: 4, offset: 15.5, half: 9 },
    '32nd': { size: MUSIC_SIZE, step: 4, offset: 15.5, half: 9 }
  };

  function drawRest(item, index, cx, unc, whole, leftPad, width){
    var x = whole ? (leftPad + width) / 2 : cx;
    var base = item.value.base;
    var style = REST_STYLE[base];
    var glyph = text('st-rest' + unc, x, yOf(style.step) + style.offset, REST_GLYPH[base], {
      'font-size': style.size, 'font-family': MUSIC_FONT, 'data-cell': item.cell, 'data-unit': item.unit, 'data-item': index
    });
    var dot = item.value.dots ? drawDot(x + style.half, 5) : '';
    return glyph + dot;
  }

  var api = {
    renderMeasure: renderMeasure,
    renderHeader: renderHeader,
    headerWidth: headerWidth,
    STAFF_HEIGHT: STAFF_HEIGHT,
    BASE_Y: BASE_Y,
    LINE_GAP: LINE_GAP
  };
  if (typeof window !== 'undefined') window.GuitarStaffSvg = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
