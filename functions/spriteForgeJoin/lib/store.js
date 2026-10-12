"use strict";

/**
 * Record store for the verification workflow (members, roles, icon_status, icon_requests, request_events,
 * admin_tokens).
 *
 * - On Catalyst: ONE Data Store table, `workflow_store`, with two columns:
 *       coll   Var Char   which collection the row belongs to (members, roles, ...)
 *       data   Text       the record as JSON (Text holds up to 10,000 characters)
 *   Tables cannot be created from code, so keeping everything in one generic table means the console needs a
 *   single table with two columns, and new fields never need a schema change.
 *   `user_data` (the existing login table) is read as a normal table.
 * - Local run (no Catalyst credentials): a JSON file in os.tmpdir().
 *
 * Every record carries a ROWID (and CREATEDTIME) assigned by the store.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const catalyst = require("zcatalyst-sdk-node");

const STORE_TABLE = process.env.WORKFLOW_TABLE || "workflow_store";
const REAL_TABLES = new Set(["user_data"]);       // existing tables with their own columns
const MAX_DATA = 10000;                            // Catalyst "Text" column limit
const LOCAL_FILE = path.join(os.tmpdir(), "svgforge-workflow.json");

function isCatalystRuntime(req) {
    return !!(req && req.headers && (req.headers["x-zc-projectid"] || req.headers["x-zc-admin-cred-token"]));
}

function localRead() {
    try { return JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8")); } catch (_) { return {}; }
}
function localWrite(db) { fs.writeFileSync(LOCAL_FILE, JSON.stringify(db, null, 2)); }

// Catalyst returns a row either flat or nested under the table name.
const flatten = (row, table) => (row && row[table] ? row[table] : row);

function encode(record) {
    const { ROWID, CREATEDTIME, MODIFIEDTIME, ...fields } = record;
    const json = JSON.stringify(fields);
    if (json.length > MAX_DATA) throw new Error(`Record too large for the Data Store (${json.length} of ${MAX_DATA} characters)`);
    return json;
}

function decode(row) {
    let fields = {};
    try { fields = JSON.parse(row.data || "{}"); } catch (_) { /* unreadable row: expose it empty */ }
    return { ...fields, ROWID: row.ROWID, CREATEDTIME: row.CREATEDTIME };
}

// A missing/mistyped table is the common first-deploy problem: say exactly what to create.
async function guard(fn) {
    try { return await fn(); }
    catch (e) {
        const m = String((e && e.message) || e);
        if (/table|not found|no such|invalid/i.test(m) && !/too large/i.test(m)) {
            throw new Error(`Catalyst Data Store table "${STORE_TABLE}" is missing or has the wrong columns. Create it in the Catalyst console (Data Store → Create Table) with two columns: coll (Var Char) and data (Text). Details: ${m}`);
        }
        throw e;
    }
}

function forRequest(req) {
    if (!isCatalystRuntime(req)) {
        return {
            async all(table) { return (localRead()[table] || []).slice(); },
            async insert(table, row) {
                const db = localRead();
                const saved = { ...row, ROWID: String(Date.now()) + Math.floor(Math.random() * 1000), CREATEDTIME: new Date().toISOString() };
                (db[table] = db[table] || []).push(saved);
                localWrite(db);
                return saved;
            },
            async update(table, id, fields) {
                const db = localRead();
                const list = db[table] || [];
                const i = list.findIndex((r) => String(r.ROWID) === String(id));
                if (i < 0) return null;
                list[i] = { ...list[i], ...fields, ROWID: list[i].ROWID };
                localWrite(db);
                return list[i];
            },
            async remove(table, id) {
                const db = localRead();
                db[table] = (db[table] || []).filter((r) => String(r.ROWID) !== String(id));
                localWrite(db);
            }
        };
    }

    const ds = catalyst.initialize(req).datastore();
    const store = () => ds.table(STORE_TABLE);
    return {
        async all(table) {
            if (REAL_TABLES.has(table)) return ((await ds.table(table).getAllRows()) || []).map((r) => flatten(r, table));
            const rows = (await guard(() => store().getAllRows()) || []).map((r) => flatten(r, STORE_TABLE));
            return rows.filter((r) => r.coll === table).map(decode);
        },
        async insert(table, row) {
            if (REAL_TABLES.has(table)) return flatten(await ds.table(table).insertRow(row), table);
            const saved = flatten(await guard(() => store().insertRow({ coll: table, data: encode(row) })), STORE_TABLE);
            return { ...row, ROWID: saved.ROWID, CREATEDTIME: saved.CREATEDTIME };
        },
        async update(table, id, fields) {
            if (REAL_TABLES.has(table)) return flatten(await ds.table(table).updateRow({ ...fields, ROWID: id }), table);
            const current = flatten(await guard(() => store().getRow(id)), STORE_TABLE);
            if (!current || current.coll !== table) return null;
            const merged = { ...decode(current), ...fields };
            await store().updateRow({ ROWID: id, data: encode(merged) });
            return merged;
        },
        async remove(table, id) {
            await (REAL_TABLES.has(table) ? ds.table(table) : store()).deleteRow(id);
        }
    };
}

module.exports = { forRequest, STORE_TABLE, MAX_DATA };
