# tcr-nav

Daily Indian mutual fund NAVs for the TCR Rating Model, collected automatically by GitHub.

**Universe:** open-ended, Regular plan, Growth option schemes that are still publishing NAVs
(about 1,770). No Direct plans, IDCW options, ETFs or closed/merged schemes.

## How it works

```
every night (GitHub Actions)                       TCR html on your computer
┌───────────────────────────────────────┐          ┌─────────────────────────────┐
│ scripts/update.py                     │          │ loads nav_data.js from      │
│  1. AMFI NAV history report: every    │          │ https://<you>.github.io/    │
│     day since the last stored date    │  Pages   │   tcr-nav/nav_data.js       │
│  2. AMFI NAVAll.txt: newest NAVs      │ ───────► │ and overlays NAV, trailing  │
│  3. append to data/nav/YYYY/*.parquet │          │ & calendar returns on the   │
│  4. scripts/compute.py → nav_data.js  │          │ vendor rows before scoring  │
└───────────────────────────────────────┘          └─────────────────────────────┘
```

* **Missed days fill themselves in.** Each run fetches everything from the last stored date
  (minus 5 days, to pick up late or revised NAVs) to today, so a skipped run is never lost.
* **Schedule:** 23:50, 07:10 and 13:40 IST. Run it by hand from the **Actions** tab
  (Daily NAV update, then Run workflow).
* **If AMFI is down**, it falls back to mfapi.in (the same AMFI data, per scheme).
* **Failures** are emailed to the repo owner by GitHub.

## Data

| Path | What |
|---|---|
| `data/nav/YYYY/YYYY-MM.parquet` | `code, date, nav`. Full history since 2006 (since launch for newer funds). |
| `data/schemes.csv` | AMFI code, name, AMC, category, plan, option, last NAV date |
| `data/state.json` | when it last ran, latest NAV date, source used |
| `nav_data.js` (Pages only) | what TCR reads: latest NAV and returns per scheme |

History was built from mfapi.in's full per-scheme history, which comes from AMFI. A Kaggle dump
was checked and rejected: it was missing about a third of trading days.

## The numbers

Calculated to match the monthly vendor exports TCR uses. They were checked against the
October 2026 files: 98–99% of funds agree to 0.01% on every period.

* NAV on a date = last NAV published on or before it.
* 30 days, 3 months, 6 months: absolute return, start = exactly one period back.
* 1 and 2 years: CAGR, start = exactly one period back.
* 3, 4, 5, 7 and 10 years: CAGR, start = one period back + 1 day, annualised over the inclusive day count.
* Calendar year: NAV on/before 1 Jan → NAV on/before 31 Dec (current year: to the latest NAV).
* Risk (3 years of monthly returns, risk-free rate 6.5%) is published but **not** applied to
  TCR. The vendor's risk ratios stay in use.

## TCR

`tcr/patch_tcr.py <TCR.html> <github-user>` adds the feed to a TCR file. The **NAV dd Mon**
button in TCR's header shows the feed's date: hover for details, click to switch back to
the uploaded files only. Copies saved with TCR's "⬇ HTML copy" keep the feature.
Benchmark rows, corpus, ratings, risk ratios and categories still come from the monthly upload.

## Rebuild from scratch

```bash
pip install -r requirements.txt
python scripts/seed.py      # ~5 minutes, downloads full history for every scheme
python scripts/update.py
```
