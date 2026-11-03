/**
 * SpriteForge - Icon Library "Edit in studio" (opened from the icon preview panel)
 *
 * - Customizer: colour (CRM swatches, original colours or any hex), stroke width, size, non-scaling stroke
 * - Preview: the icon over its own grid; "Paths" colours every element and marks where each line starts and ends
 * - Source: the icon's SVG, each element in the colour it has in the preview (hover either side to find it,
 *   click to pin); Edit turns it into a text editor and the preview follows every change
 * - Code: the final SVG (with the customizer applied) and the <crmutil-icon> markup
 * - Colors: every colour the source uses; change one to recolour it everywhere
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
    grid: true, paths: true, tab: 'source', editing: false, iconId: null, source: '', original: '', error: '', pin: -1, last: null
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
  // Draggable points of one element: [{ x, y, kind: 'anchor' | 'ctrl', move(x, y), links: [[x,y] of the anchor] }] + attrs()
  function editModel(el) {
    var tag = el.tagName.toLowerCase(), num = function (a) { return parseFloat(el.getAttribute(a)) || 0; }, pts = [];
    if (tag === 'path') {
      var segs = parsePath(el.getAttribute('d'));
      if (!segs) return null;
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
      return { pts: pts, attrs: function () { return { d: pathString(segs) }; } };
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
    var model = el && editModel(el);
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
              '<button class="btn btn-primary btn-sm" id="lpsCopySvg" type="button">Copy SVG</button>' +
              '<button class="btn btn-ghost btn-sm" id="lpsDownloadSvg" type="button">Download SVG</button>' +
              '<button class="btn btn-ghost btn-sm" id="lpsDownloadPng" type="button">Download PNG</button>' +
            '</div>' +
          '</section>' +
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
    '.wrap.is-dragging,.wrap.is-dragging .lps-handle{cursor:grabbing}';
  function stageRoot() {
    var stage = $('#lpsStage')[0];
    if (!stage) return null;
    if (stage.shadowRoot) return stage.shadowRoot;
    var root = stage.attachShadow({ mode: 'open' });
    // Events inside a shadow root reach the page re-targeted to the stage, so listen here.
    root.addEventListener('mouseover', function (e) { var t = e.target.closest && e.target.closest('[data-i]'); if (t && studio.paths) setHot(+t.getAttribute('data-i')); });
    root.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('[data-i]'); if (t) pin(+t.getAttribute('data-i'), true); });
    // Point editing (handles of the pinned element)
    root.addEventListener('pointerdown', startDrag);
    return root;
  }

  function renderStage(out) {
    var root = stageRoot();
    if (!root) return;
    root.innerHTML = '<style>' + STAGE_CSS + '</style><div class="wrap' + (studio.paths ? ' lps-paths' : '') + '">' +
      (studio.grid ? gridSvg(out.vb) : '') + scalable(out.svg) + '</div>';
    var art = root.querySelector('.lps-art');
    if (art) decorate(art, out.vb);
    $('#lpsTip').toggleClass('hidden', !studio.paths).text(studio.pin >= 0
      ? 'Drag the points to change this path · Cmd/Ctrl+Z undoes · click the path again to unpin it.'
      : 'Hover a path to find it in the source · click a path to edit its points.');
    setHot(studio.pin);
    drawHandles(root);
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
      studio.error = ''; studio.pin = -1; studio.editing = false;
    }
    if (!studio.touched) { studio.colorKey = P.colorKey(); studio.color = P.colorOf(studio.colorKey).hex; }
    $('#libStudio').removeClass('hidden');
    $('body').addClass('lps-open');
    render();
    $('#lpsClose').trigger('focus');
  };
  SF.closeLibraryStudio = function () {
    if (!$('#libStudio:not(.hidden)').length) return;
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
  $(document).on('change', '#lpsPaths', function () { studio.paths = this.checked; render(); });
  $(document).on('click', '#lpsReset', function () {
    $.extend(studio, { stroke: null, size: 32, nonScaling: false, grid: true, paths: true, touched: false, error: '', pin: -1, editing: false, source: studio.original });
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
    $('#lpsTip').text(studio.pin >= 0 ? 'Drag the points to change this path · Cmd/Ctrl+Z undoes · click the path again to unpin it.'
      : 'Hover a path to find it in the source · click a path to edit its points.');
    if (studio.pin >= 0 && fromStage) {
      var el = $('#lpsSrc .lps-src-el[data-i="' + i + '"]')[0];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }
  $(document).on('mouseover', '#lpsSrc .lps-src-el', function () { if (studio.paths) setHot(+$(this).attr('data-i')); });
  $(document).on('mouseleave', '#lpsStage, #lpsSrc', function () { setHot(studio.pin); });
  $(document).on('click', '#lpsSrc .lps-src-el', function () { pin(+$(this).attr('data-i'), false); });

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
