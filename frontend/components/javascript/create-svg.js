/**
 * SpriteForge - Create SVG
 * Image (PNG/JPG/WebP) -> SVG icon tracer. Runs fully in the browser (imagetracerjs).
 * Outputs: sprite <symbol>, standalone SVG, icon list row.
 */
(function (SF, $) {
  'use strict';
  if (!SF || !$) return;

  var TRACE_SIZE = 256;               // working canvas (square)
  var img = null;                     // HTMLImageElement of the source
  var result = null;                  // { paths, vb, name }
  var tab = 'symbol';
  var timer = null;

  function toast(m) { if (SF.showToast) SF.showToast(m); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function mode() { return $('#csvModeSeg .csv-seg-btn.active').data('mode') || 'mono'; }
  function cleanName() {
    var n = String($('#csvName').val() || '').toLowerCase().replace(/^icon-/, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return n || 'icon';
  }

  // ---- loading the image ----
  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) { toast('Please choose an image file'); return; }
    var url = URL.createObjectURL(file);
    var im = new Image();
    im.onload = function () {
      img = im;
      $('#csvSrcThumb').attr('src', url);
      $('#csvSrcInfo').text(file.name + ' · ' + im.naturalWidth + '×' + im.naturalHeight + ' px' +
        (im.naturalWidth < 256 ? ' (small — result may be rough)' : ''));
      $('#csvDropIdle').addClass('hidden');
      $('#csvDropLoaded').removeClass('hidden');
      var base = file.name.replace(/\.[^.]+$/, '');
      if (!$('#csvName').data('touched') && base && base !== 'image') $('#csvName').val(base);
      autoPickMode(im);
      schedule(0);
    };
    im.onerror = function () { toast('Could not read that image'); };
    im.src = url;
  }

  // ---- colour quantisation: exact dominant colours, no dithering ----
  // Background = transparent pixels + light neutral pixels connected to the image border
  // (handles white backgrounds and baked-in fake checkerboards).
  function bgMask(px, S) {
    var n = S * S, m = new Uint8Array(n), seen = new Uint8Array(n), st = [], i;
    function cand(k) {
      var r = px[k * 4], g = px[k * 4 + 1], b = px[k * 4 + 2];
      if (px[k * 4 + 3] < 128) return true;
      return (0.299 * r + 0.587 * g + 0.114 * b) > 185 && (Math.max(r, g, b) - Math.min(r, g, b)) < 32;
    }
    for (i = 0; i < n; i++) if (px[i * 4 + 3] < 128) m[i] = 1;
    for (i = 0; i < S; i++) { st.push(i, (S - 1) * S + i, i * S, i * S + S - 1); }
    while (st.length) {
      var k = st.pop();
      if (seen[k] || !cand(k)) continue;
      seen[k] = 1; m[k] = 1;
      var x = k % S, y = (k / S) | 0;
      if (x > 0) st.push(k - 1); if (x < S - 1) st.push(k + 1);
      if (y > 0) st.push(k - S); if (y < S - 1) st.push(k + S);
    }
    return m;
  }

  function otsu(h) {
    var tot = 0, sum = 0, t;
    for (t = 0; t < 256; t++) { tot += h[t]; sum += t * h[t]; }
    var wB = 0, sB = 0, best = 128, mx = -1;
    for (t = 0; t < 256; t++) {
      wB += h[t]; if (!wB) continue;
      var wF = tot - wB; if (!wF) break;
      sB += t * h[t];
      var mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > mx) { mx = v; best = t; }
    }
    return best;
  }

  // 5x5 per-channel median: kills texture/JPEG noise, keeps edges sharp
  function median5(px, S, bg) {
    var src = new Uint8ClampedArray(px), win = new Uint8Array(25), ch, x, y, xx, yy, c;
    for (y = 2; y < S - 2; y++) for (x = 2; x < S - 2; x++) {
      if (bg[y * S + x]) continue;
      for (ch = 0; ch < 3; ch++) {
        c = 0;
        for (yy = -2; yy <= 2; yy++) for (xx = -2; xx <= 2; xx++) {
          var k = (y + yy) * S + x + xx;
          win[c++] = bg[k] ? src[(y * S + x) * 4 + ch] : src[k * 4 + ch];
        }
        win.sort();
        px[(y * S + x) * 4 + ch] = win[12];
      }
    }
  }

  function quantize(data, S, k, minArea) {
    var px = data.data, n = S * S, i, j;
    var bg = bgMask(px, S);
    for (i = 0; i < n; i++) { if (bg[i]) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 255; } px[i * 4 + 3] = 255; }
    median5(px, S, bg);

    // 4-bit histogram buckets over foreground pixels only
    var cnt = new Float64Array(4096), sr = new Float64Array(4096), sg = new Float64Array(4096), sb = new Float64Array(4096);
    for (i = 0; i < n; i++) {
      if (bg[i]) continue;
      var o = i * 4, key = ((px[o] >> 4) << 8) | ((px[o + 1] >> 4) << 4) | (px[o + 2] >> 4);
      cnt[key]++; sr[key] += px[o]; sg[key] += px[o + 1]; sb[key] += px[o + 2];
    }
    var B = [];
    for (i = 0; i < 4096; i++) if (cnt[i]) B.push({ w: cnt[i], r: sr[i] / cnt[i], g: sg[i] / cnt[i], b: sb[i] / cnt[i] });
    if (!B.length) B.push({ w: 1, r: 0, g: 0, b: 0 });
    k = Math.min(k, B.length);
    function d2(x, c) { var dr = x.r - c.r, dg = x.g - c.g, db = x.b - c.b; return dr * dr + dg * dg + db * db; }
    B.sort(function (x, y) { return y.w - x.w; });
    var cen = [{ r: B[0].r, g: B[0].g, b: B[0].b }];
    while (cen.length < k) {
      var best = null, bs = -1;
      for (i = 0; i < B.length; i++) {
        var md = Infinity;
        for (j = 0; j < cen.length; j++) md = Math.min(md, d2(B[i], cen[j]));
        var sc = md * Math.sqrt(B[i].w);
        if (sc > bs) { bs = sc; best = B[i]; }
      }
      cen.push({ r: best.r, g: best.g, b: best.b });
    }
    for (var it = 0; it < 12; it++) {
      var acc = cen.map(function () { return { w: 0, r: 0, g: 0, b: 0 }; });
      B.forEach(function (x) {
        var bi = 0, bd = Infinity;
        for (var c = 0; c < cen.length; c++) { var dd = d2(x, cen[c]); if (dd < bd) { bd = dd; bi = c; } }
        var t = acc[bi]; t.w += x.w; t.r += x.r * x.w; t.g += x.g * x.w; t.b += x.b * x.w;
      });
      acc.forEach(function (t, c) { if (t.w) cen[c] = { r: t.r / t.w, g: t.g / t.w, b: t.b / t.w }; });
    }
    cen = cen.map(function (c) { return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }; });
    // reserved background entry (unique marker colour, replaced/removed after tracing)
    var hasBg = false; for (i = 0; i < n; i++) if (bg[i]) { hasBg = true; break; }
    var bgIdx = -1;
    if (hasBg) { cen.push({ r: 1, g: 254, b: 2 }); bgIdx = cen.length - 1; }
    var fg = bgIdx >= 0 ? cen.length - 1 : cen.length;

    var idx = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      if (bg[i]) { idx[i] = bgIdx; continue; }
      var r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], bi2 = 0, bd2 = Infinity;
      for (j = 0; j < fg; j++) {
        var dr = r - cen[j].r, dg = g - cen[j].g, db = b - cen[j].b, dd2 = dr * dr + dg * dg + db * db;
        if (dd2 < bd2) { bd2 = dd2; bi2 = j; }
      }
      idx[i] = bi2;
    }
    // majority filter x2 over foreground (never grows into background)
    for (var pass = 0; pass < 2; pass++) {
      var out = new Uint8Array(idx), hist = new Uint8Array(cen.length);
      for (var y = 1; y < S - 1; y++) for (var x = 1; x < S - 1; x++) {
        if (idx[y * S + x] === bgIdx) continue;
        hist.fill(0);
        var bm = idx[y * S + x], bc = 0;
        for (var yy = -1; yy <= 1; yy++) for (var xx = -1; xx <= 1; xx++) hist[idx[(y + yy) * S + x + xx]]++;
        for (j = 0; j < fg; j++) if (hist[j] > bc || (hist[j] === bc && j === bm)) { bc = hist[j]; bm = j; }
        out[y * S + x] = bm;
      }
      idx = out;
    }
    // merge small regions into their dominant neighbour (removes texture streaks / pinholes)
    for (var rep = 0; rep < 3 && minArea > 0; rep++) {
      var lab = new Int32Array(n).fill(-1), comps = [], cid = 0, changed = false;
      for (i = 0; i < n; i++) {
        if (lab[i] >= 0) continue;
        var stack = [i], cells = [], v = idx[i]; lab[i] = cid;
        while (stack.length) {
          var q = stack.pop(); cells.push(q);
          var qx = q % S, qy = (q / S) | 0, nb = [qx > 0 ? q - 1 : -1, qx < S - 1 ? q + 1 : -1, qy > 0 ? q - S : -1, qy < S - 1 ? q + S : -1];
          for (var t = 0; t < 4; t++) { var m = nb[t]; if (m >= 0 && lab[m] < 0 && idx[m] === v) { lab[m] = cid; stack.push(m); } }
        }
        comps.push({ v: v, cells: cells }); cid++;
      }
      comps.forEach(function (cp) {
        if (cp.v === bgIdx || cp.cells.length >= minArea) return;
        var votes = {}, bestL = -1, bestN = 0;
        cp.cells.forEach(function (q) {
          var qx = q % S, qy = (q / S) | 0, nb = [qx > 0 ? q - 1 : -1, qx < S - 1 ? q + 1 : -1, qy > 0 ? q - S : -1, qy < S - 1 ? q + S : -1];
          for (var t = 0; t < 4; t++) { var m = nb[t]; if (m >= 0 && idx[m] !== cp.v) { var l = idx[m]; votes[l] = (votes[l] || 0) + 1; if (votes[l] > bestN) { bestN = votes[l]; bestL = l; } } }
        });
        if (bestL >= 0) { cp.cells.forEach(function (q) { idx[q] = bestL; }); changed = true; }
      });
      if (!changed) break;
    }
    for (i = 0; i < n; i++) {
      var c2 = cen[idx[i]];
      px[i * 4] = c2.r; px[i * 4 + 1] = c2.g; px[i * 4 + 2] = c2.b; px[i * 4 + 3] = 255;
    }
    return { cen: cen, idx: idx, bgIdx: bgIdx };
  }

  // Looks at the image: mostly grey/black/white -> Single colour, otherwise Original colours.
  function autoPickMode(im) {
    try {
      var cv = document.createElement('canvas'), z = 64;
      cv.width = cv.height = z;
      var cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(im, 0, 0, z, z);
      var d = cx.getImageData(0, 0, z, z).data, fg = 0, col = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx > 235 && mx - mn < 30) continue;          // white-ish background
        fg++; if (mx - mn > 45) col++;
      }
      var wantColor = fg > 0 && col / fg > 0.15;
      $('#csvModeSeg .csv-seg-btn').removeClass('active').filter('[data-mode=' + (wantColor ? 'color' : 'mono') + ']').addClass('active');
      $('#csvModeAuto').text(wantColor
        ? 'We picked “Original colours” because your image has several colours. You can switch above.'
        : 'We picked “Single colour” because your image is one colour. You can switch above.');
      syncUi();
    } catch (e) {}
  }

  // ---- tracing ----
  // ---- Potrace (wasm, self-hosted) ----
  var potracePromise = null;
  function getPotrace() {
    if (!potracePromise) {
      potracePromise = import('./vendor/potrace.esm.js').then(function (m) {
        return Promise.resolve(m.init()).then(function () { return m.potrace; });
      });
    }
    return potracePromise;
  }

  // Potrace emits 10x units with a flipped y axis; convert to viewBox units.
  function convertPath(d, S, vb) {
    var k = vb / S * 0.1, H = S * 10, out = [], cmd = null, nums = [];
    function flush() {
      if (!cmd) return;
      var rel = cmd === cmd.toLowerCase(), c = cmd.toLowerCase();
      if (c === 'z') { out.push('z'); return; }
      var vals = [];
      for (var i = 0; i + 1 < nums.length; i += 2) {
        var x = nums[i], y = nums[i + 1];
        vals.push(+(x * k).toFixed(2), +((rel ? -y : H - y) * k).toFixed(2));
      }
      out.push(cmd + vals.join(' '));
    }
    var re = /([MmLlCcZz])|(-?\d+(?:\.\d+)?)/g, m;
    while ((m = re.exec(d))) {
      if (m[1]) { flush(); cmd = m[1]; nums = []; } else nums.push(parseFloat(m[2]));
    }
    flush();
    return out.join('');
  }

  function maskCanvas(S, fn) {
    var cv = document.createElement('canvas'); cv.width = cv.height = S;
    var cx = cv.getContext('2d'), id = cx.createImageData(S, S), d = id.data;
    for (var i = 0; i < S * S; i++) { var v = fn(i) ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    cx.putImageData(id, 0, 0);
    return cv;
  }

  var traceToken = 0;
  async function trace() {
    if (!img) return;
    var token = ++traceToken;
    var potrace;
    try { potrace = await getPotrace(); }
    catch (e) { console.error(e); toast('Tracer failed to load'); return; }

    var vb = +$('#csvVb').val();
    var pad = +$('#csvPad').val() / 100;
    var isMono = mode() === 'mono';
    var S = isMono ? 800 : 400;
    var inner = Math.round(S * (1 - 2 * pad));
    var ratio = Math.min(inner / img.naturalWidth, inner / img.naturalHeight);
    var w = Math.max(1, Math.round(img.naturalWidth * ratio));
    var h = Math.max(1, Math.round(img.naturalHeight * ratio));

    var cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, Math.round((S - w) / 2), Math.round((S - h) / 2), w, h);
    var data = ctx.getImageData(0, 0, S, S);
    var px = data.data, i, n = S * S;

    var smooth = +$('#csvSmooth').val();
    var speck = +$('#csvSpecks').val();
    var popts = { pathonly: true, extractcolors: false, alphamax: 1, opttolerance: Math.min(1, smooth * 0.2) };
    var paths = [];

    async function traceCanvas(canvas, turd) {
      var arr = await potrace(canvas, Object.assign({ turdsize: turd }, popts));
      return (Array.isArray(arr) ? arr : [arr]).map(function (d) { return convertPath(String(d), S, vb); }).join('');
    }

    // Traces each separate shape (connected blob, with its own holes) as its own path,
    // so every shape can be selected / recoloured on its own. Falls back to one merged path.
    async function traceShapes(test, turd) {
      var lab = new Int32Array(n), areas = [0], cid = 0, st, k;
      for (var a = 0; a < n; a++) {
        if (lab[a] || !test(a)) continue;
        cid++; areas[cid] = 0; st = [a]; lab[a] = cid;
        while (st.length) {
          k = st.pop(); areas[cid]++;
          var kx = k % S, ky = (k / S) | 0;
          for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
            var nx = kx + dx, ny = ky + dy;
            if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
            var nk = ny * S + nx;
            if (!lab[nk] && test(nk)) { lab[nk] = cid; st.push(nk); }
          }
        }
      }
      var ids = [];
      for (var c = 1; c <= cid; c++) if (areas[c] > Math.max(turd, 1)) ids.push(c);
      ids.sort(function (x, y) { return areas[y] - areas[x]; });
      if (ids.length > 40) {
        var whole = await traceCanvas(maskCanvas(S, function (j) { return lab[j] > 0; }), turd);
        return whole ? [whole] : [];
      }
      var out = [];
      for (var q2 = 0; q2 < ids.length; q2++) {
        var id = ids[q2];
        var d = await traceCanvas(maskCanvas(S, function (j) { return lab[j] === id; }), turd);
        if (d) out.push(d);
      }
      return out;
    }

    if (isMono) {
      var thr = +$('#csvThreshold').val();
      var shapeBy = $('#csvShape').val();
      var hasAlpha = false;
      for (i = 3; i < px.length; i += 4) { if (px[i] < 250) { hasAlpha = true; break; } }
      var bgm = bgMask(px, S), lums = new Float32Array(n), hist = new Float64Array(256);
      for (i = 0; i < n; i++) {
        lums[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        if (!bgm[i]) hist[lums[i] | 0]++;
      }
      var autoThr = otsu(hist) + (thr - 128);
      var ds = await traceShapes(function (j) {
        var a = px[j * 4 + 3], lum = lums[j];
        if (shapeBy === 'auto') return hasAlpha ? a > thr : (!bgm[j] && lum < autoThr);
        if (shapeBy === 'dark') return a > 127 && lum < thr;
        return a > 127 && lum > thr;
      }, speck * 4);
      ds.forEach(function (d) { paths.push({ d: d, fill: null, orig: null, group: null }); });
    } else {
      var q = quantize(data, S, +$('#csvColors').val(), speck * 20);
      var counts = {}, order = [];
      for (i = 0; i < n; i++) { if (q.idx[i] !== q.bgIdx) counts[q.idx[i]] = (counts[q.idx[i]] || 0) + 1; }
      order = Object.keys(counts).map(Number).sort(function (a, b) { return counts[b] - counts[a]; });
      if (!$('#csvRemoveWhite').is(':checked')) {
        paths.push({ d: 'M0 0H' + vb + 'V' + vb + 'H0z', fill: '#ffffff', orig: '#ffffff', group: null });
      }
      for (var li = 0; li < order.length; li++) {
        // stacked layers: each colour is traced together with everything drawn after it,
        // so shapes overlap slightly underneath and no gaps/seams can show
        var set = {}; order.slice(li).forEach(function (c) { set[c] = 1; });
        var dls = await traceShapes(function (j) { return set[q.idx[j]] === 1 && q.idx[j] !== q.bgIdx; }, speck * 4);
        var c = q.cen[order[li]];
        var hex = '#' + [c.r, c.g, c.b].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
        dls.forEach(function (d) { paths.push({ d: d, fill: hex, orig: hex, group: null }); });
        if (token !== traceToken) return;
      }
    }
    if (token !== traceToken) return;
    result = { paths: paths, vb: vb };
    sel = {}; gseq = 1;
    render();
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { trace().catch(function (e) { console.error(e); toast('Tracing failed'); }); }, ms == null ? 180 : ms);
  }

  // ---- output ----
  var sel = {};     // selected path indices
  var gseq = 1;

  function pathTag(pp, i, withIdx) {
    var cur = $('#csvCurrent').is(':checked');
    var fill = pp.fill ? ' fill="' + pp.fill + '"' : (cur ? '' : ' fill="#000000"');
    return '<path' + fill + (withIdx ? ' data-i="' + i + '"' : '') + ' d="' + pp.d + '"/>';
  }

  // Consecutive paths that share a group are wrapped in <g>; z-order is never changed.
  function pathMarkup(indent, withIdx) {
    var out = [], i = 0, P = result.paths, runNo = {};
    while (i < P.length) {
      var g = P[i].group;
      if (!g) { out.push(indent + pathTag(P[i], i, withIdx)); i++; continue; }
      var j = i, inner = [];
      while (j < P.length && P[j].group === g) { inner.push(indent + '  ' + pathTag(P[j], j, withIdx)); j++; }
      runNo[g] = (runNo[g] || 0) + 1;
      out.push(indent + '<g id="group-' + g + (runNo[g] > 1 ? '-' + runNo[g] : '') + '">\n' + inner.join('\n') + '\n' + indent + '</g>');
      i = j;
    }
    return out.join('\n');
  }

  function standalone(size, grid, withIdx) {
    var vb = result.vb, cur = $('#csvCurrent').is(':checked') || mode() === 'color';
    var body = pathMarkup('  ', withIdx);
    var g = '';
    if (grid) {
      for (var k = 0; k <= vb; k++) {
        g += '<path d="M' + k + ' 0V' + vb + 'M0 ' + k + 'H' + vb + '" stroke="currentColor" stroke-opacity=".12" stroke-width=".04" fill="none"/>';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + vb + ' ' + vb + '"' +
      (size ? ' width="' + size + '" height="' + size + '"' : '') +
      (cur ? ' fill="currentColor"' : '') + '>' + g + '\n' + body + '\n</svg>';
  }

  function codeFor(which) {
    var name = cleanName(), vb = result.vb;
    if (which === 'symbol') {
      return '<symbol id="icon-' + name + '" viewBox="0 0 ' + vb + ' ' + vb + '">\n' + pathMarkup('  ') + '\n</symbol>';
    }
    if (which === 'svg') return standalone(vb, false);
    return '| ' + name + ' | icon-' + name + ' | ' + name.replace(/-/g, ', ') + (mode() === 'color' ? ', multicolour' : '') + ' |';
  }

  function renderChips() {
    var cnt = Object.keys(sel).length;
    $('#csvPathsTitle').text('Shapes (' + result.paths.length + ')' + (cnt ? ' · ' + cnt + ' selected' : ''));
    $('#csvPathList').html(result.paths.map(function (pp, i) {
      var bg = pp.fill || 'currentColor';
      return '<button type="button" class="csv-chip' + (sel[i] ? ' sel' : '') + (pp.group ? ' grouped' : '') + '" data-i="' + i + '" title="' + (pp.group ? 'Group ' + pp.group : 'Path ' + (i + 1)) + '">' +
        '<i style="background:' + bg + '"></i>' + (i + 1) + (pp.group ? '<sup>g' + pp.group + '</sup>' : '') + '</button>';
    }).join(''));
    var first = Object.keys(sel)[0];
    if (first != null) {
      var f = result.paths[first].fill;
      if (f && /^#[0-9a-f]{6}$/i.test(f)) $('#csvPathColor').val(f);
    }
    $('#csvPathTools .csv-needsel').prop('disabled', !cnt);
  }

  function selectPath(i, additive) {
    var g = result.paths[i].group, members = [];
    result.paths.forEach(function (pp, k) { if (k === i || (g && pp.group === g)) members.push(k); });
    var on = !members.every(function (k) { return sel[k]; });
    if (!additive) sel = {};
    members.forEach(function (k) { if (on) sel[k] = true; else delete sel[k]; });
    render();
  }

  function render() {
    var name = cleanName();
    $('#csvDownloadLabel').text('Download icon-' + name + '.svg');
    $('#csvPaths').toggle(!!(result && result.paths.length));
    if (!result || !result.paths.length) {
      $('#csvPreviewBox').html('<span class="csv-hint">No shape found — adjust Find the shape by or Threshold</span>');
      $('#csvSizes').empty(); $('#csvStats').text('');
      $('#csvCode').text('Nothing generated yet.');
      $('#csvDownloadBtn').prop('disabled', true);
      return;
    }
    var hl = Object.keys(sel).map(function (k) {
      return '<path d="' + result.paths[k].d + '" fill="none" stroke="#2C83EC" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" pointer-events="none"/>';
    }).join('');
    var prev = standalone(null, $('#csvGrid').is(':checked'), true);
    $('#csvPreviewBox').html(prev.replace(/<\/svg>\s*$/, hl + '</svg>')).addClass('csv-interactive');
    renderChips();
    var sizes = [16, 24, 32, 48];
    $('#csvSizes').html(sizes.map(function (s) {
      return '<div class="csv-size-row">' + standalone(s, false) + '<span>' + s + 'px</span></div>';
    }).join(''));
    var bytes = codeFor('symbol').length;
    $('#csvStats').text(result.paths.length + ' path' + (result.paths.length === 1 ? '' : 's') + ' · ' + bytes + ' bytes as symbol');
    $('#csvCode').text(codeFor(tab));
    $('#csvDownloadBtn').prop('disabled', false);
  }

  function tabHelp() {
    $('#csvTabHelp').text({
      symbol: 'Paste this inside your sprite.svg file, then use it with <use href="#icon-name">.',
      svg: 'A complete standalone SVG. Paste it into HTML or save it as a .svg file.',
      row: 'A line for the icon list in your docs, so others can find this icon.'
    }[tab]);
  }

  function syncUi() {
    tabHelp();
    var color = mode() === 'color';
    $('#csvShapeField, #csvThresholdField, #csvCurrentRow').toggle(!color);
    $('#csvColorsField, #csvWhiteRow').toggle(color);
    $('#csvThresholdVal').text($('#csvThreshold').val());
    $('#csvColorsVal').text($('#csvColors').val());
    $('#csvSmoothVal').text($('#csvSmooth').val());
    $('#csvSpecksVal').text($('#csvSpecks').val());
    $('#csvPadVal').text($('#csvPad').val());
  }

  // ---- events (delegated: markup loads asynchronously) ----
  $(document).on('click', '#csvDrop', function (e) {
    if (e.target.id === 'csvFile') return;   // the input's own click bubbles back up here
    $('#csvFile')[0].click();
  });
  $(document).on('click', '#csvFile', function (e) { e.stopPropagation(); });
  $(document).on('keydown', '#csvDrop', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#csvFile')[0].click(); } });
  $(document).on('change', '#csvFile', function () { loadFile(this.files && this.files[0]); this.value = ''; });
  $(document).on('dragover dragenter', '#csvDrop', function (e) { e.preventDefault(); $(this).addClass('drag'); });
  $(document).on('dragleave drop', '#csvDrop', function (e) {
    e.preventDefault(); $(this).removeClass('drag');
    if (e.type === 'drop') loadFile(e.originalEvent.dataTransfer.files[0]);
  });
  document.addEventListener('paste', function (e) {
    if ($('#createSvgPage').hasClass('hidden') || !e.clipboardData) return;
    var items = e.clipboardData.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) { loadFile(items[i].getAsFile()); e.preventDefault(); return; }
    }
  });

  $(document).on('click', '#csvModeSeg .csv-seg-btn', function () {
    $('#csvModeSeg .csv-seg-btn').removeClass('active'); $(this).addClass('active');
    syncUi(); schedule(0);
  });
  $(document).on('input change', '#createSvgPage input[type=range], #csvShape, #csvVb, #csvRemoveWhite', function () {
    syncUi(); schedule();
  });
  $(document).on('change', '#csvCurrent, #csvGrid', function () { if (result) render(); });
  $(document).on('input', '#csvName', function () { $(this).data('touched', true); if (result) render(); });
  $(document).on('click', '#csvTabs [data-tab]', function () {
    $('#csvTabs [data-tab]').removeClass('active'); $(this).addClass('active');
    tab = $(this).data('tab'); tabHelp(); if (result && result.paths.length) $('#csvCode').text(codeFor(tab));
  });
  $(document).on('click', '#csvCopyBtn', function () {
    if (!result || !result.paths.length) return;
    var text = codeFor(tab);
    var done = function () { toast('Copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast('Copy failed'); });
    else { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); }
  });
  $(document).on('click', '#csvDownloadBtn', function () {
    if (!result || !result.paths.length) return;
    SF.downloadFile(standalone(result.vb, false), 'icon-' + cleanName() + '.svg', 'image/svg+xml');
  });

  // ---- path selection / colour / grouping ----
  $(document).on('click', '#csvPreviewBox path[data-i]', function (e) {
    e.stopPropagation(); selectPath(+$(this).attr('data-i'), e.shiftKey || e.metaKey || e.ctrlKey);
  });
  $(document).on('click', '#csvPreviewBox', function () { if (result && Object.keys(sel).length) { sel = {}; render(); } });
  $(document).on('click', '#csvPathList .csv-chip', function (e) {
    selectPath(+$(this).attr('data-i'), e.shiftKey || e.metaKey || e.ctrlKey || true);
  });
  $(document).on('click', '#csvSelAll', function () { if (!result) return; sel = {}; result.paths.forEach(function (_, k) { sel[k] = true; }); render(); });
  $(document).on('click', '#csvSelNone', function () { if (!result) return; sel = {}; render(); });
  $(document).on('click', '#csvApplyColor', function () {
    var c = $('#csvPathColor').val();
    Object.keys(sel).forEach(function (k) { result.paths[k].fill = c; });
    render();
  });
  $(document).on('click', '#csvResetColor', function () {
    Object.keys(sel).forEach(function (k) { result.paths[k].fill = result.paths[k].orig; });
    render();
  });
  $(document).on('click', '#csvGroupBtn', function () {
    var ks = Object.keys(sel); if (ks.length < 2) { toast('Select two or more shapes to group'); return; }
    var id = gseq++;
    ks.forEach(function (k) { result.paths[k].group = id; });
    render();
  });
  $(document).on('click', '#csvUngroupBtn', function () {
    Object.keys(sel).forEach(function (k) { result.paths[k].group = null; });
    render();
  });

  SF.initCreateSvgPage = syncUi;
})(window.SpriteForge, window.jQuery);
