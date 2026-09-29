/**
 * Local development static file server for the frontend.
 * Serves the frontend/ directory on http://localhost:3000
 *
 * Usage:  node frontend/server.js
 *   (or via root package.json: npm run dev:frontend)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.FRONTEND_PORT || 3000;
const ROOT = __dirname; // frontend/ directory

const MIME_TYPES = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".eot":  "application/vnd.ms-fontobject",
};

const server = http.createServer((req, res) => {
  // Strip query string
  let urlPath = req.url.split("?")[0];

  // Default to index.html
  if (urlPath === "/" || urlPath === "") {
    urlPath = "/index.html";
  }

  const filePath = path.join(ROOT, urlPath);

  // Security: ensure the resolved path is within ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fallback to index.html for SPA-style navigation
      const indexPath = path.join(ROOT, "index.html");
      fs.readFile(indexPath, (err2, data) => {
        if (err2) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (err3, data) => {
      if (err3) {
        res.writeHead(500);
        res.end("Server error");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`[frontend] Static server running at http://localhost:${PORT}`);
});
