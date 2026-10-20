(function(root, factory){
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuitarScorePrompt = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';

  // 프롬프트 속 문법 예시. test-score-prompt.js 가 현재 파서로 읽히는지 확인한다.
  var EXAMPLE_BEATS = 4;
  var EXAMPLE_BPM = 64;
  var EXAMPLE_MEASURES = [
    '[Am] A2@5+1C4@2:i E4@1:m A3@3:p E4@1:m | "1포지션"',
    '[E] E2@6+B3@2 G#3@3/A3@3 B3@2? - | "꾸밈음 생략 · 확인: 3박 음 흐림"',
    '[-] !E4@1:a - r? C4/D4/E4 | "확인: 3박 판독 불가"'
  ];
  var EXAMPLE_TSV_ROW = ['예시 곡', String(EXAMPLE_BEATS), String(EXAMPLE_BPM), '원본 4/4 · 4분음표=64', EXAMPLE_MEASURES.join(' // ')].join('\t');

  // 음 길이 표(프롬프트 [문법 6]). test-score-prompt.js 가 각 notation 을 파서로 읽어 noteLengths 와 맞는지 확인한다.
  var RHYTHM_EXAMPLES = [
    { notation: 'E4', lengthText: '1', noteLengths: ['1'], quarter: '4분음표', eighth: '8분음표', dottedQuarter: '점4분음표' },
    { notation: 'E4 -', lengthText: '2', noteLengths: ['2'], quarter: '2분음표', eighth: '4분음표', dottedQuarter: '점2분음표' },
    { notation: 'E4 - -', lengthText: '3', noteLengths: ['3'], quarter: '점2분음표', eighth: '점4분음표', dottedQuarter: '' },
    { notation: 'E4 - - -', lengthText: '4', noteLengths: ['4'], quarter: '온음표', eighth: '2분음표', dottedQuarter: '점온음표' },
    { notation: 'E4/F4', lengthText: '1/2 + 1/2', noteLengths: ['1/2', '1/2'], quarter: '8분음표 둘', eighth: '16분음표 둘', dottedQuarter: '' },
    { notation: 'r/E4', lengthText: '쉼 1/2 + 1/2', noteLengths: ['1/2'], quarter: '8분쉼표 + 8분음표', eighth: '16분쉼표 + 16분음표', dottedQuarter: '' },
    { notation: 'E4 -/F4', lengthText: '3/2 + 1/2', noteLengths: ['3/2', '1/2'], quarter: '점4분음표 + 8분음표', eighth: '점8분음표 + 16분음표', dottedQuarter: '' },
    { notation: 'E4/F4/G4/A4', lengthText: '1/4 × 4', noteLengths: ['1/4', '1/4', '1/4', '1/4'], quarter: '16분음표 넷', eighth: '32분음표 넷', dottedQuarter: '' },
    { notation: 'E4/-/F4/G4', lengthText: '1/2 + 1/4 + 1/4', noteLengths: ['1/2', '1/4', '1/4'], quarter: '8분음표 + 16분음표 둘', eighth: '16분음표 + 32분음표 둘', dottedQuarter: '' },
    { notation: 'E4/F4/G4/-', lengthText: '1/4 + 1/4 + 1/2', noteLengths: ['1/4', '1/4', '1/2'], quarter: '16분음표 둘 + 8분음표', eighth: '32분음표 둘 + 16분음표', dottedQuarter: '' },
    { notation: 'E4/-/-/F4', lengthText: '3/4 + 1/4', noteLengths: ['3/4', '1/4'], quarter: '점8분음표 + 16분음표', eighth: '점16분음표 + 32분음표', dottedQuarter: '' },
    { notation: 'E4/F4/G4', lengthText: '1/3 × 3', noteLengths: ['1/3', '1/3', '1/3'], quarter: '8분음표 셋잇단', eighth: '16분음표 셋잇단', dottedQuarter: '8분음표 셋' },
    { notation: 'E4/-/F4', lengthText: '2/3 + 1/3', noteLengths: ['2/3', '1/3'], quarter: '셋잇단 4분음표 + 8분음표', eighth: '셋잇단 8분음표 + 16분음표', dottedQuarter: '4분음표 + 8분음표' },
    { notation: 'E4/F4/-', lengthText: '1/3 + 2/3', noteLengths: ['1/3', '2/3'], quarter: '셋잇단 8분음표 + 4분음표', eighth: '셋잇단 16분음표 + 8분음표', dottedQuarter: '8분음표 + 4분음표' },
    { notation: 'E4/F4 -/G4', lengthText: '1/2 + 1 + 1/2', noteLengths: ['1/2', '1', '1/2'], quarter: '당김음 8분-4분-8분', eighth: '당김음 16분-8분-16분', dottedQuarter: '' }
  ];

  var PROMPT_LINES = [
    '너는 기타 악보 이미지를 "기타 스튜디오"라는 연습 앱의 텍스트 악보로 옮기는 일을 맡았어. 이 앱의 형식은 아래 [문법]이 전부야. 다른 악보 형식(ABC, MusicXML, 일반 TAB 텍스트 등)의 관습을 섞지 말고 이 문법만 써.',
    '',
    '[작업 원칙]',
    '- 한 번에 끝까지 변환해. 멈추거나 되묻지 마. 결과는 사용자가 앱에서 직접 확인하고 고쳐.',
    '- 이미지에서 읽은 내용만 적어. 원본에 없는 음, 운지, 코드를 지어내지 마.',
    '- 이 문법으로 그대로 옮길 수 없는 부분은 원곡의 선율과 화성을 살려 가볍게 편곡해. 빼는 것도 편곡이야. 바꾼 내용은 그 마디 메모에 적어. 구체적인 처리는 [예외와 애매한 경우]에 있어.',
    '- 확실하지 않은 음은 가장 그럴듯한 값으로 적고 확인 표시 `?`를 붙여. 앱은 오류를 내지 않고 그 칸을 경고색으로 보여 줘.',
    '',
    '[출력]',
    '아래 네 가지를 이 순서로 내.',
    '1. 코드블록 밖: 제목, 원본 박자표와 고른 마디 칸 수(한 칸의 음표 길이), 원본 템포 표기와 환산한 BPM, 카포, 튜닝.',
    '2. 코드블록 하나: 악보 마디만, 한 줄에 한 마디. 설명을 섞지 마.',
    '3. 코드블록 하나: Google Sheets에 붙여 넣을 TSV 한 행. 열은 제목, 칸 수, BPM, 설명, 악보 다섯 개이고, 열 사이는 공백이 아니라 탭 문자 하나야. 악보 열은 2번과 같은 마디를 ` // `로 이어 붙여. 설명 열에는 원본 박자, 템포, 카포, 튜닝과 곡 전체에 걸친 변경을 짧게 적어.',
    '4. 코드블록 밖: 바꾸거나 확인 표시를 붙인 마디 번호 요약. 없으면 "없음".',
    '',
    '[문법 1: 곡과 마디]',
    '- 곡은 마디의 나열이야. 한 줄에 한 마디를 적어.',
    '- 마디 한 줄의 모양: `[코드] 칸 칸 ... 칸 | "메모"`',
    '- `[코드]`: 맨 앞에 꼭 있어야 해. 이미지에 적힌 코드 이름을 그대로 적어(예: `[Am]`, `[G7]`, `[F#m]`, `[C/G]`). 악보는 코드가 바뀌는 마디에만 이름을 적으니, 그 마디 위에 코드 이름이 없으면 앞에서 이어지는 코드를 적어(앞 마디 중간에 코드가 바뀌었으면 바뀐 뒤 코드). 곡 처음처럼 이어질 코드가 없거나 악보에 코드가 전혀 없으면 `[-]`. `[?]`는 앱에서 다른 뜻이라 쓰지 마.',
    '- 칸: 공백 하나로 구분해. 한 곡의 모든 마디는 칸 수가 똑같아야 해. 칸 수는 [문법 5]로 정해.',
    '- `| "메모"`: 큰따옴표로 감싼 한 줄 문자열. 비어 있으면 `""`. 문자열 안의 큰따옴표는 `\\"`, 역슬래시는 `\\\\`로 써. 줄바꿈과 탭은 넣지 마.',
    '',
    '[문법 2: 칸에 들어가는 것]',
    '한 칸에는 아래 다섯 가지 중 하나가 들어가.',
    '| 칸 내용 | 뜻 | 예 |',
    '|---|---|---|',
    '| 음 토큰 | 그 칸이 시작할 때 그 음을 쳐 | `E4`, `1C4@2:i` |',
    '| 화음 | 음 토큰 2개 이상을 공백 없이 `+`로 묶어 동시에 쳐 | `E2@6+B3@2+G4@1` |',
    '| `r` | 쉼. 그 순간 울리던 소리를 모두 멈춰 | `r` |',
    '| `-` | 유지. 바로 앞의 음이나 화음 전체를 다시 치지 않고 이어서 울려. 마디를 넘어가도 돼 | `-` |',
    '| 분할 | 위 네 가지를 공백 없이 `/`로 2개, 3개 또는 4개 이어 칸을 균등하게 나눠 | `E4/F4`, `C4/-/-/D4`, `E2@6+E4@1/G4` |',
    '- `-`는 곡 맨 앞이나 `r` 바로 뒤(분할 안 포함, 예: `r/-`)에 올 수 없어.',
    '- 괄호 `( )`, 쉼표 `,`, 점 `.`, 길이 표시(`*2` 같은 것), 한글 음이름은 쓰지 마.',
    '',
    '[문법 3: 음 토큰]',
    '음 토큰은 아래 자리를 이 순서대로 붙여 써. 꼭 있어야 하는 건 음이름과 옥타브뿐이고, 나머지는 해당할 때만 붙여.',
    '`[주법][왼손 손가락][음이름][변화표][옥타브][@줄 번호][:오른손 손가락][?]`',
    '| 자리 | 쓸 수 있는 값 | 언제 붙이나 | 예 |',
    '|---|---|---|---|',
    '| 주법 | `!` 아포얀도, `h` 자연 하모닉스, `s` 슬러(뒤 음), `g` 슬라이드(뒤 음) | 이미지에 적혀 있을 때만. 하모닉스는 @줄이 꼭 있어야 해. 슬러는 오른손으로 다시 치지 않는 뒤 음에. 앞 음과 같은 줄이어야 하고, 기본 줄이 다르게 잡히면 @줄을 붙여. 슬라이드도 슬러처럼 미끄러져 닿는 뒤 음에, 앞 음과 같은 줄 | `!E4`, `hF#5@2`, `E4/sF4`, `E3@4/gF#3@4` |',
    '| 왼손 손가락 | `0`~`4` | 이미지에 적혀 있을 때만 | `1C4` |',
    '| 음이름 | `C` `D` `E` `F` `G` `A` `B` (대문자) | 항상 | `G3` |',
    '| 변화표 | `#` 또는 `b` | 실제 음높이가 반음 올라가거나 내려갈 때 | `F#3`, `Bb2` |',
    '| 옥타브 | `2`~`5` | 항상 | `E2` |',
    '| 줄 번호 | `@1`~`@6` | 이미지에 TAB이나 동그라미 줄 번호(①~⑥)가 있을 때만 | `C4@2` |',
    '| 오른손 손가락 | `:p` `:i` `:m` `:a` | 이미지에 적혀 있을 때만 | `C4:i` |',
    '| 확인 표시 | `?` | 확실하지 않을 때만 | `E4?` |',
    '모두 붙인 예: `!1C4@2:i?` (아포얀도, 왼손 1번 손가락, C4, 2번 줄, 오른손 검지, 확인 필요).',
    '- 화음은 구성음마다 자기 운지를 붙여. 예: `C3@5:p+1C4@2:i`. 확인 표시는 화음 끝에 하나만 붙여도 돼. 예: `C3@5+E4@1?`.',
    '- 화음 앞에 세로 물결선(롤)이 있으면 화음 맨 앞에 `~`를 붙여. 예: `~E2@6+B3@2+G4@1`. 분할 조각이면 그 조각 앞에(`C3@5/~A3+D4+F#4`). 단음에는 붙이지 마.',
    '- 한 화음 안에서 같은 줄 번호를 두 번 쓰지 마.',
    '- `>`, `^`, 겹올림 `##`, 겹내림 `bb`는 쓰지 마. 겹올림·겹내림은 같은 음높이의 다른 이름으로 적어(F## → G).',
    '- 이미지에 없는 줄 번호, 운지, 주법은 추측하거나 앞뒤 음에서 이어 붙이지 마. TAB의 숫자는 프렛 번호지 손가락 번호가 아니야.',
    '',
    '[문법 4: 음높이]',
    '- 옥타브 번호는 가운데 도를 C4로 하는 표기야. 옥타브 숫자는 C에서 바뀌어(B3 다음이 C4).',
    '- 음높이는 실제로 울리는 소리로 적어. 카포가 있으면 [예외와 애매한 경우]의 카포 줄을 따라.',
    '- 표준 튜닝 개방현: 1번 줄 E4, 2번 줄 B3, 3번 줄 G3, 4번 줄 D3, 5번 줄 A2, 6번 줄 E2.',
    '- TAB이 있으면 음높이 = 그 줄의 개방현에서 프렛 수만큼 반음 올린 음이야. 오선보가 같이 있으면 서로 대조해.',
    '- 오선보만 있으면: 기타 오선보는 실제 소리보다 한 옥타브 높게 적혀 있어. 오선에서 읽은 음이름의 옥타브 숫자에서 1을 빼(오선 아래 덧줄 하나의 도 → C3, 오선 맨 위 칸의 미 → E4).',
    '- 조표와 임시표는 앱이 적용하지 않아. 음마다 실제 음높이를 `#`, `b`로 적어. 임시표는 그 마디 끝까지 같은 높이의 음에 적용되고 다음 마디에서 풀려.',
    '- 앱이 받는 음역은 E2~B5(0~19프렛)야. `@줄 번호`를 붙인 음은 그 줄 개방현부터 19반음 위까지만 돼. 맞지 않으면 줄 번호를 빼.',
    '',
    '[문법 5: 박자, 칸, 템포]',
    '칸 하나가 메트로놈 클릭 한 번이야. 원본 박자표로 마디 칸 수와 한 칸의 길이를 정해.',
    '| 원본 박자 | 마디 칸 수 | 한 칸의 길이 |',
    '|---|---|---|',
    '| 2/4, 3/4, 4/4 | 2, 3, 4 | 4분음표 |',
    '| 2/2 | 4 | 4분음표 |',
    '| 3/8 | 3 | 8분음표 |',
    '| 6/8, 9/8 | 6, 9 | 8분음표 |',
    '| 6/8, 9/8 (6칸·9칸으로 BPM이 240을 넘을 때) | 2, 3 | 점4분음표(칸 안을 3분할) |',
    '| 12/8 | 4 | 점4분음표(칸 안을 3분할) |',
    '| 4/4 (4칸으로 BPM이 30보다 작거나, 32분음표가 많을 때) | 8 | 8분음표 |',
    '- 셋잇단이 있으면 셋잇단 한 묶음이 한 칸에 들어가는 칸 수를 골라(4/4의 8분음표 셋잇단이면 4칸).',
    '- 표에 없는 박자(5/4, 7/8 등)는 [예외와 애매한 경우]를 따라.',
    '- BPM은 1분에 진행하는 칸 수야. BPM = 인쇄된 템포 × (템포 음표의 길이 ÷ 한 칸의 길이). 예: 4분음표=60이고 한 칸이 8분음표면 120, 점4분음표=60이고 한 칸이 8분음표면 180, 2분음표=60이고 한 칸이 4분음표면 120.',
    '- BPM은 30~240 사이의 정수여야 해. 240을 넘으면 더 긴 칸을 고르고(8칸 대신 4칸, 6/8의 6칸 대신 2칸), 30보다 작으면 더 짧은 칸을 골라(4칸 대신 8칸). 정수가 아니면 반올림하고 설명 열에 원본 템포를 적어.',
    '- 템포가 적혀 있지 않으면 64로 두고, 이미지에서 읽은 값이 아니라고 밝혀.',
    '',
    '[문법 6: 음 길이 적는 법]',
    '음은 시작하는 칸(또는 분할 조각)에 적고, 남은 길이는 `-`로 채워. 아래 표의 길이는 칸 단위고, 마디의 나머지 칸은 생략했어.',
    '{{RHYTHM_TABLE}}',
    '- 붙임줄로 이어진 음은 길이를 더한 한 음으로 적어(뒤쪽은 `-`). 마디를 넘어가도 돼.',
    '- 모든 음의 시작이 칸의 시작이나 칸을 2·3·4로 균등하게 나눈 지점에 와야 해. 맞지 않으면 [예외와 애매한 경우]를 따라.',
    '',
    '[문법 7: 여러 성부]',
    '- 앱은 화음 구성음마다 길이를 따로 갖지 못해. 저음과 선율처럼 길이가 다른 성부는 각 음이 시작하는 칸에 `+`로 합쳐 적고, 앞서 시작한 음이 계속 울리는 칸에는 새로 시작하는 음만 적어. 아무 음도 새로 시작하지 않는 칸은 `-`야. 다른 줄의 음은 자연스럽게 계속 울려.',
    '- 한 성부만 쉬고 다른 성부가 계속 울리는 자리는 `r`이 아니라 `-`로 적어. `r`은 모든 소리를 멈추기 때문이야.',
    '- 곡 전체가 이런 식이면 설명 열에 한 번만 적고, 일부 마디만 그렇다면 그 마디 메모에 적어.',
    '',
    '[예외와 애매한 경우]',
    '처리한 마디의 메모에 무엇을 했는지 짧게 적어. 메모 예는 그대로 쓰지 않아도 돼.',
    '| 상황 | 처리 | 메모 예 |',
    '|---|---|---|',
    '| 음이 흐리거나 확실하지 않음 | 가장 그럴듯한 음을 적고 `?` | 확인: 2박 음 흐림 |',
    '| 칸 전체를 읽을 수 없음 | `r?` | 확인: 3박 판독 불가 |',
    '| 코드 이름을 읽을 수 없음 | `[-]` | 확인: 코드 흐림 |',
    '| 한 마디에 코드가 여럿 | 첫 코드를 머리표에, 나머지는 메모에 | 3박부터 G7 |',
    '| 음역(E2~B5) 밖의 음 | 옥타브를 옮겨 범위 안으로 넣고 `?` | E6 → E5 |',
    '| 칸 분할에 맞지 않는 리듬(5연음 등) | 가장 가까운 분할 지점으로 옮기고 옮긴 음에 `?` | 5연음 → 4분할 |',
    '| 꾸밈음 | 빼 | 꾸밈음 생략 |',
    '| 슬러, 해머링, 풀링(다른 높이로 잇는 곡선, H·P 표시) | 뒤 음에 `s`를 붙여(앞 음과 같은 줄, 사이에 쉼 없이). 같은 높이를 잇는 붙임줄은 `-` | 메모 없음 |',
    '| 두 음을 잇는 슬라이드·글리산도(S, sl., gliss., 두 음 사이 직선) | 뒤 음에 `g`를 붙여(앞 음과 같은 줄, 사이에 쉼 없이). 뒤 음을 다시 치라는 표시가 있어도 `g` | 메모 없음 |',
    '| 출발 음이 없는 글리산도(음 앞뒤의 짧은 사선·곡선) | 빼고 그 음만 적어 | 글리산도 생략 |',
    '| 트레몰로 | 첫 음만 적고 나머지 길이는 `-` | 트레몰로 → 한 번 |',
    '| 아르페지오 롤(화음 앞 세로 물결선) | 화음 맨 앞에 `~`를 붙여(`~E2+B3+G4`). 아래로 굴리는 롤도 `~`로 | 아래로 굴리는 롤만: 롤 방향 위로 |',
    '| 라스게아도, 스트로크 | 구성음을 `+`로 묶은 화음 한 번 | 스트로크 → 동시에 |',
    '| 자연 하모닉스(12·7·5·4프렛) | `h`를 붙여 실제로 울리는 음높이로 적고 `@줄`을 꼭 붙여. B줄 7프렛 → `hF#5@2`. 하모닉스만은 음역(E2~B5)을 넘어도 되고 옥타브 6도 그대로 적어(1번 줄 5프렛 → `hE6@1`). 이 네 프렛이 아닌 하모닉스와 인공 하모닉스는 실제 음높이의 보통 음으로 | 하모닉스 |',
    '| 티란도 표시(i·m·a 위 기호 등) | 적지 않아(표시 없는 음이 티란도) | 티란도 표시 생략 |',
    '| 벤딩, 비브라토, 골페, 피치카토 등 그 밖의 주법 | 원래 음만 적어 | 벤딩 |',
    '| 셈여림, 빠르기 변화(rit., accel.), 페르마타 | 음은 그대로 둬 | rit. · 페르마타 |',
    '| 포지션(CV 등), 바레 | 음은 그대로 둬 | CV · 바레 |',
    '| 가사 | 음은 그대로 둬 | 가사 그대로 |',
    '| 도돌이표, D.C., D.S., 1·2번 괄호 | 연주 순서대로 마디를 펼쳐 적어 | 펼친 첫 마디에: 도돌이 펼침 |',
    '| 못갖춘마디 | 앞을 `r`로 채워 온마디로 만들고, 마지막 마디의 모자란 칸도 `r`로 채워 | 못갖춘마디 |',
    '| 곡 중간에 박자가 바뀜 | 가장 많이 쓰인 박자로 칸 수를 고르고, 칸이 모자란 마디는 뒤를 `r`로 채우고, 넘치는 마디는 두 마디로 나눠 모자란 칸을 `r`로 채워 | 원본 3/4 |',
    '| 표에 없는 박자(5/4, 7/8 등) | 표의 칸 수 하나를 골라 원본 마디줄은 무시하고 리듬 그대로 다시 마디를 나눠. 끝은 `r`로 채워 | 설명 열에: 원본 5/4, 다시 마디 나눔 |',
    '| 표준이 아닌 튜닝(6번 줄을 D로 내림 등) | 실제로 울리는 음높이로 적고 줄 번호 `@`는 생략. 음역 밖은 위 음역 규칙 | 설명 열에: 원본 튜닝 |',
    '| 카포 | 설명 열에 `Capo 2`처럼 적고, 음은 카포가 없는 것처럼 TAB의 프렛 그대로 계산해. 앱이 재생할 때 카포만큼 올려 | 설명 열에: Capo 2 |',
    '| 템포 표기가 없음 | BPM 64 | 코드블록 밖에서 밝혀 |',
    '| 그 밖에 이 문법으로 옮길 수 없는 것 | 원곡의 선율과 화성을 살려 가볍게 편곡하거나 빼. 원본에 없는 음은 더하지 마 | 바꾼 내용 |',
    '- 한 마디의 메모는 원본 표기와 처리 내용을 ` · `로 이어 적어. 예: `"CV · 꾸밈음 생략 · 확인: 3박 음 흐림"`.',
    '',
    '[출력 전 점검]',
    '- 모든 마디가 `[코드]`로 시작하고, 칸 수가 모두 같아?',
    '- 모든 음에 대문자 음이름과 옥타브(2~5)가 있고, E2~B5 안이야?',
    '- `-`가 곡 맨 앞이나 `r`, `r?` 바로 뒤에 없어?',
    '- 분할은 2·3·4개이고, 공백 없이 붙어 있어?',
    '- `@줄 번호`를 붙인 음이 그 줄에서 0~19프렛 안이야? 한 화음에 같은 줄 번호가 두 번 나오지 않아?',
    '- 메모가 마디마다 큰따옴표 문자열 하나야?',
    '- TSV가 탭 4개로 나뉜 5열이고, 제목과 설명에 탭이 없어? BPM이 30~240 사이의 정수야?',
    '',
    '[예시: 실제 변환 결과가 아님]',
    '4칸(한 칸이 4분음표) 마디 세 개의 예시야. 문법만 참고하고 내용을 결과에 복사하지 마.',
    '{{EXAMPLE_MEASURES}}',
    '',
    '같은 예시의 TSV 한 행(열 사이는 탭):',
    '{{EXAMPLE_TSV}}'
  ];

  function buildRhythmTableLines(){
    var rows = ['| 표기 | 길이(칸) | 한 칸이 4분음표일 때 | 한 칸이 8분음표일 때 | 한 칸이 점4분음표일 때 |', '|---|---|---|---|---|'];
    RHYTHM_EXAMPLES.forEach(function(e){
      rows.push('| ' + ['`' + e.notation + '`', e.lengthText, e.quarter, e.eighth, e.dottedQuarter].join(' | ') + ' |');
    });
    return rows;
  }

  function buildScoreImagePrompt(){
    var lines = [];
    PROMPT_LINES.forEach(function(line){
      if (line === '{{EXAMPLE_MEASURES}}') EXAMPLE_MEASURES.forEach(function(m){ lines.push(m); });
      else if (line === '{{EXAMPLE_TSV}}') lines.push(EXAMPLE_TSV_ROW);
      else if (line === '{{RHYTHM_TABLE}}') buildRhythmTableLines().forEach(function(l){ lines.push(l); });
      else lines.push(line);
    });
    return lines.join('\n');
  }

  // 저장소를 읽고 명령을 실행할 수 있는 AI용 짧은 프롬프트. 문법과 변환 규칙은 문서와 buildScoreImagePrompt() 를 가리킨다.
  var PROJECT_PROMPT_LINES = [
    '첨부한 기타 악보 이미지를 이 저장소(기타 스튜디오)의 텍스트 악보로 옮겨 줘. 저장소 파일을 읽고 명령을 실행할 수 있다고 가정할게.',
    '',
    '1. `Docs/score-format.md`(악보 문법)를 읽어. 문법은 이 문서가 전부야.',
    '2. 아래 명령으로 변환 규칙을 출력해서 따라. [작업 원칙], [문법 5]~[문법 7], [예외와 애매한 경우]가 핵심이고, [출력] 절 대신 아래 3~5번을 따라. 규칙과 문서가 다르면 문서를 따라.',
    '   node -e "process.stdout.write(require(\'./src/score-prompt.js\').buildScoreImagePrompt())"',
    '3. 결과를 `Temp/scores/<제목>.tsv`에 TSV 한 행(제목, 칸 수, BPM, 설명, 악보를 탭으로 나눔)으로 저장해. 파일 이름에서 `\\ / : * ? " < > |`는 빼.',
    '4. `node tools/check-score.js Temp/scores/<제목>.tsv`로 검사하고 오류가 0이 될 때까지 고쳐. 확인 표시 `?`는 오류가 아니니 그대로 둬. 원본을 다시 읽어 확신이 생긴 음만 `?`를 지워.',
    '5. 채팅에는 원본 박자표, 고른 칸 수, 원본 템포와 BPM, 카포, 튜닝을 적고, TSV 한 행을 코드블록으로, 바꾸거나 `?`를 붙인 마디 요약과 저장한 파일 경로를 적어.',
    '',
    '이 작업에서는 `Temp/scores/` 밖의 파일을 고치지 말고, 커밋하거나 푸시하지 마.'
  ];

  function buildProjectPrompt(){
    return PROJECT_PROMPT_LINES.join('\n');
  }

  var COPY_OK = '프롬프트를 복사했습니다. AI 채팅에 악보 이미지와 함께 붙여 넣고, 받은 TSV 한 행을 Google Sheets 빈 행 A열에 붙여 넣으세요.';
  var COPY_PROJECT_OK = '프로젝트 AI용 프롬프트를 복사했습니다. 저장소를 연 AI 채팅에 악보 이미지와 함께 붙여 넣으세요.';
  var COPY_FAIL = '클립보드에 복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하세요.';

  // 클립보드 API 가 없거나 거부될 때 쓰는 대체 복사
  function copyWithTextarea(text){
    var area = document.createElement('textarea');
    var ok = false;
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.appendChild(area);
    try {
      area.select();
      ok = document.execCommand('copy') === true;
    } catch (e) {
      ok = false;
    } finally {
      document.body.removeChild(area);
    }
    return ok;
  }

  async function copyText(text){
    if (navigator.clipboard && navigator.clipboard.writeText){
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // 대체 경로로 넘어간다
      }
    }
    return copyWithTextarea(text);
  }

  function bindCopyButton(id, buildText, okText){
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', async function(){
      var ok = await copyText(buildText());
      var status = document.getElementById('scorePromptStatus');
      if (!status) return;
      status.hidden = false;
      status.textContent = ok ? okText : COPY_FAIL;
    });
  }

  function initScorePromptButton(){
    bindCopyButton('copyScorePromptBtn', buildScoreImagePrompt, COPY_OK);
    bindCopyButton('copyProjectPromptBtn', buildProjectPrompt, COPY_PROJECT_OK);
  }

  return {
    EXAMPLE_BEATS: EXAMPLE_BEATS,
    EXAMPLE_BPM: EXAMPLE_BPM,
    EXAMPLE_MEASURES: EXAMPLE_MEASURES,
    EXAMPLE_TSV_ROW: EXAMPLE_TSV_ROW,
    RHYTHM_EXAMPLES: RHYTHM_EXAMPLES,
    PROJECT_PROMPT_LINES: PROJECT_PROMPT_LINES,
    buildScoreImagePrompt: buildScoreImagePrompt,
    buildProjectPrompt: buildProjectPrompt,
    copyText: copyText,
    initScorePromptButton: initScorePromptButton
  };
});
