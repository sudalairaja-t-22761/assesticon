"use strict";

/**
 * Suggested icons: for each icon, the other icons whose NAME is similar (nothing about the drawing is compared).
 *
 *   mail → mail1, mail2        same name, different number
 *        → mailer, mailbox     one name starts with the other
 *        → mail-open, sendMail a shared word (names are split on - _ . digits and camelCase)
 *        → emails, massemail   one name contains the other
 * notify → sms-notification    words that start alike
 *
 * Best matches first, at most MAX names per icon.
 */

const MAX = 12;
const MIN = 3; // shorter stems / words ("up", "x") match too much to be useful

/** "Mail-12" → "mail": lower case, without a trailing number and its separator. */
const stemOf = (name) => String(name).toLowerCase().replace(/[\s._-]*\d+$/, "").replace(/[\s._-]+$/, "");

/** "sendMail-open2" → ["send", "mail", "open"] */
function wordsOf(name) {
    return String(name).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= MIN);
}

/** One stem inside the other ("mail" in "massemailtracking"); the short one must be a real word, not "up". */
function contains(x, y) {
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 4 && long.includes(short);
}

/** A word of each name starts with the same 5+ letters, covering most of the shorter word ("notify" / "notification"). */
function startAlike(a, b) {
    for (const x of a.parts) for (const y of b.parts) {
        const min = Math.min(x.length, y.length);
        let n = 0;
        while (n < min && x[n] === y[n]) n++;
        if (n >= 5 && n >= min * 0.7) return true;
    }
    return false;
}

/**
 * @param {string[]} names  icon names (duplicates are fine)
 * @returns {Map<string, string[]>}  name → similar names, best first
 */
function build(names) {
    const list = [...new Set(names)].map((name) => ({ name, stem: stemOf(name), words: new Set(wordsOf(name)) }))
        .map((e) => ({ ...e, parts: [...new Set([e.stem, ...e.words])] }));
    const out = new Map();
    for (const a of list) {
        const found = [];
        for (const b of list) {
            if (a === b) continue;
            let rank;
            if (a.stem && a.stem === b.stem) rank = 0;
            else if (a.stem.length >= MIN && b.stem.length >= MIN && (b.stem.startsWith(a.stem) || a.stem.startsWith(b.stem))) rank = 1;
            else {
                let shared = 0;
                for (const w of a.words) if (b.words.has(w)) shared++;
                if (shared) rank = 3 - Math.min(shared, 2) / 2; // 2 shared words (2) before 1 shared word (2.5)
                else if (contains(a.stem, b.stem)) rank = 3;
                else if (startAlike(a, b)) rank = 4;
                else continue;
            }
            found.push({ name: b.name, rank });
        }
        found.sort((x, y) => x.rank - y.rank || x.name.length - y.name.length || x.name.localeCompare(y.name, "en", { numeric: true }));
        out.set(a.name, found.slice(0, MAX).map((f) => f.name));
    }
    return out;
}

// The answer only changes when the icons do, so keep it per source + commit.
const cache = new Map();

/** name → suggestions for this set of icons; `key` identifies the set (source + commit). */
function index(key, icons) {
    let hit = cache.get(key);
    if (!hit) {
        hit = build(icons.map((i) => i.name));
        if (cache.size >= 6) cache.delete(cache.keys().next().value);
        cache.set(key, hit);
    }
    return hit;
}

module.exports = { build, index };
