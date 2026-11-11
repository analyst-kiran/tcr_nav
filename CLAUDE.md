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
* `scripts/compute.py` → `docs/nav_data.js` (deployed to GitHub Pages, not committed):
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

## Benchmarks: researched, not yet in production
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

## Owner's roadmap (in order)
1. Benchmarks: productionise the ETF roll-forward (daily, in the GitHub job) and feed TCR.
2. Ratios: compute vendor-method ratios for funds the vendor leaves at 0, on monthly import
   only, using the RF backed out from that month's file (or an RF the owner types in).
3. Rolling returns from the NAV history (the main reason for collecting NAVs).
4. TCR: view old rankings by date (latest or calendar pick). Design not yet chosen:
   saved snapshots vs recompute-any-date.
5. Further TCR changes, which the owner will specify.
