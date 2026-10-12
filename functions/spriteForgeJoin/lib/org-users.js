"use strict";

/**
 * (Default provider) Zoho People "Get Bulk Records" for the employee form:
 *   GET {people}/people/api/forms/employee/getRecords?sIndex=1&limit=200   scope: ZOHOPEOPLE.forms.READ
 * Set only ORG_USERS_REFRESH_TOKEN (+ optional ORG_USERS_CLIENT_ID/SECRET of the Self Client that
 * issued it) to use it. Photos need the token, so they are served through /api/org-users/photo.
 *
 * Full Zoho organisation user list, used by the Members page "Add member" search.
 *
 * The upstream endpoint is configured by env (it differs per Zoho service / data centre):
 *   ORG_USERS_API_URL         e.g. the Zoho Directory / People "list users" URL for your org (GET, JSON)
 *   ORG_USERS_REFRESH_TOKEN   OAuth refresh token of an admin with the read scope for that API
 *                             (e.g. ZohoDirectory.Users.READ); exchanged for an access token using
 *                             ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET at ZOHO_ACCOUNTS_BASE
 *   ORG_USERS_ACCESS_TOKEN    (alternative) a static access token, for quick tests
 *   ORG_USERS_LIST_PATH       optional dotted path to the array in the response (default: auto-detect)
 *   ORG_USERS_AUTH_SCHEME     optional, default "Zoho-oauthtoken"
 * Name / email fields are detected automatically (name, display_name, first+last, email, email_id…).
 */

const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, users: [], status: null, key: "" };
let tokenCache = { at: 0, token: "", key: "" };

const peopleBase = () => String(process.env.ORG_USERS_PEOPLE_BASE ||
    String(process.env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.in").replace("accounts.", "people.")).replace(/\/+$/, "");

const cfg = () => ({
    url: String(process.env.ORG_USERS_API_URL || "").trim(),
    provider: String(process.env.ORG_USERS_API_URL ? "custom" : "people"),
    refresh: String(process.env.ORG_USERS_REFRESH_TOKEN || "").trim(),
    staticToken: String(process.env.ORG_USERS_ACCESS_TOKEN || "").trim(),
    listPath: String(process.env.ORG_USERS_LIST_PATH || "").trim(),
    scheme: String(process.env.ORG_USERS_AUTH_SCHEME || "Zoho-oauthtoken").trim()
});

const isConfigured = (refresh) => !!(refresh || cfg().refresh || cfg().staticToken) && (cfg().provider === "people" || !!cfg().url);

// `refreshOverride`: the signed-in admin's own refresh token (saved at login), else ORG_USERS_REFRESH_TOKEN.
async function accessToken(refreshOverride) {
    const c = cfg();
    if (c.staticToken) return c.staticToken;
    const refresh = refreshOverride || c.refresh;
    if (tokenCache.token && tokenCache.key === refresh && Date.now() - tokenCache.at < 50 * 60 * 1000) return tokenCache.token;
    const base = String(process.env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.in").replace(/\/+$/, "");
    const body = new URLSearchParams({
        grant_type: "refresh_token", refresh_token: refresh,
        client_id: process.env.ORG_USERS_CLIENT_ID || process.env.ZOHO_CLIENT_ID || "",
        client_secret: process.env.ORG_USERS_CLIENT_SECRET || process.env.ZOHO_CLIENT_SECRET || ""
    });
    const r = await fetch(base + "/oauth/v2/token", { method: "POST", body });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) throw new Error("Could not get an access token: " + (j.error || r.status));
    tokenCache = { at: Date.now(), token: j.access_token, key: refresh };
    return j.access_token;
}

function findArray(obj, listPath) {
    if (listPath) {
        const hit = listPath.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
        return Array.isArray(hit) ? hit : [];
    }
    if (Array.isArray(obj)) return obj;
    for (const k of ["users", "data", "result", "results", "items", "members"]) {
        if (Array.isArray(obj && obj[k])) return obj[k];
    }
    for (const k of Object.keys(obj || {})) if (Array.isArray(obj[k])) return obj[k];
    return [];
}

function normalise(u) {
    const email = u.email || u.email_id || u.emailid || u.mail || u.primary_email || u.Email || u.EmailID || "";
    const name = u.display_name || u.displayName || u.name || u.full_name ||
        [u.first_name || u.firstName, u.last_name || u.lastName].filter(Boolean).join(" ") || u.Full_Name || email;
    const avatar = u.photo_url || u.photoUrl || u.photo || u.profile_photo || u.profile_picture || u.profilePicture ||
        u.avatar || u.picture || u.image || u.image_url || u.Photo || "";
    return email ? { name: String(name), email: String(email), avatar: typeof avatar === "string" ? avatar : "" } : null;
}

const PEOPLE_PAGE = 200, PEOPLE_MAX_PAGES = 50;

// ── Zoho Cliq org directory: GET {cliq}/api/v2/users (scope ZohoCliq.Users.READ) ──
const cliqBase = () => String(process.env.ORG_USERS_CLIQ_BASE ||
    String(process.env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.in").replace("accounts.", "cliq.")).replace(/\/+$/, "");

// Cliq returns department/designation as objects: take their readable text.
function textOf(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
        for (const k of ["name", "title", "value", "department_name", "designation_name", "display_name"]) if (typeof v[k] === "string" && v[k]) return v[k];
        for (const k of Object.keys(v)) if (typeof v[k] === "string" && v[k] && !/id$/i.test(k)) return v[k];
    }
    return "";
}

function cliqUser(u) {
    const email = u.email_id || u.email || "";
    if (!email) return null;
    const name = u.full_name || u.display_name || [u.first_name, u.last_name].filter(Boolean).join(" ") || email;
    const photo = typeof u.image_url === "string" ? u.image_url : "";
    return {
        name, email,
        // People-hosted photo: needs the org token, so it is served through /api/org-users/photo
        avatar: /^https:\/\//i.test(photo) ? "proxy:" + Buffer.from(photo).toString("base64url") : "",
        employeeId: u.employee_id || "", department: textOf(u.department), designation: textOf(u.designation)
    };
}

let cliqChain = Promise.resolve(), lastCliqAt = 0;
function cliqThrottle(fn) {
    const run = cliqChain.then(async () => {
        const wait = lastCliqAt + 2000 - Date.now();
        if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
        try { return await fn(); } finally { lastCliqAt = Date.now(); }
    });
    cliqChain = run.catch(() => {});
    return run;
}
const cliqCache = new Map(); // "<token tail>|<query>" → { at, users }
let cliqStatus = null;

/**
 * One server-side Cliq search (name or email, max 100 hits). Cliq allows 30 requests/min per user, so every
 * query is cached for 5 minutes and the whole directory is never paged.
 */
async function cliqSearch(refreshOverride, q, force) {
    const query = String(q || "").trim();
    const key = String(refreshOverride || "").slice(-12) + "|" + query.toLowerCase();
    const hit = cliqCache.get(key);
    if (!force && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.users;
    const token = await accessToken(refreshOverride);
    const url = `${cliqBase()}/api/v2/users?limit=100&status=active&fields=all` + (query ? `&search=${encodeURIComponent(query)}` : "");
    // Cliq rejects bursts (HTTP 429) well below its documented 30/min: one call at a time, 2 s apart, one retry.
    const { r, text } = await cliqThrottle(async () => {
        for (let attempt = 0; ; attempt++) {
            const res = await fetch(url, { headers: { Authorization: `${cfg().scheme} ${token}`, Accept: "application/json" } });
            if (res.status === 429 && attempt < 1) { await new Promise((ok) => setTimeout(ok, 4000)); continue; }
            return { r: res, text: await res.text() };
        }
    });
    let j; try { j = JSON.parse(text); } catch (_) { j = {}; }
    if (!r.ok) {
        const msg = r.status === 429 ? "Cliq rate limit reached (30 requests/min) — wait a minute and try again"
            : `Cliq returned HTTP ${r.status}` + (j.code || j.message ? ` (${j.code || j.message})` : "");
        cliqStatus = { ok: false, http: r.status, error: msg, at: Date.now() };
        throw new Error(msg);
    }
    const rows = Array.isArray(j.data) ? j.data : Array.isArray(j.users) ? j.users : Array.isArray(j) ? j : [];
    const users = rows.map(cliqUser).filter(Boolean);
    cliqStatus = { ok: true, http: r.status, count: users.length, at: Date.now() };
    if (cliqCache.size > 200) cliqCache.delete(cliqCache.keys().next().value);
    cliqCache.set(key, { at: Date.now(), users });
    return users;
}

// People returns result: [ { "<recordId>": [ { FirstName, LastName, EmailID, ... } ] }, ... ]
function peopleRecords(json) {
    const out = [];
    for (const rec of (json && json.response && json.response.result) || []) {
        for (const k of Object.keys(rec)) for (const row of Array.isArray(rec[k]) ? rec[k] : [rec[k]]) if (row && typeof row === "object") out.push(row);
    }
    return out;
}

function peopleUser(r) {
    const email = r.EmailID || r["Email ID"] || r.Email || "";
    if (!email) return null;
    const status = String(r.Employeestatus || r.EmployeeStatus || "").toLowerCase();
    if (status && status !== "active") return null;
    const name = [r.FirstName, r.LastName].filter(Boolean).join(" ") || r.Full_Name || email;
    const photo = r.Photo_downloadUrl || r.Photo || "";
    return {
        name, email,
        avatar: /^https:\/\//i.test(photo) ? "proxy:" + Buffer.from(photo).toString("base64url") : "",
        employeeId: r.EmployeeID || "", department: r.Department || "", designation: r.Designation || ""
    };
}

async function listPeople(token) {
    const users = [];
    for (let page = 0; page < PEOPLE_MAX_PAGES; page++) {
        const url = `${peopleBase()}/people/api/forms/employee/getRecords?sIndex=${page * PEOPLE_PAGE + 1}&limit=${PEOPLE_PAGE}`;
        const r = await fetch(url, { headers: { Authorization: `${cfg().scheme} ${token}`, Accept: "application/json" } });
        const text = await r.text();
        let json; try { json = JSON.parse(text); } catch (_) { json = {}; }
        if (!r.ok) {
            cache.status = { ok: false, http: r.status, at: Date.now(), message: text.slice(0, 200) };
            throw new Error(`Zoho People returned HTTP ${r.status}`);
        }
        const rows = peopleRecords(json);
        users.push(...rows.map(peopleUser).filter(Boolean));
        if (rows.length < PEOPLE_PAGE) break;
    }
    return users;
}

/** Download a People photo with the org token (host allow-listed to Zoho). */
const photoCache = new Map(); // photo URL → { type, buffer }; photos are small and requested repeatedly
async function fetchPhoto(encoded, refreshOverride) {
    const cached = photoCache.get(String(encoded));
    if (cached) return cached;
    const target = Buffer.from(String(encoded || ""), "base64url").toString("utf8");
    const u = new URL(target);
    if (u.protocol !== "https:" || !/(^|\.)zoho\.(in|com|eu|com\.au|jp|com\.cn|sa|ca)$/i.test(u.hostname)) throw new Error("Photo host not allowed");
    const r = await fetch(target, { headers: { Authorization: `${cfg().scheme} ${await accessToken(refreshOverride)}` } });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !type.startsWith("image/")) throw new Error("Photo not available");
    const out = { type, buffer: Buffer.from(await r.arrayBuffer()) };
    if (photoCache.size > 400) photoCache.delete(photoCache.keys().next().value);
    photoCache.set(String(encoded), out);
    return out;
}

/** Fetch (cached) the whole org list. Throws on upstream errors. */
async function list(force, refreshOverride) {
    if (!isConfigured(refreshOverride)) throw new Error("No Zoho token available for the org user list");
    if (!force && cache.users.length && cache.key === (refreshOverride || "") && Date.now() - cache.at < CACHE_MS) return cache.users;
    const c = cfg();
    const token = await accessToken(refreshOverride);
    if (c.provider === "people") {
        const users = await listPeople(token);
        cache = { at: Date.now(), users, key: refreshOverride || "", status: { ok: true, http: 200, at: Date.now(), count: users.length, sample: users.slice(0, 2) } };
        return users;
    }
    const r = await fetch(c.url, { headers: { Authorization: `${c.scheme} ${token}`, Accept: "application/json" } });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = {}; }
    if (!r.ok) {
        cache.status = { ok: false, http: r.status, at: Date.now(), message: text.slice(0, 200) };
        throw new Error(`Org users API returned HTTP ${r.status}`);
    }
    const users = findArray(json, c.listPath).map(normalise).filter(Boolean);
    cache = { at: Date.now(), users, status: { ok: true, http: r.status, at: Date.now(), count: users.length, sample: users.slice(0, 2) } };
    return users;
}

const lastCliq = () => cliqStatus;
module.exports = { list, isConfigured, fetchPhoto, cliqSearch, lastCliq };
