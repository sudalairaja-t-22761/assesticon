"use strict";

/**
 * spriteAppend — Zoho Catalyst Advanced I/O function.
 *
 * Appends individual SVG icons to the icon library sprite
 *   Iconassest / Sprite/crmutil_icons.svg   (ZohoRepository, branch "default")
 * and commits + pushes the result. The existing sprite is never rewritten: no symbol is renamed or moved,
 * the new icons are placed after the last existing one without overlapping, and the new <symbol>s are
 * appended at the bottom of the file (right before </svg>).
 *
 * Routes (deployed under /server/spriteAppend/…):
 *   GET  /api/sprite/health            public — is the repo token configured, which repo/branch/file
 *   GET  /api/sprite/icons             list the sprite's symbol ids + viewBoxes at the branch tip
 *   GET  /api/sprite/file              the current sprite text (image/svg+xml)
 *   POST /api/sprite/check             { svg } → overlaps / duplicate ids of any sprite text (no repo access)
 *   POST /api/sprite/append            add icons (see below)
 *
 * POST /api/sprite/append
 *   multipart/form-data: one or more .svg file parts (any field name), optional fields
 *                        message, dryRun, prefix, spacing, rowGap, padding
 *   application/json:    { "icons": [ { "name": "home.svg", "svg": "<svg …>" },
 *                                     { "name": "x.svg", "data": "<base64>", "encoding": "base64" } ],
 *                          "message": "commit message", "dryRun": false, "prefix": "zcicn-" }
 *   Response: { success, added:[{name, symbolId, gId, viewBox, x, y, width, height}], skipped:[{name, reason}],
 *               changed, pushed, commit, branch, file, webUrl, size:{before,after}, check:{overlaps,duplicateIds},
 *               svg? (dryRun only) }
 *
 * Auth: SPRITE_API_TOKEN via `x-api-token`, `Authorization: Bearer …` or `?token=`. On Catalyst the API
 * refuses every call until the token is set; locally (no Catalyst port) an empty token allows all.
 * Optional `x-user-name` / `x-user-email` headers become the commit author.
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
const path = require("path");
const express = require("express");
const multer = require("multer");

const repoConfig = require("./lib/repo-config");
const { createRepoClient } = require("./lib/repo-client");
const sprite = require("./lib/sprite-append");

// ── configuration ────────────────────────────────────────────────────────────
// The git host of the icon repo comes from the environment only (no URL is hardcoded here):
// ICON_REPO_GIT_URL, else ICON_REPO_GIT_HOST + project path, else the host of REPO_GIT_URL. See .env.example.
const cfg = repoConfig.loadIconRepo();                       // ICON_REPO_* (token falls back to REPO_TOKEN)
const gitHostOk = (() => { try { return !!new URL(cfg.gitUrl).host; } catch (_) { return false; } })();
if (!gitHostOk) console.error("[spriteAppend] ICON_REPO_GIT_URL (or ICON_REPO_GIT_HOST / REPO_GIT_URL) is not set — every repository call will fail until it is");
const spriteFile = cfg.files.find((f) => f.kind === "sprite") || cfg.files[0];
const client = createRepoClient(cfg);

const int = (name, def, min) => { const v = parseInt(process.env[name] || "", 10); return Number.isFinite(v) ? Math.max(min === undefined ? 0 : min, v) : def; };
const LIMITS = { icons: int("MAX_ICONS_PER_REQUEST", 200, 1), bytes: int("MAX_SVG_BYTES", 2 * 1024 * 1024, 1024) };
const LAYOUT = { spacing: int("SPRITE_SPACING", 7, 0), rowGap: int("SPRITE_ROW_GAP", 5, 0), padding: int("SPRITE_PADDING", 5, 0) };
const API_TOKEN = String(process.env.SPRITE_API_TOKEN || "").trim();
const ON_CATALYST = !!process.env.X_ZOHO_CATALYST_LISTEN_PORT;
// SPRITE_API_PUBLIC=true → no API token needed even on Catalyst. Anyone with the URL can then append icons to the repo.
const API_PUBLIC = ["1", "true", "yes", "on"].includes(String(process.env.SPRITE_API_PUBLIC || "").trim().toLowerCase());
if (API_PUBLIC) console.warn("[spriteAppend] SPRITE_API_PUBLIC=true: the append API accepts requests WITHOUT a token");
const ORIGINS = String(process.env.ALLOWED_ORIGINS || "").split(/[,\s]+/).map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

// ── app ──────────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (!ORIGINS.length || ORIGINS.includes(origin.replace(/\/+$/, "")))) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-token, x-user-name, x-user-email");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.bytes, files: LIMITS.icons } });

function tokenOf(req) {
    const h = String(req.headers["x-api-token"] || "").trim();
    if (h) return h;
    const auth = String(req.headers.authorization || "");
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
    return String((req.query && req.query.token) || "").trim();
}

function timingSafeEqual(a, b) {
    const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireToken(req, res, next) {
    if (API_PUBLIC) return next(); // tokenless by choice (SPRITE_API_PUBLIC=true wins over a configured token)
    if (!API_TOKEN) {
        if (ON_CATALYST && !API_PUBLIC) return res.status(503).json({ success: false, message: "SPRITE_API_TOKEN is not set on this function — add it in Catalyst Console → Functions → spriteAppend → Environment Variables (or .env.production) and redeploy, or set SPRITE_API_PUBLIC=true to run the API without a token" });
        return next(); // local development, or SPRITE_API_PUBLIC=true
    }
    const t = tokenOf(req);
    if (!t || !timingSafeEqual(t, API_TOKEN)) return res.status(401).json({ success: false, message: "Missing or invalid API token (x-api-token / Authorization: Bearer / ?token=)" });
    next();
}

function userOf(req) {
    const name = String(req.headers["x-user-name"] || "").trim();
    const email = String(req.headers["x-user-email"] || "").trim();
    return { name: name || cfg.authorName, email: email || cfg.authorEmail };
}

function notConfigured() {
    if (!gitHostOk) return Object.assign(new Error("Repository URL (ICON_REPO_GIT_URL) is not configured on the server"), { status: 503 });
    return Object.assign(new Error("Repository token (ICON_REPO_TOKEN / REPO_TOKEN) is not configured on the server"), { status: 503 });
}

/** Answer within the request deadline even if the repository hangs (the git work keeps going). */
function withDeadline(promise, what, overrideMs) {
    const ms = overrideMs || cfg.requestTimeoutMs;
    let timer;
    const host = (() => { try { return new URL(cfg.gitUrl).host; } catch (_) { return "the git host"; } })();
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${what}: the repository did not answer within ${Math.round(ms / 1000)} s (is ${host} reachable from this server?)`), { status: 504 })), ms);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function repoError(e) {
    if (/\b40[13]\b/.test(e.message || "")) {
        e.message = `The repository refused this server's token (ICON_REPO_TOKEN). Create a new ZohoRepository personal access token with read/write access to ${cfg.repoName} and set it on the function. (${e.message})`;
        e.status = 503;
    }
    return e;
}

const bool = (v) => ["1", "true", "yes", "on"].includes(String(v === undefined ? "" : v).trim().toLowerCase());

/** Normalise the request body (multipart or JSON) into { items:[{name,text}], message, dryRun, prefix, layout }. */
function parseAppendRequest(req) {
    const body = req.body || {};
    const items = [];
    for (const f of req.files || []) {
        items.push({ name: f.originalname || f.fieldname, text: f.buffer.toString("utf8"), bytes: f.size });
    }
    const list = Array.isArray(body.icons) ? body.icons : (Array.isArray(body.files) ? body.files : []);
    list.forEach((it, i) => {
        if (!it) return;
        const raw = it.svg !== undefined ? it.svg : (it.content !== undefined ? it.content : it.data);
        if (raw === undefined || raw === null) return;
        const buf = Buffer.from(String(raw), String(it.encoding || "").toLowerCase() === "base64" ? "base64" : "utf8");
        items.push({ name: it.name || `icon-${i + 1}.svg`, text: buf.toString("utf8"), bytes: buf.length });
    });
    const layout = {};
    for (const k of ["spacing", "rowGap", "padding", "iconsPerRow"]) {
        const v = body[k] !== undefined ? body[k] : (body.layout && body.layout[k]);
        if (v !== undefined && v !== null && String(v).trim() !== "" && Number.isFinite(Number(v))) layout[k] = Math.max(0, Number(v));
    }
    return {
        items,
        message: typeof body.message === "string" ? body.message.trim() : "",
        dryRun: bool(body.dryRun) || bool(req.query && req.query.dryRun),
        prefix: body.prefix !== undefined && body.prefix !== null ? String(body.prefix) : undefined,
        layout: Object.assign({}, LAYOUT, layout)
    };
}

const router = express.Router();

router.get("/health", (req, res) => {
    res.json({
        ok: true,
        function: "spriteAppend",
        configured: cfg.isConfigured,
        tokenRequired: !API_PUBLIC && (!!API_TOKEN || ON_CATALYST),
        repo: { name: cfg.repoName, projectPath: cfg.projectPath, branch: cfg.branch, webUrl: cfg.webUrl, provider: cfg.provider },
        file: spriteFile ? { name: spriteFile.name, repoPath: spriteFile.repoPath, webUrl: spriteFile.webUrl } : null,
        layout: LAYOUT,
        limits: LIMITS
    });
});

router.get("/icons", requireToken, async (req, res) => {
    try {
        if (!cfg.isConfigured) throw notConfigured();
        const [r] = await withDeadline(client.readFiles([spriteFile.repoPath]), "Reading the sprite").catch((e) => { throw repoError(e); });
        if (!r || r.missing || !r.content) return res.status(404).json({ success: false, message: `${spriteFile.repoPath} was not found on ${cfg.branch}` });
        const text = r.content.toString("utf8");
        const info = sprite.inspectSprite(text);
        res.json({
            success: true,
            file: spriteFile.repoPath,
            branch: cfg.branch,
            commit: r.commit || null,
            commitInfo: r.commitInfo || null,
            size: { width: info.width, height: info.height, bytes: Buffer.byteLength(text) },
            count: info.symbols.length,
            icons: info.symbols.map((s) => ({ symbolId: s.id, viewBox: s.viewBox }))
        });
    } catch (e) {
        console.error("[spriteAppend] icons:", e.message);
        res.status(e.status || 502).json({ success: false, message: e.message });
    }
});

router.get("/file", requireToken, async (req, res) => {
    try {
        if (!cfg.isConfigured) throw notConfigured();
        const [r] = await withDeadline(client.readFiles([spriteFile.repoPath]), "Reading the sprite").catch((e) => { throw repoError(e); });
        if (!r || r.missing || !r.content) return res.status(404).json({ success: false, message: `${spriteFile.repoPath} was not found on ${cfg.branch}` });
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        res.setHeader("X-Repo-Commit", r.commit || "");
        res.send(r.content);
    } catch (e) {
        res.status(e.status || 502).json({ success: false, message: e.message });
    }
});

router.post("/check", requireToken, (req, res) => {
    const svg = req.body && typeof req.body.svg === "string" ? req.body.svg : "";
    if (!svg.trim()) return res.status(400).json({ success: false, message: "Send { svg: \"<svg …>\" }" });
    try { res.json({ success: true, ...sprite.checkSprite(svg) }); }
    catch (e) { res.status(422).json({ success: false, message: e.message }); }
});

// One append at a time per instance: each reads the latest sprite, so parallel adds would overwrite each other
// (the repo client's own mutex serialises git work; this keeps read → modify → write atomic too).
let queue = Promise.resolve();
function serialize(fn) {
    const job = queue.then(fn, fn);
    queue = job.catch(() => {});
    return job;
}

router.post("/append", requireToken, (req, res, next) => {
    if (/multipart\/form-data/i.test(req.headers["content-type"] || "")) return upload.any()(req, res, next);
    next();
}, async (req, res) => {
    try {
        if (!cfg.isConfigured || !gitHostOk) throw notConfigured();
        if (!spriteFile) throw Object.assign(new Error("ICON_REPO_FILES does not name a sprite"), { status: 503 });
        const reqData = parseAppendRequest(req);
        if (!reqData.items.length) return res.status(400).json({ success: false, message: "No SVG supplied — send .svg file parts (multipart/form-data) or a JSON body { icons: [{ name, svg }] }" });
        if (reqData.items.length > LIMITS.icons) return res.status(413).json({ success: false, message: `Too many icons: ${reqData.items.length} (limit ${LIMITS.icons} per request)` });
        const big = reqData.items.find((it) => it.bytes > LIMITS.bytes);
        if (big) return res.status(413).json({ success: false, message: `"${big.name}" is larger than ${LIMITS.bytes} bytes` });

        const user = userOf(req);
        const result = await serialize(async () => {
            const [r] = await withDeadline(client.readFiles([spriteFile.repoPath]), "Reading the sprite").catch((e) => { throw repoError(e); });
            if (!r || r.missing || !r.content) throw Object.assign(new Error(`${spriteFile.repoPath} was not found on ${cfg.branch}`), { status: 404 });
            const before = r.content.toString("utf8");
            const out = sprite.appendIconsToSprite(before, reqData.items, { prefix: reqData.prefix, layout: reqData.layout });
            const check = sprite.checkSprite(out.svg);
            const newIds = new Set(out.added.map((a) => a.symbolId));
            const newOverlaps = check.overlaps.filter(([a, b]) => newIds.has(a) || newIds.has(b));
            if (newOverlaps.length) throw Object.assign(new Error("Placement check failed: " + newOverlaps.map((p) => p.join(" ↔ ")).join(", ")), { status: 500 });

            // check.overlaps = overlaps involving a NEW icon (always empty here); the sprite's own pre-existing
            // overlaps / duplicate ids are reported separately and never block an append.
            const report = { symbols: check.symbols, overlaps: newOverlaps, preexisting: { overlaps: check.overlaps.length, duplicateIds: check.duplicateIds } };
            const base = { added: out.added, skipped: out.skipped, changed: out.changed, size: out.size, check: report, baseCommit: r.commit || null, file: spriteFile.repoPath, branch: cfg.branch, webUrl: spriteFile.webUrl };
            if (!out.changed) return { ...base, pushed: false, commit: r.commit || null, message: "Nothing to add" };
            if (reqData.dryRun) return { ...base, dryRun: true, pushed: false, commit: null, svg: out.svg };

            const names = out.added.map((a) => a.name);
            const message = reqData.message || `Add ${names.join(", ")} to ${spriteFile.name} via spriteAppend`;
            const repoResult = await withDeadline(client.writeFiles(
                [{ repoPath: spriteFile.repoPath, content: Buffer.from(out.svg, "utf8") }],
                { message, authorName: user.name, authorEmail: user.email }
            ), "Commit").catch((e) => { throw repoError(e); });
            return { ...base, pushed: !!repoResult.pushed, changed: !!repoResult.changed, commit: repoResult.commit || null, message: repoResult.message || message };
        });

        console.log(`[spriteAppend] ${result.dryRun ? "dry-run" : (result.pushed ? "pushed " + String(result.commit || "").slice(0, 8) : "no push")}: +${result.added.length} icon(s), ${result.skipped.length} skipped (${user.email})`);
        res.json({ success: true, ...result });
    } catch (e) {
        console.error("[spriteAppend] append:", e.message);
        res.status(e.status || 502).json({ success: false, message: e.message });
    }
});

app.use("/api/sprite", router);
app.use("/sprite", router);   // short alias
app.get("/", (req, res) => res.json({ ok: true, function: "spriteAppend", routes: ["GET /api/sprite/health", "GET /api/sprite/icons", "GET /api/sprite/file", "POST /api/sprite/check", "POST /api/sprite/append"] }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, message: `A file is larger than ${LIMITS.bytes} bytes` });
    if (err && err.code === "LIMIT_FILE_COUNT") return res.status(413).json({ success: false, message: `More than ${LIMITS.icons} files in one request` });
    if (err && err.type === "entity.too.large") return res.status(413).json({ success: false, message: "Request body too large" });
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ success: false, message: "Invalid JSON body" });
    console.error("[spriteAppend]", err && err.message);
    res.status(500).json({ success: false, message: (err && err.message) || "Internal error" });
});

module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3003;
    require("http").createServer(app).listen(PORT, () => {
        console.log(`[local] spriteAppend listening on localhost port ${PORT}, path /api/sprite  →  ${cfg.repoName}@${cfg.branch} ${spriteFile ? spriteFile.repoPath : "(no file)"} via ${cfg.provider} (token ${cfg.token ? "set" : "NOT set"}; API token ${API_PUBLIC ? "not required (public)" : (API_TOKEN ? "required" : "not required locally")})`);
    });
}
