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

function load() {
    const baseUrl     = str("REPO_BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, "");
    const projectPath = str("REPO_PROJECT_PATH", DEFAULT_PROJECT_PATH).replace(/^\/+|\/+$/g, "");
    const repoName    = str("REPO_NAME", DEFAULT_REPO_NAME);
    const branch      = str("REPO_BRANCH", DEFAULT_BRANCH);
    const gitUrl      = str("REPO_GIT_URL", `${str("REPO_GIT_HOST", DEFAULT_GIT_HOST).replace(/\/+$/, "")}/${projectPath}.git`);
    const token       = str("REPO_TOKEN", "");
    const tokenUser   = str("REPO_TOKEN_USER", "oauth2");
    const provider    = str("REPO_PROVIDER", "git").toLowerCase(); // git | gitlab | gitea | github
    const files       = list("REPO_FILES", DEFAULT_FILES);
    const pairs       = list("REPO_SPRITE_PAIRS", DEFAULT_PAIRS);
    const folder      = str("MASTER_LIBRARY_FOLDER", DEFAULT_FOLDER);
    const requireLogin = bool("MASTER_LIBRARY_REQUIRE_LOGIN", true);
    const webBlobTemplate = str("REPO_WEB_BLOB_URL", "{base}/{project}#/blob/{branch}/{repo}/{path}");
    const webBranchTemplate = str("REPO_WEB_BRANCH_URL", "{base}/{project}#/tree/{branch}");
    const authorName  = str("REPO_COMMIT_AUTHOR_NAME", "SpriteForge Icon Tool");
    const authorEmail = str("REPO_COMMIT_AUTHOR_EMAIL", "spriteforge@zohocorp.com");
    // Per network round-trip limit for the git client, and the overall limit a request waits
    // for the repository before answering with an error (keep it under the platform timeout).
    // Who may commit to the repository (the push itself uses the shared REPO_TOKEN).
    // Comma separated: emails (a@zohocorp.com), domains (@zohocorp.com) or * for every signed-in user.
    const commitUsers = list("REPO_COMMIT_USERS", ["*"]).map((x) => x.toLowerCase());
    const httpTimeoutMs = Math.max(3000, parseInt(str("REPO_HTTP_TIMEOUT_MS", "20000"), 10) || 20000);
    const requestTimeoutMs = Math.max(5000, parseInt(str("REPO_REQUEST_TIMEOUT_MS", "25000"), 10) || 25000);

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

module.exports = { load, publicConfig, canCommit, DEFAULT_FILES, DEFAULT_PAIRS };
