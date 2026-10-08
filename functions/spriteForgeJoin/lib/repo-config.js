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

const DEFAULT_BASE_URL     = "https://repository.zohocorpcloud.in";
const DEFAULT_GIT_HOST     = "https://zrepository.zohocorpcloud.in";
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
    files:       ["Sprite/crmutil_icons.svg"],
    pairs:       ["crmutil_icons.svg"],
    blobTemplate:   "{base}/{project}#/source/{branch}/{repo}/{path}",
    branchTemplate: "{base}/{project}#/source/{branch}/{repo}"
};

function load(opts) {
    opts = opts || {};
    const P = opts.prefix || "REPO_";
    const D = opts.defaults || {};
    const env = (k) => str(P + k, "");
    const baseUrl     = str(P + "BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, "");
    const projectPath = str(P + "PROJECT_PATH", D.projectPath || DEFAULT_PROJECT_PATH).replace(/^\/+|\/+$/g, "");
    const repoName    = str(P + "NAME", D.repoName || DEFAULT_REPO_NAME);
    const branch      = str(P + "BRANCH", D.branch || DEFAULT_BRANCH);
    const gitUrl      = str(P + "GIT_URL", `${str(P + "GIT_HOST", DEFAULT_GIT_HOST).replace(/\/+$/, "")}/${projectPath}.git`);
    const token       = str(P + "TOKEN", opts.tokenFallback ? str(opts.tokenFallback, "") : "");
    const tokenUser   = str(P + "TOKEN_USER", "oauth2");
    // File (relative to the repo root) whose "version" is shown at the top of the Library. "" disables it.
    const versionFile = str(P + "VERSION_FILE", D.versionFile !== undefined ? D.versionFile : DEFAULT_VERSION_FILE);
    const provider    = str(P + "PROVIDER", "git").toLowerCase(); // git | gitlab | gitea | github
    const files       = list(P + "FILES", D.files || DEFAULT_FILES);
    const pairs       = list(P + "SPRITE_PAIRS", D.pairs || DEFAULT_PAIRS);
    const folder      = str(P === "REPO_" ? "MASTER_LIBRARY_FOLDER" : P + "FOLDER", D.folder || DEFAULT_FOLDER);
    const requireLogin = bool(P === "REPO_" ? "MASTER_LIBRARY_REQUIRE_LOGIN" : P + "REQUIRE_LOGIN", true);
    const webBlobTemplate = str(P + "WEB_BLOB_URL", D.blobTemplate || "{base}/{project}#/blob/{branch}/{repo}/{path}");
    const webBranchTemplate = str(P + "WEB_BRANCH_URL", D.branchTemplate || "{base}/{project}#/tree/{branch}");
    const authorName  = str(P + "COMMIT_AUTHOR_NAME", "SpriteForge Icon Tool");
    const authorEmail = str(P + "COMMIT_AUTHOR_EMAIL", "spriteforge@zohocorp.com");
    // Per network round-trip limit for the git client, and the overall limit a request waits
    // for the repository before answering with an error (keep it under the platform timeout).
    // Who may commit to the repository (the push itself uses the shared REPO_TOKEN).
    // Comma separated: emails (a@zohocorp.com), domains (@zohocorp.com) or * for every signed-in user.
    const commitUsers = list(P + "COMMIT_USERS", ["*"]).map((x) => x.toLowerCase());
    const httpTimeoutMs = Math.max(3000, parseInt(str(P + "HTTP_TIMEOUT_MS", "20000"), 10) || 20000);
    const requestTimeoutMs = Math.max(5000, parseInt(str(P + "REQUEST_TIMEOUT_MS", "25000"), 10) || 25000);

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

module.exports = { load, loadIconRepo, publicConfig, canCommit, DEFAULT_FILES, DEFAULT_PAIRS };
