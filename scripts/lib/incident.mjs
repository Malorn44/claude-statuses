import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const DATA_DIR = new URL("../../data/", import.meta.url).pathname;
const INCIDENTS_PATH = new URL("../../data/incidents.jsonl", import.meta.url).pathname;

const TOP_LEVEL_FIELDS = [
  "id",
  "name",
  "status",
  "created_at",
  "updated_at",
  "monitoring_at",
  "resolved_at",
  "impact",
  "shortlink",
  "started_at",
  "page_id",
  "incident_updates",
  "components",
  "reminder_intervals",
];

let cache = null;

async function loadCache() {
  if (cache) return cache;
  cache = new Map();
  if (!existsSync(INCIDENTS_PATH)) return cache;
  const text = await readFile(INCIDENTS_PATH, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const inc = JSON.parse(line);
    cache.set(inc.id, inc);
  }
  return cache;
}

function mergeUpdates(stored = [], fetched = []) {
  const byId = new Map();
  for (const u of stored) byId.set(u.id, u);
  for (const u of fetched) {
    const prior = byId.get(u.id);
    byId.set(u.id, prior ? { ...prior, ...u } : u);
  }
  return [...byId.values()].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  );
}

function pickFields(incident) {
  const out = {};
  for (const k of TOP_LEVEL_FIELDS) {
    if (incident[k] !== undefined) out[k] = incident[k];
  }
  return out;
}

function serializeRecord(inc) {
  const ordered = {};
  for (const k of TOP_LEVEL_FIELDS) {
    if (inc[k] !== undefined) ordered[k] = inc[k];
  }
  return JSON.stringify(ordered);
}

export async function mergeIncident(incident) {
  if (!incident?.id) throw new Error("incident missing id");
  const c = await loadCache();
  const existing = c.get(incident.id) || null;
  const next = existing
    ? { ...existing, ...pickFields(incident) }
    : pickFields(incident);
  next.incident_updates = mergeUpdates(
    existing?.incident_updates,
    incident.incident_updates,
  );
  const before = existing ? serializeRecord(existing) : null;
  const after = serializeRecord(next);
  c.set(incident.id, next);
  return { id: incident.id, changed: before !== after };
}

export async function hasIncident(id) {
  const c = await loadCache();
  return c.has(id);
}

export async function loadAllIncidents() {
  const c = await loadCache();
  return [...c.values()];
}

export async function flushIncidents() {
  const c = await loadCache();
  await mkdir(dirname(INCIDENTS_PATH), { recursive: true });
  const all = [...c.values()].sort((a, b) => {
    const ka = a.started_at || a.created_at || "";
    const kb = b.started_at || b.created_at || "";
    return ka.localeCompare(kb);
  });
  const lines = all.map(serializeRecord).join("\n") + (all.length ? "\n" : "");
  await writeFile(INCIDENTS_PATH, lines);
  return all.length;
}

export { DATA_DIR, INCIDENTS_PATH };
