#!/usr/bin/env node
/**
 * npm release publisher for the icon tool — runs on a machine INSIDE the office network (the Catalyst cloud cannot
 * reach cm-npmregistry). With REPO_NPM_PUBLISH_MODE=external the deployed backend only commits the icon; this script
 * does the release for each watched branch:
 *
 *   new icon commits on the branch since the last resources/package.json change
 *     → bump resources/package.json locally (mock: X.Y.Z-mock-N, N = 1..5, then Z+1; master: plain X.Y.(Z+1); versions already on the registry skipped)
 *     → npm publish resources --tag <tag>
 *     → ONLY after a successful publish: commit the version and push it to the branch
 *   publish failed → the bump is dropped (nothing pushed), the admins get one failure mail, the next run retries
 *
 * Re-publish: an admin can ask for the publish of a pushed request again on the Requests page. Each run reads those
 * (GET <RELEASE_NOTIFY_URL>/../republish), reports that branch's result again even when the error did not change, and
 * for a commit that is already in a published version reports that version instead of publishing twice.
 *
 * Every publish (and every new failure) is mailed to the admins through the backend (RELEASE_NOTIFY_URL +
 * RELEASE_NOTIFY_TOKEN in functions/spriteForgeJoin/.env). It uses your own git login (Keychain) and ~/.npmrc.
 *
 * Helper for the tool's web page (--serve): the Catalyst cloud and the browser cannot reach the registry, so the page of
 * the admin who pushes a request talks to this script on the admin's OWN machine (127.0.0.1:47615):
 *   GET  /status                       → { ok, machine, oneTimeLogin }    is the helper running on this machine?
 *   POST /login   { username, password } → { ok, user, ticket } | { ok:false, error }  checks the login at the registry.
 *                                         Nothing is stored: no password, no token in ~/.npmrc. The ticket stands for this
 *                                         login in the helper's memory, for ONE publish and at most 10 minutes
 *   POST /publish { branch, ticket }   → { ok, state, version } | { ok:false, error }  releases that branch now with the
 *                                         login of that ticket (refused without one: the page asks for the login per push)
 * Only the tool's own pages may call it (Origin allow-list: localhost, the host of RELEASE_NOTIFY_URL, PUBLISHER_ORIGINS).
 *
 * A machine without the backend's .env keeps its settings in sf-npm-publisher.env next to this script (written by the
 * tool's setup command) or in ~/.config/sf-npm-publisher.env (RELEASE_NOTIFY_URL, RELEASE_NOTIFY_TOKEN, optional REPO_*
 * and PUBLISHER_ORIGINS).
 *
 * Nothing is published with a login that is merely saved on a machine: by default the script only serves the page
 * (an admin logs in there with their own npm user, then pushes). The 60 s check that releases by itself is opt-in (--watch).
 *
 *   npm run publisher                      # keeps running: the helper only (scripts/install-npm-publisher.sh starts it at login)
 *   npm run publisher -- --watch           # helper + the 60 s check, which publishes with this machine's saved npm login
 *   npm run publisher -- --once            # one check by hand with this machine's saved npm login, then exit
 *   npm run publisher -- --no-serve        # the 60 s check only, no helper
 *   options: --interval 60  --port 47615  --machine <name>
 *            --grace 300    the 60 s check leaves icon commits younger than this many seconds to the helper of the admin who pushed them
 *            --dry-run (npm publish --dry-run, no commit / push)  --force-dry-run (also without new icons)
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.dirname(__dirname);
// Installed by the tool's setup command (~/.sf-npm-helper), the script has npm-release.js next to it instead of the repository.
const { bumpPackageJson } = require(fs.existsSync(path.join(__dirname, "npm-release.js")) ? path.join(__dirname, "npm-release.js")
    : path.join(ROOT, "functions", "spriteForgeJoin", "lib", "npm-release"));
const args = process.argv.slice(2);
const flag = (n) => args.includes("--" + n);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

// Settings come from the backend's .env (same values the server uses); defaults match this project.
// A machine that only runs the publisher has no backend .env: ~/.config/sf-npm-publisher.env holds its few settings.
function envFile() {
    const out = {};
    // Later files win: the home settings, the file the setup command writes next to the script, the backend's own .env.
    for (const file of [path.join(os.homedir(), ".config", "sf-npm-publisher.env"), path.join(__dirname, "sf-npm-publisher.env"),
        path.join(ROOT, "functions", "spriteForgeJoin", ".env")]) {
        try {
            for (const line of fs.readFileSync(file, "utf8").split("\n")) {
                const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
                if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
            }
        } catch (_) { /* no such file: the other one, or the defaults */ }
    }
    return out;
}
const ENV = envFile();
const get = (k, d) => process.env[k] || ENV[k] || d;

const GIT_URL = get("REPO_GIT_URL", "https://zrepository.zohocorpcloud.in/zohocorp/ICON_LIBRARY/Icons/crm_core_icons.git");
const REGISTRY = get("REPO_NPM_REGISTRY", ["http", "//cm-npmregistry"].join(":"));
const NPM_DIR = get("REPO_NPM_DIR", "resources");
const PKG = `${NPM_DIR}/package.json`;
const MAX = Math.max(1, parseInt(get("REPO_VERSION_MAX", "5"), 10) || 5);
const BRANCHES = [
    { branch: get("REPO_BRANCH", "MOCK_BRANCH"), versionTag: get("REPO_VERSION_TAG", "mock") },
    { branch: get("MASTER_REPO_BRANCH", "master"), versionTag: get("MASTER_REPO_VERSION_TAG", "") }   // no tag: plain X.Y.Z versions on "latest"
].map((b, i) => ({ ...b, tag: get(i ? "MASTER_REPO_NPM_DIST_TAG" : "REPO_NPM_DIST_TAG", "") || b.versionTag || "latest" }));
const INTERVAL_S = Math.max(15, parseInt(opt("interval", "60"), 10) || 60);
const FORCE = flag("force-dry-run");
const DRY = flag("dry-run") || FORCE;
// No option (or --serve): only the helper for the tool's page. --watch: also the 60 s check. --no-serve: only the 60 s check.
const SERVE = !flag("once") && !flag("no-serve");
const WATCH = flag("watch") || flag("once") || flag("no-serve");
const PORT = parseInt(opt("port", "47615"), 10) || 47615;
const GRACE_S = Math.max(0, parseInt(opt("grace", flag("once") ? "0" : "300"), 10) || 0); // a run by hand (--once) releases at once
const MACHINE = String(opt("machine", os.hostname())).slice(0, 80);
// Working copies, the lock and the failure list. Installed by the tool's setup command the script keeps them in its own
// folder: on some machines ~/.cache belongs to root (EACCES). A folder that cannot be created falls back to the next one.
const CACHE = (() => {
    const standalone = fs.existsSync(path.join(__dirname, "npm-release.js"));
    const places = [process.env.SF_PUBLISHER_CACHE, standalone && path.join(__dirname, "cache"), path.join(os.homedir(), ".cache", "sf-npm-publisher"),
        path.join(__dirname, "cache"), path.join(os.tmpdir(), "sf-npm-publisher-" + (os.userInfo().username || "user"))].filter(Boolean);
    for (const dir of places) {
        try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; } catch (_) { /* the next place */ }
    }
    return places[0];
})();
const NO_HOOKS = path.join(CACHE, "no-hooks"); // the Mac's ~/.git_templates commit hooks break scripted commits
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NOTIFY_URL = get("RELEASE_NOTIFY_URL", "");
const NOTIFY_TOKEN = get("RELEASE_NOTIFY_TOKEN", "");
const DEFAULT_PKG = "@zohocrm/crm-ui-library";

const log = (...m) => console.log(new Date().toISOString().replace("T", " ").slice(0, 19), ...m);

function run(cmd, argv, opts) {
    return new Promise((resolve, reject) => {
        execFile(cmd, argv, { maxBuffer: 64 * 1024 * 1024, timeout: 300000, ...opts,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", ...(opts && opts.env) } },
        (err, stdout, stderr) => {
            if (err) {
                const what = argv.filter((a) => !a.startsWith("-") && !a.includes("=") && a !== "-C").slice(cmd === "git" ? 1 : 0)[0] || "";
                const e = new Error(`${path.basename(cmd)} ${what} failed: ${String(stderr || stdout || err.message).trim().split("\n").slice(-3).join(" | ")}`);
                e.output = String(stderr || "") + String(stdout || ""); // the whole output: the npm error code is not in its last lines
                return reject(e);
            }
            resolve(String(stdout));
        });
    });
}
const git = (dir, argv) => run("git", ["-c", `core.hooksPath=${NO_HOOKS}`, "-C", dir].concat(argv));

// ── working copy: only resources/ checked out ──────────────────────────────
async function workCopy(branch) {
    const dir = path.join(CACHE, "work-" + branch.replace(/[^\w.-]/g, "_"));
    fs.mkdirSync(NO_HOOKS, { recursive: true });
    if (!fs.existsSync(path.join(dir, ".git"))) {
        fs.rmSync(dir, { recursive: true, force: true });
        await run("git", ["-c", `core.hooksPath=${NO_HOOKS}`, "clone", "-q", "--template=", "--filter=blob:none", "--no-checkout", "--depth", "50",
            "--single-branch", "--branch", branch, GIT_URL, dir]);
        await git(dir, ["sparse-checkout", "set", NPM_DIR]);
    }
    // A plain incremental fetch: the repository server stalls on a "--depth 50" fetch of an existing working copy
    // (no answer until the 5 minute timeout), while this one only asks for the commits after what is already here.
    await git(dir, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    await git(dir, ["checkout", "-q", "-B", branch, `origin/${branch}`]);
    await git(dir, ["reset", "-q", "--hard", `origin/${branch}`]);
    return dir;
}

/** Commits after the last package.json change that touch resources/ (the icons); deepens a shallow history if needed. */
async function pendingChanges(dir, branch) {
    for (const depth of [50, 300, 2000]) {
        const last = (await git(dir, ["log", "-1", "--format=%H", `origin/${branch}`, "--", PKG])).trim();
        if (last) {
            const lines = (await git(dir, ["log", "--format=%H %ct %s", `${last}..origin/${branch}`, "--", NPM_DIR, `:(exclude)${PKG}`])).trim();
            const list = (lines ? lines.split("\n") : []).map((l) => /^(\S+) (\d+) ?(.*)$/.exec(l) || [l, l.slice(0, 40), "0", l.slice(41)]);
            return { last, commits: list.map((m) => m[1]), subjects: list.map((m) => m[3]), newest: Math.max(0, ...list.map((m) => +m[2])) };
        }
        if (depth === 2000) break;
        await git(dir, ["fetch", "-q", "--deepen", String(depth), "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    }
    throw new Error(`no commit that changed ${PKG} found on ${branch}`);
}

/**
 * npm arguments that pin REGISTRY for this package. For a scoped package "--registry" alone is not enough: a
 * "@scope:registry=" line in ~/.npmrc (or publishConfig.registry in package.json) wins over it and sends the publish to
 * another host name, where this machine may have no valid login (→ 403). The scope option on the command line wins over both.
 */
function registryArgs(name) {
    const scope = /^(@[^/]+)\//.exec(name || "");
    return (scope ? ["--registry", REGISTRY, `--${scope[1]}:registry=${REGISTRY}`] : ["--registry", REGISTRY])
        .concat(USERCONFIG ? ["--userconfig", USERCONFIG] : []); // the one-time login of the admin who pushes (see the helper)
}
// Set only while the helper publishes for an admin: a temporary npm config file with that admin's token, deleted afterwards.
let USERCONFIG = "";

async function registryVersions(name) {
    try { const v = JSON.parse((await run(NPM, ["view", name, "versions", "--json", ...registryArgs(name), "--fetch-retries=1"])) || "[]"); return new Set(Array.isArray(v) ? v : [v]); }
    catch (e) { if (/E404|\b404\b|Not Found/i.test(e.message)) return new Set(); throw e; }
}

function setVersion(file, version) {
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${version}$3`));
}

/** The registry refused the version because it is there already: another machine published it a moment ago. */
const alreadyPublished = (e) => /E409|EPUBLISHCONFLICT|409 Conflict|cannot publish over|already present/i.test((e && (e.output || e.message)) || "");

/** One release check of a branch; b.result = { state: published | uptodate | waiting | dryrun | conflict, version }. */
async function releaseBranch(b, o) {
    const grace = o && o.grace != null ? o.grace : 0;
    b.result = null;
    const dir = await workCopy(b.branch);
    const pkgFile = path.join(dir, PKG);
    const text = fs.readFileSync(pkgFile, "utf8"), pkg = JSON.parse(text);
    b.seen = { name: pkg.name, version: pkg.version, commit: (await git(dir, ["rev-parse", "HEAD"])).trim() };
    const { subjects, commits, newest } = await pendingChanges(dir, b.branch);
    b.seen.commits = commits; // the requests whose icons are in this release (timeline on the request page)
    const taken = await registryVersions(pkg.name);

    // A version committed earlier (deferred mode) but not published yet: publish it as it is, nothing to push.
    const own = !!b.versionTag && new RegExp(`-${b.versionTag}-\\d+$`).test(pkg.version);
    if (own && !taken.has(pkg.version) && !FORCE) {
        log(`${b.branch}: ${pkg.name}@${pkg.version} is committed but not published — publishing it`);
        await publish(dir, b);
        b.seen.commits = [b.seen.commit].concat(commits);
        b.result = { state: "published", version: pkg.version };
        return notifyPublished(b, pkg.name, pkg.version, b.seen.commit, [`(published the committed version ${pkg.version})`]);
    }

    if (!subjects.length && !FORCE) {
        if (flag("once")) log(`${b.branch}: up to date (${pkg.name}@${pkg.version}, no new icons)`);
        b.result = { state: "uptodate", version: pkg.version };
        return reportReleased(dir, b, pkg.name, taken);
    }

    // The 60 s check leaves a fresh push to the helper on the machine of the admin who pushed it (it publishes at once);
    // what is still unpublished after the grace time is released here.
    const age = Math.floor(Date.now() / 1000) - newest;
    if (grace && !FORCE && subjects.length && age < grace) {
        if (b.waitingFor !== commits[0]) log(`${b.branch}: ${subjects.length} new icon commit(s), the newest ${age} s old — left to the pushing admin's helper for ${grace} s`);
        b.waitingFor = commits[0];
        b.result = { state: "waiting", version: pkg.version };
        return;
    }

    const next = bumpPackageJson(text, { preTag: b.versionTag, preMax: MAX }, taken).to;
    log(`${b.branch}: ${subjects.length} new icon commit(s) → ${pkg.version} → ${next}${DRY ? " (dry run)" : ""}`);
    setVersion(pkgFile, next);
    try { await publish(dir, b); }
    catch (e) {
        await git(dir, ["checkout", "--", PKG]).catch(() => {}); // nothing is pushed
        if (alreadyPublished(e)) { // not a failure: the machine that published it pushes the version
            log(`${b.branch}: ${next} is already on the registry — another machine is publishing these icons`);
            b.result = { state: "conflict", version: next };
            return;
        }
        b.seen.version = next; throw e;
    }
    if (DRY) { await git(dir, ["checkout", "--", PKG]); log(`${b.branch}: dry run OK — would push the version commit ${next}`); b.result = { state: "dryrun", version: next }; return; }

    const commit = await pushVersion(dir, b, next, subjects);
    b.result = { state: "published", version: next };
    await notifyPublished(b, pkg.name, next, commit, subjects);
    return reportReleased(dir, b, pkg.name, new Set(taken).add(next));
}

// ── re-publish asked by an admin (Requests page → "Re-publish to npm") ──────
const REPUBLISH_URL = NOTIFY_URL.replace(/\/published\/?(\?.*)?$/, "/republish");
/** { <branch>: [commit sha] } of the requests an admin wants published again; {} when the backend cannot be asked. */
function republishRequests() {
    if (DRY || !NOTIFY_TOKEN || !REPUBLISH_URL || REPUBLISH_URL === NOTIFY_URL) return Promise.resolve({});
    return new Promise((resolve) => {
        const u = new URL(REPUBLISH_URL);
        const req = require(u.protocol === "https:" ? "https" : "http").request(u, { method: "GET", timeout: 20000, headers: { "x-release-token": NOTIFY_TOKEN } }, (res) => {
            let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => {
                try { const j = JSON.parse(t); if (res.statusCode === 200 && j.branches) return resolve(j.branches); } catch (_) { /* not JSON */ }
                if (res.statusCode !== 404) log(`re-publish requests not read: HTTP ${res.statusCode}`); // 404: a backend without this route yet
                resolve({});
            });
        });
        req.on("timeout", () => req.destroy(new Error("timed out")));
        req.on("error", (e) => { log("re-publish requests not read: " + e.message); resolve({}); });
        req.end();
    });
}

/**
 * The re-publish requests of this branch that the run above did not release: their commit is already in a version
 * (the result never reached the request) → report that version; anything else → report why nothing was published.
 */
async function reportReleased(dir, b, name, taken) {
    const done = (b.seen && b.seen.commits) || [];
    const open = (b.republish || []).filter((sha) => !done.some((c) => c.startsWith(sha) || sha.startsWith(c)));
    if (!open.length || DRY) return;
    const byVersion = new Map(), bad = (sha, error) => notify({ status: "failed", name, version: "", tag: b.tag, branch: b.branch, commit: sha, commits: [sha], error });
    for (const sha of open) {
        try {
            let onBranch = false;
            for (const depth of [0, 300, 2000]) {
                if (depth) await git(dir, ["fetch", "-q", "--deepen", String(depth), "origin", `+refs/heads/${b.branch}:refs/remotes/origin/${b.branch}`]);
                onBranch = await git(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]).then(() => true, () => false);
                if (onBranch) break;
            }
            if (!onBranch) { await bad(sha, `commit ${sha.slice(0, 8)} is not on ${b.branch}, so there is nothing to publish for it`); continue; }
            // The first version commit after the icon commit is the release that carries it.
            const rel = (await git(dir, ["log", "--reverse", "--format=%H", `${sha}..HEAD`, "--", PKG])).trim().split("\n")[0];
            if (!rel) { await bad(sha, `commit ${sha.slice(0, 8)} changed nothing under ${NPM_DIR}/, so no version was published for it`); continue; }
            const version = JSON.parse(await git(dir, ["show", `${rel}:${PKG}`])).version;
            if (!taken.has(version)) { await bad(sha, `version ${version} is committed on ${b.branch} but is not on the registry`); continue; }
            if (!byVersion.has(version)) byVersion.set(version, { commit: rel, commits: [] });
            byVersion.get(version).commits.push(sha);
        } catch (e) { await bad(sha, e.message); }
    }
    for (const [version, v] of byVersion) {
        log(`${b.branch}: re-publish asked for ${v.commits.length} commit(s) already published in ${version} — reported`);
        await notify({ status: "published", name, version, tag: b.tag, branch: b.branch, commit: v.commit, commits: v.commits, subject: `(already published in ${version})` });
    }
}

/** The npm user this machine is logged in as at REGISTRY ("" when it is not). */
let NPM_USER = "";
async function whoami(name) {
    const ask = () => run(NPM, ["whoami", ...registryArgs(name || DEFAULT_PKG), "--fetch-retries=0"], { timeout: 30000 });
    // One more try before "not logged in": a single failed call would switch the page's Push button off for nothing.
    try { NPM_USER = (await ask().catch(ask)).trim(); }
    catch (e) { NPM_USER = ""; if (!/ENEEDAUTH|E401|401 Unauthorized|not logged in|requires you to be logged in/i.test(e.output || e.message)) log(`npm whoami failed: ${e.message}`); }
    return NPM_USER;
}

async function publish(dir, b) {
    const name = JSON.parse(fs.readFileSync(path.join(dir, PKG), "utf8")).name;
    const argv = ["publish", ...registryArgs(name), "--tag", b.tag];
    if (DRY) argv.push("--dry-run");
    await whoami(name); // for the result mail: which npm user published
    await run(NPM, argv, { cwd: path.join(dir, NPM_DIR) });
}

/** Commit + push the version (already published); if the branch moved meanwhile, re-apply it on the new tip. */
async function pushVersion(dir, b, version, subjects) {
    const msg = `Release ${version}: ${subjects.length} icon change(s) via SpriteForge npm publisher [${version}]`;
    for (let attempt = 1; ; attempt++) {
        await git(dir, ["add", PKG]);
        await git(dir, ["commit", "-q", "-m", msg]);
        try {
            await git(dir, ["push", "-q", "origin", `HEAD:refs/heads/${b.branch}`]);
            const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
            log(`${b.branch}: published ${version} → tag "${b.tag}" and pushed the version (${sha.slice(0, 8)})`);
            return sha;
        } catch (e) {
            if (attempt >= 3) throw new Error(`${version} is published, but pushing the version failed: ${e.message}`);
            log(`${b.branch}: push rejected (branch moved?) — retrying on the new tip`);
            await git(dir, ["fetch", "-q", "origin", `+refs/heads/${b.branch}:refs/remotes/origin/${b.branch}`]);
            await git(dir, ["reset", "-q", "--hard", `origin/${b.branch}`]);
            setVersion(path.join(dir, PKG), version);
        }
    }
}

// ── admin mails ────────────────────────────────────────────────────────────
function notify(body) {
    if (DRY) return Promise.resolve();
    if (!NOTIFY_URL || !NOTIFY_TOKEN) { log("admin mail skipped: RELEASE_NOTIFY_URL / RELEASE_NOTIFY_TOKEN not set in functions/spriteForgeJoin/.env"); return Promise.resolve(); }
    return new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify({ ...body, machine: MACHINE, npmUser: NPM_USER }));
        const u = new URL(NOTIFY_URL);
        const req = require(u.protocol === "https:" ? "https" : "http").request(u, {
            method: "POST", timeout: 30000,
            headers: { "content-type": "application/json", "content-length": data.length, "x-release-token": NOTIFY_TOKEN }
        }, (res) => {
            let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => {
                let j = {}; try { j = JSON.parse(t); } catch (_) { /* not JSON */ }
                log(res.statusCode === 200 ? `admin mail (${body.status}): sent to ${j.sent} admin(s)${j.failed && j.failed.length ? `, failed ${j.failed.length}: ${j.failed.map((f) => f.to + " (" + f.error + ")").join(", ")}` : ""}`
                    : `admin mail failed: HTTP ${res.statusCode} ${j.message || t.slice(0, 120)}`);
                resolve();
            });
        });
        req.on("timeout", () => req.destroy(new Error("timed out")));
        req.on("error", (e) => { log("admin mail failed: " + e.message); resolve(); });
        req.end(data);
    });
}
function notifyPublished(b, name, version, commit, subjects) {
    forgetFailures(b.branch);
    return notify({ status: "published", name, version, tag: b.tag, branch: b.branch, commit, commits: (b.seen && b.seen.commits) || [],
        subject: subjects.slice(0, 3).join("; ") + (subjects.length > 3 ? `; +${subjects.length - 3} more` : "") });
}

// A failure is mailed once per branch + version + error (also across restarts), not on every retry.
const FAIL_FILE = path.join(CACHE, "failures.json");
function readFailures() { try { return JSON.parse(fs.readFileSync(FAIL_FILE, "utf8")); } catch (_) { return {}; } }
function writeFailures(f) { try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(FAIL_FILE, JSON.stringify(f, null, 1)); } catch (_) { /* best effort */ } }
function forgetFailures(branch) {
    const f = readFailures(); let changed = false;
    Object.keys(f).forEach((k) => { if (k.indexOf(branch + "|") === 0) { delete f[k]; changed = true; } });
    if (changed) writeFailures(f);
}
const errorKey = (m) => String(m).replace(/\/[^\s|]*_logs\/\S+/g, "").replace(/\d{4}-\d\d-\d\dT[\d:._]+Z?/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
async function reportFailure(b, err) {
    const seen = b.seen || {};
    const key = `${b.branch}|${seen.version || "?"}|${errorKey(err.message)}`;
    const f = readFailures();
    if (f[key] || DRY) return;
    f[key] = new Date().toISOString();
    writeFailures(f);
    await notify({ status: "failed", name: seen.name || DEFAULT_PKG, version: seen.version || "", tag: b.tag,
        branch: b.branch, commit: seen.commit || "", commits: [...new Set((seen.commits || []).concat(b.republish || []))], error: err.message });
}

// ── one publisher at a time ────────────────────────────────────────────────
function lock() {
    const file = path.join(CACHE, "publisher.lock");
    fs.mkdirSync(CACHE, { recursive: true });
    try {
        const pid = parseInt(fs.readFileSync(file, "utf8"), 10);
        if (pid && pid !== process.pid) { process.kill(pid, 0); return false; } // still running
    } catch (_) { /* no lock or a dead process */ }
    fs.writeFileSync(file, String(process.pid));
    const release = () => { try { if (parseInt(fs.readFileSync(file, "utf8"), 10) === process.pid) fs.unlinkSync(file); } catch (_) { /* gone */ } };
    process.on("exit", release);
    ["SIGINT", "SIGTERM"].forEach((s) => process.on(s, () => process.exit(0)));
    return true;
}

// One release run at a time on this machine: the 60 s check and the page's "publish now" wait for each other.
let queue = Promise.resolve();
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

let busy = false;
async function tick() {
    if (busy) return;
    busy = true;
    try {
        await serial(async () => {
            const asked = await republishRequests();
            for (const b of BRANCHES) {
                b.seen = null;
                b.republish = asked[b.branch] || [];
                // An admin asked again: report this run's result even when the error is the one already mailed.
                if (b.republish.length) { log(`${b.branch}: re-publish asked for ${b.republish.length} request(s)`); forgetFailures(b.branch); }
                try { await releaseBranch(b, { grace: b.republish.length ? 0 : GRACE_S }); }
                catch (e) { log(`${b.branch}: ${e.message}`); await reportFailure(b, e); }
            }
        });
    } finally { busy = false; }
}

// ── helper for the tool's page (--serve): npm login + "publish now" on this machine ─────────────────────────────
const REGISTRY_URL = new URL(REGISTRY);
const NPMRC_KEY = `//${REGISTRY_URL.host}${REGISTRY_URL.pathname.replace(/\/?$/, "/")}:_authToken`;

function registryCall(method, pathname, headers, body) {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const u = new URL(pathname.replace(/^\//, ""), REGISTRY_URL.href.replace(/\/?$/, "/"));
        const req = require(u.protocol === "https:" ? "https" : "http").request(u, { method, timeout: 20000,
            headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } }, (res) => {
            let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => {
                let json = {}; try { json = JSON.parse(t) || {}; } catch (_) { /* not JSON */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on("timeout", () => req.destroy(new Error("the registry did not answer (is this machine in the office network / on VPN?)")));
        req.on("error", (e) => reject(new Error(`the registry ${REGISTRY_URL.host} cannot be reached: ${e.message}`)));
        req.end(data);
    });
}

// One-time logins: the page logs an admin in right before a push; the token lives only in this process's memory, for
// ONE publish and at most 10 minutes. Nothing is written to ~/.npmrc and the password is not kept at all.
const TICKET_MS = 10 * 60 * 1000;
const tickets = new Map(); // ticket → { user, token, exp }
function newTicket(user, token) {
    for (const [k, t] of tickets) if (t.exp < Date.now()) tickets.delete(k);
    const ticket = require("crypto").randomBytes(24).toString("hex");
    tickets.set(ticket, { user, token, exp: Date.now() + TICKET_MS });
    return ticket;
}
function useTicket(ticket) {
    const t = tickets.get(String(ticket || ""));
    tickets.delete(String(ticket || "")); // one publish per login
    return t && t.exp > Date.now() ? t : null;
}

/**
 * npm login with a username and password. The password is checked first with a plain "who am I" call, because the
 * registry's login call (the one "npm login" uses) would CREATE the account when the username does not exist.
 */
async function npmLogin(username, password) {
    if (!/^[\w.@-]{1,80}$/.test(username) || !password || password.length > 200) throw new Error("Enter your npm username and password");
    const who = await registryCall("GET", "/-/whoami", { authorization: "Basic " + Buffer.from(`${username}:${password}`).toString("base64") });
    if (who.status >= 500) throw new Error(`the registry answered HTTP ${who.status}`);
    if (String(who.json.username || "").toLowerCase() !== username.toLowerCase()) throw new Error("npm username or password is incorrect");
    const basic = { authorization: "Basic " + Buffer.from(`${username}:${password}`).toString("base64") };
    const res = await registryCall("PUT", `/-/user/org.couchdb.user:${encodeURIComponent(username)}`, basic, // authenticated: returns the token, never adds a user
        { _id: `org.couchdb.user:${username}`, name: username, password, type: "user", roles: [], date: new Date().toISOString() });
    if (!res.json.token) throw new Error(String(res.json.error || res.json.message || `the registry answered HTTP ${res.status} without a token`).slice(0, 300));
    return { user: String(who.json.username), token: String(res.json.token) }; // not saved anywhere
}

/** The pages allowed to call the helper: local dev, the deployed tool (host of RELEASE_NOTIFY_URL, frontend/config.js), PUBLISHER_ORIGINS. */
function allowedOrigins() {
    const list = get("PUBLISHER_ORIGINS", "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
    try { if (NOTIFY_URL) list.push(new URL(NOTIFY_URL).origin); } catch (_) { /* not a URL */ }
    try {
        const host = /cloudHost\s*=\s*'([\w.-]+)'/.exec(fs.readFileSync(path.join(ROOT, "frontend", "config.js"), "utf8"));
        if (host) list.push("https:" + "//" + host[1], "https:" + "//" + host[1].replace(".development.", "."));
    } catch (_) { /* no frontend here */ }
    return new Set(list);
}

function serve() {
    const origins = allowedOrigins();
    const okOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || origins.has(o);
    const server = require("http").createServer((req, res) => {
        const origin = String(req.headers.origin || ""), route = `${req.method} ${String(req.url).split("?")[0]}`;
        const send = (code, body) => {
            res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", vary: "Origin",
                ...(okOrigin(origin) ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS",
                    "access-control-allow-headers": "Content-Type", "access-control-allow-private-network": "true", "access-control-max-age": "600" } : {}) });
            res.end(body ? JSON.stringify(body) : "");
        };
        // Only the tool's own pages, and only by this machine's loopback name (no other web site, no DNS trick).
        if (!okOrigin(origin) || !/^(127\.0\.0\.1|localhost):\d+$/.test(String(req.headers.host || ""))) return send(403, { ok: false, error: "This page is not allowed to use the npm helper" });
        if (req.method === "OPTIONS") return send(204);
        if (route === "GET /status") {
            // oneTimeLogin: this helper asks for the login per push and stores nothing (an older helper lacks the flag).
            return send(200, { ok: true, machine: MACHINE, oneTimeLogin: true, registry: REGISTRY_URL.host, dryRun: DRY, branches: BRANCHES.map((b) => b.branch) });
        }
        if (req.method !== "POST" || !/^application\/json/i.test(String(req.headers["content-type"] || ""))) return send(404, { ok: false, error: "Not found" });
        let text = "";
        req.on("data", (c) => { text += c; if (text.length > 10000) req.destroy(); });
        req.on("end", async () => {
            let body = {}; try { body = JSON.parse(text || "{}") || {}; } catch (_) { return send(400, { ok: false, error: "Bad request" }); }
            try {
                if (route === "POST /login") {
                    const login = await npmLogin(String(body.username || "").trim(), String(body.password || ""));
                    log(`helper: npm login of ${login.user} checked — valid for one publish, nothing stored`);
                    return send(200, { ok: true, user: login.user, ticket: newTicket(login.user, login.token), minutes: TICKET_MS / 60000, machine: MACHINE });
                }
                if (route === "POST /publish") {
                    const b = BRANCHES.find((x) => x.branch === String(body.branch || ""));
                    if (!b) return send(400, { ok: false, error: `This helper does not publish the branch "${String(body.branch || "").slice(0, 80)}"` });
                    // Publish only with the login the admin just typed on the page: its one-time ticket.
                    const login = useTicket(body.ticket);
                    if (!login) return send(200, { ok: false, needLogin: true, error: "the npm login for this publish is missing or older than 10 minutes — log in again" });
                    const out = await serial(async () => {
                        const rc = path.join(CACHE, `login-${process.pid}-${Date.now()}.npmrc`);
                        try {
                            fs.writeFileSync(rc, `${NPMRC_KEY}=${login.token}\n`, { mode: 0o600 });
                            USERCONFIG = rc;
                            // Also the re-publishes admins asked for on this branch (the page asks right after "Re-publish to npm").
                            b.seen = null; b.republish = (await republishRequests())[b.branch] || [];
                            if (b.republish.length) forgetFailures(b.branch);
                            await releaseBranch(b, { grace: 0 });
                            return { ok: true, ...(b.result || {}) };
                        } catch (e) { log(`${b.branch}: ${e.message}`); await reportFailure(b, e); return { ok: false, error: e.message }; }
                        finally { USERCONFIG = ""; try { fs.unlinkSync(rc); } catch (_) { /* gone */ } }
                    });
                    return send(200, { ...out, machine: MACHINE, user: login.user });
                }
                send(404, { ok: false, error: "Not found" });
            } catch (e) {
                if (route === "POST /login") log(`helper: npm login failed — ${e.message}`);
                send(200, { ok: false, error: e.message });
            }
        });
    });
    server.on("error", (e) => { log(`helper: cannot listen on 127.0.0.1:${PORT} — ${e.message}`); process.exit(1); });
    server.listen(PORT, "127.0.0.1", () => log(`helper: listening on 127.0.0.1:${PORT} for the tool's page (npm login + publish from this machine)`));
}

(async () => {
    if (!lock()) { log("another npm publisher is already running on this machine — exiting"); return; }
    log(`npm publisher on ${MACHINE}: ${BRANCHES.map((b) => `${b.branch} → "${b.tag}"`).join(", ")} · registry ${REGISTRY}${DRY ? " · DRY RUN" : ""}${flag("once") ? "" : WATCH ? ` · every ${INTERVAL_S} s` : " · on request only"}`);
    // A one-time login file left by a publish that was killed half way.
    try { for (const f of fs.readdirSync(CACHE)) if (/^login-.*\.npmrc$/.test(f)) fs.unlinkSync(path.join(CACHE, f)); } catch (_) { /* nothing there */ }
    if (SERVE) serve();
    if (!WATCH) return;
    await tick();
    if (flag("once")) return;
    setInterval(tick, INTERVAL_S * 1000);
})();
