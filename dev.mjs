// Local dev server: serves public/ and runs the same API handlers Netlify does.
//   npm run dev   →  http://localhost:4250
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
// Key from the environment, else .env.local here, else the shared Solomon/.env.
for (const file of [".env.local", ".env", "../.env"]) {
  if (process.env.GEMINI_API_KEY) break;
  try { process.loadEnvFile(path.join(root, file)); } catch {}
}
const { handle, runMapJob } = await import("./lib/core.mjs");

const PORT = Number(process.env.PORT || 4250);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json",
  ".webmanifest": "application/manifest+json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    const chunks = [];
    if (req.method === "POST") for await (const chunk of req) chunks.push(chunk);
    // Stand-in for Netlify's background function: answer 202, keep working.
    if (url.pathname === "/.netlify/functions/map-background") {
      runMapJob(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      res.writeHead(202);
      return res.end();
    }
    if (url.pathname.startsWith("/api/")) {
      const response = await handle(new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const file = path.join(root, "public", path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(path.join(root, "public"))) throw new Error("outside public");
    const body = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, () => console.log(`\nSoundMap → http://localhost:${PORT}\n`));
