# alphaTab 보기

연습 화면의 곡을 alphaTab 플레이어로 눈으로 비교하는 새 탭 보기 창이다. 악보 입력과 연습 화면이 쓰는 우리 오선·TAB과 책의 악보를 견줄 때 다른 엔진이 그린 같은 곡을 한 번 더 보려는 용도다. 연습 기능(구간 반복, 메트로놈, 가이드음, 지판)과 소리는 우리 앱이 맡고, alphaTab은 미리보기만 한다.

구성은 이렇다.

| 파일 | 역할 |
|---|---|
| `src/score-to-alphatex.js` | 우리 악보 → alphaTex 변환기(`GuitarAlphaTex.toAlphaTex`). DOM 없는 순수 함수이고 Node에서도 돈다 |
| `alphatab.html`, `src/alphatab-view.js` | 보기 창. `app.js`를 불러오지 않는다. 변환하고 alphaTab 플레이어를 띄운다 |
| `vendor/alphatab/` | alphaTab 1.8.4(MPL-2.0). 브라우저 UMD(`dist/alphaTab.min.js`, 전역 `alphaTab`), worker·worklet, Bravura 글꼴, sonivox 사운드폰트 |
| `test/test-score-to-alphatex.js` | 변환기 테스트. vendor의 alphaTab을 `require`해서 변환 결과를 가져온 모델 필드까지 확인한다 |

## vendor로 둔 이유

alphaTab은 `codex/alphatab-player` 실험 브랜치에서 가져온 1.8.4다. 번들러가 없는 정적 앱이라 CDN 대신 저장소에 두었고(GitHub Pages에서 같은 출처로 서빙), vendor 파일은 고치지 않는다. 플레이어는 이 보기 창에서만 불러온다. 앱 기본 화면(`index.html`, `score-input.html`)은 alphaTab을 로드하지 않고 시작 속도와 소리가 그대로다.

## 쓰는 법

1. 연습 화면 머리의 `alphaTab` 단추(`#openAlphaTabBtn`, `단축키 안내` 옆, 구조화 곡일 때만 보인다)를 누른다. 지금 곡(수정 초안이면 초안 내용)을 localStorage `gs.alphaTab.view`에 `{ title, beats, bpm, capo, lines, savedAt }`로 넣고 `alphatab.html`을 새 탭으로 연다. 연습은 멈추지 않는다.
2. 보기 창은 그 값을 읽어 변환하고 그린다. 값을 지우지 않아서 새로고침해도 같은 곡이다. 값이 없거나 모양이 틀리면 상태 줄에 안내만 한다. 변환이나 alphaTab 읽기가 실패하면 이유를 상태 줄에 보인다.
3. 조작은 머리 한 줄에 있다: 곡 제목, `재생`/`일시정지`(Space), `처음으로`, 빠르기(50·75·100%), 보기(`오선+타브`·`타브`·`오선`), 상태 줄. 보기를 바꾸면 다시 그린다.

색은 `src/base.css` 토큰(`--fg`, `--muted`)에서 읽어 alphaTab 표시 색(`mainGlyphColor`, `staffLineColor` 등)에 넣고, 시스템 색 구성이 바뀌면 다시 읽는다. 소리는 alphaTab의 사운드폰트라 앱의 합성음과 다르다.

## 변환 규칙

배치는 `GuitarStaffLayout.layoutScore`의 결과 하나만 쓴다. 코드 이름만 `GuitarParser.parseScore`의 마디 `chord`에서 읽는다. 표의 alphaTab 모델 필드는 `vendor/alphatab/dist/alphaTab.core.mjs`의 alphaTex 파서 코드에서 찾은 표기를 Node에서 가져와 `test/test-score-to-alphatex.js`가 확인한 것이다.

| 우리 악보 | alphaTex | alphaTab 모델 |
|---|---|---|
| 곡 제목 | `\title "…"`(따옴표·역슬래시 이스케이프) | `score.title` |
| BPM(분당 칸 수) | `\tempo (n)`. 한 칸이 4분음표면 BPM, 8분음표면 BPM의 절반(`getGridInfo(beats).slotQuarterLength`) | `score.tempo`(4분음표 기준) |
| 칸 수 | `\ts (분자 분모)`(`getGridInfo`) | `masterBar.timeSignatureNumerator`·`Denominator` |
| 카포 | `\capo n`(0이면 안 적는다). 프렛은 카포 기준 그대로 | `staff.capo`. 실음 `note.realValue` = 프렛 + 카포 + 개방현 |
| 음 | `프렛.줄`(우리 줄 번호와 같다: 1번 줄이 높은 미). 화음은 `(음 음 …)` | `note.fret`, `note.string`(alphaTab은 높은 줄이 큰 수) |
| 음 길이 | 온 1, 2분 2, 4분 4, 8분 8, 16분 16, 32분 32를 `.길이`로 | `beat.duration` |
| 점음표 | 박 효과 `d`(하나), `dd`(둘) | `beat.dots` |
| 셋잇단 | 박 효과 `tu 3` | `beat.tupletNumerator` 3, `tupletDenominator` 2 |
| 쉼 | `r.길이`. 마디가 통째로 쉬면 `r.1`(박자와 상관없이 마디 길이) | `beat.isRest`, `beat.isFullBarRest` |
| 붙임줄로 이어진 뒤 토막 | 음 효과 `t`(프렛은 그대로 적는다) | `note.isTieDestination`, `note.tieOrigin` |
| 자연 하모닉스 `h` | 음 효과 `nh`. 프렛은 손 대는 프렛 | `note.harmonicType` = Natural, `note.realValue`가 울리는 음 |
| 슬러 `s` | 출발 음(앞 음)에 음 효과 `h`. 마디를 넘으면 출발 마디의 음, 붙임줄로 나뉜 음이면 마지막 토막 | `note.isHammerPullOrigin`, `note.hammerPullDestination` |
| 슬라이드 `g` | 출발 음에 음 효과 `sl` | `note.slideOutType` = Legato, `note.slideTarget` |
| 왼손 운지 1~4 | 음 효과 `lf 2`~`lf 5`(alphaTab은 1이 엄지라 한 칸 밀린다). 0은 안 적는다 | `note.leftHandFinger` = IndexFinger~LittleFinger |
| 오른손 운지 `:p :i :m :a` | 음 효과 `rf 1`~`rf 4` | `note.rightHandFinger` = Thumb~AnnularFinger |
| 롤 `~` | 박 효과 `ad` | `beat.brushType` = ArpeggioDown |
| 마디 코드 이름 | 마디 첫 박의 박 효과 `ch "이름"`(`[-]`이면 없다) | `beat.chordId`, `staff.chords`의 `name` |
| 마디 | ` \|` | 마디마다 `masterBar` 하나 |

- 붙임줄 도착 음에는 운지를 달지 않는다. 다시 치지 않는 음이라서다. 하모닉스(`nh`)와 슬러·슬라이드 출발 표시는 도착 음이 마지막 토막일 때 그 토막에 단다.
- 롤은 `ad`다(아래 결정 참조). 화음 첫 토막에만 달리고(배치가 롤을 첫 토막에만 싣는다) 붙임줄로 이어진 뒤 토막에는 없다.
- 코드 이름은 alphaTab이 소문자로 바꾼 값을 코드 키로 써서 `CM7`과 `Cm7`이 같은 코드가 된다. 키가 겹치는 다른 이름 뒤에는 폭이 없는 글자(`GuitarAlphaTex.CHORD_NAME_PAD`)를 붙여 가른다.

## 넣지 않는 것

아포얀도 `!`, 확인 표시 `?`, 마디 메모(가사), 조표(`key`), 변칙 조율(조율은 표준만)은 변환하지 않는다. 눈으로 대조하는 데 필요한 음높이·길이·운지·주법만 옮긴다.

## 결정

- 2026-10-20 결정(사용자 요청): 연습 기능과 소리는 우리 앱이 맡고, alphaTab은 눈으로 비교하는 미리보기로만 둔다. alphaTab을 앱의 연주 엔진으로 바꾸는 실험은 `codex/alphatab-player` 브랜치에 남아 있고 main은 기존 엔진을 쓴다.
- 2026-10-20 결정: 변환은 `layoutScore` 결과 하나만 쓴다. 음 길이·점·붙임줄·셋잇단·슬러/슬라이드 항목·롤 첫 토막을 변환기에서 다시 셈하면 오선 미리보기와 어긋나는 곳이 생기고, 오선 미리보기가 음 길이를 `GuitarRhythm.annotate` 결과 하나로만 쓰는 이유([오선 미리보기](staff-notation.md))와 같다. 배치가 오류면 그 오류를 그대로 돌려준다.
- 2026-10-20 결정: 롤은 `au`가 아니라 `ad`로 옮긴다. 이름이 반대로 보이지만, alphaTab의 `ad`(ArpeggioDown)가 아래 줄(낮은 소리)부터 굴린다. `ad`와 `au`를 같은 화음에 달고 alphaTab이 만든 MIDI 이벤트의 시작 순서를 보면 `ad`는 낮은 음부터, `au`는 높은 음부터였고(`test/test-score-to-alphatex.js`), 화면에서도 `ad`의 화살표가 위를 가리켰다(낮은 줄에서 높은 줄로, 우리 롤과 같은 방향).
- 2026-10-20 결정: `alphaTab` 단추는 악보 툴바(`악보 편집` 앞)가 아니라 머리 줄(`단축키 안내` 옆)에 둔다. 툴바에 넣으면 640px 폭 검사에서 `보기 선택`·`카포 배지`와 겹쳤다([화면과 조작](ui.md)).
- 2026-10-20 결정: 폭 500px 미만에서는 alphaTab 배율을 낮춰(`NARROW_SCALE`) 그린다. 배율은 불러올 때만 정한다. 375px에서도 가로로 넘치지 않지만 긴 곡 제목이 악보 머리의 제목 줄에서 잘린다(보기 창 안에서 가로 스크롤). 제목은 머리 줄에도 있다.
- 틀린 길: 처음에는 롤을 `au`로 옮기려 했다. 이름만 보고 정한 것이었고 위 확인으로 바로잡았다.
- 알려진 것: 재생을 시작하자마자 바로 멈추면 alphaTab 내부(`pause`)에서 `InvalidStateError`가 콘솔에 난다(소리가 실제로 시작되기 전에 멈출 때). `test/test-browser-smoke.js`는 재생 뒤 잠시 기다렸다 멈춘다. 이 오류는 vendor 코드 안이라 고치지 않았다.
- 안 돌려 본 것: 실제 폰(갤럭시 폴드7)에서의 보기·재생. 소리 품질은 확인하지 않았다.

## 검증

```powershell
node test/test-score-to-alphatex.js
node test/test-browser-smoke.js
```

`test-score-to-alphatex`는 `songs.json`의 모든 곡을 변환해 alphaTab 가져오기 진단이 0인지, 마디 수와 마디마다 박 길이 합(tick)이 박자표와 같은지, 줄·프렛·실음이 배치와 같은지 확인하고, 합성 악보로 위 표의 효과를 하나씩 모델 필드로 확인한다. 기대값은 우리 파서·상수에서 셈한다. 브라우저 스모크는 연습 화면 단추의 넘기기, 보기 창의 그리기·보기 전환·재생·다크와 375px 폭을 확인하고 `test-artifacts/alphatab-view.png`를 남긴다.
