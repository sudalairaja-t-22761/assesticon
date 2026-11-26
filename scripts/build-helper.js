"use strict";

/**
 * Copies scripts/npm-publisher.js into the spriteForgeJoin function (functions/spriteForgeJoin/helper/), so the deployed
 * backend can hand it out in the npm helper setup command (GET /api/release/helper-setup). Only the function folder is
 * uploaded by "catalyst deploy", and the script lives outside it. Run by "npm run deploy".
 *
 * Usage:  node scripts/build-helper.js        (or: npm run build:helper)
 */

const fs = require("fs");
const path = require("path");

const from = path.join(__dirname, "npm-publisher.js");
const dir = path.join(__dirname, "..", "functions", "spriteForgeJoin", "helper");

fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(from, path.join(dir, "npm-publisher.js"));
console.log(`npm helper bundled: functions/spriteForgeJoin/helper/npm-publisher.js (${Math.round(fs.statSync(from).size / 1024)} KB)`);
