# 개발 안내

번들러와 트랜스파일러가 없는 정적 Vanilla JS 앱이다. 저장소 루트에서 `index.html`을 제공하면 실행된다.

## 모듈 구성

`index.html`은 아래 표 순서대로 classic script를 로드한다. 순서를 유지한다.

| 파일 | 역할 |
|---|---|
| `src/storage.js` | DOM과 분리된 IndexedDB 저장소 |
| `src/app-state.js` | 앱 설정 상태(`appState`)와 오디오 런타임 전역. 악보 입력 화면도 같이 부른다 |
| `src/notation.js` | 입력 줄 토큰화, 마디 메모·가사·코드 머리표, 직렬화와 구조 검증 |
| `src/rhythm.js` | 칸 길이와 쉼·유지 체인 분석 |
| `src/parser.js` | `parseScore`, 음·화음·운지 파싱, 카포와 실음 계산 |
| `src/score-drafts.js` | 곡별 메모리 임시 악보·수정 초안과 원본 되돌리기 |
| `src/score.js` | 화면의 박자·음가·음이름 표시 |
| `src/audio.js` | KS/classic 합성기와 재생음 수명 관리 |
| `src/guide.js` | 구조화 악보의 재생 이벤트 생성·예약 |
| `src/image-analysis.js` | 이미지의 마디 경계 후보 분석 |
| `src/fretboard.js` | 지판 미리듣기와 코드 카드 표시 |
| `src/score-ui.js` | 악보 보기 전환과 `formatSongToSheetTsv` 공통 함수 |
| `src/sheets.js` | Google Sheets 읽기 연동 |
| `src/score-prompt.js` | 악보 이미지 → alphaTex 변환용 AI 프롬프트(`buildScoreImagePrompt`)와 복사 버튼 |
| `src/score-editor.js` | 초안 상태 줄·원본 복원, 악보 입력 화면과 주고받기 |
| `src/app.js` | 앱 상태, UI 부팅과 기능 연결 |

`app.js` 부팅 때 앱 모듈과 상태가 준비된 뒤 `initFretboard()`, `initScoreUi()`, `initSheetSync()`, `GuitarScorePrompt.initScorePromptButton()`과 편집 UI가 이벤트를 등록한다. 로컬 스크립트는 모두 같은 `v` 쿼리 버전을 쓴다. DOM 구조나 스크립트 구성, 스크립트끼리 부르는 공통 함수가 바뀌면 버전을 같이 올려 캐시된 이전 코드와 섞이지 않게 한다.

화면·단축키 규칙은 [화면과 조작](ui.md)에 있다.

alphaTab 보기 창은 `app.js` 없이 따로 스크립트를 부른다. 구성과 규칙은 [alphaTab 보기](alphatab.md)에 있다.

| 파일 | 역할 |
|---|---|
| `src/score-to-alphatex.js` | 텍스트 악보 → alphaTex 변환기(`GuitarAlphaTex`). `GuitarStaffLayout.layoutScore` 결과만 쓴다 |
| `alphatab.html`, `src/alphatab-view.js` | 새 탭 alphaTab 보기 창. `gs.alphaTab.view`를 읽어(곡에 원본 `alphaTex`가 있으면 그대로, 없으면 변환해) 플레이어를 띄운다. 불러오는 스크립트는 notation·rhythm·parser·staff-layout·score-to-alphatex·vendor alphaTab 순이다 |
| `vendor/alphatab/` | alphaTab 1.8.4(MPL-2.0) 배포본. 고치지 않는다. 앱 기본 화면은 불러오지 않고 보기 창에서만 쓴다 |
| `vendor/musescore-general/` | MuseScore_General 사운드폰트(`.sf3`, MIT, 약 38MB) 받은 그대로. 보기 창이 처음 재생할 때만 불러온다. 출처와 해시는 [alphaTab 보기](alphatab.md) |
| `tools/score-to-alphatex.js` | 시트 한 행 TSV·내장곡 → alphaTex 명령줄 도구(`GuitarAlphaTex.toAlphaTex`만 쓴다). 사용법은 [alphaTab 보기](alphatab.md#명령줄-도구) |
| `tools/alphatab-to-score.js` | alphaTex·Guitar Pro·MusicXML → 시트 한 행 TSV 명령줄 도구(vendor alphaTab을 Node에서 `require`). 가져오기 규칙과 한계는 [alphaTab 보기](alphatab.md#명령줄-도구) |
| `tools/build-scores.js` | 폴더의 `.tex` 원본 → 시트용 6열 TSV(`곡.tsv`) 도구. 같은 이름의 `.tex`가 없는 Guitar Pro 파일은 먼저 `.tex`로 만든다. 흐름은 [alphaTab 보기](alphatab.md#원본은-alphatex) |
| `tools/gp-to-alphatex.js` | Guitar Pro 파일의 기타 트랙 하나 → alphaTex 원본(`.tex`) 명령줄 도구(읽기·트랙 고르기는 `alphatab-to-score.js`의 것을 쓴다). 흐름은 [alphaTab 보기](alphatab.md#원본은-alphatex) |

악보 입력 화면 `score-input.html`은 `app.js` 없이 따로 스크립트를 부른다. 구성과 규칙은 [악보 입력](tab-input.md)에 있다. 두 화면이 같이 쓰는 색 토큰과 기본 컨트롤 스타일(`:root`, `.btn`, `.panel`, `.badge` 등)은 `src/base.css`에 두고 `index.html`은 `<style>` 앞에서 불러 캐스케이드 순서를 지킨다. 설정 상태와 오디오 런타임 전역, 마스터 리미터(`createMasterLimiter`, alphaTab 보기 창도 쓴다)는 `src/app-state.js`에서 같이 불러온다.

## 파싱과 재생 흐름

`parseScore`와 `GuitarNotation.validateScore`가 텍스트 악보의 파싱·검증 기준이다. 파생 필드는 `tok`와 원본 입력에서 다시 계산한다. `GuitarRhythm.annotate`가 칸 길이·시작 위치·유지 체인을 계산하고, `guide.js`가 그 결과로 재생 이벤트를 만들어 `audio.js`에 예약한다. SSOT는 `rhythm.js`의 음가·유지 계산, `guide.js`의 이벤트와 복원 경로, `audio.js`의 `naturalDecay`와 강제 정리다. 세부 계약은 [리듬·오디오 계약](beginner-rhythm.md), 회귀 근거는 `test/test-rhythm.js`, `test/test-guide.js`, `test/test-audio.js`에 있다.

`soundingMidi`(`src/parser.js`)가 카포 실음 변환 공통 함수다. 마디 메모와 가사는 같은 `lyric` 필드로 파싱하고 JSON 문자열로 직렬화한다.

## 초안과 저장

- 텍스트 악보는 원본과 임시 작업을 분리한다. 내장곡과 Google Sheets 원본은 바꾸지 않고, 새 악보와 수정 초안은 `score-drafts.js`가 곡별로 탭 메모리에만 둬서 새로고침하면 사라진다. 텍스트 악보는 IndexedDB·localStorage·백업에 저장하지 않는다. 예외는 악보 입력 화면의 작업 중인 악보 하나다(localStorage, [악보 입력](tab-input.md#저장과-넘기기)).
- 악보 입력 화면이 `gs.tabInput.handoff`에 넘긴 악보는 부팅 때 `scoreEditorHooks.consumeTabInputHandoff`가 읽는다. 넘긴 값에 원래 곡 id(`sourceId`)가 있고 그 곡이 있으며 칸 수가 같으면 `scoreDrafts.replaceScore`로 그 곡의 수정 초안을 만들고, 아니면 `scoreDrafts.createFromScore`로 새 임시 악보를 만든다(둘 다 출처 `tab-input`). 칸 수가 바뀐 악보는 원래 곡에 맞춰 읽을 수 없어서 임시 악보로 열고 그 이유를 `#storageStatus`에 알려 준다. 수정 초안의 조표(`key`)나 카포가 원본과 다르면 고친 것으로 본다. `consumeTabInputHandoff`가 넘긴 제목·설명에서 `getSongCapo`로 읽은 카포를 `replaceScore`의 `opts.capo`로 넘기고, `replaceScore`는 원래 곡의 제목·설명 표기를 `setSongCapoText`로 고치고 곡의 `capo` 값도 같이 바꾼다. 출처가 `tab-input`인 초안은 떠날 때 경고하지 않는다(원본이 입력 화면에 자동 저장돼 있어서다).
- 연습 화면의 텍스트 악보 편집은 악보 입력 화면으로 넘긴다. 툴바 `악보 편집`(`#editInInputBtn`)과 마디 머리의 `편집` 버튼이 지금 곡(초안이면 초안 내용)과 원래 곡 id, 시작 마디를 `gs.tabInput.open`에 써서 `score-input.html`로 간다. `원본 복원`은 초안을 원래 곡으로 돌린다.
- 원본 alphaTex 곡([alphaTab 보기](alphatab.md#원본은-alphatex))을 고쳐 돌아오면 `(사본)` 곡을 만들며, `consumeTabInputHandoff`가 넘긴 값의 카포(설명 글에 들어간다)·BPM·설명을 쓴다(유효하지 않을 때만 원래 곡의 값, 제목은 원래 곡 제목의 `(사본)`). 입력 화면은 연습 화면에서 곡을 불러온 직후 내보낸 결과(`GuitarTabInput.handoffSignature`)를 메모리에 기억해 두고, 넘길 때 지금 내보낸 결과와 같으면 handoff에 `unchanged: true`를 단다(`buildHandoff`의 세 번째 인자). `unchanged === true`이고 원래 곡이 원본 alphaTex 곡이면 사본을 만들지 않고 원래 곡을 연다. 입력 화면을 새로고침해 기억이 사라진 경우는 사본이 만들어진다. 일반 곡 경로는 `unchanged`를 보지 않는다.
- IndexedDB에는 이미지·PDF 악보, localStorage에는 앱 설정과 곡별 최근 연습 BPM·구간 이어가기 상태가 있다. 과거에 저장된 구조화 악보 DB 레코드는 자동 삭제하지 않고 앱에서 노출하지도 않는다.
- 백업 포맷은 버전 1의 `customSongs` 키를 유지한다(이미지 전용 데이터).
- Google Sheets 연동은 읽기 전용이다. TSV 복사는 초안의 현재 악보를 5열 형식으로 내보내고 시트에 직접 쓰지 않는다.
- 시트 불러오기가 실패하면 부팅 때의 조용한 자동 동기화(silent)라도 곡 선택 바 아래 `#sheetLoadStatus`에 첫 오류를 보여 준다. 틀린 행이 하나라도 있으면 시트 전체를 불러오지 않으며, 성공하거나 연동을 해제하면 줄을 숨긴다.

## 사진 변환 프롬프트

- 곡 선택 바의 `#copyScorePromptBtn`이 `src/score-prompt.js`의 `buildScoreImagePrompt()` 결과를 클립보드에 복사한다. 이 프롬프트는 악보 이미지를 alphaTex로 옮기는 규칙을 담고 있다([alphaTab 보기](alphatab.md#사진-변환)).
- 저장소를 읽고 명령을 실행할 수 있는 코딩 에이전트용 프롬프트는 `#copyProjectPromptBtn`(`buildProjectPrompt()`)으로 복사한다. `Docs/alphatab.md`("원본은 alphaTex", "사진 변환")와 `buildScoreImagePrompt()` 출력 규칙을 따라 `Temp/scores/<제목>.tex`를 저장하고 `node tools/build-scores.js Temp/scores`로 `<제목>.tsv`(6열)를 만든다.
- `test/test-score-prompt.js`는 프롬프트 속 예시 코드블록(`ALPHATEX_EXAMPLES`)이 vendor alphaTab에서 진단 0으로 읽히고 `tools/alphatab-to-score.js`로 바꾼 결과가 `validateScore` 오류 0인지, 규칙 속 alphaTex 조각과 이동 표시 이름이 읽히는지, 규칙 문장(`REQUIRED` 목록)이 빠지지 않았는지, 문서·도구 파일 존재와 프롬프트 속 명령 실행, 일부러 어긋난 사본이 걸리는지 확인한다. `RHYTHM_EXAMPLES`(음 길이 표)와 우리 악보 예시 행은 현재 파서로 읽히는지 확인한다. 알려진 alphaTex 표기를 바꾸면 프롬프트 규칙과 이 목록을 같이 고친다.
- 클립보드 API가 없거나 거부되면 화면 밖 textarea와 `execCommand('copy')`로 복사한다. `window.prompt`는 여러 줄을 한 줄로 뭉개서 쓰지 않는다.

## UI 톤

- UI 문구(상태 줄·알림·확인 창·오류 메시지·`CHORD_DB`의 `desc`)는 서술 `~습니다`·`~입니다`, 요청 `~하세요`, 확인 창 `~하시겠습니까?`, 짧은 상태 조각과 단추는 명사형으로 쓴다. `src/score-prompt.js`의 AI 프롬프트 본문은 제외한다.
- 문서·코드 주석·커밋 메시지는 해라체(`~한다`·`~했다`)로 쓰고 이모지를 쓰지 않는다.

## 코드 사전

`src/parser.js`의 `CHORD_DB`는 코드 카드(`src/fretboard.js`의 `renderChordCards`·`buildChordSvg`), 지판의 코드 운지점, 코드 미리 듣기(`src/audio.js`의 `playChordPreview`)가 같이 쓰는 운지 사전이다. 사전에 없는 코드 머리표도 받지만 `UNSUPPORTED_CHORD` 경고가 나온다([악보 문법](score-format.md#오류와-경고)).

- `frets`는 6번 줄부터 1번 줄 순서의 프렛(-1은 뮤트), `fingers`는 같은 순서의 왼손 손가락(0은 개방·뮤트)이다. 코드 이름은 키 하나로 쓰고 한글 설명을 따로 두지 않는다. 지판 옆 운지 칸에는 `키 코드`와 `desc`가 그대로 보여서 `desc`는 UI 톤을 따른다.
- 분수 코드(`G/B` 등)도 키 하나로 따로 넣는다. 베이스가 바뀌면 기본 코드의 운지를 그대로 쓸 수 없어서다.
- 맨 아래 소리(가장 굵은 줄의 음)는 근음이거나 `/` 뒤 베이스 음이어야 한다. `test/test-parser.js`가 모든 항목을 이 규칙과 머리표 검사로 확인한다.
- `buildChordSvg`는 4칸 창을 그린다. 짚는 프렛이 4를 넘으면 가장 낮게 짚는 프렛부터 4칸을 그리고 1번 줄 오른쪽에 시작 프렛(`3fr`)을 적으며 그만큼 그림 폭을 넓힌다. 한 모양이 4칸보다 넓게 벌어지면 넘는 점은 빠지니 새 코드는 4칸 안에서 짚는 모양으로 넣는다. `test/test-app-smoke.js`가 사전의 모든 코드 카드에서 점 수, 점 위치 순서, 시작 프렛 표시를 확인하고, `test/test-browser-smoke.js`가 시작 프렛 글자 상자가 그림 폭 안에 드는지 확인한다.

## 시트 자동 가져오기

`tools/sheet-import-script.js`는 Google Sheets의 Apps Script 편집기에 붙여 넣어 도는 스크립트다. 드라이브의 `FOLDER_NAME` 폴더에서 `.tsv`를 모두 읽어 시트 첫 탭(또는 `SHEET_NAME`)에 넣는다. 쓰는 법은 [사용 안내](usage.md#드라이브-폴더에서-자동으로-가져오기)에 있다.

- Apps Script 런타임에서 그대로 돌아야 해서 `require`·`module`·`import`를 쓰지 않고 최상위 함수 선언만 둔다. `test/test-sheet-import-script.js`가 `vm`으로 파일을 읽고 `SpreadsheetApp`·`DriveApp`·`PropertiesService`·`LockService`·`ScriptApp`을 가짜로 넣어 돌린다.
- 악보 문법은 검사하지 않는다. 문법은 `src/notation.js`가 SSOT라 스크립트에 옮기지 않고, 앱이 시트를 읽을 때와 `tools/check-score.js`가 검사한다. 스크립트는 한 줄이 탭으로 나뉜 5열 또는 6열인지, 제목과 악보가 비지 않았는지만 본다.
- 시트 6번째 열(F열)에 원본 alphaTex를 둔다([alphaTab 보기](alphatab.md#원본은-alphatex)). 앱은 악보를 E열에서만 읽도록 `cols.slice(4, 5)`로 읽고 F열은 곡 객체의 `alphaTex`(`song.alphaTex`)로 싣는다. 스크립트는 5열과 6열을 모두 받고, 행을 쓸 때 언제나 6열을 쓴다(5열 행은 F열을 비워 기존 alphaTex를 지운다). 셀 한 칸 한도(`TEX_CELL_LIMIT`)를 넘는 alphaTex는 그 열만 비우고 `console.log`로 남기며, 머리 행의 F1이 비어 있고 alphaTex를 쓰는 행이 있으면 `alphaTex`를 적는다.
- 파일마다 마지막 수정 시각을 Script Properties(`PROP_PREFIX` + 파일 id)에 남기고 바뀐 파일의 행만 쓴다(시트에서 직접 고친 행을 자동 실행이 덮어쓰지 않게 하려는 것이다). 오류나 제목 중복이 있던 파일은 기록하지 않아 다음 실행에서 다시 본다.
- 파일을 지워도 행은 지우지 않는다. 같은 제목이 여러 줄에 있으면 그 제목은 모두 건너뛴다.
- 제목·설명·악보·alphaTex 칸은 값을 쓰기 전에 서식을 일반 텍스트(`@`)로 바꾼다(설명이 `3/4`처럼 날짜로 읽히는 것을 막기 위해). 칸 수·BPM은 숫자로 쓴다.
- 폴더는 공개 저장소에 개인 드라이브 id를 넣지 않기 위해 이름(`FOLDER_NAME`)으로 찾는다. 휴지통이 아닌 같은 이름 폴더가 없거나 둘 이상이면 오류로 멈춘다.

## 검증

브라우저 밖에서 도는 모듈 테스트와 브라우저 스모크 테스트가 있다.

```powershell
node test/test-score-drafts.js
node test/test-score.js
node test/test-parser.js
node test/test-builtins.js
node test/test-notation.js
node test/test-rhythm.js
node test/test-image-conversion.js
node test/test-score-prompt.js
node test/test-check-score.js
node test/test-midi-to-score.js
node test/test-tab-input.js
node test/test-staff-layout.js
node test/test-staff-svg.js
node test/test-staff-input.js
node test/test-score-to-alphatex.js
node test/test-alphatab-tools.js
node test/test-audio.js
node test/test-guide.js
node test/test-storage.js
node test/test-sheets.js
node test/test-sheet-import-script.js
node test/test-app-smoke.js
node test/test-browser-smoke.js
node test/test-browser-input.js
node test/test-browser-alphatab.js
node test/test-browser-audio.js
Get-ChildItem src\*.js, test\*.js, tools\*.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

브라우저 테스트는 공통 하네스(`test/browser-harness.js`) 위에서 영역별로 나뉜다: `test-browser-smoke`(연습 화면), `test-browser-input`(`score-input.html`), `test-browser-alphatab`(`alphatab.html`·음량 비교), `test-browser-audio`(브라우저 `OfflineAudioContext`). 고친 영역에 해당하는 스위트만 돌리고, 스크린샷 검증은 `test-artifacts/` 안의 고정 이름 파일만 덮어써서 타임스탬프 파일이 누적되지 않게 한다(기존 개인 자료 보존). Chrome 또는 Edge를 자동 탐색하고 `CHROME_BIN`으로 지정할 수 있으며, Node 내장 `fetch`와 `WebSocket` 전역(`node -p "process.version + ' fetch=' + typeof fetch + ' WebSocket=' + typeof WebSocket"`)이 필요하다. 실제 기기에서의 청취 품질은 확인하지 않는다.

브라우저 스모크는 크롬 임시 프로필(`gs-browser-smoke-*`)을 프로세스 트리가 끝난 뒤 재시도하며 지우고(실패 시 경고), 시작할 때 `os.tmpdir()` 아래의 한 시간 넘은 것을 치운다.
