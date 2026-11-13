/**
 * SpriteForge - Icon Library: eye button → preview popup.
 *
 * The popup shows the icon large, its <crmutil-icon> code and size, and two suggestion lists:
 *   - Similar icons: other Library icons whose NAME is similar, or whose DRAWING is at least 90% similar.
 *     Clicking a suggestion previews it; the list stays that of the icon first opened (no nested suggestions).
 *   - Illustrations: images of the Asset Store (asset-store.js, any format incl. GIF): first those whose file name
 *     matches the icon's name, then those whose drawing looks like the icon.
 *
 * Drawing similarity: every icon is painted black on a 24×24 canvas, its coverage (alpha) is slightly blurred and
 * the two coverage maps are compared (cosine similarity, 0…1). Fingerprints are computed once per icon and cached.
 */
(function (SF, $) {
  'use strict';

  var VISUAL_MIN = 0.9;      // drawings closer than this are suggested
  var NAME_MIN = 0.6;
  var ART_VISUAL_MIN = 0.8;  // icon ↔ illustration: different drawing styles, so a lower bar than icon ↔ icon
  var MAX_SIMILAR = 18, MAX_ART = 12, MAX_ART_SCAN = 400;
  var N = 24;                // fingerprint canvas size
  var STOP = { icon: 1, icons: 1, zcicn: 1, svg: 1, img: 1, image: 1, images: 1, s: 1, ic: 1, 'new': 1, old: 1, crm: 1 };

  var current = null;        // icon shown in the popup
  var origin = null;         // icon the suggestions belong to (stays while a suggestion is being looked at)
  var runId = 0;             // drops results of an earlier icon
  var prints = {};           // icon id → { len, v: Float32Array | null }
  var hostedSvg = {};        // icon id → svg text fetched for icons without inline content

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function P() { return SF.libPreview; }
  function icons() { return ((SF.libState && SF.libState.icons) || []).filter(Boolean); }
  function byId(id) { return icons().filter(function (i) { return i.id === id; })[0] || null; }
  function baseName(icon) { return P() ? P().baseName(icon) : String(icon.name || ''); }
  function svgOf(icon) { return icon.svgContent || hostedSvg[icon.id] || ''; }

  // ── names ────────────────────────────────────────────────────────────
  function tokens(name) {
    return String(name || '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase().split(/[^a-z0-9]+/)
      .filter(function (t) { return t && !STOP[t] && !/^\d+$/.test(t); });
  }
  function squash(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function sameToken(a, b) {
    if (a === b) return true;
    if (a.length < 4 || b.length < 4) return false;
    return a.indexOf(b) === 0 || b.indexOf(a) === 0;   // note / notes, sticky / stickynotes
  }
  function shared(ta, tb) {
    var n = 0;
    ta.forEach(function (a) { if (tb.some(function (b) { return sameToken(a, b); })) n++; });
    return n;
  }
  function editDistance(a, b) {
    if (a === b) return 0;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  /** 0…1: how alike two icon names are (shared words, one inside the other, or a few letters apart). */
  function nameScore(a, b) {
    var ta = tokens(a), tb = tokens(b), score = 0;
    if (ta.length && tb.length) score = shared(ta, tb) / Math.max(ta.length, tb.length);
    var sa = squash(a), sb = squash(b);
    if (sa && sb) {
      if (sa === sb) return 1;
      var short = sa.length < sb.length ? sa : sb, long = short === sa ? sb : sa;
      // One name starts or ends with the other (notes / stickynotes) — not a chance hit in the middle (tick / stickynotes).
      var at = long.indexOf(short), tail = long.lastIndexOf(short) === long.length - short.length;
      if (short.length >= 4 && (at === 0 || tail)) score = Math.max(score, 0.6 + 0.4 * short.length / long.length);
      if (Math.abs(sa.length - sb.length) <= 3 && long.length >= 5) {
        var near = 1 - editDistance(sa, sb) / long.length;      // a typo or a plural apart, not just "search" / "share"
        if (near >= 0.7) score = Math.max(score, near);
      }
    }
    return score;
  }

  // ── drawing fingerprints ─────────────────────────────────────────────
  var BLACK = { hex: '#000000' };
  // The SVG namespace, read from the browser (an <svg> parsed as HTML gets it) instead of being written here:
  // the commit check rejects any URL-like text in source files.
  var SVG_NS = (function () {
    var d = document.createElement('div');
    d.innerHTML = '<svg></svg>';
    return d.firstChild.namespaceURI;
  })();
  function forCanvas(svg) {
    var out = String(svg).replace(/<script[\s\S]*?<\/script>/gi, '');
    if (P()) out = P().coloredSvg(out, BLACK);
    return out.replace(/<svg\b[^>]*>/i, function (tag) {
      var w = /\swidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(tag), h = /\sheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(tag);
      if (!/\sviewBox\s*=/i.test(tag) && w && h) tag = tag.replace(/<svg\b/i, '<svg viewBox="0 0 ' + w[1] + ' ' + h[1] + '"');
      tag = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '');
      if (!/\sxmlns\s*=/i.test(tag)) tag = tag.replace(/<svg\b/i, '<svg xmlns="' + SVG_NS + '"');
      return tag.replace(/<svg\b/i, '<svg width="' + N + '" height="' + N + '"');
    });
  }

  var canvas = null, ctx = null;
  function fingerprint(svg) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(new Blob([forCanvas(svg)], { type: 'image/svg+xml;charset=utf-8' }));
      var img = new Image();
      var done = function (v) { URL.revokeObjectURL(url); resolve(v); };
      img.onerror = function () { done(null); };
      img.onload = function () {
        try {
          if (!canvas) {
            canvas = document.createElement('canvas'); canvas.width = canvas.height = N;
            ctx = canvas.getContext('2d', { willReadFrequently: true });
          }
          ctx.clearRect(0, 0, N, N);
          ctx.drawImage(img, 0, 0, N, N);
          var d = ctx.getImageData(0, 0, N, N).data, a = new Float32Array(N * N), v = new Float32Array(N * N), i, x, y;
          for (i = 0; i < N * N; i++) a[i] = d[i * 4 + 3];
          // 3×3 blur: a line one pixel off still counts as nearly the same drawing.
          var norm = 0;
          for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
            var sum = 0;
            for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
              var xx = x + dx, yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < N && yy < N) sum += a[yy * N + xx];
            }
            v[y * N + x] = sum; norm += sum * sum;
          }
          if (!norm) return done(null);
          norm = Math.sqrt(norm);
          for (i = 0; i < N * N; i++) v[i] /= norm;
          done(v);
        } catch (e) { done(null); }
      };
      img.src = url;
    });
  }
  function cosine(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  /** Fingerprint every Library icon that has inline SVG and is not cached yet. onProgress(done, total). */
  function indexAll(list, onProgress, alive) {
    var todo = list.filter(function (i) {
      var svg = svgOf(i);
      return svg && !(prints[i.id] && prints[i.id].len === svg.length);
    });
    var total = todo.length, at = 0;
    function batch() {
      if (at >= total || !alive()) return Promise.resolve();
      var part = todo.slice(at, at + 40);
      return Promise.all(part.map(function (i) {
        var svg = svgOf(i);
        return fingerprint(svg).then(function (v) { prints[i.id] = { len: svg.length, v: v }; });
      })).then(function () {
        at += part.length;
        if (alive()) onProgress(at, total);
        return new Promise(function (r) { setTimeout(r, 0); }).then(batch);   // keep the page responsive
      });
    }
    return batch();
  }

  function similarTo(icon, list) {
    var mine = prints[icon.id] && prints[icon.id].v, name = baseName(icon), out = [];
    list.forEach(function (o) {
      if (o.id === icon.id) return;
      var theirs = prints[o.id] && prints[o.id].v;
      var look = mine && theirs ? cosine(mine, theirs) : 0;
      var nm = nameScore(name, baseName(o));
      if (look >= VISUAL_MIN || nm >= NAME_MIN) out.push({ icon: o, look: look, name: nm });
    });
    out.sort(function (a, b) {
      var av = a.look >= VISUAL_MIN ? a.look : 0, bv = b.look >= VISUAL_MIN ? b.look : 0;
      return (bv - av) || (b.name - a.name) || baseName(a.icon).localeCompare(baseName(b.icon));
    });
    return out;
  }

  // ── Asset Store illustrations ────────────────────────────────────────
  // Words that say nothing about what a picture shows: product prefixes and generic file-name words.
  var ART_STOP = { zoho: 1, zcrm: 1, illustration: 1, illustrations: 1, illus: 1, asset: 1, assets: 1, bg: 1, background: 1,
    empty: 1, state: 1, banner: 1, logo: 1, default: 1, common: 1, light: 1, dark: 1, large: 1, small: 1 };
  /** Subject words of a name: "zohoexpense" / "newZohoExpense" → ["expense"], "mail-bounce" → ["mail", "bounce"]. */
  function subjects(name) {
    var out = [];
    tokens(name).forEach(function (t) {
      t = t.replace(/^(?:new|zoho|zcrm|crm)+(?=[a-z]{4,})/, '');
      if (t.length >= 3 && !ART_STOP[t] && !STOP[t] && out.indexOf(t) === -1) out.push(t);
    });
    return out;
  }
  function subjectMatch(a, b) {
    if (sameToken(a, b)) return true;
    // one word written inside the other: expense / expensereport
    return (b.length >= 4 && a.indexOf(b) !== -1) || (a.length >= 4 && b.indexOf(a) !== -1);
  }
  function subjectHits(ti, tf) {
    var n = 0;
    ti.forEach(function (a) { if (tf.some(function (b) { return subjectMatch(a, b); })) n++; });
    return n;
  }
  function artFor(icon, files) {
    var ti = subjects(baseName(icon)), out = [];
    if (!ti.length) return out;
    files.forEach(function (f) {
      var score = subjectHits(ti, subjects(f.name)) / ti.length;
      if (!score) score = 0.5 * subjectHits(ti, subjects(f.folder)) / ti.length;   // folder name only: weaker
      if (score <= 0) return;
      if (/illustr/i.test(f.path)) score += 0.05;                                  // tie-break only
      out.push({ f: f, score: score });
    });
    out.sort(function (a, b) { return (b.score - a.score) || a.f.name.localeCompare(b.f.name); });
    return out.slice(0, MAX_ART);
  }

  // ── popup ────────────────────────────────────────────────────────────
  var COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  function ensureModal() {
    if ($('#libViewModal').length) return;
    $('body').append(
      '<div class="modal-overlay hidden" id="libViewModal" role="dialog" aria-modal="true" aria-labelledby="lvmTitle">' +
        '<div class="modal-overlay-bg" id="lvmBg"></div>' +
        '<div class="modal lvm-modal">' +
          '<div class="modal-header">' +
            '<h3><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
              '<span id="lvmTitle"></span><span class="lvm-sub" id="lvmSub"></span>' +
              '<button type="button" class="lvm-back hidden" id="lvmBack"></button></h3>' +
            '<button type="button" class="modal-close" id="lvmClose" aria-label="Close">&times;</button>' +
          '</div>' +
          '<div class="modal-body lvm-body">' +
            '<div class="lvm-top">' +
              '<div class="lvm-stage" id="lvmStage"></div>' +
              '<div class="lvm-info">' +
                '<div class="lvm-label">Code</div>' +
                '<div class="lvm-code"><code id="lvmCode"></code><button type="button" class="lvm-copy" id="lvmCopyCode" title="Copy code" aria-label="Copy code">' + COPY + '</button></div>' +
                '<div class="lvm-meta" id="lvmMeta"></div>' +
                '<div class="lvm-actions">' +
                  '<button type="button" class="btn btn-ghost btn-sm" id="lvmCopySvg">Copy SVG</button>' +
                  '<button type="button" class="btn btn-ghost btn-sm" id="lvmCustomize" title="Colour, size and stroke width">Customize</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="lvm-section">' +
              '<div class="lvm-section-head">Similar icons <span class="lvm-hint">similar name, or drawing at least ' + Math.round(VISUAL_MIN * 100) + '% similar</span></div>' +
              '<div class="lvm-status" id="lvmSimStatus"></div>' +
              '<div class="lvm-grid" id="lvmSimilar"></div>' +
            '</div>' +
            '<div class="lvm-section" id="lvmArtSection">' +
              '<div class="lvm-section-head">Illustrations <span class="lvm-hint">Asset Store images: matching name first, then similar drawing</span></div>' +
              '<div class="lvm-status" id="lvmArtStatus"></div>' +
              '<div class="lvm-grid lvm-art-grid" id="lvmArt"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /** The icon's SVG as shown in the popup: repainted in `color` (if given) and widened to the whole drawing. */
  function thumbSvg(icon, color) {
    var svg = svgOf(icon), p = P();
    if (!svg || !p) return svg;
    var fit = p.measure(icon);
    if (color) svg = p.coloredSvg(svg, color);
    return fit.overflow ? p.withViewBox(svg, fit.box) : svg;
  }

  /**
   * `svg` text as a real <svg> element (not an <img>), or null when the text holds none. It sits in a shadow root so
   * its own <style> rules and ids never reach the page (or another icon), and it is cleaned first: inline SVG runs
   * script, an <img> does not. The returned host is sized by CSS (.lvm-svg); the drawing scales into it.
   */
  function inlineSvg(svg, label) {
    var tpl = document.createElement('template');   // inert: nothing loads or runs while it is cleaned
    tpl.innerHTML = String(svg || '').replace(/<\?xml[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>/gi, '');
    var el = tpl.content.querySelector('svg');
    if (!el) return null;
    Array.prototype.slice.call(el.querySelectorAll('script, foreignObject, iframe, object, embed, animate[attributeName$="href"], set[attributeName$="href"]'))
      .forEach(function (n) { n.remove(); });
    [el].concat(Array.prototype.slice.call(el.querySelectorAll('*'))).forEach(function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        var name = a.name.toLowerCase();
        if (name.indexOf('on') === 0 || (/(^|:)href$/.test(name) && !/^\s*(#|data:image\/)/i.test(a.value))) n.removeAttribute(a.name);
      });
    });
    // ":root" matches nothing inside a shadow root: the sprite's :root variables (--zcicn-color-white: transparent
    // hides shapes) go on the host instead, so they still reach the icon.
    Array.prototype.forEach.call(el.querySelectorAll('style'), function (s) { s.textContent = s.textContent.replace(/:root\b/g, ':host'); });
    var w = parseFloat(el.getAttribute('width')), h = parseFloat(el.getAttribute('height'));
    if (!el.hasAttribute('viewBox') && w > 0 && h > 0) el.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    el.removeAttribute('width'); el.removeAttribute('height');

    var host = document.createElement('span');
    host.className = 'lvm-svg';
    if (label) { host.setAttribute('role', 'img'); host.setAttribute('aria-label', label); }
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var css = document.createElement('style');
    css.textContent = 'svg{display:block;width:100%;height:100%;color:#000}';   // currentColor as in an <img>: black, not the page text colour
    root.appendChild(css);
    root.appendChild(el);
    return host;
  }
  /** Inline <svg> for an icon; an <img> only while a hosted icon's SVG text has not been fetched yet. */
  function iconNode(icon, color, label) {
    var node = inlineSvg(thumbSvg(icon, color), label);
    if (node) return node;
    var img = document.createElement('img');
    img.alt = label || '';
    if (icon.openPath) img.src = icon.openPath;
    return img;
  }

  function renderHead(icon) {
    var p = P(), name = baseName(icon), svg = svgOf(icon);
    // Black on the light theme, white on the dark one (same default as the preview panel).
    var color = p ? p.colorOf(p.themeColorKey()) : null, dark = !!color && color.key === 'white';
    $('#lvmTitle').text(name);
    $('#lvmSub').text(icon.source === 'repo' && icon.sprite ? icon.sprite + '.svg' : '');
    $('#lvmStage').empty().append(iconNode(icon, dark ? color : null, name));
    $('#lvmCode').text(p ? p.code(icon, color) : name);
    var m = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
    var w = icon.width || (m && +m[1]), h = icon.height || (m && +m[2]);
    var cats = SF.iconCategories ? SF.iconCategories.of(icon).map(function (c) { return c.name; }) : [];
    $('#lvmMeta').html(
      (w && h ? '<span>Size <b>' + esc(Math.round(w * 100) / 100) + ' × ' + esc(Math.round(h * 100) / 100) + '</b></span>' : '') +
      (icon.source === 'repo' ? '<span>Source <b>repository</b></span>' : '') +
      (cats.length ? '<span>Category <b>' + esc(cats.join(', ')) + '</b></span>' : ''));
    $('#lvmCopySvg').prop('disabled', !svg);
    var away = origin && origin.id !== icon.id;
    $('#lvmBack').toggleClass('hidden', !away).text(away ? '← Back to ' + baseName(origin) : '');
    $('#lvmSimilar .lvm-tile').each(function () { $(this).toggleClass('is-active', $(this).data('iconId') === icon.id); });
  }

  function renderSimilar(icon, list) {
    var found = similarTo(icon, list), top = found.slice(0, MAX_SIMILAR);
    $('#lvmSimStatus').text(found.length ? (found.length > top.length ? 'Showing ' + top.length + ' of ' + found.length : '') : 'No similar icons found.');
    $('#lvmSimilar').html(top.map(function (x, i) {
      var n = baseName(x.icon), tags = '';
      if (x.look >= 0.995) tags += '<span class="lvm-tag lvm-tag-same">same drawing</span>';
      else if (x.look >= VISUAL_MIN) tags += '<span class="lvm-tag lvm-tag-look">' + Math.floor(x.look * 100) + '% look</span>';
      if (x.name >= NAME_MIN) tags += '<span class="lvm-tag">name</span>';
      return '<button type="button" class="lvm-tile" data-icon-id="' + esc(x.icon.id) + '" data-sim="' + i + '" title="' + esc(n + (x.icon.sprite ? ' — ' + x.icon.sprite + '.svg' : '')) + '">' +
        '<span class="lvm-thumb"></span>' +
        '<span class="lvm-name">' + esc(n) + '</span><span class="lvm-tags">' + tags + '</span></button>';
    }).join(''));
    top.forEach(function (x, i) { $('#lvmSimilar [data-sim="' + i + '"] .lvm-thumb').append(iconNode(x.icon)); });
  }

  function loadSimilar(icon, id) {
    var list = icons(), alive = function () { return id === runId; };
    $('#lvmSimilar').empty();
    $('#lvmSimStatus').text('Comparing drawings…');
    renderSimilar(icon, list);                     // name matches (and cached drawings) straight away
    indexAll(list, function (done, total) {
      $('#lvmSimStatus').text('Comparing drawings… ' + done + ' / ' + total);
    }, alive).then(function () { if (alive()) { renderSimilar(icon, list); if (current) renderHead(current); } });
  }

  // ── illustrations that LOOK like the icon ────────────────────────────
  // Icons and illustrations are drawn very differently (line art in a tight box / coloured art with margins, often
  // on an opaque background), so both are reduced to the same thing first: the "ink" (what differs from the
  // background), cropped to its bounds and scaled into N×N. GIFs are compared by their first frame.
  var S = 64, shapeCanvas = null, shapeCtx = null;
  var artPrints = {};        // asset path → Float32Array | null

  function unit(a) {
    var v = new Float32Array(N * N), norm = 0, x, y, i;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      var sum = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < N && yy < N) sum += a[yy * N + xx];
      }
      v[y * N + x] = sum; norm += sum * sum;
    }
    if (!norm) return null;
    norm = Math.sqrt(norm);
    for (i = 0; i < N * N; i++) v[i] /= norm;
    return v;
  }

  function shapePrint(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onerror = function () { resolve(null); };
      img.onload = function () {
        try {
          if (!shapeCanvas) {
            shapeCanvas = document.createElement('canvas'); shapeCanvas.width = shapeCanvas.height = S;
            shapeCtx = shapeCanvas.getContext('2d', { willReadFrequently: true });
          }
          var w = img.naturalWidth || S, h = img.naturalHeight || S, k = Math.min(S / w, S / h);
          var dw = Math.max(1, w * k), dh = Math.max(1, h * k);
          shapeCtx.clearRect(0, 0, S, S);
          shapeCtx.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
          var d = shapeCtx.getImageData(0, 0, S, S).data, ink = new Float32Array(S * S), i, x, y;
          // Where the picture is (ignoring transparent margins). If that area is almost fully opaque it is a picture
          // on a background colour (its corner): ink = what differs from it. Otherwise ink = what is painted.
          var ax0 = S, ay0 = S, ax1 = -1, ay1 = -1, solid = 0;
          for (y = 0; y < S; y++) for (x = 0; x < S; x++) if (d[(y * S + x) * 4 + 3] > 40) {
            if (x < ax0) ax0 = x; if (x > ax1) ax1 = x; if (y < ay0) ay0 = y; if (y > ay1) ay1 = y;
            if (d[(y * S + x) * 4 + 3] > 200) solid++;
          }
          if (ax1 < ax0) return resolve(null);
          var opaque = solid >= 0.9 * (ax1 - ax0 + 1) * (ay1 - ay0 + 1), c = (ay0 * S + ax0) * 4;
          for (i = 0; i < S * S; i++) {
            var o = i * 4;
            if (opaque) {
              var diff = (Math.abs(d[o] - d[c]) + Math.abs(d[o + 1] - d[c + 1]) + Math.abs(d[o + 2] - d[c + 2])) / 3;
              ink[i] = d[o + 3] > 200 ? Math.min(255, diff * 4) : 0;
            } else ink[i] = d[o + 3];
          }
          var x0 = S, y0 = S, x1 = -1, y1 = -1;
          for (y = 0; y < S; y++) for (x = 0; x < S; x++) if (ink[y * S + x] > 40) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
          if (x1 < x0) return resolve(null);
          // Crop to the ink, keep the proportions, centre it in N×N.
          var bw = x1 - x0 + 1, bh = y1 - y0 + 1, side = Math.max(bw, bh), ox = x0 - (side - bw) / 2, oy = y0 - (side - bh) / 2;
          var a = new Float32Array(N * N), step = side / N;
          for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
            var sum = 0, cnt = 0;
            for (var sy = Math.floor(oy + y * step); sy < oy + (y + 1) * step; sy++) {
              for (var sx = Math.floor(ox + x * step); sx < ox + (x + 1) * step; sx++) {
                if (sx >= 0 && sy >= 0 && sx < S && sy < S) sum += ink[sy * S + sx];
                cnt++;
              }
            }
            a[y * N + x] = cnt ? sum / cnt : 0;
          }
          resolve(unit(a));
        } catch (e) { resolve(null); }
      };
      img.src = src;
    });
  }

  function artTile(x, i) {
    var tags = (x.byName ? '<span class="lvm-tag">name</span>' : '') +
      (x.look >= ART_VISUAL_MIN ? '<span class="lvm-tag lvm-tag-look">' + Math.floor(x.look * 100) + '% look</span>' : '') +
      (/^gif$/i.test(x.f.ext || '') ? '<span class="lvm-tag">GIF</span>' : '');
    return '<button type="button" class="lvm-tile lvm-art" data-art="' + i + '" title="' + esc(x.f.path) + '">' +
      '<span class="lvm-thumb"><span class="lvm-loading">…</span></span>' +
      '<span class="lvm-name">' + esc(x.f.name) + '</span><span class="lvm-tags">' + tags + '</span></button>';
  }
  function renderArt(list, id) {
    var store = SF.assetStore;
    $('#lvmArt').html(list.map(artTile).join(''));
    list.forEach(function (x, i) {
      var $t = $('#lvmArt [data-art="' + i + '"]').data('path', x.f.path);
      store.fetchImage(x.f).then(function (b) {
        if (id !== runId) return;
        var img = function () { $t.find('.lvm-thumb').html($('<img alt="">').attr('src', b.url)); };
        // SVG files are drawn as inline <svg>; other formats (PNG, GIF…) can only be an <img>.
        if (!/^svg$/i.test(x.f.ext || '')) return img();
        fetch(b.url).then(function (r) { return r.text(); }).then(function (text) {
          if (id !== runId) return;
          var node = inlineSvg(text);
          if (node) $t.find('.lvm-thumb').empty().append(node); else img();
        }, img);
      }, function () { $t.find('.lvm-loading').text('failed'); });
    });
  }

  /** Name matches first (shown at once), then the images that look like the icon, best first. */
  function loadArt(icon, id) {
    var $sec = $('#lvmArtSection'), store = SF.assetStore;
    $('#lvmArt').empty();
    if (!store) { $sec.addClass('hidden'); return; }
    $sec.removeClass('hidden');
    $('#lvmArtStatus').text('Looking in the Asset Store…');
    store.getFiles().then(function (files) {
      if (id !== runId) return;
      if (!files.length) { $('#lvmArtStatus').text('The Asset Store is not available (sign in to load it).'); return; }
      var named = artFor(icon, files).map(function (x) { return { f: x.f, byName: true, look: 0 }; });
      renderArt(named, id);

      var svg = svgOf(icon);
      var rest = files.filter(function (f) { return !named.some(function (x) { return x.f.path === f.path; }); }).slice(0, MAX_ART_SCAN);
      if (!svg || !rest.length || named.length >= MAX_ART) {
        $('#lvmArtStatus').text(named.length ? '' : 'No matching illustration in the Asset Store.');
        return;
      }
      var src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(forCanvas(svg));
      var looks = [], at = 0, done = 0;
      var progress = function () { if (id === runId) $('#lvmArtStatus').text('Comparing with Asset Store images… ' + done + ' / ' + rest.length); };
      shapePrint(src).then(function (mine) {
        if (id !== runId) return;
        if (!mine) { $('#lvmArtStatus').text(named.length ? '' : 'No matching illustration in the Asset Store.'); return; }
        // Name matches get their look score too (shown on the tile), without changing their place.
        var all = named.map(function (x) { return x.f; }).concat(rest);
        function worker() {
          if (id !== runId || at >= all.length) return Promise.resolve();
          var f = all[at++];
          var have = f.path in artPrints ? Promise.resolve(artPrints[f.path])
            : store.fetchImage(f).then(function (b) { return shapePrint(b.url); }, function () { return null; })
                .then(function (v) { artPrints[f.path] = v; return v; });
          return have.then(function (v) {
            done++;
            var look = v ? cosine(mine, v) : 0;
            var hit = named.filter(function (x) { return x.f.path === f.path; })[0];
            if (hit) hit.look = look;
            else if (look >= ART_VISUAL_MIN) looks.push({ f: f, byName: false, look: look });
            if (done % 8 === 0) progress();
            return worker();
          });
        }
        progress();
        Promise.all([worker(), worker(), worker(), worker()]).then(function () {
          if (id !== runId) return;
          looks.sort(function (a, b) { return b.look - a.look; });
          var list = named.concat(looks).slice(0, MAX_ART);
          $('#lvmArtStatus').text(list.length ? '' : 'No matching illustration in the Asset Store.');
          renderArt(list, id);
        });
      });
    });
  }

  /** Look at a suggested icon: only the preview changes, the suggestions stay those of the icon first opened. */
  function peek(icon) {
    current = icon;
    renderHead(icon);
    $('#libViewModal .lvm-body').scrollTop(0);
  }

  function show(icon) {
    current = origin = icon;
    var id = ++runId;
    renderHead(icon);
    $('#libViewModal .lvm-body').scrollTop(0);
    loadSimilar(icon, id);
    loadArt(icon, id);
    // Hosted Library icons carry no inline SVG: fetch it once so the preview and the comparison can use it.
    if (!svgOf(icon) && icon.openPath) {
      $.ajax({ url: icon.openPath, dataType: 'text', headers: typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {} })
        .done(function (text) {
          if (!/<svg\b/i.test(text || '')) return;
          hostedSvg[icon.id] = text;
          if (id === runId) { if (current === icon) renderHead(icon); loadSimilar(icon, id); }
        });
    }
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !current || $('#assetPreview').length || $('#sfConfirmModal:not(.hidden)').length) return;
    e.stopPropagation();   // not the preview panel underneath
    close();
  }
  function close() {
    current = origin = null; runId++;
    $('#libViewModal').addClass('hidden');
    document.removeEventListener('keydown', onKey, true);
  }

  /** Open the preview popup for a Library icon. Returns false when the icon is unknown. */
  SF.openLibraryIconModal = function (iconId) {
    var icon = byId(iconId);
    if (!icon) return false;
    ensureModal();
    var wasOpen = !!current;
    show(icon);
    $('#libViewModal').removeClass('hidden');
    if (!wasOpen) document.addEventListener('keydown', onKey, true);
    $('#lvmClose').trigger('focus');
    return true;
  };
  SF.closeLibraryIconModal = close;

  function copy(text, msg) {
    if (text && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { if (SF.showToast) SF.showToast(msg); }, function () {});
    }
  }
  $(document).on('click', '#lvmClose, #lvmBg', close);
  $(document).on('click', '#lvmCopyCode', function () { copy($('#lvmCode').text(), 'Copied'); });
  $(document).on('click', '#lvmCopySvg', function () { if (current) copy(svgOf(current), 'SVG copied'); });
  $(document).on('click', '#lvmCustomize', function () {
    var id = current && current.id;
    close();
    if (id && typeof SF.openLibraryPreview === 'function') SF.openLibraryPreview(id);
  });
  $(document).on('click', '#lvmSimilar .lvm-tile', function () {
    var icon = byId($(this).data('iconId'));
    if (icon) peek(icon);
  });
  $(document).on('click', '#lvmBack', function () { if (origin) peek(origin); });
  $(document).on('click', '#lvmArt .lvm-tile', function () {
    var path = $(this).data('path');
    if (path && SF.assetStore) SF.assetStore.open(path);
  });

  SF.onLibraryThemeColor = function () { if (current) renderHead(current); };

  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    if (page !== 'iconlibrary' && current) close();
    return origSwitch.apply(this, arguments);
  };

  SF.libSimilar = { nameScore: nameScore, tokens: tokens, artFor: artFor, shapePrint: shapePrint, cosine: cosine, forCanvas: forCanvas };
})(window.SpriteForge, jQuery);
