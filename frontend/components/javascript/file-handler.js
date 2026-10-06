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

  SF.saveToProject = function (folderName, svgName, cssName) {
    var spriteName = String(svgName || folderName || 'sprite').replace(/\.svg$/i, '').trim();
    if (!spriteName) spriteName = 'sprite';

    $.ajax({
      url: _joinUrl(CATALYST_API_BASE, 'api/save-sprite'),
      type: 'POST',
      headers: _authHeaders(),
      contentType: 'application/json',
      dataType: 'json',
      data: JSON.stringify({
        spriteName: spriteName,
        svgContent: state.generatedSVG,
        cssContent: state.generatedCSS || ''
      }),
      success: function (res) {
        if (_isCatalystError(res) || (res && res.success === false)) {
          SF.showToast('Server save failed: ' + ((res && (res.message || res.error)) || 'could not save sprite'));
          return;
        }

        _clearGeneratedState();
        SF.showToast('Saved sprite to server');
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

    $.ajax({
      url: _joinUrl(CATALYST_API_BASE, 'api/list-saved-sprites'),
      type: 'GET',
      dataType: 'json',
      headers: _authHeaders(),
      success: function (data) {
        var sprites = (data && data.sprites) || [];
        var folders = sprites.map(function (sprite) {
          var spriteName = String(sprite.spriteName || 'sprite');
          var svgFileName = spriteName + '.svg';
          var svgKey = sprite.folderKey ? sprite.folderKey + '/' + svgFileName : null;
          var cssKey = sprite.hasCss && sprite.folderKey ? sprite.folderKey + '/' + spriteName + '.css' : null;
          var files = [{ name: svgFileName, size: 0 }];
          if (sprite.hasCss) files.push({ name: spriteName + '.css', size: 0 });
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
            canDelete: true,
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

  /**
   * Render saved folders grid
   */
  SF.renderSavedFolders = function (folders) {
    _savedFoldersCache = Array.isArray(folders) ? folders.slice() : [];
    if (typeof SF.refreshSpriteSourceOptions === 'function') SF.refreshSpriteSourceOptions();
    var $list = $('#savedFoldersList');
    if (!folders.length) {
      $list.html(
        '<div class="saved-empty">' +
          '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">' +
            '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' +
          '</svg>' +
          '<p>No saved sprite folders yet.<br>Generate a sprite and click <strong>"Save to Project"</strong> to store it here.</p>' +
        '</div>'
      );
      return;
    }

    function svgToDataUri(svgMarkup) {
      return 'data:image/svg+xml;base64,' + window.btoa(unescape(encodeURIComponent(svgMarkup)));
    }

    function _fmtDate(isoStr) {
      if (!isoStr) return '';
      try {
        var d = new Date(isoStr);
        var pad = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      } catch (e) { return isoStr; }
    }

    var html = '';
    folders.forEach(function (folder) {
      var openPath = folder.openPath || '';
      var entryId = folder.id || '';
      html += '<div class="saved-folder-card" data-folder="' + folder.name + '" data-entry-id="' + SF.escapeAttr(entryId) + '">';
      html += '<div class="saved-folder-header">';
      html += '<div class="saved-folder-icon">';
      html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">';
      html += '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>';
      html += '</svg></div>';
      html += '<div class="saved-folder-name-wrap">';
      html += '<div class="saved-folder-name">' + folder.name + '</div>';
      if (folder.savedAt) {
        html += '<div class="saved-folder-date">' + _fmtDate(folder.savedAt) + '</div>';
      }
      html += '</div>';
      html += '</div>';
      if (folder.previewSvg) {
        html += '<div class="saved-folder-preview">';
        html += '<img src="' + svgToDataUri(folder.previewSvg) + '" alt="' + folder.name + ' preview" loading="lazy">';
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
        html += '<span class="saved-file-name">' + file.name + '</span>';
        html += '<span class="saved-file-badge ' + badgeClass + '">' + ext + '</span>';
        html += '<span class="saved-file-size">' + SF.formatBytes(file.size) + '</span>';
        html += '</div>';
      });
      html += '</div>';
      html += '<div class="saved-folder-actions">';
      html += '<button class="btn btn-primary btn-sm saved-edit-btn" data-folder="' + SF.escapeAttr(folder.name) + '" title="Open SVG + CSS in Update Sprite to add or replace icons">';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      html += ' Add / Replace Icons';
      html += '</button>';
      html += '<button class="btn btn-ghost btn-sm saved-download-btn" data-folder="' + folder.name + '">';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      html += ' Download';
      html += '</button>';
      html += '<button class="btn btn-ghost btn-sm saved-open-btn" data-folder="' + folder.name + '" data-open-path="' + SF.escapeAttr(openPath) + '"' + (folder._ls ? ' data-ls="1"' : '') + '>';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      html += ' View';
      html += '</button>';
      html += '<button class="btn btn-ghost btn-sm saved-delete-btn" data-folder="' + folder.name + '" style="color:var(--danger);"' + (folder.canDelete === false ? ' disabled title="Delete is not available in hosted mode"' : '') + '>';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      html += ' Delete';
      html += '</button>';
      html += '</div>';
      html += '</div>';
    });
    $list.html(html);
  };

  function _findFolderByName(folderName) {
    return (_savedFoldersCache || []).find(function (f) {
      return f && f.name === folderName;
    }) || null;
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
  SF.editSavedSprite = function (folderName) {
    return SF.fetchSavedSpritePair(folderName).then(function (pair) {
      pair.label = 'Saved Sprites';
      pair.sourceKey = 'saved:' + folderName;
      pair.savedFolder = folderName;
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
  SF.deleteSavedFolder = function (folderName) {
    var lsAll = SF.lsFolders.get();
    var isLocal = lsAll.some(function (f) { return f.name === folderName && f._ls; });
    if (isLocal) {
      SF.lsFolders.remove(folderName);
      SF.showToast('Deleted ' + folderName);
      SF.loadSavedFolders();
      return;
    }

    // Look up the entry id from the render cache
    var cached = (_savedFoldersCache || []).find(function (f) { return f && f.name === folderName; });
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
