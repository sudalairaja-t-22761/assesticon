(function () {
  const p = fetch('components/templates/svg-gradient-svg-icons.html?v=1').then(r => r.text());
  window._componentPromises = window._componentPromises || [];
  window._componentPromises.push(p);

  class SvgGradientSvgIcons extends HTMLElement {
    connectedCallback() { p.then(html => { this.innerHTML = html; }); }
  }
  customElements.define('svg-gradient-svg-icons', SvgGradientSvgIcons);
})();

(function (SF, $) {
  'use strict';

  const PAGE = 'gradientsvg';
  const MAX_BYTES = 1024 * 1024;
  const MAX_STOPS = 8;
  const MIN_STOPS = 2;
  const SIZES = [24, 32, 48, 64, 96];
  const SHAPES = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
  const SKIP_ANCESTORS = ['defs', 'clippath', 'mask', 'pattern', 'marker', 'symbol'];
  const BAD_ELEMENTS = ['script', 'foreignobject', 'iframe', 'object', 'embed', 'link', 'meta'];
  const ANIMATE_ELEMENTS = ['animate', 'set', 'animatemotion', 'animatetransform'];
  const SAFE_REF = /^(#|data:image\/(png|jpe?g|gif|webp);)/i;
  const SVG_NS = (function () {
    const d = document.createElement('div');
    d.innerHTML = '<svg></svg>';
    return d.firstChild.namespaceURI;
  })();

  // Presets: angle uses 0° = left → right, 90° = top → bottom. Radial ignores angle.
  const S = (color, offset) => ({ color: color, offset: offset });
  const PRESETS = [
    { id: 'linear', label: 'Linear Gradient', type: 'linear', angle: 45, stops: [S('#6366f1', 0), S('#ec4899', 100)] },
    { id: 'diagonal', label: 'Diagonal Gradient', type: 'linear', angle: 135, stops: [S('#06b6d4', 0), S('#3b82f6', 100)] },
    { id: 'horizontal', label: 'Horizontal Gradient', type: 'linear', angle: 0, stops: [S('#f97316', 0), S('#facc15', 100)] },
    { id: 'vertical', label: 'Vertical Gradient', type: 'linear', angle: 90, stops: [S('#22c55e', 0), S('#0ea5e9', 100)] },
    { id: 'radial', label: 'Radial Gradient', type: 'radial', angle: 0, stops: [S('#f472b6', 0), S('#7c3aed', 100)] },
    { id: 'multi', label: 'Multi-Color Gradient', type: 'linear', angle: 45, stops: [S('#ef4444', 0), S('#f59e0b', 33), S('#10b981', 66), S('#3b82f6', 100)] },
    { id: 'duotone', label: 'Duotone Gradient', type: 'linear', angle: 45, stops: [S('#7c3aed', 0), S('#7c3aed', 50), S('#06b6d4', 50), S('#06b6d4', 100)] }
  ];

  /**
   * One gradient editor, mounted in `root`. `prefix` is added to the ids in its markup, so an editor can share the
   * page with another one. `jq` is the real jQuery; inside, `$` only looks in `root`.
   */
  function createEditor(root, prefix, jq) {
    const scope = function (sel) { return String(sel).replace(/#gsi/g, '#' + prefix + 'gsi'); };
    const $ = function (sel) {
      if (sel === document) return { on: function (evt, s, fn) { return jq(root).on(evt, scope(s), fn); } };
      return typeof sel === 'string' ? jq(root).find(scope(sel)) : jq(sel);
    };
    $.trim = jq.trim;

  const state = {
    loaded: false,
    root: null,          // sanitised SVG element (never shown or edited directly; the original file is untouched)
    original: '',        // serialised sanitised SVG, used for the "Original" previews
    targets: [],         // [{ index, fill, stroke }] indexes into the shape list of root
    baseName: 'icon',
    gid: '',
    preset: 'linear',
    type: 'linear',
    angle: 45,
    opacity: 100,
    stops: [],
    size: 64,
    output: '',
    nameTouched: false,
    busy: false
  };

  function presetById(id) { return PRESETS.filter(function (x) { return x.id === id; })[0] || PRESETS[0]; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function toast(m) { if (SF.showToast) SF.showToast(m); }
  function setStatus(msg, kind) {
    $('#gsiStatus').text(msg || '').toggleClass('is-error', kind === 'error')
      .toggleClass('is-success', kind === 'success').toggleClass('is-loading', kind === 'loading');
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── sanitising ─────────────────────────────────────────────────────────
  function unsafeValue(v) {
    if (/javascript:|vbscript:|expression\s*\(|@import/i.test(v)) return true;
    const urls = v.match(/url\(\s*['"]?[^'")]*/gi) || [];
    return urls.some(function (u) {
      const inner = u.replace(/^url\(\s*['"]?/i, '');
      return !(inner.charAt(0) === '#' || /^data:image\/(png|jpe?g|gif|webp);/i.test(inner));
    });
  }

  /** Parses the uploaded text, removes active content and returns the root <svg> element. Throws on invalid input. */
  function sanitise(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This file is not a valid SVG.');
    const root = doc.documentElement;
    if (!root || root.localName.toLowerCase() !== 'svg') throw new Error('This file is not a valid SVG.');

    Array.prototype.slice.call(root.getElementsByTagName('*')).forEach(function (el) {
      const name = el.localName.toLowerCase();
      if (BAD_ELEMENTS.indexOf(name) >= 0) { el.remove(); return; }
      if (name === 'style' && unsafeValue(el.textContent || '')) { el.remove(); return; }
      if (ANIMATE_ELEMENTS.indexOf(name) >= 0 && /^(xlink:)?href$|^on/i.test(el.getAttribute('attributeName') || '')) { el.remove(); return; }
      Array.prototype.slice.call(el.attributes).forEach(function (a) {
        const attr = a.name.toLowerCase();
        if (attr.indexOf('on') === 0) { el.removeAttribute(a.name); return; }
        if (attr === 'href' || attr === 'xlink:href') {
          if (!SAFE_REF.test(a.value.trim())) el.removeAttribute(a.name);
          return;
        }
        if (unsafeValue(a.value)) el.removeAttribute(a.name);
      });
    });

    if (!root.getAttribute('viewBox')) {
      const w = parseFloat(root.getAttribute('width')), h = parseFloat(root.getAttribute('height'));
      root.setAttribute('viewBox', (w > 0 && h > 0) ? '0 0 ' + w + ' ' + h : '0 0 24 24');
    }
    return root;
  }

  function shapeList(root) {
    return Array.prototype.filter.call(root.getElementsByTagName('*'), function (el) {
      return SHAPES.indexOf(el.localName.toLowerCase()) >= 0 && !insideSkipped(el, root);
    });
  }
  function insideSkipped(el, root) {
    for (let n = el.parentNode; n && n !== root; n = n.parentNode) {
      if (n.localName && SKIP_ANCESTORS.indexOf(n.localName.toLowerCase()) >= 0) return true;
    }
    return false;
  }

  /** Works out which shapes take a fill and which take a stroke, using computed styles on a measuring copy. */
  function findTargets(root) {
    const copy = document.importNode(root, true);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:24px;height:24px;visibility:hidden;pointer-events:none';
    host.appendChild(copy);
    document.body.appendChild(host);
    const copyShapes = shapeList(copy);
    // Style blocks are removed from the measuring copy so their rules cannot leak into the page.
    Array.prototype.slice.call(copy.getElementsByTagName('style')).forEach(function (s) { s.remove(); });

    const targets = [];
    copyShapes.forEach(function (el, i) {
      const cs = window.getComputedStyle(el);
      const fill = cs.fill !== 'none';
      const stroke = cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0;
      if (fill || stroke) targets.push({ index: i, fill: fill, stroke: stroke });
    });
    host.remove();
    return { targets: targets };
  }

  // ── colour helpers ─────────────────────────────────────────────────────
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(c) {
    return '#' + c.map(function (v) { return ('0' + Math.round(clamp(v, 0, 255)).toString(16)).slice(-2); }).join('');
  }
  function mix(a, b) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return rgbToHex([0, 1, 2].map(function (i) { return (x[i] + y[i]) / 2; }));
  }

  // ── output ─────────────────────────────────────────────────────────────
  function linearCoords(vb) {
    const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
    const rad = state.angle * Math.PI / 180;
    const dx = Math.cos(rad), dy = Math.sin(rad);
    const half = (Math.abs(dx) * vb[2] + Math.abs(dy) * vb[3]) / 2;
    return { x1: cx - dx * half, y1: cy - dy * half, x2: cx + dx * half, y2: cy + dy * half };
  }

  function buildOutput() {
    const out = state.root.cloneNode(true);
    const doc = out.ownerDocument;
    const vb = out.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
    if (!out.hasAttribute('xmlns')) out.setAttribute('xmlns', SVG_NS);

    const gradTag = state.type === 'radial' ? 'radialGradient' : 'linearGradient';
    const grad = doc.createElementNS(SVG_NS, gradTag);
    grad.setAttribute('id', state.gid);
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    if (state.type === 'radial') {
      grad.setAttribute('cx', r2(vb[0] + vb[2] / 2));
      grad.setAttribute('cy', r2(vb[1] + vb[3] / 2));
      grad.setAttribute('r', r2(Math.hypot(vb[2], vb[3]) / 2));
    } else {
      const c = linearCoords(vb);
      grad.setAttribute('x1', r2(c.x1)); grad.setAttribute('y1', r2(c.y1));
      grad.setAttribute('x2', r2(c.x2)); grad.setAttribute('y2', r2(c.y2));
    }
    const opacity = r2(state.opacity / 100);
    state.stops.slice().sort(function (a, b) { return a.offset - b.offset; }).forEach(function (s) {
      const stop = doc.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', r2(s.offset) + '%');
      stop.setAttribute('stop-color', s.color);
      // Written only when not fully opaque, so the default markup matches the reference syntax.
      if (opacity !== 1) stop.setAttribute('stop-opacity', opacity);
      grad.appendChild(stop);
    });
    const defs = doc.createElementNS(SVG_NS, 'defs');
    defs.appendChild(grad);
    out.insertBefore(defs, out.firstChild);

    const shapes = shapeList(out);
    const ref = 'url(#' + state.gid + ')';
    state.targets.forEach(function (t) {
      const el = shapes[t.index];
      if (!el) return;
      if (t.fill) { el.setAttribute('fill', ref); setStyleProp(el, 'fill', ref); }
      if (t.stroke) { el.setAttribute('stroke', ref); setStyleProp(el, 'stroke', ref); }
    });

    // Icon content goes in one named group, and a symbol with the source viewBox references it for sprite use.
    const iconId = slug($('#gsiName').val()) || slug(defaultName());
    const group = doc.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', iconId + '-icon');
    for (let n = defs.nextSibling; n;) {
      const next = n.nextSibling;
      group.appendChild(n);
      n = next;
    }
    out.appendChild(group);
    const symbol = doc.createElementNS(SVG_NS, 'symbol');
    symbol.setAttribute('viewBox', out.getAttribute('viewBox'));
    symbol.setAttribute('id', iconId);
    const use = doc.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#' + group.getAttribute('id'));
    symbol.appendChild(use);
    out.appendChild(symbol);
    return prettyPrint(new XMLSerializer().serializeToString(out));
  }

  /** Sets a CSS property inline so it wins over class rules, replacing any existing inline value. */
  function setStyleProp(el, prop, value) {
    const parts = (el.getAttribute('style') || '').split(';').map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s.split(':')[0].trim().toLowerCase() !== prop; });
    parts.push(prop + ': ' + value);
    el.setAttribute('style', parts.join('; '));
  }

  /** Re-indents serialised markup, two spaces per level. Text nodes stay on their tag's line. */
  function prettyPrint(xml) {
    const tokens = xml.match(/<[^>]+>|[^<]+/g) || [];
    const lines = [];
    let depth = 0, lastWasText = false;
    tokens.forEach(function (tok) {
      if (tok.charAt(0) !== '<') {
        const t = tok.trim();
        if (t) { lines[lines.length - 1] = (lines[lines.length - 1] || '') + t; lastWasText = true; }
        return;
      }
      const closing = /^<\//.test(tok);
      const selfClosing = /\/>$/.test(tok) || /^<[?!]/.test(tok);
      if (closing) depth = Math.max(0, depth - 1);
      if (closing && lastWasText) {
        lines[lines.length - 1] += tok;
      } else {
        lines.push(new Array(depth + 1).join('  ') + tok);
      }
      if (!closing && !selfClosing) depth++;
      lastWasText = false;
    });
    return lines.join('\n');
  }

  // ── code highlighting ──────────────────────────────────────────────────
  function highlight(code) {
    const re = /<!--[\s\S]*?-->|<\/?[\w:.-]+|\/?>|[\w:.-]+(?=\s*=)|"[^"]*"|'[^']*'/g;
    let html = '', last = 0, m;
    while ((m = re.exec(code))) {
      html += escHtml(code.slice(last, m.index));
      const tok = m[0];
      let cls = '';
      if (tok.indexOf('<!--') === 0) cls = 'c';
      else if (tok.charAt(0) === '<' || tok.charAt(0) === '/' || tok.charAt(0) === '>') cls = 't';
      else if (tok.charAt(0) === '"' || tok.charAt(0) === "'") cls = 's';
      else cls = 'a';
      html += '<span class="gsi-tok-' + cls + '">' + escHtml(tok) + '</span>';
      last = m.index + tok.length;
    }
    return html + escHtml(code.slice(last));
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function dataUri(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function cssGradient(preset) {
    const stops = preset.stops.map(function (s) { return s.color + ' ' + s.offset + '%'; }).join(', ');
    return preset.type === 'radial'
      ? 'radial-gradient(circle, ' + stops + ')'
      : 'linear-gradient(' + (preset.angle + 90) + 'deg, ' + stops + ')';
  }

  function renderPresets() {
    $('#gsiPresets').html(PRESETS.map(function (pr) {
      const on = pr.id === state.preset;
      return '<button type="button" class="gsi-preset' + (on ? ' is-active' : '') + '" data-preset="' + pr.id + '" aria-pressed="' + on + '">' +
        '<span class="gsi-swatch" style="background: ' + cssGradient(pr) + '"></span>' +
        '<span class="gsi-preset-label">' + escHtml(pr.label) + '</span></button>';
    }).join(''));
  }

  function renderStops() {
    const canRemove = state.stops.length > MIN_STOPS;
    $('#gsiAddStop').prop('disabled', !state.loaded || state.stops.length >= MAX_STOPS);
    $('#gsiStops').html(state.stops.map(function (s, i) {
      return '<div class="gsi-stop" data-index="' + i + '">' +
        '<input type="color" class="gsi-color" value="' + s.color + '" aria-label="Stop ' + (i + 1) + ' colour">' +
        '<input type="range" class="gsi-range gsi-offset-range" min="0" max="100" step="1" value="' + r2(s.offset) + '" aria-label="Stop ' + (i + 1) + ' position">' +
        '<input type="number" class="gsi-input gsi-num gsi-offset-num" min="0" max="100" step="1" value="' + r2(s.offset) + '" aria-label="Stop ' + (i + 1) + ' position in percent">' +
        '<button type="button" class="btn btn-ghost btn-sm gsi-remove-stop" aria-label="Remove stop ' + (i + 1) + '"' + (canRemove && state.loaded ? '' : ' disabled') + '>×</button>' +
        '</div>';
    }).join(''));
  }

  function renderCustomControls() {
    const radial = state.type === 'radial';
    $('#gsiAngleRow').toggleClass('hidden', radial);
    $('#gsiAngle').val(state.angle);
    $('#gsiAngleNum').val(state.angle);
    $('#gsiOpacity').val(state.opacity);
    $('#gsiOpacityNum').val(state.opacity);
    renderPresets();
    renderStops();
  }

  function renderPreview() {
    const has = state.loaded;
    $('#gsiEmpty').toggleClass('hidden', has);
    $('#gsiCompare').toggleClass('hidden', !has);
    $('#gsiCopy, #gsiDownload, #gsiAddLib').prop('disabled', !has);
    $('#gsiName').prop('disabled', !has);
    $('#gsiMain').toggleClass('is-locked', !has);
    if (!has) {
      ['#gsiImgOrigLight', '#gsiImgOrigDark', '#gsiImgGradLight', '#gsiImgGradDark'].forEach(function (id) { $(id).attr('src', ''); });
      $('#gsiCode').html('');
      return;
    }
    const orig = dataUri(state.original), grad = dataUri(state.output);
    $('#gsiImgOrigLight, #gsiImgOrigDark').attr('src', orig);
    $('#gsiImgGradLight, #gsiImgGradDark').attr('src', grad);
    $('#gsiCode').html(highlight(state.output));
    setPreviewSize();
  }

  function setPreviewSize() {
    const el = $('#gsiCompare')[0];
    if (el) el.style.setProperty('--gsi-size', state.size + 'px');
  }

  /** Rebuilds the output from current settings and refreshes everything that depends on it. */
  function update() {
    if (!state.loaded) return;
    state.output = buildOutput();
    renderPreview();
  }

  function defaultName() {
    return state.baseName + '-' + state.preset + '-gradient';
  }

  /** Lowercase id-safe form of a name: letters, digits, "-" and "_". */
  function slug(text) {
    return String(text || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function applyPreset(id) {
    const pr = presetById(id);
    state.preset = pr.id;
    state.type = pr.type;
    state.angle = pr.angle;
    state.stops = clone(pr.stops);
    if (!state.nameTouched) $('#gsiName').val(defaultName());
    renderCustomControls();
  }

  // ── loading a file ────────────────────────────────────────────────────
  function safeBase(filename) {
    const base = String(filename || 'icon').replace(/\.svg$/i, '').toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return base || 'icon';
  }

  function loadText(text, filename) {
    let root;
    try {
      root = sanitise(text);
    } catch (e) {
      setStatus(e.message || 'This file is not a valid SVG.', 'error');
      return;
    }
    const found = findTargets(root);
    if (!found.targets.length) {
      setStatus('No filled or stroked shapes were found in this SVG.', 'error');
      return;
    }
    state.root = root;
    state.original = new XMLSerializer().serializeToString(root);
    state.targets = found.targets;
    state.baseName = safeBase(filename);
    state.gid = 'gsi-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    state.loaded = true;
    state.nameTouched = false;
    state.opacity = 100;
    $('#gsiFileName').text(filename);
    $('#gsiFileRow').removeClass('hidden');
    $('#gsiDrop').addClass('is-loaded');
    applyPreset('linear');
    $('#gsiName').val(defaultName());
    update();
    setStatus('Loaded ' + filename + '. ' + found.targets.length + ' shape(s) will take the gradient.', 'success');
  }

  function readFile(file) {
    if (!file) return;
    const isSvg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
    if (!isSvg) { setStatus('Only .svg files are supported.', 'error'); return; }
    if (file.size > MAX_BYTES) { setStatus('This file is larger than 1 MB.', 'error'); return; }
    setStatus('Reading ' + file.name + '…', 'loading');
    const reader = new FileReader();
    reader.onload = function () { loadText(String(reader.result || ''), file.name); };
    reader.onerror = function () { setStatus('The file could not be read.', 'error'); };
    reader.readAsText(file);
  }

  function resetUpload() {
    Object.assign(state, { loaded: false, root: null, original: '', targets: [], output: '', gid: '', nameTouched: false, opacity: 100 });
    $('#gsiFileRow').addClass('hidden');
    $('#gsiDrop').removeClass('is-loaded');
    $('#gsiName').val('');
    setStatus('', null);
    applyPreset('linear');
    renderPreview();
  }

  // ── actions ───────────────────────────────────────────────────────────
  function nameError(name) {
    if (!name) return 'Give the icon a name.';
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) return 'Use letters, numbers, "-" and "_" only.';
    return '';
  }

  function saveFile(name, svg) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = (safeBase(name) || 'icon') + '.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function addToLibrary() {
    const name = $.trim($('#gsiName').val());
    const err = nameError(name);
    if (!state.loaded || state.busy) return;
    if (err) { setStatus(err, 'error'); return; }
    if (typeof SF.savePersonalIcon !== 'function') { setStatus('Saving is not available right now.', 'error'); return; }
    state.busy = true;
    setStatus('Saving to your Icon Library…', 'loading');
    SF.savePersonalIcon(name, state.output, presetById(state.preset).label).then(function (res) {
      state.busy = false;
      if (res && res.success === false) { setStatus(res.message || 'Could not save the icon.', 'error'); return; }
      setStatus('Saved "' + name + '" to your Icon Library.', 'success');
      toast('Saved to Icon Library');
    }, function (msg) {
      state.busy = false;
      setStatus(typeof msg === 'string' ? msg : 'Could not save the icon.', 'error');
    });
  }

  function addStop() {
    if (state.stops.length >= MAX_STOPS) return;
    const sorted = state.stops.slice().sort(function (a, b) { return a.offset - b.offset; });
    let at = 0, gap = -1;
    for (let i = 0; i < sorted.length - 1; i++) {
      const g = sorted[i + 1].offset - sorted[i].offset;
      if (g > gap) { gap = g; at = i; }
    }
    const a = sorted[at], b = sorted[at + 1] || sorted[at];
    state.stops.push(S(mix(a.color, b.color), r2((a.offset + b.offset) / 2)));
    renderStops();
    update();
  }

  function setAngle(v) {
    const n = clamp(Math.round(Number(v) || 0), 0, 360);
    state.angle = n;
    $('#gsiAngle').val(n);
    $('#gsiAngleNum').val(n);
    if (!state.nameTouched) $('#gsiName').val(defaultName());
    update();
  }

  function setOpacity(v) {
    const n = clamp(Math.round(Number(v) || 0), 0, 100);
    state.opacity = n;
    $('#gsiOpacity').val(n);
    $('#gsiOpacityNum').val(n);
    update();
  }

  function bindEvents() {
      renderPresets();
      renderStops();
      renderPreview();

      const $drop = $('#gsiDrop');
      $(document).on('click', '#gsiDrop', function () { $('#gsiFile').trigger('click'); });
      $(document).on('keydown', '#gsiDrop', function (e) {
        if (e.target === this && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('#gsiFile').trigger('click'); }
      });
      $(document).on('change', '#gsiFile', function () {
        const file = this.files && this.files[0];
        this.value = '';
        readFile(file);
      });
      $(document).on('dragenter dragover', '#gsiDrop', function (e) {
        e.preventDefault();
        $drop.addClass('is-over');
      });
      $(document).on('dragleave dragend', '#gsiDrop', function () { $drop.removeClass('is-over'); });
      $(document).on('drop', '#gsiDrop', function (e) {
        e.preventDefault();
        $drop.removeClass('is-over');
        const files = e.originalEvent && e.originalEvent.dataTransfer ? e.originalEvent.dataTransfer.files : null;
        readFile(files && files[0]);
      });
      $(document).on('click', '#gsiRemove', resetUpload);

      $(document).on('click', '#gsiPresets .gsi-preset', function () {
        if (!state.loaded) return;
        applyPreset($(this).data('preset'));
        update();
      });
      $(document).on('click', '#gsiReset', function () {
        if (!state.loaded) return;
        applyPreset(state.preset);
        state.opacity = 100;
        renderCustomControls();
        update();
      });

      $(document).on('input', '#gsiAngle, #gsiAngleNum', function () { setAngle(this.value); });
      $(document).on('input', '#gsiOpacity, #gsiOpacityNum', function () { setOpacity(this.value); });

      $(document).on('input', '#gsiStops .gsi-color', function () {
        const i = +$(this).closest('.gsi-stop').data('index');
        if (state.stops[i]) { state.stops[i].color = this.value; update(); }
      });
      $(document).on('input', '#gsiStops .gsi-offset-range, #gsiStops .gsi-offset-num', function () {
        const $row = $(this).closest('.gsi-stop');
        const i = +$row.data('index');
        const v = clamp(Math.round(Number(this.value) || 0), 0, 100);
        if (!state.stops[i]) return;
        state.stops[i].offset = v;
        $row.find('.gsi-offset-range').val(v);
        $row.find('.gsi-offset-num').val(v);
        update();
      });
      $(document).on('click', '#gsiStops .gsi-remove-stop', function () {
        const i = +$(this).closest('.gsi-stop').data('index');
        if (state.stops.length <= MIN_STOPS) return;
        state.stops.splice(i, 1);
        renderStops();
        update();
      });
      $(document).on('click', '#gsiAddStop', addStop);

      $(document).on('click', '.gsi-size', function () {
        state.size = +$(this).data('size');
        $('.gsi-size').removeClass('is-active');
        $(this).addClass('is-active');
        setPreviewSize();
      });
      $('.gsi-size[data-size="' + state.size + '"]').addClass('is-active');

      $(document).on('input', '#gsiName', function () {
        state.nameTouched = !!$.trim(this.value);
        const err = state.loaded && $.trim(this.value) ? nameError($.trim(this.value)) : '';
        setStatus(err, err ? 'error' : null);
        if (!err && state.loaded) update();
      });
      $(document).on('click', '#gsiCopy', function () {
        if (!state.loaded || !navigator.clipboard || !navigator.clipboard.writeText) return;
        navigator.clipboard.writeText(state.output).then(function () { toast('SVG code copied'); }, function () { toast('Copy failed'); });
      });
      $(document).on('click', '#gsiDownload', function () {
        if (!state.loaded) return;
        saveFile($.trim($('#gsiName').val()) || state.baseName + '-gradient', state.output);
      });
      $(document).on('click', '#gsiAddLib', addToLibrary);

}

  return { load: loadText, bind: bindEvents };
  }

  // ── the page ────────────────────────────────────────────────────────────
  // Same pattern as combine-icons.js.
  const origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    $('#gradientSvgPage').addClass('hidden');
    $('#gradientSvgBtn').removeClass('active');
    if (page !== PAGE) return origSwitch(page);

    origSwitch('mostused');
    $('#mostUsedPage').addClass('hidden');
    $('#mostUsedBtn').removeClass('active');
    SF.state.page = PAGE;
    try { localStorage.setItem('sf_active_page', PAGE); } catch (e) {}
    $('#gradientSvgPage').removeClass('hidden');
    $('#gradientSvgBtn').addClass('active');
    $('#pageTitle').text('Gradient svg icons');
    $('#pageBreadcrumb').text('Tools');
  };

  /**
   * Mounts a gradient editor (the page's markup and logic) inside `container`, loaded with `svgText`.
   * Used by the Library preview popup. Its element ids get a "lvm-" prefix, so they never clash with the page's.
   */
  SF.mountGradientEditor = function (container, svgText, name) {
    return fetch('components/templates/svg-gradient-svg-icons.html?v=1').then(function (r) { return r.text(); }).then(function (html) {
      const prefix = 'lvm-';
      const markup = $('<div>').html(html).find('.gsi')[0].outerHTML
        .replace(/\b(id|for)="gsi/g, '$1="' + prefix + 'gsi');
      $(container).off().empty().html(markup);
      const editor = createEditor(container, prefix, $);
      editor.bind();
      editor.load(svgText, (name || 'icon') + '.svg');
    });
  };

  $(function () {
    Promise.all(window._componentPromises || []).then(function () {
      if (!$('#gradientSvgPage').length) return;
      const page = createEditor($('#gradientSvgPage')[0], '', $);
      page.bind();

      $('#gradientSvgBtn').on('click', function () { SF.switchPage(PAGE); });

      let last = null;
      try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
      if (last === PAGE) setTimeout(function () { SF.switchPage(PAGE); }, 0);
    });
  });
})(window.SpriteForge, jQuery);
