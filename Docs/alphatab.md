# alphaTab 보기

연습 화면의 곡을 alphaTab 플레이어로 눈으로 비교하는 새 탭 보기 창이다. 악보 입력과 연습 화면이 쓰는 우리 오선·TAB과 책의 악보를 견줄 때 다른 엔진이 그린 같은 곡을 한 번 더 보려는 용도다. 연습 기능(구간 반복, 메트로놈, 가이드음, 지판)과 소리는 우리 앱이 맡고, alphaTab은 미리보기만 한다.

구성은 이렇다.

| 파일 | 역할 |
|---|---|
| `src/score-to-alphatex.js` | 우리 악보 → alphaTex 변환기(`GuitarAlphaTex.toAlphaTex`). DOM 없는 순수 함수이고 Node에서도 돈다 |
| `alphatab.html`, `src/alphatab-view.js` | 보기 창. `app.js`를 불러오지 않는다. 변환하고 alphaTab 플레이어를 띄운다 |
| `vendor/alphatab/` | alphaTab 1.8.4(MPL-2.0). 브라우저 UMD(`dist/alphaTab.min.js`, 전역 `alphaTab`), worker·worklet, Bravura 글꼴, sonivox 사운드폰트 |
| `test/test-score-to-alphatex.js` | 변환기 테스트. vendor의 alphaTab을 `require`해서 변환 결과를 가져온 모델 필드까지 확인한다 |
| `tools/score-to-alphatex.js`, `tools/alphatab-to-score.js` | 우리 악보 ↔ alphaTab 양방향 명령줄 도구. [명령줄 도구](#명령줄-도구) |
| `test/test-alphatab-tools.js`, `test/fixtures/alphatab/` | 명령줄 도구 테스트와 예제(손으로 짠 alphaTex, MusicXML, 브랜치 alphaTex 16곡) |

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

## 명령줄 도구

우리 악보와 alphaTab 사이를 오가는 두 도구가 `tools/`에 있다. 앱 화면과 상관없이 `node`로 돌린다.

```powershell
node tools/score-to-alphatex.js <시트 한 행 TSV 파일 | --builtin <id>> [-o 출력.tex]
node tools/alphatab-to-score.js <입력 파일> [--track n(1부터)] [-o 출력.tsv]
```

| | `score-to-alphatex.js` | `alphatab-to-score.js` |
|---|---|---|
| 방향 | 우리 악보 → alphaTex | alphaTex·Guitar Pro·MusicXML → 시트 한 행 |
| 입력 | 시트 한 행 TSV(`check-score.js`가 읽는 5열), 또는 `songs.json`의 내장곡 id | `.tex` `.alphatex`, `.gp` `.gp3` `.gp4` `.gp5` `.gpx`, `.musicxml` `.xml` |
| 변환 | `GuitarAlphaTex.toAlphaTex` 하나만 쓴다. 카포는 `getSongCapo({ title, badge: 설명 })` | alphaTab이 읽은 모델을 `convertScore`로 시트 행(제목, 칸 수, BPM, 설명, 악보)으로 바꾼다 |
| 출력 | stdout, `-o`면 파일 | stdout, `-o`면 파일. 성공하면 `check-score.js`와 같은 검사(`GuitarParser.validateScore`)를 돌려 오류가 있으면 출력은 쓰되 오류 목록을 stderr에 낸다 |
| 종료 코드 | 0 성공, 1 변환 실패(TSV 검사에 걸림 포함), 2 사용법이 틀림(인자, 읽을 수 없는 파일, 없는 id, 한 행이 아닌 TSV) | 0 성공, 1 변환하지 않음·읽지 못함·검사 오류, 2 사용법이 틀림(인자, 읽을 수 없는 파일, 모르는 확장자) |

메시지는 한국어 `~습니다`체다. 읽는 쪽은 alphaTex가 `AlphaTexImporter`, 나머지가 `ScoreLoader.loadScoreFromBytes`(바이트에서 형식을 알아서 고른다)다. `--track`은 1부터 센 트랙 번호다(Guitar Pro 같은 프로그램과 같다). 생략하면 6줄 표준 조율 트랙이 먼저이고, 없으면 음높이가 있는 첫 트랙(줄·프렛 없이 음높이만 있는 트랙)이다. 6줄인데 표준 조율이 아닌 트랙뿐이면 줄 정보 없는 트랙으로 넘어가지 않고 이유와 함께 멈춘다. 트랙 목록은 오류 메시지에 1부터 나온다.

### 가져오기 규칙

`alphatab-to-score.js`가 alphaTab 모델에서 우리 악보를 만드는 규칙이다. 기대는 `test/test-alphatab-tools.js`가 확인한다.

| 항목 | 규칙 |
|---|---|
| 칸 | 박자표를 `src/score-prompt.js`의 [문법 5] 표대로 고른다. 2/4·3/4·4/4는 2·3·4칸(4분음표), 2/2는 4칸, 3/8은 3칸(8분음표), 6/8·9/8은 6·9칸(8분음표)인데 BPM이 상한(`BPM_MAX`)을 넘으면 2·3칸(점4분음표, 칸 안 3분할), 12/8은 4칸(점4분음표). 표에 없는 박자, 곡 중간 박자 변경, 6줄 표준 조율(`GuitarParser.STRINGS`의 개방현)이 아닌 곡은 변환하지 않고 이유를 낸다. 카포는 설명 열 `Capo n` |
| BPM | alphaTab 첫 템포(4분음표 기준)를 한 칸 길이로 환산한다(8분음표 칸은 ×2, 점4분음표 칸은 ×2/3). 반올림해서 30~240으로 자르고, 잘랐으면 설명 열에 `BPM 자름(원래 값 n)`. 곡 중간 템포 변화는 따라가지 않고 그 마디 메모 `템포 변화 생략` |
| 시작 자리 | 모든 음의 시작(틱)을 칸 격자에 놓는다. 칸마다 그 칸 안 시작 자리와 쉼이 시작하는 자리가 칸을 d(1·2·3·4)로 나눈 자리에 모두 맞는 가장 작은 d를 고른다(오차는 `TOLERANCE_TICKS`). 쉼 시작 자리는 칸 안에서 음이 끝났는데 그 뒤로 울리는 음이 하나도 없는 자리다(다른 성부, 붙임줄로 이어진 음, 앞 마디에서 이어진 음 포함. 다른 음이 계속 울리면 넣지 않는다). 쉼 시작 자리까지 맞는 d가 없으면 쉼 시작 자리는 버리고 시작 자리만으로 고른다. 그래도 맞는 d가 없으면 오차 합이 가장 작은 d(같으면 4)로 옮기고, 옮긴 음에 `?`, 그 마디 메모 `칸 분할에 맞지 않는 리듬 → 가까운 자리`. 마디 길이를 넘는 음은 빼고 `마디 길이를 넘는 음 생략` |
| 성부 | 트랙의 모든 성부를 합친다. 같은 자리에 시작하는 음은 `+` 화음. 조각에 새로 시작하는 음이 없으면 앞 음이 울리는 중일 때 `-`, 아니면 `r`(`r` 바로 뒤나 곡 맨 앞에는 `-`를 두지 않는다). 붙임줄 도착 음은 다시 치지 않는 음이라 새 시작으로 보지 않는다. 성부가 둘 이상이고 길이가 다른 음이 겹치면 그 마디 메모 `긴 음은 시작만 적음`(모든 마디가 그러면 설명 열에 한 번) |
| 음 | 줄과 프렛에서 `개방현 + 프렛`(카포는 넣지 않는다. 우리 문법은 카포 없는 음높이). 토큰은 `[주법][왼손][음이름][옥타브]@줄[:오른손]`, 음이름은 `#`(조표 무시). alphaTab `note.string`은 가장 낮은 줄이 1이라 우리 줄 번호는 `줄 수 - string + 1`. 줄 정보 없는 트랙(조율이 없는 MusicXML 오선 파트 등)은 `note.realValue`(이조 반영)의 음높이만 쓰고 `@줄`은 붙이지 않는다(앱이 기본 위치를 고른다). 음역(6번 줄 개방 ~ 1번 줄 `GuitarNotation.MAX_FRET` 프렛) 밖의 음은 옥타브를 옮겨 안에 넣고 `?` + 마디 메모 `음역 밖 → 옥타브 옮김`. 줄이 있어야 하는 주법(슬러 `s`, 슬라이드 `g`, 하모닉스 `h`)은 빼고 종류별로 마디 메모 `줄 정보 없음: 슬러 생략`·`줄 정보 없음: 슬라이드 생략`·`줄 정보 없음: 하모닉스 생략`. 롤·화음·운지는 그대로이고, 설명 열에 `줄 정보 없음(기본 위치)` |
| 주법 | 해머링·풀링 도착 음에 `s`, 슬라이드(legato·shift) 도착 음에 `g`(출발 음과 같은 줄이 아니면 주법 없이 `슬라이드 생략`). 자연 하모닉스는 `h` + 울리는 음(`GuitarNotation.NATURAL_HARMONICS`)과 `@줄`이고, 표에 없는 프렛이면 보통 음 + `하모닉스 프렛 아님`, 인공 하모닉스는 보통 음 + `인공 하모닉스 → 보통 음`. 화음의 arpeggio down(낮은 줄 → 높은 줄)은 `~`, arpeggio up은 `~` + `위에서 아래 롤 → 아래에서 위`, brush·strum은 동시에 + `스트로크 → 동시에`. 꾸밈음은 빼고 `꾸밈음 생략`, 데드 노트는 빼고 `데드 노트 생략`. 벤딩·비브라토·트레몰로·위미바·트릴은 음만 적고 마디마다 한 번 종류를 메모. 왼손 운지는 alphaTab 검지~소지를 1~4로(엄지·모름은 없음), 오른손은 엄지·검지·중지·약지를 `:p :i :m :a`로. [변환 규칙](#변환-규칙)의 표를 거꾸로 읽은 것이다 |
| 코드 이름 | 마디 안 첫 코드 이름을 `[이름]`, 없으면 `[-]`. 폭 없는 글자(`GuitarAlphaTex.CHORD_NAME_PAD`)는 뗀다. 우리 문법이 받지 않는 이름(`INVALID_CHORD`)은 `[-]` + `코드 이름 변환 불가: 이름`. 마디 안에서 코드가 더 바뀌면 메모에 `n박부터 이름` |
| 도돌이 | 도돌이표와 1·2번 괄호는 alphaTab의 연주 순서(`MidiFileGenerator`가 만드는 `tickLookup.masterBars`)대로 펼치고, 펼친 도돌이 구간의 첫 마디에 메모 `도돌이 펼침`. D.S.·D.C.·Coda·Fine 같은 이동 표시는 펼치지 않고 그 마디 메모에 `표시 이름 표시(펼치지 않음)`. 못갖춘마디(`isAnacrusis`)는 앞을 `r`로 채우고 메모 `못갖춘마디` |
| 제목·설명 | 제목은 `score.title`(없으면 파일 이름), 탭·줄바꿈·줄 바꿈 없는 공백은 한 칸 공백으로. 설명은 `원본: 파일 이름 · alphaTab 변환` 뒤에 `Capo n`, `BPM 자름`, 곡 전체 성부 메모 |

### 하지 못하는 것

- 이동 표시(D.S.·D.C.·Coda·Fine)를 펼치지 않는다. 메모만 남긴다. 이 판의 한계다.
- 표에 없는 박자(5/4, 7/8 등), 곡 중간 박자 변경, 6줄 표준 조율이 아닌 곡은 변환하지 않는다. 첫 마디가 못갖춘마디 표시 없이 다른 박자표(1/4 등)인 곡도 박자 변경으로 거절된다.
- 다른 악기 트랙(베이스 등 4줄·5줄 현악기, 드럼)은 고르지 않는다. 6줄 기타도 줄 정보 없는 음높이 트랙도 없으면 변환하지 않는다. 줄 정보가 없는 트랙은 어느 악기인지 알 수 없어서 피아노 파트도 음높이만 있으면 고른다.
- 줄 정보 없는 트랙은 `@줄` 없이 앱이 기본 위치를 고르게 하므로 원본 운지(어느 줄에서 치는지)는 사라지고, 슬러·슬라이드·하모닉스는 빠진다.
- 트랙의 첫 6줄 보표(또는 음높이가 있는 첫 보표) 하나만 읽는다. 압축 MusicXML(`.mxl`)은 받지 않는다.
- 곡 중간 템포 변화는 첫 템포만 쓰고 그 마디 메모만 남긴다.

### 테스트가 보장하는 것

`node test/test-alphatab-tools.js`가 보장하는 것은 이렇다.

- 왕복: `songs.json`의 모든 구조화 내장곡을 `GuitarAlphaTex.toAlphaTex` → `AlphaTexImporter` → `convertScore`로 돌려 원래 악보와 견준다. 아포얀도 `!`, 확인 표시 `?`, 왼손 `0`, 마디 메모는 alphaTex에 없으니 양쪽에서 지우고, 구성음 순서를 줄 번호 내림차순으로 맞춘다. 그 밖의 토큰은 같아야 한다. 칸 구성이 달라도(4/4를 8분음표 8칸으로 쓴 곡 ↔ 4칸, `E4/-` ↔ `E4`) 같은 소리면 같게 보도록, 마디를 "마디 안 위치와 내용"의 사건 목록으로 바꿔 견주고 4분음표 템포로 BPM을 견준다. 코드 이름과 카포도 견준다.
- 브랜치 alphaTex: `codex/alphatab-player` 브랜치 `songs.json`의 alphaTex 16곡(`test/fixtures/alphatab/branch-builtins.json`, id와 alphaTex만 담은 배열)이 오류 없이 변환되고 마디 수가 alphaTab 마디 수와 같은지. 지원 박자표가 아닌 곡(4/8)은 이유와 함께 거절돼야 한다. 파일을 다시 만드는 명령:

  ```powershell
  node -e "var s=JSON.parse(require('child_process').execFileSync('git',['show','codex/alphatab-player:songs.json'],{encoding:'utf8',maxBuffer:100000000})); require('fs').writeFileSync('test/fixtures/alphatab/branch-builtins.json', JSON.stringify(s.map(function(x){ return {id:x.id,alphaTex:x.alphaTex}; }),null,2)+'\n')"
  ```

- 손으로 짠 예제(`test/fixtures/alphatab/*.tex`): 두 성부, 셋잇단, 도돌이와 1·2번 괄호, 해머링·슬라이드·하모닉스·arpeggio·brush·꾸밈음·데드 노트, 6/8, 12/8, 못갖춘마디, 카포를 기대하는 악보 줄(음 이름은 `GuitarParser.STRINGS`에서 셈한다)과 견주고, 모두 alphaTab 진단 0으로 읽히는지 확인한다. 5/4와 비표준 조율은 거절 이유를 확인한다. 같은 예제를 `Gp7Exporter`가 쓴 `.gp`로 한 번 돌려 Guitar Pro 경로도 같은 결과인지 본다(Guitar Pro 3~5와 `.gpx` 파일은 저장소에 없어 안 돌려 봤다). MusicXML은 `guitar.musicxml`(조율 있음)의 줄이 유지되는지, 브랜치에서 가져온 `simple.musicxml`(조율 없음, 기대 줄은 파일의 음에서 셈)과 `no-strings.musicxml`(오선만 있는 파트: 음역 밖 음 C2·C6, 슬러, 화음)이 `@줄` 없이 변환되고 `?`·메모가 맞는지 본다. 쉼 시작 자리는 음 뒤 쉼(`E4/r`)이 분할을 만드는지, 오래 울리는 저음이 있으면 만들지 않는지 본다. `--track`은 1부터 센다.
- 명령줄: 두 도구를 `child_process`로 돌려 종료 코드(0·1·2)와 출력(TSV 5열, `.tex`가 다시 읽힘, `check-score` 통과)을 확인한다.
- 일부러 어긋난 사본: (가) 슬러 도착 표시를 출발 음에 다는 사본, (나) 붙임줄 도착을 새 시작으로 보는 사본, (다) 8분음표 칸 BPM을 환산하지 않는 사본, (라) 쉼 시작 자리를 무시하는 사본이 실제로 검사에 걸리는지. 도구 소스의 한 줄을 바꿔 메모리에서 불러 쓴다.

왕복은 우리 문법으로 쓴 악보를 alphaTab을 거쳐 되돌릴 수 있다는 것까지만 보장한다. 남이 만든 Guitar Pro·MusicXML의 변환 품질(박자 격자에 맞는 정도, 성부가 많은 곡의 겹침)은 보장하지 않고, 메모로 표시한 손실을 사람이 확인해야 한다.

### 알려진 것

- 안 돌려 본 것: Guitar Pro 3~5·`.gpx` 실제 파일, 큰 곡(성부 여럿, 마디 수백 개)의 변환 품질, 이조(`<transpose>`)가 든 실제 기타 MusicXML(`note.realValue`가 소리 나는 높이를 주는 것은 임시 파일로만 확인했다).

### 결정

- 2026-10-20 결정(사용자): 우리 악보와 alphaTab 사이 양방향 도구를 저장소에 남긴다. 남이 배포한 Guitar Pro·MusicXML을 연습 곡으로 쓰고, 사진 변환의 중간 원본으로 alphaTex를 보관하는 실험을 하려는 것이다.
- 함정: alphaTab이 읽은 MusicXML 제목에 줄 바꿈 없는 공백(U+00A0)이 섞여 나온다(영문 제목 가운데 공백이 U+00A0이 된다). 제목을 그대로 견주면 어긋나서 공백류를 한 칸 공백으로 바꾼다.
- 2026-10-20 결정: 칸 나누기에 쉼이 시작하는 자리도 넣는다. 처음 판은 새로 치는 음의 시작 자리만 보고 분할을 골라서, `builtin-carulli-op241-05` 16마디의 `G2/r`(8분음표 + 8분쉼표)가 `G2`로 돌아와 왕복 27곡 중 1곡이 어긋났다. 음이 끝난 뒤 쉼이 시작하는 자리가 격자에 들어오지 못해서다. 쉼 시작 자리를 넣으면 27곡이 모두 맞는다. 다른 음이 계속 울리는 자리는 쉼이 아니라 넣지 않는다(성부 합치기의 "시작만 적음").
- 2026-10-20 결정: 줄 정보 없는 트랙도 받는다(거절하지 않는다). 무료로 구할 수 있는 클래식 기타 MusicXML은 대부분 오선만 있고 줄·프렛이 없어서, 거절하면 이 도구로 쓸 수 있는 파일이 거의 없다. 음높이만 적고 줄은 앱이 고르게 하되, 음역 밖 음은 옥타브를 옮기고 줄이 있어야 하는 주법은 빼며 메모로 남긴다. 6줄인데 표준 조율이 아닌 트랙은 이전처럼 거절한다.
- 2026-10-20 결정: `--track`은 1부터 센다. Guitar Pro 같은 프로그램에서 첫 트랙이 1이라서 트랙 목록과 번호를 맞췄다. 처음 판은 0부터였다.
- 함정: 셸 명령으로 alphaTex 파일을 만들면 역슬래시(`\title`)가 줄어든다. 예제는 파일 쓰기 도구로 만든다.
- 구현 메모: 도돌이 순서는 규칙을 다시 짜지 않고 alphaTab의 재생 순서를 쓴다. 이동 표시까지 따라가지 않도록 순서를 만드는 동안만 마디의 `directions`를 떼고 끝나면 되돌린다.

## 검증

```powershell
node test/test-score-to-alphatex.js
node test/test-alphatab-tools.js
node test/test-browser-smoke.js
```

`test-score-to-alphatex`는 `songs.json`의 모든 곡을 변환해 alphaTab 가져오기 진단이 0인지, 마디 수와 마디마다 박 길이 합(tick)이 박자표와 같은지, 줄·프렛·실음이 배치와 같은지 확인하고, 합성 악보로 위 표의 효과를 하나씩 모델 필드로 확인한다. 기대값은 우리 파서·상수에서 셈한다. 브라우저 스모크는 연습 화면 단추의 넘기기, 보기 창의 그리기·보기 전환·재생·다크와 375px 폭을 확인하고 `test-artifacts/alphatab-view.png`를 남긴다.
