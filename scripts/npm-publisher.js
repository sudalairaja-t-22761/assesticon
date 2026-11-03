#!/usr/bin/env node
/**
 * npm release publisher for the icon tool — runs on a machine INSIDE the office network (the Catalyst cloud cannot
 * reach cm-npmregistry). With REPO_NPM_PUBLISH_MODE=external the deployed backend only commits the icon; this script
 * does the release for each watched branch:
 *
 *   new icon commits on the branch since the last resources/package.json change
 *     → bump resources/package.json locally (X.Y.Z-<tag>-N, N = 1..5, then Z+1; versions already on the registry skipped)
 *     → npm publish resources --tag <tag>
 *     → ONLY after a successful publish: commit the version and push it to the branch
 *   publish failed → the bump is dropped (nothing pushed), the admins get one failure mail, the next run retries
 *
 * Every publish (and every new failure) is mailed to the admins through the backend (RELEASE_NOTIFY_URL +
 * RELEASE_NOTIFY_TOKEN in functions/spriteForgeJoin/.env). It uses your own git login (Keychain) and ~/.npmrc.
 *
 *   npm run publisher               # keeps running, checks every 60 s (scripts/install-npm-publisher.sh starts it at login)
 *   npm run publisher -- --once     # one check, then exit
 *   options: --interval 60  --dry-run (npm publish --dry-run, no commit / push)  --force-dry-run (also without new icons)
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.dirname(__dirname);
const { bumpPackageJson } = require(path.join(ROOT, "functions", "spriteForgeJoin", "lib", "npm-release"));
const args = process.argv.slice(2);
const flag = (n) => args.includes("--" + n);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

// Settings come from the backend's .env (same values the server uses); defaults match this project.
function envFile() {
    const out = {};
    try {
        for (const line of fs.readFileSync(path.join(ROOT, "functions", "spriteForgeJoin", ".env"), "utf8").split("\n")) {
            const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
            if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
    } catch (_) { /* no .env: defaults */ }
    return out;
}
const ENV = envFile();
const get = (k, d) => process.env[k] || ENV[k] || d;

const GIT_URL = get("REPO_GIT_URL", "https://zrepository.zohocorpcloud.in/zohocorp/CRM/CRM_UI/CRM_UI_LIBRARY.git");
const REGISTRY = get("REPO_NPM_REGISTRY", ["http", "//cm-npmregistry"].join(":"));
const NPM_DIR = get("REPO_NPM_DIR", "resources");
const PKG = `${NPM_DIR}/package.json`;
const MAX = Math.max(1, parseInt(get("REPO_VERSION_MAX", "5"), 10) || 5);
const BRANCHES = [
    { branch: get("REPO_BRANCH", "CRM_UI_LIBRARY_ICON_TOOL"), versionTag: get("REPO_VERSION_TAG", "icontool") },
    { branch: get("MASTER_REPO_BRANCH", "CRM_UI_LIBRARY_ICON_BRANCH_CLONE"), versionTag: get("MASTER_REPO_VERSION_TAG", "iconclone") }
].map((b, i) => ({ ...b, tag: get(i ? "MASTER_REPO_NPM_DIST_TAG" : "REPO_NPM_DIST_TAG", "") || b.versionTag }));
const INTERVAL_S = Math.max(15, parseInt(opt("interval", "60"), 10) || 60);
const FORCE = flag("force-dry-run");
const DRY = flag("dry-run") || FORCE;
const CACHE = path.join(os.homedir(), ".cache", "sf-npm-publisher");
const NO_HOOKS = path.join(CACHE, "no-hooks"); // the Mac's ~/.git_templates commit hooks break scripted commits
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NOTIFY_URL = get("RELEASE_NOTIFY_URL", "");
const NOTIFY_TOKEN = get("RELEASE_NOTIFY_TOKEN", "");

const log = (...m) => console.log(new Date().toISOString().replace("T", " ").slice(0, 19), ...m);

function run(cmd, argv, opts) {
    return new Promise((resolve, reject) => {
        execFile(cmd, argv, { maxBuffer: 64 * 1024 * 1024, timeout: 300000, ...opts,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", ...(opts && opts.env) } },
        (err, stdout, stderr) => {
            if (err) {
                const what = argv.filter((a) => !a.startsWith("-") && !a.includes("=") && a !== "-C").slice(cmd === "git" ? 1 : 0)[0] || "";
                return reject(new Error(`${path.basename(cmd)} ${what} failed: ${String(stderr || stdout || err.message).trim().split("\n").slice(-3).join(" | ")}`));
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
    await git(dir, ["fetch", "-q", "--depth", "50", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    await git(dir, ["checkout", "-q", "-B", branch, `origin/${branch}`]);
    await git(dir, ["reset", "-q", "--hard", `origin/${branch}`]);
    return dir;
}

/** Commits after the last package.json change that touch resources/ (the icons); deepens a shallow history if needed. */
async function pendingChanges(dir, branch) {
    for (const depth of [50, 300, 2000]) {
        const last = (await git(dir, ["log", "-1", "--format=%H", `origin/${branch}`, "--", PKG])).trim();
        if (last) {
            const lines = (await git(dir, ["log", "--format=%H %s", `${last}..origin/${branch}`, "--", NPM_DIR, `:(exclude)${PKG}`])).trim();
            const list = lines ? lines.split("\n") : [];
            return { last, commits: list.map((l) => l.slice(0, 40)), subjects: list.map((l) => l.slice(41)) };
        }
        if (depth === 2000) break;
        await git(dir, ["fetch", "-q", "--deepen", String(depth), "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    }
    throw new Error(`no commit that changed ${PKG} found on ${branch}`);
}

async function registryVersions(name) {
    try { const v = JSON.parse((await run(NPM, ["view", name, "versions", "--json", "--registry", REGISTRY, "--fetch-retries=1"])) || "[]"); return new Set(Array.isArray(v) ? v : [v]); }
    catch (e) { if (/E404|\b404\b|Not Found/i.test(e.message)) return new Set(); throw e; }
}

function setVersion(file, version) {
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${version}$3`));
}

async function releaseBranch(b) {
    const dir = await workCopy(b.branch);
    const pkgFile = path.join(dir, PKG);
    const text = fs.readFileSync(pkgFile, "utf8"), pkg = JSON.parse(text);
    b.seen = { name: pkg.name, version: pkg.version, commit: (await git(dir, ["rev-parse", "HEAD"])).trim() };
    const taken = await registryVersions(pkg.name);

    // A version committed earlier (deferred mode) but not published yet: publish it as it is, nothing to push.
    const own = new RegExp(`-${b.versionTag}-\\d+$`).test(pkg.version);
    if (own && !taken.has(pkg.version) && !FORCE) {
        log(`${b.branch}: ${pkg.name}@${pkg.version} is committed but not published — publishing it`);
        await publish(dir, b);
        b.seen.commits = [b.seen.commit];
        return notifyPublished(b, pkg.name, pkg.version, b.seen.commit, [`(published the committed version ${pkg.version})`]);
    }

    const { subjects, commits } = await pendingChanges(dir, b.branch);
    b.seen.commits = commits; // the requests whose icons are in this release (timeline on the request page)
    if (!subjects.length && !FORCE) { if (flag("once")) log(`${b.branch}: up to date (${pkg.name}@${pkg.version}, no new icons)`); return; }

    const next = bumpPackageJson(text, { preTag: b.versionTag, preMax: MAX }, taken).to;
    log(`${b.branch}: ${subjects.length} new icon commit(s) → ${pkg.version} → ${next}${DRY ? " (dry run)" : ""}`);
    setVersion(pkgFile, next);
    try { await publish(dir, b); }
    catch (e) { await git(dir, ["checkout", "--", PKG]).catch(() => {}); b.seen.version = next; throw e; } // nothing is pushed
    if (DRY) { await git(dir, ["checkout", "--", PKG]); log(`${b.branch}: dry run OK — would push the version commit ${next}`); return; }

    const commit = await pushVersion(dir, b, next, subjects);
    return notifyPublished(b, pkg.name, next, commit, subjects);
}

async function publish(dir, b) {
    const argv = ["publish", "--registry", REGISTRY, "--tag", b.tag];
    if (DRY) argv.push("--dry-run");
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
            await git(dir, ["fetch", "-q", "--depth", "50", "origin", `+refs/heads/${b.branch}:refs/remotes/origin/${b.branch}`]);
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
        const data = Buffer.from(JSON.stringify(body));
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
    await notify({ status: "failed", name: seen.name || "@zohocrm/crm-ui-library", version: seen.version || "", tag: b.tag,
        branch: b.branch, commit: seen.commit || "", commits: seen.commits || [], error: err.message });
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

let busy = false;
async function tick() {
    if (busy) return;
    busy = true;
    try {
        for (const b of BRANCHES) {
            b.seen = null;
            try { await releaseBranch(b); }
            catch (e) { log(`${b.branch}: ${e.message}`); await reportFailure(b, e); }
        }
    } finally { busy = false; }
}

(async () => {
    if (!lock()) { log("another npm publisher is already running on this machine — exiting"); return; }
    log(`npm publisher: ${BRANCHES.map((b) => `${b.branch} → "${b.tag}"`).join(", ")} · registry ${REGISTRY}${DRY ? " · DRY RUN" : ""}${flag("once") ? "" : ` · every ${INTERVAL_S} s`}`);
    await tick();
    if (flag("once")) return;
    setInterval(tick, INTERVAL_S * 1000);
})();
