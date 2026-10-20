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
| `src/score-drafts.js` | 곡별 메모리 임시 악보·수정 초안과 원본 되돌리기 |
| `src/score.js` | 화면의 박자·음가·음이름 표시 |
| `src/audio.js` | KS/classic 합성기와 재생음 수명 관리 |
| `src/guide.js` | 구조화 악보의 재생 이벤트 생성·예약 |
| `src/image-analysis.js` | 이미지의 마디 경계 후보 분석 |
| `src/fretboard.js` | 지판 미리듣기와 코드 카드 표시 |
| `src/score-ui.js` | 악보 보기 전환과 `formatSongToSheetTsv` 공통 함수 |
| `src/sheets.js` | Google Sheets 읽기 연동 |
| `src/score-prompt.js` | 악보 이미지 변환용 범용 AI 프롬프트 문자열과 복사 버튼 |
| `src/score-editor.js` | 초안 상태 줄·원본 복원, 악보 입력 화면과 주고받기 |
| `src/app.js` | 앱 상태, UI 부팅과 기능 연결 |

`app.js` 부팅 때 앱 모듈과 상태가 준비된 뒤 `initFretboard()`, `initScoreUi()`, `initSheetSync()`, `GuitarScorePrompt.initScorePromptButton()`과 편집 UI가 이벤트를 등록해. 로컬 스크립트는 모두 같은 `v` 쿼리 버전을 써. DOM 구조나 스크립트 구성이 바뀌면 버전을 같이 올려 캐시된 이전 코드와 섞이지 않게 해.

화면·단축키 결정은 [화면과 조작](ui.md)에 있어.

악보 입력 화면 `score-input.html`은 `app.js` 없이 따로 스크립트를 불러. 구성과 결정은 [악보 입력](tab-input.md)에 있어. 2026-10-19 결정: 두 화면이 같이 쓰는 색 토큰과 기본 컨트롤 스타일(`:root`, `.btn`, `.panel`, `.badge` 등)을 `index.html` 인라인 스타일에서 `src/base.css`로 옮겼어. `index.html`은 `<style>` 앞에서 불러 캐스케이드 순서를 지켜. 같은 날 `app.js` 맨 위의 설정 상태와 오디오 런타임 전역도 `src/app-state.js`로 옮겼어. 입력 화면이 `audio.js`로 음을 들려주려면 이 전역이 있어야 하는데, 복사하면 마스터 음량 같은 값이 두 군데가 돼서야.

## 파싱과 재생 흐름

`parseScore`와 `GuitarNotation.validateScore`가 텍스트 악보의 파싱·검증 기준이야. 파생 필드는 `tok`와 원본 입력에서 다시 계산해. `GuitarRhythm.annotate`가 칸 길이·시작 위치·유지 체인을 계산하고, `guide.js`가 그 결과로 재생 이벤트를 만들어 `audio.js`에 예약해. SSOT는 `rhythm.js`의 음가·유지 계산, `guide.js`의 이벤트와 복원 경로, `audio.js`의 `naturalDecay`와 강제 정리야. 세부 계약은 [리듬·오디오 계약](beginner-rhythm.md), 회귀 근거는 `test/test-rhythm.js`, `test/test-guide.js`, `test/test-audio.js`에 있어.

`soundingMidi`(`src/parser.js`)가 카포 실음 변환 공통 함수야. 마디 메모와 가사는 같은 `lyric` 필드로 파싱하고 JSON 문자열로 직렬화해.

## 초안과 저장

- 2026-10-19 결정: 텍스트 악보는 원본과 임시 작업을 분리해. 내장곡과 Google Sheets 원본은 바꾸지 않고, 새 악보와 수정 초안은 `score-drafts.js`가 곡별로 탭 메모리에만 둬서 새로고침하면 사라져. 텍스트 악보는 IndexedDB·localStorage·백업에 저장하지 않아. 이미지·PDF 악보와 앱 설정의 영속화는 그대로야. 예외는 악보 입력 화면의 작업 중인 악보 하나야(localStorage, 이유는 [악보 입력](tab-input.md)의 저장과 넘기기).
- 2026-10-19 결정: 악보 입력 화면이 `gs.tabInput.handoff`에 넘긴 악보는 부팅 때 `scoreEditorHooks.consumeTabInputHandoff`가 읽어. 넘긴 값에 원래 곡 id(`sourceId`)가 있고 그 곡이 있으며 칸 수가 같으면 `scoreDrafts.replaceScore`로 그 곡의 수정 초안을 만들고, 아니면 `scoreDrafts.createFromScore`로 새 임시 악보를 만들어(둘 다 출처 `tab-input`). 칸 수가 바뀐 악보는 원래 곡에 맞춰 읽을 수 없어서 임시 악보로 열고 그 이유를 `#storageStatus`에 알려 줘. 수정 초안의 조표(`key`)도 원본과 다르면 고친 것으로 봐(조표만 바꿔도 초안이 남고 `원본 복원`이 보여). 출처가 `tab-input`인 초안은 떠날 때 경고하지 않아(원본이 입력 화면에 자동 저장돼 있어서야).
- 2026-10-19 결정: 연습 화면의 편집은 악보 입력 화면으로 넘겨. 툴바 `악보 편집`(`#editInInputBtn`)과 마디 머리의 `편집` 버튼이 지금 곡(초안이면 초안 내용)과 원래 곡 id, 시작 마디를 `gs.tabInput.open`에 써서 `score-input.html`로 가. 전에 있던 마디 원문 편집·마디 추가·삭제·`빈 악보 추가`·초안 한 단계 되돌리기는 지웠어. 편집기가 둘이면 사용자가 헷갈리고 같은 기능을 두 군데서 고쳐야 해서야. `원본 복원`은 남겨 초안을 원래 곡으로 돌려.
- 2026-10-19 결정: 수정 초안은 악보·조표에 더해 카포도 받아. `consumeTabInputHandoff`가 넘긴 제목·설명에서 `getSongCapo`로 읽은 카포를 `replaceScore`의 `opts.capo`로 넘기고, `replaceScore`는 원래 곡의 제목·설명 표기를 `setSongCapoText`로 고치고 곡의 `capo` 값도 같이 바꿔(표기를 지웠을 때 원래 곡을 만들 때 넣어 둔 `capo`로 돌아가지 않게). 카포가 원본과 다르면 고친 것으로 봐. 입력 화면에 카포 콤보를 넣으면서, 제목·설명은 원래 곡 것을 쓰는 규칙 때문에 바꾼 카포가 연습 화면에서 사라져서야.
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
- 2026-10-20 결정: 코드 이름이 찍히지 않은 마디는 `[-]` 대신 앞에서 이어지는 코드를 적게 했어(앞 마디 중간에 바뀌었으면 바뀐 뒤 코드). 악보는 코드가 바뀌는 마디에만 이름을 찍는데, `[-]`로 두면 연습 화면에서 그 마디들의 코드 칩이 비어 보여서야. 곡 처음처럼 이어질 코드가 없으면 그대로 `[-]`야. 이미 변환해 둔 언제나 몇 번이라도·인생의 회전목마 TSV(`Temp/scores`, 드라이브 `GuitarScores` 폴더)도 같은 규칙으로 고쳤어.

## UI 톤 및 버튼 명칭 정돈

- 2026-10-19 결정: 사용자 인터페이스 전반의 비표준 해요체·구어체 문구('~해요', '~했어요', '~해줘' 등)를 표준 UI 안내문 톤(명사형 또는 하십시오형)으로 정돈했어. 시인성을 해치던 지나치게 긴 버튼 라벨(`+ 교본 사진/PDF 악보 올리기` -> `+ 악보 올리기`, `원본으로 되돌리기` -> `원본 복원`, `마디 영역 편집 켜짐` -> `마디 편집`, `파란 코드 점: 켜짐` -> `코드 운지점` 등)도 핵심 의미를 온전히 유지하면서 간결하게 축약했어. 기존 스모크 테스트와 브라우저 테스트의 핵심 단언문 정규식 키워드는 그대로 유지하여 호환성을 보장했어.
- 2026-10-19 결정: 그때 남은 반말·해요체 문구도 같은 톤으로 맞췄어. 상태 줄·알림·확인 창, 악보 검사 오류(`src/notation.js`·`src/parser.js`·`src/rhythm.js`), 악보 입력 화면의 모델·오선 입력 오류(`src/tab-input.js`·`src/staff-input.js`·`src/staff-layout.js`, 화면에 `error.message` 그대로 나와), 시트 연동 안내, 코드 사전 설명(`desc`, 지판 왼손 운지 칸에 보여), `tools/check-score.js` 출력이야. 규칙: 서술은 `~습니다`·`~입니다`, 부탁은 `~하세요`, 확인 창은 `~하시겠습니까?`, `·`로 잇는 짧은 상태 조각과 단추는 명사형. `src/score-prompt.js`의 AI 프롬프트 본문은 AI에게 주는 지시라 UI가 아니어서 그대로 뒀어(복사 결과 안내 셋만 바꿨어). 문서(`Docs/`) 말투는 이 결정의 범위가 아니야. 오류 문구를 통째로 비교하던 테스트는 새 문구로 맞췄어. 다시 찾을 때는 남은 반말 어미(`없어.`, `여야 해`, `해줘` 같은 것)를 `git grep`으로 찾아.

## 코드 사전

`src/parser.js`의 `CHORD_DB`는 코드 카드(`src/fretboard.js`의 `renderChordCards`·`buildChordSvg`), 지판의 코드 운지점, 코드 미리 듣기(`src/audio.js`의 `playChordPreview`)가 같이 쓰는 운지 사전이야. 사전에 없는 코드 머리표도 받지만 `UNSUPPORTED_CHORD` 경고가 나와([악보 문법](score-format.md#오류와-경고)).

- `frets`는 6번 줄부터 1번 줄 순서의 프렛(-1은 뮤트), `fingers`는 같은 순서의 왼손 손가락(0은 개방·뮤트)이야. `name`과 `desc`는 지판 옆 운지 칸에 그대로 보여서 UI 톤(`~습니다`·명사형)을 따라.
- 분수 코드(`G/B` 같은 것)도 키 하나로 따로 넣어. 베이스가 바뀌면 기본 코드의 운지를 그대로 쓸 수 없어서야.
- 맨 아래 소리(가장 굵은 줄의 음)는 근음이거나 `/` 뒤 베이스 음이어야 해. `test/test-parser.js`가 모든 항목을 이 규칙과 머리표 검사로 확인해.
- `buildChordSvg`는 4칸 창을 그려. 짚는 프렛이 4를 넘으면 가장 낮게 짚는 프렛부터 4칸을 그리고 1번 줄 오른쪽에 시작 프렛(`3fr`)을 적어. 왼쪽에 적으면 6번 줄 점에 가려져서(화면 캡처로 확인) 오른쪽에 두고 그림 폭을 그만큼 넓혔어. 2026-10-20에 글자가 있는 카드만 폭을 더 넓혔어(한 자리 104, 두 자리 108). `Am9`의 `10fr`이 `10f`로 잘렸고, 글자 상자로 재 보니 폭 100에서는 `3fr`도 끝이 걸쳤어. `test/test-browser-smoke.js`가 모든 카드의 시작 프렛 글자 상자가 그림 폭 안에 드는지 확인해. 한 모양이 4칸보다 넓게 벌어지면 넘는 점은 빠지니, 새 코드는 4칸 안에서 짚는 모양으로 넣어. `test/test-app-smoke.js`가 사전의 모든 코드 카드에서 점 수, 점 위치 순서, 시작 프렛 표시를 확인해.

2026-10-20 결정: 사용자가 옮긴 곡(언제나 몇 번이라도, 인생의 회전목마)의 머리표 `CM7`·`Bm7`·`F#m7b5`·`C#7`·`F#7`·`G/B`·`C/E`·`Am/E`·`G/D`·`G/F`를 넣었어. 운지는 곡 TAB에 나온 모양을 먼저 따르고, 그 모양이 4프렛을 넘으면(`F#m7b5`는 곡 TAB이 5프렛) 흔한 개방 모양을 골랐어. 같은 날 반란군의 테마의 `B/F#`·`Esus4`·`F7b5`를 같은 기준으로 더 넣었어(`B/F#`·`F7b5`는 곡 TAB의 음을 한 모양으로 모은 것). 친구를 찾아서의 `F#m7/E`·`Em7`·`A/E`·`B7sus4`·`D6`·`D/C`·`Am9`·`FM7`·`Bb`·`A/B`도 같은 날 넣었어. `Am9`는 곡의 원본 표기 `Am7(9)`와 같은 코드이고(괄호는 머리표에 못 써), 곡 TAB의 10~12프렛 모양을 그대로 썼어. 자나르칸드의 `B`·`Bsus4`·`Bmadd9`·`C#m`·`Emadd9`·`Fadd9`·`Gadd9`·`Am7`도 같은 날 넣었어(곡 TAB 모양이 한 손 모양으로 안 모이면 흔한 모양).

2026-10-20 결정: 전에는 1~4프렛만 그려서 `Gm`·`Cm` 카드의 5프렛 점이 빠졌어(인생의 회전목마 30·82마디가 `Gm`). 짚는 프렛이 4를 넘으면 창을 옮겨 그리게 고쳤어. 4프렛 안의 코드는 그림이 그대로야.

## 시트 자동 가져오기

`tools/sheet-import-script.js`는 앱이 아니라 Google Sheets의 Apps Script 편집기에 붙여 넣어 도는 스크립트야. 드라이브의 `FOLDER_NAME` 폴더에서 `.tsv`를 모두 읽어 시트 첫 탭(또는 `SHEET_NAME`)에 넣어. 쓰는 법은 [사용 안내](usage.md#드라이브-폴더에서-자동으로-가져오기)에 있어.

- Apps Script 런타임에서 그대로 돌아야 해서 `require`·`module`·`import`를 쓰지 않고 최상위 함수 선언만 둬. `test/test-sheet-import-script.js`가 `vm`으로 파일을 읽고 `SpreadsheetApp`·`DriveApp`·`PropertiesService`·`LockService`·`ScriptApp`을 가짜로 넣어 돌려.
- 악보 문법은 검사하지 않아. 문법은 `src/notation.js`가 SSOT라 스크립트에 옮기지 않고, 앱이 시트를 읽을 때와 `tools/check-score.js`가 검사해. 스크립트는 한 줄이 탭으로 나뉜 5열인지, 제목과 악보가 비지 않았는지만 봐.

2026-10-20 결정:

- 화면에서 드래그해 복사한 TSV는 클립보드에 탭이 빠진 HTML이 같이 실려서, 시트가 HTML을 골라 한 칸에 몰아넣었어. `Ctrl+Shift+V`로 피할 수는 있지만 곡마다 붙여 넣는 일이 번거로웠어. 앱은 GitHub Pages에서 돌아 로컬 파일을 못 읽고, 드라이브 파일을 브라우저에서 바로 읽으려면 Drive API 키가 필요해. 그래서 앱은 지금처럼 시트만 읽고, 시트 쪽 Apps Script가 드라이브 폴더를 가져오게 했어.
- 틀린 길: 앱이 로컬 TSV 폴더를 `python -m http.server`의 폴더 목록으로 읽는 안은 서버를 띄워 둬야 해서 버렸어.
- 행은 제목으로 맞춰. 앱은 E열부터 끝까지를 악보로 이어 읽어서(`src/sheets.js`의 `cols.slice(4)`) 출처 파일 같은 열을 더 둘 수 없어.
- 파일마다 마지막 수정 시각을 Script Properties(`PROP_PREFIX` + 파일 id)에 남기고 바뀐 파일의 행만 써. 시트에서 직접 고친 행을 자동 실행이 매번 덮어쓰지 않게 하려는 거야. 오류나 제목 중복이 있던 파일은 기록하지 않아 다음 실행에서 다시 봐.
- 파일을 지워도 행은 지우지 않아. 위 열 제약 때문에 시트에서 손으로 넣은 곡과 파일에서 온 곡을 구분할 수 없어서야.
- 같은 제목이 여러 줄에 있으면 그 제목은 모두 건너뛰어. 어느 쪽이 맞는지 스크립트가 정하지 않아.
- 제목·설명·악보 칸은 값을 쓰기 전에 서식을 일반 텍스트(`@`)로 바꿔. 설명이 `3/4`처럼 날짜로 읽힐 수 있는 값이면 시트가 바꿔 버려서야. 칸 수·BPM은 숫자로 써서 붙여 넣던 기존 행과 맞춰.
- 폴더는 id가 아니라 이름(`FOLDER_NAME`)으로 찾아. 저장소가 공개라 개인 드라이브 id를 넣지 않으려고. 휴지통이 아닌 같은 이름 폴더가 없거나 둘 이상이면 오류로 멈춰.
- 2026-10-20 실제 시트에서 확인: 드라이브 데스크톱의 "내 컴퓨터"로 동기화한 폴더도 `DriveApp.getFoldersByName`이 찾았어. `setup`과 시간 트리거 실행이 Apps Script 실행 기록에 "완료됨"으로 남았고, 앱이 쓰는 gviz 주소(`.../gviz/tq?tqx=out:json&gid=0`)로 받은 행을 TSV로 바꿔 `tools/check-score.js`에 넣으니 오류 0이었어. gviz 열 타입은 문자·숫자·숫자·문자·문자로 나왔어.
- 처음 `setup` 실행 때 권한 허용 창이 별도 팝업으로 떠서 Claude in Chrome 확장은 누를 수 없었어. 권한 허용은 사용자가 PC에서 직접 해야 해.

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
node test/test-sheet-import-script.js
node test/test-app-smoke.js
node test/test-browser-smoke.js
Get-ChildItem src\*.js, test\*.js, tools\*.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

브라우저 스모크는 Chrome 또는 Edge를 자동 탐색하고 `CHROME_BIN`으로 실행 파일을 지정할 수 있어. 임시 HTTP 서버와 임시 브라우저 프로필을 쓰며 Web Audio API 경로를 실제로 실행해. Node 내장 `fetch`와 `WebSocket` 전역이 필요하고 `node -p "process.version + ' fetch=' + typeof fetch + ' WebSocket=' + typeof WebSocket"`로 확인할 수 있어. 실제 기기에서의 청취 품질은 확인하지 않아. 스크린샷 검증은 `test-artifacts/`에 새 파일을 만들 수 있으니 기존 개인 자료를 보존해.
