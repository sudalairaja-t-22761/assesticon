"use strict";

/**
 * iconShare — Zoho Catalyst Advanced I/O function.
 *
 * Read-only API that shares the VERIFIED CRM icons with other products and projects. An icon is verified when it
 * is on a verified branch of CRM_UI_LIBRARY (the same rule the Library's badges use):
 *
 *   source=mock    icons on the mock branch   (REPO_BRANCH, default MOCK_BRANCH)
 *                  status "master_verified" when master has the same drawing, else "mock_verified"
 *   source=master  icons on the master branch (MASTER_REPO_BRANCH, default master)
 *                  status "master_verified"
 *
 * Routes (deployed under /server/iconShare/…):
 *   GET /api/icons/health           public — is the function configured, which branches
 *   GET /api/icons                  THE one link to share: every verified icon (mock + master) with its SVG code,
 *                                   plus `options` (colours, sizes, stroke widths a preview can offer).
 *                                   Optional: ?source=mock|master (default all), ?q=arrow (name contains), ?svg=0 (no SVG code)
 *   GET /api/icons/options          only the options
 *   GET /api/icons/:name            one icon, with its SVG code. :name is "search" or "zcicn-search"
 *
 * One icon:
 *   { name, symbolId, className, sprite, source, status, viewBox, size: { width, height },
 *     type: "fill" | "stroke", stroke: { width, linecap, linejoin } | null, colorClass, code, svg,
 *     colorClassKey: "fillClass" | "strokeClass",   ← the class of a chosen `options.colors` entry this icon takes
 *     codeTemplate,                                 ← `code` with {colorClass} {sizeClass} {strokeClass} variables
 *     defaults: { colorClass, sizeClass, strokeClass },  ← the starting value of each variable ("" = no class)
 *     package: { name, version } | null,      ← the npm package (and its version) of the branch the drawing is on
 *     categories: ["Stroke icons", …],        ← the icon's Library categories
 *     hasOptions: true | false }              ← the Library offers Size + Stroke width for this icon (see `options`)
 *
 * Auth: SHARE_API_TOKEN via `x-api-token`, `Authorization: Bearer …` or `?token=`. On Catalyst every call is
 * refused until the token is set; locally (no Catalyst port) an empty token allows all.
 * The repository is read at most once per SHARE_CACHE_SECONDS (default 300) per source; ?refresh=1 re-reads it now.
 */

// Load environment: FORCE_LOCAL_ENV=true → .env; otherwise .env.production, then .env.
try {
    const dotenv = require("dotenv");
    const fs = require("fs");
    const path = require("path");
    const prodEnv = path.join(__dirname, ".env.production");
    const localEnv = path.join(__dirname, ".env");
    const forceLocal = String(process.env.FORCE_LOCAL_ENV || "").toLowerCase() === "true";
    if (!forceLocal && fs.existsSync(prodEnv)) dotenv.config({ path: prodEnv });
    else if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv });
} catch (_) {}

const crypto = require("crypto");
const express = require("express");

const repoConfig = require("./lib/repo-config");
const { createRepoClient } = require("./lib/repo-client");
const { parseSprite } = require("./lib/icons");
const categories = require("./lib/categories");

// ── configuration ────────────────────────────────────────────────────────────
const SOURCES = {};
for (const [key, cfg] of [["mock", repoConfig.load()], ["master", repoConfig.loadMasterRepo()]]) {
    SOURCES[key] = { key, cfg, client: createRepoClient(cfg), sprites: cfg.files.filter((f) => f.kind === "sprite"), cache: null, loading: null };
}
const API_TOKEN = String(process.env.SHARE_API_TOKEN || "").trim();
const ON_CATALYST = !!process.env.X_ZOHO_CATALYST_LISTEN_PORT;
const CACHE_MS = Math.max(0, parseInt(process.env.SHARE_CACHE_SECONDS || "300", 10) || 0) * 1000;
const ORIGINS = String(process.env.ALLOWED_ORIGINS || "").split(/[,\s]+/).map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

// ── app ──────────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (!ORIGINS.length || ORIGINS.includes(origin.replace(/\/+$/, "")))) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-token");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

function tokenOf(req) {
    const h = String(req.headers["x-api-token"] || "").trim();
    if (h) return h;
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
    if (m) return m[1].trim();
    return String((req.query && req.query.token) || "").trim();
}

function requireToken(req, res, next) {
    if (!API_TOKEN) {
        if (ON_CATALYST) return res.status(503).json({ success: false, message: "SHARE_API_TOKEN is not set on this function — add it to .env.production (or Catalyst Console → Functions → iconShare → Environment Variables) and redeploy" });
        return next(); // local development
    }
    const got = Buffer.from(tokenOf(req)), want = Buffer.from(API_TOKEN);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
        return res.status(401).json({ success: false, message: "Missing or invalid API token (x-api-token / Authorization: Bearer / ?token=)" });
    }
    next();
}

/** Answer within the request deadline even if the repository hangs (the git work keeps going and fills the cache). */
function withDeadline(promise, cfg) {
    let timer;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`The repository did not answer within ${Math.round(cfg.requestTimeoutMs / 1000)} s — try again in a moment`), { status: 504 })), cfg.requestTimeoutMs);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** { name, version } of the npm package on the branch (cfg.versionFile, resources/package.json). null when unreadable. */
function packageOf(r) {
    if (!r || r.missing || !r.content) return null;
    try {
        const j = JSON.parse(r.content.toString("utf8"));
        return j && typeof j.version === "string" && j.version ? { name: typeof j.name === "string" ? j.name : null, version: j.version } : null;
    } catch (_) { return null; }
}

/** Icons of every sprite on one branch: { icons, pkg, commit, commitInfo, fetchedAt }. */
async function readBranch(src) {
    if (!src.cfg.isConfigured) throw Object.assign(new Error("Repository token (REPO_TOKEN) is not configured on the server"), { status: 503 });
    const paths = src.sprites.map((f) => f.repoPath);
    if (src.cfg.versionFile) paths.push(src.cfg.versionFile); // same commit as the sprites
    const results = await src.client.readFiles(paths);
    const pkg = src.cfg.versionFile ? packageOf(results[src.sprites.length]) : null;
    const icons = [];
    let commit = null, commitInfo = null;
    results.slice(0, src.sprites.length).forEach((r, i) => {
        if (!r || r.missing || !r.content) return;
        commit = r.commit || commit;
        commitInfo = r.commitInfo || commitInfo;
        icons.push(...parseSprite(r.content.toString("utf8"), src.sprites[i].name));
    });
    return { icons, pkg, commit, commitInfo, fetchedAt: new Date().toISOString() };
}

/** Cached read of a branch. A failed refresh keeps serving the last good copy (stale: true). */
async function load(src, fresh) {
    const c = src.cache;
    if (c && !fresh && Date.now() - c.at < CACHE_MS) return c.data;
    if (!src.loading) {
        src.loading = readBranch(src)
            .then((data) => { src.cache = { at: Date.now(), data }; return data; })
            .finally(() => { src.loading = null; });
        src.loading.catch(() => {}); // a waiter that timed out must not leave an unhandled rejection
    }
    try { return await withDeadline(src.loading, src.cfg); }
    catch (e) {
        if (c) { console.error(`[iconShare] ${src.key}: serving the cached copy —`, e.message); return { ...c.data, stale: true }; }
        if (/\b40[13]\b/.test(e.message || "")) {
            e.message = `The repository refused this server's token (REPO_TOKEN) — it needs a fresh ZohoRepository token. (${e.message})`;
            e.status = 503;
        }
        throw e;
    }
}

/** Icons of a source in their public shape (with status), plus the branch facts. */
async function iconsOf(sourceKey, fresh) {
    const src = SOURCES[sourceKey];
    const data = await load(src, fresh);
    // On mock, an icon whose drawing is also on master is already master verified.
    let onMaster = null, masterPkg = null;
    if (sourceKey === "mock") {
        try {
            const m = await load(SOURCES.master, fresh);
            masterPkg = m.pkg;
            onMaster = new Map(m.icons.map((i) => [i.sprite + ":" + i.symbolId, i.drawing]));
        } catch (e) { console.error("[iconShare] master branch unavailable, mock icons are reported as mock_verified:", e.message); }
    }
    const icons = data.icons.map((i) => {
        const { drawing, ...pub } = i;
        const status = sourceKey === "master" || (onMaster && onMaster.get(i.sprite + ":" + i.symbolId) === drawing) ? "master_verified" : "mock_verified";
        const { name, symbolId, className, sprite, ...rest } = pub;
        return { name, symbolId, className, sprite, source: sourceKey, status, ...rest, package: data.pkg || null };
    });
    return { icons, masterPkg, branch: src.cfg.branch, commit: data.commit, commitInfo: data.commitInfo, fetchedAt: data.fetchedAt, stale: !!data.stale };
}

/**
 * source=all (the default): every verified icon in one answer — the mock branch's icons, plus the master drawing of
 * any icon that mock has changed or does not have. `source` then says where that drawing is verified.
 */
async function allIcons(fresh) {
    const [mock, master] = await Promise.all([iconsOf("mock", fresh), iconsOf("master", fresh)]);
    const onBoth = new Set(mock.icons.filter((i) => i.status === "master_verified").map((i) => i.sprite + ":" + i.symbolId));
    const icons = mock.icons.map((i) => (i.status === "master_verified" ? { ...i, source: "master", package: mock.masterPkg || i.package } : i))
        .concat(master.icons.filter((i) => !onBoth.has(i.sprite + ":" + i.symbolId)));
    return { icons, commit: { mock: mock.commit, master: master.commit }, fetchedAt: mock.fetchedAt, stale: mock.stale || master.stale };
}
/** Icons of a source, each with its Library categories and whether Size + Stroke width apply to it. */
async function read(req, source) {
    const fresh = bool(req.query.refresh);
    const [r, index] = await Promise.all([source === "all" ? allIcons(fresh) : iconsOf(source, fresh), categories.load(req, CACHE_MS, fresh)]);
    return { ...r, icons: r.icons.map((i) => ({ ...i, ...categories.of(index, i.name) })) };
}

function sourceOf(req, res) {
    const s = String(req.query.source || "all").trim().toLowerCase();
    if (s === "all" || SOURCES[s]) return s;
    res.status(400).json({ success: false, message: `Unknown source "${s}". Use source=all, source=mock or source=master` });
    return null;
}
const bool = (v) => ["1", "true", "yes", "on"].includes(String(v === undefined ? "" : v).trim().toLowerCase());
const fail = (res, what, e) => {
    console.error(`[iconShare] ${what}:`, e.message);
    res.status(e.status || 502).json({ success: false, message: e.message });
};

/**
 * What a preview can let the user choose. A class goes next to the icon's own class in icon-class, e.g.
 * icon-class="zcicn-search zcicn_blue zcicn24". Colours are the CRM default theme: a "fill" icon takes fillClass,
 * a "stroke" icon whose colorClass starts with zcicn-iconStroke- takes strokeClass. `css` is the rule a class needs
 * outside CRM (CRM already has them); 1.5 is the sprite's own stroke width and needs no class.
 */
const COLORS = [["black", "#313949"], ["white", "#FFFFFF"], ["grey", "#616E88"], ["sandal", "#F18E0A"], ["red", "#FF5D5A"], ["blue", "#338CF0"],
    ["green", "#12AA67"], ["purple", "#C35BF4"], ["violet", "#8C71FB"], ["cyan", "#24CBB7"], ["lightGreen", "#AECC48", "lightgreen"],
    ["yellow", "#E8D216"], ["brown", "#B38B59"], ["darkRed", "#E3204F", "darkred"], ["oceanBlue", "#226DB4"], ["statusBlue", "#338CF0", "blue"]];
const OPTIONS = {
    // What is selected before the user chooses: black, the icon's own size (no size option), stroke width 1.5.
    defaults: { color: "black", size: null, stroke: 1.5 },
    colors: COLORS.map(([name, hex, stroke]) => ({ name, hex, fillClass: "zcicn_" + name, strokeClass: "zcicn-iconStroke-" + (stroke || name) })),
    sizes: [["S", 8], ["M", 12], ["L", 16], ["XL", 24], ["XXL", 32]].map(([name, px]) => ({
        name, px, className: "zcicn" + px, css: `.zcicn${px}{width:${px}px;height:${px}px}` })),
    strokes: [
        { width: 1, className: "iconStroke1", css: ".iconStroke1{stroke-width:1 !important}" },
        { width: 1.5, className: "", css: "" },
        { width: 2, className: "iconStroke2", css: ".iconStroke2{stroke-width:2 !important}" }
    ]
};

const router = express.Router();

router.get("/health", (req, res) => {
    res.json({
        ok: true,
        function: "iconShare",
        tokenRequired: !!API_TOKEN || ON_CATALYST,
        cacheSeconds: CACHE_MS / 1000,
        sources: Object.values(SOURCES).map((s) => ({
            source: s.key, configured: s.cfg.isConfigured, repo: s.cfg.repoName, branch: s.cfg.branch,
            sprites: s.sprites.map((f) => f.repoPath), cachedAt: s.cache ? s.cache.data.fetchedAt : null
        }))
    });
});

router.get("/", requireToken, async (req, res) => {
    const source = sourceOf(req, res);
    if (!source) return;
    try {
        const r = await read(req, source);
        const q = String(req.query.q || "").trim().toLowerCase().replace(/^zcicn-/, "");
        const icons = q ? r.icons.filter((i) => i.name.toLowerCase().includes(q)) : r.icons;
        res.json({
            success: true, source, commit: r.commit, fetchedAt: r.fetchedAt, stale: r.stale,
            count: icons.length,
            icons: req.query.svg === undefined || bool(req.query.svg) ? icons : icons.map(({ svg, ...light }) => light),
            options: OPTIONS // colours, size classes and stroke classes a preview can offer
        });
    } catch (e) { fail(res, "list", e); }
});

// Must stay above "/:name". Same values as the Library preview (frontend library-icon-preview.js).
router.get("/options", requireToken, (req, res) => res.json({ success: true, ...OPTIONS }));

router.get("/:name", requireToken, async (req, res) => {
    const source = sourceOf(req, res);
    if (!source) return;
    try {
        const want = String(req.params.name || "").trim().toLowerCase();
        const r = await read(req, source);
        const sprite = String(req.query.sprite || "").trim().toLowerCase();
        const icon = r.icons.find((i) => (i.symbolId.toLowerCase() === want || i.name.toLowerCase() === want) && (!sprite || i.sprite.toLowerCase() === sprite));
        if (!icon) return res.status(404).json({ success: false, message: `No verified icon "${req.params.name}" on ${source}` });
        res.json({ success: true, commit: r.commit, fetchedAt: r.fetchedAt, stale: r.stale, icon });
    } catch (e) { fail(res, "icon", e); }
});

app.use("/api/icons", router);
app.get("/", (req, res) => res.json({ ok: true, function: "iconShare", routes: ["GET /api/icons/health", "GET /api/icons?source=mock|master&q=&svg=1", "GET /api/icons/options", "GET /api/icons/:name?source=mock|master"] }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error("[iconShare]", err && err.message);
    res.status(500).json({ success: false, message: (err && err.message) || "Internal error" });
});

module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3004;
    require("http").createServer(app).listen(PORT, () => {
        console.log(`[local] iconShare listening on localhost port ${PORT}, path /api/icons  →  mock ${SOURCES.mock.cfg.branch}, master ${SOURCES.master.cfg.branch} (repo token ${SOURCES.mock.cfg.token ? "set" : "NOT set"}; API token ${API_TOKEN ? "required" : "not required locally"})`);
    });
}
