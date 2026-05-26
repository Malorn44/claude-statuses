const WINDOW_LABEL = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

const IMPACT_LABEL = {
  none: "Operational",
  minor: "Minor issue",
  major: "Partial outage",
  critical: "Major outage",
  maintenance: "Maintenance",
  no_data: "No data",
};

const STATUSPAGE_BASE = "https://status.claude.com";

const ICON_EXTERNAL = `<svg class="icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="9 7 17 7 17 15"/></svg>`;
const ICON_EXTERNAL_LG = `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="9 7 17 7 17 15"/></svg>`;

// Empirical match to status.claude.com: partial @ 30%, major @ 100%.
const IMPACT_WEIGHTS = {
  minor: 0,
  major: 0.30,
  critical: 1.0,
  maintenance: 0,
};

const VISIBLE_DAYS = 7;

const state = {
  window: "90d",
  aggregate: null,
  daily: null,
  components: null,
  incidents: null,
  incidentById: new Map(),
  history: null,
  historyPage: 0,
};

function uptimeFromImpactSeconds(row) {
  const denom = row?.window_seconds ?? row?.total_seconds ?? 0;
  if (!denom) return 100;
  const major = row.major_seconds || 0;
  const critical = row.critical_seconds || 0;
  const down = major * IMPACT_WEIGHTS.major + critical * IMPACT_WEIGHTS.critical;
  return Math.max(0, Math.min(100, (1 - down / denom) * 100));
}

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function fmtPct(n) {
  // status.claude.com truncates (not rounds) at 2 decimals, strips trailing zeros.
  if (n == null || Number.isNaN(n)) return "—";
  const truncated = Math.floor(n * 100) / 100;
  const [intPart, decPart] = truncated.toFixed(2).split(".");
  const trimmed = (decPart || "").replace(/0+$/, "");
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}

function fmtDuration(seconds) {
  if (!seconds) return "0 m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${d}d ${rh}h` : `${d}d`;
  }
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function fmtDateShort(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDateLabel(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fmtDayHeader(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function renderHeroPanel(agg) {
  const windowLabel = WINDOW_LABEL[state.window];
  document.getElementById("hero-panel-title").textContent = `Last ${windowLabel} uptime`;
  document.getElementById("hero-panel-pct").textContent =
    `${fmtPct(uptimeFromImpactSeconds(agg))}% uptime`;
  const count = agg?.stats?.incident_count ?? 0;
  document.getElementById("hero-panel-incident-count").textContent =
    `${count} incident${count === 1 ? "" : "s"} in last ${windowLabel}`;
  if (state.aggregate?.generated_at) {
    document.getElementById("hero-panel-updated").textContent =
      `Last updated ${new Date(state.aggregate.generated_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  renderHeroPanelBars();
}

function renderHeroPanelBars() {
  const el = document.getElementById("hero-panel-bars");
  const aggRow = state.daily?.rows?.find((r) => r.is_aggregate);
  if (!aggRow) return;
  const rowIdx = state.daily.rows.indexOf(aggRow);
  const first = aggRow.days[0]?.date;
  const last = aggRow.days[aggRow.days.length - 1]?.date;
  if (first) document.getElementById("hero-panel-axis-start").textContent = fmtDateLabel(first);
  if (last) document.getElementById("hero-panel-axis-end").textContent = fmtDateLabel(last);
  el.innerHTML = aggRow.days
    .map((d, dayIdx) =>
      `<div class="chart-bar impact-${d.impact}" data-row="${rowIdx}" data-day="${dayIdx}"></div>`,
    )
    .join("");
  attachBarPopover(state.daily, el);
}

function renderChart(daily) {
  const el = document.getElementById("chart");
  if (!daily?.rows?.length) return;

  const first = daily.rows[0]?.days?.[0]?.date;
  const last = daily.rows[0]?.days?.[daily.rows[0].days.length - 1]?.date;
  if (first) document.getElementById("chart-axis-start").textContent = fmtDateLabel(first);
  if (last) document.getElementById("chart-axis-end").textContent = fmtDateLabel(last);

  const rows = daily.rows.map((row, rowIdx) => {
    if (row.is_aggregate) return "";
    const bars = row.days
      .map((d, dayIdx) =>
        `<div class="chart-bar impact-${d.impact}" data-row="${rowIdx}" data-day="${dayIdx}"></div>`,
      )
      .join("");
    return `
      <div class="chart-row" data-row-id="${escapeHtml(row.id)}">
        <div class="chart-row-header">
          <span class="chart-label">${escapeHtml(row.name)}</span>
          <span class="chart-uptime" data-row-uptime>${fmtPct(uptimeFromImpactSeconds(row))}% uptime</span>
        </div>
        <div class="chart-bars">${bars}</div>
      </div>
    `;
  });
  el.innerHTML = rows.join("");

  attachBarPopover(daily);
}

const Popover = {
  el: null,
  hideTimer: null,
  sticky: false,
  stickyTarget: null,
  ensure() {
    if (this.el) return this.el;
    const el = document.createElement("div");
    el.id = "bar-popover";
    el.className = "bar-popover";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);
    el.addEventListener("pointerenter", () => clearTimeout(this.hideTimer));
    el.addEventListener("pointerleave", () => {
      if (!this.sticky) this.scheduleHide();
    });
    document.addEventListener("click", (e) => {
      if (!this.sticky) return;
      if (e.target.closest(".chart-bar, .history-day, .bar-popover")) return;
      this.hide();
    });
    this.el = el;
    return el;
  },
  scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.el?.classList.remove("is-visible"), 120);
  },
  hide() {
    clearTimeout(this.hideTimer);
    this.el?.classList.remove("is-visible");
    this.sticky = false;
    this.stickyTarget = null;
  },
  showAt(target, contentHtml) {
    const el = this.ensure();
    el.innerHTML = contentHtml;
    el.classList.add("is-visible");
    clearTimeout(this.hideTimer);
    const r = target.getBoundingClientRect();
    const popRect = el.getBoundingClientRect();
    const centerX = r.left + r.width / 2;
    let left = centerX - popRect.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, left));
    const arrowX = centerX - left;
    el.style.position = "absolute";
    el.style.left = `${left + window.scrollX}px`;
    el.style.top = `${r.bottom + window.scrollY + 10}px`;
    el.style.transform = "none";
    el.style.setProperty("--arrow-x", `${arrowX}px`);
  },
  toggleSticky(target, contentHtml) {
    if (this.sticky && this.stickyTarget === target) {
      this.hide();
      return;
    }
    this.sticky = true;
    this.stickyTarget = target;
    this.showAt(target, contentHtml);
  },
};

function attachBarPopover(daily, root = document) {
  for (const bar of root.querySelectorAll(".chart-bar")) {
    if (bar.dataset.popoverBound === "1") continue;
    bar.dataset.popoverBound = "1";
    const buildContent = () => {
      const row = daily.rows[Number(bar.dataset.row)];
      const day = row?.days?.[Number(bar.dataset.day)];
      return day ? renderPopoverContent(day, row) : null;
    };
    bar.addEventListener("pointerenter", () => {
      const html = buildContent();
      if (html != null) Popover.showAt(bar, html);
    });
    bar.addEventListener("pointerleave", () => Popover.scheduleHide());
    bar.addEventListener("click", (e) => {
      e.stopPropagation();
      const html = buildContent();
      if (html != null) Popover.toggleSticky(bar, html);
    });
  }
}

function impactPillLine(impact, durationSec) {
  return `
    <div class="bar-popover-line">
      <span class="impact-pill impact-${impact}">${escapeHtml(IMPACT_LABEL[impact])}</span>
      ${durationSec != null ? `<span class="bar-popover-duration">${escapeHtml(fmtDuration(durationSec))}</span>` : ""}
    </div>
  `;
}

function renderPopoverContent(day, row) {
  const impact = day.impact || "none";
  if (impact === "no_data") {
    return `
      <div class="bar-popover-date">${escapeHtml(fmtDateLabel(day.date))}</div>
      <div class="bar-popover-lines">${impactPillLine("no_data", null)}</div>
      <div class="bar-popover-empty">No data for ${escapeHtml(row.name)} on this day.</div>
    `;
  }

  const partialS = day.major_s || 0;
  const criticalS = day.critical_s || 0;
  const maintS = day.maintenance_s || 0;

  const lines = [];
  if (criticalS > 0) lines.push(impactPillLine("critical", criticalS));
  if (partialS > 0) lines.push(impactPillLine("major", partialS));
  if (maintS > 0) lines.push(impactPillLine("maintenance", maintS));
  if (lines.length === 0) {
    lines.push(impactPillLine(impact === "minor" ? "minor" : "none", null));
  }

  const uniqIds = [...new Set(day.incident_ids || [])];
  const incidentsList = uniqIds.length
    ? `<ul class="bar-popover-incidents">${uniqIds
        .map((id) => {
          const inc = state.incidentById.get(id);
          const name = inc?.name || id;
          return `<li><a href="${STATUSPAGE_BASE}/incidents/${encodeURIComponent(id)}" target="_blank" rel="noopener">${escapeHtml(name)} ${ICON_EXTERNAL}</a></li>`;
        })
        .join("")}</ul>`
    : impact === "none"
      ? `<div class="bar-popover-empty">No downtime on this day.</div>`
      : "";

  return `
    <div class="bar-popover-date">${escapeHtml(fmtDateLabel(day.date))}</div>
    <div class="bar-popover-lines">${lines.join("")}</div>
    ${incidentsList}
  `;
}

function populateComponentFilter(components) {
  const filter = document.getElementById("filter-component");
  if (filter.children.length !== 1) return;
  const items = (components?.components || [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const c of items) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    filter.appendChild(opt);
  }
}

function renderIncidents() {
  const el = document.getElementById("incidents");
  const compFilter = document.getElementById("filter-component").value;
  const impactFilter = document.getElementById("filter-impact").value;
  const list = (state.incidents?.incidents || []).filter((i) => {
    if (compFilter && !(i.components || []).some((c) => c.id === compFilter)) return false;
    if (impactFilter && i.impact !== impactFilter) return false;
    return true;
  });

  if (list.length === 0) {
    el.innerHTML = `<li class="muted" style="color:var(--muted);padding:24px;text-align:center">no incidents match</li>`;
    return;
  }

  const groups = new Map();
  for (const inc of list) {
    const start = inc.started_at || inc.created_at;
    if (!start) continue;
    const day = localDateKey(new Date(start));
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(inc);
  }
  const dayKeys = [...groups.keys()].sort((a, b) => b.localeCompare(a));

  const html = dayKeys.map((day, i) => {
    const dayIncidents = groups.get(day).sort(
      (a, b) =>
        new Date(b.started_at || b.created_at) -
        new Date(a.started_at || a.created_at),
    );
    const summary = `${dayIncidents.length} incident${dayIncidents.length === 1 ? "" : "s"}`;
    const collapsed = i >= VISIBLE_DAYS ? " is-collapsed" : "";
    return `
      <li class="incidents-day${collapsed}">
        <div class="incidents-day-header">
          <span class="incidents-day-date">${escapeHtml(fmtDayHeader(day))}</span>
          <span class="incidents-day-count">${summary}</span>
        </div>
        <ul class="incidents-day-list">
          ${dayIncidents.map(renderIncidentCard).join("")}
        </ul>
      </li>
    `;
  });
  el.innerHTML = html.join("");
  el.classList.remove("is-expanded");

  el.querySelectorAll(".incident-head").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest(".incident-link")) return;
      onToggleIncident(head.parentElement);
    });
  });

  const toggle = document.getElementById("incidents-toggle");
  if (dayKeys.length > VISIBLE_DAYS) {
    toggle.hidden = false;
    toggle.textContent = "Show More";
  } else {
    toggle.hidden = true;
  }
}

function renderIncidentCard(i) {
  const start = i.started_at || i.created_at;
  const end = i.resolved_at;
  const durSec = end && start
    ? Math.round((new Date(end) - new Date(start)) / 1000)
    : null;
  // Statuspage occasionally has resolved_at <= started_at on retroactive posts.
  const dur =
    durSec === null ? "ongoing"
    : durSec <= 0 ? "—"
    : fmtDuration(durSec);
  const compsHtml = (i.components || [])
    .map((c) => `<span class="component-chip">${escapeHtml(c.name)}</span>`)
    .join("");
  return `
    <li class="incident" data-id="${i.id}">
      <a class="incident-corner-link" href="${STATUSPAGE_BASE}/incidents/${encodeURIComponent(i.id)}" target="_blank" rel="noopener" title="View on status.claude.com" aria-label="View on status.claude.com">${ICON_EXTERNAL_LG}</a>
      <div class="incident-head">
        <div class="incident-bar sev-${i.impact || "minor"}"></div>
        <div class="incident-body">
          <p class="incident-title">${escapeHtml(i.name)}</p>
          <div class="incident-meta">
            <span class="impact-pill impact-${i.impact || "minor"}">${escapeHtml(IMPACT_LABEL[i.impact] || i.impact || "minor")}</span>
            <span class="incident-chip">${escapeHtml(dur)}</span>
            <span class="incident-meta-date">${fmtDateShort(start)}</span>
          </div>
          ${compsHtml ? `<div class="incident-meta incident-meta-comps-row">${compsHtml}</div>` : ""}
          <div class="incident-updates" data-loaded="false"></div>
        </div>
      </div>
    </li>
  `;
}

async function onToggleIncident(li) {
  const wasOpen = li.classList.toggle("is-open");
  if (!wasOpen) return;
  const updatesEl = li.querySelector(".incident-updates");
  if (updatesEl.dataset.loaded === "true") return;
  try {
    const full = await loadJson(`./data/incidents/${li.dataset.id}.json`);
    const chronological = (full.incident_updates || [])
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    // Statuspage labels a repeated status as "update" rather than the literal status name.
    const labeled = chronological.map((u, i) => ({
      ...u,
      displayStatus: i > 0 && u.status === chronological[i - 1].status ? "update" : u.status,
    }));
    updatesEl.innerHTML = labeled
      .reverse()
      .map(
        (u) => `
        <div class="update">
          <div class="update-meta">${escapeHtml(u.displayStatus)} · ${fmtDateShort(u.display_at || u.created_at)}</div>
          <div class="update-body">${escapeHtml(u.body || "")}</div>
        </div>
      `,
      )
      .join("");
    updatesEl.dataset.loaded = "true";
  } catch {
    updatesEl.innerHTML = `<div class="update muted">failed to load updates</div>`;
  }
}

const MONTH_FULL_NAME = {
  1: "January", 2: "February", 3: "March", 4: "April", 5: "May", 6: "June",
  7: "July", 8: "August", 9: "September", 10: "October", 11: "November", 12: "December",
};
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function getHistoryWindow() {
  const months = state.history?.months || [];
  if (!months.length) return [];
  const total = months.length;
  const end = total - state.historyPage * 3;
  const window = [];
  for (let i = end - 3; i < end; i++) {
    window.push(i >= 0 && i < total ? months[i] : null);
  }
  return window;
}

function renderHistory() {
  const container = document.getElementById("history-months");
  const months = getHistoryWindow();
  if (!months.length) {
    container.innerHTML = "<p class='muted'>No history available.</p>";
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  container.innerHTML = months
    .map((mo) => {
      if (!mo) return `<div class="history-month is-empty"></div>`;
      const dayByDate = new Map(mo.days.map((d) => [d.date, d]));
      const firstOfMonth = new Date(Date.UTC(mo.year, mo.month - 1, 1));
      const lastDay = new Date(Date.UTC(mo.year, mo.month, 0)).getUTCDate();
      const startWeekday = firstOfMonth.getUTCDay();
      const monthSeconds = lastDay * 86400;
      const weighted = mo.days.reduce(
        (s, d) => s + (d.major_s || 0) * IMPACT_WEIGHTS.major + (d.critical_s || 0) * IMPACT_WEIGHTS.critical,
        0,
      );
      const uptimePct = monthSeconds > 0 ? (1 - weighted / monthSeconds) * 100 : 100;

      const cells = [];
      for (let i = 0; i < startWeekday; i++) {
        cells.push(`<div class="history-day is-empty"></div>`);
      }
      for (let d = 1; d <= lastDay; d++) {
        const dateStr = `${mo.year}-${String(mo.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if (dateStr > todayStr) {
          cells.push(`<div class="history-day is-future" data-date="${dateStr}"></div>`);
          continue;
        }
        const dayData = dayByDate.get(dateStr) || { impact: "none", major_s: 0, critical_s: 0, maintenance_s: 0, incident_ids: [] };
        cells.push(
          `<div class="history-day impact-${dayData.impact}" data-month-key="${mo.key}" data-date="${dateStr}"></div>`,
        );
      }
      return `
        <div class="history-month">
          <div class="history-month-title">${escapeHtml(MONTH_FULL_NAME[mo.month])} ${mo.year}</div>
          <div class="history-month-uptime">${fmtPct(uptimePct)}% uptime</div>
          <div class="history-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
          <div class="history-grid">${cells.join("")}</div>
        </div>
      `;
    })
    .join("");

  const first = months.find((m) => m);
  const last = [...months].reverse().find((m) => m);
  document.getElementById("history-range").textContent = first && last
    ? `${MONTH_FULL_NAME[first.month].slice(0, 3)} ${first.year} – ${MONTH_FULL_NAME[last.month].slice(0, 3)} ${last.year}`
    : "";
  const total = (state.history?.months || []).length;
  document.getElementById("history-prev").disabled = state.historyPage * 3 >= total - 1;
  document.getElementById("history-next").disabled = state.historyPage <= 0;

  attachHistoryPopover();
}

function attachHistoryPopover() {
  const section = document.querySelector(".history-section");
  const aggRow = { id: "__aggregate__", name: "Claude Platform", is_aggregate: true };
  const dayMap = new Map();
  for (const mo of state.history?.months || []) {
    for (const d of mo.days) dayMap.set(d.date, d);
  }
  for (const cell of section.querySelectorAll(".history-day:not(.is-empty):not(.is-future)")) {
    let openTimer;
    const buildContent = () => {
      const day = dayMap.get(cell.dataset.date);
      return day ? renderPopoverContent(day, aggRow) : null;
    };
    cell.addEventListener("pointerenter", () => {
      const html = buildContent();
      if (html != null) openTimer = setTimeout(() => Popover.showAt(cell, html), 90);
    });
    cell.addEventListener("pointerleave", () => {
      clearTimeout(openTimer);
      Popover.scheduleHide();
    });
    cell.addEventListener("click", (e) => {
      clearTimeout(openTimer);
      e.stopPropagation();
      const html = buildContent();
      if (html != null) Popover.toggleSticky(cell, html);
    });
  }
}

function renderActiveWindow() {
  const agg = state.aggregate?.windows?.[state.window];
  if (!agg) return;
  renderHeroPanel(agg);
}

const PANEL_PNG_PALETTE = {
  bg: "#ffffff",
  fg: "#1c1917",
  muted: "#78716c",
  line: "#e7e5e4",
  ok: "#16a34a",
  minor: "#faa72a",
  major: "#e86235",
  critical: "#e04343",
  maintenance: "#2c84db",
  none: "#d6d3d1",
};

const PANEL_FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

function impactColor(impact) {
  const p = PANEL_PNG_PALETTE;
  return (
    impact === "critical" ? p.critical
    : impact === "major" ? p.major
    : impact === "minor" ? p.minor
    : impact === "maintenance" ? p.maintenance
    : impact === "no_data" ? p.line
    : p.ok
  );
}

function drawCardBadges(ctx, badges, W, PAD_X) {
  const BADGE_H = 66;
  const BADGE_PAD = 16;
  const BADGE_GAP = 12;
  const BADGE_TOP = 16;
  const widths = badges.map(([label, value]) => {
    ctx.font = `600 13px ${PANEL_FONT}`;
    const lw = ctx.measureText(label).width;
    ctx.font = `600 20px ${PANEL_FONT}`;
    const vw = ctx.measureText(value).width;
    return Math.max(lw, vw) + BADGE_PAD * 2;
  });
  let badgeX = W - PAD_X;
  for (let i = badges.length - 1; i >= 0; i--) {
    const w = widths[i];
    badgeX -= w;
    ctx.strokeStyle = PANEL_PNG_PALETTE.line;
    ctx.lineWidth = 1;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(badgeX + 0.5, BADGE_TOP + 0.5, w - 1, BADGE_H - 1, 8);
      ctx.stroke();
    } else {
      ctx.strokeRect(badgeX + 0.5, BADGE_TOP + 0.5, w - 1, BADGE_H - 1);
    }
    ctx.fillStyle = PANEL_PNG_PALETTE.muted;
    ctx.font = `600 13px ${PANEL_FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(badges[i][0], badgeX + BADGE_PAD, BADGE_TOP + 24);
    ctx.fillStyle = PANEL_PNG_PALETTE.fg;
    ctx.font = `600 20px ${PANEL_FONT}`;
    ctx.fillText(badges[i][1], badgeX + BADGE_PAD, BADGE_TOP + 52);
    badgeX -= BADGE_GAP;
  }
}

function drawCardBars(ctx, days, PAD_X, W) {
  const barsTop = 160;
  const barsHeight = 42;
  const gap = 2;
  const barRadius = 4;
  const barsWidth = W - PAD_X * 2;
  const barWidth = (barsWidth - gap * (days.length - 1)) / days.length;
  for (let i = 0; i < days.length; i++) {
    ctx.fillStyle = impactColor(days[i].impact || "none");
    const x = PAD_X + i * (barWidth + gap);
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, barsTop, barWidth, barsHeight, barRadius);
      ctx.fill();
    } else {
      ctx.fillRect(x, barsTop, barWidth, barsHeight);
    }
  }
  return { barsTop, barsHeight };
}

function drawCardFooter(ctx, W, PAD_X) {
  const footerY = 280;
  const p = PANEL_PNG_PALETTE;
  ctx.font = `15px ${PANEL_FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const legendItems = [
    ["operational", p.ok],
    ["maintenance", p.maintenance],
    ["major", p.major],
    ["critical", p.critical],
  ];
  let lx = PAD_X;
  for (const [label, color] of legendItems) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, footerY - 6, 12, 12);
    ctx.fillStyle = p.muted;
    ctx.fillText(label, lx + 20, footerY);
    lx += ctx.measureText(label).width + 36;
  }
  ctx.textAlign = "right";
  ctx.fillStyle = p.fg;
  ctx.font = `600 16px ${PANEL_FONT}`;
  const nameWidth = ctx.measureText("Mara Schwartz").width;
  ctx.fillText("Mara Schwartz", W - PAD_X, footerY);
  ctx.fillStyle = p.muted;
  ctx.font = `16px ${PANEL_FONT}`;
  ctx.fillText("by ", W - PAD_X - nameWidth, footerY);
}

function renderPanelToCanvas() {
  const agg = state.aggregate?.windows?.[state.window];
  const aggRow = state.daily?.rows?.find((r) => r.is_aggregate);
  if (!agg || !aggRow) return null;

  const W = 960;
  const H = 310;
  const PAD_X = 36;
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext("2d");
  ctx.scale(DPR, DPR);
  const p = PANEL_PNG_PALETTE;

  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = p.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  ctx.fillStyle = p.fg;
  ctx.font = `700 33px ${PANEL_FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(`Last ${WINDOW_LABEL[state.window]} uptime`, PAD_X, 62);

  const updated = state.aggregate?.generated_at
    ? new Date(state.aggregate.generated_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
  const count = agg.stats?.incident_count ?? 0;
  drawCardBadges(ctx, [
    ["LAST UPDATED", updated],
    [`LAST ${WINDOW_LABEL[state.window].toUpperCase()}`, `${count} incident${count === 1 ? "" : "s"}`],
  ], W, PAD_X);

  ctx.fillStyle = p.fg;
  ctx.font = `700 28px ${PANEL_FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("Claude Platform", PAD_X, 140);

  ctx.fillStyle = p.muted;
  ctx.font = `600 23px ${PANEL_FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(`${fmtPct(uptimeFromImpactSeconds(agg))}% uptime`, W - PAD_X, 140);

  const { barsTop, barsHeight } = drawCardBars(ctx, aggRow.days, PAD_X, W);

  ctx.fillStyle = p.muted;
  ctx.font = `600 13px ${PANEL_FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("90 DAYS AGO", PAD_X, barsTop + barsHeight + 20);
  ctx.textAlign = "right";
  ctx.fillText("TODAY", W - PAD_X, barsTop + barsHeight + 20);

  drawCardFooter(ctx, W, PAD_X);

  return canvas;
}

async function copyHeroPanel() {
  const btn = document.getElementById("hero-panel-copy");
  const label = document.getElementById("hero-panel-copy-label");
  const canvas = renderPanelToCanvas();
  if (!canvas) return;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  if (!blob) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    label.textContent = "Copied!";
  } catch {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "claude-statuses.png";
    a.click();
    URL.revokeObjectURL(url);
    label.textContent = "Downloaded";
  }
  btn.classList.add("is-copied");
  setTimeout(() => {
    label.textContent = "Copy card";
    btn.classList.remove("is-copied");
  }, 2000);
}

function pageHistory(delta) {
  const total = (state.history?.months || []).length;
  const maxPage = Math.max(0, Math.ceil(total / 3) - 1);
  state.historyPage = Math.max(0, Math.min(maxPage, state.historyPage + delta));
  renderHistory();
}

async function init() {
  document.getElementById("filter-component").addEventListener("change", renderIncidents);
  document.getElementById("filter-impact").addEventListener("change", renderIncidents);
  document.getElementById("hero-panel-copy").addEventListener("click", copyHeroPanel);
  document.getElementById("history-prev").addEventListener("click", () => pageHistory(1));
  document.getElementById("history-next").addEventListener("click", () => pageHistory(-1));
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "ArrowLeft") pageHistory(1);
    else if (e.key === "ArrowRight") pageHistory(-1);
  });

  document.getElementById("incidents-toggle").addEventListener("click", () => {
    const list = document.getElementById("incidents");
    const toggle = document.getElementById("incidents-toggle");
    const isExpanded = list.classList.toggle("is-expanded");
    toggle.textContent = isExpanded ? "Show Less" : "Show More";
    if (!isExpanded) {
      document
        .querySelector(".incidents-section h2")
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  });

  try {
    const [aggregate, daily, components, incidents, history] = await Promise.all([
      loadJson("./data/derived/aggregate.json"),
      loadJson("./data/derived/daily-90d.json"),
      loadJson("./data/components.json"),
      loadJson("./data/derived/incidents-index.json"),
      loadJson("./data/derived/aggregate-history.json").catch(() => null),
    ]);
    state.aggregate = aggregate;
    state.daily = daily;
    state.components = components;
    state.incidents = incidents;
    state.history = history;
    state.incidentById = new Map(
      (incidents.incidents || []).map((i) => [i.id, i]),
    );

    renderChart(daily);
    populateComponentFilter(components);
    renderIncidents();
    if (state.history) renderHistory();
    renderActiveWindow();

    document.getElementById("generated-at").textContent =
      `Last updated ${new Date(aggregate.generated_at).toLocaleString()}.`;
  } catch (e) {
    console.error(e);
    document.getElementById("hero-panel-title").textContent = "Data not yet available";
    document.getElementById("hero-panel-pct").textContent =
      "Run `node scripts/backfill.mjs && node scripts/derive.mjs` to seed.";
  }
}

init();
