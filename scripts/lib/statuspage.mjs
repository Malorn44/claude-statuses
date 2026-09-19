const BASE = "https://status.claude.com";
const UA = "claude-statuses (+https://github.com/Malorn44/claude-statuses)";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const MAX_ATTEMPTS = 5;
const UPTIME_SHOWCASE = "/uptime_showcase";
const SHOWCASE_BATCH_LIMIT = 60; // matches the page's BATCH_LIMIT

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findMatchingBrace(str, openIdx) {
  let depth = 0;
  let inString = false;
  let quoteChar = null;
  let escaped = false;

  for (let i = openIdx; i < str.length; i++) {
    const c = str[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (c === "\\") escaped = true;
      else if (c === quoteChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = true; quoteChar = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1; // unbalanced
}

export class UptimeParseError extends Error {
  constructor(message, extracted) {
    super(message);
    this.name = "UptimeParseError";
    this.extracted = extracted;
  }
}

export async function fetchPath(path, { accept = "application/json", browser = false } = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": browser ? BROWSER_UA : UA, Accept: accept },
    });
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      return ct.includes("application/json") || accept.includes("json")
        ? res.json()
        : res.text();
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 1000 * 2 ** attempt);
      await sleep(wait);
      continue;
    }
    throw new Error(`${url}: ${res.status} ${res.statusText}`);
  }
}

export const INCIDENTS = "/api/v2/incidents.json";
export const COMPONENTS = "/api/v2/components.json";

export function incidentPagePath(id) {
  return `/incidents/${id}`;
}

export function incidentJsonPath(id) {
  return `/incidents/${id}.json`;
}

export function uptimeJsonPath(id, page) {
  const qs = page && page > 1 ? `?page=${page}` : "";
  return `/uptime/${id}.json${qs}`;
}

export function historyPage(page) {
  return `/history?page=${page}`;
}

export function incidentsPage(page) {
  return `/api/v2/incidents.json?page=${page}`;
}

export async function fetchHomepageUptimeData() {
  const html = await fetchPath("/", {
    accept: "text/html,application/xhtml+xml",
    browser: true,
  });

  const codes = [...new Set(
    [...html.matchAll(/data-uptime-lazy="([a-z0-9]+)"/g)].map((m) => m[1]),
  )];

  // Legacy path only when the page has no lazy placeholders at all.
  if (!codes.length) {
    const legacy = /var\s+uptimeData\s*=\s*{/.exec(html);
    if (!legacy) {
      throw new UptimeParseError(
        "No data-uptime-lazy placeholders and no inline uptimeData",
        html.slice(0, 500),
      );
    }
    const start = legacy.index + legacy[0].length - 1;
    const end = findMatchingBrace(html, start);
    const raw = end < 0 ? "" : html.slice(start, end);
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new UptimeParseError(`Inline uptimeData not JSON: ${e.message}`, raw.slice(0, 200));
    }
  }

  // Current path (STATUS-801): fetch timelines from /uptime_showcase.
  const out = {};
  for (let i = 0; i < codes.length; i += SHOWCASE_BATCH_LIMIT) {
    const batch = codes.slice(i, i + SHOWCASE_BATCH_LIMIT);
    const data = await fetchPath(
      `${UPTIME_SHOWCASE}?components=${encodeURIComponent(batch.join(","))}`,
      { accept: "application/json", browser: true },
    );
    Object.assign(out, data?.timelines || {});
  }

  const missing = codes.filter((c) => !out[c]);
  if (missing.length) {
    throw new UptimeParseError(`uptime_showcase returned no timeline for: ${missing.join(", ")}`);
  }
  return out;
}

export async function fetchHistoryProps(page) {
  const html = await fetchPath(historyPage(page), {
    accept: "text/html,application/xhtml+xml",
    browser: true,
  });
  const m = html.match(/data-react-props="([^"]+)"/);
  if (!m) return null;
  const raw = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return JSON.parse(raw);
}

export async function* iterateHistorySlugs({ maxPages = 30 } = {}) {
  for (let p = 1; p <= maxPages; p++) {
    const data = await fetchHistoryProps(p);
    const months = data?.months || [];
    let any = false;
    for (const mo of months) {
      for (const inc of mo.incidents || []) {
        any = true;
        yield {
          code: inc.code,
          name: inc.name,
          impact: inc.impact,
          month: mo.month,
          year: mo.year,
          page: p,
        };
      }
    }
    if (!any) return;
  }
}
