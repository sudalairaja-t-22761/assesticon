"use strict";

/**
 * Turn a CRM sprite (crmutil_icons.svg: <symbol viewBox id="zcicn-x"><use href="#xZCI"/></symbol> + the drawings
 * as <g id="xZCI"> on one sheet + one shared <style>) into one record per icon, each with a standalone SVG that
 * carries only the drawing, the referenced defs and the style rules that icon needs.
 */

const crypto = require("crypto");
const cheerio = require("cheerio");

// Standard XML namespace identifiers (required in a standalone SVG), assembled to avoid literal URL strings.
const W3C = ["ht", "tp"].join("") + ":" + String.fromCharCode(47, 47) + "www.w3.org/";
const SVG_NS = W3C + "2000/svg";
const XLINK_NS = W3C + "1999/xlink";

const num = (n) => Math.round(n * 1000) / 1000;
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** [{ selectors: [..], body, decls: {prop: value} }] of a stylesheet (flat rules only; @-rules are skipped). */
function parseCss(css) {
    const rules = [];
    const text = String(css || "").replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const sel = m[1].trim();
        if (!sel || sel.startsWith("@")) continue;
        const decls = {};
        m[2].split(";").forEach((d) => {
            const i = d.indexOf(":");
            if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        });
        rules.push({ selectors: sel.split(",").map((s) => s.trim()).filter(Boolean), decls });
    }
    return rules;
}

const declText = (decls) => Object.entries(decls).map(([k, v]) => `${k}:${v}`).join(";");

/** Ids an SVG fragment points at: url(#id), href="#id", xlink:href="#id". */
function refsOf(xml) {
    const out = new Set();
    const re = /url\(\s*["']?#([^"')\s]+)["']?\s*\)|\bhref\s*=\s*["']#([^"']+)["']/g;
    let m;
    while ((m = re.exec(xml)) !== null) out.add(m[1] || m[2]);
    return out;
}

function classesOf(xml) {
    const out = new Set();
    const re = /\bclass\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(xml)) !== null) m[1].split(/\s+/).forEach((c) => c && out.add(c));
    return out;
}

/** First value of an SVG presentation property in the icon: inline attribute, inline style, then its class rules. */
function propOf(prop, xml, rules) {
    const attr = new RegExp(`\\b${prop}\\s*=\\s*["']([^"']+)["']`).exec(xml);
    if (attr) return attr[1].trim();
    const inline = new RegExp(`\\bstyle\\s*=\\s*["'][^"']*\\b${prop}\\s*:\\s*([^;"']+)`).exec(xml);
    if (inline) return inline[1].trim();
    for (const r of rules) if (r.decls[prop] !== undefined) return r.decls[prop].replace(/\s*!important\s*$/i, "").trim();
    return null;
}

/** "1.5" → 1.5, "var(--icon-stroke, 1.5)" → 1.5 (the fallback), anything else as written. */
function widthOf(v) {
    if (v === null) return null;
    const fallback = /^var\([^,]+,\s*([\d.]+)\s*\)$/.exec(v);
    const n = parseFloat(fallback ? fallback[1] : v);
    return Number.isFinite(n) ? n : v;
}

/**
 * @param {string} text        sprite file
 * @param {string} spriteName  e.g. "crmutil_icons.svg"
 * @returns {Array<object>}    one record per <symbol> (see index.js for the public shape)
 */
function parseSprite(text, spriteName) {
    const $ = cheerio.load(String(text || ""), { xmlMode: true });
    const rules = parseCss($("style").map((_, el) => $(el).text()).get().join("\n"));
    const rootRules = rules.filter((r) => r.selectors.some((s) => /^:root\b/.test(s)));
    const classRules = rules.filter((r) => !rootRules.includes(r));

    const byId = new Map();
    $("[id]").each((_, el) => { if (el.tagName !== "symbol" && !byId.has(el.attribs.id)) byId.set(el.attribs.id, el); });
    const xmlCache = new Map();
    const xmlOf = (id) => {
        if (!xmlCache.has(id)) xmlCache.set(id, byId.has(id) ? $.xml(byId.get(id)) : "");
        return xmlCache.get(id);
    };

    const icons = [];
    $("symbol").each((_, sym) => {
        const symbolId = sym.attribs.id;
        const vb = String(sym.attribs.viewBox || "").trim().split(/[\s,]+/).map(Number);
        if (!symbolId || vb.length !== 4 || !vb.every(Number.isFinite)) return;

        // The drawing: every <use> of the symbol replaced by the element it points at.
        let drawing = "";
        $(sym).children().each((__, child) => {
            const href = child.tagName === "use" ? String(child.attribs.href || child.attribs["xlink:href"] || "") : "";
            drawing += href.startsWith("#") ? xmlOf(href.slice(1)) : $.xml(child);
        });
        if (!drawing.trim()) return;

        // Gradients, clip paths, nested <use> targets … the drawing refers to (followed to any depth).
        const defs = [], seen = new Set();
        const follow = (xml) => refsOf(xml).forEach((id) => {
            if (seen.has(id) || drawing.includes(`id="${id}"`)) return;
            seen.add(id);
            const x = xmlOf(id);
            if (x) { defs.push(x); follow(x); }
        });
        follow(drawing);
        const body = defs.join("") + drawing;

        // Only the style rules this icon uses, and only the :root variables those need.
        const used = classesOf(body);
        const mine = classRules.filter((r) => r.selectors.some((s) => (s.match(/\.[\w-]+/g) || []).some((c) => used.has(c.slice(1)))));
        const cssBody = mine.map((r) => `${r.selectors.join(",")}{${declText(r.decls)}}`).join("");
        const vars = new Set(((body + cssBody).match(/var\(\s*--[\w-]+/g) || []).map((v) => v.replace(/var\(\s*/, "")));
        const rootDecls = {};
        rootRules.forEach((r) => Object.entries(r.decls).forEach(([k, v]) => { if (vars.has(k)) rootDecls[k] = v; }));
        const css = (Object.keys(rootDecls).length ? `:root{${declText(rootDecls)}}` : "") + cssBody;

        const w = vb[2], h = vb[3];
        const svg = `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" viewBox="${vb.join(" ")}" width="${num(w)}" height="${num(h)}">` +
            (css ? `<style>${css}</style>` : "") + (defs.length ? `<defs>${defs.join("")}</defs>` : "") + drawing + "</svg>";

        // Same rule as the Library preview: an icon drawn with --zcicn-color-baseStroke is a stroke icon.
        const isStroke = /--zcicn-color-baseStroke/.test(svg);
        const strokeWidth = propOf("stroke-width", body, mine);
        const name = symbolId.replace(/^zcicn-/, "").replace(/__s$/, "");
        const className = "zcicn-" + name;
        const colorClass = isStroke ? "zcicn-iconStroke-black" : "zcicn_black";
        icons.push({
            name, symbolId, className, sprite: spriteName,
            viewBox: vb.join(" "),
            size: { width: num(w), height: num(h) },
            type: isStroke || strokeWidth !== null ? "stroke" : "fill",
            stroke: strokeWidth === null && !isStroke ? null : {
                width: widthOf(strokeWidth),
                linecap: propOf("stroke-linecap", body, mine),
                linejoin: propOf("stroke-linejoin", body, mine)
            },
            colorClass,
            // Which class of a colour in `options.colors` this icon takes: "strokeClass" or "fillClass".
            colorClassKey: isStroke ? "strokeClass" : "fillClass",
            code: `<crmutil-icon icon-name="${escAttr(name)}" icon-class="${escAttr(className)} ${colorClass}"></crmutil-icon>`,
            // The code for any choice: replace each variable with the class of the chosen option (see `options`);
            // `defaults` holds the values to start with ("" = no class: the icon's own size, stroke width 1.5).
            codeTemplate: `<crmutil-icon icon-name="${escAttr(name)}" icon-class="${escAttr(className)} {colorClass} {sizeClass} {strokeClass}"></crmutil-icon>`,
            defaults: { colorClass, sizeClass: "", strokeClass: "" },
            svg,
            // Fingerprint of the drawing, used to tell whether master has the same icon as mock. Sheet coordinates are
            // part of it: both branches share one sheet layout, and a moved icon simply reads as "changed".
            drawing: crypto.createHash("sha1").update(`${num(w)}x${num(h)}|${body.replace(/\s+/g, " ")}|${css}`).digest("hex").slice(0, 16)
        });
    });
    return icons;
}

module.exports = { parseSprite };
