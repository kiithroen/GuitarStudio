# 리듬과 오디오 유지보수 계약

이 문서는 `src/rhythm.js`, `src/guide.js`, `src/audio.js`가 공유하는 현재 동작을 설명해. 사용자가 입력하는 문법은 [악보 입력 형식](score-format.md), 일반 사용 흐름은 [사용 안내](usage.md)를 봐.
오디오 경로는 악보 이벤트와 메트로놈 소리를 출력하는 범위야. 마이크 입력 캡처나 입력음 분석은 포함하지 않아.

## 리듬 파생 정보

`GuitarRhythm.getGridInfo(slotsPerBar)`는 `{slotsPerBar,numerator,denominator,slotQuarterLength,bpmUnitLabel}`을 반환해. 6·9·12칸은 각각 6/8·9/8·12/8이고 한 칸은 4분음표 길이 기준 0.5야. 8칸은 4/4의 8분음표 칸(0.5), 나머지 유효한 1~12칸은 n/4 박자에 4분음표 칸(1)이야. UI에서 선택 가능한 칸 수는 2, 3, 4, 6, 8, 9야.

`GuitarRhythm.annotate(measures, slotsPerBar)`는 입력 `beats`와 `subNotes`를 시간순으로 분석하고 `{events,totalUnits,errors}`를 반환해. `UNITS_PER_SLOT`은 12야. 단일 part의 `kind`는 `note`, `rest`, `hold`, `invalid` 중 하나고, 분할 beat는 `group`이야. 각 part에는 `startUnits`, `slotUnits`, `durationUnits`, `tieFrom`이 붙어. `startUnits`는 곡 시작부터의 절대 정수 위치고 마디 시작은 `measureIndex * slotsPerBar * 12`야. `slotUnits`는 part 자체 길이(12 또는 12/분할수)야. 이벤트와 `tieFrom`의 위치 참조에서 일반 beat의 `subIndex`는 null이고 분할 part는 0부터 시작하는 분할 인덱스를 써.

음의 `durationUnits`는 뒤이은 연속 유지까지 포함한 길이야. hold의 값은 그 위치부터 유지 체인 끝까지 남은 길이고, rest는 자체 길이야. `tieFrom`은 hold만 갖는 `{measureIndex,beatIndex,subIndex}` 원음 위치야. `resolveHold(measures,part)`는 해당 실제 음 시작 part 또는 `null`을 반환해. 쉼은 체인을 끝내.

원문 `tok`와 음·현·프렛·명시 운지를 보존하고 리듬 파생 필드는 원문을 파싱해 다시 계산해. `notationVersion`은 기존 2를 유지해. 분석 이벤트의 `part`는 실제 음 시작 part를 참조하며, 이벤트 배열을 곡에 저장해 순환 참조를 만들지 마. 잘못된 기존 악보를 자동으로 DB에 덮어쓰지 말고 원문을 보존해.

`parseScore`는 검증을 위해 `validateScore`를 호출해. `validateScore`가 `parseScore`를 다시 부르는 순환을 만들지 마. `src/notation.js`는 문장·칸 구조를 검증하고 `src/parser.js`가 음표와 코드 토큰 검사를 추가해.

## 재생 이벤트

`getBeatGuideEvents(beat, options)`와 `scheduleBeatGuide(beat, options)`는 `startTime`, `slotDuration`, `measures`, `resumeHold`, `maxDurationSlots`, `capo`를 사용해. `slotDuration` 단위는 초/한 칸이야. 이벤트 `when`은 `startTime + subIndex / 분할수 * slotDuration`, `duration`은 `durationUnits / 12 * slotDuration`이야.

note 이벤트는 `{kind:'note',note,duration,when,gain,articulation,str}` 형태고 화음 구성음은 같은 시각과 길이로 나가. 명시 아포얀도 gain은 `1.16`, 티란도는 `0.62`, 그 외는 `1`이야. 원문에 명시한 주법 설정만 전달하고 부모 분할 그룹의 주법을 자식에 전파하지 않아. rest 이벤트 `{kind:'rest',when,duration}`는 해당 시각의 직접음을 정리해.

일반 진행에서 hold는 새 note-on을 만들지 않아. `resumeHold:true`는 현재 beat 첫 part가 hold일 때만 `resolveHold`가 찾은 원음을 한 번 재생해. 이 동작은 정지 상태 칸 미리듣기, 중간 시작, 루프 시작에 사용돼. 그 뒤 내부 hold는 다시 치지 않아.

`maxDurationSlots`는 현재 칸 시작부터 재생·루프 끝까지 남은 칸 수야. 분할 위치를 고려해 이벤트를 루프 경계에서 잘라. `getSubdividedGuideEvents`와 `scheduleSubdividedGuide`는 `subStep`을 `slotDuration = subStep * subNotes.length`로 바꿔 공통 경로를 사용해. `getSubdividedGuideEvents` 반환값은 기존대로 note 이벤트만 포함해.

`scheduleBeatGuide`는 실음 MIDI에 카포를 한 번 적용해. 구조화 악보 이벤트는 `playGuitarNote(..., {exactDuration:true})`를 사용해. 명시 음표 길이는 note-off 시작 시각이고, 자연 release는 콘서트홀에서 0.06초, 드라이에서 0.035초의 시간 상수로 감쇠하며 직접음은 note-off 뒤 0.4초 안에 끝나. classic 음원의 tone decay는 명시 note-off와 분리돼 기존 합성 음형을 유지해. 쉼, 사용자 정지, 곡 교체, 루프 끝 같은 강제 경계는 직접음을 최대 15ms 안에 정리해. KS 합성·공명·기존 사용자 설정은 유지해.

콘서트홀의 wet gain은 `CONCERT_HALL_WET_GAIN` 단일 상수 `0.35`를 초기 ON 라우팅과 실시간 ON 전환에서 함께 사용해. OFF는 `0`, dry gain은 기존 `0.88`과 40ms 전환을 유지해. 이 값은 wet 잔향만 조절하며 음원·명시 길이·IR을 바꾸지 않아.

공유 마스터 compressor의 threshold는 `-3dB`야. 여러 현이 동시에 날 때 생기는 순간 피크를 위한 여유를 두고, ratio·knee·attack·release와 각 버스 gain은 기존 설정을 유지해.

classic 음원의 저음 명료도를 개선하려고 MIDI 55 미만에서만 필터 attack cutoff를 최소 1200Hz, decay cutoff를 최소 600Hz로 둬. 기존 주파수 배수 계산값이 이보다 높으면 그 값을 유지하며, 고음과 KS 음원은 바꾸지 않아.

## 재생음 정리와 시계

`stopGuitarNotes(when)`는 예약된 탄현과 직접음, 공명현 재생음을 함께 정리해. 정지, 곡 교체, 기타 시뮬레이션 끄기, 새 연습 시작 전에 이전 프리뷰나 예약음이 이어지지 않게 사용해. 만료 여부는 예약 시각이 아니라 실제 `actx.currentTime`을 기준으로 판단해. 미래의 쉼을 예약한 뒤에도 그 시각이 오기 전에 정지를 요청하면 종료를 앞당길 수 있어야 해. 이후 정지 요청이 기존 종료를 늦춰서는 안 돼. 메트로놈과 리버브 버스는 이 정리의 대상이 아니야.

재생 중 BPM 변경은 이미 울리는 음을 재합성하지 않고 이후 스케줄부터 반영해. 루프 경계에서 각 회차의 템포로 길이를 계산해. 새 재생 엔진이나 독립 성부 scheduler를 만들지 마.

검증은 이벤트 예약·음성 수명과 실제 청취 품질을 구분해. 명시하지 않은 주법, 독립 성부, 부모 주법 전파를 추가하지 마.
