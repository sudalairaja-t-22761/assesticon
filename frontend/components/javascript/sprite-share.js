/**
 * Saved sprite sharing: Private · All users · Specific users.
 *
 * One picker, used in two places:
 *   - the Save dialog (#fnameShareGroup), read with SF.spriteShare.read()
 *   - the Share button on a saved folder, which opens SF.spriteShare.open(folder)
 * People are found with GET api/share-users?q= — the same Zoho org search (People + Cliq) as the Members dialog.
 * A value is { shared: true } (all users), { shared: false, sharedWith: [emails] } (specific users) or
 * { shared: false, sharedWith: [] } (private) — the same body /api/save-sprite and /api/saved-sprite/:id/share take.
 */
(function (SF, $) {
  'use strict';

  var API = window.SF_CATALYST_API_BASE || '/server/spriteForgeJoin/';
  var known = {};          // email → { name, avatar, about } from search results, so picked people keep their name and photo
  var seq = 0, timer = null, ask = 0;

  function url(p) { return String(API).replace(/\/+$/, '') + '/' + p; }
  function headers() { return typeof SF.masterLibraryAuthHeaders === 'function' ? SF.masterLibraryAuthHeaders() : {}; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var isEmail = function (s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); };

  function nameOf(email) { return known[email] ? known[email].name : email; }
  function initials(name) {
    var p = String(name || '?').trim().split(/[\s.@_-]+/).filter(Boolean);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[1][0] : '')).toUpperCase();
  }
  // Same avatar as the Members page: the photo (People photos load through the server), initials underneath.
  function avatarHtml(email) {
    var u = known[email] || {}, src = String(u.avatar || '');
    if (src.indexOf('proxy:') === 0) {
      src = url('api/org-users/photo?u=' + encodeURIComponent(src.slice(6)) + '&session_id=' + encodeURIComponent(headers()['x-session-id'] || ''));
    } else if (!/^https?:\/\//i.test(src)) src = '';
    return '<span class="vf-avatar">' + esc(initials(u.name || email)) +
      (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + '</span>';
  }
  function personHtml(email, extra) {
    var u = known[email] || {};
    return avatarHtml(email) + '<div class="ssh-person"><b>' + esc(u.name || email) + '</b><span>' + esc(email) +
      (u.about ? ' · ' + esc(u.about) : '') + '</span></div>' + (extra || '');
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
        '<div class="ssh-search-wrap">' +
          '<input type="search" class="ssh-search" placeholder="Enter name or email address" autocomplete="off" spellcheck="false">' +
          '<div class="ssh-results hidden" role="listbox"></div>' +
        '</div>' +
        '<div class="ssh-picked-head">People with access <span class="ssh-count"></span></div>' +
        '<div class="ssh-picked"></div>' +
      '</div>' +
    '</div>';
  }

  function renderPicked($root) {
    var sel = $root.data('sshSel') || [];
    $root.find('.ssh-count').text(sel.length ? '(' + sel.length + ')' : '');
    $root.find('.ssh-picked').html(sel.length ? sel.map(function (e) {
      return '<div class="ssh-picked-row">' + personHtml(e,
        '<button type="button" class="ssh-remove" data-ssh-remove="' + esc(e) + '" title="Remove ' + esc(nameOf(e)) + '" aria-label="Remove ' + esc(nameOf(e)) + '">&times;</button>') + '</div>';
    }).join('') : '<div class="ssh-note">No one picked yet — search above and click a person to add them.</div>');
  }

  // Zoho org search (People + Cliq, the same one the Members dialog uses); runs once 2+ letters are typed.
  function search($root) {
    var q = String($root.find('.ssh-search').val() || '').trim();
    var $box = $root.find('.ssh-results');
    if (q.length < 2) { $box.removeClass('hidden').html('<div class="ssh-note">Type at least 2 letters of a name or email to search Zoho employees</div>'); return; }
    var mine = ++ask, sel = $root.data('sshSel') || [];
    $box.removeClass('hidden').html('<div class="ssh-note">Searching Zoho users…</div>');
    $.ajax({ url: url('api/share-users?q=' + encodeURIComponent(q)), type: 'GET', headers: headers(), dataType: 'json' }).then(function (r) {
      if (mine !== ask) return; // a newer search is on its way
      var list = (r && r.users) || [];
      list.forEach(function (u) { known[u.email] = { name: u.name, avatar: u.avatar, about: [u.designation, u.department].filter(Boolean).join(', ') }; });
      var rows = list.map(function (u) {
        var on = sel.indexOf(u.email) >= 0;
        return '<div class="ssh-result' + (on ? ' is-on' : '') + '" data-ssh-add="' + esc(u.email) + '">' + personHtml(u.email, on ? '<em>Added</em>' : '') + '</div>';
      });
      var low = q.toLowerCase();
      if (isEmail(low) && !list.some(function (u) { return u.email === low; })) {
        rows.push('<div class="ssh-result" data-ssh-add="' + esc(low) + '">' + avatarHtml(low) +
          '<div class="ssh-person"><b>Add “' + esc(low) + '”</b><span>Use this email even if it is not in the list</span></div></div>');
      }
      $box.html((r && r.warning ? '<div class="ssh-note">' + esc(r.warning) + '</div>' : '') +
        (rows.length ? rows.join('') : '<div class="ssh-note ssh-notfound">User not found for “' + esc(q) + '”</div>'));
    }, function (xhr) {
      if (mine !== ask) return;
      var msg = (xhr && xhr.responseJSON && xhr.responseJSON.message) || (xhr && xhr.status === 401 ? 'Session expired. Sign in again.' : 'Could not search users');
      $box.html('<div class="ssh-note ssh-notfound">' + esc(msg) + '</div>');
    });
  }

  function setMode($root, mode) {
    $root.find('input[type=radio][value="' + mode + '"]').prop('checked', true);
    $root.find('.ssh-mode').each(function () { $(this).toggleClass('is-on', $(this).find('input').is(':checked')); });
    $root.find('.ssh-users').toggleClass('hidden', mode !== 'users');
    if (mode === 'users') renderPicked($root);
  }

  /** Put a picker into $root (replacing what is there) and set its value. */
  function mount($root, value) {
    $root.html(html());
    var sel = (value && value.sharedWith ? value.sharedWith : []).map(function (e) { return String(e).toLowerCase(); });
    $root.data('sshSel', sel);
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

  var rootOf = function (el) { return $(el).closest('.ssh').parent(); };
  $(document).on('change', '.ssh input[type=radio]', function () { setMode(rootOf(this), this.value); });
  $(document).on('input focus', '.ssh-search', function () {
    var $root = rootOf(this);
    clearTimeout(timer); timer = setTimeout(function () { search($root); }, 400);
  });
  $(document).on('keydown', '.ssh-search', function (e) {
    if (e.key === 'Escape') { $(this).siblings('.ssh-results').addClass('hidden'); e.stopImmediatePropagation(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault(); // never submits the surrounding dialog
    var $first = $(this).siblings('.ssh-results').find('[data-ssh-add]').not('.is-on').first();
    if ($first.length) $first.trigger('click');
  });
  $(document).on('click', '.ssh [data-ssh-add]', function () {
    var $root = rootOf(this), sel = ($root.data('sshSel') || []).slice(), email = String($(this).data('sshAdd'));
    if (sel.indexOf(email) < 0) sel.push(email);
    $root.data('sshSel', sel);
    $root.find('.ssh-search').val('');
    $root.find('.ssh-results').addClass('hidden').empty();
    renderPicked($root);
  });
  $(document).on('click', '.ssh [data-ssh-remove]', function () {
    var $root = rootOf(this), email = String($(this).data('sshRemove'));
    $root.data('sshSel', ($root.data('sshSel') || []).filter(function (e) { return e !== email; }));
    renderPicked($root);
  });
  $(document).on('click', function (e) { if (!$(e.target).closest('.ssh-search-wrap').length) $('.ssh-results').addClass('hidden'); });

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

  SF.spriteShare = { html: html, mount: mount, read: read, describe: describe, open: open, nameOf: nameOf };
})(window.SpriteForge, jQuery);
