import { useState, useEffect, useRef } from "react";
import {
  BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell, ReferenceLine, LabelList,
} from "recharts";

// === DESIGN SYSTEM ===
const C = {
  bg: "#0B1120", card: "#131C31", cardAlt: "#0F1829", border: "#1B2A45",
  accent: "#00D4AA", gold: "#F0B942", blue: "#3B82F6", coral: "#EF6461",
  purple: "#A78BFA", orange: "#F97316", teal: "#14B8A6",
  white: "#EEF2F7", light: "#B8C7DC", muted: "#6B7F99",
  navy: "#0E1A30",
};

// === ATECO SECTOR NAMES (complete map — fallback to code if unknown) ===
const ATECO_NAMES = {
  10: "Food Mfg",       25: "Metal Products",   41: "Construction",
  43: "Spec. Constr.",  45: "Auto Trade",        46: "Wholesale",
  47: "Retail",         56: "Food & Bev.",       62: "IT & Software",
  68: "Real Estate",    71: "Tech Consulting",   77: "Rental Svcs",
  82: "Admin Services",
};

// === STATIC DEFINITIONS ===
const BUCKET_RANGES = [
  { range: "<-50%",    lo: -Infinity, hi: -50,      c: C.coral },
  { range: "-50:-25%", lo: -50,       hi: -25,      c: "#FF9F7F" },
  { range: "-25:-10%", lo: -25,       hi: -10,      c: "#FFCC80" },
  { range: "-10:0%",   lo: -10,       hi: 0,        c: C.gold },
  { range: "0:10%",    lo: 0,         hi: 10,       c: "#A5D6A7" },
  { range: "10:25%",   lo: 10,        hi: 25,       c: "#66BB6A" },
  { range: "25:50%",   lo: 25,        hi: 50,       c: C.blue },
  { range: "50:100%",  lo: 50,        hi: 100,      c: "#42A5F5" },
  { range: "100:500%", lo: 100,       hi: 500,      c: C.purple },
  { range: ">500%",    lo: 500,       hi: Infinity, c: "#7E57C2" },
];

const SIZE_TIERS = [
  { name: "<€100M",     lo: 0,    hi: 1e8 },
  { name: "€100M–500M", lo: 1e8,  hi: 5e8 },
  { name: "€500M–2B",   lo: 5e8,  hi: 2e9 },
  { name: "€2B–10B",    lo: 2e9,  hi: 1e10 },
  { name: ">€10B",      lo: 1e10, hi: Infinity },
];

const TIER_COLORS = [C.blue, C.teal, C.accent, C.gold, C.coral];

// ===  CSV PARSING ===
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(",");
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] ?? "").trim(); });
    return row;
  });
}

// === STATS HELPERS ===
function sortedCopy(arr) { return [...arr].sort((a, b) => a - b); }
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function medianOf(arr) { return arr.length ? pct(sortedCopy(arr), 50) : 0; }
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function fmtM(euros) {
  const m = euros / 1e6;
  return m >= 1000 ? `€${(m / 1000).toFixed(1)}B` : `€${Math.round(m)}M`;
}

// === SECTOR FILL: opacity-scaled color by performance magnitude ===
function sectorFill(val) {
  const intensity = Math.min(Math.abs(val) / 50, 1);
  return val > 0
    ? `rgba(0,212,170,${0.35 + intensity * 0.65})`
    : `rgba(239,100,97,${0.35 + intensity * 0.65})`;
}

// === REGIONAL MAP DATA ===
function computeRegionMapData(rows) {
  const filtered = rows.filter(r => r.fiscal_year >= 2018 && r.fiscal_year <= 2020);
  const byRegion = {};
  for (const r of filtered) {
    if (!r.region) continue;
    if (!byRegion[r.region]) byRegion[r.region] = [];
    byRegion[r.region].push(r);
  }
  const result = {};
  for (const [region, rr] of Object.entries(byRegion)) {
    const uniqueCo   = new Set(rr.map(r => r.company_id)).size;
    const growthVals = rr.map(r => r.revenue_change).filter(v => v !== null && isFinite(v));
    const yrsVals    = rr.map(r => r.years_in_business).filter(v => v > 0 && isFinite(v));
    const sectorCnt  = {};
    for (const r of rr) if (r.ateco_sector) sectorCnt[r.ateco_sector] = (sectorCnt[r.ateco_sector] || 0) + 1;
    const topCode    = Object.entries(sectorCnt).sort((a, b) => b[1] - a[1])[0]?.[0];
    result[region] = {
      companies:     uniqueCo,
      median_growth: round2(medianOf(growthVals)),
      gt100_count:   growthVals.filter(v => v > 100).length,
      neg50_count:   growthVals.filter(v => v < -50).length,
      avg_years:     yrsVals.length ? round2(yrsVals.reduce((a, b) => a + b, 0) / yrsVals.length) : 0,
      top_sector:    topCode ? `ATECO ${String(topCode).padStart(2, "0")}` : "N/A",
      total_revenue: rr.reduce((s, r) => s + r.production_value, 0),
    };
  }
  return result;
}

// === COVID SECTOR IMPACT (uses raw revenue_change column) ===
// revenue_change on a fiscal_year=Y row = change from Y-1 to Y
function computeCovidSectorImpact(rows, topSectorCodes) {
  const transitions = [
    { key: "2018→19", year: 2019 },
    { key: "2019→20", year: 2020 },
    { key: "2020→21", year: 2021 },
  ];
  return topSectorCodes.slice(0, 8).map(code => {
    const entry = { sector: ATECO_NAMES[code] || `Code ${code}` };
    for (const { key, year } of transitions) {
      const vals = rows
        .filter(r =>
          r.ateco_sector === code &&
          r.fiscal_year  === year &&
          r.revenue_change !== null &&
          isFinite(r.revenue_change)
        )
        .map(r => r.revenue_change);
      entry[key] = vals.length ? round1(medianOf(vals)) : null;
    }
    return entry;
  }).sort((a, b) => (a["2019→20"] ?? 0) - (b["2019→20"] ?? 0)); // sorted: worst COVID shock at top
}

// === REVENUE SIGNALS (pooled 2018–2020) ===
function computeRevenueSignals(rows, byCompany) {
  // Assign year-specific decile tiers (Q1-Q10) by production_value rank within each year
  const tierByKey = {}; // `${company_id}_${fiscal_year}` → tier 1-10
  for (const yr of [2018, 2019, 2020, 2021]) {
    const yrRows = rows.filter(r => r.fiscal_year === yr && r.production_value > 0);
    const sorted = [...yrRows].sort((a, b) => a.production_value - b.production_value);
    const n = sorted.length;
    sorted.forEach((r, i) => {
      tierByKey[`${r.company_id}_${yr}`] = Math.min(10, Math.floor(i / n * 10) + 1);
    });
  }

  // Build enriched rows with tier, tier_next, target, equity gap
  const enriched = [];
  for (const [compId, yearMap] of Object.entries(byCompany)) {
    for (const yr of [2018, 2019, 2020]) {
      const base = yearMap[yr];
      if (!base) continue;
      const next = yearMap[yr + 1];
      if (!next || next.revenue_change === null || !isFinite(next.revenue_change)) continue;
      const target    = next.revenue_change;
      const tier_t    = tierByKey[`${compId}_${yr}`];
      const tier_next = tierByKey[`${compId}_${yr + 1}`];
      const prevRow   = yearMap[yr - 1];
      let equityGap   = null;
      if (prevRow && base.total_assets > 0 && isFinite(base.shareholders_equity) &&
          isFinite(prevRow.shareholders_equity) && isFinite(base.net_profit_loss)) {
        equityGap = (base.shareholders_equity - prevRow.shareholders_equity - base.net_profit_loss) / base.total_assets;
      }
      enriched.push({ compId, yr, target, tier_t, tier_next, equityGap, revenue_change_t: base.revenue_change });
    }
  }

  // 1. Revenue Tier → Target
  const tierTarget = Array.from({ length: 10 }, (_, i) => {
    const t = i + 1, tr = enriched.filter(r => r.tier_t === t);
    return { tier: `Q${t}`, medTarget: round1(medianOf(tr.map(r => r.target))), n: tr.length };
  });

  // 2. Tier Shift → Target
  const shiftBuckets = [
    { label: "≤−2", check: s => s <= -2 },
    { label: "−1",  check: s => s === -1 },
    { label: "0",   check: s => s === 0  },
    { label: "+1",  check: s => s === 1  },
    { label: "≥+2", check: s => s >= 2  },
  ];
  const tierShift = shiftBuckets.map(b => {
    const sr = enriched.filter(r => r.tier_t != null && r.tier_next != null && b.check(r.tier_next - r.tier_t));
    return { shift: b.label, medTarget: round1(medianOf(sr.map(r => r.target))), n: sr.length };
  });

  // 3. Tier Persistence Stay Rate
  const tierPersistence = Array.from({ length: 10 }, (_, i) => {
    const t = i + 1, tr = enriched.filter(r => r.tier_t === t && r.tier_next != null);
    if (!tr.length) return { tier: `Q${t}`, stay: 0, up: 0, down: 0, n: 0 };
    const stay = round1(tr.filter(r => r.tier_next === t).length / tr.length * 100);
    const up   = round1(tr.filter(r => r.tier_next > t).length  / tr.length * 100);
    const down = round1(tr.filter(r => r.tier_next < t).length  / tr.length * 100);
    return { tier: `Q${t}`, stay, up, down, n: tr.length };
  });

  // 4. Extreme Event Probability by Tier
  const extremeEvents = Array.from({ length: 10 }, (_, i) => {
    const t = i + 1, tr = enriched.filter(r => r.tier_t === t);
    if (!tr.length) return { tier: `Q${t}`, pct100: 0, pct200: 0, pctNeg50: 0, n: 0 };
    const pct100   = round1(tr.filter(r => r.target > 100).length  / tr.length * 100);
    const pct200   = round1(tr.filter(r => r.target > 200).length  / tr.length * 100);
    const pctNeg50 = round1(tr.filter(r => r.target < -50).length  / tr.length * 100);
    return { tier: `Q${t}`, pct100, pct200, pctNeg50, n: tr.length };
  });

  // 5. Growth Momentum Mean Reversion
  const momentumBuckets = [
    { label: "≤−50%",          check: rc => rc <= -50 },
    { label: "−50% to +100%",  check: rc => rc > -50 && rc <= 100 },
    { label: "+100 to +200%",  check: rc => rc > 100 && rc <= 200 },
    { label: ">+200%",         check: rc => rc > 200 },
  ];
  const growthMomentum = momentumBuckets.map(b => {
    const mr = enriched.filter(r => r.revenue_change_t !== null && isFinite(r.revenue_change_t) && b.check(r.revenue_change_t));
    return { bucket: b.label, medTarget: round1(medianOf(mr.map(r => r.target))), n: mr.length };
  });

  // 6. Equity Gap Capital Flow Signal
  const egRows = enriched.filter(r => r.equityGap !== null && isFinite(r.equityGap));
  const egBuckets = [
    { label: "Withdrawal (≤−4%)", check: g => g <= -0.04 },
    { label: "Neutral",           check: g => g > -0.04 && g < 0.04 },
    { label: "Injection (≥+4%)", check: g => g >= 0.04 },
  ];
  const equityGap = egBuckets.map(b => {
    const gr = egRows.filter(r => b.check(r.equityGap));
    return { group: b.label, medTarget: round1(medianOf(gr.map(r => r.target))), n: gr.length };
  });

  return { tierTarget, tierShift, tierPersistence, extremeEvents, growthMomentum, equityGap };
}

// === MAIN DATA PROCESSING ===
function processData(rawRows) {
  // Parse all numeric fields up front
  const rows = rawRows.map(r => ({
    company_id:       r.company_id,
    fiscal_year:      parseInt(r.fiscal_year),
    region:           r.region,
    ateco_sector:     parseInt(r.ateco_sector),
    legal_form:       r.legal_form,
    production_value:    parseFloat(r.production_value)    || 0,
    total_assets:        parseFloat(r.total_assets)        || 0,
    years_in_business:   parseFloat(r.years_in_business)   || 0,
    shareholders_equity: parseFloat(r.shareholders_equity) || 0,
    net_profit_loss:     parseFloat(r.net_profit_loss)     || 0,
    profit_margin:       parseFloat(r.profit_margin)       || 0,
    roi:                 parseFloat(r.roi)                 || 0,
    debt_to_assets:      parseFloat(r.debt_to_assets)      || 0,
    current_ratio:       parseFloat(r.current_ratio)       || 0,
    revenue_change:      r.revenue_change === "" ? null : parseFloat(r.revenue_change),
  }));

  // ── Derive all metadata dynamically from the data ──────────────────────────
  const sectorCounts    = {};
  const regionCounts    = {};
  const legalFormCounts = {};
  for (const r of rows) {
    if (r.ateco_sector) sectorCounts[r.ateco_sector]  = (sectorCounts[r.ateco_sector]  || 0) + 1;
    if (r.region)       regionCounts[r.region]        = (regionCounts[r.region]        || 0) + 1;
    if (r.legal_form)   legalFormCounts[r.legal_form] = (legalFormCounts[r.legal_form] || 0) + 1;
  }
  const dynSectorCodes = Object.entries(sectorCounts)
    .sort((a, b) => b[1] - a[1]).map(([c]) => parseInt(c));
  const dynRegions = Object.entries(regionCounts)
    .sort((a, b) => b[1] - a[1]).map(([r]) => r);
  const dynLegalForms = Object.entries(legalFormCounts)
    .sort((a, b) => b[1] - a[1]).map(([f]) => f);
  // ──────────────────────────────────────────────────────────────────────────

  // Group by company to attach next-year target
  const byCompany = {};
  for (const r of rows) {
    if (!byCompany[r.company_id]) byCompany[r.company_id] = {};
    byCompany[r.company_id][r.fiscal_year] = r;
  }
  const yearRows = { 2018: [], 2019: [], 2020: [] };
  for (const yearMap of Object.values(byCompany)) {
    for (const yr of [2018, 2019, 2020]) {
      const base = yearMap[yr];
      if (!base) continue;
      const next   = yearMap[yr + 1];
      const target = (next && next.revenue_change !== null && isFinite(next.revenue_change))
        ? next.revenue_change : null;
      yearRows[yr].push({ ...base, target });
    }
  }

  const yearsData = {};
  for (const yr of [2018, 2019, 2020]) {
    yearsData[yr] = computeYearStats(yr, yearRows[yr], dynSectorCodes, dynRegions, dynLegalForms);
  }

  const uniqueCompanies = new Set(rows.map(r => r.company_id)).size;
  const totalRows       = rows.filter(r => [2018, 2019, 2020].includes(r.fiscal_year)).length;

  const crossYear = [2018, 2019, 2020].map(yr => {
    const d = yearsData[yr];
    return { year: `${yr}→${yr + 1}`, median: d.target.median, q25: d.target.q25, q75: d.target.q75, iqr: d.target.iqr, std: d.target.std, companies: d.withTarget };
  });
  const crossMetrics = [2018, 2019, 2020].map(yr => {
    const d = yearsData[yr];
    return { year: String(yr), rev: d.medianRev, assets: d.medianAssets, margin: d.medianMargin, roi: d.medianROI, debt: d.medianDebt };
  });

  const covidSectorImpact = computeCovidSectorImpact(rows, dynSectorCodes);
  const signalData        = computeRevenueSignals(rows, byCompany);
  const regionMapData     = computeRegionMapData(rows);

  return { yearsData, crossYear, crossMetrics, uniqueCompanies, totalRows, covidSectorImpact, signalData, regionMapData };
}

// === PER-YEAR STATS (fully dynamic) ===
function computeYearStats(yr, rows, sectorCodes, regions, legalForms) {
  const withTargetRows = rows.filter(r => r.target !== null && isFinite(r.target));
  const targets        = withTargetRows.map(r => r.target);
  const sortedTargets  = sortedCopy(targets);

  const tMean   = targets.length ? round1(targets.reduce((a, b) => a + b, 0) / targets.length) : 0;
  const tMedian = round1(pct(sortedTargets, 50));
  const tQ25    = round1(pct(sortedTargets, 25));
  const tQ75    = round1(pct(sortedTargets, 75));
  const tIQR    = round1(tQ75 - tQ25);
  const tStd    = round1(Math.sqrt(
    targets.length ? targets.reduce((s, t) => s + (t - tMean) ** 2, 0) / targets.length : 0
  ));

  const quantiles = [1, 5, 10, 25, 50, 75, 90, 95, 99].map(q => ({
    q: `Q${q}`, val: round1(pct(sortedTargets, q)),
  }));
  const distBuckets = BUCKET_RANGES.map(b => ({
    range: b.range,
    count: targets.filter(t => t >= b.lo && t < b.hi).length,
    c: b.c,
  }));

  // Financial medians (fractions × 100 = %)
  const prodVals   = rows.map(r => r.production_value).filter(v => v > 0);
  const assetVals  = rows.map(r => r.total_assets).filter(v => v > 0);
  const marginVals = rows.map(r => r.profit_margin).filter(v => isFinite(v));
  const roiVals    = rows.map(r => r.roi).filter(v => isFinite(v));
  const debtVals   = rows.map(r => r.debt_to_assets).filter(v => isFinite(v));
  const crVals     = rows.map(r => r.current_ratio).filter(v => v > 0 && isFinite(v));

  const medianRev    = Math.round(medianOf(prodVals) / 1e6);
  const medianAssets = Math.round(medianOf(assetVals) / 1e6);
  const medianMargin = round2(medianOf(marginVals) * 100);
  const medianROI    = round2(medianOf(roiVals) * 100);
  const medianDebt   = round2(medianOf(debtVals) * 100);
  const medianCR     = round2(medianOf(crVals));

  // Production value quantiles (displayed in €M)
  const sortedProd  = sortedCopy(prodVals);
  const prodQuantiles = [10, 25, 50, 75, 90, 95, 99].map(q => ({
    q: `P${q}`, val: Math.round(pct(sortedProd, q) / 1e6),
  }));
  const prodMean = prodVals.length
    ? Math.round(prodVals.reduce((a, b) => a + b, 0) / prodVals.length / 1e6)
    : 0;

  // Size segmentation (median target by revenue tier)
  const sizeSeg = SIZE_TIERS.map(t => {
    const tr = withTargetRows.filter(r => r.production_value >= t.lo && r.production_value < t.hi);
    return { name: t.name, n: tr.length, medTarget: round1(medianOf(tr.map(r => r.target))) };
  });

  // Size distribution (company count per tier — all rows)
  const sizeDist = SIZE_TIERS.map(t => ({
    name:  t.name,
    count: rows.filter(r => r.production_value >= t.lo && r.production_value < t.hi).length,
  }));

  // Top 8 sectors — derived dynamically, sorted ascending for horizontal bar
  const sectors = sectorCodes.slice(0, 8).map(code => {
    const sr = withTargetRows.filter(r => r.ateco_sector === code);
    return {
      name:      ATECO_NAMES[code] || `Code ${code}`,
      n:         sr.length,
      medTarget: round1(medianOf(sr.map(r => r.target))),
    };
  }).filter(s => s.n > 0).sort((a, b) => a.medTarget - b.medTarget);

  // Top 8 regions — derived dynamically
  const regionAbbr = { "Emilia-Romagna": "Emilia-Rom.", "Friuli-Venezia Giulia": "Friuli-V.G." };
  const regionStats = regions.slice(0, 8).map(reg => {
    const rr = withTargetRows.filter(r => r.region === reg);
    return {
      name:      regionAbbr[reg] || reg,
      n:         rr.length,
      medTarget: round1(medianOf(rr.map(r => r.target))),
    };
  }).filter(r => r.n > 0);

  // Legal forms — derived dynamically, sorted by count
  const legal = legalForms.map(lf => {
    const lr   = rows.filter(r => r.legal_form === lf);
    const lrwt = withTargetRows.filter(r => r.legal_form === lf);
    const pv   = lr.map(r => r.production_value).filter(v => v > 0);
    return {
      name:      lf,
      n:         lr.length,
      medRev:    Math.round(medianOf(pv) / 1e6),
      medTarget: round1(medianOf(lrwt.map(r => r.target))),
    };
  }).filter(l => l.n > 0);

  return {
    label: `${yr} → ${yr + 1}`, predicting: `${yr + 1} Revenue Change`,
    rows: rows.length, withTarget: withTargetRows.length,
    medianRev, medianAssets, medianMargin, medianROI, medianDebt, medianCR,
    target: { mean: tMean, median: tMedian, std: tStd, iqr: tIQR, q25: tQ25, q75: tQ75 },
    quantiles, distBuckets, sizeSeg, sizeDist, prodQuantiles, prodMean,
    sectors, regions: regionStats, legal,
  };
}

// === SHARED COMPONENTS ===
const Tip = ({ active, payload, label, sfx = "" }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 13px", boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}>
      <p style={{ color: C.light, fontSize: 10, margin: "0 0 5px", textTransform: "uppercase", letterSpacing: 1 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || C.accent, fontSize: 12, margin: "2px 0", fontWeight: 600 }}>
          {p.name}: {typeof p.value === "number" ? p.value.toLocaleString() : p.value}{sfx}
        </p>
      ))}
    </div>
  );
};

const KPI = ({ label, value, sub, color = C.accent }) => (
  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderTop: `3px solid ${color}`, borderRadius: 8, padding: "14px 16px", flex: 1, minWidth: 135 }}>
    <p style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", margin: 0 }}>{label}</p>
    <p style={{ color: C.white, fontSize: 26, fontWeight: 700, margin: "5px 0 2px", fontFamily: "'Playfair Display', Georgia, serif" }}>{value}</p>
    {sub && <p style={{ color: C.muted, fontSize: 10.5, margin: 0 }}>{sub}</p>}
  </div>
);

const Heading = ({ children, sub, insight }) => (
  <div style={{ margin: "28px 0 14px" }}>
    <h3 style={{ color: C.white, fontSize: 17, fontWeight: 700, margin: 0, fontFamily: "'Playfair Display', Georgia, serif" }}>{children}</h3>
    {sub && <p style={{ color: C.muted, fontSize: 11, margin: "3px 0 0" }}>{sub}</p>}
    {insight && (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, background: `${C.accent}12`, border: `1px solid ${C.accent}30`, borderRadius: 6, padding: "5px 10px" }}>
        <span style={{ color: C.accent, fontSize: 11 }}>→</span>
        <span style={{ color: C.accent, fontSize: 11, fontWeight: 500 }}>{insight}</span>
      </div>
    )}
  </div>
);

const Tab = ({ active, children, onClick, color }) => (
  <button onClick={onClick} style={{
    background: active ? (color || C.accent) : "transparent",
    color: active ? C.bg : C.muted,
    border: active ? "none" : `1px solid ${C.border}`,
    borderRadius: 6, padding: "8px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif", letterSpacing: 0.3, transition: "all 0.15s",
  }}>{children}</button>
);

const Card = ({ children, style = {} }) => (
  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 18px", ...style }}>{children}</div>
);

// === YEAR SECTION ===
function YearSection({ yr, yearsData }) {
  const d = yearsData[yr];

  return (
    <>
      {/* Year Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h2 style={{ color: C.white, fontSize: 24, fontWeight: 700, margin: 0, fontFamily: "'Playfair Display', Georgia, serif" }}>
          Fiscal Year {yr}
        </h2>
        <span style={{ color: C.accent, fontSize: 14, fontWeight: 600 }}>Predicting {d.predicting}</span>
      </div>

      {/* KPIs */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <KPI label="Companies w/ Target" value={d.withTarget.toLocaleString()} sub={`of ${d.rows.toLocaleString()} total rows`} color={C.accent} />
        <KPI label="Median Target" value={`${d.target.median > 0 ? "+" : ""}${d.target.median}%`} sub="Next-year revenue change" color={d.target.median > 0 ? C.accent : C.coral} />
        <KPI label="Median Revenue" value={`€${d.medianRev}M`} sub="Production value" color={C.gold} />
        <KPI label="Median Profit Margin" value={`${d.medianMargin}%`} sub="Net profit / revenue" color={C.blue} />
        <KPI label="Median ROI" value={`${d.medianROI}%`} sub="Operating income / assets" color={C.purple} />
      </div>

      {/* ── SECTION 1: Target Quantile Table + Distribution ── */}
      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 14 }}>
        <div>
          <Heading sub="Target variable percentile breakdown">Quantile Analysis — Revenue Change</Heading>
          <Card>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                  <th style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: "left", padding: "7px 8px" }}>Percentile</th>
                  <th style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: "right", padding: "7px 8px" }}>Revenue Change Next</th>
                </tr>
              </thead>
              <tbody>
                {d.quantiles.map((q, i) => {
                  const isMedian = q.q === "Q50";
                  const clr = q.val > 0 ? C.accent : q.val < -50 ? C.coral : C.gold;
                  return (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: isMedian ? `${C.accent}10` : "transparent" }}>
                      <td style={{ padding: "7px 8px", color: isMedian ? C.accent : C.light, fontSize: 12, fontWeight: isMedian ? 700 : 400 }}>
                        {q.q}{isMedian ? " (Median)" : ""}
                      </td>
                      <td style={{ padding: "7px 8px", textAlign: "right", color: clr, fontSize: 13, fontWeight: 600 }}>
                        {q.val > 0 ? "+" : ""}{q.val.toLocaleString()}%
                      </td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: `2px solid ${C.border}` }}>
                  <td style={{ padding: "7px 8px", color: C.muted, fontSize: 11 }}>IQR (Q75–Q25)</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: C.orange, fontSize: 13, fontWeight: 600 }}>{d.target.iqr.toFixed(1)}pp</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>

        <div>
          <Heading sub="How many companies fall into each revenue change bucket?" insight="Heavy tails on both sides — standard regression will underperform on extremes">Target Distribution</Heading>
          <Card>
            <ResponsiveContainer width="100%" height={245}>
              <BarChart data={d.distBuckets} barCategoryGap="10%">
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                <XAxis dataKey="range" tick={{ fill: C.muted, fontSize: 9 }} axisLine={{ stroke: C.border }} interval={0} angle={-30} textAnchor="end" height={48} />
                <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} />
                <Tooltip content={<Tip />} />
                <Bar dataKey="count" name="Companies" radius={[3, 3, 0, 0]}>
                  {d.distBuckets.map((b, i) => <Cell key={i} fill={b.c} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
      </div>

      {/* ── SECTION 2: Company Size Analysis ── */}
      <Heading
        sub={`Production value quantiles across ${d.rows.toLocaleString()} companies — proxy for company revenue`}
        insight="Strong right-skew: the mean is pulled far above the median by a handful of mega-corporations"
      >
        Company Size Analysis — Production Value Distribution
      </Heading>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>

        {/* Quantile table */}
        <Card>
          <p style={{ color: C.muted, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", margin: "0 0 10px", fontWeight: 600 }}>
            Production Value Quantiles
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                <th style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: "left", padding: "6px 8px" }}>Percentile</th>
                <th style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: "right", padding: "6px 8px" }}>Production Value</th>
                <th style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: "right", padding: "6px 8px" }}>Size Tier</th>
              </tr>
            </thead>
            <tbody>
              {d.prodQuantiles.map((pq, i) => {
                const isMedian = pq.q === "P50";
                const tierIdx  = SIZE_TIERS.findIndex(t => pq.val * 1e6 >= t.lo && pq.val * 1e6 < t.hi);
                const tier     = SIZE_TIERS[tierIdx] || SIZE_TIERS[SIZE_TIERS.length - 1];
                const color    = TIER_COLORS[Math.max(0, tierIdx)];
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: isMedian ? `${C.gold}10` : "transparent" }}>
                    <td style={{ padding: "7px 8px", color: isMedian ? C.gold : C.light, fontSize: 12, fontWeight: isMedian ? 700 : 400 }}>
                      {pq.q}{isMedian ? " (Median)" : ""}
                    </td>
                    <td style={{ padding: "7px 8px", textAlign: "right", color, fontSize: 13, fontWeight: 600 }}>
                      {fmtM(pq.val * 1e6)}
                    </td>
                    <td style={{ padding: "7px 8px", textAlign: "right" }}>
                      <span style={{ background: `${color}20`, border: `1px solid ${color}50`, color, borderRadius: 4, padding: "2px 7px", fontSize: 9, fontWeight: 700 }}>
                        {tier.name}
                      </span>
                    </td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: `2px solid ${C.border}` }}>
                <td style={{ padding: "7px 8px", color: C.muted, fontSize: 11 }}>Mean (right-skewed)</td>
                <td colSpan={2} style={{ padding: "7px 8px", textAlign: "right", color: C.orange, fontSize: 13, fontWeight: 600 }}>
                  €{d.prodMean.toLocaleString()}M
                </td>
              </tr>
            </tbody>
          </table>
        </Card>

        {/* Size count distribution bar chart */}
        <Card>
          <p style={{ color: C.muted, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", margin: "0 0 10px", fontWeight: 600 }}>
            Company Count by Revenue Tier
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={d.sizeDist} barCategoryGap="18%">
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
              <XAxis dataKey="name" tick={{ fill: C.light, fontSize: 10 }} axisLine={{ stroke: C.border }} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} />
              <Tooltip content={<Tip />} />
              <Bar dataKey="count" name="Companies" radius={[4, 4, 0, 0]}>
                <LabelList dataKey="count" position="top" style={{ fill: C.light, fontSize: 10, fontWeight: 600 }} />
                {d.sizeDist.map((_, i) => <Cell key={i} fill={TIER_COLORS[i]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Production value quantile bar chart (visual) */}
      <Card style={{ marginTop: 14 }}>
        <p style={{ color: C.muted, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", margin: "0 0 10px", fontWeight: 600 }}>
          Production Value by Percentile — right-skew clearly visible from P75 onward
        </p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={d.prodQuantiles} barCategoryGap="14%">
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="q" tick={{ fill: C.light, fontSize: 11 }} axisLine={{ stroke: C.border }} />
            <YAxis
              tick={{ fill: C.muted, fontSize: 10 }}
              axisLine={{ stroke: C.border }}
              tickFormatter={v => v >= 1000 ? `€${(v / 1000).toFixed(0)}B` : `€${v}M`}
            />
            <Tooltip
              formatter={v => [fmtM(v * 1e6), "Production Value"]}
              contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
              labelStyle={{ color: C.white }}
            />
            <ReferenceLine
              y={d.prodQuantiles.find(p => p.q === "P50")?.val}
              stroke={C.gold}
              strokeDasharray="4 2"
              strokeWidth={1.5}
              label={{ value: "Median", fill: C.gold, fontSize: 9, position: "insideTopRight" }}
            />
            <Bar dataKey="val" name="Production Value" radius={[4, 4, 0, 0]}>
              {d.prodQuantiles.map((_, i) => (
                <Cell key={i} fill={[C.blue, C.teal, C.accent, C.gold, C.orange, C.coral, C.purple][i]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* ── SECTION 3: Revenue Size → Target ── */}
      <Heading sub="Median next-year revenue change by company revenue size tier" insight="Smaller companies show explosive growth, larger companies trend negative — size is the #1 structural driver">Revenue Size Effect on Target</Heading>
      <Card>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={d.sizeSeg} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="name" tick={{ fill: C.light, fontSize: 11 }} axisLine={{ stroke: C.border }} />
            <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} label={{ value: "Median Target %", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 10, dx: -8 }} />
            <ReferenceLine y={0} stroke={C.muted} strokeWidth={2} />
            <Tooltip content={<Tip sfx="%" />} />
            <Bar dataKey="medTarget" name="Median Target %" radius={[4, 4, 0, 0]}>
              <LabelList dataKey="medTarget" position="top" formatter={v => `${v > 0 ? "+" : ""}${v}%`} style={{ fill: C.light, fontSize: 10, fontWeight: 700 }} />
              {d.sizeSeg.map((s, i) => <Cell key={i} fill={s.medTarget > 0 ? C.accent : C.coral} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div style={{ display: "flex", justifyContent: "center", gap: 20, marginTop: 6, flexWrap: "wrap" }}>
          {d.sizeSeg.map((s, i) => (
            <span key={i} style={{ fontSize: 10, color: C.muted }}>{s.name}: <b style={{ color: C.light }}>{s.n}</b> co.</span>
          ))}
        </div>
      </Card>

      {/* ── SECTION 4: Sector (Enhanced ComposedChart) + Region ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <Heading
            sub="Median next-year revenue change by sector — sorted by performance, ghost bar shows relative company count"
            insight="Sector spread exceeds 50pp between best and worst performers — a strong predictive signal"
          >
            Sector Performance
          </Heading>
          <Card>
            <ResponsiveContainer width="100%" height={310}>
              <ComposedChart
                data={d.sectors}
                layout="vertical"
                barCategoryGap="14%"
                margin={{ left: 6, right: 55, top: 4, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                <XAxis type="number" tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} tickFormatter={v => `${v}%`} />
                <YAxis dataKey="name" type="category" tick={{ fill: C.light, fontSize: 10 }} axisLine={{ stroke: C.border }} width={104} />
                <Tooltip content={<Tip sfx="%" />} />
                <ReferenceLine x={0} stroke={C.muted} strokeWidth={2} />
                {/* Ghost bar: relative company count — low opacity for visual context */}
                <Bar dataKey="n" name="Companies" fill={C.blue} opacity={0.12} radius={[0, 3, 3, 0]} />
                {/* Main bar: median target, opacity-scaled color by magnitude */}
                <Bar dataKey="medTarget" name="Median Target %" radius={[0, 4, 4, 0]}>
                  <LabelList
                    dataKey="medTarget"
                    position="right"
                    formatter={v => `${v > 0 ? "+" : ""}${v}%`}
                    style={{ fill: C.light, fontSize: 10, fontWeight: 700 }}
                  />
                  {d.sectors.map((s, i) => <Cell key={i} fill={sectorFill(s.medTarget)} />)}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
            <p style={{ color: C.muted, fontSize: 9.5, textAlign: "center", margin: "4px 0 0" }}>
              Ghost bars (faint blue) show relative company count — longer ghost = more statistical weight
            </p>
          </Card>
        </div>

        <div>
          <Heading sub="Regional median next-year revenue change" insight="Region alone is a weak predictor — more powerful as a peer-group benchmarking feature">Region → Target</Heading>
          <Card>
            <ResponsiveContainer width="100%" height={310}>
              <BarChart data={d.regions} layout="vertical" barCategoryGap="14%">
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                <XAxis type="number" tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} />
                <YAxis dataKey="name" type="category" tick={{ fill: C.light, fontSize: 10 }} axisLine={{ stroke: C.border }} width={100} />
                <ReferenceLine x={0} stroke={C.muted} strokeWidth={2} />
                <Tooltip content={<Tip sfx="%" />} />
                <Bar dataKey="medTarget" name="Median Target %" radius={[0, 4, 4, 0]}>
                  <LabelList dataKey="medTarget" position="right" formatter={v => `${v > 0 ? "+" : ""}${v}%`} style={{ fill: C.light, fontSize: 10, fontWeight: 600 }} />
                  {d.regions.map((r, i) => <Cell key={i} fill={r.medTarget > 0 ? C.blue : C.coral} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
      </div>

      {/* ── SECTION 5: Legal Form Table ── */}
      <Heading sub="Revenue profile and predicted change by company legal structure" insight="SPA (large corps) trend negative; SRL/SNC (smaller) show growth — mirrors the size effect">Legal Form → Revenue Target</Heading>
      <Card>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${C.border}` }}>
              {["Legal Form", "Companies", "Median Revenue", "Median Target"].map((h, i) => (
                <th key={i} style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: i === 0 ? "left" : "right", padding: "8px 10px" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.legal.map((l, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: "8px 10px", fontWeight: 600, color: C.white, fontSize: 13 }}>{l.name}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: C.light, fontSize: 12 }}>{l.n.toLocaleString()}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: C.gold, fontSize: 12 }}>€{l.medRev.toLocaleString()}M</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: l.medTarget > 0 ? C.accent : C.coral, fontSize: 13, fontWeight: 700 }}>
                  {l.medTarget > 0 ? "+" : ""}{l.medTarget}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// === ITALY REGIONAL MAP TAB ===
const ATECO_CATEGORIES = [
  { start:1,  end:3,  key:"01-03", label:"Agriculture, Forestry, Fishing" },
  { start:5,  end:9,  key:"05-09", label:"Mining and Quarrying" },
  { start:10, end:33, key:"10-33", label:"Manufacturing" },
  { start:35, end:35, key:"35",    label:"Electricity, Gas, Steam" },
  { start:36, end:39, key:"36-39", label:"Water Supply & Waste" },
  { start:41, end:43, key:"41-43", label:"Construction" },
  { start:45, end:47, key:"45-47", label:"Wholesale and Retail Trade" },
  { start:49, end:53, key:"49-53", label:"Transportation and Storage" },
  { start:55, end:56, key:"55-56", label:"Accommodation and Food Service" },
  { start:58, end:63, key:"58-63", label:"Information and Communication" },
  { start:64, end:66, key:"64-66", label:"Financial and Insurance" },
  { start:68, end:68, key:"68",    label:"Real Estate Activities" },
  { start:69, end:75, key:"69-75", label:"Professional & Scientific" },
  { start:77, end:82, key:"77-82", label:"Administrative Services" },
  { start:84, end:84, key:"84",    label:"Public Administration" },
  { start:85, end:85, key:"85",    label:"Education" },
  { start:86, end:88, key:"86-88", label:"Health and Social Work" },
  { start:90, end:93, key:"90-93", label:"Arts, Entertainment, Recreation" },
  { start:94, end:96, key:"94-96", label:"Other Services" },
];

const MAP_ALIASES = {
  "Valle d'Aosta": "Valle d'Aosta",
  "Trentino-Alto Adige/Südtirol": "Trentino-Alto Adige",
  "Provincia Autonoma di Bolzano/Bozen": "Trentino-Alto Adige",
  "Provincia Autonoma di Trento": "Trentino-Alto Adige",
  "Friuli Venezia Giulia": "Friuli-Venezia Giulia",
};

function describeAteco(value) {
  const match = String(value || "").match(/(\d{1,2})/);
  if (!match) return { label: value || "N/A", badge: "" };
  const code = Number(match[1]);
  const cat  = ATECO_CATEGORIES.find(c => code >= c.start && code <= c.end);
  if (!cat) return { label: `ATECO ${String(code).padStart(2, "0")}`, badge: "" };
  return { label: `${cat.key} ${cat.label}`, badge: `ATECO ${String(code).padStart(2, "0")}` };
}

function fmtEuro(v) {
  if (v >= 1e12) return `€${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `€${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6)  return `€${(v / 1e6).toFixed(1)}M`;
  return `€${v.toFixed(0)}`;
}

function ItalyMapTab({ regionMapData }) {
  const svgRef   = useRef(null);
  const ttRef    = useRef(null);
  const frameRef = useRef(null);

  const totalCo   = Object.values(regionMapData).reduce((s, r) => s + r.companies, 0);
  const totalProd = Object.values(regionMapData).reduce((s, r) => s + r.total_revenue, 0);
  const numReg    = Object.keys(regionMapData).filter(k => regionMapData[k].companies > 0).length;

  useEffect(() => {
    // Wait for D3 to be available (loaded via CDN with defer)
    let tries = 0;
    const tryInit = () => {
      if (!window.d3) {
        if (++tries < 40) setTimeout(tryInit, 100);
        return;
      }
      if (!svgRef.current || !ttRef.current || !frameRef.current) return;
      initMap(window.d3);
    };
    tryInit();
  }, [regionMapData]); // eslint-disable-line react-hooks/exhaustive-deps

  function initMap(d3) {
    const svg  = d3.select(svgRef.current);
    const ttEl = ttRef.current;
    svg.selectAll("*").remove();
    const g = svg.append("g");
    const W = 900, H = 900;
    const totalCompanies = totalCo;
    let pinned = null;

    function buildTooltipHtml(d) {
      const m    = d.properties.metrics;
      const sec  = describeAteco(m.top_sector);
      const share = totalCompanies > 0 ? (m.companies / totalCompanies * 100).toFixed(1) : "0.0";
      const perCo = m.companies > 0 ? fmtEuro(m.total_revenue / m.companies) : "—";
      const insight = (() => {
        if (m.companies === 0) return "No companies in this region after filtering.";
        const density = m.companies >= 300 ? "High representation" : m.companies >= 150 ? "Strong representation" : m.companies >= 75 ? "Moderate representation" : "Light representation";
        const sLine   = sec.label === "N/A" ? "" : ` Lead sector: ${sec.label}.`;
        const bal     = m.gt100_count - m.neg50_count >= 25 ? " Upside extremes dominate." : m.neg50_count - m.gt100_count >= 25 ? " Downside stress dominates." : " Upside/downside balanced.";
        return density + "." + sLine + bal;
      })();
      const growthColor = m.median_growth >= 0 ? "#16a34a" : "#dc2626";
      return `
        <div class="map-tt-head">
          <div>
            <h3 class="map-tt-h3">${d.properties.display_name}</h3>
            <div class="map-tt-note">Fiscal years 2018–2020 · revenue_change observations</div>
          </div>
          <div class="map-tt-tag">${m.companies.toLocaleString()} companies</div>
        </div>
        <div class="map-stats">
          <div class="map-stat">
            <div class="map-stat-k">Median Growth</div>
            <div class="map-stat-v" style="color:${growthColor}">${m.median_growth >= 0 ? "+" : ""}${Number(m.median_growth).toFixed(1)}%</div>
          </div>
          <div class="map-stat">
            <div class="map-stat-k">&gt;100% Obs.</div>
            <div class="map-stat-v">${m.gt100_count.toLocaleString()}</div>
          </div>
          <div class="map-stat">
            <div class="map-stat-k">&lt;−50% Obs.</div>
            <div class="map-stat-v">${m.neg50_count.toLocaleString()}</div>
          </div>
          <div class="map-stat">
            <div class="map-stat-k">Avg Yrs in Biz</div>
            <div class="map-stat-v">${Number(m.avg_years).toFixed(1)}</div>
          </div>
          <div class="map-stat">
            <div class="map-stat-k">Dataset Share</div>
            <div class="map-stat-v">${share}%</div>
          </div>
          <div class="map-stat">
            <div class="map-stat-k">Prod. Value / Co.</div>
            <div class="map-stat-v">${perCo}</div>
          </div>
          <div class="map-stat map-stat-wide">
            <div class="map-stat-k">Top Sector</div>
            <div class="map-stat-v">${sec.label}${sec.badge ? ` <span class="map-sector-badge">${sec.badge}</span>` : ""}</div>
          </div>
          <div class="map-stat map-stat-wide">
            <div class="map-stat-k">Total Prod. Value</div>
            <div class="map-stat-v">${fmtEuro(m.total_revenue)}</div>
          </div>
        </div>
        <div class="map-insight"><strong>Quick read:</strong> ${insight}</div>`;
    }

    function showTooltip(event, d) {
      ttEl.innerHTML = buildTooltipHtml(d);
      ttEl.classList.add("map-tt-show");
      moveTooltip(event);
    }
    function moveTooltip(event) {
      const box = frameRef.current.getBoundingClientRect();
      const pad = 12;
      let left = event.clientX - box.left + pad;
      let top  = event.clientY - box.top  + pad;
      if (left + ttEl.offsetWidth  > box.width  - 8) left = event.clientX - box.left - ttEl.offsetWidth  - pad;
      if (left < 8) left = 8;
      if (top  + ttEl.offsetHeight > box.height - 8) top  = box.height - ttEl.offsetHeight - 8;
      if (top  < 8) top  = 8;
      ttEl.style.left = left + "px";
      ttEl.style.top  = top  + "px";
    }
    function hideTooltip()  { ttEl.classList.remove("map-tt-show"); }
    function dimOthers(el)  { d3.selectAll(".map-region").classed("map-region-dimmed", function() { return this !== el; }); }
    function undimAll()     { d3.selectAll(".map-region").classed("map-region-dimmed", false); }

    const geojsonUrl = "https://raw.githubusercontent.com/openpolis/geojson-italy/master/geojson/limits_IT_regions.geojson";
    d3.json(geojsonUrl).then(geo => {
      const features = geo.features.map(f => {
        const raw  = f.properties.reg_name || f.properties.name || f.properties.NAME_1 || "";
        const name = MAP_ALIASES[raw] || raw;
        f.properties.display_name = name;
        f.properties.metrics = regionMapData[name] || { companies: 0, median_growth: 0, gt100_count: 0, neg50_count: 0, avg_years: 0, top_sector: "N/A", total_revenue: 0 };
        return f;
      });

      const projection = d3.geoMercator();
      projection.fitSize([W, H], { type: "FeatureCollection", features });
      const path = d3.geoPath(projection);

      const counts     = features.map(d => d.properties.metrics.companies);
      const colorScale = d3.scaleLinear()
        .domain([d3.min(counts), d3.max(counts)])
        .range(["#1B3560", "#00D4AA"]);

      g.selectAll("path")
        .data(features)
        .join("path")
        .attr("class", "map-region")
        .attr("d", path)
        .attr("fill", d => colorScale(d.properties.metrics.companies))
        .on("mouseenter", function(event, d) {
          if (!pinned) showTooltip(event, d);
          dimOthers(this);
        })
        .on("mousemove", function(event) { if (!pinned) moveTooltip(event); })
        .on("mouseleave", function() { if (!pinned) { hideTooltip(); undimAll(); } })
        .on("click", function(event, d) {
          const name = d.properties.display_name;
          if (pinned === name) {
            pinned = null;
            d3.selectAll(".map-region").classed("map-region-pinned", false);
            hideTooltip(); undimAll();
          } else {
            pinned = name;
            d3.selectAll(".map-region").classed("map-region-pinned", x => x.properties.display_name === name);
            showTooltip(event, d); dimOthers(this);
          }
        });
    }).catch(() => {
      ttEl.innerHTML = "<strong>Map failed to load</strong><br><span style='color:#6b7280'>Check network access to GitHub GeoJSON</span>";
      ttEl.classList.add("map-tt-show");
      ttEl.style.left = "24px"; ttEl.style.top = "24px";
    });
  }

  return (
    <>
      <h2 style={{ color: C.white, fontSize: 24, fontWeight: 700, margin: "0 0 6px", fontFamily: "'Playfair Display', Georgia, serif" }}>
        Italy Regional Company Landscape
      </h2>
      <p style={{ color: C.muted, fontSize: 12, margin: "0 0 16px" }}>
        Fiscal years 2018–2020  •  Colored by unique company count  •  Hover or click a region to explore stats
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        <KPI label="Unique Companies" value={totalCo.toLocaleString()} sub="Across all regions" color={C.accent} />
        <KPI label="Regions Present" value={numReg} sub="Of 20 Italian regions" color={C.blue} />
        <KPI label="Total Prod. Value" value={fmtEuro(totalProd)} sub="Sum 2018–2020" color={C.gold} />
      </div>

      {/* Colour-scale legend */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
        <p style={{ color: C.white, fontSize: 13, fontWeight: 700, margin: "0 0 4px" }}>Regional Density — Unique Companies</p>
        <p style={{ color: C.muted, fontSize: 11, margin: "0 0 10px" }}>Darker blue = more unique companies in the filtered dataset</p>
        <div style={{ height: 12, borderRadius: 999, background: `linear-gradient(90deg, #1B3560, #1B5E80, #0D9488, ${C.accent})`, marginBottom: 6 }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.muted }}>
          <span>Fewer companies</span><span>More companies</span>
        </div>
      </div>

      {/* Map frame */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18 }}>
        <div
          ref={frameRef}
          style={{ position: "relative", borderRadius: 14, overflow: "hidden", background: `radial-gradient(ellipse at 50% 40%, #0F1E3A 0%, ${C.bg} 70%)`, minHeight: 620 }}
        >
          <div ref={ttRef} className="map-tooltip" />
          <svg ref={svgRef} viewBox="0 0 900 900" style={{ width: "100%", height: 620, display: "block" }} aria-label="Italy EDA regional map" />
        </div>
        <p style={{ color: C.muted, fontSize: 9.5, textAlign: "center", margin: "8px 0 0" }}>
          GeoJSON: openpolis/geojson-italy (MIT)  •  Click a region to pin tooltip  •  Source: train_data.csv 2018–2020
        </p>
      </div>
    </>
  );
}

// === MAIN DASHBOARD ===
export default function App() {
  const [appData, setAppData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState("2018");

  useEffect(() => {
    fetch("/train_data.csv")
      .then(r => {
        if (!r.ok) throw new Error(`Could not load train_data.csv (HTTP ${r.status})`);
        return r.text();
      })
      .then(text => {
        setAppData(processData(parseCSV(text)));
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  const yearColors = { "2018": C.accent, "2019": C.blue, "2020": C.gold, signals: C.orange, map: C.teal, summary: C.purple };

  if (loading) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, fontFamily: "'DM Sans', sans-serif" }}>
      <div className="spinner" />
      <p style={{ color: C.accent, fontSize: 14, margin: 0 }}>Loading train_data.csv…</p>
    </div>
  );

  if (error) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ background: C.card, border: `1px solid ${C.coral}`, borderRadius: 10, padding: "24px 32px", maxWidth: 480 }}>
        <p style={{ color: C.coral, fontSize: 15, fontWeight: 700, margin: "0 0 8px" }}>Failed to load data</p>
        <p style={{ color: C.light, fontSize: 13, margin: 0 }}>{error}</p>
        <p style={{ color: C.muted, fontSize: 11, margin: "10px 0 0" }}>Ensure <code>train_data.csv</code> is in the <code>public/</code> folder.</p>
      </div>
    </div>
  );

  const { yearsData, crossYear, crossMetrics, uniqueCompanies, totalRows, covidSectorImpact, signalData, regionMapData } = appData;
  const bestYear          = crossYear.reduce((a, b) => a.median > b.median ? a : b);
  const highestVolatility = crossYear.reduce((a, b) => a.std    > b.std    ? a : b);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "'DM Sans', sans-serif", color: C.white }}>

      {/* HEADER */}
      <div style={{ background: C.navy, borderBottom: `1px solid ${C.border}`, padding: "20px 28px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ width: 5, height: 28, background: C.accent, borderRadius: 3 }} />
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, fontFamily: "'Playfair Display', Georgia, serif" }}>Revenue Forecasting — EDA Intelligence</h1>
        </div>
        <p style={{ color: C.muted, fontSize: 11, margin: "2px 0 14px 15px", letterSpacing: 0.4 }}>
          Challenge 3  •  {uniqueCompanies.toLocaleString()} unique Italian companies  •  {totalRows.toLocaleString()} rows across 2018–2020  •  Target: next-year revenue change (%)
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Tab active={tab === "2018"} onClick={() => setTab("2018")} color={yearColors["2018"]}>2018 → 2019</Tab>
          <Tab active={tab === "2019"} onClick={() => setTab("2019")} color={yearColors["2019"]}>2019 → 2020</Tab>
          <Tab active={tab === "2020"} onClick={() => setTab("2020")} color={yearColors["2020"]}>2020 → 2021</Tab>
          <Tab active={tab === "signals"} onClick={() => setTab("signals")} color={yearColors.signals}>Revenue Signals</Tab>
          <Tab active={tab === "map"}     onClick={() => setTab("map")}     color={yearColors.map}>Regional Map</Tab>
          <Tab active={tab === "summary"} onClick={() => setTab("summary")} color={yearColors.summary}>Summary & Comparison</Tab>
        </div>
      </div>

      <div style={{ padding: "20px 28px 40px", maxWidth: 1180, margin: "0 auto" }}>

        {tab !== "summary" && tab !== "signals" && tab !== "map" && <YearSection yr={Number(tab)} yearsData={yearsData} />}
        {tab === "map" && <ItalyMapTab regionMapData={regionMapData} />}

        {tab === "signals" && (
          <>
            <h2 style={{ color: C.white, fontSize: 24, fontWeight: 700, margin: "0 0 6px", fontFamily: "'Playfair Display', Georgia, serif" }}>
              Revenue Signals — Advanced Pattern Analysis
            </h2>
            <p style={{ color: C.muted, fontSize: 12, margin: "0 0 20px" }}>
              Cross-year pooled signals derived from 2018–2020 cohorts  •  Target = next-year revenue change  •  Each signal isolates a structural driver
            </p>

            {/* ── 1. Revenue Tier → Target ── */}
            <Heading
              sub="Median next-year revenue change by production-value decile (Q1=smallest → Q10=largest), pooled across all years"
              insight="Lower tiers show explosive growth; top tiers trend negative — decile rank is a strong non-linear signal"
            >
              Revenue Tier → Next-Year Revenue Change
            </Heading>
            <Card>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={signalData.tierTarget} barCategoryGap="12%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis dataKey="tier" tick={{ fill: C.light, fontSize: 11 }} axisLine={{ stroke: C.border }} />
                  <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} tickFormatter={v => `${v}%`} />
                  <ReferenceLine y={0} stroke={C.muted} strokeWidth={2} />
                  <Tooltip content={<Tip sfx="%" />} />
                  <Bar dataKey="medTarget" name="Median Target %" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="medTarget" position="top" formatter={v => `${v > 0 ? "+" : ""}${v}%`} style={{ fill: C.light, fontSize: 9, fontWeight: 700 }} />
                    {signalData.tierTarget.map((d, i) => <Cell key={i} fill={d.medTarget > 0 ? C.accent : C.coral} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
                {signalData.tierTarget.map((d, i) => (
                  <span key={i} style={{ fontSize: 9.5, color: C.muted }}>{d.tier}: <b style={{ color: C.light }}>{d.n}</b></span>
                ))}
              </div>
            </Card>

            {/* ── 2. Tier Shift → Target ── */}
            <Heading
              sub="Median next-year revenue change by how many deciles a company moved since the prior year"
              insight="Companies climbing tiers (≥+2) already outperform — momentum matters. Fallen companies face the steepest targets"
            >
              Tier Shift → Target
            </Heading>
            <Card>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={signalData.tierShift} barCategoryGap="22%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis dataKey="shift" tick={{ fill: C.light, fontSize: 12 }} axisLine={{ stroke: C.border }} />
                  <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} tickFormatter={v => `${v}%`} />
                  <ReferenceLine y={0} stroke={C.muted} strokeWidth={2} />
                  <Tooltip content={<Tip sfx="%" />} />
                  <Bar dataKey="medTarget" name="Median Target %" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="medTarget" position="top" formatter={v => `${v > 0 ? "+" : ""}${v}%`} style={{ fill: C.light, fontSize: 11, fontWeight: 700 }} />
                    {signalData.tierShift.map((_, i) => (
                      <Cell key={i} fill={[C.coral, "#FF9F7F", C.blue, "#66BB6A", C.accent][i]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", justifyContent: "center", gap: 20, marginTop: 6, flexWrap: "wrap" }}>
                {signalData.tierShift.map((d, i) => (
                  <span key={i} style={{ fontSize: 9.5, color: C.muted }}>Shift {d.shift}: <b style={{ color: C.light }}>{d.n}</b> obs.</span>
                ))}
              </div>
            </Card>

            {/* ── 3 + 4: Tier Persistence & Extreme Events ── */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <Heading
                  sub="% of companies that stayed in the same tier the following year — by starting tier"
                  insight="Middle tiers are most mobile; top/bottom tiers are sticky — path-dependency is tier-specific"
                >
                  Tier Persistence — Stay Rate
                </Heading>
                <Card>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={signalData.tierPersistence} barCategoryGap="10%" stackOffset="none">
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="tier" tick={{ fill: C.light, fontSize: 10 }} axisLine={{ stroke: C.border }} />
                      <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                      <Tooltip
                        formatter={(v, name) => [`${v}%`, name]}
                        contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
                        labelStyle={{ color: C.white, fontWeight: 700 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 10 }} formatter={v => <span style={{ color: C.light }}>{v}</span>} />
                      <Bar dataKey="stay" name="Stayed" stackId="a" fill={C.accent}  radius={[0, 0, 0, 0]} />
                      <Bar dataKey="up"   name="Moved Up"   stackId="a" fill={C.blue}   radius={[0, 0, 0, 0]} />
                      <Bar dataKey="down" name="Moved Down" stackId="a" fill={C.coral}  radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  <p style={{ color: C.muted, fontSize: 9.5, textAlign: "center", margin: "4px 0 0" }}>
                    Stacked 100%  •  Green = stayed same tier  •  Blue = climbed  •  Red = fell
                  </p>
                </Card>
              </div>

              <div>
                <Heading
                  sub="% of companies in each tier experiencing extreme revenue events in the following year"
                  insight="Smallest firms (Q1-Q3) face the highest extreme-event risk — both explosive growth AND severe decline"
                >
                  Extreme Event Probability by Tier
                </Heading>
                <Card>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={signalData.extremeEvents} barCategoryGap="10%" barGap={2}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="tier" tick={{ fill: C.light, fontSize: 10 }} axisLine={{ stroke: C.border }} />
                      <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} tickFormatter={v => `${v}%`} />
                      <Tooltip
                        formatter={(v, name) => [`${v}%`, name]}
                        contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
                        labelStyle={{ color: C.white, fontWeight: 700 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 10 }} formatter={v => <span style={{ color: C.light }}>{v}</span>} />
                      <Bar dataKey="pct100"   name=">100% Jump"  fill={C.accent}  radius={[3, 3, 0, 0]} />
                      <Bar dataKey="pct200"   name=">200% Jump"  fill={C.purple}  radius={[3, 3, 0, 0]} />
                      <Bar dataKey="pctNeg50" name="<−50% Drop"  fill={C.coral}   radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  <p style={{ color: C.muted, fontSize: 9.5, textAlign: "center", margin: "4px 0 0" }}>
                    % of companies in each tier experiencing the event next year  •  Pooled 2018–2020
                  </p>
                </Card>
              </div>
            </div>

            {/* ── 5 + 6: Growth Momentum & Equity Gap ── */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <Heading
                  sub="Median next-year revenue change by current-year revenue change bucket — mean reversion pattern"
                  insight="High current-year growth strongly predicts lower next-year growth — and vice versa. Classic mean reversion"
                >
                  Growth Momentum Mean Reversion
                </Heading>
                <Card>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={signalData.growthMomentum} barCategoryGap="22%">
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="bucket" tick={{ fill: C.light, fontSize: 10 }} axisLine={{ stroke: C.border }} />
                      <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} tickFormatter={v => `${v}%`} />
                      <ReferenceLine y={0} stroke={C.muted} strokeWidth={2} />
                      <Tooltip content={<Tip sfx="%" />} />
                      <Bar dataKey="medTarget" name="Median Target %" radius={[4, 4, 0, 0]}>
                        <LabelList dataKey="medTarget" position="top" formatter={v => `${v > 0 ? "+" : ""}${v}%`} style={{ fill: C.light, fontSize: 10, fontWeight: 700 }} />
                        {signalData.growthMomentum.map((d, i) => <Cell key={i} fill={d.medTarget > 0 ? C.accent : C.coral} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                        <th style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: "left", padding: "5px 8px" }}>Current Growth Bucket</th>
                        <th style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: "right", padding: "5px 8px" }}>Companies</th>
                        <th style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: "right", padding: "5px 8px" }}>Median Target</th>
                      </tr>
                    </thead>
                    <tbody>
                      {signalData.growthMomentum.map((d, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: "5px 8px", color: C.light, fontSize: 11 }}>{d.bucket}</td>
                          <td style={{ padding: "5px 8px", textAlign: "right", color: C.muted, fontSize: 11 }}>{d.n.toLocaleString()}</td>
                          <td style={{ padding: "5px 8px", textAlign: "right", color: d.medTarget > 0 ? C.accent : C.coral, fontSize: 12, fontWeight: 700 }}>
                            {d.medTarget > 0 ? "+" : ""}{d.medTarget}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>

              <div>
                <Heading
                  sub="Equity gap = (SE_t − SE_{t−1} − net_profit_t) / total_assets — measures hidden capital flows"
                  insight="Equity withdrawals signal insider pessimism; injections signal strategic investment — both predict future revenue direction"
                >
                  Equity Gap — Capital Flow Signal
                </Heading>
                <Card>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={signalData.equityGap} barCategoryGap="30%">
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="group" tick={{ fill: C.light, fontSize: 10 }} axisLine={{ stroke: C.border }} />
                      <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} tickFormatter={v => `${v}%`} />
                      <ReferenceLine y={0} stroke={C.muted} strokeWidth={2} />
                      <Tooltip content={<Tip sfx="%" />} />
                      <Bar dataKey="medTarget" name="Median Target %" radius={[4, 4, 0, 0]}>
                        <LabelList dataKey="medTarget" position="top" formatter={v => `${v > 0 ? "+" : ""}${v}%`} style={{ fill: C.light, fontSize: 11, fontWeight: 700 }} />
                        {signalData.equityGap.map((_, i) => <Cell key={i} fill={[C.coral, C.blue, C.accent][i]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div style={{ background: `${C.navy}`, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", marginTop: 14 }}>
                    <p style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", margin: "0 0 6px", fontWeight: 600 }}>Signal Construction</p>
                    <p style={{ color: C.light, fontSize: 11, lineHeight: 1.6, margin: 0 }}>
                      <b style={{ color: C.coral }}>Withdrawal</b> — shareholders removed equity beyond retained earnings<br />
                      <b style={{ color: C.blue }}>Neutral</b> — equity change ≈ expected from profits alone<br />
                      <b style={{ color: C.accent }}>Injection</b> — fresh capital infused (rights issue, shareholder loans)<br />
                      <span style={{ color: C.muted, fontSize: 10 }}>Threshold ±4% of total assets  •  Requires 2+ consecutive years</span>
                    </p>
                  </div>
                  <div style={{ display: "flex", justifyContent: "center", gap: 20, marginTop: 10 }}>
                    {signalData.equityGap.map((d, i) => (
                      <span key={i} style={{ fontSize: 9.5, color: C.muted }}>{d.group}: <b style={{ color: C.light }}>{d.n.toLocaleString()}</b> co.</span>
                    ))}
                  </div>
                </Card>
              </div>
            </div>

            {/* ── 7. Insight Cards ── */}
            <Heading>How These Signals Improve Our Revenue Model</Heading>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                {
                  num: "1", color: C.accent,
                  title: "Revenue Tier = Non-Linear Size Feature",
                  body: `Q1 (smallest) companies deliver a median target of ${signalData.tierTarget[0]?.medTarget > 0 ? "+" : ""}${signalData.tierTarget[0]?.medTarget}% while Q10 (largest) sits at ${signalData.tierTarget[9]?.medTarget > 0 ? "+" : ""}${signalData.tierTarget[9]?.medTarget}%. A simple production-value decile rank outperforms the raw €-value as a model feature because the relationship is monotone but non-linear.`,
                },
                {
                  num: "2", color: C.orange,
                  title: "Tier Momentum Compounds the Signal",
                  body: `Companies rising ≥2 tiers (${signalData.tierShift[4]?.n.toLocaleString()} obs.) show a median target of ${signalData.tierShift[4]?.medTarget > 0 ? "+" : ""}${signalData.tierShift[4]?.medTarget}% vs. ${signalData.tierShift[0]?.medTarget > 0 ? "+" : ""}${signalData.tierShift[0]?.medTarget}% for those falling ≥2 tiers. Tier change (lag-1 shift) adds orthogonal information on top of absolute tier rank.`,
                },
                {
                  num: "3", color: C.purple,
                  title: "Mean Reversion Is Actionable",
                  body: `Companies with current growth >+200% (${signalData.growthMomentum[3]?.n.toLocaleString()} obs.) show a next-year median of ${signalData.growthMomentum[3]?.medTarget > 0 ? "+" : ""}${signalData.growthMomentum[3]?.medTarget}%. Companies already declining (≤−50%) show ${signalData.growthMomentum[0]?.medTarget > 0 ? "+" : ""}${signalData.growthMomentum[0]?.medTarget}% next. Encoding current-year growth bucket creates a powerful mean-reversion feature.`,
                },
                {
                  num: "4", color: C.blue,
                  title: "Equity Gap Reveals Hidden Owner Signals",
                  body: `Equity injections (${signalData.equityGap[2]?.n.toLocaleString()} co.) precede a median target of ${signalData.equityGap[2]?.medTarget > 0 ? "+" : ""}${signalData.equityGap[2]?.medTarget}%; withdrawals (${signalData.equityGap[0]?.n.toLocaleString()} co.) precede ${signalData.equityGap[0]?.medTarget > 0 ? "+" : ""}${signalData.equityGap[0]?.medTarget}%. This accounting identity captures owner sentiment not visible in the P&L — a premium signal for Italian private companies.`,
                },
              ].map((t, i) => (
                <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderLeft: `4px solid ${t.color}`, borderRadius: 8, padding: "16px 18px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 26, height: 26, borderRadius: "50%", background: t.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: C.bg }}>{t.num}</div>
                    <span style={{ color: C.white, fontSize: 14, fontWeight: 700 }}>{t.title}</span>
                  </div>
                  <p style={{ color: C.light, fontSize: 12, lineHeight: 1.55, margin: 0 }}>{t.body}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "summary" && (
          <>
            <h2 style={{ color: C.white, fontSize: 24, fontWeight: 700, margin: "0 0 6px", fontFamily: "'Playfair Display', Georgia, serif" }}>
              3-Year Comparison & Strategic Insights
            </h2>
            <p style={{ color: C.muted, fontSize: 12, margin: "0 0 16px" }}>
              How the revenue forecasting landscape evolved across 2018→2019, 2019→2020, and 2020→2021
            </p>

            {/* Summary KPIs */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
              <KPI label="Total Companies" value={uniqueCompanies.toLocaleString()} sub="Unique across all years" color={C.accent} />
              <KPI label="Total Rows (3 years)" value={totalRows.toLocaleString()} sub="2021 excluded (test year)" color={C.blue} />
              <KPI label="Best Median Target" value={`${bestYear.median > 0 ? "+" : ""}${bestYear.median}%`} sub={`${bestYear.year} — post-COVID rebound`} color={C.accent} />
              <KPI label="Highest Volatility" value={highestVolatility.std.toLocaleString()} sub={`${highestVolatility.year} std dev (COVID effect)`} color={C.coral} />
            </div>

            {/* Median Target Trend */}
            <Heading sub="How the median next-year revenue change shifted across years" insight="2020→2021 shows post-COVID recovery — a structural upward shift in the target">Median Target Trend</Heading>
            <Card>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={crossYear} barCategoryGap="25%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis dataKey="year" tick={{ fill: C.light, fontSize: 12 }} axisLine={{ stroke: C.border }} />
                  <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} />
                  <ReferenceLine y={0} stroke={C.border} strokeWidth={2} />
                  <Tooltip content={<Tip sfx="%" />} />
                  <Bar dataKey="median" name="Median Target %" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="median" position="top" formatter={v => `${v > 0 ? "+" : ""}${v}%`} style={{ fill: C.light, fontSize: 12, fontWeight: 700 }} />
                    {crossYear.map((_, i) => <Cell key={i} fill={[C.accent, C.blue, C.gold][i]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>

            {/* ── COVID SECTOR IMPACT ── */}
            <Heading
              sub="Median revenue change per sector × year-transition — reveals which industries were hit by COVID and who recovered strongest"
              insight="Sectors sorted by COVID shock (2019→20). Construction & IT absorbed the blow; Food & Bev took the deepest hit"
            >
              COVID Sector Impact: Revenue Change 2018–2021
            </Heading>
            <Card>
              <ResponsiveContainer width="100%" height={400}>
                <BarChart
                  data={covidSectorImpact}
                  layout="vertical"
                  barCategoryGap="22%"
                  barGap={3}
                  margin={{ left: 8, right: 68, top: 8, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fill: C.muted, fontSize: 10 }}
                    axisLine={{ stroke: C.border }}
                    tickFormatter={v => `${v > 0 ? "+" : ""}${v}%`}
                  />
                  <YAxis
                    dataKey="sector"
                    type="category"
                    tick={{ fill: C.light, fontSize: 10 }}
                    axisLine={{ stroke: C.border }}
                    width={112}
                  />
                  <Tooltip
                    formatter={(v, name) => v != null ? [`${v > 0 ? "+" : ""}${v}%`, name] : ["—", name]}
                    contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
                    labelStyle={{ color: C.white, fontWeight: 700, marginBottom: 4 }}
                  />
                  <ReferenceLine x={0} stroke={C.muted} strokeWidth={2} />
                  <Legend
                    wrapperStyle={{ fontSize: 11, paddingTop: 10 }}
                    formatter={value => <span style={{ color: C.light }}>{value}</span>}
                  />
                  <Bar dataKey="2018→19" name="2018→19  Pre-COVID" fill={C.accent} radius={[0, 3, 3, 0]}>
                    <LabelList dataKey="2018→19" position="right" formatter={v => v != null ? `${v > 0 ? "+" : ""}${v}%` : ""} style={{ fill: C.muted, fontSize: 9 }} />
                  </Bar>
                  <Bar dataKey="2019→20" name="2019→20  COVID Shock" fill={C.coral} radius={[0, 3, 3, 0]}>
                    <LabelList dataKey="2019→20" position="right" formatter={v => v != null ? `${v > 0 ? "+" : ""}${v}%` : ""} style={{ fill: C.muted, fontSize: 9 }} />
                  </Bar>
                  <Bar dataKey="2020→21" name="2020→21  Recovery" fill={C.gold} radius={[0, 3, 3, 0]}>
                    <LabelList dataKey="2020→21" position="right" formatter={v => v != null ? `${v > 0 ? "+" : ""}${v}%` : ""} style={{ fill: C.muted, fontSize: 9 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <p style={{ color: C.muted, fontSize: 9.5, textAlign: "center", margin: "4px 0 0" }}>
                Sorted by 2019→20 COVID shock (worst at top)  •  Median revenue_change per sector-year cohort  •  Source: train_data.csv
              </p>
            </Card>

            {/* Quantile Comparison Across Years */}
            <Heading sub="Side-by-side percentile comparison across years" insight="Q25 stays near −68% every year, Q75 near +240% — the spread is structurally stable, only the center shifts">Quantile Comparison Across Years</Heading>
            <Card>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                {[2018, 2019, 2020].map((yr, yi) => {
                  const d = yearsData[yr];
                  const clr = [C.accent, C.blue, C.gold][yi];
                  return (
                    <div key={yr} style={{ border: `1px solid ${C.border}`, borderTop: `3px solid ${clr}`, borderRadius: 8, padding: "12px" }}>
                      <p style={{ color: clr, fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>{d.label}</p>
                      {d.quantiles.map((q, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: q.q === "Q50" ? `1px solid ${clr}40` : "none" }}>
                          <span style={{ color: q.q === "Q50" ? clr : C.muted, fontSize: 11, fontWeight: q.q === "Q50" ? 700 : 400 }}>{q.q}</span>
                          <span style={{ color: q.val > 0 ? C.accent : C.coral, fontSize: 11, fontWeight: 600 }}>{q.val > 0 ? "+" : ""}{q.val.toLocaleString()}%</span>
                        </div>
                      ))}
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0 0", marginTop: 4, borderTop: `1px solid ${C.border}` }}>
                        <span style={{ color: C.muted, fontSize: 10 }}>IQR</span>
                        <span style={{ color: C.orange, fontSize: 11, fontWeight: 700 }}>{d.target.iqr.toFixed(1)}pp</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Feature Stability */}
            <Heading sub="How base financial health evolves — the features our model will consume" insight="Metrics are remarkably stable, confirming that company fundamentals alone don't explain the extreme target variance">Feature Stability Over Time</Heading>
            <Card>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={crossMetrics}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="year" tick={{ fill: C.light, fontSize: 12 }} axisLine={{ stroke: C.border }} />
                  <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} domain={[0, 65]} />
                  <Tooltip content={<Tip />} />
                  <Line type="monotone" dataKey="margin" stroke={C.gold}   strokeWidth={2.5} name="Profit Margin %" dot={{ r: 4, fill: C.gold }} />
                  <Line type="monotone" dataKey="roi"    stroke={C.accent}  strokeWidth={2.5} name="ROI %"          dot={{ r: 4, fill: C.accent }} />
                  <Line type="monotone" dataKey="debt"   stroke={C.coral}   strokeWidth={2.5} name="Debt/Assets %"  dot={{ r: 4, fill: C.coral }} />
                  <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
                </LineChart>
              </ResponsiveContainer>
            </Card>

            {/* Volatility */}
            <Heading sub="Standard deviation and IQR of the target — measuring prediction difficulty year over year" insight="Growing std dev confirms increasing volatility — models must account for temporal instability">Target Volatility Trend</Heading>
            <Card>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={crossYear} barCategoryGap="25%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis dataKey="year" tick={{ fill: C.light, fontSize: 12 }} axisLine={{ stroke: C.border }} />
                  <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} />
                  <Tooltip content={<Tip />} />
                  <Bar dataKey="std" name="Std Deviation" fill={C.coral} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="iqr" name="IQR"           fill={C.blue}  radius={[4, 4, 0, 0]} />
                  <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            {/* Size Effect Across Years */}
            <Heading sub="The 'funnel pattern' — consistent across all three years" insight="Most actionable finding: company revenue size should be a primary feature in any predictive model">Size Effect: Consistent Across Years</Heading>
            <Card>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={yearsData[2018].sizeSeg.map((s, i) => ({
                  name: s.name,
                  "2018→19": yearsData[2018].sizeSeg[i].medTarget,
                  "2019→20": yearsData[2019].sizeSeg[i].medTarget,
                  "2020→21": yearsData[2020].sizeSeg[i].medTarget,
                }))} barCategoryGap="20%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: C.light, fontSize: 10 }} axisLine={{ stroke: C.border }} />
                  <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} label={{ value: "Median Target %", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 10, dx: -8 }} />
                  <ReferenceLine y={0} stroke={C.border} strokeWidth={2} />
                  <Tooltip content={<Tip sfx="%" />} />
                  <Bar dataKey="2018→19" fill={C.accent} name="2018→19" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="2019→20" fill={C.blue}   name="2019→20" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="2020→21" fill={C.gold}   name="2020→21" radius={[3, 3, 0, 0]} />
                  <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            {/* Strategic Takeaways */}
            <Heading>Key Strategic Takeaways for Revenue Forecasting</Heading>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { num: "1", title: "Size Drives Everything", body: "Small companies (<€100M) show explosive median growth; large companies (>€10B) trend deeply negative. This funnel pattern is consistent across all 3 years. Company revenue tier must be a primary model feature.", color: C.accent },
                { num: "2", title: "Extreme Tails Are Structural", body: "~35% of companies have >100% revenue change. These are real events (M&A, expansions, closures) — not noise. The IQR stays ~300pp every year. Standard MAE/RMSE will be dominated by these tails.", color: C.coral },
                { num: "3", title: "COVID Created a Shift, Not a Break", body: "The 2020→2021 median target reached its highest level in the dataset. The recovery effect is real but the distributional shape is unchanged. Year-fixed effects or temporal features should capture this.", color: C.gold },
                { num: "4", title: "Sector Divergence Amplified by COVID", body: "The COVID shock (2019→20) hit sectors asymmetrically. Food & Bev, Auto Trade saw the deepest declines; Construction and IT held. The 2020→21 recovery was equally uneven, creating strong sector-level signals for modeling.", color: C.blue },
              ].map((t, i) => (
                <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderLeft: `4px solid ${t.color}`, borderRadius: 8, padding: "16px 18px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 26, height: 26, borderRadius: "50%", background: t.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: C.bg }}>{t.num}</div>
                    <span style={{ color: C.white, fontSize: 14, fontWeight: 700 }}>{t.title}</span>
                  </div>
                  <p style={{ color: C.light, fontSize: 12, lineHeight: 1.55, margin: 0 }}>{t.body}</p>
                </div>
              ))}
            </div>
          </>
        )}

        <div style={{ marginTop: 36, paddingTop: 12, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between" }}>
          <p style={{ color: C.muted, fontSize: 9.5, margin: 0 }}>Target: revenue_change_next = (production_value_next − production_value) / production_value × 100  •  Shift(−1) per company</p>
          <p style={{ color: C.muted, fontSize: 9.5, margin: 0 }}>Source: train_data.csv  •  Training data only — no data leakage</p>
        </div>
      </div>
    </div>
  );
}
