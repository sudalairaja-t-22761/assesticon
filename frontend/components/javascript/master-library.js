/**
 * SpriteForge - Master UI Library
 *
 * The CRM_UI_LIBRARY icon files (two sprites + two LESS files) shown on the
 * Saved Sprites page, read DIRECTLY from the repository branch — nothing is
 * stored in Catalyst. Visible to every signed-in user. "Sync from repo"
 * fetches the branch tip again and refreshes the Library page icons, which are
 * exploded from both sprites (see repo-library-icons.js). Saving from the
 * generator with the "commit to repository" option pushes a commit.
 */
(function (SF, $) {
  'use strict';

  var state = SF.state;
  var API_BASE = window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/';
  var AUTH_STORAGE_KEY = window.SF_AUTH_STORAGE_KEY || 'sf_session_id';
  var REPO_DEFAULTS = window.SF_REPO_CONFIG || {};

  state.masterLibrary = {
    config: null,     // public repo config from the server (falls back to SF_REPO_CONFIG)
    files: [],        // index entries from the server
    missing: [],
    lastSyncAt: null,
    lastCommit: null,
    lastCommitInfo: null,
    error: null,
    canCommit: null,       // from the server: may the signed-in user commit? (null = not known yet)
    commitRestrictedReason: null,
    source: null,     // { svg, styles } when the workspace was loaded from this folder
    loading: false
  };

  // The server fetches the branch on the first call; never leave the panel "Loading…" forever.
  var REPO_TIMEOUT_MS = 90000;

  function _xhrMessage(xhr, status, fallback) {
    var data = xhr && xhr.responseJSON;
    if (data && data.message) return data.message;
    if (status === 'timeout') return 'The repository did not answer within ' + (REPO_TIMEOUT_MS / 1000) + ' s. Try Refresh, or Test to check the connection.';
    if (status === 'parsererror') {
      // Usually the platform answering instead of the function (e.g. function timeout page).
      var raw = String((xhr && xhr.responseText) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return 'The server answered HTTP ' + ((xhr && xhr.status) || '?') + ' without JSON' +
        (raw ? ': "' + raw.slice(0, 140) + (raw.length > 140 ? '…' : '') + '"' : ' (empty body — the function probably timed out)') +
        '. Open ' + _url('api/master-library/diagnose') + ' to check the repository connection.';
    }
    if (xhr && xhr.status) return fallback + ' (HTTP ' + xhr.status + (xhr.statusText ? ' ' + xhr.statusText : '') + ')';
    return fallback + ' (no response — network or CORS error)';
  }
  SF.masterLibraryXhrMessage = _xhrMessage;
  SF.MASTER_LIBRARY_TIMEOUT_MS = REPO_TIMEOUT_MS;

  function _url(p) {
    return String(API_BASE || '').replace(/\/+$/, '') + '/' + String(p || '').replace(/^\/+/, '');
  }

  function _authHeaders() {
    if (!window.SF_AUTH_ENABLED) return {};
    var sessionId = '';
    try { sessionId = localStorage.getItem(AUTH_STORAGE_KEY) || (state.auth && state.auth.sessionId) || ''; }
    catch (e) { sessionId = (state.auth && state.auth.sessionId) || ''; }
    return sessionId ? { 'x-session-id': sessionId } : {};
  }

  function _isSignedOut() {
    return !!window.SF_AUTH_ENABLED && !(state.auth && state.auth.isAuthenticated);
  }

  function _cfg() {
    return state.masterLibrary.config || REPO_DEFAULTS || {};
  }

  function _esc(s) { return SF.escapeAttr(String(s == null ? '' : s)); }

  function _shortSha(sha) { return sha ? String(sha).slice(0, 8) : ''; }

  function _fmtDate(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return iso; }
  }

  function _fileWebUrl(name) {
    var files = (_cfg().files || []);
    for (var i = 0; i < files.length; i++) if (files[i].name === name) return files[i].webUrl || '';
    return '';
  }

  function _pairs() {
    var pairs = _cfg().pairs || [];
    if (pairs.length) return pairs;
    // Fallback: every svg on its own
    return (_cfg().files || []).filter(function (f) { return f.kind === 'sprite'; }).map(function (f) { return { svg: f.name, styles: null }; });
  }

  function _entry(name) {
    var files = state.masterLibrary.files || [];
    for (var i = 0; i < files.length; i++) if (files[i].name === name) return files[i];
    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Rendering
  // ───────────────────────────────────────────────────────────────────────────

  function _renderHeader() {
    var cfg = _cfg();
    var ml  = state.masterLibrary;
    $('#mlFolderName').text(cfg.folder || 'Master_ui_library');
    $('#mlRepoLink').attr('href', cfg.webUrl || cfg.baseUrl || '#').text(cfg.repoName || cfg.projectPath || 'repository');
    $('#mlBranch').text(cfg.branch || '');
    var meta = ['Live from repository'];
    var info = ml.lastCommitInfo || {};
    if (ml.lastCommit) {
      var c = 'Commit ' + _shortSha(ml.lastCommit);
      if (info.author) c += ' by ' + info.author;
      if (info.date) c += ' (' + _fmtDate(info.date) + ')';
      meta.push(c);
    }
    if (ml.lastSyncAt) meta.push('Fetched ' + _fmtDate(ml.lastSyncAt));
    if (cfg.configured === false) meta.push('Repository token not configured');
    if (ml.error) meta.push('Error: ' + ml.error);
    $('#mlMeta').text(meta.join(' · ')).attr('title', info.subject || '');
  }

  function _fileRow(name) {
    var e = _entry(name);
    var ext = String(name.split('.').pop() || '').toLowerCase();
    var badge = ext === 'svg' ? 'svg-badge' : 'css-badge';
    var html = '<div class="saved-file-item ml-file' + (e ? '' : ' ml-file-missing') + '" data-name="' + _esc(name) + '">';
    html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    html += '<span class="saved-file-name" title="' + _esc(e && e.repoPath || name) + '">' + _esc(name) + '</span>';
    html += '<span class="saved-file-badge ' + badge + '">' + _esc(ext) + '</span>';
    if (e) {
      html += '<span class="saved-file-size">' + SF.formatBytes(e.size || 0) + '</span>';
    } else {
      html += '<span class="saved-file-size">not in repo</span>';
    }
    html += '</div>';
    if (e) {
      var who = e.updatedBy && (e.updatedBy.name || e.updatedBy.email);
      var bits = [];
      if (e.updatedAt) bits.push(_fmtDate(e.updatedAt));
      if (who) bits.push('by ' + who);
      if (e.commit) bits.push(_shortSha(e.commit));
      if (e.pushError) bits.push('push failed');
      html += '<div class="ml-file-meta' + (e.pushError ? ' ml-file-warn' : '') + '" title="' + _esc(e.pushError || '') + '">' + _esc(bits.join(' · ')) + '</div>';
    }
    return html;
  }

  function _renderGrid() {
    var $grid = $('#mlFilesGrid');
    if (!$grid.length) return;
    var cfg = _cfg();
    var pairs = _pairs();

    if (!pairs.length) {
      $grid.html('<div class="saved-empty"><p>No repository files configured (REPO_FILES).</p></div>');
      return;
    }

    var html = '';
    pairs.forEach(function (p) {
      var svgEntry = _entry(p.svg);
      var hasSvg = !!svgEntry;
      html += '<div class="saved-folder-card ml-card" data-svg="' + _esc(p.svg) + '" data-styles="' + _esc(p.styles || '') + '">';
      html += '<div class="saved-folder-header">';
      html += '<div class="saved-folder-icon ml-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></div>';
      html += '<div class="saved-folder-name-wrap">';
      html += '<div class="saved-folder-name">' + _esc(p.svg.replace(/\.svg$/i, '')) + '</div>';
      html += '<div class="saved-folder-date">' + _esc(cfg.branch || '') + '</div>';
      html += '</div></div>';
      html += '<div class="saved-folder-files">';
      html += _fileRow(p.svg);
      if (p.styles) html += _fileRow(p.styles);
      html += '</div>';
      html += '<div class="saved-folder-actions ml-actions">';
      html += '<button class="btn btn-primary btn-sm ml-edit-btn"' + (hasSvg ? '' : ' disabled title="Not found in the repository branch"') + '>';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Add / Replace Icons</button>';
      html += '<button class="btn btn-ghost btn-sm ml-view-btn" data-name="' + _esc(p.svg) + '"' + (hasSvg ? '' : ' disabled') + '>';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> View</button>';
      html += '<button class="btn btn-ghost btn-sm ml-download-btn"' + (hasSvg ? '' : ' disabled') + '>';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download</button>';
      var web = _fileWebUrl(p.svg);
      html += '<a class="btn btn-ghost btn-sm ml-open-repo" href="' + _esc(web || cfg.webUrl || '#') + '" target="_blank" rel="noopener">';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> Repository</a>';
      html += '</div></div>';
    });
    $grid.html(html);
  }

  function _setBusy(busy, label) {
    state.masterLibrary.loading = !!busy;
    $('#mlSyncBtn, #mlTestBtn, #mlRefreshBtn').prop('disabled', !!busy);
    $('#mlStatus').text(label || '').toggleClass('hidden', !label);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Data loading
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Load the folder index. Hidden entirely while signed out: the folder is only
   * shown to logged-in users.
   */
  SF.loadMasterLibrary = function () {
    var $panel = $('#masterLibraryPanel');
    if (!$panel.length) return;

    if (_isSignedOut()) {
      $panel.addClass('hidden');
      return;
    }
    $panel.removeClass('hidden');
    _renderHeader();
    if (!state.masterLibrary.files.length) {
      $('#mlFilesGrid').html('<div class="saved-empty ml-loading"><p>Loading files from repository…</p></div>');
    }

    $.ajax({
      url: _url('api/master-library'),
      type: 'GET',
      dataType: 'json',
      timeout: REPO_TIMEOUT_MS,
      headers: _authHeaders(),
      success: function (data) { _applyListing(data); },
      error: function (xhr, status) {
        if (xhr && xhr.status === 401) {
          $panel.addClass('hidden');
          return;
        }
        var data = xhr && xhr.responseJSON;
        if (data && data.files && data.files.length) { _applyListing(data); return; }
        var msg = _xhrMessage(xhr, status, 'Could not read the repository from the server.');
        state.masterLibrary.error = msg;
        _renderHeader();
        $('#mlFilesGrid').html('<div class="saved-empty"><p>' + _esc(msg) + '</p></div>');
      }
    });
  };

  /** Apply a GET /api/master-library (or /sync, /save) payload to state and re-render. */
  function _applyListing(data) {
    if (!data) return;
    var ml = state.masterLibrary;
    ml.config = data.repo || ml.config;
    if (data.files) ml.files = data.files;
    if (data.missing) ml.missing = data.missing;
    if ('lastSyncAt' in data) ml.lastSyncAt = data.lastSyncAt || null;
    if ('lastCommit' in data) ml.lastCommit = data.lastCommit || null;
    if ('lastCommitInfo' in data) ml.lastCommitInfo = data.lastCommitInfo || null;
    ml.error = data.success === false ? (data.message || data.error || 'Repository error') : (data.error || null);
    if ('canCommit' in data) {
      ml.canCommit = !!data.canCommit;
      ml.commitRestrictedReason = data.commitRestrictedReason || null;
    }
    _renderHeader();
    _renderGrid();
  }

  /** Blocking popup for a refused commit. */
  SF.showRestrictedPopup = function (message) {
    if (!$('#mlRestrictedModal').length) {
      $('body').append(
        '<div class="modal-overlay hidden" id="mlRestrictedModal" role="alertdialog" aria-labelledby="mlRestrictedTitle">' +
          '<div class="modal-overlay-bg"></div>' +
          '<div class="modal modal-sm">' +
            '<div class="modal-header">' +
              '<h3 id="mlRestrictedTitle" style="color:var(--danger);">' +
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
                ' Repository access restricted' +
              '</h3>' +
              '<button class="modal-close" id="mlRestrictedClose" aria-label="Close">&times;</button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<p id="mlRestrictedText" style="margin:0 0 10px;color:var(--text-primary);"></p>' +
              '<p style="margin:0;font-size:12px;color:var(--text-secondary);">Nothing was committed. You can still download the files or save them to your own Saved Sprites.</p>' +
            '</div>' +
            '<div class="modal-footer">' +
              '<button class="btn btn-primary" id="mlRestrictedOk">OK</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
      $(document).on('click', '#mlRestrictedClose, #mlRestrictedOk, #mlRestrictedModal .modal-overlay-bg', function () {
        $('#mlRestrictedModal').addClass('hidden');
      });
    }
    $('#mlRestrictedText').text(message || 'You do not have commit access to this repository.');
    $('#mlRestrictedModal').removeClass('hidden');
    setTimeout(function () { $('#mlRestrictedOk').trigger('focus'); }, 30);
  };

  // Shared helpers for the Library page (repo-library-icons.js).
  SF.masterLibraryUrl = _url;
  SF.masterLibraryAuthHeaders = _authHeaders;
  SF.masterLibraryConfig = _cfg;
  SF.fetchMasterLibraryFile = function (name) { return _fetchFileText(name); };
  SF.isMasterLibrarySignedOut = _isSignedOut;

  /**
   * Fetch the latest branch tip from the repository and refresh this panel.
   * @param {{onDone?:Function}} [opts]
   */
  SF.syncMasterLibrary = function (opts) {
    opts = opts || {};
    _setBusy(true, 'Pulling latest files from repository…');
    $.ajax({
      url: _url('api/master-library/sync'),
      type: 'POST',
      dataType: 'json',
      timeout: REPO_TIMEOUT_MS,
      headers: _authHeaders(),
      success: function (data) {
        _setBusy(false, '');
        _applyListing(data);
        var n = (data && data.synced && data.synced.length) || 0;
        var miss = (data && data.missing) || [];
        SF.showToast('Synced ' + n + ' file(s) from ' + (_cfg().repoName || 'repository') +
          (data && data.lastCommit ? ' @ ' + _shortSha(data.lastCommit) : '') +
          (miss.length ? ' — missing: ' + miss.join(', ') : ''));
        if (typeof opts.onDone === 'function') opts.onDone(true, data);
      },
      error: function (xhr, status) {
        _setBusy(false, '');
        if (xhr && xhr.status === 401) {
          if (typeof SF.handleHostedUnauthorized === 'function') SF.handleHostedUnauthorized('Session expired. Sign in with Zoho and try again.');
          if (typeof opts.onDone === 'function') opts.onDone(false);
          return;
        }
        var data = xhr && xhr.responseJSON;
        if (data) _applyListing(data);
        var msg = _xhrMessage(xhr, status, 'Sync failed');
        SF.showToast('Repository sync failed: ' + msg);
        if (typeof opts.onDone === 'function') opts.onDone(false, data);
      }
    });
  };

  SF.testMasterLibraryConnection = function () {
    _setBusy(true, 'Testing repository connection…');
    $.ajax({
      url: _url('api/master-library/test-connection'),
      type: 'POST',
      dataType: 'json',
      timeout: REPO_TIMEOUT_MS,
      headers: _authHeaders(),
      complete: function (xhr, status) {
        _setBusy(false, '');
        var data = xhr.responseJSON || {};
        SF.showToast((data.success ? 'Repository OK: ' : 'Repository error: ') +
          (data.detail || data.message || _xhrMessage(xhr, status, 'no answer')) +
          (data.engine ? ' [' + data.engine + ']' : ''));
      }
    });
  };

  function _fetchFileText(name) {
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: _url('api/master-library/file?name=' + encodeURIComponent(name)),
        type: 'GET',
        dataType: 'text',
        timeout: REPO_TIMEOUT_MS,
        headers: _authHeaders(),
        success: function (t) { resolve(t || ''); },
        error: function (xhr, status) {
          var json = null;
          try { json = xhr.responseJSON || JSON.parse(xhr.responseText || ''); } catch (e) { json = null; }
          reject(new Error(_xhrMessage({ responseJSON: json, status: xhr.status, statusText: xhr.statusText }, status, 'Could not load ' + name)));
        }
      });
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Actions on a sprite pair
  // ───────────────────────────────────────────────────────────────────────────

  /** Load sprite + stylesheet into Update Sprite mode so icons can be added or replaced. */
  SF.editMasterLibraryPair = function (svgName, stylesName) {
    if (!svgName) return Promise.resolve(false);
    _setBusy(true, 'Opening ' + svgName + '…');
    var jobs = [_fetchFileText(svgName)];
    if (stylesName) jobs.push(_fetchFileText(stylesName).catch(function () { return ''; }));

    return Promise.all(jobs).then(function (res) {
      _setBusy(false, '');
      return !!SF.loadSpritePair({
        svgName: svgName, svgText: res[0] || '',
        cssName: stylesName || '', cssText: res[1] || '',
        label: _cfg().repoName || 'repository',
        sourceKey: 'repo:' + svgName + '|' + (stylesName || ''),
        repoSource: { svg: svgName, styles: stylesName || null }
      });
    }).catch(function (err) {
      _setBusy(false, '');
      SF.showToast(err.message || 'Could not open sprite');
      return false;
    });
  };

  SF.viewMasterLibraryFile = function (name) {
    if (!name) return;
    var target = _url('api/master-library/file?name=' + encodeURIComponent(name));
    var sessionId = _authHeaders()['x-session-id'];
    if (sessionId) target += '&session_id=' + encodeURIComponent(sessionId);
    window.open(target, '_blank');
  };

  SF.downloadMasterLibraryPair = function (svgName, stylesName) {
    var jobs = [_fetchFileText(svgName)];
    if (stylesName) jobs.push(_fetchFileText(stylesName).catch(function () { return ''; }));
    Promise.all(jobs).then(function (res) {
      if (!stylesName || typeof JSZip === 'undefined') {
        SF.downloadFile(res[0], svgName, 'image/svg+xml');
        return;
      }
      var zip = new JSZip();
      var folder = zip.folder(_cfg().folder || 'Master_ui_library');
      folder.file(svgName, res[0] || '');
      if (res[1]) folder.file(stylesName, res[1]);
      zip.generateAsync({ type: 'blob' }).then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = svgName.replace(/\.svg$/i, '') + '.zip';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 100);
        SF.showToast('Downloaded ' + svgName + (res[1] ? ' + ' + stylesName : ''));
      });
    }).catch(function (err) { SF.showToast(err.message || 'Download failed'); });
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Save to folder + commit to repository
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * @param {Array<{name:string, content:string}>} files  repo file names (crmutil_icons.svg …)
   * @param {string} message                               commit message
   * @param {{onSuccess?:Function}} [opts]
   */
  SF.saveToMasterLibrary = function (files, message, opts) {
    opts = opts || {};
    if (!files || !files.length) { SF.showToast('Nothing to save'); return; }
    if (state.masterLibrary.canCommit === false) {
      SF.showRestrictedPopup(state.masterLibrary.commitRestrictedReason);
      return;
    }
    SF.showToast('Committing to ' + (_cfg().repoName || 'repository') + ' (' + (_cfg().branch || '') + ')…');

    $.ajax({
      url: _url('api/master-library/save'),
      type: 'POST',
      headers: _authHeaders(),
      contentType: 'application/json',
      dataType: 'json',
      data: JSON.stringify({ files: files, message: message || '' }),
      success: function (res) {
        if (!res || res.success === false) {
          SF.showToast('Save failed: ' + ((res && res.message) || 'unknown error'));
          return;
        }
        _applyListing(res);
        var names = (res.stored || []).join(', ');
        if (res.pushed) {
          SF.showToast('Saved ' + names + ' and pushed commit ' + _shortSha(res.commit) + ' to ' + res.branch);
        } else if (res.changed === false && !res.pushError) {
          SF.showToast('Saved ' + names + ' — repository already up to date');
        } else {
          SF.showToast('Repository push failed for ' + names + ': ' + (res.pushError || 'unknown error'));
        }
        if (typeof opts.onSuccess === 'function') opts.onSuccess(res);
        if (typeof SF.resetSpriteWorkspace === 'function') SF.resetSpriteWorkspace();
      },
      error: function (xhr, status) {
        if (xhr && xhr.status === 401) {
          if (typeof SF.handleHostedUnauthorized === 'function') SF.handleHostedUnauthorized('Session expired. Sign in with Zoho and try again.');
          return;
        }
        if (xhr && xhr.status === 403 && xhr.responseJSON && xhr.responseJSON.restricted) {
          state.masterLibrary.canCommit = false;
          state.masterLibrary.commitRestrictedReason = xhr.responseJSON.message;
          SF.showRestrictedPopup(xhr.responseJSON.message);
          return;
        }
        var msg = _xhrMessage(xhr, status, 'Server error');
        SF.showToast('Commit to repository failed: ' + msg);
      }
    });
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Filename modal integration ("Save to Project" → commit option)
  // ───────────────────────────────────────────────────────────────────────────

  /** Show/prepare the repository option in the filename modal. Called before the modal opens. */
  SF.prepareRepoCommitGroup = function () {
    var $group = $('#fnameRepoGroup');
    if (!$group.length) return;
    var cfg = _cfg();
    var canCommit = !_isSignedOut() && (cfg.files || []).length > 0;
    $group.toggleClass('hidden', !canCommit);
    if (!canCommit) return;

    var restricted = state.masterLibrary.canCommit === false;
    $('#fnameRepoCommit').prop('disabled', restricted);
    $('#fnameRepoRestricted').remove();
    if (restricted) {
      $('#fnameRepoCommit').closest('label').after(
        '<p class="form-hint ml-restricted-hint" id="fnameRepoRestricted">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> ' +
          _esc(state.masterLibrary.commitRestrictedReason || 'You do not have commit access to this repository.') +
        '</p>');
    }

    $('#fnameRepoFolder').text(cfg.folder || 'Master_ui_library');
    $('#fnameRepoName').text(cfg.repoName || cfg.projectPath || 'repository');
    $('#fnameRepoBranch').text(cfg.branch || '');

    var sprites = (cfg.files || []).filter(function (f) { return f.kind === 'sprite'; });
    var styles  = (cfg.files || []).filter(function (f) { return f.kind === 'styles'; });
    var src = state.masterLibrary.source || {};
    var pairs = _pairs();

    $('#fnameRepoSvg').html(sprites.map(function (f) {
      return '<option value="' + _esc(f.name) + '"' + (f.name === src.svg ? ' selected' : '') + '>' + _esc(f.name) + '</option>';
    }).join(''));
    $('#fnameRepoLess').html('<option value="">— do not update stylesheet —</option>' + styles.map(function (f) {
      return '<option value="' + _esc(f.name) + '">' + _esc(f.name) + '</option>';
    }).join(''));

    function pickStyles() {
      var svg = $('#fnameRepoSvg').val();
      var pair = pairs.filter(function (p) { return p.svg === svg; })[0];
      var preferred = (src.svg === svg && src.styles) ? src.styles : (pair && pair.styles) || '';
      $('#fnameRepoLess').val(preferred || '');
    }
    $('#fnameRepoSvg').off('change.ml').on('change.ml', pickStyles);
    pickStyles();

    var hasCss = window.sfCssPreference !== false && !!state.generatedCSS;
    $('#fnameRepoLessGroup').toggleClass('hidden', !hasCss);

    var checked = !!state.masterLibrary.source && !restricted;
    $('#fnameRepoCommit').prop('checked', checked);
    $('#fnameRepoMessage').val('Update ' + ($('#fnameRepoSvg').val() || 'icons') + ' via SpriteForge');
    _applyRepoCommitToggle();
  };

  function _applyRepoCommitToggle() {
    var on = $('#fnameRepoCommit').is(':checked');
    $('#fnameRepoFields').toggleClass('hidden', !on);
    // File names are fixed by the repository when committing.
    $('#fnameSpriteGroup, #fnameCssGroup, #fnameFolderGroup').toggleClass('ml-dimmed', on);
    $('#fnameRepoHint').text(on
      ? 'Files are committed and pushed directly to ' + (_cfg().repoName || 'the repository') + ' branch ' + (_cfg().branch || '') + '. Names above are ignored.'
      : '');
  }

  /** Read the modal's repository option. Returns null when not enabled. */
  SF.readRepoCommitSelection = function () {
    if ($('#fnameRepoGroup').hasClass('hidden') || !$('#fnameRepoCommit').is(':checked')) return null;
    return {
      svg: $('#fnameRepoSvg').val() || '',
      styles: $('#fnameRepoLessGroup').hasClass('hidden') ? '' : ($('#fnameRepoLess').val() || ''),
      message: $.trim($('#fnameRepoMessage').val() || '')
    };
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Events
  // ───────────────────────────────────────────────────────────────────────────

  $(document)
    .on('click', '#mlSyncBtn', function () { SF.syncMasterLibrary(); })
    .on('click', '#mlTestBtn', function () { SF.testMasterLibraryConnection(); })
    .on('click', '#mlRefreshBtn', function () { SF.loadMasterLibrary(); })
    .on('click', '.ml-edit-btn', function () {
      var $card = $(this).closest('.ml-card');
      SF.editMasterLibraryPair($card.data('svg'), $card.data('styles') || null);
    })
    .on('click', '.ml-view-btn', function () { SF.viewMasterLibraryFile($(this).data('name')); })
    .on('click', '.ml-download-btn', function () {
      var $card = $(this).closest('.ml-card');
      SF.downloadMasterLibraryPair($card.data('svg'), $card.data('styles') || null);
    })
    .on('change', '#fnameRepoCommit', _applyRepoCommitToggle)
    .on('change', '#fnameRepoSvg', function () {
      $('#fnameRepoMessage').val('Update ' + ($(this).val() || 'icons') + ' via SpriteForge');
    });

  // Fetch public config early so the modal has repo names even before the folder loads.
  $(function () {
    $.ajax({
      url: _url('api/master-library/config'),
      type: 'GET',
      dataType: 'json',
      success: function (data) {
        if (data && data.success) state.masterLibrary.config = data;
        _renderHeader();
        if (typeof SF.refreshSpriteSourceOptions === 'function') SF.refreshSpriteSourceOptions();
      },
      error: function () { /* keep SF_REPO_CONFIG defaults */ }
    });
  });

})(window.SpriteForge, jQuery);
