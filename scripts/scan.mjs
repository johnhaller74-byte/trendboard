#!/usr/bin/env node
/**
 * Trendboard cloud scanner
 * Runs on GitHub Actions. Fetches market data, computes scores, writes data/market.json.
 * No dependencies — Node 20+ native fetch only.
 *
 * Env:
 *   TWELVEDATA_KEY  (required) daily history + symbol directory
 *   FINNHUB_KEY     (required) wide metric scan, insiders, earnings
 *   SCAN_LIMIT      (optional) cap universe size — use 50 for a fast first test
 *   DEEP_N          (optional) how many finalists get full history (default 60)
 */

import { writeFile, mkdir } from "node:fs/promises";

const TD_KEY = process.env.TWELVEDATA_KEY;
const FH_KEY = process.env.FINNHUB_KEY;
const SCAN_LIMIT = process.env.SCAN_LIMIT ? +process.env.SCAN_LIMIT : 0;
const DEEP_N = process.env.DEEP_N ? +process.env.DEEP_N : 60;

if (!TD_KEY || !FH_KEY) {
  console.error("Missing TWELVEDATA_KEY or FINNHUB_KEY environment variables.");
  process.exit(1);
}

const BENCH = "SPY";
const SECTOR_ETFS = ["XLK","XLC","XLV","XLF","XLY","XLP","XLI","XLE","XLB","XLU","XLRE"];
const SECTOR_NAMES = {XLK:"Tech",XLC:"Comms",XLV:"Health",XLF:"Financials",XLY:"Cons. Disc.",
  XLP:"Staples",XLI:"Industrials",XLE:"Energy",XLB:"Materials",XLU:"Utilities",XLRE:"Real Estate"};
const SECTOR_RULES = [
  [/semicond|software|technolog|electronic|computer|hardware|it service/i,"XLK"],
  [/media|entertain|telecom|communicat|interactive|broadcast/i,"XLC"],
  [/pharma|biotech|health|medical|life science|diagnostic/i,"XLV"],
  [/bank|financial|insur|capital market|asset manag|credit|exchange/i,"XLF"],
  [/real estate|reit/i,"XLRE"],
  [/oil|gas|energy|coal|pipeline|drilling/i,"XLE"],
  [/utilit|electric power|water supply/i,"XLU"],
  [/aerospace|defense|industrial|machin|transport|airline|rail|construction|engineer|logistic|building/i,"XLI"],
  [/retail|apparel|auto|hotel|restaurant|leisure|luxur|homebuild|travel|e-commerce|footwear|consumer discret/i,"XLY"],
  [/food|beverage|tobacco|household|staple|grocer|personal product/i,"XLP"],
  [/chemical|mining|metal|paper|packag|material|steel|gold/i,"XLB"],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);

/* ---------- rate-limited fetchers ---------- */
let tdLast = 0, fhLast = 0;
const TD_GAP = 8600;  // ~7 calls/min, safely under the 8 credits/min free cap
const FH_GAP = 1100;  // ~55 calls/min, safely under 60/min

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 429) { await sleep(61000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}
async function td(path) {
  const wait = TD_GAP - (Date.now() - tdLast);
  if (wait > 0) await sleep(wait);
  tdLast = Date.now();
  const j = await getJSON(`https://api.twelvedata.com/${path}${path.includes("?") ? "&" : "?"}apikey=${TD_KEY}`);
  if (j && j.status === "error") throw new Error(`TwelveData: ${j.message || j.code}`);
  return j;
}
async function fh(path) {
  const wait = FH_GAP - (Date.now() - fhLast);
  if (wait > 0) await sleep(wait);
  fhLast = Date.now();
  return getJSON(`https://finnhub.io/api/v1/${path}${path.includes("?") ? "&" : "?"}token=${FH_KEY}`);
}

/* ---------- math ---------- */
const sma = (c, p, at) => {
  if (at + 1 < p || at >= c.length) return null;
  let s = 0; for (let i = at - p + 1; i <= at; i++) s += c[i];
  return s / p;
};
const scale = (v, lo, hi, pts) =>
  (v === null || v === undefined || !isFinite(v)) ? 0 : Math.max(0, Math.min(pts, (v - lo) / (hi - lo) * pts));
function volAnnualized(c, look) {
  const n = Math.min(look, c.length - 1);
  if (n < 20) return null;
  const r = [];
  for (let i = c.length - n; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const va = r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1);
  return Math.sqrt(va) * Math.sqrt(252) * 100;
}
function maThrust(c) {
  const i = c.length - 1;
  const a = sma(c,50,i), b = sma(c,150,i), ap = sma(c,50,i-21), bp = sma(c,150,i-21);
  if ([a,b,ap,bp].some(x => x === null)) return null;
  const s = (a - b) / b * 100, sp = (ap - bp) / bp * 100;
  return { s, d: s - sp };
}
function accumDays(c, v, look = 50) {
  const n = Math.min(look, c.length - 1);
  if (n < 25 || !v || v.length !== c.length) return null;
  let avg = 0; for (let i = c.length - n; i < c.length; i++) avg += v[i];
  avg /= n; if (!avg) return null;
  let up = 0, dn = 0;
  for (let i = c.length - n; i < c.length; i++) {
    if (v[i] > 1.2 * avg) { if (c[i] > c[i-1]) up++; else if (c[i] < c[i-1]) dn++; }
  }
  return up - dn;
}
const ret = (c, bars) => c.length > bars ? (c[c.length-1] / c[c.length-1-bars] - 1) * 100 : null;

/* ---------- scoring ---------- */
function trendScore(c, v, spyC, bonuses = {}) {
  if (!c || c.length < 60) return null;
  const i = c.length - 1, px = c[i];
  const ma50 = sma(c,50,i), ma150 = sma(c,150,i), ma200 = sma(c,200,i);
  const ma200p = c.length > 221 ? sma(c,200,i-21) : null;
  const yr = c.slice(Math.max(0, c.length - 252));
  const lo52 = Math.min(...yr), hi52 = Math.max(...yr);
  let m121 = null;
  if (c.length > 252) m121 = (c[i-21] / c[i-252] - 1) * 100;
  else if (c.length > 130) m121 = (c[i-21] / c[i-126] - 1) * 100;
  const r6 = ret(c, 126);
  const spy6 = spyC && spyC.length > 126 ? (spyC[spyC.length-1] / spyC[spyC.length-1-126] - 1) * 100 : null;
  const th = maThrust(c), acc = accumDays(c, v), vol = volAnnualized(c, 63);

  let s = 0;
  if (ma50 !== null && px > ma50) s += 6;
  if (ma50 !== null && ma150 !== null && ma50 > ma150) s += 6;
  if (ma150 !== null && ma200 !== null && ma150 > ma200) s += 6;
  if (ma200 !== null && ma200p !== null && ma200 > ma200p) s += 6;
  if (px >= lo52 * 1.25) s += 3;
  s += scale(px / hi52, 0.75, 1.0, 3);
  s += scale(m121, -10, 60, 20);
  s += spy6 === null ? 0 : scale((r6 ?? 0) - spy6, -10, 20, 15);
  s += th === null ? 0 : (th.s > 0 ? 4 : 0) + scale(th.d, -1, 2, 6);
  s += acc === null ? 0 : scale(acc, -4, 8, 10);
  s += vol === null ? 0 : scale(60 - vol, 0, 40, 10);

  // bonuses (max +15)
  const b = Math.min(15, (bonuses.insider || 0) + (bonuses.earnings || 0) + (bonuses.sector || 0));
  s += b;

  const ext = ma50 ? (px / ma50 - 1) * 100 : null;
  if (ext !== null && ext > 15) s -= scale(ext, 15, 40, 10);
  s = Math.max(0, Math.min(100, s));

  let regimeOk = true;
  if (spyC && spyC.length >= 200) {
    const m = sma(spyC, 200, spyC.length - 1);
    if (m !== null && spyC[spyC.length-1] < m) { s *= 0.6; regimeOk = false; }
  }
  return { score: Math.round(s), ext, ma50, ma150, ma200, hi52, lo52, regimeOk, m121, r6, vol, acc,
           thrust: th ? +th.d.toFixed(2) : null };
}

function trendPhase(c) {
  if (!c || c.length < 210) return null;
  const i = c.length - 1, px = c[i];
  const ma200 = sma(c,200,i), ma200p = sma(c,200,i-21);
  if (ma200 === null || ma200p === null) return null;
  const slope = (ma200 / ma200p - 1) * 100;
  const ma200S = [];
  { let run = 0; for (let k = 0; k < c.length; k++) { run += c[k]; if (k >= 200) run -= c[k-200];
      ma200S.push(k >= 199 ? run / 200 : null); } }
  let bars = 0;
  for (let k = i; k >= 199; k--) { if (ma200S[k] === null || c[k] < ma200S[k]) break; bars++; }
  const months = Math.round(bars / 21);
  const gain = bars > 0 ? (px / c[Math.max(0, i - bars)] - 1) * 100 : null;
  if (px > ma200 && slope > 0.15) return { stage: "Uptrend", months, gain: gain === null ? null : +gain.toFixed(0) };
  if (px > ma200) return { stage: "Topping risk", months, gain: gain === null ? null : +gain.toFixed(0) };
  if (slope < -0.1) return { stage: "Downtrend", months: 0, gain: null };
  return { stage: "Basing", months: 0, gain: null };
}

function entrySignal(sc, c, earnDays) {
  if (!sc || !c) return "—";
  const i = c.length - 1, px = c[i];
  if (sc.score < 65 || (sc.ma150 !== null && px < sc.ma150)) return "No setup";
  if (!sc.regimeOk) return "Wait — market";
  if (earnDays !== null && earnDays !== undefined && earnDays >= 0 && earnDays <= 7) return "Wait — earnings";
  if (c.length > 11) {
    let worst = 0;
    for (let k = c.length - 10; k < c.length; k++) { const d = (c[k]/c[k-1] - 1) * 100; if (d < worst) worst = d; }
    if (worst <= -7 || (px / c[c.length-11] - 1) * 100 <= -12) return "Watch — volatile";
  }
  if (sc.ma50 === null) return "—";
  if (px < sc.ma50) return "Watch — testing 50D";
  if (sc.ext <= 8) return "Buy zone";
  if (sc.ext <= 15) return "Near zone";
  return "Wait — extended";
}

/* ---------- data pulls ---------- */
async function history(sym) {
  const j = await td(`time_series?symbol=${encodeURIComponent(sym)}&interval=1day&outputsize=5000`);
  if (!j.values || !j.values.length) throw new Error(`${sym}: no history`);
  const v = j.values.slice().reverse();
  return { dates: v.map(x => x.datetime), closes: v.map(x => +x.close), volumes: v.map(x => +x.volume || 0) };
}
async function universe() {
  const seen = new Set(), list = [];
  for (const mic of ["XNAS","XNYS","XASE"]) {
    const j = await td(`stocks?mic_code=${mic}`);
    for (const t of (j.data || [])) {
      if (t.type === "Common Stock" && t.symbol && !t.symbol.includes(" ") && !seen.has(t.symbol)) {
        seen.add(t.symbol);
        list.push({ s: t.symbol, n: t.name || t.symbol });
      }
    }
  }
  list.sort((a, b) => a.s.localeCompare(b.s));
  return list;
}

/* ---------- main ---------- */
async function main() {
  const started = Date.now();
  const out = { generated: new Date().toISOString(), errors: [] };

  // 1. Benchmark + sectors
  log("Fetching benchmark and sector ETFs…");
  const bench = await history(BENCH);
  const spyC = bench.closes;
  const spyMA = sma(spyC, 200, spyC.length - 1);
  out.regime = { spy: +spyC[spyC.length-1].toFixed(2), ma200: spyMA ? +spyMA.toFixed(2) : null,
                 uptrend: spyMA !== null ? spyC[spyC.length-1] > spyMA : null };

  const sectors = [];
  for (const etf of SECTOR_ETFS) {
    try {
      const h = await history(etf);
      sectors.push({ etf, name: SECTOR_NAMES[etf], w1: ret(h.closes,5), m1: ret(h.closes,21), m3: ret(h.closes,63) });
    } catch (e) { out.errors.push(`${etf}: ${e.message}`); }
  }
  sectors.sort((a, b) => (b.m3 ?? -999) - (a.m3 ?? -999));
  sectors.forEach((s, i) => { s.rank = i + 1; ["w1","m1","m3"].forEach(k => { if (s[k] !== null) s[k] = +s[k].toFixed(2); }); });
  out.sectors = sectors;
  const topSectors = sectors.slice(0, 3).map(s => s.etf);

  // 2. Universe
  log("Loading symbol directory…");
  let univ = await universe();
  if (SCAN_LIMIT) univ = univ.slice(0, SCAN_LIMIT);
  log(`Universe: ${univ.length} symbols`);

  // 3. Stage 1 — wide metric scan via Finnhub
  const spy26 = ret(spyC, 126);
  const cand = [];
  let done = 0;
  for (const u of univ) {
    done++;
    if (done % 100 === 0) log(`Stage 1: ${done}/${univ.length} (${cand.length} candidates)`);
    try {
      const j = await fh(`stock/metric?symbol=${encodeURIComponent(u.s)}&metric=all`);
      const m = j && j.metric;
      if (!m) continue;
      const r26 = m["26WeekPriceReturnDaily"], r52 = m["52WeekPriceReturnDaily"];
      if (r26 === null || r26 === undefined || r26 <= 0) continue;
      const volRaw = m["3MonthAverageTradingVolume"] ?? m["10DayAverageTradingVolume"] ?? 0;
      const volM = volRaw > 1e5 ? volRaw / 1e6 : volRaw;
      cand.push({ sym: u.s, name: u.n, r13: m["13WeekPriceReturnDaily"] ?? null, r26,
                  r52: r52 ?? null, hi52: m["52WeekHigh"] ?? null, volM, beta: m["beta"] ?? null });
    } catch (e) { /* skip individual failures */ }
  }
  log(`Stage 1 complete: ${cand.length} candidates with positive 26w return`);

  // rough rank, then take the deep pool
  for (const c of cand) {
    const mom = (c.r26 ?? -99) * 0.5 + (c.r52 ?? -99) * 0.5;
    c.s1 = Math.round(
      scale(mom, 0, 120, 40) +
      (spy26 === null ? 15 : scale((c.r26 ?? 0) - spy26, -10, 40, 30)) +
      20 + // high proximity resolved in stage 2 with real price
      (c.beta === null || !isFinite(c.beta) ? 5 : scale(2.0 - c.beta, 0, 1.2, 10))
    );
  }
  cand.sort((a, b) => b.s1 - a.s1);
  const pool = cand.slice(0, Math.min(DEEP_N * 3, cand.length));

  // 4. Quotes on the pool (Finnhub, fast) → apply price & liquidity floors
  log(`Price-checking ${pool.length} finalists…`);
  const finalists = [];
  for (const c of pool) {
    try {
      const q = await fh(`quote?symbol=${encodeURIComponent(c.sym)}`);
      const px = +q.c;
      if (!isFinite(px) || px < 5) continue;
      const dv = px * (c.volM || 0);       // $M/day
      if (dv < 20) continue;
      finalists.push({ ...c, price: px, dv: Math.round(dv) });
    } catch (e) { /* skip */ }
  }
  finalists.sort((a, b) => b.s1 - a.s1);
  const deep = finalists.slice(0, DEEP_N);
  log(`${finalists.length} passed filters; deep-scanning top ${deep.length}`);

  // 5. Stage 2 — full history + score
  const rankings = [];
  for (const c of deep) {
    try {
      const h = await history(c.sym);
      let bonuses = {}, earnDays = null, surprise = null, insiders = 0;
      try {
        const ins = await fh(`stock/insider-transactions?symbol=${encodeURIComponent(c.sym)}`);
        const cutoff = Date.now() - 90 * 86400000;
        const buyers = new Set();
        for (const t of (ins.data || [])) {
          const dt = Date.parse(t.transactionDate || t.filingDate || "");
          if (t.transactionCode === "P" && isFinite(dt) && dt >= cutoff) buyers.add(t.name);
        }
        insiders = buyers.size;
        bonuses.insider = insiders >= 3 ? 5 : insiders === 2 ? 3.5 : insiders === 1 ? 2 : 0;
      } catch (e) {}
      try {
        const ea = await fh(`stock/earnings?symbol=${encodeURIComponent(c.sym)}&limit=1`);
        const l = Array.isArray(ea) && ea.length ? ea[0] : null;
        if (l && l.period) {
          const age = (Date.now() - Date.parse(l.period)) / 86400000;
          if (age >= 0 && age <= 100 && isFinite(+l.surprisePercent)) surprise = +l.surprisePercent;
        }
        const r21 = ret(h.closes, 21);
        bonuses.earnings = (surprise !== null && surprise > 0 && (r21 ?? 0) > 0) ? scale(surprise, 0, 10, 5) : 0;
      } catch (e) {}
      try {
        const p = await fh(`stock/profile2?symbol=${encodeURIComponent(c.sym)}`);
        const ind = (p && p.finnhubIndustry) || "";
        let sec = null;
        for (const [re, etf] of SECTOR_RULES) if (re.test(ind)) { sec = etf; break; }
        c.sector = sec;
        c.industry = ind;
        const idx = sec ? topSectors.indexOf(sec) : -1;
        bonuses.sector = idx === 0 ? 5 : (idx === 1 || idx === 2) ? 3 : 0;
      } catch (e) {}

      const sc = trendScore(h.closes, h.volumes, spyC, bonuses);
      if (!sc) continue;
      const ph = trendPhase(h.closes);
      rankings.push({
        sym: c.sym, name: c.name, price: +c.price.toFixed(2), dv: c.dv,
        score: sc.score, entry: entrySignal(sc, h.closes, earnDays),
        ext: sc.ext === null ? null : +sc.ext.toFixed(1),
        r13: c.r13 === null ? null : +c.r13.toFixed(1),
        r26: +c.r26.toFixed(1), r52: c.r52 === null ? null : +c.r52.toFixed(1),
        m1: (x => x === null ? null : +x.toFixed(1))(ret(h.closes, 21)),
        sector: c.sector || null, industry: c.industry || null,
        insiders, surprise: surprise === null ? null : +surprise.toFixed(1),
        stage: ph ? ph.stage : null, runMonths: ph ? ph.months : null, runGain: ph ? ph.gain : null,
        nearHigh: sc.hi52 ? c.price >= sc.hi52 * 0.98 : false
      });
      log(`  ${c.sym}: score ${sc.score} · ${rankings[rankings.length-1].entry}`);
    } catch (e) {
      out.errors.push(`${c.sym}: ${e.message}`);
    }
  }
  rankings.sort((a, b) => b.score - a.score);
  out.rankings = rankings;
  out.stats = { universe: univ.length, candidates: cand.length, passedFilters: finalists.length,
                deepScanned: rankings.length, minutes: +((Date.now() - started) / 60000).toFixed(1) };

  await mkdir("data", { recursive: true });
  await writeFile("data/market.json", JSON.stringify(out, null, 1));
  log(`Done in ${out.stats.minutes} min — ${rankings.length} ranked, ${out.errors.length} errors`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
                     
