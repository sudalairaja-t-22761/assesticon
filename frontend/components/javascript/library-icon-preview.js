/**
 * SpriteForge - Icon Library: click an icon → right-side preview panel
 * (CRM colour classes, live preview, <crmutil-icon> code, size). "Edit in studio" opens library-icon-studio.js.
 * Icons in a category with options (library-icon-categories.js) also get Size (S–XXL) and Stroke width (1 / 1.5 / 2),
 * which add zcicn<px> (zcicn8 … zcicn32) / iconStroke* classes to the code.
 *
 * Colours are the CRM default theme (CRM_UI_LIBRARY resources/themes/default-theme.less) and their classes
 * (CRMClient css/icons/svg-path.less): fill icons use zcicn_<colour>; icons drawn with
 * --zcicn-color-baseStroke use zcicn-iconStroke-<colour>.
 */
(function (SF, $) {
  'use strict';

  var COLORS = [
    { key: 'black',      hex: '#313949', fill: 'zcicn_black',      stroke: 'zcicn-iconStroke-black' },
    { key: 'white',      hex: '#FFFFFF', fill: 'zcicn_white',      stroke: 'zcicn-iconStroke-white' },
    { key: 'grey',       hex: '#616E88', fill: 'zcicn_grey',       stroke: 'zcicn-iconStroke-grey' },
    { key: 'sandal',     hex: '#F18E0A', fill: 'zcicn_sandal',     stroke: 'zcicn-iconStroke-sandal' },
    { key: 'red',        hex: '#FF5D5A', fill: 'zcicn_red',        stroke: 'zcicn-iconStroke-red' },
    { key: 'blue',       hex: '#338CF0', fill: 'zcicn_blue',       stroke: 'zcicn-iconStroke-blue' },
    { key: 'green',      hex: '#12AA67', fill: 'zcicn_green',      stroke: 'zcicn-iconStroke-green' },
    { key: 'purple',     hex: '#C35BF4', fill: 'zcicn_purple',     stroke: 'zcicn-iconStroke-purple' },
    { key: 'violet',     hex: '#8C71FB', fill: 'zcicn_violet',     stroke: 'zcicn-iconStroke-violet' },
    { key: 'cyan',       hex: '#24CBB7', fill: 'zcicn_cyan',       stroke: 'zcicn-iconStroke-cyan' },
    { key: 'lightGreen', hex: '#AECC48', fill: 'zcicn_lightGreen', stroke: 'zcicn-iconStroke-lightgreen' },
    { key: 'yellow',     hex: '#E8D216', fill: 'zcicn_yellow',     stroke: 'zcicn-iconStroke-yellow' },
    { key: 'brown',      hex: '#B38B59', fill: 'zcicn_brown',      stroke: 'zcicn-iconStroke-brown' },
    { key: 'darkRed',    hex: '#E3204F', fill: 'zcicn_darkRed',    stroke: 'zcicn-iconStroke-darkred' },
    { key: 'oceanBlue',  hex: '#226DB4', fill: 'zcicn_oceanBlue',  stroke: 'zcicn-iconStroke-oceanBlue' },
    { key: 'statusBlue', hex: '#338CF0', fill: 'zcicn_statusBlue', stroke: 'zcicn-iconStroke-blue' }
  ];

  // Size and stroke width classes for icons in a category with options (1.5 is the sprite's default: no class).
  var SIZES = [
    { key: 'S', px: 8, cls: 'zcicn8' }, { key: 'M', px: 12, cls: 'zcicn12' }, { key: 'L', px: 16, cls: 'zcicn16' },
    { key: 'XL', px: 24, cls: 'zcicn24' }, { key: 'XXL', px: 32, cls: 'zcicn32' }
  ];
  var STROKES = [{ w: 1, cls: 'iconStroke1' }, { w: 1.5, cls: '' }, { w: 2, cls: 'iconStroke2' }];

  var current = null;        // icon shown in the panel
  var colorKey = 'black';
  var sizeKey = '';          // '' = the icon's own size
  var strokeW = 1.5;

  function esc(s) { return SF.escapeAttr ? SF.escapeAttr(s) : String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function colorOf(k) { return COLORS.filter(function (c) { return c.key === k; })[0] || COLORS[0]; }

  /** "zcicn-arrow-back__s" / "arrow-back" → "arrow-back" */
  function baseName(icon) {
    return String(icon.name || icon.symbolId || '').replace(/^zcicn-/, '').replace(/__s$/, '');
  }
  function usesStroke(icon) { return /--zcicn-color-baseStroke/.test(icon.svgContent || ''); }

  function size(icon) {
    var w = icon.width, h = icon.height;
    if (!(w && h)) {
      var m = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(icon.svgContent || '');
      if (m) { w = +m[1]; h = +m[2]; }
    }
    var f = function (n) { return typeof SF.formatDim === 'function' ? SF.formatDim(n) : String(Math.round(n * 100) / 100); };
    return w && h ? { w: f(w), h: f(h) } : null;
  }

  // Hardcoded colours (attributes, inline styles and the sprite's class rules) are repainted in the preview too;
  // white cut-outs, "none", "transparent" and var(...) values are kept.
  var COLOR_VALUE = '(#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\)|black|currentColor)';
  var ATTR_RE  = new RegExp('\\b(fill|stroke)(\\s*=\\s*["\'])' + COLOR_VALUE + '(["\'])', 'gi');
  var STYLE_RE = new RegExp('\\b(fill|stroke)(\\s*:\\s*)' + COLOR_VALUE, 'gi');
  function isWhite(v) { return /^(#fff|#ffffff|#ffffffff|white|rgba?\(\s*255\s*,\s*255\s*,\s*255\b)/i.test(String(v).trim()); }

  /** The icon SVG painted in colour `c`: CRM's class colouring (fill / baseStroke / main) plus any hardcoded colours. */
  function coloredSvg(svg, c) {
    var out = svg
      .replace(ATTR_RE, function (m, prop, eq, val, q) { return isWhite(val) ? m : prop + eq + c.hex + q; })
      .replace(STYLE_RE, function (m, prop, sep, val) { return isWhite(val) ? m : prop + sep + c.hex; });
    // On the icon's own root element (not a :root rule): an exported file added to a sprite then colours only itself.
    var paint = 'fill:' + c.hex + ';--zcicn-color-baseStroke:' + c.hex + ';--zcicn-color-main:' + c.hex;
    return out.replace(/<svg\b[^>]*>/i, function (tag) {
      if (/\sstyle\s*=\s*"/i.test(tag)) return tag.replace(/(\sstyle\s*=\s*")([^"]*)"/i, function (m, a, v) { return a + v.replace(/;?\s*$/, ';') + paint + '"'; });
      return tag.replace(/<svg\b/i, '<svg style="' + paint + '"');
    });
  }
  // Some sprite icons are drawn partly outside their viewBox (CRM crops them). The preview widens the viewBox to the
  // drawing's real bounds so the whole icon is visible, and says so. Results are cached per icon.
  var fitCache = {};
  function measure(icon) {
    if (fitCache[icon.id]) return fitCache[icon.id];
    var res = null;
    try {
      var safe = String(icon.svgContent || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
      var host = isolatedHost(safe, 100);
      var svg = host.root.querySelector('svg');
      if (svg && svg.viewBox && svg.viewBox.baseVal) {
        var vb = svg.viewBox.baseVal, b = svg.getBBox();
        if (vb.width && vb.height && b.width && b.height) {
          var x1 = Math.min(vb.x, b.x), y1 = Math.min(vb.y, b.y);
          var x2 = Math.max(vb.x + vb.width, b.x + b.width), y2 = Math.max(vb.y + vb.height, b.y + b.height);
          var over = x1 < vb.x - 0.5 || y1 < vb.y - 0.5 || x2 > vb.x + vb.width + 0.5 || y2 > vb.y + vb.height + 0.5;
          // Pad by 6% (getBBox ignores stroke width) so strokes on the edge are not clipped.
          var pad = Math.max(x2 - x1, y2 - y1) * 0.06;
          res = { overflow: over, box: [x1 - pad, y1 - pad, x2 - x1 + 2 * pad, y2 - y1 + 2 * pad] };
        }
      }
      host.remove();
    } catch (e) { res = null; }
    fitCache[icon.id] = res || { overflow: false };
    return fitCache[icon.id];
  }

  /**
   * An off-screen element holding `svg` inside a shadow root, so the icon's own <style> rules (sprite classes)
   * never reach the page. { root, remove() }
   */
  function isolatedHost(svg, px) {
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-10000px;top:0;width:' + px + 'px;height:' + px + 'px;visibility:hidden;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = String(svg);
    document.body.appendChild(host);
    return { root: root, remove: function () { host.remove(); } };
  }

  /** svg with its root viewBox replaced by `box` (and no fixed width/height, so it scales into the preview). */
  function withViewBox(svg, box) {
    var vb = box.map(function (n) { return Math.round(n * 100) / 100; }).join(' ');
    return svg.replace(/<svg\b[^>]*>/i, function (tag) {
      tag = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '');
      return /\sviewBox\s*=/i.test(tag) ? tag.replace(/(\sviewBox\s*=\s*)("[^"]*"|'[^']*')/i, '$1"' + vb + '"') : tag.replace(/<svg\b/i, '<svg viewBox="' + vb + '"');
    });
  }

  function dataUri(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }

  // opts: { size: 'S'…'XXL', stroke: 1 | 1.5 | 2 } for icons in a category with options.
  function code(icon, c, opts) {
    var name = baseName(icon), extra = classesFor(opts);
    return '<crmutil-icon icon-name="' + name + '" icon-class="zcicn-' + name + ' ' + (usesStroke(icon) ? c.stroke : c.fill) +
      (extra.length ? ' ' + extra.join(' ') : '') + '"></crmutil-icon>';
  }
  function sizeOf(k) { return SIZES.filter(function (z) { return z.key === k; })[0] || null; }
  function strokeOf(w) { return STROKES.filter(function (z) { return z.w === w; })[0] || STROKES[1]; }
  function classesFor(opts) {
    if (!opts) return [];
    var z = sizeOf(opts.size), k = strokeOf(opts.stroke);
    return [z && z.cls, k.cls].filter(Boolean);
  }
  // The CSS the chosen classes need (iconStroke1/2 are the CRM rules; the size classes set width and height).
  function classCss(opts) {
    var z = sizeOf(opts.size), k = strokeOf(opts.stroke), out = [];
    if (z) out.push('.' + z.cls + ' {\n\twidth: ' + z.px + 'px;\n\theight: ' + z.px + 'px;\n}');
    if (k.cls) out.push('.' + k.cls + ' {\n\tstroke-width: ' + k.w + ' !important;\n}');
    return out.join('\n');
  }

  // Icon categories live in library-icon-categories.js; a category with options gives its icons Size + Stroke width.
  function hasOptions(icon) { return !!(SF.iconCategories && SF.iconCategories.hasOptions(icon)); }
  function loadOptions(force) { if (SF.iconCategories) SF.iconCategories.load(force); }

  function ensurePanel() {
    if ($('#libPreviewPanel').length) return;
    $('body').append(
      '<aside class="doc-right-panel lib-preview-panel hidden" id="libPreviewPanel" aria-label="Icon preview">' +
        '<div class="lpp-inner">' +
          '<div class="lpp-head"><span class="lpp-title" id="lppTitle"></span>' +
            '<button class="btn btn-ghost btn-sm lpp-studio-btn" id="lppStudio" type="button" title="Customize colour, stroke width and size">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
              '<span>Edit in studio</span></button>' +
            '<button class="lpp-close" id="lppClose" type="button" aria-label="Close preview">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button></div>' +
          '<div class="lpp-label">Colors</div>' +
          '<div class="lpp-swatches" id="lppSwatches" role="radiogroup" aria-label="Icon colour">' +
            COLORS.map(function (c) {
              return '<button type="button" class="lpp-swatch" role="radio" data-color="' + c.key + '" style="--sw:' + c.hex + '" title="' + c.fill + '" aria-label="' + c.key + '"></button>';
            }).join('') +
          '</div>' +
          '<div class="lpp-cats hidden" id="lppCats"></div>' +
          '<div class="lpp-opts hidden" id="lppOpts">' +
            '<div class="lpp-label">Size</div>' +
            '<div class="lpp-seg" id="lppSizes" role="radiogroup" aria-label="Icon size">' +
              SIZES.map(function (z) { return '<button type="button" role="radio" data-size="' + z.key + '" title="' + z.px + ' × ' + z.px + ' px · ' + z.cls + '">' + z.key + '</button>'; }).join('') +
            '</div>' +
            '<div class="lpp-label">Stroke width</div>' +
            '<div class="lpp-seg" id="lppStrokes" role="radiogroup" aria-label="Stroke width">' +
              STROKES.map(function (k) { return '<button type="button" role="radio" data-stroke="' + k.w + '" title="' + (k.cls || 'default — no class') + '">' + k.w + (k.cls ? '' : ' · default') + '</button>'; }).join('') +
            '</div>' +
          '</div>' +
          '<div class="lpp-label">Preview</div>' +
          '<div class="lpp-preview"><img id="lppImg" alt=""><span class="lpp-px hidden" id="lppPx"></span></div>' +
          '<div class="lpp-note hidden" id="lppNote"></div>' +
          '<div class="lpp-label">Properties</div>' +
          '<div class="lpp-box lpp-code"><code id="lppCode"></code>' +
            '<button class="lpp-copy" id="lppCopy" type="button" title="Copy code" aria-label="Copy code">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
            '</button></div>' +
          '<div class="lpp-box" id="lppSize"></div>' +
          '<div class="lpp-box lpp-code hidden" id="lppCssBox"><div class="lpp-css-head">CSS for these classes</div><code id="lppCss"></code>' +
            '<button class="lpp-copy" id="lppCssCopy" type="button" title="Copy CSS" aria-label="Copy CSS">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
            '</button></div>' +
        '</div>' +
      '</aside>'
    );
  }

  function render() {
    if (!current) return;
    var c = colorOf(colorKey);
    $('#lppTitle').text(baseName(current));
    $('#lppSwatches .lpp-swatch').each(function () {
      var on = $(this).data('color') === c.key;
      $(this).toggleClass('is-active', on).attr('aria-checked', on ? 'true' : 'false');
    });
    var on = hasOptions(current), opts = on ? { size: sizeKey, stroke: strokeW } : null, z = on ? sizeOf(sizeKey) : null;
    var catNames = SF.iconCategories ? SF.iconCategories.of(current).map(function (c) { return c.name; }) : [];
    $('#lppCats').toggleClass('hidden', !catNames.length).html(catNames.map(function (n) { return '<span class="lpp-cat">' + esc(n) + '</span>'; }).join(''));
    $('#lppOpts').toggleClass('hidden', !on);
    $('#lppSizes [data-size]').each(function () { var a = $(this).data('size') === sizeKey; $(this).toggleClass('is-active', a).attr('aria-checked', a ? 'true' : 'false'); });
    $('#lppStrokes [data-stroke]').each(function () { var a = +$(this).data('stroke') === strokeW; $(this).toggleClass('is-active', a).attr('aria-checked', a ? 'true' : 'false'); });

    var fit = current.svgContent ? measure(current) : { overflow: false };
    var svg = current.svgContent ? coloredSvg(current.svgContent, c) : '';
    if (fit.overflow) svg = withViewBox(svg, fit.box);
    // Stroke width preview: the same override the iconStroke1 / iconStroke2 classes make in CRM.
    if (svg && on && strokeW !== 1.5) svg = svg.replace(/<\/svg>\s*$/i, '<style>*{stroke-width:' + strokeW + ' !important}</style></svg>');
    $('#lppImg').attr('src', svg ? dataUri(svg) : (current.openPath || '')).attr('alt', baseName(current))
      .css(z ? { width: z.px + 'px', height: z.px + 'px' } : { width: '', height: '' });
    $('#lppPx').toggleClass('hidden', !z).text(z ? z.px + ' × ' + z.px + ' px' : '');
    $('#lppNote').toggleClass('hidden', !fit.overflow)
      .text(fit.overflow ? 'Part of this icon is drawn outside its viewBox, so CRM crops it. The preview shows the full drawing.' : '');
    $('#lppCode').text(code(current, c, opts));
    var s = size(current);
    $('#lppSize').text(z ? 'Width: ' + z.px + 'px, Height: ' + z.px + 'px (' + z.cls + ')' : s ? 'Width: ' + s.w + 'px, Height: ' + s.h + 'px' : 'Size unknown');
    var css = opts ? classCss(opts) : '';
    $('#lppCssBox').toggleClass('hidden', !css);
    $('#lppCss').text(css);
    $('#libGrid .lib-card').removeClass('lib-previewing').filter(function () { return $(this).data('iconId') === current.id; }).addClass('lib-previewing');
  }

  SF.openLibraryPreview = function (iconId) {
    var icon = ((SF.libState && SF.libState.icons) || []).filter(function (i) { return i && i.id === iconId; })[0];
    if (!icon) return;
    ensurePanel();
    if (!current || current.id !== icon.id) { sizeKey = ''; strokeW = 1.5; }
    current = icon;
    loadOptions(true);
    render();
    $('#libPreviewPanel').removeClass('hidden');
    $('.main').addClass('has-right-panel has-right-panel-wide');
  };

  SF.closeLibraryPreview = function () {
    if (typeof SF.closeLibraryStudio === 'function') SF.closeLibraryStudio();
    current = null;
    $('#libPreviewPanel').addClass('hidden');
    $('#libGrid .lib-card').removeClass('lib-previewing');
    if ($('#docRightPanel').hasClass('hidden')) $('.main').removeClass('has-right-panel has-right-panel-wide');
  };

  $(document).on('click', '#lppSwatches .lpp-swatch', function () { colorKey = $(this).data('color'); render(); });
  $(document).on('click', '#lppSizes [data-size]', function () { var k = $(this).data('size'); sizeKey = sizeKey === k ? '' : k; render(); });
  $(document).on('click', '#lppStrokes [data-stroke]', function () { strokeW = +$(this).data('stroke'); render(); });
  $(document).on('click', '#lppCssCopy', function () {
    var t = $('#lppCss').text();
    if (t && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { if (SF.showToast) SF.showToast('CSS copied'); }, function () {});
  });
  $(document).on('click', '#lppClose', function () { SF.closeLibraryPreview(); });
  $(document).on('keydown', function (e) { if (e.key === 'Escape' && current && !$('#libStudio:not(.hidden)').length) SF.closeLibraryPreview(); });
  $(document).on('click', '#lppCopy', function () {
    var t = $('#lppCode').text();
    var done = function () { if (SF.showToast) SF.showToast('Copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () {});
  });


  // Shared with the studio (library-icon-studio.js).
  SF.libPreview = {
    COLORS: COLORS, colorOf: colorOf, coloredSvg: coloredSvg, measure: measure, withViewBox: withViewBox, isWhite: isWhite,
    baseName: baseName, dataUri: dataUri, code: code, usesStroke: usesStroke, isolatedHost: isolatedHost,
    current: function () { return current; }, colorKey: function () { return colorKey; }, render: function () { render(); }
  };

  // Re-highlight after the grid re-renders; leave the Library → close the panel.
  var origRender = SF.renderLibraryGrid;
  if (typeof origRender === 'function') {
    SF.renderLibraryGrid = function () {
      var r = origRender.apply(this, arguments);
      if (current) render();
      loadOptions();
      return r;
    };
  }
  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    if (page !== 'iconlibrary' && current) SF.closeLibraryPreview();
    return origSwitch.apply(this, arguments);
  };
})(window.SpriteForge, jQuery);
