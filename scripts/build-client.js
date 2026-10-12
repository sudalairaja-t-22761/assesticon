"use strict";

/**
 * Builds the production web client into frontend/dist.
 *
 * Why: the page loads ~62 CSS/JS files plus 22 HTML templates. Catalyst's static hosting rate-limits bursts of
 * requests and answers HTTP 429 with a JSON body, so a real page load randomly lost files (CSS "MIME type
 * application/json", state.js missing, everything after it broken). The bundle needs about 5 requests instead.
 *
 *   - all stylesheets            → components/styles/app.<hash>.css
 *   - the template loader stubs  → components/javascript/loaders.<hash>.js   (templates are inlined, no fetch())
 *   - all other component JS     → components/javascript/app.<hash>.js
 *   - config.js, favicon, vendor/ and client-package.json are copied as they are
 * Local development is unchanged: `npm run dev:frontend` still serves the unbundled frontend/ folder.
 *
 * Usage:  node scripts/build-client.js        (or: npm run build:client)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "frontend");
const OUT = path.join(ROOT, "dist");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
const clean = (src) => src.split("?")[0];
function write(rel, content) {
    const p = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}
function copyDir(rel) {
    const from = path.join(ROOT, rel), to = path.join(OUT, rel);
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
        const s = path.join(from, f);
        if (fs.statSync(s).isDirectory()) copyDir(path.join(rel, f));
        else fs.copyFileSync(s, path.join(to, f));
    }
}

fs.rmSync(OUT, { recursive: true, force: true });
let html = read("index.html");

// ── 1. stylesheets ───────────────────────────────────────────────────────
const cssRe = /[ \t]*<link rel="stylesheet" href="(components\/styles\/[^"]+)">\r?\n?/g;
const cssFiles = [];
html = html.replace(cssRe, (all, href) => { cssFiles.push(clean(href)); return cssFiles.length === 1 ? "@@CSS@@\n" : ""; });
if (!cssFiles.length) throw new Error("no local stylesheets found in index.html");
const css = cssFiles.map((f) => `/* ${f} */\n${read(f)}`).join("\n");
const cssName = `components/styles/app.${hash(css)}.css`;
write(cssName, css);
html = html.replace("@@CSS@@", `<link rel="stylesheet" href="${cssName}">`);

// ── 2. scripts: loaders (before jQuery) and the rest (after it) ─────────────
const jqueryAt = html.indexOf("code.jquery.com/jquery");
if (jqueryAt < 0) throw new Error("jQuery tag not found in index.html");
const scriptRe = /[ \t]*<script src="(components\/javascript\/[^"]+)"><\/script>\r?\n?/g;

function bundleScripts(segment, marker) {
    const files = [];
    const out = segment.replace(scriptRe, (all, src) => { files.push(clean(src)); return files.length === 1 ? marker + "\n" : ""; });
    return { out, files };
}

// Inline each template into its loader: fetch('components/templates/x.html').then(r => r.text()) → Promise.resolve("<html>")
function inlineTemplates(src, file) {
    const re = /fetch\((['"])components\/templates\/([\w-]+\.html)(?:\?v=\d+)?\1\)\s*\.then\((?:r\s*=>\s*r\.text\(\)|function\s*\(r\)\s*\{\s*return r\.text\(\);\s*\})\)/g;
    let n = 0;
    const out = src.replace(re, (all, q, name) => { n++; return `Promise.resolve(${JSON.stringify(read("components/templates/" + name))})`; });
    if (/fetch\(['"]components\/templates\//.test(out)) throw new Error(`${file}: a template fetch was not inlined`);
    return { out, n };
}

const head = bundleScripts(html.slice(0, jqueryAt), "@@LOADERS@@");
const tail = bundleScripts(html.slice(jqueryAt), "@@APP@@");
html = head.out + tail.out;

let inlined = 0;
const loaders = head.files.map((f) => {
    const r = inlineTemplates(read(f), f);
    inlined += r.n;
    return `/* ${f} */\n${r.out}`;
}).join(";\n");
const templateFiles = fs.readdirSync(path.join(ROOT, "components", "templates")).filter((f) => f.endsWith(".html"));
const usedByLoaders = new Set((loaders.match(/components\/templates\/[\w-]+\.html/g) || []));
// Templates that are not loaded by a loader stub would be silently missing: fail loudly instead.
const referencedElsewhere = tail.files.some((f) => /templates\//.test(read(f)));
if (referencedElsewhere) throw new Error("a non-loader script references templates/: extend the build to inline it");
if (inlined !== templateFiles.length) console.warn(`note: ${inlined} templates inlined, ${templateFiles.length} template files exist`);

const app = tail.files.map((f) => `/* ${f} */\n${read(f)}`).join(";\n");
const loadersName = `components/javascript/loaders.${hash(loaders)}.js`;
const appName = `components/javascript/app.${hash(app)}.js`;
write(loadersName, loaders);
write(appName, app);
html = html.replace("@@LOADERS@@", `<script src="${loadersName}"></script>`).replace("@@APP@@", `<script src="${appName}"></script>`);

// ── 3. static files copied as they are ────────────────────────────────────
write("index.html", html);
for (const f of ["config.js", "favicon.svg", "client-package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
copyDir("components/javascript/vendor"); // loaded on demand by create-svg.js (import('./vendor/potrace.esm.js'))

const size = (rel) => (fs.statSync(path.join(OUT, rel)).size / 1024).toFixed(0) + " KB";
console.log(`Client built in frontend/dist:
  ${cssName} (${cssFiles.length} files, ${size(cssName)})
  ${loadersName} (${head.files.length} loaders, ${inlined} templates inlined, ${size(loadersName)})
  ${appName} (${tail.files.length} files, ${size(appName)})`);
