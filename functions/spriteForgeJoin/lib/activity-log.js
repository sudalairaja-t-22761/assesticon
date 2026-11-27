"use strict";

/**
 * Admin Activity Log: everything that happens in the tool, in one place.
 *
 * Sources (all in the workflow store: Catalyst `workflow_store` table, local JSON file in dev — no extra table):
 *   auth_events        sign-in / sign-out            { email, name, type: "login" | "logout", at, ip, agent }
 *   tool_events        npm + helper tracking         { type, at, ok, email, name, npmUser, machine, version, tag, branch,
 *                                                      pkg, icons[], by[], requests, commit, error, detail, ip, agent }
 *                        type: npm_publish | npm_login | helper_setup_code | helper_setup_report
 *   request_events     the timeline of every icon request (requested, reviews, pushes, npm result, notifications)
 *   icon_requests      to name the icon of a request event
 *   request_deletions  requests an admin deleted, with the reason
 *
 * Recording never throws: a failed write must not block signing in, pushing or publishing.
 */

const store = require("./store");

const AUTH = "auth_events";
const TOOL = "tool_events";

function clientIp(req) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return fwd || (req.socket && req.socket.remoteAddress) || "";
}

/** Short "Chrome on macOS"-style label from the User-Agent. */
function agentLabel(ua) {
    ua = String(ua || "");
    const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome"
        : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl\//.test(ua) ? "curl" : /node/i.test(ua) ? "npm helper" : "Browser";
    const osName = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android"
        : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
    return osName ? `${browser} on ${osName}` : browser;
}

async function record(req, type, user) {
    if (!user || !user.email) return;
    try {
        await store.forRequest(req).insert(AUTH, {
            email: String(user.email).toLowerCase(),
            name: user.name || "",
            type,
            at: new Date().toISOString(),
            ip: clientIp(req),
            agent: agentLabel(req.headers["user-agent"])
        });
    } catch (e) {
        console.error(`[activity-log] could not record ${type} for ${user.email}:`, e.message);
    }
}

const cut = (v, n) => String(v == null ? "" : v).slice(0, n);

/**
 * One npm / helper event. fields: { ok, email, name, npmUser, machine, version, tag, branch, pkg, icons[], by[],
 * requests, commit, error, detail }. Unknown fields are dropped, long ones shortened (a record is one small row).
 */
async function track(req, type, fields) {
    const f = fields || {};
    try {
        await store.forRequest(req).insert(TOOL, {
            type: cut(type, 40),
            at: new Date().toISOString(),
            ok: f.ok === undefined ? null : !!f.ok,
            email: cut(f.email, 120).toLowerCase(),
            name: cut(f.name, 120),
            npmUser: cut(f.npmUser, 80),
            machine: cut(f.machine, 80),
            version: cut(f.version, 60),
            tag: cut(f.tag, 40),
            branch: cut(f.branch, 120),
            pkg: cut(f.pkg, 120),
            icons: (Array.isArray(f.icons) ? f.icons : []).slice(0, 30).map((x) => cut(x, 80)),
            by: (Array.isArray(f.by) ? f.by : []).slice(0, 10).map((x) => cut(x, 120).toLowerCase()),
            requests: Number(f.requests) || 0,
            commit: cut(f.commit, 64),
            error: cut(f.error, 600),
            detail: cut(f.detail, 300),
            ip: clientIp(req),
            agent: agentLabel(req.headers["user-agent"])
        });
    } catch (e) {
        console.error(`[activity-log] could not record ${type}:`, e.message);
    }
}

/** Time of a record in ms: its own `at`, else the store's creation time ("2026-11-26 15:29:10:123" on Catalyst). */
function timeOf(r) {
    const own = r && r.at ? Date.parse(r.at) : NaN;
    if (!isNaN(own)) return own;
    const c = String((r && r.CREATEDTIME) || "");
    const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)[:.]?(\d{1,3})?/.exec(c);
    const t = m ? Date.parse(`${m[1]}T${m[2]}.${(m[3] || "0").padStart(3, "0")}`) : Date.parse(c);
    return isNaN(t) ? 0 : t;
}

// request_events action → what the feed shows. cat: request | review | push | publish | notify
const REQUEST_ACTIONS = {
    requested: ["request", "Requested (mock)"], requested_master: ["request", "Requested (master)"],
    designer_approved: ["review", "Visual audit approved"], designer_rejected: ["review", "Visual audit rejected", false],
    ui_approved: ["review", "UI audit approved"], ui_rejected: ["review", "UI audit rejected", false],
    assigned: ["review", "Approver assigned"], admin_rejected: ["review", "Rejected by admin", false], admin_declined: ["review", "Declined by admin", false],
    pushed: ["push", "Pushed"], pushed_mock: ["push", "Pushed to mock"], pushed_master: ["push", "Approved + pushed to master"],
    npm_published: ["publish", "Published to npm"], npm_publish_failed: ["publish", "npm publish failed", false],
    npm_republish_requested: ["publish", "Re-publish requested"],
    cliq_sent: ["notify", "Cliq message sent"], cliq_failed: ["notify", "Cliq message failed", false], notify_failed: ["notify", "Notification failed", false]
};
const TOOL_LABEL = { library_icon_deleted: ["request", "Library icon deleted"], npm_login: ["npm", "npm login"], helper_setup_code: ["setup", "npm helper setup started"], helper_setup_report: ["setup", "npm helper setup"] };

/**
 * Everything for the admin page.
 * @param {{ days?: number, limit?: number }} opts  days: only events from the last N days (0 = all)
 */
async function summary(req, opts) {
    opts = opts || {};
    const since = opts.days > 0 ? Date.now() - opts.days * 86400000 : 0;
    const db = store.forRequest(req);
    const read = (coll) => db.all(coll).catch((e) => { console.error(`[activity-log] ${coll}:`, e.message); return []; });
    const [auth, tool, events, requests, deletions, members] = await Promise.all(
        [AUTH, TOOL, "request_events", "icon_requests", "request_deletions", "members"].map(read));
    const inRange = (t) => t > 0 && (!since || t >= since);
    const nameOf = new Map();
    for (const m of members) if (m && m.userEmail) nameOf.set(String(m.userEmail).toLowerCase(), m.userName || m.name || "");
    for (const r of auth) if (r && r.email && r.name) nameOf.set(r.email, r.name);
    const reqOf = new Map(requests.map((r) => [String(r.ROWID), r]));

    // ── sign-ins (unchanged shape: the page's first version reads these) ──
    const rows = auth.filter((r) => r && r.email && (r.type === "login" || r.type === "logout"))
        .filter((r) => inRange(timeOf(r))).sort((a, b) => timeOf(b) - timeOf(a));
    const byUser = new Map();
    const userOf = (email) => {
        email = String(email || "").toLowerCase();
        if (!email || !/@/.test(email)) return null;
        if (!byUser.has(email)) {
            byUser.set(email, { email, name: nameOf.get(email) || "", logins: 0, logouts: 0, lastLogin: null, lastLogout: null, lastSeen: null,
                requests: 0, reviews: 0, pushes: 0, publishes: 0, publishFailed: 0, npmLogins: 0, npmLoginFailed: 0, npmUsers: [] });
        }
        return byUser.get(email);
    };
    const seen = (u, t) => { if (u && (!u.lastSeen || t > Date.parse(u.lastSeen))) u.lastSeen = new Date(t).toISOString(); };
    for (const r of rows) {
        const u = userOf(r.email); if (!u) continue;
        if (r.type === "login") { u.logins++; if (!u.lastLogin) u.lastLogin = r.at; } else { u.logouts++; if (!u.lastLogout) u.lastLogout = r.at; }
        seen(u, timeOf(r));
    }

    // ── one feed of everything ──
    const feed = [];
    const add = (t, cat, label, who, text, ok, meta) => feed.push({ at: new Date(t).toISOString(), cat, label, who: String(who || "").toLowerCase(),
        name: nameOf.get(String(who || "").toLowerCase()) || "", text: text || "", ok: ok === undefined ? null : ok, meta: meta || {} });
    for (const r of rows) add(timeOf(r), "signin", r.type === "login" ? "Signed in" : "Signed out", r.email, "", null, { ip: r.ip || "", agent: r.agent || "" });

    for (const e of events) {
        const t = timeOf(e); if (!inRange(t)) continue;
        const q = reqOf.get(String(e.requestId)) || {}, def = REQUEST_ACTIONS[e.action] || ["request", String(e.action || "event").replace(/_/g, " ")];
        // The npm result of a request is written by the publisher, not by a person: show the admin whose push it releases.
        const who = /@/.test(String(e.actor || "")) ? e.actor
            : (e.action === "npm_published" || e.action === "npm_publish_failed") && /@/.test(String(q.pushedBy || "")) ? q.pushedBy : "";
        add(t, def[0], def[1], who, e.note || "", def[2] === false ? false : (def[0] === "notify" || def[0] === "request" ? null : true),
            { icon: q.iconName || "", stage: q.stage === "master" ? "master" : (q.iconName ? "mock" : ""), requestId: String(e.requestId || ""), actor: who ? "" : String(e.actor || "") });
        const u = userOf(who);
        if (u) {
            if (def[0] === "request") u.requests++; else if (def[0] === "review") u.reviews++; else if (def[0] === "push") u.pushes++;
            seen(u, t);
        }
    }
    for (const d of deletions) {
        const t = timeOf(d); if (!inRange(t)) continue;
        add(t, "request", "Request deleted", d.deletedBy, d.reason || "", false, { icon: d.iconName || "", stage: d.stage || "" });
        seen(userOf(d.deletedBy), t);
    }

    // ── npm publishes (one row per version) + the other npm / helper events ──
    const releases = [];
    for (const e of tool) {
        const t = timeOf(e); if (!inRange(t)) continue;
        if (e.type === "npm_publish") {
            const by = (Array.isArray(e.by) ? e.by : []).filter(Boolean);
            releases.push({ at: new Date(t).toISOString(), ok: e.ok !== false, pkg: e.pkg || "", version: e.version || "", tag: e.tag || "", branch: e.branch || "",
                npmUser: e.npmUser || "", machine: e.machine || "", icons: e.icons || [], requests: e.requests || 0, commit: e.commit || "", error: e.error || "",
                by: by.map((x) => ({ email: x, name: nameOf.get(x) || "" })) });
            for (const x of by) { const u = userOf(x); if (u) { if (e.ok !== false) u.publishes++; else u.publishFailed++; if (e.npmUser && !u.npmUsers.includes(e.npmUser)) u.npmUsers.push(e.npmUser); seen(u, t); } }
            // The request timeline already has one line per icon; a publish that matched no request shows here.
            if (!e.requests) {
                add(t, "publish", e.ok !== false ? "Published to npm" : "npm publish failed", by[0] || "",
                    e.ok !== false ? `${e.pkg}@${e.version}` : `${e.version || "version not set"}: ${e.error}`, e.ok !== false,
                    { version: e.version || "", npmUser: e.npmUser || "", machine: e.machine || "", branch: e.branch || "" });
            }
            continue;
        }
        const def = TOOL_LABEL[e.type] || ["npm", String(e.type || "event").replace(/_/g, " ")];
        const label = e.type === "npm_login" ? (e.ok === false ? "npm login failed" : "npm login")
            : e.type === "helper_setup_report" ? (e.ok === false ? "npm helper setup failed" : "npm helper set up") : def[1];
        add(t, def[0], label, e.email, e.ok === false ? e.error : e.detail || "", e.ok, { npmUser: e.npmUser || "", machine: e.machine || "", ip: e.ip || "", agent: e.agent || "" });
        const u = userOf(e.email);
        if (u) {
            if (e.type === "npm_login") { if (e.ok === false) u.npmLoginFailed++; else { u.npmLogins++; if (e.npmUser && !u.npmUsers.includes(e.npmUser)) u.npmUsers.push(e.npmUser); } }
            seen(u, t);
        }
    }
    feed.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    releases.sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const users = [...byUser.values()].sort((a, b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 500, 1), 2000);
    const count = (fn) => feed.filter(fn).length;
    return {
        total: rows.length,
        logins: rows.filter((r) => r.type === "login").length,
        logouts: rows.filter((r) => r.type === "logout").length,
        users,
        events: rows.slice(0, 200).map((r) => ({ email: r.email, name: r.name, type: r.type, at: r.at, ip: r.ip || "", agent: r.agent || "" })),
        stats: {
            logins: rows.filter((r) => r.type === "login").length,
            activeUsers: users.length,
            requests: count((f) => f.cat === "request" && /^Requested/.test(f.label)),
            reviews: count((f) => f.cat === "review"),
            pushes: count((f) => f.cat === "push"),
            published: releases.filter((r) => r.ok).length,
            publishFailed: releases.filter((r) => !r.ok).length,
            npmLogins: count((f) => f.label === "npm login"),
            npmLoginFailed: count((f) => f.label === "npm login failed")
        },
        releases: releases.slice(0, 300),
        feed: feed.slice(0, limit),
        feedTotal: feed.length
    };
}

module.exports = { record, track, summary };
