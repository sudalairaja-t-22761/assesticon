"use strict";

/**
 * Repository client — reads and commits the Master UI Library files.
 *
 * Providers (REPO_PROVIDER):
 *   git     (default) — plain git over HTTPS using the `git` binary. This is what
 *                        ZohoRepository exposes at https://zrepository.zohocorpcloud.in
 *                        (Basic auth: REPO_TOKEN_USER / REPO_TOKEN). A sparse, shallow
 *                        clone is cached in os.tmpdir() and only the configured files
 *                        are checked out.
 *   gitlab / gitea / github — REST API fallbacks for hosts that expose one of those
 *                        API dialects. Token is sent as PRIVATE-TOKEN / Authorization.
 *
 * All providers expose the same interface:
 *   client.test()                         → { ok, provider, detail }
 *   client.readFiles(repoPaths)           → [{ repoPath, content (Buffer), commit, commitInfo? }]
 *   client.writeFiles(files, opts)        → { changed, commit, branch, pushed }
 *       files: [{ repoPath, content (Buffer|string) }]
 *       opts:  { message, authorName, authorEmail }
 */

const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Serialise async work so two requests never touch the git working tree at once. */
function createMutex() {
    let tail = Promise.resolve();
    return function run(fn) {
        const next = tail.then(fn, fn);
        tail = next.catch(() => {});
        return next;
    };
}

function redact(text, secrets) {
    let out = String(text || "");
    for (const s of secrets) {
        if (s && s.length > 3) out = out.split(s).join("***");
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: git CLI
// ─────────────────────────────────────────────────────────────────────────────

function createGitProvider(cfg) {
    const mutex   = createMutex();
    // (engine: git CLI)
    const secrets = [cfg.token];
    const authHeader = cfg.token
        ? "Authorization: Basic " + Buffer.from(`${cfg.tokenUser}:${cfg.token}`, "utf8").toString("base64")
        : "";
    const cacheKey = crypto.createHash("sha1").update(`${cfg.gitUrl}#${cfg.branch}`).digest("hex").slice(0, 12);
    const workDir  = path.join(os.tmpdir(), "svgforge-repo", cacheKey);
    const repoPaths = cfg.files.map((f) => f.repoPath);
    // Empty hooks dir: machine-wide hooks (e.g. core.hooksPath commit checkers) must not run for the tool's commits.
    const noHooksDir = path.join(os.tmpdir(), "svgforge-repo", "no-hooks");
    try { fs.mkdirSync(noHooksDir, { recursive: true }); } catch (_) {}

    function git(args, opts) {
        opts = opts || {};
        const fullArgs = [];
        // Credentials go in via the per-invocation config so they are never written to .git/config.
        if (authHeader) fullArgs.push("-c", `http.extraHeader=${authHeader}`);
        fullArgs.push("-c", "credential.helper=", "-c", "core.askPass=", "-c", "advice.detachedHead=false", "-c", `core.hooksPath=${noHooksDir}`);
        fullArgs.push(...args);
        return new Promise((resolve, reject) => {
            execFile("git", fullArgs, {
                cwd: opts.cwd || workDir,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
                maxBuffer: 64 * 1024 * 1024,
                timeout: opts.timeout || 180000
            }, (err, stdout, stderr) => {
                if (err) {
                    const e = new Error(`git ${args[0]} failed: ${redact(stderr || err.message, secrets).trim()}`);
                    e.stderr = redact(stderr, secrets);
                    e.code = err.code;
                    return reject(e);
                }
                resolve({ stdout: String(stdout), stderr: redact(stderr, secrets) });
            });
        });
    }

    async function gitAvailable() {
        try { await git(["--version"], { cwd: os.tmpdir(), timeout: 10000 }); return true; }
        catch (_) { return false; }
    }

    async function ensureClone() {
        if (fs.existsSync(path.join(workDir, ".git"))) return;
        fs.mkdirSync(path.dirname(workDir), { recursive: true });
        fs.rmSync(workDir, { recursive: true, force: true });

        const base = ["clone", "--no-checkout", "--depth", "1", "--single-branch", "--branch", cfg.branch];
        try {
            // Partial clone: no blobs until needed → tiny download even for a large repo.
            await git([...base, "--filter=blob:none", cfg.gitUrl, workDir], { cwd: os.tmpdir(), timeout: 600000 });
        } catch (e1) {
            fs.rmSync(workDir, { recursive: true, force: true });
            if (/filter|not supported|unknown option/i.test(e1.message)) {
                await git([...base, cfg.gitUrl, workDir], { cwd: os.tmpdir(), timeout: 600000 });
            } else if (/Remote branch .* not found|Could not find remote branch/i.test(e1.message)) {
                // Branch does not exist yet — clone the default branch and create it locally.
                await git(["clone", "--no-checkout", "--depth", "1", "--single-branch", cfg.gitUrl, workDir], { cwd: os.tmpdir(), timeout: 600000 });
                await git(["checkout", "-b", cfg.branch]);
            } else {
                throw e1;
            }
        }
        await git(["sparse-checkout", "set", "--no-cone", ...repoPaths]);
        try { await git(["checkout", cfg.branch]); }
        catch (_) { await git(["checkout", "-b", cfg.branch]); }
    }

    /** Bring the working tree to the latest remote state of the branch. */
    async function syncToRemote() {
        await ensureClone();
        try {
            await git(["fetch", "--depth", "1", "origin", cfg.branch]);
            await git(["checkout", "-B", cfg.branch, "FETCH_HEAD"]);
            await git(["sparse-checkout", "set", "--no-cone", ...repoPaths]);
        } catch (e) {
            if (!/couldn't find remote ref|Could not find remote branch/i.test(e.message)) throw e;
            // Branch is new on the remote — keep local state.
        }
    }

    async function headCommit() {
        try { return (await git(["rev-parse", "HEAD"])).stdout.trim(); } catch (_) { return null; }
    }

    /** Sha, date, author and subject of the checked-out tip (works on a depth-1 clone). */
    async function headInfo() {
        try {
            const out = (await git(["log", "-1", "--format=%H%x00%cI%x00%an%x00%s"])).stdout.trim();
            const [sha, date, author, subject] = out.split("\0");
            return sha ? { sha, date: date || null, author: author || null, subject: subject || null } : null;
        } catch (_) { return null; }
    }

    return {
        provider: "git",

        async test() {
            if (!(await gitAvailable())) {
                return { ok: false, provider: "git", detail: "git binary not found on this runtime — set REPO_PROVIDER=gitlab|gitea|github to use a REST API instead" };
            }
            if (!cfg.token) return { ok: false, provider: "git", detail: "REPO_TOKEN is not set" };
            try {
                const out = await git(["ls-remote", "--heads", cfg.gitUrl, cfg.branch], { cwd: os.tmpdir(), timeout: 60000 });
                const line = out.stdout.trim().split("\n").filter(Boolean)[0] || "";
                return {
                    ok: true,
                    provider: "git",
                    branchExists: !!line,
                    remoteCommit: line ? line.split(/\s+/)[0] : null,
                    detail: line ? `Branch ${cfg.branch} found` : `Connected, but branch ${cfg.branch} does not exist yet (it will be created on first commit)`
                };
            } catch (e) {
                return { ok: false, provider: "git", detail: e.message };
            }
        },

        readFiles(paths) {
            return mutex(async () => {
                await syncToRemote();
                const info = await headInfo();
                const commit = info ? info.sha : await headCommit();
                const out = [];
                for (const repoPath of paths) {
                    const abs = path.join(workDir, repoPath);
                    if (!fs.existsSync(abs)) {
                        out.push({ repoPath, content: null, commit, commitInfo: info, missing: true });
                        continue;
                    }
                    out.push({ repoPath, content: fs.readFileSync(abs), commit, commitInfo: info });
                }
                return out;
            });
        },

        writeFiles(files, opts) {
            opts = opts || {};
            return mutex(async () => {
                await syncToRemote();
                const touched = [];
                for (const f of files) {
                    const abs = path.join(workDir, f.repoPath);
                    fs.mkdirSync(path.dirname(abs), { recursive: true });
                    fs.writeFileSync(abs, Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), "utf8"));
                    touched.push(f.repoPath);
                }
                await git(["add", "--sparse", "--", ...touched]).catch(() => git(["add", "--", ...touched]));

                let changed = true;
                try { await git(["diff", "--cached", "--quiet"]); changed = false; } catch (_) { changed = true; }
                if (!changed) {
                    return { changed: false, pushed: false, commit: await headCommit(), branch: cfg.branch, message: "No changes — repository already has this content" };
                }

                const name  = opts.authorName  || cfg.authorName;
                const email = opts.authorEmail || cfg.authorEmail;
                const msg   = opts.message || `Update ${touched.map((p) => path.posix.basename(p)).join(", ")} via SpriteForge`;
                await git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", msg]);
                const commit = await headCommit();

                try {
                    await git(["push", "origin", `HEAD:refs/heads/${cfg.branch}`]);
                } catch (pushErr) {
                    if (!/rejected|non-fast-forward|fetch first|failed to push/i.test(pushErr.message)) throw pushErr;
                    // Someone else pushed in between — rebase onto the new tip and retry once.
                    await git(["fetch", "--depth", "1", "origin", cfg.branch]);
                    await git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "rebase", "FETCH_HEAD"]);
                    await git(["push", "origin", `HEAD:refs/heads/${cfg.branch}`]);
                }
                return { changed: true, pushed: true, commit: await headCommit() || commit, branch: cfg.branch, message: msg };
            });
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: pure-JavaScript git (isomorphic-git) — no `git` binary needed
// ─────────────────────────────────────────────────────────────────────────────
//
// Catalyst function runtimes do not ship the git CLI. This provider speaks git
// smart-HTTP directly: a depth-1, single-branch, bare clone in os.tmpdir()
// (the CRM_UI_LIBRARY branch is < 1 MB), files are read from git objects, and
// commits are built from trees without a working copy, then pushed.

/**
 * isomorphic-git's node HTTP client has no timeout: a host that never answers would
 * hang the request until the platform kills the function. Every round-trip gets a limit.
 */
// Node ≥ 19's default agents close sockets idle for 5 s, and simple-get (used by
// isomorphic-git) turns that into "Request timed out". A push waits silently while the
// server processes the pack, so it needs agents without an idle timeout; the limits
// below still stop a host that never answers.
const NO_IDLE_AGENTS = {
    "http:":  new (require("http").Agent)({ keepAlive: true, timeout: 0 }),
    "https:": new (require("https").Agent)({ keepAlive: true, timeout: 0 })
};

function httpWithTimeout(http, ms, host, pushMs) {
    return {
        request(args) {
            let proto = "https:";
            try { proto = new URL(args.url).protocol; } catch (_) {}
            const isPush = /git-receive-pack$/.test(String(args.url || "").split("?")[0]) && String(args.method || "").toUpperCase() === "POST";
            const limitMs = isPush ? Math.max(ms, pushMs || ms) : ms;
            let timer;
            const limit = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(Object.assign(new Error(isPush
                        ? `${host} did not confirm the push within ${Math.round(limitMs / 1000)} s — it may still have been applied; use Sync from repo to check`
                        : `no answer from ${host} within ${Math.round(limitMs / 1000)} s (is the git host reachable from this server?)`), { code: "ETIMEDOUT" }));
                }, limitMs);
            });
            const req = http.request({ ...args, agent: args.agent || NO_IDLE_AGENTS[proto] || undefined });
            return Promise.race([req, limit]).finally(() => clearTimeout(timer));
        }
    };
}

function createIsoGitProvider(cfg) {
    const git    = require("isomorphic-git");
    const http   = httpWithTimeout(require("isomorphic-git/http/node"), cfg.httpTimeoutMs || 20000, (() => { try { return new URL(cfg.gitUrl).host; } catch (_) { return "the git host"; } })(), cfg.requestTimeoutMs || 25000);
    const mutex  = createMutex();
    const secrets = [cfg.token];
    const headers = cfg.token
        ? { Authorization: "Basic " + Buffer.from(`${cfg.tokenUser}:${cfg.token}`, "utf8").toString("base64") }
        : {};
    const cacheKey = crypto.createHash("sha1").update(`${cfg.gitUrl}#${cfg.branch}`).digest("hex").slice(0, 12);
    const dir = path.join(os.tmpdir(), "svgforge-isogit", cacheKey);
    const gitdir = dir; // bare layout: objects/refs live directly in dir
    const remoteRef = `refs/remotes/origin/${cfg.branch}`;
    const localRef  = `refs/heads/${cfg.branch}`;
    const base = { fs, http, dir, gitdir, url: cfg.gitUrl, headers };

    function wrap(e, what) {
        const msg = redact((e && (e.data && e.data.statusMessage ? `${e.message} (${e.data.statusCode} ${e.data.statusMessage})` : e.message)) || String(e), secrets);
        const err = new Error(`${what} failed: ${msg}`);
        err.code = e && e.code;
        return err;
    }

    async function exists() {
        try { await git.resolveRef({ fs, gitdir, ref: "HEAD", depth: 1 }); return true; }
        catch (_) { return fs.existsSync(path.join(gitdir, "config")); }
    }

    /** Fetch the branch tip; returns its commit oid (null when the branch does not exist yet). */
    async function fetchTip() {
        if (!(await exists())) {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            await git.init({ fs, dir, gitdir, bare: true, defaultBranch: cfg.branch });
            await git.addRemote({ fs, gitdir, remote: "origin", url: cfg.gitUrl, force: true });
        }
        try {
            const r = await git.fetch({ ...base, remote: "origin", ref: cfg.branch, singleBranch: true, depth: 1, tags: false, prune: false });
            const oid = r.fetchHead || await git.resolveRef({ fs, gitdir, ref: remoteRef });
            await git.writeRef({ fs, gitdir, ref: localRef, value: oid, force: true });
            return oid;
        } catch (e) {
            if (e && (e.code === "NotFoundError" || /could not find|not found|couldn't find remote ref/i.test(e.message || ""))) {
                // Branch is new on the remote: start from the default branch tip.
                const info = await git.getRemoteInfo({ http, url: cfg.gitUrl, headers });
                const def = info.HEAD ? String(info.HEAD).replace(/^refs\/heads\//, "") : null;
                if (!def) throw wrap(e, "git fetch");
                const r = await git.fetch({ ...base, remote: "origin", ref: def, singleBranch: true, depth: 1, tags: false });
                return r.fetchHead || null;
            }
            throw wrap(e, "git fetch");
        }
    }

    async function commitInfo(oid) {
        try {
            const c = await git.readCommit({ fs, gitdir, oid });
            const a = c.commit.committer || c.commit.author || {};
            return { sha: oid, date: a.timestamp ? new Date(a.timestamp * 1000).toISOString() : null, author: (c.commit.author && c.commit.author.name) || null, subject: String(c.commit.message || "").split("\n")[0] };
        } catch (_) { return { sha: oid, date: null, author: null, subject: null }; }
    }

    async function readPath(commitOid, repoPath) {
        try {
            const { blob } = await git.readBlob({ fs, gitdir, oid: commitOid, filepath: repoPath });
            return Buffer.from(blob);
        } catch (e) {
            if (e && e.code === "NotFoundError") return null;
            throw wrap(e, `read ${repoPath}`);
        }
    }

    /** New tree oid = tree of `treeOid` with `files` ({ "a/b.svg": Buffer }) written in. */
    async function writeTreeWith(treeOid, files) {
        const entries = treeOid ? (await git.readTree({ fs, gitdir, oid: treeOid })).tree.slice() : [];
        const direct = {};
        const nested = {};
        Object.keys(files).forEach((p) => {
            const i = p.indexOf("/");
            if (i === -1) direct[p] = files[p];
            else {
                const head = p.slice(0, i);
                (nested[head] = nested[head] || {})[p.slice(i + 1)] = files[p];
            }
        });
        for (const name of Object.keys(direct)) {
            const oid = await git.writeBlob({ fs, gitdir, blob: new Uint8Array(direct[name]) });
            const at = entries.findIndex((e) => e.path === name);
            const entry = { mode: at >= 0 && entries[at].type === "blob" ? entries[at].mode : "100644", path: name, oid, type: "blob" };
            if (at >= 0) entries[at] = entry; else entries.push(entry);
        }
        for (const name of Object.keys(nested)) {
            const at = entries.findIndex((e) => e.path === name && e.type === "tree");
            const sub = await writeTreeWith(at >= 0 ? entries[at].oid : null, nested[name]);
            const entry = { mode: "040000", path: name, oid: sub, type: "tree" };
            if (at >= 0) entries[at] = entry; else entries.push(entry);
        }
        return git.writeTree({ fs, gitdir, tree: entries });
    }

    async function buildCommit(parentOid, files, opts) {
        const parentTree = parentOid ? (await git.readCommit({ fs, gitdir, oid: parentOid })).commit.tree : null;
        const map = {};
        files.forEach((f) => { map[f.repoPath.replace(/^\/+/, "")] = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), "utf8"); });
        const tree = await writeTreeWith(parentTree, map);
        if (tree === parentTree) return null; // nothing changed
        const now = Math.floor(Date.now() / 1000);
        const tz = new Date().getTimezoneOffset();
        const who = { name: opts.name, email: opts.email, timestamp: now, timezoneOffset: tz };
        return git.writeCommit({ fs, gitdir, commit: { message: opts.message.endsWith("\n") ? opts.message : opts.message + "\n", tree, parent: parentOid ? [parentOid] : [], author: who, committer: who } });
    }

    async function pushCommit(oid) {
        await git.writeRef({ fs, gitdir, ref: localRef, value: oid, force: true });
        const r = await git.push({ ...base, remote: "origin", ref: cfg.branch, remoteRef: cfg.branch, force: false });
        const status = r && r.refs && r.refs[localRef];
        if (r && r.ok === false || (status && status.ok === false)) {
            const e = new Error(`push rejected: ${(status && status.error) || (r && r.error) || "unknown"}`);
            e.rejected = true;
            throw e;
        }
    }

    return {
        provider: "git",
        engine: "isomorphic-git",

        async test() {
            if (!cfg.token) return { ok: false, provider: "git", engine: "isomorphic-git", detail: "REPO_TOKEN is not set" };
            try {
                const info = await git.getRemoteInfo({ http, url: cfg.gitUrl, headers });
                const oid = info.refs && info.refs.heads && info.refs.heads[cfg.branch];
                return {
                    ok: true, provider: "git", engine: "isomorphic-git", branchExists: !!oid, remoteCommit: oid || null,
                    detail: oid ? `Branch ${cfg.branch} found (isomorphic-git)` : `Connected, but branch ${cfg.branch} does not exist yet (it will be created on first commit)`
                };
            } catch (e) {
                return { ok: false, provider: "git", engine: "isomorphic-git", detail: wrap(e, "connect").message };
            }
        },

        readFiles(paths) {
            return mutex(async () => {
                const tip = await fetchTip();
                const info = tip ? await commitInfo(tip) : null;
                const out = [];
                for (const repoPath of paths) {
                    const content = tip ? await readPath(tip, repoPath) : null;
                    out.push(content ? { repoPath, content, commit: tip, commitInfo: info } : { repoPath, content: null, commit: tip, commitInfo: info, missing: true });
                }
                return out;
            });
        },

        writeFiles(files, opts) {
            opts = opts || {};
            return mutex(async () => {
                const name  = opts.authorName  || cfg.authorName;
                const email = opts.authorEmail || cfg.authorEmail;
                const message = opts.message || `Update ${files.map((f) => path.posix.basename(f.repoPath)).join(", ")} via SpriteForge`;
                for (let attempt = 0; attempt < 2; attempt++) {
                    const tip = await fetchTip();
                    let oid;
                    try { oid = await buildCommit(tip, files, { name, email, message }); }
                    catch (e) { throw wrap(e, "git commit"); }
                    if (!oid) return { changed: false, pushed: false, commit: tip, branch: cfg.branch, message: "No changes — repository already has this content" };
                    try {
                        await pushCommit(oid);
                        return { changed: true, pushed: true, commit: oid, branch: cfg.branch, message };
                    } catch (e) {
                        // Someone pushed in between: rebuild the same file changes on the new tip once.
                        const rejected = e.rejected || /reject|non-fast-forward|fetch first|not a fast/i.test(e.message || "");
                        if (!rejected || attempt === 1) throw wrap(e, "git push");
                    }
                }
                throw new Error("git push failed");
            });
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: REST APIs (GitLab / Gitea / GitHub dialects)
// ─────────────────────────────────────────────────────────────────────────────

function createRestProvider(cfg) {
    const dialect = cfg.provider; // gitlab | gitea | github
    const enc = encodeURIComponent;
    const [owner, ...rest] = cfg.projectPath.split("/");
    const repo = rest.length ? rest[rest.length - 1] : cfg.repoName;

    function headers(extra) {
        const h = { Accept: "application/json", ...(extra || {}) };
        if (cfg.token) {
            if (dialect === "gitlab") h["PRIVATE-TOKEN"] = cfg.token;
            else h.Authorization = `${dialect === "github" ? "Bearer" : "token"} ${cfg.token}`;
        }
        return h;
    }

    async function call(method, url, body) {
        const res = await fetch(url, {
            method,
            headers: headers(body ? { "Content-Type": "application/json" } : {}),
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
        if (!res.ok) {
            const e = new Error(`${dialect} API ${method} ${url.replace(cfg.baseUrl, "")} → ${res.status} ${(json && (json.message || (json.meta && json.meta.reason))) || text.slice(0, 200)}`);
            e.status = res.status;
            throw e;
        }
        return json;
    }

    const api = {
        gitlab: {
            project: () => `${cfg.baseUrl}/api/v4/projects/${enc(cfg.projectPath)}`,
            async test() { const p = await call("GET", api.gitlab.project()); return { ok: true, detail: `Project ${p.path_with_namespace || p.name}` }; },
            async read(repoPath) {
                const r = await call("GET", `${api.gitlab.project()}/repository/files/${enc(repoPath)}?ref=${enc(cfg.branch)}`);
                return { content: Buffer.from(r.content, r.encoding === "base64" ? "base64" : "utf8"), commit: r.last_commit_id || null, sha: r.blob_id };
            },
            async write(files, opts) {
                const existing = await Promise.all(files.map((f) => api.gitlab.read(f.repoPath).then(() => true, () => false)));
                const r = await call("POST", `${api.gitlab.project()}/repository/commits`, {
                    branch: cfg.branch,
                    commit_message: opts.message,
                    author_name: opts.authorName, author_email: opts.authorEmail,
                    actions: files.map((f, i) => ({ action: existing[i] ? "update" : "create", file_path: f.repoPath, content: f.content.toString("utf8") }))
                });
                return { commit: r.id };
            }
        },
        gitea: {
            base: () => `${cfg.baseUrl}/api/v1/repos/${enc(owner)}/${enc(repo)}`,
            async test() { const r = await call("GET", api.gitea.base()); return { ok: true, detail: `Repository ${r.full_name}` }; },
            async read(repoPath) {
                const r = await call("GET", `${api.gitea.base()}/contents/${repoPath.split("/").map(enc).join("/")}?ref=${enc(cfg.branch)}`);
                return { content: Buffer.from(r.content, "base64"), commit: null, sha: r.sha };
            },
            async write(files, opts) {
                const shas = await Promise.all(files.map((f) => api.gitea.read(f.repoPath).then((r) => r.sha, () => null)));
                const r = await call("POST", `${api.gitea.base()}/contents`, {
                    branch: cfg.branch, message: opts.message,
                    author: { name: opts.authorName, email: opts.authorEmail },
                    files: files.map((f, i) => ({ operation: shas[i] ? "update" : "create", path: f.repoPath, sha: shas[i] || undefined, content: f.content.toString("base64") }))
                });
                return { commit: r && r.commit && r.commit.sha };
            }
        },
        github: {
            base: () => `${cfg.baseUrl}/repos/${enc(owner)}/${enc(repo)}`,
            async test() { const r = await call("GET", api.github.base()); return { ok: true, detail: `Repository ${r.full_name}` }; },
            async read(repoPath) {
                const r = await call("GET", `${api.github.base()}/contents/${repoPath.split("/").map(enc).join("/")}?ref=${enc(cfg.branch)}`);
                return { content: Buffer.from(r.content, "base64"), commit: null, sha: r.sha };
            },
            async write(files, opts) {
                let commit = null;
                for (const f of files) {
                    const sha = await api.github.read(f.repoPath).then((r) => r.sha, () => undefined);
                    const r = await call("PUT", `${api.github.base()}/contents/${f.repoPath.split("/").map(enc).join("/")}`, {
                        branch: cfg.branch, message: opts.message, sha,
                        committer: { name: opts.authorName, email: opts.authorEmail },
                        content: f.content.toString("base64")
                    });
                    commit = r && r.commit && r.commit.sha;
                }
                return { commit };
            }
        }
    }[dialect];

    if (!api) throw new Error(`Unknown REPO_PROVIDER "${cfg.provider}" (expected git, gitlab, gitea or github)`);

    return {
        provider: dialect,
        async test() {
            if (!cfg.token) return { ok: false, provider: dialect, detail: "REPO_TOKEN is not set" };
            try { return { provider: dialect, ...(await api.test()) }; }
            catch (e) { return { ok: false, provider: dialect, detail: e.message }; }
        },
        async readFiles(paths) {
            const out = [];
            for (const repoPath of paths) {
                try { const r = await api.read(repoPath); out.push({ repoPath, content: r.content, commit: r.commit }); }
                catch (e) { if (e.status === 404) out.push({ repoPath, content: null, commit: null, missing: true }); else throw e; }
            }
            return out;
        },
        async writeFiles(files, opts) {
            opts = opts || {};
            const normalised = files.map((f) => ({ repoPath: f.repoPath, content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), "utf8") }));
            // Skip the commit entirely when nothing changed.
            const current = await this.readFiles(normalised.map((f) => f.repoPath));
            const changed = normalised.some((f, i) => !current[i].content || !current[i].content.equals(f.content));
            if (!changed) return { changed: false, pushed: false, commit: current[0] && current[0].commit, branch: cfg.branch, message: "No changes — repository already has this content" };
            const message = opts.message || `Update ${normalised.map((f) => path.posix.basename(f.repoPath)).join(", ")} via SpriteForge`;
            const r = await api.write(normalised, { message, authorName: opts.authorName || cfg.authorName, authorEmail: opts.authorEmail || cfg.authorEmail });
            return { changed: true, pushed: true, commit: r.commit || null, branch: cfg.branch, message };
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * REPO_PROVIDER:
 *   git (default) / isogit — isomorphic-git (pure JavaScript). Same behaviour on every
 *                   runtime; does not depend on the platform's git version (Catalyst
 *                   ships git 2.25, which lacks `sparse-checkout --no-cone` / `add --sparse`).
 *   git-cli       — the git CLI (needs git ≥ 2.35)
 *   git-auto      — the git CLI when present, otherwise isomorphic-git
 *   gitlab | gitea | github — REST APIs
 */
function createRepoClient(cfg) {
    if (cfg.provider === "git" || cfg.provider === "isogit") return createIsoGitProvider(cfg);
    if (cfg.provider === "git-cli") return createGitProvider(cfg);
    if (cfg.provider !== "git-auto") return createRestProvider(cfg);

    let chosen = null;
    async function pick() {
        if (chosen) return chosen;
        const cli = await new Promise((resolve) => {
            execFile("git", ["--version"], { timeout: 10000 }, (err) => resolve(!err));
        });
        chosen = cli ? createGitProvider(cfg) : createIsoGitProvider(cfg);
        console.log(`[repo-client] using ${cli ? "git CLI" : "isomorphic-git (no git binary on this runtime)"}`);
        return chosen;
    }
    return {
        provider: "git",
        engine: () => (chosen ? (chosen.engine || "git-cli") : "pending"),
        async test() {
            const p = await pick();
            const r = await p.test();
            return { engine: p.engine || "git-cli", ...r };
        },
        async readFiles(paths) { return (await pick()).readFiles(paths); },
        async writeFiles(files, opts) { return (await pick()).writeFiles(files, opts); }
    };
}

module.exports = { createRepoClient };
