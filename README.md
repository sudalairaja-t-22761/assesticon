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

## Master UI Library (CRM_UI_LIBRARY repository sync)

The **Saved Sprites** page has a shared folder, **`Master_ui_library`**, that mirrors the
icon files of the `CRM_UI_LIBRARY` repository on ZohoRepository and is visible to **every
signed-in user** (hidden while signed out):

| File | Path in repository (root = CRM_UI_LIBRARY) |
|------|-----------------|
| `crmutil_icons.svg` | `resources/images/crmutil_icons.svg` |
| `svg_cssicons.svg`  | `resources/images/svg_cssicons.svg` |
| `svg-icons.less`    | `resources/icon-styles/svg-icons.less` |
| `svg-path.less`     | `resources/icon-styles/svg-path.less` |

**Flow**

1. **Sync from repo** pulls the four files from branch `REPO_BRANCH` into the folder
   (Stratus in Catalyst, local disk in dev).
2. **Add / Replace Icons** on a card opens that sprite + its LESS file in *Update Sprite* mode.
3. Add or replace icons, **Generate**, then **Save to Project** and keep the
   *"Save to Master_ui_library and commit to CRM_UI_LIBRARY"* option ticked.
   The files are written to the folder and a commit is pushed to the branch with the
   signed-in user as author.

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
| GET  | `/?sync=1` | Folder index; pulls from repo when empty |
| POST | `/sync` | Pull all files from the repository |
| GET  | `/file?name=crmutil_icons.svg` | Raw file |
| POST | `/save` | `{ files:[{name,content}], message }` → store + commit + push |
| POST | `/test-connection` | Verify token and branch |

The default provider uses the `git` binary (sparse, shallow clone cached in the OS temp
dir; machine-wide git hooks are disabled for its commits). If the runtime has no `git`
(e.g. some serverless images), set `REPO_PROVIDER` to a REST dialect the host supports.

## License

MIT
