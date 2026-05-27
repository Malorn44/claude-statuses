#!/usr/bin/env node
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fetchPath,
  INCIDENTS,
  COMPONENTS,
  fetchHomepageUptimeData,
  uptimeJsonPath,
} from "./lib/statuspage.mjs";
import { mergeIncident, flushIncidents, DATA_DIR } from "./lib/incident.mjs";

const MONTH_NUMS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

const MAX_HISTORY_PAGES = 20;

function normalizeMonths(months) {
  return (months || [])
    .filter((m) => MONTH_NUMS[m.name])
    .map((m) => ({
      key: `${m.year}-${String(MONTH_NUMS[m.name]).padStart(2, "0")}`,
      year: m.year,
      month: MONTH_NUMS[m.name],
      name: m.name,
      uptime_percentage: m.uptime_percentage,
      days: (m.days || []).map((d) => ({
        date: d.date,
        p: d.p || 0,
        m: d.m || 0,
        events: d.events || [],
      })),
    }));
}

// Walks pages 1..maxPages of /uptime/<id>.json, deduping by month key.
// Stops early on error, empty response, or a page with no new months.
async function walkUptimePages(componentId, maxPages) {
  const seen = new Map();
  for (let page = 1; page <= maxPages; page++) {
    let months;
    try {
      const data = await fetchPath(uptimeJsonPath(componentId, page));
      months = normalizeMonths(data.months);
    } catch {
      break;
    }
    if (!months.length) break;
    const fresh = months.filter((m) => !seen.has(m.key));
    if (!fresh.length) break;
    for (const m of fresh) seen.set(m.key, m);
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// Union merge by month key. Fresh entries overwrite existing ones for the
// same month; months only on one side are preserved.
function mergeMonths(existing, fresh) {
  const byKey = new Map((existing || []).map((m) => [m.key, m]));
  for (const m of fresh) byKey.set(m.key, m);
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, obj) {
  return writeFile(path, JSON.stringify(obj, null, 2) + "\n");
}

async function refreshUptimeHistory(components, { full }) {
  const path = join(DATA_DIR, "uptime-history.json");
  const existing = await readJsonOrNull(path);
  const maxPages = full ? MAX_HISTORY_PAGES : 1;
  const out = { generated_at: new Date().toISOString(), components: {} };
  for (const c of components) {
    const existingMonths = existing?.components?.[c.id]?.months;
    const fresh = await walkUptimePages(c.id, maxPages);
    out.components[c.id] = {
      id: c.id,
      name: c.name,
      months: mergeMonths(existingMonths, fresh),
    };
  }
  await writeJson(path, out);
  console.log(
    `uptime-history refreshed (${full ? "full back-walk" : "page 1 only"}) for ${components.length} components`,
  );
}

async function refreshIncidents(incidents) {
  let changed = 0;
  for (const inc of incidents) {
    if ((await mergeIncident(inc)).changed) changed++;
  }
  const total = await flushIncidents();
  console.log(
    `fetch ok: ${incidents.length} incidents seen, ${changed} changed, ${total} total on disk`,
  );
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const [incidents, components] = await Promise.all([
    fetchPath(INCIDENTS),
    fetchPath(COMPONENTS),
  ]);
  await writeJson(join(DATA_DIR, "components.json"), components);

  const uptimeData = await fetchHomepageUptimeData();
  if (uptimeData) await writeJson(join(DATA_DIR, "uptime-data.json"), uptimeData);

  await refreshUptimeHistory(components.components || [], {
    full: process.env.FULL_HISTORY === "1",
  });
  await refreshIncidents(incidents.incidents || []);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
