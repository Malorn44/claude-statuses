const BASE = "https://status.claude.com";
const UA = "claude-statuses (+https://github.com/Malorn44/claude-statuses)";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const idx = html.indexOf("var uptimeData");
  if (idx < 0) return null;
  const eqIdx = html.indexOf("=", idx);
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = eqIdx + 1; i < html.length; i++) {
    const c = html[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch (e) {
    console.warn(`Failed to parse uptimeData: ${e.message}`);
    console.warn(`Extracted string: ${html.slice(start, Math.min(end, start + 200))}`);
    return null;
  }
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
