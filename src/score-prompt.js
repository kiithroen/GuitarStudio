(function(root, factory){
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuitarScorePrompt = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';

  // 우리 악보 한 행의 예. 사진 변환 프롬프트가 아니라 검사 도구(test-check-score.js)와 시트 가져오기 스크립트(test-sheet-import-script.js)의 시험 자료다.
  var EXAMPLE_BEATS = 4;
  var EXAMPLE_BPM = 64;
  var EXAMPLE_MEASURES = [
    '[Am] A2@5+1C4@2:i E4@1:m A3@3:p E4@1:m | "1포지션"',
    '[E] E2@6+B3@2 G#3@3/A3@3 B3@2? - | "꾸밈음 생략 · 확인: 3박 음 흐림"',
    '[-] !E4@1:a - r? C4/D4/E4 | "확인: 3박 판독 불가"'
  ];
  var EXAMPLE_TSV_ROW = ['예시 곡', String(EXAMPLE_BEATS), String(EXAMPLE_BPM), '원본 4/4 · 4분음표=64', EXAMPLE_MEASURES.join(' // ')].join('\t');

  // 우리 문법의 음 길이 표(Docs/score-format.md). test-score-prompt.js 가 각 notation 을 파서로 읽어 noteLengths 와 맞는지 확인한다.
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

  // 사진 → alphaTex 프롬프트 속 예시 악보. test-score-prompt.js 가 alphaTab(vendor/alphatab)으로 읽어 진단이 0인지,
  // tools/alphatab-to-score.js 로 바꾼 우리 악보가 검사 오류 0인지 확인한다. 알려진 alphaTex 표기는 Docs/alphatab.md 의 사진 변환 절.
  var ALPHATEX_EXAMPLES = [
    {
      caption: '예시 1: TAB이 있는 곡(모든 음이 프렛.줄). 카포, 도돌이, 섹션, 화음 이름, 롤, 해머링, 슬라이드, 셋잇단, 자연 하모닉스, 점음표, 꾸밈음, 페르마타, 붙임줄, 운지, 메모.',
      lines: [
        '\\title "예시 곡 (TAB 있음)"',
        '\\notices "교본 12쪽 · 작곡가 미상 · 원본 템포 4분음표=72 · Capo 2"',
        '\\tempo (72)',
        '\\ts (4 4)',
        '\\capo 2',
        '\\ro \\section ("A") (0.6 2.4{lf 2} 2.3{lf 3} 1.2{rf 3}).4 {ch "Am" ad} 0.1{h rf 4}.8 2.1.8 3.2{sl}.4 5.2.4 |',
        '0.1.8 {tu 3} 1.1.8 {tu 3} 3.1.8 {tu 3} 12.2{nh}.4 3.1.4 {d txt "리타르단도"} 0.2.8 |',
        '\\rc 2 3.2.16 {gr} 5.2.2 {fermata medium} 5.2{t}.2 |'
      ]
    },
    {
      caption: '예시 2: 오선만 있는 곡(모든 음이 음이름). 두 성부(긴 저음 + 선율), 못갖춘마디, 섹션, 점음표, 페르마타, 임시표, 화음, 붙임줄, 확인 표시.',
      lines: [
        '\\title "예시 곡 (오선만)"',
        '\\notices "교본 30쪽 · 템포 표기 없음(64 가정)"',
        '\\tempo (64)',
        '\\ts (3 4)',
        '\\voice',
        '\\ac r.4 | \\section ("A") C3.2 {d} | G2.2 {d txt "선율 아포얀도"} | C3.2 {d fermata medium} |',
        '\\voice',
        'G4{lf 3 rf 2}.4 | E4.4 G4.4 C5.4 | D5.4 B4.4 G4.4 | (F#4 C5).4 Bb3.4 Bb3{t}.4 {txt "확인: 3박 음 흐림"} |'
      ]
    },
    {
      caption: '예시 3: 이동 표시(세뇨 표지, To Coda, D.S. al Coda, 코다 표지).',
      lines: [
        '\\title "예시 곡 (이동 표시)"',
        '\\tempo (80)',
        '\\ts (4 4)',
        '0.1.1 |',
        '\\jump segno 2.1.1 |',
        '\\jump dacoda 3.1.1 |',
        '\\jump dalsegnoalcoda 5.1.1 {txt "D.S. al Coda"} |',
        '\\jump coda 7.1.1 {txt "Coda"} |'
      ]
    }
  ];

  var PROMPT_LINES = [
    '너는 기타 악보 이미지(교본 사진 등)를 alphaTex로 옮기는 일을 맡았어. alphaTex는 alphaTab이 읽는 텍스트 악보 형식이야. 이 프롬프트의 [문법]이 전부니까 다른 형식(ABC, MusicXML, 일반 TAB 텍스트 등)의 관습을 섞지 마.',
    '',
    '[작업 원칙]',
    '- 한 번에 끝까지 옮겨. 멈추거나 되묻지 마. 결과는 사람이 나중에 악보 화면에서 확인하고 고쳐.',
    '- 이미지에 적힌 것만 옮겨. 원본에 없는 음, 운지, 코드, 줄 번호를 지어내지 마. 줄을 추측해서 만들지 마.',
    '- 책에 적힌 구조를 그대로 적어. 성부, 실제 음 길이, 도돌이, D.S./D.C., 못갖춘마디를 단순하게 바꾸거나 펼치지 마. 근사와 펼치기는 나중에 변환 도구가 해.',
    '- 읽기 어려운 곳은 가장 그럴듯한 값으로 적고 그 박에 확인 메모를 달아([문법 6]).',
    '',
    '[출력]',
    '- alphaTex 코드블록 하나만 내. 코드블록 앞뒤에 설명, 요약, 인사말을 쓰지 마.',
    '- 아래 [예시]는 문법을 보여 주는 용도야. 예시의 제목, 음, 설명을 실제 판독 결과에 섞거나 복사하지 마.',
    '',
    '[문법 1: 머리]',
    '곡 맨 앞, 첫 마디 앞에 아래 줄을 적어. 한 줄에 하나씩이야.',
    '- `\\title "제목"`',
    '- `\\notices "…"`: 교본 이름과 쪽수, 작곡가, 원본 템포 표기, 그 밖의 설명을 한 줄에 ` · `로 이어 적어. 예: `\\notices "기타 바이엘 3권 17쪽 · 작곡가 · 원본 템포 점4분음표=60"`',
    '- `\\tempo (n)`: 1분에 4분음표가 몇 번인지야. 인쇄된 템포의 음표가 4분음표가 아니면 4분음표 기준으로 환산해(점4분음표=60이면 `\\tempo (90)`, 2분음표=60이면 `\\tempo (120)`, 8분음표=120이면 `\\tempo (60)`). 템포 표기가 없으면 `\\tempo (64)`로 두고 notices에 "템포 표기 없음(64 가정)"을 적어.',
    '- `\\ts (분자 분모)`: 원본 박자표를 그대로 적어. 예: `\\ts (3 4)`, `\\ts (6 8)`. C는 `(4 4)`, ¢는 `(2 2)`.',
    '- `\\capo n`: 카포가 있을 때만 적고 notices에도 적어. TAB의 프렛 숫자는 인쇄된 그대로 적어.',
    '- 조율이 표준(1번 줄부터 E B G D A E)이 아니면 `\\tuning (E4 B3 G3 D3 A2 D2)`처럼 1번 줄(가장 높은 줄)부터 음이름을 적고(예는 6번 줄을 D로 내린 조율) notices에도 적어.',
    '',
    '[문법 2: 마디와 마디 표시]',
    '- 원본 마디 그대로 `|`로 나눠. 모든 마디 끝에 `|`를 붙여.',
    '- 도돌이, 1·2번 괄호, D.S., D.C., Coda, Fine은 펼치지 말고 아래 마디 표시로 적어. 마디 표시는 그 마디의 첫 음(또는 쉼) 바로 앞에 적어. 한 마디에 여럿이면 이어서 적어(예: `\\ae 1 \\rc 2 3.1.1`). `|` 앞에 적으면 다음 마디에 붙으니 조심해.',
    '| 원본 | alphaTex |',
    '|---|---|',
    '| 도돌이 시작 | `\\ro` |',
    '| 도돌이 끝 | `\\rc n` (n은 연주 횟수, 한 번 되풀이하면 `\\rc 2`) |',
    '| 1번·2번 괄호 | `\\ae 1`, `\\ae 2` |',
    '| 못갖춘마디 | `\\ac` (못갖춘마디인 첫 마디 앞) |',
    '| 리허설 기호(A, B, B\') | `\\section ("A")`, `\\section ("B\'")` (인쇄된 글 그대로, 괄호로 감싸) |',
    '| 이동 표시 | `\\jump 이름` (아래) |',
    '1·2번 괄호가 있는 도돌이는 이렇게 적어: `\\ro 0.1.1 | 1.1.1 | \\ae 1 \\rc 2 3.1.1 | \\ae 2 0.2.1 | 1.2.1 |`',
    '- 이동 표시는 해당 표시가 적힌 마디 앞에 `\\jump 이름`을 적어. 세뇨 표지는 `\\jump segno`, 코다 표지는 `\\jump coda`, "To Coda"는 `\\jump dacoda`, "Fine"은 `\\jump fine`이야. D.S.는 `dalsegno`, D.S. al Coda는 `dalsegnoalcoda`, D.S. al Fine은 `dalsegnoalfine`, D.C.는 `dacapo`, D.C. al Coda는 `dacapoalcoda`, D.C. al Fine은 `dacapoalfine`이야. 겹세뇨·둘째 코다는 `segnosegno`, `doublecoda`, `dadoublecoda`, `dalsegnosegno`, `dalsegnosegnoalcoda`, `dalsegnosegnoalfine`, `dacapoaldoublecoda`, `dalsegnoaldoublecoda`, `dalsegnosegnoaldoublecoda`로 적어.',
    '- D.S.·D.C. 옆에 (with Repeat)·(반복 있음)이 적혀 있으면 그 이동 표시가 있는 마디의 박에 `{txt "with Repeat"}`를 적어.',
    '',
    '[문법 3: 음]',
    '- 줄을 아는 음(TAB 숫자나 동그라미 줄 번호 ①~⑥이 있을 때): `프렛.줄`로 적어. 1번 줄이 가장 높은 줄(가는 줄)이야. 1번 줄 개방은 `0.1`, 2번 줄 3프렛은 `3.2`, 6번 줄 개방은 `0.6`이야. TAB의 숫자는 프렛 번호지 손가락 번호가 아니야.',
    '- 줄을 모르는 음(오선만 있고 TAB도 줄 번호도 없을 때): 음이름+옥타브로 적어. 예: `C4`, `G3`. 가운데 도가 C4야. 기타 오선보는 실제 소리보다 한 옥타브 높게 적혀 있으니 오선에서 읽은 옥타브 숫자에서 1을 빼(오선 아래 덧줄 하나의 도는 `C3`, 오선 맨 위 칸의 미는 `E4`). 변화표는 실제 음높이로 음이름 뒤에 `#`·`b`를 붙여(`F#3`, `Bb2`). 조표와 임시표는 alphaTex가 적용하지 않으니 음마다 실제 높이로 적어.',
    '- 줄을 추측해서 만들지 마. 오선의 음이름만 보고 `프렛.줄`로 바꾸지 마.',
    '- 한 곡 안에서 두 방식을 섞지 마. alphaTab은 한 보표에 `프렛.줄` 음과 음이름 음이 같이 있으면 악보를 읽지 못해(오류). TAB이 있는 곡은 모든 음을 `프렛.줄`로, TAB이 없는 곡은 모든 음을 음이름으로 적어. 일부 마디만 TAB이 없으면 곡 전체를 음이름으로 적어.',
    '- 쉼은 `r.4`처럼 적어. 마디 전체가 쉬면 박자표와 상관없이 `r.1`이야.',
    '- 화음은 괄호 안에 음을 공백으로 늘어놓고 뒤에 길이를 붙여: `(0.6 2.4 2.3).4`, `(C3 G3).2`.',
    '',
    '[문법 4: 길이, 묶음, 성부]',
    '- 길이는 음이나 쉼 뒤에 `.길이`로 붙여: `.1` 온음표, `.2` 2분음표, `.4` 4분음표, `.8` 8분음표, `.16` 16분음표, `.32` 32분음표. 모든 음과 쉼에 길이를 붙이고, 한 마디의 길이 합은 박자표와 같아야 해.',
    '- 효과는 두 종류야. 음 효과는 음 바로 뒤, 길이 앞의 중괄호야: `5.2{t}.2`, `C4{lf 2}.4`, 화음 안에서는 음마다 `(5.2{t} 3.3{t}).2`. 박 효과는 길이 뒤의 중괄호 하나 안에 공백으로 이어서 적어: `(0.6 2.4).4 {ad ch "Am" txt "메모"}`.',
    '- 점음표는 박 효과 `{d}`(점 하나), `{dd}`(점 둘)야: `3.1.4 {d}`.',
    '- 셋잇단음표는 묶음의 세 음 모두에 박 효과 `{tu 3}`을 달아: `0.1.8 {tu 3} 1.1.8 {tu 3} 3.1.8 {tu 3}`.',
    '- 붙임줄로 이어지는 뒤 음에는 음 효과 `{t}`를 달고 앞 음과 같은 음을 다시 적어(마디를 넘어도 돼): `5.2.2 5.2{t}.2`, `Bb3.4 Bb3{t}.4`.',
    '- 성부: 기둥 방향이 갈리는 두 성부(긴 저음 + 선율 등)는 `\\voice`로 나눠. `\\voice` 다음에 첫째 성부의 모든 마디를 `|`로 이어 쓰고, 다시 `\\voice` 다음에 둘째 성부의 모든 마디를 써. 두 성부의 마디 수를 같게 맞추고, 한 성부가 쉬는 마디는 `r.1`처럼 쉼으로 채워. 마디 표시(`\\ro`, `\\ac`, `\\section`, `\\jump` 등)는 첫째 성부에만 적어. 성부마다 마디의 길이 합은 박자표와 같아야 해. 정확한 꼴은 예시 2야.',
    '',
    '[문법 5: 주법과 표시]',
    '| 원본 | alphaTex |',
    '|---|---|',
    '| 해머링·풀링(H·P, 다른 높이를 잇는 슬러 곡선) | 출발 음에 음 효과 `{h}`: `0.1{h}.8 2.1.8` |',
    '| 슬라이드(S, sl., 두 음 사이 직선 gliss.) | 출발 음에 음 효과 `{sl}`: `3.2{sl}.4 5.2.4` |',
    '| 출발 음이 없는 글리산도(음 앞뒤의 짧은 사선·곡선) | 빼고 그 박에 박 효과 `{txt "글리산도 생략"}` |',
    '| 자연 하모닉스(Harm., <12>) | 손 대는 프렛.줄에 음 효과 `{nh}`: `12.1{nh}.4` (줄을 알 때만) |',
    '| 롤(화음 앞 세로 물결선) | 위 화살표이거나 화살표가 없으면 박 효과 `{ad}`, 아래 화살표면 `{au}`: `(0.6 2.4 2.3).4 {ad}` |',
    '| 스트로크, 라스게아도 | 그냥 화음으로 적고 박 효과 `{txt "스트로크"}` |',
    '| 꾸밈음 | 꾸밈음을 짧은 길이로 먼저 적고 박 효과 `{gr}`: `3.2.16 {gr} 5.2.4`. 꾸밈음은 박자를 차지하지 않아 |',
    '| 페르마타 | 박 효과 `{fermata medium}` |',
    '| 왼손 운지 1~4 | 음 효과 `{lf 2}`~`{lf 5}` (`lf 1`이 엄지라 숫자가 하나씩 커져). 0은 적지 않아: `2.4{lf 2}` |',
    '| 오른손 p·i·m·a | 음 효과 `{rf 1}`~`{rf 4}`: `1.2{rf 3}` |',
    '| 코드 이름 | 그 박에 박 효과 `{ch "Am"}` |',
    '- 운지는 이미지에 적힌 것만 옮겨. 앞뒤 음에서 추측하거나 이어 붙이지 마.',
    '',
    '[문법 6: 메모와 확인]',
    '- 지시어, 가사, 설명(rit., a tempo, CV, 바레 등)은 해당하는 박에 박 효과 `{txt "…"}`로 적어. 한 박에는 `txt`를 하나만 쓰고, 여러 개면 ` · `로 이어. 문자열 안의 큰따옴표는 `\\"`, 역슬래시는 `\\\\`로 써. 이 문법에 없는 표기(벤딩, 비브라토 등)는 음만 적고 `{txt "원문"}`으로 남겨.',
    '- 읽기 어려운 곳은 가장 그럴듯하게 적고 그 박에 `{txt "확인: 이유"}`를 달아. 예: `{txt "확인: 3박 음 흐림"}`',
    '- 아포얀도 표시는 옮기지 마. "선율 아포얀도" 같은 지시는 notices나 `txt`에 글로 적어.',
    '',
    '[출력 전 점검]',
    '- 코드블록 하나뿐이고 앞뒤에 다른 글이 없어?',
    '- 모든 음과 쉼에 `.길이`가 있고, 마디마다 길이 합이 박자표와 같아? 모든 마디가 `|`로 끝나?',
    '- 한 곡이 `프렛.줄`만이거나 음이름만이야? 줄은 1~6, 프렛은 0 이상이야?',
    '- `\\ro`, `\\rc`, `\\ae`, `\\ac`, `\\section`, `\\jump`가 모두 마디의 첫 음 앞에 있어?',
    '- `\\voice`를 썼으면 성부마다 마디 수가 같아? 문자열의 큰따옴표가 짝이 맞아?',
    '',
    '[예시: 실제 변환 결과가 아님]',
    '{{EXAMPLES}}'
  ];

  function buildScoreImagePrompt(){
    var lines = [];
    PROMPT_LINES.forEach(function(line){
      if (line === '{{EXAMPLES}}'){
        ALPHATEX_EXAMPLES.forEach(function(example, index){
          if (index > 0) lines.push('');
          lines.push(example.caption);
          lines.push('```alphatex');
          example.lines.forEach(function(l){ lines.push(l); });
          lines.push('```');
        });
      } else lines.push(line);
    });
    return lines.join('\n');
  }

  // 저장소를 읽고 명령을 실행할 수 있는 AI용 짧은 프롬프트. 변환 규칙은 문서와 buildScoreImagePrompt() 를 가리킨다.
  var PROJECT_PROMPT_LINES = [
    '첨부한 기타 악보 이미지를 이 저장소(기타 스튜디오)의 악보 원본인 alphaTex로 옮기고 시트용 행까지 만들어 줘. 저장소 파일을 읽고 명령을 실행할 수 있다고 가정할게.',
    '',
    '1. `Docs/alphatab.md`의 "원본은 alphaTex"와 "사진 변환" 절을 읽어.',
    '2. 아래 명령으로 변환 규칙을 출력해서 따라. [출력] 절 대신 아래 3~5번을 따라. 규칙과 문서가 다르면 문서를 따라.',
    '   node -e "process.stdout.write(require(\'./src/score-prompt.js\').buildScoreImagePrompt())"',
    '3. 결과를 `Temp/scores/<제목>.tex`에 저장해. 파일 이름에서 `\\ / : * ? " < > |`는 빼.',
    '4. `node tools/build-scores.js Temp/scores`로 `<제목>.tsv`(시트용 6열 행)를 만들어. 그 곡에 alphaTab 읽기·변환·검사 오류가 있으면 `.tex`를 고쳐 다시 돌려 오류가 0이 되게 해.',
    '5. 채팅에는 원본 박자표·템포·카포·조율, 만든 마디 수, 변환기가 단 마디 메모와 `?` 요약, `확인:` 메모를 단 곳, 저장한 두 파일 경로를 적어.',
    '',
    '`Temp/scores/`는 구글 드라이브와 이어진 폴더야. 그 안의 다른 파일을 지우거나 고치지 말고, `Temp/scores/` 밖의 파일도 고치지 말고, 커밋하거나 푸시하지 마.'
  ];

  function buildProjectPrompt(){
    return PROJECT_PROMPT_LINES.join('\n');
  }

  var COPY_OK = '프롬프트를 복사했습니다. AI 채팅에 악보 이미지와 함께 붙여 넣고, 받은 alphaTex는 드라이브의 GuitarScores 폴더에 곡 이름.tex로 저장하세요.';
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
    ALPHATEX_EXAMPLES: ALPHATEX_EXAMPLES,
    PROJECT_PROMPT_LINES: PROJECT_PROMPT_LINES,
    buildScoreImagePrompt: buildScoreImagePrompt,
    buildProjectPrompt: buildProjectPrompt,
    copyText: copyText,
    initScorePromptButton: initScorePromptButton
  };
});
