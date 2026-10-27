"use strict";

/**
 * Sign-in / sign-out tracking for the admin Activity Log.
 *
 * Each event is one record in the workflow store collection `auth_events` (Catalyst `workflow_store`
 * table, local JSON file in dev), so no extra Data Store table is needed:
 *   { email, name, type: "login" | "logout", at: ISO time, ip, agent }
 * Recording never throws: a failed write must not block signing in or out.
 */

const store = require("./store");

const COLL = "auth_events";

function clientIp(req) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return fwd || (req.socket && req.socket.remoteAddress) || "";
}

/** Short "Chrome on macOS"-style label from the User-Agent. */
function agentLabel(ua) {
    ua = String(ua || "");
    const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome"
        : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const osName = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android"
        : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
    return osName ? `${browser} on ${osName}` : browser;
}

async function record(req, type, user) {
    if (!user || !user.email) return;
    try {
        await store.forRequest(req).insert(COLL, {
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

/**
 * Summary for the admin page.
 * @param {{ days?: number, limit?: number }} opts  days: only events from the last N days (0 = all)
 * @returns {{ users: object[], events: object[], total: number }}
 */
async function summary(req, opts) {
    opts = opts || {};
    const since = opts.days > 0 ? Date.now() - opts.days * 86400000 : 0;
    const rows = (await store.forRequest(req).all(COLL))
        .filter((r) => r && r.email && (r.type === "login" || r.type === "logout"))
        .filter((r) => !since || new Date(r.at).getTime() >= since)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const byUser = new Map();
    for (const r of rows) {
        const u = byUser.get(r.email) || { email: r.email, name: r.name || "", logins: 0, logouts: 0, lastLogin: null, lastLogout: null, lastSeen: r.at };
        if (!u.name && r.name) u.name = r.name;
        if (r.type === "login") { u.logins++; if (!u.lastLogin) u.lastLogin = r.at; }
        else { u.logouts++; if (!u.lastLogout) u.lastLogout = r.at; }
        byUser.set(r.email, u);
    }
    const users = [...byUser.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 1000);
    return {
        total: rows.length,
        logins: rows.filter((r) => r.type === "login").length,
        logouts: rows.filter((r) => r.type === "logout").length,
        users,
        events: rows.slice(0, limit).map((r) => ({ email: r.email, name: r.name, type: r.type, at: r.at, ip: r.ip || "", agent: r.agent || "" }))
    };
}

module.exports = { record, summary };
