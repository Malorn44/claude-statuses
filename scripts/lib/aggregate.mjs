export const SEVERITY_ORDER = ["none", "maintenance", "minor", "major", "critical"];

const STATUS_TO_IMPACT = {
  operational: "none",
  degraded_performance: "none",
  partial_outage: "major",
  major_outage: "critical",
  under_maintenance: "maintenance",
};

// Empirical match to status.claude.com: partial @ 30%, major @ 100%.
const IMPACT_DOWNTIME_FRACTION = {
  none: 0,
  maintenance: 0,
  minor: 0,
  major: 0.30,
  critical: 1.0,
};

function weightedDowntimeSeconds(segments) {
  let total = 0;
  for (const s of segments) total += (s.duration_s || 0) * (IMPACT_DOWNTIME_FRACTION[s.impact] || 0);
  return total;
}

function severityRank(s) {
  const i = SEVERITY_ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}

function maxSeverity(impacts) {
  let best = "none";
  for (const i of impacts) if (severityRank(i) > severityRank(best)) best = i;
  return best;
}

export function buildComponentStatusIntervals(incidents, { now = new Date() } = {}) {
  const events = [];
  for (const inc of incidents) {
    for (const u of inc.incident_updates || []) {
      const ts = new Date(u.display_at || u.created_at).getTime();
      if (!Number.isFinite(ts)) continue;
      for (const ac of u.affected_components || []) {
        if (!ac.code || !ac.new_status) continue;
        events.push({
          ts,
          code: ac.code,
          name: ac.name || ac.code,
          oldStatus: ac.old_status,
          newStatus: ac.new_status,
          incidentId: inc.id,
        });
      }
    }
  }
  events.sort((a, b) => a.ts - b.ts);

  const current = new Map();
  const intervals = [];
  const close = (code, endTs) => {
    const st = current.get(code);
    if (!st) return;
    intervals.push({
      id: `${code}@${st.since}`,
      componentId: code,
      name: st.name,
      status: st.status,
      impact: STATUS_TO_IMPACT[st.status] || "none",
      start: st.since,
      end: endTs,
      components: [{ id: code, name: st.name }],
      incidentIds: [...st.incidents],
    });
    current.delete(code);
  };

  for (const ev of events) {
    const prev = current.get(ev.code);
    // Trust upstream old_status: admins sometimes reset status outside
    // public updates, so discard the stale interval rather than overcount.
    if (prev && ev.oldStatus && ev.oldStatus !== prev.status) {
      current.delete(ev.code);
    }
    const stillPrev = current.get(ev.code);
    if (stillPrev && stillPrev.status === ev.newStatus) {
      stillPrev.incidents.add(ev.incidentId);
      continue;
    }
    close(ev.code, ev.ts);
    if (ev.newStatus !== "operational") {
      current.set(ev.code, {
        name: ev.name,
        status: ev.newStatus,
        since: ev.ts,
        incidents: new Set([ev.incidentId]),
      });
    }
  }
  const nowMs = now.getTime();
  for (const code of [...current.keys()]) close(code, nowMs);
  return intervals;
}

export function unionSegments(intervals) {
  if (intervals.length === 0) return [];
  const events = [];
  for (const iv of intervals) {
    events.push({ t: iv.start, type: "open", iv });
    events.push({ t: iv.end, type: "close", iv });
  }
  // Process closes before opens at the same timestamp to avoid zero-length blips.
  events.sort((a, b) => a.t - b.t || (a.type === "close" ? -1 : 1));

  const active = new Map();
  const segments = [];
  let lastT = null;

  const flush = (untilT) => {
    if (lastT === null || untilT <= lastT || active.size === 0) return;
    const impacts = [...active.values()].map((i) => i.impact);
    const impact = maxSeverity(impacts);
    const componentMap = new Map();
    const incidentIdSet = new Set();
    for (const iv of active.values()) {
      if (iv.incidentIds?.length) for (const id of iv.incidentIds) incidentIdSet.add(id);
      else if (iv.id) incidentIdSet.add(iv.id);
      for (const c of iv.components) componentMap.set(c.id, c);
    }
    segments.push({
      start: new Date(lastT).toISOString(),
      end: new Date(untilT).toISOString(),
      duration_s: Math.round((untilT - lastT) / 1000),
      impact,
      components: [...componentMap.values()],
      incident_ids: [...incidentIdSet],
    });
  };

  for (const ev of events) {
    if (lastT !== null && ev.t > lastT) flush(ev.t);
    if (ev.type === "open") active.set(ev.iv.id, ev.iv);
    else active.delete(ev.iv.id);
    lastT = ev.t;
  }
  return segments;
}

function clipSegments(segments, windowStart, windowEnd) {
  const out = [];
  for (const s of segments) {
    const startMs = Math.max(new Date(s.start).getTime(), windowStart);
    const endMs = Math.min(new Date(s.end).getTime(), windowEnd);
    if (endMs <= startMs) continue;
    out.push({
      ...s,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      duration_s: Math.round((endMs - startMs) / 1000),
    });
  }
  return out;
}

export function computeAggregate(incidents, { window, start, end, now = new Date(), filterComponentId } = {}) {
  let intervals = buildComponentStatusIntervals(incidents, { now });
  if (filterComponentId) {
    intervals = intervals.filter((iv) => iv.componentId === filterComponentId);
  }
  const allSegments = unionSegments(intervals);

  const windowEndMs = end ?? now.getTime();
  const windowStartMs = start
    ?? (window
      ? windowEndMs - window
      : (intervals.length ? Math.min(...intervals.map((i) => i.start), windowEndMs) : windowEndMs));

  const segments = clipSegments(allSegments, windowStartMs, windowEndMs);
  const totalSeconds = Math.round((windowEndMs - windowStartMs) / 1000);

  let majorSeconds = 0;
  let criticalSeconds = 0;
  let maintSeconds = 0;
  for (const s of segments) {
    if (s.impact === "maintenance") maintSeconds += s.duration_s;
    else if (s.impact === "major") majorSeconds += s.duration_s;
    else if (s.impact === "critical") criticalSeconds += s.duration_s;
  }
  const rawDownSeconds = majorSeconds + criticalSeconds;
  const weightedDownSeconds = Math.round(weightedDowntimeSeconds(segments));
  const uptimePct = totalSeconds > 0
    ? (1 - weightedDownSeconds / totalSeconds) * 100
    : 100;

  const incidentSet = new Set();
  for (const iv of intervals) {
    if (iv.end >= windowStartMs && iv.start <= windowEndMs) {
      for (const id of iv.incidentIds || []) incidentSet.add(id);
    }
  }
  const overlapCount = segments.filter(
    (s) => (s.components || []).length > 1,
  ).length;
  let longestOutage = 0;
  for (const s of segments) {
    if (s.impact !== "none" && s.impact !== "maintenance") {
      longestOutage = Math.max(longestOutage, s.duration_s);
    }
  }

  return {
    window: window ? `${Math.round(window / 86400000)}d` : "all",
    start: new Date(windowStartMs).toISOString(),
    end: new Date(windowEndMs).toISOString(),
    uptime_pct: Number(uptimePct.toFixed(4)),
    downtime_seconds: weightedDownSeconds,
    downtime_seconds_raw: rawDownSeconds,
    maintenance_seconds: maintSeconds,
    total_seconds: totalSeconds,
    major_seconds: majorSeconds,
    critical_seconds: criticalSeconds,
    segments,
    stats: {
      incident_count: incidentSet.size,
      overlap_segment_count: overlapCount,
      longest_outage_seconds: longestOutage,
    },
  };
}

export function computeComponentBreakdown(incidents, { window, start, end, now = new Date() } = {}) {
  const allIntervals = buildComponentStatusIntervals(incidents, { now });
  const byComponent = new Map();
  for (const iv of allIntervals) {
    if (!byComponent.has(iv.componentId)) {
      byComponent.set(iv.componentId, { id: iv.componentId, name: iv.name });
    }
  }
  const out = {};
  for (const [id, { name }] of byComponent) {
    const agg = computeAggregate(incidents, {
      window,
      start,
      end,
      now,
      filterComponentId: id,
    });
    out[id] = {
      id,
      name,
      uptime_pct: agg.uptime_pct,
      downtime_seconds: agg.downtime_seconds,
      incident_count: agg.stats.incident_count,
    };
  }
  return out;
}

export function computeDailyBuckets(incidents, { days = 90, now = new Date(), filterComponentId } = {}) {
  const DAY_MS = 86_400_000;
  const todayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const endMs = todayStart + DAY_MS;
  const startMs = endMs - days * DAY_MS;

  let intervals = buildComponentStatusIntervals(incidents, { now });
  if (filterComponentId) intervals = intervals.filter((iv) => iv.componentId === filterComponentId);

  const relatedByDay = new Map();
  const incidentRange = (inc) => {
    const s = inc.started_at || inc.created_at;
    const e = inc.resolved_at || now.toISOString();
    if (!s) return null;
    return { startMs: new Date(s).getTime(), endMs: new Date(e).getTime() };
  };
  for (const inc of incidents) {
    if (filterComponentId && !(inc.components || []).some((c) => c.id === filterComponentId)) continue;
    const r = incidentRange(inc);
    if (!r) continue;
    const firstDay = Math.max(0, Math.floor((r.startMs - startMs) / DAY_MS));
    const lastDay = Math.min(days - 1, Math.floor((r.endMs - startMs) / DAY_MS));
    for (let d = firstDay; d <= lastDay; d++) {
      if (!relatedByDay.has(d)) relatedByDay.set(d, new Set());
      relatedByDay.get(d).add(inc.id);
    }
  }

  const nowMs = now.getTime();
  const buckets = [];
  let measuredSec = 0;
  for (let d = 0; d < days; d++) {
    const ds = startMs + d * DAY_MS;
    // Clip today's bucket to now so unused hours aren't credited.
    const de = Math.min(ds + DAY_MS, nowMs);
    if (de <= ds) {
      buckets.push({
        date: new Date(ds).toISOString().slice(0, 10),
        impact: "none",
        downtime_s: 0,
        maintenance_s: 0,
        incident_ids: [],
      });
      continue;
    }
    measuredSec += (de - ds) / 1000;
    const dayIntervals = [];
    for (const iv of intervals) {
      const oStart = Math.max(iv.start, ds);
      const oEnd = Math.min(iv.end, de);
      if (oEnd <= oStart) continue;
      dayIntervals.push({ ...iv, start: oStart, end: oEnd });
    }
    const segs = unionSegments(dayIntervals);
    let majorSec = 0;
    let criticalSec = 0;
    let maintSec = 0;
    for (const s of segs) {
      if (s.impact === "maintenance") maintSec += s.duration_s;
      else if (s.impact === "major") majorSec += s.duration_s;
      else if (s.impact === "critical") criticalSec += s.duration_s;
    }
    const weightedDownSec = Math.round(weightedDowntimeSeconds(segs));
    const impact = maxSeverity(segs.map((s) => s.impact));
    buckets.push({
      date: new Date(ds).toISOString().slice(0, 10),
      impact: impact || "none",
      downtime_s: weightedDownSec,
      downtime_s_raw: majorSec + criticalSec,
      major_s: majorSec,
      critical_s: criticalSec,
      maintenance_s: maintSec,
      incident_ids: [...(relatedByDay.get(d) || [])],
    });
  }
  const majorTotal = buckets.reduce((s, b) => s + b.major_s, 0);
  const criticalTotal = buckets.reduce((s, b) => s + b.critical_s, 0);
  const maintTotal = buckets.reduce((s, b) => s + b.maintenance_s, 0);
  const downSecTotal = buckets.reduce((s, b) => s + b.downtime_s, 0);
  const uptimePct = measuredSec > 0
    ? (measuredSec - downSecTotal) / measuredSec * 100
    : 100;
  return {
    days: buckets,
    uptime_pct: Number(uptimePct.toFixed(4)),
    window_seconds: Math.round(measuredSec),
    major_seconds: majorTotal,
    critical_seconds: criticalTotal,
    maintenance_seconds: maintTotal,
  };
}
