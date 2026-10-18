# alphaTab TAB 연습 플레이어 전환 사양

## 목표

박자 카드와 채점을 제거하고, TAB 악보와 이동 커서를 보며 연습하는 정적 웹 앱으로 전환한다. alphaTab 1.8.4의 악보 모델과 재생 시간을 단일 기준으로 사용한다. 기존 독자 악보 문법을 새 입력 경로에서 지원하지 않는다. 기존 정적 앱이며 빌드나 백엔드 서버를 추가하지 않는다.

## 사용자 기능

- TAB만 표시하되 음가 기둥, 쉼표, 박자표, 붙임줄, 주법을 표시한다.
- 부드러운 재생 커서, 현재 마디 표시, 자동 스크롤, 악보 클릭 위치 이동을 제공한다.
- 재생/일시정지/정지, 가이드음 켜기/끄기, 메트로놈 켜기/끄기, 음량, 25~200% 속도, 마디 번호에 의한 구간 반복을 제공한다.
- 가이드음을 꺼도 재생 시간과 커서는 계속 움직인다. 메트로놈은 독립적으로 켜고 끌 수 있다.
- alphaTex 입력/편집/미리보기/저장, Guitar Pro 및 MusicXML 파일 가져오기, 원본 또는 편집 악보 다운로드를 제공한다.
- 개인 악보는 기존 IndexedDB songs 저장소에 저장한다. 새 레코드의 notationVersion은 3이다.
- 구글 시트는 제목, 설명, alphaTex의 세 열을 사용한다. 복사 TSV는 인용과 개행을 보존한다.
- 사진 미리보기와 외부 AI 질문용 alphaTex 변환 프롬프트를 제공한다. 이미지에서 음표를 자동 인식했다고 주장하지 않는다.
- 현재 탄현 위치에 대한 간단한 지판 안내는 유지한다. 원본에 없는 손가락과 주법을 추정하지 않는다.
- 마이크 요청, 입력 지연 보정, 채점, 점수 기록, 튜너, 박자 카드, 독자 그리드 편집기, 구형 합성음 UI는 새 앱에서 제거한다.

새 악보의 정확한 기본 예시는 다음이다. 프렛.현 순서이며 5현 3프렛은 3.5이다. alphaTex 1.8의 다중 메타데이터 인자는 괄호로 감싼다.

```text
\title "새 연습곡"
\tempo 64
\ts (3 4)
\capo 5
:4 3.5 (0.3 1.2) 0.1 |
3.5 (0.3 1.2) 0.1
```

## 레코드 계약

공통 필드: id, title, badge, format ('alphatex' 또는 'binary'), notationVersion:3, builtin:boolean, fromSheet:boolean.

- alphatex: alphaTex 문자열을 원본으로 사용한다.
- binary: bytes (ArrayBuffer 또는 Uint8Array), fileName을 원본으로 보존한다. 파일 내용은 서버에 업로드하지 않는다.
- tempo는 악보 내부 값을 따른다. 플레이어 속도는 상대 배율이다. 파일의 템포 변화를 전역 BPM으로 덮어쓰지 않는다.
- 가져온 파일의 텍스트 편집은 exporter가 생성한 alphaTex로 미리보기 후 저장한다. 본문이 같으면 제목·설명 수정 후에도 원본 bytes/fileName으로 binary 저장한다. 본문이 변경되면 alphatex로 저장하고 sourceOriginal의 bytes/fileName에 원본을 보존한다. 저장 전에는 원본 binary 레코드를 바꾸지 않는다.
- 내장 악보를 편집하면 개인 복사본으로 저장한다. 미리보기·검증 실패와 IndexedDB 쓰기 실패는 현재 저장곡을 덮어쓰지 않는다.
- 구형 structured 개인 악보는 저장된 음/현/프렛 구조로 한 번 변환한다. 원본 snapshot은 legacyOriginal에 보존하고 변환 불확실성(특히 쉼/유지)을 알린다. 이미지 전용 등 변환 불가 레코드는 삭제하지 않고 안내한다. 구형 문법을 입력하는 런타임 파서는 유지하지 않는다.

## 모듈 계약

### src/tab-engine.js (global TabEngine)

- parseAlphaTex(text) -> alphaTab Score, importBytes(bytes) -> Score, toAlphaTex(score) -> string, exportGp(score) -> Uint8Array.
- getBeatNotes(beat) -> [{str,fret,midi,lh,rh}]. str은 1이 가장 높은 현인 UI 번호, midi는 카포·조율을 반영한 실음이다. lh는 명시 1~4 또는 엄지 T 또는 null, rh는 명시 p/i/m/a/c 또는 null이다. 원본에 없는 운지를 보완하지 않는다. alphaTex의 lf/rf 인수는 1~5, alphaTab model.Fingers enum은 0~4이므로 구분한다.
- create(element, callbacks) -> controller. controller.api로 실제 alphaTab API에 접근 가능.
- controller: loadSong(song) -> Promise<Score>, getScore(), play(), pause(), stop(), setSpeed(percent), setVolume(0..1), setGuideSound(boolean), setMetronome(boolean), setLoop(startBar1based,endBarInclusive,enabled), seekBar(bar1based), destroy().
- callbacks: onScore(score), onReady(boolean), onState(playing), onPosition({currentTime,endTime,currentTick,barIndex,beatIndex}), onBeat(beat), onError(error). 인덱스는 0부터 시작한다.
- 빠른 악보 변경 시 이전 완료가 새 악보를 덮지 않는다. loadSong은 실제 렌더 완료(postRenderFinished)와 재생 준비(playerReady)를 모두 기다린 후 Score를 반환한다. 실제 api.load 호출은 직렬화하고 실행 전 중간 요청은 건너뛰어 null을 반환한다. 이전 worker의 렌더 결과가 다음 Score에 적용되지 않도록 한다.
- 최신 요청이 대기 중이면 이전 곡의 준비·위치·재생 콜백을 UI에 전달하지 않는다. 준비 전 play는 false이고 자동 지연 재생하지 않는다. 오류나 30초 준비 제한 시간 후에도 다음 요청은 처리할 수 있어야 한다. destroy 시 대기와 이벤트를 정리한다.
- 잘못된 반복 범위는 오류. MIDI 준비 전 설정은 기억했다가 적용한다.
- 루프는 시작 마디의 첫 재생 tick부터 끝 마디의 마지막 재생 구간 끝 tick까지다. 전체 곡 반복은 라이브러리 반복 기호를 보존한다.
- JS, worker, 폰트, SoundFont는 vendor/alphatab/의 고정 자산을 사용한다.

### src/library.js (global GuitarLibrary)

- loadAll() -> Promise<{songs,warnings}>: songs.json 내장곡과 IndexedDB 개인곡을 불러오고 구형 structured 레코드를 한 번 변환한다. 실패 원인을 숨기지 않는다.
- save(song) -> Promise<song>: 새 원본을 실제 TabEngine parser로 검증한 후 저장한다. 기존 id가 있으면 개인곡을 갱신한다.
- remove(id) -> Promise<void>: 개인곡만 삭제한다.
- normalizeSong(record) -> 정규화된 새 레코드. binary bytes를 JSON 문자열로 바꾸지 않는다.
- 내부 데이터 목록을 UI가 직접 변경할 필요는 없다. 저장/삭제 후 UI에서 loadAll로 갱신할 수 있다.

### src/legacy-migration.js (global LegacyMigration)

- convertSong(record, TabEngine) -> notationVersion3 레코드 또는 변환 불가 오류.
- 구형 텍스트를 새 입력으로 받지 않고 저장된 measures[].beats[]의 음·현·프렛만 변환한다. 명시 손가락은 raw tok의 숫자만 읽고 자동 lh/rh 값은 무시한다.
- 빈 칸은 구형 의미에 따라 앞 음을 연장하되 시작 공백은 쉼이다. 균등 분할은 유지한다. 임의의 롤·오른손 운지·주법을 만들지 않는다.
- 변환 결과는 실제 alphaTab parser로 검증한다. 음높이, 현, 프렛, 마디 길이를 대조한다. 원본 snapshot과 확인 안내를 보존한다.
- 구형 왼손 1~4는 alphaTex lf2~5로 변환한다. 명시 0과 프렛0의 개방현 의미는 프렛0으로 보존한다. 손가락0인데 프렛이 양수인 모순은 경고한다.

### src/sheets.js (global GuitarSheets)

- extractSheetIdAndGid(url), fetchSongs(url) -> Promise<Song[]>, toTsv(song) -> string.
- 새 시트 열은 제목, 설명, alphaTex다. 헤더 행은 건너뛴다. 한 셀의 alphaTex 개행과 따옴표를 보존한다.
- 기존 Google Visualization JSONP 방식, 응답 제한 시간, 완료/실패 cleanup을 유지한다. 잘못된 행은 행 번호와 오류로 보고하고 부분 목록으로 교체하지 않는다.
- 구형 5열 독자 문법 입력은 오류로 안내하며 해석하지 않는다. binary 곡 TSV 복사는 텍스트로 편집/저장한 다음 가능하다.

### src/app.js / src/editor.js / src/fretboard.js

- app.js는 곡 선택, 앱 상태, 플레이어 컨트롤과 모듈 연결을 담당한다. 별도 오디오 scheduler를 유지하지 않는다.
- editor.js는 alphaTex 텍스트와 파일 입력, 실제 parser 미리보기/검증, 제목·설명과 저장을 담당한다.
- fretboard.js는 별도 추론 없이 alphaTab beat.notes의 실제 현·프렛·명시 운지만 표시한다. 여러 성부/반복/카포의 내부 번호 체계는 라이브러리 실제 값으로 확인한다.
- 화면에 파서 내부 구조나 라이브러리 설정값을 과도하게 노출하지 않는다. 입력 도움말에는 사용자에게 필요한 alphaTex 예시를 제공한다.

## 검증

- 모든 활성 src/test JS 구문 검사. vendored minified JS를 직접 수정하지 않는다.
- test/test-parser.js: 실제 alphaTab parser의 성부/길이/쉼/붙임줄/잇단/카포/고음역/오류, GP 왕복, MusicXML 가져오기.
- 데이터/시트/저장 단위 검사: 내장곡 전체 파싱, 구형 구조 변환과 원본 보존, TSV 개행/인용, 저장 실패와 잘못된 시트의 원자적 처리.
- test/test-app-smoke.js: UI 연결 VM 스모크.
- test/test-browser-smoke.js: 실제 Headless Chrome, 로컬 vendor 자산만으로 TAB SVG/폰트/음원 준비, 커서의 시간 진행, 가이드 OFF 메트로놈 ON 재생, 속도, 반복, seek, 빠른 곡 교체, 편집/저장/재열기/새로고침, GP/MusicXML 입력, 마이크 요청 0, 콘솔 오류 0.
- 실제 브라우저 검증은 공용 상태이므로 한 에이전트가 순차 실행한다. 테스트를 통과시키기 위해 실제 parser/renderer/player를 가짜로 대체하지 않는다.

## 작업 경계

Temp/는 사용자 원본이며 변경·삭제·커밋하지 않는다. main은 보존하고 codex/alphatab-player에만 커밋·일반 push한다. 구형 파일 삭제는 새 앱의 참조와 대체 검증을 확인한 뒤 별도 정리한다.
