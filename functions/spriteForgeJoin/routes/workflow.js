"use strict";

/**
 * Icon verification workflow routes (all require a signed-in session):
 *
 *   GET    /api/me                      → { email, name, role, menus[] }  (menus the role may open)
 *   GET    /api/roles                   → roles + the menu catalog                              [admin]
 *   POST   /api/roles                   → { name, menus[] }  create a custom role               [admin]
 *   PATCH  /api/roles/:key              → { menus[] }  set the menus a role may open            [admin]
 *   DELETE /api/roles/:key              → custom roles only, and only when no member uses it    [admin]
 *   GET    /api/users                   → every user that has logged in (+ member type)         [admin]
 *   GET    /api/members                 → member list                                           [admin]
 *   POST   /api/members                 → { userEmail, userName?, userAvatar?, memberType (role), approverType?, expiresAt? } [admin]
 *   PATCH  /api/members/:id             → { memberType?, approverType?, expiresAt? }            [admin]
 *                                         approverType: "none" (default) | "designer" | "ui"  — who may be assigned to review
 *   DELETE /api/members/:id                                                                     [admin]
 *   GET    /api/icon-status             → [{ symbolId, sprite, status }]
 *   POST   /api/requests                → { symbolId, iconName, svg, targetSprite, note }; the Visual audit approvers are mailed first
 *   GET    /api/requests                → admins see all; others see requested-by-me + assigned-to-me
 *   GET    /api/requests/:id            → request + event timeline
 *   POST   /api/requests/:id/assign     → { designer?, ui? } optional: narrow a review to one approver (who is mailed) [admin]
 *   POST   /api/requests/:id/review     → { decision: approve|reject, note }  (any approver of the pool, first decision counts)
 *   POST   /api/mail/test               → send a test mail to the signed-in admin; reports where it ran + the exact error [admin]
 *   POST   /api/requests/:id/resend     → mail the approvers of every still-open review again          [admin]
 *   DELETE /api/requests/:id            → admin: any request; requester: own pending/rejected request
 *   POST   /api/requests/:id/push       → { commitSha? }  mark pushed to the main library       [admin]
 *
 * Icon status: absent = unverified; requested → mock_verified (both teams approved) → master_verified.
 * The sprite write itself is done by the client through /api/master-library/save; /push records it.
 */

const express = require("express");
const store = require("../lib/store");
const orgUsers = require("../lib/org-users");
const { sendMail, approvalMail } = require("../lib/mailer");
const { MENUS, loadRoles, getAccess, requireRole, norm, slug, menuList, isExpired, approverOf, BUILTIN } = require("../lib/roles");

// ALLOW_SELF_APPROVAL=true lets a requester who is also an approver review (and be mailed about) their own request.
// Off by default: verification means a second person looks at it. Turn it on for very small teams or for testing.
const allowSelfApproval = () => String(process.env.ALLOW_SELF_APPROVAL || "").toLowerCase() === "true";
const isOwnRequest = (r, email) => !allowSelfApproval() && norm(r.requestedBy) === norm(email);

const TARGET_SPRITES = ["crmutil_icons", "svg_cssicons"]; // utilicon / cssicon
const str = (v, max) => String(v == null ? "" : v).slice(0, max || 500);

// Optional access expiry: ISO string, must be a valid future time. "" clears it. Returns null when invalid.
function parseExpiry(v) {
    if (v == null || v === "") return "";
    const t = new Date(v);
    return isNaN(t.getTime()) || t.getTime() <= Date.now() ? null : t.toISOString();
}

// Approver type of a member form: "none" | "designer" | "ui". Returns null when invalid.
function parseApprover(v) {
    const a = String(v == null || v === "" ? "none" : v).toLowerCase();
    return ["none", "designer", "ui"].includes(a) ? a : null;
}

function createWorkflowRouter({ requireSession }) {
    const router = express.Router();
    // Mounted at /api, so gate only our own paths (other /api routes stay as they were).
    router.use(["/me", "/users", "/org-users", "/members", "/roles", "/mail", "/icon-status", "/requests"], requireSession);

    const me = (req) => req.auth.session.user;

    async function logEvent(db, requestId, req, action, note) {
        await db.insert("request_events", {
            requestId: String(requestId),
            actor: me(req).email || "",
            action,
            note: str(note, 500)
        });
    }

    // Which review slot ("designer" | "ui" | "") this person may act on for request r. Every active approver of a
    // type is in the pool unless an admin assigned that slot to one person; nobody reviews their own request.
    function reviewSlot(members, email, r) {
        const e = norm(email);
        const m = members.find((x) => norm(x.userEmail) === e);
        if (!e || !m || isExpired(m) || isOwnRequest(r, e)) return "";
        const type = approverOf(m);
        if (!type) return "";
        if (type === "ui" && r.designerDecision !== "approved") return ""; // the UI review starts after the Designer approved
        const assigned = type === "designer" ? r.assignedDesigner : r.assignedUI;
        return assigned && norm(assigned) !== e ? "" : type;
    }
    const slotDecision = (r, slot) => (slot === "designer" ? r.designerDecision : slot === "ui" ? r.uiDecision : "");

    // Mail every active approver of `type` (except the requester); returns { sent[], failed[] }.
    async function mailApprovers(req, db, request, type, members) {
        const pool = members.filter((m) => !isExpired(m) && approverOf(m) === type && !isOwnRequest(request, m.userEmail));
        const sent = [], failed = [];
        for (const m of pool) {
            const msg = approvalMail(req, { role: type, request });
            const out = await sendMail(req, { to: m.userEmail, subject: msg.subject, html: msg.html, text: msg.text });
            (out.ok ? sent : failed).push({ to: m.userEmail, dev: !!out.dev, error: out.error });
        }
        if (sent.length || failed.length) {
            await logEvent(db, request.ROWID, req, failed.length && !sent.length ? "mail_failed" : "mail_sent",
                `${type === "ui" ? "UI audit" : "Visual audit"} approvers notified (${sent.length}${sent.some((x) => x.dev) ? ", logged in local run" : ""}): ${sent.map((x) => x.to).join(", ")}` +
                (failed.length ? `; failed: ${failed.map((x) => x.to + " (" + x.error + ")").join(", ")}` : ""));
        }
        return { pool, sent, failed };
    }

    // "sent" | "partial" | "failed" | "logged" (local run without credentials) | "" (nobody to mail)
    function mailState(results) {
        const sent = results.reduce((n, r) => n + r.sent.length, 0), failed = results.reduce((n, r) => n + r.failed.length, 0);
        if (!sent && !failed) return "";
        if (failed) return sent ? "partial" : "failed";
        return results.some((r) => r.sent.some((x) => x.dev)) ? "logged" : "sent";
    }

    async function setIconStatus(db, symbolId, sprite, status, req) {
        const rows = await db.all("icon_status");
        const row = rows.find((r) => r.symbolId === symbolId && r.sprite === sprite);
        const fields = { symbolId, sprite, status, updatedBy: me(req).email || "" };
        if (row) await db.update("icon_status", row.ROWID, fields);
        else await db.insert("icon_status", fields);
    }

    const wrap = (fn) => async (req, res) => {
        try { await fn(req, res); }
        catch (err) {
            console.error("[workflow]", req.method, req.path, err.message);
            res.status(500).json({ success: false, message: err.message || "Request failed" });
        }
    };

    // ── identity ────────────────────────────────────────────────────────────
    router.get("/me", wrap(async (req, res) => {
        const u = me(req);
        const access = await getAccess(req, u.email);
        res.json({ success: true, email: u.email, name: u.name, role: access.role, menus: access.menus });
    }));

    // ── users + members (admin) ─────────────────────────────────────────────
    router.get("/users", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const [users, members] = await Promise.all([db.all("user_data"), db.all("members")]);
        const memberOf = new Map(members.map((m) => [norm(m.userEmail), m]));
        const seen = new Set();
        const list = [];
        for (const u of users) {
            const email = norm(u.userEmail);
            if (!email || seen.has(email)) continue;
            seen.add(email);
            const m = memberOf.get(email);
            list.push({ name: u.userName || email, email: u.userEmail, memberType: m ? m.memberType : null, approver: m && !isExpired(m) ? approverOf(m) : "" });
        }
        // Members who never logged in (added by email) still appear.
        for (const m of members) {
            const email = norm(m.userEmail);
            if (!seen.has(email)) { seen.add(email); list.push({ name: m.userName || m.userEmail, email: m.userEmail, memberType: m.memberType, approver: isExpired(m) ? "" : approverOf(m) }); }
        }
        const type = String(req.query.approver || req.query.type || "").toLowerCase();
        res.json({ success: true, users: type ? list.filter((u) => u.approver === type) : list });
    }));

    // The signed-in admin's own refresh token (saved at login with the People scope), if any.
    async function adminRefreshToken(req) {
        const email = norm(me(req).email);
        const row = (await store.forRequest(req).all("admin_tokens")).find((r) => norm(r.userEmail) === email);
        return row ? row.refreshToken : "";
    }

    // Zoho People shows each login only the records its role may see, so try the signed-in admin's token
    // first and then every other saved admin token (e.g. a People Admin/HR), keeping the longest list.
    async function loadOrgUsers(req, force) {
        const own = await adminRefreshToken(req);
        const all = (await store.forRequest(req).all("admin_tokens")).map((r) => r.refreshToken).filter(Boolean);
        const tokens = [own, ...all.filter((t) => t !== own)].filter((t, i) => t || (i === 0 && orgUsers.isConfigured("")));
        let best = null, lastErr = null;
        for (const t of tokens) {
            try {
                const list = await orgUsers.list(force, t);
                if (!best || list.length > best.length) best = list;
                if (best.length > 1) break;
            } catch (err) { lastErr = err; }
        }
        if (!best) throw lastErr || new Error("No Zoho token available for the org user list");
        return best;
    }

    async function anyAdminToken(req) {
        const row = (await store.forRequest(req).all("admin_tokens")).find((r) => r.refreshToken);
        return row ? row.refreshToken : "";
    }

    // Photos of the org users (People photo URLs need the org token, so the browser loads them here).
    router.get("/org-users/photo", requireRole(["admin"]), async (req, res) => {
        try {
            const p = await orgUsers.fetchPhoto(req.query.u, await adminRefreshToken(req));
            res.setHeader("Content-Type", p.type);
            res.setHeader("Cache-Control", "private, max-age=3600");
            res.send(p.buffer);
        } catch (_) { res.status(404).end(); }
    });

    router.get("/org-users", requireRole(["admin"]), wrap(async (req, res) => {
        let q = String(req.query.q || "").trim().toLowerCase();
        // Nothing is loaded until the admin types: no list, and no Zoho/Cliq call (Cliq's quota is tight).
        if (q.length < 2 && req.query.refresh !== "1") return res.json({ success: true, source: "zoho-org", total: 0, needQuery: true, warning: "", users: [] });
        let users, source = "zoho-org", warning = "";
        const refresh = await adminRefreshToken(req);
        if (orgUsers.isConfigured(refresh) || (await store.forRequest(req).all("admin_tokens")).length) {
            try { users = await loadOrgUsers(req, req.query.refresh === "1"); }
            catch (err) { warning = err.message + " — log out and sign in again to grant Zoho People access"; }
        } else {
            warning = "Zoho org list not connected yet: log out and sign in again (grants Zoho People access). Showing users who have logged in";
        }
        if (users && orgUsers.isConfigured(refresh)) {
            // People shows a login only its own record; Cliq's directory search covers the rest of the org.
            try {
                const extra = await orgUsers.cliqSearch(refresh || (await anyAdminToken(req)), q, req.query.refresh === "1");
                const have = new Set(users.map((u) => u.email.toLowerCase()));
                const mine = q ? users.filter((u) => (u.name + " " + u.email + " " + (u.department || "")).toLowerCase().includes(q)) : users;
                const fresh = extra.filter((u) => !have.has(u.email.toLowerCase()) &&
                    (!q || (u.name + " " + u.email).toLowerCase().includes(q))); // Cliq's search is loose: keep real matches
                users = mine.concat(fresh);
                q = ""; // already filtered
            } catch (err) { warning = err.message; }
        }
        if (!users) {
            source = "logged-in-users";
            const rows = await store.forRequest(req).all("user_data");
            users = rows.filter((u) => u.userEmail).map((u) => ({ name: u.userName || u.userEmail, email: u.userEmail, avatar: u.userAvatar || "" }));
        }

        const total = users.length;
        const hits = (q ? users.filter((u) => (u.name + " " + u.email + " " + (u.department || "")).toLowerCase().includes(q)) : users).slice(0, 200);
        res.json({ success: true, source, total, warning, users: hits });
    }));

    router.get("/members", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        try { await db.syncMirrors("members"); } catch (_) { /* readable columns are optional */ }
        res.json({ success: true, members: await db.all("members") });
    }));

    router.post("/members", requireRole(["admin"]), wrap(async (req, res) => {
        const userEmail = str(req.body.userEmail, 200).trim();
        const memberType = String(req.body.memberType || "").toLowerCase();
        if (!/^\S+@\S+$/.test(userEmail)) return res.status(400).json({ success: false, message: "Valid userEmail required" });
        const db = store.forRequest(req);
        if (!(await assignableRoleKeys(req)).includes(memberType)) return res.status(400).json({ success: false, message: "Unknown role" });
        const members = await db.all("members");
        const existing = members.find((m) => norm(m.userEmail) === norm(userEmail));
        const expiresAt = parseExpiry(req.body.expiresAt);
        if (expiresAt === null) return res.status(400).json({ success: false, message: "Access expiration must be a valid future date" });
        const approverType = parseApprover(req.body.approverType);
        if (approverType === null) return res.status(400).json({ success: false, message: "approverType must be none, designer or ui" });
        const fields = { userEmail, userName: str(req.body.userName, 200) || userEmail, memberType, approverType, expiresAt, userAvatar: /^(https?:\/\/|proxy:)/i.test(req.body.userAvatar || "") ? str(req.body.userAvatar, 500) : "", addedBy: me(req).email || "" };
        const saved = existing ? await db.update("members", existing.ROWID, fields) : await db.insert("members", fields);
        res.json({ success: true, member: saved });
    }));

    router.patch("/members/:id", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const fields = {};
        if (req.body.memberType !== undefined) {
            const memberType = String(req.body.memberType).toLowerCase();
            if (!(await assignableRoleKeys(req)).includes(memberType)) return res.status(400).json({ success: false, message: "Unknown role" });
            fields.memberType = memberType;
        }
        if (req.body.approverType !== undefined) {
            const approverType = parseApprover(req.body.approverType);
            if (approverType === null) return res.status(400).json({ success: false, message: "approverType must be none, designer or ui" });
            fields.approverType = approverType;
        }
        if (req.body.expiresAt !== undefined) {
            const expiresAt = parseExpiry(req.body.expiresAt);
            if (expiresAt === null) return res.status(400).json({ success: false, message: "Access expiration must be a valid future date" });
            fields.expiresAt = expiresAt;
        }
        const saved = await db.update("members", req.params.id, fields);
        if (!saved) return res.status(404).json({ success: false, message: "Member not found" });
        res.json({ success: true, member: saved });
    }));

    router.delete("/members/:id", requireRole(["admin"]), wrap(async (req, res) => {
        await store.forRequest(req).remove("members", req.params.id);
        res.json({ success: true });
    }));

    // ── roles + the menus each role may open (admin only) ───────────────────
    // Roles a member can hold: Admin, Designer, UI and every custom role ("user" is the implicit default).
    async function assignableRoleKeys(req) {
        return (await loadRoles(req)).filter((r) => r.key !== "user").map((r) => r.key);
    }

    router.get("/roles", requireRole(["admin"]), wrap(async (req, res) => {
        res.json({ success: true, roles: await loadRoles(req), menus: MENUS });
    }));

    router.post("/roles", requireRole(["admin"]), wrap(async (req, res) => {
        const name = str(req.body.name, 40).trim();
        const key = slug(name);
        if (!key) return res.status(400).json({ success: false, message: "Role name required" });
        if (BUILTIN[key] || (await loadRoles(req)).some((r) => r.key === key || r.name.toLowerCase() === name.toLowerCase())) {
            return res.status(409).json({ success: false, message: "A role with this name already exists" });
        }
        const row = await store.forRequest(req).insert("roles", { key, name, menus: menuList(req.body.menus).join(","), createdBy: me(req).email || "" });
        res.json({ success: true, role: { key, name, menus: menuList(row.menus) } });
    }));

    router.patch("/roles/:key", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const role = (await loadRoles(req)).find((r) => r.key === req.params.key);
        if (!role) return res.status(404).json({ success: false, message: "Role not found" });
        if (role.fixed) return res.status(400).json({ success: false, message: "Admin always has every menu" });
        const menus = menuList(req.body.menus).join(",");
        if (role.rowId) await db.update("roles", role.rowId, { menus });
        else await db.insert("roles", { key: role.key, name: role.name, menus, createdBy: me(req).email || "" }); // override of a built-in
        res.json({ success: true });
    }));

    router.delete("/roles/:key", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const role = (await loadRoles(req)).find((r) => r.key === req.params.key);
        if (!role) return res.status(404).json({ success: false, message: "Role not found" });
        if (role.builtin) return res.status(400).json({ success: false, message: "Built-in roles cannot be deleted" });
        if ((await db.all("members")).some((m) => m.memberType === role.key)) {
            return res.status(409).json({ success: false, message: "Members still have this role — change their role first" });
        }
        await db.remove("roles", role.rowId);
        res.json({ success: true });
    }));

    // ── icon status ─────────────────────────────────────────────────────────
    router.get("/icon-status", wrap(async (req, res) => {
        const rows = await store.forRequest(req).all("icon_status");
        res.json({ success: true, statuses: rows.map((r) => ({ symbolId: r.symbolId, sprite: r.sprite, status: r.status })) });
    }));

    // ── requests ────────────────────────────────────────────────────────────
    router.post("/requests", requireRole(), wrap(async (req, res) => {
        const b = req.body || {};
        const symbolId = str(b.symbolId, 200).trim();
        const sprite = str(b.sprite || "crmutil_icons", 100);
        const targetSprite = String(b.targetSprite || "");
        if (!symbolId) return res.status(400).json({ success: false, message: "symbolId required" });
        if (!TARGET_SPRITES.includes(targetSprite)) return res.status(400).json({ success: false, message: "targetSprite must be crmutil_icons or svg_cssicons" });
        const svg = String(b.svg == null ? "" : b.svg);
        if (!svg) return res.status(400).json({ success: false, message: "svg required" });
        if (svg.length > 6000) return res.status(400).json({ success: false, message: `This icon's SVG is too large to store in a request (${svg.length} of 6000 characters). Simplify the icon first.` });

        const db = store.forRequest(req);
        const open = (await db.all("icon_requests")).find(
            (r) => r.symbolId === symbolId && r.sprite === sprite && ["pending", "approved"].includes(r.status));
        if (open) return res.status(409).json({ success: false, message: "An open request already exists for this icon", request: open });

        const saved = await db.insert("icon_requests", {
            symbolId, sprite, iconName: str(b.iconName || symbolId, 200), svg,
            targetSprite, note: str(b.note, 1000),
            requestedBy: me(req).email || "", requestedByName: me(req).name || "",
            status: "pending", assignedDesigner: "", assignedUI: "",
            designerDecision: "", uiDecision: "", designerBy: "", uiBy: "", notifiedDesigners: "", notifiedUI: "", pushCommitSha: ""
        });
        await setIconStatus(db, symbolId, sprite, "requested", req);
        await logEvent(db, saved.ROWID, req, "requested", b.note);

        // Step 1: submitting mails the Visual audit approvers only (a mail problem never blocks the request).
        // The UI audit approvers are mailed after a Visual audit approver approves (see /review).
        const members = await db.all("members");
        const d = await mailApprovers(req, db, saved, "designer", members);
        // The pool is every eligible approver, whether or not the mail got through (mailStatus says how it went).
        const request = await db.update("icon_requests", saved.ROWID, {
            notifiedDesigners: d.pool.map((x) => x.userEmail).join(","), mailStatus: mailState([d])
        });
        // Nobody to mail because the only Visual audit approver is the requester themselves?
        const selfOnly = !d.pool.length && members.some((m) => !isExpired(m) && approverOf(m) === "designer" && norm(m.userEmail) === norm(me(req).email));
        res.json({ success: true, request: request || saved,
            notified: { designer: d.sent.length, ui: 0, failed: d.failed.length, local: d.sent.some((x) => x.dev), error: (d.failed[0] || {}).error || "", selfOnly } });
    }));

    router.get("/requests", requireRole(), wrap(async (req, res) => {
        const mine = norm(me(req).email);
        const db = store.forRequest(req);
        let list = await db.all("icon_requests");
        if (req.role !== "admin") {
            const members = await db.all("members");
            list = list.filter((r) => norm(r.requestedBy) === mine || reviewSlot(members, mine, r));
        }
        // The svg snapshot is only needed on the detail view.
        res.json({ success: true, role: req.role, requests: list.map(({ svg, ...rest }) => rest).reverse() });
    }));

    router.get("/requests/:id", requireRole(), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const [reqs, events] = await Promise.all([db.all("icon_requests"), db.all("request_events")]);
        const r = reqs.find((x) => String(x.ROWID) === req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Request not found" });
        const mine = norm(me(req).email);
        const slot = reviewSlot(await db.all("members"), mine, r);
        if (req.role !== "admin" && norm(r.requestedBy) !== mine && !slot) {
            return res.status(403).json({ success: false, message: "Not allowed for your role" });
        }
        res.json({ success: true, request: r, events: events.filter((e) => String(e.requestId) === String(r.ROWID)),
            canReview: r.status === "pending" && slot && !slotDecision(r, slot) ? slot : "" });
    }));

    router.post("/requests/:id/assign", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const r = (await db.all("icon_requests")).find((x) => String(x.ROWID) === req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Request not found" });
        if (r.status !== "pending") return res.status(409).json({ success: false, message: "Request is no longer pending" });
        const members = await db.all("members");
        const isType = (email, type) => members.some((m) => norm(m.userEmail) === norm(email) && approverOf(m) === type && !isExpired(m));
        const designer = str(req.body.designer, 200).trim();
        const ui = str(req.body.ui, 200).trim();
        if (!designer && !ui) return res.status(400).json({ success: false, message: "Pick a Visual audit and/or a UI audit approver" });
        if (designer && !isType(designer, "designer")) return res.status(400).json({ success: false, message: "The Visual audit approver must be an active Visual audit approver" });
        if (ui && !isType(ui, "ui")) return res.status(400).json({ success: false, message: "The UI audit approver must be an active UI audit approver" });
        const fields = {};
        if (designer) Object.assign(fields, { assignedDesigner: designer, designerDecision: "", designerBy: "" });
        if (ui) Object.assign(fields, { assignedUI: ui, uiDecision: "", uiBy: "" });
        const saved = await db.update("icon_requests", r.ROWID, fields);
        await logEvent(db, r.ROWID, req, "assigned", [designer && `designer: ${designer}`, ui && `ui: ${ui}`].filter(Boolean).join(", "));

        // The chosen approver is mailed again that the request is now theirs (a mail problem never blocks assigning).
        const mail = [];
        for (const [role, to] of [["designer", designer], ["ui", ui]]) {
            if (!to) continue;
            if (role === "ui" && r.designerDecision !== "approved") continue; // not their turn yet: mailed once the Designer approves
            const msg = approvalMail(req, { role, request: saved || r });
            const out = await sendMail(req, { to, subject: msg.subject, html: msg.html, text: msg.text });
            mail.push({ role, ...out });
            await logEvent(db, r.ROWID, req, out.ok ? "mail_sent" : "mail_failed",
                `${role} approval mail ${out.ok ? (out.dev ? "logged (local run)" : "sent") : "failed (" + out.error + ")"}: ${to}`);
        }
        res.json({ success: true, request: saved, mail });
    }));

    router.post("/requests/:id/review", requireRole(), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const r = (await db.all("icon_requests")).find((x) => String(x.ROWID) === req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Request not found" });
        if (r.status !== "pending") return res.status(409).json({ success: false, message: "Request is no longer pending" });
        const decision = String(req.body.decision || "");
        if (!["approve", "reject"].includes(decision)) return res.status(400).json({ success: false, message: "decision must be approve or reject" });

        const email = norm(me(req).email);
        const slot = reviewSlot(await db.all("members"), email, r);
        if (!slot) return res.status(403).json({ success: false, message: "You are not an approver for this request" });
        const decided = slotDecision(r, slot);
        if (decided) {
            const by = slot === "designer" ? r.designerBy : r.uiBy;
            return res.status(409).json({ success: false, message: `The ${slot === "ui" ? "UI" : "Visual"} audit is already ${decided}${by ? " by " + by : ""}` });
        }
        const asDesigner = slot === "designer", asUI = slot === "ui";

        const value = decision === "approve" ? "approved" : "rejected";
        const fields = {};
        if (asDesigner) Object.assign(fields, { designerDecision: value, designerBy: me(req).email || "" });
        if (asUI) Object.assign(fields, { uiDecision: value, uiBy: me(req).email || "" });
        const merged = { ...r, ...fields };
        if (value === "rejected") fields.status = "rejected";
        else if (merged.designerDecision === "approved" && merged.uiDecision === "approved") fields.status = "approved";

        const saved = await db.update("icon_requests", r.ROWID, fields);
        await logEvent(db, r.ROWID, req, `${asDesigner ? "designer" : "ui"}_${value}`, req.body.note);

        // Step 2: the Visual audit approved, so now the UI audit approvers are mailed (or the one assigned to the UI review).
        let uiMail = null;
        if (asDesigner && value === "approved" && fields.status !== "rejected") {
            const members = await db.all("members");
            const scope = r.assignedUI ? members.filter((m) => norm(m.userEmail) === norm(r.assignedUI)) : members;
            const out = await mailApprovers(req, db, { ...r, ...fields }, "ui", scope);
            uiMail = { sent: out.sent.length, failed: out.failed.length, local: out.sent.some((x) => x.dev), error: (out.failed[0] || {}).error || "", pool: out.pool.length };
            await db.update("icon_requests", r.ROWID, { notifiedUI: out.pool.map((x) => x.userEmail).join(","), mailStatus: mailState([out]) });
        }
        if (fields.status === "approved") await setIconStatus(db, r.symbolId, r.sprite, "mock_verified", req);
        if (fields.status === "rejected") await setIconStatus(db, r.symbolId, r.sprite, "unverified", req);
        res.json({ success: true, request: saved, uiMail });
    }));

    // Admin self-check: sends one mail to the signed-in admin and says where it ran and what Catalyst answered.
    router.post("/mail/test", requireRole(["admin"]), wrap(async (req, res) => {
        const to = me(req).email;
        const runtime = !!(req.headers["x-zc-projectid"] || req.headers["x-zc-admin-cred-token"]);
        const out = await sendMail(req, {
            to, subject: "Icon Assets — test mail",
            html: "<p>This is a test mail from the Icon Assets tool. If you can read it, approval mails will be delivered.</p>",
            text: "This is a test mail from the Icon Assets tool. If you can read it, approval mails will be delivered."
        });
        res.json({ success: true, ok: out.ok && !out.dev, dev: !!out.dev, runtime, from: String(process.env.MAIL_FROM || ""), to, error: out.error || "" });
    }));

    router.post("/requests/:id/resend", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const r = (await db.all("icon_requests")).find((x) => String(x.ROWID) === req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Request not found" });
        if (r.status !== "pending") return res.status(409).json({ success: false, message: "Only pending requests can be re-mailed" });
        const members = await db.all("members");
        const results = [], fields = {};
        for (const type of ["designer", "ui"]) {
            if (slotDecision(r, type)) continue; // that review is already decided
            if (type === "ui" && r.designerDecision !== "approved") continue; // the UI step starts after the Designer approved
            const assigned = type === "designer" ? r.assignedDesigner : r.assignedUI;
            // An assigned slot goes to that one person; otherwise to the whole pool.
            const scope = assigned ? members.filter((m) => norm(m.userEmail) === norm(assigned)) : members;
            const out = await mailApprovers(req, db, r, type, scope);
            results.push(out);
            // Refresh the recorded pool (requests made before approvers existed, or before this was tracked, get it now).
            fields[type === "designer" ? "notifiedDesigners" : "notifiedUI"] = out.pool.map((x) => x.userEmail).join(",");
        }
        const state = mailState(results);
        fields.mailStatus = state;
        const request = await db.update("icon_requests", r.ROWID, fields);
        res.json({ success: true, request, mailStatus: state,
            sent: results.reduce((n, x) => n + x.sent.length, 0), failed: results.reduce((n, x) => n + x.failed.length, 0),
            error: ((results.flatMap((x) => x.failed)[0]) || {}).error || "" });
    }));

    router.delete("/requests/:id", requireRole(), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const r = (await db.all("icon_requests")).find((x) => String(x.ROWID) === req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Request not found" });
        const own = norm(r.requestedBy) === norm(me(req).email);
        if (req.role !== "admin" && !(own && ["pending", "rejected"].includes(r.status))) {
            return res.status(403).json({ success: false, message: "Only an admin, or the requester while it is pending or rejected, can delete a request" });
        }
        await db.remove("icon_requests", r.ROWID);
        for (const ev of (await db.all("request_events")).filter((e) => String(e.requestId) === String(r.ROWID))) await db.remove("request_events", ev.ROWID);
        // Without an open request the icon goes back to unverified (a pushed icon stays master verified).
        if (r.status !== "pushed") {
            const stillOpen = (await db.all("icon_requests")).some((x) => x.symbolId === r.symbolId && x.sprite === r.sprite && ["pending", "approved"].includes(x.status));
            if (!stillOpen) await setIconStatus(db, r.symbolId, r.sprite, "unverified", req);
        }
        res.json({ success: true });
    }));

    router.post("/requests/:id/push", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const r = (await db.all("icon_requests")).find((x) => String(x.ROWID) === req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Request not found" });
        if (r.status !== "approved") return res.status(409).json({ success: false, message: "Both teams must approve before pushing" });
        const saved = await db.update("icon_requests", r.ROWID, { status: "pushed", pushCommitSha: str(req.body.commitSha, 80) });
        await setIconStatus(db, r.symbolId, r.sprite, "master_verified", req);
        await logEvent(db, r.ROWID, req, "pushed", `to ${r.targetSprite}`);
        res.json({ success: true, request: saved });
    }));

    return router;
}

module.exports = { createWorkflowRouter };
