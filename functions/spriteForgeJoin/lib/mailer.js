"use strict";

/**
 * Notification mail for the icon verification workflow ("waiting for your approval"), sent with Catalyst Mail
 * (no SMTP host, port or password to configure):
 * https://docs.catalyst.zoho.com/en/cloud-scale/help/mail/introduction/
 *
 * One-time setup in the Catalyst console (Cloud Scale → Mail): add the sender address and verify it. Then set
 * MAIL_FROM to that address. Public-domain senders need no DNS; a private domain also needs SPF/DKIM.
 * A mail takes up to 10 "to" addresses, so each approver gets their own mail.
 *
 * Which credentials are used:
 *   - deployed on Catalyst, or `catalyst serve`: the real request headers;
 *   - plain `node index.js`: the ZC_* values in .env (lib/catalyst-local.js);
 *   - neither available: the mail is only logged.
 * APP_URL is the app address used in the link (defaults to the request's Origin).
 */

const catalyst = require("zcatalyst-sdk-node");
const { fakeReqFromEnv } = require("./catalyst-local");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isCatalystRuntime = (req) => !!(req && req.headers && (req.headers["x-zc-projectid"] || req.headers["x-zc-admin-cred-token"]));
const fromAddress = () => String(process.env.MAIL_FROM || "").trim();

/** Turn a Catalyst error into something the admin can act on. */
function explain(err, runtime) {
    const m = String((err && err.message) || err || "mail failed");
    if (/AUTHENTICATION_FAILURE|status 401/i.test(m)) {
        return runtime
            ? m + " — this ran ON Catalyst (project credentials), and Catalyst Mail still refused it. In the Catalyst console open Notify → Mail → Email Configuration: the sender " + (fromAddress() || "(MAIL_FROM)") + " must be listed there and show Verified for this environment; a company-domain sender also needs its domain verified (SPF/DKIM)."
            : m + " — this ran on your LOCAL server, whose ZC_ADMIN_CRED_TOKEN in .env was refused. Local mail will not work with that token: test on the deployed app instead (or run with `catalyst serve`).";
    }
    if (/MAIL_FROM is not set/.test(m)) return m;
    if (/from.?email|sender|not (configured|verified)|INVALID_INPUT|status 400/i.test(m)) return m + " — MAIL_FROM must be a sender address that is added and verified in Catalyst console → Cloud Scale → Mail (for this environment).";
    return m;
}

/** @returns {Promise<{to:string, ok:boolean, dev?:boolean, via?:string, error?:string}>} never throws */
async function sendMail(req, { to, subject, html, text }) {
    try {
        const init = isCatalystRuntime(req) ? req : fakeReqFromEnv();
        if (!init) {
            console.log(`[mail:dev] to=${to} subject="${subject}" (NOT sent: no Catalyst credentials — set ZC_PROJECT_ID / ZC_PROJECT_KEY / ZC_ADMIN_CRED_TOKEN in .env)`);
            return { to, ok: true, dev: true };
        }
        const from = fromAddress();
        if (!from) throw new Error("MAIL_FROM is not set — add a sender in Catalyst console → Cloud Scale → Mail, verify it, then set MAIL_FROM to it");
        await catalyst.initialize(init, { scope: "admin" }).email().sendMail({
            from_email: from, to_email: [to], subject, content: html, html_mode: true
        });
        return { to, ok: true, via: "catalyst" };
    } catch (err) {
        const msg = explain(err, isCatalystRuntime(req));
        console.error("[mail] failed:", to, msg);
        return { to, ok: false, error: msg };
    }
}

/** Link that opens the request in the app (after sign-in). */
function requestLink(req, request) {
    const base = String(process.env.APP_URL || (req.headers && req.headers.origin) || "").replace(/\/+$/, "");
    if (!base) return "";
    // APP_URL may be the site root or the page itself (e.g. .../app/index.html on Catalyst).
    return `${base}${/\.html?$/i.test(base) ? "" : "/"}?request=${encodeURIComponent(request.ROWID)}`;
}

/** "Waiting for your approval" mail for one reviewer. */
function approvalMail(req, { role, request }) {
    const roleName = role === "designer" ? "Designer" : "UI";
    const link = requestLink(req, request);
    const target = request.targetSprite === "svg_cssicons" ? "cssicon (svg_cssicons.svg)" : "utilicon (crmutil_icons.svg)";
    const by = request.requestedByName || request.requestedBy;
    const subject = `Waiting for your ${roleName} approval: icon "${request.iconName}"`;

    const row = (k, v) => `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap">${k}</td><td style="padding:6px 0;font-size:14px;color:#111827">${v}</td></tr>`;
    const html =
        `<div style="background:#f3f4f6;padding:24px 12px;font-family:Segoe UI,Arial,sans-serif">` +
        `<table role="presentation" align="center" width="100%" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">` +
        `<tr><td style="background:#2C83EC;padding:18px 24px;color:#ffffff;font-size:16px;font-weight:600">Icon verification — approval needed</td></tr>` +
        `<tr><td style="padding:24px">` +
        `<p style="margin:0 0 6px;font-size:15px;color:#111827">Hi,</p>` +
        `<p style="margin:0 0 18px;font-size:15px;color:#111827">The icon <b>${esc(request.iconName)}</b> is <b>waiting for your ${roleName} approval</b>.</p>` +
        `<table role="presentation" style="border-collapse:collapse;margin-bottom:22px">` +
        row("Icon", esc(request.iconName)) + row("Requested by", esc(by)) + row("Move to", esc(target)) + row("Your review", `${roleName} approval`) +
        (request.note ? row("Note", esc(request.note)) : "") +
        `</table>` +
        (link
            ? `<a href="${esc(link)}" style="display:inline-block;background:#2C83EC;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:14px;font-weight:600">Review &amp; approve</a>` +
              `<p style="margin:16px 0 0;font-size:12px;color:#6b7280">Button not working? Open this link:<br><a href="${esc(link)}" style="color:#2C83EC;word-break:break-all">${esc(link)}</a></p>`
            : `<p style="margin:0;font-size:14px;color:#111827">Open <b>Icon Requests</b> in the Icon Assets tool to approve or reject.</p>`) +
        `</td></tr>` +
        `<tr><td style="padding:14px 24px;background:#f9fafb;color:#9ca3af;font-size:12px">You received this because you are a ${roleName} approver. Any one ${roleName} approver can complete this review.</td></tr>` +
        `</table></div>`;
    const text =
        `Icon "${request.iconName}" is waiting for your ${roleName} approval.\n\n` +
        `Requested by: ${by}\nMove to: ${target}\n` + (request.note ? `Note: ${request.note}\n` : "") +
        (link ? `\nReview and approve: ${link}\n` : `\nOpen Icon Requests in the Icon Assets tool to approve or reject.\n`);
    return { subject, html, text };
}

module.exports = { sendMail, approvalMail };
