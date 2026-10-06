/**
 * SpriteForge - Repository icons in the Library
 *
 * Reads both CRM_UI_LIBRARY sprites (crmutil_icons.svg and svg_cssicons.svg)
 * DIRECTLY from the repository (via /api/master-library/file — nothing is
 * stored in Catalyst), splits every <symbol> into its own standalone SVG and
 * shows them as individual icons in the Library page. They are read-only
 * (no delete), can be added to the current sprite or a webfont like any other
 * Library icon, and are refreshed by "Sync from repo".
 */
(function (SF, $) {
  'use strict';

  var state = SF.state;

  SF.repoLib = {
    icons: [],         // Library-shaped icon descriptors (source: 'repo')
    sprites: [],       // [{ name, base, count }]
    commit: null,      // commit the icons were built from
    loading: false,
    error: null,
    pending: null      // jqXHR/promise of the in-flight load
  };

  function _spriteFiles() {
    var cfg = typeof SF.masterLibraryConfig === 'function' ? SF.masterLibraryConfig() : (window.SF_REPO_CONFIG || {});
    return (cfg.files || []).filter(function (f) { return f && f.kind === 'sprite'; });
  }

  function _url(p) {
    return typeof SF.masterLibraryUrl === 'function'
      ? SF.masterLibraryUrl(p)
      : String(window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/').replace(/\/+$/, '') + '/' + p;
  }

  function _headers() {
    return typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {};
  }

  function _signedOut() {
    return typeof SF.isMasterLibrarySignedOut === 'function' && SF.isMasterLibrarySignedOut();
  }

  function _fetchText(name) {
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: _url('api/master-library/file?name=' + encodeURIComponent(name)),
        type: 'GET',
        dataType: 'text',
        headers: _headers(),
        success: function (text, _s, xhr) { resolve({ text: text || '', commit: xhr.getResponseHeader('X-Repo-Commit') || null }); },
        error: function (xhr) {
          var e = new Error((xhr.responseJSON && xhr.responseJSON.message) || ('Could not load ' + name + ' from repository'));
          e.status = xhr.status;
          reject(e);
        }
      });
    });
  }

  function _getListing() {
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: _url('api/master-library'),
        type: 'GET',
        dataType: 'json',
        headers: _headers(),
        success: resolve,
        error: function (xhr) {
          var e = new Error((xhr.responseJSON && xhr.responseJSON.message) || 'Could not read the repository');
          e.status = xhr.status;
          reject(e);
        }
      });
    });
  }

  // ── sprite → single SVGs ────────────────────────────────────────────────

  function _num(n) {
    return typeof SF.formatDim === 'function' ? SF.formatDim(n) : String(n);
  }

  /** Standalone SVG for one parsed sprite icon, keeping only the shared styles/defs it needs. */
  function _standaloneSvg(icon, spriteStyle, spriteDefs) {
    var content = icon.svgContent || '';
    var needsStyle = spriteStyle && /\bclass\s*=|var\(--/.test(content);
    var needsDefs  = spriteDefs && /url\(\s*#|\b(xlink:)?href\s*=\s*["']#/.test(content);
    var rootAttrs  = SF.buildPreviewAttrs(icon);
    return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="' +
      icon.originX + ' ' + icon.originY + ' ' + icon.width + ' ' + icon.height +
      '" width="' + _num(icon.width) + '" height="' + _num(icon.height) + '"' + rootAttrs + '>' +
      (needsDefs ? '<defs>' + spriteDefs + '</defs>' : '') +
      (needsStyle ? '<style>' + spriteStyle + '</style>' : '') +
      content + '</svg>';
  }

  /**
   * Split a sprite into Library icons. SF.parseExistingSprite writes the sprite
   * size into the workspace state, so that is saved and restored here.
   */
  function _explodeSprite(spriteName, svgText) {
    var keepW = state.originalSpriteWidth;
    var keepH = state.originalSpriteHeight;
    var parsed = [];
    try { parsed = SF.parseExistingSprite(svgText) || []; }
    finally {
      state.originalSpriteWidth = keepW;
      state.originalSpriteHeight = keepH;
    }

    // parseExistingSprite puts the sprite-wide <style>/<defs> on the first icon only.
    var spriteStyle = '', spriteDefs = '';
    parsed.forEach(function (p) {
      if (!spriteStyle && p.styleContent) spriteStyle = p.styleContent;
      if (!spriteDefs && p.defsContent) spriteDefs = p.defsContent;
    });

    var base = spriteName.replace(/\.svg$/i, '');
    return parsed.map(function (p) {
      var svg = _standaloneSvg(p, spriteStyle, spriteDefs);
      return {
        id: 'repo:' + base + ':' + (p.symbolId || p.name),
        name: p.name,
        symbolId: p.symbolId,
        sprite: base,
        spriteFile: spriteName,
        svgContent: svg,
        size: svg.length,
        width: p.width,
        height: p.height,
        canDelete: false,
        source: 'repo'
      };
    });
  }

  // ── public API ──────────────────────────────────────────────────────────

  function _publish() {
    if (typeof SF.setRepoLibraryIcons === 'function') SF.setRepoLibraryIcons(SF.repoLib.icons);
    _renderStatus();
  }

  function _renderStatus() {
    var r = SF.repoLib;
    var $status = $('#libRepoStatus');
    var cfg = typeof SF.masterLibraryConfig === 'function' ? SF.masterLibraryConfig() : {};
    var text = '';
    if (r.loading) {
      text = 'Loading sprites from ' + (cfg.repoName || 'repository') + '…';
    } else if (r.error) {
      text = 'Repository: ' + r.error;
    } else if (r.sprites.length) {
      text = r.sprites.map(function (s) { return s.base + ' (' + s.count + ')'; }).join(' · ') +
        ' from ' + (cfg.repoName || 'repository') + (cfg.branch ? '@' + cfg.branch : '') +
        (r.commit ? ' · ' + String(r.commit).slice(0, 8) : '');
    }
    $status.text(text).toggleClass('lib-repo-status-error', !!r.error && !r.loading);
    $('#libRepoBar').toggleClass('hidden', _signedOut());
  }

  SF.setRepoLibraryError = function (msg) {
    SF.repoLib.loading = false;
    SF.repoLib.error = msg || null;
    _renderStatus();
  };

  /**
   * Load (or reload) the repository sprites into the Library.
   * @param {boolean} [force] re-download even when the commit has not changed
   */
  SF.loadRepoLibraryIcons = function (force) {
    var r = SF.repoLib;
    if (_signedOut()) {
      r.icons = []; r.sprites = []; r.commit = null; r.error = null;
      _publish();
      return Promise.resolve([]);
    }
    if (r.pending && !force) return r.pending;

    var files = _spriteFiles();
    if (!files.length) { r.error = 'No sprite files configured (REPO_FILES)'; _publish(); return Promise.resolve([]); }

    r.loading = true;
    r.error = null;
    _renderStatus();

    var job = _getListing().then(function (listing) {
      var commit = (listing && listing.lastCommit) || null;
      if (!force && r.icons.length && commit && commit === r.commit) return r.icons; // unchanged

      var present = {};
      ((listing && listing.files) || []).forEach(function (f) { present[f.name] = true; });
      var wanted = files.filter(function (f) { return present[f.name]; });
      var missing = files.filter(function (f) { return !present[f.name]; }).map(function (f) { return f.name; });

      return Promise.all(wanted.map(function (f) {
        return _fetchText(f.name).then(function (res) { return { file: f, text: res.text }; });
      })).then(function (results) {
        var all = [];
        var sprites = [];
        results.forEach(function (res) {
          var icons = _explodeSprite(res.file.name, res.text);
          sprites.push({ name: res.file.name, base: res.file.name.replace(/\.svg$/i, ''), count: icons.length });
          all = all.concat(icons);
        });
        r.icons = all;
        r.sprites = sprites;
        r.commit = commit;
        r.error = missing.length ? 'not found in branch: ' + missing.join(', ') : null;
        return all;
      });
    }).catch(function (err) {
      if (err && err.status === 401) {
        r.icons = []; r.sprites = [];
        r.error = 'sign in to load repository icons';
      } else {
        r.error = (err && err.message) || 'could not load repository sprites';
      }
      return r.icons;
    }).then(function (icons) {
      r.loading = false;
      if (r.pending === job) r.pending = null;
      _publish();
      return icons;
    });

    r.pending = job;
    return job;
  };

  /** Sprite filter options for the Library toolbar. */
  SF.repoLibrarySprites = function () { return SF.repoLib.sprites.slice(); };

  $(document).on('click', '#libRepoSyncBtn', function () {
    if ($(this).is(':disabled')) return;
    if (typeof SF.syncMasterLibrary === 'function') {
      SF.repoLib.loading = true;
      _renderStatus();
      SF.syncMasterLibrary(); // POST /sync → refreshes this list via loadRepoLibraryIcons(true)
    } else {
      SF.loadRepoLibraryIcons(true);
    }
  });

})(window.SpriteForge, jQuery);
