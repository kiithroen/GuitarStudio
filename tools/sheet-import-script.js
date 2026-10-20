'use strict';

// 이 파일은 시트의 확장 프로그램 > Apps Script 편집기에 통째로 붙여 넣어 쓴다.
// 저장소에서는 test/test-sheet-import-script.js 가 vm 으로 읽어 가짜 Apps Script 객체와 함께 돌린다.

var FOLDER_NAME = 'GuitarScores';
var SHEET_NAME = '';            // 비우면 첫 탭
var TRIGGER_MINUTES = 5;        // everyMinutes 는 1, 5, 10, 15, 30 만 받는다
var COLUMN_COUNT = 5;
var PROP_PREFIX = 'tsv:';
var TEXT_COLUMNS = [0, 3, 4];   // 0부터 센 A, D, E 열. 일반 텍스트 서식으로 쓴다

// TSV 한 파일의 텍스트를 줄 단위로 읽는다. 문법 검사는 하지 않고 열 모양만 본다.
function parseScoreTsv(text, fileName) {
  var rows = [];
  var errors = [];
  var source = String(text);
  if (source.charAt(0) === '\uFEFF') source = source.slice(1);
  var lines = source.split(/\r\n|\n|\r/);
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    if (raw.trim() === '') continue;
    var lineNo = i + 1;
    var cols = raw.split('\t');
    if (cols.length !== COLUMN_COUNT) {
      errors.push({
        file: fileName,
        line: lineNo,
        message: '탭으로 나뉜 열이 ' + cols.length + '개입니다. ' + COLUMN_COUNT + '개여야 합니다.'
      });
      continue;
    }
    cols = cols.map(function (c) { return c.trim(); });
    if (cols[0] === '') {
      errors.push({ file: fileName, line: lineNo, message: '제목(A열)이 비었습니다.' });
      continue;
    }
    if (cols[4] === '') {
      errors.push({ file: fileName, line: lineNo, message: '악보(E열)가 비었습니다.' });
      continue;
    }
    rows.push({ file: fileName, line: lineNo, cols: cols });
  }
  return { rows: rows, errors: errors };
}

function numOrText(value) {
  return /^\d+$/.test(value) ? Number(value) : value;
}

// 칸 수와 BPM 만 숫자로 쓴다. 값 범위는 앱이 검사한다.
function toCellRow(cols) {
  return [cols[0], numOrText(cols[1]), numOrText(cols[2]), cols[3], cols[4]];
}

// 시트 상태와 읽은 행들로 어느 행을 덮어쓰고 무엇을 추가할지 정한다.
function planImport(sheetTitles, headerTitle, entries) {
  var updates = [];
  var appends = [];
  var duplicates = [];
  var unchanged = 0;

  var rest = entries.filter(function (e) { return e.cols[0] !== headerTitle; });

  // 제목이 constructor·__proto__ 같은 이름이어도 상속 속성으로 읽히지 않게 프로토타입 없는 객체를 쓴다.
  var counts = Object.create(null);
  rest.forEach(function (e) {
    counts[e.cols[0]] = (counts[e.cols[0]] || 0) + 1;
  });
  var dupInfo = Object.create(null);
  rest.forEach(function (e) {
    var title = e.cols[0];
    if (counts[title] < 2) return;
    var info = dupInfo[title];
    if (!info) {
      info = { title: title, files: [], fileKeys: [] };
      dupInfo[title] = info;
      duplicates.push(info);
    }
    if (info.files.indexOf(e.file) < 0) info.files.push(e.file);
    if (info.fileKeys.indexOf(e.fileKey) < 0) info.fileKeys.push(e.fileKey);
  });

  rest.forEach(function (e) {
    var title = e.cols[0];
    if (counts[title] >= 2) return;
    if (!e.changed) {
      unchanged++;
      return;
    }
    var index = sheetTitles.indexOf(title);
    if (index >= 0) updates.push({ row: index + 2, values: toCellRow(e.cols) });
    else appends.push(toCellRow(e.cols));
  });

  return { updates: updates, appends: appends, duplicates: duplicates, unchanged: unchanged };
}

function summarize(result) {
  if (result.busy) return '다른 가져오기가 진행 중이라 건너뛰었습니다.';
  var lines = [
    '가져오기 완료 · 추가 ' + result.added + '곡 · 갱신 ' + result.updated + '곡 · 변경 없음 ' + result.unchanged + '곡'
  ];
  result.errors.forEach(function (e) {
    lines.push(e.file + ' ' + e.line + '행: ' + e.message);
  });
  result.duplicates.forEach(function (d) {
    lines.push('"' + d.title + '" (' + d.files.join(', ') + '): 같은 제목이 여러 줄에 있어 건너뛰었습니다.');
  });
  return lines.join('\n');
}

function notify_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    console.log(message);
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('악보 가져오기')
    .addItem('폴더에서 지금 가져오기', 'importScoresFromMenu')
    .addItem('자동 가져오기 켜기', 'setup')
    .addItem('자동 가져오기 끄기', 'removeTriggers')
    .addToUi();
}

// importScores 핸들러 트리거만 지운다. 다른 핸들러 트리거는 그대로 둔다.
function deleteImportTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'importScores') ScriptApp.deleteTrigger(trigger);
  });
}

function setup() {
  deleteImportTriggers_();
  ScriptApp.newTrigger('importScores').timeBased().everyMinutes(TRIGGER_MINUTES).create();
  var result = runImport_();
  notify_('자동 가져오기를 켰습니다. ' + TRIGGER_MINUTES + '분마다 폴더를 확인합니다.\n' + summarize(result));
}

function removeTriggers() {
  deleteImportTriggers_();
  notify_('자동 가져오기를 껐습니다.');
}

function importScoresFromMenu() {
  try {
    notify_(summarize(runImport_()));
  } catch (e) {
    notify_(e.message);
  }
}

// 시간 트리거 핸들러. 오류나 제목 중복이 있으면 던져서 트리거 실패 메일로 알린다.
function importScores() {
  var result = runImport_();
  var text = summarize(result);
  console.log(text);
  if (result.errors.length || result.duplicates.length) throw new Error(text);
}

function findFolder_() {
  var folders = [];
  var iterator = DriveApp.getFoldersByName(FOLDER_NAME);
  while (iterator.hasNext()) {
    var folder = iterator.next();
    if (!folder.isTrashed()) folders.push(folder);
  }
  if (folders.length === 0) throw new Error('드라이브에서 "' + FOLDER_NAME + '" 폴더를 찾지 못했습니다.');
  if (folders.length > 1) throw new Error('드라이브에 "' + FOLDER_NAME + '" 폴더가 여러 개 있습니다. 하나만 남기세요.');
  return folders[0];
}

// 서식을 먼저 일반 텍스트로 정한 뒤 값을 쓴다. 순서가 바뀌면 시트가 값을 날짜 따위로 바꾼다.
function writeRows_(sheet, startRow, rows) {
  TEXT_COLUMNS.forEach(function (c) {
    sheet.getRange(startRow, c + 1, rows.length, 1).setNumberFormat('@');
  });
  sheet.getRange(startRow, 1, rows.length, COLUMN_COUNT).setValues(rows);
}

function runImport_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { busy: true, added: 0, updated: 0, unchanged: 0, errors: [], duplicates: [] };
  }
  try {
    var folder = findFolder_();
    var props = PropertiesService.getScriptProperties();

    var entries = [];
    var errors = [];
    var records = [];
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (file.isTrashed()) continue;
      var name = file.getName();
      if (!/\.tsv$/i.test(name)) continue;
      var id = file.getId();
      var stamp = String(file.getLastUpdated().getTime());
      var key = PROP_PREFIX + id;
      var changed = props.getProperty(key) !== stamp;
      var text = file.getBlob().getDataAsString('UTF-8');
      var parsed = parseScoreTsv(text, name);
      parsed.rows.forEach(function (r) {
        entries.push({ file: name, fileKey: id, line: r.line, cols: r.cols, changed: changed });
      });
      parsed.errors.forEach(function (e) { errors.push(e); });
      records.push({ key: key, fileKey: id, stamp: stamp, hasError: parsed.errors.length > 0 });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
    if (!sheet) throw new Error('"' + SHEET_NAME + '" 탭이 없습니다.');
    var lastRow = sheet.getLastRow();
    if (lastRow === 0) throw new Error('시트 1행에 머리글이 없습니다. 머리글 행을 먼저 넣으세요.');
    var headerTitle = String(sheet.getRange(1, 1).getValue()).trim();
    var sheetTitles = [];
    if (lastRow >= 2) {
      sheetTitles = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) {
        return String(r[0]).trim();
      });
    }

    var plan = planImport(sheetTitles, headerTitle, entries);

    plan.updates.forEach(function (u) {
      writeRows_(sheet, u.row, [u.values]);
    });
    if (plan.appends.length) writeRows_(sheet, lastRow + 1, plan.appends);

    // 오류나 제목 중복이 있던 파일은 기록하지 않아 다음 실행에서 다시 본다.
    var duplicateKeys = [];
    plan.duplicates.forEach(function (d) {
      d.fileKeys.forEach(function (k) { duplicateKeys.push(k); });
    });
    records.forEach(function (r) {
      if (r.hasError) return;
      if (duplicateKeys.indexOf(r.fileKey) >= 0) return;
      props.setProperty(r.key, r.stamp);
    });

    return {
      busy: false,
      added: plan.appends.length,
      updated: plan.updates.length,
      unchanged: plan.unchanged,
      errors: errors,
      duplicates: plan.duplicates
    };
  } finally {
    lock.releaseLock();
  }
}
