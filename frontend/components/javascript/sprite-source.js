/**
 * SpriteForge - Sprite source picker (cards)
 *
 * One card list used in two places:
 *   #spriteSourcePicker (Load Existing Sprite) → "Load" a sprite + stylesheet to update
 *   #mergeSourcePicker  (Upload Icons)         → "Merge" another sprite into it
 *
 * Sources:
 *   - Repository (CRM_UI_LIBRARY): crmutil_icons.svg + svg-icons.less, svg_cssicons.svg + svg-path.less
 *   - Saved Sprites: each saved .svg with its .css
 * Keys: "repo:<svg>|<styles>" or "saved:<folder name>".
 */
(function (SF, $) {
  'use strict';

  var state = SF.state;
  var current = '';          // key of the sprite loaded in Update Sprite
  var pending = {};          // key → 'load' | 'merge' while fetching
  var merged = {};           // keys merged into the current sprite
  var search = { load: '', merge: '' };

  var ICON_REPO  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
  var ICON_SAVED = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
  var ICON_REFRESH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

  function esc(s) { return SF.escapeAttr(String(s == null ? '' : s)); }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function signedOut() {
    return typeof SF.isMasterLibrarySignedOut === 'function' && SF.isMasterLibrarySignedOut();
  }

  /** Every source the pickers can show. */
  SF.listSpriteSources = function () {
    var out = [];
    var cfg = typeof SF.masterLibraryConfig === 'function' ? SF.masterLibraryConfig() : (window.SF_REPO_CONFIG || {});
    if (!signedOut()) {
      var pairs = cfg.pairs || [];
      if (!pairs.length) pairs = (cfg.files || []).filter(function (f) { return f.kind === 'sprite'; }).map(function (f) { return { svg: f.name, styles: null }; });
      var counts = {};
      pairs.forEach(function (p) {
        out.push({
          key: 'repo:' + p.svg + '|' + (p.styles || ''),
          group: 'repo',
          title: p.svg.replace(/\.svg$/i, ''),
          svg: p.svg,
          css: p.styles || '',
          meta: counts[p.svg] ? counts[p.svg] + ' icons' : ''
        });
      });
    }
    var saved = typeof SF.getSavedSpriteFolders === 'function' ? SF.getSavedSpriteFolders() : [];
    saved.forEach(function (f) {
      var names = (f.files || []).map(function (x) { return x && x.name; }).filter(Boolean);
      out.push({
        key: 'saved:' + f.name,
        group: 'saved',
        title: f.name,
        svg: names.filter(function (n) { return /\.svg$/i.test(n); })[0] || (f.name + '.svg'),
        css: names.filter(function (n) { return /\.(css|less)$/i.test(n); })[0] || '',
        meta: f.savedAt ? 'Saved ' + fmtDate(f.savedAt) : ''
      });
    });
    return out;
  };

  var ICON_CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
  var ICON_SEARCH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  var mergeChoice = '';      // option chosen in the merge dropdown

  function chip(kind, name) {
    if (!name) return '<span class="src-chip src-chip-none">No CSS</span>';
    var ext = String(name.split('.').pop() || '').toUpperCase();
    return '<span class="src-chip src-chip-' + kind + '" title="' + esc(name) + '"><b>' + esc(ext) + '</b><span>' + esc(name) + '</span></span>';
  }

  function actionOf($root) { return $root.data('action') === 'merge' ? 'merge' : 'load'; }

  /** The loaded key only counts while that sprite's icons are actually in the workspace. */
  function syncCurrentWithWorkspace() {
    var loaded = state.mode === 'existing' && (state.icons || []).some(function (i) { return i.isExisting; });
    if (!loaded && current) { current = ''; merged = {}; mergeChoice = ''; }
  }
  function selectedKey(action) {
    if (action === 'merge') return mergeChoice;
    // While a sprite is loading, show the one that was picked (with "Loading…"), not the previous one.
    var loading = Object.keys(pending).filter(function (k) { return pending[k] === 'load'; })[0];
    return loading || current;
  }

  function optionHtml(src, action) {
    var isCurrent = src.key === current;
    var disabled = action === 'merge' && isCurrent;
    var selected = src.key === selectedKey(action);
    var tag = '';
    if (pending[src.key] === action) tag = '<span class="src-tag src-tag-busy">' + (action === 'load' ? 'Loading…' : 'Merging…') + '</span>';
    else if (isCurrent) tag = '<span class="src-tag src-tag-current">' + (action === 'load' ? 'Loaded' : 'Updating this') + '</span>';
    else if (action === 'merge' && merged[src.key]) tag = '<span class="src-tag src-tag-merged">Merged</span>';

    return '<div class="src-opt' + (selected ? ' is-selected' : '') + (disabled ? ' is-disabled' : '') +
        '" role="option" data-key="' + esc(src.key) + '" aria-selected="' + selected + '"' + (disabled ? ' aria-disabled="true"' : '') + '>' +
      '<span class="src-opt-icon src-opt-icon-' + src.group + '">' + (src.group === 'repo' ? ICON_REPO : ICON_SAVED) + '</span>' +
      '<span class="src-opt-main">' +
        '<span class="src-opt-name"><span class="src-opt-title">' + esc(src.title) + '</span>' + tag +
          (src.meta ? '<span class="src-opt-meta">' + esc(src.meta) + '</span>' : '') + '</span>' +
        '<span class="src-opt-files">' + chip('svg', src.svg) + chip('css', src.css) + '</span>' +
      '</span>' +
      '<span class="src-opt-check">' + (selected ? ICON_CHECK : '') + '</span>' +
    '</div>';
  }

  function triggerHtml(src, action) {
    if (!src) {
      return '<span class="src-trig-placeholder">' + (action === 'merge' ? 'Choose a sprite to merge…' : 'Choose a sprite to update…') + '</span>';
    }
    var busy = pending[src.key] === action;
    return '<span class="src-opt-icon src-opt-icon-' + src.group + '">' + (src.group === 'repo' ? ICON_REPO : ICON_SAVED) + '</span>' +
      '<span class="src-trig-name">' + esc(src.title) + '</span>' +
      '<span class="src-trig-files">' + chip('svg', src.svg) + chip('css', src.css) + '</span>' +
      (busy ? '<span class="src-tag src-tag-busy">' + (action === 'load' ? 'Loading…' : 'Merging…') + '</span>' : '');
  }

  function renderList($root) {
    var action = actionOf($root);
    var cfg = typeof SF.masterLibraryConfig === 'function' ? SF.masterLibraryConfig() : {};
    var all = SF.listSpriteSources();
    var q = (search[action] || '').toLowerCase();
    var match = function (s) { return !q || (s.title + ' ' + s.svg + ' ' + s.css).toLowerCase().indexOf(q) !== -1; };
    var repo = all.filter(function (s) { return s.group === 'repo' && match(s); });
    var saved = all.filter(function (s) { return s.group === 'saved' && match(s); });
    var savedTotal = all.filter(function (s) { return s.group === 'saved'; }).length;

    var html = '';
    if (signedOut()) {
      html += '<div class="src-empty">Sign in with Zoho to see the repository sprites and your saved sprites.</div>';
    } else {
      html += '<div class="src-group-title">' + ICON_REPO + ' Repository · ' + esc(cfg.repoName || 'repository') +
        (cfg.branch ? '<span class="src-pill">' + esc(cfg.branch) + '</span>' : '') + '</div>';
      html += repo.length ? repo.map(function (s) { return optionHtml(s, action); }).join('')
        : '<div class="src-empty">' + (q ? 'No repository sprite matches.' : 'No repository sprites configured.') + '</div>';
    }
    html += '<div class="src-group-title">' + ICON_SAVED + ' Saved Sprites<span class="src-pill">' + savedTotal + '</span></div>';
    html += saved.length ? saved.map(function (s) { return optionHtml(s, action); }).join('')
      : '<div class="src-empty">' + (q && savedTotal ? 'No saved sprite matches.'
          : 'No saved sprites yet — use <strong>Save to Project</strong> after Generate.') + '</div>';
    $root.find('.src-dd-list').html(html);
  }

  function renderPicker($root) {
    if (!$root.length) return;
    var action = actionOf($root);
    if (!$root.children('.src-dd-trigger').length) {
      $root.html(
        '<button type="button" class="src-dd-trigger" aria-haspopup="listbox" aria-expanded="false">' +
          '<span class="src-dd-value"></span><span class="src-dd-chevron">' + ICON_CHEVRON + '</span>' +
        '</button>' +
        '<div class="src-dd-menu" hidden>' +
          '<div class="src-dd-tools">' +
            '<span class="src-dd-search-icon">' + ICON_SEARCH + '</span>' +
            '<input type="search" class="src-dd-search" placeholder="Search sprites…" aria-label="Search sprites" autocomplete="off">' +
            '<button type="button" class="src-dd-refresh" title="Reload repository files and saved sprites">' + ICON_REFRESH + '</button>' +
          '</div>' +
          '<div class="src-dd-list" role="listbox"></div>' +
        '</div>'
      );
    }
    var all = SF.listSpriteSources();
    var key = selectedKey(action);
    var sel = all.filter(function (s) { return s.key === key; })[0] || null;
    if (action === 'merge' && sel && sel.key === current) { mergeChoice = ''; sel = null; }
    $root.find('.src-dd-value').html(triggerHtml(sel, action));
    $root.toggleClass('has-value', !!sel);
    if (action === 'merge') {
      $('#mergeSourceBtn').prop('disabled', !sel || pending[sel.key] === 'merge')
        .text(sel && pending[sel.key] === 'merge' ? 'Merging…' : (sel && merged[sel.key] ? 'Merge again' : 'Merge'));
    }
    if (!$root.find('.src-dd-menu').prop('hidden')) renderList($root);
  }

  /** The menu is fixed to the viewport so collapsible panels (overflow hidden) cannot clip it. */
  function placeMenu($root) {
    var $menu = $root.find('.src-dd-menu');
    var trig = $root.find('.src-dd-trigger')[0];
    if (!trig || $menu.prop('hidden')) return;
    var r = trig.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var below = vh - r.bottom - 12;
    var above = r.top - 12;
    var up = below < 260 && above > below;
    var maxH = Math.max(160, Math.min(420, up ? above : below));
    $menu.css({ position: 'fixed', left: r.left + 'px', width: r.width + 'px', right: 'auto',
      top: up ? 'auto' : (r.bottom + 4) + 'px', bottom: up ? (vh - r.top + 4) + 'px' : 'auto' });
    $menu.find('.src-dd-list').css('max-height', (maxH - 48) + 'px');
  }

  function openMenu($root) {
    $('.src-dd').not($root).each(function () { closeMenu($(this)); });
    var $menu = $root.find('.src-dd-menu');
    $menu.prop('hidden', false);
    placeMenu($root);
    $root.addClass('is-open').find('.src-dd-trigger').attr('aria-expanded', 'true');
    renderList($root);
    var $sel = $root.find('.src-opt.is-selected');
    if ($sel.length) $sel.addClass('is-active')[0].scrollIntoView({ block: 'nearest' });
    setTimeout(function () { $root.find('.src-dd-search').trigger('focus'); }, 0);
  }

  function closeMenu($root) {
    if (!$root.hasClass('is-open')) return;
    $root.removeClass('is-open').find('.src-dd-menu').prop('hidden', true);
    $root.find('.src-dd-trigger').attr('aria-expanded', 'false');
  }

  function choose($root, key) {
    var action = actionOf($root);
    closeMenu($root);
    $root.find('.src-dd-trigger').trigger('focus');
    if (action === 'merge') {
      mergeChoice = key;
      renderPicker($root);
    } else if (key !== current || window.confirm('Reload ' + key.replace(/^(repo|saved):/, '').split('|')[0] + ' from its source?')) {
      load(key);
    }
  }

  function moveActive($root, dir) {
    var $opts = $root.find('.src-opt:not(.is-disabled)');
    if (!$opts.length) return;
    var idx = $opts.index($opts.filter('.is-active'));
    idx = idx < 0 ? (dir > 0 ? 0 : $opts.length - 1) : Math.max(0, Math.min($opts.length - 1, idx + dir));
    $opts.removeClass('is-active');
    $opts.eq(idx).addClass('is-active')[0].scrollIntoView({ block: 'nearest' });
  }

  SF.refreshSpriteSourceOptions = function () {
    syncCurrentWithWorkspace();
    renderPicker($('#spriteSourcePicker'));
    renderPicker($('#mergeSourcePicker'));
  };
  // Older callers
  SF.refreshMergeSourceOptions = SF.refreshSpriteSourceOptions;

  /** Empty both dropdowns (new workspace). */
  SF.resetSpriteSourcePickers = function () {
    current = '';
    mergeChoice = '';
    merged = {};
    pending = {};
    search = { load: '', merge: '' };
    $('.src-dd').each(function () {
      closeMenu($(this));
      $(this).find('.src-dd-search').val('');
    });
    SF.refreshSpriteSourceOptions();
  };

  /** The sprite now loaded in Update Sprite (called by the loaders). */
  SF.syncSpriteSourceSelect = function (key) {
    if ((key || '') !== current) merged = {};
    current = key || '';
    delete pending[current];
    Object.keys(pending).forEach(function (k) { if (pending[k] === 'load') delete pending[k]; });
    SF.refreshSpriteSourceOptions();
  };

  SF.markSpriteSourceMerged = function (key, ok) {
    delete pending[key];
    if (ok) merged[key] = true;
    SF.refreshSpriteSourceOptions();
  };

  function hasUnsavedNewIcons() {
    return (state.icons || []).some(function (i) { return !i.isExisting; });
  }

  function load(key) {
    if (hasUnsavedNewIcons() && current && current !== key &&
        !window.confirm('Load a different sprite? Icons you added that already exist in it will be dropped.')) return;
    var previous = current;
    pending = {};
    pending[key] = 'load';
    SF.refreshSpriteSourceOptions();
    var job;
    if (key.indexOf('repo:') === 0) {
      var parts = key.slice(5).split('|');
      job = SF.editMasterLibraryPair(parts[0], parts[1] || null);
    } else if (key.indexOf('saved:') === 0) {
      job = SF.editSavedSprite(key.slice(6));
    }
    Promise.resolve(job).then(function (ok) {
      if (pending[key] !== 'load') return;   // a newer choice took over
      delete pending[key];
      // Success already set the value through syncSpriteSourceSelect; on failure keep the previous one.
      if (!ok) current = previous;
      SF.refreshSpriteSourceOptions();
    });
  }

  function merge(key) {
    pending[key] = 'merge';
    SF.refreshSpriteSourceOptions();
    if (typeof SF.mergeFromSource === 'function') {
      SF.mergeFromSource(key).then(function (res) {
        SF.markSpriteSourceMerged(key, !!(res && res.added));
      });
    }
  }

  $(document)
    .on('click', '.src-dd-trigger', function () {
      var $root = $(this).closest('.src-dd');
      if ($root.hasClass('is-open')) closeMenu($root); else openMenu($root);
    })
    .on('keydown', '.src-dd-trigger', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu($(this).closest('.src-dd')); }
    })
    .on('mousemove', '.src-opt:not(.is-disabled)', function () {
      $(this).addClass('is-active').siblings('.src-opt').removeClass('is-active');
    })
    .on('click', '.src-opt', function () {
      if ($(this).hasClass('is-disabled')) return;
      choose($(this).closest('.src-dd'), String($(this).data('key')));
    })
    .on('input', '.src-dd-search', function () {
      var $root = $(this).closest('.src-dd');
      search[actionOf($root)] = $(this).val();
      renderList($root);
      moveActive($root, 1);
    })
    .on('keydown', '.src-dd-search', function (e) {
      var $root = $(this).closest('.src-dd');
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive($root, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive($root, -1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var $a = $root.find('.src-opt.is-active:not(.is-disabled)');
        if ($a.length) choose($root, String($a.data('key')));
      } else if (e.key === 'Escape') { closeMenu($root); $root.find('.src-dd-trigger').trigger('focus'); }
    })
    .on('click', '.src-dd-refresh', function () {
      if (typeof SF.loadSavedFolders === 'function') SF.loadSavedFolders();
      renderList($(this).closest('.src-dd'));
    })
    .on('wheel', '.src-dd-menu', function (e) { e.stopPropagation(); })
    .on('mousedown', function (e) {
      if (!$(e.target).closest('.src-dd').length) $('.src-dd.is-open').each(function () { closeMenu($(this)); });
    })
    .on('click', '#mergeSourceBtn', function () {
      if (mergeChoice && mergeChoice !== current) merge(mergeChoice);
    })
    // Entering Update Sprite: make sure saved sprites are listed.
    .on('click', '.sidebar-link[data-mode="existing"]', function () {
      if (typeof SF.getSavedSpriteFolders === 'function' && !SF.getSavedSpriteFolders().length &&
          typeof SF.loadSavedFolders === 'function') {
        SF.loadSavedFolders();
      }
      SF.refreshSpriteSourceOptions();
    });

  // Keep an open menu attached to its trigger while the page scrolls or resizes.
  window.addEventListener('scroll', function (e) {
    if ($(e.target).closest && $(e.target).closest('.src-dd-menu').length) return;
    $('.src-dd.is-open').each(function () { placeMenu($(this)); });
  }, true);
  window.addEventListener('resize', function () { $('.src-dd.is-open').each(function () { placeMenu($(this)); }); });

  $(function () { setTimeout(SF.refreshSpriteSourceOptions, 0); });

})(window.SpriteForge, jQuery);
