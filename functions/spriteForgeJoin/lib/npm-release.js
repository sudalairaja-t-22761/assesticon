"use strict";

/**
 * npm release step of a repository save (REPO_NPM_PUBLISH=true):
 *   bump <dir>/package.json "version" → npm publish <dir> → the bump is committed and pushed with the saved files.
 *
 * Version scheme: X.Y.Z-<tag>-N with N = 1..max. Each save adds 1 to N; after N = max the next save is X.Y.(Z+1)-<tag>-1.
 * A version without that tag (e.g. 1.0.71 or 1.0.71-icon-2) becomes X.Y.Z-<tag>-1.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

function nextVersion(current, tag, max) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+)[-.](\d+))?$/.exec(String(current || "").trim());
    if (!m) throw Object.assign(new Error(`Unexpected package.json version "${current}" (expected X.Y.Z or X.Y.Z-${tag}-N)`), { keep: true, status: 409 });
    const [, a, b, c, t, n] = m;
    if (t === tag && +n < max) return `${a}.${b}.${c}-${tag}-${+n + 1}`;
    if (t === tag) return `${a}.${b}.${+c + 1}-${tag}-1`;
    return `${a}.${b}.${c}-${tag}-1`;
}

/** package.json text with only the "version" value replaced (formatting kept). Skips versions in `taken`. */
function bumpPackageJson(text, npm, taken) {
    const json = JSON.parse(text);
    const from = json.version;
    let to = nextVersion(from, npm.preTag, npm.preMax);
    for (let i = 0; taken && taken.has(to); i++) {
        if (i > 100) throw Object.assign(new Error(`No free version after ${from} on the registry`), { keep: true, status: 409 });
        to = nextVersion(to, npm.preTag, npm.preMax);
    }
    const re = /("version"\s*:\s*")([^"]*)(")/;
    if (!re.test(text)) throw Object.assign(new Error("package.json has no \"version\" field"), { keep: true, status: 409 });
    return { name: json.name, from, to, text: text.replace(re, `$1${to}$3`) };
}

function run(cmd, args, opts, what) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            if (err) {
                const tail = String(stderr || stdout || err.message).split("\n").filter(Boolean).slice(-6).join(" | ");
                return reject(Object.assign(new Error(`${what || "npm publish"} failed: ${tail}`), { keep: true, status: 502 }));
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

/** Versions of `name` already on the registry (empty set when the package is new). Throws when the registry cannot be read. */
async function registryVersions(name, npm) {
    if (!npm.registry) throw Object.assign(new Error("REPO_NPM_REGISTRY is not set"), { keep: true, status: 503 });
    try {
        const r = await run(process.platform === "win32" ? "npm.cmd" : "npm",
            ["view", name, "versions", "--json", "--registry", npm.registry, "--fetch-retries=1"],
            { env: npmEnv(npm).env, timeout: 60000 }, "npm view");
        const v = JSON.parse(r.stdout || "[]");
        return new Set(Array.isArray(v) ? v : [v]);
    } catch (e) {
        if (/E404|404 Not Found/i.test(e.message)) return new Set();
        throw e;
    } finally { npmEnv(npm).cleanup(); }
}

let _rc = null;
/** Env for npm: no notifier/fund/audit; with REPO_NPM_TOKEN a temporary user config holding only that token. */
function npmEnv(npm) {
    const env = { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
    if (!npm.token) return { env, cleanup() {} };
    if (!_rc || !fs.existsSync(_rc)) {
        _rc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sf-npmrc-")), ".npmrc");
        fs.writeFileSync(_rc, `//${npm.registry.replace(/^[a-z]+:\/\//i, "").replace(/\/?$/, "/")}:_authToken=${npm.token}\n`, { mode: 0o600 });
    }
    env.npm_config_userconfig = _rc;
    return { env, cleanup() {} };
}

/**
 * Publish the folder `dir` of commit `oid` (exported with `exportDir`) to the configured registry.
 * @returns {{ name, version, registry, files, dryRun }}
 */
async function publish(exportDir, npm, release) {
    if (!npm.registry) throw Object.assign(new Error("REPO_NPM_REGISTRY is not set"), { keep: true, status: 503 });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "sf-npm-"));
    try {
        const pkgDir = path.join(work, "pkg");
        const files = await exportDir(npm.dir, pkgDir);
        // Always publish under a dist-tag (default: the version tag, e.g. "icontool") so `latest` is never moved by accident.
        const tag = npm.distTag || npm.preTag;
        const args = ["publish", "--registry", npm.registry, "--tag", tag];
        if (npm.dryRun) args.push("--dry-run");
        await run(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: pkgDir, env: npmEnv(npm).env, timeout: npm.timeoutMs || 180000 });
        return { name: release.name, version: release.to, from: release.from, registry: npm.registry, tag, files, dryRun: !!npm.dryRun };
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

module.exports = { nextVersion, bumpPackageJson, registryVersions, publish };
