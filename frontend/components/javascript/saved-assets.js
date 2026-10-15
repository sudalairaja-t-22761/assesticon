/**
 * SpriteForge - Saved Assets page
 * Lists the signed-in user's Savedassest/<username>/ folder tree (branch folders and any nested
 * folders) from the save-assets API, with an image preview for every file.
 */
(function (SF, $) {
  'use strict';

  var PAGE = 'savedassets';
  var loaded = false;

  function api() { return window.SF_SAVE_ASSETS_API || ''; }

  function owner() {
    var a = (SF.state && SF.state.auth) || {};
    return (a.username || a.useremail || '').trim();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtSize(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }

  function countFiles(node) {
    return (node.children || []).reduce(function (t, c) { return t + (c.type === 'file' ? 1 : countFiles(c)); }, 0);
  }

  function renderNode(node, depth) {
    var files   = (node.children || []).filter(function (c) { return c.type === 'file'; });
    var folders = (node.children || []).filter(function (c) { return c.type === 'folder'; });
    var html = '';

    folders.forEach(function (f) {
      html += '<details class="sa-folder"' + (depth < 1 ? ' open' : '') + '>' +
        '<summary><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
        esc(f.name) + '<span class="sa-folder-count">' + countFiles(f) + '</span></summary>' +
        '<div class="sa-folder-body">' + renderNode(f, depth + 1) + '</div></details>';
    });

    if (files.length) {
      html += '<div class="sa-grid">' + files.map(function (f) {
        var src = f.data_url || f.preview_url || '';
        return '<div class="sa-card" title="' + esc(f.key) + '">' +
          '<div class="sa-thumb" data-sa-src="' + esc(src) + '" data-sa-name="' + esc(f.name) + '">' +
          (src ? '<img loading="lazy" alt="' + esc(f.name) + '" src="' + esc(src) + '">' : '<span class="sa-meta">no preview</span>') + '</div>' +
          '<div class="sa-name">' + esc(f.name) + '</div>' +
          '<div class="sa-meta">' + fmtSize(f.size_bytes) + '</div></div>';
      }).join('') + '</div>';
    }
    return html;
  }

  function load() {
    var $tree = $('#savedAssetsTree'), $sum = $('#savedAssetsSummary'), user = owner();
    $('#savedAssetsOwner').text(user ? '· ' + user : '');
    if (!user) {
      $sum.text('');
      $tree.html('<div class="sa-empty">Sign in to see your saved assets.</div>');
      return;
    }
    $sum.text('Loading…');
    $.getJSON(api(), { username: user })
      .done(function (d) {
        loaded = true;
        if (!d.file_count && !d.folder_count) {
          $sum.text('');
          $tree.html('<div class="sa-empty">No saved assets for <strong>' + esc(user) + '</strong> yet.</div>');
          return;
        }
        $sum.text(d.folder_count + ' folder' + (d.folder_count === 1 ? '' : 's') + ' · ' + d.file_count + ' image' + (d.file_count === 1 ? '' : 's'));
        $tree.html(renderNode(d.tree, 0));
      })
      .fail(function (xhr) {
        var msg = (xhr.responseJSON && xhr.responseJSON.message) || 'Could not load saved assets.';
        $sum.text('');
        $tree.html('<div class="sa-error">' + esc(msg) + '</div>');
      });
  }

  // Click a thumbnail → larger preview
  $(document).on('click', '#savedAssetsTree .sa-thumb', function () {
    var src = $(this).data('sa-src');
    if (!src) return;
    var $lb = $('<div class="sa-lightbox"><img alt=""><span></span></div>');
    $lb.find('img').attr('src', src);
    $lb.find('span').text($(this).data('sa-name'));
    $lb.on('click', function () { $lb.remove(); }).appendTo('body');
  });

  // Wrap switchPage: reuse 'mostused' for the shared reset, then swap our page in.
  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    $('#savedAssetsPage').addClass('hidden');
    $('#savedAssetsBtn').removeClass('active');
    if (page !== PAGE) return origSwitch(page);

    origSwitch('mostused');
    $('#mostUsedPage').addClass('hidden');
    $('#mostUsedBtn').removeClass('active');
    SF.state.page = PAGE;
    try { localStorage.setItem('sf_active_page', PAGE); } catch (e) {}
    $('#savedAssetsPage').removeClass('hidden');
    $('#savedAssetsBtn').addClass('active');
    $('#pageTitle').text('Saved Assets');
    $('#pageBreadcrumb').text('Output');
    load();
  };

  $(function () {
    Promise.all(window._componentPromises || []).then(function () {
      $('#savedAssetsBtn').on('click', function () { SF.switchPage(PAGE); });
      $(document).on('click', '#refreshSavedAssetsBtn', load);
      // app.js can't restore this page after a refresh (it isn't in its valid list) — do it here.
      var last = null;
      try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
      if (last === PAGE) setTimeout(function () { SF.switchPage(PAGE); }, 0);
    });
  });
})(window.SpriteForge, jQuery);
