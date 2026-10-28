/**
 * SpriteForge - compare icons across sprites by NAME and DRAWING
 *
 * SF.iconCompare.spriteIcons(text) → { "<symbol id>": "<drawing key>" } for every <symbol> of a sprite.
 * The drawing key is the markup the symbol shows (the <g> its <use> points at), with ids, classes,
 * url(#…) targets and whitespace taken out, so the same drawing matches wherever it sits in the sprite.
 *
 * SF.iconCompare.branchIndex([{sprite, text}]) → { byId, byKey, sprite (id → sprite key), realId (id as written) }
 * SF.iconCompare.match(id, key, branch) → 'same' (same name, same drawing) | 'alias' (same drawing under
 * another name, branch.byKey tells which) | 'changed' (same name, different drawing) | '' (not there).
 */
(function (root) {
  'use strict';

  function normId(id) { return String(id || '').toLowerCase().replace(/__s$/, ''); }

  function drawingKey(xml) {
    return String(xml || '')
      .replace(/\s(?:id|class|xmlns(?::[\w-]+)?)\s*=\s*("[^"]*"|'[^']*')/g, '')
      .replace(/url\(\s*['"]?#[^)'"]*['"]?\s*\)/g, 'url(#)')
      .replace(/\s(?:xlink:)?href\s*=\s*("#[^"]*"|'#[^']*')/g, '')
      .replace(/>\s+</g, '><')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // realIds (optional) collects normalized id → the id exactly as written in the sprite.
  function spriteIcons(text, realIds) {
    var out = {};
    if (!text) return out;
    var doc = new root.DOMParser().parseFromString(text, 'image/svg+xml');
    // One stray character makes the strict XML parse fail as a whole; the HTML parser reads the rest anyway.
    if (doc.getElementsByTagName('parsererror').length && root.document) doc = new root.DOMParser().parseFromString(text, 'text/html');
    var ser = new root.XMLSerializer();
    var byId = {};
    var all = doc.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) { var id = all[i].getAttribute && all[i].getAttribute('id'); if (id) byId[id] = all[i]; }
    var inner = function (el) {
      var s = '';
      for (var n = el.firstChild; n; n = n.nextSibling) s += ser.serializeToString(n);
      return s;
    };
    var symbols = doc.getElementsByTagName('symbol');
    for (var j = 0; j < symbols.length; j++) {
      var sym = symbols[j], sid = sym.getAttribute('id');
      if (!sid) continue;
      var use = sym.getElementsByTagName('use')[0];
      var href = use && (use.getAttribute('href') || use.getAttribute('xlink:href'));
      var target = href && href.charAt(0) === '#' ? byId[href.slice(1)] : null;
      out[normId(sid)] = drawingKey(target ? inner(target) : inner(sym));
      if (realIds) realIds[normId(sid)] = sid;
    }
    return out;
  }

  /** { byId: {id: key}, byKey: {key: id} } for one branch, from the texts of its sprites. */
  function branchIndex(texts) {
    var byId = {}, byKey = {}, sprite = {}, realId = {};
    (texts || []).forEach(function (t) {
      if (!t || !t.text) return;
      var icons = spriteIcons(t.text, realId);
      Object.keys(icons).forEach(function (id) {
        byId[id] = icons[id]; sprite[id] = t.sprite;
        if (icons[id] && !byKey[icons[id]]) byKey[icons[id]] = id;
      });
    });
    return { byId: byId, byKey: byKey, sprite: sprite, realId: realId };
  }

  function match(id, key, branch) {
    if (!branch) return '';
    id = normId(id);
    if (id in branch.byId) return !key || branch.byId[id] === key ? 'same' : (branch.byKey[key] ? 'alias' : 'changed');
    return key && branch.byKey[key] ? 'alias' : '';
  }

  /** Short stable fingerprint of a drawing key (two 32-bit FNV-1a hashes + length). */
  function fingerprint(key) {
    if (!key) return '';
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < key.length; i++) {
      var c = key.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822507) >>> 0;
    }
    return h1.toString(36) + h2.toString(36) + key.length.toString(36);
  }

  var api = { normId: normId, fingerprint: fingerprint, drawingKey: drawingKey, spriteIcons: spriteIcons, branchIndex: branchIndex, match: match };
  if (root.SpriteForge) root.SpriteForge.iconCompare = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
