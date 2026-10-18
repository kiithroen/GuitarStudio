'use strict';
  var NOTE_DUR_SVGS = {
    whole: '<svg class="dur-svg" viewBox="0 0 16 16" width="12" height="12"><ellipse cx="8" cy="8.5" rx="5.5" ry="3.5" transform="rotate(-25 8 8.5)" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    half: '<svg class="dur-svg" viewBox="0 0 14 16" width="10" height="12"><ellipse cx="4.5" cy="11.5" rx="3.3" ry="2.2" transform="rotate(-20 4.5 11.5)" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/></svg>',
    halfDot: '<svg class="dur-svg" viewBox="0 0 16 16" width="12" height="12"><ellipse cx="4.5" cy="11.5" rx="3.3" ry="2.2" transform="rotate(-20 4.5 11.5)" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/><circle cx="12.5" cy="11.5" r="1.3" fill="currentColor"/></svg>',
    quarter: '<svg class="dur-svg" viewBox="0 0 14 16" width="10" height="12"><ellipse cx="4.5" cy="11.5" rx="3.5" ry="2.4" transform="rotate(-20 4.5 11.5)" fill="currentColor"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/></svg>',
    quarterDot: '<svg class="dur-svg" viewBox="0 0 16 16" width="12" height="12"><ellipse cx="4.5" cy="11.5" rx="3.5" ry="2.4" transform="rotate(-20 4.5 11.5)" fill="currentColor"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/><circle cx="12.5" cy="11.5" r="1.3" fill="currentColor"/></svg>',
    eighth: '<svg class="dur-svg" viewBox="0 0 14 16" width="10" height="12"><ellipse cx="4.5" cy="11.5" rx="3.5" ry="2.4" transform="rotate(-20 4.5 11.5)" fill="currentColor"/><rect x="7.3" y="1" width="1.4" height="11" fill="currentColor"/><path d="M8 1 C9.5 3.5 12 4.5 13 7.5 C12 6 10.5 5.2 8 5 Z" fill="currentColor"/></svg>',
    restQuarter: '<svg class="dur-svg" viewBox="0 0 10 16" width="8" height="12"><path d="M6 1 L2 6 L6.5 8.5 L1.5 12.5 C2.5 14.5 4.5 14 4.5 14.8 C4.5 15.6 3 15.5 2 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    restEighth: '<svg class="dur-svg" viewBox="0 0 10 16" width="8" height="12"><circle cx="4" cy="5" r="1.6" fill="currentColor"/><path d="M4 4 C6.5 4 7.5 6 7.5 7.5 L5 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
  };

  function getBeatDurationInfo(beats, bIdx, bpb){
    var b = beats[bIdx];
    var isCompound = (bpb === 6 || bpb === 9 || bpb === 12);
    if (!b || (!b.midi && !b.isSubdivided)){
      return {
        isRest: true,
        svg: isCompound ? NOTE_DUR_SVGS.restEighth : NOTE_DUR_SVGS.restQuarter,
        label: isCompound ? '8분쉼' : '쉼표',
        durName: isCompound ? '8분 쉼표' : '4분 쉼표'
      };
    }
    if (b.isSubdivided && b.subNotes && b.subNotes.length > 1){
      var n = b.subNotes.length;
      if (n === 2){
        if (b.subNotes[0].tok === '-'){
          return { isRest: false, svg: NOTE_DUR_SVGS.eighth, label: '8분(엇박)', durName: '8분 쉼/유지 + 8분음표' };
        }
        return { isRest: false, svg: NOTE_DUR_SVGS.eighth, label: '8분×2', durName: '8분음표 2개 (반박+반박)' };
      }
      if (n === 3) return { isRest: false, svg: NOTE_DUR_SVGS.eighth, label: '3잇단', durName: '셋잇단음표' };
      if (n === 4) return { isRest: false, svg: NOTE_DUR_SVGS.eighth, label: '16분×4', durName: '16분음표 4개' };
      return { isRest: false, svg: '', label: n + '분할', durName: n + '분할 음표' };
    }
    var span = 1;
    for (var i = bIdx + 1; i < beats.length; i++){
      var nextB = beats[i];
      if (nextB && nextB.midi != null && !nextB.isSubdivided) break;
      if (nextB && nextB.isSubdivided && nextB.subNotes && nextB.subNotes.length > 1){
        if (nextB.subNotes[0].tok === '-'){
          span += (nextB.subNotes[0].durFrac || 0.5);
        }
        break;
      }
      span++;
    }
    if (isCompound){
      if (span === 1) return { isRest: false, svg: NOTE_DUR_SVGS.eighth, label: '8분', durName: '8분음표' };
      if (span === 2) return { isRest: false, svg: NOTE_DUR_SVGS.quarter, label: '4분', durName: '4분음표' };
      if (span === 3) return { isRest: false, svg: NOTE_DUR_SVGS.quarterDot, label: '점4분', durName: '점4분음표 (1박)' };
      if (span === 4 || span === 5) return { isRest: false, svg: NOTE_DUR_SVGS.half, label: '2분', durName: '2분음표 (2박)' };
      if (span >= 6) return { isRest: false, svg: NOTE_DUR_SVGS.halfDot, label: '점2분', durName: '점2분음표' };
      return { isRest: false, svg: '', label: span + '박', durName: span + '박' };
    }
    if (span === 1) return { isRest: false, svg: NOTE_DUR_SVGS.quarter, label: '4분', durName: '4분음표 (1박)' };
    if (span === 1.5) return { isRest: false, svg: NOTE_DUR_SVGS.quarterDot, label: '점4분', durName: '점4분음표 (1.5박)' };
    if (span === 2) return { isRest: false, svg: NOTE_DUR_SVGS.half, label: '2분', durName: '2분음표 (2박)' };
    if (span === 3) return { isRest: false, svg: NOTE_DUR_SVGS.halfDot, label: '점2분', durName: '점2분음표 (3박)' };
    if (span >= 4) return { isRest: false, svg: NOTE_DUR_SVGS.whole, label: '온음', durName: '온음표 (4박)' };
    return { isRest: false, svg: '', label: span + '박', durName: span + '박' };
  }



if (typeof module !== 'undefined' && module.exports){ module.exports = { NOTE_DUR_SVGS: NOTE_DUR_SVGS, getBeatDurationInfo: getBeatDurationInfo }; }
