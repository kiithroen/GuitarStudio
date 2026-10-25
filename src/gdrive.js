'use strict';

(function(root){
  var CLIENT_ID_KEY = 'gs.googleClientId';
  var BACKUP_FILE_NAME = 'guitar-studio-backup.json';
  var FOLDER_NAME = 'GuitarStudio';
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var BOUNDARY = '-------guitarstudio314159';

  var tokenCache = null; // { clientId: string, accessToken: string, expiresAt: number }

  function getStorage(){
    if (typeof ls !== 'undefined' && ls && typeof ls.get === 'function') return ls;
    if (root && root.ls && typeof root.ls.get === 'function') return root.ls;
    return null;
  }

  var memoryStorage = {
    _data: {},
    get: function(k, d){
      if (typeof localStorage !== 'undefined'){
        try {
          var v = localStorage.getItem(k);
          return v == null ? d : JSON.parse(v);
        } catch (e){ return d; }
      }
      return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : d;
    },
    set: function(k, v){
      if (typeof localStorage !== 'undefined'){
        try {
          localStorage.setItem(k, JSON.stringify(v));
          return true;
        } catch (e){ return false; }
      }
      this._data[k] = v;
      return true;
    }
  };

  function getSavedClientId(){
    var store = getStorage() || memoryStorage;
    var val = store.get(CLIENT_ID_KEY, '');
    return typeof val === 'string' ? val : '';
  }

  function saveClientId(id){
    var store = getStorage() || memoryStorage;
    var str = typeof id === 'string' ? id.trim() : '';
    return store.set(CLIENT_ID_KEY, str);
  }

  function clearTokenCache(){
    tokenCache = null;
  }

  function requestAccessToken(clientId){
    var id = (clientId || getSavedClientId()).trim();
    if (!id){
      return Promise.reject(new Error('Google Client ID가 설정되지 않았습니다.'));
    }
    var now = Date.now();
    if (tokenCache && tokenCache.clientId === id && tokenCache.accessToken && tokenCache.expiresAt > now + 60000){
      return Promise.resolve(tokenCache.accessToken);
    }
    return new Promise(function(resolve, reject){
      if (!root.google || !root.google.accounts || !root.google.accounts.oauth2){
        reject(new Error('Google Identity Services SDK가 로드되지 않았습니다. 인터넷 연결을 확인해 주세요.'));
        return;
      }
      try {
        var client = root.google.accounts.oauth2.initTokenClient({
          client_id: id,
          scope: SCOPE,
          callback: function(tokenResponse){
            if (tokenResponse && tokenResponse.access_token){
              var expiresIn = Number(tokenResponse.expires_in) || 3600;
              tokenCache = {
                clientId: id,
                accessToken: tokenResponse.access_token,
                expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000
              };
              resolve(tokenResponse.access_token);
            } else {
              var errMsg = (tokenResponse && (tokenResponse.error_description || tokenResponse.error)) || 'Google OAuth 인증에 실패했습니다.';
              reject(new Error(errMsg));
            }
          },
          error_callback: function(err){
            var msg = (err && (err.message || err.type)) || 'Google OAuth 인증 중 오류가 발생했습니다.';
            reject(new Error(msg));
          }
        });
        client.requestAccessToken({ prompt: '' });
      } catch (e){
        reject(e);
      }
    });
  }

  async function findOrCreateGuitarStudioFolder(accessToken){
    if (!accessToken) throw new Error('액세스 토큰이 필요합니다.');
    var query = "mimeType='application/vnd.google-apps.folder' and name='" + FOLDER_NAME + "' and trashed=false";
    var searchUrl = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) + '&fields=' + encodeURIComponent('files(id,name)');
    var res = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken
      }
    });
    if (!res.ok){
      var errText = await res.text();
      throw new Error('폴더 검색 실패 (' + res.status + '): ' + errText);
    }
    var data = await res.json();
    if (data && Array.isArray(data.files) && data.files.length > 0 && data.files[0].id){
      return data.files[0].id;
    }

    var createUrl = 'https://www.googleapis.com/drive/v3/files';
    var createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({
        name: FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root']
      })
    });
    if (!createRes.ok){
      var createErr = await createRes.text();
      throw new Error('GuitarStudio 폴더 생성 실패 (' + createRes.status + '): ' + createErr);
    }
    var created = await createRes.json();
    if (!created || !created.id) throw new Error('생성된 폴더 ID가 올바르지 않습니다.');
    return created.id;
  }

  async function findBackupFile(accessToken, folderId){
    if (!accessToken) throw new Error('액세스 토큰이 필요합니다.');
    if (!folderId) throw new Error('폴더 ID가 필요합니다.');
    var query = "name='" + BACKUP_FILE_NAME + "' and '" + folderId + "' in parents and trashed=false";
    var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) + '&fields=' + encodeURIComponent('files(id,name,modifiedTime,size)');
    var res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken
      }
    });
    if (!res.ok){
      var errText = await res.text();
      throw new Error('백업 파일 검색 실패 (' + res.status + '): ' + errText);
    }
    var data = await res.json();
    if (data && Array.isArray(data.files) && data.files.length > 0){
      return data.files[0];
    }
    return null;
  }

  async function uploadBackupToDrive(accessToken, folderId, existingFileId, backupData){
    if (!accessToken) throw new Error('액세스 토큰이 필요합니다.');
    if (!existingFileId && !folderId) throw new Error('폴더 ID가 필요합니다.');

    var delimiter = '\r\n--' + BOUNDARY + '\r\n';
    var closeDelimiter = '\r\n--' + BOUNDARY + '--';

    var metadata = existingFileId
      ? { name: BACKUP_FILE_NAME }
      : { name: BACKUP_FILE_NAME, parents: [folderId], mimeType: 'application/json' };

    var multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(backupData) +
      closeDelimiter;

    var url = existingFileId
      ? ('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(existingFileId) + '?uploadType=multipart')
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    var method = existingFileId ? 'PATCH' : 'POST';

    var res = await fetch(url, {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'multipart/related; boundary=' + BOUNDARY
      },
      body: multipartRequestBody
    });
    if (!res.ok){
      var errText = await res.text();
      throw new Error('드라이브 백업 파일 업로드 실패 (' + res.status + '): ' + errText);
    }
    return await res.json();
  }

  async function downloadBackupFromDrive(accessToken, fileId){
    if (!accessToken) throw new Error('액세스 토큰이 필요합니다.');
    if (!fileId) throw new Error('파일 ID가 필요합니다.');
    var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media';
    var res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken
      }
    });
    if (!res.ok){
      var errText = await res.text();
      throw new Error('드라이브 백업 파일 다운로드 실패 (' + res.status + '): ' + errText);
    }
    return await res.json();
  }

  function formatBytes(bytes){
    if (bytes == null || isNaN(bytes)) return '0 B';
    var b = Number(bytes);
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function initGoogleDriveSyncUI(options){
    if (typeof document === 'undefined') return;
    options = options || {};
    var clientIdInput = document.getElementById('gdriveClientIdInput');
    var saveBtn = document.getElementById('saveGdriveClientIdBtn');
    var backupBtn = document.getElementById('gdriveBackupBtn');
    var restoreBtn = document.getElementById('gdriveRestoreBtn');
    var statusEl = document.getElementById('gdriveStatus');

    if (clientIdInput){
      clientIdInput.value = getSavedClientId();
    }

    function showStatus(msg, isError){
      if (!statusEl) return;
      statusEl.hidden = false;
      statusEl.textContent = msg;
      statusEl.style.color = isError ? 'var(--danger,#f44336)' : 'var(--accent,#4caf50)';
    }

    if (saveBtn){
      saveBtn.addEventListener('click', function(){
        var id = clientIdInput ? clientIdInput.value.trim() : '';
        saveClientId(id);
        showStatus('Client ID가 저장되었습니다.', false);
      });
    }

    if (backupBtn){
      backupBtn.addEventListener('click', async function(){
        var clientId = getSavedClientId();
        if (!clientId){
          showStatus('먼저 Google OAuth Client ID를 입력하고 저장해 주세요.', true);
          if (clientIdInput) clientIdInput.focus();
          return;
        }
        backupBtn.disabled = true;
        showStatus('구글 드라이브 연결 및 백업 진행 중...', false);
        try {
          var token = await requestAccessToken(clientId);
          var folderId = await findOrCreateGuitarStudioFolder(token);
          var existing = await findBackupFile(token, folderId);
          var payload = typeof options.getBackupPayload === 'function' ? await options.getBackupPayload() : {};
          var uploaded = await uploadBackupToDrive(token, folderId, existing ? existing.id : null, payload);
          var nowStr = new Date().toLocaleString();
          var sizeBytes = uploaded && uploaded.size != null
            ? Number(uploaded.size)
            : new Blob([JSON.stringify(payload)]).size;
          showStatus('구글 드라이브 백업 완료 (' + nowStr + ', ' + formatBytes(sizeBytes) + ')', false);
        } catch (err){
          showStatus('백업 실패: ' + (err && err.message ? err.message : err), true);
        } finally {
          backupBtn.disabled = false;
        }
      });
    }

    if (restoreBtn){
      restoreBtn.addEventListener('click', async function(){
        var clientId = getSavedClientId();
        if (!clientId){
          showStatus('먼저 Google OAuth Client ID를 입력하고 저장해 주세요.', true);
          if (clientIdInput) clientIdInput.focus();
          return;
        }
        restoreBtn.disabled = true;
        showStatus('구글 드라이브에서 백업 확인 중...', false);
        try {
          var token = await requestAccessToken(clientId);
          var folderId = await findOrCreateGuitarStudioFolder(token);
          var backupFile = await findBackupFile(token, folderId);
          if (!backupFile){
            showStatus('구글 드라이브 GuitarStudio 폴더에 백업 파일(guitar-studio-backup.json)이 없습니다.', true);
            return;
          }
          var modTimeStr = backupFile.modifiedTime ? new Date(backupFile.modifiedTime).toLocaleString() : '확인 불가';
          var confirmMsg = '구글 드라이브 백업(' + modTimeStr + ')을 복원하시겠습니까?\n현재 로컬 데이터가 덮어씌워집니다.';
          if (typeof window !== 'undefined' && window.confirm && !window.confirm(confirmMsg)){
            showStatus('복원이 취소되었습니다.', false);
            return;
          }
          showStatus('백업 파일 다운로드 및 복원 적용 중...', false);
          var data = await downloadBackupFromDrive(token, backupFile.id);
          if (typeof options.restoreBackupPayload === 'function'){
            await options.restoreBackupPayload(data);
          }
          showStatus('구글 드라이브 백업 복원 완료', false);
        } catch (err){
          showStatus('복원 실패: ' + (err && err.message ? err.message : err), true);
        } finally {
          restoreBtn.disabled = false;
        }
      });
    }
  }

  var GuitarDriveSync = {
    CLIENT_ID_KEY: CLIENT_ID_KEY,
    BACKUP_FILE_NAME: BACKUP_FILE_NAME,
    FOLDER_NAME: FOLDER_NAME,
    getSavedClientId: getSavedClientId,
    saveClientId: saveClientId,
    requestAccessToken: requestAccessToken,
    findOrCreateGuitarStudioFolder: findOrCreateGuitarStudioFolder,
    findBackupFile: findBackupFile,
    uploadBackupToDrive: uploadBackupToDrive,
    downloadBackupFromDrive: downloadBackupFromDrive,
    initGoogleDriveSyncUI: initGoogleDriveSyncUI,
    _clearTokenCache: clearTokenCache
  };

  if (typeof window !== 'undefined'){
    root.GuitarDriveSync = GuitarDriveSync;
    root.getSavedClientId = getSavedClientId;
    root.saveClientId = saveClientId;
    root.requestAccessToken = requestAccessToken;
    root.findOrCreateGuitarStudioFolder = findOrCreateGuitarStudioFolder;
    root.findBackupFile = findBackupFile;
    root.uploadBackupToDrive = uploadBackupToDrive;
    root.downloadBackupFromDrive = downloadBackupFromDrive;
    root.initGoogleDriveSyncUI = initGoogleDriveSyncUI;
  }
  if (typeof module !== 'undefined' && module.exports){
    module.exports = GuitarDriveSync;
  }
})(typeof window !== 'undefined' ? window : globalThis);
