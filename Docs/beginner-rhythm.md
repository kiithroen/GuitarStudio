# 리듬과 오디오 유지보수 계약

`src/rhythm.js`, `src/guide.js`, `src/audio.js`가 공유하는 현재 동작이다. 입력 문법은 [악보 문법](score-format.md)에 있다. 오디오 경로는 악보 이벤트와 메트로놈 소리 출력만 다루고 마이크 입력 캡처나 입력음 분석은 없다.

## 리듬 파생 정보

`GuitarRhythm.getGridInfo(slotsPerBar)`는 `{slotsPerBar,numerator,denominator,slotQuarterLength,bpmUnitLabel}`을 반환한다. 6·9·12칸은 각각 6/8·9/8·12/8이고 한 칸은 4분음표 길이 기준 0.5이다. 8칸은 4/4의 8분음표 칸(0.5), 나머지 유효한 1~12칸은 n/4 박자에 4분음표 칸(1)이다. UI에서 선택 가능한 칸 수는 2, 3, 4, 6, 8, 9이다.

`GuitarRhythm.annotate(measures, slotsPerBar)`는 입력 `beats`와 `subNotes`를 시간순으로 분석하고 `{events,totalUnits,errors}`를 반환한다. `UNITS_PER_SLOT`은 12이다. 단일 part의 `kind`는 `note`, `rest`, `hold`, `skip`, `invalid` 중 하나고, 분할 beat는 `group`이다. 각 part에는 `startUnits`, `slotUnits`, `durationUnits`, `tieFrom`이 붙는다. `startUnits`는 곡 시작부터 빈칸([악보 문법](score-format.md#빈칸))을 뺀 실제 시간의 절대 정수 위치다. 앞의 모든 칸 중 빈칸이 아닌 칸 수 × 12이므로, 빈칸이 없는 악보에서는 마디 시작이 `measureIndex * slotsPerBar * 12`이고 빈칸이 있으면 그보다 앞선다. 마디 시작 위치가 필요한 코드는 이 식으로 따로 셈하지 말고 `startUnits`를 쓴다. `totalUnits`도 빈칸을 뺀 합이다. `slotUnits`는 part 자체 길이(12 또는 12/분할수)이다.

빈칸(`skip`) part는 `slotUnits`와 `durationUnits`가 0이고 이벤트를 만들지 않으며, `startUnits`는 그 자리까지 쌓인 시간이라 바로 다음 칸과 같다. 시간이 흐르지 않으니 유지 사슬은 빈칸에서 끊기지 않고 건너 이어지며 유지 길이에 빈칸은 들어가지 않는다. 쉼이 아니라서 사슬을 끊거나 소리를 정리하지 않는다. `GuitarRhythm.isSkipBeat`가 칸 하나 통째로의 빈칸을 가리고, `GuitarRhythm.countPlayableSlots`가 어느 칸부터 구간 끝 마디까지 빈칸이 아닌 칸 수를 센다. 빈칸 판별 자체는 `GuitarNotation.isSkipToken` 하나다. 이벤트와 `tieFrom`의 위치 참조에서 일반 beat의 `subIndex`는 null이고 분할 part는 0부터 시작하는 분할 인덱스를 쓴다.

음과 화음은 현재 칸 또는 `/` 분할로 정해지는 part 공통 길이를 쓴다. `-`는 앞 음이나 화음 전체를 이어지는 다음 탄현이나 쉼까지 유지한다. 화음 구성음별 음가, 독립 성부 레인, 성부별 쉼, 화음 일부의 붙임줄은 지원하지 않는다.

2026-10-19 결정: 음별 길이 접미사는 악보 음가와 자연 여운을 혼동시키고 자동 생성 입력을 복잡하게 해 제거했다. 기존 part 공통 길이와 자연 감쇠 경로를 쓰며, 독립 성부 scheduler나 별도 음가 입력 문법은 추가하지 않았다. 원자료 로망스의 독립 음가도 새 문법으로 옮겨 기록하지 않는다.

hold part의 `durationUnits`는 그 위치부터 이어지는 유지 체인의 끝까지 남은 길이다. `tieFrom`은 hold만 갖는 `{measureIndex,beatIndex,subIndex}` 원음 위치다. `resolveHold(measures,part)`는 이어지는 원음 part 또는 `null`을 반환하고, `getSoundingNotes(measures,positionUnits)`는 그 시점에 `-`로 이어져 악보상 유지 중인 원음 또는 화음 전체와 남은 길이를 반환한다.

원문 `tok`와 음·현·프렛·명시 왼손 운지·명시 오른손 운지(`:p`, `:i`, `:m`, `:a`)를 보존하고 리듬 파생 필드는 원문을 파싱해 다시 계산한다. 오른손 운지는 표시용 metadata이며 음색, gain, 타이밍, 피치와 재생 동작에 영향을 주지 않는다. `notationVersion`은 기존 2를 유지한다. 분석 이벤트의 `part`는 실제 음 시작 part를 참조하며, 이벤트 배열을 곡에 저장해 순환 참조를 만들지 않는다. 잘못된 기존 악보를 자동으로 DB에 덮어쓰지 말고 원문을 보존한다.

`parseScore`는 검증을 위해 `validateScore`를 호출한다. `validateScore`가 `parseScore`를 다시 부르는 순환을 만들지 않는다. `src/notation.js`는 문장·칸 구조를 검증하고 `src/parser.js`가 음표와 코드 토큰 검사를 추가한다.

## 재생 이벤트

`getBeatGuideEvents(beat, options)`와 `scheduleBeatGuide(beat, options)`는 `startTime`, `slotDuration`(초/한 칸), `measures`, `resumeHold`, `maxDurationSlots`, `capo`를 사용한다. 이벤트 `when`은 `startTime + subIndex / 분할수 * slotDuration`, 각 음 이벤트의 `duration`은 그 part의 공통 `durationUnits / 12 * slotDuration`이다. 화음 구성음은 같은 시각에 시작하고 같은 part 길이를 받는다. 롤(`~`) 조각은 예외다: 구성음을 줄 번호가 큰 것부터(6번 줄 → 1번 줄) `ROLL_STEP` 간격으로 늦춰 시작하고, 간격이 그 조각 길이 × `ROLL_MAX_SHARE` ÷ (음 수 − 1)을 넘으면 그만큼으로 줄인다. 첫 음이 박 시각이고, 늦게 시작한 음은 늦은 만큼 `duration`이 줄어 끝 시각이 같다. `resumeHold` 복원은 다시 굴리지 않고 한꺼번에 울린다(새로 치는 게 아니라 이어 울리는 소리를 되살리는 것이라서). 값은 `src/guide.js`.

note 이벤트는 `{kind:'note',note,duration,when,gain,articulation,str}`, rest 이벤트는 `{kind:'rest',when,duration}`이다. rest는 해당 시각의 기타 직접음을 정리한다. gain은 명시한 아포얀도(`APOYANDO_GAIN`)와 슬러·슬라이드(`SLUR_GAIN`, 오른손으로 다시 치지 않는 음이라 작게)만 바꾸고(값은 `src/guide.js`) 그 외는 1이다(티란도 표시는 2026-10-19에 문법에서 없앴다, [악보 문법](score-format.md)). 원문에 명시한 주법 설정만 전달하고 부모 분할 그룹의 주법을 자식에 전파하지 않는다. 슬라이드 음 이벤트에는 출발 음 높이 `glideFrom`이 실려, `scheduleBeatGuide`가 `playGuitarNote`에 `glide`(출발 음 높이, 미끄럼 시간 = min(`SLIDE_GLIDE_SEC`, 음 길이 × `SLIDE_MAX_SHARE`))를 넘긴다. KS는 재생 속도(`playbackRate`), classic은 오실레이터 주파수를 출발 음 높이에서 제 높이로 미끄러뜨린다. `resumeHold` 복원은 미끄러지지 않는다. 입력 화면 들어보기도 같은 `articulationGain`을 쓴다(2026-10-20, 외부 리뷰에서 발견).

일반 진행에서 hold는 새 note-on을 만들지 않는다. `resumeHold:true`는 `-`가 이어지는 위치에서 원음 또는 화음 전체를 남은 공통 길이로 한 번 복원한다. 이 동작은 정지 상태 칸 미리듣기, 중간 시작, 루프 시작과 재생 도중 가이드음을 다시 켠 뒤의 다음 박에서 사용된다. 이전 재생의 자연 여운이나 리버브는 복원 대상이 아니고, 지속음 위치의 전체 반주를 과거부터 다시 합성하지 않는다. 복원된 악보상 길이는 곡·loop 끝에서 잘리고, 그 뒤 내부 hold는 다시 치지 않는다. 기존 스케줄러를 사용하며 중간 시각에 새 이벤트를 추가 예약하지 않는다.

`getBeatGuideEvents`와 `scheduleBeatGuide`는 빈칸 beat에 빈 이벤트 목록을 돌려주고(`resumeHold`여도 같다), 아무것도 예약하지 않는다.

재생 스케줄러(`schedulerTick`)는 칸마다 메트로놈 클릭, 가이드음, 화면 동기화를 예약하고 `nextBeatTime`에 칸 길이를 더한 뒤 다음 칸으로 간다. 칸이 빈칸이면 이 세 가지를 예약하지 않고 `nextBeatTime`도 더하지 않고 다음 칸으로 넘어간다. 마디 첫 칸이 빈칸이면 강박 표시 클릭도 없다(그 칸을 건너뛰니 다음 실제 칸은 강박 칸이 아니다). 카운트인은 그대로다. 빈칸에서 시작하는 재생·정지 상태 미리듣기는 소리 없이 다음 칸으로 가고, `resumeHold`는 소리가 나는 첫 칸에서 한 번 복원한다(`getSoundingNotes`가 그 칸의 실제 시간 위치로 찾는다). 재생을 시작할 칸이 빈칸이면 `startPractice`가 `seekPastSkipBeats`로 구간 안의 다음 소리 나는 칸으로 옮기고, 구간 끝까지 없으면 구간 시작 마디의 첫 칸으로 간다. 2026-10-21 결정: 마지막 마디의 뒤쪽 빈칸을 눌러 재생하면 남은 칸이 모두 빈칸이라 소리 없이 끝나거나 완주 횟수만 올라갔다.

`maxDurationSlots`는 현재 칸 시작부터 재생·루프 끝까지 남은 칸 수이고 빈칸은 세지 않는다(`GuitarRhythm.countPlayableSlots`). 분할 위치를 고려해 이벤트를 루프 경계에서 자른다. `getSubdividedGuideEvents`와 `scheduleSubdividedGuide`는 `subStep`을 `slotDuration = subStep * subNotes.length`로 바꿔 공통 경로를 사용한다. `getSubdividedGuideEvents` 반환값은 기존대로 note 이벤트만 포함한다.

## 오디오 출력

`scheduleBeatGuide`는 실음 MIDI에 카포를 한 번 적용한다. 구조화 악보 이벤트는 `event.duration`을 악보상 길이로 유지하면서 `playGuitarNote(..., {naturalDecay:true,hardStopAt})`에 전달하고, 음가 끝에서 note-off를 강제하지 않는다. KS는 물리 모델 버퍼가 가진 자연 감쇠를 따르고, classic은 피아노 타현 배음과 공통 `getNaturalDecayProfile` 감쇠 envelope를 사용하는 피아노형 가이드 음원이다. 그래서 실제 여운 길이는 악보 음가와 다를 수 있다. `exactDuration` API는 내부 테스트나 명시 호출에 남아 있지만 구조화 가이드는 사용하지 않는다.

- 콘서트홀 wet gain은 `CONCERT_HALL_WET_GAIN` 단일 상수를 초기 ON 라우팅과 실시간 ON 전환에서 함께 쓴다. OFF는 0이고 dry gain과 전환 시간은 기존 값을 유지한다. 이 값은 wet 잔향만 조절하며 음원·명시 길이·IR을 바꾸지 않는다.
- `appState.guitarVol`(연주음 슬라이더)은 기타 소리 전부가 지나는 `guitarBus` gain에 곱해진다(`updateGuitarVolume`). 클릭 버스와 마스터 compressor 설정은 바꾸지 않는다.
- 공유 마스터 compressor의 threshold는 여러 현이 동시에 날 때 생기는 순간 피크를 위한 여유를 두도록 낮춰 뒀다(`src/audio.js` compressor 생성부). ratio·knee·attack·release와 각 버스 gain은 기존 설정을 유지한다.
- classic 음원의 저음 명료도를 위해 저음 권선현(`isBass`)에서만 필터 attack·decay cutoff에 하한 `CLASSIC_BASS_ATTACK_CUTOFF`·`CLASSIC_BASS_DECAY_CUTOFF`를 둔다. 기존 주파수 배수 계산값이 더 높으면 그 값을 유지하며, 고음과 KS 음원은 바꾸지 않는다.
- KS 물리 모델은 `ksDesign`의 1차 분산 올패스 필터로 현의 강성에 따른 고주파 분산 지연을 반영하고, `renderKsString`에서 브리지 타격음과 비주기 탄현 마찰음 트랜지언트를 더해 어택감을 모사한다.
- 주법별 키(`ksArticulationKey`)로 아포얀도(`!`), 자연 하모닉스(`h`), 슬러(`s`)의 배음 구성(`ksExcitation`), 초기 장력 피치 벤드, 어택 시간, 감쇠 프로파일(`getNaturalDecayProfile`)을 구분해 독립 캐시(`getKsBuffer`)로 관리한다.
- 바디 공명(`BODY_MODES`)은 콘서트홀 리버브가 꺼진 드라이 모드에서도 `DRY_BODY_RATIO` 비율로 상판 울림을 유지하며, classic 음원(피아노 가이드 톤) 선택 시에는 0으로 비활성화된다. 콘서트홀 리버브 버퍼(`buildConcertHallReverbBuffer`)는 고역 공기 흡수 로우패스와 벽면 스무딩을 적용한다.
- classic 음원(`buildClassicVoice`)은 기타 탄현 주법·피치 벤드·바디 공명·개방현 공명(`addSympatheticResonance`)을 배제하고, 해머 타현 배음(`PeriodicWave` 캐시)과 복현 디튠을 적용한 맑은 피아노 가이드 톤을 합성한다.

## 재생음 정리와 시계

직접음을 정리하는 경계는 같은 현 재탄현, 전체 쉼, 사용자 정지, 곡 교체, 가이드음 끄기, 곡·loop 끝이다. 현·운지 이동만으로 소음을 추론하지 않는다.

`stopGuitarNotes(when)`는 예약된 탄현과 직접음, 공명현 재생음을 함께 정리한다. 정지, 곡 교체, 가이드음 끄기, 새 연습 시작 전에 이전 프리뷰나 예약음이 이어지지 않게 사용한다. 만료 여부는 예약 시각이 아니라 실제 `actx.currentTime`을 기준으로 판단한다. 미래의 쉼을 예약한 뒤에도 그 시각이 오기 전에 정지를 요청하면 종료를 앞당길 수 있어야 한다. 이후 정지 요청이 기존 종료를 늦춰서는 안 된다. 메트로놈과 리버브 버스는 이 정리의 대상이 아니다.

재생 중 BPM 변경은 이미 울리는 음을 재합성하지 않고 이후 스케줄부터 반영한다. 루프 경계에서 각 회차의 템포로 길이를 계산한다. 새 재생 엔진이나 독립 성부 scheduler를 만들지 않는다.

검증은 이벤트 예약·음성 수명과 실제 청취 품질을 구분한다. 명시하지 않은 주법, 독립 성부, 부모 주법 전파를 추가하지 않는다.
