"use strict";

/**
 * Skill package: the Claude skill zip every signed-in user can download, with the prompt that installs it and the
 * commands to run after the download. Only admins upload or replace the zip and edit the two texts.
 *
 *   GET /api/skill-pack           → { available, fileName, size, version, uploadedAt, uploadedBy, prompt, commands[],
 *                                     customPrompt, customCommands }                              any signed-in user
 *   GET /api/skill-pack/download  → the zip (attachment); 404 until one is uploaded                any signed-in user
 *   PUT /api/skill-pack           → { file?: { name, data (base64) }, version?, prompt?, commands? }           [admin]
 *                                   prompt / commands sent as "" go back to the built-in default
 *
 * The zip is one object in file storage (Stratus, or the local disk on a local run) through deps.files, always at
 * the same key, so an upload replaces the previous one. Its details and the texts are one record of the
 * `workflow_store` collection skill_settings (lib/store.js; no Catalyst table of its own).
 */

const express = require("express");
const store = require("../lib/store");
const { requireRole } = require("../lib/roles");

const ZIP_KEY = "skill/skill-pack.zip";
const MAX_ZIP = 5 * 1024 * 1024;
const MAX_PROMPT = 4000;
const MAX_COMMANDS = 2000;
const str = (v, max) => String(v == null ? "" : v).slice(0, max || 500);
// A download name that is safe inside a Content-Disposition header.
const safeName = (n) => (str(n, 120).replace(/[^\w.() -]+/g, "_").trim() || "skill-pack.zip");

function defaultPrompt(fileName) {
    return [
        "Purpose: install the CRM icon skill so it loads on every prompt in this CRM project, is listed in the project's .claude/skills folder, and uploads new icons and images to the icon library after each push.",
        "",
        `Install the CRM icon skill from the zip I downloaded (${fileName || "the skill zip"}, in my Downloads folder). If the browser renamed the download (for example added " (1)" before .zip), use the newest zip there whose name starts the same way. Do every step yourself; this prompt is the go-ahead for all of them.`,
        "0. This project must be the CRM repository: its root has webapps/zohocrm/CRMClient. If it does not, stop and tell me.",
        "1. Unzip it to a temporary folder. Inside the top folder there is a crm-icon-library folder and a settings.json. Ignore .DS_Store and __MACOSX.",
        "2. Copy the crm-icon-library folder to ~/.claude/skills/crm-icon-library (replace an older copy), so that SKILL.md and hook.sh are both there.",
        "3. Copy the same crm-icon-library folder to .claude/skills/crm-icon-library in the CRM project root (create the folders if missing, replace an older copy), so the skill is listed in the project's skills folder. Never stage or commit it. If git status --short lists it, add the line .claude/skills/crm-icon-library/ to the file \"$(git rev-parse --git-path info/exclude)\" (not to .gitignore).",
        "4. Merge the SessionStart and UserPromptSubmit hooks from the zip's settings.json into ~/.claude/settings.json (create the file as {} if it is missing). Keep everything already in that file; do not add a hook that is already there.",
        "5. From the CRM project root run: sh .claude/skills/crm-icon-library/hook.sh session — and show me its \"crm-icon-library setup:\" line.",
        "6. Confirm all of these and show me each result:",
        "   - ls .claude/skills/crm-icon-library lists SKILL.md and hook.sh",
        "   - ls ~/.claude/skills/crm-icon-library lists SKILL.md and hook.sh",
        "   - grep -c \"crm-icon-library/hook.sh\" ~/.claude/settings.json prints 2",
        "   - ls \"$(git rev-parse --git-path hooks)\" lists crm-icon-tools and icon-sprite",
        "   - git status --short lists nothing under .claude/skills/crm-icon-library",
        "7. Tell me to start a new Claude session so the skill and its hooks are picked up."
    ].join("\n");
}
const DEFAULT_COMMANDS = [
    "sh .claude/skills/crm-icon-library/hook.sh session",
    "ls .claude/skills/crm-icon-library ~/.claude/skills/crm-icon-library",
    "grep -c \"crm-icon-library/hook.sh\" ~/.claude/settings.json",
    "ls \"$(git rev-parse --git-path hooks)\"",
    "Show the crm-icon-library upload status"
].join("\n");
const lines = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

function createSkillPackRouter({ requireSession, files }) {
    const router = express.Router();
    const wrap = (fn) => async (req, res) => {
        try { await fn(req, res); }
        catch (err) {
            console.error("[skill-pack]", req.method, req.path, err.message);
            res.status(err.status || 500).json({ success: false, message: err.message || "Request failed" });
        }
    };
    const bad = (res, message) => res.status(400).json({ success: false, message });

    const readRow = async (db) => (await db.all("skill_settings"))[0] || null;
    function view(row) {
        const r = row || {};
        return {
            success: true,
            available: !!r.fileName,
            fileName: r.fileName || "", size: Number(r.size) || 0, version: r.version || "",
            uploadedAt: r.uploadedAt || "", uploadedBy: r.uploadedBy || "",
            prompt: r.prompt || defaultPrompt(r.fileName),
            commands: lines(r.commands || DEFAULT_COMMANDS),
            customPrompt: !!r.prompt, customCommands: !!r.commands
        };
    }

    router.use("/skill-pack", requireSession);

    router.get("/skill-pack", requireRole(), wrap(async (req, res) => {
        res.json(view(await readRow(store.forRequest(req))));
    }));

    router.get("/skill-pack/download", requireRole(), wrap(async (req, res) => {
        const row = await readRow(store.forRequest(req));
        if (!row || !row.fileName) return res.status(404).json({ success: false, message: "No skill has been uploaded yet" });
        let buf = null;
        try { buf = await files.get(req, ZIP_KEY); }
        catch (err) { console.error("[skill-pack] read zip:", err.message); }
        if (!buf || !buf.length) return res.status(404).json({ success: false, message: "The skill zip is no longer stored — ask an admin to upload it again" });
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${safeName(row.fileName)}"`);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.send(buf);
    }));

    router.put("/skill-pack", requireRole(["admin"]), wrap(async (req, res) => {
        const b = req.body || {};
        const fields = {};

        if (b.prompt != null) {
            const p = String(b.prompt).trim();
            if (p.length > MAX_PROMPT) return bad(res, `The install prompt is too long (${p.length} characters, ${MAX_PROMPT} is the limit)`);
            fields.prompt = p;
        }
        if (b.commands != null) {
            const c = lines(Array.isArray(b.commands) ? b.commands.join("\n") : b.commands).join("\n");
            if (c.length > MAX_COMMANDS) return bad(res, `The command list is too long (${c.length} characters, ${MAX_COMMANDS} is the limit)`);
            fields.commands = c;
        }
        if (b.version != null) fields.version = str(String(b.version).trim(), 40);

        let zip = null;
        if (b.file && b.file.data) {
            const name = safeName(b.file.name);
            if (!/\.zip$/i.test(name)) return bad(res, "The file must be a .zip file");
            const buf = Buffer.from(String(b.file.data).replace(/^data:[^,]*,/, ""), "base64");
            if (!buf.length) return bad(res, "The file could not be read");
            if (buf.length > MAX_ZIP) return bad(res, "The zip is larger than 5 MB");
            // Every zip starts with a local file header "PK\x03\x04" (an empty one with "PK\x05\x06").
            const sig = buf.length >= 22 ? buf.readUInt32LE(0) : 0;
            if (sig !== 0x04034b50 && sig !== 0x06054b50) return bad(res, "This is not a zip file");
            zip = { name, buf };
        }
        if (!zip && !Object.keys(fields).length) return bad(res, "Nothing to save");

        const db = store.forRequest(req);
        if (zip) {
            await files.put(req, ZIP_KEY, zip.buf, "application/zip");
            Object.assign(fields, {
                fileName: zip.name, size: zip.buf.length, uploadedAt: new Date().toISOString(),
                uploadedBy: req.auth.session.user.email || ""
            });
        }
        const cur = await readRow(db);
        if (cur) await db.update("skill_settings", cur.ROWID, fields); else await db.insert("skill_settings", fields);
        res.json(view(await readRow(db)));
    }));

    return router;
}

module.exports = { createSkillPackRouter };
