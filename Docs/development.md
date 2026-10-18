# 개발 안내

Guitar Studio는 번들러와 트랜스파일러가 없는 정적 Vanilla JS 앱이야. 저장소 루트에서 `index.html`을 제공하면 실행돼. 모듈은 classic script로 로드되며 HTML의 순서를 유지해야 해.

## 모듈 구성

| 파일 | 역할 |
|---|---|
| `src/storage.js` | DOM과 분리된 IndexedDB 저장소 |
| `src/notation.js` | 입력 줄 토큰화, 마디 메모·가사·코드 머리표, 직렬화와 구조 검증 |
| `src/rhythm.js` | 칸 길이와 쉼·유지 체인 분석 |
| `src/parser.js` | `parseScore`, 음·화음·운지 파싱, 카포와 실음 계산 |
| `src/score-drafts.js` | 곡별 메모리 임시 초안과 검증된 마디 편집 이력 |
| `src/score.js` | 화면의 박자·음가 표시 |
| `src/audio.js` | KS/classic 합성기와 재생음 수명 관리 |
| `src/guide.js` | 구조화 악보의 재생 이벤트 생성·예약 |
| `src/image-analysis.js` | 이미지의 마디 경계 후보 분석 |
| `src/fretboard.js` | 지판 미리듣기와 코드 카드 표시 |
| `src/score-ui.js` | 악보 보기 전환과 `formatSongToSheetTsv` 공통 함수 |
| `src/sheets.js` | Google Sheets 읽기 연동 |
| `src/score-editor.js` | 임시 악보 생성·편집 UI, 마디 작업과 초안 작업 흐름 |
| `src/app.js` | 앱 상태, UI 부팅과 기능 연결 |

`index.html`의 실제 순서는 `storage.js`, `notation.js`, `rhythm.js`, `parser.js`, `score-drafts.js`, `score.js`, `audio.js`, `guide.js`, `image-analysis.js`, `fretboard.js`, `score-ui.js`, `sheets.js`, `score-editor.js`, `app.js`야. 악보 초안은 원본 곡과 별도로 메모리에 보관해. 내장곡과 Google Sheets 원본은 수정하지 않고, 임시 악보는 새로고침하면 사라져. 텍스트 악보는 IndexedDB, localStorage, 백업에 저장하지 않아. 이미지·PDF 악보와 앱 설정의 영속화 흐름은 유지해. `app.js` 부팅 때 앱 모듈과 상태가 준비된 후 `initFretboard()`, `initScoreUi()`, `initSheetSync()`와 편집 UI가 이벤트를 등록해. 로컬 스크립트는 같은 v 쿼리 버전을 사용해. DOM 구조나 스크립트 구성이 바뀌면 버전을 함께 갱신해 캐시된 이전 코드와 섞이지 않게 해.

## 데이터 흐름과 유지보수 계약

`parseScore`와 `GuitarNotation.validateScore`가 텍스트 악보의 파싱·검증 기준이야. `GuitarRhythm.annotate`는 파싱된 마디에 part 공통 칸 길이, 시작 위치와 유지 체인을 계산하고 `resolveHold`/`getSoundingNotes`는 연결된 원음 또는 화음 전체와 남은 공통 길이를 돌려줘. `guide.js`는 이 결과로 part의 `durationUnits`에 따른 재생 이벤트를 만들고 `audio.js`에 예약해. 오디오 수명은 악보 길이와 분리돼: 구조화 가이드는 기존 KS 버퍼 감쇠 또는 classic 공통 자연 감쇠 프로파일을 사용하고, 재탄현·전체 쉼·정지·곡 교체·가이드 끄기·곡/loop 끝에서 직접음을 정리해. 이 관계의 SSOT는 `rhythm.js`의 음가/유지 계산, `guide.js`의 이벤트와 복원 경로, `audio.js`의 `naturalDecay` 및 강제 정리야. 관련 회귀 근거는 `test/test-rhythm.js`, `test/test-guide.js`, `test/test-audio.js`에 둬. 사용 문법은 [악보 입력 형식](score-format.md), 세부 오디오 계약은 [리듬·오디오 계약](beginner-rhythm.md)을 따라.

`tok`와 원본 입력을 기준으로 파생 필드를 다시 계산해. `score-drafts.js`는 원본 악보의 편집본과 새 임시 악보를 곡별로 메모리에 유지하고, 편집은 전체 악보 검증이 성공한 경우에만 적용해. 한 번의 마디 편집은 한 단계 실행 취소 대상으로 관리하고, 초안 초기화는 해당 곡의 원본 복사본으로 되돌려. 편집 중에는 곡 전환·재생·복사와 다른 편집을 막아 미적용 내용을 잃지 않게 해. IndexedDB에는 이미지·PDF 악보가, localStorage에는 앱 설정과 곡별 최근 연습 BPM·구간 이어가기 상태가 저장돼. 과거에 저장된 구조화 악보 DB 레코드는 자동 삭제하지 않고 앱에서 노출하지 않아. 백업 포맷은 버전 1의 `customSongs` 키를 유지하며, 이 키는 이미지 전용 데이터를 담아. Google Sheets 연동은 읽기 전용이야. TSV 복사는 초안의 현재 악보를 5열 형식으로 내보내며 시트에 직접 쓰지 않아. `soundingMidi`는 `src/parser.js`의 공통 카포 실음 변환 함수야.

마디 메모와 가사는 같은 `lyric` 필드로 파싱하고 JSON 문자열로 직렬화해.

완료된 작업은 모듈 분리와 공통 파서·카포 경로, 단위·스모크 테스트 추가, 초보 리듬 입력과 재생 계약 정리야. alphaTab 재생은 `codex/alphatab-player` 실험 브랜치에 남아 있고 main 앱은 기존 엔진을 사용해.

2026-10-19 결정: 텍스트 악보를 직접 편집할 때 원본과 임시 작업을 분리해. 내장곡과 시트 악보는 원본으로 남고, 새 악보와 수정 초안은 탭 메모리에서만 유지돼 새로고침 때 사라져. 이미지 악보 영속화 정책은 바꾸지 않아.

2026-10-19 결정: 음별 길이 접미사는 악보 음가와 자연 여운을 혼동시키고 자동 생성 입력을 복잡하게 해 제거했어. 기존 part 공통 길이와 자연 감쇠 경로를 사용하며, 독립 성부 scheduler나 별도 음가 입력 문법은 추가하지 않았어.

## 검증

프로젝트에는 브라우저 밖에서 실행하는 테스트와 브라우저 스모크 테스트가 있어. 각 테스트는 해당 모듈, 저장, 시트 응답, 이미지 분석, 앱 부팅, 실제 DOM 흐름을 확인해.

```powershell
node test/test-score-drafts.js
node test/test-score.js
node test/test-parser.js
node test/test-builtins.js
node test/test-notation.js
node test/test-rhythm.js
node test/test-image-conversion.js
node test/test-audio.js
node test/test-guide.js
node test/test-storage.js
node test/test-sheets.js
node test/test-app-smoke.js
node test/test-browser-smoke.js
Get-ChildItem src\*.js, test\*.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

2026-10-19 결정: 음이름 표시는 `src/score.js`의 공통 formatter에서 음높이만 출력해. `!`·`~` 원문 주법 메타데이터와 재생 동작은 유지하지만, 음이름 뒤 기호나 주법 색으로 표시하면 시각 요소가 과밀해져 제거했어. `test/test-score.js`는 주법이 달라도 표기가 plain note name으로 같은지, formatter가 악보 객체를 바꾸지 않는지 확인해.

2026-10-19 표시 계약: 지판 목표음은 개방현과 프렛 모두 같은 `target-note` 배지를 쓰고, TAB은 마지막 현 pill의 그림자까지 보이도록 하단 여백을 확보하면서 격자·현 이름·배경선 정렬을 유지해. 이 조정은 개방현 label의 색상 치환 불일치와 6현 하단 잘림을 막기 위한 거야.

브라우저 스모크는 Chrome 또는 Edge를 자동 탐색하고 `CHROME_BIN`으로 실행 파일을 지정할 수 있어. 임시 HTTP 서버와 임시 브라우저 프로필을 사용하며 Web Audio API 경로를 실제 실행해. 이 테스트는 Node의 내장 `fetch`와 `WebSocket` 전역이 있는 환경이 필요해. 실행 환경은 `node -p "process.version + ' fetch=' + typeof fetch + ' WebSocket=' + typeof WebSocket"`로 확인할 수 있어. 자동화 검사는 실제 기기에서의 오디오 청취 품질을 확인하지 않아. 스크린샷 검증은 `test-artifacts/`에 새 파일을 만들 수 있으므로 기존 개인 자료를 보존해.

작업 범위와 필수 검증은 [AGENTS.md](../AGENTS.md)에 있어.
