#!/usr/bin/env node
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAllIncidents, DATA_DIR } from "./lib/incident.mjs";
import {
  computeComponentBreakdown,
} from "./lib/aggregate.mjs";

const DAY_MS = 86_400_000;
const DAY_SEC = 86400;

// Empirical match to status.claude.com: partial @ 30%, major @ 100%.
const PARTIAL_WEIGHT = 0.30;
const MAJOR_WEIGHT = 1.0;

function weightedDowntime(major, critical) {
  return Math.round(major * PARTIAL_WEIGHT + critical * MAJOR_WEIGHT);
}

function impactFromSeconds(major, critical) {
  if (critical > 0) return "critical";
  if (major > 0) return "major";
  return "none";
}

function loadJsonIfExists(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function buildIncidentsByDate(incidents, nowMs) {
  const byDate = new Map();
  const componentsById = new Map();
  for (const inc of incidents) {
    const startMs = new Date(inc.started_at || inc.created_at).getTime();
    if (!Number.isFinite(startMs)) continue;
    const endMs = inc.resolved_at ? new Date(inc.resolved_at).getTime() : nowMs;
    componentsById.set(inc.id, new Set((inc.components || []).map((c) => c.id)));
    const firstDayMs = Math.floor(startMs / (DAY_SEC * 1000)) * DAY_SEC * 1000;
    const lastDayMs = Math.floor(endMs / (DAY_SEC * 1000)) * DAY_SEC * 1000;
    for (let d = firstDayMs; d <= lastDayMs; d += DAY_SEC * 1000) {
      const dateStr = new Date(d).toISOString().slice(0, 10);
      if (!byDate.has(dateStr)) byDate.set(dateStr, new Set());
      byDate.get(dateStr).add(inc.id);
    }
  }
  return { byDate, componentsById };
}

function buildPerComponent(componentList, uptimeData, fallbackStartDate) {
  const perComponent = new Map();
  for (const c of componentList) {
    const entry = uptimeData[c.id];
    const byDate = new Map();
    for (const day of entry?.days || []) {
      byDate.set(day.date.slice(0, 10), {
        p: day.outages?.p || 0,
        m: day.outages?.m || 0,
        events: day.related_events || [],
      });
    }
    perComponent.set(c.id, {
      byDate,
      startDate: entry?.component?.startDate || fallbackStartDate,
    });
  }
  return perComponent;
}

function getDateKeys(uptimeData, todayStartMs) {
  const sample = Object.values(uptimeData)[0]?.days;
  if (sample?.length) return sample.map((d) => d.date.slice(0, 10));
  const out = [];
  for (let d = 89; d >= 0; d--) {
    out.push(new Date(todayStartMs - d * DAY_SEC * 1000).toISOString().slice(0, 10));
  }
  return out;
}

function buildRow({ id, name, isAggregate, days, startDate }) {
  const major_seconds = days.reduce((s, d) => s + d.major_s, 0);
  const critical_seconds = days.reduce((s, d) => s + d.critical_s, 0);
  const inWindowDays = startDate
    ? days.filter((d) => d.date >= startDate && d.impact !== "no_data").length
    : days.length;
  const rowWindowSec = inWindowDays * DAY_SEC;
  const weighted = weightedDowntime(major_seconds, critical_seconds);
  const uptime_pct = rowWindowSec > 0
    ? Number(((1 - weighted / rowWindowSec) * 100).toFixed(4))
    : 100;
  return {
    id,
    name,
    is_aggregate: isAggregate,
    uptime_pct,
    window_seconds: rowWindowSec,
    major_seconds,
    critical_seconds,
    maintenance_seconds: 0,
    start_date: startDate || null,
    days,
  };
}

function buildComponentDay(date, compData, incidentsByDate, componentsById, componentId) {
  if (date < compData.startDate) {
    return {
      date,
      impact: "no_data",
      downtime_s: 0,
      downtime_s_raw: 0,
      major_s: 0,
      critical_s: 0,
      maintenance_s: 0,
      incident_ids: [],
      incident_names: [],
    };
  }
  const rec = compData.byDate.get(date) || { p: 0, m: 0, events: [] };
  const major_s = rec.p;
  const critical_s = rec.m;
  const incidentIdSet = new Set();
  for (const e of rec.events) if (e.code) incidentIdSet.add(e.code);
  for (const id of incidentsByDate.get(date) || []) {
    if (componentsById.get(id)?.has(componentId)) incidentIdSet.add(id);
  }
  return {
    date,
    impact: impactFromSeconds(major_s, critical_s),
    downtime_s: weightedDowntime(major_s, critical_s),
    downtime_s_raw: major_s + critical_s,
    major_s,
    critical_s,
    maintenance_s: 0,
    incident_ids: [...incidentIdSet],
    incident_names: rec.events.map((e) => e.name).filter(Boolean),
  };
}

function buildAggregateDay(date, componentList, perComponent, incidentsByDate) {
  // Per-tier max across components: same incident often updates multiple
  // components concurrently, so summing would multi-count.
  let major_s = 0;
  let critical_s = 0;
  const incidentSet = new Set();
  for (const c of componentList) {
    const compData = perComponent.get(c.id);
    if (!compData || date < compData.startDate) continue;
    const rec = compData.byDate.get(date) || { p: 0, m: 0, events: [] };
    if (rec.p > major_s) major_s = rec.p;
    if (rec.m > critical_s) critical_s = rec.m;
    for (const e of rec.events) if (e.code) incidentSet.add(e.code);
  }
  for (const id of incidentsByDate.get(date) || []) incidentSet.add(id);
  return {
    date,
    impact: impactFromSeconds(major_s, critical_s),
    downtime_s: weightedDowntime(major_s, critical_s),
    downtime_s_raw: major_s + critical_s,
    major_s,
    critical_s,
    maintenance_s: 0,
    incident_ids: [...incidentSet],
  };
}

function aggregateWindow(aggregateRow, daysCount, todayStartMs, nowMs) {
  const sliced = aggregateRow.days.slice(-daysCount);
  const major = sliced.reduce((s, d) => s + d.major_s, 0);
  const critical = sliced.reduce((s, d) => s + d.critical_s, 0);
  const totalSec = sliced.length * DAY_SEC;
  const weighted = weightedDowntime(major, critical);
  const uptime_pct = totalSec > 0
    ? Number(((1 - weighted / totalSec) * 100).toFixed(4))
    : 100;
  return {
    window: `${daysCount}d`,
    start: new Date(todayStartMs - (daysCount - 1) * DAY_SEC * 1000).toISOString(),
    end: new Date(nowMs).toISOString(),
    uptime_pct,
    downtime_seconds: weighted,
    downtime_seconds_raw: major + critical,
    maintenance_seconds: 0,
    total_seconds: totalSec,
    major_seconds: major,
    critical_seconds: critical,
    segments: [],
    stats: {
      incident_count: new Set(sliced.flatMap((d) => d.incident_ids)).size,
      longest_outage_seconds: Math.max(0, ...sliced.map((d) => d.downtime_s_raw)),
    },
  };
}

function buildHistoryMonths(history, earliestStart) {
  const monthsByKey = new Map();
  for (const compEntry of Object.values(history.components || {})) {
    for (const mo of compEntry.months || []) {
      if (!monthsByKey.has(mo.key)) {
        monthsByKey.set(mo.key, {
          key: mo.key,
          year: mo.year,
          month: mo.month,
          name: mo.name,
          dayMap: new Map(),
          hasRealData: false,
        });
      }
      const merged = monthsByKey.get(mo.key);
      if (mo.uptime_percentage != null) merged.hasRealData = true;
      for (const d of mo.days || []) {
        if (!d.date) continue;
        const key = d.date.slice(0, 10);
        if (!merged.dayMap.has(key)) {
          merged.dayMap.set(key, { p: 0, m: 0, events: [] });
        }
        const cell = merged.dayMap.get(key);
        if (d.p > cell.p) cell.p = d.p;
        if (d.m > cell.m) cell.m = d.m;
        for (const e of d.events || []) {
          if (e.code && !cell.events.some((x) => x.code === e.code)) cell.events.push(e);
        }
      }
    }
  }
  for (const [key, mo] of [...monthsByKey.entries()]) {
    if (!mo.hasRealData) monthsByKey.delete(key);
  }

  return [...monthsByKey.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((mo) => ({
      key: mo.key,
      year: mo.year,
      month: mo.month,
      name: mo.name,
      days: [...mo.dayMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, cell]) => {
          const preExistence = earliestStart && date < earliestStart;
          const impact = preExistence
            ? "no_data"
            : cell.m > 0 ? "critical"
            : cell.p > 0 ? "major"
            : "none";
          return {
            date,
            impact,
            major_s: cell.p,
            critical_s: cell.m,
            maintenance_s: 0,
            incident_ids: cell.events.map((e) => e.code),
          };
        }),
    }));
}

async function main() {
  const now = new Date();
  const nowMs = now.getTime();
  const todayStartMs = Math.floor(nowMs / (DAY_SEC * 1000)) * DAY_SEC * 1000;
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;

  const incidents = await loadAllIncidents();
  const derivedDir = join(DATA_DIR, "derived");
  await mkdir(derivedDir, { recursive: true });

  const comps = loadJsonIfExists(join(DATA_DIR, "components.json"));
  const componentList = comps?.components || [];
  const componentNames = Object.fromEntries(componentList.map((c) => [c.id, c.name]));

  const componentBreakdown = computeComponentBreakdown(incidents, {
    start: todayStart + DAY_MS - 90 * DAY_MS,
    end: nowMs,
    now,
  });
  for (const id of Object.keys(componentBreakdown)) {
    componentBreakdown[id].name = componentNames[id] || componentBreakdown[id].name;
  }
  await writeFile(
    join(derivedDir, "component-90d.json"),
    JSON.stringify({ generated_at: now.toISOString(), components: componentBreakdown }, null, 2) + "\n",
  );

  const uptimeData = loadJsonIfExists(join(DATA_DIR, "uptime-data.json")) || {};
  const dateKeys = getDateKeys(uptimeData, todayStartMs);
  const perComponent = buildPerComponent(componentList, uptimeData, dateKeys[0]);
  const { byDate: incidentsByDate, componentsById } = buildIncidentsByDate(incidents, nowMs);

  const componentRows = componentList.map((c) => {
    const compData = perComponent.get(c.id) || { byDate: new Map(), startDate: dateKeys[0] };
    const days = dateKeys.map((date) =>
      buildComponentDay(date, compData, incidentsByDate, componentsById, c.id),
    );
    return buildRow({
      id: c.id,
      name: c.name,
      isAggregate: false,
      startDate: compData.startDate,
      days,
    });
  });

  const aggregateDays = dateKeys.map((date) =>
    buildAggregateDay(date, componentList, perComponent, incidentsByDate),
  );
  const aggregateRow = buildRow({
    id: "__aggregate__",
    name: "All Claude (aggregate)",
    isAggregate: true,
    startDate: dateKeys[0],
    days: aggregateDays,
  });

  await writeFile(
    join(derivedDir, "daily-90d.json"),
    JSON.stringify(
      { generated_at: now.toISOString(), days: 90, rows: [aggregateRow, ...componentRows] },
      null,
      2,
    ) + "\n",
  );

  const aggregateByWindow = {
    "24h": aggregateWindow(aggregateRow, 1, todayStartMs, nowMs),
    "7d": aggregateWindow(aggregateRow, 7, todayStartMs, nowMs),
    "30d": aggregateWindow(aggregateRow, 30, todayStartMs, nowMs),
    "90d": aggregateWindow(aggregateRow, 90, todayStartMs, nowMs),
  };
  await writeFile(
    join(derivedDir, "aggregate.json"),
    JSON.stringify({ generated_at: now.toISOString(), windows: aggregateByWindow }, null, 2) + "\n",
  );

  const history = loadJsonIfExists(join(DATA_DIR, "uptime-history.json"));
  if (history) {
    let earliestStart = null;
    for (const e of Object.values(uptimeData)) {
      const s = e.component?.startDate;
      if (s && (earliestStart == null || s < earliestStart)) earliestStart = s;
    }
    const months = buildHistoryMonths(history, earliestStart);
    await writeFile(
      join(derivedDir, "aggregate-history.json"),
      JSON.stringify({ generated_at: now.toISOString(), months }, null, 2) + "\n",
    );
  }

  const index = incidents
    .map((i) => ({
      id: i.id,
      name: i.name,
      impact: i.impact,
      status: i.status,
      created_at: i.created_at,
      started_at: i.started_at,
      resolved_at: i.resolved_at,
      components: (i.components || []).map((c) => ({ id: c.id, name: c.name })),
      update_count: (i.incident_updates || []).length,
    }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  await writeFile(
    join(derivedDir, "incidents-index.json"),
    JSON.stringify({ generated_at: now.toISOString(), incidents: index }, null, 2) + "\n",
  );

  const a90 = aggregateByWindow["90d"];
  console.log(
    `derive ok: 90d uptime ${a90.uptime_pct.toFixed(3)}%, ${a90.segments.length} segments, ${incidents.length} incidents indexed`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
