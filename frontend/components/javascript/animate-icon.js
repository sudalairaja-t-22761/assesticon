/**
 * SpriteForge - Animate icon: give an Icon Library icon (or single parts of it) a CSS animation and add the result
 * to the Library as a new icon.
 *
 * Flow: pick an icon → choose "Whole icon" or one of its parts → apply a preset (spin, pulse, bounce, shake, swing,
 * fade, blink, slide in, pop in, draw line) or build a Custom one → tune duration / delay / easing / pivot / loop,
 * and edit the steps of the animation with sliders (move, size, rotate, opacity) → preview → name it →
 * "Add to Icon Library" (the Library's own Add icon step, shared with combine-icons.js).
 *
 * The icon is read the same way as on the Combine icons page (SF.combineIcons.analyse): every shape becomes one
 * <path> in the icon's own viewBox with sprite classes and variables already resolved, so a part is simply a path.
 * The animation is plain CSS inside the SVG: one <style> with the @keyframes and one rule per animated part.
 * Class and keyframe names carry a per-icon prefix (two animated icons in one sprite cannot clash) and a
 * prefers-reduced-motion rule switches the animation off.
 */
(function (SF, $) {
  'use strict';

  var PAGE = 'animateicon';
  var PRESETS = [
    { key: 'spin',   label: 'Spin',       dur: 1.2, ease: 'linear',      loop: true,  pivot: true },
    { key: 'pulse',  label: 'Pulse',      dur: 1,   ease: 'ease-in-out', loop: true,  pivot: true },
    { key: 'bounce', label: 'Bounce',     dur: 0.8, ease: 'ease-in-out', loop: true },
    { key: 'shake',  label: 'Shake',      dur: 0.6, ease: 'linear',      loop: true },
    { key: 'swing',  label: 'Swing',      dur: 1,   ease: 'ease-in-out', loop: true,  pivot: true, origin: 'top' },
    { key: 'fade',   label: 'Fade',       dur: 1.4, ease: 'ease-in-out', loop: true },
    { key: 'blink',  label: 'Blink',      dur: 1,   ease: 'linear',      loop: true },
    { key: 'slidex', label: 'Slide in →', dur: 0.5, ease: 'ease-out',    loop: false },
    { key: 'slidey', label: 'Slide in ↑', dur: 0.5, ease: 'ease-out',    loop: false },
    { key: 'pop',    label: 'Pop in',     dur: 0.4, ease: 'ease-out',    loop: false, pivot: true },
    { key: 'draw',   label: 'Draw line',  dur: 1.2, ease: 'ease-in-out', loop: false, strokeOnly: true },
    { key: 'custom', label: 'Custom',     dur: 1,   ease: 'ease-in-out', loop: true,  pivot: true }
  ];
  // Custom steps: what a part looks like at a moment of the animation. x / y are % of the icon's width / height,
  // s (size) and o (opacity) are %, r is degrees. Every preset except Draw line can be edited as steps.
  var FIELDS = [
    { f: 'x', label: 'Move ↔', min: -100, max: 100, step: 1, unit: '%' },
    { f: 'y', label: 'Move ↕', min: -100, max: 100, step: 1, unit: '%' },
    { f: 's', label: 'Size', min: 0, max: 300, step: 1, unit: '%' },
    { f: 'r', label: 'Rotate', min: -360, max: 360, step: 5, unit: '°' },
    { f: 'o', label: 'Opacity', min: 0, max: 100, step: 1, unit: '%' }
  ];
  var MAX_STEPS = 8;
  function step(at, v) { return $.extend({ at: at, x: 0, y: 0, s: 100, r: 0, o: 100 }, v || {}); }
  /** The steps a preset is made of (null: not editable as steps). */
  function presetSteps(key) {
    switch (key) {
      case 'spin':   return [step(0), step(100, { r: 360 })];
      case 'pulse':  return [step(0), step(50, { s: 118 }), step(100)];
      case 'bounce': return [step(0), step(50, { y: -15 }), step(100)];
      case 'shake':  return [step(0), step(20, { x: -6 }), step(40, { x: 6 }), step(60, { x: -6 }), step(80, { x: 6 }), step(100)];
      case 'swing':  return [step(0), step(25, { r: 14 }), step(75, { r: -14 }), step(100)];
      case 'fade':   return [step(0), step(50, { o: 20 }), step(100)];
      case 'blink':  return [step(0), step(45), step(50, { o: 0 }), step(95, { o: 0 }), step(100)];
      case 'slidex': return [step(0, { x: -40, o: 0 }), step(100)];
      case 'slidey': return [step(0, { y: 40, o: 0 }), step(100)];
      case 'pop':    return [step(0, { s: 0, o: 0 }), step(70, { s: 115 }), step(100)];
      case 'custom': return [step(0), step(100)];
    }
    return null;
  }
  var ORIGINS = { center: '50% 50%', top: '50% 0%', bottom: '50% 100%', left: '0% 50%', right: '100% 50%',
    'top left': '0% 0%', 'top right': '100% 0%', 'bottom left': '0% 100%', 'bottom right': '100% 100%' };
  var EASES = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'];

  var cur = null;            // { icon, name, box, shapes:[{d, attrs, stroke}], dropped, prefix }
  var anims = {};            // part key ('all' | '0' | '1' …) → { preset, dur, delay, ease, origin, loop, alt }
  var sel = 'all';           // selected part key
  var playing = true, hot = null;
  var stepSel = 0;           // step shown in the sliders
  var frozen = false;        // the selected part stands still in the pose of that step (while it is edited)
  var nameTouched = false, addedName = '', busy = false, token = 0;
  var stageRoot = null, previewTimer = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function C() { return SF.combineIcons; }
  function P() { return SF.libPreview; }
  function icons() { return ((SF.libState && SF.libState.icons) || []).filter(Boolean); }
  function baseName(icon) { return P() ? P().baseName(icon) : String(icon.name || ''); }
  function toast(m) { if (SF.showToast) SF.showToast(m); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
  function presetOf(key) { return PRESETS.filter(function (p) { return p.key === key; })[0] || null; }
  function keys() { return ['all'].concat(cur ? cur.shapes.map(function (s, i) { return String(i); }) : []); }
  function partLabel(k) { return k === 'all' ? 'Whole icon' : 'Part ' + (+k + 1); }
  function animated() { return keys().filter(function (k) { return !!anims[k]; }); }

  // ── animation CSS ────────────────────────────────────────────────────
  function pathLength(d) {
    var ns = C().svgNs, svg = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path'), len = 0;
    svg.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;visibility:hidden';
    p.setAttribute('d', d);
    svg.appendChild(p);
    document.body.appendChild(svg);
    try { len = p.getTotalLength(); } catch (e) { len = 0; }
    svg.remove();
    return Math.ceil(len * 100) / 100 || 1;
  }
  /** Keyframes of a preset. Distances are in the icon's own units, so they scale with the icon. */
  function frames(key, box, len) {
    var by = r2(box.h * 0.15), sx = r2(box.w * 0.06), dx = r2(box.w * 0.4), dy = r2(box.h * 0.4);
    switch (key) {
      case 'spin':   return 'to{transform:rotate(360deg)}';
      case 'pulse':  return '0%,100%{transform:scale(1)}50%{transform:scale(1.18)}';
      case 'bounce': return '0%,100%{transform:translateY(0)}50%{transform:translateY(-' + by + 'px)}';
      case 'shake':  return '0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-' + sx + 'px)}40%,80%{transform:translateX(' + sx + 'px)}';
      case 'swing':  return '0%,100%{transform:rotate(0deg)}25%{transform:rotate(14deg)}75%{transform:rotate(-14deg)}';
      case 'fade':   return '0%,100%{opacity:1}50%{opacity:.2}';
      case 'blink':  return '0%,45%{opacity:1}50%,95%{opacity:0}100%{opacity:1}';
      case 'slidex': return 'from{transform:translateX(-' + dx + 'px);opacity:0}to{transform:translateX(0);opacity:1}';
      case 'slidey': return 'from{transform:translateY(' + dy + 'px);opacity:0}to{transform:translateY(0);opacity:1}';
      case 'pop':    return 'from{transform:scale(0);opacity:0}70%{transform:scale(1.15);opacity:1}to{transform:scale(1);opacity:1}';
      case 'draw':   return 'from{stroke-dashoffset:' + len + '}to{stroke-dashoffset:0}';
    }
    return '';
  }
  function stepCss(st, box) {
    return 'transform:translate(' + r2(st.x * box.w / 100) + 'px,' + r2(st.y * box.h / 100) + 'px) rotate(' + r2(st.r) + 'deg) scale(' + r2(st.s / 100) + ');opacity:' + r2(st.o / 100);
  }
  function stepFrames(steps, box) {
    return steps.map(function (st) { return r2(st.at) + '%{' + stepCss(st, box) + '}'; }).join('');
  }
  function stepsOf(A) { return A ? (A.steps || presetSteps(A.preset)) : null; }
  function stepIndex(A) { var n = (stepsOf(A) || []).length; return Math.max(0, Math.min(stepSel, n - 1)); }
  function cls(k) { return cur.prefix + '-' + (k === 'all' ? 'all' : 'p' + k); }

  /**
   * The animated icon as one standalone SVG ('' while no icon is picked).
   * stage: also mark every path with data-part (for clicking / highlighting on the stage).
   */
  function buildSvg(stage) {
    if (!cur) return '';
    var b = cur.box, css = '', seen = {}, used = [];
    animated().forEach(function (k) {
      var A = anims[k], pre = presetOf(A.preset), shape = k === 'all' ? null : cur.shapes[+k];
      var draw = A.preset === 'draw', own = draw || !!A.steps, len = 0;
      var name = cur.prefix + '-' + (A.steps ? 'c' : A.preset) + (own ? k : '');
      if (draw) { if (!shape.len) shape.len = pathLength(shape.d); len = shape.len; }
      var pivot = 'transform-box:fill-box;transform-origin:' + (ORIGINS[(pre && pre.pivot) || A.steps ? A.origin : 'center'] || ORIGINS.center);
      if (stage && frozen && k === sel && A.steps) {
        // a step is being edited: the part stands still in that step's pose
        css += '.' + cls(k) + '{' + pivot + ';' + stepCss(A.steps[stepIndex(A)], b) + '}';
        return;
      }
      if (!seen[name]) { seen[name] = true; css += '@keyframes ' + name + '{' + (A.steps ? stepFrames(A.steps, b) : frames(A.preset, b, len)) + '}'; }
      var transforms = !!A.steps || !/^(fade|blink|draw)$/.test(A.preset);
      css += '.' + cls(k) + '{animation:' + name + ' ' + r2(A.dur) + 's ' + A.ease + ' ' + r2(A.delay) + 's ' +
        (A.loop ? 'infinite' : '1') + (A.alt ? ' alternate' : '') + ' both' + (transforms ? ';' + pivot : '') +
        // A fixed-width (non-scaling) stroke measures its dashes on screen, so the line would not draw fully at
        // other sizes: the drawn part gets a normal stroke (same width at the icon's own size).
        (draw ? ';stroke-dasharray:' + len + (shape.nss ? ';vector-effect:none' : '') : '') + '}';
      used.push('.' + cls(k));
    });
    if (used.length) css += '@media (prefers-reduced-motion:reduce){' + used.join(',') + '{animation:none}}';
    var paths = cur.shapes.map(function (s, i) {
      return '<path' + (anims[i] ? ' class="' + cls(String(i)) + '"' : '') + (stage ? ' data-part="' + i + '"' : '') + ' d="' + s.d + '"' + s.attrs + '/>';
    }).join('');
    return '<svg xmlns="' + C().svgNs + '" viewBox="' + [b.x, b.y, b.w, b.h].map(r2).join(' ') + '" width="' + r2(b.w) + '" height="' + r2(b.h) + '">' +
      (css ? '<style>' + css + '</style>' : '') + (anims.all ? '<g class="' + cls('all') + '">' + paths + '</g>' : paths) + '</svg>';
  }

  // ── stage ────────────────────────────────────────────────────────────
  function drawStage() {
    var host = document.getElementById('aniStage');
    if (!host) return;
    if (!stageRoot) {
      stageRoot = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      stageRoot.addEventListener('click', function (e) {
        var t = e.target, k = t && t.getAttribute ? t.getAttribute('data-part') : null;
        if (k != null) select(k);
      });
    }
    $(host).toggleClass('is-empty', !cur);
    if (!cur) { stageRoot.innerHTML = '<span>Pick an icon to start</span>'; return; }
    var dim = hot != null && hot !== 'all' ? '[data-part]:not([data-part="' + hot + '"]){opacity:.15 !important}' : '';
    stageRoot.innerHTML = '<style>svg{display:block;width:100%;height:100%;overflow:visible;fill:currentColor}[data-part]{cursor:pointer}' +
      'path{vector-effect:none}' +   // fixed-width strokes as they look at the icon's real size, not hairlines on the big stage
      '</style><style id="dim">' + dim + '</style><style id="pause">' +
      // while a step is edited nothing else moves either, so the pose is judged against a still icon
      (frozen ? '*{animation:none !important}' : playing ? '' : pauseCss()) + '</style>' + buildSvg(true);
  }
  function pauseCss() { return '*{animation-play-state:paused !important}'; }
  /** Highlight one part without restarting the animation. */
  function setHot(k) {
    hot = k;
    var el = stageRoot && stageRoot.querySelector('#dim');
    if (el) el.textContent = k != null && k !== 'all' ? '[data-part]:not([data-part="' + k + '"]){opacity:.15 !important}' : '';
  }
  function setPlaying(on) {
    playing = on;
    var el = stageRoot && stageRoot.querySelector('#pause');
    if (el) el.textContent = on ? '' : pauseCss();
    $('#aniPlay').text(on ? 'Pause' : 'Play');
  }

  // ── lists and panels ─────────────────────────────────────────────────
  function summary(A) {
    var p = presetOf(A.preset);
    return (p ? p.label : A.preset) + (A.edited && A.preset !== 'custom' ? ' (custom)' : '') + ' · ' + r2(A.dur) + 's' + (A.delay ? ' · +' + r2(A.delay) + 's' : '') + (A.loop ? ' · loop' : ' · once');
  }
  function renderParts() {
    if (!cur) { $('#aniParts').empty(); return; }
    var b = cur.box, vb = [b.x, b.y, b.w, b.h].map(r2).join(' ');
    $('#aniParts').html(keys().map(function (k) {
      var A = anims[k];
      var art = cur.shapes.map(function (s, i) {
        return '<path d="' + s.d + '"' + s.attrs + (k === 'all' || +k === i ? '' : ' opacity="0.15"') + '/>';
      }).join('');
      return '<div class="ani-part' + (sel === k ? ' is-active' : '') + '" role="button" tabindex="0" data-part="' + k + '">' +
        '<span class="ani-part-thumb"><svg viewBox="' + vb + '" aria-hidden="true">' + art + '</svg></span>' +
        '<span class="ani-part-name">' + partLabel(k) + '</span>' +
        '<span class="ani-part-anim' + (A ? '' : ' is-none') + '">' + esc(A ? summary(A) : 'no animation') + '</span>' +
        (A ? '<button type="button" class="ani-part-x" data-clear="' + k + '" title="Remove this animation" aria-label="Remove the animation of ' + partLabel(k) + '">&times;</button>' : '') +
        '</div>';
    }).join(''));
  }
  function setVal(id, v) {
    var el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v;
  }
  function renderControls() {
    var A = cur ? anims[sel] : null, shape = cur && sel !== 'all' ? cur.shapes[+sel] : null, pre = A ? presetOf(A.preset) : null;
    $('#aniTarget').text(cur ? partLabel(sel) : '');
    $('#aniPresets').toggleClass('is-off', !cur).html(
      '<button type="button" class="ani-preset' + (A ? '' : ' is-active') + '" data-preset="">None</button>' +
      PRESETS.map(function (p) {
        var off = p.strokeOnly && !(shape && shape.stroke);
        return '<button type="button" class="ani-preset' + (A && A.preset === p.key ? ' is-active' : '') + '" data-preset="' + p.key + '"' +
          (off ? ' disabled title="Only for a part drawn with a stroke"' : '') + '>' + esc(p.label) + '</button>';
      }).join(''));
    $('#aniTune').toggleClass('is-off', !A);
    setVal('aniDur', A ? r2(A.dur) : ''); setVal('aniDelay', A ? r2(A.delay) : '');
    $('#aniEase').val(A ? A.ease : 'linear');
    $('#aniOrigin').val(A ? A.origin : 'center').prop('disabled', !(pre && (pre.pivot || A.steps)));
    $('#aniLoop').prop('checked', !!(A && A.loop));
    $('#aniAlt').prop('checked', !!(A && A.alt));
    renderSteps();
  }
  // ── custom steps ─────────────────────────────────────────────────────
  function chipLabel(steps, i) { return i === 0 ? 'Start' : i === steps.length - 1 ? 'End' : r2(steps[i].at) + '%'; }
  function fieldText(f, v) { return (f.f === 'x' || f.f === 'y' || f.f === 'r') && v > 0 ? '+' + v + f.unit : v + f.unit; }
  /** Step chips and the sliders of the selected step (rebuilt only when the steps change, never while dragging). */
  function renderSteps() {
    var A = cur ? anims[sel] : null, steps = stepsOf(A);
    $('#aniSteps').toggleClass('hidden', !steps);
    if (!steps) { $('#aniChips, #aniSliders').empty(); return; }
    var i = stepIndex(A), st = steps[i], mid = i > 0 && i < steps.length - 1;
    $('#aniChips').html(steps.map(function (x, n) {
      return '<button type="button" class="ani-chip' + (n === i ? ' is-active' : '') + '" data-step="' + n + '">' + chipLabel(steps, n) + '</button>';
    }).join('') + (steps.length < MAX_STEPS ? '<button type="button" class="ani-chip ani-chip-add" id="aniStepAdd" title="Add a step after the selected one">+ Step</button>' : ''));
    var rows = FIELDS.map(function (f) {
      return '<label class="ani-slider"><span>' + f.label + '</span><input type="range" data-f="' + f.f + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + st[f.f] + '">' +
        '<output data-o="' + f.f + '">' + fieldText(f, st[f.f]) + '</output></label>';
    });
    if (mid) {
      rows.push('<label class="ani-slider"><span>When</span><input type="range" data-f="at" min="' + (steps[i - 1].at + 1) + '" max="' + (steps[i + 1].at - 1) + '" step="1" value="' + st.at + '">' +
        '<output data-o="at">' + r2(st.at) + '%</output></label>');
    }
    $('#aniSliders').html(rows.join('') + '<div class="cmb-btns">' +
      (mid ? '<button type="button" class="btn btn-ghost btn-sm" id="aniStepDel">Remove step</button>' : '') +
      '<button type="button" class="btn btn-ghost btn-sm" id="aniStepReset"' + (A.edited ? '' : ' disabled') + '>Reset steps</button></div>');
  }
  /** The animation's own, editable copy of its steps. */
  function ownSteps(A) {
    if (!A.steps) A.steps = presetSteps(A.preset);
    return A.steps;
  }
  /** After a step value changed: stage, lists and previews — the sliders themselves are left alone. */
  function refresh() {
    drawStage(); renderParts(); syncName();
    if (!previewTimer) previewTimer = setTimeout(renderPreview, 120);
  }
  function freeze(on) {
    frozen = on;
    if (on) $('#aniPlay').text('Play');
    else setPlaying(true);
  }
  function renderResults() {
    var q = $.trim($('#aniSearch').val() || '').toLowerCase(), all = icons();
    var found = q ? all.filter(function (i) { return baseName(i).toLowerCase().indexOf(q) !== -1; }) : all;
    $('#aniPickStatus').text(!all.length ? (libraryLoading() ? 'Loading the Icon Library…' : 'The Icon Library is not loaded yet (sign in to load it).')
      : !found.length ? 'No icon matches "' + q + '".' : found.length + ' icon' + (found.length === 1 ? '' : 's'));
    C().renderTiles(document.getElementById('aniResults'), found, cur ? cur.icon.id : null);
  }
  function renderPreview() {
    previewTimer = 0;
    var svg = buildSvg(false), p = P();
    if (!svg || !p) { $('#aniPreview').empty(); return; }
    $('#aniPreview').html([{ hex: '#313949', dark: false }, { hex: '#FFFFFF', dark: true }].map(function (c) {
      var src = esc(p.dataUri(p.coloredSvg(svg, c)));
      return '<div class="cmb-preview-row' + (c.dark ? ' is-dark' : '') + '">' + [16, 24, 32].map(function (px) {
        return '<img alt="' + px + ' px" title="' + px + ' px" width="' + px + '" height="' + px + '" src="' + src + '">';
      }).join('') + '</div>';
    }).join(''));
  }
  function renderWarn() {
    var warn = [];
    if (cur && cur.dropped) warn.push('Some parts (text, images or reused symbols) could not be read and are left out.');
    $('#aniWarn').html(warn.map(function (w) { return '<div>' + esc(w) + '</div>'; }).join(''));
  }
  function syncName() {
    if (!nameTouched) $('#aniName').val(cur ? (cur.name + '-animated').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : '');
    var name = $.trim($('#aniName').val()), any = animated().length > 0, done = !!addedName && addedName === name;
    var err = done || !cur ? '' : C().nameError(name);
    $('#aniNameStatus').toggleClass('is-error', !!err)
      .text(done ? 'Added to the Icon Library as an unverified icon.' : err || (cur && !any ? 'Apply an animation to add the icon to the Library.' : ''));
    $('#aniAdd').prop('disabled', busy || done || !cur || !any || !!err);
    $('#aniCopy, #aniDownload').prop('disabled', !cur);
    $('#aniClear').prop('disabled', !any);
    $('#aniPlay, #aniRestart').prop('disabled', !cur);
  }
  /** Everything after a change (the stage is rebuilt, so the animation starts again). */
  function render() {
    if (frozen) freeze(false);
    drawStage(); renderParts(); renderControls(); renderWarn(); syncName();
    $('#aniIconName').text(cur ? cur.name : '');
    if (!previewTimer) previewTimer = setTimeout(renderPreview, 120);
  }

  // ── actions ──────────────────────────────────────────────────────────
  function select(k) {
    if (!cur || keys().indexOf(String(k)) === -1) return;
    sel = String(k);
    stepSel = firstStep(anims[sel]);
    if (frozen) { freeze(false); drawStage(); }
    renderParts(); renderControls();
  }
  /** The step to open first: the first one that changes something (the middle of a pulse, the end of a spin). */
  function firstStep(A) {
    var steps = stepsOf(A) || [];
    for (var i = 0; i < steps.length; i++) {
      var x = steps[i];
      if (x.x || x.y || x.r || x.s !== 100 || x.o !== 100) return i;
    }
    return steps.length ? steps.length - 1 : 0;
  }
  function setIcon(icon, svg) {
    var a = C().analyse(icon, svg);
    if (!a) { toast(baseName(icon) + ' has no shapes that can be animated'); return; }
    var fill = false, stroke = false;
    a.shapes.forEach(function (s) { if (s.fill === 'theme') fill = true; if (s.stroke === 'theme') stroke = true; });
    cur = {
      icon: icon, name: baseName(icon), box: a.box, dropped: a.dropped, prefix: 'za' + Date.now().toString(36),
      shapes: a.shapes.map(function (s) { return { d: C().segsToD(s.segs), attrs: C().shapeAttrs(s, 1, fill && stroke), stroke: !!s.stroke, nss: !!s.nss }; })
    };
    anims = {}; sel = 'all'; hot = null; addedName = ''; nameTouched = false; stepSel = 0; frozen = false;
    setPlaying(true);
    $('#aniResults .cmb-tile').each(function () { $(this).toggleClass('is-active', $(this).attr('data-icon-id') === icon.id); });
    render();
  }
  function pick(icon) {
    var mine = ++token;
    C().loadSvg(icon).then(function (svg) { if (mine === token) setIcon(icon, svg); },
      function () { if (mine === token) toast('Could not load the SVG of ' + baseName(icon)); });
  }
  function applyPreset(key) {
    if (!cur) return;
    var p = presetOf(key);
    if (!p) delete anims[sel];
    else {
      var old = anims[sel];
      // a new preset brings its own timing; the delay set for this part is kept
      anims[sel] = { preset: p.key, dur: p.dur, delay: old ? old.delay : 0, ease: p.ease, origin: p.origin || 'center', loop: p.loop, alt: false };
      if (p.key === 'custom') anims[sel].steps = presetSteps('custom');
    }
    stepSel = firstStep(anims[sel]);
    freeze(false);
    addedName = '';
    render();
  }
  function tune(fn) {
    var A = cur && anims[sel];
    if (!A) return;
    fn(A); addedName = '';
    render();
  }
  function numOf(el) { var v = parseFloat(el.value); return isFinite(v) ? v : null; }
  function add() {
    var name = $.trim($('#aniName').val()), svg = buildSvg(false);
    if (!svg || !animated().length || C().nameError(name) || busy) return;
    busy = true; syncName();
    C().confirmAdd(name, svg).then(function (added) {
      busy = false;
      if (added) addedName = name;
      syncName();
    });
  }

  // ── page switching (same pattern as asset-store.js) ──────────────────
  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    $('#animateIconPage').addClass('hidden');
    $('#animateIconBtn').removeClass('active');
    if (page !== PAGE) return origSwitch(page);

    origSwitch('mostused');
    $('#mostUsedPage').addClass('hidden');
    $('#mostUsedBtn').removeClass('active');
    SF.state.page = PAGE;
    try { localStorage.setItem('sf_active_page', PAGE); } catch (e) {}
    $('#animateIconPage').removeClass('hidden');
    $('#animateIconBtn').addClass('active');
    $('#pageTitle').text('Animate icon');
    $('#pageBreadcrumb').text('Library');
    renderResults(); render();
    if (!icons().length && typeof SF.loadRepoLibraryIcons === 'function') {
      $('#aniPickStatus').text('Loading the Icon Library…');
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
      $('#aniEase').html(EASES.map(function (e) { return '<option value="' + e + '">' + e + '</option>'; }).join(''));
      $('#aniOrigin').html(Object.keys(ORIGINS).map(function (o) { return '<option value="' + o + '">' + o + '</option>'; }).join(''));

      $('#animateIconBtn').on('click', function () { SF.switchPage(PAGE); });
      $(document).on('input', '#aniSearch', renderResults);
      $(document).on('click', '#aniResults .cmb-tile', function () {
        var id = $(this).data('iconId'), icon = icons().filter(function (i) { return i.id === id; })[0];
        if (icon) pick(icon);
      });

      $(document).on('click', '#aniParts .ani-part', function (e) {
        if ($(e.target).closest('[data-clear]').length) return;
        select($(this).attr('data-part'));
      });
      $(document).on('keydown', '#aniParts .ani-part', function (e) {
        if (e.target === this && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select($(this).attr('data-part')); }
      });
      $(document).on('mouseenter', '#aniParts .ani-part', function () { setHot($(this).attr('data-part')); });
      $(document).on('mouseleave', '#aniParts .ani-part', function () { setHot(null); });
      $(document).on('click', '#aniParts [data-clear]', function () {
        delete anims[$(this).attr('data-clear')];
        addedName = '';
        render();
      });
      $(document).on('click', '#aniClear', function () { anims = {}; addedName = ''; render(); });

      $(document).on('click', '#aniPresets .ani-preset', function () { applyPreset($(this).attr('data-preset')); });
      $(document).on('input', '#aniDur', function () { var v = numOf(this); if (v != null && v > 0) tune(function (A) { A.dur = clamp(v, 0.1, 20); }); });
      $(document).on('input', '#aniDelay', function () { var v = numOf(this); if (v != null) tune(function (A) { A.delay = clamp(v, 0, 20); }); });
      $(document).on('change', '#aniEase', function () { var v = this.value; if (EASES.indexOf(v) !== -1) tune(function (A) { A.ease = v; }); });
      $(document).on('change', '#aniOrigin', function () { var v = this.value; if (ORIGINS[v]) tune(function (A) { A.origin = v; }); });
      $(document).on('change', '#aniLoop', function () { var on = this.checked; tune(function (A) { A.loop = on; }); });
      $(document).on('change', '#aniAlt', function () { var on = this.checked; tune(function (A) { A.alt = on; }); });

      $(document).on('click', '#aniPlay', function () {
        if (frozen) { freeze(false); drawStage(); } else setPlaying(!playing);
      });
      $(document).on('click', '#aniRestart', function () { freeze(false); drawStage(); renderPreview(); });

      // custom steps
      $(document).on('click', '#aniChips [data-step]', function () {
        var A = cur && anims[sel];
        if (!A) return;
        ownSteps(A);
        stepSel = +$(this).attr('data-step');
        freeze(true);              // show the part in this step's pose
        drawStage(); renderSteps();
      });
      $(document).on('input', '#aniSliders input[type="range"]', function () {
        var A = cur && anims[sel], f = $(this).attr('data-f'), v = parseFloat(this.value);
        if (!A || !isFinite(v)) return;
        var steps = ownSteps(A), i = stepIndex(A);
        steps[i][f] = v;
        A.edited = true; addedName = '';
        var spec = FIELDS.filter(function (x) { return x.f === f; })[0];
        $('#aniSliders [data-o="' + f + '"]').text(spec ? fieldText(spec, v) : r2(v) + '%');
        if (f === 'at') $('#aniChips [data-step="' + i + '"]').text(chipLabel(steps, i));
        $('#aniStepReset').prop('disabled', false);
        freeze(true);
        refresh();
      });
      $(document).on('click', '#aniStepAdd', function () {
        var A = cur && anims[sel];
        if (!A) return;
        var steps = ownSteps(A);
        if (steps.length >= MAX_STEPS) return;
        var i = Math.min(stepIndex(A), steps.length - 2), a = steps[i], b = steps[i + 1];
        if (b.at - a.at < 2) return;
        // halfway between its neighbours, in time and in pose
        var mid = step(Math.round((a.at + b.at) / 2), { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2),
          s: Math.round((a.s + b.s) / 2), r: Math.round((a.r + b.r) / 2), o: Math.round((a.o + b.o) / 2) });
        steps.splice(i + 1, 0, mid);
        stepSel = i + 1; A.edited = true; addedName = '';
        freeze(true);
        refresh(); renderSteps();
      });
      $(document).on('click', '#aniStepDel', function () {
        var A = cur && anims[sel];
        if (!A) return;
        var steps = ownSteps(A), i = stepIndex(A);
        if (i <= 0 || i >= steps.length - 1) return;
        steps.splice(i, 1);
        stepSel = i - 1; A.edited = true; addedName = '';
        freeze(false);
        refresh(); renderSteps();
      });
      $(document).on('click', '#aniStepReset', function () {
        var A = cur && anims[sel];
        if (!A) return;
        A.steps = A.preset === 'custom' ? presetSteps('custom') : null;
        delete A.edited;
        stepSel = firstStep(A); addedName = '';
        freeze(false);
        refresh(); renderSteps(); renderControls();
      });

      $(document).on('input', '#aniName', function () { nameTouched = !!$.trim(this.value); syncName(); });
      $(document).on('click', '#aniAdd', add);
      $(document).on('click', '#aniDownload', function () { C().saveFile($.trim($('#aniName').val()) || 'animated-icon', buildSvg(false)); });
      $(document).on('click', '#aniCopy', function () {
        var svg = buildSvg(false);
        if (svg && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(svg).then(function () { toast('SVG copied'); }, function () { toast('Copy failed'); });
      });

      var last = null;
      try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
      if (last === PAGE) setTimeout(function () { SF.switchPage(PAGE); }, 0);
    });
  });

  SF.animateIcon = { buildSvg: function () { return buildSvg(false); }, state: function () { return { cur: cur, anims: anims, sel: sel, playing: playing }; } };
})(window.SpriteForge, jQuery);
