"use strict";

/**
 * "Report a bug": any signed-in user sends an issue (text + an optional screenshot); the Cliq bot forwards it to
 * the people an admin chose.
 *
 *   POST   /api/bugs             → { text, page?, image?: { name, type, data (base64) } }  any signed-in user
 *   GET    /api/bugs             → admins: every report; others: their own (newest first)
 *   GET    /api/bugs/recipients  → { recipients: [{ email, name }] }                                   [admin]
 *   PUT    /api/bugs/recipients  → { recipients: [{ email, name? }] }  who gets the Cliq message       [admin]
 *   GET    /api/bugs/contacts    → { contacts: [{ email, name, cliq }] }  people to reach on Cliq  any signed-in user
 *   GET    /api/bugs/image/:id   → the screenshot of a report; no session (Cliq fetches it): ?sig= is an HMAC of the id
 *
 * Reports are stored in the Catalyst Data Store table `bug_reports` (columns in lib/store.js MAPPED; until that
 * table exists they go to `workflow_store` as JSON); the recipient list is the `workflow_store` collection
 * bug_settings. The screenshot goes to file storage (Stratus, or the local disk on a local run) through deps.files.
 * The menu is open to every signed-in user (it is not one of the role menus); only the recipient list is admin-only.
 */

const express = require("express");
const store = require("../lib/store");
const cliq = require("../lib/cliq");
const { requireRole, norm } = require("../lib/roles");

const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_TEXT = 3000;
const MAX_RECIPIENTS = 25;
// People a user can message on Cliq about a problem (BUG_CONTACTS="a@x.com,b@x.com" overrides the list).
const CONTACTS = ["earnest.j@zohocorp.com", "sudalairaja.t@zohocorp.com", "vishal.cb@zohocorp.com"];
const str = (v, max) => String(v == null ? "" : v).slice(0, max || 500);
const isEmail = (e) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e);

function createBugRouter({ requireSession, files }) {
    const router = express.Router();
    const me = (req) => req.auth.session.user;
    const wrap = (fn) => async (req, res) => {
        try { await fn(req, res); }
        catch (err) {
            console.error("[bugs]", req.method, req.path, err.message);
            res.status(err.status || 500).json({ success: false, message: err.message || "Request failed" });
        }
    };
    const imageSig = (id) => cliq.previewSig("bug:" + id);
    const imagePath = (r) => `bugs/image/${encodeURIComponent(r.ROWID)}?sig=${imageSig(r.ROWID)}`;

    async function readRecipients(db) {
        const row = (await db.all("bug_settings"))[0];
        let list = [];
        try { list = JSON.parse((row && row.recipients) || "[]"); } catch (_) { list = []; }
        return { row, list: Array.isArray(list) ? list.filter((x) => x && x.email) : [] };
    }

    // The screenshot: public by signature only, so the Cliq card and the report list can show it.
    router.get("/bugs/image/:id", wrap(async (req, res) => {
        const id = String(req.params.id || "");
        const want = imageSig(id), got = String(req.query.sig || "");
        if (!want || got.length !== want.length || !require("crypto").timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
            return res.status(401).json({ success: false, message: "Invalid image link" });
        }
        const r = (await store.forRequest(req).all("bug_reports")).find((x) => String(x.ROWID) === id);
        if (!r || !r.imageKey) return res.status(404).json({ success: false, message: "No image on this report" });
        const buf = await files.get(req, r.imageKey);
        if (!buf) return res.status(404).json({ success: false, message: "The image is no longer stored" });
        res.setHeader("Content-Type", r.imageType || "image/png");
        res.setHeader("Cache-Control", "private, max-age=86400");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.send(buf);
    }));

    router.use("/bugs", requireSession);

    // Opens a direct chat with the person in Cliq (https://cliq.zoho.com/users/<email>, Cliq "deep linking").
    // The "@" stays as typed: Cliq does not recognise the user when it is encoded as %40.
    router.get("/bugs/contacts", requireRole(), wrap(async (req, res) => {
        const env = String(process.env.BUG_CONTACTS || "").split(/[\s,;]+/).map(norm).filter(isEmail);
        res.json({ success: true, contacts: (env.length ? env : CONTACTS).map((email) => ({
            email, name: email.split("@")[0], cliq: `${cliq.cliqBase()}/users/${encodeURI(email)}`
        })) });
    }));

    router.get("/bugs/recipients", requireRole(["admin"]), wrap(async (req, res) => {
        res.json({ success: true, recipients: (await readRecipients(store.forRequest(req))).list, bot: cliq.isConfigured() });
    }));

    router.put("/bugs/recipients", requireRole(["admin"]), wrap(async (req, res) => {
        const seen = new Set(), list = [];
        for (const x of Array.isArray(req.body && req.body.recipients) ? req.body.recipients : []) {
            const email = norm(x && x.email);
            if (!email || seen.has(email)) continue;
            if (!isEmail(email)) return res.status(400).json({ success: false, message: `"${str(email, 80)}" is not an e-mail address` });
            seen.add(email);
            list.push({ email, name: str(x.name, 120) });
        }
        if (list.length > MAX_RECIPIENTS) return res.status(400).json({ success: false, message: `At most ${MAX_RECIPIENTS} people can receive bug reports` });
        const db = store.forRequest(req), cur = await readRecipients(db);
        const fields = { recipients: JSON.stringify(list), updatedBy: me(req).email || "" };
        if (cur.row) await db.update("bug_settings", cur.row.ROWID, fields); else await db.insert("bug_settings", fields);
        res.json({ success: true, recipients: list });
    }));

    router.post("/bugs", requireRole(), wrap(async (req, res) => {
        const b = req.body || {};
        const text = String(b.text == null ? "" : b.text).trim();
        if (!text) return res.status(400).json({ success: false, message: "Describe the issue first" });
        if (text.length > MAX_TEXT) return res.status(400).json({ success: false, message: `The description is too long (${text.length} characters, ${MAX_TEXT} is the limit)` });

        let image = null;
        if (b.image && b.image.data) {
            const ext = IMAGE_TYPES[String(b.image.type || "").toLowerCase()];
            if (!ext) return res.status(400).json({ success: false, message: "The image must be a PNG, JPG, GIF or WebP file" });
            const buf = Buffer.from(String(b.image.data).replace(/^data:[^,]*,/, ""), "base64");
            if (!buf.length) return res.status(400).json({ success: false, message: "The image could not be read" });
            if (buf.length > MAX_IMAGE) return res.status(400).json({ success: false, message: "The image is larger than 3 MB" });
            image = { buf, ext, type: String(b.image.type).toLowerCase(), name: str(b.image.name, 120) };
        }

        const db = store.forRequest(req);
        let saved = await db.insert("bug_reports", {
            text, page: str(b.page, 80), reportedBy: me(req).email || "", reportedByName: me(req).name || "",
            imageKey: "", imageType: "", imageName: "", cliqSent: "", cliqFailed: "", status: "open", at: new Date().toISOString()
        });
        if (image) {
            const key = `bugs/${saved.ROWID}.${image.ext}`;
            try {
                await files.put(req, key, image.buf, image.type);
                const img = { imageKey: key, imageType: image.type, imageName: image.name };
                await db.update("bug_reports", saved.ROWID, img);
                saved = { ...saved, ...img };
            } catch (err) {
                // The report itself is kept; only the picture is missing.
                console.error("[bugs] image upload:", err.message);
                image = null;
            }
        }

        // Forward to the chosen people by the Cliq bot (a delivery problem never loses the report).
        const { list } = await readRecipients(db);
        const who = me(req).name ? `${me(req).name} (${me(req).email})` : me(req).email;
        const slides = [];
        const imgUrl = image ? cliq.publicUrl(imagePath(saved)) : "";
        if (imgUrl) slides.push({ type: "images", title: "Screenshot", data: [imgUrl] });
        slides.push({ type: "label", title: "", data: [{ "Reported by": who }].concat(saved.page ? [{ Page: saved.page }] : []) });
        const out = await Promise.all(list.map((r) => cliq.sendCliq(req, {
            to: r.email, text: `*New bug report*\n${text.slice(0, 2500)}`,
            card: { title: "Icon Assets — bug report", theme: "modern-inline" }, slides
        })));
        const sent = out.filter((o) => o.ok && !o.dev).map((o) => o.to);
        const failed = out.filter((o) => !o.ok).map((o) => `${o.to} (${o.error})`);
        await db.update("bug_reports", saved.ROWID, { cliqSent: sent.join(","), cliqFailed: failed.join("; ").slice(0, 1500) });
        res.json({ success: true, id: saved.ROWID, imageSaved: !!image, imageLost: !!(b.image && b.image.data) && !image,
            recipients: list.length, sent: sent.length, failed: failed.length, logged: out.some((o) => o.dev) });
    }));

    router.get("/bugs", requireRole(), wrap(async (req, res) => {
        const mine = norm(me(req).email), admin = req.role === "admin";
        const db = store.forRequest(req);
        let all = await db.all("bug_reports");
        if (!all.length) {
            // The bug_reports table was just created: copy over the reports kept in workflow_store until now.
            const m = await db.migrate("bug_reports").catch(() => null);
            if (m && m.moved) all = await db.all("bug_reports");
        }
        const list = all.filter((r) => admin || norm(r.reportedBy) === mine).reverse().slice(0, 200);
        res.json({ success: true, admin, reports: list.map((r) => ({
            id: r.ROWID, text: r.text, page: r.page || "", reportedBy: r.reportedBy, reportedByName: r.reportedByName || "",
            at: r.at || "", image: r.imageKey ? imagePath(r) : "", imageName: r.imageName || "",
            // who was told is the admin's business only
            cliqSent: admin ? r.cliqSent || "" : "", cliqFailed: admin ? r.cliqFailed || "" : ""
        })) });
    }));

    return router;
}

module.exports = { createBugRouter };
