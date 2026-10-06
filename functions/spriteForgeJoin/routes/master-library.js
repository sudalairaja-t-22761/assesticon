"use strict";

/**
 * Master UI Library routes
 *
 * A single shared folder (default name: Master_ui_library) that mirrors the
 * CRM_UI_LIBRARY icon files from the repository:
 *
 *   crmutil_icons.svg, svg_cssicons.svg, svg-icons.less, svg-path.less
 *
 * The folder lives in Stratus (or local disk in dev) exactly like saved
 * sprites, is visible to every signed-in user, and every save is committed
 * and pushed to the configured repository branch.
 *
 * Routes (all under /api/master-library):
 *   GET  /config           → public repo config (no token)
 *   GET  /                 → folder listing (index); ?sync=1 pulls from repo when empty
 *   POST /sync             → pull all files from the repository into the folder
 *   GET  /file?name=x.svg  → raw file content
 *   POST /save             → { files:[{name, content}], message } → store + commit + push
 *   POST /test-connection  → verify token / branch
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const express = require("express");

const repoConfig = require("../lib/repo-config");
const { createRepoClient } = require("../lib/repo-client");

/**
 * @param {object} deps
 * @param {(req)=>boolean}                deps.useStratus
 * @param {(req,key,buf,ct)=>Promise}     deps.stratusPut
 * @param {(req,key)=>Promise<Buffer>}    deps.stratusGet
 * @param {(req)=>{session}|null}         deps.getSession
 * @param {(req,res,next)=>void}          deps.requireSession
 */
function createMasterLibraryRouter(deps) {
    const router = express.Router();
    const cfg    = repoConfig.load();
    const client = createRepoClient(cfg);

    const LOCAL_DIR = path.join(os.tmpdir(), "svgforge-master", cfg.folder);
    const indexKey  = `${cfg.folder}/_index.json`;
    const fileKey   = (name) => `${cfg.folder}/${name}`;
    const byName    = new Map(cfg.files.map((f) => [f.name, f]));

    const contentType = (name) => {
        if (/\.svg$/i.test(name))  return "image/svg+xml";
        if (/\.less$/i.test(name)) return "text/x-less";
        if (/\.css$/i.test(name))  return "text/css";
        return "application/octet-stream";
    };

    // ── storage (Stratus or local disk) ────────────────────────────────────
    async function put(req, key, buf, ct) {
        if (deps.useStratus(req)) return deps.stratusPut(req, key, buf, ct);
        const abs = path.join(LOCAL_DIR, path.posix.basename(key));
        fs.mkdirSync(LOCAL_DIR, { recursive: true });
        fs.writeFileSync(abs, buf);
    }
    async function get(req, key) {
        if (deps.useStratus(req)) return deps.stratusGet(req, key);
        const abs = path.join(LOCAL_DIR, path.posix.basename(key));
        if (!fs.existsSync(abs)) throw new Error(`Not found: ${key}`);
        return fs.readFileSync(abs);
    }
    async function readIndex(req) {
        try { return JSON.parse((await get(req, indexKey)).toString("utf8")); }
        catch (_) { return { folder: cfg.folder, files: [], lastSyncAt: null, lastCommit: null }; }
    }
    async function writeIndex(req, idx) {
        await put(req, indexKey, Buffer.from(JSON.stringify(idx, null, 2), "utf8"), "application/json");
    }
    function upsertEntry(idx, entry) {
        idx.files = (idx.files || []).filter((e) => e.name !== entry.name);
        idx.files.push(entry);
        // Keep the configured order so the UI is stable.
        const order = cfg.files.map((f) => f.name);
        idx.files.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    }
    function userOf(req) {
        const cur = deps.getSession(req);
        const u = cur && cur.session && cur.session.user;
        return u ? { name: u.name || "", email: u.email || "" } : null;
    }
    function decorate(idx) {
        return {
            folder: cfg.folder,
            repo: repoConfig.publicConfig(cfg),
            lastSyncAt: idx.lastSyncAt || null,
            lastCommit: idx.lastCommit || null,
            files: (idx.files || []).map((e) => ({ ...e, webUrl: (byName.get(e.name) || {}).webUrl || null, key: fileKey(e.name) })),
            missing: cfg.files.filter((f) => !(idx.files || []).some((e) => e.name === f.name)).map((f) => f.name)
        };
    }

    // ── pull from repository ───────────────────────────────────────────────
    async function syncFromRepo(req) {
        if (!cfg.isConfigured) throw Object.assign(new Error("Repository token (REPO_TOKEN) is not configured"), { status: 503 });
        const results = await client.readFiles(cfg.files.map((f) => f.repoPath));
        const idx = await readIndex(req);
        const now = new Date().toISOString();
        const synced = [];
        const missing = [];
        for (const r of results) {
            const meta = cfg.files.find((f) => f.repoPath === r.repoPath);
            if (!meta) continue;
            if (r.missing || !r.content) { missing.push(meta.name); continue; }
            await put(req, fileKey(meta.name), r.content, contentType(meta.name));
            upsertEntry(idx, {
                name: meta.name, repoPath: meta.repoPath, kind: meta.kind, ext: meta.ext,
                size: r.content.length, updatedAt: now, updatedBy: { name: "repository", email: "" },
                commit: r.commit || null, source: "repo"
            });
            synced.push(meta.name);
            if (r.commit) idx.lastCommit = r.commit;
        }
        idx.lastSyncAt = now;
        await writeIndex(req, idx);
        return { synced, missing, index: idx };
    }

    // ── auth gate ──────────────────────────────────────────────────────────
    const gate = (req, res, next) => (cfg.requireLogin ? deps.requireSession(req, res, next) : next());

    // ── routes ─────────────────────────────────────────────────────────────
    router.get("/config", (req, res) => {
        res.json({ success: true, ...repoConfig.publicConfig(cfg) });
    });

    router.get("/", gate, async (req, res) => {
        try {
            let idx = await readIndex(req);
            const wantSync = String(req.query.sync || "") === "1";
            if (wantSync && (!idx.files || idx.files.length < cfg.files.length) && cfg.isConfigured) {
                try { idx = (await syncFromRepo(req)).index; }
                catch (e) { console.warn("[master-library] auto-sync failed:", e.message); }
            }
            res.json({ success: true, ...decorate(idx) });
        } catch (err) {
            console.error("[master-library] list", err);
            res.status(500).json({ success: false, message: err.message });
        }
    });

    router.post("/sync", gate, async (req, res) => {
        try {
            const r = await syncFromRepo(req);
            res.json({ success: true, synced: r.synced, missing: r.missing, ...decorate(r.index) });
        } catch (err) {
            console.error("[master-library] sync", err.message);
            res.status(err.status || 502).json({ success: false, message: err.message });
        }
    });

    router.get("/file", gate, async (req, res) => {
        const name = path.posix.basename(String(req.query.name || ""));
        if (!name || !byName.has(name)) {
            return res.status(400).json({ success: false, message: `Unknown file. Allowed: ${[...byName.keys()].join(", ")}` });
        }
        try {
            const buf = await get(req, fileKey(name));
            res.setHeader("Content-Type", contentType(name));
            res.setHeader("Cache-Control", "no-store");
            res.send(buf);
        } catch (err) {
            res.status(404).json({ success: false, message: `${name} is not in ${cfg.folder} yet — run Sync from repository first` });
        }
    });

    router.post("/save", gate, async (req, res) => {
        try {
            const body  = req.body || {};
            const files = Array.isArray(body.files) ? body.files : [];
            if (!files.length) return res.status(400).json({ success: false, message: "No files supplied" });

            const prepared = [];
            for (const f of files) {
                const name = path.posix.basename(String(f.name || ""));
                const meta = byName.get(name);
                if (!meta) return res.status(400).json({ success: false, message: `"${name}" is not a Master UI Library file. Allowed: ${[...byName.keys()].join(", ")}` });
                if (typeof f.content !== "string" || !f.content.trim()) return res.status(400).json({ success: false, message: `"${name}" has no content` });
                prepared.push({ meta, buf: Buffer.from(f.content, "utf8") });
            }

            const user = userOf(req) || { name: "SpriteForge user", email: "" };
            const now  = new Date().toISOString();
            const idx  = await readIndex(req);

            // 1) Always store in the shared folder first.
            for (const p of prepared) {
                await put(req, fileKey(p.meta.name), p.buf, contentType(p.meta.name));
            }

            // 2) Commit + push to the repository.
            let repoResult = null;
            let pushError  = null;
            if (cfg.isConfigured) {
                try {
                    repoResult = await client.writeFiles(
                        prepared.map((p) => ({ repoPath: p.meta.repoPath, content: p.buf })),
                        {
                            message: body.message || `Update ${prepared.map((p) => p.meta.name).join(", ")} via SpriteForge (${user.name || user.email})`,
                            authorName:  user.name  || cfg.authorName,
                            authorEmail: user.email || cfg.authorEmail
                        }
                    );
                } catch (e) {
                    pushError = e.message;
                    console.error("[master-library] push failed:", e.message);
                }
            } else {
                pushError = "REPO_TOKEN is not configured — stored in folder only";
            }

            for (const p of prepared) {
                upsertEntry(idx, {
                    name: p.meta.name, repoPath: p.meta.repoPath, kind: p.meta.kind, ext: p.meta.ext,
                    size: p.buf.length, updatedAt: now, updatedBy: user,
                    commit: (repoResult && repoResult.commit) || null, source: "tool",
                    pushed: !!(repoResult && repoResult.pushed), pushError: pushError || null
                });
            }
            if (repoResult && repoResult.commit) idx.lastCommit = repoResult.commit;
            await writeIndex(req, idx);

            res.json({
                success: true,
                stored: prepared.map((p) => p.meta.name),
                pushed: !!(repoResult && repoResult.pushed),
                changed: repoResult ? repoResult.changed : false,
                commit: (repoResult && repoResult.commit) || null,
                branch: cfg.branch,
                commitMessage: repoResult && repoResult.message,
                pushError,
                ...decorate(idx)
            });
        } catch (err) {
            console.error("[master-library] save", err);
            res.status(500).json({ success: false, message: err.message });
        }
    });

    router.post("/test-connection", gate, async (req, res) => {
        try {
            const r = await client.test();
            res.status(r.ok ? 200 : 502).json({ success: !!r.ok, ...r, branch: cfg.branch, gitUrl: cfg.provider === "git" ? cfg.gitUrl : undefined });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

    return router;
}

module.exports = { createMasterLibraryRouter };
