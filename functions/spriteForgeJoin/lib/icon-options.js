"use strict";

/**
 * Icon categories for the Library: each one is a named list of icons with a filter chip. A category with
 * `options: true` gives its icons the Size (S–XXL) and Stroke width (1 / 1.5 / 2) options in the preview.
 *
 * One row per category in the workflow store collection "icon_options":
 *   { key: "category", id, name, options, builtin, names: [...] }   (icon names without "zcicn-" / "__s")
 * The built-in "Stroke icons" category starts as the CRM strokeIcons list (or the earlier single stroke_icons row);
 * it can be renamed and edited but not deleted.
 */

const store = require("./store");

const COLL = "icon_options";
const STROKE_ID = "stroke";
const MAX_NAMES = 600; // one row holds the whole list (the Data Store Text column takes 10,000 characters)
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

const bad = (message, status) => Object.assign(new Error(message), { status: status || 400 });

/** "zcicn-newsubscription__s" / "NewSubscription" → "newsubscription" */
const iconName = (n) => String(n || "").trim().toLowerCase().replace(/^zcicn-/, "").replace(/__s$/, "").slice(0, 120);
const slug = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const sortNames = (list) => [...new Set(list.map(iconName).filter(Boolean))].sort();

function view(row) {
    return { id: row.id, name: row.name, options: !!row.options, builtin: !!row.builtin, names: sortNames(row.names || []) };
}

/** Category rows; the built-in Stroke icons category is described (not yet stored) until it is first changed. */
async function rows(db) {
    const all = await db.all(COLL);
    const cats = all.filter((r) => r.key === "category" && r.id);
    if (!cats.some((r) => r.id === STROKE_ID)) {
        const legacy = all.filter((r) => r.key === "stroke_icons").pop(); // the single list saved before categories
        cats.unshift({ key: "category", id: STROKE_ID, name: "Stroke icons", options: true, builtin: true,
            names: legacy && Array.isArray(legacy.names) ? legacy.names : DEFAULT_STROKE_ICONS, unsaved: true });
    }
    return cats;
}

async function save(db, row, fields) {
    const next = { ...row, ...fields };
    delete next.unsaved;
    if (next.names) next.names = sortNames(next.names);
    if (row.unsaved || !row.ROWID) await db.insert(COLL, next);
    else await db.update(COLL, row.ROWID, next);
    return view(next);
}

async function list(req) {
    return (await rows(store.forRequest(req))).map(view).sort((a, b) => (b.builtin - a.builtin) || a.name.localeCompare(b.name));
}

/** Union of the icons in every category with the Size + Stroke width options. */
async function strokeIcons(req) {
    return sortNames((await list(req)).filter((c) => c.options).flatMap((c) => c.names));
}

async function find(db, id) {
    const row = (await rows(db)).find((r) => r.id === String(id));
    if (!row) throw bad("Category not found", 404);
    return row;
}

async function createCategory(req, { name, options }) {
    const n = String(name || "").trim().slice(0, 40), id = slug(n);
    if (!id) throw bad("Category name required");
    const db = store.forRequest(req), all = await rows(db);
    if (all.some((r) => r.id === id || String(r.name).toLowerCase() === n.toLowerCase())) throw bad("A category with this name already exists", 409);
    return save(db, {}, { key: "category", id, name: n, options: !!options, builtin: false, names: [] });
}

async function updateCategory(req, id, { name, options }) {
    const db = store.forRequest(req), row = await find(db, id), fields = {};
    if (name !== undefined) {
        const n = String(name || "").trim().slice(0, 40);
        if (!n) throw bad("Category name required");
        if ((await rows(db)).some((r) => r.id !== row.id && String(r.name).toLowerCase() === n.toLowerCase())) throw bad("A category with this name already exists", 409);
        fields.name = n;
    }
    if (options !== undefined) fields.options = !!options;
    return save(db, row, fields);
}

async function deleteCategory(req, id) {
    const db = store.forRequest(req), row = await find(db, id);
    if (row.builtin) throw bad("The Stroke icons category cannot be deleted");
    await db.remove(COLL, row.ROWID);
}

/** Add (enabled) or remove icons of one category. names: string | string[] */
async function setIcons(req, id, names, enabled) {
    const wanted = sortNames(Array.isArray(names) ? names : [names]);
    if (!wanted.length) throw bad("Icon name required");
    if (wanted.length > MAX_NAMES) throw bad("Too many icons in one change");
    const db = store.forRequest(req), row = await find(db, id);
    const set = new Set(sortNames(row.names || []));
    wanted.forEach((n) => (enabled ? set.add(n) : set.delete(n)));
    if (set.size > MAX_NAMES) throw bad(`A category holds at most ${MAX_NAMES} icons`);
    return save(db, row, { names: [...set] });
}

module.exports = { list, strokeIcons, createCategory, updateCategory, deleteCategory, setIcons, iconName, DEFAULT_STROKE_ICONS, STROKE_ID };
