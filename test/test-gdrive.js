'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

// Global mock localStorage/ls for test environment
const mockStorage = new Map();
globalThis.localStorage = {
  getItem(k){ return mockStorage.has(k) ? mockStorage.get(k) : null; },
  setItem(k, v){ mockStorage.set(k, String(v)); },
  removeItem(k){ mockStorage.delete(k); },
  clear(){ mockStorage.clear(); }
};

globalThis.ls = {
  get(k, d){
    try {
      const v = globalThis.localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch (e){ return d; }
  },
  set(k, v){
    try {
      globalThis.localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch (e){ return false; }
  },
  remove(k){
    try {
      globalThis.localStorage.removeItem(k);
      return true;
    } catch (e){ return false; }
  }
};

const gdrive = require(path.join(__dirname, '../src/gdrive.js'));

async function runTests(){
  let passedAssertions = 0;
  function markPassed(){ passedAssertions++; }

  // 1. Client ID 저장 및 조회 테스트
  mockStorage.clear();
  assert.equal(gdrive.getSavedClientId(), '', 'Initial clientId is empty string');
  markPassed();

  assert.equal(gdrive.saveClientId('  my-client-id-1234.apps.googleusercontent.com  '), true, 'saveClientId succeeds');
  markPassed();

  assert.equal(gdrive.getSavedClientId(), 'my-client-id-1234.apps.googleusercontent.com', 'Saved clientId is trimmed correctly');
  markPassed();

  // 2. requestAccessToken 테스트 (Mock Google Identity Services)
  gdrive._clearTokenCache();
  let initClientCalls = 0;
  let requestTokenCalls = 0;

  globalThis.google = {
    accounts: {
      oauth2: {
        initTokenClient(config){
          initClientCalls++;
          assert.equal(config.client_id, 'my-client-id-1234.apps.googleusercontent.com', 'OAuth config receives correct clientId');
          assert.equal(config.scope, 'https://www.googleapis.com/auth/drive.file', 'OAuth scope matches requirement');
          return {
            requestAccessToken(){
              requestTokenCalls++;
              config.callback({
                access_token: 'mock-access-token-xyz',
                expires_in: 3600
              });
            }
          };
        }
      }
    }
  };

  const token1 = await gdrive.requestAccessToken();
  assert.equal(token1, 'mock-access-token-xyz', 'requestAccessToken returns mock token');
  assert.equal(initClientCalls, 1, 'initTokenClient called once');
  markPassed();

  // 토큰 캐시 재사용 테스트
  const token2 = await gdrive.requestAccessToken();
  assert.equal(token2, 'mock-access-token-xyz', 'Cached token is returned');
  assert.equal(initClientCalls, 1, 'initTokenClient not called again within expiration cache');
  markPassed();

  // 3. findOrCreateGuitarStudioFolder 테스트
  const originalFetch = globalThis.fetch;
  try {
    // 3-1: 기존 폴더가 존재하는 경우
    globalThis.fetch = async function(url, options){
      assert.equal(options.headers.Authorization, 'Bearer mock-access-token-xyz', 'Authorization header is present');
      if (url.includes('/drive/v3/files?q=')){
        assert.ok(decodeURIComponent(url).includes("name='GuitarStudio'"), 'Query checks folder name');
        return {
          ok: true,
          status: 200,
          async json(){
            return { files: [{ id: 'existing-folder-id-777', name: 'GuitarStudio' }] };
          }
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    const folderId1 = await gdrive.findOrCreateGuitarStudioFolder('mock-access-token-xyz');
    assert.equal(folderId1, 'existing-folder-id-777', 'Existing folder ID returned');
    markPassed();

    // 3-2: 기존 폴더가 없어서 새로 생성하는 경우
    let folderCreated = false;
    globalThis.fetch = async function(url, options){
      if (options.method === 'GET' && url.includes('/drive/v3/files?q=')){
        return {
          ok: true,
          status: 200,
          async json(){ return { files: [] }; }
        };
      }
      if (options.method === 'POST' && url === 'https://www.googleapis.com/drive/v3/files'){
        folderCreated = true;
        const body = JSON.parse(options.body);
        assert.equal(body.name, 'GuitarStudio', 'Created folder name is GuitarStudio');
        assert.equal(body.mimeType, 'application/vnd.google-apps.folder', 'Folder mimeType is correct');
        assert.deepEqual(body.parents, ['root'], 'Parent is root');
        return {
          ok: true,
          status: 200,
          async json(){ return { id: 'newly-created-folder-id-888', name: 'GuitarStudio' }; }
        };
      }
      throw new Error('Unexpected fetch call: ' + url);
    };

    const folderId2 = await gdrive.findOrCreateGuitarStudioFolder('mock-access-token-xyz');
    assert.equal(folderId2, 'newly-created-folder-id-888', 'Newly created folder ID returned');
    assert.ok(folderCreated, 'POST create folder was called');
    markPassed();

    // 4. findBackupFile 테스트
    // 4-1: 백업 파일이 있는 경우
    globalThis.fetch = async function(url, options){
      assert.equal(options.headers.Authorization, 'Bearer mock-access-token-xyz');
      assert.ok(decodeURIComponent(url).includes("name='guitar-studio-backup.json'"), 'Query checks backup file name');
      assert.ok(decodeURIComponent(url).includes("'newly-created-folder-id-888' in parents"), 'Query checks folder parent');
      return {
        ok: true,
        status: 200,
        async json(){
          return {
            files: [{
              id: 'backup-file-id-999',
              name: 'guitar-studio-backup.json',
              modifiedTime: '2026-10-25T12:00:00.000Z',
              size: '12345'
            }]
          };
        }
      };
    };

    const backupFile = await gdrive.findBackupFile('mock-access-token-xyz', 'newly-created-folder-id-888');
    assert.deepEqual(backupFile, {
      id: 'backup-file-id-999',
      name: 'guitar-studio-backup.json',
      modifiedTime: '2026-10-25T12:00:00.000Z',
      size: '12345'
    }, 'findBackupFile returns first matching file metadata');
    markPassed();

    // 4-2: 백업 파일이 없는 경우
    globalThis.fetch = async function(){
      return {
        ok: true,
        status: 200,
        async json(){ return { files: [] }; }
      };
    };
    const noBackup = await gdrive.findBackupFile('mock-access-token-xyz', 'newly-created-folder-id-888');
    assert.equal(noBackup, null, 'findBackupFile returns null when no file found');
    markPassed();

    // 5. uploadBackupToDrive 테스트
    const dummyBackupData = {
      version: 1,
      exportedAt: '2026-10-25T12:00:00.000Z',
      appState: { vol: 0.8 },
      customSongs: [{ id: 'img-1', type: 'image', title: 'Test' }]
    };

    // 5-1: 신규 업로드 (existingFileId == null) -> POST multipart
    let newUploadCalled = false;
    globalThis.fetch = async function(url, options){
      assert.equal(url, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', 'POST URL is multipart upload');
      assert.equal(options.method, 'POST', 'POST method used for new upload');
      assert.ok(options.headers['Content-Type'].includes('multipart/related; boundary=-------guitarstudio314159'), 'Boundary matches spec');

      const bodyStr = options.body;
      assert.ok(bodyStr.includes('{"name":"guitar-studio-backup.json","parents":["folder-id-1"],"mimeType":"application/json"}'), 'Metadata part includes parents and mimeType');
      assert.ok(bodyStr.includes(JSON.stringify(dummyBackupData)), 'Payload part includes serialized data');
      newUploadCalled = true;
      return {
        ok: true,
        status: 200,
        async json(){
          return { id: 'uploaded-new-file-id', size: '1024' };
        }
      };
    };

    const newUploadResult = await gdrive.uploadBackupToDrive('mock-access-token-xyz', 'folder-id-1', null, dummyBackupData);
    assert.equal(newUploadResult.id, 'uploaded-new-file-id', 'New upload returns file metadata');
    assert.ok(newUploadCalled, 'New upload was called');
    markPassed();

    // 5-2: 갱신 업로드 (existingFileId != null) -> PATCH multipart
    let patchUploadCalled = false;
    globalThis.fetch = async function(url, options){
      assert.equal(url, 'https://www.googleapis.com/upload/drive/v3/files/existing-file-123?uploadType=multipart', 'PATCH URL contains fileId');
      assert.equal(options.method, 'PATCH', 'PATCH method used for existing file update');
      const bodyStr = options.body;
      assert.ok(bodyStr.includes('{"name":"guitar-studio-backup.json"}'), 'Update metadata has file name');
      assert.ok(bodyStr.includes(JSON.stringify(dummyBackupData)), 'Update body includes backup payload');
      patchUploadCalled = true;
      return {
        ok: true,
        status: 200,
        async json(){
          return { id: 'existing-file-123', size: '2048' };
        }
      };
    };

    const patchResult = await gdrive.uploadBackupToDrive('mock-access-token-xyz', 'folder-id-1', 'existing-file-123', dummyBackupData);
    assert.equal(patchResult.id, 'existing-file-123', 'Patch upload returns file metadata');
    assert.ok(patchUploadCalled, 'Patch upload was called');
    markPassed();

    // 6. downloadBackupFromDrive 테스트
    globalThis.fetch = async function(url, options){
      assert.equal(url, 'https://www.googleapis.com/drive/v3/files/download-target-id?alt=media', 'Download URL has alt=media');
      assert.equal(options.headers.Authorization, 'Bearer mock-access-token-xyz');
      return {
        ok: true,
        status: 200,
        async json(){
          return dummyBackupData;
        }
      };
    };

    const downloadedData = await gdrive.downloadBackupFromDrive('mock-access-token-xyz', 'download-target-id');
    assert.deepEqual(downloadedData, dummyBackupData, 'Downloaded data matches original backup payload');
    markPassed();

    // 7. API 에러 처리 테스트 (403 Forbidden 시 reject)
    globalThis.fetch = async function(){
      return {
        ok: false,
        status: 403,
        async text(){ return 'Permission denied'; }
      };
    };

    await assert.rejects(
      () => gdrive.downloadBackupFromDrive('mock-access-token-xyz', 'forbidden-id'),
      /드라이브 백업 파일 다운로드 실패 \(403\): Permission denied/,
      'Rejects with detailed status and message on HTTP error'
    );
    markPassed();

  } finally {
    globalThis.fetch = originalFetch;
  }

  process.stdout.write(`test-gdrive: ${passedAssertions} assertions passed successfully\n`);
}

runTests().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
