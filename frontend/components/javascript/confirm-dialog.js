/**
 * SpriteForge - Confirm dialog
 * One in-app "Are you sure?" popup used before deleting anything (saved sprite folders, Library icons, saved
 * webfonts). Replaces the old "click Delete twice" toast confirmation.
 *
 *   SF.confirmDelete('crm-detailview-icons', { what: 'saved sprite folder' }).then(function (yes) { ... });
 *   SF.confirmDialog({ title, message, yesText, noText, danger }) → Promise<boolean>
 *
 * Yes / No buttons, Enter = Yes, Esc or clicking outside = No. The markup is created on first use.
 */
(function (SF, $) {
  'use strict';

  var ICON_TRASH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  var ICON_ASK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  var pending = null;   // { resolve } for the open dialog

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureModal() {
    var $m = $('#sfConfirmModal');
    if ($m.length) return $m;
    $m = $(
      '<div class="modal-overlay hidden sf-confirm" id="sfConfirmModal" role="alertdialog" aria-modal="true" aria-labelledby="sfConfirmTitle" aria-describedby="sfConfirmMsg">' +
        '<div class="modal-overlay-bg"></div>' +
        '<div class="modal sf-confirm-modal">' +
          '<div class="modal-header">' +
            '<h3><span class="sf-confirm-icon" id="sfConfirmIcon"></span><span id="sfConfirmTitle">Delete</span></h3>' +
            '<button type="button" class="modal-close" id="sfConfirmClose" aria-label="Close">&times;</button>' +
          '</div>' +
          '<div class="modal-body"><p class="sf-confirm-msg" id="sfConfirmMsg"></p></div>' +
          '<div class="modal-footer sf-confirm-footer">' +
            '<button type="button" class="btn btn-ghost" id="sfConfirmNo">No</button>' +
            '<button type="button" class="btn btn-primary" id="sfConfirmYes">Yes</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    $('body').append($m);
    return $m;
  }

  function close(answer) {
    var $m = $('#sfConfirmModal');
    $m.addClass('hidden');
    $(document).off('keydown.sfConfirm');
    var p = pending; pending = null;
    if (p) {
      p.resolve(!!answer);
      if (p.returnFocus && p.returnFocus.focus) { try { p.returnFocus.focus(); } catch (e) {} }
    }
  }

  /**
   * Generic yes/no dialog.
   * @param {{title?:string, message:string, html?:string, yesText?:string, noText?:string, danger?:boolean, icon?:string}} opts
   * @returns {Promise<boolean>} true when the user chose Yes
   */
  SF.confirmDialog = function (opts) {
    opts = opts || {};
    if (pending) close(false);   // a second dialog replaces the first (answered No)
    var $m = ensureModal();
    $('#sfConfirmTitle').text(opts.title || 'Are you sure?');
    $('#sfConfirmIcon').html(opts.icon || (opts.danger ? ICON_TRASH : ICON_ASK));
    if (opts.html) $('#sfConfirmMsg').html(opts.html); else $('#sfConfirmMsg').text(opts.message || '');
    $('#sfConfirmNo').text(opts.noText || 'No');
    $('#sfConfirmYes').text(opts.yesText || 'Yes').toggleClass('sf-confirm-danger', !!opts.danger);
    $m.toggleClass('sf-confirm--danger', !!opts.danger).removeClass('hidden');

    return new Promise(function (resolve) {
      pending = { resolve: resolve, returnFocus: document.activeElement };
      // Keyboard: Esc → No, Enter → Yes (unless focus is on the No button)
      $(document).on('keydown.sfConfirm', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          close(document.activeElement && document.activeElement.id === 'sfConfirmNo' ? false : true);
        }
      });
      setTimeout(function () { $('#sfConfirmNo').trigger('focus'); }, 30);
    });
  };

  /**
   * Delete confirmation: "Delete <what> "<label>"? ... Yes, delete / No".
   * @param {string} label   name shown to the user
   * @param {{what?:string, note?:string}} [opts]  what = 'saved sprite folder' | 'icon' | 'webfont' …; note = extra line
   * @returns {Promise<boolean>}
   */
  SF.confirmDelete = function (label, opts) {
    opts = opts || {};
    var what = opts.what || 'item';
    var html = 'Delete the ' + esc(what) + ' <strong>' + esc(label) + '</strong>?' +
      '<span class="sf-confirm-note">' + esc(opts.note || 'This cannot be undone.') + '</span>';
    return SF.confirmDialog({ title: 'Delete ' + what, html: html, yesText: 'Yes, delete', noText: 'No, keep it', danger: true });
  };

  $(document).on('click', '#sfConfirmYes', function () { close(true); });
  $(document).on('click', '#sfConfirmNo, #sfConfirmClose, #sfConfirmModal .modal-overlay-bg', function () { close(false); });
})(window.SpriteForge, jQuery);
