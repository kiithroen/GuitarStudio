# Guitar Studio - 개발 및 리팩터링 로드맵 (TODO.md)

## 1. 모듈화 및 파일 분리
- [x] index.html(6,800줄+) 모놀리스 해소
  - [x] `src/parser.js`: 악보 텍스트 파싱, 서브토큰 분할, 코드 파싱 전담 모듈 분리
  - [x] `src/audio.js`: Web Audio API 신디사이저와 가이드음 분리 (공통 카포 피치 연산은 `src/parser.js`)
  - [x] `src/fretboard.js`: 지판 SVG/DOM 렌더링 및 클릭 인터랙션 분리
  - [x] `src/editor.js`: 새 악보 추가 팝업 및 비주얼 그리드 에디터 분리
  - [x] `src/storage.js`: DOM 독립 IndexedDB 저장소 분리 및 트랜잭션 완료 처리
  - [x] `src/sheets.js`: 시트 동기화와 복사 동작 분리

## 2. 파서 로직 통합 (SSOT 달성)
- [x] 현재 4곳에 분산된 파서 진입점을 단일 함수로 통일하여 정규식 불일치 원천 차단
  - [x] `buildStructuredSong`
  - [x] `saveNewSongBtn`
  - [x] `parseTextToVeBars`
  - [x] `syncGoogleSheetSongs` (기존 TODO의 `parseSheetRows`에 해당하는 실제 시트 동기화 함수)

## 3. 단위 테스트 스위트 구축
- [x] `test/test-parser.js` 경량 단위 테스트 러너 구축
  - [x] 기본 단음 파싱 테스트 (LH 운지, 음이름, 옥타브, 줄 번호)
  - [x] 화음(+) 및 아르페지오 파싱 테스트
  - [x] 서브토큰(/) 8분음표/점음표/셋잇단 분할 테스트
  - [x] 마디 분할 정규식 회귀 테스트 (가사 내 슬래시, 서브토큰 슬래시 충돌 방지 검증)
  - [x] 카포 오프셋(0~12) 및 실음 변환 정확도 테스트
