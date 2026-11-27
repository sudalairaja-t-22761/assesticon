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
  // SVG / XLink namespace URIs, read from the browser's HTML parser (it puts <svg> and xlink:href in them).
  var _nsProbe = document.createElement('div');
  _nsProbe.innerHTML = '<svg><use xlink:href="#x"></use></svg>';
  var SVG_NAMESPACE = _nsProbe.firstChild.namespaceURI;
  var XLINK_NAMESPACE = _nsProbe.querySelector('use').attributes[0].namespaceURI;

  SF.repoLib = {
    icons: [],         // Library-shaped icon descriptors (source: 'repo')
    sprites: [],       // [{ name, base, count }]
    commit: null,      // commit the icons were built from
    commitInfo: null,  // { sha, date, author, subject } of that commit
    versionRepo: null, // repo config the version was read from
    version: null,     // { name, version, file, commit } read from package.json at the branch tip
    versionChecked: false, // first load of a page session always re-reads the repo
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

  /**
   * "version" of package.json at the tip of the CRM_UI_LIBRARY branch (REPO_* — api/master-library).
   * Falls back to the icon repo's own package.json when that one has none. Never throws.
   */
  function _loadVersion(refresh) {
    var r = SF.repoLib;
    var get = function (api, apply) {
      return new Promise(function (resolve) {
        $.ajax({
          url: _url(api + (refresh ? '?refresh=1' : '')),
          type: 'GET',
          dataType: 'json',
          timeout: SF.MASTER_LIBRARY_TIMEOUT_MS || 90000,
          headers: _headers(),
          success: function (d) { apply(d || {}); resolve(); },
          error: function () { resolve(); }
        });
      });
    };
    // Mock branch (REPO_BRANCH) and master branch (MASTER_REPO_BRANCH) of CRM_UI_LIBRARY.
    return Promise.all([
      get('api/master-library', function (d) { r.version = d.packageVersion || null; r.versionRepo = d.repo || null; }),
      get('api/master-branch', function (d) { r.masterVersion = d.packageVersion || null; r.masterVersionRepo = d.repo || null; })
    ]).then(function () { _renderVersion(); });
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
  /** True when a class used by this icon has a rule that points into <defs> (clip-path: url(#…), fill: url(#…)). */
  function _classesUseDefs(content, css) {
    var used = {}, m, cRe = /\bclass\s*=\s*["']([^"']*)["']/g;
    while ((m = cRe.exec(content)) !== null) m[1].split(/\s+/).forEach(function (k) { if (k) used[k] = true; });
    var rRe = /([^{}]+)\{([^{}]*)\}/g, r;
    while ((r = rRe.exec(css)) !== null) {
      if (!/url\(\s*["']?#/.test(r[2])) continue;
      var sRe = /\.(-?[_a-zA-Z][\w-]*)/g, c;
      while ((c = sRe.exec(r[1])) !== null) if (used[c[1]]) return true;
    }
    return false;
  }

  /**
   * The part of a sprite's shared CSS and <defs> that ONE icon really uses, so its standalone SVG carries nothing
   * else (a class-styled icon used to drag the whole sprite's styles along: ~19 000 characters for a 2 KB icon).
   * Lossless for the icon: a rule is kept when every class in its selector is used by the icon (a rule without a
   * class, like ":root" or "path", is kept as it is); a <defs> entry is kept when the icon, a kept rule or another
   * kept entry points to it (url(#id) / href="#id").
   * @returns {{style:string, defs:string}}
   */
  function _onlyUsed(content, css, defs) {
    css = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
    defs = String(defs || '');
    var classesIn = function (markup, into) {
      var m, re = /\bclass\s*=\s*["']([^"']*)["']/g;
      while ((m = re.exec(markup)) !== null) m[1].split(/\s+/).forEach(function (k) { if (k) into[k] = true; });
    };
    var refsIn = function (text, into) {
      var m, re = /url\(\s*["']?#([^"')\s]+)|(?:xlink:)?href\s*=\s*["']#([^"']+)["']/g;
      while ((m = re.exec(text)) !== null) into[m[1] || m[2]] = true;
    };
    var used = {}, style = '', keptDefs = '', picked = {};
    classesIn(content, used);
    // Round by round until nothing new: kept rules can point to <defs>, and those entries can use classes again.
    for (var round = 0; round < 6; round++) {
      var before = Object.keys(used).length + Object.keys(picked).length;
      style = css.replace(/([^{}]+)\{([^{}]*)\}/g, function (rule, sel, body) {
        if (/^\s*@/.test(sel)) return rule;
        var keep = sel.split(',').filter(function (one) {
          var c, re = /\.(-?[_a-zA-Z][\w-]*)/g, any = false;
          while ((c = re.exec(one)) !== null) { any = true; if (!used[c[1]]) return false; }
          return any || !!one.trim();
        });
        return keep.length ? keep.join(',').trim() + '{' + body.trim() + '}' : '';
      }).replace(/\s*\n\s*/g, '\n').trim();
      var refs = {};
      refsIn(content + style + keptDefs, refs);
      Object.keys(refs).forEach(function (id) {
        if (picked[id]) return;
        var tag = new RegExp('<([a-zA-Z][\\w:-]*)\\b[^>]*\\bid\\s*=\\s*["\']' + _escRe(id) + '["\']').exec(defs);
        var el = tag ? _findElement(defs, tag[1], id) : null;
        if (!el) return;
        picked[id] = defs.slice(el.start, el.end);
        keptDefs += picked[id];
        classesIn(picked[id], used);
      });
      if (Object.keys(used).length + Object.keys(picked).length === before) break;
    }
    return { style: style, defs: keptDefs };
  }

  function _standaloneSvg(icon, spriteStyle, spriteDefs) {
    var content = icon.svgContent || '';
    var needsStyle = spriteStyle && /\bclass\s*=|var\(--/.test(content);
    var needsDefs  = spriteDefs && (/url\(\s*#|\b(xlink:)?href\s*=\s*["']#/.test(content) || (needsStyle && _classesUseDefs(content, spriteStyle)));
    var rootAttrs  = SF.buildPreviewAttrs(icon);
    // Only this icon's share of the sprite's styles and <defs>, not all of them.
    var own = needsStyle || needsDefs ? _onlyUsed(content, needsStyle ? spriteStyle : '', spriteDefs) : { style: '', defs: '' };
    return '<svg xmlns="' + SVG_NAMESPACE + '" xmlns:xlink="' + XLINK_NAMESPACE + '" viewBox="' +
      icon.originX + ' ' + icon.originY + ' ' + icon.width + ' ' + icon.height +
      '" width="' + _num(icon.width) + '" height="' + _num(icon.height) + '"' + rootAttrs + '>' +
      (own.defs ? '<defs>' + own.defs + '</defs>' : '') +
      (own.style ? '<style>' + own.style + '</style>' : '') +
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
    spriteStyle = SF.stripExportCss(spriteStyle); // an export's ":root:root{fill:…}" in the sprite must not paint every preview

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

  /**
   * CSS without selectors that reach outside one icon (:root, html, body, *, a bare svg). Inside a sprite such a rule
   * repaints every icon (e.g. a coloured export's ":root:root{fill:…}"), so it is never added and never shown.
   */
  var GLOBAL_SEL = /^(?::root|html|body|\*|svg)(?![\w-])/i;
  var EXPORT_SEL = /^:root:root$/i; // the colour rule older studio exports wrote
  function stripRules(css, test) {
    return String(css || '').replace(/([^{}]+)\{([^{}]*)\}/g, function (all, sel, body) {
      if (/^\s*@/.test(sel)) return all;
      var keep = sel.split(',').filter(function (x) { return x.trim() && !test.test(x.trim()); });
      return keep.length ? keep.join(',') + '{' + body + '}' : '';
    });
  }
  // A single icon being added / replaced: none of its page-wide rules go into the sprite.
  SF.stripGlobalCss = function (css) { return stripRules(css, GLOBAL_SEL); };
  // A whole sprite: keep its own :root variables (--zcicn-color-baseStroke …), drop only the export colour rule.
  SF.stripExportCss = function (css) { return stripRules(css, EXPORT_SEL); };

  /** Give a new icon's own classes / ids a unique prefix so they cannot clash with the sprite's. */
  function _isolate(icon, token) {
    // Illustrator writes the icon's <style> INSIDE <defs>. Left there it is not seen as style: its classes (st0, st1…)
    // keep their common names, repaint other icons of the sprite and are repainted by them. Move it to the style.
    var inDefs = '';
    icon.defsContent = String(icon.defsContent || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, function (all, css) {
      inDefs += '\n' + css.replace(/<!\[CDATA\[|\]\]>/g, ''); return '';
    });
    if (inDefs.trim()) icon.styleContent = (icon.styleContent || '') + inDefs;
    var style = SF.stripGlobalCss(icon.styleContent || ''), defs = icon.defsContent || '', content = icon.svgContent || '';
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

  // ── an icon SHEET: one plain SVG (no <symbol>) with several icons drawn next to each other ──────────────────
  // Design tools export a row or column of artboards as one drawing. Each icon is found by where it is drawn:
  // the top-level groups are measured in the browser and those that overlap or touch are one icon. It counts as
  // a sheet only with clear evidence, so an ordinary icon made of two separate parts (pause, apps) stays one icon:
  //   - every part has its own clip box (an exported artboard), or
  //   - the canvas is a strip (long side ≥ 1.8 × short side) and the parts are clearly apart.
  var GRAPHIC = { g: 1, path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1, text: 1, use: 1, image: 1 };
  function _tagOf(el) { return String(el.localName || el.nodeName || '').toLowerCase(); }
  function _fix(n) { return Math.round(n * 10000) / 10000; }

  /** Box of an element in the root SVG's coordinates: its clip box when it has one (an artboard), else its drawing + stroke. */
  function _unitBox(el, root) {
    var m;
    try { m = root.getScreenCTM().inverse().multiply(el.getScreenCTM()); } catch (e) { return null; }
    var corners = function (x, y, w, h) {
      var xs = [], ys = [];
      [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(function (c) {
        var p = root.createSVGPoint(); p.x = c[0]; p.y = c[1]; p = p.matrixTransform(m); xs.push(p.x); ys.push(p.y);
      });
      return { x: Math.min.apply(null, xs), y: Math.min.apply(null, ys), x2: Math.max.apply(null, xs), y2: Math.max.apply(null, ys) };
    };
    // clip-path may come from a class (Illustrator: .st6 { clip-path: url(#clippath) }), so ask the computed style.
    var cs = window.getComputedStyle(el), ref = /url\(\s*["']?#([^"')\s]+)/.exec(cs.clipPath || el.getAttribute('clip-path') || '');
    if (ref) {
      var clip = null;
      try { clip = root.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(ref[1]) : ref[1])); } catch (e) { clip = null; }
      var r = clip && clip.children.length === 1 && _tagOf(clip.children[0]) === 'rect' ? clip.children[0] : null;
      var w = r ? parseFloat(r.getAttribute('width')) : 0, h = r ? parseFloat(r.getAttribute('height')) : 0;
      if (r && w > 0 && h > 0 && !r.getAttribute('transform')) {
        var b = corners(parseFloat(r.getAttribute('x')) || 0, parseFloat(r.getAttribute('y')) || 0, w, h);
        b.clip = true;
        return b;
      }
    }
    var box;
    try { box = el.getBBox(); } catch (e) { return null; }
    if (!box || (!box.width && !box.height)) return null;
    var pad = 0, nodes = [el].concat(Array.prototype.slice.call(el.querySelectorAll('*'), 0, 400));
    nodes.forEach(function (n) {
      var s = window.getComputedStyle(n);
      if (s.stroke && s.stroke !== 'none') pad = Math.max(pad, (parseFloat(s.strokeWidth) || 1) / 2);
    });
    return corners(box.x - pad, box.y - pad, box.width + 2 * pad, box.height + 2 * pad);
  }

  /**
   * Serialise one separated icon with only the styles and <defs> entries it uses: every icon of a sheet is built with
   * the whole sheet's <style> and clip boxes, most of which belong to the other icons.
   */
  function _slimSheetIcon(svgEl) {
    var ser = new XMLSerializer(), css = '', defs = '', content = '';
    var take = function (el, intoDefs) {
      Array.prototype.forEach.call(el.children, function (c) {
        var tag = _tagOf(c);
        if (tag === 'style') css += (c.textContent || '') + '\n';
        else if (tag === 'defs') take(c, true);
        else if (intoDefs || !GRAPHIC[tag]) defs += ser.serializeToString(c);
        else content += ser.serializeToString(c);
      });
    };
    take(svgEl, false);
    var own = _onlyUsed(content, css, defs);
    var shell = svgEl.cloneNode(false);
    var open = ser.serializeToString(shell).replace(/\/>\s*$/, '>').replace(/<\/svg>\s*$/, '');
    return open + (own.defs ? '<defs>' + own.defs + '</defs>' : '') + (own.style ? '<style>' + own.style + '</style>' : '') + content + '</svg>';
  }

  /**
   * @returns {Array<{name, text}>|null} one standalone SVG per icon of the sheet (left to right, top to bottom),
   *          or null when the file is one ordinary icon.
   */
  function _explodeSheet(fileName, svgText) {
    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var src = doc.documentElement;
    if (!src || _tagOf(src) !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
    // Measured in the page (hidden): boxes and class-based styles only exist for a rendered SVG.
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;width:2000px;height:2000px;visibility:hidden;pointer-events:none';
    var root = document.importNode(src, true);
    host.appendChild(root);
    document.body.appendChild(host);
    try {
      var graphics = function (el) { return Array.prototype.filter.call(el.children, function (c) { return GRAPHIC[_tagOf(c)]; }); };
      // One group around everything is only a wrapper: look inside it (it is kept around every icon).
      var wrappers = [], units = graphics(root);
      while (units.length === 1 && _tagOf(units[0]) === 'g' && !/url\(/.test(window.getComputedStyle(units[0]).clipPath || '') && graphics(units[0]).length > 1) {
        wrappers.push(units[0]); units = graphics(units[0]);
      }
      if (units.length < 2) return null;
      var boxes = [];
      units.forEach(function (el) { var b = _unitBox(el, root); if (b) { b.els = [el]; boxes.push(b); } });
      if (boxes.length < 2) return null;

      var vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat);
      var cw = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(root.getAttribute('width')) || 0;
      var ch = vb.length === 4 && vb[3] > 0 ? vb[3] : parseFloat(root.getAttribute('height')) || 0;
      if (!cw || !ch) { cw = Math.max.apply(null, boxes.map(function (b) { return b.x2; })); ch = Math.max.apply(null, boxes.map(function (b) { return b.y2; })); }
      var tol = Math.min(cw, ch) * 0.02;
      var gap = function (a, b) { return Math.max(a.x - b.x2, b.x - a.x2, a.y - b.y2, b.y - a.y2); }; // ≤ 0: they overlap
      // Parts that overlap or touch are one icon (repeat until nothing merges).
      for (var merged = true; merged;) {
        merged = false;
        for (var i = 0; i < boxes.length && !merged; i++) {
          for (var j = i + 1; j < boxes.length && !merged; j++) {
            if (gap(boxes[i], boxes[j]) <= tol) {
              var a = boxes[i], b = boxes[j];
              boxes[i] = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2), clip: a.clip && b.clip, els: a.els.concat(b.els) };
              boxes.splice(j, 1); merged = true;
            }
          }
        }
      }
      if (boxes.length < 2) return null;
      var sizes = boxes.map(function (b) { return Math.max(b.x2 - b.x, b.y2 - b.y); }).sort(function (p, q) { return p - q; });
      var median = sizes[Math.floor(sizes.length / 2)], minGap = Infinity;
      boxes.forEach(function (p, pi) { boxes.forEach(function (q, qi) { if (pi < qi) minGap = Math.min(minGap, gap(p, q)); }); });
      var artboards = boxes.every(function (b) { return b.clip; });
      var strip = Math.max(cw, ch) >= 1.8 * Math.min(cw, ch) && minGap >= 0.15 * median;
      if (!artboards && !strip) return null; // an ordinary icon with separate parts

      // Reading order: rows top to bottom, then left to right.
      boxes.sort(function (p, q) { return Math.abs(p.y - q.y) > median / 2 ? p.y - q.y : p.x - q.x; });
      var order = Array.prototype.slice.call(root.querySelectorAll('*'));
      var base = String(fileName || 'icon').replace(/\.svg$/i, '');
      var keepAttr = function (n) { return !/^(width|height|viewBox|id|x|y|version|style)$/.test(n) && n.indexOf('xmlns') !== 0; };
      return boxes.map(function (b, n) {
        var out = document.createElementNS(SVG_NAMESPACE, 'svg');
        Array.prototype.forEach.call(root.attributes, function (at) { if (keepAttr(at.name)) out.setAttribute(at.name, at.value); }); // fill, stroke… set on the sheet
        var w = _fix(b.x2 - b.x), h = _fix(b.y2 - b.y);
        out.setAttribute('viewBox', _fix(b.x) + ' ' + _fix(b.y) + ' ' + w + ' ' + h);
        out.setAttribute('width', w); out.setAttribute('height', h);
        // The sheet's shared parts (styles, clip boxes, gradients) go with every icon.
        Array.prototype.forEach.call(root.children, function (c) { if (!GRAPHIC[_tagOf(c)]) out.appendChild(c.cloneNode(true)); });
        var parent = out;
        wrappers.forEach(function (wr) { var shell = wr.cloneNode(false); parent.appendChild(shell); parent = shell; });
        b.els.sort(function (p, q) { return order.indexOf(p) - order.indexOf(q); }).forEach(function (el) { parent.appendChild(el.cloneNode(true)); });
        return { name: base + '-' + (n + 1) + '.svg', text: _slimSheetIcon(out) };
      });
    } catch (e) {
      return null; // could not be measured: keep the file as one icon
    } finally {
      document.body.removeChild(host);
    }
  }

  SF.explodeIconSheet = _explodeSheet; // Create / Update Sprite uploads use it too (file-handler.js)

  /**
   * Uploaded files → one item per ICON. A sprite file (it has <symbol>s) is separated into its icons, each as its own
   * standalone SVG named after its symbol; an icon sheet (several icons drawn next to each other in one plain SVG) is
   * separated by where the icons are drawn; any other SVG stays one icon.
   * @param {object} [keepWhole] file names to keep as one icon although they look like a sheet
   * @returns {{items: Array<{name, text, from?}>, notes: string[], sheets: Array<{name, text, count}>}} name is a
   *          file-style name ("bell.svg"); from is the file an icon was separated from; notes says what was done with
   *          each separated file; sheets lists the files separated as a sheet (the guess a person may undo).
   */
  function _separate(files, keepWhole) {
    var items = [], notes = [], sheets = [];
    (files || []).forEach(function (f) {
      if (!/<symbol\b/i.test(f.text)) {
        var parts = keepWhole && keepWhole[f.name] ? null : _explodeSheet(f.name, f.text);
        if (!parts) { items.push({ name: f.name, text: f.text }); return; }
        parts.forEach(function (ic) { items.push({ name: ic.name, text: ic.text, from: f.name }); });
        notes.push(f.name + ': ' + parts.length + ' icons drawn side by side, separated');
        sheets.push({ name: f.name, text: f.text, count: parts.length });
        return;
      }
      var icons = [];
      try { icons = _explodeSprite(f.name, f.text); } catch (e) { icons = []; }
      icons = icons.filter(function (ic) { return ic && ic.svgContent && (ic.name || ic.symbolId); });
      if (!icons.length) { notes.push(f.name + ': no icons found in this sprite'); return; }
      icons.forEach(function (ic) { items.push({ name: String(ic.name || ic.symbolId) + '.svg', text: ic.svgContent, from: f.name }); });
      notes.push(f.name + ': sprite separated into ' + icons.length + ' icon' + (icons.length === 1 ? '' : 's'));
    });
    return { items: items, notes: notes, sheets: sheets };
  }

  /** Commit a new sprite text to the icon repo. */
  function _commit(svg, names, verb, prep) {
    var file = _spriteFiles()[0];
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: _url('api/icon-library/save'),
        type: 'POST',
        headers: _headers(),
        contentType: 'application/json',
        dataType: 'json',
        timeout: SF.MASTER_LIBRARY_TIMEOUT_MS || 90000,
        data: JSON.stringify({ files: [{ name: file.name, content: svg }], message: (verb || 'Add') + ' ' + names.join(', ') + ' ' + (prep || 'to') + ' ' + file.name + ' via SpriteForge' }),
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
    return _readFiles(fileList).then(function (files) {
      var sep = _separate(files); // a sprite file adds each of its icons separately
      if (!sep.items.length) { SF.showToast(sep.notes[0] || 'Choose one or more .svg files'); return; }
      if (sep.notes.length) SF.showToast(sep.notes.join(' · '));
      return _appendItems(sep.items);
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


  // ── replace one icon in the repo sprite (same place, same symbol id) ────

  /** Start/end of the element `<tag ... id="id" ...>...</tag>` (nested tags of the same name handled). */
  function _findElement(text, tag, id) {
    var open = new RegExp('<' + tag + '\\b[^>]*\\bid\\s*=\\s*["\']' + _escRe(id) + '["\'][^>]*>', 'g');
    var m = open.exec(text);
    if (!m) return null;
    var start = m.index, pos = start + m[0].length, depth = 1;
    if (/\/>$/.test(m[0])) return { start: start, end: pos, openEnd: pos, closeStart: pos };
    var tok = new RegExp('<' + tag + '\\b[^>]*?(\\/?)>|<\\/' + tag + '\\s*>', 'g');
    tok.lastIndex = pos;
    var t;
    while ((t = tok.exec(text)) !== null) {
      if (t[0].charAt(1) === '/') { depth--; if (!depth) return { start: start, end: tok.lastIndex, openEnd: start + m[0].length, closeStart: t.index }; }
      else if (t[1] !== '/') depth++;
    }
    return null;
  }

  /**
   * Replace the artwork of ONE icon in the sprite TEXT. The symbol keeps its id and its slot
   * (viewBox x/y/width/height) so nothing else in the sprite moves; the new artwork is centred
   * in that slot (scaled down only when it is bigger than the slot).
   * @param {string} spriteText
   * @param {string} symbolId   e.g. "zcicn-search"
   * @param {{name:string,text:string}} item  the new single-icon SVG
   * @returns {{svg:string}|{error:string}}
   */
  SF.replaceIconInSpriteText = function (spriteText, symbolId, item) {
    var sym = _findElement(spriteText, 'symbol', symbolId);
    if (!sym) return { error: symbolId + ' was not found in the sprite (it may have been changed in the repository — press Sync from repo)' };
    var symOpen = spriteText.slice(sym.start, sym.openEnd);
    var vb = /viewBox\s*=\s*["']([^"']+)["']/.exec(symOpen);
    var n = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [];
    if (n.length !== 4 || !n.every(isFinite)) return { error: symbolId + ' has no readable viewBox' };
    var slot = { x: n[0], y: n[1], w: n[2], h: n[3] };

    var icon = SF.parseSVGFile(item.text, item.name);
    if (!icon) return { error: 'The new file is not a readable SVG' };
    _isolate(icon, 'r' + Date.now().toString(36) + '-');

    var iw = icon.width || slot.w, ih = icon.height || slot.h;
    var sc = Math.min(1, slot.w / iw, slot.h / ih);
    var tx = slot.x + (slot.w - iw * sc) / 2 - icon.originX * sc;
    var ty = slot.y + (slot.h - ih * sc) / 2 - icon.originY * sc;
    var f = function (v) { return +v.toFixed(3); };
    var hasStroke = /<[^>]+\bstroke\s*=/i.test(icon.svgContent || '');

    var inner = spriteText.slice(sym.openEnd, sym.closeStart);
    var useM = /<use\b[^>]*?(?:xlink:)?href\s*=\s*["']#([^"']+)["']/.exec(inner);
    var gId = useM ? useM[1] : null;
    var g = gId ? _findElement(spriteText, 'g', gId) : null;
    if (!gId) gId = _camel(icon.name) + 'ZCI';

    var newName = item.newName && String(item.newName).trim();
    var newSymbolId = newName ? SF.makeSymbolId(newName) : symbolId;
    if (newName && newSymbolId !== symbolId) {
      if (_findElement(spriteText, 'symbol', newSymbolId)) return { error: newSymbolId + ' already exists in the sprite' };
      gId = _camel(newName) + 'ZCI';
    }

    var a = 'id="' + SF.escapeAttr(gId) + '" transform="translate(' + f(tx) + ',' + f(ty) + ')' + (sc !== 1 ? ' scale(' + f(sc) + ')' : '') + '"';
    if (icon.rootFill) a += ' fill="' + SF.escapeAttr(icon.rootFill) + '"';
    if (icon.rootStroke && !hasStroke) a += ' stroke="' + SF.escapeAttr(icon.rootStroke) + '"';
    if (icon.colorMode === 'stroke' && !icon.rootFill) a += ' fill="none"';
    var newG = '<g ' + a + '>\n' + icon.svgContent + '\n</g>';

    var out;
    if (g) {
      out = spriteText.slice(0, g.start) + newG + spriteText.slice(g.end);
    } else {
      // symbol that holds its artwork directly: swap the symbol's content instead
      out = spriteText.slice(0, sym.openEnd) + '\n' + newG + '\n' + spriteText.slice(sym.closeStart);
    }

    if (newSymbolId !== symbolId) {
      var sym2 = _findElement(out, 'symbol', symbolId);
      if (sym2) {
        var open2 = out.slice(sym2.start, sym2.openEnd).replace(/(\bid\s*=\s*)(["'])[^"']*\2/, '$1$2' + SF.escapeAttr(newSymbolId) + '$2');
        var inner2 = out.slice(sym2.openEnd, sym2.closeStart).replace(/((?:xlink:)?href\s*=\s*)(["'])#[^"']*\2/, '$1$2#' + SF.escapeAttr(gId) + '$2');
        out = out.slice(0, sym2.start) + open2 + inner2 + out.slice(sym2.closeStart);
      }
      out = out.replace(new RegExp('\\.' + _escRe(symbolId) + '(?![\\w-])', 'g'), '.' + newSymbolId);
    }

    if (icon.styleContent && icon.styleContent.trim()) {
      var se = out.indexOf('</style>');
      out = se >= 0 ? out.slice(0, se) + '\n' + icon.styleContent.trim() + '\n' + out.slice(se)
        : out.replace(/(<svg\b[^>]*>)/, function (m) { return m + '\n<style type="text/css">\n' + icon.styleContent.trim() + '\n</style>'; });
    }
    if (icon.defsContent && icon.defsContent.trim()) {
      var de = out.indexOf('</defs>');
      if (de >= 0) out = out.slice(0, de) + '\n' + icon.defsContent.trim() + '\n' + out.slice(de);
      else { var se2 = out.indexOf('</style>'); var at = se2 >= 0 ? se2 + 8 : out.search(/<svg\b[^>]*>/); out = out.slice(0, at) + '\n<defs>\n' + icon.defsContent.trim() + '\n</defs>' + out.slice(at); }
    }
    return { svg: out, symbolId: newSymbolId };
  };

  /** @returns {Promise<{ok:boolean, error?:string}>} */
  SF.replaceIconInRepo = function (symbolId, iconName, item) {
    var job = _queue.then(function () { return _replaceNow(symbolId, iconName, item); });
    _queue = job.catch(function () {});
    return job;
  };

  function _replaceNow(symbolId, iconName, item) {
    var file = _spriteFiles()[0];
    var result = { ok: false };
    if (!file) { result.error = 'No icon repository sprite configured'; SF.showToast(result.error); return Promise.resolve(result); }
    SF.showToast('Reading ' + file.name + ' from ' + (_cfg().repoName || 'repository') + '…');
    return _getListing(true).then(function () { return _fetchText(file.name); }).then(function (res) {
      var r = SF.replaceIconInSpriteText(res.text, symbolId, item);
      if (r.error) { result.error = r.error; SF.showToast('Replace failed: ' + r.error); return result; }
      return _commit(r.svg, [item.newName || iconName]).then(function (out) {
        result.ok = true;
        SF.showToast('Replaced ' + iconName + (item.newName && item.newName !== iconName ? ' (now ' + item.newName + ')' : '') + (out && out.pushed ? ' and pushed ' + String(out.commit || '').slice(0, 8) + ' to ' + out.branch : ' (repository already up to date)'));
        return SF.loadRepoLibraryIcons(true, true).then(function () { return result; });
      });
    }).catch(function (err) {
      result.error = (err && err.message) || 'unknown error';
      if (err && err.status === 401 && typeof SF.handleHostedUnauthorized === 'function') return SF.handleHostedUnauthorized('Session expired. Sign in with Zoho and try again.');
      SF.showToast('Replace failed: ' + result.error);
      return result;
    });
  }

  // ── remove ONE icon from the repo sprite (admin, unverified icons only — the Library card decides) ───────────

  /**
   * Take one icon out of the sprite TEXT: its <symbol>, the <g> its <use> points to, and the style rules and
   * <defs> entries that only this icon used. Nothing else moves (the icon's slot stays empty).
   * @returns {{svg:string}|{error:string}}
   */
  SF.removeIconFromSpriteText = function (spriteText, symbolId) {
    var sym = _findElement(spriteText, 'symbol', symbolId);
    if (!sym) return { error: symbolId + ' was not found in the sprite (it may have been changed in the repository — press Sync from repo)' };
    var inner = spriteText.slice(sym.openEnd, sym.closeStart);
    var useM = /<use\b[^>]*?(?:xlink:)?href\s*=\s*["']#([^"']+)["']/.exec(inner);
    var g = useM ? _findElement(spriteText, 'g', useM[1]) : null;
    var gone = inner + (g ? spriteText.slice(g.start, g.end) : '');
    // cut the later piece first so the earlier positions stay valid
    var cuts = [sym].concat(g ? [g] : []).sort(function (a, b) { return b.start - a.start; });
    var out = spriteText;
    cuts.forEach(function (c) { out = out.slice(0, c.start) + out.slice(c.end); });

    // classes the removed artwork used (+ the icon's own .symbolId rule) that nothing left in the sprite uses
    var classes = {}, m, cRe = /\bclass\s*=\s*["']([^"']*)["']/g;
    while ((m = cRe.exec(gone)) !== null) m[1].split(/\s+/).forEach(function (k) { if (k) classes[k] = true; });
    var still = {}, sRe = /\bclass\s*=\s*["']([^"']*)["']/g;
    while ((m = sRe.exec(out)) !== null) m[1].split(/\s+/).forEach(function (k) { if (k) still[k] = true; });
    var orphan = Object.keys(classes).filter(function (k) { return !still[k]; }).concat([symbolId]);
    // An icon added by this tool has ONE private prefix on all its classes and ids ("nmwys0dwv0-", see _isolate).
    // When nothing left in the artwork carries that prefix, everything with it goes: also the rules and clip boxes
    // the icon brought along but never used itself.
    var tokens = {};
    Object.keys(classes).forEach(function (k) { var t = /^([nr][0-9a-z]{6,14}-)/.exec(k); if (t) tokens[t[1]] = true; });
    var artwork = out.replace(/<defs\b[\s\S]*?<\/defs>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
    var dead = Object.keys(tokens).filter(function (t) { return !new RegExp('\\bclass\\s*=\\s*["\'][^"\']*\\b' + _escRe(t)).test(artwork); });
    var ruleBodies = '';
    out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, function (all, open, css, close) {
      var kept = css.replace(/([^{}]+)\{([^{}]*)\}/g, function (rule, sel, body) {
        if (/^\s*@/.test(sel)) return rule;
        var keep = sel.split(',').filter(function (one) {
          return !orphan.some(function (k) { return new RegExp('\\.' + _escRe(k) + '(?![\\w-])').test(one); }) &&
            !dead.some(function (t) { return one.indexOf('.' + t) >= 0; });
        });
        if (keep.length === sel.split(',').length) return rule;
        ruleBodies += body;
        return keep.length ? keep.join(',') + '{' + body + '}' : '';
      });
      return open + kept.replace(/\n\s*\n+/g, '\n') + close;
    });

    // <defs> entries (clip boxes, gradients) that only the removed artwork / removed rules pointed to
    var ids = {}, iRe = /url\(\s*["']?#([^"')\s]+)|(?:xlink:)?href\s*=\s*["']#([^"']+)["']/g;
    while ((m = iRe.exec(gone + ruleBodies)) !== null) ids[m[1] || m[2]] = true;
    Object.keys(ids).forEach(function (id) {
      var e = _escRe(id);
      if (new RegExp('url\\(\\s*["\']?#' + e + '["\']?\\s*\\)|href\\s*=\\s*["\']#' + e + '["\']').test(out)) return; // still used
      var tag = new RegExp('<([a-zA-Z][\\w:-]*)\\b[^>]*\\bid\\s*=\\s*["\']' + e + '["\']').exec(out);
      var el = tag ? _findElement(out, tag[1], id) : null;
      var d0 = out.indexOf('<defs'), d1 = out.indexOf('</defs>');
      if (el && d0 >= 0 && el.start > d0 && el.end <= d1) out = out.slice(0, el.start) + out.slice(el.end);
    });
    // every <defs> entry that carries a removed icon's private prefix
    dead.forEach(function (t) {
      for (var guard = 0; guard < 200; guard++) {
        var d0 = out.indexOf('<defs'), d1 = out.indexOf('</defs>');
        if (d0 < 0 || d1 < 0) break;
        var hit = new RegExp('<([a-zA-Z][\\w:-]*)\\b[^>]*\\bid\\s*=\\s*["\'](' + _escRe(t) + '[^"\']*)["\']').exec(out.slice(d0, d1));
        var el = hit ? _findElement(out, hit[1], hit[2]) : null;
        if (!el || el.start < d0 || el.end > d1) break;
        out = out.slice(0, el.start) + out.slice(el.end);
      }
    });
    out = out.replace(/<defs>\s*<\/defs>\s*/g, ''); // nothing left in it
    return { svg: out.replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n') };
  };

  /** Remove one icon from the repo sprite, commit, reload the Library. @returns {Promise<{ok:boolean, error?:string}>} */
  SF.deleteIconFromRepo = function (symbolId, iconName) {
    var run = function () {
      var file = _spriteFiles()[0];
      var result = { ok: false };
      if (!file) { result.error = 'No icon repository sprite configured'; SF.showToast(result.error); return Promise.resolve(result); }
      SF.showToast('Reading ' + file.name + ' from ' + (_cfg().repoName || 'repository') + '…');
      return _getListing(true).then(function () { return _fetchText(file.name); }).then(function (res) {
        var r = SF.removeIconFromSpriteText(res.text, symbolId);
        if (r.error) { result.error = r.error; SF.showToast('Delete failed: ' + r.error); return result; }
        return _commit(r.svg, [iconName], 'Remove', 'from').then(function (out) {
          result.ok = true;
          SF.showToast('Deleted ' + iconName + ' from the Library' + (out && out.pushed ? ' (commit ' + String(out.commit || '').slice(0, 8) + ')' : ''));
          return SF.loadRepoLibraryIcons(true, true).then(function () { return result; });
        });
      }).catch(function (err) {
        result.error = (err && err.message) || 'unknown error';
        if (err && err.status === 401 && typeof SF.handleHostedUnauthorized === 'function') return SF.handleHostedUnauthorized('Session expired. Sign in with Zoho and try again.');
        SF.showToast('Delete failed: ' + result.error);
        return result;
      });
    };
    // One change of the sprite at a time (same queue as adding icons): each reads the latest sprite.
    var p = _queue.then(run, run);
    _queue = p.catch(function () {});
    return p;
  };

  /** Same artwork (ignoring ids, classes and whitespace) as another repository icon? Returns that icon. */
  function _artKey(markup) {
    return String(markup || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s(id|class)\s*=\s*["'][^"']*["']/gi, '')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  function _findDuplicateArtwork(text, fileName, ownSymbolId) {
    var parsed = SF.parseSVGFile(text, fileName);
    var key = parsed && _artKey(parsed.svgContent);
    if (!key) return null;
    var icons = (SF.libState && SF.libState.icons) || [];
    for (var i = 0; i < icons.length; i++) {
      var ic = icons[i];
      if (!ic || ic.source !== 'repo' || ic.symbolId === ownSymbolId) continue;
      var other = /<svg\b[^>]*>([\s\S]*)<\/svg>/i.exec(ic.svgContent || '');
      if (other && _artKey(other[1].replace(/<(defs|style)\b[\s\S]*?<\/\1>/gi, '')) === key) return ic;
    }
    return null;
  }

  // Library tile "Replace" button → pick the new SVG → replace in the sprite → commit.
  var _replaceTarget = null;
  $(document).on('click', '.library-replace-btn', function (e) {
    e.stopPropagation();
    var $b = $(this);
    if ($b.is(':disabled') || $b.hasClass('is-busy')) return;
    _replaceTarget = { symbolId: $b.data('symbolId'), name: $b.data('iconName'), $btn: $b };
    var $in = $('#libReplaceInput');
    if (!$in.length) $in = $('<input type="file" id="libReplaceInput" accept=".svg,image/svg+xml" hidden>').appendTo('body');
    $in.val('')[0].click();
  });
  $(document).on('click', '#libReplaceInput', function (e) { e.stopPropagation(); });
  $(document).on('change', '#libReplaceInput', function () {
    var t = _replaceTarget, f = this.files && this.files[0];
    _replaceTarget = null;
    if (!t || !f) return;
    if (!/\.svg$/i.test(f.name)) { SF.showToast('Choose an .svg file'); return; }
    _readFiles([f]).then(function (items) {
      if (!items.length) { SF.showToast('Could not read that file'); return; }
      var dup = _findDuplicateArtwork(items[0].text, f.name, t.symbolId);
      if (dup) { SF.showToast('Replace blocked: this artwork is already in the Library as "' + dup.name + '"'); return; }
      var entered = window.prompt('Icon name for the replacement (the symbol id is renamed to match):', t.name);
      if (entered === null) return;
      var newName = String(entered).trim().replace(/\s+/g, '-');
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(newName)) { SF.showToast('Use letters, numbers, - or _ for the icon name'); return; }
      if (newName !== t.name) {
        var clash = ((SF.libState && SF.libState.icons) || []).some(function (ic) {
          return ic && ic.source === 'repo' && ic.symbolId !== t.symbolId &&
            (String(ic.name).toLowerCase() === newName.toLowerCase() || String(ic.symbolId).toLowerCase() === SF.makeSymbolId(newName).toLowerCase());
        });
        if (clash) { SF.showToast('"' + newName + '" already exists in the Library — choose another name'); return; }
      }
      if (!window.confirm('Replace "' + t.name + '" with ' + f.name + (newName !== t.name ? ' as "' + newName + '"' : '') + ' and commit to the repository?')) return;
      t.$btn.addClass('is-busy');
      SF.replaceIconInRepo(t.symbolId, t.name, { name: newName, newName: newName, text: items[0].text }).then(function () { t.$btn.removeClass('is-busy'); });
    });
  });

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

  var _up = [];  // [{ file, text, name, from? }]
  var _upSheets = []; // [{ name, text, count }] files separated as an icon sheet: "Keep as one icon" undoes it

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
        (u.from ? '<span class="lib-upload-from" title="Separated from the sprite ' + _escHtml(u.from) + '">from ' + _escHtml(u.from) + '</span>' : '') +
        (dup ? '<span class="lib-upload-note">already in Library</span>' : '') +
        '<button type="button" class="lib-upload-remove" title="Remove">&times;</button></div>';
    }).join(''));
    $('#libUploadSubmit').prop('disabled', !ok);
    // Files separated by where the icons are drawn: say so, and let the person keep such a file as one icon.
    _upSheets = _upSheets.filter(function (sh) { return _up.some(function (u) { return u.from === sh.name; }); });
    if (!$('#libUploadSheets').length) $('#libUploadList').before('<div class="lib-upload-sheets" id="libUploadSheets"></div>');
    $('#libUploadSheets').html(_upSheets.map(function (sh, i) {
      return '<div class="lib-upload-sheet"><span><b>' + _escHtml(sh.name) + '</b> has ' + sh.count + ' icons drawn side by side: each one is saved as its own icon.</span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-lib-whole="' + i + '">Keep as one icon</button></div>';
    }).join(''));
  }

  function _upAdd(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var svgs = files.filter(function (f) { return /\.svg$/i.test(f.name); });
    if (files.length && svgs.length < files.length) $('#libUploadStatus').text('Only .svg files were added.').attr('class', 'upload-status error');
    else $('#libUploadStatus').text('').attr('class', 'upload-status');
    _readFiles(svgs).then(function (read) {
      var sep = _separate(read); // a sprite file becomes one row per icon
      sep.items.forEach(function (it) {
        if (_up.some(function (u) { return u.file === it.name && u.text === it.text; })) return;
        _up.push({ file: it.name, text: it.text, name: SF.cleanFileName(it.name), from: it.from || '' });
      });
      if (sep.notes.length) $('#libUploadStatus').text(sep.notes.join(' · ')).attr('class', 'upload-status' + (sep.items.length ? '' : ' error'));
      sep.sheets.forEach(function (sh) { if (!_upSheets.some(function (x) { return x.name === sh.name; })) _upSheets.push(sh); });
      _upRender();
    });
  }

  function _upClose() { $('#libUploadModal').addClass('hidden'); _up = []; _upSheets = []; $('#libUploadList, #libUploadSheets').empty(); }
  $(document).on('click', '[data-lib-whole]', function () {
    var sh = _upSheets[+$(this).data('lib-whole')];
    if (!sh) return;
    _up = _up.filter(function (u) { return u.from !== sh.name; });
    _up.push({ file: sh.name, text: sh.text, name: SF.cleanFileName(sh.name), from: '' });
    $('#libUploadStatus').text(sh.name + ': kept as one icon').attr('class', 'upload-status');
    _upRender();
  });

  $(document).on('click', '#libUploadIconsBtn', function (e) {
    e.preventDefault();
    _up = []; _upSheets = []; _upRender();
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
    _renderVersion();
  }

  function _renderVersion() {
    var r = SF.repoLib, mock = r.version, master = r.masterVersion;
    var show = !!((mock && mock.version) || (master && master.version)) && !_signedOut();
    $('#libVersionBar').toggleClass('hidden', !show);
    if (!show) return;
    [['mock', mock, r.versionRepo || _cfg(), '#libVersionValue', '#libVersionBranch'],
     ['master', master, r.masterVersionRepo || {}, '#libMasterVersionValue', '#libMasterVersionBranch']].forEach(function (x) {
      var v = x[1], cfg = x[2];
      $('[data-version-item="' + x[0] + '"]').toggleClass('hidden', !(v && v.version));
      if (!v || !v.version) return;
      var $v = $(x[3]), changed = $v.text() !== '—' && $v.text() !== v.version;
      $v.text(v.version).attr('title', (v.name ? v.name + '\n' : '') + (v.file || 'package.json') +
        (cfg.branch ? ' @ ' + cfg.branch : '') + (v.commit ? ' · ' + String(v.commit).slice(0, 8) : ''));
      $(x[4]).text(cfg.branch || '');
      if (changed) { $v.addClass('is-updated'); setTimeout(function () { $v.removeClass('is-updated'); }, 2500); }
    });
    var any = (mock && mock.version) ? mock : master;
    $('#libVersionName').text(any.name || (any.file || 'package.json'));
  }

  /**
   * Show the version a save just committed (save response: packageVersion / release) in the Library version bar
   * without waiting for a page reload or sync.
   */
  SF.setLibraryVersion = function (res, stage) {
    if (!res) return;
    // The version just published wins over the listing's (which may still be the pre-push read).
    var v = (res.release ? { name: res.release.name, version: res.release.version, file: 'resources/package.json', commit: res.commit || null } : null) ||
      res.packageVersion;
    if (!v || !v.version) return;
    var master = stage === 'master' || (!stage && res.branch && (SF.repoLib.masterVersionRepo || {}).branch === res.branch);
    SF.repoLib[master ? 'masterVersion' : 'version'] = v;
    if (res.repo) SF.repoLib[master ? 'masterVersionRepo' : 'versionRepo'] = res.repo;
    _renderVersion();
  };

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

    if (!r.versionChecked) fresh = true;   // page (re)load: always read the latest package.json version
    if (fresh || force) _loadVersion(true);  // refresh, sync and every commit re-read the version
    var job = _getListing(!!fresh).then(function (listing) {
      r.versionChecked = true;
      if (!r.version && listing && listing.packageVersion) { r.version = listing.packageVersion; r.versionRepo = listing.repo || null; }
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

(function (SF, $) {
  'use strict';
  $(document).on('click', '[data-version-copy]', function () {
    var key = $(this).data('version-copy') === 'master' ? 'masterVersion' : 'version';
    var v = SF.repoLib && SF.repoLib[key] && SF.repoLib[key].version;
    if (!v) return;
    var $btn = $(this);
    var done = function () {
      $btn.addClass('is-copied').find('span').text('Copied');
      setTimeout(function () { $btn.removeClass('is-copied').find('span').text('Copy'); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, function () { SF.showToast('Copy failed'); });
    else { var ta = document.createElement('textarea'); ta.value = v; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { SF.showToast('Copy failed'); } ta.remove(); }
  });
})(window.SpriteForge, jQuery);
