"use strict";

/**
 * Master UI Library routes — served DIRECTLY from the repository.
 *
 * The CRM_UI_LIBRARY icon files
 *
 *   crmutil_icons.svg, svg_cssicons.svg, svg-icons.less, svg-path.less
 *
 * are read from the configured repository branch and kept only in an
 * in-memory cache (plus the git client's scratch clone in os.tmpdir()).
 * Nothing is copied into Catalyst Stratus / File Store: the repository is the
 * single source of truth. "Sync" re-fetches the branch tip and replaces the
 * cache; "Save" commits + pushes and then updates the cache with what was
 * pushed.
 *
 * Routes (all under /api/master-library):
 *   GET  /config           → public repo config (no token)
 *   GET  /                 → file listing; ?refresh=1 (or legacy ?sync=1 when empty) re-fetches the repo
 *   POST /sync             → fetch the latest branch tip from the repository
 *   GET  /file?name=x.svg  → raw file content (from the repository cache)
 *   POST /save             → { files:[{name, content}], message } → commit + push
 *   POST /test-connection  → verify token / branch
 */

const path = require("path");
const express = require("express");

const repoConfig = require("../lib/repo-config");
const { createRepoClient } = require("../lib/repo-client");

/**
 * @param {object} deps
 * @param {(req)=>{session}|null}         deps.getSession
 * @param {(req,res,next)=>void}          deps.requireSession
 */
function createMasterLibraryRouter(deps) {
    const router = express.Router();
    const cfg    = repoConfig.load();
    const client = createRepoClient(cfg);
    const byName = new Map(cfg.files.map((f) => [f.name, f]));

    const contentType = (name) => {
        if (/\.svg$/i.test(name))  return "image/svg+xml; charset=utf-8";
        if (/\.less$/i.test(name)) return "text/x-less; charset=utf-8";
        if (/\.css$/i.test(name))  return "text/css; charset=utf-8";
        return "application/octet-stream";
    };

    // ── in-memory repository cache ─────────────────────────────────────────
    // files: name → { content: Buffer, commit, updatedAt, updatedBy, source, pushError? }
    const cache = { files: new Map(), missing: [], commit: null, commitInfo: null, fetchedAt: null, error: null };
    let inflight = null;

    function notConfigured() {
        return Object.assign(new Error("Repository token (REPO_TOKEN) is not configured on the server"), { status: 503 });
    }

    /** Fetch every configured file from the repository branch tip. Concurrent callers share one fetch. */
    function fetchFromRepo() {
        if (!cfg.isConfigured) return Promise.reject(notConfigured());
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const results = await client.readFiles(cfg.files.map((f) => f.repoPath));
                const now = new Date().toISOString();
                const files = new Map();
                const missing = [];
                let info = null;
                let commit = null;
                for (const r of results) {
                    const meta = cfg.files.find((f) => f.repoPath === r.repoPath);
                    if (!meta) continue;
                    if (r.commit) commit = r.commit;
                    if (r.commitInfo) info = r.commitInfo;
                    if (r.missing || !r.content) { missing.push(meta.name); continue; }
                    files.set(meta.name, { content: r.content, commit: r.commit || null, updatedAt: now, updatedBy: null, source: "repo" });
                }
                cache.files = files;
                cache.missing = missing;
                cache.commit = commit;
                cache.commitInfo = info;
                cache.fetchedAt = now;
                cache.error = null;
                return cache;
            } catch (e) {
                cache.error = e.message;
                throw e;
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    async function ensureLoaded(force) {
        if (force || !cache.fetchedAt) await fetchFromRepo();
        return cache;
    }

    function userOf(req) {
        const cur = deps.getSession(req);
        const u = cur && cur.session && cur.session.user;
        return u ? { name: u.name || "", email: u.email || "" } : null;
    }

    function listing() {
        const files = cfg.files
            .filter((f) => cache.files.has(f.name))
            .map((f) => {
                const e = cache.files.get(f.name);
                return {
                    name: f.name, repoPath: f.repoPath, kind: f.kind, ext: f.ext, webUrl: f.webUrl,
                    size: e.content.length, commit: e.commit, updatedAt: e.updatedAt,
                    updatedBy: e.updatedBy, source: e.source, pushError: e.pushError || null
                };
            });
        return {
            folder: cfg.folder,
            source: "repository",
            repo: repoConfig.publicConfig(cfg),
            lastSyncAt: cache.fetchedAt,
            lastCommit: cache.commit,
            lastCommitInfo: cache.commitInfo,
            files,
            missing: cfg.files.filter((f) => !cache.files.has(f.name)).map((f) => f.name),
            error: cache.error
        };
    }

    // ── auth gate ──────────────────────────────────────────────────────────
    const gate = (req, res, next) => (cfg.requireLogin ? deps.requireSession(req, res, next) : next());

    // ── routes ─────────────────────────────────────────────────────────────
    router.get("/config", (req, res) => {
        res.json({ success: true, ...repoConfig.publicConfig(cfg) });
    });

    router.get("/", gate, async (req, res) => {
        const force = String(req.query.refresh || "") === "1";
        try {
            await ensureLoaded(force);
            res.json({ success: true, ...listing() });
        } catch (err) {
            console.error("[master-library] list:", err.message);
            // Still answer with whatever is cached so the UI can show the error next to stale data.
            res.status(err.status || 502).json({ success: false, message: err.message, ...listing() });
        }
    });

    router.post("/sync", gate, async (req, res) => {
        try {
            await fetchFromRepo();
            const l = listing();
            res.json({ success: true, synced: l.files.map((f) => f.name), ...l });
        } catch (err) {
            console.error("[master-library] sync:", err.message);
            res.status(err.status || 502).json({ success: false, message: err.message, ...listing() });
        }
    });

    router.get("/file", gate, async (req, res) => {
        const name = path.posix.basename(String(req.query.name || ""));
        if (!name || !byName.has(name)) {
            return res.status(400).json({ success: false, message: `Unknown file. Allowed: ${[...byName.keys()].join(", ")}` });
        }
        try {
            await ensureLoaded(false);
        } catch (err) {
            return res.status(err.status || 502).json({ success: false, message: err.message });
        }
        const entry = cache.files.get(name);
        if (!entry) {
            return res.status(404).json({ success: false, message: `${name} was not found in ${cfg.repoName}@${cfg.branch} (${byName.get(name).repoPath})` });
        }
        res.setHeader("Content-Type", contentType(name));
        res.setHeader("Cache-Control", "no-store");
        if (entry.commit) res.setHeader("X-Repo-Commit", entry.commit);
        res.send(entry.content);
    });

    router.post("/save", gate, async (req, res) => {
        try {
            if (!cfg.isConfigured) throw notConfigured();
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
            const repoResult = await client.writeFiles(
                prepared.map((p) => ({ repoPath: p.meta.repoPath, content: p.buf })),
                {
                    message: body.message || `Update ${prepared.map((p) => p.meta.name).join(", ")} via SpriteForge (${user.name || user.email})`,
                    authorName:  user.name  || cfg.authorName,
                    authorEmail: user.email || cfg.authorEmail
                }
            );

            // The repository now holds exactly what was pushed — mirror it in the cache.
            const now = new Date().toISOString();
            for (const p of prepared) {
                cache.files.set(p.meta.name, {
                    content: p.buf, commit: repoResult.commit || null, updatedAt: now,
                    updatedBy: user, source: "tool"
                });
            }
            if (repoResult.commit) {
                cache.commit = repoResult.commit;
                if (repoResult.changed) cache.commitInfo = { sha: repoResult.commit, date: now, author: user.name || user.email || cfg.authorName, subject: repoResult.message };
            }
            if (!cache.fetchedAt) cache.fetchedAt = now;

            res.json({
                success: true,
                stored: prepared.map((p) => p.meta.name),
                pushed: !!repoResult.pushed,
                changed: !!repoResult.changed,
                commit: repoResult.commit || null,
                branch: cfg.branch,
                commitMessage: repoResult.message,
                pushError: null,
                ...listing()
            });
        } catch (err) {
            console.error("[master-library] save:", err.message);
            res.status(err.status || 502).json({ success: false, message: err.message, pushError: err.message });
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
