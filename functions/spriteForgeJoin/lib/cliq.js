"use strict";

/**
 * Zoho Cliq bot messages for the icon verification workflow. Sent next to the mails of lib/mailer.js: every
 * notification goes out on both channels.
 *
 * Setup (see cliq/SETUP.md): create the bot in Cliq, then set
 *   CLIQ_BOT_NAME      the bot's unique name
 *   CLIQ_BOT_TOKEN     a Cliq webhook token (zapikey) that may post as the bot
 *   CLIQ_ACTION_TOKEN  shared secret the bot's button/form functions send back to POST /api/cliq/action (24+ chars)
 *   CLIQ_FUNCTION      name of the Cliq button function (default "iconaction")
 *   CLIQ_SENDER_NAME   name shown on a direct message (default "Icon Assets")
 *   CLIQ_DELIVERY      "bot-first" (default) | "direct";  CLIQ_DIRECT_FALLBACK=false switches the retry off
 *   CLIQ_BASE          optional; default: ZOHO_ACCOUNTS_BASE with accounts. → cliq. (https://cliq.zoho.in)
 *   API_PUBLIC_URL     optional; public address of this function (…/server/spriteForgeJoin), used for the icon
 *                      preview image. Default: the origin of APP_URL + /server/spriteForgeJoin
 *
 * A person is addressed by e-mail (members are stored by e-mail) and does not have to subscribe to the bot: when
 * Cliq does not accept the bot message for them, the same card goes out as a direct chat message. Without CLIQ_BOT_NAME / CLIQ_BOT_TOKEN the
 * message is only logged, like a mail on a local run.
 */

const crypto = require("crypto");
const { requestLink } = require("./mailer");

const env = (k) => String(process.env[k] || "").trim();
const cliqBase = () => (env("CLIQ_BASE") || env("ORG_USERS_CLIQ_BASE") ||
    (env("ZOHO_ACCOUNTS_BASE") || "https://accounts.zoho.in").replace("://accounts.", "://cliq.")).replace(/\/+$/, "");
const isConfigured = () => !!(env("CLIQ_BOT_NAME") && env("CLIQ_BOT_TOKEN"));
// A bot's unique name is lowercase without spaces; Cliq answers 404 "request URL is invalid" for any capital letter.
const botName = () => env("CLIQ_BOT_NAME").toLowerCase();
const fnName = () => env("CLIQ_FUNCTION") || "iconaction";

/** Turn a Cliq answer into something the admin can act on. */
function explain(status, body) {
    const m = String((body && (body.message || body.code)) || body || "").slice(0, 300);
    if (status === 401 || status === 403) return `Cliq refused the bot token (${status}) — check CLIQ_BOT_TOKEN and that the token may post as ${env("CLIQ_BOT_NAME")}. ${m}`;
    if (status === 404) return `Cliq does not know the bot "${botName()}" (404). CLIQ_BOT_NAME must be the bot's unique name (lowercase letters and digits only, no spaces — the part after /bots/ in the bot's webhook URL), not its display name. CLIQ_BASE is ${cliqBase()}. ${m}`;
    return `Cliq answered ${status}${m ? ": " + m : ""}`;
}

// Delivery: "bot-first" (default) posts to the bot and, when Cliq does not accept that for the person (they never
// subscribed to the bot), sends the same card as a direct chat message, which needs no subscription.
// CLIQ_DELIVERY=direct always sends the direct message; CLIQ_DIRECT_FALLBACK=false switches the retry off.
const delivery = () => (env("CLIQ_DELIVERY").toLowerCase() === "direct" ? "direct" : "bot-first");
// Off by default: Cliq refuses a webhook token (zapikey) on the direct-message endpoint (401), so the retry only
// works once a token that may post direct messages is configured.
const fallbackOn = () => env("CLIQ_DIRECT_FALLBACK").toLowerCase() === "true";
const senderName = () => env("CLIQ_SENDER_NAME") || "Icon Assets";

/** One POST to Cliq. @returns {{ok:boolean, status:number, error?:string}} */
async function post(path, body) {
    const url = `${cliqBase()}/api/v2/${path}?zapikey=${encodeURIComponent(env("CLIQ_BOT_TOKEN"))}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
        let out = await res.text();
        try { out = JSON.parse(out); } catch (_) { /* plain text */ }
        if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, body: out };
        return { ok: false, status: res.status, error: explain(res.status, out) };
    } catch (err) {
        return { ok: false, status: 0, error: err && err.name === "AbortError" ? "Cliq did not answer within 10 s" : String((err && err.message) || err) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Send one message to one person (by e-mail). Nobody has to subscribe to the bot first: see `delivery` above.
 * @returns {Promise<{to:string, ok:boolean, dev?:boolean, via?: "cliq-bot"|"cliq-direct", error?:string}>} never throws
 */
async function sendCliq(req, { to, text, card, slides, buttons }) {
    try {
        if (!isConfigured()) {
            console.log(`[cliq:dev] to=${to} "${(card && card.title) || ""}" ${String(text || "").replace(/\s+/g, " ").slice(0, 160)}` +
                (buttons && buttons.length ? ` [${buttons.map((b) => b.label).join(" | ")}]` : "") + " (NOT sent: CLIQ_BOT_NAME / CLIQ_BOT_TOKEN are not set)");
            return { to, ok: true, dev: true };
        }
        const body = { text: String(text || "") };
        if (card) body.card = card;
        if (slides && slides.length) body.slides = slides;
        if (buttons && buttons.length) body.buttons = buttons;
        // The direct message is posted with the webhook token's own account, shown under the bot's name.
        const direct = () => post(`buddies/${encodeURIComponent(to)}/message`, { ...body, bot: { name: senderName() } });

        if (delivery() === "direct") {
            const d = await direct();
            if (d.ok) return { to, ok: true, via: "cliq-direct" };
            throw new Error(d.error);
        }
        const viaBot = await post(`bots/${encodeURIComponent(botName())}/message`, { ...body, userids: to });
        // Cliq answers 200 with the list of people it delivered to; a person who never subscribed to the bot is left out.
        const reached = !viaBot.ok || !viaBot.body || !Array.isArray(viaBot.body.user_ids) || viaBot.body.user_ids.length > 0;
        if (viaBot.ok && reached) return { to, ok: true, via: "cliq-bot" };
        if (viaBot.ok) viaBot.error = `Cliq did not deliver to ${to}: they have not subscribed to the bot "${botName()}" yet (or the address is not a Cliq user)`;
        // 401 / 404 mean the token or the bot name is wrong: a direct message would only hide that.
        if (!fallbackOn() || viaBot.status === 401 || viaBot.status === 404) throw new Error(viaBot.error);
        const d = await direct();
        if (d.ok) { console.log("[cliq] bot message refused for", to, "→ sent as a direct message:", viaBot.error); return { to, ok: true, via: "cliq-direct" }; }
        throw new Error(`${viaBot.error}; the direct message failed too: ${d.error}`);
    } catch (err) {
        const msg = String((err && err.message) || err);
        console.error("[cliq] failed:", to, msg);
        return { to, ok: false, error: msg };
    }
}

// ── icon preview (PNG served by GET /api/cliq/preview/:id.png?sig=…) ────────────────────────────
const previewSecret = () => env("SESSION_SECRET") || env("ZOHO_CLIENT_SECRET") || env("CLIQ_ACTION_TOKEN");
function previewSig(id) {
    const secret = previewSecret();
    return secret ? crypto.createHmac("sha256", secret).update("preview:" + String(id)).digest("hex").slice(0, 40) : "";
}
function validPreviewSig(id, sig) {
    const want = previewSig(id), got = String(sig || "");
    return !!want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function apiBase() {
    const set = env("API_PUBLIC_URL").replace(/\/+$/, "");
    if (set) return set;
    try { return new URL(env("APP_URL")).origin + "/server/spriteForgeJoin"; } catch (_) { return ""; }
}
function previewUrl(request) {
    const base = apiBase(), sig = previewSig(request.ROWID);
    return base && sig ? `${base}/api/cliq/preview/${encodeURIComponent(request.ROWID)}.png?sig=${sig}` : "";
}

// ── message parts ───────────────────────────────────────────────────────────────────────────────
const branchOf = (r) => (r.stage === "master" ? "Master branch" : "Mock branch");
const targetOf = (r) => (r.targetSprite === "svg_cssicons" ? "cssicon (svg_cssicons.svg)" : "utilicon (crmutil_icons.svg)");

function slidesFor(request, extra) {
    const rows = [
        { Icon: request.iconName || request.symbolId },
        { "Requested by": request.requestedByName || request.requestedBy || "" },
        { "Move to": `${branchOf(request)} · ${targetOf(request)}` }
    ].concat(extra || []);
    if (request.note) rows.push({ "Requester's note": String(request.note).slice(0, 300) });
    const slides = [];
    const img = previewUrl(request);
    if (img) slides.push({ type: "images", title: "Preview", data: [img] });
    slides.push({ type: "label", title: "", data: rows });
    return slides;
}

const actionButton = (label, type, action, request) => ({
    label, type, key: `${action}:${request.ROWID}`,
    action: { type: "invoke.function", data: { name: fnName() } }
});
function openButton(req, request) {
    const link = requestLink(req, request);
    return link ? [{ label: "Open in app", type: "+", action: { type: "open.url", data: { web: link } } }] : [];
}

/** "Waiting for your approval" card for one reviewer: preview, details, Approve / Reject (each asks for a note). */
function approvalCard(req, { role, request }) {
    const roleName = role === "designer" ? "Visual audit" : "UI audit";
    return {
        text: `The icon *${request.iconName}* is waiting for your *${roleName}* approval. Any one ${roleName} approver can complete this audit.`,
        card: { title: `Icon approval needed — ${roleName}`, theme: "modern-inline" },
        slides: slidesFor(request, [{ "Your audit": roleName }]),
        buttons: [actionButton("Approve", "+", "approve", request), actionButton("Reject", "-", "reject", request)].concat(openButton(req, request))
    };
}

/** Both audits passed: only admins get this card, with the push button (and Decline for a master request). */
function pushCard(req, { request }) {
    const master = request.stage === "master";
    const buttons = [actionButton(master ? "Approve & push to master" : "Push to mock branch", "+", "push", request)];
    if (master) buttons.push(actionButton("Decline", "-", "decline", request));
    return {
        text: `Both audits approved the icon *${request.iconName}*. It is ready for you to ${master ? "approve and push to the master branch" : "push to the mock branch"}.`,
        card: { title: master ? "Ready to push to master" : "Ready to push to mock", theme: "modern-inline" },
        slides: slidesFor(request, [
            { "Visual audit": "approved" + (request.designerBy ? " by " + request.designerBy : "") },
            { "UI audit": "approved" + (request.uiBy ? " by " + request.uiBy : "") }
        ]),
        buttons: buttons.concat(openButton(req, request))
    };
}

/** A plain status update. info: { title, line, note?, by? } (built once in routes/workflow.js for mail and Cliq). */
function statusCard(req, { request, info }) {
    const extra = [];
    if (info.by) extra.push({ By: info.by });
    if (info.note) extra.push({ Note: String(info.note).slice(0, 400) });
    return {
        text: info.line,
        card: { title: info.title, theme: "modern-inline" },
        slides: slidesFor(request, extra),
        buttons: openButton(req, request)
    };
}

/** npm release result. r: { status, name, version, tag, branch, commit, subject, error }; request is optional. */
function releaseCard(req, { release: r, request }) {
    const failed = r.status === "failed";
    const ver = r.version ? `${r.name}@${r.version}` : r.name;
    const rows = [{ Package: r.name }];
    if (r.version) rows.push({ Version: r.version });
    if (r.tag) rows.push({ "npm tag": r.tag });
    rows.push({ Branch: r.branch });
    if (request) rows.unshift({ Icon: request.iconName || request.symbolId });
    if (failed) rows.push({ Error: String(r.error || "unknown error").slice(0, 400) });
    else rows.push({ Install: `npm i ${r.name}@${r.version}` });
    return {
        text: failed
            ? `npm publish *failed* for ${ver} (${r.branch}).${request ? ` Your icon *${request.iconName}* is pushed but not published yet;` : ""} The publisher retries every minute.`
            : (request ? `Your icon *${request.iconName}* is published in *${ver}*` : `*${ver}* was published to npm`) + (r.tag ? ` (tag ${r.tag}).` : "."),
        card: { title: failed ? "npm publish failed" : "New icon library version published", theme: "modern-inline" },
        slides: [{ type: "label", title: "", data: rows }],
        buttons: request ? openButton(req, request) : []
    };
}

module.exports = { sendCliq, isConfigured, approvalCard, pushCard, statusCard, releaseCard, previewUrl, previewSig, validPreviewSig };
