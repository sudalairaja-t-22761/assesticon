/**
 * SpriteForge - Icon verification workflow
 *
 * - Verification badges on Library icons (unverified / requested / mock verified / master verified)
 * - Request Icon form (target sprite: utilicon = crmutil_icons, cssicon = svg_cssicons)
 * - Requests page: step progress, admin can assign Visual audit + UI audit approvers, reviewers approve/reject,
 *   admin pushes the approved icon into the chosen sprite of the main library
 * - Members page (admin only): add members with a role and an approver type (None / Visual audit / UI audit)
 */
(function (SF, $) {
  'use strict';

  var TARGETS = { crmutil_icons: 'utilicon (crmutil_icons.svg)', svg_cssicons: 'cssicon (svg_cssicons.svg)' };
  var STATUS_LABEL = {
    unverified: 'Unverified', requested: 'Verification requested',
    mock_verified: 'Mock verified', master_verified: 'Master verified'
  };
  var ROLE_INFO = {
    designer: 'Designer — decides the menus this member can open (preset for design work). Approving requests is set separately under Approver.',
    ui: 'UI — decides the menus this member can open (preset for UI work). Approving requests is set separately under Approver.',
    admin: 'Admin — manages members and roles, assigns approvers, and pushes approved icons to the main library.'
  };
  var APPROVER_INFO = {
    none: 'Not an approver: will not be offered when requests are assigned.',
    designer: 'Visual audit — checks the visual quality of requested icons (shape, grid, style). Gets a mail when a request is waiting for their visual audit.',
    ui: 'UI audit — checks how the icon fits the product UI (size, usage, naming). Gets a mail after the visual audit is approved.'
  };
  // Stage labels shown to people (the stored keys stay designer | ui).
  var AUDIT = { designer: 'Visual audit', ui: 'UI audit' };
  var STAGE = { designer: 'Visual', ui: 'UI' };
  // "Visual approved" / "UI rejected" ...
  function decisionPill(decision, slot) {
    return '<span class="vf-pill vf-pill-' + decision + '">' + STAGE[slot] + ' ' + decision + '</span>';
  }
  // Timeline action labels for stored actions like designer_approved.
  function actionLabel(action) {
    var m = /^(designer|ui)_(approved|rejected)$/.exec(action);
    return m ? STAGE[m[1]] + ' ' + m[2] : action.replace(/_/g, ' ');
  }
  // Approver type of a member: designer | ui | '' (none). Older rows without the field used their Designer/UI role.
  function approverOf(m) {
    var a = String(m.approverType || '');
    if (a === 'designer' || a === 'ui') return a;
    if (a === 'none') return '';
    return m.memberType === 'designer' || m.memberType === 'ui' ? m.memberType : '';
  }
  function isExpiredMember(m) { return !!m.expiresAt && new Date(m.expiresAt).getTime() <= Date.now(); }
  var TICK = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';

  // Mail link: /?request=<id>. Remember it across the sign-in redirect, then open that request.
  (function captureDeepLink() {
    try {
      var m = location.search.match(/[?&]request=([^&#]+)/);
      if (!m) return;
      sessionStorage.setItem('sf_deeplink_request', decodeURIComponent(m[1]));
      var rest = location.search.replace(/([?&])request=[^&#]*&?/, '$1').replace(/[?&]$/, '');
      history.replaceState(null, '', location.pathname + rest + location.hash);
    } catch (e) {}
  })();

  var wf = SF.wf = { role: null, email: null, statuses: {}, requests: [], openId: null, masterIds: null, members: [], roles: [], menuCatalog: [], menus: null };

  // sidebar menu key → button selector, and which menu(s) open each page
  var MENU_SELECTORS = {
    create_sprite: '.sidebar-link[data-mode="new"]', update_sprite: '.sidebar-link[data-mode="existing"]', create_svg: '#createSvgBtn',
    customise: '#helpDocBtn', library: '#iconLibraryBtn', asset_store: '#assetStoreBtn', figma: '#figmaBtn', webfont: '#webfontBtn', settings: '#settingsBtn',
    saved_sprites: '#savedSpritesBtn', saved_webfonts: '#savedWebfontsBtn', saved_assets: '#savedAssetsBtn', most_used: '#mostUsedBtn',
    request_icon: '#requestIconNavBtn', requests: '#wfRequestsBtn', members: '#wfMembersBtn'
  };
  var PAGE_MENU = {
    generator: ['create_sprite', 'update_sprite'], createsvg: ['create_svg'], helpdoc: ['customise'], iconlibrary: ['library'], assetstore: ['asset_store'],
    webfont: ['webfont'], savedsprites: ['saved_sprites'], savedwebfonts: ['saved_webfonts'], savedassets: ['saved_assets'], mostused: ['most_used'],
    requesticon: ['request_icon'], wfrequests: ['requests'], wfmembers: ['members']
  };

  function menuAllowed(key) { return !wf.menus || wf.menus.indexOf(key) !== -1; }
  function pageAllowed(page) {
    var keys = PAGE_MENU[page];
    return !keys || keys.some(menuAllowed);
  }
  function firstAllowedPage() {
    var order = ['generator', 'iconlibrary', 'requesticon', 'wfrequests', 'mostused', 'savedsprites', 'savedwebfonts', 'savedassets', 'assetstore', 'webfont', 'createsvg', 'helpdoc', 'wfmembers'];
    return order.filter(pageAllowed)[0] || null;
  }

  // Hide the sidebar items the signed-in role may not open (and section labels left with nothing under them).
  function applyMenus() {
    Object.keys(MENU_SELECTORS).forEach(function (key) {
      if (key === 'members') return; // handled by role === admin
      $(MENU_SELECTORS[key]).toggleClass('hidden', !menuAllowed(key));
    });
    $('.sidebar-label').each(function () {
      var any = false;
      $(this).nextUntil('.sidebar-label', '.sidebar-link').each(function () { if (!$(this).hasClass('hidden')) any = true; });
      $(this).toggleClass('hidden', !any);
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(method, path, body) {
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: SF.masterLibraryUrl('api/' + path),
        type: method,
        dataType: 'json',
        headers: SF.masterLibraryAuthHeaders(),
        contentType: 'application/json',
        data: body ? JSON.stringify(body) : undefined,
        success: resolve,
        error: function (xhr) {
          var m = (xhr.responseJSON && xhr.responseJSON.message) || xhr.statusText || 'Request failed';
          if (xhr.status === 404 && !xhr.responseJSON) m = 'API not found on the server — restart or redeploy the backend (it is running old code)';
          var e = new Error(m); e.status = xhr.status; reject(e);
        }
      });
    });
  }

  function fail(e) { SF.showToast(e && e.message ? e.message : 'Something went wrong'); }

  // ── identity / status ────────────────────────────────────────────────────
  function loadMe() {
    return api('GET', 'me').then(function (r) {
      wf.role = r.role; wf.email = r.email; wf.menus = r.menus || null;
      $('#wfMembersBtn').toggleClass('hidden', r.role !== 'admin');
      applyMenus();
    }).catch(function () { wf.role = null; wf.menus = null; $('#wfMembersBtn').addClass('hidden'); });
  }

  function loadStatuses() {
    var mine = api('GET', 'icon-status').then(function (r) {
      wf.statuses = {};
      (r.statuses || []).forEach(function (s) { wf.statuses[s.sprite + ':' + s.symbolId] = s.status; });
    }).catch(function () { /* signed out / table missing: icons just show as unverified */ });
    return Promise.all([mine, loadMasterIds()]).then(function () {
      renderStatusFilter();
      if (typeof SF.renderLibraryGrid === 'function' && $('#libGrid').length) SF.renderLibraryGrid();
    });
  }

  // Compare the two repos: an icon of the icon store whose symbol already exists in a main-library
  // sprite (CRM_UI_LIBRARY) is master verified, whatever the request records say.
  function normId(id) { return String(id || '').toLowerCase().replace(/__s$/, ''); }

  function loadMasterIds() {
    if (wf.masterIds || typeof SF.fetchMasterLibraryFile !== 'function') return Promise.resolve();
    var files = ['crmutil_icons.svg', 'svg_cssicons.svg'];
    return Promise.all(files.map(function (f) { return SF.fetchMasterLibraryFile(f).catch(function () { return null; }); })).then(function (texts) {
      if (texts.every(function (t) { return t === null; })) return; // not signed in / repo unreachable: retry next time
      var ids = {};
      texts.forEach(function (t) {
        var re = /<symbol\b[^>]*\bid\s*=\s*["']([^"']+)["']/g, m;
        while (t && (m = re.exec(t)) !== null) ids[normId(m[1])] = true;
      });
      wf.masterIds = ids;
    });
  }

  SF.wfStatusOf = function (icon) {
    if (wf.masterIds && wf.masterIds[normId(icon.symbolId)]) return 'master_verified';
    var st = wf.statuses[icon.sprite + ':' + icon.symbolId] || 'unverified';
    return st === 'master_verified' ? 'mock_verified' : st; // pushed but not (yet) in the repo sprite
  };

  SF.wfBadgeHtml = function (icon) {
    var st = SF.wfStatusOf(icon);
    var tip = st === 'unverified' ? 'Not verified yet — click to request verification' : STATUS_LABEL[st];
    return '<span class="vf-badge vf-badge-' + st + '" data-vf-symbol="' + esc(icon.symbolId) + '" data-vf-sprite="' + esc(icon.sprite) +
      '" title="' + esc(tip) + '">' + (st === 'unverified' ? 'Unverified' : TICK + ' ' + STATUS_LABEL[st].replace('Verification ', '')) + '</span>';
  };

  function renderStatusFilter() {
    var $bar = $('#libStatusFilter');
    if (!$bar.length) {
      $bar = $('<div class="vf-status-filter" id="libStatusFilter"></div>').insertAfter('#libSourceFilter');
    }
    var cur = SF.libState.statusFilter || 'all';
    var counts = { all: 0 };
    (SF.libState.icons || []).forEach(function (ic) {
      if (ic.source !== 'repo') return;
      counts.all++; var s = SF.wfStatusOf(ic); counts[s] = (counts[s] || 0) + 1;
    });
    var chips = [['all', 'All status']].concat(Object.keys(STATUS_LABEL).map(function (k) { return [k, STATUS_LABEL[k]]; }));
    $bar.html(chips.map(function (c) {
      return '<button type="button" class="lib-source-chip' + (c[0] === cur ? ' active' : '') + '" data-vf-filter="' + c[0] + '">' +
        esc(c[1]) + ' <span class="lib-source-count">' + (counts[c[0]] || 0) + '</span></button>';
    }).join(''));
  }

  $(document).on('click', '[data-vf-filter]', function () {
    SF.libState.statusFilter = $(this).data('vf-filter');
    renderStatusFilter();
    SF.renderLibraryGrid();
  });

  // Clicking an "Unverified" badge starts a request for that icon.
  $(document).on('click', '.vf-badge-unverified', function (e) {
    e.stopPropagation();
    wf.prefill = { symbolId: $(this).data('vf-symbol'), sprite: $(this).data('vf-sprite') };
    SF.switchPage('requesticon');
  });

  // ── Request Icon page ────────────────────────────────────────────────────
  function repoIcons() { return (SF.repoLib && SF.repoLib.icons) || []; }

  function renderRequestForm() {
    var $body = $('#requestIconPage .panel-body');
    if (!$body.length) return;
    var icons = repoIcons();
    var pre = wf.prefill || {};
    wf.prefill = null;
    var opts = icons.map(function (ic) {
      var sel = ic.symbolId === pre.symbolId && ic.sprite === pre.sprite ? ' selected' : '';
      return '<option value="' + esc(ic.id) + '"' + sel + '>' + esc(ic.name) + ' — ' + esc(ic.sprite) + '</option>';
    }).join('');
    $body.html(
      '<div class="vf-form">' +
        '<label>Icon (from the icon store)<select id="wfReqIcon">' + (opts || '<option value="">Loading icons…</option>') + '</select></label>' +
        '<img class="vf-form-preview hidden" id="wfReqPreview" alt="">' +
        '<label>Move to main library sprite<select id="wfReqTarget">' +
          Object.keys(TARGETS).map(function (k) { return '<option value="' + k + '">' + esc(TARGETS[k]) + '</option>'; }).join('') +
        '</select></label>' +
        '<label>Note<textarea id="wfReqNote" rows="3" maxlength="1000" placeholder="Where will it be used?"></textarea></label>' +
        '<div><button class="btn btn-primary btn-sm" id="wfReqSubmit" type="button">Request verification</button></div>' +
        '<div class="vf-msg">Visual audit and UI audit both have to approve. Once both approve, an admin pushes it to the main library.</div>' +
      '</div>');
    updateRequestPreview();
    if (!icons.length && typeof SF.loadRepoLibraryIcons === 'function') {
      Promise.resolve(SF.loadRepoLibraryIcons(false)).then(function () { if (repoIcons().length) renderRequestForm(); });
    }
  }

  function selectedRepoIcon() {
    var id = $('#wfReqIcon').val();
    return repoIcons().filter(function (ic) { return ic.id === id; })[0] || null;
  }

  function updateRequestPreview() {
    var ic = selectedRepoIcon();
    var $p = $('#wfReqPreview');
    if (ic && ic.svgContent) {
      $p.attr('src', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(ic.svgContent)).removeClass('hidden');
    } else { $p.addClass('hidden'); }
  }

  $(document).on('change', '#wfReqIcon', updateRequestPreview);

  $(document).on('click', '#wfReqSubmit', function () {
    var ic = selectedRepoIcon();
    if (!ic) { SF.showToast('Pick an icon first'); return; }
    var $btn = $(this).prop('disabled', true);
    api('POST', 'requests', {
      symbolId: ic.symbolId, sprite: ic.sprite, iconName: ic.name, svg: ic.svgContent,
      targetSprite: $('#wfReqTarget').val(), note: $('#wfReqNote').val()
    }).then(function (res) {
      var n = res.notified || {};
      SF.showToast(n.designer
        ? 'Request submitted — mailed ' + n.designer + ' Visual audit approver' + (n.designer === 1 ? '' : 's') + '. UI audit approvers are mailed after the visual audit is approved.' + (n.local ? ' (NOT delivered — no Catalyst credentials; see the server log)' : '') + (n.failed ? ' · ' + n.failed + ' mail(s) failed' + (n.error ? ': ' + n.error : '') : '')
        : n.selfOnly ? 'Request submitted — nobody was mailed: you are the only Visual audit approver and cannot approve your own request. Add another Visual audit approver (or an admin can enable ALLOW_SELF_APPROVAL).'
        : n.failed ? 'Request submitted — mail failed: ' + (n.error || 'see the request timeline')
        : 'Request submitted — no Visual audit approvers yet, ask an admin to add them');
      return loadStatuses();
    }).then(function () { SF.switchPage('wfrequests'); })
      .catch(fail).then(function () { $btn.prop('disabled', false); });
  });

  // ── Requests page ────────────────────────────────────────────────────────
  function requestsPageHtml() {
    return '<div class="content hidden" id="wfRequestsPage">' +
      '<div class="panel vf-waiting-panel hidden" id="wfWaitingPanel"><div class="panel-header"><h3 class="panel-title" id="wfWaitingTitle">Waiting for approval</h3></div>' +
        '<div class="panel-body-flush"><div id="wfWaiting"></div></div></div>' +
      '<div class="panel">' +
      '<div class="panel-header"><h3 class="panel-title">Icon Requests</h3>' +
        '<div class="panel-actions"><button class="btn btn-ghost btn-sm vf-pill hidden" id="wfMailTest" type="button" title="Send one test mail to yourself to check that approval mails can be delivered">Send test mail to me</button></div></div>' +
      '<div class="vf-mailtest hidden" id="wfMailTestResult"></div>' +
      '<div class="panel-body-flush"><div id="wfRequestsList"></div><div id="wfRequestDetail"></div></div>' +
      '</div></div>';
  }

  function pill(status) { return '<span class="vf-pill vf-pill-' + status + '">' + esc(status) + '</span>'; }
  function dataUri(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg || ''); }

  function loadRequests() {
    $('#wfRequestsList').html('<div class="vf-empty">Loading…</div>');
    return api('GET', 'requests').then(function (r) {
      wf.requests = r.requests || [];
      if (r.role) wf.role = r.role;
      $('#wfMailTest').toggleClass('hidden', wf.role !== 'admin');
      renderRequestsList();
      if (wf.openId) openRequest(wf.openId);
      if (wf.role === 'admin') {
        return api('GET', 'members').then(function (m) { wf.members = m.members || []; }).catch(function () {}).then(renderWaiting);
      }
      renderWaiting();
    }).catch(function (e) {
      $('#wfRequestsList').html('<div class="vf-empty">' + esc(e.message) + '</div>');
    });
  }

  // One review slot (Designer or UI): who may act, and the state. Every approver of the type was mailed on submit,
  // unless an admin assigned the slot to one person.
  function reviewerCell(assigned, decision, by, notifiedCsv, status, slot, notYet) {
    var label = AUDIT[slot];
    if (notYet && !decision && status === 'pending') return '<span class="vf-msg">starts after the Visual audit is approved</span>';
    var pool = String(notifiedCsv || '').split(',').filter(Boolean);
    var who = assigned ? esc(assigned)
      : pool.length ? '<span title="' + esc(pool.join(', ')) + '">' + pool.length + ' ' + label + ' approver' + (pool.length === 1 ? '' : 's') + '</span>'
      : '<span class="vf-msg">no ' + label + ' approvers</span>';
    var state = decision ? decisionPill(decision, slot) + (by ? ' <span class="vf-msg">by ' + esc(by) + '</span>' : '')
      : (status === 'pending' && (assigned || pool.length) ? '<span class="vf-pill vf-pill-pending">waiting for approval</span>' : '');
    return who + '<div>' + state + '</div>';
  }

  var MAIL_TAG = {
    failed: ['mail not delivered', 'The approval mail could not be sent — see the request timeline, fix it, then use "Resend mail".'],
    partial: ['some mails failed', 'Some approvers could not be mailed — see the request timeline, then use "Resend mail".'],
    logged: ['mail not sent (local run)', 'No Catalyst credentials on this server, so the mail was only logged.']
  };
  function mailTag(r) {
    var t = MAIL_TAG[r.mailStatus];
    return t ? '<div><span class="vf-pill vf-pill-rejected" title="' + esc(t[1]) + '">' + t[0] + '</span></div>' : '';
  }
  function canDelete(r) {
    return wf.role === 'admin' || (String(r.requestedBy).toLowerCase() === String(wf.email || '').toLowerCase() && (r.status === 'pending' || r.status === 'rejected'));
  }

  // Who still has to approve: each open Designer/UI slot -> its assigned person, else everyone who was mailed.
  function waitingByApprover() {
    var map = {};
    (wf.requests || []).filter(function (r) { return r.status === 'pending'; }).forEach(function (r) {
      [['designer', r.assignedDesigner, r.designerDecision, r.notifiedDesigners], ['ui', r.assignedUI, r.uiDecision, r.notifiedUI]].forEach(function (slot) {
        if (slot[2]) return; // this slot is already decided
        if (slot[0] === 'ui' && r.designerDecision !== 'approved') return; // the UI review starts after the Designer approved
        var emails = slot[1] ? [slot[1]] : String(slot[3] || '').split(',').filter(Boolean);
        emails.forEach(function (e) {
          var k = e.toLowerCase();
          (map[k] = map[k] || { email: e, types: {}, requests: [] });
          map[k].types[slot[0]] = true;
          map[k].requests.push({ id: r.ROWID, name: r.iconName, slot: slot[0] });
        });
      });
    });
    return map;
  }

  function renderWaiting() {
    var map = waitingByApprover(), me = String(wf.email || '').toLowerCase(), admin = wf.role === 'admin';
    var rows = Object.keys(map).map(function (k) { return map[k]; }).filter(function (a) { return admin || a.email.toLowerCase() === me; });
    $('#wfWaitingTitle').text(admin ? 'Waiting for approval — approver list' : 'Waiting for your approval');
    $('#wfWaitingPanel').toggleClass('hidden', !rows.length);
    if (!rows.length) return;
    rows.sort(function (a, b) { return b.requests.length - a.requests.length; });
    $('#wfWaiting').html('<table class="vf-table"><thead><tr><th>Approver</th><th>Type</th><th>Waiting</th><th>Requests</th></tr></thead><tbody>' + rows.map(function (a) {
      var m = (wf.members || []).filter(function (x) { return String(x.userEmail).toLowerCase() === a.email.toLowerCase(); })[0];
      var name = m ? (m.userName || m.userEmail) : a.email;
      return '<tr><td><div class="vf-person">' + avatarHtml(m && m.userAvatar, name) + '<div><b>' + esc(name) + '</b>' +
        (a.email.toLowerCase() === me ? ' <span class="vf-you">You</span>' : '') + '<div class="vf-msg">' + esc(a.email) + '</div></div></div></td>' +
        '<td>' + Object.keys(a.types).map(function (t) { return '<span class="vf-pill-tag vf-approver-' + t + '">' + AUDIT[t] + '</span>'; }).join(' ') + '</td>' +
        '<td><span class="vf-pill vf-pill-pending">' + a.requests.length + ' waiting</span></td>' +
        '<td>' + a.requests.map(function (q) { return '<button type="button" class="vf-chip" data-vf-open-req="' + esc(q.id) + '">' + esc(q.name) + '</button>'; }).join('') + '</td></tr>';
    }).join('') + '</tbody></table>');
  }
  $(document).on('click', '[data-vf-open-req]', function () { openRequest(String($(this).data('vf-open-req'))); $('html, body, .main').animate({ scrollTop: $('#wfRequestDetail').offset().top - 80 }, 200); });

  function renderRequestsList() {
    if (!wf.requests.length) { $('#wfRequestsList').html('<div class="vf-empty">No requests yet.</div>'); return; }
    $('#wfRequestsList').html('<table class="vf-table"><thead><tr><th>Icon</th><th>Target</th><th>Requested by</th><th>Visual audit</th><th>UI audit</th><th>Status</th><th></th></tr></thead><tbody>' +
      wf.requests.map(function (r) {
        return '<tr class="vf-row" data-vf-req="' + esc(r.ROWID) + '">' +
          '<td>' + esc(r.iconName) + '</td><td>' + esc(r.targetSprite === 'svg_cssicons' ? 'cssicon' : 'utilicon') + '</td>' +
          '<td>' + esc(r.requestedByName || r.requestedBy) + '</td>' +
          '<td>' + reviewerCell(r.assignedDesigner, r.designerDecision, r.designerBy, r.notifiedDesigners, r.status, 'designer') + '</td>' +
          '<td>' + reviewerCell(r.assignedUI, r.uiDecision, r.uiBy, r.notifiedUI, r.status, 'ui', r.designerDecision !== 'approved') + '</td>' +
          '<td>' + pill(r.status) + mailTag(r) + '</td>' +
          '<td class="vf-row-actions">' + (canDelete(r) ? '<button class="btn btn-ghost btn-sm vf-pill" data-vf-req-del="' + esc(r.ROWID) + '" style="color:var(--danger)">Delete</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>');
  }

  $(document).on('click', '.vf-row', function () { openRequest(String($(this).data('vf-req'))); });

  function stepsHtml(r) {
    var rej = function (d) { return d === 'rejected'; };
    var steps = [
      { label: 'Requested', cls: 'done' },
      { label: 'Visual audit', cls: r.designerDecision === 'approved' ? 'done' : rej(r.designerDecision) ? 'rejected' : 'current' },
      { label: 'UI audit', cls: r.uiDecision === 'approved' ? 'done' : rej(r.uiDecision) ? 'rejected' : (r.designerDecision === 'approved' ? 'current' : '') },
      { label: 'Mock verified', cls: (r.status === 'approved' || r.status === 'pushed') ? 'done' : '' },
      { label: 'Pushed to library', cls: r.status === 'pushed' ? 'done' : (r.status === 'approved' ? 'current' : '') }
    ];
    return '<div class="vf-steps">' + steps.map(function (s) { return '<div class="vf-step ' + s.cls + '">' + s.label + '</div>'; }).join('') + '</div>';
  }

  function openRequest(id) {
    wf.openId = id;
    api('GET', 'requests/' + encodeURIComponent(id)).then(function (res) {
      var r = res.request;
      var actions = '';
      if (wf.role === 'admin' && r.status === 'pending') {
        actions += '<span class="vf-msg">The Visual audit approvers were mailed; the UI audit approvers are mailed after the visual audit is approved. Optionally assign one person instead:</span>' +
          '<select id="wfAssignDesigner"><option value="">Any Visual audit approver</option></select>' +
          '<select id="wfAssignUI"><option value="">Any UI audit approver</option></select>' +
          '<button class="btn btn-primary btn-sm" id="wfAssignBtn" type="button">Assign</button>';
      }
      if (res.canReview) { // this person is in the approver pool for a slot that is still open
        actions += '<input id="wfReviewNote" type="text" placeholder="Note (optional)">' +
          '<button class="btn btn-primary btn-sm" data-vf-review="approve" type="button">Approve</button>' +
          '<button class="btn btn-ghost btn-sm" data-vf-review="reject" type="button" style="color:var(--danger)">Reject</button>';
      }
      if (wf.role === 'admin' && r.status === 'pending') {
        actions += '<button class="btn btn-ghost btn-sm vf-pill" id="wfResendBtn" type="button" title="Mail the approvers of every open review again">Resend mail</button>';
      }
      if (canDelete(r)) {
        actions += '<button class="btn btn-ghost btn-sm vf-pill" data-vf-req-del="' + esc(r.ROWID) + '" type="button" style="color:var(--danger);margin-left:auto">Delete request</button>';
      }
      if (wf.role === 'admin' && r.status === 'approved') {
        actions += '<button class="btn btn-primary btn-sm" id="wfPushBtn" type="button">Push to ' + esc(TARGETS[r.targetSprite] || r.targetSprite) + '</button>';
      }
      $('#wfRequestDetail').html('<div class="vf-detail">' +
        '<div class="vf-detail-head"><img src="' + dataUri(r.svg) + '" alt=""><div><b>' + esc(r.iconName) + '</b> ' + pill(r.status) +
          '<div class="vf-msg">' + 'target: ' + esc(TARGETS[r.targetSprite] || r.targetSprite) +
          ' · by ' + esc(r.requestedBy) + (r.note ? '<br>' + esc(r.note) : '') + '</div></div></div>' +
        stepsHtml(r) +
        (actions ? '<div class="vf-actions" data-vf-id="' + esc(r.ROWID) + '">' + actions + '</div>' : '') +
        '<ul class="vf-timeline">' + (res.events || []).map(function (ev) {
          return '<li><b>' + esc(actionLabel(ev.action)) + '</b> — ' + esc(ev.actor) + (ev.note ? ': ' + esc(ev.note) : '') + '</li>';
        }).join('') + '</ul></div>');
      wf.open = r;
      if (wf.role === 'admin' && r.status === 'pending') fillAssignDropdowns(r);
    }).catch(fail);
  }

  // Dropdowns come from the user list, filtered by role.
  function fillAssignDropdowns(r) {
    ['designer', 'ui'].forEach(function (type) {
      api('GET', 'users?approver=' + type).then(function (res) {
        var $sel = $(type === 'designer' ? '#wfAssignDesigner' : '#wfAssignUI');
        res.users.forEach(function (u) {
          $sel.append('<option value="' + esc(u.email) + '">' + esc(u.name) + ' (' + esc(u.email) + ')</option>');
        });
        $sel.val(type === 'designer' ? r.assignedDesigner : r.assignedUI);
      }).catch(fail);
    });
  }

  $(document).on('click', '[data-vf-req-del]', function (e) {
    e.stopPropagation();
    var id = String($(this).data('vf-req-del'));
    var r = (wf.requests || []).filter(function (x) { return String(x.ROWID) === id; })[0];
    if (!window.confirm('Delete the request' + (r ? ' for "' + r.iconName + '"' : '') + '? Its history is removed too.')) return;
    api('DELETE', 'requests/' + encodeURIComponent(id)).then(function () {
      SF.showToast('Request deleted');
      if (wf.openId === id) { wf.openId = null; $('#wfRequestDetail').empty(); }
      return Promise.all([loadRequests(), loadStatuses()]);
    }).catch(fail);
  });

  $(document).on('click', '#wfMailTest', function () {
    var $b = $(this).prop('disabled', true).text('Sending…'), $r = $('#wfMailTestResult').removeClass('hidden vf-mailtest-ok vf-mailtest-bad').text('Sending a test mail…');
    api('POST', 'mail/test').then(function (res) {
      var where = res.runtime ? 'deployed on Catalyst' : 'your LOCAL server';
      var head = 'Server: ' + where + ' · Sender (MAIL_FROM): ' + (res.from || 'not set') + ' · To: ' + res.to;
      if (res.ok) $r.addClass('vf-mailtest-ok').html('<b>✓ Test mail sent.</b> Check the inbox of ' + esc(res.to) + '.<div class="vf-msg">' + esc(head) + '</div>');
      else if (res.dev) $r.addClass('vf-mailtest-bad').html('<b>Not sent:</b> this server has no Catalyst credentials.<div class="vf-msg">' + esc(head) + '</div>');
      else $r.addClass('vf-mailtest-bad').html('<b>✗ Mail failed.</b> ' + esc(res.error) + '<div class="vf-msg">' + esc(head) + '</div>');
    }).catch(function (e) { $r.addClass('vf-mailtest-bad').text(e.message); })
      .then(function () { $b.prop('disabled', false).text('Send test mail to me'); });
  });

  $(document).on('click', '#wfResendBtn', function () {
    var $b = $(this).prop('disabled', true);
    api('POST', 'requests/' + wf.open.ROWID + '/resend').then(function (res) {
      SF.showToast(res.failed ? 'Resend: ' + res.sent + ' sent, ' + res.failed + ' failed' + (res.error ? ' — ' + res.error : '')
        : res.sent ? 'Approval mail sent again to ' + res.sent + ' approver' + (res.sent === 1 ? '' : 's') : 'Nobody to mail yet');
      return loadRequests();
    }).catch(fail).then(function () { $b.prop('disabled', false); });
  });

  $(document).on('click', '#wfAssignBtn', function () {
    var d = $('#wfAssignDesigner').val(), u = $('#wfAssignUI').val();
    if (!d && !u) { SF.showToast('Pick a Visual audit and/or UI audit approver to assign'); return; }
    api('POST', 'requests/' + wf.open.ROWID + '/assign', { designer: d, ui: u })
      .then(function (res) {
        var mail = res.mail || [], bad = mail.filter(function (m) { return !m.ok; });
        SF.showToast(bad.length ? 'Assigned — mail failed: ' + bad[0].error
          : mail.some(function (m) { return m.dev; }) ? 'Assigned (mail NOT delivered — no Catalyst credentials; see the server log)'
          : 'Assigned — approval mail sent to ' + mail.map(function (m) { return m.to; }).join(', '));
        return loadRequests();
      }).catch(fail);
  });

  $(document).on('click', '[data-vf-review]', function () {
    api('POST', 'requests/' + wf.open.ROWID + '/review', { decision: $(this).data('vf-review'), note: $('#wfReviewNote').val() })
      .then(function (res) {
        var u = res.uiMail;
        SF.showToast(u ? (u.failed ? 'Saved — UI audit approvers: ' + u.failed + ' mail(s) failed' + (u.error ? ': ' + u.error : '')
          : u.local ? 'Saved — UI audit approvers listed (mail NOT delivered: no Catalyst credentials)'
          : u.sent ? 'Saved — mailed ' + u.sent + ' UI audit approver' + (u.sent === 1 ? '' : 's') + ' for the next audit'
          : 'Saved — no UI audit approvers yet to mail') : 'Review saved');
        return Promise.all([loadRequests(), loadStatuses()]);
      }).catch(fail);
  });

  // Push: add the single icon to the chosen sprite of the main library repo, then record it.
  $(document).on('click', '#wfPushBtn', function () {
    var r = wf.open, $btn = $(this).prop('disabled', true);
    var file = r.targetSprite + '.svg', pushedVersion = null;
    var done = function () { $btn.prop('disabled', false); };
    SF.showToast('Adding ' + r.iconName + ' to ' + file + '…');
    SF.fetchMasterLibraryFile(file).then(function (text) {
      var res = SF.addIconsToSpriteText(text, [{ name: r.iconName, text: r.svg }]);
      if (!res.added.length) {
        var why = res.skipped.length ? res.skipped[0].reason : 'nothing to add';
        if (why !== 'already in the sprite') throw new Error('Could not add icon: ' + why);
        return { alreadyThere: true };
      }
      return new Promise(function (resolve, reject) {
        $.ajax({
          url: SF.masterLibraryUrl('api/master-library/save'), type: 'POST', dataType: 'json',
          headers: SF.masterLibraryAuthHeaders(), contentType: 'application/json',
          data: JSON.stringify({ files: [{ name: file, content: res.svg }], message: 'Add ' + r.iconName + ' to ' + file + ' (verified) via SpriteForge' }),
          success: function (out) {
            if (!out || out.success === false || out.pushError) reject(new Error((out && (out.pushError || out.message)) || 'Push failed'));
            else resolve(out);
          },
          error: function (xhr) { reject(new Error((xhr.responseJSON && xhr.responseJSON.message) || 'Push failed')); }
        });
      });
    }).then(function (out) {
      if (out && typeof SF.setLibraryVersion === 'function') SF.setLibraryVersion(out);
      pushedVersion = out && out.release ? out.release.version : null;
      return api('POST', 'requests/' + r.ROWID + '/push', { commitSha: (out && out.commit) || '' });
    }).then(function () {
      SF.showToast('Pushed to ' + file + (pushedVersion ? ' · published ' + pushedVersion : ''));
      return Promise.all([loadRequests(), loadStatuses()]);
    }).catch(fail).then(done);
  });

  // ── Members page (admin): Member / Role / Added On / Access Expires + "Add Member" dialog ──
  function initials(name) {
    var p = String(name || '?').trim().split(/\s+/);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  function photoSrc(url) {
    url = String(url || '');
    if (url.indexOf('proxy:') === 0) { // People photos need the org token: load through the server (img tags can't send headers)
      var sid = (SF.masterLibraryAuthHeaders() || {})['x-session-id'] || '';
      return SF.masterLibraryUrl('api/org-users/photo?u=' + encodeURIComponent(url.slice(6)) + '&session_id=' + encodeURIComponent(sid));
    }
    return /^https?:\/\//i.test(url) ? url : '';
  }
  // Photo when we have one; initials underneath as the fallback if it is missing or fails to load.
  function avatarHtml(url, name) {
    var src = photoSrc(url);
    return '<span class="vf-avatar">' + esc(initials(name)) +
      (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + '</span>';
  }

  function fmtAdded(v) {
    var d = new Date(v);
    if (!v || isNaN(d.getTime())) return '—';
    var o = { month: 'short', day: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString(undefined, o);
  }
  function fmtExpiry(v) {
    var d = new Date(v);
    if (!v || isNaN(d.getTime())) return '<span class="vf-msg">No expiration set</span>';
    var txt = d.toLocaleString(undefined, { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return d.getTime() <= Date.now() ? '<span class="vf-expired">Expired · ' + esc(txt) + '</span>' : esc(txt);
  }
  function assignableRoles() {
    var list = (wf.roles || []).filter(function (r) { return r.key !== 'user'; });
    return list.length ? list : [{ key: 'designer', name: 'Designer' }, { key: 'ui', name: 'UI' }, { key: 'admin', name: 'Admin' }];
  }
  function roleOptions(sel) {
    return assignableRoles().map(function (r) {
      return '<option value="' + esc(r.key) + '"' + (r.key === sel ? ' selected' : '') + '>' + esc(r.name) + '</option>';
    }).join('');
  }
  function menuLabel(key) {
    var m = (wf.menuCatalog || []).filter(function (x) { return x.key === key; })[0];
    return m ? m.label : key;
  }
  function roleHint(key) {
    if (ROLE_INFO[key]) return ROLE_INFO[key];
    var r = (wf.roles || []).filter(function (x) { return x.key === key; })[0];
    return r ? r.name + ' — can open: ' + (r.menus.map(menuLabel).join(', ') || 'no menus') : '';
  }

  function membersPageHtml() {
    return '<div class="content hidden" id="wfMembersPage">' +
      '<div class="panel"><div class="panel-header"><h3 class="panel-title">Members</h3>' +
        '<div class="panel-actions vf-head-actions"><input id="wfMemberFilter" class="vf-input" type="search" placeholder="Search members" autocomplete="off">' +
        '<button class="btn btn-primary btn-sm vf-pill" id="wfOpenAdd" type="button">Add Member</button></div></div>' +
        '<div class="vf-tabs" id="wfMemberTabs"></div>' +
        '<div class="panel-body-flush"><div id="wfMembersList"></div></div></div>' +
      '<div class="panel" style="margin-top:16px"><div class="panel-header"><h3 class="panel-title">Roles &amp; menu access</h3>' +
        '<div class="panel-actions"><button class="btn btn-primary btn-sm vf-pill" id="wfOpenRole" type="button">Add Role</button></div></div>' +
        '<div class="vf-roles-layout"><div class="vf-role-list" id="wfRoleList"></div><div class="vf-role-editor" id="wfRoleEditor"></div></div></div>' +
      '</div>';
  }

  function memberModalHtml() {
    return '<div class="vf-modal-overlay hidden" id="wfMemberModal"><div class="vf-modal" role="dialog" aria-label="Add Member">' +
      '<div class="vf-modal-head"><h3 id="wfMemberModalTitle">Add Member</h3><button type="button" class="vf-modal-x" id="wfModalClose" aria-label="Close">×</button></div>' +
      '<div class="vf-modal-row" id="wfSearchRow">' +
        '<div class="vf-search vf-grow"><input id="wfUserSearch" class="vf-input" type="search" autocomplete="off" placeholder="Enter name or email address">' +
          '<div id="wfUserResults" class="vf-results hidden"></div></div>' +
      '</div>' +
      '<div class="vf-picked" id="wfUserPicked"></div>' +
      '<div class="vf-modal-grid">' +
        '<label class="vf-field"><span>Role <em>(menu access)</em></span><select id="wfMemberType" class="vf-input">' + roleOptions('designer') + '</select></label>' +
        '<label class="vf-field"><span>Approver</span><select id="wfMemberApprover" class="vf-input">' +
          '<option value="none" selected>None</option><option value="designer">Visual audit</option><option value="ui">UI audit</option></select></label>' +
      '</div>' +
      '<div class="vf-role-hint" id="wfTypeHint"></div>' +
      '<div class="vf-role-hint" id="wfApproverHint">' + esc(APPROVER_INFO.none) + '</div>' +
      '<div class="vf-modal-label">Access Expiration Date <span class="vf-msg">(Optional):</span></div>' +
      '<input id="wfMemberExpiry" class="vf-input" type="datetime-local">' +
      '<div class="vf-modal-error hidden" id="wfModalError"></div>' +
      '<div class="vf-modal-foot"><button class="btn btn-primary btn-sm vf-pill" id="wfMemberAdd" type="button">Add</button>' +
        '<button class="btn btn-ghost btn-sm vf-pill" id="wfModalCancel" type="button">Cancel</button></div>' +
      '</div></div>';
  }

  var MEMBER_TABS = [['all', 'All members'], ['designer', 'Visual audit'], ['ui', 'UI audit']];

  // Pending / approved counts per approver, from the requests list (admins receive every request).
  function approverStats(email) {
    var e = String(email || '').toLowerCase(), st = { pending: 0, approved: 0 };
    (wf.requests || []).forEach(function (r) {
      [['assignedDesigner', 'designerDecision'], ['assignedUI', 'uiDecision']].forEach(function (p) {
        if (String(r[p[0]] || '').toLowerCase() !== e) return;
        if (r[p[1]] === 'approved') st.approved++;
        else if (!r[p[1]] && r.status === 'pending') st.pending++;
      });
    });
    return st;
  }

  function roleName(key) {
    var r = (wf.roles || []).filter(function (x) { return x.key === key; })[0];
    return r ? r.name : (key || '—');
  }
  function approverPill(m) {
    var a = isExpiredMember(m) ? '' : approverOf(m);
    return a ? '<span class="vf-pill-tag vf-approver-' + a + '">' + AUDIT[a] + '</span>' : '<span class="vf-msg">None</span>';
  }

  function renderMembers() {
    var q = ($('#wfMemberFilter').val() || '').trim().toLowerCase(), tab = wf.memberTab || 'all';
    var inTab = function (m) { return tab === 'all' || (!isExpiredMember(m) && approverOf(m) === tab); };
    $('#wfMemberTabs').html(MEMBER_TABS.map(function (t) {
      var n = (wf.members || []).filter(function (m) { return t[0] === 'all' || (!isExpiredMember(m) && approverOf(m) === t[0]); }).length;
      return '<button type="button" class="vf-tab' + (t[0] === tab ? ' active' : '') + '" data-vf-tab="' + t[0] + '">' + esc(t[1]) + ' <span class="vf-count">' + n + '</span></button>';
    }).join(''));
    var list = (wf.members || []).filter(function (m) { return inTab(m) && (!q || (m.userName + ' ' + m.userEmail).toLowerCase().indexOf(q) !== -1); });
    var approvers = tab !== 'all';
    $('#wfMembersList').html(list.length ? '<table class="vf-table"><thead><tr><th>Members</th><th>Role</th><th>Approver</th>' +
      (approvers ? '<th>Waiting for approval</th><th>Approved</th>' : '<th>Added On</th><th>Access Expires</th>') + '<th></th></tr></thead><tbody>' +
      list.map(function (m) {
        var you = String(m.userEmail).toLowerCase() === String(wf.email || '').toLowerCase();
        var st = approvers ? approverStats(m.userEmail) : null;
        return '<tr><td><div class="vf-person">' + avatarHtml(m.userAvatar, m.userName || m.userEmail) +
          '<div><b>' + esc(m.userName || m.userEmail) + '</b>' + (you ? ' <span class="vf-you">You</span>' : '') +
          '<div class="vf-msg">' + esc(m.userEmail) + '</div></div></div></td>' +
          '<td title="' + esc(roleHint(m.memberType)) + '">' + esc(roleName(m.memberType)) + '</td><td>' + approverPill(m) + '</td>' +
          (approvers
            ? '<td>' + (st.pending ? '<span class="vf-pill vf-pill-pending">' + st.pending + ' waiting</span>' : '<span class="vf-msg">none</span>') + '</td><td>' + st.approved + '</td>'
            : '<td>' + esc(fmtAdded(m.CREATEDTIME)) + '</td><td>' + fmtExpiry(m.expiresAt) + '</td>') +
          '<td class="vf-row-actions"><button class="btn btn-ghost btn-sm vf-pill" data-vf-member-edit="' + esc(m.ROWID) + '">Edit</button>' +
          '<button class="btn btn-ghost btn-sm vf-pill" data-vf-member-del="' + esc(m.ROWID) + '" style="color:var(--danger)">Remove</button></td></tr>';
      }).join('') + '</tbody></table>'
      : '<div class="vf-empty">' + (q ? 'No members match your search.' : approvers ? 'No ' + AUDIT[tab] + ' approvers yet. Add or edit a member and set Approver.' : 'No members yet. Click Add Member to start.') + '</div>');
  }

  $(document).on('click', '[data-vf-tab]', function () { wf.memberTab = $(this).data('vf-tab'); renderMembers(); });

  // ── Roles & menu access: role list on the left, grouped switches for the selected role on the right ──
  function menuGroups() {
    var groups = [];
    (wf.menuCatalog || []).forEach(function (m) {
      var g = groups.filter(function (x) { return x.name === m.group; })[0];
      if (!g) { g = { name: m.group, items: [] }; groups.push(g); }
      g.items.push(m);
    });
    return groups;
  }

  function menuSwitches(selected, attr, disabled) {
    return menuGroups().map(function (g) {
      return '<div class="vf-menu-group"><div class="vf-menu-group-title">' + esc(g.name) + '</div>' + g.items.map(function (m) {
        return '<label class="vf-switch-row"><span>' + esc(m.label) + '</span>' +
          '<input type="checkbox" class="vf-switch" ' + attr + ' value="' + esc(m.key) + '"' +
          (selected.indexOf(m.key) !== -1 ? ' checked' : '') + (disabled ? ' disabled' : '') + '></label>';
      }).join('') + '</div>';
    }).join('');
  }

  /** Values of the switched-on menu toggles inside a container. */
  function checkedVals($box) {
    return $box.find('input:checked').map(function () { return this.value; }).get();
  }

  function selectedRole() { return (wf.roles || []).filter(function (x) { return x.key === wf.roleSel; })[0]; }

  function renderRoles() {
    var roles = wf.roles || [];
    if (!roles.some(function (r) { return r.key === wf.roleSel; })) wf.roleSel = roles.length ? roles[0].key : null;
    $('#wfRoleList').html(roles.map(function (r) {
      var used = (wf.members || []).filter(function (m) { return m.memberType === r.key; }).length;
      return '<button type="button" class="vf-role-item' + (r.key === wf.roleSel ? ' active' : '') + '" data-vf-role-pick="' + esc(r.key) + '">' +
        '<span class="vf-role-name">' + esc(r.name) + '</span>' +
        '<span class="vf-msg">' + (r.key === 'user' ? 'No role assigned' : used + ' member' + (used === 1 ? '' : 's')) + (r.builtin ? '' : ' · Custom') + '</span></button>';
    }).join(''));
    var r = selectedRole();
    var warn = wf.rolesWarning ? '<div class="vf-modal-error">' + esc(wf.rolesWarning) + '</div>' : '';
    if (!r) { $('#wfRoleEditor').html(warn); return; }
    var menus = r.fixed ? (wf.menuCatalog || []).map(function (m) { return m.key; }) : r.menus;
    $('#wfRoleEditor').html(warn +
      '<div class="vf-editor-head"><div><h4>' + esc(r.name) + (r.builtin ? ' <span class="vf-pill-tag">Built-in</span>' : ' <span class="vf-pill-tag">Custom</span>') + '</h4>' +
        '<div class="vf-msg">' + esc(r.fixed ? 'Admin always has every menu, plus Members.' : r.key === 'user' ? 'Applies to signed-in users who have no member role.' : 'Choose the menus this role can open, then click Save changes.') + '</div></div>' +
        (r.builtin ? '' : '<div><button class="btn btn-ghost btn-sm vf-pill" data-vf-role-rename="' + esc(r.key) + '">Rename</button> ' +
          '<button class="btn btn-ghost btn-sm vf-pill" data-vf-role-del="' + esc(r.key) + '" style="color:var(--danger)">Delete role</button></div>') + '</div>' +
      (r.fixed ? '' : '<div class="vf-bulk"><button type="button" class="vf-link" data-vf-bulk="all">Select all</button><button type="button" class="vf-link" data-vf-bulk="none">Clear all</button></div>') +
      '<div class="vf-menu-grid" data-vf-role-menus="' + esc(r.key) + '">' + menuSwitches(menus, '', r.fixed) + '</div>' +
      (r.fixed ? '' : '<div class="vf-role-savebar"><span class="vf-msg" id="wfRoleDirty"></span>' +
        '<button type="button" class="btn btn-ghost btn-sm vf-pill" id="wfRoleDiscard" disabled>Discard</button>' +
        '<button type="button" class="btn btn-primary btn-sm vf-pill" id="wfRoleSave" disabled>Save changes</button></div>'));
  }

  function roleDirty() {
    var r = selectedRole(), $box = $('[data-vf-role-menus]');
    if (!r || r.fixed || !$box.length) return false;
    return checkedVals($box).slice().sort().join(',') !== (r.menus || []).slice().sort().join(',');
  }
  function refreshSaveBar() {
    var dirty = roleDirty();
    $('#wfRoleSave, #wfRoleDiscard').prop('disabled', !dirty);
    $('#wfRoleDirty').text(dirty ? 'Unsaved changes' : '');
  }
  $(document).on('click', '[data-vf-role-pick]', function () {
    if (roleDirty() && !window.confirm('Discard unsaved menu changes?')) return;
    wf.roleSel = $(this).data('vf-role-pick'); renderRoles();
  });

  // Toggles only mark the role as changed; Save changes writes every menu's true/false to the role's row.
  $(document).on('change', '[data-vf-role-menus] input', refreshSaveBar);
  $(document).on('click', '[data-vf-bulk]', function () {
    $('[data-vf-role-menus]').find('input:not(:disabled)').prop('checked', $(this).data('vf-bulk') === 'all');
    refreshSaveBar();
  });
  $(document).on('click', '#wfRoleDiscard', renderRoles);
  $(document).on('click', '#wfRoleSave', function () {
    var $box = $('[data-vf-role-menus]'), roleKey = $box.data('vf-role-menus'), menus = checkedVals($box);
    $('#wfRoleSave').prop('disabled', true).text('Saving…');
    api('PATCH', 'roles/' + encodeURIComponent(roleKey), { menus: menus })
      .then(function () {
        var r = selectedRole();
        if (r) r.menus = menus;
        SF.showToast('Menu access saved');
        loadMe(); // re-apply the sidebar if the signed-in user holds this role
      })
      .catch(fail)
      .then(function () { $('#wfRoleSave').text('Save changes'); refreshSaveBar(); });
  });
  $(document).on('click', '[data-vf-role-rename]', function () {
    var key = $(this).data('vf-role-rename'), r = (wf.roles || []).filter(function (x) { return x.key === key; })[0];
    var name = r && window.prompt('Role name', r.name);
    if (!name || !name.trim() || name.trim() === r.name) return;
    api('PATCH', 'roles/' + encodeURIComponent(key), { name: name.trim() }).then(function () { SF.showToast('Role renamed'); loadMembers(); }).catch(fail);
  });

  function loadMembers() {
    Promise.all([api('GET', 'members'), api('GET', 'roles'), api('GET', 'requests').catch(function () { return { requests: [] }; })]).then(function (res) {
      wf.members = res[0].members || [];
      wf.roles = res[1].roles || [];
      wf.menuCatalog = res[1].menus || [];
      wf.rolesWarning = res[1].warning || res[0].warning || '';
      wf.requests = res[2].requests || [];
      renderMembers();
      renderRoles();
    }).catch(function (e) { $('#wfMembersList').html('<div class="vf-empty">' + esc(e.message) + '</div>'); });
  }
  $(document).on('input', '#wfMemberFilter', renderMembers);

  // ── Add Member dialog ──
  function toLocalInput(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function updateHints() {
    $('#wfTypeHint').text(roleHint($('#wfMemberType').val()));
    $('#wfApproverHint').text(APPROVER_INFO[$('#wfMemberApprover').val()] || '');
  }
  function showPicked(avatar, name, email) {
    $('#wfUserPicked').html('<div class="vf-person">' + avatarHtml(avatar, name) +
      '<div><b>' + esc(name) + '</b><div class="vf-msg">' + esc(email) + '</div></div></div>');
  }

  // One dialog for both "Add Member" and "Edit Member" (wf.editing = the member being edited).
  function openMemberModal(member) {
    wf.editing = member || null; wf.picked = null;
    $('#wfMemberModalTitle').text(member ? 'Edit Member' : 'Add Member');
    $('#wfMemberAdd').text(member ? 'Save' : 'Add');
    $('#wfMemberType').html(roleOptions(member ? member.memberType : 'designer'));
    $('#wfMemberApprover').val(member ? (approverOf(member) || 'none') : 'none');
    $('#wfUserSearch').val('');
    wf.expiryOrig = member ? toLocalInput(member.expiresAt) : '';
    $('#wfMemberExpiry').val(wf.expiryOrig);
    $('#wfSearchRow').toggleClass('hidden', !!member);
    $('#wfUserPicked').empty(); $('#wfModalError').addClass('hidden');
    if (member) showPicked(member.userAvatar, member.userName || member.userEmail, member.userEmail);
    updateHints();
    $('#wfMemberModal').removeClass('hidden');
    if (member) return;
    showSearchHint(); // nothing is loaded until the admin types
    setTimeout(function () { $('#wfUserSearch').trigger('focus'); }, 30);
  }
  function openAddModal() { openMemberModal(null); }
  function closeAddModal() { $('#wfMemberModal').addClass('hidden'); }
  function modalError(msg) { $('#wfModalError').text(msg).toggleClass('hidden', !msg); }

  $(document).on('change', '#wfMemberType, #wfMemberApprover', updateHints);
  $(document).on('click', '[data-vf-member-edit]', function () {
    var id = String($(this).data('vf-member-edit'));
    openMemberModal((wf.members || []).filter(function (m) { return String(m.ROWID) === id; })[0] || null);
  });
  $(document).on('click', '#wfOpenAdd', openAddModal);
  $(document).on('click', '#wfModalClose, #wfModalCancel', closeAddModal);
  $(document).on('click', '#wfMemberModal', function (e) { if (e.target === this) closeAddModal(); });
  $(document).on('keydown', function (e) { if (e.key === 'Escape') closeAddModal(); });

  // User search over the Zoho org (People + Cliq directory); runs only once the admin types.
  var searchTimer = null;
  function showSearchHint() {
    $('#wfUserResults').removeClass('hidden').html('<div class="vf-result-note">Type at least 2 letters of a name or email to search Zoho employees</div>');
  }
  function searchUsers() {
    var q = $('#wfUserSearch').val().trim();
    if (q.length < 2) { showSearchHint(); return; }
    $('#wfUserResults').removeClass('hidden').html('<div class="vf-result-note">Searching Zoho users…</div>');
    api('GET', 'org-users?q=' + encodeURIComponent(q)).then(function (r) {
      var $box = $('#wfUserResults').removeClass('hidden');
      $box.html((r.warning ? '<div class="vf-result-note">' + esc(r.warning) + '</div>' : '') +
        (r.users.length ? r.users.map(function (u) {
          return '<div class="vf-result" data-email="' + esc(u.email) + '" data-name="' + esc(u.name) + '" data-avatar="' + esc(u.avatar || '') + '">' +
            avatarHtml(u.avatar, u.name) + '<div><b>' + esc(u.name) + '</b><div class="vf-msg">' + esc(u.email) +
            (u.department || u.designation ? ' · ' + esc([u.designation, u.department].filter(Boolean).join(', ')) : '') + '</div></div></div>';
        }).join('') : '<div class="vf-result-note vf-notfound">User not found for "' + esc(q) + '"</div>') +
        (/^\S+@\S+\.\S+$/.test(q) && !r.users.some(function (u) { return u.email.toLowerCase() === q.toLowerCase(); })
          ? '<div class="vf-result" data-email="' + esc(q) + '" data-name="' + esc(q.split('@')[0]) + '" data-avatar="">' + avatarHtml('', q) +
            '<div><b>Add "' + esc(q) + '"</b><div class="vf-msg">Use this email even if it is not in the list</div></div></div>' : '') +
        '<div class="vf-result-note">' + r.users.length + ' shown (' + esc(r.source) + ')</div>');
    }).catch(function (e) { $('#wfUserResults').removeClass('hidden').html('<div class="vf-result-note vf-notfound">' + esc(e.message) + '</div>'); });
  }
  $(document).on('input focus', '#wfUserSearch', function () {
    clearTimeout(searchTimer); searchTimer = setTimeout(searchUsers, 450);
  });
  $(document).on('click', '.vf-result', function () {
    wf.picked = { email: $(this).data('email'), name: $(this).data('name'), avatar: $(this).data('avatar') };
    showPicked(wf.picked.avatar, wf.picked.name, wf.picked.email);
    $('#wfUserSearch').val('');
    $('#wfUserResults').addClass('hidden'); modalError('');
  });
  $(document).on('click', function (e) { if (!$(e.target).closest('.vf-search').length) $('#wfUserResults').addClass('hidden'); });

  $(document).on('click', '#wfMemberAdd', function () {
    var exp = $('#wfMemberExpiry').val();
    var body = { memberType: $('#wfMemberType').val(), approverType: $('#wfMemberApprover').val() };
    if (wf.editing) {
      if (exp !== wf.expiryOrig) body.expiresAt = exp ? new Date(exp).toISOString() : ''; // untouched expiry is not re-validated
      api('PATCH', 'members/' + encodeURIComponent(wf.editing.ROWID), body)
        .then(function () { SF.showToast('Member updated'); closeAddModal(); loadMembers(); }).catch(function (e) { modalError(e.message); });
      return;
    }
    if (!wf.picked) { modalError('Search and select a user first'); return; }
    body.userEmail = wf.picked.email; body.userName = wf.picked.name; body.userAvatar = wf.picked.avatar || '';
    body.expiresAt = exp ? new Date(exp).toISOString() : '';
    api('POST', 'members', body)
      .then(function () { SF.showToast('Member added'); closeAddModal(); loadMembers(); }).catch(function (e) { modalError(e.message); });
  });

  // ── Add Role dialog + delete ──
  function roleModalHtml() {
    return '<div class="vf-modal-overlay hidden" id="wfRoleModal"><div class="vf-modal vf-modal-wide" role="dialog" aria-label="Add Role">' +
      '<div class="vf-modal-head"><h3>Add Role</h3><button type="button" class="vf-modal-x" id="wfRoleClose" aria-label="Close">×</button></div>' +
      '<input id="wfRoleName" class="vf-input" type="text" maxlength="40" placeholder="Role name, e.g. Icon Reviewer">' +
      '<div class="vf-modal-label">Menus this role can open</div>' +
      '<div class="vf-menu-grid vf-menu-grid-modal" id="wfNewRoleMenus"></div>' +
      '<div class="vf-modal-error hidden" id="wfRoleError"></div>' +
      '<div class="vf-modal-foot"><button class="btn btn-primary btn-sm vf-pill" id="wfRoleAdd" type="button">Add</button>' +
        '<button class="btn btn-ghost btn-sm vf-pill" id="wfRoleCancel" type="button">Cancel</button></div></div></div>';
  }
  $(document).on('click', '#wfOpenRole', function () {
    $('#wfRoleName').val(''); $('#wfRoleError').addClass('hidden');
    $('#wfNewRoleMenus').html(menuSwitches([], 'data-new-role'));
    $('#wfRoleModal').removeClass('hidden');
    setTimeout(function () { $('#wfRoleName').trigger('focus'); }, 30);
  });
  $(document).on('click', '#wfRoleClose, #wfRoleCancel', function () { $('#wfRoleModal').addClass('hidden'); });
  $(document).on('click', '#wfRoleModal', function (e) { if (e.target === this) $(this).addClass('hidden'); });
  $(document).on('click', '#wfRoleAdd', function () {
    var name = $('#wfRoleName').val().trim();
    if (!name) { $('#wfRoleError').text('Enter a role name').removeClass('hidden'); return; }
    api('POST', 'roles', { name: name, menus: checkedVals($('#wfNewRoleMenus')) })
      .then(function (r) { wf.roleSel = r.role.key; $('#wfRoleModal').addClass('hidden'); SF.showToast('Role added'); loadMembers(); })
      .catch(function (e) { $('#wfRoleError').text(e.message).removeClass('hidden'); });
  });
  $(document).on('click', '[data-vf-role-del]', function () {
    if (!window.confirm('Delete this role?')) return;
    api('DELETE', 'roles/' + encodeURIComponent($(this).data('vf-role-del'))).then(function () { wf.roleSel = null; loadMembers(); }).catch(fail);
  });

  $(document).on('click', '[data-vf-member-del]', function () {
    api('DELETE', 'members/' + $(this).data('vf-member-del')).then(loadMembers).catch(fail);
  });

  // ── page switching / init ────────────────────────────────────────────────
  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    if (!pageAllowed(page)) { // role-based menu restriction
      var fallback = firstAllowedPage();
      SF.showToast('Your role cannot open this menu');
      if (!fallback || fallback === page) return;
      page = fallback;
    }
    $('#wfRequestsPage, #wfMembersPage').addClass('hidden');
    $('#wfRequestsBtn, #wfMembersBtn').removeClass('active');
    if (page !== 'wfrequests' && page !== 'wfmembers') {
      origSwitch(page);
      if (page === 'requesticon') { loadMe(); renderRequestForm(); }
      if (page === 'iconlibrary') loadStatuses();
      return;
    }
    origSwitch('mostused'); // reuse its page reset, then swap in ours
    $('#mostUsedPage').addClass('hidden');
    $('#mostUsedBtn').removeClass('active');
    SF.state.page = page;
    try { localStorage.setItem('sf_active_page', page); } catch (e) {}
    var members = page === 'wfmembers';
    $(members ? '#wfMembersPage' : '#wfRequestsPage').removeClass('hidden');
    $(members ? '#wfMembersBtn' : '#wfRequestsBtn').addClass('active');
    $('#pageTitle').text(members ? 'Members' : 'Icon Requests');
    $('#pageBreadcrumb').text(members ? 'Admin' : 'Verification');
    loadMe().then(function () { if (members) loadMembers(); else loadRequests(); });
  };

  function navBtn(id, page, label, path) {
    return '<button class="sidebar-link" data-page="' + page + '" id="' + id + '">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + path + '</svg><span>' + label + '</span></button>';
  }

  $(function () {
    Promise.all(window._componentPromises || []).then(function () {
      $('.main').append(requestsPageHtml() + membersPageHtml());
      $('body').append(memberModalHtml() + roleModalHtml());
      $('#requestIconNavBtn').after(
        navBtn('wfRequestsBtn', 'wfrequests', 'Icon Requests', '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>') +
        navBtn('wfMembersBtn', 'wfmembers', 'Members', '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'));
      $('#wfMembersBtn').addClass('hidden');
      $('#wfRequestsBtn, #wfMembersBtn').on('click', function () { SF.switchPage($(this).data('page')); });
      loadStatuses();
      loadMe().then(function () {
        // app.js restored the last page before our pages and the role's menus were known.
        var last = null;
        try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
        var page = last === 'wfrequests' || last === 'wfmembers' ? last : SF.state.page;
        var link = null;
        try { link = sessionStorage.getItem('sf_deeplink_request'); } catch (e) {}
        if (link && wf.role) { // signed in: open the request from the mail
          try { sessionStorage.removeItem('sf_deeplink_request'); } catch (e) {}
          wf.openId = link;
          SF.switchPage('wfrequests');
          return;
        }
        if (!pageAllowed(page) || page === 'wfrequests' || page === 'wfmembers') SF.switchPage(page);
      });
    });
  });

})(window.SpriteForge, jQuery);
