# 초보용 악보 해석 정확성 개선 사양

## 1. 범위와 보존

현재 main의 타브/박자 카드, 프렛·명시 왼손 운지, 지판, 이미지 악보와 메트로놈, 시트/개인 악보, 기존 KS/classic 합성기와 음색 설정을 보존한다. alphaTab을 도입하거나 화면을 다시 설계하지 않는다. 독립 음가 성부, 화음 일부만의 붙임줄, 슬러/꾸밈음, 못갖춘마디/가변 박자/반복 기호 해석은 이번 범위 밖이다. 사진 변환 프롬프트는 미지원 내용을 단순화하지 말고 이미지 모드 사용을 안내한다.

Temp/와 test-artifacts/의 기존 미추적 자료는 변경·삭제·커밋하지 않는다. 이번 검수 스크린샷은 test-artifacts/에 새 파일로 추가하되 커밋하지 않는다. 실험 브랜치 codex/alphatab-player도 수정하지 않는다. 검수/필수 검사 후 메인이 현재 main 변경만 커밋·일반 push한다.

## 2. 입력 의미

- r 또는 R: 명시적 쉼. 이전 음/화음을 끝내며 다음 유지의 출발점이 될 수 없다. 새 도움말/패드는 r을 사용한다.
- -: 바로 앞 음/화음 전체를 연장한다. 다시 탄현하지 않는다. 마디 경계를 넘어도 연결한다. 악보 시작 또는 쉼 뒤의 -는 ORPHAN_HOLD 오류다.
- .: 의미가 모호하므로 신규 입력에서 AMBIGUOUS_REST_TOKEN 오류로 안내한다. r 또는 -로 고치도록 한다. 원문을 자동으로 바꾸지 않는다.
- +: 동시에 치는 겹음/화음이다. 모든 구성음은 같은 시각, 같은 명시 길이로 재생한다. 자동 롤, 저음 지연/길이 가산, 음높이에 따른 강조를 추가하지 않는다. 원문에 적은 !/>/^와 ~의 명시 주법은 유지한다.
- /: 한 칸을 균등 분할한다. 2/3/4분할을 지원하고 그 외 개수는 UNSUPPORTED_SUBDIVISION 오류다. 분할 안의 r과 -도 위와 동일하다. 예: C4/-/-/D4는 앞 음 3/4칸과 뒤 음 1/4칸이다.
- 마디 구분은 기존대로 // 또는 줄바꿈, 가사는 JSON 문자열이다. 명시 왼손 운지/현 번호 문법과 표시를 변경하지 않는다.
- 마디 칸이 부족하면 MISSING_BEATS를 오류로 반환한다. 미리보기용 파싱도 실제 입력 칸만 보존하며 -/r로 부족분을 자동 채우지 않는다. 초과 칸도 오류다. 의도적 짧은 마디는 이번 텍스트 형식에서 지원하지 않는다.

## 3. 공통 리듬 모듈 src/rhythm.js

DOM 없는 UMD 모듈이다. 브라우저 전역 GuitarRhythm, Node CommonJS로 제공한다. index 순서는 notation, rhythm, parser, score를 지킨다.

- UNITS_PER_SLOT = 12. 지원하는 균등 분할을 정수로 계산한다.
- getGridInfo(slotsPerBar): {slotsPerBar,numerator,denominator,slotQuarterLength,bpmUnitLabel}. 6/9/12칸은 각각 6/8,9/8,12/8이며 한 칸은 8분음표(quarterLength 0.5), 8칸은 4/4의 8분음표(0.5), 그 외 기존 유효 1~12칸은 n/4의 4분음표(1). bpmUnitLabel은 '8분음표 한 칸' 또는 '4분음표 한 칸'이다.
- annotate(measures,slotsPerBar): 입력 beats/subNotes의 파싱 결과를 시간순으로 분석하고 파생 리듬 필드를 붙인다. 반환 {events,totalUnits,errors}. events는 음 시작 단위/총 길이/원본 구성음을 가진 분석 결과이며 Score나 Song에 순환 참조로 저장하지 않는다.
- resolveHold(measures,part): part.tieFrom의 실제 음 시작 part를 반환한다. 없거나 잘못된 참조는 null. 새로운 운지/음/성부를 추정하지 않는다.

각 단음/화음/쉼/유지 part의 필드:

- kind: 'note'|'rest'|'hold'|'invalid'. subdivided 부모 beat는 kind:'group'.
- startUnits: 곡 시작부터의 정수 위치. 한 마디 시작은 measureIndex*slotsPerBar*12.
- slotUnits: 현재 part 자체 길이(12 또는 12/분할수).
- durationUnits: note는 뒤따르는 연속 유지까지 합친 총 길이, hold는 해당 위치부터 그 유지 체인의 끝까지 남은 길이, rest는 자기 길이.
- tieFrom: hold만 {measureIndex,beatIndex,subIndex}; 일반 beat의 subIndex는 null, 나머지는 null.

원문 tok와 파싱된 모든 음/현/프렛/명시 운지는 보존한다. rest가 체인을 끊는다. 각 note/chord 전체를 하나의 체인으로 다루며 독립 음가를 발명하지 않는다. 소수 시간 누적 대신 12단위로 경계를 계산한다.

parser.parseScore/validateScore/buildStructuredSong은 같은 진단을 공유한다. parseScore 내부에서 validateScore를 다시 호출하는 순환을 만들지 않는다. 기존 코드 사전 경고 등은 보존한다. notationVersion은 기존 2를 유지하며 리듬 필드는 tok로부터 재계산하는 파생값이다. 구형 문법 파서나 데이터 변환 프레임워크를 추가하지 않는다.

기존 songs.json의 선행 무음 11칸만 r로 명시한다: clementine 첫 마디 1~2칸, brahms 첫 마디 1~2칸, amazinggrace 첫 마디 1~2칸, greensleeves 첫 마디 1~5칸(id는 builtin-lv3-/builtin-lv4- 기존 접두). 이는 앞 음이 없어 유지할 수 없었던 위치다. 나머지 음/손가락/제목/BPM/칸 수/곡 수는 바꾸지 않는다.

## 4. 표시와 안내

getBeatDurationInfo는 파생 durationUnits와 getGridInfo의 음표 단위를 사용한다. 쉼은 '쉼', 유지는 '유지'로 구분한다. 지원하지 않는 길이를 가까운 온음/2분음표 등으로 반올림하지 않고 실제 칸 길이를 표시한다. 분할 part의 점8분·16분 등 길이도 잘못 동일한 음가로 표시하지 않는다.

기존 타브의 숫자 알약과 괄호 운지는 그대로 유지한다. hold에는 별도 유지/붙임 표식을, rest에는 쉼 표식을 사용한다. 단순 원문 유지 체인은 마디를 넘어도 표시로 구분한다. 자동 롤 화살표와 자동 아포얀도/티란도 표시·계산을 제거한다. 원문 명시 주법 표시는 유지한다.

패드에 r(쉼)과 -(앞 음 유지)를 별도로 제공한다. 새 마디의 빈 칸은 명시적 r로 생성한다. 키보드 Space/0은 쉼(r), -는 유지, r/R도 쉼이다. 두 토큰을 화음에 합치지 않는다. 기존 메타데이터/이미지/명시 운지/저장 실패 보호를 유지한다.

입력 부족/모호한 점/고아 유지는 저장과 TSV 내보내기를 막고 위치를 알린다. 원문/마지막 정상 미리보기를 덮지 않는다. 저장된 structured 곡도 선택 시 tok를 통해 리듬을 재계산한다. 유효하지 않은 기존 개인곡은 삭제하지 않고 편집을 허용하되 재생을 막고 오류 위치를 안내한다. 오류 원문을 자동 교정해 DB에 덮어쓰지 않는다.

박자 셀/BPM 숫자와 저장값은 유지한다. 한 클릭은 한 칸이며 BPM은 분당 진행하는 칸 수임을 명시한다. 9칸은 기존 UI 주 표기인 9/8로 고정하고 '3박 셋잇단', '3/4 환산' 혼용을 제거한다. 3/4 셋잇단은 3칸에서 각 칸을 /로 3분할한다. AI 프롬프트도 같은 뜻을 설명하고, 인쇄 템포의 음표 단위가 다르면 환산값과 원본값을 구분한다.

## 5. 재생 계약

guide.js에 getBeatGuideEvents(beat,options), scheduleBeatGuide(beat,options)를 둔다. options={startTime,slotDuration,measures,resumeHold,maxDurationSlots,capo}. slotDuration은 한 칸의 초 단위 길이다. capo는 schedule에서 실제 MIDI로 바꿀 때 한 번 적용한다.

- note event는 {kind:'note',note,duration,when,gain,articulation,str}. duration=durationUnits/12*slotDuration, when=startTime+subIndex/분할수*slotDuration. 모든 chord 구성음은 같은 when과 duration. gain은 원문 명시 주법에 따른 기존 설정만 보존하고 저음 순서로 추정 가산하지 않는다.
- rest event는 {kind:'rest',when,duration}. scheduleBeatGuide는 시간순으로 처리하며 해당 시각의 기타 직접음을 끊는다. 리버브의 자연스러운 잔향까지 강제로 끄지는 않는다.
- hold는 일반 진행에서 note-on 없음. resumeHold:true이면 첫 part가 hold인 경우에만 원래 음/화음을 한 번 재생한다(유지 위치에서 클릭 미리듣기, 중간 시작, 루프 시작). 그 뒤의 내부 유지는 다시 치지 않는다.
- maxDurationSlots는 현재 칸 시작부터 재생/루프 끝까지 남은 칸 수이며, note duration이 루프 경계를 넘지 않게 sub offset까지 고려해서 자른다.
- 기존 getSubdividedGuideEvents/scheduleSubdividedGuide는 하위 호출을 위 계약으로 연결한다. subStep 옵션은 slotDuration=subStep*subNotes.length로 대응한다. getSubdividedGuideEvents의 반환은 기존대로 note event만이다.
- 실제 playGuitarNote 호출의 MIDI에는 카포를 한 번만 더한다. 미리듣기/런타임은 동일 helper를 사용한다.

audio.js의 기존 음원/필터/KS 생성/공명·음색 설정은 유지한다. playGuitarNote의 7번째 선택 인수 {exactDuration:true}를 추가해서 위 helper로 호출한 구조화 악보만 명시 길이에 맞춰 직접음을 종료한다(짧은 해제 꼬리 15ms 이내). 기존 음가 배율/최소 0.18~0.35초/75% 시점 해제를 정확 경로에 적용하지 않는다. 일반 지판·튜너·이미지 호출의 기존 음색 경로는 유지한다.

audio.js에 stopGuitarNotes(when)를 제공해 직접음/공명현 보이스 및 예약된 탄현을 정리한다. 정지/곡 교체/가이드 끄기/재생 위치 변경 시 이전 소리가 새 위치로 흘러가지 않게 한다. 메트로놈이나 마이크 상태를 바꾸지 않는다. 시간순 rest 처리 뒤의 새 note-on을 잘못 지우지 않는다.

기존 메트로놈/커서/카운트인/연습 통계 기능은 보존한다. 재생 중 BPM 변경은 기존처럼 이후 스케줄 음부터 적용하며 이미 울리는 음을 새로 합성해 다시 치지 않는다. 루프/시작 경계의 길이는 그 회차의 tempo로 계산한다. 새로운 재생 엔진이나 독립 성부 scheduler를 만들지 않는다.

## 6. 검증과 완료

- 구문 검사 src/test 전체. parser/notation/rhythm 단위: rest/hold 구분, 고아 유지, 박 부족/초과, 마디 넘는 체인, 점음표/2·3·4 분할, 화음 전체 유지, r 체인 단절, 14곡 전체 유효성, 운지/현/카포 보존.
- guide/audio 단위: 모든 구성음 동시 onset, 명시 길이와 cutoff, 쉼 종료, 내부 유지 note-on 0, 중간 시작/loop 재개 1회, 끝 경계 clipping, 카포 1회, 기존 합성기/공명 경로 회귀.
- 기존 image/storage/sheets/VM 검사 유지. 초보용 문법/프롬프트/패드/마디 검증과 메타데이터 저장 보호를 확인한다.
- 브라우저 한 에이전트 독점: 실제 기존 TAB/괄호 운지/지판/이미지 모드/커서·메트로놈·편집저장/새로고침, rest/hold/마디 넘는 체인/동시 chord, invalid 저장/TSV 차단, 콘솔 오류. 실제 화면 screenshot은 test-artifacts에 저장해 메인이 검수한다. 오디오 스케줄 검증과 실제 청취를 구분한다.
- 모든 diff와 실제 결과를 메인이 검수한 뒤 현재 작업 파일만 main에 커밋·push한다. 빌드 단계나 외부 의존성을 추가하지 않는다.
