"use strict";

// Load environment variables:
// - FORCE_LOCAL_ENV=true  → always load .env (local dev, skips .env.production)
// - otherwise             → .env.production is preferred; .env is fallback
// .env is listed in .catalystignore and NOT uploaded to Catalyst, so
// .env.production is always used in deployed / catalyst-serve environments.
try {
    const dotenv = require("dotenv");
    const fs = require("fs");
    const path = require("path");
    const prodEnv  = path.join(__dirname, ".env.production");
    const localEnv = path.join(__dirname, ".env");
    const forceLocal = String(process.env.FORCE_LOCAL_ENV || "").toLowerCase() === "true";
    if (!forceLocal && fs.existsSync(prodEnv)) {
        dotenv.config({ path: prodEnv });
    } else if (fs.existsSync(localEnv)) {
        dotenv.config({ path: localEnv });
    }
} catch (_) {}

// ===================================
// SVG Sprite Service — Complete Serverless Code
// Fully server-based (NO localStorage dependency)
// ===================================
//
// SETUP REQUIRED:
// -----------------------------------------------
// 1. Go to Catalyst Console → Data Store
// 2. Create a new table called: SpriteRegistry
// 3. Add these columns:
//    ┌──────────────┬──────────┬────────────┐
//    │ Column Name  │ Type     │ Required   │
//    ├──────────────┼──────────┼────────────┤
//    │ sprite_name  │ TEXT     │ Yes        │
//    │ file_id      │ TEXT     │ Yes        │
//    │ file_name    │ TEXT     │ No         │
//    └──────────────┴──────────┴────────────┘
//    (ROWID, CREATEDTIME, MODIFIEDTIME are auto-created)
//
// 4. Go to Settings → Permission → Add this function
//    to the allowed roles for Data Store access.
//
// 5. Ensure File Store folder exists:
//    FOLDER_ID = "32235000000015888"
// -----------------------------------------------

const express = require("express");
const catalyst = require("zcatalyst-sdk-node");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");
const cheerio = require("cheerio");
const { v4: uuidv4 } = require("uuid");
const fsAsync = require("fs").promises;

// ── Local-dev webfont storage (used when Catalyst runtime is unavailable) ────
const LOCAL_WF_DIR   = path.join(os.tmpdir(), "svgforge-wf");
const LOCAL_WF_INDEX = path.join(LOCAL_WF_DIR, "_index.json");

function localWfRead()  { try { return JSON.parse(fs.readFileSync(LOCAL_WF_INDEX, "utf8")); } catch (_) { return { entries: [] }; } }
function localWfWrite(idx) { fs.mkdirSync(LOCAL_WF_DIR, { recursive: true }); fs.writeFileSync(LOCAL_WF_INDEX, JSON.stringify(idx, null, 2)); }

// ── Catalyst Stratus object storage — zcatalyst-sdk-node ─────────────────────
// The bucket name is taken from STRATUS_BUCKET_NAME (preferred) or derived from
// STRATUS_BUCKET_URL by stripping the environment suffix that the SDK re-adds:
//   https://publicsvg-development.lzstratus.com → "publicsvg"
// The Stratus domain suffix is also extracted so the SDK targets the right DC.
const _stratusBucketUrl = (process.env.STRATUS_BUCKET_URL || "").replace(/\/+$/, "");
const _stratusHostname  = (() => { try { return new URL(_stratusBucketUrl).hostname; } catch (_) { return ""; } })();
const _stratusLabel     = _stratusHostname.split(".")[0] || "";  // e.g. "publicsvg-development"
// Export the domain suffix before the SDK is required (it snapshots it at load time).
if (_stratusHostname && !process.env.X_ZOHO_STRATUS_RESOURCE_SUFFIX) {
    const dot = _stratusHostname.indexOf(".");
    if (dot > -1) process.env.X_ZOHO_STRATUS_RESOURCE_SUFFIX = _stratusHostname.slice(dot);
}
const STRATUS_BUCKET_NAME = (() => {
    if (process.env.STRATUS_BUCKET_NAME) return process.env.STRATUS_BUCKET_NAME.trim();
    const env = (process.env.ZC_ENVIRONMENT || "development").trim().toLowerCase();
    return env && _stratusLabel.toLowerCase().endsWith(`-${env}`)
        ? _stratusLabel.slice(0, -(env.length + 1))
        : _stratusLabel;
})();

/** True when the Catalyst runtime has injected credential headers. */
function isCatalystRuntime(req) {
    return !!(req && req.headers && (req.headers["x-zc-projectid"] || req.headers["x-zc-admin-cred-token"]));
}

/**
 * True when Stratus should be used:
 * - Always in Catalyst runtime (production / catalyst serve)
 * - In local dev when ZC_PROJECT_ID + STRATUS_BUCKET_NAME are both set
 *   AND STRATUS_ALLOW_LOCAL_FALLBACK is not "true"
 */
function shouldUseStratus(req) {
    if (isCatalystRuntime(req)) return true;
    if (String(process.env.STRATUS_ALLOW_LOCAL_FALLBACK || "").toLowerCase() === "true") return false;
    return !!(process.env.ZC_PROJECT_ID && STRATUS_BUCKET_NAME);
}

/**
 * Build a synthetic basicio-compatible object for the SDK.
 * The SDK accepts:
 *   - advancedio: { headers: { 'x-zc-projectid': ..., 'x-zc-admin-cred-token': ... } }
 *   - basicio:    { catalystHeaders: { same headers } }
 *
 * We use advancedio format: wrap env vars into a fake req-like object with a
 * `headers` property so catalyst.initialize() treats it as an Advanced I/O call.
 */
function _fakeReqFromEnv() {
    const projectId  = process.env.ZC_PROJECT_ID  || "";
    const projectKey = process.env.ZC_PROJECT_KEY  || "";
    const credToken  = process.env.ZC_ADMIN_CRED_TOKEN || "";
    const credType   = process.env.ZC_ADMIN_CRED_TYPE  || "zoho";
    const environment = process.env.ZC_ENVIRONMENT || "development";
    if (!projectId || !projectKey) return null;
    return {
        headers: {
            "x-zc-projectid":        projectId,
            "x-zc-project-key":      projectKey,
            "x-zc-admin-cred-type":  credType,
            "x-zc-admin-cred-token": credToken,
            // SDK also requires a user-level credential. Since we are acting as admin,
            // set the same ticket as the user token so `userToken` is not undefined.
            "x-zc-user-cred-type":   credType,
            "x-zc-user-cred-token":  credToken,
            "x-zc-environment":      environment,
            "x-zc-user-type":        "admin"   // tells SDK currentUser = admin
        }
    };
}

/** Bucket instance — uses admin scope so deletePath/deleteObject are allowed. */
function stratusBucket(req) {
    if (!STRATUS_BUCKET_NAME) throw new Error("STRATUS_BUCKET_NAME is not configured");

    let initObj;
    if (isCatalystRuntime(req)) {
        // Production / catalyst serve: use real request (has runtime headers)
        initObj = req;
    } else {
        // Local dev with env credentials: build a fake req with catalyst headers
        initObj = _fakeReqFromEnv();
        if (!initObj) throw new Error("Local Stratus requires ZC_PROJECT_ID and ZC_PROJECT_KEY in .env");
    }

    const instance = catalyst.initialize(initObj, { scope: "admin" });
    if (typeof instance.stratus !== "function") throw new Error("zcatalyst-sdk-node does not expose Stratus — upgrade to 3.x");
    return instance.stratus().bucket(STRATUS_BUCKET_NAME);
}

/** Drain a stream/Buffer/string returned by getObject() into a Buffer. */
async function _drainStream(body) {
    if (!body) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === "string") return Buffer.from(body, "utf8");
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function stratusPut(req, key, buf, ct) {
    const { Readable } = require("stream");
    await stratusBucket(req).putObject(key, Readable.from(buf), {
        overwrite: true,
        contentType: ct || "application/octet-stream"
    });
}
async function stratusGet(req, key) {
    return _drainStream(await stratusBucket(req).getObject(key));
}
async function stratusDelete(req, key) {
    try { await stratusBucket(req).deleteObject(key); }
    catch (e) { console.warn(`[stratus] deleteObject(${key}) warn:`, e.message); }
}
async function stratusDeletePath(req, prefix) {
    const p = String(prefix || "").replace(/\/*$/, "/");
    await stratusBucket(req).deletePath(p);
}
async function stratusReadIndex(req, sub) {
    try { return JSON.parse((await stratusGet(req, `${sub}/webfonts/_index.json`)).toString("utf8")); }
    catch (_) { return { entries: [] }; }
}
async function stratusWriteIndex(req, sub, idx) {
    await stratusPut(req, `${sub}/webfonts/_index.json`,
        Buffer.from(JSON.stringify(idx, null, 2), "utf8"), "application/json");
}

const app = express();
app.use(express.json({ limit: "10mb" }));

// Resolved before the CORS middleware so the handler can reference it
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin || "";
    let isLocalOrigin = false;
    try { const u = new URL(origin); isLocalOrigin = u.hostname === "localhost" || u.hostname === "127.0.0.1"; } catch (_) {}
    if (!origin || isLocalOrigin || ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin || "*");
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-session-id");
    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }
    next();
});

const FOLDER_ID = process.env.FOLDER_ID || "37672000000012906";
const TABLE_NAME = "SpriteForgeRegistry";

const ZOHO_ACCOUNTS_BASE = process.env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.in";
const ZOHO_AUTH_URL = `${ZOHO_ACCOUNTS_BASE}/oauth/v2/auth`;
const ZOHO_TOKEN_URL = `${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`;
const ZOHO_USERINFO_URL = `${ZOHO_ACCOUNTS_BASE}/oauth/v2/userinfo`;
const ZOHO_FALLBACK_AVATAR_URL = `${ZOHO_ACCOUNTS_BASE}/oauth/user/photo`;

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || "";
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "";
const ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || "";
const ZOHO_SCOPE = process.env.ZOHO_SCOPE || "openid,email,profile,phone";

// Returns the redirect URI to use:
// - For localhost: use the supplied origin + "/" (matches Zoho registered localhost URI)
// - For allowlisted production origins: always return ZOHO_REDIRECT_URI (exact registered path)
// - Fallback: ZOHO_REDIRECT_URI
function resolveRedirectUri(redirectOrigin) {
    // Only add trailing slash if the URI has no path (i.e. it is just an origin like http://localhost:3000)
    const normalise = (uri) => {
        if (!uri) return uri;
        try {
            const u = new URL(uri);
            // If path is "/" or empty, ensure trailing slash; otherwise keep path exactly as-is
            if (u.pathname === "/" || u.pathname === "") return uri.replace(/\/?$/, "/");
            return uri; // has a real path — do NOT add trailing slash
        } catch (_) { return uri; }
    };
    if (!redirectOrigin) return normalise(ZOHO_REDIRECT_URI);
    try {
        const parsed = new URL(redirectOrigin);
        const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
        if (isLocal) {
            // Local dev: use the supplied origin with trailing slash
            return normalise(redirectOrigin);
        }
        // Production allowlisted origin: use the full registered ZOHO_REDIRECT_URI exactly
        const originOnly = parsed.origin;
        if (ALLOWED_ORIGINS.includes(redirectOrigin) || ALLOWED_ORIGINS.includes(originOnly)) {
            return normalise(ZOHO_REDIRECT_URI);
        }
    } catch (_) { /* invalid URL — fall through */ }
    return normalise(ZOHO_REDIRECT_URI);
}

const AUTH_ENFORCE = String(process.env.AUTH_ENFORCE || "false").toLowerCase() === "true";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const AVATAR_MAX_BYTES = Number(process.env.AVATAR_MAX_BYTES || 2 * 1024 * 1024);
// Derive allowed avatar host from ZOHO_ACCOUNTS_BASE so localzoho.com works too.
const ALLOWED_AVATAR_HOST_REGEX = (() => {
    try {
        const host   = new URL(ZOHO_ACCOUNTS_BASE).hostname;
        const domain = host.replace(/^accounts\./, "");
        const esc    = domain.replace(/\./g, "\\.");
        return new RegExp(`(^|\\.)${esc}$`, "i");
    } catch (_) { return /(^|\.)zoho\.in$/i; }
})();

function decodeJwtPayload(token) {
    if (!token || token.split(".").length < 2) return null;
    try {
        const payload = token.split(".")[1];
        const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
        const json = Buffer.from(normalized, "base64").toString("utf8");
        return JSON.parse(json);
    } catch (error) {
        console.warn("id_token decode failed:", error.message);
        return null;
    }
}

// Sessions are stateless HMAC-signed tokens so they survive serverless cold
// starts and work across instances (an in-memory Map loses them on refresh).
const SESSION_SECRET = process.env.SESSION_SECRET || ZOHO_CLIENT_SECRET || "";
const avatarCache = new Map(); // best-effort only; avatar is too large for a header token

function b64url(buf) {
    return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signSessionBody(body) {
    return b64url(crypto.createHmac("sha256", SESSION_SECRET).update(body).digest());
}

function createSession(payload) {
    const user = payload.user || {};
    const pz = payload.zohoProfile || {};
    const data = {
        user: {
            id: user.id || null,
            email: user.email || null,
            name: user.name || null,
            picture: user.picture || null,
            avatar: null,
            avatarHash: user.avatarHash || null
        },
        zohoProfile: { sub: pz.sub || null, email: pz.email || null, name: pz.name || null },
        createdAt: Date.now()
    };
    const body = b64url(JSON.stringify(data));
    const sessionId = body + "." + signSessionBody(body);
    if (user.avatar) {
        avatarCache.set(sessionId, user.avatar);
        if (avatarCache.size > 200) avatarCache.delete(avatarCache.keys().next().value);
    }
    return sessionId;
}

function getSession(req) {
    const headerSessionId = req.headers["x-session-id"];
    const querySessionId = req.query && typeof req.query.session_id === "string"
        ? req.query.session_id
        : "";
    const sessionId = headerSessionId || querySessionId;
    if (!sessionId || typeof sessionId !== "string" || !SESSION_SECRET) return null;

    const dot = sessionId.indexOf(".");
    if (dot < 1) return null;
    const body = sessionId.slice(0, dot);
    const sig = Buffer.from(sessionId.slice(dot + 1));
    const expected = Buffer.from(signSessionBody(body));
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;

    let session;
    try { session = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); }
    catch (_) { return null; }
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) return null;

    const cached = avatarCache.get(sessionId);
    if (cached) session.user.avatar = cached;
    return { sessionId, session };
}

function requireSession(req, res, next) {
    const current = getSession(req);
    if (!current) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized. Missing or invalid session."
        });
    }
    req.auth = current;
    next();
}

async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let json;
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        json = { raw: text };
    }
    return { response, json, text };
}

async function fetchAvatarDataUri(accessToken, primaryUrl) {
    const candidates = [];
    if (primaryUrl) candidates.push(primaryUrl);
    candidates.push(ZOHO_FALLBACK_AVATAR_URL);

    for (const url of candidates) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" || !ALLOWED_AVATAR_HOST_REGEX.test(parsed.hostname)) {
                continue;
            }

            const resp = await fetch(parsed.toString(), {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            if (!resp.ok) continue;

            const contentType = (resp.headers.get("content-type") || "").toLowerCase();
            if (!contentType.startsWith("image/")) continue;

            const buffer = Buffer.from(await resp.arrayBuffer());
            if (!buffer.length || buffer.length > AVATAR_MAX_BYTES) continue;

            return {
                dataUri: `data:${contentType};base64,${buffer.toString("base64")}`,
                hash: crypto.createHash("sha256").update(buffer).digest("hex"),
                contentType,
                byteLength: buffer.length
            };
        } catch (error) {
            console.warn("Avatar fetch failed:", error.message);
        }
    }

    return null;
}

function isProtectedPath(pathname) {
    return pathname === "/save-sprite"
        || pathname.startsWith("/check-sprite/")
        || pathname.startsWith("/find-sprite/")
        || pathname === "/list-sprites"
        || pathname.startsWith("/get-sprite/")
        || pathname.startsWith("/sprite/")
        || pathname.startsWith("/delete-sprite/")
        || pathname === "/svgwebfont";
}

app.use((req, res, next) => {
    if (!AUTH_ENFORCE) return next();
    if (!isProtectedPath(req.path)) return next();
    return requireSession(req, res, next);
});

// ===================================
// AUTH: Build Zoho Login URL
// ===================================
app.get("/api/auth/zoho/url", (req, res) => {
    const hasRedirectOrigin = !!req.query.redirect_origin;
    if (!ZOHO_CLIENT_ID || (!ZOHO_REDIRECT_URI && !hasRedirectOrigin)) {
        return res.status(500).json({
            success: false,
            message: "Missing ZOHO_CLIENT_ID or ZOHO_REDIRECT_URI"
        });
    }

    const authUrl = new URL(ZOHO_AUTH_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", ZOHO_CLIENT_ID);
    authUrl.searchParams.set("scope", ZOHO_SCOPE);
    authUrl.searchParams.set("redirect_uri", resolveRedirectUri(req.query.redirect_origin));
    authUrl.searchParams.set("access_type", "offline");

    res.status(200).json({ success: true, url: authUrl.toString() });
});

// ===================================
// AUTH: Exchange code and create session
// ===================================
app.post("/api/auth/zoho/callback", async (req, res) => {
    try {
        const { code, redirect_origin } = req.body || {};
        if (!code) {
            return res.status(400).json({ success: false, message: "Missing authorization code" });
        }

        if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
            return res.status(500).json({
                success: false,
                message: "Missing Zoho OAuth configuration"
            });
        }

        const form = new URLSearchParams({
            grant_type: "authorization_code",
            client_id: ZOHO_CLIENT_ID,
            client_secret: ZOHO_CLIENT_SECRET,
            redirect_uri: resolveRedirectUri(redirect_origin),
            code
        });

        const tokenData = await fetchJson(ZOHO_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form
        });

        if (!tokenData.response.ok || !tokenData.json.access_token) {
            return res.status(400).json({
                success: false,
                message: "Token exchange failed",
                details: tokenData.json
            });
        }

        const accessToken = tokenData.json.access_token;
        const idTokenPayload = decodeJwtPayload(tokenData.json.id_token);

        const userInfoData = await fetchJson(ZOHO_USERINFO_URL, {
            method: "GET",
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const userInfo = userInfoData.response.ok ? userInfoData.json : {};

        const mergedProfile = {
            ...idTokenPayload,
            ...userInfo
        };

        const userId = mergedProfile.sub || mergedProfile.user_id || mergedProfile.email;
        const avatarCandidate = mergedProfile.picture || mergedProfile.profile_picture;
        const avatar = await fetchAvatarDataUri(accessToken, avatarCandidate);

        const user = {
            id: userId || null,
            email: mergedProfile.email || null,
            name: mergedProfile.name || mergedProfile.given_name || mergedProfile.email || "Zoho User",
            picture: avatarCandidate || null,
            avatar: avatar ? avatar.dataUri : null,
            avatarHash: avatar ? avatar.hash : null
        };

        const sessionId = createSession({
            user,
            zohoProfile: mergedProfile,
            accessToken,
            refreshToken: tokenData.json.refresh_token || null
        });

        // Persist user profile on first login; deduplicate by userEmail
        let userDataStatus = "not_attempted";
        try {
            const ca    = catalyst.initialize(req);
            const zcql  = ca.zcql();
            const safe  = (user.email || "").replace(/'/g, "''");
            const rows  = await zcql.executeZCQLQuery(
                `SELECT ROWID FROM user_data WHERE userEmail = '${safe}'`
            );
            if (rows && rows.length) {
                userDataStatus = `exists (ROWID ${rows[0].user_data && rows[0].user_data.ROWID})`;
            } else {
                const inserted = await ca.datastore().table(49699000000329011).insertRow({
                    userName:   user.name                            || "",
                    userEmail:  user.email                           || "",
                    userAvatar: user.picture                         || "",
                    userid:     String(mergedProfile.sub || user.id || "")
                });
                userDataStatus = `inserted (ROWID ${inserted && inserted.ROWID})`;
            }
        } catch (dsErr) {
            userDataStatus = `error: ${dsErr.message}`;
            console.error("[user_data] error:", dsErr.message);
        }
        console.log("[user_data] status:", userDataStatus);

        res.status(200).json({
            success: true,
            sessionId,
            user,
            zohoProfile:    mergedProfile,
            userDataStatus  // visible in browser dev tools Network tab
        });
    } catch (error) {
        console.error("ZOHO CALLBACK ERROR:", error);
        res.status(500).json({ success: false, message: error.message || "OAuth callback failed" });
    }
});

// ===================================
// AUTH: Validate session
// ===================================
app.get("/api/auth/session", (req, res) => {
    const current = getSession(req);
    if (!current) {
        return res.status(401).json({ success: false, message: "Invalid session" });
    }

    res.status(200).json({
        success: true,
        sessionId: current.sessionId,
        user: current.session.user,
        zohoProfile: current.session.zohoProfile
    });
});

// ===================================
// AUTH: Logout
// ===================================
app.post("/api/auth/logout", (req, res) => {
    const sessionId = req.headers["x-session-id"];
    if (sessionId && typeof sessionId === "string") {
        avatarCache.delete(sessionId);
    }
    res.status(200).json({ success: true, message: "Logged out" });
});

// ===================================
// Optional avatar proxy (allowlisted)
// ===================================
app.get("/api/avatar/proxy", async (req, res) => {
    try {
        const encoded = req.query.url;
        if (!encoded || typeof encoded !== "string") {
            return res.status(400).json({ success: false, message: "Missing url query param" });
        }

        const targetUrl = Buffer.from(encoded, "base64").toString("utf8");
        const parsed = new URL(targetUrl);
        if (parsed.protocol !== "https:" || !ALLOWED_AVATAR_HOST_REGEX.test(parsed.hostname)) {
            return res.status(400).json({ success: false, message: "Avatar URL not allowed" });
        }

        const response = await fetch(parsed.toString());
        if (!response.ok) {
            return res.status(400).json({ success: false, message: "Failed to fetch avatar" });
        }

        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (!contentType.startsWith("image/")) {
            return res.status(400).json({ success: false, message: "Invalid avatar content type" });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > AVATAR_MAX_BYTES) {
            return res.status(400).json({ success: false, message: "Avatar too large" });
        }

        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=300");
        res.status(200).send(buffer);
    } catch (error) {
        console.error("AVATAR PROXY ERROR:", error);
        res.status(500).json({ success: false, message: "Avatar proxy failed" });
    }
});

// ===================================
// DEBUG: full DataStore + header diagnostic (remove after confirming working)
// ===================================
app.get("/api/test-userdata", async (req, res) => {
    const catalystHeaders = ["x-zc-projectid","x-zc-project-key","x-zc-admin-cred-token",
                             "x-zc-admin-cred-type","x-zc-environment"].reduce((acc, k) => {
        acc[k] = req.headers[k] ? "present" : "MISSING";
        return acc;
    }, {});
    try {
        const ca      = catalyst.initialize(req);
        const zcql    = ca.zcql();
        const rows    = await zcql.executeZCQLQuery("SELECT ROWID FROM user_data");
        const inserted = await ca.datastore().table(49699000000329011).insertRow({
            userName: "test", userEmail: "test@test.com", userAvatar: "", userid: "test-sub"
        });
        res.json({ success: true, catalystInit: "ok", catalystHeaders,
                   existingCount: rows && rows.length, insertedROWID: inserted && inserted.ROWID });
    } catch (err) {
        res.json({ success: false, catalystHeaders, error: err.message });
    }
});

// ===================================
// HEALTH CHECK
// ===================================
app.all("/", (req, res) => {
    res.status(200).send("SVG Sprite Service is Live. Endpoints: POST /save-sprite, GET /sprite/:name, GET /find-sprite/:name, GET /get-sprite/:fileId, GET /list-sprites, DELETE /delete-sprite/:name");
});

// ===================================
// LIST FOLDERS (used by icon-library.js in local/non-hosted mode)
// Returns saved sprites as a flat folder list compatible with the frontend.
// ===================================
app.get("/api/list-folders", async (req, res) => {
    // No Catalyst runtime — return empty so the frontend falls back to localStorage
    if (!isCatalystRuntime(req)) {
        return res.status(200).json({ success: true, folders: [], _note: "local fallback — no Catalyst credentials" });
    }
    try {
        const catalystApp = catalyst.initialize(req);
        const zcql = catalystApp.zcql();
        const result = await zcql.executeZCQLQuery(
            `SELECT sprite_name, file_id, file_name, CREATEDTIME FROM ${TABLE_NAME} ORDER BY CREATEDTIME DESC`
        );
        // Group sprites as if each is a folder containing one SVG file
        const folders = (result || []).map(row => {
            const record = row[TABLE_NAME];
            const spriteName = record.sprite_name || "";
            const fileName   = record.file_name   || (spriteName + ".svg");
            return {
                name:  spriteName,
                kind:  "icon",
                files: [{ name: fileName, size: 0, fileId: record.file_id }]
            };
        });
        res.status(200).json({ success: true, folders });
    } catch (error) {
        console.error("[api/list-folders] ERROR:", error.message);
        res.status(200).json({ success: true, folders: [], _error: error.message });
    }
});

// ===================================
// SAVE FOLDER / ICON (used by icon-library.js in local non-hosted mode)
// In local dev this gracefully returns a Catalyst-style error so the frontend
// falls back to localStorage. In production the route is never called because
// the hosted path (CATALYST_API_BASE save-sprite) is used instead.
// ===================================
app.post("/api/save-folder", (req, res) => {
    res.status(200).json({
        status: "failure",
        data: { error_code: "FUNCTION_UNAVAILABLE", message: "save-folder is not available in local dev — icon saved to localStorage" }
    });
});

// ── Sprite index helpers (mirrors webfont local pattern) ─────────────────────
const LOCAL_SP_DIR   = path.join(os.tmpdir(), "svgforge-sp");
const LOCAL_SP_INDEX = path.join(LOCAL_SP_DIR, "_index.json");
function localSpRead()  { try { return JSON.parse(fs.readFileSync(LOCAL_SP_INDEX, "utf8")); } catch (_) { return { entries: [] }; } }
function localSpWrite(idx) { fs.mkdirSync(LOCAL_SP_DIR, { recursive: true }); fs.writeFileSync(LOCAL_SP_INDEX, JSON.stringify(idx, null, 2)); }

// ===================================
// MASTER UI LIBRARY — CRM_UI_LIBRARY icon files read DIRECTLY from the repository
// (2 sprites + 2 LESS), cached in memory only — nothing is stored in Stratus.
// Visible to every signed-in user; saves are committed + pushed to REPO_BRANCH.
// Config: REPO_* / MASTER_LIBRARY_* env vars (see .env.example).
// Routes: /api/master-library/{config,sync,file,save,test-connection}
// ===================================
const { createMasterLibraryRouter } = require("./routes/master-library");
app.use("/api/master-library", createMasterLibraryRouter({
    getSession,
    requireSession
}));

// Second repository: the Library page's icon repo (Iconassest / Sprite), configured with
// ICON_REPO_* variables. Same routes as above under /api/icon-library. The Saved Sprites /
// Update Sprite flow keeps using /api/master-library (CRM_UI_LIBRARY) unchanged.
app.use("/api/icon-library", createMasterLibraryRouter({
    getSession,
    requireSession,
    cfg: require("./lib/repo-config").loadIconRepo(),
    tag: "icon-library",
    tokenVar: "ICON_REPO_TOKEN"
}));

// ===================================
// SAVE SPRITE (new endpoint — local disk + Stratus, no Catalyst DataStore needed)
// POST /api/save-sprite
// Body: { spriteName, svgContent, cssContent }
// ===================================
app.post("/api/save-sprite", async (req, res) => {
    try {
        const { spriteName, svgContent, cssContent } = req.body || {};
        if (!spriteName || !svgContent) {
            return res.status(400).json({ success: false, message: "Missing spriteName or svgContent" });
        }

        const safeName = String(spriteName).replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 64);
        const now      = new Date();
        const pad      = n => String(n).padStart(2, "0");
        const datePart = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
        const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const entryId  = `${datePart}_${timePart}_${safeName}`;
        const savedAt  = now.toISOString();

        const inStratus = shouldUseStratus(req);

        if (inStratus) {
            const folderKey = `savedsprites/${entryId}`;
            await stratusPut(req, `${folderKey}/${safeName}.svg`, Buffer.from(svgContent, "utf8"), "image/svg+xml");
            if (cssContent) {
                await stratusPut(req, `${folderKey}/${safeName}.css`, Buffer.from(cssContent, "utf8"), "text/css");
            }
            // Update index
            let index;
            try { index = JSON.parse((await stratusGet(req, "savedsprites/_index.json")).toString("utf8")); }
            catch (_) { index = { entries: [] }; }
            // Remove old entry with same spriteName if any (replace mode)
            index.entries = index.entries.filter(e => e.spriteName !== safeName);
            index.entries.unshift({ id: entryId, spriteName: safeName, savedAt, folderKey, hasCss: !!cssContent });
            await stratusPut(req, "savedsprites/_index.json", Buffer.from(JSON.stringify(index, null, 2), "utf8"), "application/json");
            console.log(`[save-sprite] Saved to Stratus: ${folderKey}`);
            return res.json({ success: true, id: entryId, spriteName: safeName, savedAt, message: "Sprite saved to Stratus" });
        }

        // ── Local disk fallback ───────────────────────────────────────────────
        const localDir = path.join(LOCAL_SP_DIR, entryId);
        fs.mkdirSync(localDir, { recursive: true });
        fs.writeFileSync(path.join(localDir, `${safeName}.svg`), svgContent, "utf8");
        if (cssContent) fs.writeFileSync(path.join(localDir, `${safeName}.css`), cssContent, "utf8");

        const idx = localSpRead();
        // Replace existing entry with same spriteName
        idx.entries = idx.entries.filter(e => e.spriteName !== safeName);
        idx.entries.unshift({ id: entryId, spriteName: safeName, savedAt, localDir, hasCss: !!cssContent });
        localSpWrite(idx);

        console.log(`[save-sprite] Saved locally: ${localDir}`);
        return res.json({ success: true, id: entryId, spriteName: safeName, savedAt, message: "Sprite saved locally" });

    } catch (err) {
        console.error("[save-sprite]", err);
        return res.status(500).json({ success: false, message: err.message || "Save failed" });
    }
});

// ===================================
// LIST SAVED SPRITES (new endpoint)
// GET /api/list-saved-sprites
// ===================================
app.get("/api/list-saved-sprites", async (req, res) => {
    try {
        const inStratus = shouldUseStratus(req);

        if (inStratus) {
            let index;
            try { index = JSON.parse((await stratusGet(req, "savedsprites/_index.json")).toString("utf8")); }
            catch (_) { index = { entries: [] }; }
            const sprites = (index.entries || []).map(e => ({
                id:         e.id,
                spriteName: e.spriteName,
                savedAt:    e.savedAt || null,
                folderKey:  e.folderKey,
                hasCss:     !!e.hasCss
            }));
            return res.json({ success: true, sprites });
        }

        // ── Local disk fallback ───────────────────────────────────────────────
        const idx = localSpRead();
        const sprites = idx.entries.map(e => ({
            id:         e.id,
            spriteName: e.spriteName,
            savedAt:    e.savedAt || null,
            folderKey:  `local:${e.id}`,
            hasCss:     !!e.hasCss,
            localDir:   e.localDir
        }));
        return res.json({ success: true, sprites });

    } catch (err) {
        console.error("[list-saved-sprites]", err);
        return res.status(500).json({ success: false, message: err.message || "List failed" });
    }
});

// ===================================
// GET SPRITE SVG CONTENT
// GET /api/get-sprite-file?key=...
// ===================================
app.get("/api/get-sprite-file", async (req, res) => {
    const key = String(req.query.key || "");
    if (!key) return res.status(400).json({ success: false, message: "Missing key" });

    if (key.startsWith("local:")) {
        const rest     = key.slice(6);
        const slash    = rest.indexOf("/");
        const entryId  = rest.slice(0, slash);
        const fname    = rest.slice(slash + 1);
        const idx      = localSpRead();
        const entry    = idx.entries.find(e => e.id === entryId);
        if (!entry) return res.status(404).send("Not found");
        const fpath = path.join(entry.localDir, fname);
        if (!fs.existsSync(fpath)) return res.status(404).send("File not found");
        res.setHeader("Content-Type", fname.endsWith(".css") ? "text/css" : "image/svg+xml");
        return res.sendFile(fpath);
    }

    try {
        const buf  = await stratusGet(req, key);
        const fname = key.split("/").pop() || "file";
        res.setHeader("Content-Type", fname.endsWith(".css") ? "text/css" : "image/svg+xml");
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.send(buf);
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
});

// ===================================
// DELETE SAVED SPRITE (new endpoint)
// DELETE /api/delete-saved-sprite/:id
// ===================================
app.delete("/api/delete-saved-sprite/:id", async (req, res) => {
    try {
        const entryId   = req.params.id;
        const inStratus = shouldUseStratus(req);

        if (inStratus) {
            let index;
            try { index = JSON.parse((await stratusGet(req, "savedsprites/_index.json")).toString("utf8")); }
            catch (_) { index = { entries: [] }; }
            const entry = (index.entries || []).find(e => e.id === entryId);
            if (!entry) return res.status(404).json({ success: false, message: "Not found" });
            await Promise.all([
                stratusDelete(req, `${entry.folderKey}/${entry.spriteName}.svg`),
                entry.hasCss ? stratusDelete(req, `${entry.folderKey}/${entry.spriteName}.css`) : Promise.resolve()
            ]);
            index.entries = index.entries.filter(e => e.id !== entryId);
            await stratusPut(req, "savedsprites/_index.json", Buffer.from(JSON.stringify(index, null, 2), "utf8"), "application/json");
            return res.json({ success: true });
        }

        // ── Local disk fallback ───────────────────────────────────────────────
        const idx   = localSpRead();
        const entry = idx.entries.find(e => e.id === entryId);
        if (!entry) return res.status(404).json({ success: false, message: "Not found" });
        if (entry.localDir) { try { fs.rmSync(entry.localDir, { recursive: true, force: true }); } catch (_) {} }
        idx.entries = idx.entries.filter(e => e.id !== entryId);
        localSpWrite(idx);
        return res.json({ success: true });

    } catch (err) {
        console.error("[delete-saved-sprite]", err);
        return res.status(500).json({ success: false, message: err.message || "Delete failed" });
    }
});

app.delete("/api/delete-file/:folder/:file", (req, res) => {
    res.status(200).json({ success: true, _note: "local dev no-op" });
});

app.delete("/api/delete-folder/:folder", (req, res) => {
    res.status(200).json({ success: true, _note: "local dev no-op" });
});

// ===================================
// CHECK IF SPRITE EXISTS BY NAME
// ===================================
app.get("/check-sprite/:name", async (req, res) => {
    try {
        const catalystApp = catalyst.initialize(req);
        const zcql = catalystApp.zcql();
        const name = decodeURIComponent(req.params.name).replace(/'/g, "''");

        const result = await zcql.executeZCQLQuery(
            `SELECT sprite_name, file_id, CREATEDTIME FROM ${TABLE_NAME} WHERE sprite_name = '${name}'`
        );

        if (result && result.length > 0) {
            res.status(200).json({ exists: true, sprite: result[0][TABLE_NAME] });
        } else {
            res.status(200).json({ exists: false });
        }
    } catch (error) {
        console.error("CHECK ERROR:", error);
        res.status(500).json({ exists: false, message: error.message });
    }
});

// ===================================
// SAVE SVG SPRITE
// Uploads to File Store + registers name→fileId in Data Store
// Accepts optional `mode` in body: "replace" (default) or "new"
// ===================================
app.post("/save-sprite", async (req, res) => {
    if (!isCatalystRuntime(req)) {
        return res.status(503).json({ success: false, message: "Sprite save requires Catalyst runtime. Use `catalyst serve` or deploy to Catalyst." });
    }
    try {
        const catalystApp = catalyst.initialize(req);
        const folder = catalystApp.filestore().folder(FOLDER_ID);
        const table = catalystApp.datastore().table(TABLE_NAME);
        const zcql = catalystApp.zcql();

        const { spriteName, svgContent, mode } = req.body;

        if (!spriteName || !svgContent) {
            return res.status(400).json({
                success: false,
                message: "Missing spriteName or svgContent"
            });
        }

        const saveMode = mode || "replace"; // "replace" or "new"

        // Check for existing sprite
        const escapedName = spriteName.replace(/'/g, "''");
        const existing = await zcql.executeZCQLQuery(
            `SELECT ROWID, file_id FROM ${TABLE_NAME} WHERE sprite_name = '${escapedName}'`
        );

        // If mode is "new" and name exists, generate unique name
        let finalName = spriteName;
        if (saveMode === "new" && existing && existing.length > 0) {
            let counter = 1;
            let candidateName = `${spriteName}(${counter})`;
            let candidateEscaped = candidateName.replace(/'/g, "''");
            let check = await zcql.executeZCQLQuery(
                `SELECT ROWID FROM ${TABLE_NAME} WHERE sprite_name = '${candidateEscaped}'`
            );
            while (check && check.length > 0) {
                counter++;
                candidateName = `${spriteName}(${counter})`;
                candidateEscaped = candidateName.replace(/'/g, "''");
                check = await zcql.executeZCQLQuery(
                    `SELECT ROWID FROM ${TABLE_NAME} WHERE sprite_name = '${candidateEscaped}'`
                );
            }
            finalName = candidateName;
            console.log(`Mode=new: renamed "${spriteName}" → "${finalName}"`);
        }

        // Sanitize file name
        const safeName = finalName.replace(/[^a-zA-Z0-9-_()]/g, "_");
        const fileName = safeName.endsWith(".svg") ? safeName : `${safeName}.svg`;
        const filePath = path.join("/tmp", fileName);

        // Write SVG to temp file and upload
        fs.writeFileSync(filePath, svgContent);

        const uploadResult = await folder.uploadFile({
            code: fs.createReadStream(filePath),
            name: fileName
        });

        // Clean up temp file
        fs.unlinkSync(filePath);

        const fileId = String(uploadResult.id || uploadResult.file_id);
        console.log("Upload result — fileId:", fileId, "fileName:", fileName);

        // Check if this finalName already exists in Data Store (for replace mode)
        const finalEscaped = finalName.replace(/'/g, "''");
        const finalExisting = (saveMode === "new")
            ? [] // new mode already has a unique name
            : (existing || []);

        if (finalExisting.length > 0) {
            // Delete the OLD file from File Store to avoid orphans
            const oldFileId = finalExisting[0][TABLE_NAME].file_id;
            if (oldFileId) {
                try {
                    await folder.deleteFile(oldFileId);
                    console.log(`Deleted old file ${oldFileId} from File Store`);
                } catch (delErr) {
                    console.warn(`Could not delete old file ${oldFileId}:`, delErr.message);
                    // Continue anyway — the old file becomes orphaned but save still works
                }
            }

            // Update existing record with new fileId
            const rowId = finalExisting[0][TABLE_NAME].ROWID;
            await table.updateRow({
                ROWID: rowId,
                file_id: fileId,
                file_name: fileName
            });
            console.log(`Updated existing record ROWID=${rowId} for "${finalName}" (old file ${oldFileId} → new file ${fileId})`);
        } else {
            // Insert new record
            await table.insertRow({
                sprite_name: finalName,
                file_id: fileId,
                file_name: fileName
            });
            console.log(`Inserted new record for "${finalName}"`);
        }

        res.status(200).json({
            success: true,
            message: "Sprite saved successfully",
            fileId: fileId,
            fileName: fileName,
            spriteName: finalName
        });

    } catch (error) {
        console.error("SAVE ERROR:", error);
        res.status(500).json({
            success: false,
            message: error.message || "Error saving sprite"
        });
    }
});

// ===================================
// FIND SPRITE BY NAME
// Looks up fileId from Data Store by sprite name
// ===================================
app.get("/find-sprite/:name", async (req, res) => {
    try {
        const catalystApp = catalyst.initialize(req);
        const zcql = catalystApp.zcql();
        const name = decodeURIComponent(req.params.name);
        const escapedName = name.replace(/'/g, "''");

        console.log("Finding sprite by name:", name);

        const result = await zcql.executeZCQLQuery(
            `SELECT file_id, file_name, sprite_name, CREATEDTIME FROM ${TABLE_NAME} WHERE sprite_name = '${escapedName}'`
        );

        if (result && result.length > 0) {
            const row = result[0][TABLE_NAME];
            res.status(200).json({
                success: true,
                fileId: row.file_id,
                fileName: row.file_name,
                spriteName: row.sprite_name,
                createdAt: row.CREATEDTIME
            });
        } else {
            res.status(404).json({
                success: false,
                message: `Sprite "${name}" not found`
            });
        }

    } catch (error) {
        console.error("FIND ERROR:", error);
        res.status(500).json({
            success: false,
            message: error.message || "Error finding sprite"
        });
    }
});

// ===================================
// LIST ALL SPRITES
// Returns all saved sprite names with their fileIds.
// In standalone local runs (no Catalyst runtime headers) returns an empty list
// gracefully instead of crashing with app/invalid_project_details.
// ===================================
app.get("/list-sprites", async (req, res) => {
    // Standalone local run — no Catalyst credentials present.
    if (!isCatalystRuntime(req)) {
        return res.status(200).json({ success: true, count: 0, sprites: [],
            _note: "Catalyst credentials unavailable — saved sprites require `catalyst serve`" });
    }
    try {
        const catalystApp = catalyst.initialize(req);
        const zcql = catalystApp.zcql();
        const result = await zcql.executeZCQLQuery(
            `SELECT sprite_name, file_id, file_name, CREATEDTIME FROM ${TABLE_NAME} ORDER BY CREATEDTIME DESC`
        );
        const sprites = (result || []).map(row => ({
            name: row[TABLE_NAME].sprite_name,
            fileId: row[TABLE_NAME].file_id,
            fileName: row[TABLE_NAME].file_name,
            createdAt: row[TABLE_NAME].CREATEDTIME
        }));
        console.log(`Found ${sprites.length} sprites`);
        res.status(200).json({ success: true, count: sprites.length, sprites });
    } catch (error) {
        console.error("LIST ERROR:", error);
        res.status(500).json({ success: false, message: error.message || "Error listing sprites" });
    }
});

// ===================================
// RETRIEVE SVG SPRITE BY FILE ID
// Downloads actual SVG from File Store
// ===================================
app.get("/get-sprite/:fileId", async (req, res) => {
    try {
        const catalystApp = catalyst.initialize(req);
        const folder = catalystApp.filestore().folder(FOLDER_ID);
        const fileId = req.params.fileId;

        console.log("Downloading file by ID:", fileId);

        const fileContent = await folder.downloadFile(fileId);

        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 24h

        if (Buffer.isBuffer(fileContent)) {
            res.status(200).send(fileContent);
        } else if (fileContent && typeof fileContent.pipe === "function") {
            fileContent.pipe(res);
        } else {
            res.status(200).send(fileContent);
        }

    } catch (error) {
        console.error("RETRIEVE ERROR:", error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: error.message || "Error retrieving sprite"
            });
        }
    }
});

// ===================================
// RETRIEVE SVG SPRITE BY NAME (single URL)
// Looks up name in Data Store → downloads from File Store
// This is the URL you share / use as background-image
// Usage: GET /sprite/icon1  or  GET /sprite/icon1.svg
// ===================================
app.get("/sprite/:name", async (req, res) => {
    if (!isCatalystRuntime(req)) {
        return res.status(404).json({ success: false, message: "Sprite endpoint requires Catalyst runtime. Use /api/get-sprite-file for local dev." });
    }
    try {
        const catalystApp = catalyst.initialize(req);
        const zcql = catalystApp.zcql();
        const folder = catalystApp.filestore().folder(FOLDER_ID);

        let name = decodeURIComponent(req.params.name);
        // Strip .svg extension if provided for lookup
        const lookupName = name.replace(/\.svg$/i, "");
        const escapedName = lookupName.replace(/'/g, "''");

        console.log("Sprite by name:", lookupName);
        console.log("ZCQL query:", `SELECT file_id FROM ${TABLE_NAME} WHERE sprite_name = '${escapedName}'`);

        // Look up fileId from Data Store
        const result = await zcql.executeZCQLQuery(
            `SELECT file_id FROM ${TABLE_NAME} WHERE sprite_name = '${escapedName}'`
        );

        console.log("ZCQL result:", JSON.stringify(result));

        if (!result || result.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Sprite "${lookupName}" not found`
            });
        }

        const fileId = result[0][TABLE_NAME].file_id;
        console.log("Resolved fileId:", fileId, "type:", typeof fileId);

        // Download from File Store — pass as string (same as working /get-sprite endpoint)
        const fileContent = await folder.downloadFile(fileId);

        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "public, max-age=86400");

        if (Buffer.isBuffer(fileContent)) {
            res.status(200).send(fileContent);
        } else if (fileContent && typeof fileContent.pipe === "function") {
            fileContent.pipe(res);
        } else {
            res.status(200).send(fileContent);
        }

    } catch (error) {
        console.error("SPRITE BY NAME ERROR:", error.message, error.stack);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: error.message || "Error retrieving sprite by name"
            });
        }
    }
});

// ===================================
// DELETE SPRITE BY NAME
// Removes from both File Store and Data Store
// ===================================
app.delete("/delete-sprite/:name", async (req, res) => {
    try {
        const catalystApp = catalyst.initialize(req);
        const zcql = catalystApp.zcql();
        const name = decodeURIComponent(req.params.name);
        const escapedName = name.replace(/'/g, "''");

        console.log("Deleting sprite:", name);

        // Find the record
        const result = await zcql.executeZCQLQuery(
            `SELECT ROWID, file_id FROM ${TABLE_NAME} WHERE sprite_name = '${escapedName}'`
        );

        if (!result || result.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Sprite "${name}" not found`
            });
        }

        const row = result[0][TABLE_NAME];
        const fileId = row.file_id;
        const rowId = row.ROWID;

        // Delete from File Store
        try {
            await catalystApp.filestore().folder(FOLDER_ID).deleteFile(parseInt(fileId));
            console.log("File deleted from File Store:", fileId);
        } catch (e) {
            console.warn("File delete failed (may already be deleted):", e.message);
        }

        // Delete from Data Store
        const table = catalystApp.datastore().table(TABLE_NAME);
        await table.deleteRow(rowId);
        console.log("Record deleted from Data Store:", rowId);

        res.status(200).json({
            success: true,
            message: `Sprite "${name}" deleted successfully`
        });

    } catch (error) {
        console.error("DELETE ERROR:", error);
        res.status(500).json({
            success: false,
            message: error.message || "Error deleting sprite"
        });
    }
});

// ===================================
// WEBFONT: SVG files → WOFF2/WOFF/TTF/EOT/CSS icon font
// ===================================

const WEBFONT_FOLDER_ID = process.env.WEBFONT_FOLDER_ID || "";

const WF_SKIP_ID = /^(stop|path\d|gradient|linear|radial|clip|filter|mask|title|defs|layer|svg|metadata|guide|grid|perspective|base|namedview)/i;

let _wfSvgtofont;
async function _getWfSvgtofont() {
    if (!_wfSvgtofont) { const m = await import("svgtofont"); _wfSvgtofont = m.default; }
    return _wfSvgtofont;
}

function wfSanitizeName(raw, fallback) {
    return String(raw || "").replace(/\.svg$/i, "").replace(/[^a-zA-Z0-9]/g, "-")
        .toLowerCase().replace(/-+/g, "-").replace(/^-+|-+$/g, "") || fallback || "icon";
}

function wfPrepSvg(svgText) {
    // Strip XML declaration — cheerio/svgtofont's css-what parser treats the
    // whole file content as a CSS selector when an <?xml …?> prolog is present.
    const cleaned = svgText.replace(/^<\?xml[^?]*\?>\s*/i, "");
    try {
        const $d = cheerio.load(cleaned, { xmlMode: true });
        const $svg = $d("svg");
        if (!$svg.length) return svgText;
        if (!$svg.attr("viewBox")) {
            const w = parseFloat($svg.attr("width")) || 24;
            const h = parseFloat($svg.attr("height")) || 24;
            $svg.attr("viewBox", `0 0 ${w} ${h}`);
        }
        $svg.removeAttr("width").removeAttr("height");
        if (($svg.attr("fill") || "").toLowerCase() === "none") $svg.removeAttr("fill");
        $svg.removeAttr("stroke");
        return $d.html();
    } catch (_) { return svgText; }
}

async function wfReadBuf(p) {
    try { return await fsAsync.readFile(p); } catch (_) { return null; }
}

function wfParseGlyphs(css, fontName) {
    const glyphs = [];
    const re = new RegExp(`\\.${fontName}-([\\w-]+):before\\s*\\{[^}]*content:\\s*["']\\\\([0-9a-fA-F]+)["']`, "gi");
    let m;
    while ((m = re.exec(css)) !== null) glyphs.push({ name: m[1], cp: m[2].toLowerCase() });
    return glyphs;
}

async function wfUploadFont(folder, fileName, buffer) {
    const tmp = `/tmp/${uuidv4()}-${fileName}`;
    await fsAsync.writeFile(tmp, buffer);
    try {
        const result = await folder.uploadFile({ code: fs.createReadStream(tmp), name: fileName });
        return String(result.id || result.file_id);
    } finally {
        await fsAsync.unlink(tmp).catch(() => {});
    }
}

const wfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 500 },
    fileFilter(req, file, cb) {
        cb(null, file.mimetype === "image/svg+xml" || file.originalname.toLowerCase().endsWith(".svg"));
    }
});

app.post("/generate", wfUpload.array("files", 500), async (req, res) => {
    const fontName = wfSanitizeName(req.body.fontName, "iconfont");
    const mode     = req.body.mode === "sprite" ? "sprite" : "files";
    const files    = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No SVG files received" });

    const tmpDir  = `/tmp/wf-${uuidv4()}`;
    const srcDir  = `${tmpDir}/src`;
    const distDir = `${tmpDir}/dist`;

    try {
        await fsAsync.mkdir(srcDir,  { recursive: true });
        await fsAsync.mkdir(distDir, { recursive: true });

        const iconNames = [];
        const uniq = base => { let n = base, i = 2; while (iconNames.includes(n)) n = `${base}-${i++}`; return n; };

        if (mode === "sprite") {
            const $ = cheerio.load(files[0].buffer.toString("utf8"), { xmlMode: true });
            const elById = {};
            $("[id]").each((_, el) => { elById[$(el).attr("id")] = el; });
            $("symbol[id]").each(async (_, sym) => {
                const rawId = $(sym).attr("id");
                if (!rawId || WF_SKIP_ID.test(rawId)) return;
                const $sym = $(sym).clone();
                $sym.find("use").each((_, use) => {
                    const href = ($(use).attr("href") || $(use).attr("xlink:href") || "").replace(/^#/, "");
                    if (href && elById[href]) $(use).replaceWith($(elById[href]).clone());
                });
                const vb   = $(sym).attr("viewBox") || "0 0 24 24";
                const name = uniq(wfSanitizeName(rawId));
                iconNames.push(name);
                await fsAsync.writeFile(`${srcDir}/${name}.svg`, wfPrepSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${$sym.html() || ""}</svg>`), "utf8");
            });
            $("svg > path[id], svg > g[id]").each(async (_, el) => {
                const rawId = $(el).attr("id");
                if (!rawId || WF_SKIP_ID.test(rawId)) return;
                const rootVb = $("svg").attr("viewBox") || `0 0 ${parseFloat($("svg").attr("width")) || 24} ${parseFloat($("svg").attr("height")) || 24}`;
                const name   = uniq(wfSanitizeName(rawId));
                iconNames.push(name);
                await fsAsync.writeFile(`${srcDir}/${name}.svg`, wfPrepSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${rootVb}">${$.html(el)}</svg>`), "utf8");
            });
        } else {
            for (const file of files) {
                const name = uniq(wfSanitizeName(file.originalname.replace(/\.svg$/i, "")));
                iconNames.push(name);
                await fsAsync.writeFile(`${srcDir}/${name}.svg`, wfPrepSvg(file.buffer.toString("utf8")), "utf8");
            }
        }

        if (!iconNames.length) {
            await fsAsync.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            return res.status(400).json({ error: "No valid icons found" });
        }

        const svgtofont = await _getWfSvgtofont();
        await svgtofont({
            src: srcDir, dist: distDir, fontName, css: true, startUnicode: 0xe001,
            svgicons2svgfont: { fontHeight: 1000, normalize: true, fixedWidth: true, centerHorizontally: true }
        });

        const [woff2Buf, woffBuf, ttfBuf, eotBuf, svgBuf] = await Promise.all([
            wfReadBuf(`${distDir}/${fontName}.woff2`),
            wfReadBuf(`${distDir}/${fontName}.woff`),
            wfReadBuf(`${distDir}/${fontName}.ttf`),
            wfReadBuf(`${distDir}/${fontName}.eot`),
            wfReadBuf(`${distDir}/${fontName}.svg`)
        ]);

        // ── Save to Catalyst File Store ──────────────────────────────────────
        const stored = {};
        if (WEBFONT_FOLDER_ID) {
            try {
                const folder = catalyst.initialize(req).filestore().folder(WEBFONT_FOLDER_ID);
                const ts     = Date.now();
                await Promise.all([
                    woff2Buf && wfUploadFont(folder, `${fontName}-${ts}.woff2`, woff2Buf).then(id => { stored.woff2 = id; }),
                    woffBuf  && wfUploadFont(folder, `${fontName}-${ts}.woff`,  woffBuf).then(id  => { stored.woff  = id; }),
                    ttfBuf   && wfUploadFont(folder, `${fontName}-${ts}.ttf`,   ttfBuf).then(id   => { stored.ttf   = id; }),
                    eotBuf   && wfUploadFont(folder, `${fontName}-${ts}.eot`,   eotBuf).then(id   => { stored.eot   = id; }),
                    svgBuf   && wfUploadFont(folder, `${fontName}-${ts}.svg`,   svgBuf).then(id   => { stored.svg   = id; }),
                ].filter(Boolean));
                console.log("[webfont] saved to File Store:", stored);
            } catch (storeErr) {
                console.warn("[webfont] File Store save failed:", storeErr.message);
            }
        }

        let genCss = "";
        for (const p of [`${distDir}/${fontName}.css`, `${distDir}/css/${fontName}.css`]) {
            try { genCss = await fsAsync.readFile(p, "utf8"); break; } catch (_) {}
        }

        let glyphs = wfParseGlyphs(genCss, fontName);
        if (!glyphs.length && svgBuf) {
            const $sf = cheerio.load(svgBuf.toString("utf8"), { xmlMode: true });
            $sf("glyph[unicode]").each((_, g) => {
                const unicode = $sf(g).attr("unicode") || "", gname = $sf(g).attr("glyph-name") || "";
                const cp = unicode.codePointAt(0);
                if (gname && cp && cp >= 0xe001) glyphs.push({ name: gname, cp: cp.toString(16) });
            });
        }
        if (!glyphs.length) glyphs = iconNames.map((name, i) => ({ name, cp: (0xe001 + i).toString(16) }));

        const ts       = Date.now();
        const srcParts = [
            eotBuf   ? `url("${fontName}.eot?t=${ts}#iefix") format("embedded-opentype")` : null,
            woff2Buf ? `url("${fontName}.woff2?t=${ts}") format("woff2")`  : null,
            woffBuf  ? `url("${fontName}.woff?t=${ts}") format("woff")`    : null,
            ttfBuf   ? `url("${fontName}.ttf?t=${ts}") format("truetype")` : null,
            svgBuf   ? `url("${fontName}.svg?t=${ts}#${fontName}") format("svg")` : null
        ].filter(Boolean).join(",\n       ");

        const css = [
            `@font-face {`, `  font-family: "${fontName}";`,
            eotBuf ? `  src: url("${fontName}.eot?t=${ts}");` : null,
            `  src: ${srcParts};`, `  font-weight: normal;`, `  font-style: normal;`, `}`, ``,
            `[class^="${fontName}-"], [class*=" ${fontName}-"] {`,
            `  font-family: "${fontName}" !important;`, `  speak: none;`, `  font-style: normal;`,
            `  font-weight: normal;`, `  font-variant: normal;`, `  text-transform: none;`,
            `  line-height: 1;`, `  -webkit-font-smoothing: antialiased;`,
            `  -moz-osx-font-smoothing: grayscale;`, `}`, ``,
            ...glyphs.map(g => `.${fontName}-${g.name}:before { content: "\\${g.cp}"; }`)
        ].filter(l => l !== null).join("\n");

        const previewHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${fontName}</title><link rel="stylesheet" href="${fontName}.css"><style>body{font-family:-apple-system,sans-serif;padding:24px;background:#f8f9fa;margin:0}h1{color:#1a1a2e;margin-bottom:4px}.sub{color:#666;margin-bottom:24px;font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:12px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 8px;text-align:center;cursor:pointer;transition:all .15s}.card:hover{box-shadow:0 4px 16px rgba(0,0,0,.1);border-color:#6366f1}.card i{font-size:28px;display:block;margin-bottom:8px;color:#374151}.card span{font-size:10px;color:#6b7280;display:block;word-break:break-all}.t{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:#1e293b;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;transition:transform .2s;pointer-events:none}.t.show{transform:translateX(-50%) translateY(0)}</style></head><body><h1>${fontName}</h1><p class="sub">${glyphs.length} icon${glyphs.length !== 1 ? "s" : ""} &mdash; click to copy class</p><div class="grid">${glyphs.map(g => `<div class="card" onclick="cp('${fontName} ${fontName}-${g.name}')"><i class="${fontName} ${fontName}-${g.name}"></i><span>${g.name}</span></div>`).join("")}</div><div class="t" id="t">Copied!</div><script>function cp(c){navigator.clipboard.writeText(c).catch(function(){var x=document.createElement("textarea");x.value=c;document.body.appendChild(x);x.select();document.execCommand("copy");document.body.removeChild(x)});var t=document.getElementById("t");t.classList.add("show");setTimeout(function(){t.classList.remove("show")},2000)}</script></body></html>`;

        res.json({
            fontName,
            icons:       glyphs.map(g => g.name),
            css,
            previewHtml,
            stored,
            fonts: {
                woff2: woff2Buf ? woff2Buf.toString("base64") : null,
                woff:  woffBuf  ? woffBuf.toString("base64")  : null,
                ttf:   ttfBuf   ? ttfBuf.toString("base64")   : null,
                eot:   eotBuf   ? eotBuf.toString("base64")   : null,
                svg:   svgBuf   ? svgBuf.toString("base64")   : null
            }
        });

    } catch (err) {
        console.error("[webfont]", err);
        res.status(500).json({ error: err.message || "Font generation failed" });
    } finally {
        fsAsync.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

// ===================================
// SAVE WEBFONT
// Stratus: webfonts/YYYY-MM-DD_HHmmss_fontName/  — date-time folder, no auth required
// Index:   webfonts/_index.json  — global catalogue
// Local fallback: os.tmpdir()/svgforge-wf/
// ===================================
app.post("/save-webfont", async (req, res) => {
    try {
        const { fontName, fonts, css, previewHtml } = req.body || {};

        if (!fontName || !fonts) {
            return res.status(400).json({ success: false, message: "Missing fontName or fonts" });
        }

        const safeName = String(fontName).replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 32);
        const ts       = Date.now();

        // Build human-readable date-time folder name: YYYY-MM-DD_HHmmss_fontName
        const dtObj    = new Date(ts);
        const pad      = n => String(n).padStart(2, "0");
        const datePart = `${dtObj.getFullYear()}-${pad(dtObj.getMonth()+1)}-${pad(dtObj.getDate())}`;
        const timePart = `${pad(dtObj.getHours())}${pad(dtObj.getMinutes())}${pad(dtObj.getSeconds())}`;
        const entryId  = `${datePart}_${timePart}_${safeName}`;
        const folderKey = `webfonts/${entryId}`;

        const inCatalyst = shouldUseStratus(req);

        if (inCatalyst) {
            // Upload all font files to Stratus under the date-time folder
            const uploads = [];
            const fontMimes = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", eot: "application/vnd.ms-fontobject", svg: "image/svg+xml" };
            for (const [ext, mime] of Object.entries(fontMimes)) {
                if (fonts[ext]) uploads.push(stratusPut(req, `${folderKey}/${safeName}.${ext}`, Buffer.from(fonts[ext], "base64"), mime));
            }
            if (css)         uploads.push(stratusPut(req, `${folderKey}/${safeName}.css`,          Buffer.from(css, "utf8"),         "text/css"));
            if (previewHtml) uploads.push(stratusPut(req, `${folderKey}/${safeName}_preview.html`, Buffer.from(previewHtml, "utf8"), "text/html"));

            await Promise.all(uploads);

            // Update global index
            let index;
            try { index = JSON.parse((await stratusGet(req, "webfonts/_index.json")).toString("utf8")); }
            catch (_) { index = { entries: [] }; }

            index.entries.unshift({ id: entryId, fontName: safeName, ts: String(ts), folderKey, savedAt: dtObj.toISOString() });

            await stratusPut(req, "webfonts/_index.json", Buffer.from(JSON.stringify(index, null, 2), "utf8"), "application/json");

            console.log(`[save-webfont] Saved to Stratus: ${folderKey}`);
            return res.json({ success: true, id: entryId, fontName: safeName, folderKey, savedAt: dtObj.toISOString(), message: "WebFont saved to Stratus successfully" });
        }

        // ── Local development fallback ──────────────────────────────────────────
        const localDir = path.join(LOCAL_WF_DIR, entryId);
        fs.mkdirSync(localDir, { recursive: true });

        const savedFiles = {};
        for (const t of ["woff2", "woff", "ttf", "eot", "svg"]) {
            if (fonts[t]) {
                fs.writeFileSync(path.join(localDir, `${safeName}.${t}`), Buffer.from(fonts[t], "base64"));
                savedFiles[t] = true;
            }
        }
        if (css)         { fs.writeFileSync(path.join(localDir, `${safeName}.css`),          css,         "utf8"); savedFiles.css  = true; }
        if (previewHtml) { fs.writeFileSync(path.join(localDir, `${safeName}_preview.html`), previewHtml, "utf8"); savedFiles.html = true; }

        const idx = localWfRead();
        idx.entries.unshift({ id: entryId, fontName: safeName, ts: String(ts), localDir, savedAt: dtObj.toISOString(), files: savedFiles });
        localWfWrite(idx);

        console.log(`[save-webfont] Saved locally: ${localDir}`);
        return res.json({ success: true, id: entryId, fontName: safeName, savedAt: dtObj.toISOString(), message: "WebFont saved locally" });

    } catch (err) {
        console.error("[save-webfont]", err);
        return res.status(500).json({ success: false, message: err.message || "Save failed" });
    }
});

// ===================================
// LIST ALL SAVED WEBFONTS (no auth required — global bucket listing)
// ===================================
app.get("/list-webfonts", async (req, res) => {
    try {
        const inCatalyst = shouldUseStratus(req);

        if (inCatalyst) {
            let index;
            try { index = JSON.parse((await stratusGet(req, "webfonts/_index.json")).toString("utf8")); }
            catch (_) { index = { entries: [] }; }

            const fonts = (index.entries || []).map(e => ({
                id:        e.id,
                fontName:  e.fontName,
                ts:        e.ts,
                savedAt:   e.savedAt || null,
                folderKey: e.folderKey
            }));
            return res.json({ success: true, fonts });
        }

        // ── Local-dev fallback ────────────────────────────────────────────────
        const idx = localWfRead();
        const fonts = idx.entries.map(e => ({
            id:        e.id,
            fontName:  e.fontName,
            ts:        e.ts,
            savedAt:   e.savedAt || null,
            folderKey: `local:${e.id}`,
            files:     e.files || {}
        }));
        return res.json({ success: true, fonts });

    } catch (err) {
        console.error("[list-webfonts]", err);
        res.status(500).json({ success: false, message: err.message || "List failed" });
    }
});

// ===================================
// DELETE SAVED WEBFONT — removes Stratus objects + updates index (no auth required)
// ===================================
app.delete("/delete-webfont/:id", async (req, res) => {
    try {
        const entryId    = req.params.id;
        const inCatalyst = shouldUseStratus(req);

        if (inCatalyst) {
            let index;
            try { index = JSON.parse((await stratusGet(req, "webfonts/_index.json")).toString("utf8")); }
            catch (_) { index = { entries: [] }; }

            const entry = (index.entries || []).find(e => e.id === entryId);
            if (!entry) return res.status(404).json({ success: false, message: "Not found" });

            const fk   = entry.folderKey;
            const name = entry.fontName;
            await Promise.all(
                ["woff2","woff","ttf","eot","svg","css"].map(ext => stratusDelete(req, `${fk}/${name}.${ext}`))
                    .concat([stratusDelete(req, `${fk}/${name}_preview.html`)])
            );
            index.entries = index.entries.filter(e => e.id !== entryId);
            await stratusPut(req, "webfonts/_index.json", Buffer.from(JSON.stringify(index, null, 2), "utf8"), "application/json");
            return res.json({ success: true });
        }

        // ── Local-dev fallback ────────────────────────────────────────────────
        const idx   = localWfRead();
        const entry = idx.entries.find(e => e.id === entryId);
        if (!entry) return res.status(404).json({ success: false, message: "Not found" });
        if (entry.localDir) { try { fs.rmSync(entry.localDir, { recursive: true, force: true }); } catch (_) {} }
        idx.entries = idx.entries.filter(e => e.id !== entryId);
        localWfWrite(idx);
        return res.json({ success: true });

    } catch (err) {
        console.error("[delete-webfont]", err);
        res.status(500).json({ success: false, message: err.message || "Delete failed" });
    }
});

// ===================================
// DOWNLOAD WEBFONT FILE
// Stratus: GET /get-webfont-file?key={sub}/webfonts/{entryId}/{filename}
// Local:   GET /get-webfont-file?key=local:{entryId}/{filename}
// ===================================
app.get("/get-webfont-file", async (req, res) => {
    const key = String(req.query.key || "");
    if (!key) return res.status(400).json({ success: false, message: "Missing key param" });

    if (key.startsWith("local:")) {
        const rest    = key.slice(6);
        const slash   = rest.indexOf("/");
        const entryId = rest.slice(0, slash);
        const fname   = rest.slice(slash + 1);
        const idx     = localWfRead();
        const entry   = idx.entries.find(e => e.id === entryId);
        if (!entry) return res.status(404).send("Not found");
        const fpath   = path.join(entry.localDir, fname);
        if (!fs.existsSync(fpath)) return res.status(404).send("File not found");
        res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
        return res.sendFile(fpath);
    }

    try {
        const buffer = await stratusGet(req, key);
        const fname  = key.split("/").pop() || "download";
        res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.send(buffer);
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
});

// ============================================================
// ICON LIBRARY — Stratus: library/_index.json + library/{name}.svg
//                Local:   os.tmpdir()/svgforge-lib/_index.json
// ============================================================

const LOCAL_LIB_DIR   = path.join(os.tmpdir(), "svgforge-lib");
const LOCAL_LIB_INDEX = path.join(LOCAL_LIB_DIR, "_index.json");

function localLibRead()  {
    try { return JSON.parse(fs.readFileSync(LOCAL_LIB_INDEX, "utf8")); } catch (_) { return { entries: [] }; }
}
function localLibWrite(idx) {
    fs.mkdirSync(LOCAL_LIB_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_LIB_INDEX, JSON.stringify(idx, null, 2));
}

// ── POST /api/library/upload ─────────────────────────────────────────────────
// Body: { iconName: string, svgContent: string }
// Stores SVG under library/<safeName>.svg (Stratus or local disk)
// and upserts an entry in library/_index.json
app.post("/api/library/upload", async (req, res) => {
    try {
        const { iconName, svgContent } = req.body || {};
        if (!iconName || !svgContent) {
            return res.status(400).json({ success: false, message: "Missing iconName or svgContent" });
        }

        const safeName = String(iconName).replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 128);
        const key      = `library/${safeName}.svg`;
        const savedAt  = new Date().toISOString();

        if (shouldUseStratus(req)) {
            await stratusPut(req, key, Buffer.from(svgContent, "utf8"), "image/svg+xml");

            // Upsert index
            let index;
            try { index = JSON.parse((await stratusGet(req, "library/_index.json")).toString("utf8")); }
            catch (_) { index = { entries: [] }; }
            index.entries = index.entries.filter(e => e.name !== safeName);
            index.entries.unshift({ name: safeName, key, savedAt, size: Buffer.byteLength(svgContent, "utf8") });
            await stratusPut(req, "library/_index.json",
                Buffer.from(JSON.stringify(index, null, 2), "utf8"), "application/json");

            console.log(`[library/upload] Stratus: ${key}`);
            return res.json({ success: true, iconName: safeName, key, savedAt });
        }

        // ── Local disk fallback ───────────────────────────────────────────────
        fs.mkdirSync(LOCAL_LIB_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOCAL_LIB_DIR, `${safeName}.svg`), svgContent, "utf8");

        const idx = localLibRead();
        idx.entries = idx.entries.filter(e => e.name !== safeName);
        idx.entries.unshift({ name: safeName, key: `local:${safeName}.svg`, savedAt, size: Buffer.byteLength(svgContent, "utf8") });
        localLibWrite(idx);

        console.log(`[library/upload] Local: ${safeName}.svg`);
        return res.json({ success: true, iconName: safeName, key: `local:${safeName}.svg`, savedAt });

    } catch (err) {
        console.error("[library/upload]", err);
        return res.status(500).json({ success: false, message: err.message || "Upload failed" });
    }
});

// ── GET /api/library/list ────────────────────────────────────────────────────
// Returns { success, icons: [{ name, key, savedAt, size }] }
app.get("/api/library/list", async (req, res) => {
    try {
        if (shouldUseStratus(req)) {
            let index;
            try { index = JSON.parse((await stratusGet(req, "library/_index.json")).toString("utf8")); }
            catch (_) { index = { entries: [] }; }
            return res.json({ success: true, icons: index.entries || [] });
        }

        // Local disk fallback
        const idx = localLibRead();
        return res.json({ success: true, icons: idx.entries || [] });

    } catch (err) {
        console.error("[library/list]", err);
        return res.status(500).json({ success: false, message: err.message || "List failed" });
    }
});

// ── GET /api/library/icon/:name ──────────────────────────────────────────────
// Serves SVG content. :name may include or omit .svg extension.
app.get("/api/library/icon/:name", async (req, res) => {
    try {
        const raw      = decodeURIComponent(req.params.name || "");
        const safeName = raw.replace(/\.svg$/i, "").replace(/[^a-zA-Z0-9-_]/g, "_");

        if (shouldUseStratus(req)) {
            const buf = await stratusGet(req, `library/${safeName}.svg`);
            res.setHeader("Content-Type", "image/svg+xml");
            res.setHeader("Cache-Control", "public, max-age=3600");
            return res.send(buf);
        }

        // Local disk fallback
        const fpath = path.join(LOCAL_LIB_DIR, `${safeName}.svg`);
        if (!fs.existsSync(fpath)) return res.status(404).json({ success: false, message: "Icon not found" });
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "public, max-age=3600");
        return res.sendFile(fpath);

    } catch (err) {
        if (!res.headersSent) res.status(404).json({ success: false, message: "Icon not found" });
    }
});

// ── DELETE /api/library/icon/:name ───────────────────────────────────────────
app.delete("/api/library/icon/:name", async (req, res) => {
    try {
        const raw      = decodeURIComponent(req.params.name || "");
        const safeName = raw.replace(/\.svg$/i, "").replace(/[^a-zA-Z0-9-_]/g, "_");

        if (shouldUseStratus(req)) {
            await stratusDelete(req, `library/${safeName}.svg`);

            let index;
            try { index = JSON.parse((await stratusGet(req, "library/_index.json")).toString("utf8")); }
            catch (_) { index = { entries: [] }; }
            index.entries = index.entries.filter(e => e.name !== safeName);
            await stratusPut(req, "library/_index.json",
                Buffer.from(JSON.stringify(index, null, 2), "utf8"), "application/json");

            console.log(`[library/delete] Stratus: ${safeName}.svg`);
            return res.json({ success: true });
        }

        // Local disk fallback
        const fpath = path.join(LOCAL_LIB_DIR, `${safeName}.svg`);
        try { fs.rmSync(fpath, { force: true }); } catch (_) {}

        const idx = localLibRead();
        idx.entries = idx.entries.filter(e => e.name !== safeName);
        localLibWrite(idx);

        console.log(`[library/delete] Local: ${safeName}.svg`);
        return res.json({ success: true });

    } catch (err) {
        console.error("[library/delete]", err);
        return res.status(500).json({ success: false, message: err.message || "Delete failed" });
    }
});

module.exports = app;

// Local development only — Catalyst runs the app via module.exports.
// NOTE: env vars are already loaded at the top of this file (.env.production
//       takes priority over .env). No extra dotenv.config() call needed here.
if (require.main === module) {
    const http = require('http');
    const PORT = process.env.PORT || 3001;
    http.createServer(app).listen(PORT, () => {
        console.log(`[local] spriteForgeJoin running at http://localhost:${PORT}`);
        console.log(`[local] Loaded env  : ${
            (() => {
                const fs        = require('fs');
                const path      = require('path');
                const forced    = String(process.env.FORCE_LOCAL_ENV || '').toLowerCase() === 'true';
                const prodEnvP  = path.join(__dirname, '.env.production');
                const localEnvP = path.join(__dirname, '.env');
                if (forced && fs.existsSync(localEnvP))                return '.env (FORCE_LOCAL_ENV)';
                if (!forced && fs.existsSync(prodEnvP))                return '.env.production';
                if (fs.existsSync(localEnvP))                          return '.env';
                return '(none)';
            })()
        }`);
        console.log(`[local] Stratus     : ${
            String(process.env.STRATUS_ALLOW_LOCAL_FALLBACK).toLowerCase() === 'true'
                ? 'local disk fallback (os.tmpdir)'
                : `bucket → ${process.env.STRATUS_BUCKET_NAME || '(not set)'}`
        }`);
        console.log(`[local] Auth enforce: ${process.env.AUTH_ENFORCE || 'false'}`);
        console.log(`[local] Master UI Library (direct from repo): ${process.env.REPO_NAME || 'CRM_UI_LIBRARY'}@${process.env.REPO_BRANCH || 'CRM_UI_LIBRARY_ICON_TOOL'} via ${process.env.REPO_PROVIDER || 'git'} (token ${process.env.REPO_TOKEN ? 'set' : 'NOT set'})`);
    });
}
