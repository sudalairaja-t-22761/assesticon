/**
 * Zoho Catalyst — Advanced I/O Function
 * Upload files to Catalyst Stratus (Object Storage) Bucket
 *
 * Endpoint: POST /server/upload-to-stratus
 * Body    : multipart/form-data  { file: <binary> }
 *
 * Environment Variables:
 *   STRATUS_BUCKET_NAME  — Stratus bucket name (e.g. "checker-development")
 */

'use strict';

const catalyst     = require('zcatalyst-sdk-node');
const Busboy       = require('busboy');
const { Readable } = require('stream');

// ─────────────────────────────────────────────────────────────────
// Helper: send JSON response (raw Node.js http)
// ─────────────────────────────────────────────────────────────────
function sendJSON(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type'                : 'application/json',
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(payload);
}

// ─────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin' : '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end('OK');
    return;
  }

  // ── Debug: GET /buckets — list all available buckets ─────────
  if (req.method === 'GET' && req.url && req.url.includes('buckets')) {
    try {
      const app     = catalyst.initialize(req);
      const stratus = app.stratus();
      const buckets = await stratus.listBuckets();
      return sendJSON(res, 200, { buckets });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  if (req.method !== 'POST') {
    return sendJSON(res, 405, { status: 'error', message: 'Method not allowed. Use POST.' });
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return sendJSON(res, 400, { status: 'error', message: 'Content-Type must be multipart/form-data' });
  }

  try {
    // ── Parse uploaded file ──────────────────────────────────────
    const { fileName, fileBuffer, mimeType } = await parseMultipart(req);

    if (!fileBuffer || fileBuffer.length === 0) {
      return sendJSON(res, 400, { status: 'error', message: 'No file found in request body.' });
    }

    // ── Initialize Catalyst SDK ──────────────────────────────────
    const app     = catalyst.initialize(req);
    const stratus = app.stratus();

    // ── Get bucket name from env var or use default ──────────────
    const bucketName = process.env.STRATUS_BUCKET_NAME || 'checking';
    const bucket     = stratus.bucket(bucketName);

    // ── Build unique object key ──────────────────────────────────
    const timestamp    = Date.now();
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey    = `uploads/${timestamp}_${safeFileName}`;

    // ── Upload to Stratus ────────────────────────────────────────
    const fileStream   = Readable.from(fileBuffer);
    const uploadResult = await bucket.putObject(objectKey, fileStream, {
      overwrite  : true,
      contentType: mimeType || 'application/octet-stream'
    });

    console.log('[upload-to-stratus] Success:', objectKey);

    return sendJSON(res, 200, {
      status      : 'success',
      message     : 'File uploaded successfully',
      file_name   : fileName,
      object_key  : objectKey,
      bucket      : bucketName,
      size_bytes  : fileBuffer.length,
      uploaded_at : new Date().toISOString(),
      result      : uploadResult
    });

  } catch (err) {
    console.error('[upload-to-stratus] Error:', err.message || err);
    return sendJSON(res, 500, {
      status : 'error',
      message: err.message || 'Internal server error'
    });
  }
};

// ─────────────────────────────────────────────────────────────────
// Parse multipart/form-data using Busboy
// ─────────────────────────────────────────────────────────────────
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });

    let fileName  = 'upload_' + Date.now();
    let mimeType  = 'application/octet-stream';
    let chunks    = [];
    let fileFound = false;

    bb.on('file', (fieldname, stream, info) => {
      fileFound = true;
      fileName  = info.filename || fileName;
      mimeType  = info.mimeType || mimeType;

      stream.on('data',  chunk => chunks.push(chunk));
      stream.on('end',   () => {});
      stream.on('error', reject);
    });

    bb.on('finish', () => {
      if (!fileFound) return reject(new Error('No file field found in form data.'));
      resolve({ fileName, fileBuffer: Buffer.concat(chunks), mimeType });
    });

    bb.on('error', reject);
    req.pipe(bb);
  });
}
