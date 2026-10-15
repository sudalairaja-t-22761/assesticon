"use strict";

/**
 * Record store for the verification workflow (members, roles, icon_status, icon_requests, request_events,
 * admin_tokens).
 *
 * - On Catalyst: ONE Data Store table, `workflow_store`, with two required columns:
 *       coll   Var Char   which collection the row belongs to (members, roles, ...)
 *       data   Text       the record as JSON (Text holds up to 10,000 characters)
 *   plus OPTIONAL readable columns that mirror a few fields of member rows, so the table is easy to read in the
 *   console: email, role, approverType, expiresAt (all Var Char). They are never read back, and if they do not
 *   exist the writes quietly go without them.
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
const REAL_TABLES = new Set(["user_data", "roles"]); // tables with their own columns (see lib/roles.js for `roles`)
const MAX_DATA = 10000;                            // Catalyst "Text" column limit
// Readable copies of key fields, written next to the JSON (members only).
const MIRRORS = {
    members: (r) => ({ email: r.userEmail || "", role: r.memberType || "", approverType: r.approverType || "", expiresAt: r.expiresAt || "" })
};
const mirrorOf = (table, record) => (MIRRORS[table] ? MIRRORS[table](record) : {});

// Tables kept in their own Data Store table with readable columns, while the app keeps using its own field names.
//   members: user_name, user_email, role, approver, added_on, expires_at (required) · user_avatar (Text), added_by (optional)
// If the table does not exist yet, reads and writes quietly use the generic `workflow_store` rows as before.
const MAPPED = {
    members: {
        required: { userName: "user_name", userEmail: "user_email", memberType: "role", approverType: "approver", addedOn: "added_on", expiresAt: "expires_at" },
        optional: { userAvatar: "user_avatar", addedBy: "added_by" }
    }
};
const MAP_CHUNK = 50;
function toRow(fields, cols) {
    const out = {};
    for (const [field, col] of Object.entries(cols)) if (fields[field] !== undefined) out[col] = fields[field] == null ? "" : String(fields[field]);
    return out;
}
function fromRow(spec, row) {
    const out = { ROWID: row.ROWID, CREATEDTIME: row.added_on || row.CREATEDTIME };
    for (const [field, col] of Object.entries({ ...spec.required, ...spec.optional })) if (field !== "addedOn") out[field] = row[col] == null ? "" : row[col];
    return out;
}

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
            async insertMany(table, rows) { const out = []; for (const r of rows) out.push(await this.insert(table, r)); return out; },
            async legacy() { return []; },
            async migrate() { return { ok: true, moved: 0 }; },
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
            },
            async syncMirrors() { return 0; }
        };
    }

    const ds = catalyst.initialize(req).datastore();
    const store = () => ds.table(STORE_TABLE);
    const ldb = {}; // generic-store implementations, used when a mapped table is not available
    const mapped = {
        // Insert rows into a mapped table. The first row is inserted alone to learn whether the optional columns
        // exist (dropped for good once one is rejected), then the rest go in together — never retried, so no duplicates.
        optionalOk: true,
        async insertRows(table, rows) {
            const spec = MAPPED[table], out = [];
            const shape = (r) => (mapped.optionalOk ? { ...toRow(r, spec.required), ...toRow(r, spec.optional) } : toRow(r, spec.required));
            let first;
            try { first = await ds.table(table).insertRow(shape(rows[0])); }
            catch (e) {
                if (!mapped.optionalOk) throw e;
                // Retry with the required columns only. If that works the optional columns are simply not created
                // (skip them from now on); if it fails too, the problem is something else (e.g. no table) — rethrow.
                first = await ds.table(table).insertRow(toRow(rows[0], spec.required));
                mapped.optionalOk = false;
            }
            out.push(flatten(first, table));
            const rest = rows.slice(1).map(shape);
            for (let i = 0; i < rest.length; i += MAP_CHUNK) {
                out.push(...((await ds.table(table).insertRows(rest.slice(i, i + MAP_CHUNK))) || []).map((r) => flatten(r, table)));
            }
            return out;
        }
    };
    const api = {
        async all(table) {
            if (MAPPED[table]) {
                try { return ((await ds.table(table).getAllRows()) || []).map((r) => fromRow(MAPPED[table], flatten(r, table))); }
                catch (e) { console.error(`[store] table "${table}" unavailable, using workflow_store:`, e.message); }
            }
            return ldb.all(table);
        },
        // Copy members saved in workflow_store into the real table the first time it exists (keeps Added On).
        async migrate(table) {
            const spec = MAPPED[table];
            let rows;
            try { rows = (await ds.table(table).getAllRows()) || []; }
            catch (e) { return { ok: false, error: `Data Store table "${table}" is missing or has the wrong columns. Create it with Var Char columns ${Object.values(spec.required).join(", ")} (and optional ${Object.values(spec.optional).join(", ")}). Details: ${e.message}` }; }
            if (rows.length) return { ok: true, moved: 0 };
            const legacy = await ldb.legacy(table);
            if (!legacy.length) return { ok: true, moved: 0 };
            const saved = await mapped.insertRows(table, legacy.map((l) => ({ ...l, addedOn: l.addedOn || l.CREATEDTIME || new Date().toISOString() })));
            return { ok: true, moved: saved.length };
        },
        async insert(table, row) {
            if (MAPPED[table]) {
                try {
                    const rec = { ...row, addedOn: row.addedOn || new Date().toISOString() };
                    const [saved] = await mapped.insertRows(table, [rec]);
                    return { ...row, ROWID: saved.ROWID, CREATEDTIME: rec.addedOn };
                } catch (e) { console.error(`[store] insert into "${table}" failed, using workflow_store:`, e.message); }
            }
            return ldb.insert(table, row);
        },
        async update(table, id, fields) {
            if (MAPPED[table]) {
                const spec = MAPPED[table];
                try {
                    let updated;
                    try { updated = await ds.table(table).updateRow({ ROWID: id, ...toRow(fields, spec.required), ...toRow(fields, spec.optional) }); }
                    catch (e) { updated = await ds.table(table).updateRow({ ROWID: id, ...toRow(fields, spec.required) }); }
                    return fromRow(spec, flatten(updated, table));
                } catch (e) { console.error(`[store] update in "${table}" failed, using workflow_store:`, e.message); }
            }
            return ldb.update(table, id, fields);
        },
        async remove(table, id) {
            if (MAPPED[table]) {
                try { await ds.table(table).deleteRow(id); return; }
                catch (e) { console.error(`[store] delete from "${table}" failed, using workflow_store:`, e.message); }
            }
            return ldb.remove(table, id);
        },
        async insertMany(table, rows) { return ldb.insertMany(table, rows); },
        async legacy(table) { return ldb.legacy(table); },
        async syncMirrors(table) { return ldb.syncMirrors(table); }
    };
    Object.assign(ldb, {
        async all(table) {
            if (REAL_TABLES.has(table)) return ((await ds.table(table).getAllRows()) || []).map((r) => flatten(r, table));
            const rows = (await guard(() => store().getAllRows()) || []).map((r) => flatten(r, STORE_TABLE));
            return rows.filter((r) => r.coll === table).map(decode);
        },
        async insert(table, row) {
            if (REAL_TABLES.has(table)) return flatten(await ds.table(table).insertRow(row), table);
            const base = { coll: table, data: encode(row) }, extra = mirrorOf(table, row);
            const write = async (fields) => flatten(await guard(() => store().insertRow(fields)), STORE_TABLE);
            let saved;
            try { saved = await write({ ...base, ...extra }); }
            catch (e) { if (!Object.keys(extra).length) throw e; saved = await write(base); } // mirror columns not created yet
            return { ...row, ROWID: saved.ROWID, CREATEDTIME: saved.CREATEDTIME };
        },
        // Several rows in one call (real tables only).
        async insertMany(table, rows) {
            if (!rows.length) return [];
            const saved = await ds.table(table).insertRows(rows);
            return (saved || []).map((r) => flatten(r, table));
        },
        // Rows an older version kept as JSON in the generic `workflow_store` table (coll = table).
        async legacy(table) {
            try {
                const rows = (await store().getAllRows() || []).map((r) => flatten(r, STORE_TABLE));
                return rows.filter((r) => r.coll === table).map(decode);
            } catch (_) { return []; }
        },
        async update(table, id, fields) {
            if (REAL_TABLES.has(table)) return flatten(await ds.table(table).updateRow({ ...fields, ROWID: id }), table);
            const current = flatten(await guard(() => store().getRow(id)), STORE_TABLE);
            if (!current || current.coll !== table) return null;
            const merged = { ...decode(current), ...fields };
            const base = { ROWID: id, data: encode(merged) }, extra = mirrorOf(table, merged);
            try { await store().updateRow({ ...base, ...extra }); }
            catch (e) { if (!Object.keys(extra).length) throw e; await store().updateRow(base); } // mirror columns not created yet
            return merged;
        },
        async remove(table, id) {
            await (REAL_TABLES.has(table) ? ds.table(table) : store()).deleteRow(id);
        },
        // Fill the readable columns of rows saved before they existed. Cheap no-op once everything is in sync.
        async syncMirrors(table) {
            if (!MIRRORS[table]) return 0;
            const rows = ((await guard(() => store().getAllRows())) || []).map((r) => flatten(r, STORE_TABLE)).filter((r) => r.coll === table);
            let n = 0;
            for (const row of rows) {
                const want = mirrorOf(table, decode(row));
                if (Object.keys(want).every((k) => String(row[k] == null ? "" : row[k]) === String(want[k]))) continue;
                try { await store().updateRow({ ROWID: row.ROWID, ...want }); n++; } catch (_) { return n; } // columns not created: stop
            }
            return n;
        }
    });
    return api;
}

module.exports = { forRequest, STORE_TABLE, MAX_DATA };
