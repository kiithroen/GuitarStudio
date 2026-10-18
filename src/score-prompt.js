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
    '[E] E2@6+B3@2 G#3@3/A3@3 B3@2 - | ""',
    '[-] !E4@1:a - r C4/D4/E4 | "셋잇단"'
  ];
  var EXAMPLE_TSV_ROW = ['예시 곡', String(EXAMPLE_BEATS), String(EXAMPLE_BPM), '원본 4/4 · 4분음표=64', EXAMPLE_MEASURES.join(' // ')].join('\t');

  var PROMPT_LINES = [
    '첨부한 기타 악보 이미지를 읽고, 아래 규칙에 맞춰 기타 스튜디오 앱의 텍스트 악보로 변환해 줘. 이미지에서 확인한 내용만 적고, 보이지 않거나 확정할 수 없는 것은 추측하지 말고 불확실한 점 목록으로 알려 줘.',
    '',
    '[출력 순서]',
    '1. 코드블록 밖: 제목, 원본 박자표와 고른 마디 칸 수, 원본 템포 표기와 환산한 BPM, 카포.',
    '2. 코드블록 하나: 악보 마디만, 한 줄에 한 마디. 설명을 섞지 마.',
    '3. 코드블록 하나: Google Sheets에 붙여 넣을 TSV 한 행. 열은 제목, 칸 수, BPM, 설명, 악보 다섯 개이고, 열 사이는 공백이 아니라 탭 문자 하나야. 악보 열은 2번과 같은 마디를 ` // `로 이어 붙여.',
    '4. 코드블록 밖: 불확실한 점과 근사한 부분 목록(마디 번호와 칸 위치). 없으면 "없음".',
    '',
    '[마디와 칸]',
    '- 한 마디는 `[코드] 칸 칸 칸 ... | "메모"` 형식의 한 줄이야. 마디는 줄바꿈이나 ` // `로만 나눠.',
    '- 칸은 공백으로 구분해. 모든 마디의 칸 수가 정확히 같아야 하고, 모자라거나 남으면 앱에서 오류야.',
    '- 한 칸 안을 균등하게 나눌 때는 공백 없이 `/`로 붙여 써. 2·3·4분할만 돼. 예: `E4/F4`, `C4/D4/E4`, `C4/-/-/D4`.',
    '- 마디 칸 수는 2, 3, 4, 6, 8, 9 중 하나를 곡 전체에 하나만 골라. 2·3·4칸은 한 칸이 4분음표, 6칸과 9칸은 6/8·9/8의 8분음표, 8칸은 4/4의 8분음표야. 12/8은 4칸을 고르고 각 칸을 3분할해. 3/4의 셋잇단은 3칸에서 해당 칸을 3분할해.',
    '- 모든 음의 시작이 칸의 시작이나 칸을 2·3·4로 균등하게 나눈 지점에 오도록 칸 수를 골라. 그래도 맞지 않는 리듬은 근사하지 말고 `?`로 남겨 목록에 적어.',
    '',
    '[음, 쉼, 유지, 화음]',
    '- 음은 영어 음이름과 옥타브로 적어. 예: `E4`, `F#3`, `Bb2`. 앱은 조표와 임시표를 적용하지 않으니 각 음의 실제 높이를 음마다 `#`, `b`로 적어. 마디가 바뀌면 임시표가 풀리는 것도 반영해.',
    '- 카포가 없으면 앱의 음높이는 실제로 울리는 소리야. 카포가 있을 때는 아래 [템포와 카포]를 따라. 표준 튜닝 개방현은 1번 줄 E4, 2번 줄 B3, 3번 줄 G3, 4번 줄 D3, 5번 줄 A2, 6번 줄 E2야. 기타 오선보는 실음보다 한 옥타브 높게 적으니 오선보만 보고 적을 때는 한 옥타브 낮춰. TAB이 있으면 줄 번호와 프렛으로 음높이를 계산해 오선보와 대조해.',
    '- 지원 범위는 0~12프렛, 즉 E2~E5야. 벗어나는 음은 `?`로 남기고 목록에 적어.',
    '- `r`은 쉼표야. 그 순간 울리던 기타 소리를 모두 멈춰.',
    '- `-`는 바로 앞 음이나 화음을 다시 치지 않고 그 칸(분할 안에서는 그 조각)만큼 더 끄는 거야. 붙임줄, 점음표, 긴 음표는 시작 칸에 음을 적고 나머지 칸을 `-`로 채워. 다음 마디로 이어져도 돼. 곡 맨 앞이나 `r` 바로 뒤에는 쓸 수 없어.',
    '- 동시에 치는 음은 `+`로 묶어. 예: `E2@6+B3@2+G4@1`.',
    '- `.`이나 음 뒤 길이 표시(`*2` 같은 것)는 쓰지 마.',
    '',
    '[성부가 여러 개일 때]',
    '- 앱은 화음 구성음마다 길이를 따로 갖지 못해. 저음과 선율처럼 길이가 다른 성부는 각 음이 시작하는 칸에 `+`로 합쳐 적고, 앞서 시작한 음이 계속 울리는 칸에는 새로 시작하는 음만 적어. 다른 줄의 음은 자연 감쇠로 계속 울려.',
    '- 한 성부만 쉬고 다른 성부가 계속 울리는 자리는 `r`이 아니라 `-`로 적어. `r`은 모든 소리를 멈추기 때문이야.',
    '- 이렇게 근사한 마디는 4번 목록에 적어.',
    '',
    '[줄 번호, 운지, 주법: 이미지에 적힌 것만]',
    '- 줄 번호: TAB이나 동그라미 줄 번호(①~⑥)가 보이면 음 뒤에 `@1`~`@6`으로 붙여. 예: `C4@2`. 보이지 않으면 생략해.',
    '- 왼손 손가락: 음표 옆 0~4 숫자가 보이면 음 앞에 붙여. 예: `1C4@2`. TAB의 숫자는 프렛 번호지 손가락 번호가 아니야.',
    '- 오른손 손가락: p, i, m, a가 보이면 음 뒤에 `:p`, `:i`, `:m`, `:a`로 붙여. 예: `1C4@2:i`. 화음은 구성음마다 따로 붙여. 예: `C3@5:p+1C4@2:i`.',
    '- 아포얀도는 음 앞에 `!`, 티란도는 음 앞에 `~`야. 예: `!E4@1:a`. `>`나 `^`는 쓰지 마.',
    '- 이미지에 없는 줄 번호, 운지, 주법은 추측하거나 앞뒤 음에서 이어 붙이지 마.',
    '',
    '[코드와 메모]',
    '- 마디의 첫 항목은 코드 머리표야. 이미지에 코드 이름이 적혀 있으면 `[Am]`처럼, 없거나 읽을 수 없으면 `[-]`로 적어. 읽을 수 없는 코드는 4번 목록에 적어. `[?]`는 앱의 코드 추론 표시라 오류로 걸러지지 않으니 쓰지 마. 코드를 추측해 채우지 마. 한 마디에 코드가 여럿이면 첫 코드를 머리표에 적고 나머지는 메모에 적어.',
    '- `|` 뒤에는 그 마디의 메모를 큰따옴표 문자열로 적어. 포지션(예: CV), 바레, 셈여림, 빠르기 변화, 가사처럼 이미지에 있는 내용을 짧게 적고, 없으면 `""`로 둬. 문자열 안의 큰따옴표는 `\\"`로 써.',
    '',
    '[앱이 지원하지 않는 표기]',
    '- 도돌이표, D.C., D.S., 1·2번 괄호는 연주 순서대로 마디를 펼쳐 적어.',
    '- 못갖춘마디는 앞을 `r`로 채워 온마디로 만들고, 마지막 마디의 모자란 칸도 `r`로 채워.',
    '- 꾸밈음은 빼고, 슬러·해머링·풀링·슬라이드는 각 음을 따로 친 음으로 적어. 하모닉스, 트레몰로, 라스게아도 같은 주법도 일반 음으로 적어. 모두 4번 목록에 적어.',
    '- 곡 중간에 박자가 바뀌거나 표준 튜닝이 아니면(예: 6번 줄을 D로 내림) 변환하지 말고 그 이유만 알려 줘.',
    '',
    '[템포와 카포]',
    '- BPM은 1분에 진행하는 칸 수야. 인쇄된 템포의 음표 단위가 칸과 다르면 환산해. 예: 4/4에서 4분음표=60을 8칸으로 적으면 120, 6/8에서 점4분음표=60이면 6칸 기준 180.',
    '- BPM은 30~240 사이의 정수만 돼. 환산한 값이 240을 넘으면 더 긴 칸(예: 8칸 대신 4칸)을 골라 짧은 음은 칸 안 분할로 적고, 30보다 작으면 더 짧은 칸(예: 4칸 대신 8칸)을 골라. 정수가 아니면 가장 가까운 정수로 반올림하고 4번 목록에 적어.',
    '- 템포가 적혀 있지 않으면 64로 두고, 이 값이 이미지에서 읽은 것이 아니라고 밝혀.',
    '- 카포가 적혀 있으면 설명 열에 `Capo 2`처럼 적어. 음은 카포가 없는 것처럼 TAB의 프렛 그대로 계산해 적어. 앱이 재생할 때 카포만큼 올려.',
    '',
    '[읽을 수 없는 음]',
    '- 읽을 수 없는 음이나 칸은 지우거나 채우지 말고 그 자리에 `?`를 적어. 앱은 `?`가 남은 악보를 오류로 막으니 사용자가 원본을 보고 고칠 수 있게 4번 목록에 위치를 적어.',
    '',
    '[형식 예시: 실제 변환 결과가 아님]',
    '4칸 마디 세 개의 예시야. 문법만 참고하고 내용을 결과에 복사하지 마.',
    '{{EXAMPLE_MEASURES}}',
    '',
    '같은 예시의 TSV 한 행(열 사이는 탭):',
    '{{EXAMPLE_TSV}}'
  ];

  function buildScoreImagePrompt(){
    var lines = [];
    PROMPT_LINES.forEach(function(line){
      if (line === '{{EXAMPLE_MEASURES}}') EXAMPLE_MEASURES.forEach(function(m){ lines.push(m); });
      else if (line === '{{EXAMPLE_TSV}}') lines.push(EXAMPLE_TSV_ROW);
      else lines.push(line);
    });
    return lines.join('\n');
  }

  var COPY_OK = '프롬프트를 복사했어. AI 채팅에 악보 이미지와 함께 붙여 넣고, 받은 TSV 한 행을 Google Sheets 빈 행 A열에 붙여 넣어.';
  var COPY_FAIL = '클립보드에 복사하지 못했어. 브라우저의 클립보드 권한을 확인해 줘.';

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

  function initScorePromptButton(){
    var btn = document.getElementById('copyScorePromptBtn');
    if (!btn) return;
    btn.addEventListener('click', async function(){
      var ok = await copyText(buildScoreImagePrompt());
      var status = document.getElementById('scorePromptStatus');
      if (!status) return;
      status.hidden = false;
      status.textContent = ok ? COPY_OK : COPY_FAIL;
    });
  }

  return {
    EXAMPLE_BEATS: EXAMPLE_BEATS,
    EXAMPLE_BPM: EXAMPLE_BPM,
    EXAMPLE_MEASURES: EXAMPLE_MEASURES,
    EXAMPLE_TSV_ROW: EXAMPLE_TSV_ROW,
    buildScoreImagePrompt: buildScoreImagePrompt,
    initScorePromptButton: initScorePromptButton
  };
});
