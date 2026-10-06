/**
 * SpriteForge - Icon Library (Flat Library View)
 * Icons are shown as individual items in Library (no folder picker in UI).
 */
(function (SF, $) {
  'use strict';

  var LIB_KEY = 'sf_library_icons_v2';
  var LIBRARY_FOLDER = 'library';
  var INTERNAL_PREFIX = '__library__';
  function _isLocalLikeHost() {
    var protocol = String(window.location.protocol || '').toLowerCase();
    var host = String(window.location.hostname || '').toLowerCase();
    if (protocol === 'file:') return true;
    if (!host) return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
    if (/\.local$/.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
    return false;
  }

  var IS_LOCAL_HOST = _isLocalLikeHost();
  var BACKEND_MODE = window.SF_BACKEND_MODE || (IS_LOCAL_HOST ? 'local' : 'catalyst');
  var CATALYST_API_BASE = window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/';
  var AUTH_STORAGE_KEY = window.SF_AUTH_STORAGE_KEY || 'sf_session_id';

  SF.libState = {
    icons: [],        // combined list: repository sprite icons + user Library icons
    userIcons: [],    // uploaded Library icons (server + localStorage)
    repoIcons: [],    // exploded from the repository sprites (repo-library-icons.js)
    sourceFilter: 'all', // 'all' | 'mine' | '<sprite base name>'
    search: '',
    selected: {},
    authBlocked: false
  };

  function rebuildLibraryIcons() {
    SF.libState.icons = (SF.libState.repoIcons || []).concat(SF.libState.userIcons || []);
    pruneSelected();
  }

  /** Called by repo-library-icons.js whenever the repository sprites are (re)loaded. */
  SF.setRepoLibraryIcons = function (icons) {
    SF.libState.repoIcons = Array.isArray(icons) ? icons : [];
    var f = SF.libState.sourceFilter;
    if (f !== 'all' && f !== 'mine' && !SF.libState.repoIcons.some(function (i) { return i.sprite === f; })) {
      SF.libState.sourceFilter = 'all';
    }
    rebuildLibraryIcons();
    SF.renderLibraryGrid();
  };

  SF.setLibrarySourceFilter = function (filter) {
    SF.libState.sourceFilter = filter || 'all';
    try { localStorage.setItem('sf_lib_source_filter', SF.libState.sourceFilter); } catch (e) {}
    SF.renderLibraryGrid();
  };
  try { SF.libState.sourceFilter = localStorage.getItem('sf_lib_source_filter') || 'all'; } catch (e) {}

  function matchesSource(icon) {
    var f = SF.libState.sourceFilter || 'all';
    if (f === 'all') return true;
    if (f === 'mine') return icon.source !== 'repo';
    return icon.source === 'repo' && icon.sprite === f;
  }

  function matchesSearch(icon, search) {
    if (!search) return true;
    return String(icon.name || '').toLowerCase().indexOf(search) !== -1 ||
      (icon.source === 'repo' && String(icon.symbolId || '').toLowerCase().indexOf(search) !== -1);
  }

  function visibleLibraryIcons() {
    var search = (SF.libState.search || '').toLowerCase();
    return (SF.libState.icons || []).filter(function (icon) {
      return icon && matchesSource(icon) && matchesSearch(icon, search);
    });
  }

  function selectedIds() {
    return Object.keys(SF.libState.selected || {}).filter(function (id) {
      return !!SF.libState.selected[id];
    });
  }

  function pruneSelected() {
    var valid = {};
    (SF.libState.icons || []).forEach(function (icon) {
      if (!icon || !icon.id) return;
      valid[icon.id] = true;
    });
    Object.keys(SF.libState.selected || {}).forEach(function (id) {
      if (!valid[id]) delete SF.libState.selected[id];
    });
  }

  function updateLibrarySelectionUi(visibleIcons) {
    var selectedCount = selectedIds().length;
    $('#libSelectedCount').text(selectedCount + ' selected');
    $('#libAddSelectedBtn').prop('disabled', selectedCount === 0);
    $('#libGenerateWebfontBtn').prop('disabled', selectedCount === 0);

    var visible = Array.isArray(visibleIcons) ? visibleIcons : [];
    var selectableVisible = visible.length;
    var selectedVisible = visible.filter(function (icon) {
      return !!(icon && SF.libState.selected && SF.libState.selected[icon.id]);
    }).length;

    var allVisibleSelected = selectableVisible > 0 && selectedVisible === selectableVisible;
    $('#libSelectAllVisible').prop('checked', allVisibleSelected);
  }

  function isHostedMode() {
    return BACKEND_MODE === 'catalyst' && !IS_LOCAL_HOST;
  }

  function isHostedAuthMissing() {
    return isHostedMode() && !!window.SF_AUTH_ENABLED && !(SF.state && SF.state.auth && SF.state.auth.isAuthenticated);
  }

  function hostedAuthHeaders() {
    if (!isHostedMode() || !window.SF_AUTH_ENABLED) return {};
    var sessionId = '';
    try {
      sessionId = localStorage.getItem(AUTH_STORAGE_KEY) || (SF.state && SF.state.auth && SF.state.auth.sessionId) || '';
    } catch (e) {
      sessionId = (SF.state && SF.state.auth && SF.state.auth.sessionId) || '';
    }
    return sessionId ? { 'x-session-id': sessionId } : {};
  }

  function handleHostedUnauthorized(xhr, fallbackMessage) {
    if (!xhr || xhr.status !== 401) return false;
    if (typeof SF.handleHostedUnauthorized === 'function') {
      SF.handleHostedUnauthorized(fallbackMessage || 'Session expired. Sign in with Zoho and try again.');
    } else {
      SF.showToast(fallbackMessage || 'Session expired. Sign in with Zoho and try again.');
    }
    return true;
  }

  function joinUrl(base, path) {
    return String(base || '').replace(/\/+$/, '') + '/' + String(path || '').replace(/^\/+/, '');
  }

  function isCatalystError(res) {
    return res && res.status === 'failure' && res.data && res.data.error_code;
  }

  function svgToDataUri(svgMarkup) {
    return 'data:image/svg+xml;base64,' + window.btoa(unescape(encodeURIComponent(svgMarkup || '')));
  }

  function loadHostedPreviewSvg(icon, $img) {
    if (!icon || !icon.openPath || !$img || !$img.length) return;

    $.ajax({
      url: icon.openPath,
      type: 'GET',
      dataType: 'text',
      headers: hostedAuthHeaders(),
      success: function (svgText) {
        if (svgText) {
          $img.attr('src', svgToDataUri(svgText));
        }
      },
      error: function (xhr) {
        if (handleHostedUnauthorized(xhr, 'Session expired. Sign in with Zoho to load Library previews.')) {
          return;
        }
      }
    });
  }

  function fileBaseName(fileName) {
    return String(fileName || '').replace(/\.svg$/i, '');
  }

  function parseLsIcons() {
    try {
      var raw = localStorage.getItem(LIB_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeLsIcons(items) {
    try { localStorage.setItem(LIB_KEY, JSON.stringify(items || [])); } catch (e) {}
  }

  function upsertLsIcon(iconName, svgContent) {
    var safeIconName = SF.cleanFileName(iconName) || 'icon';
    var all = parseLsIcons();
    var next = [];
    var found = false;

    all.forEach(function (item) {
      if (item && item.name === safeIconName) {
        next.push({
          id: 'ls:' + safeIconName,
          name: safeIconName,
          svgContent: svgContent || '',
          size: (svgContent || '').length,
          updatedAt: Date.now()
        });
        found = true;
      } else {
        next.push(item);
      }
    });

    if (!found) {
      next.push({
        id: 'ls:' + safeIconName,
        name: safeIconName,
        svgContent: svgContent || '',
        size: (svgContent || '').length,
        updatedAt: Date.now()
      });
    }

    writeLsIcons(next);
  }

  function removeLsIconById(iconId) {
    if (!iconId || iconId.indexOf('ls:') !== 0) return;
    var target = iconId.slice(3);
    var all = parseLsIcons().filter(function (item) {
      return item && item.name !== target;
    });
    writeLsIcons(all);
  }

  function buildServerIconList(folders) {
    var out = [];

    function isIconFolder(folder) {
      if (!folder) return false;
      if (folder.kind === 'icon') return true;
      if (folder.kind === 'sprite') return false;
      var files = folder.files || [];
      if (!files.length) return false;
      return files.every(function (f) {
        var n = (f && f.name ? f.name : '').toLowerCase();
        return n.endsWith('.svg');
      });
    }

    (folders || []).forEach(function (folder) {
      if (!isIconFolder(folder)) return;

      (folder.files || []).forEach(function (file) {
        var fileName = (file && file.name) || '';
        if (!/\.svg$/i.test(fileName)) return;

        var cleanIconName = SF.cleanFileName(fileBaseName(fileName)) || fileBaseName(fileName) || 'icon';
        var iconId = 'srv:' + folder.name + '/' + fileName;
        var openPath = 'saved-sprites/' + encodeURIComponent(folder.name) + '/' + encodeURIComponent(fileName);

        out.push({
          id: iconId,
          name: cleanIconName,
          size: file.size || 0,
          openPath: openPath,
          deleteFolder: folder.name,
          deleteFile: fileName,
          canDelete: true,
          source: 'server'
        });
      });
    });

    return out;
  }

  function buildHostedIconList(sprites) {
    var out = [];
    (sprites || []).forEach(function (sprite) {
      var rawName = (sprite && sprite.name) ? String(sprite.name) : 'icon';
      if (rawName.indexOf(INTERNAL_PREFIX) !== 0) return;

      var baseName = fileBaseName(rawName);
      var displayBaseName = baseName.slice(INTERNAL_PREFIX.length) || 'icon';
      var cleanIconName = SF.cleanFileName(displayBaseName) || displayBaseName || 'icon';
      var fileName = cleanIconName + '.svg';
      var openPath = joinUrl(CATALYST_API_BASE, 'sprite/' + encodeURIComponent(baseName) + '.svg');

      out.push({
        id: 'srv:' + fileName,
        name: cleanIconName,
        size: (sprite && sprite.size) || 0,
        openPath: openPath,
        deleteName: baseName,
        canDelete: true,
        source: 'server'
      });
    });
    return out;
  }

  function verifyHostedSaved(iconName, onDone) {
    $.ajax({
      url: joinUrl(CATALYST_API_BASE, 'list-sprites'),
      type: 'GET',
      dataType: 'json',
      headers: hostedAuthHeaders(),
      success: function (data) {
        var sprites = (data && data.sprites) || [];
        var expected = fileBaseName(iconName || '').toLowerCase();
        var ok = sprites.some(function (sprite) {
          var n = fileBaseName((sprite && sprite.name) || '').toLowerCase();
          return n === expected;
        });
        onDone(!!ok);
      },
      error: function (xhr) {
        handleHostedUnauthorized(xhr, 'Session expired while verifying library save. Sign in and try again.');
        onDone(false);
      }
    });
  }

  function tryHostedDelete(iconName, done) {
    var safeName = fileBaseName(iconName || '');
    var candidates = [
      { method: 'DELETE', url: joinUrl(CATALYST_API_BASE, 'delete-sprite/' + encodeURIComponent(safeName)) },
      { method: 'DELETE', url: joinUrl(CATALYST_API_BASE, 'delete-sprite/' + encodeURIComponent(safeName) + '.svg') },
      { method: 'DELETE', url: joinUrl(CATALYST_API_BASE, 'sprite/' + encodeURIComponent(safeName)) },
      { method: 'DELETE', url: joinUrl(CATALYST_API_BASE, 'sprite/' + encodeURIComponent(safeName) + '.svg') },
      {
        method: 'POST',
        url: joinUrl(CATALYST_API_BASE, 'delete-sprite'),
        body: JSON.stringify({ spriteName: safeName }),
        contentType: 'application/json'
      },
      {
        method: 'POST',
        url: joinUrl(CATALYST_API_BASE, 'save-sprite'),
        body: JSON.stringify({ spriteName: safeName, mode: 'delete' }),
        contentType: 'application/json'
      }
    ];

    function run(i) {
      if (i >= candidates.length) {
        done(false, 'Delete endpoint unavailable on server');
        return;
      }

      var c = candidates[i];
      $.ajax({
        url: c.url,
        type: c.method,
        headers: hostedAuthHeaders(),
        contentType: c.contentType,
        data: c.body,
        success: function (res) {
          var failed = isCatalystError(res) || (res && res.success === false);
          if (failed) {
            run(i + 1);
            return;
          }
          done(true);
        },
        error: function (xhr) {
          if (handleHostedUnauthorized(xhr, 'Session expired while deleting library icon. Sign in and try again.')) {
            done(false, 'Unauthorized');
            return;
          }
          // Some delete endpoints return 204/200 with empty body; jQuery can report parsererror.
          if (xhr && xhr.status >= 200 && xhr.status < 300) {
            done(true);
            return;
          }
          run(i + 1);
        }
      });
    }

    run(0);
  }

  function buildLocalIconList() {
    return parseLsIcons().map(function (item) {
      var cleanName = SF.cleanFileName(item && item.name) || 'icon';
      return {
        id: 'ls:' + cleanName,
        name: cleanName,
        svgContent: (item && item.svgContent) || '',
        size: (item && item.size) || (((item && item.svgContent) || '').length),
        source: 'local'
      };
    });
  }

  function uniqueWorkspaceIconName(baseName) {
    var base = SF.cleanFileName(baseName) || 'icon';
    var taken = {};
    (SF.state && SF.state.icons || []).forEach(function (icon) {
      var n = String((icon && icon.name) || '').toLowerCase();
      if (n) taken[n] = true;
    });

    if (!taken[base.toLowerCase()]) return base;

    var i = 2;
    while (taken[(base + '-' + i).toLowerCase()]) i++;
    return base + '-' + i;
  }

  function parseIconFromSvg(svgText, preferredName) {
    var parseName = (SF.cleanFileName(preferredName) || 'icon') + '.svg';
    var parsed = SF.parseSVGFile(svgText || '', parseName);
    if (!parsed) return null;

    parsed.name = uniqueWorkspaceIconName(parsed.name || preferredName || 'icon');
    parsed.gId = SF.makeGId(parsed.name);
    parsed.symbolId = SF.makeSymbolId(parsed.name);
    return parsed;
  }

  SF.addLibraryIconToSprite = function (iconId, done, options) {
    options = options || {};
    var icon = (SF.libState.icons || []).find(function (item) {
      return item && item.id === iconId;
    });

    if (!icon) {
      if (typeof done === 'function') done(false, 'icon not found');
      return;
    }

    function finishWithSvg(svgText) {
      var parsed = parseIconFromSvg(svgText, icon.name);
      if (!parsed) {
        if (!options.silent) SF.showToast('Could not add icon to sprite');
        if (typeof done === 'function') done(false, 'parse failed');
        return;
      }

      SF.state.icons.push(parsed);
      SF.renderIconList();
      if (!options.silent) SF.showToast('Added "' + parsed.name + '" to current sprite');
      if (typeof done === 'function') done(true, parsed.name);
    }

    if (icon.svgContent) {
      finishWithSvg(icon.svgContent);
      return;
    }

    if (!icon.openPath && !(icon.deleteFolder && icon.deleteFile) && !icon.deleteName) {
      if (!options.silent) SF.showToast('No icon source available');
      if (typeof done === 'function') done(false, 'no source');
      return;
    }

    var candidates = [];
    var rawOpenPath = String(icon.openPath || '').trim();

    if (rawOpenPath) {
      candidates.push(rawOpenPath);
      if (!/^https?:\/\//i.test(rawOpenPath) && rawOpenPath.charAt(0) !== '/') {
        candidates.push('/' + rawOpenPath);
      }

      var spriteExtMatch = rawOpenPath.match(/^(.*\/sprite\/[^/?#]+)\.svg([?#].*)?$/i);
      if (spriteExtMatch && spriteExtMatch[1]) {
        candidates.push(spriteExtMatch[1] + (spriteExtMatch[2] || ''));
      }
    }

    if (icon.deleteFolder && icon.deleteFile) {
      var localRel = 'saved-sprites/' + encodeURIComponent(icon.deleteFolder) + '/' + encodeURIComponent(icon.deleteFile);
      candidates.push(localRel);
      candidates.push('/' + localRel);
    }

    if (icon.deleteName) {
      var hostedBase = fileBaseName(icon.deleteName);
      candidates.push(joinUrl(CATALYST_API_BASE, 'sprite/' + encodeURIComponent(hostedBase) + '.svg'));
      candidates.push(joinUrl(CATALYST_API_BASE, 'sprite/' + encodeURIComponent(hostedBase)));
    }

    var seen = {};
    candidates = candidates.filter(function (url) {
      var u = String(url || '').trim();
      if (!u || seen[u]) return false;
      seen[u] = true;
      return true;
    });

    function tryFetch(i) {
      if (i >= candidates.length) {
        if (!options.silent) SF.showToast('Failed to fetch icon from Library');
        if (typeof done === 'function') done(false, 'fetch failed');
        return;
      }

      $.ajax({
        url: candidates[i],
        type: 'GET',
        dataType: 'text',
        success: function (svgText) {
          finishWithSvg(svgText || '');
        },
        error: function () {
          tryFetch(i + 1);
        }
      });
    }

    tryFetch(0);
  };

  SF.toggleLibrarySelection = function (iconId, forceState) {
    if (!iconId) return;
    if (!SF.libState.selected) SF.libState.selected = {};
    var next = typeof forceState === 'boolean' ? forceState : !SF.libState.selected[iconId];
    if (next) SF.libState.selected[iconId] = true;
    else delete SF.libState.selected[iconId];
    // Update just this card — re-rendering hundreds of repository icons per click is slow.
    var $card = $('#libGrid .lib-card').filter(function () { return $(this).data('iconId') === iconId; });
    if ($card.length) {
      $card.toggleClass('lib-selected', next);
      $card.find('.library-select-checkbox').prop('checked', next);
      updateLibrarySelectionUi(visibleLibraryIcons());
    } else {
      SF.renderLibraryGrid();
    }
  };

  SF.setLibrarySelectionForVisible = function (checked) {
    var visible = visibleLibraryIcons();
    if (!SF.libState.selected) SF.libState.selected = {};
    visible.forEach(function (icon) {
      if (!icon || !icon.id) return;
      if (checked) SF.libState.selected[icon.id] = true;
      else delete SF.libState.selected[icon.id];
    });
    SF.renderLibraryGrid();
  };

  SF.clearLibrarySelection = function () {
    SF.libState.selected = {};
    SF.renderLibraryGrid();
  };

  SF.addSelectedLibraryIconsToSprite = function (done) {
    var ids = selectedIds();
    if (!ids.length) {
      SF.showToast('Select icons from Library first');
      if (typeof done === 'function') done(false, []);
      return;
    }

    var addedNames = [];
    var failed = 0;

    function run(i) {
      if (i >= ids.length) {
        SF.showToast('Added ' + addedNames.length + ' icon' + (addedNames.length === 1 ? '' : 's') + ' to sprite' + (failed ? ' (' + failed + ' failed)' : ''));
        if (addedNames.length) SF.libState.selected = {};
        SF.renderLibraryGrid();
        if (typeof done === 'function') done(addedNames.length > 0, addedNames);
        return;
      }

      SF.addLibraryIconToSprite(ids[i], function (ok, msg) {
        if (ok) addedNames.push(msg || 'icon');
        else failed++;
        run(i + 1);
      }, { silent: true });
    }

    run(0);
  };

  function verifySaved(folderName, svgName, onDone) {
    if (isHostedMode()) {
      $.getJSON(joinUrl(CATALYST_API_BASE, 'list-sprites'), function (data) {
        var sprites = (data && data.sprites) || [];
        var expected = fileBaseName(svgName || '').toLowerCase();
        var ok = sprites.some(function (sprite) {
          var n = fileBaseName((sprite && sprite.name) || '').toLowerCase();
          return n === expected;
        });
        onDone(!!ok);
      }).fail(function () {
        onDone(false);
      });
      return;
    }

    $.getJSON(joinUrl(CATALYST_API_BASE, 'api/list-folders'), function (data) {
      var folders = (data && data.folders) || [];
      var ok = folders.some(function (folder) {
        if (!folder || folder.name !== folderName) return false;
        return (folder.files || []).some(function (f) {
          return (f.name || '').toLowerCase() === (svgName || '').toLowerCase();
        });
      });
      onDone(!!ok);
    }).fail(function () {
      onDone(false);
    });
  }

  SF.initBuiltInLibrary = function () {
    SF.loadLibraryFolders();
  };

  // Kept for backward compatibility with previous app flow.
  SF.mergeLibraryIcons = function () {};

  SF.handleLibrarySpriteFile = function () {
    $('#libSpriteStatus')
      .text('Use Upload Icons to add individual icons directly to Library.')
      .attr('class', 'upload-status error');
  };

  SF.saveSingleIconToLibrary = function (iconName, svgContent, options) {
    options = options || {};
    var safeIconName = SF.cleanFileName(iconName) || 'icon';

    // Use the new unified library endpoint (works in both local dev and hosted)
    $.ajax({
      url: joinUrl(CATALYST_API_BASE, 'api/library/upload'),
      type: 'POST',
      headers: hostedAuthHeaders(),
      contentType: 'application/json',
      dataType: 'json',
      data: JSON.stringify({ iconName: safeIconName, svgContent: svgContent || '' }),
      success: function (res) {
        if (res && res.success) {
          SF.showToast('Saved "' + safeIconName + '" to Library');
          SF.loadLibraryFolders();
          if (typeof options.onSuccess === 'function') options.onSuccess(res);
        } else {
          var msg = (res && res.message) || 'could not save icon to Library';
          SF.showToast('Save failed: ' + msg);
          if (typeof options.onError === 'function') options.onError(msg);
        }
      },
      error: function (xhr, status, err) {
        if (handleHostedUnauthorized(xhr, 'Session expired while saving to library. Sign in and try again.')) {
          if (typeof options.onError === 'function') options.onError('Unauthorized');
          return;
        }
        var apiError = (xhr && xhr.responseJSON && (xhr.responseJSON.message || xhr.responseJSON.error))
          || (xhr && xhr.responseText) || err || status || 'could not save icon to Library';
        SF.showToast('Save failed: ' + apiError);
        if (typeof options.onError === 'function') options.onError(apiError);
      }
    });
  };

  // Backward-compatible wrapper; folderName is ignored in flat Library mode.
  SF.saveSingleIconToLibraryFolder = function (iconName, svgContent, folderName, options) {
    SF.saveSingleIconToLibrary(iconName, svgContent, options || {});
  };

  SF.deleteLibraryIcon = function (iconId, done) {
    var icon = (SF.libState.icons || []).find(function (item) {
      return item && item.id === iconId;
    });

    if (!icon) {
      if (typeof done === 'function') done(false);
      return;
    }

    // localStorage-only icons
    if (icon.source === 'local' || String(icon.id || '').indexOf('ls:') === 0) {
      removeLsIconById(icon.id);
      SF.showToast('Icon removed from Library');
      SF.loadLibraryFolders();
      if (typeof done === 'function') done(true);
      return;
    }

    // New unified library endpoint (source === 'library')
    if (icon.source === 'library' || String(icon.id || '').indexOf('lib:') === 0) {
      var libName = icon.deleteName || icon.name;
      $.ajax({
        url: joinUrl(CATALYST_API_BASE, 'api/library/icon/' + encodeURIComponent(libName)),
        type: 'DELETE',
        headers: hostedAuthHeaders(),
        dataType: 'json',
        success: function (res) {
          if (res && res.success) {
            SF.showToast('Icon removed from Library');
            SF.loadLibraryFolders();
            if (typeof done === 'function') done(true);
          } else {
            SF.showToast('Delete failed: ' + ((res && res.message) || 'could not delete icon'));
            if (typeof done === 'function') done(false);
          }
        },
        error: function (xhr) {
          if (handleHostedUnauthorized(xhr, 'Session expired while deleting. Sign in and try again.')) {
            if (typeof done === 'function') done(false);
            return;
          }
          var apiError = (xhr && xhr.responseJSON && xhr.responseJSON.message) || 'could not delete icon';
          SF.showToast('Delete failed: ' + apiError);
          if (typeof done === 'function') done(false);
        }
      });
      return;
    }

    // Legacy: delete via old folder/file endpoints
    if (icon.deleteFile && icon.deleteFolder) {
      $.ajax({
        url: joinUrl(CATALYST_API_BASE, 'api/delete-file/' + encodeURIComponent(icon.deleteFolder) + '/' + encodeURIComponent(icon.deleteFile)),
        type: 'DELETE',
        dataType: 'json',
        success: function (res) {
          if (res && res.success) {
            SF.showToast('Icon removed from Library');
            SF.loadLibraryFolders();
            if (typeof done === 'function') done(true);
          } else {
            SF.showToast('Delete failed: ' + ((res && res.error) || 'could not delete icon'));
            if (typeof done === 'function') done(false);
          }
        },
        error: function () {
          SF.showToast('Delete failed: could not delete icon');
          if (typeof done === 'function') done(false);
        }
      });
      return;
    }

    SF.showToast('This icon cannot be deleted');
    if (typeof done === 'function') done(false);
  };

  // ── Build icon list from the new /api/library/list response ──────────────
  function buildLibraryIconList(icons) {
    return (icons || []).map(function (item) {
      var name     = (item && item.name) || 'icon';
      var key      = (item && item.key)  || '';
      var isLocal  = key.indexOf('local:') === 0;
      var openPath = isLocal
        ? joinUrl(CATALYST_API_BASE, 'api/library/icon/' + encodeURIComponent(name))
        : joinUrl(CATALYST_API_BASE, 'api/library/icon/' + encodeURIComponent(name));
      return {
        id:         'lib:' + name,
        name:       name,
        size:       (item && item.size) || 0,
        openPath:   openPath,
        deleteName: name,
        canDelete:  true,
        source:     'library'
      };
    });
  }

  SF.loadLibraryFolders = function () {
    $.ajax({
      url: joinUrl(CATALYST_API_BASE, 'api/library/list'),
      type: 'GET',
      dataType: 'json',
      headers: hostedAuthHeaders(),
      success: function (data) {
        SF.libState.authBlocked = false;
        var serverIcons = buildLibraryIconList((data && data.icons) || []);
        // Also merge in any localStorage icons for backward compat
        var localIcons = buildLocalIconList().filter(function (li) {
          return !serverIcons.some(function (si) { return si.name === li.name; });
        });
        SF.libState.userIcons = serverIcons.concat(localIcons);
        rebuildLibraryIcons();
        SF.renderLibraryGrid();
      },
      error: function (xhr) {
        if (handleHostedUnauthorized(xhr, 'Session expired. Sign in with Zoho to load Library icons.')) {
          SF.libState.authBlocked = true;
        } else {
          SF.libState.authBlocked = false;
        }
        // Fallback to localStorage-only
        SF.libState.userIcons = buildLocalIconList();
        rebuildLibraryIcons();
        SF.renderLibraryGrid();
      }
    });

    // Both repository sprites, split into single icons (read straight from the repo).
    if (typeof SF.loadRepoLibraryIcons === 'function') SF.loadRepoLibraryIcons(false);
  };

  function renderSourceFilter() {
    var $bar = $('#libSourceFilter');
    if (!$bar.length) return;
    var all = SF.libState.icons || [];
    var mine = all.filter(function (i) { return i.source !== 'repo'; }).length;
    var sprites = typeof SF.repoLibrarySprites === 'function' ? SF.repoLibrarySprites() : [];
    var cur = SF.libState.sourceFilter || 'all';
    var chips = [{ key: 'all', label: 'All', count: all.length }];
    sprites.forEach(function (sp) { chips.push({ key: sp.base, label: sp.base, count: sp.count, repo: true }); });
    chips.push({ key: 'mine', label: 'My icons', count: mine });
    $bar.html(chips.map(function (c) {
      return '<button type="button" class="lib-source-chip' + (c.key === cur ? ' active' : '') + (c.repo ? ' lib-source-repo' : '') +
        '" data-source="' + SF.escapeAttr(c.key) + '">' + SF.escapeAttr(c.label) +
        ' <span class="lib-source-count">' + c.count + '</span></button>';
    }).join(''));
  }

  SF.renderLibraryGrid = function () {
    var $grid = $('#libGrid');
    if (!$grid.length) return;

    $grid.addClass('lib-grid-icononly');
    $grid.empty();

    pruneSelected();
    renderSourceFilter();
    var visible = visibleLibraryIcons();

    $('#libIconCount').text(visible.length);
    updateLibrarySelectionUi(visible);

    if (!visible.length) {
      var emptyMessage = SF.libState.authBlocked
        ? 'Sign in with Zoho to load Library icons'
        : (SF.repoLib && SF.repoLib.loading && !(SF.libState.icons || []).length
          ? 'Loading icons from repository…'
          : ((SF.libState.search || '') ? 'No icons match your search' : 'No icons here yet'));
      $grid.append(
        '<div class="lib-empty">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
          '</svg>' +
          '<span>' + emptyMessage + '</span>' +
        '</div>'
      );
      return;
    }

    var html = '';
    var lazyHosted = [];
    visible.forEach(function (icon, index) {
      // inline content (local / repository): data-URI; library/server (local dev): direct URL; hosted: lazy-load
      var previewSrc = icon.svgContent
        ? svgToDataUri(icon.svgContent)
        : (isHostedMode() ? '' : (icon.openPath || ''));
      if (!icon.svgContent && isHostedMode()) lazyHosted.push(index);
      var isSelected = !!(SF.libState.selected && SF.libState.selected[icon.id]);
      var isRepo = icon.source === 'repo';
      var title = icon.name + (isRepo ? ' — ' + icon.sprite + '.svg (repository, read-only)' : '');

      var cardHtml = '<div class="lib-card lib-select-card' + (isSelected ? ' lib-selected' : '') + (isRepo ? ' lib-card-repo' : '') + '" data-icon-id="' + SF.escapeAttr(icon.id) + '" title="' + SF.escapeAttr(title) + '">' +
        '<label class="library-select-toggle" title="Select icon">' +
          '<input type="checkbox" class="library-select-checkbox" data-icon-id="' + SF.escapeAttr(icon.id) + '"' + (isSelected ? ' checked' : '') + '>' +
          '<span></span>' +
        '</label>' +
        '<div class="lib-card-preview">' +
          '<img alt="' + SF.escapeAttr(icon.name) + ' preview" loading="lazy" decoding="async" src="' + SF.escapeAttr(previewSrc) + '">' +
        '</div>' +
        '<div class="saved-folder-actions lib-icon-actions">' +
          '<button class="btn btn-ghost btn-sm library-add-btn" data-icon-id="' + SF.escapeAttr(icon.id) + '" data-tooltip="Add to Sprite" aria-label="Add to Sprite">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
          '</button>' +
          '<button class="btn btn-ghost btn-sm library-open-btn" data-icon-id="' + SF.escapeAttr(icon.id) + '" data-open-path="' + SF.escapeAttr(icon.openPath || '') + '" data-tooltip="View" aria-label="View">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
          '</button>' +
          '<button class="btn btn-ghost btn-sm library-delete-btn" data-icon-id="' + SF.escapeAttr(icon.id) + '" data-icon-name="' + SF.escapeAttr(icon.name) + '" style="color:var(--danger);" data-tooltip="' + (icon.canDelete === false ? 'Managed in repository' : 'Delete') + '" aria-label="Delete"' + (icon.canDelete === false ? ' disabled' : '') + '>' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>';

      html += cardHtml;
    });

    // One DOM write for the whole grid (repository sprites add hundreds of cards).
    $grid.html(html);
    if (lazyHosted.length) {
      var $cards = $grid.children('.lib-card');
      lazyHosted.forEach(function (index) {
        loadHostedPreviewSvg(visible[index], $cards.eq(index).find('.lib-card-preview img').first());
      });
    }
  };

  $(document).on('click', '.lib-source-chip', function () {
    SF.setLibrarySourceFilter($(this).data('source'));
  });

  // Kept for backward compatibility with previous app flow.
  SF.updateLibSelectedCount = function () {};

  // Kept for backward compatibility with previous app flow.
  SF.addSelectedLibraryIcons = function () {};

  /**
   * Fetch SVG content for all selected library icons and hand them off to
   * the WebFont generator page.
   *
   * Flow:
   *  1. Collect selected icon descriptors.
   *  2. For each icon, resolve the SVG text (inline or via HTTP).
   *  3. Once all are resolved, call SF.loadIconsIntoWebfont(icons) which
   *     lives in webfont.js, then navigate to the webfont page.
   */
  SF.generateWebfontFromLibrary = function () {
    var ids = selectedIds();
    if (!ids.length) {
      SF.showToast('Select icons from Library first');
      return;
    }

    var iconDescriptors = ids.map(function (id) {
      return (SF.libState.icons || []).find(function (ic) { return ic && ic.id === id; });
    }).filter(Boolean);

    if (!iconDescriptors.length) {
      SF.showToast('No valid icons selected');
      return;
    }

    SF.showToast('Loading ' + iconDescriptors.length + ' icon' + (iconDescriptors.length === 1 ? '' : 's') + '…');

    var results = [];
    var remaining = iconDescriptors.length;

    function onAllDone() {
      var valid = results.filter(function (r) { return r && r.svgText; });
      if (!valid.length) {
        SF.showToast('Could not load SVG content for selected icons');
        return;
      }
      // Navigate to webfont page then inject icons
      if (typeof SF.switchPage === 'function') {
        SF.switchPage('webfont');
      }
      // Give the page a tick to render then load icons
      setTimeout(function () {
        if (typeof SF.loadIconsIntoWebfont === 'function') {
          SF.loadIconsIntoWebfont(valid);
        } else {
          SF.showToast('WebFont page not ready – please try again');
        }
      }, 150);
    }

    function resolveSvg(icon, index) {
      // If SVG content is already available (localStorage icons)
      if (icon.svgContent) {
        results[index] = { name: icon.name, svgText: icon.svgContent };
        if (--remaining === 0) onAllDone();
        return;
      }

      // Build candidate URLs (same logic as addLibraryIconToSprite)
      var candidates = [];
      var rawOpenPath = String(icon.openPath || '').trim();

      if (rawOpenPath) {
        candidates.push(rawOpenPath);
        if (!/^https?:\/\//i.test(rawOpenPath) && rawOpenPath.charAt(0) !== '/') {
          candidates.push('/' + rawOpenPath);
        }
      }

      if (icon.deleteFolder && icon.deleteFile) {
        var localRel = 'saved-sprites/' + encodeURIComponent(icon.deleteFolder) + '/' + encodeURIComponent(icon.deleteFile);
        candidates.push(localRel);
        candidates.push('/' + localRel);
      }

      if (icon.deleteName) {
        var hostedBase = fileBaseName(icon.deleteName);
        candidates.push(joinUrl(CATALYST_API_BASE, 'api/library/icon/' + encodeURIComponent(hostedBase)));
      }

      // Dedupe
      var seen = {};
      candidates = candidates.filter(function (url) {
        var u = String(url || '').trim();
        if (!u || seen[u]) return false;
        seen[u] = true;
        return true;
      });

      function tryFetch(i) {
        if (i >= candidates.length) {
          // Could not fetch — skip this icon
          results[index] = null;
          if (--remaining === 0) onAllDone();
          return;
        }
        $.ajax({
          url: candidates[i],
          type: 'GET',
          dataType: 'text',
          headers: hostedAuthHeaders(),
          success: function (svgText) {
            results[index] = { name: icon.name, svgText: svgText || '' };
            if (--remaining === 0) onAllDone();
          },
          error: function () { tryFetch(i + 1); }
        });
      }

      tryFetch(0);
    }

    iconDescriptors.forEach(function (icon, idx) {
      resolveSvg(icon, idx);
    });
  };

})(window.SpriteForge, jQuery);
