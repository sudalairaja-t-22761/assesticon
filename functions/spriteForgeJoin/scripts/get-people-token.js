"use strict";

/**
 * One-time helper: get a Zoho People refresh token for the app's own client (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET).
 *
 *   1. In https://api-console.zoho.in open your client → add this Authorized Redirect URI:  http://localhost:8787/callback
 *   2. node scripts/get-people-token.js          (run from functions/spriteForgeJoin)
 *   3. Open the printed URL, approve. The script prints ORG_USERS_REFRESH_TOKEN=... in THIS terminal.
 *   4. Paste that line into .env (and .env.production) yourself. Nothing is written to disk by this script.
 */

const http = require("http");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PORT = Number(process.env.TOKEN_HELPER_PORT || 8787);
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = "ZOHOPEOPLE.forms.READ,ZOHOPEOPLE.employee.ALL";
const BASE = String(process.env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.in").replace(/\/+$/, "");
const ID = process.env.ORG_USERS_CLIENT_ID || process.env.ZOHO_CLIENT_ID;
const SECRET = process.env.ORG_USERS_CLIENT_SECRET || process.env.ZOHO_CLIENT_SECRET;

if (!ID || !SECRET) { console.error("ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET missing in .env"); process.exit(1); }

const authUrl = `${BASE}/oauth/v2/auth?` + new URLSearchParams({
    response_type: "code", client_id: ID, scope: SCOPE, redirect_uri: REDIRECT, access_type: "offline", prompt: "consent"
});

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== "/callback") { res.statusCode = 404; return res.end(); }
    const code = u.searchParams.get("code");
    if (!code) { res.end("No code in the redirect: " + (u.searchParams.get("error") || "unknown error")); return; }
    try {
        const r = await fetch(BASE + "/oauth/v2/token", {
            method: "POST",
            body: new URLSearchParams({ grant_type: "authorization_code", client_id: ID, client_secret: SECRET, redirect_uri: REDIRECT, code })
        });
        const j = await r.json();
        if (!j.refresh_token) throw new Error("Zoho answered: " + JSON.stringify({ error: j.error, scope: j.scope }));
        console.log("\nAdd this line to .env and .env.production:\n\nORG_USERS_REFRESH_TOKEN=" + j.refresh_token + "\n");
        res.end("Done. You can close this tab and go back to the terminal.");
    } catch (e) {
        console.error("Token exchange failed:", e.message);
        res.end("Token exchange failed, see the terminal.");
    }
    server.close();
});

server.listen(PORT, () => console.log(`Open this URL in your browser and approve:\n\n${authUrl}\n\nWaiting on ${REDIRECT} …`));
