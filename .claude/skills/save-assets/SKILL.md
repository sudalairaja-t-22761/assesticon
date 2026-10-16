---
name: save-assets
description: Store project images in the Asset store by calling the save-assets API. Use when the user asks to save, upload or sync images to the Asset store, or to set up ("set up save-assets") automatic upload of newly added images after git push.
---

# save-assets

Self-contained: this one file is the whole skill. It adds nothing to the project's folder structure; the
automatic part is a git hook installed inside `.git/` (not tracked, not committed).

## The API (a Catalyst function, called with a plain HTTPS link)

```
POST https://assets-icons-management-60067235816.development.catalystserverless.in/server/save-assets/
Headers: Content-Type: application/json
Body:    { "username": "Test", "branch": "test",
           "images": [ { "name": "new.svg", "data": "<svg ...>" },
                       { "name": "logo.png", "data": "<base64>", "encoding": "base64" } ] }
```
Stored as `Savedassest/<username>/<branch>/<name>` (same name overwrites). When the hook uploads, `username` is the pusher's **full name** (the full name of the OS account of whoever is logged in on that machine, e.g. `Sudalairaja @ Manojkumar T` - never hard-coded; falls back to `git config user.name`), so it matches the name shown in the tool's Saved Assets page. Response:
`{ "status": "success|partial|error", "saved": [...], "failed": [...] }`.
List a user's saved files: `GET <same url>?username=Test`.

## One-off upload (when the user names files)
Build the JSON from the files (svg as text, every other format base64) and POST it with curl, e.g.:
```bash
curl -s -X POST "$SAVE_ASSETS_URL" -H "Content-Type: application/json" \
  -d "{\"username\":\"$(git config user.name)\",\"branch\":\"$(git rev-parse --abbrev-ref HEAD)\",\"images\":[{\"name\":\"new.svg\",\"data\":$(node -p 'JSON.stringify(require("fs").readFileSync("path/to/new.svg","utf8"))')}]}"
```

## Automatic upload on `git push`
When the user asks to set this up, do steps 1-4 below yourself in the current repo (no other files are needed).
Uploads images **newly added** (any image format, subfolders included) under the watched folder in the commits
being pushed. Default folder `webapps/zohocrm/CRMClient/components/images` (full local path `crm/zohocrm/webapps/zohocrm/CRMClient/components/images`).
It is matched anywhere inside the repo, so no per-machine prefix is needed whatever folder the user cloned into. Modified/old images are not resent.

1. Config (optional): `~/.save-assets.json` (`{"url": "<API url>", "path": "<folder>", "user": "<name>"}`) or env vars
   `SAVE_ASSETS_URL`, `SAVE_ASSETS_PATH`, `SAVE_ASSETS_USER` (only to force a different name - leave unset normally, it overrides the login full name; `path` only needs changing to watch a different folder). The script's built-in default URL is used when none is set.
2. Write the script below to `$(git rev-parse --git-path hooks)/save-assets.js`.
3. Append to `$(git rev-parse --git-path hooks)/pre-push` (create it with `#!/bin/sh` if missing; keep any existing content), then `chmod +x` it:
   ```sh
   # save-assets
   __r="$(cat)"; ( printf '%s\n' "$__r" | SA_WAIT_PID=$PPID SA_REMOTE="$1" node "$(dirname "$0")/save-assets.js" >/dev/null 2>&1 & ) >/dev/null 2>&1
   ```
   Skip if the file already contains `# save-assets`. The hook runs in the background, waits for `git push` to finish, uploads only if the push succeeded (remote branch == pushed commit), and never blocks or fails the push.
4. Each push logs one line per batch to `.git/save-assets.log` (branch, user, sha, http status, saved/failed). Read it
   when the user asks what was synced; show file names and the error for any failure.

### save-assets.js
```js
#!/usr/bin/env node
// save-assets pre-push hook: uploads images newly added under WATCH in the pushed commits. Never blocks a push.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const home = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.save-assets.json'), 'utf8')); } catch (_) { return {}; } })();
const URL_ = process.env.SAVE_ASSETS_URL || home.url || 'https://assets-icons-management-60067235816.development.catalystserverless.in/server/save-assets/';
// Folder to watch, matched ANYWHERE in the repo (':(glob)**/<folder>/**'), so it works whether the clone root is crm/ or crm/zohocrm/ or anything else.
const WATCH = (process.env.SAVE_ASSETS_PATH || home.path || 'webapps/zohocrm/CRMClient/components/images').split(',').map(s => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean).map(w => ':(glob)**/' + w + '/**');
const EXT = /\.(svg|png|jpe?g|jpe|jfif|gif|webp|avif|bmp|ico|tiff?|apng|heic|heif)$/i;
const g = (a) => cp.execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
const log = (m) => { try { fs.appendFileSync(path.join(g(['rev-parse', '--git-dir']).trim(), 'save-assets.log'), new Date().toISOString() + ' ' + m + '\n'); } catch (_) {} };
// Full name of the person pushing: OS account full name (macOS `id -F`, Linux passwd GECOS); falls back to git user.name.
const fullName = () => { try {
  const u = os.userInfo().username;
  const t = process.platform === 'darwin' ? cp.execFileSync('id', ['-F'], { encoding: 'utf8' })
    : process.platform === 'win32' ? cp.execFileSync('powershell', ['-NoProfile', '-Command', '(Get-LocalUser -Name $env:USERNAME).FullName'], { encoding: 'utf8' })
    : cp.execFileSync('getent', ['passwd', u], { encoding: 'utf8' }).split(':')[4].split(',')[0];
  return t.trim();
} catch (_) { return ''; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
(async () => {
  // pre-push mode: SA_WAIT_PID = the running `git push`. Wait until it has finished (max 5 min).
  if (process.env.SA_WAIT_PID) { for (let i = 0; i < 600 && alive(+process.env.SA_WAIT_PID); i++) await sleep(500); }
  const user = process.env.SAVE_ASSETS_USER || home.user || fullName() || g(['config', 'user.name']).trim();
  const input = process.env.SA_COMMIT ? `x ${g(['rev-parse', 'HEAD']).trim()} refs/heads/${g(['rev-parse', '--abbrev-ref', 'HEAD']).trim()} 0` : fs.readFileSync(0, 'utf8'); // SA_COMMIT=1: post-commit mode
  for (const l of input.split('\n').filter(Boolean)) {
    const [, sha, ref, old] = l.trim().split(/\s+/);
    if (!sha || /^0+$/.test(sha) || !/^refs\/heads\//.test(ref)) continue;
    if (process.env.SA_WAIT_PID) { // push done? git moves refs/remotes/<remote>/<branch> to the pushed sha only on success
      let at = ''; try { at = g(['rev-parse', 'refs/remotes/' + (process.env.SA_REMOTE || 'origin') + '/' + ref.slice(11)]).trim(); } catch (_) {}
      if (at !== sha) { log(`branch=${ref.slice(11)} push not completed, skipped`); continue; }
    }
    // new branch: its commits that no OTHER remote branch has (this branch's own remote ref now points at sha)
    const others = g(['for-each-ref', '--format=%(refname)', 'refs/remotes']).split('\n').filter(r => r && !r.endsWith('/HEAD') && r !== 'refs/remotes/' + (process.env.SA_REMOTE || 'origin') + '/' + ref.slice(11));
    const range = /^0*$/.test(old) ? [sha, '--not', ...others] : [old + '..' + sha];
    const files = [...new Set(g(['log', '--diff-filter=A', '--name-only', '--pretty=format:', ...range, '--', ...WATCH]).split('\n').filter(f => f && EXT.test(f)))];
    const images = [], seen = new Set();
    for (const f of files) {
      let buf; try { buf = cp.execFileSync('git', ['show', sha + ':' + f], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { continue; }
      if (!buf.length || buf.length > 5 << 20) continue;
      let name = path.basename(f); if (seen.has(name)) name = path.basename(path.dirname(f)) + '_' + name; seen.add(name);
      images.push(/\.svg$/i.test(f) ? { name, data: buf.toString('utf8') } : { name, data: buf.toString('base64'), encoding: 'base64' });
    }
    for (let i = 0; i < images.length; i += 10) {
      try {
        const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, branch: ref.replace(/^refs\/heads\//, ''), images: images.slice(i, i + 10) }) });
        const b = await r.json().catch(() => ({}));
        log(`branch=${ref.slice(11)} user=${user} sha=${sha.slice(0, 8)} http=${r.status} saved=${(b.saved || []).length} failed=${(b.failed || []).length}${b.message ? ' ' + b.message : ''}`);
      } catch (e) { log('error ' + e.message); }
    }
  }
})().catch(e => log('error ' + e.message)).then(() => process.exit(0));
```
