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

## License

MIT
