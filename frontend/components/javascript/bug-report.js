/**
 * SpriteForge - Report a bug
 * Every signed-in user can send an issue (text + an optional screenshot). The Cliq bot forwards it to the people
 * an admin chose in "Who gets bug reports". That box and the list of reports are shown to admins only; everyone
 * else sees "Contact on Cliq" (links that open a Cliq chat with the people of /api/bugs/contacts).
 * API: /api/bugs, /api/bugs/recipients (functions/spriteForgeJoin/routes/bug-report.js).
 */
(function (SF, $) {
  'use strict';

  var PAGE = 'bugreport';
  var MAX_IMAGE = 3 * 1024 * 1024;
  var TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  var image = null;        // { name, type, data (data URL) }
  var recipients = [];     // admin: [{ email, name }]
  var searchTimer = null;

  function base() { return String(window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/').replace(/\/+$/, '') + '/api/'; }
  function headers() { return typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {}; }
  function isAdmin() { return !!(SF.wf && SF.wf.role === 'admin'); }
  function toast(m) { if (SF.showToast) SF.showToast(m); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, path, body) {
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: base() + path, type: method, dataType: 'json', headers: headers(), timeout: 90000,
        contentType: 'application/json', data: body ? JSON.stringify(body) : undefined,
        success: resolve,
        error: function (xhr) {
          reject(new Error((xhr.responseJSON && xhr.responseJSON.message) || (xhr.status === 401 ? 'Sign in first' : xhr.status === 404 ? 'The server does not have this feature yet — redeploy the backend' : 'Request failed')));
        }
      });
    });
  }
  function when(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  }

  var BUG_ICON = '<path d="M8 2l1.9 1.9M14.1 3.9L16 2M9 7.1v-1a3 3 0 0 1 6 0v1"/><path d="M12 20a6 6 0 0 1-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3a6 6 0 0 1-6 6zM12 20v-9M6.5 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M21 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/>';

  function pageHtml() {
    return '<div class="content hidden" id="bugPage"><div class="bug-cols">' +
      '<div class="panel bug-form-panel">' +
        '<div class="panel-header"><h3 class="panel-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + BUG_ICON + '</svg>Report a bug</h3></div>' +
        '<form class="panel-body bug-form" id="bugForm">' +
          '<label class="bug-label" for="bugText">What went wrong?</label>' +
          '<textarea id="bugText" class="bug-text" maxlength="3000" rows="7" placeholder="What did you do, what did you expect, and what happened instead?"></textarea>' +
          '<div class="bug-count" id="bugCount">0 / 3000</div>' +
          '<label class="bug-label">Screenshot <span class="bug-muted">(optional — PNG, JPG, GIF or WebP, up to 3 MB; you can also paste an image)</span></label>' +
          '<div class="bug-drop" id="bugDrop">' +
            '<input type="file" id="bugFile" accept="image/png,image/jpeg,image/gif,image/webp" hidden>' +
            '<button type="button" class="btn btn-ghost btn-sm" id="bugPick">Choose image</button>' +
            '<span class="bug-muted" id="bugFileName">No image attached</span>' +
            '<button type="button" class="btn btn-ghost btn-sm hidden" id="bugRemove">Remove</button>' +
          '</div>' +
          '<img class="bug-preview hidden" id="bugPreview" alt="Attached screenshot">' +
          '<div class="bug-msg hidden" id="bugMsg" role="status"></div>' +
          '<div class="bug-actions"><button type="submit" class="btn btn-primary" id="bugSubmit">Submit issue</button></div>' +
        '</form>' +
      '</div>' +
      '<div class="bug-side">' +
        '<div class="panel hidden" id="bugContactPanel">' +
          '<div class="panel-header"><h3 class="panel-title">Contact on Cliq</h3></div>' +
          '<div class="panel-body">' +
            '<div class="bug-muted bug-gap">Need a quick answer? Open a Cliq chat with one of these people.</div>' +
            '<div class="bug-people" id="bugContacts"></div>' +
          '</div>' +
        '</div>' +
        '<div class="panel hidden" id="bugAdminPanel">' +
          '<div class="panel-header"><h3 class="panel-title">Who gets bug reports</h3><span class="bug-muted">Admins only</span></div>' +
          '<div class="panel-body">' +
            '<div class="bug-muted bug-gap">Each submitted issue is sent to these people by the Cliq bot. They must have subscribed to the bot once.</div>' +
            '<div class="bug-search"><input type="search" class="bug-input" id="bugUserSearch" autocomplete="off" placeholder="Name or email address" aria-label="Find a person to add">' +
              '<div class="bug-results hidden" id="bugUserResults"></div></div>' +
            '<div class="bug-people" id="bugPeople"></div>' +
          '</div>' +
        '</div>' +
        '<div class="panel hidden" id="bugListPanel">' +
          '<div class="panel-header"><h3 class="panel-title">All reports</h3>' +
            '<div class="panel-actions"><button class="btn btn-ghost btn-sm" id="bugRefresh" type="button">Refresh</button></div></div>' +
          '<div class="panel-body bug-list" id="bugList"></div>' +
        '</div>' +
      '</div>' +
    '</div></div>';
  }

  // ── the form ──────────────────────────────────────────────────────────────
  function message(text, kind) {
    $('#bugMsg').toggleClass('hidden', !text).removeClass('is-ok is-bad').addClass(kind === 'bad' ? 'is-bad' : 'is-ok').text(text || '');
  }
  function setImage(file) {
    if (!file) { image = null; }
    else {
      if (TYPES.indexOf(file.type) === -1) { message('The image must be a PNG, JPG, GIF or WebP file.', 'bad'); return; }
      if (file.size > MAX_IMAGE) { message('The image is larger than 3 MB.', 'bad'); return; }
      var rd = new FileReader();
      rd.onload = function () {
        image = { name: file.name || 'screenshot.png', type: file.type, data: String(rd.result || '') };
        message('');
        showImage();
      };
      rd.onerror = function () { message('The image could not be read.', 'bad'); };
      rd.readAsDataURL(file);
      return;
    }
    showImage();
  }
  function showImage() {
    $('#bugFileName').text(image ? image.name : 'No image attached');
    $('#bugRemove').toggleClass('hidden', !image);
    $('#bugPreview').toggleClass('hidden', !image).attr('src', image ? image.data : '');
    if (!image) $('#bugFile').val('');
  }
  function submit(e) {
    e.preventDefault();
    var text = $('#bugText').val().trim();
    if (!text) { message('Describe the issue first.', 'bad'); $('#bugText').trigger('focus'); return; }
    var $btn = $('#bugSubmit').prop('disabled', true).text('Sending…');
    message('');
    api('POST', 'bugs', { text: text, page: document.title || '', image: image ? { name: image.name, type: image.type, data: image.data } : undefined })
      .then(function (r) {
        var note = 'Thank you — the issue is recorded.';
        if (r.imageLost) note += ' The screenshot could not be stored, so only the text was saved.';
        if (isAdmin()) {
          note += !r.recipients ? ' Nobody is on the "Who gets bug reports" list yet, so no Cliq message was sent.'
            : r.logged ? ' The Cliq bot is not configured on this server, so the message was only logged.'
            : ' Cliq message sent to ' + r.sent + ' of ' + r.recipients + (r.failed ? ' (' + r.failed + ' failed — see the report below).' : '.');
        }
        message(note, 'ok');
        $('#bugText').val(''); $('#bugCount').text('0 / 3000');
        setImage(null);
        loadList();
      })
      .catch(function (err) { message(err.message, 'bad'); })
      .then(function () { $btn.prop('disabled', false).text('Submit issue'); });
  }

  // ── reports ───────────────────────────────────────────────────────────────
  function loadList() {
    if (!isAdmin()) return;
    $('#bugList').html('<div class="bug-muted">Loading…</div>');
    api('GET', 'bugs').then(function (r) {
      if (!r.reports.length) { $('#bugList').html('<div class="bug-empty">' + (r.admin ? 'No bug reports yet.' : 'You have not reported anything yet.') + '</div>'); return; }
      $('#bugList').html(r.reports.map(function (b) {
        return '<article class="bug-item">' +
          '<header><b>' + esc(b.reportedByName || b.reportedBy) + '</b><span class="bug-muted">' + esc(when(b.at)) + '</span></header>' +
          '<p>' + esc(b.text) + '</p>' +
          (b.image ? '<a href="' + esc(base() + b.image) + '" target="_blank" rel="noopener"><img class="bug-thumb" loading="lazy" alt="Screenshot of the issue" src="' + esc(base() + b.image) + '"></a>' : '') +
          (r.admin && (b.cliqSent || b.cliqFailed) ? '<footer class="bug-muted">' +
            (b.cliqSent ? 'Cliq sent to: ' + esc(b.cliqSent.split(',').join(', ')) : '') +
            (b.cliqFailed ? (b.cliqSent ? ' · ' : '') + '<span class="bug-bad">Not delivered: ' + esc(b.cliqFailed) + '</span>' : '') + '</footer>' : '') +
          '</article>';
      }).join(''));
    }).catch(function (err) { $('#bugList').html('<div class="bug-msg is-bad">' + esc(err.message) + '</div>'); });
  }

  // ── everyone: people to reach on Cliq ────────────────────────────────
  function loadContacts() {
    api('GET', 'bugs/contacts').then(function (r) {
      $('#bugContacts').html((r.contacts || []).map(function (c) {
        return '<div class="bug-person"><div><b>' + esc(c.name || c.email) + '</b><span class="bug-muted">' + esc(c.email) + '</span></div>' +
          '<a class="btn btn-ghost btn-sm" href="' + esc(c.cliq) + '" target="_blank" rel="noopener" aria-label="Open a Cliq chat with ' + esc(c.email) + '">Open in Cliq</a></div>';
      }).join('') || '<div class="bug-empty">No contacts are set up.</div>');
    }).catch(function (err) { $('#bugContacts').html('<div class="bug-msg is-bad">' + esc(err.message) + '</div>'); });
  }

  // ── admin: who gets the Cliq message ──────────────────────────────────────
  function renderPeople() {
    $('#bugPeople').html(recipients.length ? recipients.map(function (p, i) {
      return '<div class="bug-person"><div><b>' + esc(p.name || p.email) + '</b>' + (p.name ? '<span class="bug-muted">' + esc(p.email) + '</span>' : '') + '</div>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-bug-remove="' + i + '" aria-label="Remove ' + esc(p.email) + '">Remove</button></div>';
    }).join('') : '<div class="bug-empty">Nobody yet. Search for a person above to add them.</div>');
  }
  function loadPeople() {
    if (!isAdmin()) return;
    api('GET', 'bugs/recipients').then(function (r) { recipients = r.recipients || []; renderPeople(); })
      .catch(function (err) { $('#bugPeople').html('<div class="bug-msg is-bad">' + esc(err.message) + '</div>'); });
  }
  function savePeople(next, done) {
    api('PUT', 'bugs/recipients', { recipients: next }).then(function (r) { recipients = r.recipients || []; renderPeople(); toast(done); })
      .catch(function (err) { toast(err.message); renderPeople(); });
  }
  function searchPeople() {
    var q = $('#bugUserSearch').val().trim(), $box = $('#bugUserResults');
    if (q.length < 2) { $box.addClass('hidden').empty(); return; }
    $box.removeClass('hidden').html('<div class="bug-result-note">Searching…</div>');
    api('GET', 'org-users?q=' + encodeURIComponent(q)).then(function (r) {
      var users = r.users || [];
      var typed = /^\S+@\S+\.\S+$/.test(q) && !users.some(function (u) { return String(u.email).toLowerCase() === q.toLowerCase(); });
      $box.html(users.map(function (u) {
        return '<button type="button" class="bug-result" data-email="' + esc(u.email) + '" data-name="' + esc(u.name) + '"><b>' + esc(u.name) + '</b><span class="bug-muted">' + esc(u.email) + '</span></button>';
      }).join('') + (typed ? '<button type="button" class="bug-result" data-email="' + esc(q) + '" data-name=""><b>Add "' + esc(q) + '"</b><span class="bug-muted">Use this email address</span></button>' : '') +
        (!users.length && !typed ? '<div class="bug-result-note">Nobody found for "' + esc(q) + '"</div>' : ''));
    }).catch(function (err) { $box.html('<div class="bug-result-note">' + esc(err.message) + '</div>'); });
  }

  // ── page switching (same pattern as admin-activity-log.js) ────────────────
  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    $('#bugPage').addClass('hidden');
    $('#bugReportBtn').removeClass('active');
    if (page !== PAGE) return origSwitch(page);
    origSwitch('mostused');
    $('#mostUsedPage').addClass('hidden');
    $('#mostUsedBtn').removeClass('active');
    SF.state.page = PAGE;
    try { localStorage.setItem('sf_active_page', PAGE); } catch (e) {}
    $('#bugPage').removeClass('hidden');
    $('#bugReportBtn').addClass('active');
    $('#pageTitle').text('Report a bug');
    $('#pageBreadcrumb').text('Help');
    showForRole();
    // The role may still be loading when the page opens (workflow.js reads it from the server): look again shortly.
    if (!(SF.wf && SF.wf.role)) {
      var tries = 0, t = setInterval(function () {
        if ((SF.wf && SF.wf.role) || ++tries > 20) { clearInterval(t); if (SF.state.page === PAGE) showForRole(true); }
      }, 300);
    }
  };
  function showForRole(settled) {
    // Everyone: the people to reach on Cliq. Admins also get the recipient list and every report.
    var known = settled || !!(SF.wf && SF.wf.role); // a role that never arrives is treated as a common user
    $('#bugAdminPanel, #bugListPanel').toggleClass('hidden', !isAdmin());
    $('#bugContactPanel').removeClass('hidden');
    loadContacts();
    if (!known) return;
    loadList();
    loadPeople();
  }

  $(function () {
    Promise.all(window._componentPromises || []).then(function () {
      $('.main').append(pageHtml());
      var btn = '<button class="sidebar-link" data-page="' + PAGE + '" id="bugReportBtn">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + BUG_ICON + '</svg><span>Report a bug</span></button>';
      var $after = $('#wfActivityLogBtn').length ? $('#wfActivityLogBtn') : $('#wfMembersBtn').length ? $('#wfMembersBtn') : $('#wfRequestsBtn').length ? $('#wfRequestsBtn') : $('#requestIconNavBtn');
      if ($after.length) $after.after(btn); else $('.sidebar-link').last().after(btn);
      $('#bugReportBtn').on('click', function () { SF.switchPage(PAGE); });

      $(document).on('submit', '#bugForm', submit);
      $(document).on('input', '#bugText', function () { $('#bugCount').text(this.value.length + ' / 3000'); });
      $(document).on('click', '#bugPick', function () { $('#bugFile').trigger('click'); });
      $(document).on('change', '#bugFile', function () { if (this.files && this.files[0]) setImage(this.files[0]); });
      $(document).on('click', '#bugRemove', function () { setImage(null); });
      $(document).on('paste', '#bugPage', function (e) {
        var items = (e.originalEvent.clipboardData || {}).items || [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === 'file' && TYPES.indexOf(items[i].type) !== -1) { e.preventDefault(); setImage(items[i].getAsFile()); return; }
        }
      });
      $(document).on('dragover', '#bugDrop', function (e) { e.preventDefault(); });
      $(document).on('drop', '#bugDrop', function (e) {
        e.preventDefault();
        var f = e.originalEvent.dataTransfer && e.originalEvent.dataTransfer.files[0];
        if (f) setImage(f);
      });
      $(document).on('click', '#bugRefresh', loadList);

      $(document).on('input focus', '#bugUserSearch', function () { clearTimeout(searchTimer); searchTimer = setTimeout(searchPeople, 400); });
      $(document).on('click', '#bugUserResults .bug-result', function () {
        var email = String($(this).data('email')).toLowerCase(), name = String($(this).data('name') || '');
        $('#bugUserSearch').val(''); $('#bugUserResults').addClass('hidden').empty();
        if (recipients.some(function (p) { return p.email === email; })) { toast(email + ' is already on the list'); return; }
        savePeople(recipients.concat([{ email: email, name: name }]), 'Added ' + (name || email));
      });
      $(document).on('click', '[data-bug-remove]', function () {
        var i = +$(this).attr('data-bug-remove'), p = recipients[i];
        if (p) savePeople(recipients.filter(function (_, k) { return k !== i; }), 'Removed ' + (p.name || p.email));
      });
      $(document).on('click', function (e) { if (!$(e.target).closest('.bug-search').length) $('#bugUserResults').addClass('hidden'); });

      var last = null;
      try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
      if (last === PAGE) setTimeout(function () { SF.switchPage(PAGE); }, 0);
    });
  });
})(window.SpriteForge, jQuery);
