/**
 * SpriteForge - Activity Log (admins only)
 * One dashboard for everything that happens in the tool, from GET /api/activity-log:
 *   - totals for the period
 *   - npm publishes: which version, by which admin, under which npm user, from which machine, with which icons
 *   - one feed of all activity (publishes, npm logins, helper setup, pushes, reviews, requests, notifications, sign-ins)
 *     with a type filter, a user filter and a search box
 *   - per-user totals
 * The menu is shown only to admins (workflow.js toggles #wfActivityLogBtn with #wfMembersBtn); the API is admin-only too.
 */
(function (SF, $) {
  'use strict';

  var PAGE = 'adminlog';
  var days = 30;
  var data = null;                                   // the last answer of the API
  var view = { cat: 'all', user: '', q: '', shown: 150 };
  var CATS = [['all', 'All'], ['publish', 'npm publishes'], ['npm', 'npm logins'], ['setup', 'Helper setup'], ['push', 'Pushes'],
    ['review', 'Reviews'], ['request', 'Requests'], ['notify', 'Notifications'], ['signin', 'Sign-ins']];
  var CAT_LABEL = { publish: 'npm publish', npm: 'npm login', setup: 'Helper setup', push: 'Push', review: 'Review', request: 'Request', notify: 'Notification', signin: 'Sign-in' };

  function url(p) { return String(window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/').replace(/\/+$/, '') + '/api/' + p; }
  function headers() { return typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {}; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function when(iso) {
    if (!iso) return '<span class="al-muted">—</span>';
    var d = new Date(iso);
    return '<span class="al-when" title="' + esc(d.toLocaleString()) + '">' + esc(d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) +
      ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) + '</span>';
  }
  function person(name, email) {
    if (!email && !name) return '<span class="al-muted">—</span>';
    return '<div class="al-person"><span class="al-name">' + esc(name || email) + '</span>' +
      (name && email ? '<span class="al-email">' + esc(email) + '</span>' : '') + '</div>';
  }
  function result(ok, yes, no) {
    return ok === false ? '<span class="al-pill al-pill-bad">' + esc(no) + '</span>' : '<span class="al-pill al-pill-ok">' + esc(yes) + '</span>';
  }

  function pageHtml() {
    return '<div class="content hidden" id="wfActivityLogPage"><div class="panel">' +
      '<div class="panel-header"><h3 class="panel-title">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>' +
        'Activity Log</h3>' +
        '<div class="panel-actions">' +
          '<select class="al-range" id="alRange" aria-label="Time range">' +
            '<option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="0">All time</option>' +
          '</select>' +
          '<button class="btn btn-ghost btn-sm" id="alRefresh" type="button">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh</button>' +
        '</div></div>' +
      '<div class="panel-body">' +
        '<div class="al-stats" id="alStats"></div>' +
        '<div id="alBody" class="hidden">' +
          '<h4 class="al-heading">npm publishes <span class="al-muted" id="alReleaseCount"></span></h4><div class="al-table-wrap" id="alReleases"></div>' +
          '<h4 class="al-heading">All activity <span class="al-muted" id="alFeedCount"></span></h4>' +
          '<div class="al-filters">' +
            '<div class="al-chips" id="alChips" role="tablist" aria-label="Activity type"></div>' +
            '<select class="al-range" id="alUser" aria-label="User"><option value="">All users</option></select>' +
            '<input class="al-search" id="alSearch" type="search" placeholder="Search icon, version, user, machine…" aria-label="Search activity">' +
          '</div>' +
          '<div class="al-table-wrap" id="alFeed"></div>' +
          '<h4 class="al-heading">By user</h4><div class="al-table-wrap" id="alUsers"></div>' +
        '</div>' +
      '</div></div></div>';
  }

  // ── totals ──
  function renderStats(d) {
    var s = d.stats || {};
    var tile = function (n, label, cat, bad) {
      return '<button type="button" class="al-stat' + (bad && n ? ' al-stat-bad' : '') + '"' + (cat ? ' data-al-cat="' + cat + '" title="Show these in the activity list"' : ' disabled') + '><span>' + (n || 0) + '</span>' + esc(label) + '</button>';
    };
    $('#alStats').html(
      tile(s.published, 'Versions published', 'publish') + tile(s.publishFailed, 'Publish failures', 'publish', true) +
      tile(s.pushes, 'Pushes', 'push') + tile(s.reviews, 'Reviews', 'review') + tile(s.requests, 'Requests', 'request') +
      tile(s.npmLogins, 'npm logins', 'npm') + tile(s.npmLoginFailed, 'Failed npm logins', 'npm', true) +
      tile(s.logins, 'Sign-ins', 'signin') + tile(s.activeUsers, 'Active users', ''));
  }

  // ── npm publishes: one row per version ──
  function renderReleases(d) {
    var list = d.releases || [];
    $('#alReleaseCount').text(list.length ? '· ' + list.length : '');
    if (!list.length) {
      $('#alReleases').html('<div class="al-empty">No npm publish recorded in this period. Publishes are recorded from now on: version, admin, npm user and machine.</div>');
      return;
    }
    $('#alReleases').html('<table class="al-table"><thead><tr><th>Time</th><th>Version</th><th>Branch</th><th>Icons</th><th>Pushed by</th><th>npm user</th><th>Machine</th><th>Result</th></tr></thead><tbody>' +
      list.map(function (r) {
        var icons = r.icons || [], by = r.by || [];
        return '<tr><td>' + when(r.at) + '</td>' +
          '<td><span class="al-version">' + esc(r.version || '—') + '</span>' + (r.tag ? ' <span class="al-tag">' + esc(r.tag) + '</span>' : '') +
            (r.pkg ? '<div class="al-email">' + esc(r.pkg) + '</div>' : '') + '</td>' +
          '<td>' + esc(r.branch || '—') + '</td>' +
          '<td>' + (icons.length ? '<span title="' + esc(icons.join(', ')) + '">' + esc(icons.slice(0, 3).join(', ')) + (icons.length > 3 ? ' +' + (icons.length - 3) : '') + '</span>' : '<span class="al-muted">—</span>') + '</td>' +
          '<td>' + (by.length ? by.map(function (b) { return person(b.name, b.email); }).join('') : '<span class="al-muted" title="No pushed request matched this publish">—</span>') + '</td>' +
          '<td>' + (r.npmUser ? '<span class="al-mono">' + esc(r.npmUser) + '</span>' : '<span class="al-muted">—</span>') + '</td>' +
          '<td>' + esc(r.machine || '—') + '</td>' +
          '<td>' + result(r.ok, 'Published', 'Failed') + (r.ok ? '' : '<div class="al-err-text" title="' + esc(r.error) + '">' + esc(r.error) + '</div>') + '</td></tr>';
      }).join('') + '</tbody></table>');
  }

  // ── one feed, filtered in the page ──
  function feedRows() {
    var q = view.q.toLowerCase();
    return (data.feed || []).filter(function (f) {
      if (view.cat !== 'all' && f.cat !== view.cat) return false;
      if (view.user && f.who !== view.user) return false;
      if (!q) return true;
      var m = f.meta || {};
      return [f.label, f.who, f.name, f.text, m.icon, m.version, m.npmUser, m.machine, m.agent, m.ip, m.branch, m.actor].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function details(f) {
    var m = f.meta || {}, bits = [];
    if (f.text) bits.push(esc(f.text));
    if (m.npmUser) bits.push('npm user <span class="al-mono">' + esc(m.npmUser) + '</span>');
    if (m.machine) bits.push('machine ' + esc(m.machine));
    if (m.agent) bits.push(esc(m.agent));
    if (m.ip) bits.push('<span class="al-muted">' + esc(m.ip) + '</span>');
    return bits.join(' · ') || '<span class="al-muted">—</span>';
  }
  function renderFeed() {
    var rows = feedRows(), total = data.feedTotal || 0, loaded = (data.feed || []).length;
    $('#alFeedCount').text('· ' + rows.length + (rows.length !== loaded ? ' of ' + loaded : '') + (total > loaded ? ' (latest ' + loaded + ' of ' + total + ' loaded)' : ''));
    $('#alChips').html(CATS.map(function (c) {
      var n = c[0] === 'all' ? loaded : (data.feed || []).filter(function (f) { return f.cat === c[0]; }).length;
      return '<button type="button" role="tab" class="al-chip' + (view.cat === c[0] ? ' active' : '') + '" aria-selected="' + (view.cat === c[0]) + '" data-al-cat="' + c[0] + '">' + esc(c[1]) + ' <span>' + n + '</span></button>';
    }).join(''));
    if (!rows.length) { $('#alFeed').html('<div class="al-empty">Nothing matches these filters in this period.</div>'); return; }
    $('#alFeed').html('<table class="al-table al-feed"><thead><tr><th>Time</th><th>Type</th><th>User</th><th>What</th><th>Details</th></tr></thead><tbody>' +
      rows.slice(0, view.shown).map(function (f) {
        var m = f.meta || {};
        return '<tr' + (f.ok === false ? ' class="al-row-bad"' : '') + '><td>' + when(f.at) + '</td>' +
          '<td><span class="al-pill al-cat-' + esc(f.cat) + '">' + esc(CAT_LABEL[f.cat] || f.cat) + '</span></td>' +
          '<td>' + (f.who ? person(f.name, f.who) : '<span class="al-muted">' + esc(m.actor || 'system') + '</span>') + '</td>' +
          '<td><span class="al-what' + (f.ok === false ? ' al-what-bad' : '') + '">' + esc(f.label) + '</span>' +
            (m.icon ? '<div class="al-email">' + esc(m.icon) + (m.stage ? ' · ' + esc(m.stage) : '') + '</div>' : '') + '</td>' +
          '<td class="al-details">' + details(f) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (rows.length > view.shown ? '<button type="button" class="btn btn-ghost btn-sm al-more" id="alMore">Show ' + Math.min(150, rows.length - view.shown) + ' more</button>' : ''));
  }

  // ── per user ──
  function renderUsers(d) {
    var users = d.users || [];
    var cur = view.user;
    $('#alUser').html('<option value="">All users</option>' + users.map(function (u) {
      return '<option value="' + esc(u.email) + '"' + (u.email === cur ? ' selected' : '') + '>' + esc(u.name || u.email) + '</option>';
    }).join(''));
    if (!users.length) { $('#alUsers').html('<div class="al-empty">No user activity in this period yet.</div>'); return; }
    var n = function (v, bad) { return '<td class="al-num' + (bad && v ? ' al-num-bad' : '') + '">' + (v || 0) + '</td>'; };
    $('#alUsers').html('<table class="al-table"><thead><tr><th>User</th><th class="al-num">Sign-ins</th><th class="al-num">Requests</th><th class="al-num">Reviews</th><th class="al-num">Pushes</th>' +
      '<th class="al-num">Published</th><th class="al-num">Failed publish</th><th>npm user</th><th class="al-num">Failed npm logins</th><th>Last seen</th></tr></thead><tbody>' +
      users.map(function (u) {
        return '<tr class="al-user-row" data-al-user="' + esc(u.email) + '" title="Show only this user in the activity list"><td>' + person(u.name, u.email) + '</td>' +
          n(u.logins) + n(u.requests) + n(u.reviews) + n(u.pushes) + n(u.publishes) + n(u.publishFailed, true) +
          '<td>' + ((u.npmUsers || []).length ? '<span class="al-mono">' + esc(u.npmUsers.join(', ')) + '</span>' : '<span class="al-muted">—</span>') + '</td>' +
          n(u.npmLoginFailed, true) + '<td>' + when(u.lastSeen) + '</td></tr>';
      }).join('') + '</tbody></table>');
  }

  function render(d) {
    data = d;
    renderStats(d);
    $('#alBody').removeClass('hidden');
    renderReleases(d); renderUsers(d); renderFeed();
  }

  function load() {
    $('#alStats').html('<div class="al-muted">Loading…</div>'); $('#alBody').addClass('hidden');
    $.ajax({ url: url('activity-log?days=' + days), dataType: 'json', headers: headers(), timeout: 60000 })
      .done(render)
      .fail(function (xhr) {
        var msg = xhr.status === 403 ? 'Only admins can see the Activity Log.' : xhr.status === 401 ? 'Sign in to see the Activity Log.'
          : ((xhr.responseJSON && xhr.responseJSON.message) || 'Could not load the Activity Log.');
        $('#alStats').html('<div class="al-error">' + esc(msg) + '</div>');
      });
  }

  // Page switching (same pattern as saved-assets.js): reuse 'mostused' for the shared reset, then show ours.
  var origSwitch = SF.switchPage;
  SF.switchPage = function (page) {
    $('#wfActivityLogPage').addClass('hidden');
    $('#wfActivityLogBtn').removeClass('active');
    if (page !== PAGE) return origSwitch(page);
    if (SF.wf && SF.wf.role && SF.wf.role !== 'admin') return origSwitch('generator');
    origSwitch('mostused');
    $('#mostUsedPage').addClass('hidden');
    $('#mostUsedBtn').removeClass('active');
    SF.state.page = PAGE;
    try { localStorage.setItem('sf_active_page', PAGE); } catch (e) {}
    $('#wfActivityLogPage').removeClass('hidden');
    $('#wfActivityLogBtn').addClass('active');
    $('#pageTitle').text('Activity Log');
    $('#pageBreadcrumb').text('Admin');
    load();
  };

  $(function () {
    Promise.all(window._componentPromises || []).then(function () {
      $('.main').append(pageHtml());
      var btn = '<button class="sidebar-link hidden" data-page="' + PAGE + '" id="wfActivityLogBtn">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg><span>Activity Log</span></button>';
      if ($('#wfMembersBtn').length) $('#wfMembersBtn').after(btn); else $('#requestIconNavBtn').after(btn);
      $('#wfActivityLogBtn').toggleClass('hidden', !(SF.wf && SF.wf.role === 'admin'));
      $('#wfActivityLogBtn').on('click', function () { SF.switchPage(PAGE); });
      $(document).on('click', '#alRefresh', load);
      $(document).on('change', '#alRange', function () { days = parseInt($(this).val(), 10) || 0; load(); });
      // A total, a chip or a user row sets the filter of the activity list.
      $(document).on('click', '#wfActivityLogPage [data-al-cat]', function () {
        if (!data) return;
        view.cat = String($(this).data('al-cat')); view.shown = 150; renderFeed();
        if ($(this).hasClass('al-stat')) { var el = $('#alChips')[0]; if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      });
      $(document).on('change', '#alUser', function () { view.user = $(this).val() || ''; view.shown = 150; renderFeed(); });
      $(document).on('click', '#wfActivityLogPage .al-user-row', function () {
        view.user = String($(this).data('al-user')); view.cat = 'all'; view.shown = 150; $('#alUser').val(view.user); renderFeed();
        var el = $('#alChips')[0]; if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      $(document).on('input', '#alSearch', function () { view.q = $(this).val() || ''; view.shown = 150; renderFeed(); });
      $(document).on('click', '#alMore', function () { view.shown += 150; renderFeed(); });
      var last = null;
      try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
      if (last === PAGE) setTimeout(function () { SF.switchPage(PAGE); }, 0);
    });
  });
})(window.SpriteForge, jQuery);
