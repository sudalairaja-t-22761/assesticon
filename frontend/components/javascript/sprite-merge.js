/**
 * SpriteForge - Merge another sprite (SVG + CSS/LESS) into the current one
 *
 * "Upload Icons" can take, besides single SVG files, a whole second sprite:
 *   - a Saved Sprite (its .svg + .css),
 *   - a repository pair (e.g. svg_cssicons.svg + svg-path.less), or
 *   - an uploaded sprite .svg plus its .css/.less.
 * Its icons are added as NEW icons (laid out after the existing ones) and every
 * icon whose name or class already exists in the loaded sprite / stylesheet is
 * skipped. The second sprite's styling travels with its icons:
 *   - classes and gradient ids from its <style>/<defs> are prefixed so they cannot
 *     clash with the loaded sprite's (.st0 vs .st0),
 *   - its CSS/LESS rules for the merged icons (other than width/height, which are
 *     generated) are appended to the output stylesheet, with any LESS variables
 *     they need that the loaded stylesheet does not define.
 */
(function (SF, $) {
  'use strict';

  var state = SF.state;

  // Extra stylesheet rules carried over from merged sprites.
  // [{ classes: ['zcicn-a__s'], text: '.zcicn-a__s{fill:…}', from: 'svg_cssicons' }]
  state.mergedCssRules = [];
  state.mergedCssVars = []; // [{ name:'@x', text:'@x: 1px;' }]

  function esc(s) { return SF.escapeAttr(String(s == null ? '' : s)); }
  function reEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function stripComments(t) {
    return String(t || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  // ── isolate the merged sprite's <style> classes and <defs> ids ──────────

  function isolate(icons, token) {
    var style = '', defs = '';
    icons.forEach(function (ic) {
      if (!style && ic.styleContent) style = ic.styleContent;
      if (!defs && ic.defsContent) defs = ic.defsContent;
    });

    // Classes defined in the sprite <style>: ".st0{…}" / ".st0,.st1{…}"
    var classMap = {};
    if (style) {
      var selRe = /([^{}]+)\{/g, m;
      while ((m = selRe.exec(stripComments(style))) !== null) {
        var cRe = /\.(-?[_a-zA-Z][\w-]*)/g, c;
        while ((c = cRe.exec(m[1])) !== null) classMap[c[1]] = token + '-' + c[1];
      }
    }
    // ids defined in <defs>
    var idMap = {};
    if (defs) {
      var idRe = /\bid\s*=\s*["']([^"']+)["']/g, im;
      while ((im = idRe.exec(defs)) !== null) idMap[im[1]] = token + '-' + im[1];
    }

    function renameClassesInMarkup(markup) {
      return String(markup || '').replace(/\bclass\s*=\s*(["'])([^"']*)\1/g, function (all, q, list) {
        return 'class=' + q + list.split(/\s+/).map(function (k) { return classMap[k] || k; }).join(' ') + q;
      });
    }
    function renameIds(markup) {
      var out = String(markup || '');
      Object.keys(idMap).forEach(function (id) {
        var e = reEsc(id);
        out = out
          .replace(new RegExp('\\bid\\s*=\\s*(["\'])' + e + '\\1', 'g'), 'id="' + idMap[id] + '"')
          .replace(new RegExp('url\\(\\s*#' + e + '\\s*\\)', 'g'), 'url(#' + idMap[id] + ')')
          .replace(new RegExp('((?:xlink:)?href\\s*=\\s*["\'])#' + e + '(["\'])', 'g'), '$1#' + idMap[id] + '$2');
      });
      return out;
    }

    var newStyle = style;
    Object.keys(classMap).forEach(function (k) {
      newStyle = newStyle.replace(new RegExp('\\.' + reEsc(k) + '(?![\\w-])', 'g'), '.' + classMap[k]);
    });
    newStyle = renameIds(newStyle);
    var newDefs = renameIds(renameClassesInMarkup(defs));

    icons.forEach(function (ic, i) {
      ic.svgContent = renameIds(renameClassesInMarkup(ic.svgContent));
      ic.styleContent = i === 0 ? newStyle : '';
      ic.defsContent = i === 0 ? newDefs : '';
    });
  }

  // ── stylesheet rules that belong to the merged icons ────────────────────

  function definedLessVars(text) {
    var out = {};
    var re = /(^|[;{}\s])(@[\w-]+)\s*:/g, m;
    var src = stripComments(text);
    while ((m = re.exec(src)) !== null) out[m[2]] = true;
    return out;
  }

  function collectRules(cssText, classRename, fromName) {
    var rules = [];
    var neededVars = {};
    var src = stripComments(cssText);
    var re = /([^{}]+)\{([^{}]*)\}/g, m;
    var oldClasses = Object.keys(classRename);
    if (!oldClasses.length) return { rules: rules, vars: [] };

    while ((m = re.exec(src)) !== null) {
      var selector = m[1].trim();
      var body = m[2].trim();
      if (!body || /^@/.test(selector)) continue;
      // width/height-only rules are regenerated from the icon sizes
      var decls = body.split(';').map(function (d) { return d.trim(); }).filter(Boolean);
      if (decls.every(function (d) { return /^(width|height)\s*:/i.test(d); })) continue;

      var kept = [];
      var used = [];
      selector.split(',').forEach(function (part) {
        var p = part.trim();
        var hit = false;
        oldClasses.forEach(function (oc) {
          var r = new RegExp('\\.' + reEsc(oc) + '(?![\\w-])', 'g');
          if (r.test(p)) {
            hit = true;
            p = p.replace(r, '.' + classRename[oc]);
            used.push(classRename[oc]);
          }
        });
        if (hit) kept.push(p);
      });
      if (!kept.length) continue;

      var varRe = /@\{?([\w-]+)\}?/g, v;
      while ((v = varRe.exec(body)) !== null) neededVars['@' + v[1]] = true;
      rules.push({ classes: used, text: kept.join(',\n') + ' {\n\t' + decls.join(';\n\t') + ';\n}', from: fromName });
    }

    // LESS variables the copied rules need, taken from the merged stylesheet.
    var vars = [];
    Object.keys(neededVars).forEach(function (name) {
      var dm = src.match(new RegExp('(^|[;{}\\s])(' + reEsc(name) + '\\s*:[^;{}]*;)'));
      if (dm) vars.push({ name: name, text: dm[2].trim() });
    });
    return { rules: rules, vars: vars };
  }

  /** Extra rules for icons still in the workspace, ready to append to the output stylesheet. */
  SF.mergedStylesheetExtras = function (targetText) {
    var present = {};
    (state.icons || []).forEach(function (i) { if (i && i.symbolId) present[i.symbolId] = true; });
    var rules = (state.mergedCssRules || []).filter(function (r) {
      return r.classes.some(function (c) { return present[c]; });
    });
    if (!rules.length) return '';
    var defined = definedLessVars(targetText || '');
    var isLess = (state.sourceCssExt || 'css') === 'less';
    var vars = isLess ? (state.mergedCssVars || []).filter(function (v) { return !defined[v.name]; }) : [];
    var from = {};
    rules.forEach(function (r) { from[r.from] = true; });
    var out = '/* Styles merged via SpriteForge from ' + Object.keys(from).join(', ') + ' */\n';
    if (vars.length) out += vars.map(function (v) { return v.text; }).join('\n') + '\n';
    out += rules.map(function (r) { return r.text; }).join('\n');
    return out;
  };

  // ── merge ───────────────────────────────────────────────────────────────

  /**
   * @param {{svgName, svgText, cssName?, cssText?, label?}} pair
   * @returns {{added:string[], skipped:Array}}
   */
  SF.mergeSpritePair = function (pair) {
    if (!pair || !pair.svgText) { SF.showToast('Sprite to merge is empty'); return null; }
    var base = String(pair.svgName || 'sprite').replace(/\.svg$/i, '');
    var token = SF.cleanFileName(base).replace(/_/g, '-') || 'merged';

    // parseExistingSprite records the sprite size in state — keep the loaded sprite's.
    var keepW = state.originalSpriteWidth, keepH = state.originalSpriteHeight;
    var parsed;
    try { parsed = SF.parseExistingSprite(pair.svgText) || []; }
    finally { state.originalSpriteWidth = keepW; state.originalSpriteHeight = keepH; }
    if (!parsed.length) { SF.showToast('No icons found in ' + pair.svgName); return null; }

    isolate(parsed, token);

    var dims = pair.cssText ? SF.parseExistingCSS(pair.cssText) : {};
    var added = [];
    var skipped = [];
    var classRename = {};

    parsed.forEach(function (ic) {
      var oldSymbol = ic.symbolId;
      var d = dims[oldSymbol];
      if (d) {
        if (d.width !== null) ic.width = d.width;
        if (d.height !== null) ic.height = d.height;
      }
      var conflict = SF.iconNameConflict(ic.name);
      if (conflict) { skipped.push({ name: ic.name, reason: conflict }); return; }

      ic.isExisting = false;           // laid out after the loaded sprite's icons
      ic.isNewlyParsed = true;
      ic.mergedFrom = base;
      ic.gId = SF.makeGId(ic.name);
      ic.symbolId = SF.makeSymbolId(ic.name);
      if (oldSymbol) classRename[oldSymbol] = ic.symbolId;
      state.icons.push(ic);
      added.push(ic.name);
    });

    // The first parsed icon carries the sprite <style>/<defs>; if it was skipped, hand them on.
    var carrier = parsed[0];
    if (carrier && carrier.isExisting !== false && added.length) {
      var first = state.icons.filter(function (i) { return i.mergedFrom === base; })[0];
      if (first) { first.styleContent = carrier.styleContent; first.defsContent = carrier.defsContent; }
    }

    if (pair.cssText && added.length) {
      var c = collectRules(pair.cssText, classRename, pair.cssName || base);
      state.mergedCssRules = (state.mergedCssRules || []).concat(c.rules);
      var have = {};
      (state.mergedCssVars || []).forEach(function (v) { have[v.name] = true; });
      state.mergedCssVars = (state.mergedCssVars || []).concat(c.vars.filter(function (v) { return !have[v.name]; }));
    }

    if (typeof SF.renderIconList === 'function') SF.renderIconList();
    state.generatedSVG = '';
    state.generatedCSS = '';
    $('#outputSection').addClass('hidden');

    SF.showToast('Merged ' + added.length + ' icon' + (added.length === 1 ? '' : 's') + ' from ' + pair.svgName +
      (pair.cssText ? ' + ' + (pair.cssName || 'stylesheet') : '') +
      (skipped.length ? ' — ' + skipped.length + ' duplicate' + (skipped.length === 1 ? '' : 's') + ' skipped' : ''));
    if (skipped.length) setTimeout(function () { SF.reportDuplicateIcons(skipped); }, 1800);
    $('#mergeStatus').text('Last merge: ' + added.length + ' added, ' + skipped.length + ' duplicates skipped from ' + pair.svgName)
      .attr('class', 'upload-status ' + (added.length ? 'success' : 'error'));
    return { added: added, skipped: skipped };
  };

  // ── UI: card picker (sprite-source.js) + file upload in "Upload Icons" ──

  function fetchPair(key) {
    if (key.indexOf('repo:') === 0) {
      var parts = key.slice(5).split('|');
      var jobs = [SF.fetchMasterLibraryFile(parts[0])];
      if (parts[1]) jobs.push(SF.fetchMasterLibraryFile(parts[1]).catch(function () { return ''; }));
      return Promise.all(jobs).then(function (r) {
        return { svgName: parts[0], svgText: r[0], cssName: parts[1] || '', cssText: r[1] || '' };
      });
    }
    if (key.indexOf('saved:') === 0) return SF.fetchSavedSpritePair(key.slice(6));
    return Promise.reject(new Error('Unknown source'));
  }

  function readFile(f) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function (e) { resolve(e.target.result || ''); };
      r.onerror = reject;
      r.readAsText(f);
    });
  }

  /** Uploaded files: one sprite .svg plus optionally its .css/.less. */
  SF.mergeSpriteFiles = function (files) {
    var list = Array.from(files || []);
    var svg = list.filter(function (f) { return /\.svg$/i.test(f.name); });
    var css = list.filter(function (f) { return /\.(css|less)$/i.test(f.name); });
    if (svg.length !== 1) { SF.showToast('Choose one sprite .svg (and optionally its .css / .less)'); return; }
    var jobs = [readFile(svg[0])];
    if (css[0]) jobs.push(readFile(css[0]));
    Promise.all(jobs).then(function (r) {
      SF.mergeSpritePair({ svgName: svg[0].name, svgText: r[0], cssName: css[0] ? css[0].name : '', cssText: r[1] || '' });
    }).catch(function () { SF.showToast('Could not read the selected files'); });
  };

  /** Merge a picker source ("repo:…" / "saved:…"). Resolves with the merge result (or null). */
  SF.mergeFromSource = function (key) {
    return fetchPair(key).then(function (pair) {
      return SF.mergeSpritePair(pair);
    }).catch(function (err) {
      SF.showToast(err.message || 'Could not load the sprite to merge');
      return null;
    });
  };

  $(document)
    .on('click', '#mergeFilesBtn', function () { $('#mergeFilesInput').trigger('click'); })
    .on('change', '#mergeFilesInput', function () {
      SF.mergeSpriteFiles(this.files);
      this.value = '';
    });

})(window.SpriteForge, jQuery);
