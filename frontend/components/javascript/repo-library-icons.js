/**
 * SpriteForge - Repository icons in the Library
 *
 * Reads the Library's icon repo (Iconassest, folder Sprite) DIRECTLY from the
 * repository via /api/icon-library/* — a different repository from the
 * CRM_UI_LIBRARY one used by Saved Sprites. Nothing is stored in Catalyst.
 * Splits every <symbol> of the sprite into its own standalone SVG and
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
    commitInfo: null,  // { sha, date, author, subject } of that commit
    loading: false,
    error: null,
    pending: null      // jqXHR/promise of the in-flight load
  };

  function _spriteFiles() {
    return (_cfg().files || []).filter(function (f) { return f && f.kind === 'sprite'; });
  }

  // Icon repo settings: server answer (GET api/icon-library/config) over the config.js defaults.
  var _serverCfg = null;
  function _cfg() { return _serverCfg || window.SF_ICON_REPO_CONFIG || {}; }
  SF.iconRepoConfig = _cfg;

  function _url(p) {
    return String(window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/').replace(/\/+$/, '') + '/' + p;
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
        url: _url('api/icon-library/file?name=' + encodeURIComponent(name)),
        type: 'GET',
        dataType: 'text',
        timeout: SF.MASTER_LIBRARY_TIMEOUT_MS || 90000,
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

  function _getListing(refresh) {
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: _url('api/icon-library' + (refresh ? '?refresh=1' : '')),
        type: 'GET',
        dataType: 'json',
        timeout: SF.MASTER_LIBRARY_TIMEOUT_MS || 90000,
        headers: _headers(),
        success: resolve,
        error: function (xhr, status) {
          var e = new Error((xhr.responseJSON && xhr.responseJSON.message) ||
            (status === 'timeout' ? 'The icon repository did not answer in time' : 'Could not read the icon repository'));
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

  // ── add new icons to the repo sprite (appended, never overlapping) ──────

  function _escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** Give a new icon's own classes / ids a unique prefix so they cannot clash with the sprite's. */
  function _isolate(icon, token) {
    var style = icon.styleContent || '', defs = icon.defsContent || '', content = icon.svgContent || '';
    var classMap = {}, idMap = {}, m;
    var selRe = /([^{}]+)\{/g;
    while ((m = selRe.exec(style.replace(/\/\*[\s\S]*?\*\//g, ''))) !== null) {
      var cRe = /\.(-?[_a-zA-Z][\w-]*)/g, c;
      while ((c = cRe.exec(m[1])) !== null) classMap[c[1]] = token + c[1];
    }
    var idRe = /\bid\s*=\s*["']([^"']+)["']/g;
    while ((m = idRe.exec(defs + content)) !== null) idMap[m[1]] = token + m[1];
    function ids(t) {
      Object.keys(idMap).forEach(function (id) {
        var e = _escRe(id);
        t = t.replace(new RegExp('\\bid\\s*=\\s*(["\'])' + e + '\\1', 'g'), 'id="' + idMap[id] + '"')
             .replace(new RegExp('url\\(\\s*#' + e + '\\s*\\)', 'g'), 'url(#' + idMap[id] + ')')
             .replace(new RegExp('((?:xlink:)?href\\s*=\\s*["\'])#' + e + '(["\'])', 'g'), '$1#' + idMap[id] + '$2');
      });
      return t;
    }
    function classes(t) {
      return t.replace(/\bclass\s*=\s*(["'])([^"']*)\1/g, function (all, q, list) {
        return 'class=' + q + list.split(/\s+/).map(function (k) { return classMap[k] || k; }).join(' ') + q;
      });
    }
    Object.keys(classMap).forEach(function (k) {
      style = style.replace(new RegExp('\\.' + _escRe(k) + '(?![\\w-])', 'g'), '.' + classMap[k]);
    });
    icon.styleContent = ids(style);
    icon.defsContent = ids(classes(defs));
    icon.svgContent = ids(classes(content));
  }

  function _camel(name) {
    return String(name).replace(/[-_\s]+(.)?/g, function (_, ch) { return ch ? ch.toUpperCase() : ''; });
  }

  /**
   * Append new icons to the sprite TEXT. The existing sprite is kept exactly as it is: the
   * new <g> groups go before the first <symbol>, the new <symbol>s before </svg>, and each
   * new icon is placed after the last existing icon with every candidate spot checked
   * against all existing viewBoxes, so nothing overlaps.
   * @param {string} spriteText
   * @param {Array<{name:string, text:string}>} items  single-icon SVG sources
   * @returns {{svg:string, added:string[], skipped:Array<{name,reason}>, placed:Array}}
   */
  SF.addIconsToSpriteText = function (spriteText, items) {
    var skipped = [], added = [], placed = [];
    var rects = [], ids = {}, gids = {};
    var symRe = /<symbol\b[^>]*>/g, sm;
    while ((sm = symRe.exec(spriteText)) !== null) {
      var vb = /viewBox\s*=\s*["']([^"']+)["']/.exec(sm[0]);
      var id = /\bid\s*=\s*["']([^"']+)["']/.exec(sm[0]);
      if (id) ids[id[1].toLowerCase()] = true;
      if (vb) {
        var n = vb[1].trim().split(/[\s,]+/).map(Number);
        if (n.length === 4 && n.every(isFinite)) rects.push({ spriteX: n[0], spriteY: n[1], width: n[2], height: n[3] });
      }
    }
    var gRe = /\bid\s*=\s*["']([^"']+)["']/g, gm;
    while ((gm = gRe.exec(spriteText)) !== null) gids[gm[1]] = true;

    var symIds = Object.keys(ids);
    var prefix = symIds.length && symIds.filter(function (i) { return i.indexOf('zcicn-') === 0; }).length * 2 >= symIds.length
      ? 'zcicn-' : ((state.settings && state.settings.prefix) || 'zcicn-');

    var root = /<svg\b[^>]*>/.exec(spriteText);
    var rootVb = root && /viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(root[0]);
    var W = rootVb ? Math.ceil(+rootVb[1]) : 450;
    var H = rootVb ? Math.ceil(+rootVb[2]) : 0;

    var icons = [];
    items.forEach(function (it) {
      var icon = SF.parseSVGFile(it.text, it.name);
      if (!icon) { skipped.push({ name: it.name, reason: 'not a readable SVG' }); return; }
      var symbolId = prefix + icon.name;
      if (ids[symbolId.toLowerCase()]) { skipped.push({ name: icon.name, reason: 'already in the sprite' }); return; }
      ids[symbolId.toLowerCase()] = true;
      var gId = _camel(icon.name) + 'ZCI';
      while (gids[gId]) gId += '_n';
      gids[gId] = true;
      icon.symbolId = symbolId;
      icon.gId = gId;
      _isolate(icon, 'n' + Date.now().toString(36) + icons.length + '-');
      icons.push(icon);
    });
    if (!icons.length) return { svg: spriteText, added: added, skipped: skipped, placed: placed };

    var pos = SF.placeNewIcons(rects, icons, W, { iconsPerRow: 0 });
    var newG = [], newSym = [], newStyle = '', newDefs = '';
    icons.forEach(function (icon) {
      var tx = Math.round(icon.spriteX - icon.originX), ty = Math.round(icon.spriteY - icon.originY);
      var hasStroke = /<[^>]+\bstroke\s*=/i.test(icon.svgContent || '');
      var a = 'id="' + SF.escapeAttr(icon.gId) + '"';
      if (tx || ty) a += ' transform="translate(' + tx + ',' + ty + ')"';
      if (icon.rootFill) a += ' fill="' + SF.escapeAttr(icon.rootFill) + '"';
      if (icon.rootStroke && !hasStroke) a += ' stroke="' + SF.escapeAttr(icon.rootStroke) + '"';
      if (icon.colorMode === 'stroke' && !icon.rootFill) a += ' fill="none"';
      newG.push('<g ' + a + '>\n' + icon.svgContent + '\n</g>');
      newSym.push('<symbol viewBox="' + Math.round(icon.spriteX) + ' ' + Math.round(icon.spriteY) + ' ' + Math.ceil(icon.width) + ' ' + Math.ceil(icon.height) + '" id="' + SF.escapeAttr(icon.symbolId) + '">\n<use href="#' + SF.escapeAttr(icon.gId) + '"></use>\n</symbol>');
      if (icon.styleContent && icon.styleContent.trim()) newStyle += '\n' + icon.styleContent.trim();
      if (icon.defsContent && icon.defsContent.trim()) newDefs += '\n' + icon.defsContent.trim();
      added.push(icon.name);
      placed.push({ name: icon.name, x: icon.spriteX, y: icon.spriteY, w: icon.width, h: icon.height });
    });

    var out = spriteText;
    // sprite size grows only when the new icons run past the bottom / right edge
    var newH = Math.max(H, Math.ceil(pos.maxBottom + ((state.settings && state.settings.padding) || 5)));
    var newW = Math.max(W, Math.ceil(pos.maxRight + ((state.settings && state.settings.padding) || 5)));
    if (root && (newH !== H || newW !== W)) {
      var r2 = root[0]
        .replace(/(\bwidth\s*=\s*["'])[\d.]+(px)?/, '$1' + newW + '$2')
        .replace(/(\bheight\s*=\s*["'])[\d.]+(px)?/, '$1' + newH + '$2')
        .replace(/(viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+)[\d.]+([\s,]+)[\d.]+/, '$1' + newW + '$2' + newH)
        .replace(/(enable-background\s*:\s*new\s+[\d.-]+\s+[\d.-]+\s+)[\d.]+(\s+)[\d.]+/, '$1' + newW + '$2' + newH);
      out = out.replace(root[0], function () { return r2; });
    }
    if (newStyle) {
      var se = out.indexOf('</style>');
      out = se >= 0 ? out.slice(0, se) + newStyle + '\n' + out.slice(se) : out.replace(/(<svg\b[^>]*>)/, function (m) { return m + '\n<style type="text/css">' + newStyle + '\n</style>'; });
    }
    if (newDefs) {
      var de = out.indexOf('</defs>');
      if (de >= 0) out = out.slice(0, de) + newDefs + '\n' + out.slice(de);
      else { var se2 = out.indexOf('</style>'); var at = se2 >= 0 ? se2 + 8 : out.search(/<svg\b[^>]*>/); out = out.slice(0, at) + '\n<defs>' + newDefs + '\n</defs>' + out.slice(at); }
    }
    var firstSym = out.indexOf('<symbol');
    var gs = newG.join('\n') + '\n';
    out = firstSym >= 0 ? out.slice(0, firstSym) + gs + out.slice(firstSym) : out.replace('</svg>', function () { return gs + '</svg>'; });
    var close = out.lastIndexOf('</svg>');
    out = out.slice(0, close) + newSym.join('\n') + '\n' + out.slice(close);
    return { svg: out, added: added, skipped: skipped, placed: placed };
  };

  function _readFiles(fileList) {
    return Promise.all(Array.prototype.slice.call(fileList).filter(function (f) { return /\.svg$/i.test(f.name); }).map(function (f) {
      return new Promise(function (resolve) {
        var rd = new FileReader();
        rd.onload = function () { resolve({ name: f.name, text: String(rd.result || '') }); };
        rd.onerror = function () { resolve(null); };
        rd.readAsText(f);
      });
    })).then(function (a) { return a.filter(Boolean); });
  }

  /** Commit a new sprite text to the icon repo. */
  function _commit(svg, names) {
    var file = _spriteFiles()[0];
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: _url('api/icon-library/save'),
        type: 'POST',
        headers: _headers(),
        contentType: 'application/json',
        dataType: 'json',
        timeout: SF.MASTER_LIBRARY_TIMEOUT_MS || 90000,
        data: JSON.stringify({ files: [{ name: file.name, content: svg }], message: 'Add ' + names.join(', ') + ' to ' + file.name + ' via SpriteForge' }),
        success: resolve,
        error: function (xhr, status) {
          var d = xhr.responseJSON;
          reject(new Error((d && d.message) || (status === 'timeout' ? 'The repository did not answer in time' : 'Commit failed')));
        }
      });
    });
  }

  /** Library "Add icon": append SVG files to the repo sprite, commit, reload the Library. */
  SF.addIconsToIconRepo = function (fileList) {
    var file = _spriteFiles()[0];
    if (!file) { SF.showToast('No icon repository sprite configured'); return Promise.resolve(); }
    return _readFiles(fileList).then(function (items) {
      if (!items.length) { SF.showToast('Choose one or more .svg files'); return; }
      return _appendItems(items);
    });
  };

  // One append at a time: each reads the latest sprite, so parallel adds would overwrite each other.
  var _queue = Promise.resolve();
  function _appendItems(items, quiet) {
    var job = _queue.then(function () { return _appendNow(items, quiet); });
    _queue = job.catch(function () {});
    return job;
  }

  /** @returns {Promise<{ok:boolean, added:string[], skipped:Array, error?:string}>} */
  function _appendNow(items, quiet) {
    var file = _spriteFiles()[0];
    var result = { ok: false, added: [], skipped: [] };
    return Promise.resolve().then(function () {
      if (!quiet) SF.showToast('Reading ' + file.name + ' from ' + (_cfg().repoName || 'repository') + '…');
      return _getListing(true).then(function () { return _fetchText(file.name); }).then(function (res) {
        var r = SF.addIconsToSpriteText(res.text, items);
        result.skipped = r.skipped;
        if (!quiet) r.skipped.forEach(function (s) { SF.showToast(s.name + ' skipped: ' + s.reason); });
        if (!r.added.length) {
          result.ok = true;
          if (quiet && r.skipped.length) SF.showToast('Library: ' + r.skipped.length + ' icon(s) already in ' + file.name + ' — nothing added');
          return;
        }
        return _commit(r.svg, r.added).then(function (out) {
          result.ok = true;
          result.added = r.added;
          SF.showToast('Added ' + r.added.join(', ') + (out && out.pushed ? ' and pushed ' + String(out.commit || '').slice(0, 8) + ' to ' + out.branch : ' (repository already up to date)'));
          return SF.loadRepoLibraryIcons(true, true);
        });
      });
    }).then(function () { return result; }, function (err) {
      result.error = (err && err.message) || 'unknown error';
      if (!quiet && err && err.status === 401 && typeof SF.handleHostedUnauthorized === 'function') return SF.handleHostedUnauthorized('Session expired. Sign in with Zoho and try again.');
      SF.showToast((quiet ? 'Library auto-add failed: ' : 'Add icon failed: ') + result.error);
      return result;
    });
  }

  /** Add single-icon SVGs ({name, text}) to the repo sprite; see _appendNow for the result. */
  SF.addItemsToIconRepo = function (items, quiet) { return _appendItems(items, quiet); };

  /**
   * Called when a sprite is created: every NEW icon of it is appended to the Library's repo
   * sprite (after its last icon, no overlap, names already there are skipped). The repo sprite
   * is never regenerated — only the new icons are added to its text. Never blocks the caller.
   */
  SF.autoAddIconsToIconRepo = function (icons) {
    if (_signedOut() || !_spriteFiles().length) return Promise.resolve();
    var items = (icons || []).filter(function (i) { return i && !i.isExisting && i.svgContent; }).map(function (i) {
      return { name: i.name, text: _standaloneSvg(i, i.styleContent || '', i.defsContent || '') };
    });
    if (!items.length) return Promise.resolve();
    return _appendItems(items, true);
  };

  $(document).on('click', '#libAddIconBtn', function () { $('#libAddIconInput').val('').trigger('click'); });
  $(document).on('change', '#libAddIconInput', function () {
    if (this.files && this.files.length) SF.addIconsToIconRepo(this.files);
  });

  // ── Library "Upload Icons" window: drop SVGs, name them, Submit ──────────

  var _up = [];  // [{ file, text, name }]

  function _escHtml(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function _isDup(name) {
    var id = ('zcicn-' + SF.cleanFileName(name)).toLowerCase();
    return (SF.libState && SF.libState.repoIcons || []).some(function (i) { return String(i.symbolId || '').toLowerCase() === id; });
  }

  function _upRender() {
    var seen = {}, ok = _up.length > 0;
    $('#libUploadList').html(_up.map(function (u, i) {
      var key = SF.cleanFileName(u.name || '');
      var dup = !!key && (_isDup(u.name) || seen[key]);
      var empty = !key;
      if (key) seen[key] = true;
      if (dup || empty) ok = false;
      var prev = u.text.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
      return '<div class="lib-upload-row' + (dup ? ' is-dup' : '') + '" data-i="' + i + '">' +
        '<div class="lib-upload-prev">' + prev + '</div>' +
        '<input type="text" class="form-input lib-upload-name" value="' + _escHtml(u.name) + '" placeholder="Icon name" autocomplete="off" spellcheck="false">' +
        (dup ? '<span class="lib-upload-note">already in Library</span>' : '') +
        '<button type="button" class="lib-upload-remove" title="Remove">&times;</button></div>';
    }).join(''));
    $('#libUploadSubmit').prop('disabled', !ok);
  }

  function _upAdd(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var svgs = files.filter(function (f) { return /\.svg$/i.test(f.name); });
    if (files.length && svgs.length < files.length) $('#libUploadStatus').text('Only .svg files were added.').attr('class', 'upload-status error');
    else $('#libUploadStatus').text('').attr('class', 'upload-status');
    _readFiles(svgs).then(function (items) {
      items.forEach(function (it) {
        if (_up.some(function (u) { return u.file === it.name && u.text === it.text; })) return;
        _up.push({ file: it.name, text: it.text, name: SF.cleanFileName(it.name) });
      });
      _upRender();
    });
  }

  function _upClose() { $('#libUploadModal').addClass('hidden'); _up = []; $('#libUploadList').empty(); }

  $(document).on('click', '#libUploadIconsBtn', function (e) {
    e.preventDefault();
    _up = []; _upRender();
    $('#libUploadStatus').text('').attr('class', 'upload-status');
    $('#libUploadModal').removeClass('hidden');
  });
  $(document).on('click', '#libUploadClose, #libUploadCancel, #libUploadModal .modal-overlay-bg', _upClose);
  $(document).on('click', '#libUploadDrop', function () { $('#libUploadInput').val('').trigger('click'); });
  $(document).on('click', '#libUploadInput', function (e) { e.stopPropagation(); });
  $(document).on('change', '#libUploadInput', function () { _upAdd(this.files); });
  $(document).on('dragover dragenter', '#libUploadDrop', function (e) { e.preventDefault(); $(this).addClass('drag-over'); });
  $(document).on('dragleave drop', '#libUploadDrop', function () { $(this).removeClass('drag-over'); });
  $(document).on('drop', '#libUploadDrop', function (e) { e.preventDefault(); _upAdd(e.originalEvent.dataTransfer.files); });
  $(document).on('input', '.lib-upload-name', function () {
    var i = +$(this).closest('.lib-upload-row').data('i');
    if (_up[i]) _up[i].name = $(this).val();
    var pos = this.selectionStart, id = $(this).closest('.lib-upload-row').index();
    _upRender();
    var el = $('#libUploadList .lib-upload-row').eq(id).find('input')[0];
    if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (_) {} }
  });
  $(document).on('click', '.lib-upload-remove', function () {
    _up.splice(+$(this).closest('.lib-upload-row').data('i'), 1);
    _upRender();
  });
  $(document).on('click', '#libUploadSubmit', function () {
    var $btn = $(this);
    var items = _up.map(function (u) { return { name: SF.cleanFileName(u.name), text: u.text }; });
    if (!items.length || $btn.is(':disabled')) return;
    $btn.prop('disabled', true).addClass('is-busy');
    $('#libUploadStatus').text('Adding to ' + (_cfg().repoName || 'repository') + '…').attr('class', 'upload-status');
    SF.addItemsToIconRepo(items, false).then(function (res) {
      $btn.removeClass('is-busy');
      if (res && res.ok) { _upClose(); }
      else {
        $('#libUploadStatus').text((res && res.error) || 'Could not add icons').attr('class', 'upload-status error');
        _upRender();
      }
    });
  });

  // ── public API ──────────────────────────────────────────────────────────

  function _publish() {
    if (typeof SF.setRepoLibraryIcons === 'function') SF.setRepoLibraryIcons(SF.repoLib.icons);
    _renderStatus();
  }

  function _renderStatus() {
    var r = SF.repoLib;
    var $status = $('#libRepoStatus');
    var cfg = _cfg();
    var text = '', tip = '';
    if (r.loading) {
      text = 'Loading sprites from ' + (cfg.repoName || 'repository') + '…';
    } else if (r.error) {
      text = 'Repository: ' + r.error;
    } else if (r.sprites.length) {
      text = r.sprites.map(function (s) { return s.base + ' (' + s.count + ')'; }).join(' · ') +
        ' from ' + (cfg.repoName || 'repository') + (cfg.branch ? '@' + cfg.branch : '') +
        (r.commit ? ' · commit ' + String(r.commit).slice(0, 8) : '');
      var ci = r.commitInfo;
      if (ci) {
        var d = ci.date ? new Date(ci.date) : null;
        var when = d && !isNaN(d.getTime())
          ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' +
            d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
          : '';
        text += (ci.author ? ' · by ' + ci.author : '') + (when ? ' · ' + when : '');
        tip = (ci.subject ? ci.subject + '\n' : '') + (ci.author || '') + (when ? ' · ' + when : '') + (r.commit ? '\n' + r.commit : '');
      }
    }
    $status.text(text).attr('title', tip).toggleClass('lib-repo-status-error', !!r.error && !r.loading);
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
  SF.loadRepoLibraryIcons = function (force, fresh) {
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

    var job = _getListing(!!fresh).then(function (listing) {
      if (listing && listing.repo) _serverCfg = Object.assign({}, window.SF_ICON_REPO_CONFIG || {}, listing.repo);
      r.canCommit = !(listing && 'canCommit' in listing) || !!listing.canCommit;
      var commit = (listing && listing.lastCommit) || null;
      if (listing && listing.lastCommitInfo) r.commitInfo = listing.lastCommitInfo;
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
    var $btn = $(this).addClass('is-busy');
    SF.loadRepoLibraryIcons(true, true).then(function () { $btn.removeClass('is-busy'); });
  });

})(window.SpriteForge, jQuery);
