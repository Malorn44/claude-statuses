#!/usr/bin/env node
import { writeFile, mkdir, stat } from "node:fs/promises";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_PAGES = 20;

async function collectAllUptimePages(componentId) {
  const seen = new Map();
  for (let page = 1; page <= MAX_HISTORY_PAGES; page++) {
    let data;
    try {
      data = await fetchPath(uptimeJsonPath(componentId, page));
    } catch {
      break;
    }
    const months = data.months || [];
    if (!months.length) break;
    let anyNew = false;
    for (const m of months) {
      const mnum = MONTH_NUMS[m.name];
      if (!mnum) continue;
      const key = `${m.year}-${String(mnum).padStart(2, "0")}`;
      if (seen.has(key)) continue;
      anyNew = true;
      seen.set(key, {
        key,
        year: m.year,
        month: mnum,
        name: m.name,
        uptime_percentage: m.uptime_percentage,
        days: (m.days || []).map((d) => ({
          date: d.date,
          p: d.p || 0,
          m: d.m || 0,
          events: d.events || [],
        })),
      });
    }
    if (!anyNew) break;
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

async function isStale(path, maxAgeMs) {
  try {
    const s = await stat(path);
    return Date.now() - s.mtimeMs > maxAgeMs;
  } catch {
    return true;
  }
}

async function main() {
  const now = new Date();
  await mkdir(DATA_DIR, { recursive: true });

  const [incidents, components] = await Promise.all([
    fetchPath(INCIDENTS),
    fetchPath(COMPONENTS),
  ]);

  await writeFile(
    join(DATA_DIR, "components.json"),
    JSON.stringify(components, null, 2) + "\n",
  );

  const uptimeData = await fetchHomepageUptimeData();
  if (uptimeData) {
    await writeFile(
      join(DATA_DIR, "uptime-data.json"),
      JSON.stringify(uptimeData, null, 2) + "\n",
    );
  }

  const historyPath = join(DATA_DIR, "uptime-history.json");
  if (await isStale(historyPath, DAY_MS)) {
    const history = { generated_at: now.toISOString(), components: {} };
    for (const c of components.components || []) {
      history.components[c.id] = {
        id: c.id,
        name: c.name,
        months: await collectAllUptimePages(c.id),
      };
    }
    await writeFile(historyPath, JSON.stringify(history, null, 2) + "\n");
    console.log(`uptime-history refreshed for ${Object.keys(history.components).length} components`);
  }

  const merged = [];
  for (const inc of incidents.incidents || []) {
    merged.push(await mergeIncident(inc));
  }

  const changed = merged.filter((r) => r.changed).length;
  const total = await flushIncidents();
  console.log(
    `fetch ok: ${merged.length} incidents seen, ${changed} changed, ${total} total on disk`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
