# 화면과 조작

연습 화면의 툴바, 표기, 단축키, 메트로놈 클릭 동작 기준이다. 사용자 설명은 [사용 안내](usage.md)에 있다. 악보 입력 화면(`score-input.html`)의 화면·조작은 [악보 입력](tab-input.md)에 따로 있다.

## 툴바와 콘솔

- 악보 바로 위 `#scoreToolbar`에 시작 버튼 `#compactPlayBtn`과 곡 선택 `#compactSongSelect`를 일반·콤팩트 뷰 모두 둔다. 상단 패널의 중복 곡 선택 행과 `#playBtn`은 `hidden`으로 유지한다(Space 단축키와 스모크 테스트 호환).
- 콘솔은 2열 그리드다. 첫째(템포) 박스 헤더에 콘서트홀 버튼과 가이드음 토글 `#guideSoundBtn`(`가이드음` / `가이드음 끔`)이 `.fx-toggle` 스타일로 놓이고, `탭` 단추(`#tapTempoBtn`)는 두 번 이상 연속 타건 간격(최근 5회, 2.5초 초과 시 초기화)의 평균으로 BPM을 반영한다.
- 640px 이상에서 툴바는 `flex-wrap: nowrap`이고 `#scoreClickHint`를 숨긴다. 임시 악보·수정 초안이 아니면 `#scoreDraftControls` 전체를 숨긴다.
- `#rewindToFirstBtn`(Home)은 `resetToFirstMeasure`가 커서를 첫 마디로 돌리고, 반복 구간 시작이 첫 마디를 벗어나 있으면 전체 곡 기준으로 맞추며, `#structuredScoreWrap`·`#imgStageScroll`을 맨 위로 부드럽게 스크롤한다.
- 곡 선택 바에 악보 입력 화면으로 가는 링크 `#openScoreInputLink`(`악보 입력`)를 둔다. 악보 툴바의 `악보 편집`(`#editInInputBtn`, 텍스트 악보만)과 마디 머리의 `편집` 버튼(`.score-measure-edit`, 그 마디부터 편집)이 악보 입력 화면으로 넘긴다([개발 안내](development.md#초안과-저장)).
- 헤더의 `단축키 안내` 옆에 `alphaTab` 단추(`#openAlphaTabBtn`, 구조화 곡일 때만 표시)를 둔다([alphaTab 보기](alphatab.md)). 툴바 폭 여유가 없어 단추를 더 넣지 않는다.
- 원본이 alphaTex인 곡(시트 6열)은 악보 입력 화면에서 고쳐 돌아와도 제자리 수정 초안을 만들지 않고, 우리 악보만 담은 새 곡을 `임시 악보` 묶음에 `<원래 제목> (사본)`(중복 시 `(사본 2)` 등)으로 저장해 연다. 칸 수를 바꿔 돌아와도 같다. 상태 줄(`#storageStatus`) 문구는 `원본이 alphaTex인 곡이라 고친 내용을 사본 「<사본 제목>」으로 저장했습니다.`, `악보 편집` 단추 설명은 `악보 입력 화면에서 고치면 우리 악보 사본으로 저장됩니다`이다([alphaTab 보기](alphatab.md#원본은-alphatex)).
- 곡에 카포가 있으면 툴바의 보기 선택 바로 뒤에 `카포 N` 배지(`#capoBadge`, 강조색)를 보여 준다. 카포 0이면 숨기고, 콤팩트 모드에서도 보인다.
- `#compactStatusBadge`(마디·박·BPM)는 콘솔을 숨기는 콤팩트 뷰에서만 보인다.
- 곡 선택 목록(`#songSelect`, `#compactSongSelect`)은 `src/app.js`의 `appendBuiltinSongGroups`로 내장곡을 레벨별 묶음(`Lv.1 입문` 등)으로 보여 준다([내장곡 출처](builtin-sources.md#레벨)).
- 악보 보기 선택 목록 `#scoreViewSelect`(`타브`·`둘 다`·`오선`·`카드`)와 `T` 키 전환은 `src/score-ui.js`의 `setScoreView` 하나가 맡는다([오선 미리보기](staff-notation.md#연습-화면)). 고른 뒤 포커스를 빼서 Space·T 단축키가 계속 동작한다.
- 폭이 모자라면 곡 선택(`#compactSongSelect`, `flex:1 1 auto`, 최소 90px)이 먼저 줄어든다. `test/test-browser-smoke.js`가 640·768·900·984·1092px에서 툴바 항목 겹침을 확인한다.
- 아래 두 칸(`.two-col`, 운지 가이드·코드표와 유튜브)의 열을 `minmax(0, …)`로 잡아 코드표(`#chordCards`)가 자기 칸 안에서만 가로 스크롤되게 한다. 코드 카드의 클릭 안내는 패널 제목(`이 곡의 코드 운지표 (누르면 화음 미리 듣기)`)에만 둔다.

## 단축키와 안내

- 단축키는 `src/app.js`의 keydown 핸들러 한 곳에서 처리하고 한글 자판 키도 같이 받는다. 입력 칸에 포커스가 있거나 `Ctrl`·`Alt`·`Meta` 조합이면 무시하고, 모달이 열려 있을 때는 `Esc`(열린 모달 닫기)만 받는다. 정지 상태에서 `←`·`→`는 앞·뒤 마디 첫 박으로 이동해 미리 들려주며(`stepMeasure`), `[`·`]`(또는 `-`·`=`)는 BPM을 ±2 조절하고, `R`(`ㄱ`)은 구간 반복(`#loopEnable`)을 켜고 끈다. 키를 바꾸면 `#helpModal` 안내도 같이 고친다.
- 헤더의 `#helpModalOpenBtn`과 `?` 키로 `#helpModal` 조작 안내(연습 제어, 오디오·음색, 악보 모드, 마우스 조작)를 연다.

## 메트로놈 클릭

`appState.clickMode`(`all`/`countin`/`off`, 기본 `all`)로 고르고 localStorage 앱 설정에 저장한다. `off`는 카운트인 마디도 건너뛴다. 구간 반복으로 구간 시작에 돌아갈 때도 처음 시작할 때처럼 카운트인 한 마디를 센 뒤 다시 치고(`off`면 세지 않고 바로 잇는다), 카운트인이 시작될 때 커서를 구간의 첫 소리 나는 칸으로 옮긴다(`scheduleLoopRestartCursor`). 자동 가속이 BPM을 올리면 카운트인도 새 BPM으로 센다.

- 콘솔 박자 칸은 두 줄이다. 첫 줄은 `박자`·`클릭 모드`, 둘째 줄은 `클릭음`·`연주음`이다. 구조화 악보(`curSong.type === 'structured'`)일 때 `박자`(`#beatsSelect`)는 마디 칸 수가 고정되어 있어 `disabled`로 잠그고 툴팁(`곡 악보에 고정된 박자 (악보 편집 화면에서 변경 가능)`)을 둔다. 이미지 악보(`curSong.type === 'image'`)에서만 선택할 수 있다.
- `클릭음`(`#volRange`)은 `appState.vol`(0~2, 화면 0~200%)이고 클릭 gain은 `vol` × 클릭별 진폭이다.
- `연주음`(`#guitarVolRange`)은 `appState.guitarVol`(0~1, 화면 0~100%, 기본 100%)이고 기타 소리 전부가 지나는 `guitarBus`의 gain으로 `updateGuitarVolume`이 짧은 램프로 반영한다. 클릭 버스(`clickBus`)는 영향받지 않는다. 악보 입력 화면도 같은 `audio.js`를 쓰므로 같이 적용된다.
- 저장된 값이 숫자가 아니거나 범위 밖이면 `src/app-state.js`가 기본값으로 되돌린다.

## 음이름 표기

- 표기 문자열은 `src/score.js`의 `formatBeatPitchLabel`·`getNoteDisplayName`이 SSOT이다. 기본은 CDE이고 헤더에 `도레미 표기 / CDE 표기` 전환 버튼을 둔다.
- 음이름에는 음높이만 쓴다. `!`·`~` 주법은 원문 메타데이터로 남고 재생에도 쓰이지만 음이름 뒤 기호나 주법 색으로 표시하지 않는다. `test/test-score.js`가 주법이 달라도 표기가 같은지, formatter가 악보 객체를 바꾸지 않는지 확인한다.

## 박자 카드

- 마디의 분할 수에 따라 마디 카드 최소 너비를 정하고, 음이름 글자 수에 따라 `b-ko-dense`·`b-ko-ultra` 클래스로 글자를 줄인다.
- 오른손 운지 라벨은 기호만 쓴다(`5줄 p + 1줄 a`, `i / m`). `active-beat`일 때 오른손 운지와 서브 표기의 대비·굵기를 올린다.

## 마디 폭

규칙은 `src/app.js`의 `renderStructuredMeasures`와 그 위의 `measureNeedWidth`·`measureBaseWidth`·`applyMeasureSpans`에 있고, 폭 상수는 `MEASURE_`로 시작한다.

- 마디마다 필요한 폭이 있다. TAB 보기(타브·둘 다·오선)는 `칸 수 × 그 마디의 최대 분할 수 × 분할 하나의 폭 + 여백`과 칸 수별 기본 폭 중 큰 값, 카드 보기는 `칸 수 × (그 마디의 최대 분할로 정한 칸 폭) + 여백`과 칸 수별 카드 기본 폭 중 큰 값이다.
- 기준 열 폭은 곡의 마디 필요 폭을 작은 순으로 놓고 `MEASURE_WIDTH_PERCENTILE` 자리(인덱스 `ceil(비율 × 마디 수) - 1`)의 값이다. 격자는 `repeat(auto-fill, minmax(min(기준폭px, 100%), 1fr))`이다. `min(…, 100%)` 때문에 기준 폭이 화면보다 넓어도 열이 화면을 넘지 않는다.
- 필요 폭이 기준 폭보다 큰 마디는 `grid-column: span k`(k = 필요 폭 / 기준 폭을 올림)로 열을 더 차지한다. k가 지금 격자의 열 수 이상이면 `grid-column: 1 / -1`(한 줄 전체)이다(열 수보다 큰 span은 보이지 않는 열을 만들어 가로로 넘치기 때문이다).
- 열 수는 `getComputedStyle(grid).gridTemplateColumns`의 열 목록을 센다(`gridColumnCount`, 값을 `#measuresGrid`의 `data-cols`에도 둔다). 그리는 때와 격자 폭이 바뀔 때(창 크기·콤팩트 뷰) 다시 센다. 크기가 바뀔 때는 이미 붙은 `span k`가 만든 암시 열을 세지 않도록 열을 세기 전에 모든 카드의 `style.gridColumn`을 지운다. 폭 관찰은 오선 층 다시 그리기와 같은 `ResizeObserver`(`watchGridResize`)가 하고, 열 걸침은 관찰 콜백 루프를 피하려고 `setTimeout`으로 다음 틱에 바꾼다.
- 어떤 곡·보기·폭에서도 `#structuredScoreWrap`·`#measuresGrid`·페이지가 가로로 넘치지 않는다(콤팩트 뷰 포함). 마디가 필요 폭보다 좁아지면 칸이 줄어든 폭에 맞춰 같이 줄고 오선 층도 마디 폭에 맞춰 다시 그린다.
- 필요 폭이 현재 격자 전체 폭(`grid.clientWidth`)에 비례한 임계치(`src/app.js`의 `MEASURE_DENSE_RATIO`)를 넘는 마디에는 `applyMeasureSpans`가 `.is-dense` 클래스를 붙여 TAB 프렛 알약(`.tab-fret-pill`)과 음이름 줄(`.tab-cell-en`)의 글자 크기·안쪽 여백을 줄인다. 브라우저 스모크의 `testMeasureWidth`가 여러 칸 수·분할의 곡을 보기와 폭별로 열어 넘침, span, `.is-dense`를 확인한다.
- 320px에서도 콘솔 그리드(`.stage-grid`)를 `minmax(0, …)`로 두고 컨트롤 항목에 `min-width: 0; max-width: 100%`를 주어 콘솔(`.stage-box`)과 페이지가 가로로 넘치지 않는다.

## TAB과 지판

- TAB 프렛 글자는 연습 화면과 악보 입력 화면이 같은 함수 `buildFretLabel`(`src/score-ui.js`)로 만든다. 프렛 숫자 오른쪽 위에 작은 왼손 운지, 오른쪽 아래에 작은 오른손 글자를 같은 가로 자리에 쌓는다(`1C4@2:i` → 1, 위 1, 아래 i). 원문에 없는 운지는 그리지 않는다.
- 원문에 적힌 아포얀도 `!`는 프렛 글자 색 `--near`(주황) 굵게 보여 준다. 확인 표시 색이 주법 색보다 이기고, 재생 중 활성 박 안에서는 알약 글자색을 따른다. 유지 칸의 흐린 알약(`tab-held-fret`)은 다시 치는 음이 아니라서 왼손 운지만 그리고 오른손과 주법 색은 뺀다.
- 슬라이드(`g`) 음은 TAB 프렛 앞에 방향을 붙인다(올라가면 `/7`, 내려가면 `\5`, `.fret-slide`). 판정이 틀어진 슬라이드는 `—`로 방향 없이 보인다.
- 롤(`~`) 화음은 연습 화면 TAB에서 화음 왼쪽에 세로 물결선(`.roll-mark`, `src/score-ui.js`의 `buildRollMark`)을 그린다. 그 화음의 가장 위 줄부터 가장 아래 줄까지 걸치고, 알약 가운데에서 왼쪽으로 띄워 둔다. 유지 칸의 흐린 알약에는 그리지 않는다.
- 지판 목표음은 개방현과 프렛 모두 같은 `target-note` 배지를 쓴다.
- TAB은 마지막 현 pill 그림자까지 보이게 하단 여백을 두되 격자·현 이름·배경선 정렬을 유지한다.
- 코드 지판(파란 점)의 개방현(`fret === 0`)은 프렛과 같은 `.fb-marker.chord-tone` 원형 마커로 `0`을 그린다. 연주음(초록) 마커와 겹치면 연주음이 보인다.
- 마디 메모(`.m-lyric`)는 머리 줄(`.m-head`)에 한 줄 말줄임으로 표시하고 `title`로 전체 글을 보여 준다. 마디 번호(`.m-num`)는 줄어들거나 줄바꿈하지 않게(`flex-shrink:0`, `white-space:nowrap`) 한다.
- 마디 코드 칩은 오선/타브/카드 패널 상단(`.measure-chords-bar`)의 박자별 슬롯에 놓인다. 코드를 누르면 해당 코드의 화음 미리듣기와 지판 하이라이트가 동작한다.
- 연습 화면 지판은 0~19프렛으로 그린다(`GuitarNotation.MAX_FRET`, CSS 변수 `--fret-count`). 머리 줄은 프렛 숫자와 표시 점(3·5·7·9·12·15·17·19)만 적고, 좁은 화면에서는 가로로 스크롤된다(`min-width:650px`).

## 빈칸

빈칸 `_` 칸([악보 문법](score-format.md#빈칸))은 연습 화면 TAB(`.beat-cell.slot-skip`)과 박 카드 모두 음·쉼 표시 없이 흐리게 빗금으로 그리고, 박 카드는 `빈칸` 글자(`.b-skip-label`)를 보인다. `.slot-skip`과 `.b-skip-label` 규칙은 `src/base.css`에 두어 악보 입력 화면(`.ti-cell.slot-skip`)과 같이 쓴다. 재생 커서는 빈칸에 머물지 않고 건너뛴다.

## 확인 표시

원문에 확인 표시 `?`가 있는 칸은 TAB과 박자 카드 모두 `.beat-cell.is-uncertain`(경고색 안쪽 테두리와 배경)으로 칠하고 툴팁 끝에 `확인 필요(?)`를 붙인다. 악보 툴바의 `#uncertainBadge`는 확인 표시가 있는 칸 수를 `확인 N곳`으로 보여 주고, 0이거나 이미지 악보면 숨긴다. 개수는 `src/score.js`의 `countUncertainBeats`만 센다. CSS 규칙은 `.beat-cell.tab-cell`과 `.beat-cell.arp-group-start`보다 뒤에 두고 `:not(.active-beat)`로 특이도를 올린다(`arp-group-start` 칸은 구분 그림자와 경고 테두리를 한 `box-shadow`에 합친다). 재생 중 활성 칸은 활성 표시가 이긴다. 문법은 [악보 문법](score-format.md#확인-표시)을 본다.
