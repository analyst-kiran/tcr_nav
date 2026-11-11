# Notes for Claude (project handover)

This repo is the data layer for the owner's TCR fund-rating model (a single HTML file kept
**private, not in this repo**: the owner re-uploads it, plus the monthly vendor Excel exports,
in each new chat). This repo is public, so never commit the TCR html, vendor files or
anything derived from them that identifies the owner.

## What exists (working, in production)
* `scripts/update.py`: GitHub Actions runs it 3×/day (`.github/workflows/daily-nav.yml`).
  AMFI NAV history report (catch-up from last stored date − 5 days) + NAVAll.txt (newest day);
  mfapi.in fallback. Classification (Regular + Growth + open-ended, no ETFs) uses only the
  history report's full scheme name. NAVAll short names can't tell Direct from Regular.
* `data/nav/YYYY/YYYY-MM.parquet`: code, date, nav. ~1,770 schemes, 2006 → today, from
  mfapi.in full history (the Kaggle dump was rejected: about a third of days missing).
* `scripts/compute.py` → `docs/nav_data.js`, `docs/bench_px.js`, `docs/hist/<year>.js` (Pages only):
  https://analyst-kiran.github.io/tcr_nav/nav_data.js
* `tcr/live_nav.js` + `tcr/patch_tcr.py`: patch for the TCR html. It loads the feed, matches
  vendor rows to AMFI codes by NAV on the vendor's NAV date plus a name/AMC check, and
  overlays NAV, trailing and calendar returns before `runModel` scores.

## Verified conventions (match the vendor exports, 98–99% exact to 0.01%)
* NAV on a date = last NAV on/before it. As-of = latest fully published NAV date.
* ≤2Y: start = asof − period; <1Y absolute, 1–2Y CAGR ^(1/y).
* ≥3Y: start = asof − period + 1 day; CAGR ^(365/inclusive days).
* Calendar year: NAV on/before 1 Jan → NAV on/before 31 Dec (current year to as-of).
* Vendor risk-free rate backs out to 5.63% for every AMC (Mean − Sharpe×SD). Vendor gives
  no ratios (zeros) for ~58% of funds. Their SD looks like 3Y monthly, annualised
  (corr 0.998), but the exact window is not yet pinned down.

## Benchmarks: in production (ETF roll-forward)
No free official daily index feed (NSE/BSE refuse automated access; do not bypass bot checks).
Approach tested: anchor each benchmark at the vendor's exact month-end level, then roll
forward with ETF NAV ratios (AMFI data). The vendor's trailing and calendar returns imply
~15 true index levels, used to backtest anchor→target windows of 1–5 months:
* ETFs need **unit-split adjustment** (69 ETFs have ×0.1 / ×0.01 jumps).
* Strict index-name matching only (loose matching paired BSE indices with Nifty ETFs).
* Price-index benchmarks: optional dividend drift estimated from calendar 2024.
* Composites: LargeMidcap 250 = 50% Nifty 100 ETF + 50% Midcap 150 ETF (0.018%/30d);
  CRISIL hybrids = Nifty 50 ETF + debt leg (~0.10–0.15%/30d); Arbitrage ≈ arbitrage fund.
* 21 of the 24 benchmarks TCR uses are covered, median error ~0.02%/30 days. No passive tracker
  exists for Nifty Services Sector, Nifty 100 ESG or Nifty Transportation & Logistics.
* Production: `data/benchmark_map.json` (built by `scripts/build_bench_map.py` from vendor files,
  run locally), tracker NAVs in `data/proxy/` (seeded by `scripts/seed_proxies.py`, appended
  daily by update.py), published as `docs/bench_px.js`. `tcr/live_nav.js` anchors each benchmark
  at the vendor-implied levels (exact there), follows the tracker between anchors (residual spread
  geometrically), and uses tracker + last-year drift after the last anchor.
* VENDOR QUIRK: benchmark rows' "2 YEARS" is an ABSOLUTE return; fund rows' "2 YEARS" is CAGR.
  Anchors read it as absolute; live output publishes benchmark 2Y as CAGR (like funds).
  Verified on 1,171 values: everything else is reproduced exactly at the vendor date.
* Correction & recovery cycle analysis (idea from debpal/BharatFinTrack, MIT) is wanted later,
  alongside rolling returns.

## Owner's roadmap (in order)
1. ~~Benchmarks~~ DONE (ETF roll-forward live in the job and in TCR).
2. ~~Ratios~~ DONE. Vendor method pinned (99.3–100% exact): 36 month-end returns ending the
   month-end BEFORE the as-of month; SD = sample SD×√12; Mean = avg×12; Sharpe = (Mean−RF)/SD;
   Sortino = (Mean−RF)/(sample SD of months below the fund's mean ×√12). RF = median(Mean−Sharpe×SD)
   of the file (5.63% in Oct 2026) or user override. Blank ratios filled from ≥12 months.
3. ~~Rolling returns~~ DONE: `tcr/live_engine.js` builds RR_RAW (1/2/3/5/7/10Y, daily starts,
   N-year window, default 5) and calls TCR's own computeRollingRatings() → Rolling tab.
4. ~~Calendar~~ DONE (option B): NAV button → panel (as-of date, live on/off, RF, rolling window).
   Rebuilding at the vendor date reproduces the file 99–100% (funds) / 100% (benchmarks).
   CY_ASON is set to the shown date during runs (the file title's date would mark years complete).
4b. ~~Correction & recovery cycles~~ DONE (fund drawer section; falls ≥10%, max fall 3Y/5Y vs benchmark).
5. DONE this round (tcr/live_engine.js):
   * Captures: panel "Capture source" = Investwell Top Schemes (default, latest) or NAV/TCR formula
     (36 months vs category benchmark, all funds; always used for past dates). Investwell's own method
     could not be reproduced (no variant matched exactly); NAV values land close (usually within a few pts).
   * Calendar periods: Y / H / Q / M (9/10/12/36 complete + running), funds and benchmarks from history.
   * Benchmark trackers now splice up to 2 older trackers of the same index (data/benchmark_map.json
     "history"), so series reach back far enough for captures/drawdowns (Smallcap 250 ETF alone had ~1y).
   * Score history: quiet runModel at 60 month-ends + quarter-ends since 2015 (patch adds an early
     return before rendering when LIVE_SILENT); ~35 s, cached in IndexedDB per files+settings.
     Drawer: score now / 1Y avg / all-time avg / deviation / σ / rank, why (pillar Δ × TCR weights
     T20 C40 R20 Cons20), sparkline. Signals pop-up: rising stars, turnarounds, fading, backtest.
   * Backtest (Nov 2026 run): top quartile beats category avg by +0.49 pts/yr (58% of cases);
     strong in Multi Asset, Flexi Cap, BAF; zero/negative in Large/Mid/Small Cap, Value, Technology.
   * Benchmark sources pop-up documents the benchmark data flow.
6. NEXT: manager-change flag, AUM-flow signals (whitelist AUM history), behaviour in the last fall,
   capture trend, style drift; weight tuning from the backtest.
