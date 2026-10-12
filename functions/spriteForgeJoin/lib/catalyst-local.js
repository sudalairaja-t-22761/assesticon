"use strict";

/**
 * Catalyst credentials for a LOCAL run (plain `node index.js`), taken from .env, so Catalyst services
 * (Stratus, Mail) can be called without a request that carries the runtime headers.
 * Returns null when ZC_PROJECT_ID / ZC_PROJECT_KEY are not set. On Catalyst (or `catalyst serve`) the real
 * request headers are used instead and this is never needed.
 *
 * ZC_ADMIN_CRED_TOKEN is a short-lived ticket: when Catalyst answers 401 AUTHENTICATION_FAILURE, refresh it.
 */
function fakeReqFromEnv() {
    const projectId  = process.env.ZC_PROJECT_ID  || "";
    const projectKey = process.env.ZC_PROJECT_KEY  || "";
    const credToken  = process.env.ZC_ADMIN_CRED_TOKEN || "";
    const credType   = process.env.ZC_ADMIN_CRED_TYPE  || "zoho";
    const environment = process.env.ZC_ENVIRONMENT || "development";
    if (!projectId || !projectKey) return null;
    return {
        headers: {
            "x-zc-projectid":        projectId,
            "x-zc-project-key":      projectKey,
            "x-zc-admin-cred-type":  credType,
            "x-zc-admin-cred-token": credToken,
            // SDK also requires a user-level credential. Since we are acting as admin,
            // set the same ticket as the user token so `userToken` is not undefined.
            "x-zc-user-cred-type":   credType,
            "x-zc-user-cred-token":  credToken,
            "x-zc-environment":      environment,
            "x-zc-user-type":        "admin"   // tells SDK currentUser = admin
        }
    };
}

module.exports = { fakeReqFromEnv };
