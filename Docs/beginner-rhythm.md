# 리듬과 오디오 유지보수 계약

`src/rhythm.js`, `src/guide.js`, `src/audio.js`가 공유하는 현재 동작이야. 입력 문법은 [악보 문법](score-format.md)에 있어. 오디오 경로는 악보 이벤트와 메트로놈 소리 출력만 다루고 마이크 입력 캡처나 입력음 분석은 없어.

## 리듬 파생 정보

`GuitarRhythm.getGridInfo(slotsPerBar)`는 `{slotsPerBar,numerator,denominator,slotQuarterLength,bpmUnitLabel}`을 반환해. 6·9·12칸은 각각 6/8·9/8·12/8이고 한 칸은 4분음표 길이 기준 0.5야. 8칸은 4/4의 8분음표 칸(0.5), 나머지 유효한 1~12칸은 n/4 박자에 4분음표 칸(1)이야. UI에서 선택 가능한 칸 수는 2, 3, 4, 6, 8, 9야.

`GuitarRhythm.annotate(measures, slotsPerBar)`는 입력 `beats`와 `subNotes`를 시간순으로 분석하고 `{events,totalUnits,errors}`를 반환해. `UNITS_PER_SLOT`은 12야. 단일 part의 `kind`는 `note`, `rest`, `hold`, `invalid` 중 하나고, 분할 beat는 `group`이야. 각 part에는 `startUnits`, `slotUnits`, `durationUnits`, `tieFrom`이 붙어. `startUnits`는 곡 시작부터의 절대 정수 위치고 마디 시작은 `measureIndex * slotsPerBar * 12`야. `slotUnits`는 part 자체 길이(12 또는 12/분할수)야. 이벤트와 `tieFrom`의 위치 참조에서 일반 beat의 `subIndex`는 null이고 분할 part는 0부터 시작하는 분할 인덱스를 써.

음과 화음은 현재 칸 또는 `/` 분할로 정해지는 part 공통 길이를 써. `-`는 앞 음이나 화음 전체를 이어지는 다음 탄현이나 쉼까지 유지해. 화음 구성음별 음가, 독립 성부 레인, 성부별 쉼, 화음 일부의 붙임줄은 지원하지 않아.

2026-10-19 결정: 음별 길이 접미사는 악보 음가와 자연 여운을 혼동시키고 자동 생성 입력을 복잡하게 해 제거했어. 기존 part 공통 길이와 자연 감쇠 경로를 쓰며, 독립 성부 scheduler나 별도 음가 입력 문법은 추가하지 않았어. 원자료 로망스의 독립 음가도 새 문법으로 옮겨 기록하지 않아.

hold part의 `durationUnits`는 그 위치부터 이어지는 유지 체인의 끝까지 남은 길이야. `tieFrom`은 hold만 갖는 `{measureIndex,beatIndex,subIndex}` 원음 위치야. `resolveHold(measures,part)`는 이어지는 원음 part 또는 `null`을 반환하고, `getSoundingNotes(measures,positionUnits)`는 그 시점에 `-`로 이어져 악보상 유지 중인 원음 또는 화음 전체와 남은 길이를 반환해.

원문 `tok`와 음·현·프렛·명시 왼손 운지·명시 오른손 운지(`:p`, `:i`, `:m`, `:a`)를 보존하고 리듬 파생 필드는 원문을 파싱해 다시 계산해. 오른손 운지는 표시용 metadata이며 음색, gain, 타이밍, 피치와 재생 동작에 영향을 주지 않아. `notationVersion`은 기존 2를 유지해. 분석 이벤트의 `part`는 실제 음 시작 part를 참조하며, 이벤트 배열을 곡에 저장해 순환 참조를 만들지 마. 잘못된 기존 악보를 자동으로 DB에 덮어쓰지 말고 원문을 보존해.

`parseScore`는 검증을 위해 `validateScore`를 호출해. `validateScore`가 `parseScore`를 다시 부르는 순환을 만들지 마. `src/notation.js`는 문장·칸 구조를 검증하고 `src/parser.js`가 음표와 코드 토큰 검사를 추가해.

## 재생 이벤트

`getBeatGuideEvents(beat, options)`와 `scheduleBeatGuide(beat, options)`는 `startTime`, `slotDuration`(초/한 칸), `measures`, `resumeHold`, `maxDurationSlots`, `capo`를 사용해. 이벤트 `when`은 `startTime + subIndex / 분할수 * slotDuration`, 각 음 이벤트의 `duration`은 그 part의 공통 `durationUnits / 12 * slotDuration`이야. 화음 구성음은 같은 시각에 시작하고 같은 part 길이를 받아.

note 이벤트는 `{kind:'note',note,duration,when,gain,articulation,str}`, rest 이벤트는 `{kind:'rest',when,duration}`이야. rest는 해당 시각의 기타 직접음을 정리해. gain은 명시한 아포얀도와 슬러(`SLUR_GAIN`, 오른손으로 다시 치지 않는 음이라 작게)만 바꾸고(값은 `src/guide.js`) 그 외는 1이야(티란도 표시는 2026-10-19에 문법에서 없앴어, [악보 문법](score-format.md)). 원문에 명시한 주법 설정만 전달하고 부모 분할 그룹의 주법을 자식에 전파하지 않아.

일반 진행에서 hold는 새 note-on을 만들지 않아. `resumeHold:true`는 `-`가 이어지는 위치에서 원음 또는 화음 전체를 남은 공통 길이로 한 번 복원해. 이 동작은 정지 상태 칸 미리듣기, 중간 시작, 루프 시작과 재생 도중 기타 시뮬레이션을 다시 켠 뒤의 다음 박에서 사용돼. 이전 재생의 자연 여운이나 리버브는 복원 대상이 아니고, 지속음 위치의 전체 반주를 과거부터 다시 합성하지 않아. 복원된 악보상 길이는 곡·loop 끝에서 잘리고, 그 뒤 내부 hold는 다시 치지 않아. 기존 스케줄러를 사용하며 중간 시각에 새 이벤트를 추가 예약하지 않아.

`maxDurationSlots`는 현재 칸 시작부터 재생·루프 끝까지 남은 칸 수야. 분할 위치를 고려해 이벤트를 루프 경계에서 잘라. `getSubdividedGuideEvents`와 `scheduleSubdividedGuide`는 `subStep`을 `slotDuration = subStep * subNotes.length`로 바꿔 공통 경로를 사용해. `getSubdividedGuideEvents` 반환값은 기존대로 note 이벤트만 포함해.

## 오디오 출력

`scheduleBeatGuide`는 실음 MIDI에 카포를 한 번 적용해. 구조화 악보 이벤트는 `event.duration`을 악보상 길이로 유지하면서 `playGuitarNote(..., {naturalDecay:true,hardStopAt})`에 전달하고, 음가 끝에서 note-off를 강제하지 않아. KS는 기존 버퍼가 가진 자연 감쇠를 따르고, classic은 기존 파형·배음·필터·어택을 보존하면서 공통 `getNaturalDecayProfile`의 음고·현 기반 감쇠 envelope를 사용해. 그래서 실제 여운 길이는 악보 음가와 다를 수 있어. `exactDuration` API는 내부 테스트나 명시 호출에 남아 있지만 구조화 가이드는 사용하지 않아.

- 콘서트홀 wet gain은 `CONCERT_HALL_WET_GAIN` 단일 상수를 초기 ON 라우팅과 실시간 ON 전환에서 함께 써. OFF는 0이고 dry gain과 전환 시간은 기존 값을 유지해. 이 값은 wet 잔향만 조절하며 음원·명시 길이·IR을 바꾸지 않아.
- 공유 마스터 compressor의 threshold는 여러 현이 동시에 날 때 생기는 순간 피크를 위한 여유를 두도록 낮춰 뒀어(`src/audio.js` compressor 생성부). ratio·knee·attack·release와 각 버스 gain은 기존 설정을 유지해.
- classic 음원의 저음 명료도를 위해 저음 권선현(`isBass`)에서만 필터 attack·decay cutoff에 하한 `CLASSIC_BASS_ATTACK_CUTOFF`·`CLASSIC_BASS_DECAY_CUTOFF`를 둬. 기존 주파수 배수 계산값이 더 높으면 그 값을 유지하며, 고음과 KS 음원은 바꾸지 않아.

## 재생음 정리와 시계

직접음을 정리하는 경계는 같은 현 재탄현, 전체 쉼, 사용자 정지, 곡 교체, 기타 시뮬레이션 끄기, 곡·loop 끝이야. 현·운지 이동만으로 소음을 추론하지 않아.

`stopGuitarNotes(when)`는 예약된 탄현과 직접음, 공명현 재생음을 함께 정리해. 정지, 곡 교체, 기타 시뮬레이션 끄기, 새 연습 시작 전에 이전 프리뷰나 예약음이 이어지지 않게 사용해. 만료 여부는 예약 시각이 아니라 실제 `actx.currentTime`을 기준으로 판단해. 미래의 쉼을 예약한 뒤에도 그 시각이 오기 전에 정지를 요청하면 종료를 앞당길 수 있어야 해. 이후 정지 요청이 기존 종료를 늦춰서는 안 돼. 메트로놈과 리버브 버스는 이 정리의 대상이 아니야.

재생 중 BPM 변경은 이미 울리는 음을 재합성하지 않고 이후 스케줄부터 반영해. 루프 경계에서 각 회차의 템포로 길이를 계산해. 새 재생 엔진이나 독립 성부 scheduler를 만들지 마.

검증은 이벤트 예약·음성 수명과 실제 청취 품질을 구분해. 명시하지 않은 주법, 독립 성부, 부모 주법 전파를 추가하지 마.
