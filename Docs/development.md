# 개발 안내

번들러와 트랜스파일러가 없는 정적 Vanilla JS 앱이야. 저장소 루트에서 `index.html`을 제공하면 실행돼.

## 모듈 구성

`index.html`은 아래 표 순서대로 classic script를 로드해. 순서를 유지해.

| 파일 | 역할 |
|---|---|
| `src/storage.js` | DOM과 분리된 IndexedDB 저장소 |
| `src/app-state.js` | 앱 설정 상태(`appState`)와 오디오 런타임 전역. 악보 입력 화면도 같이 불러 |
| `src/notation.js` | 입력 줄 토큰화, 마디 메모·가사·코드 머리표, 직렬화와 구조 검증 |
| `src/rhythm.js` | 칸 길이와 쉼·유지 체인 분석 |
| `src/parser.js` | `parseScore`, 음·화음·운지 파싱, 카포와 실음 계산 |
| `src/score-drafts.js` | 곡별 메모리 임시 초안과 검증된 마디 편집 이력 |
| `src/score.js` | 화면의 박자·음가·음이름 표시 |
| `src/audio.js` | KS/classic 합성기와 재생음 수명 관리 |
| `src/guide.js` | 구조화 악보의 재생 이벤트 생성·예약 |
| `src/image-analysis.js` | 이미지의 마디 경계 후보 분석 |
| `src/fretboard.js` | 지판 미리듣기와 코드 카드 표시 |
| `src/score-ui.js` | 악보 보기 전환과 `formatSongToSheetTsv` 공통 함수 |
| `src/sheets.js` | Google Sheets 읽기 연동 |
| `src/score-prompt.js` | 악보 이미지 변환용 범용 AI 프롬프트 문자열과 복사 버튼 |
| `src/score-editor.js` | 임시 악보 생성·편집 UI, 마디 작업과 초안 작업 흐름 |
| `src/app.js` | 앱 상태, UI 부팅과 기능 연결 |

`app.js` 부팅 때 앱 모듈과 상태가 준비된 뒤 `initFretboard()`, `initScoreUi()`, `initSheetSync()`, `GuitarScorePrompt.initScorePromptButton()`과 편집 UI가 이벤트를 등록해. 로컬 스크립트는 모두 같은 `v` 쿼리 버전을 써. DOM 구조나 스크립트 구성이 바뀌면 버전을 같이 올려 캐시된 이전 코드와 섞이지 않게 해.

화면·단축키 결정은 [화면과 조작](ui.md)에 있어.

악보 입력 화면 `score-input.html`은 `app.js` 없이 따로 스크립트를 불러. 구성과 결정은 [악보 입력](tab-input.md)에 있어. 2026-10-19 결정: 두 화면이 같이 쓰는 색 토큰과 기본 컨트롤 스타일(`:root`, `.btn`, `.panel`, `.badge` 등)을 `index.html` 인라인 스타일에서 `src/base.css`로 옮겼어. `index.html`은 `<style>` 앞에서 불러 캐스케이드 순서를 지켜. 같은 날 `app.js` 맨 위의 설정 상태와 오디오 런타임 전역도 `src/app-state.js`로 옮겼어. 입력 화면이 `audio.js`로 음을 들려주려면 이 전역이 있어야 하는데, 복사하면 마스터 음량 같은 값이 두 군데가 돼서야.

## 파싱과 재생 흐름

`parseScore`와 `GuitarNotation.validateScore`가 텍스트 악보의 파싱·검증 기준이야. 파생 필드는 `tok`와 원본 입력에서 다시 계산해. `GuitarRhythm.annotate`가 칸 길이·시작 위치·유지 체인을 계산하고, `guide.js`가 그 결과로 재생 이벤트를 만들어 `audio.js`에 예약해. SSOT는 `rhythm.js`의 음가·유지 계산, `guide.js`의 이벤트와 복원 경로, `audio.js`의 `naturalDecay`와 강제 정리야. 세부 계약은 [리듬·오디오 계약](beginner-rhythm.md), 회귀 근거는 `test/test-rhythm.js`, `test/test-guide.js`, `test/test-audio.js`에 있어.

`soundingMidi`(`src/parser.js`)가 카포 실음 변환 공통 함수야. 마디 메모와 가사는 같은 `lyric` 필드로 파싱하고 JSON 문자열로 직렬화해.

## 초안과 저장

- 2026-10-19 결정: 텍스트 악보는 원본과 임시 작업을 분리해. 내장곡과 Google Sheets 원본은 바꾸지 않고, 새 악보와 수정 초안은 `score-drafts.js`가 곡별로 탭 메모리에만 둬서 새로고침하면 사라져. 텍스트 악보는 IndexedDB·localStorage·백업에 저장하지 않아. 이미지·PDF 악보와 앱 설정의 영속화는 그대로야. 예외는 악보 입력 화면의 작업 중인 악보 하나야(localStorage, 이유는 [악보 입력](tab-input.md)의 저장과 넘기기).
- 2026-10-19 결정: 악보 입력 화면이 `gs.tabInput.handoff`에 넘긴 악보는 부팅 때 `scoreEditorHooks.consumeTabInputHandoff`가 읽어 `scoreDrafts.createFromScore`로 임시 악보를 만들어(출처 `tab-input`). 연습 화면에서 고치지 않은 이 임시 악보는 떠날 때 경고하지 않아.
- 편집은 전체 악보 검증이 성공할 때만 적용해. 마디 편집 한 번이 실행 취소 한 단계고, 초안 초기화는 그 곡 원본 복사본으로 되돌려. 편집 중에는 곡 전환·재생·복사·다른 편집을 막아 미적용 내용을 잃지 않게 해.
- IndexedDB에는 이미지·PDF 악보, localStorage에는 앱 설정과 곡별 최근 연습 BPM·구간 이어가기 상태가 있어. 과거에 저장된 구조화 악보 DB 레코드는 자동 삭제하지 않고 앱에서 노출하지도 않아.
- 백업 포맷은 버전 1의 `customSongs` 키를 유지해. 이름과 달리 이미지 전용 데이터를 담아.
- Google Sheets 연동은 읽기 전용이야. TSV 복사는 초안의 현재 악보를 5열 형식으로 내보내고 시트에 직접 쓰지 않아.
- 2026-10-19 결정: 시트 불러오기가 실패하면 부팅 때의 조용한 자동 동기화(silent)라도 곡 선택 바 아래 `#sheetLoadStatus`에 첫 오류를 보여 줘. 전에는 silent일 때 이유를 숨겨서, 틀린 행이 하나만 있어도 새로고침하면 시트 곡이 모두 사라지고 아무 안내도 없었어. 틀린 행이 있으면 시트 전체를 막는 정책은 그대로야. 성공하거나 연동을 해제하면 줄을 숨겨.

## 사진 변환 프롬프트

- 2026-10-19 결정: 곡 선택 바의 `#copyScorePromptBtn`이 `src/score-prompt.js`의 `buildScoreImagePrompt()` 결과를 클립보드에 복사해. a4dcdd5에서 이미지 변환 편집기를 걷어낼 때 `src/ai-prompt.js`의 프롬프트 복사까지 같이 지워졌는데, 이미지 악보를 텍스트 악보로 옮길 보조 수단이 이것뿐이라 되살렸어.
- 옛 프롬프트는 버튼에 특정 AI 이름을 달고, 앱에서 고른 칸 수·BPM을 인자로 받고, 여러 성부가 나오면 변환을 멈추게 했어. 새 프롬프트는 AI 이름을 쓰지 않고 인자가 없어. 칸 수와 BPM은 AI가 이미지의 박자표·템포를 보고 고르고 환산하며, 템포가 없으면 앱 기본값 64를 쓰고 그 사실을 밝히게 해.
- 여러 성부는 내장 로망스와 같은 방식으로 근사하게 해. 각 음의 시작 칸에 `+`로 합치고 길이는 자연 감쇠에 맡기며, 한 성부만 쉬는 자리는 `r` 대신 `-`로 적어. 곡 전체가 이런 식이면 설명 열에, 일부 마디만이면 그 마디 메모에 적게 해.
- 출력은 한 줄에 한 마디인 악보와 Google Sheets용 TSV 한 행이야.
- 2026-10-19 결정: 프롬프트는 한 번에 끝까지 관대하게 변환하게 해. 처음에는 지원하지 않는 표기(박자 변경, 변칙 조율)에서 변환을 멈추고 읽지 못한 음을 단독 `?`로 남겨 앱 검증이 불러오기를 막게 했는데, 사용자는 AI를 여러 번 다시 돌리지 않고 앱에서 직접 고치길 원했어. 이제 지원하지 않는 표기는 정해진 규칙대로 단순하게 바꾸고(꾸밈음 생략, 슬러는 따로 침, 박자가 다른 마디는 `r`로 채우거나 나눔 등) 마디 메모에 적게 하며, 불확실한 음은 가장 그럴듯한 값에 확인 표시 `?`를 붙이게 해([악보 문법](score-format.md)의 확인 표시). 이미지에 없는 내용을 지어내지는 않게 해. 같은 날 안 맞는 표기는 가볍게 편곡하는 느낌이면 되고 빼는 것도 그중 하나라 메모만 남기면 돼. 그래서 목록에 없는 표기(벤딩, 골페 등)도 같은 식으로 바꾸거나 빼게 하되, 원본에 없는 음을 더하지는 않게 해.
- 2026-10-19 결정: 프롬프트가 앱이 받는 한계를 AI에 직접 알려 줘. 시트 BPM은 정수만 받고(`src/sheets.js`), 범위를 벗어난 BPM은 앱이 말없이 잘라(`src/app.js` 곡 적용부). 칸을 잘게 잡으면 BPM이 커지니, 넘으면 칸을 키우고 분할로 적게 해. 빠른 6/8·9/8은 6칸·9칸이면 쉽게 넘어서(점4분음표=100이면 300) 12/8처럼 2칸·3칸에 3분할로 적는 길을 같이 알려 줘. 파서는 2칸 3분할 마디를 오류 없이 읽어. 코드 머리표 `[?]`는 코드 추론 표시라 검증을 통과하므로 읽지 못한 코드는 `[-]`로 두게 해. 카포가 있으면 적은 음과 실음이 다르다는 것도 밝혀. 이 한계를 바꾸면 프롬프트 문구도 같이 고쳐.
- 2026-10-19 결정: 프롬프트를 앱을 모르는 AI 기준으로 다시 썼어. 작업 원칙 → 출력 → 문법 1~7(마디, 칸 내용, 음 토큰 자리 순서, 음높이, 박자와 칸, 음 길이 표, 여러 성부) → 예외와 애매한 경우 표 → 출력 전 점검 순서야. 이전 판은 규칙이 흩어져 있고 음표 길이를 어떻게 적는지 대응이 없어서 AI가 유추해야 했어(8분음표 둘을 두 칸에 적는 식의 실수 위험). 음 길이 표는 `RHYTHM_EXAMPLES` 데이터에서 만들고, `test-score-prompt`가 각 표기를 파서로 읽어 길이가 표와 맞는지 확인해. 옥타브 번호(가운데 도 = C4)와 기타 오선보의 한 옥타브 차이처럼 앱 밖의 관습에 기대던 부분도 명시했어.
- `test/test-score-prompt.js`는 프롬프트 속 문법 예시(`EXAMPLE_MEASURES`, `EXAMPLE_TSV_ROW`)와 음 길이 표(`RHYTHM_EXAMPLES`)가 현재 파서로 오류 없이 읽히고 길이가 맞는지만 확인해. 규칙 문장은 검사하지 않으니 문법을 바꾸면 프롬프트 규칙도 같이 고쳐.
- 클립보드 API가 없거나 거부되면 화면 밖 textarea와 `execCommand('copy')`로 복사해. `window.prompt`는 여러 줄을 한 줄로 뭉개서 쓰지 않아.
- 2026-10-19 결정: 저장소를 읽고 명령을 실행할 수 있는 AI(코딩 에이전트)용 짧은 프롬프트를 `#copyProjectPromptBtn`으로 복사해. 본문은 `src/score-prompt.js`의 `buildProjectPrompt()`야. 문법과 변환 규칙을 다시 적지 않고 `Docs/score-format.md`와 `buildScoreImagePrompt()` 출력 명령을 가리켜서, 규칙이 한 군데에만 있게 했어. AI는 결과를 `Temp/scores/<제목>.tsv`에 저장하고 `node tools/check-score.js`로 문법 오류가 0인지 확인해. 이 도구는 행 모양(5열, 칸 수, BPM 30~240)을 보고 악보는 `parser.validateScore`로만 검사해. 칸 수 목록은 `src/sheets.js`, BPM 범위는 `src/app.js` 곡 적용부와 같아야 해. `test-score-prompt`가 프롬프트 속 명령을 실제로 실행해 확인해.

## 이력

모듈 분리, 공통 파서·카포 경로, 단위·스모크 테스트, 초보 리듬 입력과 재생 계약 정리를 마쳤어. alphaTab 재생은 `codex/alphatab-player` 실험 브랜치에만 있고 main 앱은 기존 엔진을 써.

## 검증

브라우저 밖에서 도는 모듈 테스트와 브라우저 스모크 테스트가 있어.

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
node test/test-audio.js
node test/test-guide.js
node test/test-storage.js
node test/test-sheets.js
node test/test-app-smoke.js
node test/test-browser-smoke.js
Get-ChildItem src\*.js, test\*.js, tools\*.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

브라우저 스모크는 Chrome 또는 Edge를 자동 탐색하고 `CHROME_BIN`으로 실행 파일을 지정할 수 있어. 임시 HTTP 서버와 임시 브라우저 프로필을 쓰며 Web Audio API 경로를 실제로 실행해. Node 내장 `fetch`와 `WebSocket` 전역이 필요하고 `node -p "process.version + ' fetch=' + typeof fetch + ' WebSocket=' + typeof WebSocket"`로 확인할 수 있어. 실제 기기에서의 청취 품질은 확인하지 않아. 스크린샷 검증은 `test-artifacts/`에 새 파일을 만들 수 있으니 기존 개인 자료를 보존해.
