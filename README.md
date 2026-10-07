# Catalyst Stratus File Upload

A full-stack Zoho Catalyst project that lets users upload files via a clean web UI and stores them in a **Catalyst Stratus (Object Storage) Bucket**.

---

## Project Structure

```
catalyst-stratus-upload/
├── catalyst-app.json               # Catalyst project configuration
├── frontend/                       # Static web UI (served by Catalyst Client)
│   ├── index.html                  # Upload page
│   ├── style.css                   # Styles
│   └── app.js                      # Upload logic (fetch → Catalyst function)
└── functions/
    └── upload-to-stratus/          # Catalyst Advanced I/O function
        ├── index.js                # Function handler
        ├── package.json            # Node.js dependencies
        └── .env.example            # Environment variable template
```

---

## Prerequisites

| Tool | Install |
|------|---------|
| Node.js ≥ 18 | https://nodejs.org |
| Catalyst CLI | `npm install -g zcatalyst-cli` |
| Zoho Catalyst account | https://catalyst.zoho.com |

---

## Setup Steps

### 1. Clone / open the project

```bash
cd catalyst-stratus-upload
```

### 2. Log in to Catalyst

```bash
catalyst login
```

### 3. Link to your Catalyst project

```bash
catalyst init
```

Choose your existing project **or** create a new one. This fills in the `project_id` inside `catalyst-app.json`.

### 4. Create a Stratus Bucket

1. Open **Catalyst Console** → **Stratus** → **Buckets** → **Create Bucket**  
2. Name it (e.g. `my-uploads`) and choose a region  
3. Copy the bucket name

### 5. Set the environment variable

**Option A — Catalyst Console:**  
Go to **Functions → upload-to-stratus → Configuration → Environment Variables** and add:

```
STRATUS_BUCKET_NAME = my-uploads
```

**Option B — local `.env` file (for local dev only):**

```bash
cp functions/upload-to-stratus/.env.example functions/upload-to-stratus/.env
# Edit the file and set STRATUS_BUCKET_NAME
```

### 6. Install function dependencies

```bash
cd functions/upload-to-stratus
npm install
cd ../..
```

### 7. Deploy

```bash
catalyst deploy
```

This deploys both the **frontend** (to Catalyst Client) and the **function** (to Catalyst Functions).

---

## Update the Frontend URL

After deployment, Catalyst gives you a URL like:

```
https://<project-domain>.catalystapps.com
```

The Advanced I/O function endpoint follows this pattern:

```
https://<project-domain>.api.catalyst.zoho.com/baas/v1/project/<project-id>/function/upload-to-stratus/execute
```

Open **`frontend/app.js`** and update line 7:

```js
const CATALYST_UPLOAD_URL = 'https://YOUR_PROJECT_DOMAIN.api.catalyst.zoho.com/baas/v1/project/YOUR_PROJECT_ID/function/upload-to-stratus/execute';
```

Then redeploy:

```bash
catalyst deploy --only client
```

---

## Local Development

Run the function locally with the Catalyst local server:

```bash
catalyst serve
```

This starts:
- **Frontend** at `http://localhost:3000`
- **Function** at `http://localhost:3000/server/upload-to-stratus`

Update `CATALYST_UPLOAD_URL` in `app.js` to `http://localhost:3000/server/upload-to-stratus` for local testing.

---

## How It Works

```
Browser
  │
  ├─ Drag & drop or browse → select files
  │
  └─ Click "Upload to Stratus"
       │
       └─ POST multipart/form-data ──► Catalyst Advanced I/O Function
                                              │
                                              ├─ Parses file with Busboy
                                              │
                                              └─ Uploads to Stratus Bucket
                                                       │
                                                       └─ Returns JSON { status, object_key, … }
```

---

## API Reference

### `POST /server/upload-to-stratus`

**Request**

| Field | Type | Description |
|-------|------|-------------|
| `file` | `File` (multipart) | File to upload (any type) |

**Success Response `200`**

```json
{
  "status"     : "success",
  "message"    : "File uploaded successfully",
  "file_name"  : "photo.jpg",
  "object_key" : "uploads/1720000000000_photo.jpg",
  "bucket"     : "my-uploads",
  "size_bytes" : 204800,
  "uploaded_at": "2024-08-01T10:00:00.000Z"
}
```

**Error Response `4xx / 5xx`**

```json
{
  "status" : "error",
  "message": "Description of what went wrong"
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STRATUS_BUCKET_NAME` | ✅ | `catalyst-uploads` | Name of the Stratus bucket |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `zcatalyst-sdk-node` | Official Catalyst Node.js SDK |
| `busboy` | Fast multipart/form-data parser |

---

---

## Master UI Library (CRM_UI_LIBRARY repository)

The **Saved Sprites** page has a shared panel, **`Master_ui_library`**, that shows the
icon files of the `CRM_UI_LIBRARY` repository on ZohoRepository and is visible to **every
signed-in user** (hidden while signed out). The files are read **directly from the
repository** and only cached in server memory; nothing is copied into Catalyst Stratus.

| File | Path in repository (root = CRM_UI_LIBRARY) |
|------|-----------------|
| `crmutil_icons.svg` | `resources/images/crmutil_icons.svg` |
| `svg_cssicons.svg`  | `resources/images/svg_cssicons.svg` |
| `svg-icons.less`    | `resources/icon-styles/svg-icons.less` |
| `svg-path.less`     | `resources/icon-styles/svg-path.less` |

**Flow**

1. **Sync from repo** fetches the latest tip of branch `REPO_BRANCH` and refreshes both
   the Master UI Library panel and the **Icon Library** page.
2. The **Icon Library** page splits both sprites (`crmutil_icons.svg` and
   `svg_cssicons.svg`) into single SVG icons automatically. A filter row switches between
   *All*, each sprite and *My icons*. Repository icons are read-only there, but can be
   added to the current sprite or a webfont. The Library has its own **Sync from repo** button.
3. **Add / Replace Icons** on a card opens that sprite + its LESS file in *Update Sprite* mode.
4. Add or replace icons, **Generate**, then **Save to Project** and keep the
   *"Commit directly to CRM_UI_LIBRARY"* option ticked. A commit is pushed to the branch
   with the signed-in user as author, and the Library icons refresh from it.

**Configuration** — `functions/spriteForgeJoin/.env` (local) / `.env.production` or the
Catalyst Console environment variables (see `.env.example`):

```
REPO_BASE_URL=https://repository.zohocorpcloud.in
REPO_PROJECT_PATH=zohocorp/CRM/CRM_UI/CRM_UI_LIBRARY
REPO_NAME=CRM_UI_LIBRARY
REPO_BRANCH=CRM_UI_LIBRARY_ICON_TOOL
REPO_GIT_URL=https://zrepository.zohocorpcloud.in/zohocorp/CRM/CRM_UI/CRM_UI_LIBRARY.git
REPO_TOKEN=<personal access token>     # never commit this
REPO_TOKEN_USER=oauth2                 # username paired with the token (basic auth)
REPO_PROVIDER=git                      # git | gitlab | gitea | github
MASTER_LIBRARY_FOLDER=Master_ui_library
MASTER_LIBRARY_REQUIRE_LOGIN=true
```

The browser-side display defaults (repo name, branch, links, file pairing) live in
`frontend/config.js` → `SF_REPO_CONFIG`; the server config is the source of truth and is
served from `GET /api/master-library/config` (token excluded).

**API** (`/api/master-library`, session required unless `MASTER_LIBRARY_REQUIRE_LOGIN=false`)

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/config` | Public repo config (no auth) |
| GET  | `/` | File listing with last commit; `?refresh=1` re-fetches the repo |
| POST | `/sync` | Fetch the latest branch tip from the repository |
| GET  | `/file?name=crmutil_icons.svg` | Raw file from the repository (`X-Repo-Commit` header) |
| POST | `/save` | `{ files:[{name,content}], message }` → commit + push |
| POST | `/test-connection` | Verify token and branch |

`REPO_PROVIDER=git` (default) uses **isomorphic-git**, a pure-JavaScript git client. It
keeps a depth-1, single-branch copy of about 1 MB in the temp dir, reads files from git
objects, and commits and pushes over HTTPS. It does not depend on the platform's git:
Catalyst ships git 2.25, which is too old for the sparse-checkout commands the CLI engine
uses. `REPO_PROVIDER=git-cli` forces the git CLI (git 2.35 or newer), and `git-auto` uses
the CLI when present.

Every repository call has a time limit: `REPO_HTTP_TIMEOUT_MS` per network round-trip
(default 20000) and `REPO_REQUEST_TIMEOUT_MS` per request (default 25000). A slow or
unreachable host therefore gets a JSON error instead of a platform timeout.

**Who may commit.** The push uses the shared `REPO_TOKEN`, so the tool checks the signed-in
user against `REPO_COMMIT_USERS` first. It takes comma-separated emails, `@domain` entries,
or `*` for every signed-in user, which is the default. Anyone else sees a "Repository access
restricted" popup, the commit option in Save to Project is disabled for them, and the server
answers 403.

`GET /api/master-library/diagnose` is public and returns no secrets. It reports the
engine, the runtime's git version, DNS and HTTPS reachability of the git host, and
whether the token is accepted. Add `?read=1` to also read the branch, which returns file
names, sizes and the commit only.

## License

MIT
