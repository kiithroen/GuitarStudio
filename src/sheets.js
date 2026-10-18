'use strict';

(function(root, factory){
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuitarSheets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  function extractSheetIdAndGid(rawInput){
    var str = String(rawInput || '').trim();
    if (!str) return null;
    var match = str.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    var sheetId = match ? match[1] : (/^[a-zA-Z0-9-_]{20,}$/.test(str) ? str : null);
    if (!sheetId) return null;
    var gidMatch = str.match(/[#&?]gid=([0-9]+)/);
    return { sheetId: sheetId, gid: gidMatch ? gidMatch[1] : '0' };
  }

  function loadSheetViaJsonp(sheetId, gid, options){
    options = options || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var win = options.window || (typeof window !== 'undefined' ? window : null);
    var setTimer = options.setTimeout || setTimeout;
    var clearTimer = options.clearTimeout || clearTimeout;
    if (!doc || !win) return Promise.reject(new Error('Google Sheets JSONP requires a browser document'));
    return new Promise(function(resolve, reject){
      var cbName = '__gsSheetCb_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      var script = doc.createElement('script');
      var finished = false;
      var timer = setTimer(function(){ finish(new Error('시트 응답 시간 초과')); }, 8000);
      function cleanup(){
        clearTimer(timer);
        try { delete win[cbName]; } catch (_) { win[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      function finish(error, value){
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      }
      win[cbName] = function(response){
        if (!response || response.status === 'error' || !response.table){ finish(new Error('시트 데이터를 읽지 못했어요.')); return; }
        var rows = (response.table.rows || []).map(function(row){
          return (row.c || []).map(function(cell){
            if (!cell) return '';
            return cell.v != null ? String(cell.v) : (cell.f != null ? String(cell.f) : '');
          });
        });
        finish(null, rows);
      };
      script.onerror = function(){ finish(new Error('시트 접근에 실패했어요.')); };
      script.src = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(sheetId) +
        '/gviz/tq?tqx=responseHandler:' + cbName + '&gid=' + encodeURIComponent(gid) + '&_=' + Date.now();
      doc.head.appendChild(script);
    });
  }

  function quoteTSV(value){
    return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  }
  function toTsv(song){
    if (!song || song.format !== 'alphatex' || typeof song.alphaTex !== 'string') throw new TypeError('Only alphaTex songs can be copied to a sheet');
    return [song.title || '', song.description || song.badge || '', song.alphaTex].map(quoteTSV).join('\t');
  }
  function parseRows(rows, validateAlphaTex){
    if (!Array.isArray(rows)) throw new TypeError('시트 응답 형식이 올바르지 않아.');
    var output = [];
    rows.forEach(function(cols, index){
      cols = Array.isArray(cols) ? cols : [];
      var title = String(cols[0] || '').trim();
      if (!title || (index === 0 && /^(제목|곡 제목|title)$/i.test(title))) return;
      if (cols.length >= 5 && /^\s*\d+\s*$/.test(cols[1] || '') && /^\s*\d+\s*$/.test(cols[2] || '')) {
        throw new Error('시트 ' + (index + 1) + '행: 구형 5열 악보 형식이야. 제목, 설명, alphaTex 세 열로 바꿔줘.');
      }
      if (cols.length > 3 && cols.slice(3).some(function(cell){ return String(cell || '').trim() !== ''; })) {
        throw new Error('시트 ' + (index + 1) + '행: 제목, 설명, alphaTex 세 열만 사용해줘.');
      }
      var alphaTex = String(cols[2] || '');
      if (!alphaTex.trim()) throw new Error('시트 ' + (index + 1) + '행: alphaTex가 비어 있어.');
      try { validateAlphaTex(alphaTex); }
      catch (error){ throw new Error('시트 ' + (index + 1) + '행: ' + error.message); }
      output.push({ id: 'sheet-song-' + index, title: title, description: String(cols[1] || ''), badge: String(cols[1] || ''), format: 'alphatex', alphaTex: alphaTex, notationVersion: 3, builtin: false, fromSheet: true });
    });
    return output;
  }
  async function fetchSongs(url, options){
    options = options || {};
    var info = extractSheetIdAndGid(url);
    if (!info) throw new Error('올바른 구글 스프레드시트 공유 링크를 입력해줘.');
    var rows = await loadSheetViaJsonp(info.sheetId, info.gid, options);
    var engine = options.TabEngine || (typeof TabEngine !== 'undefined' ? TabEngine : null);
    if (!engine || typeof engine.parseAlphaTex !== 'function') throw new Error('alphaTab parser가 아직 준비되지 않았어.');
    return parseRows(rows, engine.parseAlphaTex);
  }
  return { extractSheetIdAndGid: extractSheetIdAndGid, loadSheetViaJsonp: loadSheetViaJsonp, quoteTSV: quoteTSV, toTsv: toTsv, parseRows: parseRows, fetchSongs: fetchSongs };
});
