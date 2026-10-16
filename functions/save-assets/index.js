/**
 * Zoho Catalyst — Advanced I/O Function
 * Save a user's asset images to Stratus under:
 *   Savedassest/<username>/<branch>/<image files>
 *
 * Endpoint: POST /server/save-assets            (save images)
 *           GET  /server/save-assets?username=   (list a user's folders + image previews)
 *
 * Body (JSON):
 *   {
 *     "username": "john",
 *     "branch"  : "main",
 *     "images"  : [
 *       { "name": "home.svg", "data": "<svg ...>" },                      // raw text (svg)
 *       { "name": "logo.png", "data": "<base64>", "encoding": "base64" }  // binary
 *     ]
 *   }
 *
 * Body (multipart/form-data): fields `username`, `branch`, and one or more file parts.
 *
 * Folders are just key prefixes in Stratus: saving a file under
 * Savedassest/<username>/<branch>/ creates any missing level and reuses the ones that exist
 * (exact, case-sensitive match). No placeholder objects are written.
 *
 * Environment Variables:
 *   STRATUS_BUCKET_NAME — Stratus bucket name
 */

'use strict';

const catalyst     = require('zcatalyst-sdk-node');
const Busboy       = require('busboy');
const { Readable } = require('stream');

const ROOT_FOLDER = 'Savedassest';

const MIME = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  apng: 'image/apng', heic: 'image/heic', heif: 'image/heif', jfif: 'image/jpeg'
};

function sendJSON(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type'                : 'application/json',
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(body));
}

/** Folder/file name safe for a single key segment (no slashes, no dot-only names). */
function safeSegment(value) {
  const s = String(value == null ? '' : value).trim().replace(/[^a-zA-Z0-9._@ -]/g, '_');
  return /^\.*$/.test(s) ? '' : s;
}

function guessMime(name) {
  return MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const fields = {};
    const images = [];

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (_field, stream, info) => {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => {
        images.push({ name: info.filename, buffer: Buffer.concat(chunks), contentType: info.mimeType });
      });
    });
    bb.on('finish', () => resolve({ username: fields.username, branch: fields.branch, images }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

async function parseRequest(req) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) return parseMultipart(req);

  const raw  = await readBody(req);
  const json = JSON.parse(raw.toString('utf8') || '{}');
  const images = (Array.isArray(json.images) ? json.images : []).map(img => ({
    name       : img && img.name,
    buffer     : Buffer.from(String((img && img.data) || ''), img && img.encoding === 'base64' ? 'base64' : 'utf8'),
    contentType: img && img.contentType
  }));
  return { username: json.username, branch: json.branch, images };
}


const PREVIEW_EXPIRY_SECONDS = 3600;
const INLINE_MAX_BYTES       = 512 * 1024;

async function drain(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * GET ?username=<name>[&branch=<branch>][&inline=1]
 * Returns the nested folder tree under Savedassest/<username>/ — branch folders and any
 * deeper folders — with a time-limited preview_url per image (and a data_url when inline=1
 * and the image is small enough).
 */
async function listUserAssets(req, res) {
  const query    = new URLSearchParams(String(req.url || '').split('?')[1] || '');
  const user     = safeSegment(query.get('username'));
  const branch   = safeSegment(query.get('branch'));
  const inline   = query.get('inline') === '1' || query.get('inline') === 'true';
  if (!user) return sendJSON(res, 400, { status: 'error', message: 'username is required.' });

  const bucketName = process.env.STRATUS_BUCKET_NAME || 'savediconsvg';
  const bucket     = catalyst.initialize(req, { scope: 'admin' }).stratus().bucket(bucketName);
  const rootPath   = `${ROOT_FOLDER}/${user}/` + (branch ? `${branch}/` : '');

  const root = { name: branch || user, type: 'folder', path: rootPath, children: [] };
  const folders = { [rootPath]: root };
  const files = [];

  const folderFor = (path) => {
    if (folders[path]) return folders[path];
    const parentPath = path.replace(/[^/]+\/$/, '');
    const node = { name: path.slice(parentPath.length, -1), type: 'folder', path, children: [] };
    folders[path] = node;
    folderFor(parentPath).children.push(node);
    return node;
  };

  for await (const obj of bucket.listIterableObjects({ prefix: rootPath })) {
    const d   = obj.keyDetails || obj;
    const key = d.key;
    if (!key || !key.startsWith(rootPath)) continue;
    // Folder markers: Stratus stores the empty "name/" object as a zero-byte "name" (slash dropped).
    if (key.endsWith('/') || (Number(d.size) === 0 && !/\.[A-Za-z0-9]+$/.test(key))) {
      folderFor(key.endsWith('/') ? key : `${key}/`);
      continue;
    }
    const parentPath = key.replace(/[^/]+$/, '');
    const node = {
      name: key.slice(parentPath.length), type: 'file', key,
      size_bytes: Number(d.size) || 0,
      content_type: d.content_type || guessMime(key),
      last_modified: d.last_modified || null
    };
    folderFor(parentPath).children.push(node);
    files.push(node);
  }

  await Promise.all(files.map(async (f) => {
    try {
      const r = await bucket.generatePreSignedUrl(f.key, 'GET', { expiryIn: String(PREVIEW_EXPIRY_SECONDS) });
      f.preview_url = r.signature;
    } catch (err) { f.preview_error = err.message || String(err); }
    if (inline && f.size_bytes <= INLINE_MAX_BYTES) {
      try {
        const buf = await drain(await bucket.getObject(f.key));
        f.data_url = `data:${f.content_type};base64,${buf.toString('base64')}`;
      } catch (err) { f.preview_error = err.message || String(err); }
    }
  }));

  const sortTree = (n) => {
    n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
    n.children.forEach(c => c.type === 'folder' && sortTree(c));
  };
  sortTree(root);

  return sendJSON(res, 200, {
    status: 'success', bucket: bucketName, username: user,
    folder_count: Object.keys(folders).length - 1, file_count: files.length,
    preview_expires_in_seconds: PREVIEW_EXPIRY_SECONDS,
    tree: root
  });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return sendJSON(res, 200, { status: 'ok' });
  if (req.method === 'GET') {
    try { return await listUserAssets(req, res); }
    catch (err) {
      console.error('[save-assets] List error:', err.message || err);
      return sendJSON(res, 500, { status: 'error', message: err.message || 'Internal server error' });
    }
  }
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { status: 'error', message: 'Method not allowed. Use GET or POST.' });
  }

  try {
    const { username, branch, images } = await parseRequest(req);

    const user   = safeSegment(username);
    const branchName = safeSegment(branch);
    if (!user)       return sendJSON(res, 400, { status: 'error', message: 'username is required.' });
    if (!branchName) return sendJSON(res, 400, { status: 'error', message: 'branch is required.' });

    const files = images.filter(i => i.name && i.buffer && i.buffer.length);
    if (!files.length) return sendJSON(res, 400, { status: 'error', message: 'images list is empty.' });

    const bucketName = process.env.STRATUS_BUCKET_NAME || 'savediconsvg';
    const bucket     = catalyst.initialize(req, { scope: 'admin' }).stratus().bucket(bucketName);

    const branchFolder = `${ROOT_FOLDER}/${user}/${branchName}/`;

    const saved = [];
    const failed = [];
    for (const img of files) {
      const name = safeSegment(img.name);
      if (!name) { failed.push({ name: img.name, error: 'invalid file name' }); continue; }
      const key = `${branchFolder}${name}`;
      try {
        await bucket.putObject(key, Readable.from(img.buffer), {
          overwrite  : true,
          contentType: img.contentType && img.contentType !== 'application/octet-stream'
            ? img.contentType : guessMime(name)
        });
        saved.push({ name, key, size_bytes: img.buffer.length });
      } catch (err) {
        failed.push({ name, error: err.message || String(err) });
      }
    }

    console.log(`[save-assets] ${branchFolder} saved=${saved.length} failed=${failed.length}`);
    return sendJSON(res, failed.length && !saved.length ? 500 : 200, {
      status : failed.length ? (saved.length ? 'partial' : 'error') : 'success',
      bucket : bucketName,
      folder : branchFolder,
      saved, failed,
      saved_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[save-assets] Error:', err.message || err);
    const bad = err instanceof SyntaxError;
    return sendJSON(res, bad ? 400 : 500, {
      status : 'error',
      message: bad ? 'Invalid JSON body.' : (err.message || 'Internal server error')
    });
  }
};
