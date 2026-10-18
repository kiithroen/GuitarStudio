(function(root){
  'use strict';
  function buildAiPromptText(original){
    const safelyQuoted=JSON.stringify(String(original||''));
    return [
      '사진의 기타 악보를 alphaTab 1.8.4 alphaTex 문법으로 옮겨줘. 사진만으로 확정할 수 없는 음, 박 길이, 마디 경계, 쉼, 붙임줄, 성부, 운지는 추측하지 말고 불확실성 목록에 위치와 이유를 써. 읽을 수 없는 부분이 있으면 해당 구간의 출력도 보류해.',
      '',
      '규칙:',
      '- 기타 TAB 숫자는 실제 프렛 번호야. 각 음을 프렛.현 형식으로 써. 현 번호는 위의 가장 높은 현부터 1이야. 예: 3.5는 5번 현 3프렛.',
      '- 음 길이는 :4(4분), :8(8분)처럼 음 앞에 둬(:4 3.5). 필요하면 길이를 음 뒤에 .4처럼 쓸 수 있어. 쉼은 r, 동시음은 괄호로 묶어 (0.3 1.2). 마디는 |로 나눠.',
      '- 붙임줄은 음에 {t}를 붙여. 잇단음표는 alphaTex의 {tu n} 구문으로 명시하고, 원본에서 확인되지 않으면 만들지 마.',
      '- 독립 성부에는 \\voice를 사용하되 성부 시작과 길이를 원본에서 확인한 경우에만 출력해. 박자표 인자는 괄호로 묶어 \\ts (3 4), 카포는 \\capo 5, 템포는 \\tempo 64로 적어.',
      '- 왼손 운지가 원문에 표시된 경우만 lf 속성으로 옮겨. alphaTex lf 값은 1 엄지, 2 검지, 3 중지, 4 약지, 5 소지야. 운지가 없으면 lf를 생략해. 오른손 운지는 만들지 마.',
      '- TAB 숫자는 음이름으로 바꾸지 말고 확인된 프렛.현을 그대로 기록해. 고정 표준 조율이나 프렛 범위 제한을 가정하지 마. 튜닝이 불확실하면 질문하거나 불확실성으로 보고해.',
      '- 출력은 먼저 alphaTex만 담은 코드블록, 다음에 판독 불확실성 목록으로 구성해. 예시는 실제 사진 판독과 섞지 마.',
      '',
      '현재 편집 중인 원문 alphaTex(문맥 참고용, 사진 판독 결과로 간주하지 말 것):',
      safelyQuoted
    ].join('\n');
  }
  if(typeof module==='object'&&module.exports)module.exports=buildAiPromptText;else root.buildAiPromptText=buildAiPromptText;
})(typeof globalThis!=='undefined'?globalThis:this);
