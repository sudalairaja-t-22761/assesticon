"use strict";

/**
 * Roles for the icon workflow + role-based menu access.
 *
 * Built-in roles: admin (every menu, fixed), designer, ui (reviewers), user (everyone without a member row).
 * Admins can also create custom roles and choose which sidebar menus each role may open. Menus are the
 * sidebar items of the app (MENUS); "members" is admin-only and never assignable.
 * ADMIN_EMAILS (comma-separated) are always admins.
 *
 * Stored in the `roles` table: custom roles, plus overrides of a built-in role's menus (admin cannot be edited).
 */

const store = require("./store");

const MENUS = [
    { key: "create_sprite",  label: "Create Sprite",   group: "Workflow" },
    { key: "update_sprite",  label: "Update Sprite",   group: "Workflow" },
    { key: "create_svg",     label: "Create SVG",      group: "Workflow" },
    { key: "customise",      label: "Customise Icons", group: "Documentation" },
    { key: "library",        label: "Icon Library",    group: "Library" },
    { key: "figma",          label: "Figma Import",    group: "Integrations" },
    { key: "webfont",        label: "SVG to WebFont",  group: "Tools" },
    { key: "settings",       label: "Settings",        group: "Tools" },
    { key: "saved_sprites",  label: "Saved Sprites",   group: "Output" },
    { key: "saved_webfonts", label: "Saved WebFonts",  group: "Output" },
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
const menuList = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((m) => String(m).trim()).filter((m) => MENU_KEYS.includes(m));

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

/** All roles: built-ins (with any saved menu override) followed by custom roles. */
async function loadRoles(req) {
    const rows = await store.forRequest(req).all("roles");
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out = Object.keys(BUILTIN).map((key) => {
        const b = BUILTIN[key], row = byKey.get(key);
        return { key, name: b.name, builtin: true, fixed: !!b.fixed, rowId: row ? row.ROWID : null,
            menus: b.fixed ? b.menus : (row ? menuList(row.menus) : b.menus) };
    });
    for (const r of rows) if (!BUILTIN[r.key]) out.push({ key: r.key, name: r.name, builtin: false, fixed: false, rowId: r.ROWID, menus: menuList(r.menus) });
    return out;
}

/** { role, menus } for a signed-in email. */
async function getAccess(req, email) {
    const e = norm(email);
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

module.exports = { MENUS, MENU_KEYS, BUILTIN, ASSIGNABLE_BUILTIN, loadRoles, getAccess, getRole, requireRole, norm, slug, menuList, isExpired, approverOf };
