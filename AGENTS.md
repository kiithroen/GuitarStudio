# Guitar Studio 에이전트 작업 지침

## 아키텍처

- 무빌드 정적 웹 앱이다. 번들러나 백엔드를 도입하지 않는다. 정적 HTTP/HTTPS 환경에서 실행한다.
- `Docs/alphatab-player.md`가 TAB 연습 플레이어의 확정 사양이다.
- alphaTab 1.8.4의 parser와 악보 모델을 단일 기준으로 사용한다. 앱의 파싱·파일 입력·검증은 `src/tab-engine.js`를 통한다.
- 재생·커서·메트로놈·반복은 alphaTab의 시간축을 사용한다. 별도 scheduler나 마디 칸 수로 음가를 추정하는 로직을 만들지 않는다.
- 역할별 모듈을 유지하고 한 파일에 렌더링·저장·파싱을 몰아넣지 않는다.

## 악보와 데이터

- 신규 텍스트는 alphaTex, 파일 입력은 Guitar Pro/MusicXML이다. 구형 독자 문법은 신규 입력에서 받지 않는다.
- notationVersion 3 레코드는 alphaTex 문자열 또는 원본 binary bytes를 보존한다. 편집하지 않은 입력 파일은 그대로 다운로드할 수 있어야 한다.
- 구형 structured 레코드의 일회성 변환은 `legacy-migration.js`에 격리한다. 원본 snapshot과 불확실성 안내를 남기고 변환 불가 데이터를 삭제하지 않는다.
- 원문에 없는 손가락·현·롤·주법을 추가하지 않는다. 카포·조율·실음·현 번호는 alphaTab 모델 기준으로 일관되게 처리한다.
- 시트는 제목/설명/alphaTex 세 열이다. TSV 인용과 개행을 보존하고 전체 행 검증 전 기존 목록을 교체하지 않는다.
- `Temp/`는 사용자 원본 파일이다. 변경·삭제·커밋하지 않는다.

## 의존성과 검증

- `vendor/alphatab/`의 고정 자산과 라이선스를 함께 배포한다. 런타임 CDN 및 `latest` URL에 의존하지 않는다. vendored 코드를 직접 수정하지 않는다.
- 구문 검사: `Get-ChildItem src\*.js, test\*.js | ForEach-Object { node --check $_.FullName }`.
- 실제 alphaTab parser: `node test/test-parser.js`.
- 데이터/저장/시트: `node test/test-migration.js`, `node test/test-storage.js`, `node test/test-sheets.js`.
- 프롬프트와 VM 연결: `node test/test-image-conversion.js`, `node test/test-app-smoke.js`.
- 실제 Headless Chrome: `node test/test-browser-smoke.js`. 로컬 자산의 렌더링·음원 준비·커서 진행·음소거·반복·편집·새로고침을 검증한다. 실제 parser/renderer/player를 stub으로 바꿔 통과시키지 않는다.
- 공용 브라우저 검증은 한 에이전트가 순차 실행한다. 실행하지 않은 검사나 실제 청취를 통과했다고 보고하지 않는다.

## 완료와 Git

- 메인은 diff와 검증 증거를 직접 검수한 뒤 현재 작업만 커밋하고 현재 브랜치에 일반 push한다. 사용자의 명시적인 보류 요청이 없으면 재확인을 기다리지 않는다.
- 서브에이전트는 커밋·푸시하지 않는다. 지정 범위 밖의 판단이나 사양 충돌은 메인에게 보고한다.
- 무관한 변경을 포함하거나 강제 push하지 않는다. 차단된 검증·원격 연결은 미완료로 명시한다.
- 코드 주석·커밋 메시지·문서에 이모지를 쓰지 않는다.
