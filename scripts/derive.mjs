#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAllIncidents, DATA_DIR } from "./lib/incident.mjs";

const DAY_MS = 86_400_000;
const DAY_SEC = 86400;

function impactFromSeconds(major, critical, minor = 0) {
  if (critical > 0) return "critical";
  if (major > 0) return "major";
  if (minor > 0) return "minor";
  return "none";
}

function unionIntervalsToDailySeconds(intervals) {
  if (intervals.length === 0) return new Map();
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const merged = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else merged.push([sorted[i][0], sorted[i][1]]);
  }
  const byDate = new Map();
  for (const [start, end] of merged) {
    const firstDayMs = Math.floor(start / (DAY_SEC * 1000)) * DAY_SEC * 1000;
    const lastDayMs = Math.floor((end - 1) / (DAY_SEC * 1000)) * DAY_SEC * 1000;
    for (let d = firstDayMs; d <= lastDayMs; d += DAY_SEC * 1000) {
      const dateStr = new Date(d).toISOString().slice(0, 10);
      const dayEnd = d + DAY_SEC * 1000;
      const secs = Math.round((Math.min(end, dayEnd) - Math.max(start, d)) / 1000);
      byDate.set(dateStr, (byDate.get(dateStr) || 0) + secs);
    }
  }
  return byDate;
}

function buildMinorSecondsByComponent(incidents, nowMs) {
  // Sweep minor-impact incidents into per-(component, date) and aggregate
  // per-date second buckets, unioning overlapping intervals so concurrent
  // incidents don't multi-count.
  const intervalsByComponent = new Map();
  const aggregateIntervals = [];
  for (const inc of incidents) {
    if (inc.impact !== "minor") continue;
    const startMs = new Date(inc.started_at || inc.created_at).getTime();
    if (!Number.isFinite(startMs)) continue;
    const endMs = inc.resolved_at ? new Date(inc.resolved_at).getTime() : nowMs;
    if (endMs <= startMs) continue;
    aggregateIntervals.push([startMs, endMs]);
    for (const c of inc.components || []) {
      if (!intervalsByComponent.has(c.id)) intervalsByComponent.set(c.id, []);
      intervalsByComponent.get(c.id).push([startMs, endMs]);
    }
  }
  const perComponent = new Map();
  for (const [cid, ivs] of intervalsByComponent) {
    perComponent.set(cid, unionIntervalsToDailySeconds(ivs));
  }
  return { perComponent, aggregate: unionIntervalsToDailySeconds(aggregateIntervals) };
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
  const minor_seconds = days.reduce((s, d) => s + (d.minor_s || 0), 0);
  const inWindowDays = startDate
    ? days.filter((d) => d.date >= startDate && d.impact !== "no_data").length
    : days.length;
  const rowWindowSec = inWindowDays * DAY_SEC;
  return {
    id,
    name,
    is_aggregate: isAggregate,
    window_seconds: rowWindowSec,
    major_seconds,
    critical_seconds,
    minor_seconds,
    days,
  };
}

function buildComponentDay(date, compData, incidentsByDate, componentsById, componentId, minorByDate) {
  if (date < compData.startDate) {
    return {
      date,
      impact: "no_data",
      major_s: 0,
      critical_s: 0,
      minor_s: 0,
      maintenance_s: 0,
      incident_ids: [],
    };
  }
  const rec = compData.byDate.get(date) || { p: 0, m: 0, events: [] };
  const major_s = rec.p;
  const critical_s = rec.m;
  const minor_s = minorByDate?.get(date) || 0;
  const incidentIdSet = new Set();
  for (const e of rec.events) if (e.code) incidentIdSet.add(e.code);
  for (const id of incidentsByDate.get(date) || []) {
    if (componentsById.get(id)?.has(componentId)) incidentIdSet.add(id);
  }
  return {
    date,
    impact: impactFromSeconds(major_s, critical_s, minor_s),
    major_s,
    critical_s,
    minor_s,
    maintenance_s: 0,
    incident_ids: [...incidentIdSet],
  };
}

function buildAggregateDay(date, componentList, perComponent, incidentsByDate, aggregateMinorByDate) {
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
  const minor_s = aggregateMinorByDate?.get(date) || 0;
  return {
    date,
    impact: impactFromSeconds(major_s, critical_s, minor_s),
    major_s,
    critical_s,
    minor_s,
    maintenance_s: 0,
    incident_ids: [...incidentSet],
  };
}

function aggregateWindow(aggregateRow, daysCount) {
  const sliced = aggregateRow.days.slice(-daysCount);
  const major = sliced.reduce((s, d) => s + d.major_s, 0);
  const critical = sliced.reduce((s, d) => s + d.critical_s, 0);
  const minor = sliced.reduce((s, d) => s + (d.minor_s || 0), 0);
  const totalSec = sliced.length * DAY_SEC;
  return {
    total_seconds: totalSec,
    major_seconds: major,
    critical_seconds: critical,
    minor_seconds: minor,
    stats: {
      incident_count: new Set(sliced.flatMap((d) => d.incident_ids)).size,
    },
  };
}

function buildHistoryMonths(history, earliestStart, aggregateMinorByDate) {
  const monthsByKey = new Map();
  for (const compEntry of Object.values(history.components || {})) {
    for (const mo of compEntry.months || []) {
      if (!monthsByKey.has(mo.key)) {
        monthsByKey.set(mo.key, {
          key: mo.key,
          year: mo.year,
          month: mo.month,
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
      days: [...mo.dayMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, cell]) => {
          const preExistence = earliestStart && date < earliestStart;
          const minor_s = aggregateMinorByDate?.get(date) || 0;
          const impact = preExistence
            ? "no_data"
            : impactFromSeconds(cell.p, cell.m, minor_s);
          return {
            date,
            impact,
            major_s: cell.p,
            critical_s: cell.m,
            minor_s,
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

  const incidents = await loadAllIncidents();
  const derivedDir = join(DATA_DIR, "derived");
  await mkdir(derivedDir, { recursive: true });

  const comps = loadJsonIfExists(join(DATA_DIR, "components.json"));
  const componentList = comps?.components || [];

  const uptimeData = loadJsonIfExists(join(DATA_DIR, "uptime-data.json")) || {};
  const dateKeys = getDateKeys(uptimeData, todayStartMs);
  const perComponent = buildPerComponent(componentList, uptimeData, dateKeys[0]);
  const { byDate: incidentsByDate, componentsById } = buildIncidentsByDate(incidents, nowMs);
  const minorSeconds = buildMinorSecondsByComponent(incidents, nowMs);

  const componentRows = componentList.map((c) => {
    const compData = perComponent.get(c.id) || { byDate: new Map(), startDate: dateKeys[0] };
    const minorByDate = minorSeconds.perComponent.get(c.id);
    const days = dateKeys.map((date) =>
      buildComponentDay(date, compData, incidentsByDate, componentsById, c.id, minorByDate),
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
    buildAggregateDay(date, componentList, perComponent, incidentsByDate, minorSeconds.aggregate),
  );
  const aggregateRow = buildRow({
    id: "__aggregate__",
    name: "Claude Platform",
    isAggregate: true,
    startDate: dateKeys[0],
    days: aggregateDays,
  });

  await writeFile(
    join(derivedDir, "daily-90d.json"),
    JSON.stringify(
      { generated_at: now.toISOString(), rows: [aggregateRow, ...componentRows] },
      null,
      2,
    ) + "\n",
  );

  const aggregateByWindow = {
    "24h": aggregateWindow(aggregateRow, 1),
    "7d": aggregateWindow(aggregateRow, 7),
    "30d": aggregateWindow(aggregateRow, 30),
    "90d": aggregateWindow(aggregateRow, 90),
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
    const months = buildHistoryMonths(history, earliestStart, minorSeconds.aggregate);
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
      created_at: i.created_at,
      started_at: i.started_at,
      resolved_at: i.resolved_at,
      components: (i.components || []).map((c) => ({ id: c.id, name: c.name })),
    }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  await writeFile(
    join(derivedDir, "incidents-index.json"),
    JSON.stringify({ generated_at: now.toISOString(), incidents: index }, null, 2) + "\n",
  );

  const a90 = aggregateByWindow["90d"];
  const down90 = a90.major_seconds * 0.30 + a90.critical_seconds * 1.0;
  const uptime90 = a90.total_seconds > 0 ? (1 - down90 / a90.total_seconds) * 100 : 100;
  console.log(
    `derive ok: 90d uptime ${uptime90.toFixed(3)}%, ${incidents.length} incidents indexed`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
