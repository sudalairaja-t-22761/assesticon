/**
 * SpriteForge - Asset Store page
 * Lists every image (any format) of the Iconassest repo's Assets folder, read directly from the
 * repository through /api/icon-library/assets, with a click-to-preview dialog.
 */
(function (SF, $) {
  'use strict';

  var PAGE = 'assetstore';
  var files = [];        // all images from the server
  var shown = [];        // after search / format filter (the preview steps through these)
  var blobs = {};        // repo path → { url, size, w, h } (loaded lazily)
  var inflight = {};
  var queue = [], active = 0, MAX_PARALLEL = 4;
  var observer = null;
  var current = -1;      // index into `shown` of the open preview
  var meta = null;       // last listing (repo config, commit)

  function url(p) {
    return String(window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/').replace(/\/+$/, '') + '/api/icon-library/' + p;
  }
  function headers() { return typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {}; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }

  // ── image loading (auth header → blob URL) ───────────────────────────
  function fetchImage(f) {
    if (blobs[f.path]) return Promise.resolve(blobs[f.path]);
    if (inflight[f.path]) return inflight[f.path];
    inflight[f.path] = new Promise(function (resolve, reject) {
      queue.push({ f: f, resolve: resolve, reject: reject });
      pump();
    }).then(function (b) { delete inflight[f.path]; return b; }, function (e) { delete inflight[f.path]; throw e; });
    return inflight[f.path];
  }
  function pump() {
    while (active < MAX_PARALLEL && queue.length) {
      (function (job) {
        active++;
        fetch(url('asset?path=' + encodeURIComponent(job.f.path)), { headers: headers() })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
          .then(function (blob) {
            var b = { url: URL.createObjectURL(blob), size: blob.size, w: 0, h: 0 };
            blobs[job.f.path] = b;
            job.resolve(b);
          })
          .catch(job.reject)
          .then(function () { active--; pump(); });
      })(queue.shift());
    }
  }

  function loadThumb(el) {
    var f = shown[+el.getAttribute('data-i')];
    if (!f) return;
    fetchImage(f).then(function (b) {
      if (el.querySelector('img')) return;
      var img = new Image();
      img.alt = f.name;
      img.onload = function () { b.w = img.naturalWidth; b.h = img.naturalHeight; };
      img.src = b.url;
      el.innerHTML = '';
      el.appendChild(img);
    }, function () { el.innerHTML = '<span class="as-meta">failed to load</span>'; });
  }

  function watchThumbs() {
    if (observer) observer.disconnect();
    var thumbs = document.querySelectorAll('#assetStoreGrid .as-thumb');
    if (!('IntersectionObserver' in window)) { Array.prototype.forEach.call(thumbs, loadThumb); return; }
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { observer.unobserve(e.target); loadThumb(e.target); } });
    }, { rootMargin: '200px' });
    Array.prototype.forEach.call(thumbs, function (t) { observer.observe(t); });
  }

  // ── render ───────────────────────────────────────────────────────────
  function applyFilter() {
    var q = ($('#assetStoreSearch').val() || '').trim().toLowerCase();
    var ext = $('#assetStoreFormat').val() || '';
    shown = files.filter(function (f) {
      return (!ext || f.ext === ext) && (!q || f.path.toLowerCase().indexOf(q) !== -1);
    });
    render();
  }

  function render() {
    var $grid = $('#assetStoreGrid');
    $('#assetStoreCount').text(files.length ? '· ' + files.length : '');
    if (!shown.length) {
      $grid.html('<div class="as-empty">' + (files.length ? 'No images match your search.' : 'No images found in the Assets folder.') + '</div>');
      $('#assetStoreSummary').text('');
      return;
    }
    $('#assetStoreSummary').text(shown.length === files.length
      ? files.length + ' image' + (files.length === 1 ? '' : 's') + ' in ' + ((meta && meta.dir) || 'Assets')
      : shown.length + ' of ' + files.length + ' images');

    var groups = [], byFolder = {};
    shown.forEach(function (f, i) {
      if (!byFolder[f.folder]) { byFolder[f.folder] = []; groups.push(f.folder); }
      byFolder[f.folder].push({ f: f, i: i });
    });
    var multi = groups.length > 1 || groups[0] !== '';
    $grid.html(groups.map(function (g) {
      return (multi ? '<div class="as-group-title">' + esc(g || '(root)') + '<span>' + byFolder[g].length + '</span></div>' : '') +
        '<div class="as-grid">' + byFolder[g].map(function (x) {
          return '<div class="as-card" tabindex="0" role="button" data-i="' + x.i + '" title="' + esc(x.f.path) + '">' +
            '<div class="as-thumb" data-i="' + x.i + '"><span class="as-meta">loading…</span></div>' +
            '<div class="as-name">' + esc(x.f.name) + '</div><div class="as-meta">' + esc(x.f.ext) + '</div></div>';
        }).join('') + '</div>';
    }).join(''));
    watchThumbs();
  }

  function load(refresh) {
    var $sum = $('#assetStoreSummary'), $grid = $('#assetStoreGrid');
    if (typeof SF.isMasterLibrarySignedOut === 'function' && SF.isMasterLibrarySignedOut()) {
      $sum.text('');
      $grid.html('<div class="as-empty">Sign in to browse the Asset Store.</div>');
      return;
    }
    $sum.text('Loading from repository…');
    $.ajax({ url: url('assets' + (refresh ? '?refresh=1' : '')), dataType: 'json', headers: headers(), timeout: SF.MASTER_LIBRARY_TIMEOUT_MS || 90000 })
      .done(function (d) {
        meta = d;
        files = d.files || [];
        Object.keys(blobs).forEach(function (k) { URL.revokeObjectURL(blobs[k].url); delete blobs[k]; });
        var exts = [];
        files.forEach(function (f) { if (exts.indexOf(f.ext) === -1) exts.push(f.ext); });
        exts.sort();
        var cur = $('#assetStoreFormat').val();
        $('#assetStoreFormat').html('<option value="">All formats</option>' + exts.map(function (e) {
          return '<option value="' + esc(e) + '">' + esc(e.toUpperCase()) + '</option>';
        }).join('')).val(exts.indexOf(cur) !== -1 ? cur : '');
        applyFilter();
      })
      .fail(function (xhr) {
        var msg = (xhr.responseJSON && xhr.responseJSON.message) || 'Could not load the Asset Store from the repository.';
        $sum.text('');
        $grid.html('<div class="as-error">' + esc(msg) + '</div>');
      });
  }

  // ── preview ──────────────────────────────────────────────────────────
  function closePreview() { $('#assetPreview').remove(); $(document).off('keydown.assetpreview'); current = -1; }

  function openPreview(i) {
    var f = shown[i];
    if (!f) return;
    current = i;
    var $p = $('#assetPreview');
    if (!$p.length) {
      $p = $(
        '<div class="as-preview" id="assetPreview"><div class="as-preview-box">' +
          '<div class="as-preview-head"><div class="as-preview-title"></div>' +
            '<button class="btn btn-ghost btn-sm" id="assetPreviewClose">Close</button></div>' +
          '<div class="as-preview-stage"><button class="as-preview-nav as-preview-prev" aria-label="Previous">&#8249;</button>' +
            '<span class="as-meta">loading…</span>' +
            '<button class="as-preview-nav as-preview-next" aria-label="Next">&#8250;</button></div>' +
          '<div class="as-preview-info"></div>' +
        '</div></div>').appendTo('body');
      $p.on('click', function (e) { if (e.target === this) closePreview(); });
      $p.on('click', '#assetPreviewClose', closePreview);
      $p.on('click', '.as-preview-prev', function () { step(-1); });
      $p.on('click', '.as-preview-next', function () { step(1); });
      $p.on('click', '#assetPreviewCopy', function () {
        var t = shown[current] && shown[current].path;
        if (t && navigator.clipboard) navigator.clipboard.writeText(t).then(function () { if (SF.toast) SF.toast('Path copied'); });
      });
      $(document).on('keydown.assetpreview', function (e) {
        if (e.key === 'Escape') closePreview();
        else if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'ArrowRight') step(1);
      });
    }
    $p.find('.as-preview-title').text(f.name);
    $p.find('.as-preview-nav').toggle(shown.length > 1);
    var $stage = $p.find('.as-preview-stage');
    $stage.find('img, .as-meta').remove();
    $stage.prepend('<span class="as-meta">loading…</span>');
    renderInfo($p, f, null);

    fetchImage(f).then(function (b) {
      if (shown[current] !== f) return;
      var img = new Image();
      img.alt = f.name;
      img.onload = function () { b.w = img.naturalWidth; b.h = img.naturalHeight; if (shown[current] === f) renderInfo($p, f, b); };
      img.src = b.url;
      $stage.find('.as-meta').remove();
      $stage.prepend(img);
      renderInfo($p, f, b);
    }, function () {
      if (shown[current] === f) $stage.find('.as-meta').text('Could not load this image.');
    });
  }

  function renderInfo($p, f, b) {
    var repo = (meta && meta.repo) || {};
    var web = repo.baseUrl ? repo.baseUrl + '/' + repo.projectPath + '#/source/' + repo.branch + '/' + repo.repoName + '/' + f.path : '';
    $p.find('.as-preview-info').html(
      '<span>Format <b>' + esc(f.ext.toUpperCase()) + '</b></span>' +
      (b && b.w ? '<span>Dimensions <b>' + b.w + ' × ' + b.h + '</b></span>' : '') +
      (b ? '<span>Size <b>' + fmtSize(b.size) + '</b></span>' : '') +
      '<span>Path <b>' + esc(f.path) + '</b></span>' +
      '<span class="as-preview-actions">' +
        '<button class="btn btn-ghost btn-sm" id="assetPreviewCopy">Copy path</button>' +
        (b ? '<a class="btn btn-ghost btn-sm" href="' + esc(b.url) + '" download="' + esc(f.name) + '">Download</a>' : '') +
        (web ? '<a class="btn btn-ghost btn-sm" href="' + esc(web) + '" target="_blank" rel="noopener">Open in repo</a>' : '') +
      '</span>');
  }

  function step(d) {
    if (shown.length < 2) return;
    openPreview((current + d + shown.length) % shown.length);
  }

  // ── page switching (same pattern as saved-assets.js) ─────────────────
  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    $('#assetStorePage').addClass('hidden');
    $('#assetStoreBtn').removeClass('active');
    if (page !== PAGE) return origSwitch(page);

    origSwitch('mostused');
    $('#mostUsedPage').addClass('hidden');
    $('#mostUsedBtn').removeClass('active');
    SF.state.page = PAGE;
    try { localStorage.setItem('sf_active_page', PAGE); } catch (e) {}
    $('#assetStorePage').removeClass('hidden');
    $('#assetStoreBtn').addClass('active');
    $('#pageTitle').text('Asset Store');
    $('#pageBreadcrumb').text('Library');
    if (!files.length) load(false); else applyFilter();
  };

  $(function () {
    Promise.all(window._componentPromises || []).then(function () {
      $('#assetStoreBtn').on('click', function () { SF.switchPage(PAGE); });
      $(document).on('click', '#refreshAssetStoreBtn', function () { load(true); });
      $(document).on('input', '#assetStoreSearch', applyFilter);
      $(document).on('change', '#assetStoreFormat', applyFilter);
      $(document).on('click', '#assetStoreGrid .as-card', function () { openPreview(+$(this).data('i')); });
      $(document).on('keydown', '#assetStoreGrid .as-card', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(+$(this).data('i')); }
      });
      var last = null;
      try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
      if (last === PAGE) setTimeout(function () { SF.switchPage(PAGE); }, 0);
    });
  });
})(window.SpriteForge, jQuery);
