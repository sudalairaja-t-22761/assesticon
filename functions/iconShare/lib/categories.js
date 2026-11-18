"use strict";

/**
 * The Library's icon categories, read from the main app's store (spriteForgeJoin lib/icon-options.js: rows of the
 * `workflow_store` collection "icon_options", { key: "category", id, name, options, names[] }).
 * A category with options gives its icons the Size + Stroke width choices in a preview.
 *
 * Read-only. Off Catalyst, or when the store cannot be read, only the built-in "Stroke icons" list is known.
 */

const STORE_TABLE = process.env.WORKFLOW_TABLE || "workflow_store";
const COLL = "icon_options";
const STROKE_ID = "stroke";
// Same list as spriteForgeJoin lib/icon-options.js (the built-in category until an admin first changes it).
const DEFAULT_STROKE_ICONS = [
    "plus-rounded", "minus-rounded", "minus", "copylink", "newleads", "newcontacts", "attachment-video-plain", "attachment-text",
    "attachment-document", "attachment-pdf", "attachment-audio", "attachment-image", "attachment-chart", "attachment-noformat", "newtasks",
    "newvoiceofthecustomer", "newmessages", "attachment-zip", "attachment-sheet", "newusers", "roles", "callssm", "taskssm", "eventssm",
    "newservices", "newcases", "newtranslate", "newterritory", "newsocial", "newapps", "newappointments", "newsalesorder", "newinvoice",
    "newquotes", "newevents", "newcustommodule", "newaccounts", "newpotentials", "newvendors", "newpricebooks", "newcalculator", "newnotes",
    "newannouncements", "newapprovals", "newpurchaseorders", "newsolutions", "newreports", "newsalesinbox", "newfeeds", "newforecast",
    "newprojects", "neworchestration", "newhome", "newactivities", "newvisits", "newmicsenterprises", "newfiles", "newdocuments",
    "newproducts", "newworkqueue", "newcalls", "individualrecord", "multiplerecords", "cpq", "trigger", "newbundles", "newzohobooks",
    "newzohoexpense", "newgoogleadwords", "newdesk", "newinvoices", "newcampaigns", "newsalesorders", "newforecasts", "newmicsenterprise",
    "newsubscription", "gaps-to-target", "predictedachivement", "warning-triangle", "gapanalyzer", "business-pattern", "raise-an-issue",
    "quick-help-dashboard", "mail-configuration", "integration-hub", "sales-overview", "tick-rounded"
];

/** "zcicn-newsubscription__s" / "NewSubscription" → "newsubscription" */
const iconName = (n) => String(n || "").trim().toLowerCase().replace(/^zcicn-/, "").replace(/__s$/, "");
const onCatalyst = (req) => !!(req && req.headers && (req.headers["x-zc-projectid"] || req.headers["x-zc-admin-cred-token"]));

async function readRows(req) {
    const table = require("zcatalyst-sdk-node").initialize(req, { scope: "admin" }).datastore().table(STORE_TABLE);
    const out = [];
    let nextToken;
    for (let page = 0; page < 1000; page++) { // getAllRows returns the first page only
        const resp = (await table.getPagedRows({ nextToken, maxRows: 300 })) || {};
        out.push(...(resp.data || []));
        if (!resp.more_records || !resp.next_token) break;
        nextToken = resp.next_token;
    }
    return out.map((r) => (r && r[STORE_TABLE] ? r[STORE_TABLE] : r)).filter((r) => r && r.coll === COLL)
        .map((r) => { try { return JSON.parse(r.data || "{}"); } catch (_) { return {}; } });
}

/** icon name → { categories: [name], hasOptions } */
function indexOf(rows) {
    const cats = rows.filter((r) => r.key === "category" && r.id);
    if (!cats.some((r) => r.id === STROKE_ID)) {
        const legacy = rows.filter((r) => r.key === "stroke_icons").pop();
        cats.unshift({ id: STROKE_ID, name: "Stroke icons", options: true, names: legacy && Array.isArray(legacy.names) ? legacy.names : DEFAULT_STROKE_ICONS });
    }
    const index = new Map();
    cats.sort((a, b) => ((b.id === STROKE_ID) - (a.id === STROKE_ID)) || String(a.name).localeCompare(String(b.name))).forEach((c) => {
        [...new Set((c.names || []).map(iconName).filter(Boolean))].forEach((n) => {
            const e = index.get(n) || { categories: [], hasOptions: false };
            e.categories.push(String(c.name));
            if (c.options) e.hasOptions = true;
            index.set(n, e);
        });
    });
    return index;
}

let cache = null; // { at, index }

/** Cached index. Never throws: a store problem keeps the last good copy, or falls back to the built-in list. */
async function load(req, maxAgeMs, fresh) {
    if (cache && !fresh && Date.now() - cache.at < maxAgeMs) return cache.index;
    try {
        cache = { at: Date.now(), index: indexOf(onCatalyst(req) ? await readRows(req) : []) };
    } catch (e) {
        console.error("[iconShare] icon categories unavailable:", e.message);
        if (!cache) return indexOf([]);
    }
    return cache.index;
}

const NONE = { categories: [], hasOptions: false };
const of = (index, name) => index.get(iconName(name)) || NONE;

module.exports = { load, of };
