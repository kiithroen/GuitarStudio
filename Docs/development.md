# 개발 안내

Guitar Studio는 번들러와 트랜스파일러가 없는 정적 Vanilla JS 앱이야. 저장소 루트에서 `index.html`을 제공하면 실행돼. 모듈은 classic script로 로드되며 HTML의 순서를 유지해야 해.

## 모듈 구성

| 파일 | 역할 |
|---|---|
| `src/storage.js` | DOM과 분리된 IndexedDB 저장소 |
| `src/notation.js` | 입력 줄 토큰화, 마디 메모·가사·코드 머리표, 직렬화와 구조 검증 |
| `src/rhythm.js` | 칸 길이와 쉼·유지 체인 분석 |
| `src/parser.js` | `parseScore`, 음·화음·운지 파싱, 카포와 실음 계산 |
| `src/score.js` | 화면의 박자·음가 표시 |
| `src/audio.js` | KS/classic 합성기와 재생음 수명 관리 |
| `src/guide.js` | 구조화 악보의 재생 이벤트 생성·예약 |
| `src/ai-prompt.js` | 외부 변환용 프롬프트 작성 |
| `src/image-analysis.js` | 이미지의 마디 경계 후보 분석 |
| `src/fretboard.js` | 지판과 코드 카드 표시·입력 |
| `src/editor.js` | 악보 편집 UI와 TSV 복사 |
| `src/sheets.js` | Google Sheets 읽기 연동 |
| `src/app.js` | 앱 상태, UI 부팅과 기능 연결 |

`index.html`의 실제 순서는 `storage.js`, `notation.js`, `rhythm.js`, `parser.js`, `score.js`, `audio.js`, `guide.js`, `ai-prompt.js`, `image-analysis.js`, `fretboard.js`, `editor.js`, `sheets.js`, `app.js`야. `app.js` 부팅 때 앱 모듈과 상태가 준비된 후 `initFretboard()`, `initEditor()`, `initSheetSync()`가 UI 이벤트를 등록해.

## 데이터 흐름과 유지보수 계약

`parseScore`와 `GuitarNotation.validateScore`가 텍스트 악보의 파싱·검증 기준이야. `GuitarRhythm.annotate`는 파싱된 마디에 칸 길이, 시작 위치와 유지 체인을 계산하고 `resolveHold`는 유지의 원음 참조를 돌려줘. `guide.js`는 이 결과로 재생 이벤트를 만들고 `audio.js`에 예약해. 사용 문법은 [악보 입력 형식](score-format.md), 세부 오디오 계약은 [리듬·오디오 계약](beginner-rhythm.md)을 따라.

`tok`와 원본 입력을 기준으로 파생 필드를 다시 계산해. IndexedDB에는 개인 악보가, localStorage에는 앱 설정과 곡별 최근 연습 BPM·구간 이어가기 상태가 저장돼. Google Sheets 연동은 읽기 전용이야. `soundingMidi`는 `src/parser.js`의 공통 카포 실음 변환 함수야.

마디 메모와 가사는 같은 `lyric` 필드로 파싱하고 JSON 문자열로 직렬화해.

완료된 작업은 모듈 분리와 공통 파서·카포 경로, 단위·스모크 테스트 추가, 초보 리듬 입력과 재생 계약 정리야. alphaTab 재생은 `codex/alphatab-player` 실험 브랜치에 남아 있고 main 앱은 기존 엔진을 사용해.

## 검증

프로젝트에는 브라우저 밖에서 실행하는 테스트와 브라우저 스모크 테스트가 있어. 각 테스트는 해당 모듈, 저장, 시트 응답, 이미지 분석, 앱 부팅, 실제 DOM 흐름을 확인해.

```powershell
node test/test-parser.js
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

브라우저 스모크는 Chrome 또는 Edge를 자동 탐색하고 `CHROME_BIN`으로 실행 파일을 지정할 수 있어. 임시 HTTP 서버와 임시 브라우저 프로필을 사용하며 Web Audio API 경로를 실제 실행해. 이 테스트는 Node의 내장 `fetch`와 `WebSocket` 전역이 있는 환경이 필요해. 실행 환경은 `node -p "process.version + ' fetch=' + typeof fetch + ' WebSocket=' + typeof WebSocket"`로 확인할 수 있어. 자동화 검사는 실제 기기에서의 오디오 청취 품질을 확인하지 않아. 스크린샷 검증은 `test-artifacts/`에 새 파일을 만들 수 있으므로 기존 개인 자료를 보존해.

작업 범위와 필수 검증은 [AGENTS.md](../AGENTS.md)에 있어.
