/**
 * SpriteForge - Activity Log (admins only)
 * Sign-in / sign-out counts per user and the latest events, from GET /api/activity-log.
 * The menu is shown only to admins (workflow.js toggles #wfActivityLogBtn with #wfMembersBtn); the API is admin-only too.
 */
(function (SF, $) {
  'use strict';

  var PAGE = 'adminlog';
  var days = 30;

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
    return '<span title="' + esc(d.toLocaleString()) + '">' + esc(d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) +
      ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) + '</span>';
  }
  function person(name, email) {
    return '<div class="al-person"><span class="al-name">' + esc(name || email) + '</span>' +
      (name ? '<span class="al-email">' + esc(email) + '</span>' : '') + '</div>';
  }

  function pageHtml() {
    return '<div class="content hidden" id="wfActivityLogPage"><div class="panel">' +
      '<div class="panel-header"><h3 class="panel-title">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>' +
        'Activity Log</h3>' +
        '<div class="panel-actions">' +
          '<select class="al-range" id="alRange" aria-label="Time range">' +
            '<option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="0">All time</option>' +
          '</select>' +
          '<button class="btn btn-ghost btn-sm" id="alRefresh" type="button">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh</button>' +
        '</div></div>' +
      '<div class="panel-body">' +
        '<div class="al-stats" id="alStats"></div>' +
        '<h4 class="al-heading">By user</h4><div class="al-table-wrap" id="alUsers"></div>' +
        '<h4 class="al-heading">Recent sign-ins and sign-outs</h4><div class="al-table-wrap" id="alEvents"></div>' +
      '</div></div></div>';
  }

  function render(d) {
    $('#alStats').html(
      '<div class="al-stat"><span>' + d.logins + '</span>Logins</div>' +
      '<div class="al-stat"><span>' + d.logouts + '</span>Logouts</div>' +
      '<div class="al-stat"><span>' + d.users.length + '</span>Users</div>');
    if (!d.users.length) {
      $('#alUsers').html('<div class="al-empty">No sign-ins recorded in this period yet.</div>');
      $('#alEvents').html('');
      return;
    }
    $('#alUsers').html('<table class="al-table"><thead><tr><th>User</th><th class="al-num">Logins</th><th class="al-num">Logouts</th><th>Last login</th><th>Last logout</th></tr></thead><tbody>' +
      d.users.map(function (u) {
        return '<tr><td>' + person(u.name, u.email) + '</td><td class="al-num">' + u.logins + '</td><td class="al-num">' + u.logouts + '</td>' +
          '<td>' + when(u.lastLogin) + '</td><td>' + when(u.lastLogout) + '</td></tr>';
      }).join('') + '</tbody></table>');
    $('#alEvents').html('<table class="al-table"><thead><tr><th>Time</th><th>User</th><th>Event</th><th>Device</th><th>IP</th></tr></thead><tbody>' +
      d.events.map(function (e) {
        return '<tr><td>' + when(e.at) + '</td><td>' + person(e.name, e.email) + '</td>' +
          '<td><span class="al-pill al-pill-' + e.type + '">' + (e.type === 'login' ? 'Login' : 'Logout') + '</span></td>' +
          '<td>' + esc(e.agent || '—') + '</td><td class="al-muted">' + esc(e.ip || '—') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (d.total > d.events.length ? '<div class="al-muted al-more">Showing the latest ' + d.events.length + ' of ' + d.total + ' events.</div>' : ''));
  }

  function load() {
    $('#alStats').html('<div class="al-muted">Loading…</div>'); $('#alUsers, #alEvents').html('');
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
      var last = null;
      try { last = localStorage.getItem('sf_active_page'); } catch (e) {}
      if (last === PAGE) setTimeout(function () { SF.switchPage(PAGE); }, 0);
    });
  });
})(window.SpriteForge, jQuery);
