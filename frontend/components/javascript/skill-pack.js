/**
 * SpriteForge - Skill package
 * Every signed-in user: the "Get Skill" button in the top bar opens a dialog with the skill zip (Download), the
 * install prompt (Copy) and the commands to run after the download (Copy, one by one).
 * Admins: the "Skill package" sidebar page uploads / replaces the zip and edits the two texts.
 * API: /api/skill-pack (functions/spriteForgeJoin/routes/skill-pack.js).
 */
(function (SF, $) {
  'use strict';

  var PAGE = 'skilladmin';
  var MAX_ZIP = 5 * 1024 * 1024;
  var pack = null;      // last GET /api/skill-pack
  var picked = null;    // admin: { name, size, data (data URL) } waiting to be uploaded

  function base() { return String(window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/').replace(/\/+$/, '') + '/api/'; }
  function headers() { return typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {}; }
  function isAdmin() { return !!(SF.wf && SF.wf.role === 'admin'); }
  function signedIn() { return !!(SF.state && SF.state.auth && SF.state.auth.isAuthenticated); }
  function toast(m) { if (SF.showToast) SF.showToast(m); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, body) {
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: base() + 'skill-pack', type: method, dataType: 'json', headers: headers(), timeout: 120000,
        contentType: 'application/json', data: body ? JSON.stringify(body) : undefined,
        success: resolve,
        error: function (xhr) {
          reject(new Error((xhr.responseJSON && xhr.responseJSON.message) || (xhr.status === 401 ? 'Sign in first' : xhr.status === 404 ? 'The server does not have this feature yet — redeploy the backend' : xhr.status === 413 ? 'The file is too large for the server' : 'Request failed')));
        }
      });
    });
  }
  function size(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function when(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  }
  function details(p) {
    if (!p || !p.available) return '<div class="sk-empty">No skill uploaded yet.</div>';
    return '<div class="sk-file"><div class="sk-file-icon">' + svg(ZIP_ICON, 22) + '</div><div class="sk-file-meta">' +
      '<b>' + esc(p.fileName) + '</b>' +
      '<span class="sk-muted">' + esc(size(p.size)) + (p.version ? ' · version ' + esc(p.version) : '') + '</span>' +
      '<span class="sk-muted">Updated ' + esc(when(p.uploadedAt)) + (p.uploadedBy ? ' by ' + esc(p.uploadedBy) : '') + '</span>' +
      '</div></div>';
  }

  var ZIP_ICON = '<path d="M21 8v13H3V3h13z"/><path d="M16 3v5h5M10 7h2M10 10h2M10 13h2"/>';
  var DOWN_ICON = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>';
  var COPY_ICON = '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
  function svg(paths, px) { return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'; }

  // ── everyone: the Get Skill dialog ────────────────────────────────────────
  function ensureModal() {
    var $m = $('#skillModal');
    if ($m.length) return $m;
    $m = $(
      '<div class="modal-overlay hidden" id="skillModal" role="dialog" aria-modal="true" aria-labelledby="skillModalTitle">' +
        '<div class="modal-overlay-bg" data-skill-close></div>' +
        '<div class="modal sk-modal">' +
          '<div class="modal-header"><h3 id="skillModalTitle">' + svg(ZIP_ICON, 16) + 'Get the CRM icon skill</h3>' +
            '<button type="button" class="modal-close" data-skill-close aria-label="Close">&times;</button></div>' +
          '<div class="modal-body sk-body" id="skillModalBody"></div>' +
        '</div>' +
      '</div>');
    $('body').append($m);
    return $m;
  }
  function renderModal() {
    var p = pack || {};
    $('#skillModalBody').html(
      '<section class="sk-step"><h4><span class="sk-num">1</span>Download the skill</h4>' +
        '<div class="sk-row">' + details(p) +
          '<button type="button" class="btn btn-primary" id="skillDownload"' + (p.available ? '' : ' disabled') + '>' + svg(DOWN_ICON, 14) + ' Download zip</button></div>' +
        '<div class="sk-msg is-bad hidden" id="skillDlMsg" role="status"></div></section>' +
      '<section class="sk-step"><h4><span class="sk-num">2</span>Install it — paste this prompt into Claude Code' +
          '<button type="button" class="btn btn-ghost btn-sm sk-copy" id="skillCopyPrompt">' + svg(COPY_ICON, 14) + ' Copy prompt</button></h4>' +
        '<pre class="sk-prompt" id="skillPromptText" tabindex="0">' + esc(p.prompt || '') + '</pre></section>' +
      '<section class="sk-step"><h4><span class="sk-num">3</span>After download — run in your CRM project</h4>' +
        '<div class="sk-cmds">' + (p.commands || []).map(function (c, i) {
          return '<div class="sk-cmd"><code>' + esc(c) + '</code>' +
            '<button type="button" class="btn btn-ghost btn-sm sk-copy" data-skill-cmd="' + i + '" aria-label="Copy command ' + (i + 1) + '">' + svg(COPY_ICON, 14) + '</button></div>';
        }).join('') + '</div></section>');
  }
  function openModal() {
    var $m = ensureModal();
    $('#skillModalBody').html('<div class="sk-muted">Loading…</div>');
    $m.removeClass('hidden');
    $m.find('.modal-close').trigger('focus');
    $(document).on('keydown.skillModal', function (e) { if (e.key === 'Escape') closeModal(); });
    api('GET').then(function (r) { pack = r; renderModal(); })
      .catch(function (err) { $('#skillModalBody').html('<div class="sk-msg is-bad">' + esc(err.message) + '</div>'); });
  }
  function closeModal() {
    $('#skillModal').addClass('hidden');
    $(document).off('keydown.skillModal');
    $('#skillGetBtn').trigger('focus');
  }
  // The zip is fetched with the session header and saved from memory, so the session never goes into a URL.
  function download($btn, $msg) {
    var html = $btn.html();
    $btn.prop('disabled', true).text('Downloading…');
    $msg.addClass('hidden');
    fetch(base() + 'skill-pack/download', { headers: headers(), cache: 'no-store' }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.message || 'The download failed (' + res.status + ')'); });
      return res.blob();
    }).then(function (blob) {
      var a = document.createElement('a'), href = URL.createObjectURL(blob);
      a.href = href; a.download = (pack && pack.fileName) || 'skill-pack.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
      toast('Skill zip downloaded');
    }).catch(function (err) { $msg.removeClass('hidden').text(err.message); })
      .then(function () { $btn.prop('disabled', false).html(html); });
  }

  // ── admin: the Skill package page ─────────────────────────────────────────
  function pageHtml() {
    return '<div class="content hidden" id="skillAdminPage"><div class="sk-cols">' +
      '<div class="panel">' +
        '<div class="panel-header"><h3 class="panel-title">' + svg(ZIP_ICON, 16) + 'Skill zip</h3><span class="sk-muted">Admins only</span></div>' +
        '<div class="panel-body sk-form">' +
          '<div id="skAdminDetails"></div>' +
          '<label class="sk-label" for="skFile">Upload a zip <span class="sk-muted">(.zip, up to 5 MB — it replaces the current one)</span></label>' +
          '<div class="sk-drop" id="skDrop">' +
            '<input type="file" id="skFile" accept=".zip,application/zip" hidden>' +
            '<button type="button" class="btn btn-ghost btn-sm" id="skPick">Choose zip</button>' +
            '<span class="sk-muted" id="skFileName">or drop the file here</span>' +
            '<button type="button" class="btn btn-ghost btn-sm hidden" id="skUnpick">Remove</button>' +
          '</div>' +
          '<label class="sk-label" for="skVersion">Version label <span class="sk-muted">(optional, shown to users)</span></label>' +
          '<input type="text" class="sk-input" id="skVersion" maxlength="40" autocomplete="off" placeholder="for example 2026-11-05">' +
          '<div class="sk-msg hidden" id="skZipMsg" role="status"></div>' +
          '<div class="sk-actions"><button type="button" class="btn btn-ghost" id="skDownloadAdmin">' + svg(DOWN_ICON, 14) + ' Download current</button>' +
            '<button type="button" class="btn btn-primary" id="skUpload">Save</button></div>' +
        '</div>' +
      '</div>' +
      '<div class="panel">' +
        '<div class="panel-header"><h3 class="panel-title">Install texts</h3><span class="sk-muted">Shown in the Get Skill dialog</span></div>' +
        '<div class="panel-body sk-form">' +
          '<label class="sk-label" for="skPrompt">Install prompt <span class="sk-muted" id="skPromptState"></span></label>' +
          '<textarea class="sk-text" id="skPrompt" rows="11" maxlength="4000" spellcheck="false"></textarea>' +
          '<label class="sk-label" for="skCommands">After-download commands <span class="sk-muted" id="skCommandsState"></span></label>' +
          '<textarea class="sk-text sk-mono" id="skCommands" rows="5" maxlength="2000" spellcheck="false" placeholder="One command per line"></textarea>' +
          '<div class="sk-msg hidden" id="skTextMsg" role="status"></div>' +
          '<div class="sk-actions"><button type="button" class="btn btn-ghost" id="skReset">Use the default texts</button>' +
            '<button type="button" class="btn btn-primary" id="skSaveText">Save texts</button></div>' +
        '</div>' +
      '</div>' +
    '</div></div>';
  }
  function msg(sel, text, kind) {
    $(sel).toggleClass('hidden', !text).removeClass('is-ok is-bad').addClass(kind === 'bad' ? 'is-bad' : 'is-ok').text(text || '');
  }
  function renderAdmin() {
    var p = pack || {};
    $('#skAdminDetails').html(details(p));
    $('#skDownloadAdmin').prop('disabled', !p.available);
    $('#skVersion').val(p.version || '');
    $('#skPrompt').val(p.prompt || '');
    $('#skCommands').val((p.commands || []).join('\n'));
    $('#skPromptState').text(p.customPrompt ? '(edited)' : '(default)');
    $('#skCommandsState').text(p.customCommands ? '(edited — one per line)' : '(default — one per line)');
  }
  function loadAdmin() {
    $('#skAdminDetails').html('<div class="sk-muted">Loading…</div>');
    api('GET').then(function (r) { pack = r; renderAdmin(); })
      .catch(function (err) { $('#skAdminDetails').html('<div class="sk-msg is-bad">' + esc(err.message) + '</div>'); });
  }
  function pick(file) {
    if (!file) { picked = null; }
    else if (!/\.zip$/i.test(file.name || '')) { msg('#skZipMsg', 'The file must be a .zip file.', 'bad'); return; }
    else if (file.size > MAX_ZIP) { msg('#skZipMsg', 'The zip is larger than 5 MB.', 'bad'); return; }
    else {
      var rd = new FileReader();
      rd.onload = function () { picked = { name: file.name, size: file.size, data: String(rd.result || '') }; msg('#skZipMsg', ''); showPicked(); };
      rd.onerror = function () { msg('#skZipMsg', 'The file could not be read.', 'bad'); };
      rd.readAsDataURL(file);
      return;
    }
    showPicked();
  }
  function showPicked() {
    $('#skFileName').text(picked ? picked.name + ' (' + size(picked.size) + ')' : 'or drop the file here');
    $('#skUnpick').toggleClass('hidden', !picked);
    if (!picked) $('#skFile').val('');
  }
  function saveZip() {
    var version = $('#skVersion').val().trim();
    if (!picked && version === ((pack && pack.version) || '')) { msg('#skZipMsg', 'Choose a zip or change the version label first.', 'bad'); return; }
    var ask = picked && pack && pack.available
      ? SF.confirmDialog({ title: 'Replace the skill zip?', message: 'Users will download "' + picked.name + '" instead of "' + pack.fileName + '" from now on.', yesText: 'Replace', noText: 'Cancel' })
      : Promise.resolve(true);
    ask.then(function (yes) {
      if (!yes) return;
      var $btn = $('#skUpload').prop('disabled', true).text('Saving…');
      msg('#skZipMsg', '');
      var body = { version: version };
      if (picked) body.file = { name: picked.name, data: picked.data };
      api('PUT', body).then(function (r) {
        var done = picked ? 'Uploaded ' + r.fileName + '.' : 'Version label saved.';
        pack = r; picked = null; showPicked(); renderAdmin(); msg('#skZipMsg', done, 'ok');
      }).catch(function (err) { msg('#skZipMsg', err.message, 'bad'); })
        .then(function () { $btn.prop('disabled', false).text('Save'); });
    });
  }
  function saveTexts(reset) {
    var $btn = $(reset ? '#skReset' : '#skSaveText').prop('disabled', true);
    msg('#skTextMsg', '');
    // Text left equal to the built-in default is not stored, so later improvements to the default still reach users.
    var prompt = $('#skPrompt').val().trim(), commands = $('#skCommands').val().trim();
    var body = reset ? { prompt: '', commands: '' } : {
      prompt: pack && !pack.customPrompt && prompt === pack.prompt ? '' : prompt,
      commands: pack && !pack.customCommands && commands === pack.commands.join('\n') ? '' : commands
    };
    api('PUT', body).then(function (r) { pack = r; renderAdmin(); msg('#skTextMsg', reset ? 'The default texts are in use again.' : 'Texts saved.', 'ok'); })
      .catch(function (err) { msg('#skTextMsg', err.message, 'bad'); })
      .then(function () { $btn.prop('disabled', false); });
  }

  // ── page switching (same pattern as admin-activity-log.js) ────────────────
  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    $('#skillAdminPage').addClass('hidden');
    $('#skillAdminBtn').removeClass('active');
    if (page !== PAGE) return origSwitch(page);
    if (SF.wf && SF.wf.role && SF.wf.role !== 'admin') return origSwitch('generator');
    origSwitch('mostused');
    $('#mostUsedPage').addClass('hidden');
    $('#mostUsedBtn').removeClass('active');
    SF.state.page = PAGE;
    try { localStorage.setItem('sf_active_page', PAGE); } catch (e) {}
    $('#skillAdminPage').removeClass('hidden');
    $('#skillAdminBtn').addClass('active');
    $('#pageTitle').text('Skill package');
    $('#pageBreadcrumb').text('Admin');
    msg('#skZipMsg', ''); msg('#skTextMsg', '');
    loadAdmin();
  };

  // Shown to signed-in users only (app.js calls this whenever the sign-in state changes).
  SF.refreshSkillButton = function () { $('#skillGetBtn').toggleClass('hidden', !signedIn()); };

  $(function () {
    Promise.all(window._componentPromises || []).then(function () {
      $('.main').append(pageHtml());
      var btn = '<button class="sidebar-link hidden" data-page="' + PAGE + '" id="skillAdminBtn">' + svg(ZIP_ICON, 18) + '<span>Skill package</span></button>';
      var $after = $('#wfActivityLogBtn').length ? $('#wfActivityLogBtn') : $('#wfMembersBtn').length ? $('#wfMembersBtn') : $('#requestIconNavBtn');
      if ($after.length) $after.after(btn); else $('.sidebar-link').last().after(btn);
      $('#skillAdminBtn').toggleClass('hidden', !isAdmin()).on('click', function () { SF.switchPage(PAGE); });
      SF.refreshSkillButton();

      $(document).on('click', '#skillGetBtn', openModal);
      $(document).on('click', '[data-skill-close]', closeModal);
      $(document).on('click', '#skillDownload', function () { download($(this), $('#skillDlMsg')); });
      $(document).on('click', '#skillCopyPrompt', function () { SF.copyToClipboard((pack && pack.prompt) || '', $(this)); });
      $(document).on('click', '[data-skill-cmd]', function () {
        var c = pack && pack.commands[+$(this).attr('data-skill-cmd')];
        if (c) SF.copyToClipboard(c, $(this));
      });

      $(document).on('click', '#skPick', function () { $('#skFile').trigger('click'); });
      $(document).on('change', '#skFile', function () { if (this.files && this.files[0]) pick(this.files[0]); });
      $(document).on('click', '#skUnpick', function () { pick(null); });
      $(document).on('dragover', '#skDrop', function (e) { e.preventDefault(); $(this).addClass('is-over'); });
      $(document).on('dragleave drop', '#skDrop', function () { $(this).removeClass('is-over'); });
      $(document).on('drop', '#skDrop', function (e) {
        e.preventDefault();
        var f = e.originalEvent.dataTransfer && e.originalEvent.dataTransfer.files[0];
        if (f) pick(f);
      });
      $(document).on('click', '#skUpload', saveZip);
      $(document).on('click', '#skDownloadAdmin', function () { download($(this), $('#skZipMsg').removeClass('is-ok').addClass('is-bad')); });
      $(document).on('click', '#skSaveText', function () { saveTexts(false); });
      $(document).on('click', '#skReset', function () { saveTexts(true); });

      var last = null;
      try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
      if (last === PAGE) setTimeout(function () { SF.switchPage(PAGE); }, 0);
    });
  });
})(window.SpriteForge, jQuery);
