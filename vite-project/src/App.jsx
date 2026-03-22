import { useState, useEffect, useRef } from "react";
import {
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell, ReferenceLine, LabelList,
  ScatterChart, Scatter, ZAxis,
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
  { name: "<€10M",      lo: 0,      hi: 1e7 },
  { name: "€10–25M",    lo: 1e7,    hi: 2.5e7 },
  { name: "€25–50M",    lo: 2.5e7,  hi: 5e7 },
  { name: "€50–100M",   lo: 5e7,    hi: 1e8 },
  { name: "€100–250M",  lo: 1e8,    hi: 2.5e8 },
  { name: "€250–500M",  lo: 2.5e8,  hi: 5e8 },
  { name: "€500M–1B",   lo: 5e8,    hi: 1e9 },
  { name: "€1B–2B",     lo: 1e9,    hi: 2e9 },
  { name: "€2B–10B",    lo: 2e9,    hi: 1e10 },
  { name: ">€10B",      lo: 1e10,   hi: Infinity },
];

const TIER_COLORS = [
  "#3B82F6", "#38BDF8", "#14B8A6", "#00D4AA", "#84CC16",
  "#F0B942", "#F97316", "#EF6461", "#A78BFA", "#7C3AED",
];

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

// === CORRELATION MATRIX — two feature groups ===
const CORR_FINANCIAL = [
  { key: "production_value",    label: "Prod.Val" },
  { key: "total_assets",        label: "Assets" },
  { key: "shareholders_equity", label: "Equity" },
  { key: "total_debt",          label: "Debt" },
  { key: "operating_income",    label: "Op.Inc" },
  { key: "net_profit_loss",     label: "NetPft" },
  { key: "revenue_change",      label: "RevChg" },
  { key: "revenue_change_next", label: "RC★" },
  { key: "production_value_next", label: "PV★" },
];

const CORR_RATIOS = [
  { key: "profit_margin",      label: "Margin" },
  { key: "roi",                label: "ROI" },
  { key: "leverage",           label: "Levg" },
  { key: "debt_to_assets",     label: "D/A" },
  { key: "current_ratio",      label: "CR" },
  { key: "years_in_business",  label: "YrsBiz" },
  { key: "revenue_change",     label: "RevChg" },
  { key: "revenue_change_next", label: "RC★" },
  { key: "production_value_next", label: "PV★" },
];

function computeMatrix(rows, features) {
  const valid = rows.filter(r =>
    r.revenue_change_next !== null && isFinite(r.revenue_change_next) &&
    r.production_value_next !== null && isFinite(r.production_value_next)
  );
  const n = valid.length;
  if (n < 2) return { labels: features.map(f => f.label), matrix: [] };

  const cols = features.map(f => valid.map(r => {
    const v = r[f.key];
    return (v === null || v === undefined || !isFinite(v)) ? 0 : v;
  }));
  const means = cols.map(c => c.reduce((a, b) => a + b, 0) / n);
  const stds  = cols.map((c, i) => {
    const m = means[i];
    return Math.sqrt(c.reduce((s, v) => s + (v - m) ** 2, 0) / n);
  });

  const matrix = features.map((_, i) =>
    features.map((_, j) => {
      if (stds[i] < 1e-10 || stds[j] < 1e-10) return i === j ? 1 : 0;
      let sum = 0;
      for (let k = 0; k < n; k++) sum += (cols[i][k] - means[i]) * (cols[j][k] - means[j]);
      return round2(sum / (n * stds[i] * stds[j]));
    })
  );

  return { labels: features.map(f => f.label), matrix, n };
}

function computeCorrelationData(rows) {
  // Pooled across all years — for DataOverview
  const financial = computeMatrix(rows, CORR_FINANCIAL);
  const ratios    = computeMatrix(rows, CORR_RATIOS);

  // Feature→target corrs (used for the bar chart comparison)
  const allFeatures = [
    { key: "production_value",    label: "Prod. Value" },
    { key: "total_assets",        label: "Tot. Assets" },
    { key: "shareholders_equity", label: "SH Equity" },
    { key: "total_debt",          label: "Tot. Debt" },
    { key: "operating_income",    label: "Op. Income" },
    { key: "net_profit_loss",     label: "Net Profit" },
    { key: "profit_margin",       label: "Prft. Margin" },
    { key: "roi",                 label: "ROI" },
    { key: "leverage",            label: "Leverage" },
    { key: "debt_to_assets",      label: "Debt/Assets" },
    { key: "current_ratio",       label: "Curr. Ratio" },
    { key: "years_in_business",   label: "Yrs in Biz" },
    { key: "revenue_change",      label: "Rev. Change" },
    { key: "revenue_change_next", label: "RC Next ★" },
    { key: "production_value_next", label: "PV Next ★" },
  ];
  const full = computeMatrix(rows, allFeatures);
  const pvNextIdx = allFeatures.findIndex(f => f.key === "production_value_next");
  const rcNextIdx = allFeatures.findIndex(f => f.key === "revenue_change_next");
  const featureTargetCorrs = allFeatures
    .filter(f => f.key !== "production_value_next" && f.key !== "revenue_change_next")
    .map(f => {
      const fi = allFeatures.findIndex(ff => ff.key === f.key);
      return { label: f.label, corrPV: full.matrix[fi]?.[pvNextIdx] ?? 0, corrRC: full.matrix[fi]?.[rcNextIdx] ?? 0 };
    })
    .sort((a, b) => Math.abs(b.corrPV) - Math.abs(a.corrPV));

  return { financial, ratios, featureTargetCorrs };
}

function computeYearCorrData(rows, yr) {
  const yrRows = rows.filter(r => r.fiscal_year === yr);
  return {
    financial: computeMatrix(yrRows, CORR_FINANCIAL),
    ratios:    computeMatrix(yrRows, CORR_RATIOS),
  };
}

// === YEARS IN BUSINESS ANALYSIS ===
const AGE_BUCKETS = [
  { label: "Startup\n(≤3yr)",     display: "Startup (≤3yr)",     check: y => y > 0 && y <= 3 },
  { label: "Young\n(4-10yr)",     display: "Young (4-10yr)",     check: y => y > 3 && y <= 10 },
  { label: "Mature\n(11-25yr)",   display: "Mature (11-25yr)",   check: y => y > 10 && y <= 25 },
  { label: "Established\n(>25yr)",display: "Established (>25yr)",check: y => y > 25 },
];

function computeYearsInBusinessAnalysis(rows) {
  const valid = rows.filter(r =>
    r.years_in_business > 0 &&
    r.revenue_change !== null && isFinite(r.revenue_change) &&
    [2018, 2019, 2020].includes(r.fiscal_year)
  );
  const buckets = AGE_BUCKETS.map(b => {
    const br = valid.filter(r => b.check(r.years_in_business));
    return { label: b.display, n: br.length, medTarget: round1(medianOf(br.map(r => r.revenue_change))) };
  });

  // Pearson r between years_in_business and revenue_change
  const yvs = valid.map(r => r.years_in_business);
  const tvs = valid.map(r => r.revenue_change);
  const n   = valid.length;
  const my  = yvs.reduce((a, b) => a + b, 0) / n;
  const mt  = tvs.reduce((a, b) => a + b, 0) / n;
  const sy  = Math.sqrt(yvs.reduce((s, v) => s + (v - my) ** 2, 0) / n);
  const st  = Math.sqrt(tvs.reduce((s, v) => s + (v - mt) ** 2, 0) / n);
  const pearsonR = (sy < 1e-10 || st < 1e-10) ? 0
    : round2(yvs.reduce((s, v, i) => s + (v - my) * (tvs[i] - mt), 0) / (n * sy * st));

  // Scatter data by year (sampled for performance) — clamp y to avoid extreme outliers
  const MAX_PTS = 400;
  const scatterByYear = {};
  for (const yr of [2018, 2019, 2020]) {
    const yrRows = rows.filter(r =>
      r.fiscal_year === yr &&
      r.years_in_business > 0 && r.years_in_business <= 70 &&
      r.revenue_change_next !== null && isFinite(r.revenue_change_next) &&
      r.revenue_change_next >= 0 && r.revenue_change_next <= 6000
    );
    const step = yrRows.length > MAX_PTS ? Math.ceil(yrRows.length / MAX_PTS) : 1;
    scatterByYear[yr] = yrRows.filter((_, i) => i % step === 0).map(r => ({
      x: Math.round(r.years_in_business),
      y: Math.round(r.revenue_change_next),
    }));
  }

  return { buckets, pearsonR, n, scatterByYear };
}

// === OUTLIER DISTRIBUTION DATA ===
function computeOutliersData(rows) {
  const variables = [
    { key: "production_value",    label: "Production Value" },
    { key: "total_assets",        label: "Total Assets" },
    { key: "total_debt",          label: "Total Debt" },
    { key: "production_costs",    label: "Production Costs" },
    { key: "shareholders_equity", label: "Shareholders Equity" },
  ];
  return variables.map(v => {
    const vals = rows.map(r => r[v.key]).filter(x => x > 0 && isFinite(x)).sort((a, b) => a - b);
    if (!vals.length) return { label: v.label, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p99: 0, n: 0 };
    return {
      label: v.label,
      p10: pct(vals, 10),
      p25: pct(vals, 25),
      p50: pct(vals, 50),
      p75: pct(vals, 75),
      p90: pct(vals, 90),
      p99: pct(vals, 99),
      n: vals.length,
    };
  });
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
    total_fixed_assets:  parseFloat(r.total_fixed_assets)  || 0,
    current_assets:      parseFloat(r.current_assets)      || 0,
    total_debt:          parseFloat(r.total_debt)          || 0,
    short_term_debt:     parseFloat(r.short_term_debt)     || 0,
    long_term_debt:      parseFloat(r.long_term_debt)      || 0,
    production_costs:    parseFloat(r.production_costs)    || 0,
    operating_income:    parseFloat(r.operating_income)    || 0,
    financial_income:    parseFloat(r.financial_income)    || 0,
    financial_expenses:  parseFloat(r.financial_expenses)  || 0,
    years_in_business:   parseFloat(r.years_in_business)   || 0,
    shareholders_equity: parseFloat(r.shareholders_equity) || 0,
    net_profit_loss:     parseFloat(r.net_profit_loss)     || 0,
    roe:                 parseFloat(r.roe)                 || 0,
    leverage:            parseFloat(r.leverage)            || 0,
    profit_margin:       parseFloat(r.profit_margin)       || 0,
    roi:                 parseFloat(r.roi)                 || 0,
    debt_to_assets:      parseFloat(r.debt_to_assets)      || 0,
    current_ratio:       parseFloat(r.current_ratio)       || 0,
    quick_ratio:         parseFloat(r.quick_ratio)         || 0,
    revenue_change:      r.revenue_change === "" ? null : parseFloat(r.revenue_change),
    // forward-looking targets (filled in second pass below)
    production_value_next: null,
    revenue_change_next:   null,
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
  // Second pass: compute production_value_next and revenue_change_next per company
  for (const yearMap of Object.values(byCompany)) {
    for (const yr of [2018, 2019, 2020]) {
      const curr = yearMap[yr], next = yearMap[yr + 1];
      if (!curr) continue;
      if (next && next.production_value > 0 && curr.production_value > 0) {
        curr.production_value_next = next.production_value;
        curr.revenue_change_next   = ((next.production_value - curr.production_value) / curr.production_value) * 100;
      }
    }
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

  const covidSectorImpact    = computeCovidSectorImpact(rows, dynSectorCodes);
  const signalData           = computeRevenueSignals(rows, byCompany);
  const regionMapData        = computeRegionMapData(rows);
  const correlationData      = computeCorrelationData(rows);
  const yearsInBusinessData  = computeYearsInBusinessAnalysis(rows);
  const outliersData         = computeOutliersData(rows);
  const yearsCorrelationData = {
    2018: computeYearCorrData(rows, 2018),
    2019: computeYearCorrData(rows, 2019),
    2020: computeYearCorrData(rows, 2020),
  };

  return { yearsData, crossYear, crossMetrics, uniqueCompanies, totalRows, covidSectorImpact, signalData, regionMapData, correlationData, yearsInBusinessData, outliersData, yearsCorrelationData };
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
function YearSection({ yr, yearsData, yearsCorrelation }) {
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

        {/* Size count distribution bar chart — filter tiers with too few companies */}
        <Card>
          <p style={{ color: C.muted, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", margin: "0 0 10px", fontWeight: 600 }}>
            Company Count by Revenue Tier
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={d.sizeDist.filter(t => t.count >= 25)} barCategoryGap="12%" margin={{ left: 4, right: 4, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
              <XAxis dataKey="name" tick={{ fill: C.light, fontSize: 9 }} axisLine={{ stroke: C.border }} angle={-30} textAnchor="end" height={58} interval={0} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} width={44} />
              <Tooltip content={<Tip />} />
              <Bar dataKey="count" name="Observations" radius={[4, 4, 0, 0]}>
                <LabelList dataKey="count" position="top" style={{ fill: C.light, fontSize: 9, fontWeight: 600 }} />
                {d.sizeDist.filter(t => t.count >= 25).map((t) => {
                  const origIdx = d.sizeDist.indexOf(t);
                  return <Cell key={origIdx} fill={TIER_COLORS[origIdx % TIER_COLORS.length]} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p style={{ color: C.muted, fontSize: 9, textAlign: "center", margin: "4px 0 0" }}>Tiers with &lt;25 observations hidden to avoid misleading visual weight</p>
        </Card>
      </div>

      {/* ── SECTION 3: Revenue Size → Target ── */}
      <Heading sub="Median next-year revenue change by company revenue size tier" insight="Smaller companies show explosive growth, larger companies trend negative — size is the #1 structural driver">Revenue Size Effect on Target</Heading>
      <Card>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={d.sizeSeg} barCategoryGap="12%">
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="name" tick={{ fill: C.light, fontSize: 9 }} axisLine={{ stroke: C.border }} angle={-30} textAnchor="end" height={54} interval={0} />
            <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={{ stroke: C.border }} label={{ value: "Median Target %", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 10, dx: -8 }} />
            <ReferenceLine y={0} stroke={C.muted} strokeWidth={2} />
            <Tooltip content={<Tip sfx="%" />} />
            <Bar dataKey="medTarget" name="Median Target %" radius={[4, 4, 0, 0]}>
              <LabelList dataKey="medTarget" position="top" formatter={v => `${v > 0 ? "+" : ""}${v}%`} style={{ fill: C.light, fontSize: 9, fontWeight: 700 }} />
              {d.sizeSeg.map((s, i) => <Cell key={i} fill={s.medTarget > 0 ? C.accent : C.coral} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div style={{ display: "flex", justifyContent: "center", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
          {d.sizeSeg.map((s, i) => (
            <span key={i} style={{ fontSize: 9.5, color: C.muted }}>{s.name}: <b style={{ color: C.light }}>{s.n}</b> obs.</span>
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
            {/* Lollipop chart: thin stem + colored dot per sector */}
            <div style={{ padding: "4px 0" }}>
              {d.sectors.map((s, i) => {
                const dotColor = sectorFill(s.medTarget);
                const maxAbs   = Math.max(...d.sectors.map(x => Math.abs(x.medTarget)), 1);
                const pct      = s.medTarget / maxAbs; // -1 to +1
                const barW     = Math.abs(pct) * 42;   // max ~42% of half-width
                const isPos    = s.medTarget >= 0;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: i < d.sectors.length - 1 ? `1px solid ${C.border}` : "none" }}>
                    {/* Sector name + n label */}
                    <div style={{ width: 118, flexShrink: 0, textAlign: "right" }}>
                      <span style={{ color: C.light, fontSize: 10 }}>{s.name}</span>
                      <span style={{ color: C.muted, fontSize: 8.5, marginLeft: 4 }}>n={s.n}</span>
                    </div>
                    {/* Lollipop track */}
                    <div style={{ flex: 1, position: "relative", height: 18, display: "flex", alignItems: "center" }}>
                      {/* Zero line */}
                      <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: "100%", background: C.muted, opacity: 0.4 }} />
                      {/* Stem */}
                      <div style={{
                        position: "absolute",
                        [isPos ? "left" : "right"]: "50%",
                        width: `${barW}%`,
                        height: 2,
                        background: dotColor,
                        opacity: 0.55,
                      }} />
                      {/* Dot */}
                      <div style={{
                        position: "absolute",
                        left: `calc(50% + ${pct * 42}%)`,
                        transform: "translate(-50%, 0)",
                        width: 11,
                        height: 11,
                        borderRadius: "50%",
                        background: dotColor,
                        boxShadow: `0 0 6px ${dotColor}80`,
                      }} />
                    </div>
                    {/* Value label */}
                    <div style={{ width: 44, flexShrink: 0, textAlign: "left" }}>
                      <span style={{ color: dotColor, fontSize: 10, fontWeight: 700 }}>{s.medTarget > 0 ? "+" : ""}{s.medTarget}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p style={{ color: C.muted, fontSize: 9.5, textAlign: "center", margin: "8px 0 0" }}>
              Sorted by median target  •  n = observations  •  Dot color intensity scales with magnitude
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

      {/* ── SECTION 6: Year-Specific Correlation Matrices ── */}
      {yearsCorrelation && (
        <>
          <Heading
            sub={`Pearson correlation for ${yr} observations — split by feature type. ★ = prediction targets`}
            insight="Financial size features correlate strongly with PV★ but near-zero with RC★ — consistent every year"
          >
            {yr} Feature Correlations
          </Heading>
          <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Card>
              <SplitCorrMatrix corrData={yearsCorrelation.financial} title="Financial Size Features" accentColor={C.gold} />
              <p style={{ color: C.muted, fontSize: 9, marginTop: 8, marginBottom: 0 }}>★ = target columns  •  Hover for exact values  •  n = {yearsCorrelation.financial.n ?? "—"}</p>
            </Card>
            <Card>
              <SplitCorrMatrix corrData={yearsCorrelation.ratios} title="Financial Ratios" accentColor={C.blue} />
              <p style={{ color: C.muted, fontSize: 9, marginTop: 8, marginBottom: 0 }}>★ = target columns  •  Hover for exact values  •  n = {yearsCorrelation.ratios.n ?? "—"}</p>
            </Card>
          </div>
        </>
      )}
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

// === CORRELATION COLOR HELPER — more vivid palette ===
function corrColor(val) {
  if (val === null || val === undefined || isNaN(val)) return "#1B2A45";
  const v = Math.max(-1, Math.min(1, val));
  if (v === 0) return "rgba(27,42,69,0.7)";
  if (v > 0) {
    const t = v;
    // deep navy → vivid teal-green
    const r = Math.round(0   + t * 16);
    const g = Math.round(40  + t * 220);
    const b = Math.round(60  + t * 100);
    return `rgba(${r},${g},${b},${0.25 + t * 0.75})`;
  } else {
    const t = -v;
    // deep navy → vivid crimson-red
    const r = Math.round(30  + t * 230);
    const g = Math.round(40  + t * 20);
    const b = Math.round(60  + t * 20);
    return `rgba(${r},${g},${b},${0.25 + t * 0.75})`;
  }
}

// === BOX PLOT (log-scale) — shows outlier behavior of monetary variables ===
function BoxPlotChart({ data }) {
  if (!data || !data.length) return null;
  const W = 700, leftPad = 160, rightPad = 50, topPad = 28, botPad = 40;
  const chartW = W - leftPad - rightPad;
  const rowH = 64;
  const H = topPad + data.length * rowH + botPad;

  const allVals = data.flatMap(d => [d.p10, d.p25, d.p50, d.p75, d.p90].filter(v => v > 0));
  if (!allVals.length) return null;
  const logMin = Math.log10(Math.min(...allVals)) - 0.1;
  const logMax = Math.log10(Math.max(...allVals)) + 0.1;

  function toX(v) {
    if (v <= 0) return 0;
    return Math.max(0, Math.min(chartW, ((Math.log10(v) - logMin) / (logMax - logMin)) * chartW));
  }

  const ticks = [];
  for (let p = Math.floor(logMin); p <= Math.ceil(logMax); p++) {
    ticks.push({ val: Math.pow(10, p), x: toX(Math.pow(10, p)) });
  }

  const boxColors = [C.blue, C.orange, C.accent, C.coral, C.purple];
  const boxH = 22;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible", display: "block" }}>
      {/* grid lines */}
      {ticks.map((t, i) => (
        <line key={i} x1={leftPad + t.x} y1={topPad} x2={leftPad + t.x} y2={topPad + data.length * rowH}
          stroke={C.border} strokeDasharray="3 4" strokeOpacity={0.7} />
      ))}
      {/* x-axis line */}
      <line x1={leftPad} y1={topPad + data.length * rowH} x2={leftPad + chartW} y2={topPad + data.length * rowH} stroke={C.border} />
      {/* x ticks */}
      {ticks.map((t, i) => {
        const label = t.val >= 1e9 ? `€${(t.val / 1e9).toFixed(0)}B` : t.val >= 1e6 ? `€${(t.val / 1e6).toFixed(0)}M` : `€${t.val.toFixed(0)}`;
        return (
          <text key={i} x={leftPad + t.x} y={topPad + data.length * rowH + 16}
            textAnchor="middle" fontSize={8.5} fill={C.muted}>{label}</text>
        );
      })}
      {/* box plots */}
      {data.map((d, i) => {
        const cy = topPad + i * rowH + rowH / 2;
        const color = boxColors[i % boxColors.length];
        const xP10 = toX(d.p10), xP25 = toX(d.p25), xP50 = toX(d.p50), xP75 = toX(d.p75), xP90 = toX(d.p90);
        return (
          <g key={i} transform={`translate(${leftPad},0)`}>
            <text x={-10} y={cy + 4} textAnchor="end" fontSize={10} fill={C.light} fontWeight={600}>{d.label}</text>
            {/* Whisker */}
            <line x1={xP10} y1={cy} x2={xP90} y2={cy} stroke={color} strokeWidth={1.5} opacity={0.5} />
            <line x1={xP10} y1={cy - 7} x2={xP10} y2={cy + 7} stroke={color} strokeWidth={2} />
            <line x1={xP90} y1={cy - 7} x2={xP90} y2={cy + 7} stroke={color} strokeWidth={2} />
            {/* IQR Box */}
            <rect x={xP25} y={cy - boxH / 2} width={Math.max(1, xP75 - xP25)} height={boxH}
              fill={color} fillOpacity={0.25} stroke={color} strokeWidth={1.5} rx={3} />
            {/* Median */}
            <line x1={xP50} y1={cy - boxH / 2} x2={xP50} y2={cy + boxH / 2} stroke={color} strokeWidth={2.5} />
            <circle cx={xP50} cy={cy} r={4.5} fill={color} />
          </g>
        );
      })}
      {/* legend */}
      <text x={leftPad + chartW / 2} y={H - 6} textAnchor="middle" fontSize={8.5} fill={C.muted}>
        Log₁₀ scale (€)  •  Box = IQR (P25–P75)  •  Dot = Median  •  Whiskers = P10–P90
      </text>
    </svg>
  );
}

// === SPLIT CORRELATION MATRIX COMPONENT ===
function SplitCorrMatrix({ corrData, title, accentColor }) {
  const { labels, matrix } = corrData;
  if (!matrix || !matrix.length) return <p style={{ color: C.muted, fontSize: 11 }}>Insufficient data.</p>;
  const targetIdx = labels.findIndex(l => l === "PV★");
  return (
    <div>
      <p style={{ color: accentColor, fontSize: 10, fontWeight: 700, margin: "0 0 8px", textTransform: "uppercase", letterSpacing: 1 }}>{title}</p>
      <div style={{ overflowX: "auto" }}>
        <table className="corr-table">
          <thead>
            <tr>
              <th style={{ width: 60, minWidth: 60 }} />
              {labels.map((l, j) => (
                <th key={j} className={`corr-header ${j >= targetIdx && targetIdx >= 0 ? "corr-target" : ""}`}>
                  <div className="corr-header-inner">{l}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, i) => (
              <tr key={i}>
                <td style={{ color: C.light, fontSize: 8, textAlign: "right", paddingRight: 6, whiteSpace: "nowrap", fontWeight: i >= targetIdx && targetIdx >= 0 ? 700 : 400 }}>
                  {labels[i]}
                </td>
                {row.map((val, j) => (
                  <td key={j}
                    className={`corr-cell ${j >= targetIdx && targetIdx >= 0 ? "corr-target" : ""}`}
                    style={{ background: i === j ? "rgba(255,255,255,0.06)" : corrColor(val) }}
                    title={`${labels[i]} × ${labels[j]}: ${val}`}
                  >
                    {i === j ? "—" : (val > 0 ? "+" : "") + val.toFixed(2).replace(/^0\./, ".").replace(/^-0\./, "-.").replace(/^\./, "0.")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// === DATA OVERVIEW TAB ===
function DataOverviewSection({ correlationData, yearsInBusinessData, uniqueCompanies, totalRows, outliersData }) {
  const { featureTargetCorrs, financial: corrFinancial, ratios: corrRatios } = correlationData;
  const { pearsonR, scatterByYear } = yearsInBusinessData;

  return (
    <>
      {/* ── HERO ── */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ color: C.white, fontSize: 28, fontWeight: 700, margin: "0 0 6px", fontFamily: "'Playfair Display', Georgia, serif" }}>
          Italian Company Revenue Dataset
        </h2>
        <p style={{ color: C.muted, fontSize: 12, margin: "0 0 20px", lineHeight: 1.6 }}>
          This dataset captures financial statements for Italian companies across fiscal years 2018–2021.
          The prediction challenge: <b style={{ color: C.accent }}>forecast next-year revenue change (%)</b> from current-year financials.
          The analysis below shows why we select <b style={{ color: C.gold }}>production_value_next</b> as the primary modeling target — it is measurable, has strong feature correlations, and avoids the volatility of percentage change as a direct target.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <KPI label="Unique Companies"   value={uniqueCompanies.toLocaleString()} sub="Distinct entities"          color={C.accent} />
          <KPI label="Total Observations" value={totalRows.toLocaleString()}        sub="Company–year rows (3 yrs)"  color={C.blue}   />
          <KPI label="Features"           value="30+"                               sub="Financial & structural"     color={C.gold}   />
          <KPI label="Fiscal Years"       value="2018–2021"                         sub="4 years of statements"      color={C.purple} />
        </div>
      </div>

      {/* ── OUTLIER BEHAVIOR ── */}
      <Heading
        sub="Distribution of key monetary variables — log₁₀ scale reveals extreme right skew"
        insight="All monetary variables span 5–6 orders of magnitude. Outliers are real events (M&A, expansions) — not noise. Must use log transforms or robust scaling."
      >
        Outlier Behaviour of Monetary Variables (Log Scale)
      </Heading>
      <Card>
        <BoxPlotChart data={outliersData} />
        <div style={{ background: `${C.gold}0F`, border: `1px solid ${C.gold}25`, borderRadius: 8, padding: "10px 14px", marginTop: 12 }}>
          <p style={{ color: C.gold, fontSize: 10, fontWeight: 700, margin: "0 0 4px", textTransform: "uppercase", letterSpacing: 1 }}>How we handle outliers</p>
          <p style={{ color: C.light, fontSize: 11, lineHeight: 1.6, margin: 0 }}>
            We <b style={{ color: C.accent }}>do not remove</b> outliers — they represent real business events (mergers, rapid expansion). Instead: (1) log-transform monetary features before modeling, (2) use <b style={{ color: C.accent }}>winsorisation at P1/P99</b> for ratio features prone to division instability, and (3) rely on <b style={{ color: C.gold }}>tree-based models</b> (XGBoost, Random Forest) which are inherently robust to scale outliers.
          </p>
        </div>
      </Card>

      {/* ── SPLIT CORRELATION MATRICES (pooled) ── */}
      <Heading
        sub="Pearson correlation — split by feature type (pooled 2018–2020). ★ = prediction targets"
        insight="Financial size features correlate 0.6–0.9 with each other but <0.15 with RC★ — predicting absolute PV is far easier than % change"
      >
        Feature Correlation Matrices
      </Heading>
      <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card>
          <SplitCorrMatrix corrData={corrFinancial} title="Financial Size Features" accentColor={C.gold} />
          <p style={{ color: C.muted, fontSize: 9, marginTop: 8, marginBottom: 0 }}>★ = target columns  •  Hover cells for exact values</p>
        </Card>
        <Card>
          <SplitCorrMatrix corrData={corrRatios} title="Financial Ratios" accentColor={C.blue} />
          <p style={{ color: C.muted, fontSize: 9, marginTop: 8, marginBottom: 0 }}>★ = target columns  •  Hover cells for exact values</p>
        </Card>
      </div>

      {/* ── FEATURE → TARGET COMPARISON ── */}
      <Heading
        sub="Left: correlations with production_value_next (our target). Right: correlations with revenue_change_next (what we derive post-hoc)"
        insight="PV Next correlations (0.8–0.9) are 5–10× stronger than RC Next (<0.15) — confirming the target choice"
      >
        Why production_value_next? Feature Correlation Comparison
      </Heading>
      {featureTargetCorrs && featureTargetCorrs.length > 0 && (
        <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Card>
            <p style={{ color: C.gold, fontSize: 10, fontWeight: 700, margin: "0 0 8px", textTransform: "uppercase", letterSpacing: 1 }}>
              production_value_next — Strong Signal
            </p>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={featureTargetCorrs} layout="vertical" barCategoryGap="12%" margin={{ left: 8, right: 28, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                <XAxis type="number" domain={[-1, 1]} tick={{ fill: C.muted, fontSize: 9 }} axisLine={{ stroke: C.border }} tickFormatter={v => v.toFixed(1)} />
                <YAxis dataKey="label" type="category" tick={{ fill: C.light, fontSize: 9 }} axisLine={{ stroke: C.border }} width={80} />
                <ReferenceLine x={0} stroke={C.muted} strokeWidth={1.5} />
                <Tooltip formatter={(v) => [v.toFixed(3), "Corr with PV Next"]} contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="corrPV" name="Corr with PV Next" radius={[0, 4, 4, 0]}>
                  {featureTargetCorrs.map((d, i) => <Cell key={i} fill={d.corrPV >= 0 ? C.gold : C.coral} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
          <Card>
            <p style={{ color: C.coral, fontSize: 10, fontWeight: 700, margin: "0 0 8px", textTransform: "uppercase", letterSpacing: 1 }}>
              revenue_change_next — Weak Signal
            </p>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={featureTargetCorrs} layout="vertical" barCategoryGap="12%" margin={{ left: 8, right: 28, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                <XAxis type="number" domain={[-0.3, 0.3]} tick={{ fill: C.muted, fontSize: 9 }} axisLine={{ stroke: C.border }} tickFormatter={v => v.toFixed(1)} />
                <YAxis dataKey="label" type="category" tick={{ fill: C.light, fontSize: 9 }} axisLine={{ stroke: C.border }} width={80} />
                <ReferenceLine x={0} stroke={C.muted} strokeWidth={1.5} />
                <Tooltip formatter={(v) => [v.toFixed(3), "Corr with RC Next"]} contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="corrRC" name="Corr with RC Next" radius={[0, 4, 4, 0]}>
                  {featureTargetCorrs.map((d, i) => <Cell key={i} fill={Math.abs(d.corrRC) < 0.1 ? C.muted : d.corrRC >= 0 ? C.blue : C.coral} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}

      {/* ── YEARS IN BUSINESS — SCATTER BY YEAR ── */}
      <Heading
        sub="years_in_business vs revenue_change_next — each panel = one fiscal year, points sampled for clarity"
        insight={`Pearson r = ${pearsonR} — cloud shape is identical across all 3 years: no age-based signal whatsoever`}
      >
        Years in Business vs. Next-Year Revenue Change
      </Heading>
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {[2018, 2019, 2020].map((yr, yi) => {
            const pts = scatterByYear?.[yr] ?? [];
            const clr = [C.blue, C.accent, C.gold][yi];
            return (
              <div key={yr}>
                <p style={{ color: clr, fontSize: 10, fontWeight: 700, textAlign: "center", margin: "0 0 4px" }}>
                  fiscal_year = {yr}
                </p>
                <ResponsiveContainer width="100%" height={220}>
                  <ScatterChart margin={{ left: 12, right: 8, top: 8, bottom: 28 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis
                      dataKey="x" name="years_in_business" type="number"
                      domain={[0, 70]} tickCount={8}
                      tick={{ fill: C.muted, fontSize: 8 }} axisLine={{ stroke: C.border }}
                      label={{ value: "years_in_business", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 8 }}
                    />
                    <YAxis
                      dataKey="y" name="revenue_change_next" type="number"
                      domain={[0, 6000]}
                      tick={{ fill: C.muted, fontSize: 8 }} axisLine={{ stroke: C.border }} width={44}
                      label={{ value: "revenue_change_next", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 8, dx: -2 }}
                    />
                    <ZAxis range={[12, 12]} />
                    <Tooltip
                      cursor={{ strokeDasharray: "3 3" }}
                      formatter={(v, n) => [v, n]}
                      contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 10 }}
                    />
                    <Scatter data={pts} fill={clr} fillOpacity={0.35} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </div>
        <p style={{ color: C.muted, fontSize: 9.5, textAlign: "center", margin: "8px 0 0" }}>
          Points sampled for performance  •  y-axis capped at 6000% to show cluster structure  •  Pearson r = {pearsonR}
        </p>
        <div style={{ background: `${C.coral}10`, border: `1px solid ${C.coral}25`, borderRadius: 8, padding: "10px 14px", marginTop: 10 }}>
          <span style={{ color: C.coral, fontSize: 11, fontWeight: 600 }}>
            Key takeaway: The point cloud is structurally identical across all 3 years — dense near zero, sparse at extremes, no age gradient.
            Company age carries <b>zero predictive signal</b>. Do not include <code>years_in_business</code> as a raw feature.
          </span>
        </div>
      </Card>

      {/* ── TARGET VARIABLE CONSTRUCTION (moved to end) ── */}
      <Heading
        sub="How the prediction target is constructed"
        insight="We predict production_value_next (absolute) then derive % change — far more predictable than raw % change"
      >
        Target Variable Construction
      </Heading>
      <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 4 }}>
        <Card>
          <p style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", margin: "0 0 8px" }}>Primary Modeling Target</p>
          <div style={{ background: `${C.gold}12`, border: `1px solid ${C.gold}30`, borderRadius: 8, padding: "10px 14px", marginBottom: 10, fontFamily: "monospace", fontSize: 13, color: C.gold }}>
            production_value_next = PV<sub style={{ fontSize: 10 }}>t+1</sub>
          </div>
          <p style={{ color: C.light, fontSize: 12, lineHeight: 1.6, margin: 0 }}>
            The absolute production value of the next fiscal year, per company. Computed by shifting each company's time series by −1. This is our <b style={{ color: C.gold }}>actual model target</b> since it correlates strongly (0.8–0.9) with current-year financials.
          </p>
        </Card>
        <Card>
          <p style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", margin: "0 0 8px" }}>Business Interpretation</p>
          <div style={{ background: `${C.accent}12`, border: `1px solid ${C.accent}30`, borderRadius: 8, padding: "10px 14px", marginBottom: 10, fontFamily: "monospace", fontSize: 13, color: C.accent }}>
            revenue_change_next = (PV<sub style={{ fontSize: 10 }}>t+1</sub> − PV<sub style={{ fontSize: 10 }}>t</sub>) / PV<sub style={{ fontSize: 10 }}>t</sub> × 100
          </div>
          <p style={{ color: C.light, fontSize: 12, lineHeight: 1.6, margin: 0 }}>
            The percentage change is what clients care about, but it is <b style={{ color: C.coral }}>noisy</b> (corr &lt;0.15 with any feature). We compute it <i>post-prediction</i> from predicted PV<sub style={{ fontSize: 10 }}>t+1</sub> and observed PV<sub style={{ fontSize: 10 }}>t</sub>.
          </p>
        </Card>
      </div>
    </>
  );
}

// === MAIN DASHBOARD ===
export default function App() {
  const [appData, setAppData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState("overview");

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

  const yearColors = { overview: C.white, "2018": C.accent, "2019": C.blue, "2020": C.gold, signals: C.orange, map: C.teal, summary: C.purple, features: "#A78BFA", nextsteps: "#F472B6" };

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

  const { yearsData, crossYear, uniqueCompanies, totalRows, covidSectorImpact, signalData, regionMapData, correlationData, yearsInBusinessData, outliersData, yearsCorrelationData } = appData;
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
          Challenge 3  •  {uniqueCompanies.toLocaleString()} unique Italian companies  •  {totalRows.toLocaleString()} observations across 2018–2020  •  Target: next-year revenue change (%)
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Tab active={tab === "overview"}   onClick={() => setTab("overview")}   color={yearColors.overview}>Data Overview</Tab>
          <Tab active={tab === "2018"}       onClick={() => setTab("2018")}       color={yearColors["2018"]}>2018 → 2019</Tab>
          <Tab active={tab === "2019"}       onClick={() => setTab("2019")}       color={yearColors["2019"]}>2019 → 2020</Tab>
          <Tab active={tab === "2020"}       onClick={() => setTab("2020")}       color={yearColors["2020"]}>2020 → 2021</Tab>
          <Tab active={tab === "signals"}    onClick={() => setTab("signals")}    color={yearColors.signals}>Revenue Signals</Tab>
          <Tab active={tab === "map"}        onClick={() => setTab("map")}        color={yearColors.map}>Regional Map</Tab>
          <Tab active={tab === "summary"}    onClick={() => setTab("summary")}    color={yearColors.summary}>Summary & Comparison</Tab>
          <Tab active={tab === "features"}   onClick={() => setTab("features")}   color={yearColors.features}>Feature Engineering</Tab>
          <Tab active={tab === "nextsteps"}  onClick={() => setTab("nextsteps")}  color={yearColors.nextsteps}>What's Next</Tab>
        </div>
      </div>

      <div style={{ padding: "20px 28px 40px", maxWidth: 1180, margin: "0 auto" }}>

        {tab === "overview" && <DataOverviewSection correlationData={correlationData} yearsInBusinessData={yearsInBusinessData} uniqueCompanies={uniqueCompanies} totalRows={totalRows} outliersData={outliersData} />}
        {["2018","2019","2020"].includes(tab) && <YearSection yr={Number(tab)} yearsData={yearsData} yearsCorrelation={yearsCorrelationData[Number(tab)]} />}
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
                  <span key={i} style={{ fontSize: 9.5, color: C.muted }}>{d.tier}: <b style={{ color: C.light }}>{d.n}</b> obs.</span>
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
                        <th style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", textAlign: "right", padding: "5px 8px" }}>Observations</th>
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
                      <span key={i} style={{ fontSize: 9.5, color: C.muted }}>{d.group}: <b style={{ color: C.light }}>{d.n.toLocaleString()}</b> obs.</span>
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
              <KPI label="Total Observations" value={totalRows.toLocaleString()} sub="Company-year rows, 2018–2020 (2021 = test year)" color={C.blue} />
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
              <ResponsiveContainer width="100%" height={290}>
                <BarChart data={yearsData[2018].sizeSeg.map((s, i) => ({
                  name: s.name,
                  "2018→19": yearsData[2018].sizeSeg[i].medTarget,
                  "2019→20": yearsData[2019].sizeSeg[i].medTarget,
                  "2020→21": yearsData[2020].sizeSeg[i].medTarget,
                }))} barCategoryGap="14%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: C.light, fontSize: 9 }} axisLine={{ stroke: C.border }} angle={-30} textAnchor="end" height={54} interval={0} />
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

        {/* ── FEATURE ENGINEERING TAB ── */}
        {tab === "features" && (
          <>
            <h2 style={{ color: C.white, fontSize: 24, fontWeight: 700, margin: "0 0 6px", fontFamily: "'Playfair Display', Georgia, serif" }}>
              Feature Engineering
            </h2>
            <p style={{ color: C.muted, fontSize: 12, margin: "0 0 20px" }}>
              From raw financial statements to model-ready features — what we built, how we cleaned it, and what decisions we made
            </p>

            {/* Created Features */}
            <Heading sub="New variables derived from the raw dataset">Created Features</Heading>
            <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { name: "pv_yoy_growth", type: "Temporal", color: C.accent, desc: "(PV_t − PV_{t−1}) / PV_{t−1} × 100", body: "Year-over-year percentage change in production value. Captures momentum — the single most direct lag feature for our regression target." },
                { name: "revenue_tier", type: "Rank", color: C.gold, desc: "Decile rank of PV within each fiscal year (1–10)", body: "Non-linear size encoding. Avoids scale dominance by very large firms. Q1=smallest 10%, Q10=largest 10% within each year cross-section." },
                { name: "tier_shift", type: "Momentum", color: C.blue, desc: "tier_t − tier_{t−1}", body: "Movement in revenue decile vs. prior year. Encodes momentum: companies climbing tiers already outperform; fallen companies face mean-reversion pressure." },
                { name: "equity_gap", type: "Capital Signal", color: C.purple, desc: "(SE_t − SE_{t−1} − net_profit) / total_assets", body: "Detects hidden capital flows — equity withdrawals by shareholders signal pessimism, injections signal strategic commitment. Unique signal not visible in the P&L." },
                { name: "debt_burden", type: "Ratio", color: C.coral, desc: "total_debt / operating_income (clamped)", body: "Interest coverage proxy. High values indicate financial stress constraining investment capacity. Winsorised at P1/P99 to handle near-zero denominators." },
                { name: "asset_efficiency", type: "Ratio", color: C.orange, desc: "production_value / total_assets", body: "Asset turnover — how much revenue each euro of assets generates. Higher values signal operational efficiency. Normalises size effect on raw revenue." },
                { name: "margin_change", type: "Temporal", color: C.teal, desc: "profit_margin_t − profit_margin_{t−1}", body: "Year-over-year change in net profit margin. Captures trend in profitability efficiency, orthogonal to the raw margin level." },
                { name: "leverage_change", type: "Temporal", color: "#F472B6", desc: "leverage_t − leverage_{t−1}", body: "Change in debt/equity ratio. Rising leverage can signal growth investment or distress — combined with equity_gap this disambiguates the direction." },
              ].map((f, i) => (
                <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderLeft: `4px solid ${f.color}`, borderRadius: 8, padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <code style={{ color: f.color, fontSize: 12, fontWeight: 700 }}>{f.name}</code>
                    <span style={{ background: `${f.color}20`, color: f.color, fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 4, letterSpacing: 0.5 }}>{f.type}</span>
                  </div>
                  <p style={{ color: C.muted, fontSize: 10, fontFamily: "monospace", margin: "0 0 6px" }}>{f.desc}</p>
                  <p style={{ color: C.light, fontSize: 11, lineHeight: 1.5, margin: 0 }}>{f.body}</p>
                </div>
              ))}
            </div>

            {/* Missingness */}
            <Heading sub="How missing values are identified and treated">Handling Missingness</Heading>
            <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Card>
                <p style={{ color: C.accent, fontSize: 10, fontWeight: 700, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 1 }}>Numeric Features</p>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  {[
                    { feature: "Monetary columns", strategy: "Median per fiscal year", reason: "Right-skewed; median robust to outliers" },
                    { feature: "Ratio columns (ROI, margin…)", strategy: "Winsorise P1/P99 → median", reason: "Division instability near zero" },
                    { feature: "Temporal lag features", strategy: "Forward-fill within company", reason: "Preserves time-series continuity" },
                    { feature: "Target (revenue_change_next)", strategy: "Row excluded from training", reason: "No future info available — not imputable" },
                  ].map((r, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: "6px 8px", color: C.light, fontSize: 10 }}>{r.feature}</td>
                      <td style={{ padding: "6px 8px", color: C.accent, fontSize: 10, fontWeight: 600 }}>{r.strategy}</td>
                    </tr>
                  ))}
                </table>
                <p style={{ color: C.muted, fontSize: 9.5, margin: "8px 0 0" }}>All imputers fitted on training data only — applied to validation/test to avoid leakage</p>
              </Card>
              <Card>
                <p style={{ color: C.blue, fontSize: 10, fontWeight: 700, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 1 }}>Categorical Features</p>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  {[
                    { feature: "legal_form", strategy: "One-Hot Encoding", reason: "Low cardinality (6 classes), no ordinal order" },
                    { feature: "ateco_sector", strategy: "Target encoding (mean PV Next)", reason: "High cardinality — smoothed to avoid overfitting" },
                    { feature: "region", strategy: "Target encoding (mean PV Next)", reason: "20 regions — OHE would add too many sparse dims" },
                    { feature: "fiscal_year", strategy: "Integer feature + year dummies", reason: "Captures temporal trend and COVID fixed effect" },
                  ].map((r, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: "6px 8px", color: C.light, fontSize: 10 }}>{r.feature}</td>
                      <td style={{ padding: "6px 8px", color: C.blue, fontSize: 10, fontWeight: 600 }}>{r.strategy}</td>
                    </tr>
                  ))}
                </table>
                <p style={{ color: C.muted, fontSize: 9.5, margin: "8px 0 0" }}>Target encoding computed on training fold only to prevent leakage into validation</p>
              </Card>
            </div>

            {/* Feature Selection */}
            <Heading sub="How we will decide which engineered features make it into the final model">Feature Selection Strategy</Heading>
            <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { num: "1", color: C.accent, title: "Correlation Filter", body: "Remove features with |Pearson r| < 0.02 against production_value_next. Eliminates pure noise while keeping weak but potentially non-linear predictors." },
                { num: "2", color: C.gold, title: "Mutual Information Ranking", body: "sklearn's mutual_info_regression captures non-linear associations. Revenue tier, tier_shift and equity_gap score well despite modest Pearson r." },
                { num: "3", color: C.purple, title: "SHAP Importance (post-model)", body: "After fitting XGBoost, SHAP values reveal true contribution per feature per sample. Final selection based on mean |SHAP| across validation set." },
                { num: "4", color: C.blue, title: "VIF Multicollinearity Check", body: "Financial size features (PV, assets, equity, debt) correlate 0.85–0.97 with each other. We keep only production_value + ratio-derived features to reduce multicollinearity." },
              ].map((t, i) => (
                <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderLeft: `4px solid ${t.color}`, borderRadius: 8, padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 24, height: 24, borderRadius: "50%", background: t.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: C.bg }}>{t.num}</div>
                    <span style={{ color: C.white, fontSize: 13, fontWeight: 700 }}>{t.title}</span>
                  </div>
                  <p style={{ color: C.light, fontSize: 11, lineHeight: 1.55, margin: 0 }}>{t.body}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── WHAT'S NEXT TAB ── */}
        {tab === "nextsteps" && (
          <>
            <h2 style={{ color: C.white, fontSize: 24, fontWeight: 700, margin: "0 0 6px", fontFamily: "'Playfair Display', Georgia, serif" }}>
              What's Next — From EDA to Model
            </h2>
            <p style={{ color: C.muted, fontSize: 12, margin: "0 0 20px" }}>
              The road ahead: how we will conquer the hardest parts of this forecasting challenge
            </p>

            {/* Cross-validation strategy illustration */}
            <Heading sub="Time-aware split — no future information ever reaches the past">Cross-Validation Strategy</Heading>
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { label: "Fold 1", blocks: [
                    { yr: "2018", role: "Train" }, { yr: "2019", role: "Train" },
                    { yr: "2020", role: "Validation" }, { yr: "2021", role: "Holdout" },
                    { yr: "2022", role: "Test (blind)" }, { yr: "2023", role: "Test (blind)" },
                  ]},
                  { label: "Fold 2", blocks: [
                    { yr: "2018", role: "Train" }, { yr: "2019", role: "Train" }, { yr: "2020", role: "Train" },
                    { yr: "2021", role: "Validation" },
                    { yr: "2022", role: "Test (blind)" }, { yr: "2023", role: "Test (blind)" },
                  ]},
                ].map((fold, fi) => {
                  const roleColor = { "Train": C.blue, "Validation": C.gold, "Holdout": C.purple, "Test (blind)": C.coral };
                  return (
                    <div key={fi} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ color: C.white, fontSize: 13, fontWeight: 700, minWidth: 58 }}>{fold.label}</span>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {fold.blocks.map((b, bi) => (
                          <div key={bi} style={{
                            background: `${roleColor[b.role]}30`, border: `2px solid ${roleColor[b.role]}`,
                            borderRadius: 8, padding: "10px 18px", textAlign: "center", minWidth: 68,
                          }}>
                            <div style={{ color: C.white, fontSize: 13, fontWeight: 700 }}>{b.yr}</div>
                            <div style={{ color: roleColor[b.role], fontSize: 9, fontWeight: 600, marginTop: 3 }}>{b.role}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 14 }}>
                {[["Train", C.blue], ["Validation", C.gold], ["Holdout", C.purple], ["Test (blind)", C.coral]].map(([label, color]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 14, height: 14, borderRadius: 3, background: color }} />
                    <span style={{ color: C.light, fontSize: 10 }}>{label}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Model pipeline */}
            <Heading sub="Models we will train and compare">Planned Model Pipeline</Heading>
            <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { name: "Ridge Regression", color: C.blue, tag: "Baseline", pros: ["Interpretable coefficients", "Fast to train", "L2 regularisation handles multicollinearity"], cons: ["Linear only — misses tier non-linearities", "Sensitive to outlier scale"] },
                { name: "Random Forest", color: C.accent, tag: "Ensemble", pros: ["Handles non-linearities natively", "Robust to outliers", "Built-in feature importance"], cons: ["Slower on large feature sets", "Memory intensive", "No extrapolation"] },
                { name: "XGBoost", color: C.gold, tag: "Primary", pros: ["State-of-the-art on tabular data", "Handles missing values natively", "SHAP-compatible for interpretation"], cons: ["Hyperparameter sensitive", "Needs careful CV to avoid overfit"] },
                { name: "LightGBM", color: C.purple, tag: "Alternative", pros: ["Faster than XGBoost on large data", "Excellent on imbalanced targets", "Leaf-wise growth"], cons: ["Less interpretable defaults", "Slightly less stable than XGBoost on small data"] },
              ].map((m, i) => (
                <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderTop: `3px solid ${m.color}`, borderRadius: 8, padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <span style={{ color: C.white, fontSize: 14, fontWeight: 700 }}>{m.name}</span>
                    <span style={{ background: `${m.color}25`, color: m.color, fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 4 }}>{m.tag}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div>
                      <p style={{ color: C.accent, fontSize: 9, fontWeight: 700, margin: "0 0 4px", textTransform: "uppercase" }}>Strengths</p>
                      {m.pros.map((p, pi) => <p key={pi} style={{ color: C.light, fontSize: 10, margin: "0 0 3px", lineHeight: 1.4 }}>✓ {p}</p>)}
                    </div>
                    <div>
                      <p style={{ color: C.coral, fontSize: 9, fontWeight: 700, margin: "0 0 4px", textTransform: "uppercase" }}>Challenges</p>
                      {m.cons.map((c, ci) => <p key={ci} style={{ color: C.muted, fontSize: 10, margin: "0 0 3px", lineHeight: 1.4 }}>✗ {c}</p>)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Key challenges ahead */}
            <Heading sub="The hardest problems we will face — and how we plan to tackle them">Key Challenges Ahead</Heading>
            <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { icon: "⚡", color: C.coral, title: "Extreme Tails (IQR ≈ 300pp)", body: "~35% of companies see >100% revenue change. Standard RMSE is dominated by these events. Plan: train on log-transformed target, evaluate directional accuracy separately from magnitude error." },
                { icon: "⏱", color: C.gold, title: "Temporal Non-Stationarity", body: "COVID (2019→20) created a structural break. Models trained pre-COVID underperform on recovery data. Plan: year fixed effects + separate error analysis by year to detect and correct for drift." },
                { icon: "🔬", color: C.purple, title: "Weak Signal-to-Noise", body: "No feature correlates >0.15 with revenue_change_next directly. We need non-linear combinations. Plan: interaction features (size × sector), tree ensembles, and SHAP to validate signal quality." },
                { icon: "🏗", color: C.blue, title: "Evaluation Metric Alignment", body: "MAPE penalises small-revenue companies disproportionately. Directional accuracy matters most to stakeholders. Plan: report RMSE, MAPE, directional accuracy, and decile-wise MAE jointly." },
              ].map((t, i) => (
                <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderLeft: `4px solid ${t.color}`, borderRadius: 8, padding: "16px 18px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 18 }}>{t.icon}</span>
                    <span style={{ color: C.white, fontSize: 13, fontWeight: 700 }}>{t.title}</span>
                  </div>
                  <p style={{ color: C.light, fontSize: 11, lineHeight: 1.55, margin: 0 }}>{t.body}</p>
                </div>
              ))}
            </div>

            <div style={{ background: `${C.accent}0F`, border: `1px solid ${C.accent}30`, borderRadius: 10, padding: "18px 22px", marginTop: 8 }}>
              <p style={{ color: C.accent, fontSize: 14, fontWeight: 700, margin: "0 0 8px", fontFamily: "'Playfair Display', Georgia, serif" }}>
                Our Commitment
              </p>
              <p style={{ color: C.light, fontSize: 12, lineHeight: 1.7, margin: 0 }}>
                The signal is weak, the distribution is wild, and the tails are real — but that is exactly what makes this challenge interesting.
                We have built a rigorous EDA foundation, identified the structural drivers, engineered meaningful features, and designed a leakage-proof validation strategy.
                The next phase is model development, hyperparameter optimisation, SHAP interpretation, and final evaluation.
                We will not just predict — we will explain.
              </p>
            </div>
          </>
        )}

        <div style={{ marginTop: 36, paddingTop: 12, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 4 }}>
          <p style={{ color: C.muted, fontSize: 9.5, margin: 0 }}>Target: revenue_change_next = (production_value_next − production_value) / production_value × 100  •  Shift(−1) per company</p>
          <p style={{ color: C.muted, fontSize: 9.5, margin: 0 }}>Source: train_data.csv  •  Training data only — no data leakage</p>
        </div>
      </div>
    </div>
  );
}
