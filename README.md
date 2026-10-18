# Guitar Studio

TAB 악보와 움직이는 재생 커서를 보며 기타를 연습하는 정적 웹 앱이다. alphaTab 1.8.4가 악보 해석, TAB 렌더링과 재생을 담당한다. 빌드 도구나 별도 백엔드는 필요 없다.

## 실행

프로젝트 폴더를 정적 HTTP 서버로 제공하고 브라우저에서 연다. file://로 직접 열면 worker, 음원과 저장소가 정상 동작하지 않을 수 있다.

```powershell
python -m http.server 8000
```

브라우저에서 http://localhost:8000을 연다. 라이브러리, 폰트와 SoundFont는 vendor/alphatab/에 포함되어 있다. 구글 시트 동기화를 제외한 악보 렌더링과 재생은 런타임 CDN을 사용하지 않는다.

## 연습 기능

- 음가, 쉼표, 박자표, 붙임줄, 여러 성부와 기타 주법을 포함한 TAB 표시.
- 재생 커서, 현재 마디 표시, 자동 스크롤과 악보 클릭 이동.
- 재생·일시정지·정지, 25~200% 상대 속도와 마디 구간 반복.
- 독립적인 가이드음과 메트로놈, 음량 조절.
- 현재 음의 현·프렛을 보여 주는 간단한 지판. 원본에 명시된 손가락만 표시한다.
- alphaTex 편집·미리보기, Guitar Pro/MusicXML 가져오기, 원본 다운로드와 Guitar Pro 내보내기.
- 브라우저 IndexedDB 개인 악보 저장과 구글 시트 동기화.

박자 카드, 마이크 채점, 튜너, 자동 베이스 반주, 손가락 추정은 제공하지 않는다. 사진 입력은 미리보기와 외부 AI 전사 프롬프트 복사를 제공한다. 사진을 앱 안에서 자동 인식하는 기능은 없다.

## 악보 입력

텍스트 입력은 alphaTex를 사용한다. 음표는 프렛.현, 현 번호는 가장 높은 현이 1번이다. :4는 뒤따르는 음표의 기본 음가를 4분음표로 지정한다. |는 마디 구분이다.

```text
\title "카포 5 연습"
\tempo 64
\ts (3 4)
\capo 5
:4 3.5 (0.3 1.2) 0.1 |
3.5 (0.3 1.2) 0.1
```

복잡한 악보는 Guitar Pro 또는 MusicXML 파일로 가져오는 편이 편하다. 가져온 파일은 원본 바이트로 저장한다. 제목·설명만 바꾸면 원본 형식을 유지하고, 편집기에 표시된 alphaTex 본문을 수정해 저장하면 alphaTex 악보가 되며 원본 파일은 sourceOriginal에 남는다. alphaTab이 지원하는 형식과 표현 범위 안에서 렌더링하며, 형식 간 변환 시 모든 프로그램 고유 정보가 보존되는 것은 아니다.

새 문법은 기존 음이름·슬래시 문법을 해석하지 않는다. 이전 구조화 악보는 저장된 음·현·프렛으로 한 번 변환하고 legacyOriginal에 원본을 보관한다. 구형 빈 칸의 유지음/쉼 해석을 포함한 변환 안내를 확인해야 한다. 자동 변환할 수 없는 이미지 악보도 저장소에서 삭제하지 않는다.

문법은 [alphaTab alphaTex 문서](https://alphatab.net/docs/alphatex/introduction/)를 참고할 수 있다. 앱에 고정된 버전은 1.8.4이므로 최신 문서에만 있는 문법은 지원하지 않을 수 있다.

## 구글 시트

시트는 다음 세 열을 사용한다. 첫 행은 제목, 설명, alphaTex로 둔다.

| A: 제목 | B: 설명 | C: alphaTex |
| --- | --- | --- |
| 카포 5 연습 | 두 마디 연습 | 위 예시 전체를 한 셀에 입력 |

시트의 공유 권한을 링크로 읽을 수 있게 설정한 뒤 앱에 시트 URL을 넣고 동기화한다. 동기화는 읽기 전용이며 시트에 쓰지 않는다. 앱의 TSV 복사 결과를 A열의 빈 셀에 붙여 넣으면 세 열로 나뉘고 alphaTex 안의 줄바꿈·탭·따옴표를 보존한다. binary 악보는 alphaTex로 편집·저장한 후 TSV로 복사할 수 있다. 구형 5열 시트는 지원하지 않는다.

## 파일 구조

| 경로 | 역할 |
| --- | --- |
| index.html | 화면, 스타일과 스크립트 순서 |
| src/tab-engine.js | 실제 alphaTab parser, renderer, player를 연결하는 공통 API |
| src/library.js, src/storage.js | 내장곡과 IndexedDB 개인 악보 |
| src/legacy-migration.js | 기존 구조화 데이터의 일회성 변환 |
| src/sheets.js | 세 열 시트 읽기와 TSV 직렬화 |
| src/editor.js | alphaTex 편집, 파일 가져오기와 다운로드 |
| src/fretboard.js | 현재 음의 현·프렛·명시 운지 표시 |
| src/ai-prompt.js | 외부 AI 사진 전사 지침 |
| src/app.js | 곡 선택, 상태와 플레이어 UI 연결 |
| songs.json | 변환된 내장곡과 연습 예제 |
| vendor/alphatab/ | 고정 버전 라이브러리, worker, 폰트, 음원과 라이선스 |
| Docs/alphatab-player.md | 전환 사양과 모듈 계약 |

Temp/는 개인 원본 자료이며 배포와 커밋에서 제외한다. 구조화 JSON을 수동 변환하려면 아래 명령을 사용할 수 있다. 이 도구는 구형 텍스트 문법을 파싱하지 않는다.

```powershell
node tools/convert-builtin-songs.js 입력.json 출력.json
```

## 검증

프로젝트 루트에서 실행한다. 패키지 설치나 빌드 단계는 없다. 브라우저 검증은 설치된 Chrome/Edge와 Node.js의 내장 WebSocket을 사용한다.

```powershell
Get-ChildItem src\*.js, test\*.js, tools\*.js | ForEach-Object { node --check $_.FullName }
node test/test-parser.js
node test/test-migration.js
node test/test-storage.js
node test/test-sheets.js
node test/test-image-conversion.js
node test/test-app-smoke.js
node test/test-browser-smoke.js
```

단위 검증은 실제 alphaTab의 복합 리듬·성부·붙임줄·카포, GP 왕복과 MusicXML 가져오기, 데이터 변환과 저장 오류를 확인한다. 브라우저 검증은 실제 로컬 자산 로드, TAB 렌더링과 재생 시간, 편집·저장·파일 가져오기를 확인한다. Headless 테스트만으로 실제 스피커의 음질이나 연주와의 청각적 일치를 판단하지 않는다.

alphaTab은 MPL-2.0, Bravura 폰트는 SIL OFL이며 SoundFont는 함께 제공된 라이선스를 따른다. 배포 파일과 출처는 vendor/alphatab/README.md에 기록한다.
