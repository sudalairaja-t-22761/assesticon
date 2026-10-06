/**
 * SpriteForge - Sprite & CSS Generation
 * Generates SVG sprite and CSS output strings.
 */
(function (SF) {
  'use strict';

  var state = SF.state;

  /**
   * Generate the SVG sprite string
   * @returns {string} Complete SVG sprite content
   */
  SF.generateSVGSprite = function () {
    var dims = SF.calculateLayout();
    var w = dims.width;
    var h = dims.height;

    var lines = [];

    lines.push('<?xml version="1.0" encoding="utf-8"?>');
    lines.push('<!-- Generator: SVG Sprite Generator Tool -->');
    lines.push('<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"');
    lines.push(' width="' + w + 'px" height="' + h + 'px" viewBox="0 0 ' + w + ' ' + h + '" style="enable-background:new 0 0 ' + w + ' ' + h + ';" xml:space="preserve">');

    var allDefs = '';
    var allStyles = '';
    state.icons.forEach(function (icon) {
      if (icon.defsContent) allDefs += icon.defsContent + '\n';
      if (icon.styleContent) allStyles += icon.styleContent + '\n';
    });

    if (allDefs.trim()) {
      lines.push('<defs>');
      lines.push(allDefs.trim());
      lines.push('</defs>');
    }

    lines.push('<style type="text/css">');
    if (allStyles.trim()) {
      lines.push(allStyles.trim());
    }
    lines.push('</style>');

    state.icons.forEach(function (icon) {
      var tx = Math.round(icon.spriteX - icon.originX);
      var ty = Math.round(icon.spriteY - icon.originY);
      var contentHasStroke = /<[^>]+\bstroke\s*=/i.test(icon.svgContent || '');

      var gAttrs = 'id="' + SF.escapeAttr(icon.gId) + '"';

      if (!(Math.abs(tx) < 0.001 && Math.abs(ty) < 0.001)) {
        gAttrs += ' transform="translate(' + tx + ',' + ty + ')"';
      }

      if (icon.rootFill) {
        gAttrs += ' fill="' + SF.escapeAttr(icon.rootFill) + '"';
      }
      if (icon.rootStroke && !contentHasStroke) {
        gAttrs += ' stroke="' + SF.escapeAttr(icon.rootStroke) + '"';
      }
      if (icon.colorMode === 'stroke' && !icon.rootFill) {
        gAttrs += ' fill="none"';
      }

      lines.push('<g ' + gAttrs + '>');
      lines.push(icon.svgContent);
      lines.push('</g>');
    });

    state.icons.forEach(function (icon) {
      var vb = Math.round(icon.spriteX) + ' ' + Math.round(icon.spriteY) + ' ' + Math.ceil(icon.width) + ' ' + Math.ceil(icon.height);
      lines.push('<symbol viewBox="' + vb + '" id="' + SF.escapeAttr(icon.symbolId) + '">');
      lines.push(' <use href="#' + SF.escapeAttr(icon.gId) + '"></use>');
      lines.push(' </symbol>');
    });

    lines.push('</svg>');

    state.generatedSVG = lines.join('\n');
    return state.generatedSVG;
  };

  /**
   * Generate the CSS string with icon dimensions
   * @returns {string} CSS content
   */
  SF.generateCSS = function () {
    // Update Sprite with a loaded stylesheet: keep it and append only what is new.
    var css;
    if (state.mode === 'existing' && state.sourceCssText) {
      css = SF.mergeStylesheet(state.sourceCssText, state.icons);
    } else {
      css = _sizeRules(state.icons).join('\n');
    }

    // Rules carried over from sprites merged into this one (sprite-merge.js).
    var extras = typeof SF.mergedStylesheetExtras === 'function'
      ? SF.mergedStylesheetExtras(state.mode === 'existing' ? state.sourceCssText : css) : '';
    if (extras) css = css.replace(/\s+$/, '') + '\n' + extras + '\n';

    state.generatedCSS = css;
    return state.generatedCSS;
  };

  /** width/height rules grouped by size: ".a,\n.b{ width: Npx; height: Npx; }" */
  function _sizeRules(icons) {
    // Group icons by dimensions (width×height)
    var groups = {};
    icons.forEach(function (icon) {
      var key = SF.formatDim(icon.width) + 'x' + SF.formatDim(icon.height);
      if (!groups[key]) groups[key] = { w: icon.width, h: icon.height, selectors: [] };
      groups[key].selectors.push('.' + icon.symbolId);
    });

    var cssLines = [];
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      cssLines.push(g.selectors.join(',\n') + '{');
      cssLines.push(' width: ' + SF.formatDim(g.w) + 'px;');
      cssLines.push(' height: ' + SF.formatDim(g.h) + 'px;');
      cssLines.push('}');
    });
    return cssLines;
  }

  /**
   * Original stylesheet + rules for icons it does not have yet.
   * - Every existing rule, mixin, variable and comment is kept as-is.
   * - Icons whose class is not in the stylesheet get width/height rules appended.
   * - Existing icons whose size changed (replaced artwork) get an override rule.
   * Classes already present are never added twice.
   */
  SF.mergeStylesheet = function (sourceText, icons) {
    var classes = SF.extractStylesheetClasses(sourceText);
    var dims = SF.parseExistingCSS(sourceText);
    var dimsLower = {};
    Object.keys(dims).forEach(function (k) { dimsLower[k.toLowerCase()] = dims[k]; });

    var seen = {};
    var added = [];
    var resized = [];
    (icons || []).forEach(function (icon) {
      var cls = String(icon.symbolId || '');
      var key = cls.toLowerCase();
      if (!cls || seen[key]) return;
      seen[key] = true;
      if (!classes[key]) { added.push(icon); return; }
      var d = dimsLower[key];
      if (d && ((d.width !== null && Math.abs(d.width - icon.width) > 0.001) ||
                (d.height !== null && Math.abs(d.height - icon.height) > 0.001))) {
        resized.push(icon);
      }
    });

    if (!added.length && !resized.length) return sourceText;

    var out = String(sourceText).replace(/\s+$/, '');
    if (added.length) {
      out += '\n/* Added via SpriteForge: ' + added.map(function (i) { return i.name; }).join(', ') + ' */\n';
      out += _sizeRules(added).join('\n');
    }
    if (resized.length) {
      out += '\n/* Size updated via SpriteForge (replaced icons) */\n';
      out += _sizeRules(resized).join('\n');
    }
    return out + '\n';
  };

})(window.SpriteForge);
