"""One-time build of the history store (re-runnable to rebuild from scratch).

  python scripts/seed.py

1. Finds today's active open-ended Regular-Growth schemes from AMFI (last 10 days).
2. Downloads each scheme's full NAV history from mfapi.in (AMFI data, since inception).
3. Overlays the last 10 days straight from AMFI.
4. Writes data/nav/<YYYY>/<YYYY-MM>.parquet and data/schemes.csv.

(The Kaggle dump was checked and rejected: about a third of trading days are missing.)
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import pandas as pd

import navlib as L

IST = timezone(timedelta(hours=5, minutes=30))


def main():
    today = datetime.now(IST).date()
    recent = L.fetch_history(today - timedelta(days=10), today)
    rg = recent[L.is_regular_growth(recent)]
    schemes = L.merge_schemes(L.load_schemes().iloc[0:0], rg)
    codes = sorted(schemes["code"])
    L.log(f"active Regular-Growth schemes: {len(codes)}")

    parts, failed = [], []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(L.fetch_mfapi, int(c)): c for c in codes}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                parts.append(f.result())
            except Exception as e:
                failed.append(futs[f])
                L.log(f"  mfapi {futs[f]} failed: {e}")
            if i % 200 == 0:
                L.log(f"  {i}/{len(codes)} schemes downloaded")
    for c in failed:  # one slow retry pass
        try:
            parts.append(L.fetch_mfapi(int(c)))
        except Exception as e:
            L.log(f"  mfapi {c} failed again: {e}")

    allrows = pd.concat(parts + [rg[["code", "date", "nav"]]], ignore_index=True)
    allrows = allrows[allrows["nav"] > 0]
    L.write_months(allrows)
    schemes.to_csv(L.SCHEMES_CSV, index=False)
    L.save_state(seeded_at=datetime.now(IST).isoformat(timespec="seconds"),
                 latest_nav_date=str(max(allrows["date"])), schemes=len(schemes),
                 history_source="mfapi.in full history + AMFI history report")
    L.log(f"seeded {len(allrows):,} rows for {allrows['code'].nunique()} schemes; latest {max(allrows['date'])}")


if __name__ == "__main__":
    main()
