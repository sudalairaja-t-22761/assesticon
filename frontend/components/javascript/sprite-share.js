/**
 * Saved sprite sharing: Private · All users · Specific users.
 *
 * One picker, used in two places:
 *   - the Save dialog (#fnameShareGroup), read with SF.spriteShare.read()
 *   - the Share button on a saved folder, which opens SF.spriteShare.open(folder)
 * The people list comes from GET api/share-users (everyone who has signed in, plus members added by email).
 * A value is { shared: true } (all users), { shared: false, sharedWith: [emails] } (specific users) or
 * { shared: false, sharedWith: [] } (private) — the same body /api/save-sprite and /api/saved-sprite/:id/share take.
 */
(function (SF, $) {
  'use strict';

  var API = window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/';
  var MAX_LIST = 60;
  var users = null, loading = null, seq = 0;

  function url(p) { return String(API).replace(/\/+$/, '') + '/' + p; }
  function headers() { return typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {}; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var isEmail = function (s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); };

  function loadUsers() {
    if (users) return $.Deferred().resolve(users).promise();
    if (loading) return loading;
    loading = $.ajax({ url: url('api/share-users'), type: 'GET', headers: headers(), dataType: 'json' })
      .then(function (res) { users = (res && res.users) || []; return users; },
        function () { loading = null; return $.Deferred().resolve([]).promise(); });
    return loading;
  }
  function nameOf(email) {
    var u = (users || []).filter(function (x) { return x.email === email; })[0];
    return u ? u.name : email;
  }

  // Value → mode
  function modeOf(v) {
    if (!v) return 'private';
    if (v.shared) return 'all';
    return v.sharedWith && v.sharedWith.length ? 'users' : 'private';
  }

  /** Picker markup. Mount it with SF.spriteShare.mount($root, value). */
  function html() {
    var name = 'sshMode' + (++seq);
    var opt = function (value, title, hint) {
      return '<label class="ssh-mode"><input type="radio" name="' + name + '" value="' + value + '">' +
        '<span><b>' + title + '</b><small>' + hint + '</small></span></label>';
    };
    return '<div class="ssh">' +
      '<div class="ssh-modes" role="radiogroup" aria-label="Who can see this folder">' +
        opt('private', 'Private', 'Only you and admins') +
        opt('all', 'All users', 'Everyone who signs in') +
        opt('users', 'Specific users', 'Only the people you pick') +
      '</div>' +
      '<div class="ssh-users hidden">' +
        '<div class="ssh-chips"></div>' +
        '<input type="text" class="form-input ssh-search" placeholder="Search people by name or email" autocomplete="off" spellcheck="false">' +
        '<div class="ssh-list" role="listbox"></div>' +
      '</div>' +
    '</div>';
  }

  function renderChips($root) {
    var sel = $root.data('sshSel') || [];
    $root.find('.ssh-chips').html(sel.length ? sel.map(function (e) {
      return '<span class="ssh-chip" title="' + esc(e) + '">' + esc(nameOf(e)) +
        '<button type="button" class="ssh-chip-x" data-ssh-remove="' + esc(e) + '" aria-label="Remove ' + esc(nameOf(e)) + '">&times;</button></span>';
    }).join('') : '<span class="ssh-empty">No one picked yet</span>');
  }

  function renderList($root) {
    var sel = $root.data('sshSel') || [];
    var q = String($root.find('.ssh-search').val() || '').trim().toLowerCase();
    var $list = $root.find('.ssh-list');
    if (!users) { $list.html('<div class="ssh-note">Loading people…</div>'); return; }
    var hits = users.filter(function (u) { return !q || u.name.toLowerCase().indexOf(q) >= 0 || u.email.indexOf(q) >= 0; });
    var rows = hits.slice(0, MAX_LIST).map(function (u) {
      var on = sel.indexOf(u.email) >= 0;
      return '<label class="ssh-row' + (on ? ' is-on' : '') + '"><input type="checkbox" data-ssh-user="' + esc(u.email) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="ssh-row-name">' + esc(u.name) + '</span><span class="ssh-row-mail">' + esc(u.email) + '</span></label>';
    });
    // Someone who has never signed in can still be added by their full email.
    if (q && isEmail(q) && !users.some(function (u) { return u.email === q; }) && sel.indexOf(q) < 0) {
      rows.unshift('<button type="button" class="ssh-row ssh-add" data-ssh-add="' + esc(q) + '">+ Add <b>' + esc(q) + '</b></button>');
    }
    if (hits.length > MAX_LIST) rows.push('<div class="ssh-note">' + (hits.length - MAX_LIST) + ' more — type to narrow the list</div>');
    $list.html(rows.length ? rows.join('') : '<div class="ssh-note">' + (q ? 'No one matches “' + esc(q) + '”. Type a full email to add someone.' : 'No other users yet.') + '</div>');
  }

  function setMode($root, mode) {
    $root.find('input[type=radio][value="' + mode + '"]').prop('checked', true);
    $root.find('.ssh-mode').each(function () { $(this).toggleClass('is-on', $(this).find('input').is(':checked')); });
    $root.find('.ssh-users').toggleClass('hidden', mode !== 'users');
    if (mode === 'users') loadUsers().then(function () { renderChips($root); renderList($root); });
  }

  /** Put a picker into $root (replacing what is there) and set its value. */
  function mount($root, value) {
    $root.html(html());
    var sel = (value && value.sharedWith ? value.sharedWith : []).map(function (e) { return String(e).toLowerCase(); });
    $root.data('sshSel', sel);
    renderChips($root);
    setMode($root, modeOf(value));
  }

  /** The value of the picker inside $root. */
  function read($root) {
    var mode = $root.find('input[type=radio]:checked').val() || 'private';
    if (mode === 'all') return { shared: true };
    return { shared: false, sharedWith: mode === 'users' ? ($root.data('sshSel') || []).slice() : [] };
  }

  /** Words for a value, e.g. "shared with all users" / "shared with 3 people" / "private". */
  function describe(v) {
    var mode = modeOf(v);
    if (mode === 'all') return 'shared with all users';
    if (mode === 'users') return 'shared with ' + (v.sharedWith.length === 1 ? nameOf(v.sharedWith[0]) : v.sharedWith.length + ' people');
    return 'private';
  }

  $(document).on('change', '.ssh input[type=radio]', function () { setMode($(this).closest('.ssh').parent(), this.value); });
  $(document).on('input', '.ssh-search', function () { renderList($(this).closest('.ssh').parent()); });
  $(document).on('keydown', '.ssh-search', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // never submits the surrounding dialog
    var $add = $(this).closest('.ssh').find('[data-ssh-add]').first();
    if ($add.length) $add.trigger('click');
  });
  $(document).on('change', '.ssh [data-ssh-user]', function () {
    var $root = $(this).closest('.ssh').parent(), sel = ($root.data('sshSel') || []).slice(), email = String($(this).data('sshUser'));
    var at = sel.indexOf(email);
    if (this.checked && at < 0) sel.push(email);
    if (!this.checked && at >= 0) sel.splice(at, 1);
    $root.data('sshSel', sel);
    $(this).closest('.ssh-row').toggleClass('is-on', this.checked);
    renderChips($root);
  });
  $(document).on('click', '.ssh [data-ssh-add]', function () {
    var $root = $(this).closest('.ssh').parent(), sel = ($root.data('sshSel') || []).slice(), email = String($(this).data('sshAdd'));
    if (sel.indexOf(email) < 0) sel.push(email);
    $root.data('sshSel', sel);
    $root.find('.ssh-search').val('');
    renderChips($root); renderList($root);
  });
  $(document).on('click', '.ssh [data-ssh-remove]', function () {
    var $root = $(this).closest('.ssh').parent(), email = String($(this).data('sshRemove'));
    $root.data('sshSel', ($root.data('sshSel') || []).filter(function (e) { return e !== email; }));
    renderChips($root); renderList($root);
  });

  // ── Share dialog for a saved folder ─────────────────────────────────────────
  function ensureModal() {
    if ($('#sshModal').length) return;
    $('body').append(
      '<div class="modal-overlay hidden" id="sshModal">' +
        '<div class="modal-overlay-bg" data-ssh-close></div>' +
        '<div class="modal modal-sm ssh-modal" role="dialog" aria-modal="true" aria-labelledby="sshTitle">' +
          '<div class="modal-header"><h3 id="sshTitle">Share sprite</h3><button class="modal-close" type="button" data-ssh-close aria-label="Close">&times;</button></div>' +
          '<div class="modal-body"><p class="ssh-folder" id="sshFolder"></p><div id="sshPicker"></div></div>' +
          '<div class="modal-footer"><button class="btn btn-ghost" type="button" data-ssh-close>Cancel</button>' +
            '<button class="btn btn-primary" type="button" id="sshSave">Save sharing</button></div>' +
        '</div>' +
      '</div>');
  }
  function close() { $('#sshModal').addClass('hidden').removeData('folder'); }

  /** Open the Share dialog for a saved folder ({ id, name, shared, sharedWith }). onDone() runs after a save. */
  function open(folder, onDone) {
    ensureModal();
    $('#sshFolder').html('Who can see <b>' + esc(folder.name || folder.id) + '</b> in Saved Sprites?');
    mount($('#sshPicker'), { shared: !!folder.shared, sharedWith: folder.sharedWith || [] });
    $('#sshSave').prop('disabled', false).text('Save sharing');
    $('#sshModal').data('folder', folder).data('done', onDone || null).removeClass('hidden');
  }

  $(document).on('click', '#sshModal [data-ssh-close]', close);
  $(document).on('keydown', function (e) { if (e.key === 'Escape' && !$('#sshModal').hasClass('hidden')) close(); });
  $(document).on('click', '#sshSave', function () {
    var $m = $('#sshModal'), folder = $m.data('folder'), onDone = $m.data('done');
    if (!folder) return;
    var value = read($('#sshPicker'));
    if (!value.shared && $('#sshPicker input[value=users]').is(':checked') && !value.sharedWith.length) {
      SF.showToast('Pick at least one person, or choose Private');
      return;
    }
    var $btn = $(this).prop('disabled', true).text('Saving…');
    $.ajax({
      url: url('api/saved-sprite/' + encodeURIComponent(folder.id) + '/share'),
      type: 'POST', headers: headers(), contentType: 'application/json', dataType: 'json',
      data: JSON.stringify(value)
    }).then(function (res) {
      if (!res || res.success === false) throw { responseJSON: res };
      close();
      SF.showToast((folder.name || 'Folder') + ' is ' + describe({ shared: res.shared, sharedWith: res.sharedWith || [] }));
      if (typeof onDone === 'function') onDone(res);
    }).fail(function (xhr) {
      $btn.prop('disabled', false).text('Save sharing');
      if (xhr && xhr.status === 401) { SF.showToast('Session expired. Sign in and try again.'); return; }
      SF.showToast((xhr && xhr.responseJSON && xhr.responseJSON.message) || 'Could not change sharing');
    });
  });

  SF.spriteShare = { html: html, mount: mount, read: read, describe: describe, open: open, loadUsers: loadUsers, nameOf: nameOf };
})(window.SpriteForge, jQuery);
