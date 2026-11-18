/**
 * SpriteForge - Icon Library "Edit in studio" (opened from the icon preview panel)
 *
 * - Customizer: colour (CRM swatches, original colours or any hex), stroke width, size, non-scaling stroke
 * - Preview: the icon over its own grid; "Paths" colours every element and marks where each line starts and ends
 * - Source: the icon's SVG, each element in the colour it has in the preview (hover either side to find it,
 *   click to pin); Edit turns it into a text editor and the preview follows every change
 * - Code: the final SVG (with the customizer applied) and the <crmutil-icon> markup
 * - Colors: every colour the source uses; change one to recolour it everywhere
 * - Tools (above the preview): Edit points, Select / move, Pen, Add point, Delete point, Convert point,
 *   Rectangle, Ellipse, Line, Delete path. Every change is written into the Source (one undo step each).
 * - Add to library: save the edited Source as a new icon, or replace the drawing of the icon that was opened
 *
 * Stroke width is in units of a 24-unit grid (like Lucide), scaled to the icon's viewBox; with non-scaling stroke it
 * is in screen pixels instead. Fill-only icons have no lines, so for them it adds an outline in the element's own
 * colour (a bolder icon); white cut-outs are left alone.
 */
(function (SF, $) {
  'use strict';

  var P = SF.libPreview;
  if (!P) return;

  var SHAPES = 'path,circle,ellipse,rect,line,polyline,polygon';
  var PALETTE = ['#3B82F6', '#A855F7', '#EC4899', '#F43F5E', '#F97316', '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#6366F1'];
  var studio = {
    colorKey: 'black', color: '#313949', touched: false, stroke: null, size: 32, nonScaling: false,
    grid: true, paths: true, tab: 'source', editing: false, iconId: null, source: '', original: '', error: '', pin: -1, last: null, tool: 'edit'
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toast(m) { if (SF.showToast) SF.showToast(m); }
  function clean(svg) { return String(svg || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, ''); }
  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    var err = doc.getElementsByTagName('parsererror')[0];
    return err ? { error: (err.textContent || 'Not valid SVG').split('\n').filter(Boolean)[0] } : { doc: doc };
  }

  // ── source formatting: one element per line, root attributes one per line (like Lucide's source view) ──
  // html: wrap each shape element in a span coloured like its path in the preview (same document order).
  function formatSvg(text, html) {
    var parsed = parseXml(text);
    if (parsed.error) return html ? esc(text) : text;
    var n = 0, out = [];
    var t = function (s) { return html ? esc(s) : s; };
    var xt = function (s) { return t(s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')); }; // text content
    function attrs(el, parentNs, multi, pad) {
      var list = [];
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        if (a.name === 'xmlns' && a.value === parentNs) continue; // repeated namespace on inner elements
        list.push(a.name + '="' + a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"');
      }
      if (!list.length) return '';
      return multi ? '\n' + list.map(function (x) { return pad + '  ' + t(x); }).join('\n') + '\n' + pad : ' ' + t(list.join(' '));
    }
    function walk(el, depth, parentNs) {
      var pad = new Array(depth + 1).join('  ');
      var kids = [].filter.call(el.childNodes, function (c) { return c.nodeType === 1 || ((c.nodeType === 3 || c.nodeType === 4) && c.nodeValue.trim()); });
      var shape = el.matches && el.matches(SHAPES);
      var open = pad + t('<' + el.nodeName) + attrs(el, parentNs, depth === 0, pad);
      var i0 = n;
      if (shape) n++;
      var line;
      if (!kids.length) line = open + t((depth === 0 ? '' : ' ') + '/>');
      else if (kids.length === 1 && kids[0].nodeType !== 1) line = open + t('>') + xt(kids[0].nodeValue.trim()) + t('</' + el.nodeName + '>');
      else {
        out.push(open + t('>'));
        kids.forEach(function (c) { if (c.nodeType === 1) walk(c, depth + 1, el.namespaceURI); else out.push(pad + '  ' + xt(c.nodeValue.trim())); });
        out.push(pad + t('</' + el.nodeName + '>'));
        return;
      }
      if (shape && html) line = pad + '<span class="lps-src-el" data-i="' + i0 + '" style="--c:' + PALETTE[i0 % PALETTE.length] + '">' + line.slice(pad.length) + '</span>';
      out.push(line);
    }
    walk(parsed.doc.documentElement, 0, '');
    return out.join('\n');
  }

  // ── colours used by the source ────────────────────────────────────────────
  var COLOR_RE = /\b(fill|stroke|stop-color|color|flood-color)(\s*=\s*["']|\s*:\s*)(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|currentColor|black|white)/g;
  function sourceColors(text) {
    var seen = {}, list = [], m;
    COLOR_RE.lastIndex = 0;
    while ((m = COLOR_RE.exec(text)) !== null) {
      var v = m[3], k = v.toLowerCase().replace(/\s+/g, '');
      if (!seen[k]) { seen[k] = { value: v, key: k, props: {}, count: 0 }; list.push(seen[k]); }
      seen[k].props[m[1]] = true; seen[k].count++;
    }
    return list;
  }
  function toHex(v) {
    v = String(v).trim().toLowerCase();
    if (v === 'black') return '#000000';
    if (v === 'white') return '#ffffff';
    var m = /^#([0-9a-f]{3})$/.exec(v);
    if (m) return '#' + m[1].split('').map(function (c) { return c + c; }).join('');
    if (/^#[0-9a-f]{6}/.test(v)) return v.slice(0, 7);
    m = /^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/.exec(v);
    if (m) return '#' + [m[1], m[2], m[3]].map(function (x) { return ('0' + (+x).toString(16)).slice(-2); }).join('');
    return '';
  }
  function replaceColor(text, from, to) {
    var k = from.toLowerCase().replace(/\s+/g, '');
    COLOR_RE.lastIndex = 0;
    return text.replace(COLOR_RE, function (all, prop, sep, val) { return val.toLowerCase().replace(/\s+/g, '') === k ? prop + sep + to : all; });
  }

  // ── the customized svg ────────────────────────────────────────────────────
  /** { svg, mode: 'stroke' | 'fill' | 'mixed', vb } for the current source + settings at `size` px. */
  function build(size) {
    var svg = clean(studio.source);
    if (studio.colorKey !== 'original') svg = P.coloredSvg(svg, { hex: studio.color });
    // Measured in a shadow root: the icon's <style> (and the colour rule) must never reach the page.
    var host = P.isolatedHost(svg, 200);
    var el = host.root.querySelector('svg'), mode = 'fill', vb = [0, 0, 24, 24];
    try {
      if (el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.width) { var b = el.viewBox.baseVal; vb = [b.x, b.y, b.width, b.height]; }
      var unit = Math.max(vb[2], vb[3]) / 24, nStroke = 0, nFill = 0;
      // Read every computed style first (writing in between would make the browser recompute each time).
      var info = [].map.call(el.querySelectorAll(SHAPES), function (s) { var cs = getComputedStyle(s); return { s: s, stroke: cs.stroke, fill: cs.fill }; });
      info.forEach(function (x) {
        var stroked = x.stroke && x.stroke !== 'none';
        var filled = x.fill && x.fill !== 'none' && !P.isWhite(x.fill.replace(/\s/g, ''));
        if (stroked) nStroke++; else if (filled) nFill++;
        if (studio.stroke == null || (!stroked && !filled)) return;
        var w = studio.nonScaling ? studio.stroke : studio.stroke * unit;
        var style = (x.s.getAttribute('style') || '') + ';stroke-width:' + (+w.toFixed(3)) + (studio.nonScaling ? ';vector-effect:non-scaling-stroke' : '');
        if (!stroked) style += ';stroke:' + x.fill + ';stroke-linejoin:round;stroke-linecap:round';
        x.s.setAttribute('style', style.replace(/^;/, ''));
      });
      mode = nStroke && nFill ? 'mixed' : nStroke ? 'stroke' : 'fill';
      el.setAttribute('width', size);
      el.setAttribute('height', size);
      svg = new XMLSerializer().serializeToString(el);
    } catch (e) { /* keep the svg as it is */ }
    host.remove();
    return { svg: svg, mode: mode, vb: vb };
  }
  function scalable(svg) {
    return svg.replace(/<svg\b([^>]*)>/i, function (m, a) { return '<svg' + a.replace(/\s(width|height)="[^"]*"/g, '') + ' class="lps-art" preserveAspectRatio="xMidYMid meet">'; });
  }

  function gridSvg(vb) {
    var w = vb[2], h = vb[3], step = Math.max(w, h) > 64 ? Math.ceil(Math.max(w, h) / 32) : 1, lines = '';
    for (var x = 0; x <= w + 1e-6; x += step) lines += 'M' + (vb[0] + x) + ' ' + vb[1] + 'v' + h;
    for (var y = 0; y <= h + 1e-6; y += step) lines += 'M' + vb[0] + ' ' + (vb[1] + y) + 'h' + w;
    return '<svg class="lps-grid" viewBox="' + vb.join(' ') + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
      '<path d="' + lines + '" fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>';
  }

  // Paths view: colour each element of the live preview and mark where open lines start and end.
  function decorate(art, vb) {
    var shapes = [].slice.call(art.querySelectorAll(SHAPES));
    var info = shapes.map(function (s) { var cs = getComputedStyle(s); return { stroke: cs.stroke !== 'none', fill: cs.fill !== 'none' && !P.isWhite(cs.fill.replace(/\s/g, '')) }; });
    var ns = art.namespaceURI, marks = document.createElementNS(ns, 'g'), r = Math.max(vb[2], vb[3]) * 0.018;
    marks.setAttribute('class', 'lps-marks');
    var toArt = art.getScreenCTM() && art.getScreenCTM().inverse();
    shapes.forEach(function (s, i) {
      s.classList.add('lps-el');
      if (info[i].stroke) s.classList.add('lps-el-stroke');
      if (info[i].fill) s.classList.add('lps-el-fill');
      s.setAttribute('data-i', i);
      s.style.setProperty('--c', PALETTE[i % PALETTE.length]);
      if (!studio.paths || !toArt || typeof s.getTotalLength !== 'function') return;
      try {
        var len = s.getTotalLength(), m = toArt.multiply(s.getScreenCTM());
        if (!(len > 0)) return;
        var a = s.getPointAtLength(0).matrixTransform(m), b = s.getPointAtLength(len).matrixTransform(m);
        var pts = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < r ? [a] : [a, b]; // closed shapes: one mark
        pts.forEach(function (p) {
          var c = document.createElementNS(ns, 'circle');
          c.setAttribute('cx', +p.x.toFixed(3)); c.setAttribute('cy', +p.y.toFixed(3)); c.setAttribute('r', +r.toFixed(3));
          c.setAttribute('data-i', i); c.setAttribute('class', 'lps-mark');
          c.style.setProperty('--c', PALETTE[i % PALETTE.length]);
          marks.appendChild(c);
        });
      } catch (e) { /* element without geometry */ }
    });
    art.appendChild(marks);
  }


  // ── Point editing: click a path (Paths view) to pin it, then drag its points ───────────────
  // Path data is read into absolute segments; a dragged point is written back into the Source on release.
  var ROUND = function (n) { return +(+n).toFixed(3); };
  function parsePath(d) {
    var str = String(d || ''), pos = 0, segs = [], cx = 0, cy = 0, sx = 0, sy = 0, cmd = '';
    var ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
    var NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
    var skip = function () { while (pos < str.length && /[\s,]/.test(str[pos])) pos++; };
    var number = function () { skip(); NUM.lastIndex = pos; var m = NUM.exec(str); if (!m) return NaN; pos = NUM.lastIndex; return parseFloat(m[0]); };
    var flag = function () { skip(); var ch = str[pos]; if (ch !== '0' && ch !== '1') return NaN; pos++; return +ch; }; // arc flags may be written "011"
    for (;;) {
      skip();
      if (pos >= str.length) break;
      if (/[a-zA-Z]/.test(str[pos])) cmd = str[pos++];
      else if (!cmd) return null;
      var up = cmd.toUpperCase(), rel = cmd !== up, n = ARGS[up];
      if (n === undefined) return null;
      if (up === 'Z') { segs.push({ c: 'Z', p: [] }); cx = sx; cy = sy; cmd = ''; continue; }
      var a = [];
      for (var k = 0; k < n; k++) a.push(up === 'A' && (k === 3 || k === 4) ? flag() : number());
      if (a.some(isNaN)) return null;
      var ox = rel ? cx : 0, oy = rel ? cy : 0, seg;
      if (up === 'H') seg = { c: 'L', p: [a[0] + ox, cy] };
      else if (up === 'V') seg = { c: 'L', p: [cx, a[0] + oy] };
      else if (up === 'A') seg = { c: 'A', p: [a[0], a[1], a[2], a[3], a[4], a[5] + ox, a[6] + oy] };
      else seg = { c: up, p: a.map(function (v, j) { return v + (j % 2 ? oy : ox); }) };
      segs.push(seg);
      cx = seg.p[seg.p.length - 2]; cy = seg.p[seg.p.length - 1];
      if (up === 'M') { sx = cx; sy = cy; cmd = rel ? 'l' : 'L'; } // extra pairs after M are lines
    }
    return segs;
  }
  function pathString(segs) {
    return segs.map(function (g) { return g.c + (g.p.length ? g.p.map(ROUND).join(' ') : ''); }).join(' ');
  }
  // An elliptical arc as cubic curves: [[c1x, c1y, c2x, c2y, x, y], …] (one per quarter turn at most).
  function arcToCubics(x1, y1, rx, ry, angle, large, sweep, x2, y2) {
    if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
    var phi = angle * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, xp = cp * dx + sp * dy, yp = -sp * dx + cp * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    var l = xp * xp / (rx * rx) + yp * yp / (ry * ry);
    if (l > 1) { rx *= Math.sqrt(l); ry *= Math.sqrt(l); }
    var den = rx * rx * yp * yp + ry * ry * xp * xp;
    var k = (!!large === !!sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / den));
    var cxp = k * rx * yp / ry, cyp = -k * ry * xp / rx;
    var cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    var ang = function (ux, uy, vx, vy) { return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); };
    var ux = (xp - cxp) / rx, uy = (yp - cyp) / ry, t1 = ang(1, 0, ux, uy), dt = ang(ux, uy, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
    var n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), d = dt / n, t = 4 / 3 * Math.tan(d / 4), out = [];
    var at = function (a) { // point on the ellipse + its derivative
      var c = Math.cos(a), si = Math.sin(a);
      return [cx + rx * c * cp - ry * si * sp, cy + rx * c * sp + ry * si * cp, -rx * si * cp - ry * c * sp, -rx * si * sp + ry * c * cp];
    };
    for (var i = 0; i < n; i++) {
      var a = at(t1 + i * d), b = at(t1 + (i + 1) * d);
      out.push([a[0] + t * a[2], a[1] + t * a[3], b[0] - t * b[2], b[1] - t * b[3], b[0], b[1]]);
    }
    out[n - 1][4] = x2; out[n - 1][5] = y2;
    return out;
  }
  // The same path with M, L, C and Z only (S, Q, T and A become cubic curves), and every closed shape ending on its
  // start point — so any segment can be split, joined or reshaped the same way.
  function normalizeSegs(segs) {
    var out = [], cx = 0, cy = 0, sx = 0, sy = 0, lastC = null, lastQ = null;
    segs.forEach(function (g) {
      var p = g.p, c = null, q = null;
      if (g.c === 'M') { out.push({ c: 'M', p: [p[0], p[1]] }); sx = p[0]; sy = p[1]; }
      else if (g.c === 'L') out.push({ c: 'L', p: [p[0], p[1]] });
      else if (g.c === 'C') { out.push({ c: 'C', p: p.slice() }); c = [p[2], p[3]]; }
      else if (g.c === 'S') { var r = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy]; out.push({ c: 'C', p: [r[0], r[1], p[0], p[1], p[2], p[3]] }); c = [p[0], p[1]]; }
      else if (g.c === 'Q' || g.c === 'T') {
        q = g.c === 'Q' ? [p[0], p[1]] : (lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy]);
        var ex = p[p.length - 2], ey = p[p.length - 1];
        out.push({ c: 'C', p: [cx + 2 / 3 * (q[0] - cx), cy + 2 / 3 * (q[1] - cy), ex + 2 / 3 * (q[0] - ex), ey + 2 / 3 * (q[1] - ey), ex, ey] });
      }
      else if (g.c === 'A') arcToCubics(cx, cy, p[0], p[1], p[2], p[3], p[4], p[5], p[6]).forEach(function (k) { out.push({ c: 'C', p: k }); });
      else if (g.c === 'Z') {
        if (Math.abs(cx - sx) > 1e-6 || Math.abs(cy - sy) > 1e-6) out.push({ c: 'L', p: [sx, sy] });
        out.push({ c: 'Z', p: [] });
      }
      lastC = c; lastQ = q;
      if (g.c === 'Z') { cx = sx; cy = sy; } else { var e = out[out.length - 1].p; cx = e[e.length - 2]; cy = e[e.length - 1]; }
    });
    return out;
  }
  var endOf = function (g) { return [g.p[g.p.length - 2], g.p[g.p.length - 1]]; };
  var near = function (a, b) { return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6; };
  // The subpath that holds segment i of a normalized path: { m, last (last drawing segment), closed }.
  function subpath(segs, i) {
    var m = i; while (m > 0 && segs[m].c !== 'M') m--;
    var k = m + 1; while (k < segs.length && segs[k].c !== 'M' && segs[k].c !== 'Z') k++;
    return { m: m, last: k - 1, closed: !!segs[k] && segs[k].c === 'Z' };
  }
  function lineIfFlat(segs, i) { // a curve whose handles sit on its ends is a line
    var g = segs[i];
    if (g && g.c === 'C' && near([g.p[0], g.p[1]], endOf(segs[i - 1])) && near([g.p[2], g.p[3]], endOf(g))) segs[i] = { c: 'L', p: endOf(g) };
  }
  // Point on segment i at t, for L and C.
  function pointOn(segs, i, t) {
    var a = endOf(segs[i - 1]), g = segs[i], u = 1 - t;
    if (g.c === 'L') return [a[0] + (g.p[0] - a[0]) * t, a[1] + (g.p[1] - a[1]) * t];
    return [u * u * u * a[0] + 3 * u * u * t * g.p[0] + 3 * u * t * t * g.p[2] + t * t * t * g.p[4],
      u * u * u * a[1] + 3 * u * u * t * g.p[1] + 3 * u * t * t * g.p[3] + t * t * t * g.p[5]];
  }
  // Add point: the place on the path closest to (x, y) → { i, t, dist }.
  function nearestOnPath(segs, x, y) {
    var best = null;
    segs.forEach(function (g, i) {
      if (g.c !== 'L' && g.c !== 'C') return;
      for (var k = 0; k <= 40; k++) {
        var t = k / 40, q = pointOn(segs, i, t), d = Math.hypot(q[0] - x, q[1] - y);
        if (!best || d < best.dist) best = { i: i, t: t, dist: d };
      }
    });
    if (best) for (var step = 1 / 80, n = 0; n < 12; n++, step /= 2) { // refine around the best sample
      [best.t - step, best.t + step].forEach(function (t) {
        if (t <= 0 || t >= 1) return;
        var q = pointOn(segs, best.i, t), d = Math.hypot(q[0] - x, q[1] - y);
        if (d < best.dist) { best.dist = d; best.t = t; }
      });
    }
    return best;
  }
  function splitSeg(segs, i, t) {
    var a = endOf(segs[i - 1]), g = segs[i];
    t = Math.min(0.98, Math.max(0.02, t));
    if (g.c === 'L') { segs.splice(i, 1, { c: 'L', p: pointOn(segs, i, t) }, { c: 'L', p: g.p.slice() }); return; }
    var mid = function (p, q) { return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; };
    var c1 = [g.p[0], g.p[1]], c2 = [g.p[2], g.p[3]], e = [g.p[4], g.p[5]];
    var ab = mid(a, c1), bc = mid(c1, c2), cd = mid(c2, e), abc = mid(ab, bc), bcd = mid(bc, cd), x = mid(abc, bcd);
    segs.splice(i, 1, { c: 'C', p: ab.concat(abc, x) }, { c: 'C', p: bcd.concat(cd, e) });
  }
  // Delete point: remove the anchor at the end of segment i; its two neighbours are joined. false = nothing left.
  function removeAnchor(segs, i) {
    var sp = subpath(segs, i), count = sp.last - sp.m + 1 - (sp.closed ? 1 : 0);
    if (count <= 2) { segs.splice(sp.m, sp.last - sp.m + 1 + (sp.closed ? 1 : 0)); return segs.some(function (g) { return g.c !== 'M' && g.c !== 'Z'; }); }
    if (i === sp.m) { // the start point: the shape now starts at the next point
      var start = endOf(segs[i + 1]);
      if (sp.closed) { var l = segs[sp.last].p; l[l.length - 2] = start[0]; l[l.length - 1] = start[1]; }
      segs[i].p = start;
      segs.splice(i + 1, 1);
      return true;
    }
    var g = segs[i], next = i < sp.last ? segs[i + 1] : null;
    if (!next) { segs.splice(i, 1); return true; } // the end of an open line
    var a = endOf(segs[i - 1]), e = endOf(next);
    var joined = g.c === 'C' || next.c === 'C'
      ? { c: 'C', p: (g.c === 'C' ? [g.p[0], g.p[1]] : a).concat(next.c === 'C' ? [next.p[2], next.p[3]] : e, e) } : { c: 'L', p: e };
    segs.splice(i, 2, joined);
    return true;
  }
  // Convert point: a smooth point becomes a corner (handles pulled in), a corner becomes smooth (handles pushed out).
  function convertAnchor(segs, i) {
    var sp = subpath(segs, i), A = endOf(segs[i]);
    var inI = i === sp.m ? (sp.closed ? sp.last : -1) : i;
    var outI = i === sp.m ? i + 1 : (i < sp.last ? i + 1 : (sp.closed ? sp.m + 1 : -1));
    if (outI > sp.last) outI = -1;
    var gin = inI > 0 ? segs[inI] : null, gout = outI > 0 ? segs[outI] : null;
    var smooth = (gin && gin.c === 'C' && !near([gin.p[2], gin.p[3]], A)) || (gout && gout.c === 'C' && !near([gout.p[0], gout.p[1]], A));
    if (smooth) {
      if (gin && gin.c === 'C') { gin.p[2] = A[0]; gin.p[3] = A[1]; }
      if (gout && gout.c === 'C') { gout.p[0] = A[0]; gout.p[1] = A[1]; }
      // the higher index first: turning one into a line does not move the other
      [inI, outI].filter(function (k) { return k > 0; }).sort(function (a, b) { return b - a; }).forEach(function (k) { lineIfFlat(segs, k); });
      return;
    }
    var prev = gin ? endOf(segs[inI - 1]) : null, nextPt = gout ? endOf(gout) : null;
    var from = prev || A, to = nextPt || A, len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    var dx = (to[0] - from[0]) / len, dy = (to[1] - from[1]) / len;
    if (gin) {
      var li = Math.hypot(A[0] - prev[0], A[1] - prev[1]) / 3, c1 = gin.c === 'C' ? [gin.p[0], gin.p[1]] : prev;
      segs[inI] = { c: 'C', p: [c1[0], c1[1], A[0] - dx * li, A[1] - dy * li, A[0], A[1]] };
    }
    if (gout) {
      var lo = Math.hypot(nextPt[0] - A[0], nextPt[1] - A[1]) / 3, c2 = gout.c === 'C' ? [gout.p[2], gout.p[3]] : nextPt;
      segs[outI] = { c: 'C', p: [A[0] + dx * lo, A[1] + dy * lo, c2[0], c2[1], nextPt[0], nextPt[1]] };
    }
  }
  // The tools that reshape a path work on its normalized form.
  var RESHAPE = { add: true, del: true, convert: true };

  // Draggable points of one element: [{ x, y, kind: 'anchor' | 'ctrl', move(x, y), links: [[x,y] of the anchor] }] + attrs()
  // normalized: read a path as M / L / C / Z only (see normalizeSegs).
  function editModel(el, normalized) {
    var tag = el.tagName.toLowerCase(), num = function (a) { return parseFloat(el.getAttribute(a)) || 0; }, pts = [];
    if (tag === 'path') {
      var segs = parsePath(el.getAttribute('d'));
      if (!segs) return null;
      if (normalized) segs = normalizeSegs(segs);
      segs.forEach(function (g, si) {
        var P = g.p, end = P.length - 2;
        var at = function (j, kind) { pts.push({ kind: kind, get: function () { return [P[j], P[j + 1]]; }, set: function (x, y) { P[j] = x; P[j + 1] = y; }, seg: si, j: j }); };
        if (g.c === 'C') { at(0, 'ctrl'); at(2, 'ctrl'); }
        if (g.c === 'S' || g.c === 'Q') at(0, 'ctrl');
        if (g.c !== 'Z') at(end, 'anchor');
      });
      // An anchor drags the control points that belong to it (the curve in and the next curve out) along.
      pts.forEach(function (p) {
        if (p.kind !== 'anchor') return;
        var g = segs[p.seg], next = segs[p.seg + 1], tied = [];
        if (g.c === 'C') tied.push([g.p, 2]); if (g.c === 'S') tied.push([g.p, 0]);
        if (next && next.c === 'C') tied.push([next.p, 0]);
        p.tied = tied;
      });
      // A closed shape that ends on its start point: both anchors are one point (one handle, moved together).
      var anchors = pts.filter(function (p) { return p.kind === 'anchor'; });
      anchors.forEach(function (p) {
        if (segs[p.seg].c !== 'M') return;
        var k = p.seg + 1;
        while (k < segs.length && segs[k].c !== 'M' && segs[k].c !== 'Z') k++;
        var last = anchors.filter(function (q) { return q.seg === k - 1 && q !== p; })[0];
        if (!last || segs[k] === undefined || segs[k].c !== 'Z') return;
        var a = p.get(), b = last.get();
        if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) { p.twin = last; last.hidden = true; }
      });
      pts.forEach(function (p) { // a control point's line goes to the anchor it shapes
        if (p.kind !== 'ctrl') return;
        var g = segs[p.seg], prev = segs[p.seg - 1];
        p.line = (g.c === 'C' && p.j === 0 && prev) ? function () { return [prev.p[prev.p.length - 2], prev.p[prev.p.length - 1]]; }
          : function () { return [g.p[g.p.length - 2], g.p[g.p.length - 1]]; };
      });
      return { pts: pts, segs: segs, attrs: function () { return { d: pathString(segs) }; } };
    }
    var pair = function (ax, ay) { var v = { x: num(ax), y: num(ay) }; pts.push({ kind: 'anchor', get: function () { return [v.x, v.y]; }, set: function (x, y) { v.x = x; v.y = y; } }); return v; };
    if (tag === 'line') {
      var a = pair('x1', 'y1'), b = pair('x2', 'y2');
      return { pts: pts, attrs: function () { return { x1: ROUND(a.x), y1: ROUND(a.y), x2: ROUND(b.x), y2: ROUND(b.y) }; } };
    }
    if (tag === 'circle' || tag === 'ellipse') {
      var c = pair('cx', 'cy');
      return { pts: pts, attrs: function () { return { cx: ROUND(c.x), cy: ROUND(c.y) }; } };
    }
    if (tag === 'rect') {
      var x = num('x'), y = num('y'), w = num('width'), h = num('height');
      var tl = { x: x, y: y }, br = { x: x + w, y: y + h };
      pts.push({ kind: 'anchor', get: function () { return [tl.x, tl.y]; }, set: function (nx, ny) { tl.x = nx; tl.y = ny; } });
      pts.push({ kind: 'anchor', get: function () { return [br.x, br.y]; }, set: function (nx, ny) { br.x = nx; br.y = ny; } });
      return { pts: pts, attrs: function () {
        return { x: ROUND(Math.min(tl.x, br.x)), y: ROUND(Math.min(tl.y, br.y)), width: ROUND(Math.abs(br.x - tl.x)), height: ROUND(Math.abs(br.y - tl.y)) };
      } };
    }
    if (tag === 'polyline' || tag === 'polygon') {
      var nums = (el.getAttribute('points') || '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [], list = [];
      for (var q = 0; q + 1 < nums.length; q += 2) list.push([+nums[q], +nums[q + 1]]);
      list.forEach(function (v) { pts.push({ kind: 'anchor', get: function () { return v; }, set: function (nx, ny) { v[0] = nx; v[1] = ny; } }); });
      return { pts: pts, attrs: function () { return { points: list.map(function (v) { return ROUND(v[0]) + ',' + ROUND(v[1]); }).join(' ') }; } };
    }
    return null;
  }

  var edit = null; // { el, art, model, drag: { pt, start } }
  // Handles of the pinned element, in the art's own coordinates.
  function drawHandles(root) {
    var art = root && root.querySelector('.lps-art'), old = art && art.querySelector('.lps-handles');
    if (old) old.remove();
    edit = null;
    if (!art || !studio.paths || studio.pin < 0) return;
    var el = art.querySelectorAll(SHAPES)[studio.pin];
    var model = el && editModel(el, !!RESHAPE[studio.tool]);
    if (!model || !model.pts.length) return;
    edit = { el: el, art: art, model: model, drag: null };
    var ns = art.namespaceURI, g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'lps-handles');
    art.appendChild(g);
    placeHandles();
  }
  function toArt(x, y) {
    var m = edit.art.getScreenCTM().inverse().multiply(edit.el.getScreenCTM()), pt = edit.art.createSVGPoint();
    pt.x = x; pt.y = y;
    return pt.matrixTransform(m);
  }
  // Draw the handles once; while dragging only their positions change (a re-created handle would lose the pointer).
  function placeHandles() {
    var g = edit && edit.art.querySelector('.lps-handles');
    if (!g) return;
    var vb = edit.art.viewBox.baseVal, r = Math.max(vb.width, vb.height) * 0.02, ns = edit.art.namespaceURI;
    var set = function (e, attrs) { Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; };
    if (!g.childNodes.length) {
      edit.model.pts.forEach(function (p) {
        if (p.kind === 'ctrl' && p.line) g.appendChild(set(document.createElementNS(ns, 'line'), { 'class': 'lps-handle-line' }));
      });
      edit.model.pts.forEach(function (p, i) {
        g.appendChild(set(document.createElementNS(ns, p.kind === 'ctrl' ? 'rect' : 'circle'),
          { 'class': 'lps-handle' + (p.kind === 'ctrl' ? ' lps-handle-ctrl' : ''), 'data-h': i }));
      });
    }
    var lines = g.querySelectorAll('.lps-handle-line'), li = 0;
    edit.model.pts.forEach(function (p) {
      if (p.kind !== 'ctrl' || !p.line) return;
      var a = toArt.apply(null, p.line()), b = toArt.apply(null, p.get());
      set(lines[li++], { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    });
    edit.model.pts.forEach(function (p, i) {
      var c = toArt.apply(null, p.get()), h = g.querySelector('[data-h="' + i + '"]');
      if (p.hidden) { h.setAttribute('display', 'none'); return; }
      if (p.kind === 'ctrl') set(h, { x: c.x - r * 0.75, y: c.y - r * 0.75, width: r * 1.5, height: r * 1.5 });
      else set(h, { cx: c.x, cy: c.y, r: r });
    });
  }
  function pointerLocal(e) {
    var pt = edit.art.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(edit.el.getScreenCTM().inverse());
  }
  function startDrag(e) {
    var h = e.target.closest && e.target.closest('[data-h]');
    if (!h || !edit) return;
    e.preventDefault(); e.stopPropagation();
    var p = edit.model.pts[+h.getAttribute('data-h')], loc = pointerLocal(e), at = p.get();
    edit.drag = { p: p, dx: at[0] - loc.x, dy: at[1] - loc.y, moved: false, last: at.slice() };
    try { h.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
    // Follow the pointer anywhere on the page until it is released (even outside the preview).
    window.addEventListener('pointermove', moveDrag);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }
  function moveDrag(e) {
    if (!edit || !edit.drag) return;
    try { moveDragNow(e); } catch (err) { console.error('[studio] drag:', err); }
  }
  function moveDragNow(e) {
    var d = edit.drag, loc = pointerLocal(e), nx = loc.x + d.dx, ny = loc.y + d.dy, ox = nx - d.last[0], oy = ny - d.last[1];
    d.p.set(nx, ny);
    (d.p.tied || []).forEach(function (t) { t[0][t[1]] += ox; t[0][t[1] + 1] += oy; }); // its curve handles come along
    if (d.p.twin) { // the closing point of the same shape
      d.p.twin.set(nx, ny);
      (d.p.twin.tied || []).forEach(function (t) { t[0][t[1]] += ox; t[0][t[1] + 1] += oy; });
    }
    d.last = [nx, ny]; d.moved = true;
    var attrs = edit.model.attrs();
    Object.keys(attrs).forEach(function (k) { edit.el.setAttribute(k, attrs[k]); });
    placeHandles();
  }
  function endDrag() {
    window.removeEventListener('pointermove', moveDrag);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    if (!edit || !edit.drag) return;
    var moved = edit.drag.moved, attrs = edit.model.attrs();
    edit.drag = null;
    if (moved) { try { setSourceAttrs(studio.pin, attrs); } catch (err) { console.error('[studio] save point edit:', err); toast('Could not save the change: ' + err.message); } }
  }
  // Write the attributes of element #i into the Source (one undo step), then redraw everything from it.
  function setSourceAttrs(i, attrs) {
    var parsed = parseXml(studio.source);
    if (parsed.error) { toast('The Source is not valid SVG, so the change was not saved'); return; }
    var el = parsed.doc.querySelectorAll(SHAPES)[i];
    if (!el) return;
    pushUndo();
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    studio.source = formatSvg(new XMLSerializer().serializeToString(parsed.doc.documentElement), false);
    studio.error = '';
    render();
    if (studio.editing) $('#lpsEditor').val(studio.source);
  }
  // Change the Source document (one undo step), then redraw everything from it. fn returns false to cancel.
  function mutateSource(fn) {
    var parsed = parseXml(studio.source);
    if (parsed.error) { toast('The Source is not valid SVG, so the change was not saved'); return false; }
    var before = studio.source;
    if (fn(parsed.doc) === false) return false;
    studio.undo = (studio.undo || []).concat([before]).slice(-50);
    studio.source = formatSvg(new XMLSerializer().serializeToString(parsed.doc.documentElement), false);
    studio.error = '';
    render();
    if (studio.editing) $('#lpsEditor').val(studio.source);
    return true;
  }
  function removeSourceEl(i) {
    var ok = mutateSource(function (doc) { var el = doc.querySelectorAll(SHAPES)[i]; if (!el) return false; studio.pin = -1; el.parentNode.removeChild(el); });
    if (ok) toast('Path deleted · Cmd/Ctrl+Z brings it back');
  }
  // A new element looks like the icon's other elements; a line always needs a stroke to be visible.
  var LOOK = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-rule', 'clip-rule', 'class', 'style'];
  function addSourceEl(tag, attrs) {
    var index = -1;
    mutateSource(function (doc) {
      var shapes = doc.querySelectorAll(SHAPES), like = shapes[shapes.length - 1], parent = like ? like.parentNode : doc.documentElement;
      var el = doc.createElementNS(doc.documentElement.namespaceURI, tag);
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
      if (like) LOOK.forEach(function (k) { if (like.hasAttribute(k)) el.setAttribute(k, like.getAttribute(k)); });
      var vb = (studio.last && studio.last.vb) || [0, 0, 24, 24];
      if (tag === 'line' && studio.last && studio.last.mode === 'fill') {
        el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', ROUND(Math.max(vb[2], vb[3]) / 16)); el.setAttribute('stroke-linecap', 'round');
      }
      parent.appendChild(el);
      index = shapes.length;
      studio.pin = index;
    });
    return index;
  }

  // ── Tools ──────────────────────────────────────────────────────────────────
  var TOOLS = [
    { key: 'edit', name: 'Edit points', hot: 'A', tip: 'Click a path, then drag its points and curve handles.',
      icon: '<path d="M5 3l14 8-6 2-2 6z"/>' },
    { key: 'select', name: 'Select / move', hot: 'V', tip: 'Click a path to select it, drag to move it · Delete removes it.',
      icon: '<path d="M5 3l14 8-6 2-2 6z" fill="currentColor"/>' },
    { key: 'pen', name: 'Pen', hot: 'P', tip: 'Click for a corner, click and drag for a curve · click the first point to close · Enter or click the last point again to finish · Esc cancels · Shift keeps 45° steps.',
      icon: '<path d="M12 19l7-7 3 3-7 7z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="M2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/>' },
    { key: 'add', name: 'Add point', hot: '+', tip: 'Click a path to select it, then click on its line to add a point there.',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>' },
    { key: 'del', name: 'Delete point', hot: '-', tip: 'Click a path to select it, then click one of its points to remove it.',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>' },
    { key: 'convert', name: 'Convert point', hot: 'C', tip: 'Click a point to switch it between a corner and a smooth curve · drag the blue handles to shape the curve.',
      icon: '<path d="M4 20L12 5l8 15"/><circle cx="12" cy="5" r="2" fill="currentColor"/>' },
    { key: 'rect', name: 'Rectangle', hot: 'R', tip: 'Drag to draw a rectangle · Shift makes a square.', icon: '<rect x="4" y="5" width="16" height="14" rx="1"/>' },
    { key: 'ellipse', name: 'Ellipse', hot: 'E', tip: 'Drag to draw an ellipse · Shift makes a circle.', icon: '<ellipse cx="12" cy="12" rx="9" ry="7"/>' },
    { key: 'line', name: 'Line', hot: 'L', tip: 'Drag to draw a line · Shift keeps 45° steps.', icon: '<path d="M5 19L19 5"/>' }
  ];
  var DRAWING = { pen: true, rect: true, ellipse: true, line: true };
  var toolOf = function (k) { return TOOLS.filter(function (t) { return t.key === k; })[0] || TOOLS[0]; };
  function toolsHtml() {
    return TOOLS.map(function (t) {
      return '<button type="button" class="lps-tool" data-tool="' + t.key + '" title="' + esc(t.name + ' (' + t.hot + ')') + '" aria-label="' + esc(t.name) + '">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + t.icon + '</svg></button>';
    }).join('') + '<span class="lps-tool-sep"></span>' +
      '<button type="button" class="lps-tool" id="lpsDelPath" title="Delete the selected path (Delete)" aria-label="Delete the selected path">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>';
  }
  function tipText() {
    if (studio.tool === 'edit') return studio.pin >= 0 ? 'Drag the points to change this path · Cmd/Ctrl+Z undoes · click the path again to unpin it.'
      : 'Hover a path to find it in the source · click a path to edit its points.';
    return toolOf(studio.tool).name + ': ' + toolOf(studio.tool).tip;
  }
  function setTool(k) {
    if (!toolOf(k) || studio.tool === k) return;
    cancelDraw();
    studio.tool = k;
    if (k !== 'edit') studio.paths = true; // the tools work on the coloured Paths view
    render();
  }

  // Where new elements go: next to the icon's last element (same group, same transform), else the svg itself.
  function drawParent(art) {
    var shapes = art.querySelectorAll(SHAPES), last = shapes[shapes.length - 1];
    return last && last.parentNode && last.parentNode !== art && art.contains(last.parentNode) ? last.parentNode : art;
  }
  function drawPoint(e, parent) {
    var art = parent.ownerSVGElement || parent, pt = art.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    var q = pt.matrixTransform(parent.getScreenCTM().inverse());
    return [+q.x.toFixed(2), +q.y.toFixed(2)];
  }
  // Shift: keep the direction from `from` in 45° steps.
  function snap45(from, to) {
    var dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy), a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return [+(from[0] + Math.cos(a) * len).toFixed(2), +(from[1] + Math.sin(a) * len).toFixed(2)];
  }

  var draw = null; // pen: { tool, pts: [{ x, y, hin, hout }], cursor, down } · shapes: { tool, a: [x, y], b: [x, y] }
  function penD(pts, closed) {
    var f = function (v) { return ROUND(v[0]) + ' ' + ROUND(v[1]); };
    var seg = function (a, b) { return a.hout || b.hin ? 'C' + f(a.hout || [a.x, a.y]) + ' ' + f(b.hin || [b.x, b.y]) + ' ' + f([b.x, b.y]) : 'L' + f([b.x, b.y]); };
    var d = 'M' + f([pts[0].x, pts[0].y]);
    for (var i = 1; i < pts.length; i++) d += ' ' + seg(pts[i - 1], pts[i]);
    if (closed) d += ' ' + seg(pts[pts.length - 1], pts[0]) + ' Z';
    return d;
  }
  function shapeAttrs(d) {
    var a = d.a, b = d.b;
    if (d.tool === 'line') return { tag: 'line', attrs: { x1: ROUND(a[0]), y1: ROUND(a[1]), x2: ROUND(b[0]), y2: ROUND(b[1]) } };
    var x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    if (d.tool === 'rect') return { tag: 'rect', attrs: { x: ROUND(x), y: ROUND(y), width: ROUND(w), height: ROUND(h) } };
    return { tag: 'ellipse', attrs: { cx: ROUND(x + w / 2), cy: ROUND(y + h / 2), rx: ROUND(w / 2), ry: ROUND(h / 2) } };
  }
  // The drawing in progress, shown over the icon (not part of the Source until it is finished).
  function drawOverlay() {
    var root = stageRoot(), art = root && root.querySelector('.lps-art');
    if (!art) return;
    var old = art.querySelector('.lps-draw');
    if (old) old.remove();
    if (!draw) return;
    var parent = drawParent(art), ns = art.namespaceURI, g = document.createElementNS(ns, 'g');
    var vb = art.viewBox.baseVal, r = Math.max(vb.width, vb.height) * 0.018;
    var mk = function (tag, attrs) { var e = document.createElementNS(ns, tag); Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); g.appendChild(e); return e; };
    g.setAttribute('class', 'lps-draw');
    if (draw.tool === 'pen') {
      var pts = draw.pts, last = pts[pts.length - 1];
      if (pts.length > 1) mk('path', { 'class': 'lps-draw-line', d: penD(pts, false) });
      if (draw.cursor && !draw.down) mk('path', { 'class': 'lps-draw-next', d: penD([last, { x: draw.cursor[0], y: draw.cursor[1] }], false) });
      pts.forEach(function (p, i) {
        [p.hin, p.hout].forEach(function (h) {
          if (!h || i !== pts.length - 1) return;
          mk('line', { 'class': 'lps-handle-line', x1: p.x, y1: p.y, x2: h[0], y2: h[1] });
          mk('rect', { 'class': 'lps-draw-ctrl', x: h[0] - r * 0.6, y: h[1] - r * 0.6, width: r * 1.2, height: r * 1.2 });
        });
        mk('circle', { 'class': 'lps-draw-pt' + (i === 0 && pts.length > 1 ? ' is-first' : ''), cx: p.x, cy: p.y, r: i === 0 && pts.length > 1 ? r * 1.4 : r });
      });
    } else {
      var sh = shapeAttrs(draw);
      mk(sh.tag, Object.assign({ 'class': 'lps-draw-line' }, sh.attrs));
    }
    parent.appendChild(g);
  }
  function cancelDraw() {
    window.removeEventListener('pointermove', drawMove);
    window.removeEventListener('pointerup', drawUp);
    window.removeEventListener('pointercancel', drawUp);
    if (!draw) return;
    draw = null;
    drawOverlay();
  }
  function finishPen(closed) {
    var d = draw;
    cancelDraw();
    if (!d || d.tool !== 'pen' || d.pts.length < 2) return;
    addSourceEl('path', { d: penD(d.pts, closed) });
  }
  function startDraw(e) {
    var root = stageRoot(), art = root && root.querySelector('.lps-art');
    if (!art) return;
    e.preventDefault();
    var parent = drawParent(art), p = drawPoint(e, parent), vb = art.viewBox.baseVal, r = Math.max(vb.width, vb.height) * 0.03;
    if (studio.tool === 'pen') {
      if (!draw) draw = { tool: 'pen', pts: [], parent: parent };
      var pts = draw.pts, last = pts[pts.length - 1];
      if (e.shiftKey && last) p = snap45([last.x, last.y], p);
      if (pts.length > 1 && Math.hypot(p[0] - pts[0].x, p[1] - pts[0].y) < r) return finishPen(true);   // back on the first point: close
      if (last && Math.hypot(p[0] - last.x, p[1] - last.y) < r / 3) return finishPen(false);           // the last point again: finish
      pts.push({ x: p[0], y: p[1], hin: null, hout: null });
      draw.down = true;
    } else {
      draw = { tool: studio.tool, a: p, b: p, parent: parent, down: true };
    }
    window.addEventListener('pointermove', drawMove);
    window.addEventListener('pointerup', drawUp);
    window.addEventListener('pointercancel', drawUp);
    drawOverlay();
  }
  function drawMove(e) {
    if (!draw || !draw.down) return;
    var p = drawPoint(e, draw.parent);
    if (draw.tool === 'pen') { // dragging after a click pulls out the curve handles of that point
      var pt = draw.pts[draw.pts.length - 1];
      if (e.shiftKey) p = snap45([pt.x, pt.y], p);
      if (Math.hypot(p[0] - pt.x, p[1] - pt.y) > 0.05) { pt.hout = p; pt.hin = [+(2 * pt.x - p[0]).toFixed(2), +(2 * pt.y - p[1]).toFixed(2)]; }
    } else {
      if (e.shiftKey && draw.tool === 'line') p = snap45(draw.a, p);
      else if (e.shiftKey) { var m = Math.max(Math.abs(p[0] - draw.a[0]), Math.abs(p[1] - draw.a[1])); p = [draw.a[0] + (p[0] < draw.a[0] ? -m : m), draw.a[1] + (p[1] < draw.a[1] ? -m : m)]; }
      draw.b = p;
    }
    drawOverlay();
  }
  function drawUp() {
    window.removeEventListener('pointermove', drawMove);
    window.removeEventListener('pointerup', drawUp);
    window.removeEventListener('pointercancel', drawUp);
    if (!draw) return;
    draw.down = false;
    if (draw.tool === 'pen') { drawOverlay(); return; }
    var d = draw, sh = shapeAttrs(d);
    draw = null;
    if (Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) < 0.3) { drawOverlay(); return; } // a click, not a drag
    addSourceEl(sh.tag, sh.attrs);
  }

  // Select tool: drag the selected element as a whole.
  function mover(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'path') {
      var segs = parsePath(el.getAttribute('d'));
      if (!segs) return null;
      var base = segs.map(function (g) { return g.p.slice(); });
      return function (dx, dy) {
        segs.forEach(function (g, i) {
          g.p = base[i].map(function (v, j) { return g.c === 'A' ? (j === 5 ? v + dx : j === 6 ? v + dy : v) : v + (j % 2 ? dy : dx); });
        });
        return { d: pathString(segs) };
      };
    }
    var model = editModel(el);
    if (!model) return null;
    var start = model.pts.map(function (p) { return p.get().slice(); });
    return function (dx, dy) {
      model.pts.forEach(function (p, i) { p.set(start[i][0] + dx, start[i][1] + dy); });
      return model.attrs();
    };
  }
  var moving = null;
  function startMove(e) {
    if (!edit) return;
    var mv = mover(edit.el);
    if (!mv) { toast('This element cannot be moved here: edit it in the Source'); return; }
    e.preventDefault();
    moving = { mv: mv, from: pointerLocal(e), attrs: null };
    var g = edit.art.querySelector('.lps-handles');
    if (g) g.setAttribute('display', 'none');
    window.addEventListener('pointermove', moveMove);
    window.addEventListener('pointerup', moveUp);
    window.addEventListener('pointercancel', moveUp);
  }
  function moveMove(e) {
    if (!moving || !edit) return;
    var loc = pointerLocal(e), dx = loc.x - moving.from.x, dy = loc.y - moving.from.y;
    if (!moving.attrs && Math.hypot(dx, dy) < 0.05) return;
    // The element moves with the pointer, so measure from where the drag started in the element's own space.
    moving.attrs = moving.mv(ROUND(dx), ROUND(dy));
    Object.keys(moving.attrs).forEach(function (k) { edit.el.setAttribute(k, moving.attrs[k]); });
  }
  function moveUp() {
    window.removeEventListener('pointermove', moveMove);
    window.removeEventListener('pointerup', moveUp);
    window.removeEventListener('pointercancel', moveUp);
    var m = moving;
    moving = null;
    if (m && m.attrs) setSourceAttrs(studio.pin, m.attrs);
    else if (edit) { var g = edit.art.querySelector('.lps-handles'); if (g) g.removeAttribute('display'); }
  }

  function pinTo(i) {
    studio.pin = i;
    setHot(i);
    drawHandles(stageRoot());
    $('#lpsDelPath').prop('disabled', i < 0);
  }
  // Add / Delete / Convert point on the pinned path.
  function reshape(fn) {
    if (!edit || !edit.model.segs) { toast('This tool works on paths: this element is a ' + (edit ? edit.el.tagName.toLowerCase() : 'shape') + ' (edit it with Edit points)'); return; }
    var segs = edit.model.segs, keep = fn(segs);
    if (keep === false) return removeSourceEl(studio.pin);
    if (keep === null) return;
    setSourceAttrs(studio.pin, { d: pathString(segs) });
  }
  function onStageDown(e) {
    if (e.button) return;
    var tool = studio.tool, h = e.target.closest && e.target.closest('[data-h]'), hit = e.target.closest && e.target.closest('[data-i]');
    var i = hit ? +hit.getAttribute('data-i') : -1;
    if (tool === 'edit') return startDrag(e);
    if (DRAWING[tool]) return startDraw(e);
    if (h && edit) {
      var p = edit.model.pts[+h.getAttribute('data-h')];
      if (tool === 'select' || tool === 'add' || p.kind === 'ctrl') return startDrag(e);
      e.preventDefault();
      if (tool === 'del') return reshape(function (segs) { return removeAnchor(segs, p.seg); });
      return reshape(function (segs) { convertAnchor(segs, p.seg); });
    }
    if (tool === 'select') {
      if (i < 0) { if (studio.pin >= 0) pinTo(-1); return; }
      if (i !== studio.pin) pinTo(i);
      return startMove(e);
    }
    if (i >= 0 && i !== studio.pin) return pinTo(i);
    if (tool !== 'add' || !edit) return;
    e.preventDefault();
    var loc = pointerLocal(e), vb = edit.art.viewBox.baseVal;
    reshape(function (segs) {
      var at = nearestOnPath(segs, loc.x, loc.y);
      if (!at || at.dist > Math.max(vb.width, vb.height) * 0.08) { toast('Click on the line of the selected path'); return null; }
      splitSeg(segs, at.i, at.t);
    });
  }
  function onStageMove(e) {
    if (studio.tool !== 'pen' || !draw || draw.down) return;
    var p = drawPoint(e, draw.parent), last = draw.pts[draw.pts.length - 1];
    draw.cursor = e.shiftKey && last ? snap45([last.x, last.y], p) : p;
    drawOverlay();
  }

  function pushUndo() { studio.undo = (studio.undo || []).concat([studio.source]).slice(-50); }
  function undo() {
    if (!studio.undo || !studio.undo.length) return;
    studio.source = studio.undo.pop();
    studio.error = '';
    render();
    if (studio.editing) $('#lpsEditor').val(studio.source);
  }

  // ── markup ────────────────────────────────────────────────────────────────
  var ICON = {
    reset: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  };
  function ensureStudio() {
    if ($('#libStudio').length) return;
    var sw = '<button type="button" class="lps-original" data-color="original" title="The icon\'s own colours">Original</button>' +
      P.COLORS.map(function (c) { return '<button type="button" class="lpp-swatch" data-color="' + c.key + '" style="--sw:' + c.hex + '" title="' + c.key + ' ' + c.hex + '" aria-label="' + c.key + '"></button>'; }).join('');
    $('body').append(
      '<div class="lps-overlay hidden" id="libStudio" role="dialog" aria-modal="true" aria-labelledby="lpsTitle">' +
        '<div class="lps">' +
          '<aside class="lps-side">' +
            '<div class="lps-side-head"><b>Customizer</b><button class="lpp-close" id="lpsReset" type="button" title="Reset everything" aria-label="Reset">' + ICON.reset + '</button></div>' +
            '<label class="lps-label">Color</label>' +
            '<div class="lps-color"><input type="color" id="lpsColor" aria-label="Custom colour"><input type="text" id="lpsHex" maxlength="7" spellcheck="false" aria-label="Hex colour"></div>' +
            '<div class="lpp-swatches lps-swatches" id="lpsSwatches">' + sw + '</div>' +
            '<label class="lps-label lps-row"><span>Stroke width</span><span id="lpsStrokeVal"></span></label>' +
            '<input type="range" id="lpsStroke" min="0.25" max="4" step="0.25">' +
            '<div class="lps-hint" id="lpsStrokeHint"></div>' +
            '<label class="lps-label lps-row"><span>Size</span><span id="lpsSizeVal"></span></label>' +
            '<input type="range" id="lpsSize" min="12" max="128" step="2">' +
            '<label class="lps-label lps-row lps-toggle"><span>Non-scaling stroke</span><input type="checkbox" id="lpsNonScaling"><i aria-hidden="true"></i></label>' +
            '<div class="lps-hint">Keeps the stroke the same number of pixels at every size.</div>' +
          '</aside>' +
          '<section class="lps-main">' +
            '<div class="lps-head"><span class="lps-title" id="lpsTitle"></span><span class="lps-dim" id="lpsDim"></span>' +
              '<button class="lpp-close" id="lpsClose" type="button" aria-label="Close studio">' + ICON.close + '</button></div>' +
            '<div class="lps-body">' +
              '<div class="lps-col">' +
                '<div class="lps-card lps-preview-card">' +
                  '<div class="lps-card-head"><b>Preview</b><span class="lps-chips">' +
                    '<label class="lps-chip"><input type="checkbox" id="lpsPaths"><span>Paths</span></label>' +
                    '<label class="lps-chip"><input type="checkbox" id="lpsGrid"><span>Grid</span></label></span></div>' +
                  '<div class="lps-tools" id="lpsTools" role="toolbar" aria-label="Drawing tools">' + toolsHtml() + '</div>' +
                  '<div class="lps-canvas" id="lpsCanvas"><div class="lps-stage" id="lpsStage"></div></div>' +
                  '<div class="lps-tip" id="lpsTip">Hover a path to find it in the source · click to pin it.</div>' +
                '</div>' +
                '<div class="lps-card"><div class="lps-card-head"><b>Colors</b><span class="lps-hint" id="lpsColorsHint"></span></div><div class="lps-colors" id="lpsColors"></div></div>' +
                '<div class="lps-sizes" id="lpsSizes"></div>' +
              '</div>' +
              '<div class="lps-card lps-src-card">' +
                '<div class="lps-tabs" role="tablist">' +
                  '<button type="button" role="tab" class="lps-tab" data-tab="source">Source</button>' +
                  '<button type="button" role="tab" class="lps-tab" data-tab="code">Code</button>' +
                  '<span class="lps-tab-actions" id="lpsTabActions"></span></div>' +
                '<div class="lps-error hidden" id="lpsError"></div>' +
                '<pre class="lps-src" id="lpsSrc"></pre>' +
                '<textarea class="lps-editor hidden" id="lpsEditor" spellcheck="false" aria-label="SVG source"></textarea>' +
                '<div class="lps-code hidden" id="lpsCode"></div>' +
              '</div>' +
            '</div>' +
            '<div class="lps-actions">' +
              '<button class="btn btn-primary btn-sm" id="lpsAddLib" type="button" title="Save the Source to the UI library: as a new icon, or in place of this icon">Add to library</button>' +
              '<span class="lps-actions-gap"></span>' +
              '<button class="btn btn-ghost btn-sm" id="lpsCopySvg" type="button">Copy SVG</button>' +
              '<button class="btn btn-ghost btn-sm" id="lpsDownloadSvg" type="button">Download SVG</button>' +
              '<button class="btn btn-ghost btn-sm" id="lpsDownloadPng" type="button">Download PNG</button>' +
            '</div>' +
          '</section>' +
        '</div>' +
        '<div class="lps-dlg hidden" id="lpsAddDlg" role="dialog" aria-modal="true" aria-labelledby="lpsAddTitle">' +
          '<form class="lps-dlg-box" id="lpsAddForm">' +
            '<b id="lpsAddTitle">Add to library</b>' +
            '<div class="lps-hint">Saves the Source (without the customizer colour, stroke width and size) to the UI library sprite. This is a commit to the icon repository.</div>' +
            '<label class="lps-dlg-opt"><input type="radio" name="lpsAddMode" value="new" checked><span>Save as a new icon</span></label>' +
            '<input type="text" class="vf-input lps-dlg-name" id="lpsAddName" maxlength="80" spellcheck="false" autocomplete="off" aria-label="Name of the new icon" placeholder="icon-name">' +
            '<label class="lps-dlg-opt" id="lpsAddReplaceRow"><input type="radio" name="lpsAddMode" value="replace"><span id="lpsAddReplaceText"></span></label>' +
            '<div class="lps-dlg-err hidden" id="lpsAddErr"></div>' +
            '<div class="lps-dlg-actions"><button type="button" class="btn btn-ghost btn-sm" id="lpsAddCancel">Cancel</button>' +
              '<button type="submit" class="btn btn-primary btn-sm" id="lpsAddSave">Save</button></div>' +
          '</form>' +
        '</div>' +
      '</div>');
  }

  // ── render ────────────────────────────────────────────────────────────────
  function render() {
    var icon = P.current();
    if (!icon || !$('#libStudio:not(.hidden)').length) return;
    var out = build(studio.size);
    studio.last = out;
    $('#lpsTitle').text(P.baseName(icon));
    $('#lpsDim').text(studio.size + ' × ' + studio.size + ' px');
    renderCustomizer(out);
    renderStage(out);
    renderSizes(out);
    renderColors();
    renderPanel(out);
  }

  function renderCustomizer(out) {
    var original = studio.colorKey === 'original';
    $('#lpsColor').val(original ? '#313949' : studio.color);
    if (document.activeElement !== $('#lpsHex')[0]) $('#lpsHex').val(original ? '' : studio.color.toUpperCase()).attr('placeholder', original ? 'original' : '');
    $('#lpsSwatches [data-color]').each(function () { $(this).toggleClass('is-active', $(this).data('color') === studio.colorKey); });
    $('#lpsStroke').val(studio.stroke == null ? 2 : studio.stroke);
    $('#lpsStrokeVal').text(studio.stroke == null ? 'original' : studio.stroke + (studio.nonScaling ? 'px' : ''));
    $('#lpsStrokeHint').text(out.mode === 'fill' ? 'This icon is drawn with fills: stroke width adds an outline, so it gets bolder.'
      : out.mode === 'mixed' ? 'Lines get this width; filled parts get an outline of the same width.' : 'Sets the width of the icon\'s lines.');
    $('#lpsSize').val(studio.size); $('#lpsSizeVal').text(studio.size + 'px');
    $('#lpsNonScaling').prop('checked', studio.nonScaling);
    $('#lpsGrid').prop('checked', studio.grid);
    $('#lpsPaths').prop('checked', studio.paths);
    $('#lpsTools [data-tool]').each(function () { var on = $(this).data('tool') === studio.tool; $(this).toggleClass('is-active', on).attr('aria-pressed', on); });
    $('#lpsDelPath').prop('disabled', studio.pin < 0);
  }

  // The live preview sits in the stage's shadow root, so the icon's <style> rules stay inside it.
  var STAGE_CSS =
    ':host{display:block}.wrap{position:absolute;inset:0}.wrap>svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}' +
    '.lps-grid{color:var(--text-tertiary,#9ca3af);opacity:.35;pointer-events:none}' +
    '.lps-paths .lps-el{cursor:pointer;transition:opacity .12s}' +
    '.lps-paths .lps-el-stroke{stroke:var(--c)!important}' +
    '.lps-paths .lps-el-fill{fill:var(--c)!important;fill-opacity:.8}' +
    '.lps-paths .lps-el-stroke.lps-el-fill{fill-opacity:.35}' +
    '.lps-mark{fill:var(--bg-panel,#fff);stroke:var(--c);stroke-width:2;vector-effect:non-scaling-stroke;cursor:pointer}' +
    '.has-hot .lps-el:not(.is-hot),.has-hot .lps-mark:not(.is-hot){opacity:.18}' +
    '.lps-handles .lps-handle{fill:#fff;stroke:#2C83EC;stroke-width:2;vector-effect:non-scaling-stroke;cursor:grab;touch-action:none}' +
    '.lps-handles .lps-handle:hover{fill:#2C83EC}.lps-handles .lps-handle-ctrl{fill:#2C83EC;stroke:#fff}' +
    '.lps-handles .lps-handle-line{stroke:#2C83EC;stroke-width:1;stroke-dasharray:3 2;vector-effect:non-scaling-stroke;pointer-events:none}' +
    '.wrap.is-dragging,.wrap.is-dragging .lps-handle{cursor:grabbing}' +
    '.wrap{touch-action:none}.tool-pen,.tool-rect,.tool-ellipse,.tool-line,.tool-pen .lps-el,.tool-rect .lps-el,.tool-ellipse .lps-el,.tool-line .lps-el{cursor:crosshair}' +
    '.tool-select .lps-el{cursor:move}.tool-add .lps-el{cursor:copy}.tool-del .lps-handle,.tool-convert .lps-handle{cursor:pointer}' +
    '.tool-pen .lps-handles,.tool-rect .lps-handles,.tool-ellipse .lps-handles,.tool-line .lps-handles,.tool-pen .lps-marks,.tool-rect .lps-marks,.tool-ellipse .lps-marks,.tool-line .lps-marks{pointer-events:none}' +
    '.lps-draw{pointer-events:none}.lps-draw-line,.lps-draw-next{fill:none;stroke:#2C83EC;stroke-width:2;vector-effect:non-scaling-stroke}' +
    '.lps-draw-next{stroke-dasharray:4 3;opacity:.7}.lps-draw-pt{fill:#fff;stroke:#2C83EC;stroke-width:2;vector-effect:non-scaling-stroke}' +
    '.lps-draw-pt.is-first{fill:#2C83EC;stroke:#fff}.lps-draw-ctrl{fill:#2C83EC;stroke:#fff;stroke-width:1;vector-effect:non-scaling-stroke}' +
    '.lps-draw .lps-handle-line{stroke:#2C83EC;stroke-width:1;stroke-dasharray:3 2;vector-effect:non-scaling-stroke}';
  function stageRoot() {
    var stage = $('#lpsStage')[0];
    if (!stage) return null;
    if (stage.shadowRoot) return stage.shadowRoot;
    var root = stage.attachShadow({ mode: 'open' });
    // Events inside a shadow root reach the page re-targeted to the stage, so listen here.
    root.addEventListener('mouseover', function (e) { var t = e.target.closest && e.target.closest('[data-i]'); if (t && studio.paths && !DRAWING[studio.tool]) setHot(+t.getAttribute('data-i')); });
    // Edit points: a click pins / unpins a path. The other tools select on pointer down (see onStageDown).
    root.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('[data-i]'); if (t && studio.tool === 'edit') pin(+t.getAttribute('data-i'), true); });
    // Point editing (handles of the pinned element) and the drawing tools
    root.addEventListener('pointerdown', onStageDown);
    root.addEventListener('pointermove', onStageMove);
    return root;
  }

  function renderStage(out) {
    var root = stageRoot();
    if (!root) return;
    root.innerHTML = '<style>' + STAGE_CSS + '</style><div class="wrap tool-' + studio.tool + (studio.paths ? ' lps-paths' : '') + '">' +
      (studio.grid ? gridSvg(out.vb) : '') + scalable(out.svg) + '</div>';
    var art = root.querySelector('.lps-art');
    if (art) decorate(art, out.vb);
    $('#lpsTip').toggleClass('hidden', !studio.paths).text(tipText());
    setHot(studio.pin);
    drawHandles(root);
    drawOverlay(); // a pen drawing in progress survives a redraw
  }

  function renderSizes(out) {
    $('#lpsSizes').html([16, 24, 32, 48, studio.size].filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; }).map(function (px) {
      var svg = px === studio.size ? out.svg : build(px).svg;
      return '<figure class="lps-size' + (px === studio.size ? ' is-current' : '') + '"><img alt="" width="' + px + '" height="' + px + '" src="' + P.dataUri(svg) + '"><figcaption>' + px + '</figcaption></figure>';
    }).join(''));
  }

  function renderColors() {
    var list = sourceColors(studio.source);
    $('#lpsColorsHint').text(studio.colorKey === 'original' ? '' : 'The customizer colour paints over these — choose Original to see them.');
    $('#lpsColors').html(list.length ? list.map(function (c) {
      var hex = toHex(c.value), fixed = c.key === 'currentcolor';
      return '<div class="lps-color-row"><span class="lps-color-props">' + esc(Object.keys(c.props).join(' · ')) + '</span>' +
        (fixed ? '<span class="lps-color-cur" title="Takes the text colour of the page">◐</span>'
          : '<input type="color" data-src-color="' + esc(c.value) + '" value="' + esc(hex || '#000000') + '" aria-label="Change ' + esc(c.value) + '">') +
        '<code>' + esc(c.value) + '</code><span class="lps-color-n">' + c.count + '×</span></div>';
    }).join('') : '<div class="lps-hint">No colours in the source: the icon takes its colour from the CRM class (fill).</div>');
  }

  function renderPanel(out) {
    $('.lps-tab').each(function () { $(this).toggleClass('is-active', $(this).data('tab') === studio.tab).attr('aria-selected', $(this).data('tab') === studio.tab); });
    var src = studio.tab === 'source';
    $('#lpsTabActions').html(src
      ? (studio.editing ? '<button type="button" class="btn btn-primary btn-sm" id="lpsEditDone">Done</button>' : '<button type="button" class="btn btn-ghost btn-sm" id="lpsEdit">Edit</button>') +
        (studio.undo && studio.undo.length ? '<button type="button" class="btn btn-ghost btn-sm" id="lpsUndo" title="Undo the last change (Cmd/Ctrl+Z)">Undo</button>' : '') +
        (studio.source !== studio.original ? '<button type="button" class="btn btn-ghost btn-sm" id="lpsRevert" title="Back to the icon from the library">Revert</button>' : '') +
        '<button type="button" class="lpp-close" id="lpsCopySrc" title="Copy source" aria-label="Copy source">' + ICON.copy + '</button>'
      : '');
    $('#lpsError').toggleClass('hidden', !studio.error).text(studio.error ? 'Not valid SVG — the preview shows the last working version. ' + studio.error : '');
    $('#lpsSrc').toggleClass('hidden', !src || studio.editing);
    $('#lpsEditor').toggleClass('hidden', !src || !studio.editing);
    $('#lpsCode').toggleClass('hidden', src);
    if (src && !studio.editing) $('#lpsSrc').html(formatSvg(studio.source, true));
    if (src && studio.editing && document.activeElement !== $('#lpsEditor')[0]) $('#lpsEditor').val(studio.source);
    if (!src) {
      var icon = P.current(), crm = studio.colorKey !== 'original' && P.COLORS.some(function (c) { return c.key === studio.colorKey; });
      var snippet = crm && studio.stroke == null ? P.code(icon, P.colorOf(studio.colorKey)) : '';
      $('#lpsCode').html(
        (snippet ? '<div class="lps-code-head"><b>CRM markup</b><button type="button" class="lpp-close" data-copy-code="crm" title="Copy">' + ICON.copy + '</button></div><pre class="lps-src lps-pre-sm" id="lpsCodeCrm">' + esc(snippet) + '</pre>'
          : '<div class="lps-hint">' + (crm ? 'A custom stroke width is not available as a CRM class: use the SVG below.' : 'A custom colour is not a CRM class: use the SVG below.') + '</div>') +
        '<div class="lps-code-head"><b>SVG (' + studio.size + 'px)</b><button type="button" class="lpp-close" data-copy-code="svg" title="Copy">' + ICON.copy + '</button></div>' +
        '<pre class="lps-src" id="lpsCodeSvg">' + esc(formatSvg(out.svg, false)) + '</pre>');
    }
  }

  // Highlight one element in both the preview and the source (-1: none).
  function setHot(i) {
    var on = i != null && i >= 0, root = stageRoot(), wrap = root && root.querySelector('.wrap');
    if (wrap) {
      wrap.classList.toggle('has-hot', on);
      [].forEach.call(root.querySelectorAll('[data-i]'), function (el) { el.classList.toggle('is-hot', on && +el.getAttribute('data-i') === i); });
    }
    $('#lpsSrc .lps-src-el').each(function () { $(this).toggleClass('is-hot', on && +$(this).data('i') === i).toggleClass('is-pinned', +$(this).data('i') === studio.pin); });
  }

  // ── open / close ──────────────────────────────────────────────────────────
  function initialSource(icon) {
    var svg = clean(icon.svgContent), fit = P.measure(icon);
    if (fit.overflow) svg = P.withViewBox(svg, fit.box);
    return formatSvg(svg, false);
  }

  SF.openLibraryStudio = function () {
    var icon = P.current();
    if (!icon || !icon.svgContent) { toast('This icon has no SVG to edit'); return; }
    ensureStudio();
    if (studio.iconId !== icon.id) {
      studio.iconId = icon.id; studio.original = studio.source = initialSource(icon); studio.undo = [];
      studio.error = ''; studio.pin = -1; studio.editing = false; studio.tool = 'edit'; cancelDraw();
    }
    if (!studio.touched) { studio.colorKey = P.colorKey(); studio.color = P.colorOf(studio.colorKey).hex; }
    $('#libStudio').removeClass('hidden');
    $('body').addClass('lps-open');
    render();
    $('#lpsClose').trigger('focus');
  };
  SF.closeLibraryStudio = function () {
    if (!$('#libStudio:not(.hidden)').length) return;
    cancelDraw(); $('#lpsAddDlg').addClass('hidden');
    $('#libStudio').addClass('hidden'); $('body').removeClass('lps-open'); $('#lppStudio').trigger('focus');
  };

  function fileName(ext) { return P.baseName(P.current()) + '-' + studio.size + 'px.' + ext; }
  function copy(text, what) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(what + ' copied'); }, function () { toast('Copy failed'); });
  }

  // ── events ────────────────────────────────────────────────────────────────
  $(document).on('click', '#lppStudio', function () { SF.openLibraryStudio(); });
  $(document).on('click', '#lpsClose', SF.closeLibraryStudio);
  $(document).on('click', '#libStudio', function (e) { if (e.target === this) SF.closeLibraryStudio(); });
  $(document).on('keydown', function (e) {
    if (e.key !== 'Escape' || !$('#libStudio:not(.hidden)').length) return;
    if ($('#lpsAddDlg:not(.hidden)').length) { $('#lpsAddDlg').addClass('hidden'); return; }
    if (draw) { cancelDraw(); return; }
    if (studio.tool !== 'edit' && !$(document.activeElement).is('textarea, input')) { setTool('edit'); return; }
    if (studio.editing && document.activeElement === $('#lpsEditor')[0]) { studio.editing = false; render(); return; }
    SF.closeLibraryStudio();
  });

  $(document).on('click', '#lpsSwatches [data-color]', function () {
    var k = $(this).data('color');
    studio.colorKey = k; studio.touched = true;
    if (k !== 'original') studio.color = P.colorOf(k).hex;
    render();
  });
  $(document).on('input', '#lpsColor', function () { studio.color = this.value; studio.colorKey = ''; studio.touched = true; render(); });
  $(document).on('input', '#lpsHex', function () {
    var v = this.value.trim(); if (v && v[0] !== '#') v = '#' + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) { studio.color = v; studio.colorKey = ''; studio.touched = true; render(); }
  });
  $(document).on('input', '#lpsStroke', function () { studio.stroke = +this.value; render(); });
  $(document).on('input', '#lpsSize', function () { studio.size = +this.value; render(); });
  $(document).on('change', '#lpsNonScaling', function () { studio.nonScaling = this.checked; render(); });
  $(document).on('change', '#lpsGrid', function () { studio.grid = this.checked; render(); });
  $(document).on('change', '#lpsPaths', function () { studio.paths = this.checked; if (!this.checked) { cancelDraw(); studio.tool = 'edit'; } render(); });
  $(document).on('click', '#lpsReset', function () {
    cancelDraw();
    $.extend(studio, { stroke: null, size: 32, nonScaling: false, grid: true, paths: true, touched: false, error: '', pin: -1, editing: false, source: studio.original, tool: 'edit' });
    studio.colorKey = P.colorKey(); studio.color = P.colorOf(studio.colorKey).hex;
    render();
  });

  // Find a path: hover in the preview or in the source; click pins it (click again to unpin).
  // (preview events are bound in stageRoot)
  function pin(i, fromStage) {
    if (!studio.paths) return;
    studio.pin = studio.pin === i ? -1 : i;
    setHot(studio.pin);
    drawHandles(stageRoot());
    $('#lpsTip').text(tipText());
    $('#lpsDelPath').prop('disabled', studio.pin < 0);
    if (studio.pin >= 0 && fromStage) {
      var el = $('#lpsSrc .lps-src-el[data-i="' + i + '"]')[0];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }
  $(document).on('mouseover', '#lpsSrc .lps-src-el', function () { if (studio.paths) setHot(+$(this).attr('data-i')); });
  $(document).on('mouseleave', '#lpsStage, #lpsSrc', function () { setHot(studio.pin); });
  $(document).on('click', '#lpsSrc .lps-src-el', function () { pin(+$(this).attr('data-i'), false); });

  // Tools: toolbar buttons and their keys (not while typing in the Source editor or a field).
  $(document).on('click', '#lpsTools [data-tool]', function () { setTool($(this).data('tool')); });
  $(document).on('click', '#lpsDelPath', function () { if (studio.pin >= 0) removeSourceEl(studio.pin); });
  $(document).on('keydown', function (e) {
    if (!$('#libStudio:not(.hidden)').length || $('#lpsAddDlg:not(.hidden)').length) return;
    if (e.metaKey || e.ctrlKey || e.altKey || $(document.activeElement).is('textarea, input, select')) return;
    if (e.key === 'Enter' && draw && draw.tool === 'pen') { e.preventDefault(); finishPen(false); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (draw && draw.tool === 'pen') { e.preventDefault(); draw.pts.pop(); if (draw.pts.length) drawOverlay(); else cancelDraw(); return; }
      if (studio.pin >= 0 && studio.paths) { e.preventDefault(); removeSourceEl(studio.pin); }
      return;
    }
    var key = e.key === '=' ? '+' : String(e.key).toUpperCase();
    var t = TOOLS.filter(function (x) { return x.hot === key; })[0];
    if (t) { e.preventDefault(); setTool(t.key); }
  });

  // Add to library: the Source as a new icon, or in place of the icon that was opened (a repository icon only).
  function openAddDialog() {
    var icon = P.current();
    if (!icon) return;
    if (studio.error) { toast('Fix the Source first: it is not valid SVG'); return; }
    if (draw) finishPen(false);
    var name = P.baseName(icon), repo = icon.source === 'repo' && !!icon.symbolId, changed = studio.source !== studio.original;
    $('#lpsAddName').val(name + (changed ? '-edited' : '-copy'));
    $('#lpsAddReplaceRow').toggleClass('hidden', !repo);
    $('#lpsAddReplaceText').text('Replace the drawing of "' + name + '" (same name, same place in the sprite)');
    $('#lpsAddDlg input[name="lpsAddMode"][value="new"]').prop('checked', true);
    $('#lpsAddErr').addClass('hidden').text('');
    $('#lpsAddSave').prop('disabled', false).text('Save');
    $('#lpsAddDlg').removeClass('hidden');
    $('#lpsAddName').prop('disabled', false).trigger('focus').trigger('select');
  }
  $(document).on('click', '#lpsAddLib', openAddDialog);
  $(document).on('click', '#lpsAddCancel', function () { $('#lpsAddDlg').addClass('hidden'); });
  $(document).on('click', '#lpsAddDlg', function (e) { if (e.target === this) $(this).addClass('hidden'); });
  $(document).on('change', '#lpsAddDlg input[name="lpsAddMode"]', function () { $('#lpsAddName').prop('disabled', this.value !== 'new'); });
  $(document).on('submit', '#lpsAddForm', function (e) {
    e.preventDefault();
    var icon = P.current(), mode = $('#lpsAddDlg input[name="lpsAddMode"]:checked').val(), svg = clean(studio.source);
    var fail = function (m) { $('#lpsAddErr').removeClass('hidden').text(m); $('#lpsAddSave').prop('disabled', false).text('Save'); };
    if (!icon) return;
    if (typeof SF.addItemsToIconRepo !== 'function' || typeof SF.replaceIconInRepo !== 'function') return fail('The UI library is not available on this page.');
    var busy = function () { $('#lpsAddErr').addClass('hidden'); $('#lpsAddSave').prop('disabled', true).text('Saving…'); };
    if (mode === 'replace') {
      var name = P.baseName(icon);
      var ask = SF.confirmDialog ? SF.confirmDialog({ title: 'Replace ' + name, message: 'The drawing of "' + name + '" in the UI library is replaced by the one in the studio. Everything that uses this icon shows the new drawing.', yesText: 'Yes, replace', noText: 'No, keep it', danger: true })
        : Promise.resolve(window.confirm('Replace the drawing of "' + name + '" in the UI library?'));
      return ask.then(function (yes) {
        if (!yes) return;
        busy();
        return SF.replaceIconInRepo(icon.symbolId, name, { name: name + '.svg', text: svg }).then(function (res) {
          if (!res || !res.ok) return fail('Replace failed: ' + ((res && res.error) || 'unknown error'));
          studio.original = studio.source;
          $('#lpsAddDlg').addClass('hidden');
          render();
        });
      });
    }
    var raw = $('#lpsAddName').val().trim().replace(/\.svg$/i, '').replace(/^zcicn-/i, '');
    var newName = SF.cleanFileName ? SF.cleanFileName(raw) : raw.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (!newName || !/[a-z0-9]/.test(newName)) return fail('Give the new icon a name (letters, digits, - and _).');
    busy();
    SF.addItemsToIconRepo([{ name: newName + '.svg', text: svg }], false).then(function (res) {
      if (!res || res.error) return fail('Add failed: ' + ((res && res.error) || 'unknown error'));
      if (!res.added || !res.added.length) return fail(res.skipped && res.skipped.length ? '"' + newName + '" was not added: ' + res.skipped[0].reason + '. Choose another name.' : 'Nothing was added.');
      $('#lpsAddDlg').addClass('hidden');
    });
  });

  $(document).on('click', '.lps-tab', function () { studio.tab = $(this).data('tab'); render(); });
  $(document).on('click', '#lpsEdit', function () { studio.editing = true; render(); $('#lpsEditor').trigger('focus'); });
  $(document).on('click', '#lpsEditDone', function () { studio.editing = false; render(); });
  $(document).on('click', '#lpsUndo', undo);
  // Cmd/Ctrl+Z in the studio undoes a point edit (the Source editor keeps its own text undo).
  $(document).on('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || String(e.key).toLowerCase() !== 'z' || !$('#libStudio:not(.hidden)').length) return;
    if ($(document.activeElement).is('textarea, input')) return;
    if (studio.undo && studio.undo.length) { e.preventDefault(); undo(); }
  });
  $(document).on('click', '#lpsRevert', function () { pushUndo(); studio.source = studio.original; studio.error = ''; studio.pin = -1; render(); if (studio.editing) $('#lpsEditor').val(studio.source); });
  $(document).on('click', '#lpsCopySrc', function () { copy(studio.source, 'Source'); });
  var editTimer = null;
  $(document).on('input', '#lpsEditor', function () {
    var text = this.value;
    clearTimeout(editTimer);
    editTimer = setTimeout(function () {
      var parsed = parseXml(text);
      if (parsed.error || !parsed.doc.documentElement || parsed.doc.documentElement.nodeName !== 'svg') {
        studio.error = parsed.error || 'The source must be one <svg> element.';
      } else { studio.error = ''; studio.source = text; }
      render();
    }, 250);
  });

  $(document).on('input', '#lpsColors [data-src-color]', function () {
    var from = $(this).attr('data-src-color'), to = this.value;
    studio.source = replaceColor(studio.source, from, to);
    $(this).attr('data-src-color', to);
    if (studio.colorKey !== 'original') { studio.colorKey = 'original'; studio.touched = true; }
    render();
  });

  $(document).on('click', '[data-copy-code]', function () {
    copy($(this).data('copy-code') === 'crm' ? $('#lpsCodeCrm').text() : studio.last && studio.last.svg, $(this).data('copy-code') === 'crm' ? 'Markup' : 'SVG');
  });
  $(document).on('click', '#lpsCopySvg', function () { copy(studio.last && studio.last.svg, 'SVG'); });
  $(document).on('click', '#lpsDownloadSvg', function () {
    if (studio.last && SF.downloadFile) SF.downloadFile(studio.last.svg, fileName('svg'), 'image/svg+xml');
  });
  $(document).on('click', '#lpsDownloadPng', function () {
    if (!studio.last) return;
    var px = studio.size, scale = 2, img = new Image(), name = fileName('png').replace(/\.png$/, '@2x.png');
    img.onload = function () {
      var cv = document.createElement('canvas'); cv.width = px * scale; cv.height = px * scale;
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob(function (blob) {
        if (!blob) { toast('PNG export failed'); return; }
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      }, 'image/png');
    };
    img.onerror = function () { toast('PNG export failed'); };
    img.src = P.dataUri(studio.last.svg);
  });
})(window.SpriteForge, jQuery);
