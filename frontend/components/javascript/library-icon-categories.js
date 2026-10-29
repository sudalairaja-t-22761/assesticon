/**
 * SpriteForge - Icon Library categories (GET /api/icon-categories)
 *
 * - One filter chip per category after the status chips: only that category's icons are shown
 * - A category with "Size & stroke" on gives its icons the Size + Stroke width options in the preview
 *   (the built-in "Stroke icons" category starts as the CRM strokeIcons list)
 * - Admin: tick icons → pick a category → Add / Remove; "Categories" opens a dialog to create, rename,
 *   switch Size & stroke on/off and delete categories
 */
(function (SF, $) {
  'use strict';

  var cats = null;           // [{ id, name, options, builtin, names[] }] once loaded
  var index = {};            // icon name → [category]
  var loading = false, failedAt = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function toast(m) { if (SF.showToast) SF.showToast(m); }
  function isAdmin() { return !!(SF.wf && SF.wf.role === 'admin'); }
  function nameOf(icon) { return String((icon && (icon.name || icon.symbolId)) || '').toLowerCase().replace(/^zcicn-/, '').replace(/__s$/, ''); }

  // "HTTP 404 · Cannot GET …" rather than a bare "failed": says whether the server is old, signed out or broken.
  function errorText(xhr, status) {
    var j = xhr.responseJSON, body = String(xhr.responseText || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (j && j.message) return j.message + ' (HTTP ' + xhr.status + ')';
    if (!xhr.status) return 'No answer from the server (' + (status || 'network error') + ')';
    return 'HTTP ' + xhr.status + ' from ' + (this && this.url ? this.url.replace(/[?#].*$/, '') : 'api/icon-categories') + (body ? ' · ' + body : '');
  }

  function api(method, path, body) {
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: SF.masterLibraryUrl('api/icon-categories' + (path || '')), type: method, dataType: 'json', contentType: 'application/json',
        headers: SF.masterLibraryAuthHeaders ? SF.masterLibraryAuthHeaders() : {}, data: body ? JSON.stringify(body) : undefined,
        success: resolve,
        error: function (xhr, status) { reject(new Error(errorText.call(this, xhr, status))); }
      });
    });
  }

  function apply(r) {
    cats = r.categories || [];
    index = {};
    cats.forEach(function (c) { c.names.forEach(function (n) { (index[n] = index[n] || []).push(c); }); });
    // A filter on a category that no longer exists shows everything again.
    if (SF.libState && SF.libState.categoryFilter && !byId(SF.libState.categoryFilter)) SF.libState.categoryFilter = '';
    refresh();
    return r;
  }
  function byId(id) { return (cats || []).filter(function (c) { return c.id === id; })[0] || null; }

  // Library grid (chips, counts, filter) and the open preview depend on the categories.
  function refresh() {
    if (typeof SF.renderLibraryGrid === 'function' && $('#libGrid').length) SF.renderLibraryGrid();
    else updateBulk();
    if (SF.libPreview && SF.libPreview.current()) SF.libPreview.render();
    if ($('#libCatDialog:not(.hidden)').length) renderDialog();
  }

  function load(force) {
    if (cats || loading || !SF.masterLibraryUrl || (!force && Date.now() - failedAt < 10000)) return;
    loading = true;
    api('GET').then(apply, function (e) {
      failedAt = Date.now(); // tried again later (signed out, server busy)
      if (isAdmin() && force) toast('Icon categories: ' + e.message);
    }).then(function () { loading = false; });
  }

  function change(method, path, body, done) {
    return api(method, path, body).then(function (r) { apply(r); if (done) toast(done); return r; }, function (e) { toast(e.message); throw e; });
  }

  SF.iconCategories = {
    load: load,
    loaded: function () { return !!cats; },
    list: function () { return (cats || []).slice(); },
    of: function (icon) { return index[nameOf(icon)] || []; },
    has: function (icon, id) { return (index[nameOf(icon)] || []).some(function (c) { return c.id === id; }); },
    hasOptions: function (icon) { return (index[nameOf(icon)] || []).some(function (c) { return c.options; }); },
    // Filter chips for workflow.js's status bar ('' until loaded or when there are no categories).
    chipsHtml: function () {
      if (!cats || !cats.length) return '';
      var cur = (SF.libState && SF.libState.categoryFilter) || '', counts = {};
      ((SF.libState && SF.libState.icons) || []).forEach(function (ic) {
        if (ic.source === 'repo') (index[nameOf(ic)] || []).forEach(function (c) { counts[c.id] = (counts[c.id] || 0) + 1; });
      });
      return '<span class="vf-filter-sep" aria-hidden="true"></span>' + cats.map(function (c) {
        return '<button type="button" class="lib-source-chip' + (c.id === cur ? ' active' : '') + '" data-lib-cat="' + esc(c.id) + '" aria-pressed="' + (c.id === cur) + '"' +
          ' title="' + esc(c.name + (c.options ? ' · these icons get the Size and Stroke width options' : '')) + '">' + esc(c.name) +
          ' <span class="lib-source-count">' + (counts[c.id] || 0) + '</span></button>';
      }).join('');
    }
  };

  // Filter: one category at a time (click again to show all); combines with the status chips.
  $(document).on('click', '[data-lib-cat]', function () {
    var id = String($(this).data('lib-cat'));
    SF.libState.categoryFilter = SF.libState.categoryFilter === id ? '' : id;
    SF.renderLibraryGrid();
  });

  // ── admin bulk bar: tick icons → category → Add / Remove ──────────────────
  function selectedRepoIcons() {
    var sel = (SF.libState && SF.libState.selected) || {};
    return ((SF.libState && SF.libState.icons) || []).filter(function (i) { return i && i.source === 'repo' && sel[i.id]; });
  }
  function currentCat() {
    var id = $('#libCatSelect').val() || (SF.libState && SF.libState.categoryFilter) || (cats && cats[0] && cats[0].id);
    return byId(id);
  }
  function updateBulk() {
    var $bar = $('#libBulkActions');
    if (!$bar.length) return;
    if (!$('#libCatBulk').length) {
      $bar.append(
        '<span class="lib-cat-bulk hidden" id="libCatBulk">' +
          '<select id="libCatSelect" aria-label="Category"></select>' +
          '<button class="btn btn-ghost btn-sm" id="libCatAddBtn" type="button">Add to category</button>' +
          '<button class="btn btn-ghost btn-sm" id="libCatRemoveBtn" type="button">Remove from category</button>' +
          '<button class="btn btn-ghost btn-sm" id="libCatManageBtn" type="button" title="Create, rename and delete categories">Categories…</button>' +
        '</span>');
    }
    var show = isAdmin() && !!cats;
    $('#libCatBulk').toggleClass('hidden', !show);
    if (!show) return;
    var $sel = $('#libCatSelect'), keep = $sel.val() || (SF.libState && SF.libState.categoryFilter) || '';
    $sel.html(cats.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join(''));
    if (keep && byId(keep)) $sel.val(keep);
    var c = currentCat(), icons = selectedRepoIcons();
    var inCat = c ? icons.filter(function (i) { return SF.iconCategories.has(i, c.id); }).length : 0;
    $('#libCatAddBtn').prop('disabled', !c || icons.length - inCat === 0).text('Add to category' + (icons.length - inCat ? ' (' + (icons.length - inCat) + ')' : ''));
    $('#libCatRemoveBtn').prop('disabled', !c || inCat === 0).text('Remove from category' + (inCat ? ' (' + inCat + ')' : ''));
  }
  function bulk(add) {
    var c = currentCat();
    if (!c) return;
    var icons = selectedRepoIcons().filter(function (i) { return SF.iconCategories.has(i, c.id) !== add; });
    if (!icons.length) return;
    var names = icons.map(nameOf), n = names.length + ' icon' + (names.length === 1 ? '' : 's');
    if (!add && !window.confirm('Remove ' + n + ' from "' + c.name + '"?')) return;
    $('#libCatAddBtn, #libCatRemoveBtn').prop('disabled', true);
    change('PUT', '/' + encodeURIComponent(c.id) + '/icons', { names: names, enabled: add }, (add ? 'Added ' + n + ' to "' : 'Removed ' + n + ' from "') + c.name + '"')
      .catch(function () {}).then(updateBulk);
  }
  $(document).on('change', '#libCatSelect', updateBulk);
  $(document).on('click', '#libCatAddBtn', function () { bulk(true); });
  $(document).on('click', '#libCatRemoveBtn', function () { bulk(false); });
  // Ticking icons does not re-render the grid: refresh the button counts after each change.
  $(document).on('change', '.library-select-checkbox, #libSelectAllVisible', function () { setTimeout(updateBulk, 0); });
  $(document).on('click', '#libGrid .lib-card', function () { setTimeout(updateBulk, 0); });

  // ── "Categories…" dialog (admin) ──────────────────────────────────────────
  function ensureDialog() {
    if ($('#libCatDialog').length) return;
    $('body').append(
      '<div class="lps-overlay lcat-overlay hidden" id="libCatDialog" role="dialog" aria-modal="true" aria-labelledby="lcatTitle">' +
        '<div class="lcat">' +
          '<div class="lcat-head"><b id="lcatTitle">Icon categories</b>' +
            '<button class="lpp-close" id="lcatClose" type="button" aria-label="Close">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>' +
          '<div class="lcat-hint">Each category gets a filter chip in the Library. Turn on <b>Size &amp; stroke</b> to give its icons the Size and Stroke width options. Add or remove icons by ticking them in the Library.</div>' +
          '<div class="lcat-list" id="lcatList"></div>' +
          '<form class="lcat-new" id="lcatNew"><input type="text" id="lcatNewName" maxlength="40" placeholder="New category name" aria-label="New category name">' +
            '<label class="lcat-opt"><input type="checkbox" id="lcatNewOptions"> Size &amp; stroke</label>' +
            '<button class="btn btn-primary btn-sm" type="submit">Add category</button></form>' +
        '</div>' +
      '</div>');
  }
  function renderDialog() {
    $('#lcatList').html((cats || []).map(function (c) {
      return '<div class="lcat-row" data-cat="' + esc(c.id) + '">' +
        '<input type="text" class="lcat-name" maxlength="40" value="' + esc(c.name) + '" aria-label="Category name">' +
        '<span class="lcat-count">' + c.names.length + ' icon' + (c.names.length === 1 ? '' : 's') + '</span>' +
        '<label class="lcat-opt"><input type="checkbox" class="lcat-options"' + (c.options ? ' checked' : '') + '> Size &amp; stroke</label>' +
        (c.builtin ? '<span class="lcat-builtin" title="Built-in category: it can be renamed and edited, not deleted">built-in</span>'
          : '<button type="button" class="btn btn-ghost btn-sm lcat-del" style="color:var(--danger)">Delete</button>') +
      '</div>';
    }).join('') || '<div class="lcat-hint">No categories yet.</div>');
  }
  $(document).on('click', '#libCatManageBtn', function () {
    ensureDialog(); renderDialog();
    $('#libCatDialog').removeClass('hidden'); $('#lcatNewName').trigger('focus');
  });
  function closeDialog() { $('#libCatDialog').addClass('hidden'); $('#libCatManageBtn').trigger('focus'); }
  $(document).on('click', '#lcatClose', closeDialog);
  $(document).on('click', '#libCatDialog', function (e) { if (e.target === this) closeDialog(); });
  $(document).on('keydown', function (e) { if (e.key === 'Escape' && $('#libCatDialog:not(.hidden)').length) closeDialog(); });
  $(document).on('submit', '#lcatNew', function (e) {
    e.preventDefault();
    var name = $('#lcatNewName').val().trim();
    if (!name) { $('#lcatNewName').trigger('focus'); return; }
    change('POST', '', { name: name, options: $('#lcatNewOptions').prop('checked') }, 'Category "' + name + '" added').then(function (r) {
      $('#lcatNewName').val(''); $('#lcatNewOptions').prop('checked', false);
      if (r.category) $('#libCatSelect').val(r.category.id);
      updateBulk();
    }, function () {});
  });
  $(document).on('change', '#lcatList .lcat-name', function () {
    var id = $(this).closest('.lcat-row').data('cat'), name = this.value.trim(), c = byId(String(id));
    if (!c || !name || name === c.name) { this.value = c ? c.name : ''; return; }
    change('PATCH', '/' + encodeURIComponent(id), { name: name }, 'Renamed to "' + name + '"').catch(function () { renderDialog(); });
  });
  $(document).on('change', '#lcatList .lcat-options', function () {
    var id = $(this).closest('.lcat-row').data('cat'), on = this.checked, c = byId(String(id));
    change('PATCH', '/' + encodeURIComponent(id), { options: on }, 'Size & stroke ' + (on ? 'on' : 'off') + ' for "' + (c ? c.name : id) + '"').catch(function () { renderDialog(); });
  });
  $(document).on('click', '#lcatList .lcat-del', function () {
    var id = String($(this).closest('.lcat-row').data('cat')), c = byId(id);
    if (!c || !window.confirm('Delete the category "' + c.name + '"' + (c.names.length ? ' (' + c.names.length + ' icons)' : '') + '? The icons themselves stay in the Library.')) return;
    change('DELETE', '/' + encodeURIComponent(id), null, 'Category "' + c.name + '" deleted').catch(function () {});
  });

  // Keep the bulk bar in step with every grid render.
  var origRender = SF.renderLibraryGrid;
  if (typeof origRender === 'function') {
    SF.renderLibraryGrid = function () { var r = origRender.apply(this, arguments); load(); updateBulk(); return r; };
  }
})(window.SpriteForge, jQuery);
