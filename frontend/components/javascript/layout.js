/**
 * SpriteForge - Layout Calculation
 * Positions icons within the sprite sheet.
 */
(function (SF) {
  'use strict';

  var state = SF.state;

  function rectOf(icon) {
    return { x: icon.spriteX, y: icon.spriteY, w: icon.width, h: icon.height };
  }

  /** a and b closer than the gaps (or overlapping)? */
  function collides(a, b, gapX, gapY) {
    return a.x < b.x + b.w + gapX && b.x < a.x + a.w + gapX &&
           a.y < b.y + b.h + gapY && b.y < a.y + a.h + gapY;
  }

  /**
   * Put new icons into an existing sprite without touching existing positions.
   * Starts right after the last existing icon (bottom-most row, right-most in it),
   * fills that line to the sprite width, then wraps to new lines. Every candidate
   * spot is checked against all existing viewBoxes and already placed icons, with
   * `spacing` / `rowGap` kept as gaps, so nothing overlaps even in irregular sprites.
   */
  function placeAfterExisting(existing, icons, maxWidth, s) {
    var gapX = s.spacing, gapY = s.rowGap, pad = s.padding;
    var rects = existing.map(rectOf);
    var maxRight = 0, maxBottom = 0;
    rects.forEach(function (r) { maxRight = Math.max(maxRight, r.x + r.w); maxBottom = Math.max(maxBottom, r.y + r.h); });
    var right = (maxWidth > 0 ? maxWidth : Math.max(maxRight + pad, 450)) - pad;

    // Anchor: the last existing icon = top-most y of the bottom-most row, right-most in that row.
    var anchor = rects.reduce(function (best, r) {
      if (!best) return r;
      if (r.y > best.y + 0.5) return r;
      if (Math.abs(r.y - best.y) <= 0.5 && r.x + r.w > best.x + best.w) return r;
      return best;
    }, null);

    var x = anchor ? anchor.x + anchor.w + gapX : pad;
    var y = anchor ? anchor.y : pad;
    var line = [];          // rects placed on the current line
    var inLine = 0;

    function hit(c) {
      for (var i = 0; i < rects.length; i++) if (collides(c, rects[i], gapX, gapY)) return rects[i];
      return null;
    }

    function nextLine() {
      // Below everything placed on this line and every existing icon that covers this line's top.
      var bottom = -Infinity;
      line.forEach(function (r) { bottom = Math.max(bottom, r.y + r.h); });
      rects.forEach(function (r) { if (r.y <= y + 0.5 && r.y + r.h > y) bottom = Math.max(bottom, r.y + r.h); });
      var ny = bottom === -Infinity ? y + 1 : bottom + gapY;
      y = Math.max(ny, y + 1);
      x = pad;
      line = [];
      inLine = 0;
    }

    icons.forEach(function (icon) {
      var w = icon.width, h = icon.height;
      for (var guard = 0; guard < 100000; guard++) {
        var rowFull = s.iconsPerRow > 0 && inLine >= s.iconsPerRow;
        // Wider than the free width: wrap (an icon wider than the whole sprite gets its own line).
        if (rowFull || (x + w > right && x > pad)) { nextLine(); continue; }
        var c = { x: x, y: y, w: w, h: h };
        var r = hit(c);
        if (r) { x = r.x + r.w + gapX; continue; }
        icon.spriteX = Math.round(x);
        icon.spriteY = Math.round(y);
        var placedRect = rectOf(icon);
        // Rounding can move it by < 1 px; re-check and nudge right if that created a touch.
        if (hit(placedRect)) { x += 1; continue; }
        rects.push(placedRect);
        line.push(placedRect);
        inLine++;
        x = placedRect.x + w + gapX;
        maxRight = Math.max(maxRight, placedRect.x + w);
        maxBottom = Math.max(maxBottom, placedRect.y + h);
        break;
      }
    });

    return { maxRight: maxRight, maxBottom: maxBottom };
  }

  /**
   * Place new icons after the last of `existing` without overlapping any of them.
   * existing / icons: [{ spriteX, spriteY, width, height }] (icons get spriteX/spriteY).
   * @returns {{maxRight:number, maxBottom:number}}
   */
  SF.placeNewIcons = function (existing, icons, maxWidth, settings) {
    var s = Object.assign({ spacing: 7, rowGap: 5, padding: 5, iconsPerRow: 0 }, settings || {});
    return placeAfterExisting(existing, icons, maxWidth, s);
  };

  /** Overlapping icon pairs in the current layout (for checks / debugging). */
  SF.findLayoutOverlaps = function () {
    var out = [];
    var list = state.icons;
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        if (list[i].isExisting && list[j].isExisting) continue; // existing sprite is kept as-is
        if (collides(rectOf(list[i]), rectOf(list[j]), 0, 0)) out.push([list[i].name, list[j].name]);
      }
    }
    return out;
  };

  /**
   * Calculate the position of each icon in the sprite
   * @returns {{width: number, height: number}} Total sprite dimensions
   */
  SF.calculateLayout = function () {
    var s = state.settings;

    // --- First pass: preserve positions for existing icons, track bounds ---
    var hasExisting = false;
    var maxExistingX = 0, maxExistingY = 0;

    // Per-row tracking: map of Y → { rightEdge, maxHeight }
    var existingRows = {};

    state.icons.forEach(function (icon) {
      if (icon.isExisting && icon.originalSpriteX !== undefined) {
        icon.spriteX = icon.originalSpriteX;
        icon.spriteY = icon.originalSpriteY;
        hasExisting = true;

        maxExistingX = Math.max(maxExistingX, icon.spriteX + icon.width);
        maxExistingY = Math.max(maxExistingY, icon.spriteY + icon.height);

        // Track per-row occupancy
        var rowKey = Math.round(icon.spriteY);
        if (!existingRows[rowKey]) {
          existingRows[rowKey] = { rightEdge: 0, maxHeight: 0 };
        }
        existingRows[rowKey].rightEdge = Math.max(
          existingRows[rowKey].rightEdge,
          icon.spriteX + icon.width
        );
        existingRows[rowKey].maxHeight = Math.max(
          existingRows[rowKey].maxHeight,
          icon.height
        );
      }
    });

    // --- Collect new icons and sort: group by dimensions (width×height) ---
    var newIcons = [];
    state.icons.forEach(function (icon, idx) {
      if (icon.isExisting && icon.originalSpriteX !== undefined) return;
      newIcons.push({ icon: icon, origIdx: idx });
    });

    // --- Determine maxWidth ---
    var maxWidth;
    if (state.originalSpriteWidth > 0) {
      // Update mode: respect the existing sprite's width
      maxWidth = state.originalSpriteWidth;
    } else if (s.maxSpriteWidth > 0) {
      // User explicitly set a max width
      maxWidth = s.maxSpriteWidth;
    } else if (newIcons.length > 1) {
      // Auto-calculate: create a balanced grid layout
      var totalIconWidth = 0;
      newIcons.forEach(function (entry) {
        totalIconWidth += entry.icon.width + s.spacing;
      });
      var cols = Math.ceil(Math.sqrt(newIcons.length));
      var avgWidth = totalIconWidth / newIcons.length;
      maxWidth = Math.max(Math.ceil(avgWidth * cols) + s.padding * 2, 450);
    } else {
      maxWidth = 0;
    }

    newIcons.sort(function (a, b) {
      // Primary: group by height (same-height icons row together neatly)
      if (a.icon.height !== b.icon.height) return a.icon.height - b.icon.height;
      // Secondary: group by width within same height
      if (a.icon.width !== b.icon.width) return a.icon.width - b.icon.width;
      // Tertiary: preserve original order
      return a.origIdx - b.origIdx;
    });

    // --- Find the best starting position ---
    // Try to fit on the last existing row if space allows
    // ── Existing sprite: place new icons after the last existing icon, never overlapping ──
    if (hasExisting && newIcons.length) {
      var placed = placeAfterExisting(state.icons.filter(function (icon) {
        return icon.isExisting && icon.originalSpriteX !== undefined;
      }), newIcons.map(function (e) { return e.icon; }), maxWidth, s);
      var W = Math.ceil(Math.max(placed.maxRight + s.padding, maxWidth || 0, 450, 1));
      var H = Math.ceil(Math.max(placed.maxBottom + s.padding, state.originalSpriteHeight || 0, 1));
      return { width: W, height: H };
    }

    var currentX, currentY, maxRowHeight;

    if (hasExisting) {
      // Find the last (bottommost) row
      var lastRowY = -1;
      Object.keys(existingRows).forEach(function (yStr) {
        var y = parseInt(yStr, 10);
        if (y > lastRowY) lastRowY = y;
      });

      var lastRow = existingRows[lastRowY];
      var spaceOnLastRow = maxWidth > 0
        ? (maxWidth - s.padding) - (lastRow.rightEdge + s.spacing)
        : Infinity;

      if (newIcons.length > 0 && spaceOnLastRow >= newIcons[0].icon.width) {
        // There's room on the last existing row — start there
        currentX = lastRow.rightEdge + s.spacing;
        currentY = lastRowY;
        maxRowHeight = lastRow.maxHeight;
      } else {
        // No room — start a new row below all existing content
        currentX = s.padding;
        currentY = maxExistingY + s.rowGap;
        maxRowHeight = 0;
      }
    } else {
      currentX = s.padding;
      currentY = s.padding;
      maxRowHeight = 0;
    }

    var maxX = maxExistingX;
    var newIconCount = 0;

    newIcons.forEach(function (entry) {
      var icon = entry.icon;

      // Wrap to next row if would exceed sprite width or row icon limit
      var wouldExceed = maxWidth > 0 && (currentX + icon.width) > (maxWidth - s.padding);
      var rowLimitReached = s.iconsPerRow > 0 && newIconCount > 0 && newIconCount % s.iconsPerRow === 0;

      if (wouldExceed || rowLimitReached) {
        currentX = s.padding;
        currentY += maxRowHeight + s.rowGap;
        maxRowHeight = 0;
      }

      icon.spriteX = currentX;
      icon.spriteY = currentY;

      currentX += icon.width + s.spacing;
      maxRowHeight = Math.max(maxRowHeight, icon.height);
      maxX = Math.max(maxX, icon.spriteX + icon.width);
      newIconCount++;
    });

    // --- Compute final dimensions ---
    var totalWidth = Math.ceil(Math.max(maxX + s.padding, 1));
    var totalHeight = Math.ceil(Math.max(currentY + maxRowHeight + s.padding, maxExistingY + s.padding, 1));

    // Preserve original sprite dimensions (only grow, never shrink)
    if (maxWidth > 0) totalWidth = Math.max(totalWidth, maxWidth);
    if (state.originalSpriteHeight > 0) totalHeight = Math.max(totalHeight, state.originalSpriteHeight);

    // Enforce minimum sprite width
    totalWidth = Math.max(totalWidth, 450);

    return { width: totalWidth, height: totalHeight };
  };

})(window.SpriteForge);
