# Guitar Studio 에이전트 지침

세션마다 통째로 읽히는 파일이라 규칙과 함정만 둔다. 내용과 결정은 문서에 있다: [사용](Docs/usage.md) · [악보 문법](Docs/score-format.md) · [모듈·저장·검증](Docs/development.md) · [리듬·오디오](Docs/beginner-rhythm.md) · [화면·조작](Docs/ui.md) · [악보 입력](Docs/tab-input.md) · [오선 미리보기](Docs/staff-notation.md) · [오선 입력](Docs/staff-input.md) · [내장곡 출처](Docs/builtin-sources.md) · [alphaTab 보기·변환](Docs/alphatab.md). 일하기 전에 해당 문서만 읽는다.

## 문서
- 문서는 지금 상태(스펙)만 최신으로 간결하게 갱신한다. 날짜(`YYYY-MM-DD`)가 달린 결정 기록·히스토리는 나에게 묻지 않고 임의로 추가하지 않는다.
- 같은 내용을 여러 문서에 복사하지 않고 링크한다. 이 파일에는 결정 내용을 적지 않는다.
- 튜닝 값(gain·cutoff·threshold 같은 상수)은 문서에 옮겨 적지 않고 상수·함수 이름만 적는다.

## 구조
- 무빌드 정적 앱(Vanilla JS classic script, Web Audio)이다. 번들러·트랜스파일러·빌드 단계를 넣지 않는다.
- 파싱·음악 이론·오디오 합성은 공통 함수 하나만 둔다(SSOT). 복사하지 않는다. 커진 로직은 독립 모듈로 뺀다.
- 카포처럼 전역 피치에 영향을 주는 값은 TAB·코드 카드·지판·가이드음 모든 경로에 같이 반영한다.
- 악보 입력 화면(`score-input.html`)은 `app.js`를 불러오지 않는다. 두 화면이 같이 쓰는 전역은 `src/app-state.js`, 스타일은 `src/base.css`에 둔다. 칸 수 목록은 `GuitarNotation.SHEET_BEAT_COUNTS`, 음이름은 `noteNameForMidi`만 쓴다.
- UI 문구(상태 줄·알림·확인 창·오류 메시지)는 `~습니다`·`~하세요`·명사형으로 쓰고 반말·해요체를 쓰지 않는다. `src/score-prompt.js`의 AI 프롬프트 본문은 해당하지 않는다. 문서·코드 주석·커밋 메시지는 해라체(`~한다`·`~했다`)로 쓰고 반말을 쓰지 않는다. 규칙은 `Docs/development.md`의 UI 톤 절.
- `vendor/` 아래(`alphatab/`, `musescore-general/` 사운드폰트)는 받은 그대로 두고 고치지 않는다. alphaTab은 보기 창(`alphatab.html`)과 `tools/`에서만 불러오고 앱 기본 화면에는 싣지 않는다.
- `tools/sheet-import-script.js`는 시트의 Apps Script에 붙여 넣는 파일이다. `require`·`module`·`import`를 쓰지 않고, 악보 문법 검사를 옮기지 않는다.

## 악보·재생
- 마디 구분은 `//`와 줄바꿈, 칸 안 분할은 붙여 쓴 `/`(2·3·4분할)다. 구형 공백 슬래시, 구형 악보 변환, 옛 호환 표기(한글 음이름, 괄호·쉼표 분할, 뒤 주법, 따옴표 없는 메모, 코드 별칭, `R`)는 받지 않는다. 되살리지 않는다.
- `r`은 쉼, `-`는 앞 음·화음 전체의 유지다. 음별 길이 접미사는 없다. `.`·고아 유지·칸 부족/초과·그 밖의 분할은 오류이며 모자란 칸을 자동으로 채우지 않는다.
- 빈칸 `_`는 시간 0인 칸이다(못갖춘마디·짧은 마디). 판별은 `GuitarNotation.isSkipToken`·`GuitarRhythm.isSkipBeat`만 쓰고, 위치는 `annotate`의 `startUnits`(빈칸을 뺀 실제 시간)만 쓴다. 마디 시작을 `마디 번호 × 칸 수`로 셈하지 않는다.
- 음가는 `src/rhythm.js`의 파생 길이 하나를 표시와 재생이 같이 쓴다.
- 운지(왼손 숫자, 오른손 `:p :i :m :a`)는 원문에 적힌 것만 표시한다. 추정·전파하지 않는다. 오른손 운지는 음색·gain·타이밍·피치를 바꾸지 않는다.
- 한 클릭이 한 칸, BPM은 분당 칸 수다. 9칸을 3/4 셋잇단으로 쓰지 않는다. `+` 화음은 동시에 치고(`~`가 붙은 화음만 롤), 적히지 않은 롤·주법을 추론하지 않는다.
- KS/classic 음색과 TAB·명시 운지 화면을 보존한다.
- 음 끝 확인 표시 `?`는 오류·음높이·재생에 영향을 주지 않는다. 쉼 판별은 `GuitarNotation.isRestToken`(`r?`, 단독 `?` 포함) 하나로 한다. `/^[rR]$/`를 새로 쓰지 않는다.
- 원본 MIDI에서 옮긴 내장곡(`tools/builtin-recipes.json`에 있는 곡)은 `songs.json`의 `lines`를 손으로 고치지 않는다. 레시피(`edits`, `lineOverrides`)를 고치고 `node tools/rebuild-builtins.js <원본 폴더>`로 일치를 확인한다.
- 악보 원본은 alphaTex다(사진 → alphaTex → 우리 악보). 우리 악보 문법을 바꾸면 alphaTex → 우리 악보 변환(`tools/alphatab-to-score.js`)과 `test-alphatab-tools`를 같이 고친다. 사진 변환 프롬프트(`src/score-prompt.js`)는 alphaTex 문법만 가르치고, 바꾸면 `test-score-prompt`를 돌린다.
- 원본이 alphaTex인 곡은 앱에서 고치면 우리 악보 사본이 된다. 원본 `.tex`를 고칠 때는 `node tools/build-scores.js <폴더>`로 다시 만든다.
- 음 토큰 앞 기호(주법 `!`·`h`·`s`·`g`, 롤 `~`)를 새로 넣으면 `src/staff-layout.js`의 `parseComponent`·`notesForPart`도 고친다. 이 파일은 토큰을 따로 읽어서, 롤·슬라이드 때 두 번 오선 보기 오류를 냈다. `둘 다` 보기와 입력 카드 오선으로 확인한다.
- 기타 음역(프렛 수)은 `GuitarNotation.MAX_FRET` 하나로 정한다. 12·19 같은 숫자를 새로 박지 않는다. 카포 0~12, 칸 수 12는 다른 뜻이다.

## 검증 (명령은 `Docs/development.md` 검증 절)
- 커밋 전 모든 `src/*.js`, `test/*.js`, `tools/*.js`가 `node --check`를 통과해야 한다.
- 파서 정규식·악보 구조·카포: `test-parser`. 음가·쉼·유지·재생: `test-rhythm`, `test-guide`, `test-audio`. 부팅·상태 저장: `test-app-smoke`. DOM·인터랙션·콘솔 에러: `test-browser-smoke`. 타브 입력 모델·변환: `test-tab-input`. 오선 배치·그리기: `test-staff-layout`, `test-staff-svg`. 오선 입력 계산: `test-staff-input`. 시트 자동 가져오기 스크립트: `test-sheet-import-script`.
- 오선 미리보기의 음 길이는 `GuitarRhythm.annotate` 결과만 쓴다. 따로 길이를 계산하거나 성부를 나누지 않는다.

## 커밋
- 메인 세션이 diff 검수와 필수 검증을 마치고 commit과 push까지 해야 완료다. 따로 묻지 않는다. 사용자가 보류나 로컬 작업만 말하면 따른다.
- 서브에이전트는 commit·push 하지 않고 메인에 보고한다.
- 이 작업의 변경만 커밋한다. 설정된 upstream에 일반 push 하고 강제 push 하지 않는다. 못 끝내면 원인과 남은 단계를 보고하고 완료라 하지 않는다.
- 코드 주석·커밋 메시지·문서에 이모지를 쓰지 않는다.
