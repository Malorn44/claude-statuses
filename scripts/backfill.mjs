#!/usr/bin/env node
import {
  fetchPath,
  iterateHistorySlugs,
  incidentJsonPath,
} from "./lib/statuspage.mjs";
import {
  mergeIncident,
  flushIncidents,
  hasIncident,
} from "./lib/incident.mjs";

const CONCURRENCY = 4;

async function pool(items, fn, concurrency = CONCURRENCY) {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await fn(item);
      } catch (e) {
        console.warn(`  ${item}: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
}

async function enumerateSlugs() {
  const slugs = [];
  const seen = new Set();
  for await (const inc of iterateHistorySlugs()) {
    if (!inc.code || seen.has(inc.code)) continue;
    seen.add(inc.code);
    slugs.push(inc.code);
  }
  return slugs;
}

async function filterNew(slugs) {
  const out = [];
  for (const c of slugs) {
    if (!(await hasIncident(c))) out.push(c);
  }
  return out;
}

async function main() {
  const force = process.argv.includes("--force");

  console.log("step 1: enumerating /history pages for incident slugs…");
  const slugs = await enumerateSlugs();
  console.log(`  found ${slugs.length} unique slugs`);

  const todo = force ? slugs : await filterNew(slugs);
  console.log(`  ${todo.length} new, ${slugs.length - todo.length} already on disk`);

  if (todo.length === 0) {
    console.log("nothing to do");
    return;
  }

  console.log(`step 2: fetching /incidents/<slug>.json (concurrency=${CONCURRENCY})…`);
  let done = 0;
  let failed = 0;
  await pool(todo, async (slug) => {
    try {
      const inc = await fetchPath(incidentJsonPath(slug));
      await mergeIncident(inc);
      done++;
      if (done % 25 === 0 || done === todo.length) {
        console.log(`  ${done}/${todo.length} fetched`);
      }
    } catch (e) {
      failed++;
      console.warn(`  ${slug}: ${e.message}`);
    }
  });

  await flushIncidents();
  console.log(`backfill done: ${done} new incidents, ${failed} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
