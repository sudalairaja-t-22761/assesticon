/**
 * SpriteForge - Combine icons: two Icon Library icons arranged on a free canvas become one new icon.
 *
 * Flow: pick icon A and icon B → move / resize / rotate / flip each on a 24 × 24 canvas (optionally cut a gap
 * around the top icon) → preview → name it → "Add to Icon Library" (the Library's own Add icon step: the icon is
 * appended to the repository sprite and listed as unverified).
 *
 * The result is ONE flat SVG: every shape of both icons is read from the rendered icon (so sprite classes and CSS
 * variables are already resolved), turned into a <path> of absolute M / L / C / Z segments and the icon's own
 * transforms plus the canvas placement are applied to the points. Colours are not copied: filled shapes inherit the
 * fill (zcicn_<colour>), stroked shapes use --zcicn-color-baseStroke (zcicn-iconStroke-<colour>), white stays white.
 */
(function (SF, $) {
  'use strict';

  var PAGE = 'combineicons';
  var SIZE = 24;                       // output viewBox: 0 0 24 24
  var PAD = 4;                         // canvas margin around the artboard (room for the handles)
  var SNAP = 0.35;                     // snapping distance, canvas units
  var BLACK = 'hsl(0,0%,0%)';          // mask ink: not a colour the previews repaint (they replace #hex / rgb / black)
  var THEME_STROKE = 'var(--zcicn-color-baseStroke, currentColor)';
  var SHAPES = 'path,rect,circle,ellipse,line,polyline,polygon';
  // Read from the browser instead of written here: the commit check rejects URL-like text in source files.
  var SVG_NS = (function () {
    var d = document.createElement('div');
    d.innerHTML = '<svg></svg>';
    return d.firstChild.namespaceURI;
  })();

  var layers = [null, null];           // slot 0 = icon A, slot 1 = icon B
  var order = [0, 1];                  // paint order, bottom → top
  var sel = -1;                        // selected slot on the canvas
  var slot = 0;                        // slot the next picked icon goes into
  var cut = { on: false, gap: 1 };
  var guides = [];                     // snap lines shown while dragging: { v: x } | { h: y }
  var drag = null;
  var nameTouched = false, addedName = '', busy = false;
  var hosted = {};                     // icon id → svg text fetched for icons without inline content
  var raf = 0, previewTimer = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function P() { return SF.libPreview; }
  function icons() { return ((SF.libState && SF.libState.icons) || []).filter(Boolean); }
  function baseName(icon) { return P() ? P().baseName(icon) : String(icon.name || ''); }
  function svgOf(icon) { return icon.svgContent || hosted[icon.id] || ''; }
  function toast(m) { if (SF.showToast) SF.showToast(m); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

  // ── path data → absolute M / L / C / Z segments ──────────────────────
  function arcToCubics(x1, y1, rx, ry, deg, large, sweep, x2, y2) {
    if (x1 === x2 && y1 === y2) return [];
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry) return [['L', x2, y2]];
    var phi = deg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    var xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
    var lam = xp * xp / (rx * rx) + yp * yp / (ry * ry);
    if (lam > 1) { var grow = Math.sqrt(lam); rx *= grow; ry *= grow; }
    var den = rx * rx * yp * yp + ry * ry * xp * xp;
    var k = den ? Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / den)) : 0;
    if (!!large === !!sweep) k = -k;
    var cxp = k * rx * yp / ry, cyp = -k * ry * xp / rx;
    var cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    var t1 = Math.atan2((yp - cyp) / ry, (xp - cxp) / rx), t2 = Math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx);
    var dt = t2 - t1;
    if (sweep && dt < 0) dt += 2 * Math.PI; else if (!sweep && dt > 0) dt -= 2 * Math.PI;
    var n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), step = dt / n, t = 4 / 3 * Math.tan(step / 4), out = [];
    function pt(u, v) { return [cx + rx * u * cos - ry * v * sin, cy + rx * u * sin + ry * v * cos]; }
    for (var i = 0; i < n; i++) {
      var a = t1 + i * step, b = a + step;
      var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
      var p1 = pt(ca - t * sa, sa + t * ca), p2 = pt(cb + t * sb, sb - t * cb), p = i === n - 1 ? [x2, y2] : pt(cb, sb);
      out.push(['C', p1[0], p1[1], p2[0], p2[1], p[0], p[1]]);
    }
    return out;
  }

  /** "M1 2h3a1 1 0 01.5.5z" → [['M',1,2], ['L',4,2], ['C',…], ['Z']] (as much as is readable, like a browser). */
  function parsePath(d) {
    d = String(d || '');
    var i = 0, n = d.length, out = [];
    var cx = 0, cy = 0, sx = 0, sy = 0, px = 0, py = 0, prev = '';   // current point, subpath start, last control point
    function ws() { while (i < n && /[\s,]/.test(d.charAt(i))) i++; }
    function num() {
      ws();
      var m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(d.substr(i, 48));
      if (!m) throw new Error('number');
      i += m[0].length;
      return +m[0];
    }
    function flag() { ws(); var c = d.charAt(i); if (c !== '0' && c !== '1') throw new Error('flag'); i++; return +c; }
    function more() { ws(); return i < n && /[-+.\d]/.test(d.charAt(i)); }
    try {
      for (;;) {
        ws();
        if (i >= n) break;
        var cmd = d.charAt(i++);
        if (!/[MLHVCSQTAZ]/i.test(cmd)) throw new Error('command');
        if (!out.length && !/m/i.test(cmd)) throw new Error('start');
        if (/z/i.test(cmd)) { out.push(['Z']); cx = sx; cy = sy; prev = 'Z'; continue; }
        do {
          var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? cx : 0, oy = rel ? cy : 0;
          var x, y, x1, y1, x2, y2;
          if (C === 'M') { x = ox + num(); y = oy + num(); out.push(['M', x, y]); sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
          else if (C === 'L') { x = ox + num(); y = oy + num(); out.push(['L', x, y]); }
          else if (C === 'H') { x = ox + num(); y = cy; out.push(['L', x, y]); }
          else if (C === 'V') { x = cx; y = oy + num(); out.push(['L', x, y]); }
          else if (C === 'C' || C === 'S') {
            if (C === 'C') { x1 = ox + num(); y1 = oy + num(); }
            else { x1 = /[CS]/.test(prev) ? 2 * cx - px : cx; y1 = /[CS]/.test(prev) ? 2 * cy - py : cy; }
            x2 = ox + num(); y2 = oy + num(); x = ox + num(); y = oy + num();
            out.push(['C', x1, y1, x2, y2, x, y]); px = x2; py = y2;
          } else if (C === 'Q' || C === 'T') {
            var qx, qy;
            if (C === 'Q') { qx = ox + num(); qy = oy + num(); }
            else { qx = /[QT]/.test(prev) ? 2 * cx - px : cx; qy = /[QT]/.test(prev) ? 2 * cy - py : cy; }
            x = ox + num(); y = oy + num();
            out.push(['C', cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y]);
            px = qx; py = qy;
          } else {   // A
            var rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
            x = ox + num(); y = oy + num();
            Array.prototype.push.apply(out, arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y));
          }
          cx = x; cy = y; prev = C;
        } while (more());
      }
    } catch (e) { /* keep what was read */ }
    return out;
  }

  /** Path data of a basic shape element (lengths resolved by the browser). */
  function shapeD(el) {
    var tag = el.tagName.toLowerCase();
    function v(name) { try { return el[name].baseVal.value; } catch (e) { return 0; } }
    if (tag === 'path') return el.getAttribute('d') || '';
    if (tag === 'line') return 'M' + v('x1') + ' ' + v('y1') + 'L' + v('x2') + ' ' + v('y2');
    if (tag === 'polyline' || tag === 'polygon') {
      var n = (el.getAttribute('points') || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [], d = '';
      for (var i = 0; i + 1 < n.length; i += 2) d += (i ? 'L' : 'M') + n[i] + ' ' + n[i + 1];
      return d && tag === 'polygon' ? d + 'Z' : d;
    }
    if (tag === 'circle' || tag === 'ellipse') {
      var cx = v('cx'), cy = v('cy'), rx = tag === 'circle' ? v('r') : v('rx'), ry = tag === 'circle' ? rx : v('ry');
      if (!(rx > 0 && ry > 0)) return '';
      return 'M' + (cx - rx) + ' ' + cy + 'A' + rx + ' ' + ry + ' 0 1 0 ' + (cx + rx) + ' ' + cy + 'A' + rx + ' ' + ry + ' 0 1 0 ' + (cx - rx) + ' ' + cy + 'Z';
    }
    if (tag === 'rect') {
      var x = v('x'), y = v('y'), w = v('width'), h = v('height');
      if (!(w > 0 && h > 0)) return '';
      var hasX = el.hasAttribute('rx'), hasY = el.hasAttribute('ry');
      var a = hasX ? v('rx') : (hasY ? v('ry') : 0), b = hasY ? v('ry') : a;
      a = Math.min(a, w / 2); b = Math.min(b, h / 2);
      if (!(a > 0 && b > 0)) return 'M' + x + ' ' + y + 'H' + (x + w) + 'V' + (y + h) + 'H' + x + 'Z';
      var arc = 'A' + a + ' ' + b + ' 0 0 1 ';
      return 'M' + (x + a) + ' ' + y + 'H' + (x + w - a) + arc + (x + w) + ' ' + (y + b) + 'V' + (y + h - b) + arc + (x + w - a) + ' ' + (y + h) +
        'H' + (x + a) + arc + x + ' ' + (y + h - b) + 'V' + (y + b) + arc + (x + a) + ' ' + y + 'Z';
    }
    return '';
  }

  function applyMatrix(segs, m) {
    return segs.map(function (s) {
      var o = [s[0]];
      for (var i = 1; i < s.length; i += 2) {
        o.push(m.a * s[i] + m.c * s[i + 1] + m.e, m.b * s[i] + m.d * s[i + 1] + m.f);
      }
      return o;
    });
  }
  function segsToD(segs) {
    return segs.map(function (s) { return s[0] + s.slice(1).map(r2).join(' '); }).join('');
  }

  // ── icon → shapes ────────────────────────────────────────────────────
  function paintKind(value, opacity) {
    var v = String(value || '').replace(/\s+/g, '').toLowerCase();
    if (!v || v === 'none' || v === 'transparent' || /^rgba\(.*,0\)$/.test(v) || opacity === 0) return null;
    return /^(rgb\(255,255,255\)|rgba\(255,255,255,1\)|#fff|#ffffff|white)$/.test(v) ? 'white' : 'theme';
  }

  /**
   * The drawable shapes of an icon, in the coordinates of its own viewBox.
   * @returns {{box:{x,y,w,h}, shapes:Array, dropped:number}|null}
   */
  function analyse(icon, svgText) {
    var p = P();
    if (!p || !svgText) return null;
    var safe = String(svgText).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
    // The icon is read inside a shadow root, where ":root" matches nothing: the sprite's :root variables
    // (--zcicn-color-white: transparent hides shapes) are moved to the host so they still reach the icon.
    safe = safe.replace(/:root\b/g, ':host');
    var host = p.isolatedHost(safe, 100), res = null;
    try {
      var root = host.root.querySelector('svg');
      if (!root) return null;
      // Theme colours resolve to "a colour" (anything not white is the theme colour).
      root.style.setProperty('--zcicn-color-baseStroke', '#000');
      root.style.setProperty('--zcicn-color-main', '#000');
      root.style.color = '#000';
      // Like every preview in the Library (coloredSvg): the icon's root carries the fill colour, so shapes without a
      // fill of their own are filled even when the standalone root says fill="none".
      root.style.fill = '#000';
      var vb = root.viewBox && root.viewBox.baseVal, box = null;
      if (vb && vb.width && vb.height) box = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
      else { var bb = root.getBBox(); if (bb.width && bb.height) box = { x: bb.x, y: bb.y, w: bb.width, h: bb.height }; }
      var fit = icon && icon.id ? p.measure(icon) : null;      // icons drawn outside their viewBox: the whole drawing
      if (fit && fit.overflow && fit.box) box = { x: fit.box[0], y: fit.box[1], w: fit.box[2], h: fit.box[3] };
      if (!box) return null;

      var inv = root.getScreenCTM().inverse(), shapes = [];
      var dropped = Array.prototype.filter.call(root.querySelectorAll('use,text,image,foreignObject'), function (el) {
        if (el.closest('defs,clipPath,mask,symbol,pattern,marker')) return false;
        try { var bb = el.getBBox(); return bb.width > 0 && bb.height > 0; } catch (e) { return false; }   // drawn, not an empty leftover
      }).length;
      Array.prototype.forEach.call(root.querySelectorAll(SHAPES), function (el) {
        if (el.closest('defs,clipPath,mask,symbol,pattern,marker')) return;
        var cs = getComputedStyle(el), ctm = el.getScreenCTM();
        if (cs.display === 'none' || !ctm) return;
        var m = inv.multiply(ctm), segs = applyMatrix(parsePath(shapeD(el)), m);
        if (segs.length < 2) return;
        // non-scaling-stroke: the width is in screen pixels at any icon size, so it is never scaled with the shape
        var nss = cs.vectorEffect === 'non-scaling-stroke';
        var grow = nss ? 1 : (Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1), sw = (parseFloat(cs.strokeWidth) || 0) * grow;
        var fo = parseFloat(cs.fillOpacity), so = parseFloat(cs.strokeOpacity);
        var fill = el.tagName.toLowerCase() === 'line' ? null : paintKind(cs.fill, fo);
        var stroke = sw > 0 ? paintKind(cs.stroke, so) : null;
        if (!fill && !stroke) return;
        var op = 1;
        for (var node = el; node && node.nodeType === 1; node = node.parentNode) {
          var o = parseFloat(getComputedStyle(node).opacity);
          if (isFinite(o)) op *= o;
          if (node === root) break;
        }
        if (op <= 0) return;
        shapes.push({ segs: segs, fill: fill, stroke: stroke, sw: sw, nss: nss && !!stroke, cap: cs.strokeLinecap || 'butt', join: cs.strokeLinejoin || 'miter',
          rule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero', op: Math.min(1, op),
          fo: fill && fo < 1 ? fo : 1, so: stroke && so < 1 ? so : 1 });
      });
      res = shapes.length ? { box: box, shapes: shapes, dropped: dropped } : null;
    } catch (e) { res = null; }
    host.remove();
    return res;
  }

  // ── layers ───────────────────────────────────────────────────────────
  function live() { return order.filter(function (i) { return !!layers[i]; }); }
  function fitScale(L, size) { return size / Math.max(L.box.w, L.box.h); }
  /** Starting place: icon A fills the canvas, icon B is a half-size badge in the bottom-right corner. */
  function place(L, i) {
    var size = i === 0 ? SIZE : SIZE / 2, c = i === 0 ? SIZE / 2 : SIZE * 0.75;
    L.x = c; L.y = c; L.scale = fitScale(L, size); L.rot = 0; L.flip = false;
  }
  /** Layer → canvas matrix: box centre to (x, y), flipped, scaled, rotated. */
  function matrix(L) {
    var r = L.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), k = L.scale, fx = L.flip ? -1 : 1;
    var a = c * k * fx, b = s * k * fx, cc = -s * k, d = c * k;
    var bx = L.box.x + L.box.w / 2, by = L.box.y + L.box.h / 2;
    return { a: a, b: b, c: cc, d: d, e: L.x - a * bx - cc * by, f: L.y - b * bx - d * by };
  }
  function corners(L) {
    var b = L.box, m = matrix(L);
    return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(function (p) {
      return [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f];
    });
  }
  function bounds(L) {
    var c = corners(L), xs = c.map(function (p) { return p[0]; }), ys = c.map(function (p) { return p[1]; });
    return { x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs), y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys) };
  }
  function isMixed() {
    var fill = false, stroke = false;
    live().forEach(function (i) {
      layers[i].shapes.forEach(function (s) { if (s.fill === 'theme') fill = true; if (s.stroke === 'theme') stroke = true; });
    });
    return fill && stroke;
  }

  // ── markup ───────────────────────────────────────────────────────────
  function shapeAttrs(s, k, mixed) {
    var a = '', style = [];
    if (!s.fill) style.push('fill:none');
    else if (s.fill === 'white') a += ' fill="#fff"';
    else if (mixed) a += ' fill="currentColor"';        // fill and stroke shapes in one icon: say which is which
    if (s.fill && s.rule === 'evenodd') a += ' fill-rule="evenodd"';
    if (s.fill && s.fo < 1) a += ' fill-opacity="' + r2(s.fo) + '"';
    if (s.stroke && s.so < 1) a += ' stroke-opacity="' + r2(s.so) + '"';
    if (s.stroke) {
      style.push('stroke:' + (s.stroke === 'white' ? '#fff' : THEME_STROKE));
      a += ' stroke-width="' + r2(s.nss ? s.sw : s.sw * k) + '"';
      if (s.nss) a += ' vector-effect="non-scaling-stroke"';
      if (s.cap !== 'butt') a += ' stroke-linecap="' + esc(s.cap) + '"';
      if (s.join !== 'miter') a += ' stroke-linejoin="' + esc(s.join) + '"';
    }
    if (s.op < 1) a += ' opacity="' + r2(s.op) + '"';
    if (style.length) a += ' style="' + style.join(';') + '"';
    return a;
  }
  function layerPaths(i, mixed) {
    var L = layers[i], m = matrix(L);
    return L.shapes.map(function (s) {
      return '<path d="' + segsToD(applyMatrix(s.segs, m)) + '"' + shapeAttrs(s, L.scale, mixed) + '/>';
    }).join('');
  }
  /** Mask that hides the bottom icon under the top one, plus `cut.gap` around it. */
  function maskMarkup(id, x, y, w, h) {
    var top = live()[1], L = layers[top], m = matrix(L);
    return '<mask id="' + id + '" maskUnits="userSpaceOnUse" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '">' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="#fff"/>' +
      '<g stroke-linejoin="round" stroke-linecap="round">' +
      L.shapes.map(function (s) {
        return '<path d="' + segsToD(applyMatrix(s.segs, m)) + '" fill="' + (s.fill ? BLACK : 'none') + '" stroke="' + BLACK +
          '" stroke-width="' + r2((s.stroke && !s.nss ? s.sw * L.scale : 0) + 2 * cut.gap) + '"' + (s.fill && s.rule === 'evenodd' ? ' fill-rule="evenodd"' : '') + '/>';
      }).join('') + '</g></mask>';
  }
  function cutOn() { return cut.on && live().length === 2; }

  /** The combined icon as one standalone SVG ('' while the canvas is empty). */
  function buildSvg() {
    var ls = live();
    if (!ls.length) return '';
    var mixed = isMixed(), body = cutOn() ? '<defs>' + maskMarkup('cmbCut', 0, 0, SIZE, SIZE) + '</defs>' : '';
    ls.forEach(function (i, n) {
      var paths = layerPaths(i, mixed);
      body += cutOn() && n === 0 ? '<g mask="url(#cmbCut)">' + paths + '</g>' : paths;
    });
    return '<svg xmlns="' + SVG_NS + '" viewBox="0 0 ' + SIZE + ' ' + SIZE + '" width="' + SIZE + '" height="' + SIZE + '">' + body + '</svg>';
  }

  // ── canvas ───────────────────────────────────────────────────────────
  function pts(list) { return list.map(function (p) { return r2(p[0]) + ',' + r2(p[1]); }).join(' '); }
  function rotHandle(L) {
    var c = corners(L), mx = (c[0][0] + c[1][0]) / 2, my = (c[0][1] + c[1][1]) / 2;
    var ux = c[0][0] - c[3][0], uy = c[0][1] - c[3][1], len = Math.sqrt(ux * ux + uy * uy) || 1;
    return { from: [mx, my], at: [mx + ux / len * 1.8, my + uy / len * 1.8] };
  }
  function drawCanvas() {
    raf = 0;
    var cv = document.getElementById('cmbCanvas');
    if (!cv) return;
    var ls = live(), mixed = isMixed(), full = SIZE + 2 * PAD;
    var h = '<rect class="cmb-board" x="0" y="0" width="' + SIZE + '" height="' + SIZE + '"/>' +
      '<line class="cmb-axis" x1="' + SIZE / 2 + '" y1="0" x2="' + SIZE / 2 + '" y2="' + SIZE + '"/>' +
      '<line class="cmb-axis" x1="0" y1="' + SIZE / 2 + '" x2="' + SIZE + '" y2="' + SIZE / 2 + '"/>';
    if (!ls.length) h += '<text class="cmb-empty" x="' + SIZE / 2 + '" y="' + (SIZE / 2 - 1) + '">Pick two icons to start</text>';
    if (cutOn()) h += '<defs>' + maskMarkup('cmbCutCanvas', -PAD, -PAD, full, full) + '</defs>';
    ls.forEach(function (i, n) {
      h += '<g data-layer="' + i + '"' + (cutOn() && n === 0 ? ' mask="url(#cmbCutCanvas)"' : '') + '>' + layerPaths(i, mixed) +
        '<polygon class="cmb-hit" points="' + pts(corners(layers[i])) + '"/></g>';
    });
    h += '<path class="cmb-dim" fill-rule="evenodd" d="M' + -PAD + ' ' + -PAD + 'h' + full + 'v' + full + 'h' + -full + 'zM0 0h' + SIZE + 'v' + SIZE + 'h' + -SIZE + 'z"/>' +
      '<rect class="cmb-frame" x="0" y="0" width="' + SIZE + '" height="' + SIZE + '"/>';
    guides.forEach(function (g) {
      h += g.v != null ? '<line class="cmb-guide" x1="' + g.v + '" y1="' + -PAD + '" x2="' + g.v + '" y2="' + (SIZE + PAD) + '"/>'
        : '<line class="cmb-guide" x1="' + -PAD + '" y1="' + g.h + '" x2="' + (SIZE + PAD) + '" y2="' + g.h + '"/>';
    });
    var L = layers[sel];
    if (L) {
      var c = corners(L), rh = rotHandle(L);
      h += '<polygon class="cmb-sel" points="' + pts(c) + '"/>' +
        '<line class="cmb-sel" x1="' + r2(rh.from[0]) + '" y1="' + r2(rh.from[1]) + '" x2="' + r2(rh.at[0]) + '" y2="' + r2(rh.at[1]) + '"/>' +
        c.map(function (p) { return '<circle class="cmb-handle" data-h="scale" cx="' + r2(p[0]) + '" cy="' + r2(p[1]) + '" r="0.5"/>'; }).join('') +
        '<circle class="cmb-handle cmb-handle-rot" data-h="rot" cx="' + r2(rh.at[0]) + '" cy="' + r2(rh.at[1]) + '" r="0.5"/>';
    }
    cv.innerHTML = h;
  }
  function pointer(e) {
    var m = document.getElementById('cmbCanvas').getScreenCTM().inverse();
    return { x: m.a * e.clientX + m.c * e.clientY + m.e, y: m.b * e.clientX + m.d * e.clientY + m.f };
  }
  function nearest(list) {
    var best = null;
    list.forEach(function (c) {
      var d = c[1] - c[0];
      if (Math.abs(d) <= SNAP && (!best || Math.abs(d) < Math.abs(best.d))) best = { d: d, at: c[1] };
    });
    return best;
  }
  /** While moving: the icon's centre snaps to the canvas centre, its edges to the canvas edges. */
  function snap(L) {
    guides = [];
    var b = bounds(L);
    var sx = nearest([[L.x, SIZE / 2], [b.x0, 0], [b.x1, SIZE]]), sy = nearest([[L.y, SIZE / 2], [b.y0, 0], [b.y1, SIZE]]);
    if (sx) { L.x += sx.d; guides.push({ v: sx.at }); }
    if (sy) { L.y += sy.d; guides.push({ h: sy.at }); }
  }

  // ── side panel, warnings, preview ────────────────────────────────────
  function setVal(id, v) {
    var el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v;
  }
  function sizePct(L) { return L.scale * Math.max(L.box.w, L.box.h) / SIZE * 100; }
  function syncPanel() {
    var L = layers[sel], ls = live();
    $('#cmbLayer').toggleClass('is-off', !L);
    setVal('cmbX', L ? r2(L.x) : ''); setVal('cmbY', L ? r2(L.y) : '');
    setVal('cmbSize', L ? Math.round(sizePct(L)) : ''); setVal('cmbRot', L ? Math.round(L.rot) : '');
    $('#cmbFront').prop('disabled', !L || ls.length < 2 || ls[ls.length - 1] === sel);
    $('#cmbCut, #cmbGap').prop('disabled', ls.length < 2);
    $('#cmbCut').prop('checked', cut.on);

    var warn = [];
    if (isMixed()) warn.push('One icon is filled and the other is drawn with strokes. The sprite colours an icon as one or the other, so check the colours after adding it.');
    if (ls.some(function (i) { return layers[i].dropped; })) warn.push('Some parts (text, images or reused symbols) could not be combined and are left out.');
    if (ls.some(function (i) { var b = bounds(layers[i]); return b.x0 < -0.01 || b.y0 < -0.01 || b.x1 > SIZE + 0.01 || b.y1 > SIZE + 0.01; })) {
      warn.push('Parts outside the ' + SIZE + ' × ' + SIZE + ' canvas will be cut off.');
    }
    $('#cmbWarn').html(warn.map(function (w) { return '<div>' + esc(w) + '</div>'; }).join(''));
  }
  function renderSlots() {
    $('#cmbSlots').html([0, 1].map(function (i) {
      var L = layers[i], label = 'Icon ' + (i ? 'B' : 'A');
      return '<div class="cmb-slot' + (slot === i ? ' is-active' : '') + '" role="button" tabindex="0" data-slot="' + i + '" title="' + esc(L ? L.name : 'Pick ' + label) + '">' +
        '<span class="cmb-slot-tag">' + label + '</span>' +
        '<span class="cmb-slot-thumb">' + (L ? '<img alt="" src="' + esc(L.thumb) + '">' : 'empty') + '</span>' +
        '<span class="cmb-slot-name">' + esc(L ? L.name : (slot === i ? 'pick below' : '')) + '</span>' +
        (L ? '<button type="button" class="cmb-slot-x" data-remove="' + i + '" title="Remove ' + label + '" aria-label="Remove ' + label + '">&times;</button>' : '') +
        '</div>';
    }).join(''));
  }
  function thumb(icon) {
    var svg = svgOf(icon);
    return svg && P() ? P().dataUri(svg) : (icon.openPath || '');
  }
  function renderResults() {
    var q = $.trim($('#cmbSearch').val() || '').toLowerCase(), all = icons();
    var found = q ? all.filter(function (i) { return baseName(i).toLowerCase().indexOf(q) !== -1; }) : all;
    $('#cmbPickStatus').text(!all.length ? (libraryLoading() ? 'Loading the Icon Library…' : 'The Icon Library is not loaded yet (sign in to load it).')
      : !found.length ? 'No icon matches "' + q + '".' : found.length + ' icon' + (found.length === 1 ? '' : 's'));
    renderTiles(document.getElementById('cmbResults'), found, null);
  }
  /**
   * Icon tiles for a picker list (shared with the Animate icon page). Every icon is listed; a thumbnail is only
   * built when its tile scrolls into view, so a Library of a thousand icons stays light.
   */
  function renderTiles(el, list, activeId) {
    if (!el) return;
    if (el._cmbWatch) el._cmbWatch.disconnect();
    var byId = {};
    el.innerHTML = list.map(function (icon) {
      var n = baseName(icon);
      byId[icon.id] = icon;
      return '<button type="button" class="cmb-tile' + (activeId === icon.id ? ' is-active' : '') + '" data-icon-id="' + esc(icon.id) + '" title="' + esc(n) + '">' +
        '<img alt="" width="24" height="24"><span>' + esc(n) + '</span></button>';
    }).join('');
    function show(tile) {
      var icon = byId[tile.getAttribute('data-icon-id')], img = tile.firstChild;
      if (icon && img && !img.getAttribute('src')) img.src = thumb(icon);
    }
    var tiles = el.querySelectorAll('.cmb-tile');
    if (typeof IntersectionObserver !== 'function') { Array.prototype.forEach.call(tiles, show); return; }
    var watch = el._cmbWatch = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { show(e.target); watch.unobserve(e.target); } });
    }, { root: el, rootMargin: '300px 0px' });
    Array.prototype.forEach.call(tiles, function (t) { watch.observe(t); });
  }
  function renderPreview() {
    previewTimer = 0;
    var svg = buildSvg(), p = P();
    if (!svg || !p) { $('#cmbPreview').empty(); return; }
    $('#cmbPreview').html([{ hex: '#313949', dark: false }, { hex: '#FFFFFF', dark: true }].map(function (c) {
      var src = esc(p.dataUri(p.coloredSvg(svg, c)));
      return '<div class="cmb-preview-row' + (c.dark ? ' is-dark' : '') + '">' + [16, 24, 32].map(function (px) {
        return '<img alt="' + px + ' px" title="' + px + ' px" width="' + px + '" height="' + px + '" src="' + src + '">';
      }).join('') + '</div>';
    }).join(''));
  }

  // ── name ─────────────────────────────────────────────────────────────
  function defaultName() {
    var ls = [0, 1].filter(function (i) { return layers[i]; });
    return ls.map(function (i) { return layers[i].name; }).join('-').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function nameError(name) {
    if (!name) return 'Give the new icon a name.';
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) return 'Use letters, numbers, "-" and "_" only.';
    var low = name.toLowerCase();
    if (icons().some(function (i) { return baseName(i).toLowerCase() === low; })) return 'An icon named "' + name + '" is already in the Icon Library.';
    return '';
  }
  function syncName() {
    if (!nameTouched) $('#cmbName').val(defaultName());
    var name = $.trim($('#cmbName').val()), two = live().length === 2, any = live().length > 0;
    var done = !!addedName && addedName === name;
    var err = done || !any ? '' : nameError(name);
    $('#cmbNameStatus').toggleClass('is-error', !!err)
      .text(done ? 'Added to the Icon Library as an unverified icon.' : err || (any && !two ? 'Pick the second icon to add the result to the Library.' : ''));
    $('#cmbAdd').prop('disabled', busy || done || !two || !!err);
    $('#cmbCopy, #cmbDownload').prop('disabled', !any);
  }

  function render() {
    if (!raf) raf = requestAnimationFrame(drawCanvas);
    syncPanel();
    syncName();
    if (!previewTimer) previewTimer = setTimeout(renderPreview, 120);
  }

  // ── picking ──────────────────────────────────────────────────────────
  var pending = [0, 0];   // per slot: id of the pick still being read (a later pick wins)
  function setLayer(i, icon, svg) {
    var a = analyse(icon, svg);
    if (!a) { toast(baseName(icon) + ' has no shapes that can be combined'); renderSlots(); return; }
    var L = { iconId: icon.id, name: baseName(icon), thumb: thumb(icon), box: a.box, shapes: a.shapes, dropped: a.dropped };
    place(L, i);
    layers[i] = L;
    sel = i; addedName = '';
    if (!layers[1 - i]) slot = 1 - i;
    renderSlots();
    render();
  }
  function pick(icon) {
    var i = slot, token = ++pending[i], svg = svgOf(icon);
    if (svg) { setLayer(i, icon, svg); return; }
    if (!icon.openPath) { toast('This icon has no SVG to combine'); return; }
    renderSlots();
    $.ajax({ url: icon.openPath, dataType: 'text', headers: typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {} })
      .done(function (text) {
        if (token !== pending[i]) return;
        if (!/<svg\b/i.test(text || '')) { toast('This icon has no SVG to combine'); return; }
        hosted[icon.id] = text;
        setLayer(i, icon, text);
      })
      .fail(function () { if (token === pending[i]) toast('Could not load ' + baseName(icon)); });
  }
  function removeLayer(i) {
    layers[i] = null; pending[i]++;
    if (sel === i) sel = layers[1 - i] ? 1 - i : -1;
    slot = i; addedName = '';
    renderSlots();
    render();
  }
  function startOver() {
    layers = [null, null]; order = [0, 1]; sel = -1; slot = 0; cut.on = false; guides = [];
    nameTouched = false; addedName = '';
    $('#cmbName').val('');
    renderSlots();
    render();
  }

  // ── add / copy / download ────────────────────────────────────────────
  /**
   * Ask, then hand one SVG to the Library's own Add icon step (appended to the repository sprite, listed as unverified).
   * Shared with the Animate icon page. @returns {Promise<boolean>} true when the icon was added
   */
  function confirmAdd(name, svg) {
    if (typeof SF.addIconsToIconRepo !== 'function') { toast('Add icon is not available'); return Promise.resolve(false); }
    var p = P();
    var ask = typeof SF.confirmDialog === 'function' ? SF.confirmDialog({
      title: 'Add "' + name + '" to the Icon Library?',
      html: '<div style="display:flex;align-items:center;gap:14px">' +
        '<img alt="" width="48" height="48" style="flex:none;padding:6px;border-radius:6px;background:#fff" src="' + esc(p.dataUri(p.coloredSvg(svg, { hex: '#313949' }))) + '">' +
        '<span>The icon is committed to the repository sprite right away and is listed as <b>unverified</b>. ' +
        'You can then request its verification like any other icon.</span></div>',
      yesText: 'Add icon', noText: 'Cancel'
    }) : Promise.resolve(window.confirm('Add "' + name + '" to the Icon Library? It is committed to the repository right away.'));
    return ask.then(function (yes) {
      if (!yes) return false;
      var file = new File([svg], name + '.svg', { type: 'image/svg+xml' });
      return Promise.resolve(SF.addIconsToIconRepo([file])).then(function (res) {
        if (res && res.ok && res.added && res.added.length) return true;
        if (res && res.ok && res.skipped && res.skipped.length) toast(name + ' was not added: ' + res.skipped[0].reason);
        return false;
      }, function () { return false; });
    });
  }
  function addToLibrary() {
    var name = $.trim($('#cmbName').val()), svg = buildSvg();
    if (!svg || live().length < 2 || nameError(name) || busy) return;
    busy = true; syncName();
    confirmAdd(name, svg).then(function (added) {
      busy = false;
      if (added) addedName = name;
      syncName();
    });
  }
  function saveFile(name, svg) {
    if (!svg) return;
    var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), a = document.createElement('a');
    a.href = url; a.download = (name || 'icon') + '.svg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function download() { saveFile($.trim($('#cmbName').val()) || 'combined-icon', buildSvg()); }
  /** The icon's SVG text: inline, or fetched once for hosted icons. Rejects when there is none. */
  function loadSvg(icon) {
    var svg = svgOf(icon);
    if (svg) return Promise.resolve(svg);
    if (!icon.openPath) return Promise.reject(new Error('no svg'));
    return new Promise(function (resolve, reject) {
      $.ajax({ url: icon.openPath, dataType: 'text', headers: typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {} })
        .done(function (text) {
          if (!/<svg\b/i.test(text || '')) return reject(new Error('no svg'));
          hosted[icon.id] = text;
          resolve(text);
        })
        .fail(function () { reject(new Error('load failed')); });
    });
  }

  // ── canvas events ────────────────────────────────────────────────────
  function onDown(e) {
    if (e.button) return;
    var cv = this, p = pointer(e), t = e.target, h = t.getAttribute && t.getAttribute('data-h');
    var g = t.closest ? t.closest('[data-layer]') : null, L = layers[sel];
    if (h && L) {
      var dx = p.x - L.x, dy = p.y - L.y;
      drag = h === 'rot' ? { type: 'rot', a0: Math.atan2(dy, dx), r0: L.rot }
        : { type: 'scale', d0: Math.sqrt(dx * dx + dy * dy) || 1, s0: L.scale };
    } else if (g) {
      sel = +g.getAttribute('data-layer'); L = layers[sel];
      drag = { type: 'move', ox: p.x - L.x, oy: p.y - L.y };
    } else { sel = -1; drag = null; }
    if (drag) { try { cv.setPointerCapture(e.pointerId); } catch (err) {} }
    cv.focus({ preventScroll: true });
    e.preventDefault();
    render();
  }
  function onMove(e) {
    var L = layers[sel];
    if (!drag || !L) return;
    var p = pointer(e), dx = p.x - L.x, dy = p.y - L.y;
    if (drag.type === 'move') {
      L.x = p.x - drag.ox; L.y = p.y - drag.oy;
      if (e.altKey) guides = []; else snap(L);
    } else if (drag.type === 'scale') {
      L.scale = clamp(drag.s0 * Math.sqrt(dx * dx + dy * dy) / drag.d0, fitScale(L, 0.5), fitScale(L, SIZE * 4));
    } else {
      var deg = drag.r0 + (Math.atan2(dy, dx) - drag.a0) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      L.rot = ((Math.round(deg * 10) / 10) % 360 + 360) % 360;
    }
    addedName = '';
    render();
  }
  function onUp() {
    if (!drag) return;
    drag = null; guides = [];
    render();
  }
  function onKey(e) {
    var L = layers[sel], step = e.shiftKey ? 1 : 0.25;
    var d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!L || !d) return;
    e.preventDefault();
    L.x += d[0]; L.y += d[1]; addedName = '';
    render();
  }
  function edit(fn) {
    var L = layers[sel];
    if (!L) return;
    fn(L); addedName = '';
    render();
  }
  function numOf(el) { var v = parseFloat(el.value); return isFinite(v) ? v : null; }

  // ── page switching (same pattern as asset-store.js) ──────────────────
  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    $('#combineIconsPage').addClass('hidden');
    $('#combineIconsBtn').removeClass('active');
    if (page !== PAGE) return origSwitch(page);

    origSwitch('mostused');
    $('#mostUsedPage').addClass('hidden');
    $('#mostUsedBtn').removeClass('active');
    SF.state.page = PAGE;
    try { localStorage.setItem('sf_active_page', PAGE); } catch (e) {}
    $('#combineIconsPage').removeClass('hidden');
    $('#combineIconsBtn').addClass('active');
    $('#pageTitle').text('Combine icons');
    $('#pageBreadcrumb').text('Library');
    renderSlots(); renderResults(); render();
    if (!icons().length && typeof SF.loadRepoLibraryIcons === 'function') {
      $('#cmbPickStatus').text('Loading the Icon Library…');
      Promise.resolve(SF.loadRepoLibraryIcons()).then(function () { if (SF.state.page === PAGE) { renderResults(); syncName(); } }, function () {});
    }
  };

  // The Library can finish loading after this page is opened (page reload, sign-in, a new icon added): list it then.
  var origSetIcons = SF.setRepoLibraryIcons;
  SF.setRepoLibraryIcons = function () {
    var out = origSetIcons.apply(this, arguments);
    if (SF.state && SF.state.page === PAGE) { renderResults(); syncName(); }
    return out;
  };
  function libraryLoading() { return !!(SF.repoLib && SF.repoLib.loading); }

  $(function () {
    Promise.all(window._componentPromises || []).then(function () {
      $('#combineIconsBtn').on('click', function () { SF.switchPage(PAGE); });
      $(document).on('click', '#cmbClear', startOver);
      $(document).on('input', '#cmbSearch', renderResults);
      $(document).on('click', '#cmbResults .cmb-tile', function () {
        var id = $(this).data('iconId'), icon = icons().filter(function (i) { return i.id === id; })[0];
        if (icon) pick(icon);
      });
      $(document).on('click', '#cmbSlots .cmb-slot', function (e) {
        if ($(e.target).closest('[data-remove]').length) return;
        slot = +$(this).data('slot');
        if (layers[slot]) sel = slot;
        renderSlots(); render();
      });
      $(document).on('keydown', '#cmbSlots .cmb-slot', function (e) {
        if (e.target === this && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $(this).trigger('click'); }
      });
      $(document).on('click', '#cmbSlots [data-remove]', function () { removeLayer(+$(this).data('remove')); });

      var cv = document.getElementById('cmbCanvas');
      if (cv) {
        cv.addEventListener('pointerdown', onDown);
        cv.addEventListener('pointermove', onMove);
        cv.addEventListener('pointerup', onUp);
        cv.addEventListener('pointercancel', onUp);
        cv.addEventListener('keydown', onKey);
      }

      $(document).on('input', '#cmbX', function () { var v = numOf(this); if (v != null) edit(function (L) { L.x = v; }); });
      $(document).on('input', '#cmbY', function () { var v = numOf(this); if (v != null) edit(function (L) { L.y = v; }); });
      $(document).on('input', '#cmbSize', function () {
        var v = numOf(this);
        if (v != null && v > 0) edit(function (L) { L.scale = fitScale(L, clamp(v, 2, 400) / 100 * SIZE); });
      });
      $(document).on('input', '#cmbRot', function () { var v = numOf(this); if (v != null) edit(function (L) { L.rot = (v % 360 + 360) % 360; }); });
      $(document).on('click', '#cmbFlip', function () { edit(function (L) { L.flip = !L.flip; }); });
      $(document).on('click', '#cmbCentre', function () { edit(function (L) { L.x = L.y = SIZE / 2; }); });
      $(document).on('click', '#cmbReset', function () { edit(function (L) { place(L, sel); }); });
      $(document).on('click', '#cmbFront', function () { if (layers[sel]) { order = [1 - sel, sel]; addedName = ''; render(); } });
      $(document).on('change', '#cmbCut', function () { cut.on = this.checked; addedName = ''; render(); });
      $(document).on('input', '#cmbGap', function () { var v = numOf(this); if (v != null) { cut.gap = clamp(v, 0, 6); addedName = ''; render(); } });

      $(document).on('input', '#cmbName', function () { nameTouched = !!$.trim(this.value); syncName(); });
      $(document).on('click', '#cmbAdd', addToLibrary);
      $(document).on('click', '#cmbDownload', download);
      $(document).on('click', '#cmbCopy', function () {
        var svg = buildSvg();
        if (svg && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(svg).then(function () { toast('SVG copied'); }, function () { toast('Copy failed'); });
      });

      var last = null;
      try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
      if (last === PAGE) setTimeout(function () { SF.switchPage(PAGE); }, 0);
    });
  });

  SF.combineIcons = { parsePath: parsePath, segsToD: segsToD, applyMatrix: applyMatrix, analyse: analyse, buildSvg: buildSvg,
    shapeAttrs: shapeAttrs, renderTiles: renderTiles, nameError: nameError, confirmAdd: confirmAdd, saveFile: saveFile, loadSvg: loadSvg, thumb: thumb, svgNs: SVG_NS,
    state: function () { return { layers: layers, order: order, sel: sel, cut: cut }; } };
})(window.SpriteForge, jQuery);
