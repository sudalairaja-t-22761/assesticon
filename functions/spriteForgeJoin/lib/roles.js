"use strict";

/**
 * Roles for the icon workflow + role-based menu access.
 *
 * Built-in roles: admin (every menu, fixed), designer, ui (reviewers), user (everyone without a member row).
 * Admins can also create custom roles and choose which sidebar menus each role may open. Menus are the
 * sidebar items of the app (MENUS); "members" is admin-only and never assignable.
 * ADMIN_EMAILS (comma-separated) are always admins.
 *
 * Stored in ONE Catalyst Data Store table, `roles` (create it in the console — tables cannot be made from code),
 * one row per role (Admin, Designer, UI, Everyone else and every custom role):
 *
 *   role_key (Var Char) · role_name (Var Char) · then one Boolean column per menu, named exactly as the menu key:
 *   create_sprite, update_sprite, create_svg, customise, library, figma, webfont, settings, saved_sprites,
 *   saved_webfonts, saved_assets, most_used, request_icon, requests
 *
 * A toggle updates just its column on the role's row. ROWID / CREATEDTIME / MODIFIEDTIME are added by Catalyst.
 * Rows an older version kept as JSON in `workflow_store` (coll = roles) are the starting values when a role is
 * first seeded.
 */

const store = require("./store");

const MENUS = [
    { key: "create_sprite",  label: "Create Sprite",   group: "Workflow" },
    { key: "update_sprite",  label: "Update Sprite",   group: "Workflow" },
    { key: "create_svg",     label: "Create SVG",      group: "Workflow" },
    { key: "customise",      label: "Customise Icons", group: "Documentation" },
    { key: "library",        label: "Icon Library",    group: "Library" },
    { key: "asset_store",   label: "Asset Store",     group: "Library" },
    { key: "figma",          label: "Figma Import",    group: "Integrations" },
    { key: "webfont",        label: "SVG to WebFont",  group: "Tools" },
    { key: "settings",       label: "Settings",        group: "Tools" },
    { key: "saved_sprites",  label: "Saved Sprites",   group: "Output" },
    { key: "saved_webfonts", label: "Saved WebFonts",  group: "Output" },
    { key: "saved_assets",   label: "Saved Assets",    group: "Output" },
    { key: "most_used",      label: "Most Used Icons", group: "Analytics" },
    { key: "request_icon",   label: "Request Icon",    group: "Analytics" },
    { key: "requests",       label: "Icon Requests",   group: "Analytics" }
];
const MENU_KEYS = MENUS.map((m) => m.key);

const REVIEW_MENUS = ["library", "request_icon", "requests", "most_used"];
const BUILTIN = {
    admin:    { name: "Admin",         menus: [...MENU_KEYS, "members"], fixed: true },
    designer: { name: "Designer",      menus: REVIEW_MENUS },
    ui:       { name: "UI",            menus: REVIEW_MENUS },
    user:     { name: "Everyone else", menus: MENU_KEYS }   // signed-in users with no member role
};
const ASSIGNABLE_BUILTIN = ["admin", "designer", "ui"];

const envAdmins = () =>
    String(process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const norm = (e) => String(e || "").trim().toLowerCase();
const slug = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const isOn = (v) => v === true || String(v).toLowerCase() === "true";
const menuList = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((m) => String(m).trim()).filter((m) => MENU_KEYS.includes(m));
/** Legacy `menus` value (comma list, array, or { key: bool } map) → allowed keys, or null when unset. */
const legacyMenus = (v) =>
    v && typeof v === "object" && !Array.isArray(v) ? MENU_KEYS.filter((k) => isOn(v[k])) : (v == null || v === "" ? null : menuList(v));

// ROWIDs are 17-digit strings: compare as BigInt so the newest row wins reliably.
const newerRow = (a, b) => { try { return BigInt(b.ROWID) > BigInt(a.ROWID) ? b : a; } catch (_) { return Number(b.ROWID) > Number(a.ROWID) ? b : a; } };
const latestBy = (rows, keyOf) => { const m = new Map(); for (const r of rows) { const k = keyOf(r); m.set(k, m.has(k) ? newerRow(m.get(k), r) : r); } return m; };

const roleDefaults = (key) => (BUILTIN[key] ? (BUILTIN[key].fixed ? MENU_KEYS : BUILTIN[key].menus) : []);

const ROLE_COLUMNS = ["role_key", "role_name", ...MENU_KEYS];

async function readRoleData(req) {
    const db = store.forRequest(req);
    return { db, roleRows: await db.all("roles") };
}

/** Menu keys switched on in a roles row; a column with no value yet (new menu) falls back to the role's default. */
function menusOfRow(row) {
    const defaults = roleDefaults(row.role_key);
    return MENU_KEYS.filter((m) => (row[m] === undefined || row[m] === null || row[m] === "" ? defaults.includes(m) : isOn(row[m])));
}

function buildRoles(roleRows) {
    const rolesByKey = latestBy(roleRows, (r) => r.role_key);
    const out = Object.keys(BUILTIN).map((key) => {
        const b = BUILTIN[key], row = rolesByKey.get(key);
        return { key, name: b.name, builtin: true, fixed: !!b.fixed, rowId: row ? row.ROWID : null,
            menus: b.fixed ? b.menus : (row ? menusOfRow(row) : roleDefaults(key)) };
    });
    for (const [key, r] of rolesByKey) {
        if (BUILTIN[key]) continue;
        out.push({ key, name: r.role_name, builtin: false, fixed: false, rowId: r.ROWID, menus: menusOfRow(r) });
    }
    return out;
}

const fallbackRoles = () => Object.keys(BUILTIN).map((key) => ({
    key, name: BUILTIN[key].name, builtin: true, fixed: !!BUILTIN[key].fixed, rowId: null, menus: BUILTIN[key].menus }));

const tablesHint = (e) =>
    `Catalyst Data Store table "roles" is missing or lacks columns. Create it with role_key and role_name (Var Char) plus one ` +
    `Boolean column per menu: ${MENU_KEYS.join(", ")}. Details: ${(e && e.message) || e}`;

const menuFields = (on) => Object.fromEntries(MENU_KEYS.map((m) => [m, on.includes(m)]));

/** All roles: built-ins followed by custom roles, each with the menus whose switch is on. */
async function loadRoles(req) {
    try { return buildRoles((await readRoleData(req)).roleRows); }
    catch (e) {
        console.error("[roles]", tablesHint(e));
        return fallbackRoles(); // keep the app usable on built-in defaults until the table exists
    }
}

/**
 * Make sure every role has a row in `roles`. Missing roles are added with their old (workflow_store) or default
 * switches, and a menu column that is still empty on an existing row is filled with the same; switches that are
 * already set are never touched. A no-op once in sync. Throws the "create this table" hint when the table is
 * missing. Returns the number of rows written.
 */
async function syncRoleRows(req) {
    let data;
    try { data = await readRoleData(req); } catch (e) { throw new Error(tablesHint(e)); }
    const { db, roleRows } = data;

    const legacyByKey = latestBy(await db.legacy("roles"), (r) => r.key);
    const startFor = (key) => {
        if (BUILTIN[key] && BUILTIN[key].fixed) return MENU_KEYS;
        const old = legacyByKey.has(key) ? legacyMenus(legacyByKey.get(key).menus) : null;
        return old || roleDefaults(key);
    };

    let written = 0;
    const have = latestBy(roleRows, (r) => r.role_key);
    const adds = [];
    for (const key of Object.keys(BUILTIN)) if (!have.has(key)) adds.push({ role_key: key, role_name: BUILTIN[key].name, ...menuFields(startFor(key)) });
    for (const [key, l] of legacyByKey) if (!BUILTIN[key] && !have.has(key)) adds.push({ role_key: key, role_name: l.name || key, ...menuFields(startFor(key)) });
    if (adds.length) { await db.insertMany("roles", adds); written += adds.length; }

    for (const [key, row] of have) {
        const start = startFor(key);
        const blanks = MENU_KEYS.filter((m) => row[m] === undefined || row[m] === null || row[m] === "");
        if (!blanks.length) continue;
        await db.update("roles", row.ROWID, Object.fromEntries(blanks.map((m) => [m, start.includes(m)])));
        written++;
    }
    return written;
}

/** Set one menu's true/false switch for a role — updates just that column of its row. */
async function setRoleMenu(req, rowId, menuKey, allowed) {
    await store.forRequest(req).update("roles", rowId, { [menuKey]: !!allowed });
}

/** Set every menu of a role at once from a list of allowed keys. */
async function setRoleMenus(req, rowId, list) {
    await store.forRequest(req).update("roles", rowId, menuFields(menuList(list)));
}

async function createRole(req, { key, name, menus }) {
    await store.forRequest(req).insert("roles", { role_key: key, role_name: name, ...menuFields(menuList(menus)) });
}

async function renameRole(req, rowId, name) { await store.forRequest(req).update("roles", rowId, { role_name: name }); }

/** Delete a custom role (its row holds all of its menu switches). */
async function deleteRole(req, rowId) { await store.forRequest(req).remove("roles", rowId); }

/**
 * Approver type of a member: "designer", "ui" or "" (none). New members store an explicit "none"; rows saved
 * before this field existed (empty) keep their old behaviour, where the Designer/UI role was the approver.
 */
const approverOf = (m) => {
    const a = String(m.approverType || "");
    if (a === "designer" || a === "ui") return a;
    if (a === "none") return "";
    return m.memberType === "designer" || m.memberType === "ui" ? m.memberType : "";
};

/** A member whose access expiry has passed is treated as a plain user. */
const isExpired = (m) => !!m.expiresAt && new Date(m.expiresAt).getTime() <= Date.now();


// Seed the roles table (and copy members into their own table) once per running instance, on the first access
// check — so the rows exist right after a deploy without anyone opening the Roles screen. A failure (a table not
// created yet) is retried at most once a minute.
let seeding = null, lastTry = 0;
const RETRY_MS = 60 * 1000;
function ensureSeeded(req) {
    if (seeding && (seeding !== "retry" || Date.now() - lastTry < RETRY_MS)) return seeding === "retry" ? Promise.resolve() : seeding;
    lastTry = Date.now();
    seeding = (async () => {
        let ok = true;
        try {
            const n = await syncRoleRows(req);
            if (n) console.log(`[roles] seeded ${n} row(s) in the roles table`);
        } catch (e) { ok = false; console.error("[roles] seed:", e.message); }
        try {
            const m = await store.forRequest(req).migrate("members");
            if (!m.ok) { ok = false; console.error("[members] migrate:", m.error); }
            else if (m.moved) console.log(`[members] copied ${m.moved} member(s) into the members table`);
        } catch (e) { ok = false; console.error("[members] migrate:", e.message); }
        if (!ok) seeding = "retry";
    })();
    return seeding;
}

/** { role, menus } for a signed-in email. */
async function getAccess(req, email) {
    const e = norm(email);
    await ensureSeeded(req);
    const roles = await loadRoles(req);
    const pick = (key) => {
        const r = roles.find((x) => x.key === key) || roles.find((x) => x.key === "user");
        return { role: r.key, menus: r.menus };
    };
    if (!e) return pick("user");
    if (envAdmins().includes(e)) return pick("admin");
    const members = await store.forRequest(req).all("members");
    const m = members.find((r) => norm(r.userEmail) === e);
    if (!m || isExpired(m) || m.memberType === "user" || !roles.some((r) => r.key === m.memberType)) return pick("user");
    return pick(m.memberType);
}

const getRole = async (req, email) => (await getAccess(req, email)).role;

/** Express middleware factory: attaches req.role then enforces `allowed` (omit for any signed-in user). */
function requireRole(allowed) {
    return async (req, res, next) => {
        try {
            const email = req.auth && req.auth.session.user.email;
            req.role = await getRole(req, email);
            if (allowed && !allowed.includes(req.role)) {
                return res.status(403).json({ success: false, message: "Not allowed for your role" });
            }
            next();
        } catch (err) {
            console.error("[roles] error:", err.message);
            res.status(500).json({ success: false, message: err.message || "Role check failed" });
        }
    };
}

module.exports = { MENUS, MENU_KEYS, BUILTIN, ASSIGNABLE_BUILTIN, loadRoles, syncRoleRows, setRoleMenu, setRoleMenus, createRole, renameRole, deleteRole, getAccess, getRole, requireRole, norm, slug, menuList, isExpired, approverOf };
