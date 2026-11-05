/**
 * SpriteForge - File Handling
 * Upload, download, and drop zone management.
 */
(function (SF, $) {
  'use strict';

  var state = SF.state;
  var CATALYST_API_BASE = window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/';
  var AUTH_STORAGE_KEY = window.SF_AUTH_STORAGE_KEY || 'sf_session_id';
  var HOSTED_LIBRARY_PREFIX = '__library__';
  var _savedFoldersCache = [];

  function _joinUrl(base, path) {
    return String(base || '').replace(/\/+$/, '') + '/' + String(path || '').replace(/^\/+/, '');
  }

  function _isAuthMissing() {
    return !!window.SF_AUTH_ENABLED && !(state.auth && state.auth.isAuthenticated);
  }

  function _authHeaders() {
    if (!window.SF_AUTH_ENABLED) return {};
    var sessionId = '';
    try {
      sessionId = localStorage.getItem(AUTH_STORAGE_KEY) || (state.auth && state.auth.sessionId) || '';
    } catch (e) {
      sessionId = (state.auth && state.auth.sessionId) || '';
    }
    return sessionId ? { 'x-session-id': sessionId } : {};
  }

  function _handleUnauthorized(xhr, fallbackMessage) {
    if (!xhr || xhr.status !== 401) return false;
    if (typeof SF.handleHostedUnauthorized === 'function') {
      SF.handleHostedUnauthorized(fallbackMessage || 'Session expired. Sign in with Zoho and try again.');
    } else {
      SF.showToast(fallbackMessage || 'Session expired. Sign in with Zoho and try again.');
    }
    return true;
  }

  function _clearGeneratedState() {
    state.icons = [];
    state.generatedSVG = '';
    state.generatedCSS = '';
    SF.renderIconList();
    $('#outputSection').addClass('hidden');
    $('#spriteStatus').text('').attr('class', 'upload-status');
    $('#cssStatus').text('').attr('class', 'upload-status');
  }

  /**
   * Handle uploaded SVG icon files
   * @param {FileList} files
   */
  SF.handleSVGFiles = function (files, options) {
    options = options || {};
    var pending = 0;
    var total = 0;
    var skipped = 0;
    var svgFiles = [];
    var addedIcons = [];
    var rejected = [];

    Array.from(files).forEach(function (file) {
      if (!file.name.toLowerCase().endsWith('.svg')) {
        skipped++;
        return;
      }
      svgFiles.push(file);
    });

    total = svgFiles.length;

    if (total === 0) {
      alert(skipped > 0
        ? skipped + ' non-SVG file(s) skipped. Please upload only .svg files.'
        : 'No SVG files found in the selection.');
      return;
    }

    $('#svgDropZone').addClass('loading');

    svgFiles.forEach(function (file) {
      pending++;
      var reader = new FileReader();

      reader.onload = function (e) {
        // A whole sprite (several <symbol>s) is merged icon-by-icon, not added as one icon.
        if (!options.noSpriteDetect && typeof SF.mergeSpritePair === 'function' &&
            (String(e.target.result || '').match(/<symbol\b/g) || []).length > 1) {
          SF.mergeSpritePair({ svgName: file.name, svgText: e.target.result });
          pending--;
          if (pending === 0) {
            $('#svgDropZone').removeClass('loading');
            SF.renderIconList();
            SF.reportDuplicateIcons(rejected);
            if (typeof options.onComplete === 'function') options.onComplete(addedIcons);
          }
          return;
        }
        var parseName = file.name;
        if (options.overrideName && total === 1) {
          parseName = options.overrideName + '.svg';
        }
        var icon = SF.parseSVGFile(e.target.result, parseName);
        if (icon) {
          if (options.overrideName && total === 1) {
            icon.name = SF.cleanFileName(options.overrideName);
          }
          var conflict = SF.iconNameConflict(icon.name);
          if (conflict) {
            rejected.push({ name: icon.name, reason: conflict });
          } else {
            icon.gId = SF.makeGId(icon.name);
            icon.symbolId = SF.makeSymbolId(icon.name);
            state.icons.push(icon);
            addedIcons.push(icon);

            if (total === 1 && !options.skipAutoSave && typeof SF.saveSingleIconToLibraryFolder === 'function') {
              SF.saveSingleIconToLibraryFolder(icon.name, e.target.result, options.folderName);
            }
          }
        }

        pending--;
        if (pending === 0) {
          $('#svgDropZone').removeClass('loading');
          SF.renderIconList();
          SF.reportDuplicateIcons(rejected);
          if (typeof options.onComplete === 'function') {
            options.onComplete(addedIcons);
          }
        }
      };

      reader.onerror = function () {
        pending--;
        if (pending === 0) {
          $('#svgDropZone').removeClass('loading');
          SF.renderIconList();
          SF.reportDuplicateIcons(rejected);
          if (typeof options.onComplete === 'function') {
            options.onComplete(addedIcons);
          }
        }
      };

      reader.readAsText(file);
    });
  };

  /**
   * Fresh workspace: icons, loaded sprite + stylesheet, merged styles, output and the
   * source dropdowns. Used when switching Create ⇄ Update, on Clear All and after a commit.
   * @param {{keepNewIcons?:boolean}} [opts] keepNewIcons keeps icons added by hand (not from a sprite)
   */
  SF.resetSpriteWorkspace = function (opts) {
    opts = opts || {};
    state.icons = opts.keepNewIcons ? state.icons.filter(function (i) { return !i.isExisting && !i.mergedFrom; }) : [];
    state.generatedSVG = '';
    state.generatedCSS = '';
    state.sourceSpriteName = '';
    state.sourceCssName = '';
    state.sourceCssExt = 'css';
    state.sourceCssText = '';
    state.sourceCssClasses = {};
    state.sourceCssDims = {};
    state.sourceSavedFolder = '';
    state.sourceSavedShared = false; state.sourceSavedSharedWith = [];
    state.originalSpriteWidth = 0;
    state.originalSpriteHeight = 0;
    state.newSpriteBaseName = '';
    state.newCssBaseName = '';
    state.mergedCssRules = [];
    state.mergedCssVars = [];
    if (state.masterLibrary) state.masterLibrary.source = null;
    try { delete window.sfCssPreference; } catch (e) { window.sfCssPreference = undefined; }

    $('#outputSection').addClass('hidden');
    $('#svgoStatsBar').addClass('hidden');
    $('#spritePreview').empty();
    $('#svgCode, #cssCode').text('');
    $('#spriteStatus, #cssStatus, #mergeStatus').text('').attr('class', 'upload-status');
    $('#spriteDropZone .file-input, #cssDropZone .file-input, #svgDropZone .file-input, #mergeFilesInput').val('');
    if (typeof SF.resetSpriteSourcePickers === 'function') SF.resetSpriteSourcePickers();
    SF.renderIconList();
  };

  /**
   * Load an existing sprite from its text (Update Sprite mode).
   * Icons added earlier that clash with the sprite are dropped (duplicates are not allowed).
   * Clears any previously loaded stylesheet — load the matching one right after.
   * @returns {number} icons found
   */
  SF.loadSpriteText = function (svgText, fileName) {
    state.sourceSpriteName = String(fileName || 'sprite').replace(/\.svg$/i, '');
    state.sourceCssText = '';
    state.sourceCssClasses = {};
    state.sourceCssDims = {};

    var icons = SF.parseExistingSprite(svgText || '');
    if (!icons.length) {
      $('#spriteStatus')
        .text('No icons found in sprite. Check the file format.')
        .attr('class', 'upload-status error');
      return 0;
    }

    var pendingNew = state.icons.filter(function (i) { return !i.isExisting; });
    state.icons = icons;
    var rejected = [];
    pendingNew.forEach(function (icon) {
      var conflict = SF.iconNameConflict(icon.name);
      if (conflict) rejected.push({ name: icon.name, reason: conflict });
      else state.icons.push(icon);
    });

    SF.renderIconList();
    $('#spriteStatus')
      .text('Loaded ' + icons.length + ' icons from ' + state.sourceSpriteName + '.svg')
      .attr('class', 'upload-status success');
    $('#cssStatus').text('').attr('class', 'upload-status');
    SF.reportDuplicateIcons(rejected);
    return icons.length;
  };

  /**
   * Load the sprite's CSS/LESS from its text. The full text is kept: on Generate the
   * original stylesheet is preserved and only rules for new icons are appended.
   * @returns {number} rules with width/height found
   */
  SF.loadStylesheetText = function (cssText, fileName) {
    var lower = String(fileName || '').toLowerCase();
    state.sourceCssName = String(fileName || 'sprite').replace(/\.(css|less)$/i, '');
    state.sourceCssExt = /\.less$/.test(lower) ? 'less' : 'css';
    state.sourceCssText = String(cssText || '');
    state.sourceCssClasses = SF.extractStylesheetClasses(state.sourceCssText);

    var dims = SF.parseExistingCSS(state.sourceCssText);
    state.sourceCssDims = dims;
    var updated = 0;
    state.icons.forEach(function (icon) {
      var d = dims[icon.symbolId];
      if (!d || !icon.isExisting) return;
      if (d.width !== null) { icon.width = d.width; updated++; }
      if (d.height !== null) icon.height = d.height;
    });

    // A loaded stylesheet is always regenerated together with the sprite.
    window.sfCssPreference = true;

    var count = Object.keys(dims).length;
    SF.renderIconList();
    $('#cssStatus')
      .text('Loaded ' + state.sourceCssName + '.' + state.sourceCssExt + ' — ' + count + ' size rules' + (updated > 0 ? ', matched ' + updated + ' icons' : '') +
        '. New icons are appended; existing rules are kept.')
      .attr('class', 'upload-status success');
    return count;
  };

  /**
   * Load a sprite and its stylesheet together into Update Sprite mode.
   * @param {{svgName:string, svgText:string, cssName?:string, cssText?:string, label?:string}} pair
   */
  SF.loadSpritePair = function (pair) {
    if (!pair || !pair.svgText) { SF.showToast('Sprite is empty'); return false; }
    // Update Sprite mode + generator page. Coming from Create Sprite resets the workspace
    // but keeps icons added by hand; they are checked for duplicates below.
    if (typeof SF.setGeneratorMode === 'function') SF.setGeneratorMode('existing', { silent: true, keepNewIcons: true });
    else $('.sidebar-link[data-mode="existing"]').trigger('click');
    // Where the files came from (set after the mode switch, which clears it).
    if (state.masterLibrary) state.masterLibrary.source = pair.repoSource || null;
    state.sourceSavedFolder = pair.savedFolder || '';
    state.sourceSavedShared = !!pair.savedShared;
    state.sourceSavedSharedWith = pair.savedSharedWith || [];
    state.mergedCssRules = [];
    state.mergedCssVars = [];
    state.icons = state.icons.filter(function (i) { return !i.mergedFrom; });
    var n = SF.loadSpriteText(pair.svgText, pair.svgName);
    if (!n) return false;
    if (pair.cssText) SF.loadStylesheetText(pair.cssText, pair.cssName || (state.sourceSpriteName + '.css'));
    state.generatedSVG = '';
    state.generatedCSS = '';
    $('#outputSection').addClass('hidden');
    if (typeof SF.syncSpriteSourceSelect === 'function') SF.syncSpriteSourceSelect(pair.sourceKey || '');
    SF.showToast('Loaded ' + pair.svgName + (pair.cssText ? ' + ' + pair.cssName : '') + (pair.label ? ' from ' + pair.label : '') +
      ' — add or replace icons, then Generate → Save to Project');
    return true;
  };

  /**
   * Handle uploaded existing SVG sprite file
   * @param {File} file
   */
  SF.handleSpriteFile = function (file) {
    $('#spriteDropZone').addClass('loading');
    var reader = new FileReader();
    reader.onload = function (e) {
      $('#spriteDropZone').removeClass('loading');
      if (state.masterLibrary) state.masterLibrary.source = null;
      state.sourceSavedFolder = '';
      state.sourceSavedShared = false; state.sourceSavedSharedWith = [];
      state.mergedCssRules = [];
      state.mergedCssVars = [];
      state.icons = state.icons.filter(function (i) { return !i.mergedFrom; });
      SF.loadSpriteText(e.target.result, file.name);
      if (typeof SF.syncSpriteSourceSelect === 'function') SF.syncSpriteSourceSelect('');
    };
    reader.onerror = function () { $('#spriteDropZone').removeClass('loading'); };
    reader.readAsText(file);
  };

  /**
   * Handle uploaded CSS or LESS file for existing sprite
   * @param {File} file
   */
  SF.handleCSSFile = function (file) {
    var fileName = file.name.toLowerCase();
    if (!fileName.endsWith('.css') && !fileName.endsWith('.less')) {
      $('#cssStatus')
        .text('Unsupported file type. Please upload a .css or .less file.')
        .attr('class', 'upload-status error');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) { SF.loadStylesheetText(e.target.result, file.name); };
    reader.readAsText(file);
  };

  /**
   * Smart download: update mode uses the original filename,
   * new mode prompts the user (or re-uses a previously entered name).
   * @param {'svg'|'css'} type
   */
  SF.downloadWithName = function (type) {
    var ext = type === 'svg' ? 'svg' : (state.sourceCssExt || 'css');

    if (state.mode === 'existing') {
      // Update mode → use the original source filename
      var baseName;
      if (type === 'svg') {
        baseName = state.sourceSpriteName || 'sprite';
      } else {
        baseName = state.sourceCssName || state.sourceSpriteName || 'sprite';
      }
      var content = type === 'svg' ? state.generatedSVG : state.generatedCSS;
      var mime    = type === 'svg' ? 'image/svg+xml' : 'text/css';
      SF.downloadFile(content, baseName + '.' + ext, mime);
    } else {
      // New mode → names already set via generate modal, download directly
      var name;
      if (type === 'svg') {
        name = state.newSpriteBaseName || 'sprite';
      } else {
        name = state.newCssBaseName || state.newSpriteBaseName || 'sprite';
      }
      var content = type === 'svg' ? state.generatedSVG : state.generatedCSS;
      var mime    = type === 'svg' ? 'image/svg+xml' : 'text/css';
      SF.downloadFile(content, name + '.' + ext, mime);
    }
  };

  /**
   * Download SVG and CSS as a ZIP folder
   * @param {string} folderName - Name of the folder inside the ZIP
   * @param {string} svgName - SVG filename (with extension)
   * @param {string} cssName - CSS filename (with extension)
   */
  SF.downloadAsFolder = function (folderName, svgName, cssName) {
    if (typeof JSZip === 'undefined') {
      alert('JSZip library not loaded. Cannot create folder download.');
      return;
    }
    var zip = new JSZip();
    var folder = zip.folder(folderName);
    folder.file(svgName, state.generatedSVG);
    folder.file(cssName, state.generatedCSS);
    zip.generateAsync({ type: 'blob' }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = folderName + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 100);
    });
  };

  /**
   * Download content as a file
   */
  SF.downloadFile = function (content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 100);
  };

  /**
   * Save SVG and CSS to a folder on the server
   */
  function _isCatalystError(res) {
    return res && res.status === 'failure' && res.data && res.data.error_code;
  }

  // ── LocalStorage fallback (for deployed environments without server.py) ─────
  var LS_KEY = 'spriteforge_folders_v1';

  SF.lsFolders = {
    get: function () {
      try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
      catch (e) { return []; }
    },
    set: function (folders) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(folders)); return true; }
      catch (e) { SF.showToast('Browser storage full — delete some sprites to free space'); return false; }
    },
    upsert: function (entry) {
      var all = SF.lsFolders.get();
      var found = false;
      for (var i = 0; i < all.length; i++) {
        if (all[i].name === entry.name) { all[i] = entry; found = true; break; }
      }
      if (!found) all.push(entry);
      return SF.lsFolders.set(all);
    },
    remove: function (name) {
      return SF.lsFolders.set(SF.lsFolders.get().filter(function (f) { return f.name !== name; }));
    }
  };

  function _lsSaveSprite(folderName, svgName, cssName) {
    var files = [
      { name: svgName, size: (state.generatedSVG || '').length }
    ];
    if (cssName) {
      files.push({ name: cssName, size: (state.generatedCSS || '').length });
    }

    SF.lsFolders.upsert({
      name: folderName,
      files: files,
      previewSvg: state.generatedSVG || '',
      kind: 'sprite',
      _ls: true,
      _svgContent: state.generatedSVG || '',
      _cssContent: state.generatedCSS || ''
    });
    _clearGeneratedState();
    SF.showToast('Saved to browser storage');
    SF.loadSavedFolders();
  }
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Save the generated sprite (+ CSS) to the server under the signed-in user's folder.
   * opts.shared = true lists the folder for every user; opts.sharedWith = [emails] for those users only;
   * otherwise only the owner and admins see it.
   */
  SF.saveToProject = function (folderName, svgName, cssName, opts) {
    var spriteName = String(svgName || folderName || 'sprite').replace(/\.svg$/i, '').trim();
    if (!spriteName) spriteName = 'sprite';
    var shared = !!(opts && opts.shared);
    var sharedWith = shared || !opts || !opts.sharedWith ? [] : opts.sharedWith;

    $.ajax({
      url: _joinUrl(CATALYST_API_BASE, 'api/save-sprite'),
      type: 'POST',
      headers: _authHeaders(),
      contentType: 'application/json',
      dataType: 'json',
      data: JSON.stringify({
        spriteName: spriteName,
        svgContent: state.generatedSVG,
        cssContent: state.generatedCSS || '',
        shared: shared,
        sharedWith: sharedWith
      }),
      success: function (res) {
        if (_isCatalystError(res) || (res && res.success === false)) {
          SF.showToast('Server save failed: ' + ((res && (res.message || res.error)) || 'could not save sprite'));
          return;
        }

        _clearGeneratedState();
        SF.showToast(shared || sharedWith.length ? 'Saved sprite · ' + SF.spriteShare.describe({ shared: shared, sharedWith: sharedWith }) : 'Saved sprite to your folders');
        SF.loadSavedFolders();
      },
      error: function (xhr) {
        if (_handleUnauthorized(xhr, 'Session expired while saving sprite. Sign in and try again.')) {
          return;
        }
        // Fallback to localStorage if server unavailable
        _lsSaveSprite(folderName, svgName, cssName);
      }
    });
  };

  /**
   * Load and render saved sprite folders from server
   */
  SF.loadSavedFolders = function () {
    // If auth is enabled and the user is not signed in, show the sign-in prompt instead
    if (_isAuthMissing()) {
      var $list = $('#savedFoldersList');
      if ($list.length) {
        $list.html(
          '<div class="saved-empty saved-auth-required">' +
            '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">' +
              '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
              '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
            '</svg>' +
            '<p>Sign in to view your saved sprites.</p>' +
          '</div>'
        );
      }
      return;
    }

    var scope = $('#savedScope').val() === 'mine' ? '?scope=mine' : '';
    $.ajax({
      url: _joinUrl(CATALYST_API_BASE, 'api/list-saved-sprites' + scope),
      type: 'GET',
      dataType: 'json',
      headers: _authHeaders(),
      success: function (data) {
        var sprites = (data && data.sprites) || [];
        _savedViewer = (data && data.viewer) || null;
        var folders = sprites.map(function (sprite) {
          var spriteName = String(sprite.spriteName || 'sprite');
          var svgFileName = spriteName + '.svg';
          var svgKey = sprite.folderKey ? sprite.folderKey + '/' + svgFileName : null;
          var cssKey = sprite.hasCss && sprite.folderKey ? sprite.folderKey + '/' + spriteName + '.css' : null;
          var files = [{ name: svgFileName, size: sprite.svgBytes || 0 }];
          if (sprite.hasCss) files.push({ name: spriteName + '.css', size: sprite.cssBytes || 0 });
          // Build openPath so View button works: route through /api/get-sprite-file
          var openPath = svgKey ? _joinUrl(CATALYST_API_BASE, 'api/get-sprite-file?key=' + encodeURIComponent(svgKey)) : '';
          return {
            id: sprite.id,
            name: spriteName,
            files: files,
            previewSvg: '',
            kind: 'sprite',
            savedAt: sprite.savedAt || null,
            folderKey: sprite.folderKey || null,
            svgKey: svgKey,
            cssKey: cssKey,
            openPath: openPath,
            owner: sprite.owner || null,
            shared: !!sprite.shared,
            sharedWith: sprite.sharedWith || [],
            sharedWithMe: !!sprite.sharedWithMe,
            isMine: !!sprite.isMine,
            canManage: sprite.canManage !== false,
            canDelete: sprite.canManage !== false,
            _hosted: true
          };
        });
        var lsSprites = SF.lsFolders.get().filter(function (f) { return f._ls && f.kind !== 'icon'; });
        SF.renderSavedFolders(folders.concat(lsSprites));
      },
      error: function (xhr) {
        if (_handleUnauthorized(xhr, 'Session expired. Sign in with Zoho to load saved sprites.')) {
          return;
        }
        var lsSprites = SF.lsFolders.get().filter(function (f) { return f._ls && f.kind !== 'icon'; });
        if (lsSprites.length) {
          SF.renderSavedFolders(lsSprites);
        } else {
          var msg = 'Could not load saved sprites from server.';
          $('#savedFoldersList').html('<div class="saved-empty"><p>' + msg + '</p></div>');
        }
      }
    });
  };

  // Who is looking (from the server: { email, name, role }) and the current search text.
  var _savedViewer = null;
  var _savedSearch = '';

  function _savedEsc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _savedFmtDate(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    } catch (e) { return isoStr; }
  }

  function _svgToDataUri(svgMarkup) {
    return 'data:image/svg+xml;base64,' + window.btoa(unescape(encodeURIComponent(svgMarkup)));
  }

  /** Reference used on card buttons: the server id when there is one (names can repeat across users). */
  function _savedRef(folder) { return String(folder.id || folder.name || ''); }

  function _savedMatches(folder, q) {
    if (!q) return true;
    var hay = [folder.name, folder.owner && folder.owner.name, folder.owner && folder.owner.email]
      .concat((folder.files || []).map(function (f) { return f && f.name; }))
      .filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  /** One saved-folder card. */
  function _savedCardHtml(folder, viewer) {
    var openPath = folder.openPath || '';
    var ref = _savedRef(folder);
    var name = _savedEsc(folder.name);
    var ownerName = folder.owner && (folder.owner.name || folder.owner.email);
    var isMine = !!folder.isMine || !!folder._ls;
    var canManage = folder.canManage !== false && folder.canDelete !== false;
    var html = '';

    html += '<div class="saved-folder-card" data-folder="' + _savedEsc(ref) + '" data-entry-id="' + _savedEsc(folder.id || '') + '">';
    html += '<div class="saved-folder-header">';
    html += '<div class="saved-folder-icon">';
    html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">';
    html += '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>';
    html += '</svg></div>';
    html += '<div class="saved-folder-name-wrap">';
    html += '<div class="saved-folder-name">' + name + '</div>';
    if (folder.savedAt) html += '<div class="saved-folder-date">' + _savedFmtDate(folder.savedAt) + '</div>';
    // Who saved it
    html += '<div class="saved-folder-owner">';
    html += '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    if (folder._ls) html += '<span>This browser only</span>';
    else if (isMine) html += '<span class="saved-you">You</span>' + (ownerName ? '<span>· ' + _savedEsc(ownerName) + '</span>' : '');
    else if (ownerName) html += '<span title="' + _savedEsc(folder.owner.email || '') + '">' + _savedEsc(ownerName) + '</span>';
    else html += '<span>Older save · no owner</span>';
    html += '</div>';
    html += '</div>';
    if (!folder._ls) {
      var withList = folder.sharedWith || [];
      var PEOPLE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
      html += folder.shared
        ? '<span class="saved-shared-badge" title="Visible to every signed-in user"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Shared</span>'
        : withList.length
          ? '<span class="saved-shared-badge saved-shared-badge--people" title="Shared with: ' + _savedEsc(withList.map(SF.spriteShare.nameOf).join(', ')) + '">' + PEOPLE + ' ' + withList.length + (withList.length === 1 ? ' person' : ' people') + '</span>'
          : folder.sharedWithMe && !isMine
            ? '<span class="saved-shared-badge saved-shared-badge--people" title="The owner shared this folder with you">' + PEOPLE + ' Shared with you</span>'
            : (folder.owner ? '<span class="saved-shared-badge saved-shared-badge--private" title="Only the owner and admins see this folder">Private</span>' : '');
    }
    html += '</div>';
    if (folder.previewSvg) {
      html += '<div class="saved-folder-preview">';
      html += '<img src="' + _svgToDataUri(folder.previewSvg) + '" alt="' + name + ' preview" loading="lazy">';
      html += '</div>';
    }
    html += '<div class="saved-folder-files">';
    (folder.files || []).forEach(function (file) {
      var ext = file.name.split('.').pop().toLowerCase();
      var badgeClass = ext === 'svg' ? 'svg-badge' : 'css-badge';
      if (!openPath && ext === 'svg' && !folder._ls && !folder._hosted) {
        openPath = 'saved-sprites/' + encodeURIComponent(folder.name) + '/' + encodeURIComponent(file.name);
      }
      html += '<div class="saved-file-item">';
      html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">';
      html += '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
      html += '</svg>';
      html += '<span class="saved-file-name">' + _savedEsc(file.name) + '</span>';
      html += '<span class="saved-file-badge ' + badgeClass + '">' + ext + '</span>';
      html += '<span class="saved-file-size">' + SF.formatBytes(file.size) + '</span>';
      html += '</div>';
    });
    html += '</div>';
    html += '<div class="saved-folder-actions">';
    html += '<button class="btn btn-primary btn-sm saved-edit-btn" data-folder="' + _savedEsc(ref) + '" data-name="' + name + '" title="Open SVG + CSS in Update Sprite to add or replace icons">';
    html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    html += ' Add / Replace Icons';
    html += '</button>';
    html += '<button class="btn btn-ghost btn-sm saved-download-btn" data-folder="' + _savedEsc(ref) + '" data-name="' + name + '">';
    html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    html += ' Download';
    html += '</button>';
    html += '<button class="btn btn-ghost btn-sm saved-open-btn" data-folder="' + _savedEsc(ref) + '" data-name="' + name + '" data-open-path="' + SF.escapeAttr(openPath) + '"' + (folder._ls ? ' data-ls="1"' : '') + '>';
    html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    html += ' View';
    html += '</button>';
    if (folder.id && !folder._ls && canManage) {
      var anyShare = folder.shared || (folder.sharedWith || []).length > 0;
      html += '<button class="btn btn-ghost btn-sm saved-share-btn' + (anyShare ? ' is-shared' : '') + '" data-entry-id="' + _savedEsc(folder.id) + '" data-name="' + name + '" title="Choose who can see this folder: private, all users or specific users">';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Share';
      html += '</button>';
    }
    // Delete: enabled only for the owner (or an admin); shared folders of other users show a locked button.
    if (canManage) {
      html += '<button class="btn btn-ghost btn-sm saved-delete-btn" data-folder="' + _savedEsc(ref) + '" data-name="' + name + '" title="Delete this folder (asks first)">';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      html += ' Delete';
      html += '</button>';
    } else {
      var lockTip = 'Only ' + (ownerName ? _savedEsc(ownerName) : 'the owner') + ' or an admin can delete this folder';
      html += '<button class="btn btn-ghost btn-sm saved-delete-btn saved-delete-btn--locked" disabled aria-disabled="true" tabindex="-1" data-tooltip="' + lockTip + '" title="' + lockTip + '">';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
      html += ' Delete';
      html += '</button>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  /**
   * Group folders per user (asset-folder style). Admins see every user as a group; everyone else sees
   * "My saved folders" and "Shared by other users".
   * @returns {Array<{key, name, email, cls, folders}>}
   */
  function _savedGroups(folders, viewer) {
    var isAdmin = viewer.role === 'admin';
    var me = String(viewer.email || '').toLowerCase();
    var map = {}, order = [];
    function group(key, name, email, cls) {
      if (!map[key]) { map[key] = { key: key, name: name, email: email || '', cls: cls || '', folders: [] }; order.push(key); }
      return map[key];
    }
    folders.forEach(function (f) {
      var ownerEmail = String((f.owner && f.owner.email) || '').toLowerCase();
      var ownerName = (f.owner && (f.owner.name || f.owner.email)) || '';
      if (f._ls || f.isMine || (ownerEmail && ownerEmail === me)) {
        group('me', isAdmin ? (viewer.name || viewer.email || 'My saved folders') : 'My saved folders', isAdmin ? me : '', 'saved-user-group--me').folders.push(f);
      } else if (isAdmin && ownerEmail) {
        group('u:' + ownerEmail, ownerName, ownerEmail, '').folders.push(f);
      } else if (!ownerEmail) {
        group('legacy', isAdmin ? 'Older saves (no owner)' : 'Shared with everyone', '', 'saved-user-group--legacy').folders.push(f);
      } else {
        group('shared', 'Shared by other users', '', 'saved-user-group--shared').folders.push(f);
      }
    });
    // Mine first, then users by name, then shared / older saves.
    var tail = { shared: 1, legacy: 2 };
    order.sort(function (a, b) {
      if (a === 'me') return -1; if (b === 'me') return 1;
      var ta = tail[a] || 0, tb = tail[b] || 0;
      if (ta !== tb) return ta - tb;
      return map[a].name.localeCompare(map[b].name);
    });
    return order.map(function (k) { return map[k]; });
  }

  /**
   * Render saved folders grouped per user, filtered by the search box.
   */
  SF.renderSavedFolders = function (folders) {
    _savedFoldersCache = Array.isArray(folders) ? folders.slice() : [];
    if (typeof SF.refreshSpriteSourceOptions === 'function') SF.refreshSpriteSourceOptions();
    var $list = $('#savedFoldersList');
    var viewer = _savedViewer || {};
    var isAdmin = viewer.role === 'admin';
    $('#savedScope').toggleClass('hidden', !isAdmin);
    $('#savedOwnerTag').text(viewer.email ? (isAdmin ? '· Admin view: all users' : '· ' + (viewer.name || viewer.email)) : '');

    if (!folders.length) {
      $list.removeClass('saved-grouped').html(
        '<div class="saved-empty">' +
          '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">' +
            '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' +
          '</svg>' +
          '<p>No saved sprite folders yet.<br>Generate a sprite and click <strong>"Save to Project"</strong> to store it here.</p>' +
        '</div>'
      );
      return;
    }

    var q = $.trim(_savedSearch).toLowerCase();
    var shown = folders.filter(function (f) { return _savedMatches(f, q); });
    if (!shown.length) {
      $list.removeClass('saved-grouped').html(
        '<div class="saved-empty"><p>No saved folders match <strong>' + _savedEsc(_savedSearch) + '</strong>.</p></div>');
      return;
    }

    var html = '';
    _savedGroups(shown, viewer).forEach(function (g) {
      var sharedCount = g.folders.filter(function (f) { return f.shared; }).length;
      var initial = (g.name || '?').trim().charAt(0).toUpperCase();
      html += '<details class="saved-user-group ' + g.cls + '" open data-group="' + _savedEsc(g.key) + '">';
      html += '<summary>';
      html += '<span class="saved-user-avatar">' + _savedEsc(initial) + '</span>';
      html += '<span><div class="saved-user-name">' + _savedEsc(g.name) + '</div>' +
        (g.email ? '<div class="saved-user-email">' + _savedEsc(g.email) + '</div>' : '') + '</span>';
      html += '<span class="saved-user-count"><span>' + g.folders.length + ' folder' + (g.folders.length === 1 ? '' : 's') + '</span>' +
        (sharedCount ? '<span>' + sharedCount + ' shared</span>' : '') + '</span>';
      html += '</summary>';
      html += '<div class="saved-folders-grid">';
      g.folders.forEach(function (f) { html += _savedCardHtml(f, viewer); });
      html += '</div></details>';
    });
    $list.addClass('saved-grouped').html(html);
  };

  // Search (folder name, file name, user name or email) — filters the cached listing.
  $(document).on('input search', '#savedSearch', function () {
    _savedSearch = $(this).val() || '';
    SF.renderSavedFolders(_savedFoldersCache);
  });
  // Admin scope: all users / only mine.
  $(document).on('change', '#savedScope', function () { SF.loadSavedFolders(); });

  // Share a folder (owner or admin): private, all users or specific users.
  $(document).on('click', '.saved-share-btn', function () {
    var id = $(this).data('entryId');
    if (!id) return;
    var folder = (_savedFoldersCache || []).filter(function (f) { return String(f.id) === String(id); })[0] || {};
    SF.spriteShare.open({ id: id, name: $(this).data('name') || folder.name || id, shared: !!folder.shared, sharedWith: folder.sharedWith || [] },
      function () { SF.loadSavedFolders(); });
  });

  /** Find a saved folder by its server id, or by name (browser-storage entries and older callers). */
  function _findFolderByName(ref) {
    var list = _savedFoldersCache || [];
    var key = String(ref == null ? '' : ref);
    return list.find(function (f) { return f && f.id && String(f.id) === key; }) ||
      list.find(function (f) { return f && f.name === key; }) || null;
  }

  function _downloadZip(folderName, svgName, svgContent, cssName, cssContent) {
    if (typeof JSZip === 'undefined') {
      SF.showToast('JSZip library not loaded. Cannot download bundle.');
      return;
    }

    var zip = new JSZip();
    var folder = zip.folder(folderName || 'sprite');
    folder.file(svgName || 'sprite.svg', svgContent || '');
    folder.file(cssName || 'sprite.css', cssContent || '');

    zip.generateAsync({ type: 'blob' }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (folderName || 'sprite') + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 100);
      SF.showToast('Downloaded SVG + CSS');
    });
  }

  function _fetchText(url, onSuccess, onFail, headers) {
    $.ajax({
      url: url,
      type: 'GET',
      dataType: 'text',
      headers: headers || {},
      success: function (text) { onSuccess(text || ''); },
      error: function (xhr) { if (typeof onFail === 'function') onFail(xhr); }
    });
  }

  /** Saved sprite folders (last listing) — used by the Update Sprite source picker. */
  SF.getSavedSpriteFolders = function () {
    return (_savedFoldersCache || []).filter(function (f) { return f && f.kind !== 'icon'; });
  };

  /**
   * Fetch a saved sprite's SVG and CSS text.
   * @returns {Promise<{svgName, svgText, cssName, cssText}>}
   */
  SF.fetchSavedSpritePair = function (folderName) {
    return new Promise(function (resolve, reject) {
      var folder = _findFolderByName(folderName);
      if (!folder) { reject(new Error('Saved sprite "' + folderName + '" not found')); return; }
      var files = folder.files || [];
      var svgFile = files.find(function (f) { return f && /\.svg$/i.test(f.name || ''); });
      var cssFile = files.find(function (f) { return f && /\.(css|less)$/i.test(f.name || ''); });
      var svgName = (svgFile && svgFile.name) || ((folder.name || 'sprite') + '.svg');
      var cssName = (cssFile && cssFile.name) || '';

      if (folder._ls) {
        resolve({ svgName: svgName, svgText: folder._svgContent || folder.previewSvg || '', cssName: cssName || (folder.name + '.css'), cssText: folder._cssContent || '' });
        return;
      }
      var svgUrl = folder.svgKey ? _joinUrl(CATALYST_API_BASE, 'api/get-sprite-file?key=' + encodeURIComponent(folder.svgKey)) : (folder.openPath || '');
      var cssUrl = folder.cssKey ? _joinUrl(CATALYST_API_BASE, 'api/get-sprite-file?key=' + encodeURIComponent(folder.cssKey)) : '';
      if (!cssName && folder.cssKey) cssName = folder.cssKey.split('/').pop();
      if (!svgUrl) { reject(new Error('No SVG file stored for "' + folderName + '"')); return; }
      var headers = _authHeaders();
      _fetchText(svgUrl, function (svgText) {
        if (!cssUrl) { resolve({ svgName: svgName, svgText: svgText, cssName: '', cssText: '' }); return; }
        _fetchText(cssUrl, function (cssText) {
          resolve({ svgName: svgName, svgText: svgText, cssName: cssName, cssText: cssText });
        }, function () {
          resolve({ svgName: svgName, svgText: svgText, cssName: '', cssText: '' });
        }, headers);
      }, function (xhr) {
        if (_handleUnauthorized(xhr, 'Session expired. Sign in with Zoho to open saved sprites.')) { reject(new Error('Unauthorized')); return; }
        reject(new Error('Could not load ' + svgName));
      }, headers);
    });
  };

  /** Open a saved sprite (SVG + CSS) in Update Sprite mode. */
  /** @returns {Promise<boolean>} whether the sprite was loaded */
  SF.editSavedSprite = function (ref) {
    var folder = _findFolderByName(ref);
    return SF.fetchSavedSpritePair(ref).then(function (pair) {
      pair.label = 'Saved Sprites';
      pair.sourceKey = 'saved:' + (folder ? _savedRef(folder) : String(ref));
      pair.savedFolder = folder ? folder.name : String(ref);
      pair.savedShared = !!(folder && folder.shared && (folder.isMine || folder._ls));
      pair.savedSharedWith = folder && folder.isMine ? (folder.sharedWith || []) : [];
      return !!SF.loadSpritePair(pair);
    }).catch(function (err) { SF.showToast(err.message || 'Could not open saved sprite'); return false; });
  };

  $(document).on('click', '.saved-edit-btn', function () {
    var name = $(this).data('folder');
    if (name) SF.editSavedSprite(String(name));
  });

  SF.downloadSavedBundle = function (folderName) {
    var folder = _findFolderByName(folderName);
    if (!folder) {
      SF.showToast('Folder not found');
      return;
    }

    var files = folder.files || [];
    var svgFile = files.find(function (f) { return f && /\.svg$/i.test(f.name || ''); });
    var cssFile = files.find(function (f) { return f && /\.(css|less)$/i.test(f.name || ''); });
    var svgName = (svgFile && svgFile.name) || ((folder.name || 'sprite') + '.svg');
    var cssName = (cssFile && cssFile.name) || ((folder.name || 'sprite') + '.css');

    if (folder._ls) {
      var svgLocal = folder._svgContent || folder.previewSvg || '';
      var cssLocal = folder._cssContent || '/* CSS content unavailable in local cache */\n';
      _downloadZip(folder.name, svgName, svgLocal, cssName, cssLocal);
      return;
    }

    // Use the /api/get-sprite-file endpoint for both SVG and CSS
    var svgUrl = folder.svgKey
      ? _joinUrl(CATALYST_API_BASE, 'api/get-sprite-file?key=' + encodeURIComponent(folder.svgKey))
      : (folder.openPath || '');
    var cssUrl = folder.cssKey
      ? _joinUrl(CATALYST_API_BASE, 'api/get-sprite-file?key=' + encodeURIComponent(folder.cssKey))
      : '';
    var headers = _authHeaders();

    if (!svgUrl) {
      SF.showToast('No SVG file available for download');
      return;
    }

    _fetchText(svgUrl, function (svgContent) {
      if (cssUrl) {
        _fetchText(cssUrl, function (cssContent) {
          _downloadZip(folder.name, svgName, svgContent, cssName, cssContent);
        }, function () {
          _downloadZip(folder.name, svgName, svgContent, cssName, '/* CSS file is not available for this sprite */\n');
        }, headers);
      } else {
        // No CSS — just download SVG directly
        SF.downloadFile(svgContent, svgName, 'image/svg+xml');
        SF.showToast('Downloaded SVG');
      }
    }, function (xhr) {
      SF.showToast('Failed to download sprite SVG');
    }, headers);
  };

  /**
   * Delete a saved sprite folder — uses entry id from cache when available
   */
  SF.deleteSavedFolder = function (ref) {
    var cached = _findFolderByName(ref);
    var folderName = cached ? cached.name : String(ref);
    var lsAll = SF.lsFolders.get();
    var isLocal = lsAll.some(function (f) { return f.name === folderName && f._ls; }) && !(cached && cached.id);
    if (isLocal) {
      SF.lsFolders.remove(folderName);
      SF.showToast('Deleted ' + folderName);
      SF.loadSavedFolders();
      return;
    }

    // Entry id from the render cache
    var entryId = cached && cached.id;

    if (entryId) {
      $.ajax({
        url: _joinUrl(CATALYST_API_BASE, 'api/delete-saved-sprite/' + encodeURIComponent(entryId)),
        type: 'DELETE',
        headers: _authHeaders(),
        success: function (res) {
          if (res && res.success) {
            SF.showToast('Deleted ' + folderName);
            SF.loadSavedFolders();
          }
        },
        error: function (xhr) {
          if (_handleUnauthorized(xhr, 'Session expired while deleting sprite. Sign in and try again.')) { return; }
          SF.showToast('Failed to delete sprite');
        }
      });
    } else {
      // Fallback to old endpoint for legacy entries
      $.ajax({
        url: _joinUrl(CATALYST_API_BASE, 'delete-sprite/' + encodeURIComponent(folderName)),
        type: 'DELETE',
        headers: _authHeaders(),
        success: function (res) {
          if (res && res.success) {
            SF.showToast('Deleted ' + folderName);
            SF.loadSavedFolders();
          }
        },
        error: function (xhr) {
          if (_handleUnauthorized(xhr, 'Session expired while deleting sprite. Sign in and try again.')) { return; }
          SF.showToast('Failed to delete sprite');
        }
      });
    }
  };

  /**
   * Initialize a drop zone with file handling
   * @param {string} selector - jQuery selector for the drop zone
   * @param {Function} callback - Called with FileList
   */
  SF.setupDropZone = function (selector, callback) {
    var $zone = $(selector);
    var $input = $zone.find('.file-input');

    $zone.on('click', function (e) {
      if (!$(e.target).is('.file-input')) {
        $input.trigger('click');
      }
    });

    $input.on('change', function () {
      if (this.files && this.files.length > 0) {
        callback(this.files);
      }
      $(this).val('');
    });

    $zone.on('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      $(this).addClass('drag-active');
    });

    $zone.on('dragleave', function (e) {
      e.preventDefault();
      e.stopPropagation();
      $(this).removeClass('drag-active');
    });

    $zone.on('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      $(this).removeClass('drag-active');

      var files = e.originalEvent.dataTransfer.files;
      if (files && files.length > 0) {
        callback(files);
      }
    });
  };

})(window.SpriteForge, jQuery);
