(function (root) {
  'use strict';

  const $ = id => document.getElementById(id);
  let source = null;
  let sourceAlphaTex = null;
  let binaryExportError = null;
  let imageUrl = '';
  let onSave = null;

  function createId() {
    if (root.crypto?.randomUUID) return 'song-' + root.crypto.randomUUID();
    return 'song-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function setMessage(message, isError) {
    const box = $('editorMessage');
    box.textContent = message || '';
    box.classList.toggle('error', !!isError);
  }

  function destroyPreviewApi() {
    const box = $('editorPreview');
    if (box._api) {
      box._api.destroy();
      box._api = null;
    }
  }

  function cleanupPreview() {
    destroyPreviewApi();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = '';
    $('imagePreview').removeAttribute('src');
    $('imagePreview').classList.add('hidden');
  }

  function close() {
    cleanupPreview();
    $('editorDialog').close();
  }

  function open(options) {
    const settings = options || {};
    cleanupPreview();
    source = settings.song || null;
    onSave = settings.onSave || null;
    sourceAlphaTex = null;
    binaryExportError = null;

    const mode = settings.mode || 'new';
    $('editorHeading').textContent = mode === 'new'
      ? '새 악보'
      : mode === 'import' ? '가져온 악보 편집' : '악보 수정';
    $('editorTitle').value = source?.title || '';
    $('editorDescription').value = source?.description || source?.badge || '';
    $('editorAlphaTex').value = '';
    $('editorPreview').replaceChildren();
    $('editorPreview').classList.add('hidden');
    $('editorFileInfo').textContent = '';
    $('imageInput').value = '';
    setMessage('');

    let alphaTex = source?.format === 'alphatex' ? source.alphaTex : '';
    if (source?.format === 'binary') {
      try {
        alphaTex = root.TabEngine.toAlphaTex(root.TabEngine.importBytes(source.bytes));
        sourceAlphaTex = alphaTex;
        $('editorFileInfo').textContent = '원본 파일 ' + source.fileName
          + '을 보존 중이야. alphaTex를 바꾸면 텍스트 악보로 저장해.';
      } catch (error) {
        binaryExportError = error;
        setMessage('원본을 alphaTex로 변환하지 못했어: ' + error.message, true);
      }
    }

    if (mode === 'new' && !alphaTex) {
      alphaTex = '\\title "새 연습곡"\n\\tempo 64\n\\ts (3 4)\n\\capo 5\n:4 3.5 (0.3 1.2) 0.1 |\n3.5 (0.3 1.2) 0.1';
    }
    $('editorAlphaTex').value = alphaTex;
    if (source?.format === 'binary' && !binaryExportError) {
      sourceAlphaTex = $('editorAlphaTex').value;
    }
    $('editorDialog').showModal();
  }

  async function validate() {
    const box = $('editorPreview');
    destroyPreviewApi();
    try {
      const score = root.TabEngine.parseAlphaTex($('editorAlphaTex').value);
      const bars = score.tracks?.[0]?.staves?.[0]?.bars?.length || 0;
      box.replaceChildren();

      const summary = document.createElement('div');
      summary.className = 'notice';
      summary.textContent = 'alphaTex 검증 완료 · ' + bars + '마디';
      box.appendChild(summary);

      if (root.alphaTab?.AlphaTabApi) {
        const assetRoot = new URL('vendor/alphatab/dist/', location.href).href;
        box._api = new root.alphaTab.AlphaTabApi(box, {
          core: {
            scriptFile: assetRoot + 'alphaTab.min.js',
            fontDirectory: assetRoot + 'font/',
            engine: 'svg'
          },
          player: { enablePlayer: false },
          notation: { rhythmMode: root.alphaTab.TabRhythmMode.ShowWithBeams },
          display: { staveProfile: 'tab' }
        });
        box._api.error.on(error => {
          summary.textContent = '미리보기 렌더 오류: ' + error;
        });
        box._api.load(score);
      }

      box.classList.remove('hidden');
      setMessage('미리보기 검증 완료');
      return score;
    } catch (error) {
      box.textContent = error.message;
      box.classList.remove('hidden');
      setMessage('alphaTex 오류라 저장할 수 없어.', true);
      throw error;
    }
  }

  function buildSong(alphaTex) {
    const isBuiltInCopy = !!source?.builtin || !!source?.fromSheet;
    const hasReusableId = typeof source?.id === 'string' && source.id.length > 0;
    const id = source && !isBuiltInCopy && hasReusableId ? source.id : createId();
    const title = $('editorTitle').value.trim();
    const description = $('editorDescription').value.trim();
    if (!title) throw new Error('제목을 입력해줘.');

    const preservesBinary = source?.format === 'binary'
      && (sourceAlphaTex === null
        ? binaryExportError && alphaTex === ''
        : alphaTex === sourceAlphaTex);
    if (preservesBinary) {
      return {
        id, title, description, badge: description, format: 'binary',
        bytes: new Uint8Array(source.bytes), fileName: source.fileName,
        notationVersion: 3, builtin: false, fromSheet: false
      };
    }

    const song = {
      id, title, description, badge: description, format: 'alphatex', alphaTex,
      notationVersion: 3, builtin: false, fromSheet: false
    };
    if (source?.format === 'binary') {
      song.sourceOriginal = {
        format: 'binary', bytes: new Uint8Array(source.bytes), fileName: source.fileName
      };
    } else if (source?.sourceOriginal) {
      song.sourceOriginal = source.sourceOriginal;
    }
    if (source?.legacyOriginal) song.legacyOriginal = source.legacyOriginal;
    if (source?.warnings) song.warnings = source.warnings;
    return song;
  }

  async function save(event) {
    event.preventDefault();
    const text = $('editorAlphaTex').value;
    const unchangedBinary = source?.format === 'binary'
      && (sourceAlphaTex === null
        ? binaryExportError && text === ''
        : text === sourceAlphaTex);
    if (binaryExportError && !unchangedBinary) {
      setMessage('원본 파일을 변환하지 못했고 본문이 바뀌어 저장을 막았어: '
        + binaryExportError.message, true);
      return;
    }
    if (!unchangedBinary && !text.trim()) {
      setMessage('alphaTex를 입력해줘.', true);
      return;
    }

    $('saveSongBtn').disabled = true;
    try {
      if (unchangedBinary) {
        root.TabEngine.importBytes(source.bytes);
      } else {
        await validate();
      }
      const song = buildSong(text);
      if (!onSave) throw new Error('저장 연결이 준비되지 않았어.');
      await onSave(song);
      close();
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      $('saveSongBtn').disabled = false;
    }
  }

  function downloadAlphaTex() {
    const blob = new Blob([$('editorAlphaTex').value], { type: 'text/plain;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = ($('editorTitle').value || 'score').replace(/[\\/:*?"<>|]+/g, '_') + '.atex';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  }

  function previewImage(event) {
    const file = event.target.files?.[0];
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = file ? URL.createObjectURL(file) : '';
    $('imagePreview').src = imageUrl;
    $('imagePreview').classList.toggle('hidden', !imageUrl);
  }

  async function copyImagePrompt() {
    try {
      await navigator.clipboard.writeText(root.buildAiPromptText($('editorAlphaTex').value));
      setMessage('사진 악보 변환 프롬프트를 복사했어.');
    } catch (error) {
      setMessage('프롬프트 복사 실패: ' + error.message, true);
    }
  }

  function wire() {
    $('editorDialog').addEventListener('close', cleanupPreview);
    $('editorForm').addEventListener('submit', save);
    $('closeEditorBtn').addEventListener('click', close);
    $('previewAlphaTexBtn').addEventListener('click', () => validate().catch(() => {}));
    $('downloadAlphaTexBtn').addEventListener('click', downloadAlphaTex);
    $('imageInput').addEventListener('change', previewImage);
    $('copyImagePromptBtn').addEventListener('click', copyImagePrompt);
  }

  root.GuitarEditor = { open };
  document.addEventListener('DOMContentLoaded', wire);
})(typeof globalThis !== 'undefined' ? globalThis : this);
