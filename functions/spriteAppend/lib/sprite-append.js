"use strict";

/**
 * Append individual SVG icons to an existing sprite (Iconassest/Sprite/crmutil_icons.svg).
 *
 * Server-side port of the Library page's `SF.addIconsToSpriteText` (frontend/components/javascript/
 * repo-library-icons.js + layout.js + svg-parser.js), so a plain HTTP call does the same thing the
 * "Add icon" button does — without the browser.
 *
 * Guarantees:
 *   - the existing sprite TEXT is kept exactly as it is: no symbol is renamed, re-ordered or re-written;
 *   - every new icon is placed after the last existing icon and every candidate spot is checked against
 *     all existing viewBoxes (and the icons placed before it) so nothing overlaps;
 *   - the new <g> groups go right before the first <symbol>, the new <symbol>s right before </svg>
 *     (= the bottom of the sprite); the root width/height/viewBox grow only when the new icons run past
 *     the current bottom/right edge;
 *   - an icon whose symbol id already exists is skipped (never overwritten);
 *   - ids / classes inside a new icon get a unique prefix so they cannot clash with the sprite's.
 *
 * Sprite format produced (same as the sprite's own entries):
 *   <g id="<camelName>ZCI" transform="translate(x,y)"> …icon content… </g>
 *   <symbol viewBox="x y w h" id="zcicn-<name>"><use href="#<camelName>ZCI"></use></symbol>
 */

const cheerio = require("cheerio");

const DEFAULT_LAYOUT = { spacing: 7, rowGap: 5, padding: 5, iconsPerRow: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers (ported 1:1 from the frontend)
// ─────────────────────────────────────────────────────────────────────────────

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function escapeAttr(str) {
    return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function camel(name) {
    return String(name).replace(/[-_\s.]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ""));
}

/** Remove redundant xmlns attributes and empty <g> tags from serialized SVG inner content. */
function cleanSvgContent(html) {
    // the svg / xlink namespace declarations (…w3.org/2000/svg, …w3.org/1999/xlink) are implied inside the sprite
    let cleaned = String(html || "")
        .replace(/ xmlns="[^"]*w3\.org\/2000\/svg"/g, "")
        .replace(/ xmlns:xlink="[^"]*w3\.org\/1999\/xlink"/g, "");
    let prev;
    do {
        prev = cleaned;
        cleaned = cleaned.replace(/<g[^>]*>\s*<\/g>/g, "");
    } while (cleaned !== prev);
    return cleaned;
}

/** 'fill' | 'stroke' | 'none' — how the icon is coloured. */
function detectColorMode(innerContent, rootFill, rootStroke) {
    const isFillNone = rootFill && rootFill.toLowerCase() === "none";
    if (isFillNone) return "stroke";
    if (rootStroke && !rootFill) return "stroke";
    if (rootFill && !rootStroke) return "fill";
    if (rootFill && rootStroke) return "fill";
    const stripped = String(innerContent).replace(/<(rect|svg)\b[^>]*>/gi, "");
    const hasStroke = /stroke\s*[=:]/i.test(stripped);
    const hasFillNone = /fill\s*=\s*["']none["']/i.test(stripped);
    const hasFill = /fill\s*=\s*["'](?!none["'])[^"']+["']/i.test(stripped);
    if (hasFillNone && hasStroke) return "stroke";
    if (hasStroke && !hasFill) return "stroke";
    if (hasFill) return "fill";
    return "none";
}

/** For stroke icons: fill="none" on every visual child that has no fill of its own. */
function pushFillNoneToChildren(content) {
    const re = /(<(?:path|circle|ellipse|rect|line|polyline|polygon|text|use)\b)([^>]*?)(\/?>)/gi;
    return String(content).replace(re, (m, open, attrs, close) => (/\bfill\s*=/i.test(attrs) ? m : open + ' fill="none"' + attrs + close));
}

/** CSS without selectors that reach outside one icon (:root, html, body, *, bare svg). */
const GLOBAL_SEL = /^(?::root|html|body|\*|svg)(?![\w-])/i;
function stripGlobalCss(css) {
    return String(css || "").replace(/([^{}]+)\{([^{}]*)\}/g, (all, sel, body) => {
        if (/^\s*@/.test(sel)) return all;
        const keep = sel.split(",").filter((x) => x.trim() && !GLOBAL_SEL.test(x.trim()));
        return keep.length ? keep.join(",") + "{" + body + "}" : "";
    });
}

/** Give a new icon's own classes / ids a unique prefix so they cannot clash with the sprite's. */
function isolate(icon, token) {
    let style = stripGlobalCss(icon.styleContent || "");
    const defs = icon.defsContent || "";
    const content = icon.svgContent || "";
    const classMap = {}, idMap = {};
    let m;
    const selRe = /([^{}]+)\{/g;
    const noComments = style.replace(/\/\*[\s\S]*?\*\//g, "");
    while ((m = selRe.exec(noComments)) !== null) {
        const cRe = /\.(-?[_a-zA-Z][\w-]*)/g;
        let c;
        while ((c = cRe.exec(m[1])) !== null) classMap[c[1]] = token + c[1];
    }
    const idRe = /\bid\s*=\s*["']([^"']+)["']/g;
    while ((m = idRe.exec(defs + content)) !== null) idMap[m[1]] = token + m[1];
    const ids = (t) => {
        for (const id of Object.keys(idMap)) {
            const e = escRe(id);
            t = t.replace(new RegExp("\\bid\\s*=\\s*([\"'])" + e + "\\1", "g"), 'id="' + idMap[id] + '"')
                 .replace(new RegExp("url\\(\\s*#" + e + "\\s*\\)", "g"), "url(#" + idMap[id] + ")")
                 .replace(new RegExp("((?:xlink:)?href\\s*=\\s*[\"'])#" + e + "([\"'])", "g"), "$1#" + idMap[id] + "$2");
        }
        return t;
    };
    const classes = (t) => t.replace(/\bclass\s*=\s*(["'])([^"']*)\1/g, (all, q, list) =>
        "class=" + q + list.split(/\s+/).map((k) => classMap[k] || k).join(" ") + q);
    for (const k of Object.keys(classMap)) {
        style = style.replace(new RegExp("\\." + escRe(k) + "(?![\\w-])", "g"), "." + classMap[k]);
    }
    icon.styleContent = ids(style);
    icon.defsContent = ids(classes(defs));
    icon.svgContent = ids(classes(content));
}

// ─────────────────────────────────────────────────────────────────────────────
// Icon name → symbol id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The icon name is the file name without ".svg", kept as it is (case and - _ . are preserved); only
 * characters that are not valid in an XML id / CSS class (spaces, quotes, #, / …) become "_".
 */
function iconNameFromFile(fileName) {
    const base = String(fileName || "").split(/[\\/]/).pop().replace(/\.svg$/i, "").trim();
    // invalid runs at the ends are dropped, inside the name they become one "_"; everything else stays as typed
    return base.replace(/^[^A-Za-z0-9_.:-]+|[^A-Za-z0-9_.:-]+$/g, "").replace(/[^A-Za-z0-9_.:-]+/g, "_");
}

/** zcicn- + name, unless the name already carries the prefix. prefix "" → the bare name. */
function symbolIdFor(name, prefix) {
    const p = prefix == null ? "zcicn-" : String(prefix);
    if (!p) return name;
    return name.toLowerCase().startsWith(p.toLowerCase()) ? name : p + name;
}

/** The prefix most of the sprite's symbols use (zcicn- for crmutil_icons.svg). */
function detectPrefix(symbolIds, fallback) {
    const ids = symbolIds || [];
    if (!ids.length) return fallback;
    const n = ids.filter((i) => /^zcicn-/i.test(i)).length;
    return n * 2 >= ids.length ? "zcicn-" : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse one stand-alone SVG into an icon object
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(["title", "desc", "metadata"]);

/**
 * @param {string} text      SVG file content
 * @param {string} fileName  used for the icon name
 * @returns {object|null}    { name, svgContent, defsContent, styleContent, colorMode, rootFill, rootStroke,
 *                             originX, originY, width, height } or null when the file is not a usable SVG
 */
function parseIconSvg(text, fileName) {
    let $;
    try { $ = cheerio.load(String(text || ""), { xmlMode: true, decodeEntities: false }); }
    catch (_) { return null; }
    const svgEl = $("svg").first();
    if (!svgEl.length) return null;

    let vx = 0, vy = 0, vw = 24, vh = 24;
    const viewBox = svgEl.attr("viewBox");
    if (viewBox) {
        const parts = viewBox.trim().split(/[\s,]+/).map(Number);
        vx = isNaN(parts[0]) ? 0 : Math.round(parts[0]);
        vy = isNaN(parts[1]) ? 0 : Math.round(parts[1]);
        vw = isNaN(parts[2]) ? 24 : Math.ceil(parts[2]);
        vh = isNaN(parts[3]) ? 24 : Math.ceil(parts[3]);
    } else {
        const w = svgEl.attr("width"), h = svgEl.attr("height");
        if (w) vw = Math.ceil(parseFloat(w)) || 24;
        if (h) vh = Math.ceil(parseFloat(h)) || 24;
    }

    let inner = "", defs = "", style = "";
    svgEl.contents().each((_, node) => {
        if (node.type === "tag") {
            const tag = String(node.name || "").toLowerCase();
            if (SKIP_TAGS.has(tag)) return;
            if (tag === "defs") {
                $(node).contents().each((__, dc) => { if (dc.type === "tag") defs += $.xml(dc); });
                return;
            }
            if (tag === "style") { style += $(node).text() || ""; return; }
            inner += $.xml(node);
        } else if (node.type === "text") {
            const t = node.data || "";
            if (t.trim()) inner += t;
        }
    });
    inner = cleanSvgContent(inner);
    defs = cleanSvgContent(defs);
    if (!inner.trim()) return null;

    let rootFill = svgEl.attr("fill") || null;
    let rootStroke = svgEl.attr("stroke") || null;
    const rootStyle = svgEl.attr("style") || "";
    if (!rootFill) { const m = rootStyle.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/); if (m) rootFill = m[1].trim(); }
    if (!rootStroke) { const m = rootStyle.match(/(?:^|;)\s*stroke\s*:\s*([^;]+)/); if (m) rootStroke = m[1].trim(); }

    const colorMode = detectColorMode(inner, rootFill, rootStroke);
    if (colorMode === "stroke" && rootFill && rootFill.toLowerCase() === "none") inner = pushFillNoneToChildren(inner);
    if (rootFill && rootFill.toLowerCase() === "none") rootFill = null;

    return {
        name: iconNameFromFile(fileName),
        svgContent: inner,
        defsContent: defs,
        styleContent: style,
        colorMode,
        rootFill,
        rootStroke,
        originX: vx,
        originY: vy,
        width: vw,
        height: vh
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout: place new icons after the existing ones without overlapping
// ─────────────────────────────────────────────────────────────────────────────

function collides(a, b, gapX, gapY) {
    return a.x < b.x + b.w + gapX && b.x < a.x + a.w + gapX &&
           a.y < b.y + b.h + gapY && b.y < a.y + a.h + gapY;
}

/**
 * Put new icons into an existing sprite without touching existing positions. Starts right after the last
 * existing icon (bottom-most row, right-most in it), fills that line to the sprite width, then wraps to
 * new lines. Every candidate spot is checked against all existing viewBoxes and already placed icons.
 * @param {Array<{x,y,w,h}>} existing
 * @param {Array<{width,height}>} icons   get spriteX / spriteY
 * @returns {{maxRight:number, maxBottom:number}}
 */
function placeAfterExisting(existing, icons, maxWidth, s) {
    const gapX = s.spacing, gapY = s.rowGap, pad = s.padding;
    const rects = existing.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    let maxRight = 0, maxBottom = 0;
    rects.forEach((r) => { maxRight = Math.max(maxRight, r.x + r.w); maxBottom = Math.max(maxBottom, r.y + r.h); });
    const right = (maxWidth > 0 ? maxWidth : Math.max(maxRight + pad, 450)) - pad;

    const anchor = rects.reduce((best, r) => {
        if (!best) return r;
        if (r.y > best.y + 0.5) return r;
        if (Math.abs(r.y - best.y) <= 0.5 && r.x + r.w > best.x + best.w) return r;
        return best;
    }, null);

    let x = anchor ? anchor.x + anchor.w + gapX : pad;
    let y = anchor ? anchor.y : pad;
    let line = [];
    let inLine = 0;

    const hit = (c) => { for (const r of rects) if (collides(c, r, gapX, gapY)) return r; return null; };
    const nextLine = () => {
        let bottom = -Infinity;
        line.forEach((r) => { bottom = Math.max(bottom, r.y + r.h); });
        rects.forEach((r) => { if (r.y <= y + 0.5 && r.y + r.h > y) bottom = Math.max(bottom, r.y + r.h); });
        const ny = bottom === -Infinity ? y + 1 : bottom + gapY;
        y = Math.max(ny, y + 1);
        x = pad;
        line = [];
        inLine = 0;
    };

    for (const icon of icons) {
        const w = icon.width, h = icon.height;
        for (let guard = 0; guard < 100000; guard++) {
            const rowFull = s.iconsPerRow > 0 && inLine >= s.iconsPerRow;
            if (rowFull || (x + w > right && x > pad)) { nextLine(); continue; }
            const c = { x, y, w, h };
            const r = hit(c);
            if (r) { x = r.x + r.w + gapX; continue; }
            icon.spriteX = Math.round(x);
            icon.spriteY = Math.round(y);
            const placed = { x: icon.spriteX, y: icon.spriteY, w, h };
            if (hit(placed)) { x += 1; continue; }
            rects.push(placed);
            line.push(placed);
            inLine++;
            x = placed.x + w + gapX;
            maxRight = Math.max(maxRight, placed.x + w);
            maxBottom = Math.max(maxBottom, placed.y + h);
            break;
        }
    }
    return { maxRight, maxBottom };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprite text inspection
// ─────────────────────────────────────────────────────────────────────────────

/** Every <symbol> of the sprite text: [{ id, viewBox, rect|null }], plus every id in the file. */
function inspectSprite(spriteText) {
    const text = String(spriteText || "");
    const symbols = [];
    const symRe = /<symbol\b[^>]*>/g;
    let sm;
    while ((sm = symRe.exec(text)) !== null) {
        const vb = /viewBox\s*=\s*["']([^"']+)["']/.exec(sm[0]);
        const id = /\bid\s*=\s*["']([^"']+)["']/.exec(sm[0]);
        let rect = null;
        if (vb) {
            const n = vb[1].trim().split(/[\s,]+/).map(Number);
            if (n.length === 4 && n.every(isFinite)) rect = { x: n[0], y: n[1], w: n[2], h: n[3] };
        }
        symbols.push({ id: id ? id[1] : null, viewBox: vb ? vb[1] : null, rect });
    }
    const allIds = new Set();
    const gRe = /\bid\s*=\s*["']([^"']+)["']/g;
    let gm;
    while ((gm = gRe.exec(text)) !== null) allIds.add(gm[1]);

    const root = /<svg\b[^>]*>/.exec(text);
    const rootVb = root && /viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(root[0]);
    return {
        symbols,
        allIds,
        root: root ? root[0] : null,
        width: rootVb ? Math.ceil(+rootVb[1]) : 450,
        height: rootVb ? Math.ceil(+rootVb[2]) : 0
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Append
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} spriteText                       current sprite file
 * @param {Array<{name:string, text:string}>} items single-icon SVG sources (name = file name)
 * @param {object} [opts]
 * @param {string} [opts.prefix]                    symbol id prefix; default: the sprite's own (zcicn-); "" = none
 * @param {object} [opts.layout]                    { spacing, rowGap, padding, iconsPerRow }
 * @returns {{ svg:string, added:Array, skipped:Array<{name,reason}>, changed:boolean,
 *             size:{before:{width,height}, after:{width,height}} }}
 */
function appendIconsToSprite(spriteText, items, opts) {
    opts = opts || {};
    const layout = Object.assign({}, DEFAULT_LAYOUT, opts.layout || {});
    const text = String(spriteText || "");
    if (!/<svg\b/i.test(text) || text.lastIndexOf("</svg>") < 0) {
        throw Object.assign(new Error("The sprite file is not a readable SVG (no <svg> … </svg>)"), { status: 422 });
    }
    const info = inspectSprite(text);
    const ids = new Set(info.symbols.filter((s) => s.id).map((s) => s.id.toLowerCase()));
    const rects = info.symbols.map((s) => s.rect).filter(Boolean);
    const gids = new Set(info.allIds);
    const prefix = opts.prefix !== undefined && opts.prefix !== null
        ? String(opts.prefix)
        : detectPrefix(info.symbols.map((s) => s.id).filter(Boolean), "zcicn-");

    const skipped = [], added = [], icons = [];
    const seen = new Set();
    const token = "n" + Date.now().toString(36);
    (items || []).forEach((it, i) => {
        const fileName = it && it.name ? String(it.name) : "icon-" + (i + 1) + ".svg";
        const icon = parseIconSvg(it && it.text, fileName);
        if (!icon) { skipped.push({ name: fileName, reason: "not a readable SVG" }); return; }
        if (!icon.name) { skipped.push({ name: fileName, reason: "empty icon name" }); return; }
        const symbolId = symbolIdFor(icon.name, prefix);
        const key = symbolId.toLowerCase();
        if (ids.has(key)) { skipped.push({ name: icon.name, symbolId, reason: "already in the sprite" }); return; }
        if (seen.has(key)) { skipped.push({ name: icon.name, symbolId, reason: "duplicate in this request" }); return; }
        seen.add(key);
        let gId = camel(icon.name) + "ZCI";
        while (gids.has(gId)) gId += "_n";
        gids.add(gId);
        icon.symbolId = symbolId;
        icon.gId = gId;
        isolate(icon, token + i + "-");
        icons.push(icon);
    });

    const before = { width: info.width, height: info.height };
    if (!icons.length) return { svg: text, added, skipped, changed: false, size: { before, after: before } };

    const pos = placeAfterExisting(rects, icons, info.width, layout);
    const newG = [], newSym = [];
    let newStyle = "", newDefs = "";
    for (const icon of icons) {
        const tx = Math.round(icon.spriteX - icon.originX), ty = Math.round(icon.spriteY - icon.originY);
        const hasStroke = /<[^>]+\bstroke\s*=/i.test(icon.svgContent || "");
        let a = 'id="' + escapeAttr(icon.gId) + '"';
        if (tx || ty) a += ' transform="translate(' + tx + "," + ty + ')"';
        if (icon.rootFill) a += ' fill="' + escapeAttr(icon.rootFill) + '"';
        if (icon.rootStroke && !hasStroke) a += ' stroke="' + escapeAttr(icon.rootStroke) + '"';
        if (icon.colorMode === "stroke" && !icon.rootFill) a += ' fill="none"';
        newG.push("<g " + a + ">\n" + icon.svgContent + "\n</g>");
        newSym.push('<symbol viewBox="' + icon.spriteX + " " + icon.spriteY + " " + Math.ceil(icon.width) + " " + Math.ceil(icon.height) + '" id="' + escapeAttr(icon.symbolId) + '">\n<use href="#' + escapeAttr(icon.gId) + '"></use>\n</symbol>');
        if (icon.styleContent && icon.styleContent.trim()) newStyle += "\n" + icon.styleContent.trim();
        if (icon.defsContent && icon.defsContent.trim()) newDefs += "\n" + icon.defsContent.trim();
        added.push({ name: icon.name, symbolId: icon.symbolId, gId: icon.gId, x: icon.spriteX, y: icon.spriteY, width: icon.width, height: icon.height, viewBox: icon.spriteX + " " + icon.spriteY + " " + Math.ceil(icon.width) + " " + Math.ceil(icon.height) });
    }

    let out = text;
    // The sprite grows only when the new icons run past the bottom / right edge.
    const newH = Math.max(info.height, Math.ceil(pos.maxBottom + layout.padding));
    const newW = Math.max(info.width, Math.ceil(pos.maxRight + layout.padding));
    if (info.root && (newH !== info.height || newW !== info.width)) {
        const r2 = info.root
            .replace(/(\bwidth\s*=\s*["'])[\d.]+(px)?/, "$1" + newW + "$2")
            .replace(/(\bheight\s*=\s*["'])[\d.]+(px)?/, "$1" + newH + "$2")
            .replace(/(viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+)[\d.]+([\s,]+)[\d.]+/, "$1" + newW + "$2" + newH)
            .replace(/(enable-background\s*:\s*new\s+[\d.-]+\s+[\d.-]+\s+)[\d.]+(\s+)[\d.]+/, "$1" + newW + "$2" + newH);
        out = out.replace(info.root, () => r2);
    }
    if (newStyle) {
        const se = out.indexOf("</style>");
        out = se >= 0
            ? out.slice(0, se) + newStyle + "\n" + out.slice(se)
            : out.replace(/(<svg\b[^>]*>)/, (m) => m + '\n<style type="text/css">' + newStyle + "\n</style>");
    }
    if (newDefs) {
        const de = out.indexOf("</defs>");
        if (de >= 0) out = out.slice(0, de) + newDefs + "\n" + out.slice(de);
        else {
            const se2 = out.indexOf("</style>");
            const at = se2 >= 0 ? se2 + 8 : (() => { const m = /<svg\b[^>]*>/.exec(out); return m ? m.index + m[0].length : 0; })();
            out = out.slice(0, at) + "\n<defs>" + newDefs + "\n</defs>" + out.slice(at);
        }
    }
    const firstSym = out.indexOf("<symbol");
    const gs = newG.join("\n") + "\n";
    out = firstSym >= 0 ? out.slice(0, firstSym) + gs + out.slice(firstSym) : out.replace(/<\/svg>(?![\s\S]*<\/svg>)/, () => gs + "</svg>");
    const close = out.lastIndexOf("</svg>");
    out = out.slice(0, close) + newSym.join("\n") + "\n" + out.slice(close);

    return { svg: out, added, skipped, changed: true, size: { before, after: { width: newW, height: newH } } };
}

/**
 * Self-check of a sprite text: overlapping symbol viewBoxes and duplicate symbol ids.
 * @returns {{ overlaps: Array<[string,string]>, duplicateIds: string[], symbols: number }}
 */
function checkSprite(spriteText) {
    const info = inspectSprite(spriteText);
    const syms = info.symbols.filter((s) => s.rect);
    const overlaps = [];
    for (let i = 0; i < syms.length; i++) {
        for (let j = i + 1; j < syms.length; j++) {
            if (collides(syms[i].rect, syms[j].rect, 0, 0)) overlaps.push([syms[i].id, syms[j].id]);
        }
    }
    const seen = new Set(), duplicateIds = [];
    for (const s of info.symbols) {
        if (!s.id) continue;
        const k = s.id.toLowerCase();
        if (seen.has(k)) duplicateIds.push(s.id); else seen.add(k);
    }
    return { overlaps, duplicateIds, symbols: info.symbols.length };
}

module.exports = {
    DEFAULT_LAYOUT,
    appendIconsToSprite,
    parseIconSvg,
    inspectSprite,
    checkSprite,
    iconNameFromFile,
    symbolIdFor,
    detectPrefix
};
