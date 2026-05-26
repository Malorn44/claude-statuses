#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const PORT = Number(process.env.PORT || 8000);
const ROOT = resolve(new URL("../", import.meta.url).pathname);
const SITE = join(ROOT, "site");
const DATA = join(ROOT, "data");
const INCIDENTS_JSONL = join(DATA, "incidents.jsonl");
const RELOAD_DEBOUNCE_MS = 80;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const RELOAD_SNIPPET = `
<script>
(() => {
  const es = new EventSource("/__reload");
  es.addEventListener("reload", () => location.reload());
  es.onerror = () => {};
})();
</script>`;

const clients = new Set();
let debounceTimer = null;

function broadcastReload(reason) {
  for (const res of clients) {
    try {
      res.write(`event: reload\ndata: ${reason}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
  console.log(`reload sent to ${clients.size} client(s): ${reason}`);
}

function scheduleReload(reason) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => broadcastReload(reason), RELOAD_DEBOUNCE_MS);
}

let incidentLineByIdPromise = null;
function loadIncidentLineById() {
  if (incidentLineByIdPromise) return incidentLineByIdPromise;
  incidentLineByIdPromise = readFile(INCIDENTS_JSONL, "utf8").then((text) => {
    const map = new Map();
    for (const line of text.split("\n")) {
      if (!line) continue;
      map.set(JSON.parse(line).id, line);
    }
    return map;
  });
  return incidentLineByIdPromise;
}

async function serveIncidentFromJsonl(res, id) {
  try {
    const map = await loadIncidentLineById();
    const line = map.get(id);
    if (!line) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(line);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

async function serveFile(res, path, { inject = false } = {}) {
  try {
    const s = await stat(path);
    if (s.isDirectory()) return serveFile(res, join(path, "index.html"), { inject });
    const ext = extname(path);
    if (inject && ext === ".html") {
      let html = await readFile(path, "utf8");
      html = html.includes("</body>")
        ? html.replace("</body>", `${RELOAD_SNIPPET}\n</body>`)
        : html + RELOAD_SNIPPET;
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
      res.end(html);
      return;
    }
    const buf = await readFile(path);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 1000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/__reload") return handleSse(req, res);
  const safe = normalize(url).replace(/^(\.\.[\/\\])+/, "");
  const incidentMatch = safe.match(/^\/data\/incidents\/([^/]+)\.json$/);
  if (incidentMatch) {
    serveIncidentFromJsonl(res, incidentMatch[1]);
  } else if (safe.startsWith("/data/")) {
    serveFile(res, join(DATA, safe.replace(/^\/data\//, "")));
  } else {
    serveFile(res, join(SITE, safe === "/" ? "/index.html" : safe), { inject: true });
  }
}).listen(PORT, () => {
  console.log(`serving http://localhost:${PORT}  (live reload on)`);
});

for (const [label, dir] of [["site", SITE], ["data", DATA]]) {
  try {
    watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename || filename.endsWith("~")) return;
      if (label === "data" && filename === "incidents.jsonl") incidentLineByIdPromise = null;
      scheduleReload(`${label}/${filename}`);
    });
  } catch (e) {
    console.warn(`watch failed for ${label}: ${e.message}`);
  }
}
