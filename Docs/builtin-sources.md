# 내장곡의 선율 출처와 운지 제안

**출처 대조일: 2026-10-19.** 내장 악보는 기타 연습용 편집판이야. 출처에서 확인한 선율과 앱이 작성한 현·왼손·오른손 운지 제안을 구분해 기록해. 앱의 운지 표기를 출처 악보의 운지로 설명하지 않아.

전통곡은 확인한 전통 선율만 대조했어. 현대 발행자의 편곡·반주를 복제하거나 그 전체가 퍼블릭 도메인이라고 주장하지 않아. 원악보와 대조를 마치지 못한 곡은 그 한계를 적었어. 코드 머리표는 앱의 연습용 화성 표기이며 출처 악보의 화성 편곡을 전사한 것이 아니야.

| 내장곡 ID | 선율 출처 | 대조 범위와 앱 편집 |
|---|---|---|
| `builtin-lv1-butterfly` | [Lightly Row, fluteTunes 악보](https://www.flutetunes.com/tunes.php?id=116), [PDF](https://www.flutetunes.com/tunes/lightly-row.pdf), [MIDI](https://www.flutetunes.com/tunes/lightly-row.mid) | 독일 전통 선율, C장조. 2/2 원자료를 앱의 네 칸으로 옮기고 한 옥타브 낮췄어. m8 E4, m16 C4는 각 2박 유지 후 2박 쉼으로 대조 결과를 반영했어. 출처의 staccato 점은 앱에서 지원하지 않아 생략했어. |
| `builtin-lv1-schoolbell` | [한국민족문화대백과사전, 학교종](https://encykorea.aks.ac.kr/Article/E0081228) | 작곡 배경 참고 자료만 확인했어. 음표를 대조할 원악보는 확인하지 못해 현재 선율을 원악보와 일치한다고 주장하지 않아. |
| `builtin-lv1-twinkle` | [Twinkle Twinkle Little Star, fluteTunes 악보](https://www.flutetunes.com/tunes.php?id=18), [PDF](https://www.flutetunes.com/tunes/twinkle-twinkle-little-star.pdf) | C장조 선율 12마디를 대조했고 한 옥타브 낮췄어. 피아노 반주는 쓰지 않았고 선율 음은 수정하지 않았어. |
| `builtin-lv2-london` | [London Bridge is Falling Down, mfiles PDF](https://www.mfiles.co.uk/scores/london-bridge-is-falling-down.pdf) | C장조 2/4 첫 8마디 선율만 대조했어. 피아노 반주는 쓰지 않았어. 점8분음표와 16분음표를 현재 칸 문법으로 적었고, 기존 마디 재생 시간을 유지하도록 2/4·34 BPM을 앱 연습값으로 정했어. |
| `builtin-lv2-jinglebells` | [Jingle Bells, fluteTunes 악보](https://www.flutetunes.com/tunes.php?id=239), [PDF](https://www.flutetunes.com/tunes/jingle-bells.pdf) | 플루트 선율과 2쪽 후렴 m13~20을 대조했어. C장조 E5에서 앱 실음 G장조 B3로 옮겼어. 후렴의 점 리듬과 재탄현을 반영하고, 출처의 8마디 후렴을 리듬이 두 배 길어진 16마디 앱판으로 펼쳤어. 앞 절과 피아노 반주는 쓰지 않았어. 발행자가 1857년 판과 현재 후렴이 다르다고 설명하므로 원곡 그대로라고 하지 않아. BPM 68은 앱 편집값이야. |
| `builtin-lv2-odetojoy` | [Ode to Joy PDF](https://pdfminstrel.wordpress.com/wp-content/uploads/2015/05/ode_to_joy_f.pdf) | G장조 주제판 16마디를 기타 음역의 C장조로 적었어. B5에서 E4로 실제 19반음 낮춘 편집이야. 원전 전체가 아니고 m14 끝의 F4 경과음을 추가했어. |
| `builtin-lv3-brahms` | [Brahms' Lullaby, mfiles PDF](https://www.mfiles.co.uk/scores/brahms-lullaby-wiegenlied-piano.pdf) | F장조 악보에서 선율만 대조해 C장조로 5반음 낮췄어. 피아노 반주는 쓰지 않았어. 픽업 앞에 쉼 두 칸을 채우고, 마지막 C4는 출처의 2박에서 앱의 3박으로 늘렸어. |
| `builtin-lv3-clementine` | [Oh My Darling, Clementine, fluteTunes 악보](https://www.flutetunes.com/tunes.php?id=27), [PDF](https://www.flutetunes.com/tunes/oh-my-darling-clementine.pdf) | 전통 주제 첫 8마디를 G장조에서 C장조로 7반음 낮춰 적었어. 게시된 악보의 추가 고음 코다는 제외했어. 못갖춘마디 앞에 쉼을 채워 9줄 한 절로 정리하고 점8분음표·16분음표를 4분할로 적었어. 코드 머리표는 앱의 연습용 화성이야. |
| `builtin-lv4-amazinggrace` | [Amazing Grace for piano and flute, mfiles PDF](https://www.mfiles.co.uk/scores/amazing-grace-piano-flute.pdf) | 플루트 선율의 m8 끝 픽업 D4부터 m24 G4까지 대조하고 12반음 낮췄어. 앞의 피아노 도입부와 반주는 쓰지 않았어. 픽업을 포함해 17줄로 만들고 마지막 G4 유지 뒤 다음 절 픽업 B4는 끝 쉼으로 바꿨어. 8분 셋잇단은 `/`로 적었고 슬러는 옮기지 않았어. |
| `builtin-lv4-canon` | 이 곡의 화성 연습선은 앱 편집이야. Pachelbel 작품의 원작 채보라고 주장하지 않아. | 17마디 C장조 연습 배열이야. 마지막 C화음은 구성음을 동시에 치고 전체를 유지해. F2는 6번줄 1프렛이므로 왼손 검지 운지로 표기했어. |
| `builtin-lv4-greensleeves` | [Greensleeves, mfiles PDF](https://www.mfiles.co.uk/scores/greensleeves-accomp.pdf) | 전통 선율 일부를 대조하고 기타 편곡을 12반음 낮췄어. 반주를 복사하지 않았어. 자연 G가 나오는 구간과 종지의 G#/F#를 구분했고 점8분음표·16분음표를 `/`로 나눴어. 못갖춘마디 앞에 5칸 쉼을 채웠고, 끝 A3는 출처의 점4분음표+4분음표보다 8분음표 한 칸 늘려 6칸 마디에 맞췄어. 슬러는 옮기지 않아 각 음을 다시 탄현해. |
| `builtin-lv5-romance` | [Anonymous, Spanish Romance, Mutopia 악보 PDF](https://www.mutopiaproject.org/ftp/Anonymous/spanish-romance/spanish-romance-let.pdf), [곡·저자 정보](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=795) | 첫 쪽 마단조 16마디를 대조해 기타 기보음보다 12반음 낮췄어. 장조 B부분과 반복 전개는 포함하지 않았고 내성을 생략해 선율·베이스 연습판으로 만들었어. m1~14는 베이스를 선율 첫 박에 함께 탄현해. 별도 길이 표기 없이 각 음은 현행 칸 음가를 사용하며, 소리는 오디오의 자연 감쇠를 따라. |
| `builtin-lv6-romance-full` | [Anonymous, Spanish Romance, Mutopia 악보 PDF](https://www.mutopiaproject.org/ftp/Anonymous/spanish-romance/spanish-romance-let.pdf), [곡·저자 정보](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=795) | 첫 쪽 마단조 16마디를 대조해 기타 기보음보다 12반음 낮췄어. 장조 B부분과 반복 전개는 포함하지 않았어. m1~14는 베이스를 첫 분할 탄현에 선율과 함께 치고, 선율·내성은 매 박을 셋으로 나눈 현재 분할 길이를 사용해. 원자료의 성부별 음가는 따로 기록하지 않고 자연 여운은 별도 오디오 동작으로 처리해. 독립 성부 레인·성부별 쉼·화음 구성음별 길이는 지원하지 않아. m15는 E3/B2/G2 베이스가 각 박 첫 분할에서 선율과 동시 탄현되고, 내성은 나머지 셋잇단 분할에 배치돼. m16은 E2/E4를 2박 유지한 뒤 쉼을 둬. |

로망스 원자료는 Anonymous 표기, Jeff Covey 2006 조판, Mutopia-2006/08/03-795야. 출처 악보는 [CC BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/)로 표시되어 있어. 이 앱의 두 Romance 파생 악보 데이터도 CC BY-SA 2.5로 배포해. 앱 전체의 라이선스를 뜻하지 않아. 변형된 음역·성부·리듬을 이 문서에 기록했어. 악보의 `!`/`~`, 현 번호와 손번호는 PDF 원문 표시가 아니라 앱의 연습 제안이야. [Romance 기타 교육 페이지](https://www.clasesguitarraonline.com/clases-guitarra-vitoria-musical-eduardo/romance-anonimo-guitarra)는 아포얀도를 사용할 수 있는 연주 기법의 참고 링크로만 기록해.

앱 데이터에 붙은 현 번호, 왼손·오른손 손가락, 화음 머리표는 모두 연습용 제안이야. 이는 원자료에 운지나 코드가 적혀 있었다는 뜻이 아니야. 전통 선율의 출처 자료에 있는 현대 편곡·반주 저작권을 퍼블릭 도메인으로 간주하지 않아.
