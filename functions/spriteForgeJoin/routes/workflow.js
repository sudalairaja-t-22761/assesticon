"use strict";

/**
 * Icon verification workflow routes (all require a signed-in session):
 *
 *   GET    /api/me                      → { email, name, role, menus[] }  (menus the role may open)
 *   GET    /api/user-settings           → { settings: { settings, tagConfig, svgo } | null, updatedAt }  the signed-in user's Sprite Settings
 *   PUT    /api/user-settings           → { settings, tagConfig, svgo }  save them (one record per user)
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
 *   GET    /api/icon-categories         → { categories: [{ id, name, options, builtin, names[] }] }  Library icon categories;
 *                                         options: true gives its icons the Size + Stroke width options in the preview
 *   POST   /api/icon-categories         → { name, options? }  new category                                          [admin]
 *   PATCH  /api/icon-categories/:id     → { name?, options? }                                                       [admin]
 *   DELETE /api/icon-categories/:id     → not the built-in Stroke icons category                                    [admin]
 *   PUT    /api/icon-categories/:id/icons → { names[], enabled }  add / remove icons                                [admin]
 *   POST   /api/release/published       → { status: published|failed, name, version, tag, branch, commit?, subject?, error?, commits[]? }
 *                                         commits = the icon commits in that release: their requests get the result in the timeline
 *                                         mail every admin (+ RELEASE_NOTIFY_EMAILS) the publish result. Called by
 *                                         scripts/npm-publisher.js; header x-release-token = RELEASE_NOTIFY_TOKEN
 *   GET    /api/release/republish       → { branches: { <branch>: [commitSha] } }  the re-publishes admins asked for; polled by
 *                                         scripts/npm-publisher.js (same x-release-token), which answers through /release/published
 *   POST   /api/requests/:id/republish  → admin asks the npm publisher to publish a pushed request again            [admin]
 *   POST   /api/requests                → { symbolId, iconName, svg, targetSprite, note, stage?, inMock? }; the Visual audit approvers are mailed first
 *                                         stage "mock" (default): an unverified icon; stage "master": a mock verified icon
 *   GET    /api/requests                → admins see all; others see requested-by-me + assigned-to-me
 *   GET    /api/requests/:id            → request + event timeline
 *   POST   /api/requests/:id/assign     → { designer?, ui? } optional: narrow a review to one approver (who is mailed) [admin]
 *   POST   /api/requests/:id/review     → { decision: approve|reject, note }  (any approver of the pool, first decision counts)
 *   POST   /api/mail/test               → send a test mail to the signed-in admin; reports where it ran + the exact error [admin]
 *   POST   /api/requests/:id/resend     → mail the approvers of every still-open review again          [admin]
 *   DELETE /api/requests/:id            → admin: any request, ?note= reason required (sent to the requester + the admins);
 *                                         requester: own pending/rejected request
 *   POST   /api/requests/:id/reject     → { note }  admin rejects an open request at any stage (Visual audit, UI audit,
 *                                         waiting for push); the reason is required                                 [admin]
 *   POST   /api/requests/:id/push       → { commitSha? }  record the push   [admin]
 *   POST   /api/requests/:id/decline    → { note }  admin turns down an audited master request         [admin]
 *   POST   /api/cliq/test               → send a test Cliq bot message to the signed-in admin              [admin]
 *   POST   /api/cliq/action             → { action: approve|reject|push|decline, requestId, email, name?, note? }
 *                                         called by the Cliq bot's button / form functions (cliq/*.dg); no session:
 *                                         header x-cliq-token = CLIQ_ACTION_TOKEN. Answers { ok, message } for the bot.
 *                                         "push" does the whole push on the server (sprite edit + commit + record).
 *   GET    /api/cliq/preview/:id.png    → PNG of a request's icon for the bot card; ?sig= is an HMAC of the id
 *
 * Notifications: every step is sent by mail AND by the Cliq bot (lib/mailer.js + lib/cliq.js) —
 *   approvers get "waiting for your approval" (Cliq: card with Approve / Reject + a note form),
 *   the requester gets every status change, admins get every status change, and once both audits passed
 *   only admins get the push card (Push to mock / Approve & push to master + Decline).
 *
 * Flow (UI library = Iconassest, mock = REPO_BRANCH, master = MASTER_REPO_BRANCH):
 *   unverified ─request─▶ requested ─Visual + UI audit─▶ admin pushes to mock ─▶ mock_verified
 *   mock_verified ─request─▶ master_requested ─Visual + UI audit─▶ admin approves + pushes to master ─▶ master_verified
 * A rejection (or a deleted request) puts the icon back where that stage started (unverified / mock_verified).
 * In the app the sprite write is done by the client through /api/master-library/save (mock) or
 * /api/master-branch/save (master, admin only) and /push records it; from the Cliq bot the server does both.
 */

const express = require("express");
const store = require("../lib/store");
const orgUsers = require("../lib/org-users");
const { sendMail, approvalMail, releaseMail, statusMail } = require("../lib/mailer");
const cliq = require("../lib/cliq");
const merge = require("../lib/sprite-merge");
const crypto = require("crypto");
const zlib = require("zlib");
const { MENUS, MENU_KEYS, loadRoles, syncRoleRows, setRoleMenu, setRoleMenus, createRole, renameRole, deleteRole, getAccess, getRole, requireRole, norm, slug, menuList, isExpired, approverOf, BUILTIN } = require("../lib/roles");

// ALLOW_SELF_APPROVAL=true lets a requester who is also an approver review (and be mailed about) their own request.
// Off by default: verification means a second person looks at it. Turn it on for very small teams or for testing.
const allowSelfApproval = () => String(process.env.ALLOW_SELF_APPROVAL || "").toLowerCase() === "true";
const isOwnRequest = (r, email) => !allowSelfApproval() && norm(r.requestedBy) === norm(email);

const TARGET_SPRITES = ["crmutil_icons", "svg_cssicons"]; // utilicon / cssicon
const OPEN = ["pending", "approved"];
const stageOf = (r) => (r && r.stage === "master" ? "master" : "mock");
// Where an icon goes back to when a request of that stage is rejected or deleted.
const startStatus = (r) => (stageOf(r) === "master" ? "mock_verified" : "unverified");
const str = (v, max) => String(v == null ? "" : v).slice(0, max || 500);

// A request keeps a snapshot of the icon's SVG. One record holds 10,000 characters, so an SVG over SVG_INLINE is stored
// Brotli-compressed (svgz, base64) — lossless, the exact same markup comes back. readSvg works for both forms.
const SVG_INLINE = 6000;
function packSvg(svg) {
    if (svg.length <= SVG_INLINE) return { svg, svgz: "" };
    const svgz = zlib.brotliCompressSync(Buffer.from(svg, "utf8"), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).toString("base64");
    return svgz.length <= SVG_INLINE ? { svg: "", svgz } : null;
}
const readSvg = (r) => (r.svgz ? zlib.brotliDecompressSync(Buffer.from(r.svgz, "base64")).toString("utf8") : r.svg || "");

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

function createWorkflowRouter({ requireSession, repos }) {
    const router = express.Router();
    // Mounted at /api, so gate only our own paths (other /api routes stay as they were).
    router.use(["/me", "/user-settings", "/users", "/share-users", "/org-users", "/members", "/roles", "/mail", "/icon-status", "/icon-categories", "/requests", "/activity-log"], requireSession);

    const me = (req) => req.auth.session.user;
    // Who is acting: the signed-in user of a session route, or the { email, name, role } the Cliq bot sent.
    const actorOf = (x) => (x && x.auth ? { email: me(x).email || "", name: me(x).name || "", role: x.role || "" } : (x || { email: "" }));
    const fail = (status, message) => Object.assign(new Error(message), { status });

    async function logEvent(db, requestId, who, action, note) {
        await db.insert("request_events", {
            requestId: String(requestId),
            actor: actorOf(who).email || "",
            action,
            note: str(note, 500)
        });
    }

    // Which review slot ("designer" | "ui" | "") this person may act on for request r. Every active approver of a
    // type is in the pool unless an admin assigned that slot to one person; nobody reviews their own request.
    // An admin may approve both audits: the Visual audit first, then the UI audit, whoever is assigned.
    function reviewSlot(members, email, r, admin) {
        const e = norm(email);
        if (admin && e && !isOwnRequest(r, e)) return r.designerDecision !== "approved" ? "designer" : "ui";
        const m = members.find((x) => norm(x.userEmail) === e);
        if (!e || !m || isExpired(m) || isOwnRequest(r, e)) return "";
        const type = approverOf(m);
        if (!type) return "";
        if (type === "ui" && r.designerDecision !== "approved") return ""; // the UI review starts after the Designer approved
        const assigned = type === "designer" ? r.assignedDesigner : r.assignedUI;
        return assigned && norm(assigned) !== e ? "" : type;
    }
    const slotDecision = (r, slot) => (slot === "designer" ? r.designerDecision : slot === "ui" ? r.uiDecision : "");
    // Pushing an audited icon (mock or master) is admin only. req.role is set by requireRole.
    const canPush = (req) => req.role === "admin";

    // One person, both channels. mail: { subject, html, text } | null, card: a lib/cliq.js message | null.
    async function tell(req, to, mail, card) {
        const [m, c] = await Promise.all([
            mail ? sendMail(req, { to, subject: mail.subject, html: mail.html, text: mail.text }) : null,
            card ? cliq.sendCliq(req, { to, ...card }) : null
        ]);
        return { to, mail: m, cliq: c };
    }
    // { sent[], failed[] } of one channel ("mail" | "cliq") from tell() results.
    function channel(results, key) {
        const sent = [], failed = [];
        for (const r of results) {
            const out = r[key];
            if (out) (out.ok ? sent : failed).push({ to: r.to, dev: !!out.dev, error: out.error, via: out.via });
        }
        return { sent, failed };
    }
    const listFailed = (failed) => failed.map((x) => x.to + " (" + x.error + ")").join(", ");

    // Mail + Cliq card to every active approver of `type` (except the requester): "waiting for your approval".
    // Returns the mail result as before ({ pool, sent[], failed[] }) plus cliq: { sent[], failed[] }.
    async function mailApprovers(req, db, request, type, members, who) {
        const pool = members.filter((m) => !isExpired(m) && approverOf(m) === type && !isOwnRequest(request, m.userEmail));
        const results = await Promise.all(pool.map((m) => {
            const msg = approvalMail(req, { role: type, request });
            return tell(req, m.userEmail, msg, cliq.approvalCard(req, { role: type, request }));
        }));
        const { sent, failed } = channel(results, "mail"), bot = channel(results, "cliq");
        const label = type === "ui" ? "UI audit" : "Visual audit";
        if (sent.length || failed.length) {
            await logEvent(db, request.ROWID, who || req, failed.length && !sent.length ? "mail_failed" : "mail_sent",
                `${label} approvers notified (${sent.length}${sent.some((x) => x.dev) ? ", logged in local run" : ""}): ${sent.map((x) => x.to).join(", ")}` +
                (failed.length ? `; failed: ${listFailed(failed)}` : ""));
        }
        if (bot.sent.length || bot.failed.length) {
            await logEvent(db, request.ROWID, who || req, bot.failed.length && !bot.sent.length ? "cliq_failed" : "cliq_sent",
                `${label} approvers got the Cliq card (${bot.sent.length}${bot.sent.some((x) => x.dev) ? ", logged only: the bot is not configured" : ""}): ${bot.sent.map((x) => x.to + (x.via === "cliq-direct" ? " (direct message: not subscribed to the bot)" : "")).join(", ")}` +
                (bot.failed.length ? `; failed: ${listFailed(bot.failed)}` : ""));
        }
        return { pool, sent, failed, cliq: bot };
    }

    // Every admin: ADMIN_EMAILS + members with the Admin role whose access has not expired.
    const adminEmails = (members) => [...new Set(String(process.env.ADMIN_EMAILS || "").split(",").map(norm)
        .concat(members.filter((m) => m.memberType === "admin" && !isExpired(m)).map((m) => norm(m.userEmail))).filter(Boolean))];

    // The text of one status update, for the requester (you: true) or an admin. Used by the mail and the Cliq card.
    function statusInfo(event, r, o, you) {
        const icon = `*${r.iconName || r.symbolId}*`, branch = stageOf(r) === "master" ? "master branch" : "mock branch";
        const who = you ? "Your request for the icon " + icon : `The request of ${r.requestedByName || r.requestedBy} for the icon ${icon}`;
        const by = (o.actor && (o.actor.name || o.actor.email)) || "";
        const base = { by, note: str(o.note, 500), tone: "" };
        switch (event) {
            case "requested": return { ...base, by: "", note: "", title: you ? "Request sent to Visual audit" : "New icon request",
                line: `${who} (${branch}) was sent to the Visual audit approvers. The UI audit follows after the Visual audit approves.` };
            case "designer_approved": return { ...base, tone: "ok", title: "Visual audit approved",
                line: `${who} passed the Visual audit. It moved to the UI audit.` };
            case "designer_rejected": return { ...base, tone: "bad", title: "Visual audit rejected",
                line: `${who} was rejected in the Visual audit. The request is closed; a new request can be raised after the icon is fixed.` };
            case "ui_rejected": return { ...base, tone: "bad", title: "UI audit rejected",
                line: `${who} was rejected in the UI audit. The request is closed; a new request can be raised after the icon is fixed.` };
            case "ready": return { ...base, tone: "ok", title: you ? "Both audits approved" : `Ready to push to ${stageOf(r) === "master" ? "master" : "mock"}`,
                line: you ? `${who} passed the Visual audit and the UI audit. It is waiting for an admin to push it to the ${branch}.`
                    : `${who} passed both audits. It is waiting for an admin to push it to the ${branch}.` };
            case "pushed": return { ...base, tone: "ok", title: `Pushed to ${branch}`,
                line: o.alreadyThere ? `${who}: the same icon is already on the ${branch}, so the request is recorded as pushed.`
                    : `${who} was pushed to the ${branch}. The npm version follows as soon as it is published.` };
            case "admin_rejected": return { ...base, tone: "bad", title: "Request rejected by an admin",
                line: `${who} (${branch}) was rejected by an admin. The request is closed; a new request can be raised after the icon is fixed.` };
            case "deleted": return { ...base, tone: "bad", title: "Request deleted by an admin",
                line: `${who} (${branch}) was deleted by an admin.${r.status === "pushed" ? " The icon stays on the branch." : ""}` };
            case "declined": return { ...base, tone: "bad", title: "Master push declined",
                line: `${who} was declined by an admin. The icon stays mock verified.` };
            default: return { ...base, title: "Icon request update", line: `${who}: ${event}.` };
        }
    }

    /**
     * Tell the requester and every admin about a status change, by mail and by the Cliq bot.
     * event: requested | designer_approved | designer_rejected | ui_rejected | ready | pushed | declined
     * o: { actor: { email, name }, note?, members?, skip?: emails already told (the approvers of this step), alreadyThere? }
     * The person who acted is not told about their own action. "ready" is the exception: every admin gets the push
     * card (Push / Decline), also the one who gave the last approval. A problem here never blocks the workflow.
     */
    async function notify(req, db, event, request, o) {
        try {
            const members = o.members || await db.all("members");
            const actor = norm(o.actor && o.actor.email), requester = norm(request.requestedBy);
            const skip = new Set((o.skip || []).map(norm));
            const admins = adminEmails(members);
            const jobs = [];
            const status = (to, you) => {
                const info = statusInfo(event, request, o, you);
                return tell(req, to, statusMail(req, { request, info }), cliq.statusCard(req, { request, info }));
            };
            if (event === "ready") {
                for (const a of admins) {
                    const info = statusInfo(event, request, o, false);
                    jobs.push(tell(req, a, statusMail(req, { request, info }), cliq.pushCard(req, { request })));
                }
                if (requester && requester !== actor && !admins.includes(requester)) jobs.push(status(requester, true));
            } else {
                if (requester && requester !== actor && !skip.has(requester)) jobs.push(status(requester, true));
                for (const a of admins) if (a !== actor && a !== requester && !skip.has(a)) jobs.push(status(a, false));
            }
            const results = await Promise.all(jobs);
            const failed = channel(results, "mail").failed.map((x) => "mail to " + x.to + " (" + x.error + ")")
                .concat(channel(results, "cliq").failed.map((x) => "Cliq to " + x.to + " (" + x.error + ")"));
            if (failed.length) await logEvent(db, request.ROWID, o.actor, "notify_failed", `${event}: ${failed.join("; ")}`.slice(0, 500));
            return results;
        } catch (err) {
            console.error("[workflow] notify", event, err.message);
            return [];
        }
    }

    // "sent" | "partial" | "failed" | "logged" (local run without credentials) | "" (nobody to mail)
    function mailState(results) {
        const sent = results.reduce((n, r) => n + r.sent.length, 0), failed = results.reduce((n, r) => n + r.failed.length, 0);
        if (!sent && !failed) return "";
        if (failed) return sent ? "partial" : "failed";
        return results.some((r) => r.sent.some((x) => x.dev)) ? "logged" : "sent";
    }

    // drawing: fingerprint of the UI library drawing that was pushed ("" for any other change), so the Library
    // can tell a pushed icon from one whose drawing changed in the UI library afterwards.
    async function setIconStatus(db, symbolId, sprite, status, who, drawing) {
        const rows = await db.all("icon_status");
        const row = rows.find((r) => r.symbolId === symbolId && r.sprite === sprite);
        const fields = { symbolId, sprite, status, drawing: str(drawing, 80), updatedBy: actorOf(who).email || "" };
        if (row) await db.update("icon_status", row.ROWID, fields);
        else await db.insert("icon_status", fields);
    }

    const wrap = (fn) => async (req, res) => {
        try { await fn(req, res); }
        catch (err) {
            console.error("[workflow]", req.method, req.path, err.message);
            res.status(err.status || 500).json({ success: false, message: err.message || "Request failed" });
        }
    };

    // ── the workflow actions (shared by the session routes and the Cliq bot) ───
    // Each takes the acting person as actor = { email, name, role } and throws fail(status, message) when a rule says no.
    const findRequest = async (db, id) => {
        const r = (await db.all("icon_requests")).find((x) => String(x.ROWID) === String(id));
        if (!r) throw fail(404, "Request not found");
        return r;
    };

    /** Approve / reject one audit. Returns { request, slot, uiMail }. */
    async function reviewRequest(req, db, actor, id, decision, note) {
        const r = await findRequest(db, id);
        if (r.status !== "pending") throw fail(409, "Request is no longer pending" + (r.status === "rejected" ? " (it was rejected)" : r.status === "approved" ? " (both audits are approved)" : ""));
        if (!["approve", "reject"].includes(decision)) throw fail(400, "decision must be approve or reject");
        if (decision === "reject" && !str(note).trim()) throw fail(400, "A note is required to reject: say what has to change");

        const members = await db.all("members");
        const slot = reviewSlot(members, norm(actor.email), r, actor.role === "admin");
        if (!slot) {
            const mine = members.find((x) => norm(x.userEmail) === norm(actor.email));
            throw fail(403, mine && approverOf(mine) === "ui" && r.designerDecision !== "approved"
                ? "The UI audit starts after the Visual audit is approved" : "You are not an approver for this request");
        }
        const decided = slotDecision(r, slot);
        if (decided) {
            const by = slot === "designer" ? r.designerBy : r.uiBy;
            throw fail(409, `The ${slot === "ui" ? "UI" : "Visual"} audit is already ${decided}${by ? " by " + by : ""}`);
        }
        const asDesigner = slot === "designer", asUI = slot === "ui";

        const value = decision === "approve" ? "approved" : "rejected";
        const fields = {};
        if (asDesigner) Object.assign(fields, { designerDecision: value, designerBy: actor.email || "" });
        if (asUI) Object.assign(fields, { uiDecision: value, uiBy: actor.email || "" });
        const merged = { ...r, ...fields };
        if (value === "rejected") fields.status = "rejected";
        else if (merged.designerDecision === "approved" && merged.uiDecision === "approved") fields.status = "approved";

        const saved = await db.update("icon_requests", r.ROWID, fields);
        await logEvent(db, r.ROWID, actor, `${slot}_${value}`, note);
        const now = { ...r, ...fields };

        // Step 2: the Visual audit approved, so now the UI audit approvers are notified (or the one assigned to the UI review).
        let uiMail = null, told = [];
        if (asDesigner && value === "approved" && fields.status !== "approved") {
            const scope = r.assignedUI ? members.filter((m) => norm(m.userEmail) === norm(r.assignedUI)) : members;
            const out = await mailApprovers(req, db, now, "ui", scope, actor);
            uiMail = { sent: out.sent.length, failed: out.failed.length, local: out.sent.some((x) => x.dev), error: (out.failed[0] || {}).error || "", pool: out.pool.length,
                cliq: out.cliq.sent.filter((x) => !x.dev).length, cliqFailed: out.cliq.failed.length };
            told = out.pool.map((x) => x.userEmail);
            await db.update("icon_requests", r.ROWID, { notifiedUI: told.join(","), mailStatus: mailState([out]) });
        }
        // Both audits passed: the icon keeps its requested status until an admin pushes it.
        if (fields.status === "rejected") await setIconStatus(db, r.symbolId, r.sprite, startStatus(r), actor);
        // The requester and the admins follow every step; once both audits passed only the admins get the push card.
        await notify(req, db, fields.status === "approved" ? "ready" : `${slot}_${value}`, now, { actor, note, members, skip: told });
        return { request: saved || now, slot, uiMail };
    }

    /** Record that an approved request was pushed (the sprite is already committed). Returns the saved request. */
    async function recordPush(req, db, actor, id, o) {
        const r = await findRequest(db, id);
        if (r.status === "pushed") throw fail(409, "Already pushed" + (r.pushedBy ? " by " + r.pushedBy : ""));
        if (r.status !== "approved") throw fail(409, "Both the Visual audit and the UI audit must approve before pushing");
        const master = stageOf(r) === "master";
        // Pushing an audited icon (mock or master) is admin only.
        if (actor.role !== "admin") throw fail(403, master ? "Only an admin can approve and push to the master branch" : "Only an admin can push this icon to the mock branch");
        const saved = await db.update("icon_requests", r.ROWID, { status: "pushed", pushCommitSha: str(o.commitSha, 80), pushedBy: actor.email || "", pushedAt: new Date().toISOString(),
            releaseStatus: "", releaseVersion: "", releaseError: "" });
        await setIconStatus(db, r.symbolId, r.sprite, master ? "master_verified" : "mock_verified", actor, o.drawing);
        await logEvent(db, r.ROWID, actor, master ? "pushed_master" : "pushed_mock",
            `to ${r.targetSprite}${o.version ? " · published " + str(o.version, 60) : ""}${o.alreadyThere ? " (already in the sprite)" : ""}${o.via ? " · " + o.via : ""}`);
        await notify(req, db, "pushed", { ...r, status: "pushed" }, { actor, alreadyThere: !!o.alreadyThere });
        return saved;
    }

    /** Admin turns down a master request after both audits passed. Returns the saved request. */
    async function declineRequest(req, db, actor, id, note) {
        const r = await findRequest(db, id);
        if (actor.role !== "admin") throw fail(403, "Only an admin can decline a master push");
        if (stageOf(r) !== "master" || r.status !== "approved") throw fail(409, "Only an audited master request can be declined");
        const saved = await db.update("icon_requests", r.ROWID, { status: "rejected" });
        await setIconStatus(db, r.symbolId, r.sprite, startStatus(r), actor);
        await logEvent(db, r.ROWID, actor, "admin_declined", note);
        await notify(req, db, "declined", { ...r, status: "rejected" }, { actor, note });
        return saved || { ...r, status: "rejected" };
    }

    /** Admin rejects an open request at any stage (waiting for the Visual audit, the UI audit or the push). The reason is required. */
    async function adminReject(req, db, actor, id, note) {
        const r = await findRequest(db, id);
        if (actor.role !== "admin") throw fail(403, "Only an admin can reject a request at any stage");
        if (!OPEN.includes(r.status)) throw fail(409, r.status === "pushed" ? "Already pushed — a pushed request cannot be rejected" : "This request is already closed");
        const reason = str(note, 500).trim();
        if (!reason) throw fail(400, "Add a reason so the requester knows why the request was rejected");
        const saved = await db.update("icon_requests", r.ROWID, { status: "rejected", rejectedBy: actor.email || "", rejectNote: reason });
        await setIconStatus(db, r.symbolId, r.sprite, startStatus(r), actor);
        await logEvent(db, r.ROWID, actor, "admin_rejected", reason);
        await notify(req, db, "admin_rejected", { ...r, status: "rejected" }, { actor, note: reason });
        return saved || { ...r, status: "rejected" };
    }

    /**
     * The whole push on the server (the Cliq bot's Push button): the same decisions as the app's Push button —
     * the same drawing is already on the branch → only record it; the same name with another drawing → replace that
     * icon in its sprite; otherwise add the icon to the request's sprite — then commit + push and record it.
     * Returns { request, message }.
     */
    const pushing = new Set(); // requests whose push is running in this instance (a double click must not commit twice)
    async function pushRequest(req, db, actor, id) {
        const r = await findRequest(db, id);
        const stage = stageOf(r), master = stage === "master", C = merge.compare;
        if (r.status === "pushed") throw fail(409, "Already pushed" + (r.pushedBy ? " by " + r.pushedBy : ""));
        if (r.status !== "approved") throw fail(409, "Both the Visual audit and the UI audit must approve before pushing");
        if (actor.role !== "admin") throw fail(403, master ? "Only an admin can approve and push to the master branch" : "Only an admin can push this icon to the mock branch");
        const repo = repos && repos[stage];
        if (!repo) throw fail(503, "The server-side push is not set up on this server");
        const author = { name: actor.name || actor.email, email: actor.email };
        if (!repo.canCommit(author)) throw fail(403, `${actor.email} does not have commit access to ${repo.branch} (REPO_COMMIT_USERS)`);
        if (pushing.has(String(r.ROWID))) throw fail(409, "A push of this request is already running");
        pushing.add(String(r.ROWID));
        try {
            // Fresh sprites of the branch (the first read re-reads the repository) + the UI library drawing of this icon.
            const texts = [];
            for (const f of TARGET_SPRITES) {
                const text = await repo.readText(f + ".svg", !texts.length).catch((e) => { console.warn("[push] read", f, e.message); return null; });
                texts.push(text ? { sprite: f, text } : null);
            }
            if (!texts.some(Boolean)) throw fail(502, `The sprites of ${repo.branch} could not be read — try again in a minute`);
            let uiKey = "", uiRead = false;
            for (const name of (repos.ui && repos.ui.files) || []) {
                if (!/\.svg$/i.test(name)) continue;
                const t = await repos.ui.readText(name).catch(() => null);
                if (!t) continue;
                uiRead = true;
                uiKey = C.spriteIcons(t)[C.normId(r.symbolId)] || uiKey;
            }
            if (!uiRead) throw fail(502, "The UI library sprite could not be read, so the icon cannot be compared with the branch — try again in a minute");

            const branch = C.branchIndex(texts.filter(Boolean)), nid = C.normId(r.symbolId);
            const m = C.match(r.symbolId, uiKey, branch);
            let file = r.targetSprite + ".svg", replaceId = "", alreadyThere = m === "same" || m === "alias", out = null;
            if (!alreadyThere) {
                if (m === "changed") { replaceId = branch.realId[nid]; file = (branch.sprite[nid] || r.targetSprite) + ".svg"; }
                const sprite = texts.find((t) => t && t.sprite + ".svg" === file);
                if (!sprite) throw fail(502, `${file} could not be read from ${repo.branch}`);
                const item = { name: merge.cleanIconName(r.iconName), text: readSvg(r) };
                let svg = "";
                if (replaceId) {
                    const res = merge.replaceIconInSprite(sprite.text, replaceId, item);
                    if (res.error) throw fail(422, "Could not replace icon: " + res.error);
                    svg = res.svg;
                } else {
                    const res = merge.appendIconsToSprite(sprite.text, [item]);
                    if (res.added.length) svg = res.svg;
                    else {
                        const why = res.skipped.length ? res.skipped[0].reason : "nothing to add";
                        if (why !== "already in the sprite") throw fail(422, "Could not add icon: " + why);
                        alreadyThere = true;
                    }
                }
                if (svg) {
                    out = await repo.saveFiles(author, [{ name: file, content: svg }],
                        `${replaceId ? "Update " + replaceId + " in " : "Add " + r.iconName + " to "}${file} (${stage} verified) via SpriteForge`);
                    if (!out || out.success === false || out.pushError) throw fail(502, (out && (out.pushError || out.message)) || "Push failed");
                }
            }
            const version = (out && out.release && out.release.version) || "";
            const request = await recordPush(req, db, actor, r.ROWID, { commitSha: (out && out.commit) || "", version, alreadyThere,
                drawing: r.drawing || C.fingerprint(uiKey), via: "from the Cliq bot" });
            const on = master ? "master branch" : "mock branch";
            const as = alreadyThere && m === "alias" ? branch.realId[branch.byKey[uiKey]] || "" : "";
            const message = (alreadyThere ? `The same icon is already on the ${on}${as && C.normId(as) !== nid ? " as " + as : ""} — recorded as pushed.`
                : `${replaceId ? "Replaced " + replaceId + " in " : "Pushed \"" + r.iconName + "\" to "}${file} on the ${on}.`) +
                (out && out.release && out.release.external ? " The office npm publisher now publishes the new version; the requester and the admins get it when it is out."
                    : version ? ` Version ${version}${out.release.pending ? " is committed and will be published within a minute." : " is published."}` : "") +
                (out && out.releaseOff ? " No npm version: the release is switched off on this server." : "");
            return { request, message, alreadyThere, replaced: replaceId, file };
        } finally {
            pushing.delete(String(r.ROWID));
        }
    }

    // ── identity ────────────────────────────────────────────────────────────
    router.get("/me", wrap(async (req, res) => {
        const u = me(req);
        const access = await getAccess(req, u.email);
        res.json({ success: true, email: u.email, name: u.name, role: access.role, menus: access.menus });
    }));

    // ── Sprite Settings, kept per user ──────────────────────────────────────
    // One `user_settings` record per email. Only known fields are stored, so a record always fits and stays readable.
    const SVGO_PASSES = ["removeComments", "removeMetadata", "removeEditorData", "removeUnusedNS", "removeDefaultAttrs", "removeEmptyDefs",
        "removeEmptyGroups", "removeEmptyStyles", "removeXmlSpace", "cleanupNumericValues", "collapseWhitespace", "minify"];
    const num = (v, max) => Math.min(max, Math.max(0, parseInt(v, 10) || 0));
    const past = (v) => (Array.isArray(v) ? v : []).slice(0, 6).map((x) => str(x, 60));
    function cleanUserSettings(body) {
        const s = (body && body.settings) || {}, t = (body && body.tagConfig) || {}, o = (body && body.svgo) || {};
        const passes = {};
        for (const k of SVGO_PASSES) passes[k] = !!(o.passes && o.passes[k]);
        return {
            settings: {
                spacing: num(s.spacing, 100), rowGap: num(s.rowGap, 100), padding: num(s.padding, 100),
                iconsPerRow: num(s.iconsPerRow, 100), maxSpriteWidth: num(s.maxSpriteWidth, 10000),
                gSuffix: str(s.gSuffix, 60), prefix: str(s.prefix, 60), symbolSuffix: str(s.symbolSuffix, 60),
                // naming used before the current one: icons of a loaded sprite written with it are renamed
                pastPrefixes: past(s.pastPrefixes), pastSuffixes: past(s.pastSuffixes), pastGSuffixes: past(s.pastGSuffixes)
            },
            tagConfig: {
                tagName: str(t.tagName, 60).trim() || "crmutil-icon", nameAttr: str(t.nameAttr, 60).trim() || "icon-name",
                classAttr: str(t.classAttr, 60).trim() || "icon-class", extraClass: str(t.extraClass, 200).trim()
            },
            svgo: { enabled: !!o.enabled, floatPrecision: Math.min(8, Math.max(0, parseInt(o.floatPrecision, 10) || 0)), passes }
        };
    }
    const settingsRows = async (db, email) => (await db.all("user_settings")).filter((r) => norm(r.userEmail) === norm(email));

    router.get("/user-settings", wrap(async (req, res) => {
        const rows = await settingsRows(store.forRequest(req), me(req).email);
        const row = rows[rows.length - 1];
        res.json({ success: true, settings: row ? { settings: row.settings, tagConfig: row.tagConfig, svgo: row.svgo } : null, updatedAt: row ? row.updatedAt : "" });
    }));

    router.put("/user-settings", wrap(async (req, res) => {
        const email = me(req).email;
        if (!email) return res.status(400).json({ success: false, message: "This session has no email" });
        const db = store.forRequest(req);
        const fields = { userEmail: norm(email), ...cleanUserSettings(req.body), updatedAt: new Date().toISOString() };
        const rows = await settingsRows(db, email);
        if (rows.length) await db.update("user_settings", rows[rows.length - 1].ROWID, fields);
        else await db.insert("user_settings", fields);
        for (const extra of rows.slice(0, -1)) await db.remove("user_settings", extra.ROWID); // two first saves at once
        res.json({ success: true, settings: { settings: fields.settings, tagConfig: fields.tagConfig, svgo: fields.svgo }, updatedAt: fields.updatedAt });
    }));

    // ── users + members (admin) ─────────────────────────────────────────────
    // Admin Activity Log: sign-in / sign-out counts per user and the latest events. ?days=7|30|0(all) &limit=200
    router.get("/activity-log", requireRole(["admin"]), wrap(async (req, res) => {
        const days = Math.max(0, parseInt(req.query.days, 10) || 0);
        res.json({ success: true, days, ...(await require("../lib/activity-log").summary(req, { days, limit: req.query.limit })) });
    }));

    // People a saved sprite can be shared with: the same Zoho org search as the Members dialog (type 2+ letters),
    // name / email / photo / designation only. The person searching is left out (a folder is always theirs).
    router.get("/share-users", requireRole(), wrap(async (req, res) => {
        const out = await searchOrgUsers(req, req.query.q, false);
        const self = norm(me(req).email);
        out.users = out.users.filter((u) => u.email && norm(u.email) !== self)
            .map((u) => ({ name: u.name || u.email, email: String(u.email).toLowerCase(), avatar: u.avatar || "", designation: u.designation || "", department: u.department || "" }));
        res.json(out);
    }));

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
    router.get("/org-users/photo", requireRole(), async (req, res) => {
        try {
            const p = await orgUsers.fetchPhoto(req.query.u, (await adminRefreshToken(req)) || (await anyAdminToken(req)));
            res.setHeader("Content-Type", p.type);
            res.setHeader("Cache-Control", "private, max-age=3600");
            res.send(p.buffer);
        } catch (_) { res.status(404).end(); }
    });

    // Search the Zoho org (People + Cliq directory, with the admin's org token), falling back to the users who have
    // signed in. Used by the Members dialog (admin) and the saved sprite Share picker (any signed-in user).
    async function searchOrgUsers(req, q, fresh) {
        q = String(q || "").trim().toLowerCase();
        // Nothing is loaded until someone types: no list, and no Zoho/Cliq call (Cliq's quota is tight).
        if (q.length < 2 && !fresh) return { success: true, source: "zoho-org", total: 0, needQuery: true, warning: "", users: [] };
        let users, source = "zoho-org", warning = "";
        // The signed-in admin's org token, else any saved admin token (a non-admin has none of their own).
        const refresh = (await adminRefreshToken(req)) || (await anyAdminToken(req));
        if (orgUsers.isConfigured(refresh) || (await store.forRequest(req).all("admin_tokens")).length) {
            try { users = await loadOrgUsers(req, fresh); }
            catch (err) { warning = err.message + " — log out and sign in again to grant Zoho People access"; }
        } else {
            warning = "Zoho org list not connected yet: log out and sign in again (grants Zoho People access). Showing users who have logged in";
        }
        if (users && orgUsers.isConfigured(refresh)) {
            // People shows a login only its own record; Cliq's directory search covers the rest of the org.
            try {
                const extra = await orgUsers.cliqSearch(refresh, q, fresh);
                const have = new Set(users.map((u) => u.email.toLowerCase()));
                const mine = q ? users.filter((u) => (u.name + " " + u.email + " " + (u.department || "")).toLowerCase().includes(q)) : users;
                const more = extra.filter((u) => !have.has(u.email.toLowerCase()) &&
                    (!q || (u.name + " " + u.email).toLowerCase().includes(q))); // Cliq's search is loose: keep real matches
                users = mine.concat(more);
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
        return { success: true, source, total, warning, users: hits };
    }

    router.get("/org-users", requireRole(["admin"]), wrap(async (req, res) => {
        res.json(await searchOrgUsers(req, req.query.q, req.query.refresh === "1"));
    }));

    router.get("/members", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const moved = await db.migrate("members").catch((e) => ({ ok: false, error: e.message })); // first time: copy old members across
        res.json({ success: true, members: await db.all("members"), warning: moved.ok ? "" : moved.error });
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
        let warning = "";
        await syncRoleRows(req).catch((e) => { warning = e.message; console.error("[roles] sync:", e.message); }); // every role × menu gets a row
        res.json({ success: true, roles: await loadRoles(req), menus: MENUS, warning });
    }));

    router.post("/roles", requireRole(["admin"]), wrap(async (req, res) => {
        const name = str(req.body.name, 40).trim();
        const key = slug(name);
        if (!key) return res.status(400).json({ success: false, message: "Role name required" });
        if (BUILTIN[key] || (await loadRoles(req)).some((r) => r.key === key || r.name.toLowerCase() === name.toLowerCase())) {
            return res.status(409).json({ success: false, message: "A role with this name already exists" });
        }
        await createRole(req, { key, name, menus: req.body.menus });
        res.json({ success: true, role: { key, name, menus: menuList(req.body.menus) } });
    }));

    async function editableRole(req, res) {
        let role = (await loadRoles(req)).find((r) => r.key === req.params.key);
        if (role && !role.rowId && !role.fixed) { // built-in role not seeded yet: add its row first
            await syncRoleRows(req);
            role = (await loadRoles(req)).find((r) => r.key === req.params.key);
        }
        if (!role) { res.status(404).json({ success: false, message: "Role not found" }); return null; }
        if (role.fixed) { res.status(400).json({ success: false, message: "Admin always has every menu" }); return null; }
        return role;
    }

    // Edit a role: rename it (custom roles only) and/or set all of its menus at once.
    router.patch("/roles/:key", requireRole(["admin"]), wrap(async (req, res) => {
        const role = await editableRole(req, res);
        if (!role) return;
        if (req.body.name !== undefined) {
            const name = str(req.body.name, 40).trim();
            if (role.builtin) return res.status(400).json({ success: false, message: "Built-in roles cannot be renamed" });
            if (!name) return res.status(400).json({ success: false, message: "Role name required" });
            if ((await loadRoles(req)).some((r) => r.key !== role.key && r.name.toLowerCase() === name.toLowerCase())) {
                return res.status(409).json({ success: false, message: "A role with this name already exists" });
            }
            await renameRole(req, role.rowId, name);
        }
        if (req.body.menus !== undefined) await setRoleMenus(req, role.rowId, req.body.menus);
        res.json({ success: true });
    }));

    // One toggle: { allowed: true|false } for a single menu of a role — saved straight to that menu's column on the role's row.
    router.patch("/roles/:key/menus/:menu", requireRole(["admin"]), wrap(async (req, res) => {
        const role = await editableRole(req, res);
        if (!role) return;
        if (!MENU_KEYS.includes(req.params.menu)) return res.status(400).json({ success: false, message: "Unknown menu" });
        await setRoleMenu(req, role.rowId, req.params.menu, req.body.allowed === true || req.body.allowed === "true");
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
        await deleteRole(req, role.rowId);
        res.json({ success: true });
    }));

    // ── icon status ─────────────────────────────────────────────────────────
    router.get("/icon-status", wrap(async (req, res) => {
        const rows = await store.forRequest(req).all("icon_status");
        res.json({ success: true, statuses: rows.map((r) => ({ symbolId: r.symbolId, sprite: r.sprite, status: r.status, drawing: r.drawing || "" })) });
    }));

    // ── release published (from scripts/npm-publisher.js, which runs inside the office network) ──
    // No session: the publisher authenticates with the shared RELEASE_NOTIFY_TOKEN instead.
    function releaseToken(req, res, next) {
        const want = String(process.env.RELEASE_NOTIFY_TOKEN || "");
        const got = String(req.headers["x-release-token"] || "");
        if (want.length < 24) return res.status(503).json({ success: false, message: "RELEASE_NOTIFY_TOKEN is not set on the server" });
        if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
            return res.status(401).json({ success: false, message: "Invalid release token" });
        }
        next();
    }
    const branchOf = (r) => (repos && repos[stageOf(r)] && repos[stageOf(r)].branch) || "";

    // The re-publishes admins asked for (releaseStatus "requested"), per branch: the publisher polls this every run,
    // publishes (or looks up the version the commit is already in) and answers through /release/published.
    router.get("/release/republish", releaseToken, wrap(async (req, res) => {
        const branches = {};
        for (const q of await store.forRequest(req).all("icon_requests")) {
            const sha = String(q.pushCommitSha || "").toLowerCase(), branch = branchOf(q);
            if (q.status !== "pushed" || q.releaseStatus !== "requested" || !branch || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
            if (!(branches[branch] = branches[branch] || []).includes(sha)) branches[branch].push(sha);
        }
        res.json({ success: true, branches });
    }));

    router.post("/release/published", releaseToken, wrap(async (req, res) => {
        const b = req.body || {};
        const status = b.status === "failed" ? "failed" : "published";
        const r = { status, name: str(b.name, 120), version: str(b.version, 60), tag: str(b.tag, 40), branch: str(b.branch, 120),
            commit: str(b.commit, 64), subject: str(b.subject, 300), error: str(b.error, 1500) };
        const validVersion = /^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(r.version);
        // A failure may come before the version is known (e.g. the branch could not be read).
        if (!r.name || !r.branch || (status === "published" ? !validVersion : r.version && !validVersion)) {
            return res.status(400).json({ success: false, message: "name, branch and a valid version are required" });
        }
        // Every admin (ADMIN_EMAILS + members with the Admin role whose access has not expired) + RELEASE_NOTIFY_EMAILS.
        const members = await store.forRequest(req).all("members");
        const admins = [...new Set(String(process.env.ADMIN_EMAILS || "").split(",")
            .concat(String(process.env.RELEASE_NOTIFY_EMAILS || "").split(",")).map(norm)
            .concat(members.filter((m) => m.memberType === "admin" && !isExpired(m)).map((m) => norm(m.userEmail))).filter(Boolean))];
        const msg = releaseMail(r), sent = [], failed = [];
        const adminOut = await Promise.all(admins.map((to) => tell(req, to, msg, cliq.releaseCard(req, { release: r }))));
        for (const o of adminOut) (o.mail.ok ? sent : failed).push(o.mail.ok ? o.to : { to: o.to, error: o.mail.error });
        const botFailed = adminOut.filter((o) => !o.cliq.ok).map((o) => ({ to: o.to, error: o.cliq.error }));
        console.log(`[release] ${r.name}@${r.version || "?"} (${r.tag}) ${status} on ${r.branch}: mailed ${sent.length} admin(s)${failed.length ? ", failed " + failed.length : ""}; Cliq ${adminOut.length - botFailed.length}${botFailed.length ? ", failed " + botFailed.length : ""}`);
        // The pushed requests whose icon commit is in this release: record the result on the request + its timeline.
        const commits = (Array.isArray(b.commits) ? b.commits : []).map((c) => str(c, 64).toLowerCase()).filter((c) => /^[0-9a-f]{7,64}$/.test(c));
        let requests = 0;
        if (commits.length) {
            const db = store.forRequest(req);
            const inRelease = (sha) => { const s = String(sha || "").toLowerCase(); return s.length >= 7 && commits.some((c) => c.startsWith(s) || s.startsWith(c)); };
            for (const q of (await db.all("icon_requests")).filter((x) => x.status === "pushed" && inRelease(x.pushCommitSha))) {
                if (q.releaseStatus === "published") continue; // already recorded (a later failure is about newer icons)
                await db.update("icon_requests", q.ROWID, { releaseStatus: status, releaseVersion: r.version, releaseTag: r.tag, releaseError: status === "failed" ? r.error.slice(0, 500) : "" });
                await db.insert("request_events", { requestId: String(q.ROWID), actor: "npm publisher", action: status === "published" ? "npm_published" : "npm_publish_failed",
                    note: status === "published" ? `${r.name}@${r.version} · tag ${r.tag}` : `${r.version || "version not set"}: ${r.error.slice(0, 400)}` });
                // The requester gets the version of their icon (an admin requester already got the admin message).
                const to = norm(q.requestedBy);
                if (to && !admins.includes(to)) {
                    const o = await tell(req, to, msg, cliq.releaseCard(req, { release: r, request: q }));
                    const bad = [!o.mail.ok && "mail (" + o.mail.error + ")", !o.cliq.ok && "Cliq (" + o.cliq.error + ")"].filter(Boolean);
                    if (bad.length) await db.insert("request_events", { requestId: String(q.ROWID), actor: "npm publisher", action: "notify_failed", note: `version to ${to}: ${bad.join("; ")}`.slice(0, 500) });
                }
                requests++;
            }
        }
        res.json({ success: true, sent: sent.length, failed, cliqFailed: botFailed, requests, local: !(req.headers["x-zc-projectid"] || req.headers["x-zc-admin-cred-token"]) });
    }));

    // ── icon categories (filter chips; Size + Stroke width in the Library preview) ──
    const cats = require("../lib/icon-options");
    // Validation errors from lib/icon-options carry a status; anything else is a 500 from wrap().
    const catWrap = (fn) => wrap(async (req, res) => {
        try { await fn(req, res); }
        catch (err) {
            if (!err.status) { console.error("[icon-categories]", req.method, req.path, err.stack || err.message); throw err; }
            res.status(err.status).json({ success: false, message: err.message });
        }
    });
    const catList = async (req, res, extra) => res.json({ success: true, ...extra, categories: await cats.list(req) });
    router.get("/icon-categories", catWrap((req, res) => catList(req, res)));
    router.post("/icon-categories", requireRole(["admin"]), catWrap(async (req, res) => {
        const category = await cats.createCategory(req, req.body || {});
        await catList(req, res, { category });
    }));
    router.patch("/icon-categories/:id", requireRole(["admin"]), catWrap(async (req, res) => {
        const category = await cats.updateCategory(req, req.params.id, req.body || {});
        await catList(req, res, { category });
    }));
    router.delete("/icon-categories/:id", requireRole(["admin"]), catWrap(async (req, res) => {
        await cats.deleteCategory(req, req.params.id);
        await catList(req, res);
    }));
    router.put("/icon-categories/:id/icons", requireRole(["admin"]), catWrap(async (req, res) => {
        const b = req.body || {};
        const category = await cats.setIcons(req, req.params.id, b.names || b.name, !!b.enabled);
        await catList(req, res, { category });
    }));
    // Anything else under /icon-categories: say exactly what arrived (method + URL) instead of Express's HTML 404.
    router.all(["/icon-categories", "/icon-categories/*"], (req, res) => {
        console.warn("[icon-categories] no route for", req.method, req.originalUrl);
        res.status(404).json({ success: false, message: `No route for ${req.method} ${req.originalUrl}` });
    });

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
        const packed = packSvg(svg);
        if (!packed) return res.status(400).json({ success: false, message: `This icon's SVG is too large to store in a request (${svg.length} characters, ${SVG_INLINE} after compression is the limit). Simplify the icon first.` });

        const stage = b.stage === "master" ? "master" : "mock";

        const db = store.forRequest(req);
        const sameIcon = (await db.all("icon_requests")).filter((r) => r.symbolId === symbolId && r.sprite === sprite);
        const open = sameIcon.find((r) => OPEN.includes(r.status));
        if (open) {
            return res.status(409).json({ success: false, request: open,
                message: `An open ${stageOf(open)} request already exists for this icon (${open.status === "approved" ? "audits passed, waiting for the push" : "in audit"})` });
        }
        // The Library compares the icon with the mock/master sprites (inMock / inMaster); the stored status covers the rest.
        const row = (await db.all("icon_status")).find((r) => r.symbolId === symbolId && r.sprite === sprite);
        const current = (row && row.status) || "unverified";
        // Requests from before the two stages have no stage: their push went to REPO_BRANCH, which is the mock branch now.
        const pushedToMaster = sameIcon.some((r) => r.status === "pushed" && stageOf(r) === "master");
        const onMaster = b.inMaster === true || (current === "master_verified" && pushedToMaster);
        const onMock = b.inMock === true || current === "mock_verified" || current === "master_verified";
        if (onMaster) return res.status(409).json({ success: false, message: "This icon is already master verified" });
        if (stage === "mock" && onMock) return res.status(409).json({ success: false, message: "This icon is already on the mock branch — request the push to master instead" });
        if (stage === "master" && !onMock) return res.status(409).json({ success: false, message: "Only a mock verified icon can be requested for master — get it audited and pushed to mock first" });

        const saved = await db.insert("icon_requests", {
            symbolId, sprite, iconName: str(b.iconName || symbolId, 200), ...packed,
            targetSprite, note: str(b.note, 1000), stage,
            requestedBy: me(req).email || "", requestedByName: me(req).name || "",
            drawing: str(b.drawing, 80), // fingerprint of the UI library drawing (set by the Library), recorded at the push
            status: "pending", assignedDesigner: "", assignedUI: "",
            designerDecision: "", uiDecision: "", designerBy: "", uiBy: "", notifiedDesigners: "", notifiedUI: "", pushCommitSha: ""
        });
        await setIconStatus(db, symbolId, sprite, stage === "master" ? "master_requested" : "requested", req);
        await logEvent(db, saved.ROWID, req, stage === "master" ? "requested_master" : "requested", b.note);

        // Step 1: submitting notifies the Visual audit approvers only, by mail and by the Cliq bot (a delivery
        // problem never blocks the request). The UI audit approvers follow after a Visual approver approves (see /review).
        const members = await db.all("members");
        const d = await mailApprovers(req, db, saved, "designer", members);
        // The pool is every eligible approver, whether or not the mail got through (mailStatus says how it went).
        const request = await db.update("icon_requests", saved.ROWID, {
            notifiedDesigners: d.pool.map((x) => x.userEmail).join(","), mailStatus: mailState([d])
        });
        // Admins hear about every new request (the requester is the one acting here, so they are not told).
        await notify(req, db, "requested", saved, { actor: actorOf(req), members, skip: d.pool.map((x) => x.userEmail) });
        // Nobody to mail because the only Visual audit approver is the requester themselves?
        const selfOnly = !d.pool.length && members.some((m) => !isExpired(m) && approverOf(m) === "designer" && norm(m.userEmail) === norm(me(req).email));
        res.json({ success: true, request: request || saved,
            notified: { designer: d.sent.length, ui: 0, failed: d.failed.length, local: d.sent.some((x) => x.dev), error: (d.failed[0] || {}).error || "", selfOnly,
                cliq: d.cliq.sent.filter((x) => !x.dev).length, cliqFailed: d.cliq.failed.length, cliqError: (d.cliq.failed[0] || {}).error || "" } });
    }));

    router.get("/requests", requireRole(), wrap(async (req, res) => {
        const mine = norm(me(req).email);
        const db = store.forRequest(req);
        let list = await db.all("icon_requests");
        const members = await db.all("members");
        if (req.role !== "admin") list = list.filter((r) => norm(r.requestedBy) === mine || reviewSlot(members, mine, r, req.role === "admin"));
        // The svg snapshot is only needed on the detail view. canReview / canPush say what this person may do on each row.
        res.json({ success: true, role: req.role, requests: list.map(({ svg, svgz, ...rest }) => {
            const slot = reviewSlot(members, mine, rest, req.role === "admin");
            return { ...rest, canReview: rest.status === "pending" && slot && !slotDecision(rest, slot) ? slot : "",
                canPush: rest.status === "approved" && canPush(req, rest) ? stageOf(rest) : "" };
        }).reverse() });
    }));

    router.get("/requests/:id", requireRole(), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const [reqs, events] = await Promise.all([db.all("icon_requests"), db.all("request_events")]);
        const r = reqs.find((x) => String(x.ROWID) === req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Request not found" });
        const mine = norm(me(req).email);
        const slot = reviewSlot(await db.all("members"), mine, r, req.role === "admin");
        if (req.role !== "admin" && norm(r.requestedBy) !== mine && !slot) {
            return res.status(403).json({ success: false, message: "Not allowed for your role" });
        }
        const { svgz, ...plain } = r;
        res.json({ success: true, request: { ...plain, svg: readSvg(r) }, events: events.filter((e) => String(e.requestId) === String(r.ROWID)),
            canReview: r.status === "pending" && slot && !slotDecision(r, slot) ? slot : "",
            canPush: r.status === "approved" && canPush(req, r) ? stageOf(r) : "" });
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
            const both = await tell(req, to, approvalMail(req, { role, request: saved || r }), cliq.approvalCard(req, { role, request: saved || r }));
            const out = both.mail, bot = both.cliq;
            mail.push({ role, ...out, cliq: bot });
            await logEvent(db, r.ROWID, req, out.ok ? "mail_sent" : "mail_failed",
                `${role} approval mail ${out.ok ? (out.dev ? "logged (local run)" : "sent") : "failed (" + out.error + ")"}: ${to}`);
            await logEvent(db, r.ROWID, req, bot.ok ? "cliq_sent" : "cliq_failed",
                `${role} approval Cliq card ${bot.ok ? (bot.dev ? "logged only (the bot is not configured)" : bot.via === "cliq-direct" ? "sent as a direct message (not subscribed to the bot)" : "sent") : "failed (" + bot.error + ")"}: ${to}`);
        }
        res.json({ success: true, request: saved, mail });
    }));

    router.post("/requests/:id/review", requireRole(), wrap(async (req, res) => {
        res.json({ success: true, ...(await reviewRequest(req, store.forRequest(req), actorOf(req), req.params.id, String(req.body.decision || ""), req.body.note)) });
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
            error: ((results.flatMap((x) => x.failed)[0]) || {}).error || "",
            cliq: results.reduce((n, x) => n + x.cliq.sent.filter((y) => !y.dev).length, 0), cliqFailed: results.reduce((n, x) => n + x.cliq.failed.length, 0),
            cliqError: ((results.flatMap((x) => x.cliq.failed)[0]) || {}).error || "" });
    }));

    router.delete("/requests/:id", requireRole(), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const r = (await db.all("icon_requests")).find((x) => String(x.ROWID) === req.params.id);
        if (!r) return res.status(404).json({ success: false, message: "Request not found" });
        const own = norm(r.requestedBy) === norm(me(req).email);
        if (req.role !== "admin" && !(own && ["pending", "rejected"].includes(r.status))) {
            return res.status(403).json({ success: false, message: "Only an admin, or the requester while it is pending or rejected, can delete a request" });
        }
        // An admin deleting someone's request says why: the history goes with the request, so the reason is sent to the
        // requester and the admins and kept in `request_deletions`.
        const reason = str(req.query.note || (req.body && req.body.note), 500).trim();
        if (!own) {
            if (!reason) return res.status(400).json({ success: false, message: "Add a reason so the requester knows why the request was deleted" });
            const actor = actorOf(req);
            await db.insert("request_deletions", { requestId: String(r.ROWID), symbolId: r.symbolId, iconName: r.iconName, stage: stageOf(r), status: r.status,
                requestedBy: r.requestedBy || "", deletedBy: actor.email, reason, at: new Date().toISOString() }).catch((e) => console.warn("[workflow] deletion record", e.message));
            await notify(req, db, "deleted", r, { actor, note: reason });
        }
        await db.remove("icon_requests", r.ROWID);
        for (const ev of (await db.all("request_events")).filter((e) => String(e.requestId) === String(r.ROWID))) await db.remove("request_events", ev.ROWID);
        // Without an open request the icon goes back to where this stage started (a pushed icon keeps its status).
        if (r.status !== "pushed") {
            const stillOpen = (await db.all("icon_requests")).some((x) => x.symbolId === r.symbolId && x.sprite === r.sprite && OPEN.includes(x.status));
            if (!stillOpen) await setIconStatus(db, r.symbolId, r.sprite, startStatus(r), req);
        }
        res.json({ success: true });
    }));

    router.post("/requests/:id/push", requireRole(), wrap(async (req, res) => {
        const b = req.body || {};
        const request = await recordPush(req, store.forRequest(req), actorOf(req), req.params.id,
            { commitSha: b.commitSha, drawing: b.drawing, version: b.version, alreadyThere: !!b.alreadyThere });
        res.json({ success: true, request });
    }));

    // Admin asks for the npm publish of a pushed request again (it failed, or no result ever came back). The office
    // npm publisher picks it up on its next run; the result lands on the request like every other publish result.
    router.post("/requests/:id/republish", requireRole(["admin"]), wrap(async (req, res) => {
        const db = store.forRequest(req);
        const r = await findRequest(db, req.params.id);
        if (r.status !== "pushed") throw fail(409, "Only a pushed request can be published again");
        if (r.releaseStatus === "published") throw fail(409, `Already published${r.releaseVersion ? " in " + r.releaseVersion : ""}`);
        if (!/^[0-9a-f]{7,64}$/i.test(String(r.pushCommitSha || ""))) throw fail(409, "This request has no commit of its own (the icon was already on the branch), so there is nothing to publish");
        if (!branchOf(r)) throw fail(503, "The repository branch of this request is not configured on this server");
        const saved = await db.update("icon_requests", r.ROWID, { releaseStatus: "requested", releaseError: "", republishAt: new Date().toISOString(), republishBy: me(req).email || "" });
        await logEvent(db, r.ROWID, actorOf(req), "npm_republish_requested", r.releaseError ? `after: ${str(r.releaseError, 300)}` : "");
        res.json({ success: true, request: saved || { ...r, releaseStatus: "requested" } });
    }));

    // Admin rejects an open request at any stage, with a reason.
    router.post("/requests/:id/reject", requireRole(["admin"]), wrap(async (req, res) => {
        res.json({ success: true, request: await adminReject(req, store.forRequest(req), actorOf(req), req.params.id, req.body && req.body.note) });
    }));

    // Admin turns down a master request after both audits passed: the icon stays mock verified.
    router.post("/requests/:id/decline", requireRole(["admin"]), wrap(async (req, res) => {
        res.json({ success: true, request: await declineRequest(req, store.forRequest(req), actorOf(req), req.params.id, req.body && req.body.note) });
    }));

    // ── Cliq bot ────────────────────────────────────────────────────────────
    // Admin self-check: one test bot message to the signed-in admin; says what Cliq answered.
    router.post("/cliq/test", requireSession, requireRole(["admin"]), wrap(async (req, res) => {
        const to = me(req).email;
        const out = await cliq.sendCliq(req, {
            to, text: "This is a test message from the Icon Assets tool. If you can read it, approval cards will be delivered.",
            card: { title: "Icon Assets — test message", theme: "modern-inline" }
        });
        res.json({ success: true, ok: out.ok && !out.dev, dev: !!out.dev, via: out.via || "", configured: cliq.isConfigured(), bot: String(process.env.CLIQ_BOT_NAME || ""), to, error: out.error || "" });
    }));

    // PNG of a request's icon for the bot card. No session (Cliq fetches it): ?sig= is an HMAC of the request id.
    let resvgReady = null;
    function loadResvg() {
        if (!resvgReady) {
            resvgReady = (async () => {
                const { Resvg, initWasm } = require("@resvg/resvg-wasm");
                await initWasm(require("fs").readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
                return Resvg;
            })().catch((e) => { resvgReady = null; throw e; });
        }
        return resvgReady;
    }
    // A stand-alone preview: the icon on a white tile, drawn in a dark colour where it inherits its colour.
    function previewSvg(svg) {
        const m = /<svg\b[^>]*>/i.exec(svg);
        if (!m) return svg;
        let open = m[0];
        if (!/\scolor\s*=/.test(open)) open = open.replace(/<svg\b/i, '<svg color="#1f2937"');
        return svg.slice(0, m.index) + open + svg.slice(m.index + m[0].length);
    }
    router.get("/cliq/preview/:file", wrap(async (req, res) => {
        const id = String(req.params.file || "").replace(/\.png$/i, "");
        if (!cliq.validPreviewSig(id, req.query.sig)) return res.status(401).json({ success: false, message: "Invalid preview link" });
        const r = (await store.forRequest(req).all("icon_requests")).find((x) => String(x.ROWID) === id);
        if (!r) return res.status(404).json({ success: false, message: "Request not found" });
        const Resvg = await loadResvg();
        const png = new Resvg(previewSvg(readSvg(r)), { fitTo: { mode: "width", value: 256 }, background: "#ffffff" }).render().asPng();
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.send(Buffer.from(png));
    }));

    // Called by the bot's button / form functions. The person is the Cliq user who clicked (their e-mail, sent by
    // Cliq itself); their role is looked up here, so the same rules apply as in the app.
    router.post("/cliq/action", wrap(async (req, res) => {
        const want = String(process.env.CLIQ_ACTION_TOKEN || "");
        const got = String(req.headers["x-cliq-token"] || "");
        if (want.length < 24) return res.status(503).json({ ok: false, message: "CLIQ_ACTION_TOKEN is not set on the server" });
        if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
            return res.status(401).json({ ok: false, message: "Invalid Cliq token" });
        }
        const b = req.body || {};
        const email = norm(b.email), action = String(b.action || ""), id = str(b.requestId, 40).trim();
        if (!email || !id) return res.status(400).json({ ok: false, message: "email and requestId are required" });
        const actor = { email, name: str(b.name, 200), role: await getRole(req, email) };
        const db = store.forRequest(req);
        try {
            let message;
            if (action === "approve" || action === "reject") {
                const out = await reviewRequest(req, db, actor, id, action, b.note);
                const r = out.request, audit = out.slot === "ui" ? "UI audit" : "Visual audit";
                message = action === "reject" ? `Rejected "${r.iconName}" in the ${audit}. The requester and the admins are informed.`
                    : r.status === "approved" ? `Approved "${r.iconName}" in the ${audit}. Both audits passed: the admins got the push request.`
                    : `Approved "${r.iconName}" in the ${audit}. It moved to the UI audit.`;
            } else if (action === "decline") {
                const r = await declineRequest(req, db, actor, id, b.note);
                message = `Declined the master push of "${r.iconName}". It stays mock verified.`;
            } else if (action === "push") {
                message = (await pushRequest(req, db, actor, id)).message;
            } else {
                return res.status(400).json({ ok: false, message: "action must be approve, reject, push or decline" });
            }
            res.json({ ok: true, message });
        } catch (err) {
            if (!err.status) throw err;
            // A rule said no (already decided, not your audit, …): answered as a normal message for the bot to show.
            res.json({ ok: false, message: err.message });
        }
    }));

    return router;
}

module.exports = { createWorkflowRouter };
