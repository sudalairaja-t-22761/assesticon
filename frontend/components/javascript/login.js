/**
 * SpriteForge - Full-page sign-in (login.html)
 *
 * Standalone: no jQuery, no app bundle. Decides where the visitor goes:
 *   - a stored session that the server accepts  -> straight to the dashboard (index.html)
 *   - no session, or one the server rejects      -> show the "Sign in with Zoho" button
 * The OAuth redirect URI registered with Zoho is the site root, so the ?code= exchange
 * still happens in index.html (app.js _bootstrapAuth); this page only starts the flow.
 */
(function () {
  'use strict';

  var API_BASE = String(window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/').replace(/\/+$/, '');
  var AUTH_ENABLED = !!window.SF_AUTH_ENABLED;
  var STORAGE_KEY = window.SF_AUTH_STORAGE_KEY || 'sf_session_id';
  var DASHBOARD = 'index.html';

  var $ = function (id) { return document.getElementById(id); };
  var elNotice = $('loginNotice');
  var elChecking = $('loginChecking');
  var elActions = $('loginActions');
  var elBtn = $('loginBtn');
  var elBtnLabel = $('loginBtnLabel');

  // ---- theme (shared with the dashboard through the same localStorage key) ----
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var label = $('loginThemeLabel');
    if (label) label.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }
  (function restoreTheme() {
    var saved = null;
    try { saved = localStorage.getItem('spriteforge-theme'); } catch (e) {}
    applyTheme(saved === 'dark' ? 'dark' : 'light');
  }());
  var themeBtn = $('loginThemeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('spriteforge-theme', next); } catch (e) {}
    });
  }

  // ---- helpers ----
  function getSessionId() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }
  function clearSessionId() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
  function goToDashboard() {
    window.location.replace(DASHBOARD + (window.location.hash || ''));
  }
  function showNotice(kind, text) {
    if (!elNotice) return;
    if (!text) { elNotice.className = 'login-notice hidden'; elNotice.textContent = ''; return; }
    elNotice.className = 'login-notice is-' + kind;
    elNotice.textContent = text;
  }
  function showLoginForm() {
    if (elChecking) elChecking.classList.add('hidden');
    if (elActions) elActions.classList.remove('hidden');
    if (elBtn) { elBtn.disabled = false; elBtn.focus(); }
    if (elBtnLabel) elBtnLabel.textContent = 'Sign in with Zoho';
  }
  function setBusy(label) {
    if (elBtn) elBtn.disabled = true;
    if (elBtnLabel) elBtnLabel.textContent = label;
  }

  function apiFetch(path, options) {
    var url = API_BASE + '/' + String(path || '').replace(/^\/+/, '');
    var opts = options || {};
    opts.headers = opts.headers || {};
    var sessionId = getSessionId();
    if (sessionId) opts.headers['x-session-id'] = sessionId;
    return fetch(url, opts).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
        if (!response.ok) {
          var error = new Error((data && data.message) || ('Request failed with status ' + response.status));
          error.status = response.status;
          error.data = data;
          throw error;
        }
        return data;
      });
    });
  }

  // ---- message from the dashboard (?reason=expired|logout|failed&message=...) ----
  (function showReason() {
    var params = new URLSearchParams(window.location.search || '');
    var reason = params.get('reason');
    var detail = params.get('message');
    if (reason === 'expired')      showNotice('warning', 'Your session has expired. Sign in again to continue.');
    else if (reason === 'logout')  showNotice('success', 'You have been signed out.');
    else if (reason === 'failed')  showNotice('danger', 'Sign-in failed' + (detail ? ': ' + detail : '. Please try again.'));
    else if (reason === 'required') showNotice('info', 'Please sign in to use SpriteForge.');
    if (reason && window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname + (window.location.hash || ''));
    }
  }());

  // ---- start the Zoho OAuth flow ----
  function beginZohoLogin() {
    setBusy('Redirecting to Zoho…');
    showNotice('', '');
    var origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
    return apiFetch('api/auth/zoho/url?redirect_origin=' + encodeURIComponent(origin), { method: 'GET' })
      .then(function (data) {
        if (!data || !data.url) throw new Error('Could not compute the Zoho sign-in URL');
        window.location.href = data.url;
      })
      .catch(function (error) {
        showLoginForm();
        showNotice('danger', (error && error.message) || 'Could not start Zoho sign-in');
      });
  }
  if (elBtn) elBtn.addEventListener('click', beginZohoLogin);

  // ---- decide: dashboard or sign-in form ----
  if (!AUTH_ENABLED) { goToDashboard(); return; }

  // Landed here with an OAuth code (redirect URI pointed at this page): let the dashboard exchange it.
  if (new URLSearchParams(window.location.search || '').get('code')) {
    window.location.replace(DASHBOARD + window.location.search + (window.location.hash || ''));
    return;
  }

  if (!getSessionId()) { showLoginForm(); return; }

  var isAuthRejection = function (e) { return e && (e.status === 401 || e.status === 403); };
  var validate = function () { return apiFetch('api/auth/session', { method: 'GET' }); };

  // Retry once on transient failures (cold start, network blip) so a refresh does not sign the user out.
  validate()
    .catch(function (e) {
      if (isAuthRejection(e)) throw e;
      return new Promise(function (r) { setTimeout(r, 1200); }).then(validate);
    })
    .then(function () { goToDashboard(); })
    .catch(function (e) {
      if (isAuthRejection(e)) {
        clearSessionId();
        showLoginForm();
        showNotice('warning', 'Your session has expired. Sign in again to continue.');
      } else {
        // Server unreachable: the dashboard keeps the stored session in that case, so go there.
        goToDashboard();
      }
    });
}());
