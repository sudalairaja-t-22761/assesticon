"use strict";

/**
 * Repository (ZohoRepository / CRM_UI_LIBRARY) configuration.
 *
 * Everything is read from environment variables so the same code works in
 * local dev (.env), `catalyst serve` and deployed Catalyst (.env.production or
 * Console → Functions → Environment Variables).
 *
 * The personal token is NEVER returned by `publicConfig()`.
 */

const path = require("path");

function str(name, fallback) {
    const v = process.env[name];
    return v === undefined || v === null || String(v).trim() === "" ? fallback : String(v).trim();
}

function list(name, fallback) {
    const raw = str(name, "");
    if (!raw) return fallback;
    return raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function bool(name, fallback) {
    const v = str(name, "");
    if (!v) return fallback;
    return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

// Hosts come from the environment (REPO_BASE_URL / REPO_GIT_URL in .env); the icon repo reuses them unless it sets its own.
const originOf = (u) => { try { return new URL(u).origin; } catch (_) { return ""; } };
const DEFAULT_BASE_URL     = () => str("REPO_BASE_URL", "");
const DEFAULT_GIT_HOST     = () => originOf(str("REPO_GIT_URL", ""));
const DEFAULT_PROJECT_PATH = "zohocorp/CRM/CRM_UI/CRM_UI_LIBRARY";
const DEFAULT_REPO_NAME    = "CRM_UI_LIBRARY";
const DEFAULT_BRANCH       = "CRM_UI_LIBRARY_ICON_TOOL";
const DEFAULT_FOLDER       = "Master_ui_library";
// Where the package.json with the library "version" lives in CRM_UI_LIBRARY (repo-root relative).
const DEFAULT_VERSION_FILE = "resources/package.json";

// Paths are relative to the repository root (the repo root IS the CRM_UI_LIBRARY folder).
// The web UI shows them as <project>#/blob/<branch>/CRM_UI_LIBRARY/<path>.
const DEFAULT_FILES = [
    "resources/images/crmutil_icons.svg",
    "resources/images/svg_cssicons.svg",
    "resources/icon-styles/svg-icons.less",
    "resources/icon-styles/svg-path.less"
];

// Which stylesheet belongs to which sprite. Format: "sprite.svg:styles.less"
const DEFAULT_PAIRS = [
    "crmutil_icons.svg:svg-icons.less",
    "svg_cssicons.svg:svg-path.less"
];

/**
 * Second repository: the Library's icon repo (Iconassest, folder "Sprite"). It is separate from
 * the CRM_UI_LIBRARY settings above and is configured with ICON_REPO_* variables.
 */
const ICON_DEFAULTS = {
    projectPath: "zohocorp/user/sudalairaja.t/Iconassest",
    repoName:    "Iconassest",
    branch:      "default",
    folder:      "Icon_library",
    versionFile: "",                // the Iconassest repo has no package.json
    assetsDir:   "Assets",          // folder with the Asset Store images (any image format)
    files:       ["Sprite/crmutil_icons.svg"],
    pairs:       ["crmutil_icons.svg"],
    blobTemplate:   "{base}/{project}#/source/{branch}/{repo}/{path}",
    branchTemplate: "{base}/{project}#/source/{branch}/{repo}"
};

/**
 * Master library: the same CRM_UI_LIBRARY repository on its own branch (MASTER_REPO_*). Verified icons go
 * UI library (Iconassest) → mock branch (REPO_BRANCH) → master branch (MASTER_REPO_BRANCH, admin push only).
 */
const MASTER_DEFAULTS = {
    branch:     "CRM_UI_LIBRARY_ICON_BRANCH_CLONE",
    folder:     "Master_branch",
    versionTag: "iconclone",   // 1.0.73-icon-2 → 1.0.73-iconclone-1 → … -iconclone-5 → 1.0.74-iconclone-1
    distTag:    "iconclone",   // npm publish --tag (never moves "latest")
    npmPublish: true
};
// Keys MASTER_REPO_* falls back to REPO_* for (same repository, token and registry). Branch, tags and commit users stay its own.
const SHARED_KEYS = ["BASE_URL", "PROJECT_PATH", "NAME", "GIT_URL", "GIT_HOST", "TOKEN", "TOKEN_USER", "PROVIDER", "FILES", "SPRITE_PAIRS",
    "VERSION_FILE", "NPM_PUBLISH", "NPM_DIR", "NPM_REGISTRY", "NPM_TOKEN", "NPM_TIMEOUT_MS", "NPM_DRY_RUN", "VERSION_MAX",
    "COMMIT_AUTHOR_NAME", "COMMIT_AUTHOR_EMAIL", "HTTP_TIMEOUT_MS", "REQUEST_TIMEOUT_MS", "WEB_BLOB_URL", "WEB_BRANCH_URL"];

function load(opts) {
    opts = opts || {};
    const P = opts.prefix || "REPO_";
    const D = opts.defaults || {};
    // A second config of the same repository (MASTER_REPO_*) reuses the REPO_* value of these keys when it does not set its own.
    const F = opts.fallbackPrefix || "";
    const get = (k, def) => str(P + k, F && SHARED_KEYS.includes(k) ? str(F + k, def) : def);
    const getBool = (k, def) => { const v = get(k, ""); return v ? ["1", "true", "yes", "on"].includes(v.toLowerCase()) : def; };
    const getList = (k, def) => { const v = get(k, ""); return v ? v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean) : def; };
    const baseUrl     = get("BASE_URL", DEFAULT_BASE_URL()).replace(/\/+$/, "");
    const projectPath = get("PROJECT_PATH", D.projectPath || DEFAULT_PROJECT_PATH).replace(/^\/+|\/+$/g, "");
    const repoName    = get("NAME", D.repoName || DEFAULT_REPO_NAME);
    const branch      = get("BRANCH", D.branch || DEFAULT_BRANCH);
    const gitUrl      = get("GIT_URL", `${get("GIT_HOST", DEFAULT_GIT_HOST()).replace(/\/+$/, "")}/${projectPath}.git`);
    const token       = get("TOKEN", opts.tokenFallback ? str(opts.tokenFallback, "") : "");
    const tokenUser   = get("TOKEN_USER", "oauth2");
    // File (relative to the repo root) whose "version" is shown at the top of the Library. "" disables it.
    const versionFile = get("VERSION_FILE", D.versionFile !== undefined ? D.versionFile : DEFAULT_VERSION_FILE);
    // Release on every save: bump <npmDir>/package.json "version" (X.Y.Z-<tag>-N, N = 1..max, then Z+1 and N = 1),
    // npm publish that folder to npmRegistry, and commit the bump with the saved files. Off unless NPM_PUBLISH=true.
    const npm = {
        enabled:  getBool("NPM_PUBLISH", !!D.npmPublish),
        dir:      get("NPM_DIR", "resources"),
        registry: get("NPM_REGISTRY", ""),
        token:    get("NPM_TOKEN", ""),     // optional; otherwise the server user's ~/.npmrc login is used
        distTag:  get("NPM_DIST_TAG", D.distTag || ""),  // optional `npm publish --tag`
        preTag:   get("VERSION_TAG", D.versionTag || "icontool"),
        preMax:   Math.max(1, parseInt(get("VERSION_MAX", "5"), 10) || 5),
        dryRun:   getBool("NPM_DRY_RUN", false),
        timeoutMs: Math.max(30000, parseInt(get("NPM_TIMEOUT_MS", "240000"), 10) || 240000)
    };
    const assetsDir   = get("ASSETS_DIR", D.assetsDir !== undefined ? D.assetsDir : "").replace(/^\/+|\/+$/g, "");
    const provider    = get("PROVIDER", "git").toLowerCase(); // git | gitlab | gitea | github
    const files       = getList("FILES", D.files || DEFAULT_FILES);
    const pairs       = getList("SPRITE_PAIRS", D.pairs || DEFAULT_PAIRS);
    const folder      = str(P === "REPO_" ? "MASTER_LIBRARY_FOLDER" : P + "FOLDER", D.folder || DEFAULT_FOLDER);
    const requireLogin = bool(P === "REPO_" ? "MASTER_LIBRARY_REQUIRE_LOGIN" : P + "REQUIRE_LOGIN", true);
    const webBlobTemplate = get("WEB_BLOB_URL", D.blobTemplate || "{base}/{project}#/blob/{branch}/{repo}/{path}");
    const webBranchTemplate = get("WEB_BRANCH_URL", D.branchTemplate || "{base}/{project}#/tree/{branch}");
    const authorName  = get("COMMIT_AUTHOR_NAME", "SpriteForge Icon Tool");
    const authorEmail = get("COMMIT_AUTHOR_EMAIL", "spriteforge@zohocorp.com");
    // Per network round-trip limit for the git client, and the overall limit a request waits
    // for the repository before answering with an error (keep it under the platform timeout).
    // Who may commit to the repository (the push itself uses the shared REPO_TOKEN).
    // Comma separated: emails (a@zohocorp.com), domains (@zohocorp.com) or * for every signed-in user.
    const commitUsers = getList("COMMIT_USERS", ["*"]).map((x) => x.toLowerCase());
    const httpTimeoutMs = Math.max(3000, parseInt(get("HTTP_TIMEOUT_MS", "20000"), 10) || 20000);
    const requestTimeoutMs = Math.max(5000, parseInt(get("REQUEST_TIMEOUT_MS", "25000"), 10) || 25000);

    const fileEntries = files.map((repoPath) => {
        const name = path.posix.basename(repoPath);
        const ext  = path.posix.extname(name).replace(/^\./, "").toLowerCase();
        return {
            name,
            repoPath,
            ext,
            kind: ext === "svg" ? "sprite" : (ext === "less" || ext === "css" ? "styles" : "other"),
            webUrl: fill(webBlobTemplate, { base: baseUrl, project: projectPath, branch, repo: repoName, path: repoPath })
        };
    });

    const pairEntries = pairs.map((p) => {
        const [svg, styles] = p.split(":").map((s) => s && s.trim());
        return { svg, styles: styles || null };
    }).filter((p) => p.svg);

    return {
        baseUrl,
        projectPath,
        repoName,
        branch,
        gitUrl,
        token,
        tokenUser,
        versionFile,
        assetsDir,
        npm,
        provider,
        files: fileEntries,
        pairs: pairEntries,
        folder,
        requireLogin,
        authorName,
        authorEmail,
        httpTimeoutMs,
        requestTimeoutMs,
        commitUsers,
        webUrl: fill(webBranchTemplate, { base: baseUrl, project: projectPath, branch, repo: repoName, path: "" }),
        isConfigured: !!token
    };
}

/**
 * Is this signed-in user allowed to commit? user: { email }
 * @returns {boolean}
 */
function canCommit(cfg, user) {
    const rules = (cfg && cfg.commitUsers) || ["*"];
    const email = String((user && user.email) || "").trim().toLowerCase();
    return rules.some((r) => {
        if (r === "*") return true;
        if (!email) return false;
        if (r.charAt(0) === "@") return email.endsWith(r);
        return email === r;
    });
}

function fill(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? "" : vars[k]));
}

/** Safe-to-send-to-the-browser view (no token). */
function publicConfig(cfg) {
    cfg = cfg || load();
    return {
        baseUrl:     cfg.baseUrl,
        projectPath: cfg.projectPath,
        repoName:    cfg.repoName,
        branch:      cfg.branch,
        provider:    cfg.provider,
        folder:      cfg.folder,
        webUrl:      cfg.webUrl,
        files:       cfg.files,
        pairs:       cfg.pairs,
        requireLogin: cfg.requireLogin,
        configured:  cfg.isConfigured
    };
}

/** Config of the Library icon repo (ICON_REPO_*; token falls back to REPO_TOKEN). */
function loadIconRepo() {
    return load({ prefix: "ICON_REPO_", defaults: ICON_DEFAULTS, tokenFallback: "REPO_TOKEN" });
}

/** Config of the master branch (MASTER_REPO_*; repository, token and registry fall back to REPO_*). */
function loadMasterRepo() {
    return load({ prefix: "MASTER_REPO_", defaults: MASTER_DEFAULTS, fallbackPrefix: "REPO_" });
}

module.exports = { load, loadIconRepo, loadMasterRepo, publicConfig, canCommit, DEFAULT_FILES, DEFAULT_PAIRS };
